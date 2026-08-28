import {
  assertExactCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  summarizeSnapshot,
  waitForActionable,
  waitForFreshSnapshot,
  waitForStableRevision,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";

const SCENARIO = "native_chop_tree_source_v1";
const EXPECTED_ACTIONS = ["move_to_tile", "travel", "equip_tool", "chop_tree_source"];
const EXPECTED_CAPABILITIES = [
  "cancel_active_execution",
  "chop_tree_source",
  "equip_tool",
  "inspect_self",
  "move_to_tile",
  "travel",
].sort();

/** Execute the chop-tree-source contract against an already-connected bridge session. */
export async function runChopTreeSourceSmoke(
  client,
  receipts,
  config,
  {
    terminalTimeoutMs = 5_000,
    postconditionTimeoutMs = 5_000,
    stabilizeTimeoutMs = 10_000,
    moveTimeoutMs = 55_000,
    travelTimeoutMs = 15_000,
  } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  validateNativeLocalFixtureConfig(config);
  try {
    let snapshot = await observeFresh(client, { actionable: true });
    assertExactCapabilities(snapshot, EXPECTED_CAPABILITIES);
    if (snapshot.location !== "FarmHouse") throw new Error("chop_tree_source_route_must_start_at_farmhouse");
    snapshot = await travelToFarm(client, receipts, snapshot, trace, stabilizeTimeoutMs, travelTimeoutMs);
    snapshot = await moveToReachableChopTree(client, receipts, snapshot, trace, stabilizeTimeoutMs, moveTimeoutMs);
    const target = chooseChopTree(snapshot);
    const axe = chooseAxe(snapshot);
    const equipped = await execute(client, trace, "equip_axe", "equip_tool", { slot: axe.slot }, snapshot);
    if (equipped.state !== "succeeded" || equipped.reasonCode !== "tool_selected")
      throw new Error(`axe_equip_failed:${equipped.reasonCode}`);
    snapshot = await observeFresh(client, { actionable: true });
    const freshTarget = findSameChopTree(snapshot, target);
    if (!freshTarget || freshTarget.health !== 1 || freshTarget.stump !== false)
      throw new Error("tree_chop_target_changed_after_equip");
    const accepted = await execute(
      client,
      trace,
      "chop_tree_source",
      "chop_tree_source",
      { slot: axe.slot, x: freshTarget.x, y: freshTarget.y, expectedTargetId: freshTarget.targetId },
      snapshot,
    );
    const receipt = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    if (receipt.state !== "succeeded" || receipt.reasonCode !== "tree_source_chopped")
      throw new Error(`chop_tree_source_failed:${receipt.reasonCode}`);
    const evidence = parseEvidence(receipt.evidence);
    const after = await waitForStableRevision(client, {
      revision: receipt.revision,
      timeoutMs: postconditionTimeoutMs,
      check: (latest) => latest.actionable === true && latest.activeExecution == null,
    });
    const reread = findSameChopResult(after, freshTarget);
    const passed =
      after.revision === receipt.revision &&
      evidence.target === freshTarget.targetId &&
      evidence.tool === "axe" &&
      evidence.slot === String(axe.slot) &&
      evidence.health_before === "1" &&
      evidence.health_after === "5" &&
      evidence.stump_before === "false" &&
      evidence.stump_after === "true" &&
      evidence.source_transformed === "true" &&
      reread?.health === 5 &&
      reread.stump === true &&
      reread.moss === false &&
      reread.tapped === false;
    return {
      state: passed ? "passed" : "blocked",
      topology: "native_local_player_fixture",
      reasonCode: passed ? "tree_source_chopped" : "chop_tree_source_postcondition_mismatch",
      target: freshTarget,
      receipt: summarizeReceipt(receipt),
      evidence,
      trace,
      before: summarizeWithChop(snapshot),
      after: summarizeWithChop(after),
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      state: "blocked",
      topology: "native_local_player_fixture",
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
    const result = await runChopTreeSourceSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}

async function execute(client, trace, phase, action, args, snapshot) {
  if (snapshot.actionable !== true || snapshot.activeExecution != null)
    throw new Error(`${phase}_player_not_actionable`);
  const nonce = `${Date.now()}_${trace.length}`;
  const requestId = `native_local_chop_tree_source_${phase}_${nonce}`;
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
  const accepted = await execute(client, trace, "travel", "travel", { x: warp.sourceX, y: warp.sourceY }, fresh);
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

async function moveToReachableChopTree(client, receipts, snapshot, trace, stabilizeTimeoutMs, moveTimeoutMs) {
  if (chopTreeCandidates(snapshot).length === 1) return snapshot;
  for (let radius = 1; radius <= 12; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const target = { x: snapshot.tile.x + dx, y: snapshot.tile.y + dy };
        if (!validTile(target.x) || !validTile(target.y)) continue;
        try {
          snapshot = await moveToTile(
            client,
            receipts,
            snapshot,
            target,
            "move_to_chop_tree_fixture",
            trace,
            stabilizeTimeoutMs,
            moveTimeoutMs,
          );
          if (chopTreeCandidates(snapshot).length === 1) return snapshot;
        } catch (error) {
          const reason = String(error instanceof Error ? error.message : error);
          if (!reason.endsWith("_not_accepted:no_native_path") && !reason.startsWith("move_failed:no_native_path"))
            throw error;
          snapshot = await observeFresh(client, { actionable: true });
          if (chopTreeCandidates(snapshot).length === 1) return snapshot;
        }
      }
    }
  }
  throw new Error("no_reachable_unique_native_chop_tree_target");
}

async function moveToTile(client, receipts, snapshot, target, phase, trace, stabilizeTimeoutMs, terminalTimeoutMs) {
  snapshot = await waitForActionable(client, snapshot, stabilizeTimeoutMs);
  const accepted = await execute(client, trace, phase, "move_to_tile", target, snapshot);
  if (accepted.state !== "accepted") throw new Error(`${phase}_not_accepted:${accepted.reasonCode}`);
  const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "target_reached")
    throw new Error(`move_failed:${terminal.reasonCode}`);
  return waitForFreshSnapshot(client, {
    minRevision: terminal.revision,
    timeoutMs: stabilizeTimeoutMs,
    requireActionable: true,
    check: (latest) => latest.activeExecution == null && adjacent(latest.tile, target),
  });
}

function chopTreeCandidates(snapshot) {
  return (snapshot.treeChopSourceTargets ?? []).filter(
    (entry) => validChopTree(entry) && entry.health === 1 && entry.stump === false,
  );
}
function chooseChopTree(snapshot) {
  const targets = chopTreeCandidates(snapshot);
  if (targets.length !== 1)
    throw new Error(targets.length ? "ambiguous_live_tree_chop_target" : "no_live_tree_chop_target");
  return targets[0];
}
function findSameChopTree(snapshot, target) {
  return (snapshot.treeChopSourceTargets ?? []).find(
    (entry) =>
      entry?.targetId === target.targetId && entry.x === target.x && entry.y === target.y && validChopTree(entry),
  );
}
function findSameChopResult(snapshot, target) {
  return (snapshot.treeChopResultTargets ?? []).find(
    (entry) =>
      validChopResult(entry) &&
      entry.location === target.location &&
      entry.x === target.x &&
      entry.y === target.y &&
      entry.treeType === target.treeType,
  );
}
function chooseAxe(snapshot) {
  const axes = (snapshot.toolSlots ?? []).filter((entry) => Number.isInteger(entry?.slot) && entry.label === "(T)Axe");
  if (axes.length !== 1) throw new Error(axes.length ? "ambiguous_live_axe_slot" : "no_live_axe_slot");
  return axes[0];
}
function validChopTree(entry) {
  return (
    typeof entry?.targetId === "string" &&
    entry.targetId.length > 0 &&
    validTile(entry.x) &&
    validTile(entry.y) &&
    typeof entry.location === "string" &&
    entry.location.length > 0 &&
    typeof entry.treeType === "string" &&
    entry.treeType.length > 0 &&
    Number.isInteger(entry.growthStage) &&
    Number.isFinite(entry.health) &&
    entry.stump === false &&
    entry.moss === false &&
    entry.tapped === false
  );
}
function validChopResult(entry) {
  return (
    typeof entry?.targetId === "string" &&
    entry.targetId.length > 0 &&
    validTile(entry.x) &&
    validTile(entry.y) &&
    typeof entry.location === "string" &&
    entry.location.length > 0 &&
    typeof entry.treeType === "string" &&
    entry.treeType.length > 0 &&
    Number.isFinite(entry.health) &&
    entry.stump === true &&
    entry.moss === false &&
    entry.tapped === false
  );
}
function parseEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  return Object.fromEntries(
    detail.split(";").flatMap((part) => {
      const index = part.indexOf("=");
      return index > 0 ? [[part.slice(0, index), part.slice(index + 1)]] : [];
    }),
  );
}
function validTile(value) {
  return Number.isInteger(value) && value >= 0 && value <= 1000;
}
function adjacent(left, right) {
  return Math.abs(left.x - right.x) <= 1 && Math.abs(left.y - right.y) <= 1;
}
function resolveFarmWarp(snapshot) {
  const warps = (snapshot.warps ?? []).filter(
    (entry) => entry?.targetLocation === "Farm" && validTile(entry.sourceX) && validTile(entry.sourceY),
  );
  if (warps.length !== 1) throw new Error(warps.length ? "ambiguous_farm_warp" : "farm_warp_missing");
  return warps[0];
}
function summarizeWithChop(snapshot) {
  return {
    ...summarizeSnapshot(snapshot),
    treeChopSourceTargets: Array.isArray(snapshot.treeChopSourceTargets) ? snapshot.treeChopSourceTargets.length : 0,
    treeChopResultTargets: Array.isArray(snapshot.treeChopResultTargets) ? snapshot.treeChopResultTargets.length : 0,
  };
}
function validateNativeLocalFixtureConfig(value) {
  const fixture = value?.NativeLocalPlayerFixture;
  if (
    fixture?.Enable !== true ||
    fixture.Bootstrap?.Enable === true ||
    fixture.FixtureScenario !== SCENARIO ||
    !validFixtureSlotRelationship(fixture.LogicalSaveName, fixture.ObservedSaveSlot)
  )
    throw new Error("native_local_fixture_config_invalid");
  if (
    value.Portfolio?.Enable !== false ||
    value.HostAutomation?.Enable !== false ||
    value.HostFarmhandProvisioning?.Enable !== false ||
    value.FarmhandProvisioner?.Enable !== false
  )
    throw new Error("native_local_fixture_topology_not_isolated");
  if (
    value.ActionPolicyVersion !== 0 ||
    JSON.stringify(value.EnabledActions) !== JSON.stringify(EXPECTED_ACTIONS) ||
    JSON.stringify(value.ExperimentalActions ?? []) !== JSON.stringify([])
  )
    throw new Error("native_local_chop_tree_source_action_policy_invalid");
}
function validFixtureSlotRelationship(logicalName, observedSaveSlot) {
  return (
    typeof logicalName === "string" &&
    /^GameBuddyFixture[A-Za-z0-9]{0,64}$/.test(logicalName) &&
    typeof observedSaveSlot === "string" &&
    new RegExp(`^${logicalName}_[0-9]{1,32}$`).test(observedSaveSlot)
  );
}
