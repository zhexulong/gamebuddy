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

const ACTION = "machine_load";
const SCENARIO = "native_machine_coffee_load_v1";
const EXPECTED_ACTIONS = [ACTION];
const EXPECTED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];

/** Execute the machine-load contract against an already-connected bridge session. */
export async function runMachineLoadSmoke(
  client,
  receipts,
  config,
  { terminalTimeoutMs = 5_000, postconditionTimeoutMs = 5_000 } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  try {
    validateConfig(config);
    const before = await actionableSnapshot(client);
    assertExactCapabilities(before, EXPECTED_CAPABILITIES);
    const target = chooseOnlyLoadableKeg(before);
    const requestId = `native_local_machine_load_${Date.now()}`;
    const accepted = await executeFresh(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: ACTION,
      args: {
        slot: target.loadInputSlot,
        x: target.x,
        y: target.y,
        expectedQualifiedItemId: target.loadInputQualifiedItemId,
        expectedTargetId: target.targetId,
      },
      snapshot: before,
      timeoutMs: 30_000,
    });
    trace.push({ action: ACTION, args: { targetId: target.targetId }, receipt: summarizeReceipt(accepted) });

    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "machine_coffee_loaded")
      throw new Error(`machine_load_failed:${terminal.reasonCode}`);
    const evidence = parseEvidence(terminal.evidence);
    const after = await waitForFreshSnapshot(client, {
      minRevision: terminal.revision,
      timeoutMs: postconditionTimeoutMs,
      requireActionable: true,
      check: (snapshot) => Array.isArray(snapshot.machineTargets),
    });
    assertExactCapabilities(after, EXPECTED_CAPABILITIES);
    const reread = (after.machineTargets ?? []).find((entry) => entry?.targetId === target.targetId);
    const passed =
      terminal.executionId === accepted.executionId &&
      terminal.requestId === accepted.requestId &&
      after.revision >= terminal.revision &&
      reread?.qualifiedItemId === "(BC)12" &&
      reread.readyForHarvest === false &&
      reread.minutesUntilReady === 120 &&
      reread.heldObjectQualifiedItemId === "(O)395" &&
      reread.lastInputQualifiedItemId === "(O)433" &&
      evidence.location === before.location &&
      evidence.target === target.targetId &&
      evidence.tile === `${target.x},${target.y}` &&
      evidence.machine === "(BC)12" &&
      evidence.slot === String(target.loadInputSlot) &&
      evidence.input === "(O)433" &&
      evidence.input_stack_before === "5" &&
      evidence.input_stack_after === "removed" &&
      evidence.last_input === "(O)433" &&
      evidence.held === "(O)395" &&
      evidence.ready_for_harvest === "false" &&
      evidence.minutes_until_ready === "120" &&
      evidence.native_check_action === "true";
    return {
      state: passed ? "passed" : "blocked",
      topology: "native_local_player_fixture",
      reasonCode: passed ? "machine_coffee_loaded" : "machine_load_postcondition_mismatch",
      target: summarizeTarget(target),
      receipt: summarizeReceipt(terminal),
      evidence,
      reread: summarizeTarget(reread),
      trace,
      before: summarizeWithMachines(before),
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
    const result = await runMachineLoadSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}

function validateConfig(value) {
  const fixture = value?.NativeLocalPlayerFixture;
  if (
    fixture?.Enable !== true ||
    fixture.Bootstrap?.Enable === true ||
    fixture.FixtureScenario !== SCENARIO ||
    value.ActionPolicyVersion !== 0 ||
    !same(value.EnabledActions, EXPECTED_ACTIONS)
  )
    throw new Error("native_local_machine_load_fixture_config_invalid");
  if (
    value.Portfolio?.Enable === true ||
    value.HostAutomation?.Enable === true ||
    value.HostFarmhandProvisioning?.Enable === true ||
    value.FarmhandProvisioner?.Enable === true
  )
    throw new Error("native_local_machine_load_topology_invalid");
}

async function actionableSnapshot(client) {
  const snapshot = await observeFresh(client, { actionable: true });
  if (!Array.isArray(snapshot.machineTargets)) throw new Error("native_local_machine_load_snapshot_not_actionable");
  return snapshot;
}

function chooseOnlyLoadableKeg(snapshot) {
  const targets = snapshot.machineTargets.filter(
    (entry) =>
      entry?.qualifiedItemId === "(BC)12" &&
      Number.isInteger(entry.x) &&
      Number.isInteger(entry.y) &&
      typeof entry.targetId === "string" &&
      entry.readyForHarvest === false &&
      entry.minutesUntilReady === 0 &&
      entry.heldObjectQualifiedItemId == null &&
      entry.lastInputQualifiedItemId == null &&
      Number.isInteger(entry.loadInputSlot) &&
      entry.loadInputQualifiedItemId === "(O)433" &&
      entry.loadInputStack === 5,
  );
  if (targets.length !== 1) throw new Error(targets.length ? "ambiguous_loadable_keg" : "no_loadable_keg");
  return targets[0];
}

function parseEvidence(receiptEvidence) {
  const detail = typeof receiptEvidence?.detail === "string" ? receiptEvidence.detail : "";
  const fields = Object.fromEntries(
    detail.split(";").map((part) => {
      const index = part.indexOf("=");
      return index > 0 ? [part.slice(0, index), part.slice(index + 1)] : ["", ""];
    }),
  );
  const expected = [
    "location",
    "target",
    "tile",
    "machine",
    "slot",
    "input",
    "input_stack_before",
    "input_stack_after",
    "last_input",
    "held",
    "ready_for_harvest",
    "minutes_until_ready",
    "native_check_action",
  ];
  if (
    Object.keys(fields).length !== expected.length ||
    !expected.every((key) => typeof fields[key] === "string" && fields[key].length > 0)
  )
    throw new Error("invalid_machine_load_evidence");
  return fields;
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
        loadInputSlot: target.loadInputSlot ?? null,
        loadInputQualifiedItemId: target.loadInputQualifiedItemId ?? null,
        loadInputStack: target.loadInputStack ?? null,
      }
    : null;
}

function summarizeWithMachines(snapshot) {
  return {
    ...summarizeSnapshot(snapshot),
    machineTargets: snapshot.machineTargets?.map(summarizeTarget) ?? [],
  };
}
