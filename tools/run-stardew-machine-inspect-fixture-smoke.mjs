import { readFile } from "node:fs/promises";
import { loadHostProductionModule } from "./lib/host-production-module.mjs";

const { LocalStardewBridgeClient } = await loadHostProductionModule("local-stardew-bridge.js");

const SCENARIO = "native_machine_inspect_v1";
const EXPECTED_CAPABILITIES = ["cancel_active_execution", "inspect_self", "machine_inspect", "move_to_tile"];
const config = JSON.parse(await readFile(required("--client-config"), "utf8"));
validateNativeLocalConfig(config);
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
const startedAt = Date.now();
const unsubscribe = client.onFact((fact) => {
  if (fact.type === "execution_receipt") receipts.push(fact.payload);
});

try {
  let snapshot = await observeActionable();
  requireExactCapabilities(snapshot);
  snapshot = await moveToMachineApproach(snapshot);

  // Fixture coordinates are bounded navigation candidates only. The typed
  // production request is bound solely to a newly observed opaque target and
  // its snapshot revision after navigation has completed.
  snapshot = await observeActionable();
  requireExactCapabilities(snapshot);
  const target = chooseOnlyFreshMachineTarget(snapshot);
  const accepted = await execute(
    "inspect_machine",
    "machine_inspect",
    {
      x: target.x,
      y: target.y,
      expectedTargetId: target.targetId,
    },
    snapshot,
  );
  const terminal = await terminalForRequest(accepted, 5_000);
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "machine_inspected")
    throw new Error(`machine_inspect_failed:${terminal.reasonCode}`);

  const after = await observeActionable();
  const reread = chooseSameFreshMachineTarget(after, target.targetId);
  const evidence = parseEvidence(terminal.evidence);
  const passed =
    terminal.executionId === accepted.executionId &&
    terminal.requestId === accepted.requestId &&
    after.revision >= terminal.revision &&
    evidenceMatchesTarget(evidence, target, snapshot.location) &&
    sameMachine(target, reread);
  console.log(
    JSON.stringify({
      state: passed ? "passed" : "blocked",
      topology: "native_local_player_fixture",
      reasonCode: passed ? "machine_inspected" : "machine_inspect_postcondition_mismatch",
      target: targetSummary(target),
      receipt: receiptSummary(terminal),
      evidence,
      reread: targetSummary(reread),
      unchangedTarget: sameMachine(target, reread),
      trace,
      before: snapshotSummary(snapshot),
      after: snapshotSummary(after),
      durationMs: Date.now() - startedAt,
    }),
  );
  if (!passed) process.exitCode = 2;
} catch (error) {
  console.error(
    JSON.stringify({
      state: "blocked",
      topology: "native_local_player_fixture",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
      latestReceipt: receiptSummary(client.state.latestReceipt),
      trace,
    }),
  );
  process.exitCode = 2;
} finally {
  unsubscribe();
  client.close();
}

async function moveToMachineApproach(snapshot) {
  // The pre-attachment fixture establishes the machine within the native
  // inspection discovery radius of the initial local-player position. Do not invent coordinates or
  // navigate toward hidden state: an absent fresh opaque target fails closed.
  if (validMachineTargets(snapshot).length === 1) return snapshot;
  throw new Error("no_reachable_native_machine_target");
}

async function move(snapshot, target, phase) {
  snapshot = await observeActionable();
  requireExactCapabilities(snapshot);
  const accepted = await execute(phase, "move_to_tile", target, snapshot);
  if (accepted.state !== "accepted") throw new Error(`${phase}_not_accepted:${accepted.reasonCode}`);
  const terminal = await waitForTerminal(accepted.executionId, accepted.requestId, 55_000);
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "target_reached")
    throw new Error(`move_failed:${terminal.reasonCode}`);
  const after = await observeActionable();
  if (after.revision < terminal.revision || !adjacent(after.tile, target))
    throw new Error(`${phase}_postcondition_missing`);
  return after;
}

async function observeActionable() {
  const snapshot = await client.observe();
  if (!snapshot.actionable || snapshot.activeExecution != null)
    throw new Error("native_local_machine_player_not_actionable");
  if (
    !Number.isInteger(snapshot.revision) ||
    !Number.isInteger(snapshot.tile?.x) ||
    !Number.isInteger(snapshot.tile?.y)
  )
    throw new Error("native_local_machine_snapshot_invalid");
  if (
    !Array.isArray(snapshot.capabilities) ||
    !Array.isArray(snapshot.warps) ||
    !Array.isArray(snapshot.machineTargets)
  )
    throw new Error("native_local_machine_snapshot_facts_missing");
  return snapshot;
}
function requireExactCapabilities(snapshot) {
  if (JSON.stringify([...snapshot.capabilities].sort()) !== JSON.stringify([...EXPECTED_CAPABILITIES].sort()))
    throw new Error("native_local_machine_capability_not_isolated");
}
function chooseOnlyFreshMachineTarget(snapshot) {
  const targets = validMachineTargets(snapshot);
  if (targets.length !== 1)
    throw new Error(targets.length === 0 ? "no_fresh_live_machine_target" : "ambiguous_live_machine_targets");
  return targets[0];
}
function chooseSameFreshMachineTarget(snapshot, targetId) {
  const target = validMachineTargets(snapshot).find((entry) => entry.targetId === targetId);
  if (!target) throw new Error("fresh_machine_target_missing");
  return target;
}
function validMachineTargets(snapshot) {
  return snapshot.machineTargets.filter(
    (target) =>
      Number.isInteger(target?.x) &&
      Number.isInteger(target?.y) &&
      target.x >= 0 &&
      target.y >= 0 &&
      typeof target.targetId === "string" &&
      target.targetId.length > 0 &&
      typeof target.qualifiedItemId === "string" &&
      target.qualifiedItemId.length > 0 &&
      typeof target.readyForHarvest === "boolean" &&
      Number.isInteger(target.minutesUntilReady) &&
      (target.heldObjectQualifiedItemId == null || typeof target.heldObjectQualifiedItemId === "string") &&
      (target.lastInputQualifiedItemId == null || typeof target.lastInputQualifiedItemId === "string") &&
      adjacent(snapshot.tile, target),
  );
}
function validWarp(warp) {
  return (
    Number.isInteger(warp?.sourceX) &&
    Number.isInteger(warp?.sourceY) &&
    Number.isInteger(warp?.targetX) &&
    Number.isInteger(warp?.targetY) &&
    warp.sourceX >= 0 &&
    warp.sourceY >= 0 &&
    warp.targetX >= 0 &&
    warp.targetY >= 0 &&
    typeof warp.targetLocation === "string" &&
    warp.targetLocation.length > 0
  );
}
async function execute(phase, action, args, snapshot) {
  const requestId = `native_local_machine_inspect_${phase}_${Date.now()}`;
  const receipt = await client.execute({
    requestId,
    idempotencyKey: `${requestId}_idem`,
    action,
    args,
    expectedRevision: snapshot.revision,
    deadlineMs: Date.now() + 30_000,
  });
  trace.push({ phase, action, args, receipt: receiptSummary(receipt) });
  return receipt;
}
async function terminalForRequest(receipt, timeoutMs) {
  if (isTerminal(receipt?.state)) return requireReceiptIdentity(receipt, receipt.executionId, receipt.requestId);
  return waitForTerminal(receipt?.executionId, receipt?.requestId, timeoutMs);
}
async function waitForTerminal(executionId, requestId, timeoutMs) {
  if (
    typeof executionId !== "string" ||
    executionId.length === 0 ||
    typeof requestId !== "string" ||
    requestId.length === 0
  )
    throw new Error("execution_identity_missing");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = receipts.find(
      (item) => item.executionId === executionId && item.requestId === requestId && isTerminal(item.state),
    );
    if (receipt) return requireReceiptIdentity(receipt, executionId, requestId);
    await delay(100);
  }
  throw new Error(`terminal_timeout:${executionId}`);
}
function requireReceiptIdentity(receipt, executionId, requestId) {
  if (receipt?.executionId !== executionId || receipt?.requestId !== requestId)
    throw new Error("receipt_identity_mismatch");
  return receipt;
}
function evidenceMatchesTarget(evidence, target, location) {
  return (
    evidence.location === location &&
    evidence.target === target.targetId &&
    evidence.tile === `${target.x},${target.y}` &&
    evidence.machine === target.qualifiedItemId &&
    evidence.ready_for_harvest === String(target.readyForHarvest) &&
    evidence.minutes_until_ready === String(target.minutesUntilReady) &&
    evidence.held === (target.heldObjectQualifiedItemId ?? "none") &&
    evidence.last_input === (target.lastInputQualifiedItemId ?? "none")
  );
}
function sameMachine(left, right) {
  return (
    left.targetId === right.targetId &&
    left.x === right.x &&
    left.y === right.y &&
    left.qualifiedItemId === right.qualifiedItemId &&
    left.readyForHarvest === right.readyForHarvest &&
    left.minutesUntilReady === right.minutesUntilReady &&
    (left.heldObjectQualifiedItemId ?? null) === (right.heldObjectQualifiedItemId ?? null) &&
    (left.lastInputQualifiedItemId ?? null) === (right.lastInputQualifiedItemId ?? null)
  );
}
function parseEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  const result = {};
  for (const field of detail.split(";")) {
    const separator = field.indexOf("=");
    if (separator <= 0 || separator === field.length - 1) throw new Error("invalid_machine_inspect_evidence");
    const key = field.slice(0, separator);
    const value = field.slice(separator + 1);
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || value.length > 512 || Object.hasOwn(result, key))
      throw new Error("invalid_machine_inspect_evidence");
    result[key] = value;
  }
  const expected = [
    "held",
    "last_input",
    "location",
    "machine",
    "minutes_until_ready",
    "ready_for_harvest",
    "target",
    "tile",
  ];
  if (JSON.stringify(Object.keys(result).sort()) !== JSON.stringify(expected))
    throw new Error("invalid_machine_inspect_evidence");
  return result;
}
function validateNativeLocalConfig(value) {
  const fixture = value.NativeLocalPlayerFixture;
  if (
    fixture?.Enable !== true ||
    fixture.Bootstrap?.Enable === true ||
    fixture.FixtureScenario !== SCENARIO ||
    typeof fixture.LogicalSaveName !== "string" ||
    !/^GameBuddyFixture[A-Za-z0-9]{0,64}$/.test(fixture.LogicalSaveName) ||
    typeof fixture.ObservedSaveSlot !== "string" ||
    !new RegExp(`^${fixture.LogicalSaveName}_[0-9]{1,32}$`).test(fixture.ObservedSaveSlot)
  )
    throw new Error("native_local_fixture_config_invalid");
  if (
    value.Portfolio?.Enable === true ||
    value.HostAutomation?.Enable === true ||
    value.HostFarmhandProvisioning?.Enable === true ||
    value.FarmhandProvisioner?.Enable === true
  )
    throw new Error("native_local_fixture_topology_not_isolated");
  if (
    value.ActionPolicyVersion !== 0 ||
    JSON.stringify(value.EnabledActions) !== JSON.stringify(["move_to_tile", "machine_inspect"])
  )
    throw new Error("native_local_machine_action_policy_invalid");
  const requiredConfig = ["SaveId", "WorldId", "PlayerId", "CompanionId", "PipeName", "BridgeToken"];
  if (requiredConfig.some((key) => typeof value[key] !== "string" || value[key].length === 0))
    throw new Error("invalid_client_config");
}
function adjacent(left, right) {
  return Math.abs(left.x - right.x) <= 1 && Math.abs(left.y - right.y) <= 1;
}
function isTerminal(state) {
  return ["succeeded", "failed", "invalidated", "cancelled", "expired", "uncertain", "rejected"].includes(state);
}
function required(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing_${name.slice(2)}`);
  return process.argv[index + 1];
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function targetSummary(target) {
  return target
    ? {
        targetId: target.targetId,
        x: target.x,
        y: target.y,
        qualifiedItemId: target.qualifiedItemId,
        readyForHarvest: target.readyForHarvest,
        minutesUntilReady: target.minutesUntilReady,
        heldObjectQualifiedItemId: target.heldObjectQualifiedItemId ?? null,
        lastInputQualifiedItemId: target.lastInputQualifiedItemId ?? null,
      }
    : null;
}
function receiptSummary(receipt) {
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
function snapshotSummary(snapshot) {
  return {
    revision: snapshot.revision,
    location: snapshot.location,
    tile: snapshot.tile,
    actionable: snapshot.actionable,
    machineTargets: snapshot.machineTargets?.map(targetSummary) ?? [],
    activeExecution: snapshot.activeExecution ?? null,
  };
}
