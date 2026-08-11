import { readFile } from "node:fs/promises";
import { LocalStardewBridgeClient } from "../host/dist-test/local-stardew-bridge.js";

const config = JSON.parse(await readFile(required("--client-config"), "utf8"));
validateConfig(config);
const scope = { integrationId: "stardew", saveId: config.SaveId, worldId: config.WorldId, playerId: config.PlayerId, companionId: config.CompanionId };
const client = await LocalStardewBridgeClient.connect(scope, config.PipeName, config.BridgeToken);
const receipts = [];
const trace = [];
const startedAt = Date.now();
const unsubscribe = client.onFact((fact) => { if (fact.type === "execution_receipt") receipts.push(fact.payload); });

try {
  let snapshot = await actionableSnapshot();
  requireCapabilities(snapshot);
  if (snapshot.location !== "FarmHouse") throw new Error("chop_tree_source_route_must_start_at_farmhouse");
  snapshot = await travelToFarm(snapshot);
  snapshot = await moveToReachableChopTree(snapshot);
  const target = chooseChopTree(snapshot);
  const axe = chooseAxe(snapshot);
  const equipped = await execute("equip_axe", "equip_tool", { slot: axe.slot }, snapshot);
  if (equipped.state !== "succeeded" || equipped.reasonCode !== "tool_selected") throw new Error(`axe_equip_failed:${equipped.reasonCode}`);
  snapshot = await actionableSnapshot();
  const freshTarget = findSameChopTree(snapshot, target);
  if (!freshTarget || freshTarget.health !== 1 || freshTarget.stump !== false) throw new Error("tree_chop_target_changed_after_equip");
  const accepted = await execute("chop_tree_source", "chop_tree_source", { slot: axe.slot, x: freshTarget.x, y: freshTarget.y, expectedTargetId: freshTarget.targetId }, snapshot);
  if (accepted.state !== "succeeded" || accepted.reasonCode !== "tree_source_chopped") throw new Error(`chop_tree_source_failed:${accepted.reasonCode}`);
  const evidence = parseEvidence(accepted.evidence);
  const after = await actionableSnapshot();
  const reread = findSameChopResult(after, freshTarget);
  const passed = evidence.target === freshTarget.targetId && evidence.tool === "axe" && evidence.slot === String(axe.slot)
    && evidence.health_before === "1" && evidence.health_after === "5" && evidence.stump_before === "false"
    && evidence.stump_after === "true" && evidence.source_transformed === "true"
    && reread?.health === 5 && reread.stump === true && reread.moss === false && reread.tapped === false;
  console.log(JSON.stringify({ state: passed ? "passed" : "blocked", topology: "native_local_player_fixture", reasonCode: passed ? "tree_source_chopped" : "chop_tree_source_postcondition_mismatch", target: freshTarget, receipt: summaryReceipt(accepted), evidence, trace, before: summary(snapshot), after: summary(after), durationMs: Date.now() - startedAt }));
  if (!passed) process.exitCode = 2;
} catch (error) {
  console.error(JSON.stringify({ state: "blocked", topology: "native_local_player_fixture", reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256), latestReceipt: summaryReceipt(client.state.latestReceipt), trace, durationMs: Date.now() - startedAt }));
  process.exitCode = 2;
} finally { unsubscribe(); client.close(); }

function validateConfig(value) {
  const fixture = value?.NativeLocalPlayerFixture;
  if (fixture?.Enable !== true || fixture.Bootstrap?.Enable === true || fixture.FixtureScenario !== "native_chop_tree_source_v1" || value.ActionPolicyVersion !== 0 || !same(value.EnabledActions, ["move_to_tile", "travel", "equip_tool", "chop_tree_source"])) throw new Error("native_local_chop_tree_source_fixture_config_invalid");
  if (value.Portfolio?.Enable === true || value.HostAutomation?.Enable === true || value.HostFarmhandProvisioning?.Enable === true || value.FarmhandProvisioner?.Enable === true) throw new Error("native_local_chop_tree_source_topology_invalid");
}
function requireCapabilities(snapshot) { if (!same([...(snapshot.capabilities ?? [])].sort(), ["cancel_active_execution", "chop_tree_source", "equip_tool", "inspect_self", "move_to_tile", "travel"].sort())) throw new Error("native_local_chop_tree_source_capability_not_isolated"); }
async function actionableSnapshot() { const snapshot = await client.observe(); if (!snapshot.actionable || snapshot.activeExecution != null || !Number.isInteger(snapshot.revision)) throw new Error("native_local_chop_tree_source_snapshot_not_actionable"); return snapshot; }
async function execute(phase, action, args, snapshot) { if (!snapshot.actionable || snapshot.activeExecution != null) throw new Error(`${phase}_player_not_actionable`); const requestId = `native_local_chop_tree_source_${phase}_${Date.now()}_${trace.length}`; const receipt = await client.execute({ requestId, idempotencyKey: `${requestId}_idem`, action, args, expectedRevision: snapshot.revision, deadlineMs: Date.now() + 30_000 }); trace.push({ phase, action, args, receipt: summaryReceipt(receipt) }); return receipt; }
async function travelToFarm(snapshot) {
  const warps = (snapshot.warps ?? []).filter((entry) => entry?.targetLocation === "Farm" && validTile(entry.sourceX) && validTile(entry.sourceY));
  if (warps.length !== 1) throw new Error(warps.length ? "ambiguous_farm_warp" : "farm_warp_missing");
  const warp = warps[0];
  if (!adjacent(snapshot.tile, { x: warp.sourceX, y: warp.sourceY })) snapshot = await move(snapshot, { x: warp.sourceX, y: warp.sourceY }, "move_to_farm_warp");
  const accepted = await execute("travel", "travel", { x: warp.sourceX, y: warp.sourceY }, snapshot);
  if (accepted.state !== "accepted") throw new Error(`travel_not_accepted:${accepted.reasonCode}`);
  return (await waitForTerminal(accepted, (latest) => latest.location === "Farm")).snapshot;
}
async function moveToReachableChopTree(snapshot) {
  if (chopTreeCandidates(snapshot).length === 1) return snapshot;
  for (let radius = 1; radius <= 12; radius++) for (let dx = -radius; dx <= radius; dx++) for (let dy = -radius; dy <= radius; dy++) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
    const target = { x: snapshot.tile.x + dx, y: snapshot.tile.y + dy };
    if (!validTile(target.x) || !validTile(target.y)) continue;
    try { snapshot = await move(snapshot, target, "move_to_chop_tree_fixture"); if (chopTreeCandidates(snapshot).length === 1) return snapshot; }
    catch (error) { const reason = String(error instanceof Error ? error.message : error); if (!reason.includes("no_native_path")) throw error; snapshot = await actionableSnapshot(); if (chopTreeCandidates(snapshot).length === 1) return snapshot; }
  }
  throw new Error("no_reachable_unique_native_chop_tree_target");
}
async function move(snapshot, target, phase) { const accepted = await execute(phase, "move_to_tile", target, snapshot); if (accepted.state !== "accepted") throw new Error(`${phase}_not_accepted:${accepted.reasonCode}`); return (await waitForTerminal(accepted, (latest) => latest.activeExecution == null && adjacent(latest.tile, target), 55_000)).snapshot; }
async function waitForTerminal(accepted, predicate, timeoutMs = 15_000) { const deadline = Date.now() + timeoutMs; let latest = await client.observe(); while (Date.now() < deadline) { const terminal = receipts.find((entry) => entry.executionId === accepted.executionId && entry.requestId === accepted.requestId && isTerminal(entry.state)); if (terminal?.state !== "succeeded") { if (terminal) throw new Error(`navigation_failed:${terminal.reasonCode}`); } if (terminal?.state === "succeeded" && predicate(latest)) { trace.push({ phase: "terminal", receipt: summaryReceipt(terminal) }); return { receipt: terminal, snapshot: latest }; } await delay(200); latest = await client.observe(); } throw new Error(`navigation_timeout:${accepted.executionId}`); }
function chopTreeCandidates(snapshot) { return (snapshot.treeChopSourceTargets ?? []).filter((entry) => validChopTree(entry) && entry.health === 1 && entry.stump === false); }
function chooseChopTree(snapshot) { const targets = chopTreeCandidates(snapshot); if (targets.length !== 1) throw new Error(targets.length ? "ambiguous_live_tree_chop_target" : "no_live_tree_chop_target"); return targets[0]; }
function findSameChopTree(snapshot, target) { return (snapshot.treeChopSourceTargets ?? []).find((entry) => entry?.targetId === target.targetId && entry.x === target.x && entry.y === target.y && validChopTree(entry)); }
function findSameChopResult(snapshot, target) { return (snapshot.treeChopResultTargets ?? []).find((entry) => validChopResult(entry) && entry.location === target.location && entry.x === target.x && entry.y === target.y && entry.treeType === target.treeType); }
function chooseAxe(snapshot) { const axes = (snapshot.toolSlots ?? []).filter((entry) => Number.isInteger(entry?.slot) && entry.label === "(T)Axe"); if (axes.length !== 1) throw new Error(axes.length ? "ambiguous_live_axe_slot" : "no_live_axe_slot"); return axes[0]; }
function validChopTree(entry) { return typeof entry?.targetId === "string" && entry.targetId.length > 0 && validTile(entry.x) && validTile(entry.y) && typeof entry.location === "string" && entry.location.length > 0 && typeof entry.treeType === "string" && entry.treeType.length > 0 && Number.isInteger(entry.growthStage) && Number.isFinite(entry.health) && entry.stump === false && entry.moss === false && entry.tapped === false; }
function validChopResult(entry) { return typeof entry?.targetId === "string" && entry.targetId.length > 0 && validTile(entry.x) && validTile(entry.y) && typeof entry.location === "string" && entry.location.length > 0 && typeof entry.treeType === "string" && entry.treeType.length > 0 && Number.isFinite(entry.health) && entry.stump === true && entry.moss === false && entry.tapped === false; }
function parseEvidence(evidence) { const detail = typeof evidence?.detail === "string" ? evidence.detail : ""; return Object.fromEntries(detail.split(";").flatMap((part) => { const index = part.indexOf("="); return index > 0 ? [[part.slice(0, index), part.slice(index + 1)]] : []; })); }
function required(name) { const index = process.argv.indexOf(name); if (index < 0 || !process.argv[index + 1]) throw new Error(`missing_${name.slice(2)}`); return process.argv[index + 1]; }
function validTile(value) { return Number.isInteger(value) && value >= 0 && value <= 1000; }
function adjacent(left, right) { return Math.abs(left.x - right.x) <= 1 && Math.abs(left.y - right.y) <= 1; }
function same(left, right) { return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]); }
function isTerminal(state) { return ["succeeded", "failed", "invalidated", "cancelled", "expired", "uncertain", "rejected"].includes(state); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function summary(snapshot) { return { revision: snapshot.revision, location: snapshot.location, tile: snapshot.tile, actionable: snapshot.actionable, treeChopSourceTargets: snapshot.treeChopSourceTargets?.length ?? 0, treeChopResultTargets: snapshot.treeChopResultTargets?.length ?? 0, activeExecution: snapshot.activeExecution ?? null }; }
function summaryReceipt(receipt) { return receipt ? { executionId: receipt.executionId, requestId: receipt.requestId, state: receipt.state, reasonCode: receipt.reasonCode, revision: receipt.revision, evidence: receipt.evidence ?? null } : null; }
