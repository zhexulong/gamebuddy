import {
  assertExactCapabilities,
  connectNativeLocalClient,
  delay,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  summarizeSnapshot,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";

const ACTION_LOAD = "machine_load";
const ACTION_COLLECT = "machine_collect_output";
const SCENARIO = "native_machine_coffee_load_v1";
const EXPECTED_ACTIONS = [ACTION_LOAD, ACTION_COLLECT];
const EXPECTED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION_LOAD, ACTION_COLLECT];

/** Execute the machine-collect contract against an already-connected bridge session. */
export async function runMachineCollectOutputSmoke(
  client,
  receipts,
  config,
  { terminalTimeoutMs = 5_000, readyTimeoutMs = 180_000 } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  validateNativeLocalFixtureConfig(config);
  try {
    const before = await requireActionableMachineSnapshot(client);
    assertExactCapabilities(before, EXPECTED_CAPABILITIES);
    const loadTarget = chooseOnlyLoadableKeg(before);
    const loadAccepted = await execute(
      client,
      trace,
      ACTION_LOAD,
      {
        slot: loadTarget.loadInputSlot,
        x: loadTarget.x,
        y: loadTarget.y,
        expectedQualifiedItemId: loadTarget.loadInputQualifiedItemId,
        expectedTargetId: loadTarget.targetId,
      },
      before,
    );
    const loadTerminal = await waitForTerminal(receipts, loadAccepted, terminalTimeoutMs);
    if (loadTerminal.state !== "succeeded" || loadTerminal.reasonCode !== "machine_coffee_loaded")
      throw new Error(`machine_load_failed:${loadTerminal.reasonCode}`);
    const loaded = await requireActionableMachineSnapshot(client);
    const processingTarget = (loaded.machineTargets ?? []).find((entry) => entry?.targetId === loadTarget.targetId);
    if (!isProcessingCoffee(processingTarget)) throw new Error("machine_collect_processing_postcondition_mismatch");

    const ready = await waitForReadyTarget(client, loadTarget.targetId, readyTimeoutMs);
    const collectAccepted = await execute(
      client,
      trace,
      ACTION_COLLECT,
      { x: ready.x, y: ready.y, expectedTargetId: ready.targetId },
      await requireActionableMachineSnapshot(client),
    );
    const collectTerminal = await waitForTerminal(receipts, collectAccepted, terminalTimeoutMs);
    if (collectTerminal.state !== "succeeded" || collectTerminal.reasonCode !== "machine_coffee_collected")
      throw new Error(`machine_collect_failed:${collectTerminal.reasonCode}`);
    const evidence = parseEvidence(collectTerminal.evidence);
    const after = await requireActionableMachineSnapshot(client);
    assertExactCapabilities(after, EXPECTED_CAPABILITIES);
    const reread = (after.machineTargets ?? []).find((entry) => entry?.targetId === loadTarget.targetId);
    const inventoryBefore = parseNonNegativeSafeInteger(evidence.inventory_coffee_before);
    const inventoryAfter = parseNonNegativeSafeInteger(evidence.inventory_coffee_after);
    const passed =
      evidence.location === before.location &&
      evidence.target === loadTarget.targetId &&
      evidence.tile === `${ready.x},${ready.y}` &&
      evidence.machine === "(BC)12" &&
      evidence.output === "(O)395" &&
      evidence.input === "(O)433" &&
      evidence.ready_before === "true" &&
      evidence.minutes_until_ready_before === "0" &&
      inventoryBefore !== null &&
      inventoryAfter === inventoryBefore + 1 &&
      evidence.held_after === "none" &&
      evidence.ready_after === "false" &&
      evidence.native_check_action === "true" &&
      reread?.heldObjectQualifiedItemId == null &&
      reread?.readyForHarvest === false &&
      reread?.minutesUntilReady === 0 &&
      reread?.collectOutputReady === false;
    return {
      state: passed ? "passed" : "blocked",
      topology: "native_local_player_fixture",
      reasonCode: passed ? "machine_coffee_collected" : "machine_collect_postcondition_mismatch",
      loadTarget: summarizeTarget(loadTarget),
      readyTarget: summarizeTarget(ready),
      loadReceipt: summarizeReceipt(loadTerminal),
      collectReceipt: summarizeReceipt(collectTerminal),
      evidence,
      reread: summarizeTarget(reread),
      trace,
      before: summarizeWithMachines(before),
      loaded: summarizeWithMachines(loaded),
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
    const result = await runMachineCollectOutputSmoke(session.client, session.receipts, config);
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
    value.ActionPolicyVersion !== 0 ||
    !same(value.EnabledActions, EXPECTED_ACTIONS)
  )
    throw new Error("native_local_machine_collect_fixture_config_invalid");
  if (
    value.Portfolio?.Enable === true ||
    value.HostAutomation?.Enable === true ||
    value.HostFarmhandProvisioning?.Enable === true ||
    value.FarmhandProvisioner?.Enable === true
  )
    throw new Error("native_local_machine_collect_topology_invalid");
}
async function requireActionableMachineSnapshot(client) {
  const snapshot = await observeFresh(client, { actionable: true });
  if (!Number.isInteger(snapshot?.revision) || !Array.isArray(snapshot?.machineTargets))
    throw new Error("native_local_machine_collect_snapshot_not_actionable");
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
function isProcessingCoffee(entry) {
  return (
    entry?.qualifiedItemId === "(BC)12" &&
    entry.readyForHarvest === false &&
    entry.minutesUntilReady > 0 &&
    entry.heldObjectQualifiedItemId === "(O)395" &&
    entry.lastInputQualifiedItemId === "(O)433"
  );
}
async function waitForReadyTarget(client, targetId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await requireActionableMachineSnapshot(client);
    const entry = snapshot.machineTargets.find((candidate) => candidate?.targetId === targetId);
    if (
      entry?.qualifiedItemId === "(BC)12" &&
      entry.readyForHarvest === true &&
      entry.minutesUntilReady === 0 &&
      entry.heldObjectQualifiedItemId === "(O)395" &&
      entry.lastInputQualifiedItemId === "(O)433" &&
      entry.collectOutputReady === true
    )
      return entry;
    await delay(500);
  }
  throw new Error("machine_ready_timeout_without_time_skip");
}
async function execute(client, trace, action, args, snapshot) {
  const requestId = `native_local_${action}_${Date.now()}`;
  const receipt = await executeFresh(client, {
    requestId,
    idempotencyKey: `${requestId}_idem`,
    action,
    args,
    snapshot,
    timeoutMs: 30_000,
  });
  trace.push({ action, args, receipt: summarizeReceipt(receipt) });
  return receipt;
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
    "output",
    "input",
    "ready_before",
    "minutes_until_ready_before",
    "inventory_coffee_before",
    "inventory_coffee_after",
    "held_after",
    "ready_after",
    "native_check_action",
  ];
  if (
    Object.keys(fields).length !== expected.length ||
    !expected.every((key) => typeof fields[key] === "string" && fields[key].length > 0)
  )
    throw new Error("invalid_machine_collect_evidence");
  return fields;
}
function parseNonNegativeSafeInteger(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
function same(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}
function summarizeTarget(value) {
  return value
    ? {
        targetId: value.targetId,
        x: value.x,
        y: value.y,
        qualifiedItemId: value.qualifiedItemId,
        readyForHarvest: value.readyForHarvest,
        minutesUntilReady: value.minutesUntilReady,
        heldObjectQualifiedItemId: value.heldObjectQualifiedItemId ?? null,
        lastInputQualifiedItemId: value.lastInputQualifiedItemId ?? null,
        loadInputSlot: value.loadInputSlot ?? null,
        loadInputQualifiedItemId: value.loadInputQualifiedItemId ?? null,
        loadInputStack: value.loadInputStack ?? null,
        collectOutputReady: value.collectOutputReady ?? null,
      }
    : null;
}
function summarizeWithMachines(snapshot) {
  return { ...summarizeSnapshot(snapshot), machineTargets: snapshot.machineTargets?.map(summarizeTarget) ?? [] };
}
