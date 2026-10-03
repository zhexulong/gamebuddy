import {
  assertRequiredCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  summarizeSnapshot,
  waitForActionable,
  waitForFreshSnapshot,
  waitForTerminal,
  validateNativeLocalFixturePolicy,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

const SCENARIO = "native_wia_modal_dismiss_chain_v1";
const EXPECTED_ACTIONS = ["cancel_active_execution", "dismiss_modal", "move_to_tile", "travel", "observe_scene"];
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "move_to_tile", "observe_scene", "travel", "dismiss_modal"].sort();

/**
 * WIA §4.2 full modal-handling chain live proof:
 *  1. move_to_tile begins against a far soil tile; the fixture opens a native
 *     informational DialogueBox (drawObjectDialogue) mid-move; the body loop
 *     terminates the move with invalidated/modal_interrupted (intent breakpoint).
 *  2. With the dialogue still on screen, the SAME session issues dismiss_modal —
 *     the ONE action the Modal admission profile admits — and the receipt must
 *     be succeeded/modal_dismissed with the menu gone.
 *  3. The Agent resumes the same intent: re-issuing move_to_tile toward the same
 *     target now succeeds with target_reached.
 *
 * This is the admission half-loop + resumption leg evidence (the "全链路闭环"
 * the single interruption receipts do not yet prove).
 */
export async function runWiaModalDismissChain(
  client,
  receipts,
  config,
  {
    terminalTimeoutMs = 15_000,
    postconditionTimeoutMs = 10_000,
    stabilizeTimeoutMs = 10_000,
    moveTimeoutMs = 55_000,
    travelTimeoutMs = 15_000,
  } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  validateNativeLocalFixtureConfig(config);
  try {
    let snapshot = await observeFresh(client);
    assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);
    if (snapshot.location !== "Farm")
      snapshot = await travelToFarm(client, receipts, snapshot, trace, stabilizeTimeoutMs, travelTimeoutMs);

    const target = chooseDistantSoilTile(snapshot);
    if (target === null) throw new Error("no_distant_live_soil_tile");

    // ---- phase 1: interrupt ----
    const fresh1 = await waitForActionable(client, snapshot, stabilizeTimeoutMs);
    const accepted1 = await execute("interrupt", "move_to_tile", { x: target.x, y: target.y }, fresh1, trace, client);
    if (accepted1.state !== "accepted") throw new Error(`interrupt_not_accepted:${accepted1.reasonCode}`);
    const interrupted = await waitForTerminal(receipts, accepted1, terminalTimeoutMs);
    if (interrupted.state !== "invalidated" || interrupted.reasonCode !== "modal_interrupted")
      throw new Error(`interrupt_missing:state=${interrupted.state};reason=${interrupted.reasonCode}`);
    const interruptEvidence = parseStrictEvidence(interrupted.evidence);
    const breakpointOk =
      typeof interruptEvidence.interrupted_by === "string" &&
      interruptEvidence.interrupted_by.length > 0 &&
      parseTargetCoordinates(interruptEvidence.target_tile).x !== null &&
      Number.isInteger(Number(interrupted.revision));

    // ---- phase 2: dismiss (admission half-loop) ----
    const fresh2 = await waitForFreshSnapshot(client, {
      minRevision: interrupted.revision,
      timeoutMs: postconditionTimeoutMs,
    });
    const accepted2 = await execute("dismiss", "dismiss_modal", {}, fresh2, trace, client, { requireActionable: false });
    // dismiss_modal is instantaneous: the bridge immediate response IS the
    // terminal (succeeded/modal_dismissed). Accept either that or the
    // accepted-then-journal-terminal shape.
    let dismissed =
      accepted2.state === "succeeded" && accepted2.reasonCode === "modal_dismissed"
        ? accepted2
        : accepted2.state === "accepted"
          ? await waitForTerminal(receipts, accepted2, terminalTimeoutMs)
          : accepted2; // already a terminal (rejected/failed/...)
    if (dismissed.state !== "succeeded" || dismissed.reasonCode !== "modal_dismissed")
      throw new Error(`dismiss_missing:state=${dismissed.state};reason=${dismissed.reasonCode}`);
    const dismissEvidence = parseStrictEvidence(dismissed.evidence);
    const dismissOk =
      dismissEvidence.modal_type === "DialogueBox" &&
      dismissEvidence.dismissed === "true" &&
      Number.isInteger(Number(dismissed.revision));

    // ---- phase 3: resume (resumption leg) ----
    const fresh3 = await waitForActionable(client, await waitForFreshSnapshot(client, {
      minRevision: dismissed.revision,
      timeoutMs: postconditionTimeoutMs,
    }), stabilizeTimeoutMs);
    if (fresh3.activeExecution != null) throw new Error("resume_player_busy_after_dismiss");
    const accepted3 = await execute("resume", "move_to_tile", { x: target.x, y: target.y }, fresh3, trace, client);
    if (accepted3.state !== "accepted") throw new Error(`resume_not_accepted:${accepted3.reasonCode}`);
    const resumed = await waitForTerminal(receipts, accepted3, moveTimeoutMs);
    if (resumed.state !== "succeeded" || resumed.reasonCode !== "target_reached")
      throw new Error(`resume_missing:state=${resumed.state};reason=${resumed.reasonCode}`);

    const after = await waitForFreshSnapshot(client, {
      minRevision: resumed.revision,
      timeoutMs: postconditionTimeoutMs,
      requireActionable: true,
      check: (latest) => adjacent(latest.tile, target),
    });
    const passed = breakpointOk && dismissOk && after.tile.x === target.x && after.tile.y === target.y;
    return {
      state: passed ? "passed" : "blocked",
      reasonCode: passed ? "modal_dismiss_chain_complete" : "wia_modal_dismiss_chain_postcondition_mismatch",
      target,
      phases: {
        interrupt: summarizeReceipt(interrupted),
        dismiss: summarizeReceipt(dismissed),
        resume: summarizeReceipt(resumed),
      },
      breakpointOk,
      dismissOk,
      after: summarizeSnapshot(after),
      trace,
      before: summarizeSnapshot(snapshot),
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      state: "blocked",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
      latestReceipt: summarizeReceipt(client.state?.latestReceipt),
      trace,
    };
  }
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runWiaModalDismissChain(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}

async function execute(phase, action, args, snapshot, trace, client, { requireActionable = true } = {}) {
  // The Modal admission profile admits dismiss_modal EXACTLY while the modal
  // holds the actor (actionable=false is the world fact it acts on); only
  // body-owning phases require an actionable actor.
  if (requireActionable && (snapshot.actionable !== true || snapshot.activeExecution != null))
    throw new Error(`${phase}_player_not_actionable`);
  const nonce = `${Date.now()}_${trace.length}`;
  const requestId = `native_local_wia_dismiss_${phase}_${nonce}`;
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
async function moveToTile(client, receipts, snapshot, target, phase, trace, stabilizeTimeoutMs, terminalTimeoutMs) {
  const fresh = await waitForActionable(client, snapshot, stabilizeTimeoutMs);
  const accepted = await execute(phase, "move_to_tile", { x: target.x, y: target.y }, fresh, trace, client);
  if (accepted.state !== "accepted") throw new Error(`${phase}_not_accepted:${accepted.reasonCode}`);
  const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "target_reached")
    throw new Error(`${phase}_failed:${terminal.reasonCode}`);
  return waitForFreshSnapshot(client, {
    minRevision: terminal.revision,
    timeoutMs: stabilizeTimeoutMs,
    requireActionable: true,
    check: (latest) => adjacent(latest.tile, target),
  });
}
async function travelToFarm(client, receipts, snapshot, trace, stabilizeTimeoutMs, terminalTimeoutMs) {
  let fresh = await waitForActionable(client, snapshot, stabilizeTimeoutMs);
  const warp = resolveFarmWarp(fresh);
  if (!adjacent(fresh.tile, { x: warp.sourceX, y: warp.sourceY }))
    fresh = await moveToTile(
      client,
      receipts,
      fresh,
      { x: warp.sourceX, y: warp.sourceY },
      "move_to_farm_warp",
      trace,
      stabilizeTimeoutMs,
      terminalTimeoutMs,
    );
  const accepted = await execute("travel", "travel", { x: warp.sourceX, y: warp.sourceY }, fresh, trace, client);
  if (accepted.state !== "accepted") throw new Error(`travel_not_accepted:${accepted.reasonCode}`);
  const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "travel_completed")
    throw new Error(`travel_failed:${terminal.reasonCode}`);
  return waitForFreshSnapshot(client, {
    minRevision: terminal.revision,
    timeoutMs: stabilizeTimeoutMs,
    requireActionable: true,
    check: (latest) => latest.location === "Farm",
  });
}
function resolveFarmWarp(snapshot) {
  const matches = Array.isArray(snapshot.warps)
    ? snapshot.warps.filter(
        (warp) =>
          warp?.targetLocation === "Farm" &&
          Number.isInteger(warp.sourceX) &&
          Number.isInteger(warp.sourceY) &&
          Number.isInteger(warp.targetX) &&
          Number.isInteger(warp.targetY) &&
          warp.sourceX >= 0 &&
          warp.sourceY >= 0 &&
          warp.targetX >= 0 &&
          warp.targetY >= 0,
      )
    : [];
  if (matches.length !== 1) throw new Error(matches.length ? "ambiguous_farm_warp" : "farm_warp_missing");
  return matches[0];
}
function adjacent(left, right) {
  return (
    Number.isInteger(left?.x) &&
    Number.isInteger(left?.y) &&
    Number.isInteger(right?.x) &&
    Number.isInteger(right?.y) &&
    Math.abs(left.x - right.x) <= 1 &&
    Math.abs(left.y - right.y) <= 1
  );
}
function chooseDistantSoilTile(snapshot) {
  const player = { x: snapshot.tile?.x, y: snapshot.tile?.y };
  if (!Number.isInteger(player.x) || !Number.isInteger(player.y)) return null;
  const ranks = Array.isArray(snapshot.soilTiles)
    ? snapshot.soilTiles
        .filter((tile) => Number.isInteger(tile?.x) && Number.isInteger(tile?.y))
        .map((tile) => ({
          ...tile,
          distance: Math.max(Math.abs(tile.x - player.x), Math.abs(tile.y - player.y)),
        }))
        .filter((tile) => tile.distance >= 2)
        .sort((a, b) => b.distance - a.distance)
    : [];
  return ranks.length > 0 ? { x: ranks[0].x, y: ranks[0].y, distance: ranks[0].distance } : null;
}
function parseStrictEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  const result = {};
  for (const part of detail.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0 || index === part.length - 1) return {};
    const key = part.slice(0, index);
    if (Object.hasOwn(result, key)) return {};
    result[key] = part.slice(index + 1);
  }
  return result;
}
function parseTargetCoordinates(value) {
  const match = typeof value === "string" ? value.match(/^([\d.]+),([\d.]+)$/) : null;
  if (!match) return { x: null, y: null };
  return { x: Number(match[1]), y: Number(match[2]) };
}
function validateNativeLocalFixtureConfig(value) {
  if (value?.NativeLocalPlayerFixture?.Enable !== true) throw new Error("native_local_fixture_not_enabled");
  if (value.Portfolio?.Enable === true || value.HostAutomation?.Enable === true || value.HostFarmhandProvisioning?.Enable === true || value.FarmhandProvisioner?.Enable === true)
    throw new Error("native_local_fixture_topology_not_isolated");
  validateNativeLocalFixturePolicy(value, { requiredActions: EXPECTED_ACTIONS });
}