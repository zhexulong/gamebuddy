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
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";

const SCENARIO = "native_refill_watering_can_v1";
const EXPECTED_ACTIONS = ["move_to_tile", "equip_tool", "refill_watering_can"];
const EXPECTED_CAPABILITIES = [
  "cancel_active_execution",
  "equip_tool",
  "inspect_self",
  "move_to_tile",
  "refill_watering_can",
].sort();

/** Execute the refill-watering-can contract against an already-connected bridge session. */
export async function runRefillWateringCanSmoke(
  client,
  receipts,
  config,
  {
    terminalTimeoutMs = 5_000,
    postconditionTimeoutMs = 5_000,
    stabilizeTimeoutMs = 10_000,
    moveTimeoutMs = 55_000,
  } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  validateConfig(config);
  try {
    let snapshot = await observeFresh(client);
    snapshot = await waitForActionable(client, snapshot, stabilizeTimeoutMs);
    assertExactCapabilities(snapshot, EXPECTED_CAPABILITIES);
    if (snapshot.location !== "FarmHouse") throw new Error("refill_watering_can_must_start_at_farmhouse");
    const can = chooseCan(snapshot);
    const target = chooseTarget(snapshot);
    if (!adjacent(snapshot.tile, target))
      snapshot = await move(client, receipts, snapshot, target, trace, stabilizeTimeoutMs, moveTimeoutMs);
    const equipped = await execute(client, trace, "equip", "equip_tool", { slot: can.slot }, snapshot);
    const equipTerminal = await waitForTerminal(receipts, equipped, terminalTimeoutMs);
    if (equipTerminal.state !== "succeeded" || equipTerminal.reasonCode !== "tool_selected")
      throw new Error(`equip_failed:${equipTerminal.reasonCode}`);

    // The request binds fresh opaque target facts from the snapshot that
    // immediately follows the equip prerequisite; fixture coordinates never
    // authorize the refill.
    const afterEquip = await waitForFreshSnapshot(client, {
      minRevision: equipTerminal.revision,
      timeoutMs: stabilizeTimeoutMs,
      requireActionable: true,
      check: (fresh) => Array.isArray(fresh.wateringCanFacts) && Array.isArray(fresh.refillWateringCanTargets),
    });
    const freshCan = (afterEquip.wateringCanFacts ?? []).find(
      (entry) => entry.slot === can.slot && entry.qualifiedItemId === can.qualifiedItemId,
    );
    const freshTarget = (afterEquip.refillWateringCanTargets ?? []).find(
      (entry) => entry.targetId === target.targetId && entry.x === target.x && entry.y === target.y,
    );
    if (!freshCan || !freshTarget || freshCan.water >= freshCan.max) throw new Error("refill_precondition_changed");

    const accepted = await execute(
      client,
      trace,
      "refill",
      "refill_watering_can",
      { slot: freshCan.slot, x: freshTarget.x, y: freshTarget.y, expectedTargetId: freshTarget.targetId },
      afterEquip,
    );
    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    const evidence = parseEvidence(terminal.evidence);
    const after = await waitForFreshSnapshot(client, {
      minRevision: terminal.revision,
      timeoutMs: postconditionTimeoutMs,
      requireActionable: true,
      check: (fresh) => Array.isArray(fresh.wateringCanFacts),
    });
    const reread = (after.wateringCanFacts ?? []).find(
      (entry) => entry.slot === freshCan.slot && entry.qualifiedItemId === freshCan.qualifiedItemId,
    );
    const passed =
      terminal.state === "succeeded" &&
      terminal.reasonCode === "watering_can_refilled" &&
      terminal.executionId === accepted.executionId &&
      terminal.requestId === accepted.requestId &&
      evidence.target === freshTarget.targetId &&
      evidence.slot === String(freshCan.slot) &&
      evidence.water_before === String(freshCan.water) &&
      evidence.water_after === String(freshCan.max) &&
      evidence.water_max === String(freshCan.max) &&
      reread?.water === freshCan.max &&
      reread.max === freshCan.max;
    return {
      state: passed ? "passed" : "blocked",
      topology: "native_local_player_fixture",
      reasonCode: passed ? "watering_can_refilled" : "refill_watering_can_postcondition_mismatch",
      target: freshTarget,
      can: freshCan,
      receipt: summarizeReceipt(terminal),
      evidence,
      trace,
      after: { ...summarizeSnapshot(after), wateringCanFacts: after.wateringCanFacts ?? [] },
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
    const result = await runRefillWateringCanSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}

function validateConfig(value) {
  if (
    value?.NativeLocalPlayerFixture?.Enable !== true ||
    value.NativeLocalPlayerFixture.Bootstrap?.Enable === true ||
    value.NativeLocalPlayerFixture.FixtureScenario !== SCENARIO ||
    value.ActionPolicyVersion !== 0 ||
    !same(value.EnabledActions, EXPECTED_ACTIONS)
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

async function execute(client, trace, phase, action, args, snapshot) {
  if (snapshot.actionable !== true || snapshot.activeExecution != null)
    throw new Error(`${phase}_player_not_actionable`);
  const nonce = `${Date.now()}_${trace.length}`;
  const receipt = await executeFresh(client, {
    requestId: `native_local_refill_watering_can_${phase}_${nonce}`,
    idempotencyKey: `native_local_refill_watering_can_${phase}_idem_${nonce}`,
    action,
    args,
    snapshot,
    timeoutMs: 30_000,
  });
  trace.push({ phase, action, args, receipt: summarizeReceipt(receipt) });
  return receipt;
}

async function move(client, receipts, snapshot, target, trace, stabilizeTimeoutMs, moveTimeoutMs) {
  const accepted = await execute(client, trace, "move", "move_to_tile", { x: target.x, y: target.y }, snapshot);
  if (accepted.state !== "accepted") throw new Error(`move_not_accepted:${accepted.reasonCode}`);
  const terminal = await waitForTerminal(receipts, accepted, moveTimeoutMs);
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "target_reached")
    throw new Error(`move_failed:${terminal.reasonCode}`);
  const evidence = parseEvidence(terminal.evidence);
  if (evidence.target !== `${target.x},${target.y}` || evidence.arrival !== "exact")
    throw new Error("move_evidence_mismatch");
  trace.push({
    phase: "move_terminal",
    action: "move_to_tile",
    args: { x: target.x, y: target.y },
    receipt: summarizeReceipt(terminal),
  });
  return waitForFreshSnapshot(client, {
    minRevision: terminal.revision,
    timeoutMs: stabilizeTimeoutMs,
    requireActionable: true,
    check: (latest) => adjacent(latest.tile, target),
  });
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

function validTile(value) {
  return Number.isInteger(value) && value >= 0 && value <= 1000;
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

function same(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}
