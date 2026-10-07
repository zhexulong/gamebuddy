// Stardew-local use_obelisk smoke.
//
// `use_obelisk` activates one published fixed-point warp structure. The Mod
// re-derives the structure, its route and its destination on the game thread from
// live state, calls the native seam (Building.PerformObeliskWarp for a placed
// obelisk building, IslandWest.performAction for the island's own "FarmObelisk"
// tile), and then hands the arrival to the shared travel completion path.
//
// The native call does NOT warp: it plays the wand effect, freezes the actor and
// hands `warpFarmer` to a 1000ms DelayedAction. Admission is therefore
// instantaneous (`accepted`) and the SINGLE terminal belongs to the arrival
// (`obelisk_arrived`, minted by CompleteTravelAfterWarp on the Warped edge). This
// runner drives that chain in one native-local session and then proves the three
// things a receipt alone cannot: the world really moved the actor to the
// destination the target advertises, the actor was not already there, and the
// published identity is the one that was executed.
//
// The fixture only establishes the declared Given (one finished obelisk building
// on the farm, actor in its interaction ring) and emits no receipt, so a pass here
// is evidence about the production seam rather than a fixture-authored warp.
//
// Shared harness helpers (bounded scope, revision-bound requests, exact receipt
// identity, terminal wait, owned teardown) come from
// `stardew-native-smoke-harness-v1.mjs`.

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
// The native-local lane loads the compiled test artifact, exactly like the other
// chain runners: the immutable production generation can predate the current
// protocol, which the Mod then rejects as invalid_hello_ack.
import { loadHostTestModule } from "./lib/host-test-module.mjs";

const EXPECTED_CAPABILITIES = ["cancel_active_execution", "inspect_self", "use_obelisk"];
const SCENARIO = "native_use_obelisk_v1";
const ACCEPTED_REASON = "accepted";
const TERMINAL_REASON = "obelisk_arrived";
/** The route this fixture stages. Route B needs the island upgrade Given instead. */
const FIXTURE_ROUTE = "building";

/** Execute the use_obelisk contract against an already-connected bridge session. */
export async function runUseObeliskSmoke(client, receipts, config, { arrivalTimeoutMs = 60_000 } = {}) {
  const trace = [];
  const startedAt = Date.now();
  try {
    // The stored profile config is part of the declared Given: a config for another
    // scenario means the run would exercise something other than this contract.
    validateNativeLocalFixtureConfig(config);
    const before = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(before, EXPECTED_CAPABILITIES);

    const targets = readObeliskTargets(before);
    if (targets.length === 0)
      throw new Error(`use_obelisk_no_target_advertised:location=${before.location}`);
    // This fixture declares the BUILDING Given only, so an advertised island tile
    // would mean the world is not the one this scenario claims to arm.
    const chosen = targets.find((target) => target.route === FIXTURE_ROUTE);
    if (!chosen)
      throw new Error(`use_obelisk_fixture_route_missing:routes=${targets.map((t) => t.route).join("/")}`);

    const dispatched = await execute(client, trace, "use", "use_obelisk", {
      x: chosen.x,
      y: chosen.y,
      expectedTargetId: chosen.targetId,
    }, before);

    if (dispatched.state !== "accepted" && dispatched.state !== "succeeded")
      throw new Error(
        "use_obelisk_dispatch_not_accepted:state=" + dispatched.state + ";reason=" + dispatched.reasonCode +
        ";evidence=" + (evidenceText(dispatched) ?? "(none)") +
        ";target=" + chosen.targetId + ";xy=" + chosen.x + "," + chosen.y + ";route=" + chosen.route,
      );
    if (dispatched.state === "accepted" && dispatched.reasonCode !== ACCEPTED_REASON)
      throw new Error(`use_obelisk_accept_reason_mismatch:${dispatched.reasonCode}`);

    // The dispatch only STARTS the native routine; the terminal arrives when the
    // delayed warp lands. A receipt that is already terminal is accepted too, so the
    // runner proves the terminal rather than the timing.
    const terminal =
      dispatched.state === "succeeded" ||
      dispatched.state === "rejected" ||
      dispatched.state === "invalidated" ||
      dispatched.state === "failed" ||
      dispatched.state === "uncertain" ||
      dispatched.state === "expired"
        ? dispatched
        : await waitForTerminal(receipts, dispatched, arrivalTimeoutMs);
    // Record the raw terminal so a failure names the receipt that actually arrived
    // (state, reason code and the evidence prefix) instead of only reporting that a
    // field was missing.
    trace.push({
      phase: "terminal",
      state: terminal.state,
      reasonCode: terminal.reasonCode,
      revision: terminal.revision,
      evidencePrefix: evidenceText(terminal)?.slice(0, 240) ?? null,
    });

    if (terminal.state !== "succeeded" || terminal.reasonCode !== TERMINAL_REASON)
      throw new Error(
        "use_obelisk_terminal_mismatch:state=" + terminal.state + ";reason=" + terminal.reasonCode +
        ";evidence=" + (evidenceText(terminal) ?? "(none)") +
        ";dispatched=" + (evidenceText(dispatched) ?? "(none)") +
        ";target=" + chosen.targetId + ";xy=" + chosen.x + "," + chosen.y + ";route=" + chosen.route,
      );

    const dispatch = parseStrictEvidence(evidenceText(dispatched));
    const arrival = parseStrictEvidence(evidenceText(terminal));

    // The world, not the receipt, is the authority on the arrival.
    const after = await waitForFreshSnapshot(client, { minRevision: terminal.revision });

    const detail = {
      reasonCode: TERMINAL_REASON,
      requested: { targetId: chosen.targetId, x: chosen.x, y: chosen.y, route: chosen.route, destination: chosen.destination },
      dispatchedRoute: dispatch.route ?? null,
      dispatchedTarget: dispatch.target ?? null,
      dispatchedTargetTile: dispatch.target_tile ?? null,
      dispatchedOrigin: dispatch.origin ?? null,
      dispatchedDestination: dispatch.destination ?? null,
      dispatchedDestinationTile: dispatch.destination_tile ?? null,
      forceDismount: dispatch.force_dismount ?? null,
      terminalExpected: arrival.expected ?? null,
      terminalActual: arrival.actual ?? null,
      // No "advertised list unchanged" fact here on purpose: obeliskTargets is published PER
      // LOCATION, so any successful warp leaves the previous location's list empty and the
      // comparison is guaranteed to differ. Asserting it produced a false failure in live
      // (obelisk_arrived with expected=Desert:35,43;actual=Desert:35,43).
      before: summarizeSnapshot(before),
      after: summarizeSnapshot(after),
      afterLocation: after.location,
      trace,
      durationMs: Date.now() - startedAt,
    };
    assertUseObeliskPostconditions(detail);
    return { state: "passed", ...detail, latestReceipt: summarizeReceipt(terminal) };
  } catch (error) {
    return {
      state: "blocked",
      reasonCode: error?.message ?? "use_obelisk_smoke_failed",
      trace,
      durationMs: Date.now() - startedAt,
    };
  }
}

/**
 * The pass contract, factored out so a negative test can prove each clause instead
 * of trusting the happy path.
 */
export function assertUseObeliskPostconditions(detail) {
  if (detail.reasonCode !== TERMINAL_REASON) throw new Error(`use_obelisk_reason:${detail.reasonCode}`);

  // The executed structure is the one the snapshot advertised: the dispatch echoes
  // the published identity, the tile and the route, so a silently re-targeted
  // obelisk cannot pass as the requested one.
  if (detail.dispatchedTarget !== detail.requested?.targetId)
    throw new Error(`use_obelisk_target_mismatch:${detail.dispatchedTarget}!=${detail.requested?.targetId}`);
  if (detail.dispatchedRoute !== detail.requested?.route)
    throw new Error(`use_obelisk_route_mismatch:${detail.dispatchedRoute}!=${detail.requested?.route}`);
  if (detail.dispatchedTargetTile !== `${detail.requested?.x},${detail.requested?.y}`)
    throw new Error(`use_obelisk_tile_mismatch:${detail.dispatchedTargetTile}`);

  // The destination is the target's own, not a client-supplied one.
  if (detail.dispatchedDestination !== detail.requested?.destination)
    throw new Error(`use_obelisk_destination_mismatch:${detail.dispatchedDestination}!=${detail.requested?.destination}`);

  // The world moved: the arrival location IS the advertised destination, and it is
  // not where the dispatch started (an arrival equal to the origin would mean no
  // warp happened at all).
  if (detail.after?.hasLocation !== true) throw new Error("use_obelisk_after_missing");
  if (detail.afterLocation !== detail.requested?.destination)
    throw new Error(`use_obelisk_arrival_not_observed:${detail.afterLocation}!=${detail.requested?.destination}`);
  if (detail.afterLocation === detail.dispatchedOrigin)
    throw new Error(`use_obelisk_did_not_move:${detail.afterLocation}`);

  // The terminal's own expected-pair must name the same destination, or the
  // succeeded receipt belongs to some other warp.
  if (!String(detail.terminalExpected ?? "").startsWith(`${detail.requested?.destination}:`))
    throw new Error(`use_obelisk_terminal_expected_mismatch:${detail.terminalExpected}`);
  if (!String(detail.terminalActual ?? "").startsWith(`${detail.requested?.destination}:`))
    throw new Error(`use_obelisk_terminal_actual_mismatch:${detail.terminalActual}`);

  // The arrival TILE is not asserted: the native layout chooses it (the island
  // route reads the farm's WarpTotemEntry, the building route may be nudged onto a
  // passable neighbour). Only the location is the legal postcondition.
  if (!detail.trace?.some((entry) => entry.action === "use_obelisk")) throw new Error("use_obelisk_trace");

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
  if (typeof text !== "string" || text.length === 0) throw new Error("use_obelisk_evidence_missing");
  const fields = {};
  for (const part of text.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) throw new Error(`use_obelisk_evidence_malformed:${part}`);
    fields[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return fields;
}

/**
 * Read the advertised obelisks. The list is the Mod's own projection from live
 * state, so an empty list is itself a finding (the world is not the one this
 * scenario declares) rather than something to paper over.
 */
function readObeliskTargets(snapshot) {
  const raw = snapshot?.obeliskTargets;
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => ({
    targetId: entry.targetId,
    route: entry.route,
    location: entry.location,
    x: entry.x,
    y: entry.y,
    displayName: entry.displayName,
    destination: entry.destination,
    forceDismount: entry.forceDismount === true,
  }));
}

// `snapshot` is required: executeFresh binds the request to the observation it was
// computed against, which is what stops a stale plan from being replayed.
async function execute(client, trace, phase, action, args, snapshot) {
  const requestId = `native_local_use_obelisk_${phase}_${Date.now()}_${trace.length}`;
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
    const result = await runUseObeliskSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
