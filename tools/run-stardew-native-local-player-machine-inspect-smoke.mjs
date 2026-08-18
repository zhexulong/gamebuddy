import {
  assertExactCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  summarizeSnapshot,
  waitForFreshSnapshot,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";

const SCENARIO = "native_machine_inspect_v1";
const EXPECTED_ACTIONS = ["move_to_tile", "machine_inspect"];
const EXPECTED_CAPABILITIES = ["cancel_active_execution", "inspect_self", "machine_inspect", "move_to_tile"];

/** Execute the machine-inspect contract against an already-connected bridge session. */
export async function runMachineInspectSmoke(
  client,
  receipts,
  config,
  { terminalTimeoutMs = 5_000, postconditionTimeoutMs = 5_000 } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  validateNativeLocalFixtureConfig(config);
  try {
    const snapshot = await requireActionableMachineSnapshot(client);
    assertExactCapabilities(snapshot, EXPECTED_CAPABILITIES);
    const targets = validMachineTargets(snapshot);
    if (targets.length !== 1)
      throw new Error(targets.length === 0 ? "no_reachable_native_machine_target" : "ambiguous_live_machine_targets");
    const target = targets[0];
    const accepted = await execute(
      client,
      trace,
      "inspect_machine",
      "machine_inspect",
      { x: target.x, y: target.y, expectedTargetId: target.targetId },
      snapshot,
    );
    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "machine_inspected")
      throw new Error(`machine_inspect_failed:${terminal.reasonCode}`);
    const evidence = parseEvidence(terminal.evidence);
    const after = await waitForFreshSnapshot(client, {
      minRevision: terminal.revision,
      timeoutMs: postconditionTimeoutMs,
      requireActionable: true,
      check: (latest) => Array.isArray(latest.machineTargets),
    });
    const reread = chooseSameFreshMachineTarget(after, target.targetId);
    const unchanged = sameMachine(target, reread);
    const passed =
      after.revision >= terminal.revision && evidenceMatchesTarget(evidence, target, snapshot.location) && unchanged;
    return {
      state: passed ? "passed" : "blocked",
      topology: "native_local_player_fixture",
      reasonCode: passed ? "machine_inspected" : "machine_inspect_postcondition_mismatch",
      target: summarizeTarget(target),
      receipt: summarizeReceipt(terminal),
      evidence,
      reread: summarizeTarget(reread),
      unchangedTarget: unchanged,
      trace,
      before: summarizeWithMachines(snapshot),
      after: summarizeWithMachines(after),
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
    const result = await runMachineInspectSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}

function validateNativeLocalFixtureConfig(value) {
  const fixture = value?.NativeLocalPlayerFixture;
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
  if (value.ActionPolicyVersion !== 0 || !same(value.EnabledActions, EXPECTED_ACTIONS))
    throw new Error("native_local_machine_action_policy_invalid");
}
async function requireActionableMachineSnapshot(client) {
  const snapshot = await observeFresh(client, { actionable: true });
  if (
    !Number.isInteger(snapshot?.tile?.x) ||
    !Number.isInteger(snapshot?.tile?.y) ||
    !Array.isArray(snapshot?.capabilities) ||
    !Array.isArray(snapshot?.warps) ||
    !Array.isArray(snapshot?.machineTargets)
  )
    throw new Error("native_local_machine_snapshot_facts_missing");
  return snapshot;
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
function chooseSameFreshMachineTarget(snapshot, targetId) {
  const target = validMachineTargets(snapshot).find((entry) => entry.targetId === targetId);
  if (!target) throw new Error("fresh_machine_target_missing");
  return target;
}
async function execute(client, trace, phase, action, args, snapshot) {
  const requestId = `native_local_machine_inspect_${phase}_${Date.now()}`;
  const receipt = await executeFresh(client, {
    requestId,
    idempotencyKey: `${requestId}_idem`,
    action,
    args,
    snapshot,
    timeoutMs: 30_000,
  });
  trace.push({ phase, action, args, receipt: summarizeReceipt(receipt) });
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
function same(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}
function summarizeTarget(target) {
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
function summarizeWithMachines(snapshot) {
  return { ...summarizeSnapshot(snapshot), machineTargets: snapshot.machineTargets?.map(summarizeTarget) ?? [] };
}
