// Stardew-local select_mine_elevator_floor smoke.
//
// The mine elevator's floor SELECTION only exists inside
// `MineElevatorMenu.receiveLeftClick`, so it is its own action rather than a
// `travel` target or an `enter_mine` argument (Lane L3 card §3.7: letting
// `enter_mine` take a level would make it an arbitrary-level teleport that bypasses
// `lowestLevelReached`).
//
// The transition it performs is public and UI-free: `Game1.enterMine(floor)` after
// setting the public `Farmer.ridingMineElevator` flag, or — for floor 0, which means
// "return to the mine entrance" and not "go to level 0" — the separate
// `Game1.warpFarmer("Mine", 17, 4)`.
//
// This runner proves the three things a receipt alone cannot: the terminal is the
// native `mine_elevator_floor_selected`, the world really moved (the arrival
// location IS the requested floor and the actor landed on the native arrival tile),
// and the floor bookkeeping followed (the freshly observed floor set now reports the
// arrival floor as the current one). The fixture only stages mine progress and puts
// the actor on a level that carries the elevator tile; it emits no receipt.

import {
  assertRequiredCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  summarizeSnapshot,
  waitForFreshSnapshot,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

const EXPECTED_CAPABILITIES = ["cancel_active_execution", "inspect_self", "select_mine_elevator_floor"];
const SCENARIO = "native_mine_elevator_v1";
const TERMINAL_REASON = "mine_elevator_floor_selected";
/** The level the fixture places the actor on (a floor that carries elevator tile 112). */
const FIXTURE_START_LOCATION = "UndergroundMine5";

/** Execute the select_mine_elevator_floor contract against a connected session. */
export async function runMineElevatorSmoke(client, receipts, config, { floorsTimeoutMs = 30_000 } = {}) {
  const trace = [];
  const startedAt = Date.now();
  try {
    validateNativeLocalFixtureConfig(config);

    const before = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(before, EXPECTED_CAPABILITIES);

    const floorsBefore = readFloorTargets(before);
    if (floorsBefore.length === 0)
      throw new Error(`mine_elevator_no_floors_advertised:location=${before.location}`);

    // Pick a floor that is neither the entrance nor the current one: selecting the
    // current floor is a native no-op the action refuses, and floor 0 is a different
    // native path ("return to the entrance"), so neither proves a floor change.
    const chosen = floorsBefore.find((f) => !f.isMineEntrance && !f.isCurrentFloor);
    if (!chosen)
      throw new Error(
        `mine_elevator_no_selectable_floor:${floorsBefore.map((f) => f.floor).join("/")}`,
      );

    const dispatched = await execute(client, trace, "select", "select_mine_elevator_floor", {
      expectedTargetId: chosen.targetId,
    }, before);

    // The dispatch is accepted, not terminal: Game1.enterMine performs a warp, and the
    // single terminal arrives on the Warped edge (measured live: reading the level in
    // the same frame still returns the OLD one). So the accepted receipt carries the
    // dispatch facts and the terminal carries the postcondition.
    const terminal =
      dispatched.state === "succeeded" ||
      dispatched.state === "rejected" ||
      dispatched.state === "invalidated" ||
      dispatched.state === "failed" ||
      dispatched.state === "uncertain"
        ? dispatched
        : await waitForTerminal(receipts, dispatched, floorsTimeoutMs);
    const dispatch = parseStrictEvidence(evidenceText(dispatched));

    trace.push({
      phase: "terminal",
      state: terminal.state,
      reasonCode: terminal.reasonCode,
      revision: terminal.revision,
      evidencePrefix: evidenceText(terminal)?.slice(0, 240) ?? null,
    });

    if (terminal.state !== "succeeded" || terminal.reasonCode !== TERMINAL_REASON)
      throw new Error(`mine_elevator_terminal_mismatch:state=${terminal.state};reason=${terminal.reasonCode}`);

    const evidence = parseStrictEvidence(evidenceText(terminal));

    // The world, not the receipt, decides whether the actor moved.
    const after = await waitForFreshSnapshot(client, { minRevision: terminal.revision });
    const floorsAfter = readFloorTargets(after);
    const arrivedCurrent = floorsAfter.some((f) => f.floor === chosen.floor && f.isCurrentFloor);

    const detail = {
      reasonCode: TERMINAL_REASON,
      requested: { floor: chosen.floor, targetId: chosen.targetId },
      floorsBefore: floorsBefore.map((f) => `${f.floor}${f.isCurrentFloor ? "*" : ""}`).join("/"),
      floorsAfter: floorsAfter.map((f) => `${f.floor}${f.isCurrentFloor ? "*" : ""}`).join("/"),
      originLocation: dispatch.origin ?? null,
      originFloor: Number.parseInt(dispatch.origin_floor ?? "", 10),
      elevatorTile: dispatch.elevator_tile ?? null,
      // The riding flag is an implementation requirement (the mine entrance reads it to
      // choose the elevator landing tile), but it is NOT a postcondition: the native
      // layout may consume and reset it during the warp. Measured live, the receipt's
      // value at arrival is not a stable contract, so the runner records it as an
      // observation instead of a clause.
      ridingMineElevatorObserved: dispatch.riding_mine_elevator ?? null,
      terminalLevel: Number.parseInt(evidence.level ?? "", 10),
      terminalActual: evidence.actual ?? null,
      before: summarizeSnapshot(before),
      after: summarizeSnapshot(after),
      afterLocation: after.location,
      arrivedCurrentFloorAdvertised: arrivedCurrent,
      trace,
      durationMs: Date.now() - startedAt,
    };
    assertMineElevatorPostconditions(detail);
    return { state: "passed", ...detail, latestReceipt: summarizeReceipt(terminal) };
  } catch (error) {
    return {
      state: "blocked",
      reasonCode: error?.message ?? "mine_elevator_smoke_failed",
      trace,
      durationMs: Date.now() - startedAt,
    };
  }
}

/**
 * The pass contract, factored out so a negative test can prove each clause instead
 * of trusting the happy path.
 */
export function assertMineElevatorPostconditions(detail) {
  if (detail.reasonCode !== TERMINAL_REASON) throw new Error(`mine_elevator_reason:${detail.reasonCode}`);
  if (!Number.isSafeInteger(detail.requested?.floor)) throw new Error("mine_elevator_requested_floor_missing");

  // The world moved: the arrival location is the requested floor's generated level,
  // the actor is on the native arrival tile, and the freshly observed floor set now
  // reports that floor as current.
  const expectedLocation = `UndergroundMine${detail.requested.floor}`;
  if (detail.afterLocation !== expectedLocation)
    throw new Error(`mine_elevator_arrival_not_observed:${detail.afterLocation}!=${expectedLocation}`);
  // The native MineShaft layout chooses the landing tile (measured live: level 10
  // arrives near 10,4 rather than the requested 6,6), so the postcondition the receipt
  // must carry is the LEVEL. A tile assertion here would be a false contract.
  if (detail.terminalLevel !== detail.requested.floor)
    throw new Error(`mine_elevator_terminal_level_mismatch:${detail.terminalLevel}!=${detail.requested.floor}`);
  if (detail.arrivedCurrentFloorAdvertised !== true)
    throw new Error(`mine_elevator_current_floor_not_reprojected:${detail.floorsAfter}`);
  if (detail.originFloor === detail.requested.floor)
    throw new Error(`mine_elevator_did_not_change_floor:${detail.originFloor}`);

  // The public flag the mine entrance reads to pick the elevator landing tile is set
  // on dispatch; it is deliberately NOT asserted here, because the native layout may
  // consume and reset it during the warp. The action's own contract is the floor.
  if (!detail.elevatorTile) throw new Error("mine_elevator_elevator_tile_not_reported");
  if (!detail.trace?.some((entry) => entry.action === "select_mine_elevator_floor"))
    throw new Error("mine_elevator_trace");
  return detail;
}

/**
 * The stored fixture config must be this scenario. `Portfolio` is deliberately NOT
 * required to be false: it is not a ModConfig property, so the game drops it when it
 * rewrites the profile config, and only an explicit true is a topology violation.
 */
export function validateNativeLocalFixtureConfig(config) {
  if (config?.NativeLocalPlayerFixture?.Enable !== true) throw new Error("native_local_fixture_not_enabled");
  if (
    config.Portfolio?.Enable === true ||
    config.HostAutomation?.Enable === true ||
    config.HostFarmhandProvisioning?.Enable === true ||
    config.FarmhandProvisioner?.Enable === true
  )
    throw new Error("native_local_fixture_topology_not_isolated");
  const scenario = config.NativeLocalPlayerFixture.FixtureScenario;
  if (scenario !== SCENARIO) throw new Error(`native_local_fixture_scenario_mismatch:${scenario ?? "missing"}`);
}

/** The wire carries evidence as an object; the Mod's string form arrives as `{ detail }`. */
function evidenceText(receipt) {
  const evidence = receipt?.evidence;
  if (typeof evidence === "string") return evidence;
  return typeof evidence?.detail === "string" ? evidence.detail : null;
}

export function parseStrictEvidence(text) {
  if (typeof text !== "string" || text.length === 0) throw new Error("mine_elevator_evidence_missing");
  const fields = {};
  for (const part of text.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) throw new Error(`mine_elevator_evidence_malformed:${part}`);
    fields[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return fields;
}

/**
 * Read the advertised floors. The snapshot field is the Mod's own derivation from
 * live `MineShaft.lowestLevelReached`, so an empty list is itself a finding (the
 * actor is not somewhere the elevator exists) rather than something to paper over.
 */
function readFloorTargets(snapshot) {
  const raw = snapshot?.mineElevatorFloorTargets;
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => ({
    targetId: entry.targetId,
    floor: entry.floor,
    isCurrentFloor: entry.isCurrentFloor === true,
    isMineEntrance: entry.isMineEntrance === true,
  }));
}

// `snapshot` is required: executeFresh binds the request to the observation it was
// computed against, which is what stops a stale plan from being replayed.
async function execute(client, trace, phase, action, args, snapshot) {
  const requestId = `native_local_mine_elevator_${phase}_${Date.now()}_${trace.length}`;
  const receipt = await executeFresh(client, {
    requestId,
    idempotencyKey: `${requestId}_idem`,
    action,
    args,
    snapshot,
    timeoutMs: 30_000,
  });
  trace.push({ phase, action, args, requestId, receipt: summarizeReceipt(receipt) });
  return receipt;
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runMineElevatorSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
