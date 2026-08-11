import { readFile } from "node:fs/promises";
import { LocalStardewBridgeClient } from "../host/dist-test/local-stardew-bridge.js";

const ACTION_LOAD = "machine_load";
const ACTION_COLLECT = "machine_collect_output";
const SCENARIO = "native_machine_coffee_load_v1";
const EXPECTED_ACTIONS = [ACTION_LOAD, ACTION_COLLECT];
const EXPECTED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION_LOAD, ACTION_COLLECT];
const config = JSON.parse(await readFile(required("--client-config"), "utf8"));
validateConfig(config);
const scope = { integrationId: "stardew", saveId: config.SaveId, worldId: config.WorldId, playerId: config.PlayerId, companionId: config.CompanionId };
const client = await LocalStardewBridgeClient.connect(scope, config.PipeName, config.BridgeToken);
const startedAt = Date.now();
const receipts = [];
const trace = [];
const unsubscribe = client.onFact((fact) => { if (fact.type === "execution_receipt") receipts.push(fact.payload); });
try {
  const before = await actionableSnapshot();
  requireExactCapabilities(before);
  const loadTarget = chooseOnlyLoadableKeg(before);
  const loadAccepted = await execute(ACTION_LOAD, {
    slot: loadTarget.loadInputSlot, x: loadTarget.x, y: loadTarget.y,
    expectedQualifiedItemId: loadTarget.loadInputQualifiedItemId, expectedTargetId: loadTarget.targetId,
  }, before);
  const loadTerminal = await terminalFor(loadAccepted, 5_000, "machine_load_terminal_timeout");
  if (loadTerminal.state !== "succeeded" || loadTerminal.reasonCode !== "machine_coffee_loaded") throw new Error(`machine_load_failed:${loadTerminal.reasonCode}`);
  const loaded = await actionableSnapshot();
  const processingTarget = (loaded.machineTargets ?? []).find((entry) => entry?.targetId === loadTarget.targetId);
  if (!isProcessingCoffee(processingTarget)) throw new Error("machine_collect_processing_postcondition_mismatch");

  const ready = await waitForReadyTarget(loadTarget.targetId, 180_000);
  const collectAccepted = await execute(ACTION_COLLECT, { x: ready.x, y: ready.y, expectedTargetId: ready.targetId }, await actionableSnapshot());
  const collectTerminal = await terminalFor(collectAccepted, 5_000, "machine_collect_terminal_timeout");
  if (collectTerminal.state !== "succeeded" || collectTerminal.reasonCode !== "machine_coffee_collected") throw new Error(`machine_collect_failed:${collectTerminal.reasonCode}`);
  const evidence = parseEvidence(collectTerminal.evidence);
  const after = await actionableSnapshot();
  requireExactCapabilities(after);
  const reread = (after.machineTargets ?? []).find((entry) => entry?.targetId === loadTarget.targetId);
  const passed = evidence.machine === "(BC)12" && evidence.output === "(O)395" && evidence.input === "(O)433"
    && evidence.ready_before === "true" && evidence.minutes_until_ready_before === "0"
    && evidence.inventory_coffee_after === String(Number(evidence.inventory_coffee_before) + 1)
    && evidence.held_after === "none" && evidence.ready_after === "false" && evidence.native_check_action === "true"
    && reread?.heldObjectQualifiedItemId == null && reread?.readyForHarvest === false && reread?.minutesUntilReady === 0 && reread?.collectOutputReady === false;
  console.log(JSON.stringify({ state: passed ? "passed" : "blocked", topology: "native_local_player_fixture", reasonCode: passed ? "machine_coffee_collected" : "machine_collect_postcondition_mismatch", loadTarget: summarizeTarget(loadTarget), readyTarget: summarizeTarget(ready), loadReceipt: summarizeReceipt(loadTerminal), collectReceipt: summarizeReceipt(collectTerminal), evidence, reread: summarizeTarget(reread), trace, before: summarizeSnapshot(before), loaded: summarizeSnapshot(loaded), after: summarizeSnapshot(after), durationMs: Date.now() - startedAt }));
  if (!passed) process.exitCode = 2;
} catch (error) {
  console.error(JSON.stringify({ state: "blocked", topology: "native_local_player_fixture", reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256), latestReceipt: summarizeReceipt(client.state.latestReceipt), trace, durationMs: Date.now() - startedAt }));
  process.exitCode = 2;
} finally { unsubscribe(); client.close(); }

function validateConfig(value) {
  const fixture = value?.NativeLocalPlayerFixture;
  if (fixture?.Enable !== true || fixture.Bootstrap?.Enable === true || fixture.FixtureScenario !== SCENARIO || value.ActionPolicyVersion !== 0 || !same(value.EnabledActions, EXPECTED_ACTIONS)) throw new Error("native_local_machine_collect_fixture_config_invalid");
  if (value.Portfolio?.Enable === true || value.HostAutomation?.Enable === true || value.HostFarmhandProvisioning?.Enable === true || value.FarmhandProvisioner?.Enable === true) throw new Error("native_local_machine_collect_topology_invalid");
}
function requireExactCapabilities(snapshot) { if (!same([...(snapshot.capabilities ?? [])].sort(), [...EXPECTED_CAPABILITIES].sort())) throw new Error("native_local_machine_collect_capability_not_isolated"); }
async function actionableSnapshot() { const snapshot = await client.observe(); if (!snapshot?.actionable || snapshot.activeExecution != null || !Number.isInteger(snapshot.revision) || !Array.isArray(snapshot.machineTargets)) throw new Error("native_local_machine_collect_snapshot_not_actionable"); return snapshot; }
function chooseOnlyLoadableKeg(snapshot) { const targets = snapshot.machineTargets.filter((entry) => entry?.qualifiedItemId === "(BC)12" && Number.isInteger(entry.x) && Number.isInteger(entry.y) && typeof entry.targetId === "string" && entry.readyForHarvest === false && entry.minutesUntilReady === 0 && entry.heldObjectQualifiedItemId == null && entry.lastInputQualifiedItemId == null && Number.isInteger(entry.loadInputSlot) && entry.loadInputQualifiedItemId === "(O)433" && entry.loadInputStack === 5); if (targets.length !== 1) throw new Error(targets.length ? "ambiguous_loadable_keg" : "no_loadable_keg"); return targets[0]; }
function isProcessingCoffee(entry) { return entry?.qualifiedItemId === "(BC)12" && entry.readyForHarvest === false && entry.minutesUntilReady > 0 && entry.heldObjectQualifiedItemId === "(O)395" && entry.lastInputQualifiedItemId === "(O)433"; }
async function waitForReadyTarget(targetId, timeoutMs) { const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { const snapshot = await actionableSnapshot(); const entry = snapshot.machineTargets.find((candidate) => candidate?.targetId === targetId); if (entry?.qualifiedItemId === "(BC)12" && entry.readyForHarvest === true && entry.minutesUntilReady === 0 && entry.heldObjectQualifiedItemId === "(O)395" && entry.lastInputQualifiedItemId === "(O)433" && entry.collectOutputReady === true) return entry; await delay(500); } throw new Error("machine_ready_timeout_without_time_skip"); }
async function execute(action, args, snapshot) { const requestId = `native_local_${action}_${Date.now()}`; const receipt = await client.execute({ requestId, idempotencyKey: `${requestId}_idem`, action, args, expectedRevision: snapshot.revision, deadlineMs: Date.now() + 30_000 }); trace.push({ action, args, receipt: summarizeReceipt(receipt) }); return receipt; }
async function terminalFor(receipt, timeoutMs, code) { if (isTerminal(receipt?.state)) return requireIdentity(receipt, receipt.executionId, receipt.requestId); const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { const terminal = receipts.find((item) => item.executionId === receipt?.executionId && item.requestId === receipt?.requestId && isTerminal(item.state)); if (terminal) return requireIdentity(terminal, receipt.executionId, receipt.requestId); await delay(100); } throw new Error(code); }
function requireIdentity(receipt, executionId, requestId) { if (receipt?.executionId !== executionId || receipt?.requestId !== requestId) throw new Error("machine_collect_receipt_identity_mismatch"); return receipt; }
function parseEvidence(receiptEvidence) { const detail = typeof receiptEvidence?.detail === "string" ? receiptEvidence.detail : ""; const fields = Object.fromEntries(detail.split(";").map((part) => { const index = part.indexOf("="); return index > 0 ? [part.slice(0, index), part.slice(index + 1)] : ["", ""]; })); const expected = ["location", "target", "tile", "machine", "output", "input", "ready_before", "minutes_until_ready_before", "inventory_coffee_before", "inventory_coffee_after", "held_after", "ready_after", "native_check_action"]; if (Object.keys(fields).length !== expected.length || !expected.every((key) => typeof fields[key] === "string" && fields[key].length > 0)) throw new Error("invalid_machine_collect_evidence"); return fields; }
function same(left, right) { return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]); }
function isTerminal(state) { return ["succeeded", "failed", "invalidated", "cancelled", "expired", "uncertain", "rejected"].includes(state); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function required(name) { const index = process.argv.indexOf(name); if (index < 0 || !process.argv[index + 1]) throw new Error(`missing_${name.slice(2)}`); return process.argv[index + 1]; }
function summarizeTarget(value) { return value ? { targetId: value.targetId, x: value.x, y: value.y, qualifiedItemId: value.qualifiedItemId, readyForHarvest: value.readyForHarvest, minutesUntilReady: value.minutesUntilReady, heldObjectQualifiedItemId: value.heldObjectQualifiedItemId, lastInputQualifiedItemId: value.lastInputQualifiedItemId, collectOutputReady: value.collectOutputReady } : null; }
function summarizeReceipt(value) { return value ? { executionId: value.executionId, requestId: value.requestId, state: value.state, reasonCode: value.reasonCode, revision: value.revision } : null; }
function summarizeSnapshot(value) { return { revision: value.revision, location: value.location, tile: value.tile, capabilities: value.capabilities, machineTargets: value.machineTargets?.map(summarizeTarget) }; }
