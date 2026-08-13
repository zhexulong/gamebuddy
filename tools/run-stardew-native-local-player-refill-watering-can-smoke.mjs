import { readFile } from "node:fs/promises";
import { loadHostProductionModule } from "./lib/host-production-module.mjs";

const { LocalStardewBridgeClient } = await loadHostProductionModule("local-stardew-bridge.js");

function required(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) throw new Error(`missing_${name.slice(2)}`);
  return process.argv[index + 1];
}
const config = JSON.parse(await readFile(required("--client-config"), "utf8"));
const scope = {
  integrationId: "stardew",
  saveId: config.SaveId,
  worldId: config.WorldId,
  playerId: config.PlayerId,
  companionId: config.CompanionId,
};
const client = await LocalStardewBridgeClient.connect(scope, config.PipeName, config.BridgeToken);
const receipts = [];
const trace = [];
const unsubscribe = client.onFact((fact) => {
  if (fact.type === "execution_receipt") receipts.push(fact.payload);
});
try {
  let snapshot = await waitForActionable(await client.observe(), 5_000);
  validateConfig(config);
  requireCapabilities(snapshot);
  if (snapshot.location !== "FarmHouse") throw new Error("refill_watering_can_must_start_at_farmhouse");
  const can = chooseCan(snapshot);
  const target = chooseTarget(snapshot);
  if (!adjacent(snapshot.tile, target)) snapshot = await move(snapshot, target);
  const equipped = await execute("equip", "equip_tool", { slot: can.slot }, snapshot);
  if (equipped.state !== "succeeded" || equipped.reasonCode !== "tool_selected")
    throw new Error(`equip_failed:${equipped.reasonCode}`);
  snapshot = await waitForActionable(await client.observe(), 5_000);
  const freshCan = (snapshot.wateringCanFacts ?? []).find(
    (entry) => entry.slot === can.slot && entry.qualifiedItemId === can.qualifiedItemId,
  );
  const freshTarget = (snapshot.refillWateringCanTargets ?? []).find(
    (entry) => entry.targetId === target.targetId && entry.x === target.x && entry.y === target.y,
  );
  if (!freshCan || !freshTarget || freshCan.water >= freshCan.max) throw new Error("refill_precondition_changed");
  const receipt = await execute(
    "refill",
    "refill_watering_can",
    { slot: freshCan.slot, x: freshTarget.x, y: freshTarget.y, expectedTargetId: freshTarget.targetId },
    snapshot,
  );
  const after = await waitForActionable(await client.observe(), 5_000);
  const reread = (after.wateringCanFacts ?? []).find(
    (entry) => entry.slot === freshCan.slot && entry.qualifiedItemId === freshCan.qualifiedItemId,
  );
  const evidence = parseEvidence(receipt.evidence);
  const passed =
    receipt.state === "succeeded" &&
    receipt.reasonCode === "watering_can_refilled" &&
    evidence.target === freshTarget.targetId &&
    evidence.slot === String(freshCan.slot) &&
    evidence.water_before === String(freshCan.water) &&
    evidence.water_after === String(freshCan.max) &&
    evidence.water_max === String(freshCan.max) &&
    reread?.water === freshCan.max &&
    reread.max === freshCan.max;
  console.log(
    JSON.stringify({
      state: passed ? "passed" : "blocked",
      topology: "native_local_player_fixture",
      reasonCode: passed ? "watering_can_refilled" : "refill_watering_can_postcondition_mismatch",
      target: freshTarget,
      can: freshCan,
      receipt: summarizeReceipt(receipt),
      evidence,
      trace,
      after: { revision: after.revision, location: after.location, wateringCanFacts: after.wateringCanFacts ?? [] },
    }),
  );
  if (!passed) process.exitCode = 2;
} catch (error) {
  console.error(
    JSON.stringify({
      state: "blocked",
      topology: "native_local_player_fixture",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
      latestReceipt: summarizeReceipt(client.state.latestReceipt),
      trace,
    }),
  );
  process.exitCode = 2;
} finally {
  unsubscribe();
  client.close();
}
function validateConfig(value) {
  if (
    value?.NativeLocalPlayerFixture?.Enable !== true ||
    value.NativeLocalPlayerFixture.Bootstrap?.Enable === true ||
    value.NativeLocalPlayerFixture.FixtureScenario !== "native_refill_watering_can_v1" ||
    value.ActionPolicyVersion !== 0 ||
    !same(value.EnabledActions, ["move_to_tile", "equip_tool", "refill_watering_can"])
  )
    throw new Error("native_local_refill_watering_can_fixture_config_invalid");
  if (
    value.Portfolio?.Enable === true ||
    value.HostAutomation?.Enable === true ||
    value.HostFarmhandProvisioning?.Enable === true ||
    value.FarmhandProvisioner?.Enable === true
  )
    throw new Error("native_local_refill_watering_can_topology_invalid");
}
function requireCapabilities(snapshot) {
  if (
    !same(
      [...(snapshot.capabilities ?? [])].sort(),
      ["cancel_active_execution", "equip_tool", "inspect_self", "move_to_tile", "refill_watering_can"].sort(),
    )
  )
    throw new Error("native_local_refill_watering_can_capability_not_isolated");
}
function chooseCan(snapshot) {
  const cans = (snapshot.wateringCanFacts ?? []).filter(
    (entry) =>
      Number.isInteger(entry?.slot) &&
      typeof entry.qualifiedItemId === "string" &&
      Number.isInteger(entry.water) &&
      Number.isInteger(entry.max) &&
      entry.water >= 0 &&
      entry.water < entry.max,
  );
  if (cans.length !== 1)
    throw new Error(cans.length ? "ambiguous_partial_watering_can" : "partial_watering_can_missing");
  return cans[0];
}
function chooseTarget(snapshot) {
  const targets = (snapshot.refillWateringCanTargets ?? []).filter(
    (entry) => typeof entry?.targetId === "string" && validTile(entry.x) && validTile(entry.y),
  );
  if (targets.length !== 1) throw new Error(targets.length ? "ambiguous_refill_target" : "refill_target_missing");
  return targets[0];
}
async function execute(phase, action, args, snapshot) {
  if (!snapshot.actionable || snapshot.activeExecution != null) throw new Error(`${phase}_player_not_actionable`);
  const nonce = `${Date.now()}_${trace.length}`;
  const receipt = await client.execute({
    requestId: `native_local_refill_watering_can_${phase}_${nonce}`,
    idempotencyKey: `native_local_refill_watering_can_${phase}_idem_${nonce}`,
    action,
    args,
    expectedRevision: snapshot.revision,
    deadlineMs: Date.now() + 30_000,
  });
  trace.push({ phase, action, args, receipt: summarizeReceipt(receipt) });
  return receipt;
}
async function move(snapshot, target) {
  const accepted = await execute("move", "move_to_tile", { x: target.x, y: target.y }, snapshot);
  if (accepted.state !== "accepted") throw new Error(`move_not_accepted:${accepted.reasonCode}`);
  const completion = await waitForMoveTerminalAndSnapshot(accepted, target, 55_000);
  trace.push({
    phase: "move_terminal",
    action: "move_to_tile",
    args: { x: target.x, y: target.y },
    receipt: summarizeReceipt(completion.receipt),
  });
  return completion.snapshot;
}
async function waitForActionable(snapshot, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (snapshot.actionable && snapshot.activeExecution == null) return snapshot;
    await delay(200);
    snapshot = await client.observe();
  }
  return snapshot;
}
async function waitForMoveTerminalAndSnapshot(accepted, target, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = await client.observe();
  while (Date.now() < deadline) {
    const terminal = receipts.find(
      (receipt) =>
        receipt.executionId === accepted.executionId &&
        receipt.requestId === accepted.requestId &&
        isTerminal(receipt.state),
    );
    if (terminal && (terminal.state !== "succeeded" || terminal.reasonCode !== "target_reached"))
      throw new Error(`move_failed:${terminal?.reasonCode}`);
    const evidence = parseEvidence(terminal?.evidence);
    if (
      terminal &&
      evidence.target === `${target.x},${target.y}` &&
      evidence.arrival === "exact" &&
      latest.actionable &&
      latest.activeExecution == null &&
      adjacent(latest.tile, target)
    )
      return { receipt: terminal, snapshot: latest };
    await delay(200);
    latest = await client.observe();
  }
  throw new Error(`move_timeout:${accepted.executionId}`);
}
function parseEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  return Object.fromEntries(
    detail
      .split(";")
      .map((part) => {
        const index = part.indexOf("=");
        return index > 0 ? [part.slice(0, index), part.slice(index + 1)] : null;
      })
      .filter(Boolean),
  );
}
function isTerminal(state) {
  return ["succeeded", "failed", "invalidated", "cancelled", "expired", "uncertain", "rejected"].includes(state);
}
function summarizeReceipt(receipt) {
  return receipt
    ? {
        executionId: receipt.executionId,
        requestId: receipt.requestId,
        state: receipt.state,
        reasonCode: receipt.reasonCode,
        revision: receipt.revision,
        evidence: receipt.evidence ?? null,
      }
    : null;
}
function validTile(value) {
  return Number.isInteger(value) && value >= 0 && value <= 1000;
}
function adjacent(left, right) {
  return Math.abs(left.x - right.x) <= 1 && Math.abs(left.y - right.y) <= 1;
}
function same(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
