import {
  assertRequiredCapabilities,
  executeFresh,
  observeFresh,
  summarizeReceipt,
  summarizeSnapshot,
  waitForFreshSnapshot,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import {
  execute,
  moveToReachableSoil,
  parseStrictEvidence,
  travelToFarm,
} from "./run-stardew-native-local-player-tool-recovery-chain-smoke.mjs";

/**
 * Native-local contract for BODY OWNERSHIP on the wire.
 *
 * Two properties, both about facts the Agent needs and neither provable offline:
 *
 *  1. OBSERVABILITY WHILE AN EXECUTION IS IN FLIGHT. A snapshot taken while a request is running must carry
 *     `activeExecution` with a non-null `ownerKind` and an `interruptible` boolean, so the Agent can see who
 *     owns the body BEFORE it is refused. This is also the exact window that a wire-contract mismatch kills:
 *     the Host refuses an unknown member on the active execution and closes the transport, and no committed
 *     test ever sent a non-null one.
 *
 *  2. THE SUPERSEDE SEMANTICS THE GUIDANCE PROMISES. The remedy text tells the Agent that a new movement
 *     directive replaces a walk in progress. That claim is only honest if a second `move_to_tile` really does
 *     displace the first one, so the run requires: the second request is ACCEPTED and the first execution
 *     reaches its own terminal. If the first execution ever kept running, the guidance would be lying.
 *
 * The runner drives the production bridge directly and issues both requests itself. It therefore proves the
 * MECHANISM and the WIRE, never that an Agent chose the recovery - a run that needed the Agent to decide is a
 * different gate, and this file must not be reported as if it were that one.
 */
const SCENARIO = "native_till_soil_v1";
const EXPECTED_ACTIONS = ["move_to_tile", "travel", "till_soil", "equip_tool"];
const REQUIRED_CAPABILITIES = [
  "inspect_self",
  "move_to_tile",
  "navigate_to_destination",
  "observe_scene",
  "till_soil",
  "travel",
];

/** The owner kinds this lane may publish; the fixture's walk must be one of them. */
const MOVEMENT_OWNERS = new Set(["body_owned_by_movement", "body_owned_by_navigation"]);

export async function runBodyOwnerHoldSmoke(
  client,
  receipts,
  config,
  { terminalTimeoutMs = 5_000, stabilizeTimeoutMs = 10_000, moveTimeoutMs = 55_000, travelTimeoutMs = 15_000 } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  validateNativeLocalFixtureConfig(config);
  try {
    let snapshot = await observeFresh(client);
    assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);
    if (snapshot.location !== "Farm")
      snapshot = await travelToFarm(client, receipts, snapshot, trace, stabilizeTimeoutMs, travelTimeoutMs);
    // Reach a tile from which the fixture's soil is workable, so the walk below is a REAL approach to a real
    // target rather than a move into open ground.
    snapshot = await moveToReachableSoil(client, receipts, snapshot, trace, stabilizeTimeoutMs, moveTimeoutMs);
    if (snapshot.actionable !== true || snapshot.activeExecution != null)
      throw new Error(`body_owner_hold_not_idle:actionable=${snapshot.actionable};active=${snapshot.activeExecution?.action}`);

    // The walk: a target far enough away that it cannot complete before the next request is issued. The soil
    // tile list gives reachable coordinates, and the farthest of them is used precisely to create that window.
    const walkTarget = farthestReachableTile(snapshot);
    if (walkTarget === null) throw new Error("body_owner_hold_no_walk_target");

    const firstAccepted = await execute("walk_owner", "move_to_tile", walkTarget, snapshot, trace, client);
    if (firstAccepted.state !== "accepted")
      throw new Error(`body_owner_hold_walk_not_accepted:${firstAccepted.state}:${firstAccepted.reasonCode}`);

    // (1) The in-flight window. Observe WITHOUT waiting for the walk to finish: this is the snapshot whose
    // activeExecution must carry the owner facts, and the one a contract mismatch would have refused.
    const inFlight = await waitForInFlightOwner(client, stabilizeTimeoutMs);
    const ownerKind = inFlight.activeExecution?.ownerKind;
    const interruptible = inFlight.activeExecution?.interruptible;
    const observability = {
      inFlight: inFlight.activeExecution != null,
      ownerKindNamed: typeof ownerKind === "string" && MOVEMENT_OWNERS.has(ownerKind),
      interruptibleIsBoolean: typeof interruptible === "boolean",
      revisionAdvanced: inFlight.revision >= firstAccepted.revision,
    };
    if (!Object.values(observability).every(Boolean))
      throw new Error(
        `body_owner_observability_missing:${JSON.stringify(observability)};ownerKind=${String(ownerKind)};interruptible=${String(interruptible)}`,
      );

    // (2) The supersede the guidance promises: a second movement directive must be accepted AND must end the
    // first execution, or the text would be false for every Agent that followed it.
    const secondAccepted = await executeWalking(
      "walk_supersede",
      "move_to_tile",
      adjacentTile(snapshot, walkTarget),
      singleRequestFor(inFlight),
      trace,
      client,
    );
    if (secondAccepted.state !== "accepted")
      throw new Error(`body_owner_supersede_not_accepted:${secondAccepted.state}:${secondAccepted.reasonCode}`);
    // Name this failure locally: the harness reports a bare `native_terminal_receipt_missing_or_stale`, which
    // does not say WHICH walk had no terminal, and "the walk I just superseded never ended" is the whole point.
    const superseded = await waitForTerminal(receipts, firstAccepted, terminalTimeoutMs).catch((error) => {
      throw new Error(`body_owner_supersede_missing:first_walk_had_no_terminal:${String(error instanceof Error ? error.message : error)}`);
    });
    const supersededEvidence = superseded.evidence == null ? {} : parseStrictEvidence(superseded.evidence);
    const supersede = {
      // The first execution must reach a terminal of its own; a still-running first walk means two owners.
      firstIsTerminal: ["rejected", "cancelled", "invalidated", "succeeded", "uncertain"].includes(superseded.state),
      firstReasonReported: typeof superseded.reasonCode === "string" && superseded.reasonCode.length > 0,
      // The published guidance names `superseded_by_new_directive`; the receipt has to carry it when that is
      // what happened, so the Agent can tell "replaced" from "failed".
      reasonMatchesGuidance:
        superseded.reasonCode === "superseded_by_new_directive" ||
        supersededEvidence.reason === "superseded_by_new_directive" ||
        superseded.state !== "rejected",
    };
    // The first walk's terminal is not necessarily the supersede one - a walk can also finish on its own before
    // the second request arrives. Both are honest outcomes; what is NOT honest is a second acceptance that
    // leaves the first execution unaccounted for.
    if (!supersede.firstIsTerminal || !supersede.firstReasonReported || !supersede.reasonMatchesGuidance)
      throw new Error(`body_owner_supersede_missing:${JSON.stringify(supersede)};state=${superseded.state};reason=${superseded.reasonCode}`);

    const secondTerminal = await waitForTerminal(receipts, secondAccepted, terminalTimeoutMs);
    if (!["succeeded", "rejected", "invalidated", "cancelled", "uncertain"].includes(secondTerminal.state))
      throw new Error(`body_owner_second_walk_not_terminal:${secondTerminal.state}`);

    // Settle before releasing the fixture: the body must be free again so the run does not end mid-walk.
    const settled = await waitForFreshSnapshot(client, {
      minRevision: Math.max(superseded.revision, secondTerminal.revision),
      timeoutMs: moveTimeoutMs,
      requireActionable: true,
      check: (latest) => latest.activeExecution == null,
    });
    if (settled.actionable !== true || settled.activeExecution != null)
      throw new Error(`body_owner_hold_not_settled:actionable=${settled.actionable}`);

    return {
      role: "body_owner_hold",
      state: "passed",
      reasonCode: "body_owner_hold_observable_and_supersedable",
      scenario: SCENARIO,
      location: settled.location,
      observability,
      ownerKind: String(ownerKind),
      interruptible: Boolean(interruptible),
      supersede,
      walkTarget,
      elapsedMs: Date.now() - startedAt,
      trace,
      phases: {
        walk: summarizeReceipt(firstAccepted),
        inFlight: summarizeSnapshot(inFlight),
        superseded: summarizeReceipt(superseded),
        second: summarizeReceipt(secondTerminal),
      },
    };
  } catch (error) {
    return {
      role: "body_owner_hold",
      state: "blocked",
      reasonCode: String(error instanceof Error ? error.message : error),
      scenario: SCENARIO,
      elapsedMs: Date.now() - startedAt,
      trace,
    };
  }
}

/** Wait for a snapshot whose active execution is present: the in-flight window, without waiting for it to end. */
async function waitForInFlightOwner(client, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = await observeFresh(client);
  while (Date.now() < deadline) {
    if (latest.activeExecution != null) return latest;
    await new Promise((resolve) => setTimeout(resolve, 100));
    latest = await observeFresh(client);
  }
  return latest;
}

/**
 * The farthest live tile the snapshot reports. Deliberately the farthest rather than the nearest: the run needs
 * the walk to still be running when the next request is issued, and a near target would settle first and turn
 * this gate into a test of nothing.
 */
function farthestReachableTile(snapshot) {
  const tiles = Array.isArray(snapshot.soilTiles) ? snapshot.soilTiles : [];
  let best = null;
  let bestDistance = -1;
  for (const tile of tiles) {
    if (!Number.isFinite(tile?.x) || !Number.isFinite(tile?.y)) continue;
    const distance = Math.max(Math.abs(tile.x - snapshot.tile.x), Math.abs(tile.y - snapshot.tile.y));
    if (distance > bestDistance) {
      bestDistance = distance;
      best = { x: tile.x, y: tile.y };
    }
  }
  // A target one tile away would settle immediately, so it is not a walk worth asserting on.
  return bestDistance >= 3 ? best : null;
}

function adjacentTile(snapshot, target) {
  const candidates = [
    { x: target.x + 1, y: target.y },
    { x: target.x - 1, y: target.y },
    { x: target.x, y: target.y + 1 },
    { x: target.x, y: target.y - 1 },
  ];
  for (const candidate of candidates) if (!samePoint(candidate, snapshot.tile)) return candidate;
  return candidates[0];
}

function samePoint(left, right) {
  return left.x === right.x && left.y === right.y;
}

/**
 * Send a request from a snapshot that is NOT actionable, which is the only honest way to test a supersede:
 * the body is held by the walk this request is meant to replace, so `actionable` is false by construction.
 * The shared `execute` helper refuses that, correctly, for every other chain - so this phase uses the
 * harness primitive directly and keeps the same identity and trace discipline.
 */
async function executeWalking(phase, action, args, snapshot, trace, client) {
  const nonce = `${Date.now()}_${trace.length}`;
  const requestId = `native_local_hold_${phase}_${nonce}`;
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

/** The snapshot to bind the second request to: the in-flight observation, minus its active execution. */
function singleRequestFor(snapshot) {
  return { ...snapshot, activeExecution: null };
}

function validateNativeLocalFixtureConfig(value) {
  if (value === null || typeof value !== "object") throw new Error("invalid_native_local_fixture_config");
  if (value.fixtureScenario !== SCENARIO)
    throw new Error(`native_local_fixture_scenario_mismatch:expected=${SCENARIO};actual=${String(value.fixtureScenario)}`);
  const actions = Array.isArray(value.actions) ? value.actions : [];
  for (const action of EXPECTED_ACTIONS)
    if (!actions.includes(action)) throw new Error(`native_local_fixture_action_missing:${action}`);
}
