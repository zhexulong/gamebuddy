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
  if (snapshot.location === "FarmHouse") snapshot = await travelToFarm(snapshot);
  else if (snapshot.location !== "Farm") throw new Error("clear_hoedirt_route_must_start_at_farmhouse_or_fixture_farm");
  const target = chooseHoeDirt(snapshot);
  const pickaxe = choosePickaxe(snapshot);
  const equipped = await execute("equip_pickaxe", "equip_tool", { slot: pickaxe.slot }, snapshot);
  if (equipped.state !== "succeeded" || equipped.reasonCode !== "tool_selected") throw new Error(`pickaxe_equip_failed:${equipped.reasonCode}`);

  snapshot = await actionableSnapshot();
  const freshTarget = findSameHoeDirt(snapshot, target);
  if (!freshTarget) throw new Error("clear_hoedirt_target_changed_after_equip");
  const accepted = await execute("clear_hoedirt", "clear_hoedirt", { slot: pickaxe.slot, x: freshTarget.x, y: freshTarget.y, expectedTargetId: freshTarget.targetId }, snapshot);
  if (accepted.state !== "succeeded" || accepted.reasonCode !== "hoedirt_cleared") throw new Error(`clear_hoedirt_failed:${accepted.reasonCode}`);

  const evidence = parseStrictEvidence(accepted.evidence);
  const after = await actionableSnapshot();
  const reread = findSameHoeDirt(after, freshTarget);
  const passed = evidence.target === freshTarget.targetId
    && evidence.location === freshTarget.location
    && evidence.tile === `${freshTarget.x},${freshTarget.y}`
    && evidence.tool === "pickaxe"
    && evidence.slot === String(pickaxe.slot)
    && evidence.crop_before === "false"
    && evidence.hoedirt_present_before === "true"
    && evidence.hoedirt_present_after === "false"
    && evidence.removed === "true"
    && reread === undefined;
  console.log(JSON.stringify({ state: passed ? "passed" : "blocked", topology: "native_local_player_fixture", reasonCode: passed ? "hoedirt_cleared" : "clear_hoedirt_postcondition_mismatch", target: freshTarget, receipt: summaryReceipt(accepted), evidence, trace, before: summary(snapshot), after: summary(after), durationMs: Date.now() - startedAt }));
  if (!passed) process.exitCode = 2;
} catch (error) {
  console.error(JSON.stringify({ state: "blocked", topology: "native_local_player_fixture", reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256), latestReceipt: summaryReceipt(client.state.latestReceipt), trace, durationMs: Date.now() - startedAt }));
  process.exitCode = 2;
} finally { unsubscribe(); client.close(); }

function validateConfig(value) {
  const fixture = value?.NativeLocalPlayerFixture;
  if (fixture?.Enable !== true || fixture.Bootstrap?.Enable === true || fixture.FixtureScenario !== "native_clear_hoedirt_v1" || value.ActionPolicyVersion !== 0 || !same(value.EnabledActions, ["move_to_tile", "travel", "equip_tool", "clear_hoedirt"])) throw new Error("native_local_clear_hoedirt_fixture_config_invalid");
  if (value.Portfolio?.Enable === true || value.HostAutomation?.Enable === true || value.HostFarmhandProvisioning?.Enable === true || value.FarmhandProvisioner?.Enable === true) throw new Error("native_local_clear_hoedirt_topology_invalid");
}
function requireCapabilities(snapshot) { if (!same([...(snapshot.capabilities ?? [])].sort(), ["cancel_active_execution", "clear_hoedirt", "equip_tool", "inspect_self", "move_to_tile", "travel"].sort())) throw new Error("native_local_clear_hoedirt_capability_not_isolated"); }
async function actionableSnapshot() { const snapshot = await client.observe(); if (!snapshot.actionable || snapshot.activeExecution != null || !Number.isInteger(snapshot.revision)) throw new Error("native_local_clear_hoedirt_snapshot_not_actionable"); return snapshot; }
async function execute(phase, action, args, snapshot) { if (!snapshot.actionable || snapshot.activeExecution != null) throw new Error(`${phase}_player_not_actionable`); const requestId = `native_local_clear_hoedirt_${phase}_${Date.now()}_${trace.length}`; const receipt = await client.execute({ requestId, idempotencyKey: `${requestId}_idem`, action, args, expectedRevision: snapshot.revision, deadlineMs: Date.now() + 30_000 }); trace.push({ phase, action, args, receipt: summaryReceipt(receipt) }); return receipt; }
async function travelToFarm(snapshot) {
  const warps = (snapshot.warps ?? []).filter((entry) => entry?.targetLocation === "Farm" && validTile(entry.sourceX) && validTile(entry.sourceY));
  if (warps.length !== 1) throw new Error(warps.length ? "ambiguous_farm_warp" : "farm_warp_missing");
  const warp = warps[0];
  if (!adjacent(snapshot.tile, { x: warp.sourceX, y: warp.sourceY })) snapshot = await move(snapshot, { x: warp.sourceX, y: warp.sourceY }, "move_to_farm_warp");
  const accepted = await execute("travel", "travel", { x: warp.sourceX, y: warp.sourceY }, snapshot);
  if (accepted.state !== "accepted") throw new Error(`travel_not_accepted:${accepted.reasonCode}`);
  return (await waitForTerminal(accepted, (latest) => latest.location === "Farm")).snapshot;
}
async function move(snapshot, target, phase) { const accepted = await execute(phase, "move_to_tile", target, snapshot); if (accepted.state !== "accepted") throw new Error(`${phase}_not_accepted:${accepted.reasonCode}`); return (await waitForTerminal(accepted, (latest) => latest.activeExecution == null && adjacent(latest.tile, target), 55_000)).snapshot; }
async function waitForTerminal(accepted, predicate, timeoutMs = 15_000) { const deadline = Date.now() + timeoutMs; let latest = await client.observe(); while (Date.now() < deadline) { const terminal = receipts.find((entry) => entry.executionId === accepted.executionId && entry.requestId === accepted.requestId && isTerminal(entry.state)); if (terminal?.state !== "succeeded") { if (terminal) throw new Error(`navigation_failed:${terminal.reasonCode}`); } if (terminal?.state === "succeeded" && predicate(latest)) { trace.push({ phase: "terminal", receipt: summaryReceipt(terminal) }); return { receipt: terminal, snapshot: latest }; } await delay(200); latest = await client.observe(); } throw new Error(`navigation_timeout:${accepted.executionId}`); }
function hoeDirtCandidates(snapshot) { return (snapshot.clearHoeDirtTargets ?? []).filter(validHoeDirt); }
function chooseHoeDirt(snapshot) { const targets = hoeDirtCandidates(snapshot); if (targets.length !== 1) throw new Error(targets.length ? "ambiguous_live_clear_hoedirt_target" : "no_live_clear_hoedirt_target"); return targets[0]; }
function findSameHoeDirt(snapshot, target) { return (snapshot.clearHoeDirtTargets ?? []).find((entry) => entry?.targetId === target.targetId && entry.x === target.x && entry.y === target.y && validHoeDirt(entry)); }
function choosePickaxe(snapshot) { const tools = (snapshot.toolSlots ?? []).filter((entry) => Number.isInteger(entry?.slot) && entry.label === "(T)Pickaxe"); if (tools.length !== 1) throw new Error(tools.length ? "ambiguous_live_pickaxe_slot" : "no_live_pickaxe_slot"); return tools[0]; }
function validHoeDirt(entry) { return typeof entry?.targetId === "string" && entry.targetId.length > 0 && typeof entry.location === "string" && entry.location.length > 0 && validTile(entry.x) && validTile(entry.y) && entry.crop === false && entry.ground === true; }
function parseStrictEvidence(receiptEvidence) { const detail = typeof receiptEvidence?.detail === "string" ? receiptEvidence.detail : ""; const expectedKeys = ["location", "target", "tile", "tool", "slot", "crop_before", "hoedirt_present_before", "hoedirt_present_after", "removed"]; const entries = detail.split(";").map((part) => { const index = part.indexOf("="); return index > 0 ? [part.slice(0, index), part.slice(index + 1)] : null; }); if (entries.some((entry) => entry === null)) return {}; const evidence = Object.fromEntries(entries); if (Object.keys(evidence).length !== expectedKeys.length || !expectedKeys.every((key) => key in evidence)) return {}; return evidence; }
function required(name) { const index = process.argv.indexOf(name); if (index < 0 || !process.argv[index + 1]) throw new Error(`missing_${name.slice(2)}`); return process.argv[index + 1]; }
function validTile(value) { return Number.isInteger(value) && value >= 0 && value <= 1000; }
function adjacent(left, right) { return Math.abs(left.x - right.x) <= 1 && Math.abs(left.y - right.y) <= 1; }
function same(left, right) { return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]); }
function isTerminal(state) { return ["succeeded", "failed", "invalidated", "cancelled", "expired", "uncertain", "rejected"].includes(state); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function summary(snapshot) { return { revision: snapshot.revision, location: snapshot.location, tile: snapshot.tile, actionable: snapshot.actionable, clearHoeDirtTargets: snapshot.clearHoeDirtTargets?.length ?? 0, activeExecution: snapshot.activeExecution ?? null }; }
function summaryReceipt(receipt) { return receipt ? { executionId: receipt.executionId, requestId: receipt.requestId, state: receipt.state, reasonCode: receipt.reasonCode, revision: receipt.revision, evidence: receipt.evidence ?? null } : null; }
