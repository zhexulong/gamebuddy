// Native-local wood-fence smoke. Shared harness owns bridge mechanics;
// this runner owns fixture topology, target discovery, evidence, and postcondition.
import {
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  summarizeSnapshot,
  waitForActionable,
  waitForFreshSnapshot,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";

const ACTION = "place_wood_fence";
const REQUIRED_CAPABILITIES = [ACTION, "move_to_tile", "travel"];

export async function runPlaceWoodFenceSmoke(
  client,
  receipts,
  config,
  { moveTimeoutMs = 55_000, transitionTimeoutMs = 20_000, postconditionTimeoutMs = 5_000 } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  try {
    validateConfig(config);
    let snapshot = await actionableSnapshot(client);
    requireCapabilities(snapshot);
    if (snapshot.location !== "Farm")
      snapshot = await travelToFarm(client, receipts, trace, snapshot, moveTimeoutMs, transitionTimeoutMs);
    snapshot = await waitForActionable(client, snapshot, 5_000);
    snapshot = await moveToReachableTarget(client, receipts, trace, snapshot, moveTimeoutMs);
    snapshot = await waitForActionable(client, snapshot, 3_000);
    if (snapshot.actionable !== true || snapshot.activeExecution != null)
      throw new Error("player_not_actionable_before_place");
    const target = chooseReachableWoodFenceTarget(snapshot);
    if (!target) throw new Error("no_adjacent_live_wood_fence_target");
    const accepted = await dispatch(
      client,
      trace,
      "place",
      ACTION,
      {
        slot: target.slot,
        x: target.x,
        y: target.y,
        expectedQualifiedItemId: target.qualifiedItemId,
        expectedTargetId: target.targetId,
      },
      snapshot,
    );
    const terminal = await waitForTerminal(receipts, accepted, postconditionTimeoutMs);
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "wood_fence_placed")
      throw new Error(`wood_fence_failed:${terminal.reasonCode}`);
    const after = await waitForFreshSnapshot(client, {
      minRevision: terminal.revision,
      timeoutMs: postconditionTimeoutMs,
      requireActionable: true,
      check: (candidate) => Array.isArray(candidate.woodFenceResultTargets),
    });
    const evidence = parseStrictEvidence(terminal.evidence);
    const resultFence = after.woodFenceResultTargets.find((entry) => entry.targetId === target.targetId);
    const resultMatches =
      resultFence !== undefined &&
      resultFence.location === target.location &&
      resultFence.x === target.x &&
      resultFence.y === target.y &&
      resultFence.slot === target.slot &&
      resultFence.targetId === target.targetId &&
      resultFence.qualifiedItemId === target.qualifiedItemId &&
      resultFence.isFence === true &&
      resultFence.isGate === false &&
      Number.isFinite(resultFence.health) &&
      resultFence.health === Number(evidence.health) &&
      Number.isFinite(resultFence.maxHealth) &&
      resultFence.maxHealth >= resultFence.health;
    const evidenceMatches =
      evidence.source === "(O)322" &&
      evidence.location === target.location &&
      Number(evidence.x) === target.x &&
      Number(evidence.y) === target.y &&
      evidence.target === target.targetId &&
      evidence.item === target.qualifiedItemId &&
      Number(evidence.slot) === target.slot &&
      evidence.source_empty_before === "true" &&
      evidence.is_fence === "true" &&
      evidence.is_gate === "false" &&
      Number.isFinite(Number(evidence.health)) &&
      Number(evidence.health) > 0 &&
      Number.isFinite(Number(evidence.max_health)) &&
      Number(evidence.max_health) >= Number(evidence.health);
    const stackDeltaProven = Number(evidence.inventory_before) === 1 && Number(evidence.inventory_after) === 0;
    const passed =
      terminal.executionId === accepted.executionId &&
      terminal.requestId === accepted.requestId &&
      evidenceMatches &&
      stackDeltaProven &&
      resultMatches &&
      after.revision === terminal.revision &&
      after.actionable === true &&
      after.activeExecution == null;
    return {
      state: passed ? "passed" : "blocked",
      reasonCode: passed ? "wood_fence_placed" : terminal.reasonCode,
      target,
      receipt: summarizeReceipt(terminal),
      evidence,
      resultFence,
      evidenceMatches,
      resultMatches,
      stackDeltaProven,
      trace,
      before: summarize(snapshot),
      after: summarize(after),
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      state: "blocked",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
      latestReceipt: summarizeReceipt(client.state?.latestReceipt),
      trace,
      durationMs: Date.now() - startedAt,
    };
  }
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config);
  try {
    const result = await runPlaceWoodFenceSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}

async function dispatch(client, trace, phase, action, args, snapshot) {
  if (snapshot.actionable !== true || snapshot.activeExecution != null)
    throw new Error(`${phase}_player_not_actionable`);
  const requestId = `native_local_place_wood_fence_${phase}_${Date.now()}_${trace.length}`;
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

async function travelToFarm(client, receipts, trace, snapshot, moveTimeoutMs, transitionTimeoutMs) {
  const warp = snapshot.warps?.find((entry) => entry.targetLocation === "Farm");
  if (!warp) throw new Error("farm_warp_missing");
  if (!adjacent(snapshot.tile, warp))
    snapshot = await move(client, receipts, trace, snapshot, warp, "move_to_farm_warp", moveTimeoutMs);
  const accepted = await dispatch(client, trace, "travel", "travel", { x: warp.sourceX, y: warp.sourceY }, snapshot);
  const terminal = await waitForTerminal(receipts, accepted, transitionTimeoutMs);
  if (terminal.state !== "succeeded") throw new Error(`navigation_failed:${terminal.reasonCode}`);
  return waitForFreshSnapshot(client, {
    minRevision: terminal.revision,
    timeoutMs: transitionTimeoutMs,
    requireActionable: true,
    check: (latest) => latest.location === "Farm",
  });
}

async function move(client, receipts, trace, snapshot, target, phase, timeoutMs) {
  snapshot = await waitForActionable(client, snapshot, 10_000);
  const accepted = await dispatch(client, trace, phase, "move_to_tile", { x: target.x, y: target.y }, snapshot);
  const terminal = await waitForTerminal(receipts, accepted, timeoutMs);
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "target_reached")
    throw new Error(`navigation_failed:${terminal.reasonCode}`);
  return waitForFreshSnapshot(client, {
    minRevision: terminal.revision,
    timeoutMs,
    requireActionable: true,
    check: (latest) => adjacent(latest.tile, target),
  });
}

async function moveToReachableTarget(client, receipts, trace, snapshot, moveTimeoutMs) {
  if (chooseReachableWoodFenceTarget(snapshot)) return snapshot;
  for (let radius = 2; radius <= 12; radius++) {
    for (let dx = -radius; dx <= radius; dx++)
      for (let dy = -radius; dy <= radius; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        try {
          const moved = await move(
            client,
            receipts,
            trace,
            snapshot,
            { x: snapshot.tile.x + dx, y: snapshot.tile.y + dy },
            "move_to_native_place_wood_fence_fixture",
            moveTimeoutMs,
          );
          if (chooseReachableWoodFenceTarget(moved)) return moved;
          snapshot = moved;
        } catch (error) {
          const reason = String(error instanceof Error ? error.message : error);
          if (!reason.endsWith("no_native_path") && !reason.startsWith("navigation_failed:no_native_path")) throw error;
          snapshot = await observeFresh(client, { actionable: true });
          if (chooseReachableWoodFenceTarget(snapshot)) return snapshot;
        }
      }
  }
  throw new Error("no_reachable_native_place_wood_fence_fixture_target");
}

async function actionableSnapshot(client) {
  const snapshot = await observeFresh(client, { actionable: true });
  if (!Number.isInteger(snapshot.tile?.x) || !Number.isInteger(snapshot.tile?.y))
    throw new Error("native_local_wood_fence_snapshot_invalid");
  return snapshot;
}

function validateConfig(config) {
  if (config?.NativeLocalPlayerFixture?.Enable !== true) throw new Error("native_local_fixture_not_enabled");
  if (
    config.Portfolio?.Enable === true ||
    config.HostAutomation?.Enable === true ||
    config.HostFarmhandProvisioning?.Enable === true ||
    config.FarmhandProvisioner?.Enable === true
  )
    throw new Error("native_local_fixture_topology_not_isolated");
}
function requireCapabilities(snapshot) {
  for (const action of REQUIRED_CAPABILITIES)
    if (!snapshot.capabilities?.includes(action)) throw new Error(`native_local_${action}_capability_missing`);
}
function chooseReachableWoodFenceTarget(snapshot) {
  return (
    snapshot.woodFenceTargets?.find(
      (target) =>
        Number.isInteger(target?.slot) &&
        Number.isInteger(target?.x) &&
        Number.isInteger(target?.y) &&
        typeof target.targetId === "string" &&
        typeof target.qualifiedItemId === "string" &&
        adjacent(snapshot.tile, target),
    ) ?? null
  );
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
function parseStrictEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  const result = {};
  for (const field of detail.split(";")) {
    const index = field.indexOf("=");
    const key = index > 0 ? field.slice(0, index) : "";
    if (index <= 0 || index === field.length - 1 || !/^[a-z][a-z0-9_]{0,63}$/.test(key) || result[key] !== undefined)
      throw new Error("malformed_or_duplicate_fence_evidence");
    result[key] = field.slice(index + 1);
  }
  const expectedKeys = [
    "source",
    "location",
    "x",
    "y",
    "target",
    "item",
    "slot",
    "source_empty_before",
    "is_fence",
    "is_gate",
    "health",
    "max_health",
    "inventory_before",
    "inventory_after",
  ];
  if (Object.keys(result).length !== expectedKeys.length || !expectedKeys.every((key) => result[key] !== undefined))
    throw new Error("unknown_or_incomplete_fence_evidence");
  return result;
}
function summarize(snapshot) {
  return {
    ...summarizeSnapshot(snapshot),
    woodFenceTargets: snapshot.woodFenceTargets?.length ?? 0,
    woodFenceResultTargets: snapshot.woodFenceResultTargets?.length ?? 0,
  };
}
