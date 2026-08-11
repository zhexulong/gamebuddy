import { readFile } from "node:fs/promises";
import { LocalStardewBridgeClient } from "../host/dist-test/local-stardew-bridge.js";

const ACTION = "machine_load";
const SCENARIO = "native_machine_coffee_load_v1";
const EXPECTED_ACTIONS = [ACTION];
const EXPECTED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];
const config = JSON.parse(await readFile(required("--client-config"), "utf8"));
validateConfig(config);
const scope = { integrationId: "stardew", saveId: config.SaveId, worldId: config.WorldId, playerId: config.PlayerId, companionId: config.CompanionId };
const client = await LocalStardewBridgeClient.connect(scope, config.PipeName, config.BridgeToken);
const receipts = [];
const trace = [];
const startedAt = Date.now();
const unsubscribe = client.onFact((fact) => { if (fact.type === "execution_receipt") receipts.push(fact.payload); });

try {
  const before = await actionableSnapshot();
  requireExactCapabilities(before);
  const target = chooseOnlyLoadableKeg(before);
  const accepted = await execute(ACTION, {
    slot: target.loadInputSlot,
    x: target.x,
    y: target.y,
    expectedQualifiedItemId: target.loadInputQualifiedItemId,
    expectedTargetId: target.targetId,
  }, before);
  const terminal = await terminalFor(accepted, 5_000);
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "machine_coffee_loaded") throw new Error(`machine_load_failed:${terminal.reasonCode}`);
  const evidence = parseEvidence(terminal.evidence);
  const after = await actionableSnapshot();
  requireExactCapabilities(after);
  const reread = (after.machineTargets ?? []).find((entry) => entry?.targetId === target.targetId);
  const passed = terminal.executionId === accepted.executionId && terminal.requestId === accepted.requestId
    && after.revision >= terminal.revision
    && reread?.qualifiedItemId === "(BC)12" && reread.readyForHarvest === false && reread.minutesUntilReady === 120
    && reread.heldObjectQualifiedItemId === "(O)395" && reread.lastInputQualifiedItemId === "(O)433"
    && evidence.location === before.location && evidence.target === target.targetId && evidence.tile === `${target.x},${target.y}`
    && evidence.machine === "(BC)12" && evidence.slot === String(target.loadInputSlot)
    && evidence.input === "(O)433" && evidence.input_stack_before === "5" && evidence.input_stack_after === "removed"
    && evidence.last_input === "(O)433" && evidence.held === "(O)395" && evidence.ready_for_harvest === "false"
    && evidence.minutes_until_ready === "120" && evidence.native_check_action === "true";
  console.log(JSON.stringify({ state: passed ? "passed" : "blocked", topology: "native_local_player_fixture", reasonCode: passed ? "machine_coffee_loaded" : "machine_load_postcondition_mismatch", target: summarizeTarget(target), receipt: summarizeReceipt(terminal), evidence, reread: summarizeTarget(reread), trace, before: summarizeSnapshot(before), after: summarizeSnapshot(after), durationMs: Date.now() - startedAt }));
  if (!passed) process.exitCode = 2;
} catch (error) {
  console.error(JSON.stringify({ state: "blocked", topology: "native_local_player_fixture", reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256), latestReceipt: summarizeReceipt(client.state.latestReceipt), trace, durationMs: Date.now() - startedAt }));
  process.exitCode = 2;
} finally {
  unsubscribe();
  client.close();
}

function validateConfig(value) {
  const fixture = value?.NativeLocalPlayerFixture;
  if (fixture?.Enable !== true || fixture.Bootstrap?.Enable === true || fixture.FixtureScenario !== SCENARIO || value.ActionPolicyVersion !== 0 || !same(value.EnabledActions, EXPECTED_ACTIONS)) throw new Error("native_local_machine_load_fixture_config_invalid");
  if (value.Portfolio?.Enable === true || value.HostAutomation?.Enable === true || value.HostFarmhandProvisioning?.Enable === true || value.FarmhandProvisioner?.Enable === true) throw new Error("native_local_machine_load_topology_invalid");
}
function requireExactCapabilities(snapshot) { if (!same([...(snapshot.capabilities ?? [])].sort(), [...EXPECTED_CAPABILITIES].sort())) throw new Error("native_local_machine_load_capability_not_isolated"); }
async function actionableSnapshot() { const snapshot = await client.observe(); if (!snapshot?.actionable || snapshot.activeExecution != null || !Number.isInteger(snapshot.revision) || !Array.isArray(snapshot.machineTargets)) throw new Error("native_local_machine_load_snapshot_not_actionable"); return snapshot; }
function chooseOnlyLoadableKeg(snapshot) {
  const targets = snapshot.machineTargets.filter((entry) => entry?.qualifiedItemId === "(BC)12" && Number.isInteger(entry.x) && Number.isInteger(entry.y) && typeof entry.targetId === "string"
    && entry.readyForHarvest === false && entry.minutesUntilReady === 0 && entry.heldObjectQualifiedItemId == null && entry.lastInputQualifiedItemId == null
    && Number.isInteger(entry.loadInputSlot) && entry.loadInputQualifiedItemId === "(O)433" && entry.loadInputStack === 5);
  if (targets.length !== 1) throw new Error(targets.length ? "ambiguous_loadable_keg" : "no_loadable_keg");
  return targets[0];
}
async function execute(action, args, snapshot) { const requestId = `native_local_machine_load_${Date.now()}`; const receipt = await client.execute({ requestId, idempotencyKey: `${requestId}_idem`, action, args, expectedRevision: snapshot.revision, deadlineMs: Date.now() + 30_000 }); trace.push({ action, args, receipt: summarizeReceipt(receipt) }); return receipt; }
async function terminalFor(receipt, timeoutMs) { if (isTerminal(receipt?.state)) return requireIdentity(receipt, receipt.executionId, receipt.requestId); const deadline = Date.now() + timeoutMs; while (Date.now() < deadline) { const terminal = receipts.find((item) => item.executionId === receipt?.executionId && item.requestId === receipt?.requestId && isTerminal(item.state)); if (terminal) return requireIdentity(terminal, receipt.executionId, receipt.requestId); await delay(100); } throw new Error("machine_load_terminal_timeout"); }
function requireIdentity(receipt, executionId, requestId) { if (receipt?.executionId !== executionId || receipt?.requestId !== requestId) throw new Error("machine_load_receipt_identity_mismatch"); return receipt; }
function parseEvidence(receiptEvidence) { const detail = typeof receiptEvidence?.detail === "string" ? receiptEvidence.detail : ""; const fields = Object.fromEntries(detail.split(";").map((part) => { const index = part.indexOf("="); return index > 0 ? [part.slice(0, index), part.slice(index + 1)] : ["", ""]; })); const expected = ["location", "target", "tile", "machine", "slot", "input", "input_stack_before", "input_stack_after", "last_input", "held", "ready_for_harvest", "minutes_until_ready", "native_check_action"]; if (Object.keys(fields).length !== expected.length || !expected.every((key) => typeof fields[key] === "string" && fields[key].length > 0)) throw new Error("invalid_machine_load_evidence"); return fields; }
function same(left, right) { return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]); }
function isTerminal(state) { return ["succeeded", "failed", "invalidated", "cancelled", "expired", "uncertain", "rejected"].includes(state); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function required(name) { const index = process.argv.indexOf(name); if (index < 0 || !process.argv[index + 1]) throw new Error(`missing_${name.slice(2)}`); return process.argv[index + 1]; }
function summarizeTarget(target) { return target ? { targetId: target.targetId, x: target.x, y: target.y, qualifiedItemId: target.qualifiedItemId, readyForHarvest: target.readyForHarvest, minutesUntilReady: target.minutesUntilReady, heldObjectQualifiedItemId: target.heldObjectQualifiedItemId ?? null, lastInputQualifiedItemId: target.lastInputQualifiedItemId ?? null, loadInputSlot: target.loadInputSlot ?? null, loadInputQualifiedItemId: target.loadInputQualifiedItemId ?? null, loadInputStack: target.loadInputStack ?? null } : null; }
function summarizeReceipt(receipt) { return receipt ? { executionId: receipt.executionId, requestId: receipt.requestId, state: receipt.state, reasonCode: receipt.reasonCode, revision: receipt.revision, evidence: receipt.evidence ?? null } : null; }
function summarizeSnapshot(snapshot) { return { revision: snapshot.revision, location: snapshot.location, tile: snapshot.tile, actionable: snapshot.actionable, machineTargets: snapshot.machineTargets?.map(summarizeTarget) ?? [], activeExecution: snapshot.activeExecution ?? null }; }
