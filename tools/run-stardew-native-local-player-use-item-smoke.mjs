import {
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  summarizeSnapshot,
  waitForFreshSnapshot,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";

const ACTION = "use_item";
const SCENARIO = "native_use_item_v1";
const EXPECTED_CAPABILITIES = ["cancel_active_execution", "inspect_self", "use_item"];

/** Execute the use-item contract against an already-connected bridge session. */
export async function runUseItemSmoke(
  client,
  receipts,
  config,
  { terminalTimeoutMs = 40_000, postconditionTimeoutMs = 5_000 } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  validateNativeLocalUseItemConfig(config);
  try {
    const before = await observeFresh(client, { actionable: true });
    requireActionableUseItemSnapshot(before);
    requireExactCapabilities(before);
    const target = chooseOnlyEligibleFoodTarget(before);
    const requestId = `native_local_use_item_${Date.now()}`;
    const accepted = await executeFresh(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: ACTION,
      args: { slot: target.slot, expectedQualifiedItemId: target.qualifiedItemId },
      snapshot: before,
      timeoutMs: 30_000,
    });
    if (accepted.state !== "accepted" || !opaqueId(accepted.executionId))
      throw new Error(`use_item_not_accepted:${accepted.reasonCode}`);
    trace.push({
      action: ACTION,
      args: { slot: target.slot, expectedQualifiedItemId: target.qualifiedItemId },
      receipt: summarizeReceipt(accepted),
    });

    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    if (terminal.executionId !== accepted.executionId || terminal.requestId !== requestId)
      throw new Error("use_item_terminal_identity_mismatch");
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "item_used")
      throw new Error(`use_item_failed:${terminal.reasonCode}`);
    const evidence = parseStrictUseItemEvidence(terminal.evidence);
    const after = await waitForFreshSnapshot(client, {
      minRevision: terminal.revision,
      timeoutMs: postconditionTimeoutMs,
      requireActionable: true,
      check: (snapshot) =>
        Number.isFinite(snapshot.stamina) &&
        Number.isInteger(snapshot.health) &&
        Array.isArray(snapshot.foodTargets),
    });
    requireExactCapabilities(after);

    const stackBefore = parseSafeInteger(evidence.stack_before);
    const stackAfter = parseSafeInteger(evidence.stack_after);
    const staminaBefore = parseFiniteDecimal(evidence.stamina_before);
    const staminaAfter = parseFiniteDecimal(evidence.stamina_after);
    const healthBefore = parseSafeInteger(evidence.health_before);
    const healthAfter = parseSafeInteger(evidence.health_after);
    const expectedStackAfter = target.stack - 1;
    const stackSemantics = stackBefore === target.stack && stackAfter === expectedStackAfter && stackAfter >= 0;
    const actorStateSemantics =
      staminaBefore !== null &&
      staminaAfter !== null &&
      healthBefore !== null &&
      healthAfter !== null &&
      sameNativeNumber(staminaBefore, before.stamina) &&
      healthBefore === before.health &&
      sameNativeNumber(staminaAfter, after.stamina) &&
      healthAfter === after.health;
    const freshInventoryPostcondition =
      stackAfter === 0
        ? after.foodTargets.every(
            (entry) => entry.slot !== target.slot || entry.qualifiedItemId !== target.qualifiedItemId,
          )
        : after.foodTargets.some(
            (entry) =>
              entry.slot === target.slot &&
              entry.qualifiedItemId === target.qualifiedItemId &&
              entry.stack === stackAfter,
          );
    const passed =
      terminal.state === "succeeded" &&
      terminal.reasonCode === "item_used" &&
      terminal.revision <= after.revision &&
      evidence.slot === String(target.slot) &&
      evidence.item === target.qualifiedItemId &&
      evidence.edibility === String(target.edibility) &&
      evidence.drink === String(target.isDrink) &&
      evidence.animation_complete === "true" &&
      stackSemantics &&
      actorStateSemantics &&
      freshInventoryPostcondition;
    return {
      state: passed ? "passed" : "blocked",
      topology: "native_local_player_fixture",
      reasonCode: passed ? "item_used" : "use_item_postcondition_mismatch",
      target: targetSummary(target),
      receipt: summarizeReceipt(terminal),
      evidence,
      stackSemantics,
      actorStateSemantics,
      freshInventoryPostcondition,
      trace,
      before: snapshotSummary(before),
      after: snapshotSummary(after),
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      state: "blocked",
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
    const result = await runUseItemSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } catch (error) {
    console.error(
      JSON.stringify({
        state: "blocked",
        reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
        latestReceipt: summarizeReceipt(session.client.state?.latestReceipt),
      }),
    );
    process.exitCode = 2;
  } finally {
    session.close();
  }
}

function validateNativeLocalUseItemConfig(value) {
  const requiredFields = ["SaveId", "WorldId", "PlayerId", "CompanionId", "PipeName", "BridgeToken"];
  if (requiredFields.some((key) => typeof value?.[key] !== "string" || value[key].length === 0))
    throw new Error("invalid_client_config");
  if (
    value.NativeLocalPlayerFixture?.Enable !== true ||
    value.NativeLocalPlayerFixture?.Bootstrap?.Enable === true ||
    value.NativeLocalPlayerFixture?.FixtureScenario !== SCENARIO
  )
    throw new Error("native_local_use_item_fixture_config_invalid");
  if (
    value.Portfolio?.Enable === true ||
    value.HostAutomation?.Enable === true ||
    value.HostFarmhandProvisioning?.Enable === true ||
    value.FarmhandProvisioner?.Enable === true
  )
    throw new Error("native_local_fixture_topology_not_isolated");
  if (value.ActionPolicyVersion !== 0 || !sameStrings(value.EnabledActions, [ACTION]))
    throw new Error("native_local_use_item_action_policy_invalid");
}

function requireActionableUseItemSnapshot(snapshot) {
  if (
    !Number.isInteger(snapshot.revision) ||
    !Number.isFinite(snapshot.stamina) ||
    !Number.isInteger(snapshot.health) ||
    !Array.isArray(snapshot.capabilities) ||
    !Array.isArray(snapshot.foodTargets)
  )
    throw new Error("native_local_use_item_snapshot_invalid");
}

function sameStrings(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function requireExactCapabilities(snapshot) {
  if (!sameStrings([...snapshot.capabilities].sort(), [...EXPECTED_CAPABILITIES].sort()))
    throw new Error("native_local_use_item_capability_not_isolated");
}

function chooseOnlyEligibleFoodTarget(snapshot) {
  const eligible = snapshot.foodTargets.filter(
    (target) =>
      Number.isInteger(target?.slot) &&
      target.slot >= 0 &&
      typeof target.qualifiedItemId === "string" &&
      target.qualifiedItemId.length > 0 &&
      Number.isInteger(target.stack) &&
      target.stack > 0 &&
      Number.isInteger(target.edibility) &&
      target.edibility >= -299 &&
      target.isDrink === false,
  );
  if (eligible.length !== 1)
    throw new Error(
      eligible.length === 0 ? "no_fresh_live_eligible_food_target" : "ambiguous_live_eligible_food_targets",
    );
  return eligible[0];
}

function parseStrictUseItemEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  if (detail.length === 0 || detail.length > 4_096) throw new Error("invalid_use_item_evidence");
  const result = {};
  for (const field of detail.split(";")) {
    const separator = field.indexOf("=");
    if (separator <= 0 || separator === field.length - 1) throw new Error("invalid_use_item_evidence");
    const key = field.slice(0, separator);
    const fieldValue = field.slice(separator + 1);
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || fieldValue.length > 512 || Object.hasOwn(result, key))
      throw new Error("invalid_use_item_evidence");
    result[key] = fieldValue;
  }
  const required = [
    "slot",
    "item",
    "stack_before",
    "stack_after",
    "edibility",
    "drink",
    "stamina_before",
    "stamina_after",
    "health_before",
    "health_after",
    "animation_complete",
  ];
  if (Object.keys(result).length !== required.length || required.some((key) => !(key in result)))
    throw new Error("invalid_use_item_evidence");
  return result;
}

function parseSafeInteger(value) {
  return typeof value === "string" && /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value))
    ? Number(value)
    : null;
}

function parseFiniteDecimal(value) {
  return typeof value === "string" && /^-?\d+(?:\.\d{1,2})?$/.test(value) && Number.isFinite(Number(value))
    ? Number(value)
    : null;
}

function sameNativeNumber(receiptValue, snapshotValue) {
  return Number.isFinite(snapshotValue) && Math.abs(receiptValue - snapshotValue) <= 0.005;
}

function opaqueId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function targetSummary(target) {
  return {
    slot: target.slot,
    qualifiedItemId: target.qualifiedItemId,
    stack: target.stack,
    edibility: target.edibility,
    isDrink: target.isDrink,
  };
}

function snapshotSummary(snapshot) {
  return {
    ...summarizeSnapshot(snapshot),
    stamina: snapshot.stamina,
    health: snapshot.health,
    foodTargets: snapshot.foodTargets?.map(targetSummary) ?? [],
  };
}
