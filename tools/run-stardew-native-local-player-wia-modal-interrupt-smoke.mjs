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

const SCENARIO = "native_wia_modal_interrupt_v1";
const EXPECTED_ACTIONS = ["cancel_active_execution", "move_to_tile", "travel", "observe_scene"];
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "move_to_tile", "observe_scene", "travel"].sort();

/**
 * WIA modal interruption live proof (world-interruption-arbitration.md §4.1
 * ② / §1.1): a running move execution is interrupted by a world-owned native
 * modal (the same drawObjectDialogue the door-gate refusal uses), and the
 * receipt must classify it as invalidated/modal_interrupted with the intent
 * breakpoint (interrupted_by / target_tile / interrupted_at /
 * remaining_distance / revision) — so the Agent can replan against the actual
 * blocked intent instead of receiving an opaque menu_opened failure.
 */
export async function runWiaModalInterruptSmoke(
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
    const fresh = await waitForActionable(client, snapshot, stabilizeTimeoutMs);
    const accepted = await execute("wia_modal_interrupt", "move_to_tile", target, fresh, trace, client);
    if (accepted.state !== "accepted") throw new Error(`wia_modal_interrupt_not_accepted:${accepted.reasonCode}`);

    const receipt = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    if (receipt.state !== "invalidated" || receipt.reasonCode !== "modal_interrupted") {
      throw new Error(`wia_modal_interrupt_missing:state=${receipt.state};reason=${receipt.reasonCode}`);
    }

    const evidence = parseStrictEvidence(receipt.evidence);
    const targetCoords = parseTargetCoordinates(evidence.target_tile);
    const interruptedAt = parseTargetCoordinates(evidence.interrupted_at);
    const evidenceOk =
      typeof evidence.interrupted_by === "string" &&
      evidence.interrupted_by.length > 0 &&
      targetCoords.x !== null &&
      targetCoords.y !== null &&
      interruptedAt.x !== null &&
      interruptedAt.y !== null &&
      Number.isFinite(Number(evidence.remaining_distance)) &&
      Number.isInteger(Number(receipt.revision));

    const after = await waitForFreshSnapshot(client, {
      minRevision: receipt.revision,
      timeoutMs: postconditionTimeoutMs,
      check: (latest) => latest.location === snapshot.location,
    });
    const passed =
      evidenceOk &&
      after.revision === receipt.revision &&
      after.location === snapshot.location &&
      (!after.actionable || after.activeExecution == null);
    return {
      state: passed ? "passed" : "blocked",
      reasonCode: passed ? "modal_interrupted" : "wia_modal_interrupt_postcondition_mismatch",
      target,
      receipt: summarizeReceipt(receipt),
      evidence,
      evidenceOk,
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
  const session = await connectNativeLocalClient(config);
  try {
    const result = await runWiaModalInterruptSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}

async function execute(phase, action, args, snapshot, trace, client) {
  if (snapshot.actionable !== true || snapshot.activeExecution != null)
    throw new Error(`${phase}_player_not_actionable`);
  const nonce = `${Date.now()}_${trace.length}`;
  const requestId = `native_local_wia_modal_${phase}_${nonce}`;
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
  const accepted = await execute(phase, "move_to_tile", target, fresh, trace, client);
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
        .filter((tile) => tile.distance > 8)
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