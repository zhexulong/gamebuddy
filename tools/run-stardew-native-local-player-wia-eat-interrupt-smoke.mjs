import {
  assertRequiredCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  summarizeSnapshot,
  waitForFreshSnapshot,
  waitForTerminal,
  validateNativeLocalFixturePolicy,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

const SCENARIO = "native_wia_eat_interrupt_v1";
const EXPECTED_ACTIONS = ["cancel_active_execution", "dismiss_modal", "inspect_self", "use_item"];
const REQUIRED_CAPABILITIES = [...EXPECTED_ACTIONS].sort();

/**
 * WIA non-movement live proof for native use_item:
 *
 * 1. use_item starts native Farmer.eatHeldObject. The native item consumption
 *    happens synchronously before RequestLocalUseItem returns its accepted
 *    receipt, so the fixture's two Bread items become 1 before the modal opens.
 *    A real DialogueBox is opened while the eating animation is active and the
 *    non-movement WIA arbiter emits invalidated/modal_interrupted with the
 *    existing native_animation_pending evidence.
 * 2. The same session dismisses the modal and waits for a fresh actionable
 *    snapshot with the item-use owner released.
 * 3. The same use_item intent is submitted again. The remaining item is eaten
 *    natively and settles as succeeded/item_used, leaving no food in the slot.
 *
 * Unlike move_to_tile, non-movement item use has no frozen target-tile intent
 * breakpoint shape. This runner deliberately validates the current honest
 * evidence contract and does not manufacture movement-only fields.
 */
export async function runWiaEatInterruptSmoke(
  client,
  receipts,
  config,
  { terminalTimeoutMs = 40_000, postconditionTimeoutMs = 10_000 } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  validateNativeLocalEatInterruptConfig(config);
  try {
    const before = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(before, REQUIRED_CAPABILITIES);
    requireUseItemSnapshot(before, "native_local_wia_eat_snapshot_invalid");
    const target = chooseOnlyTwoStackFoodTarget(before);

    // Phase 1: native consumption starts before the accepted response, then the
    // fixture modal interrupts the still-running animation.
    const firstAccepted = await executeUseItem(
      "interrupt",
      target,
      before,
      trace,
      client,
    );
    if (firstAccepted.state !== "accepted")
      throw new Error(`interrupt_not_accepted:${firstAccepted.reasonCode}`);
    const firstAcceptedEvidence = parseStrictEvidence(firstAccepted.evidence);
    const firstAcceptedShape =
      firstAcceptedEvidence.slot === String(target.slot) &&
      firstAcceptedEvidence.item === target.qualifiedItemId &&
      firstAcceptedEvidence.stack_before === "2";
    if (!firstAcceptedShape)
      throw new Error("interrupt_native_consumption_boundary_missing");

    const interrupted = await waitForTerminal(receipts, firstAccepted, terminalTimeoutMs);
    if (interrupted.state !== "invalidated" || interrupted.reasonCode !== "modal_interrupted")
      throw new Error(`interrupt_missing:state=${interrupted.state};reason=${interrupted.reasonCode}`);
    const interruptEvidence = parseStrictEvidence(interrupted.evidence);
    const interruptEvidenceOk =
      Object.keys(interruptEvidence).length === 1 &&
      interruptEvidence.native_animation_pending === "true";
    if (!interruptEvidenceOk)
      throw new Error("interrupt_evidence_missing_native_animation_pending");

    // Invalidation is not allowed to imply that the native consumption was
    // rolled back. The authoritative fresh snapshot must show stack 1 and no
    // manager-owned execution before the modal is dismissed.
    const released = await waitForFreshSnapshot(client, {
      minRevision: interrupted.revision,
      timeoutMs: postconditionTimeoutMs,
      check: (snapshot) =>
        snapshot.activeExecution == null && foodStack(snapshot, target) === 1,
    });
    const releaseOk = released.activeExecution == null && foodStack(released, target) === 1;
    if (!releaseOk) throw new Error("interrupt_owner_not_released");

    // Phase 2: dismiss_modal is instantaneous in the Mod. Its immediate bridge
    // response is the terminal, although the accepted-then-terminal form is
    // tolerated for parity with the shared harness.
    const dismissAccepted = await executeAction(
      "dismiss",
      "dismiss_modal",
      {},
      released,
      trace,
      client,
      { requireActionable: false },
    );
    const dismissed =
      dismissAccepted.state === "succeeded" && dismissAccepted.reasonCode === "modal_dismissed"
        ? dismissAccepted
        : dismissAccepted.state === "accepted"
          ? await waitForTerminal(receipts, dismissAccepted, terminalTimeoutMs)
          : dismissAccepted;
    if (dismissed.state !== "succeeded" || dismissed.reasonCode !== "modal_dismissed")
      throw new Error(`dismiss_missing:state=${dismissed.state};reason=${dismissed.reasonCode}`);
    const dismissEvidence = parseStrictEvidence(dismissed.evidence);
    if (dismissEvidence.modal_type !== "DialogueBox" || dismissEvidence.dismissed !== "true")
      throw new Error("dismiss_evidence_missing");

    const readyForRetry = await waitForFreshSnapshot(client, {
      minRevision: dismissed.revision,
      timeoutMs: postconditionTimeoutMs,
      requireActionable: true,
      check: (snapshot) => snapshot.activeExecution == null && foodStack(snapshot, target) === 1,
    });
    if (readyForRetry.activeExecution != null || foodStack(readyForRetry, target) !== 1)
      throw new Error("retry_precondition_mismatch");

    // Phase 3: re-submit the same slot/item identity after the modal is gone.
    const retryAccepted = await executeUseItem(
      "retry",
      target,
      readyForRetry,
      trace,
      client,
    );
    if (retryAccepted.state !== "accepted")
      throw new Error(`retry_not_accepted:${retryAccepted.reasonCode}`);
    const retryAcceptedEvidence = parseStrictEvidence(retryAccepted.evidence);
    if (
      retryAcceptedEvidence.slot !== String(target.slot) ||
      retryAcceptedEvidence.item !== target.qualifiedItemId ||
      retryAcceptedEvidence.stack_before !== "1"
    )
      throw new Error("retry_native_consumption_boundary_missing");

    const retry = await waitForTerminal(receipts, retryAccepted, terminalTimeoutMs);
    if (retry.state !== "succeeded" || retry.reasonCode !== "item_used")
      throw new Error(`retry_failed:state=${retry.state};reason=${retry.reasonCode}`);
    const retryEvidence = parseStrictUseItemEvidence(retry.evidence);
    const after = await waitForFreshSnapshot(client, {
      minRevision: retry.revision,
      timeoutMs: postconditionTimeoutMs,
      requireActionable: true,
      check: (snapshot) => snapshot.activeExecution == null && foodStack(snapshot, target) === 0,
    });
    const retryPostcondition =
      after.activeExecution == null &&
      foodStack(after, target) === 0 &&
      retryEvidence.slot === String(target.slot) &&
      retryEvidence.item === target.qualifiedItemId &&
      retryEvidence.stack_before === "1" &&
      retryEvidence.stack_after === "0" &&
      retryEvidence.animation_complete === "true";
    if (!retryPostcondition) throw new Error("retry_item_postcondition_mismatch");

    return {
      state: "passed",
      topology: "native_local_player_fixture",
      reasonCode: "wia_eat_interrupt_retry_complete",
      target: targetSummary(target),
      phases: {
        interrupt: summarizeReceipt(interrupted),
        dismiss: summarizeReceipt(dismissed),
        retry: summarizeReceipt(retry),
      },
      firstAcceptedShape,
      interruptEvidence,
      interruptEvidenceOk,
      releaseOk,
      retryEvidence,
      retryPostcondition,
      before: summarizeSnapshot(before),
      released: summarizeSnapshot(released),
      after: summarizeSnapshot(after),
      trace,
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
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runWiaEatInterruptSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}

async function executeUseItem(phase, target, snapshot, trace, client) {
  return executeAction(
    phase,
    "use_item",
    { slot: target.slot, expectedQualifiedItemId: target.qualifiedItemId },
    snapshot,
    trace,
    client,
  );
}

async function executeAction(phase, action, args, snapshot, trace, client, { requireActionable = true } = {}) {
  if (requireActionable && (snapshot.actionable !== true || snapshot.activeExecution != null))
    throw new Error(`${phase}_player_not_actionable`);
  const nonce = `${Date.now()}_${trace.length}`;
  const requestId = `native_local_wia_eat_${phase}_${nonce}`;
  const receipt = await executeFresh(client, {
    requestId,
    idempotencyKey: `${requestId}_idem`,
    action,
    args,
    snapshot,
    timeoutMs: 30_000,
  });
  trace.push({ phase, action, args, requestId, receipt: summarizeReceipt(receipt) });
  return receipt;
}

function validateNativeLocalEatInterruptConfig(value) {
  const requiredFields = ["SaveId", "WorldId", "PlayerId", "CompanionId", "PipeName", "BridgeToken"];
  if (requiredFields.some((key) => typeof value?.[key] !== "string" || value[key].length === 0))
    throw new Error("invalid_client_config");
  if (
    value.NativeLocalPlayerFixture?.Enable !== true ||
    value.NativeLocalPlayerFixture?.Bootstrap?.Enable === true ||
    value.NativeLocalPlayerFixture?.FixtureScenario !== SCENARIO
  )
    throw new Error("native_local_wia_eat_fixture_config_invalid");
  if (
    value.Portfolio?.Enable === true ||
    value.HostAutomation?.Enable === true ||
    value.HostFarmhandProvisioning?.Enable === true ||
    value.FarmhandProvisioner?.Enable === true
  )
    throw new Error("native_local_fixture_topology_not_isolated");
  validateNativeLocalFixturePolicy(value, { requiredActions: EXPECTED_ACTIONS });
}

function requireUseItemSnapshot(snapshot, errorCode) {
  if (
    !Number.isSafeInteger(snapshot?.revision) ||
    typeof snapshot.location !== "string" ||
    !Number.isInteger(snapshot.tile?.x) ||
    !Number.isInteger(snapshot.tile?.y) ||
    !Array.isArray(snapshot.capabilities) ||
    !Array.isArray(snapshot.foodTargets)
  )
    throw new Error(errorCode);
}

function chooseOnlyTwoStackFoodTarget(snapshot) {
  const eligible = snapshot.foodTargets.filter(
    (target) =>
      Number.isInteger(target?.slot) &&
      target.slot >= 0 &&
      typeof target.qualifiedItemId === "string" &&
      target.qualifiedItemId.length > 0 &&
      Number.isInteger(target.stack) &&
      target.stack === 2 &&
      Number.isInteger(target.edibility) &&
      target.edibility >= -299 &&
      target.isDrink === false,
  );
  if (eligible.length !== 1)
    throw new Error(
      eligible.length === 0
        ? "no_two_stack_live_eligible_food_target"
        : "ambiguous_live_two_stack_food_targets",
    );
  return eligible[0];
}

function foodStack(snapshot, target) {
  const matches = (snapshot.foodTargets ?? []).filter(
    (entry) => entry?.slot === target.slot && entry?.qualifiedItemId === target.qualifiedItemId,
  );
  if (matches.length > 1) return null;
  return matches.length === 0 ? 0 : matches[0].stack;
}

function parseStrictEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  if (detail.length === 0 || detail.length > 4_096) throw new Error("invalid_wia_eat_evidence");
  const result = {};
  for (const field of detail.split(";")) {
    const separator = field.indexOf("=");
    if (separator <= 0 || separator === field.length - 1) throw new Error("invalid_wia_eat_evidence");
    const key = field.slice(0, separator);
    const value = field.slice(separator + 1);
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || value.length > 512 || Object.hasOwn(result, key))
      throw new Error("invalid_wia_eat_evidence");
    result[key] = value;
  }
  return result;
}

function parseStrictUseItemEvidence(evidence) {
  const result = parseStrictEvidence(evidence);
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

function targetSummary(target) {
  return {
    slot: target.slot,
    qualifiedItemId: target.qualifiedItemId,
    initialStack: target.stack,
    edibility: target.edibility,
    isDrink: target.isDrink,
  };
}
