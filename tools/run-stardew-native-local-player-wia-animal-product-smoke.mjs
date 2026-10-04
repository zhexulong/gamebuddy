import {
  TERMINAL_STATES,
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

const SCENARIO = "native_wia_animal_product_interrupt_v1";
const EXPECTED_ACTIONS = ["collect_animal_product", "dismiss_modal"];
const REQUIRED_CAPABILITIES = [...EXPECTED_ACTIONS].sort();

/**
 * WIA non-movement live proof for the ACTIVE ANIMAL PRODUCT slot
 * (world-interruption-arbitration.md §4.1 ② / §4.3).
 *
 * 1. collect_animal_product starts the version-locked MilkPail/Shears tool
 *    animation and its accepted receipt. Unlike the item-use slot the animation
 *    finishes across later ticks, so the ExecutionManager mints the terminal from
 *    that deferred completion path. The fixture opens a real DialogueBox while the
 *    animation is running; the non-movement WIA arbiter must terminate the SAME
 *    execution exactly once as invalidated/modal_interrupted with the existing
 *    native_animation_pending evidence, and the deferred completion must only
 *    release the slot. This runner asserts that single-terminal invariant.
 * 2. The same session dismisses the modal and waits for a fresh actionable
 *    snapshot with the animal-product owner released and the ready target intact.
 * 3. The same collect_animal_product intent is submitted again. The animation
 *    completes natively and settles as succeeded/animal_product_collected, clearing
 *    the produce and adding the inventory output.
 *
 * The animal-product slot has no frozen target-tile intent breakpoint shape, so
 * this runner validates the honest non-movement evidence contract and never
 * manufactures movement-only fields.
 */
export async function runWiaAnimalProductInterruptSmoke(
  client,
  receipts,
  config,
  { terminalTimeoutMs = 40_000, postconditionTimeoutMs = 10_000 } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  validateWiaAnimalProductConfig(config);
  try {
    const before = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(before, REQUIRED_CAPABILITIES);
    requireAnimalProductSnapshot(before, "native_local_wia_animal_product_snapshot_invalid");
    const target = chooseLiveAnimalProductTarget(before);

    // Phase 1: the async collection animation starts, then the fixture modal
    // interrupts it while the native tool animation is still running.
    const firstAccepted = await executeCollect("interrupt", target, before, trace, client);
    if (firstAccepted.state !== "accepted")
      throw new Error(`interrupt_not_accepted:${firstAccepted.reasonCode}`);
    const firstAcceptedEvidence = parseStrictEvidence(firstAccepted.evidence);
    const firstAcceptedShape =
      firstAcceptedEvidence.target === target.targetId &&
      firstAcceptedEvidence.produce === target.qualifiedProduceItemId &&
      firstAcceptedEvidence.tool === target.toolKind;
    if (!firstAcceptedShape)
      throw new Error("interrupt_native_target_boundary_missing");

    const interrupted = await waitForTerminal(receipts, firstAccepted, terminalTimeoutMs);
    if (interrupted.state !== "invalidated" || interrupted.reasonCode !== "modal_interrupted")
      throw new Error(`interrupt_missing:state=${interrupted.state};reason=${interrupted.reasonCode}`);
    const interruptEvidence = parseStrictEvidence(interrupted.evidence);
    // The animal-product arbiter emits the NON-movement interruption shape: the
    // deferred native animation is the only fact (no movement intent breakpoint).
    const interruptEvidenceOk =
      Object.keys(interruptEvidence).length === 1 &&
      interruptEvidence.native_animation_pending === "true";
    if (!interruptEvidenceOk)
      throw new Error("interrupt_evidence_not_non_movement_shape");

    // The deferred completion path releases the slot when the animation finishes.
    // Read the world: by the time a fresh snapshot shows no manager-owned execution
    // the completion path has already run, so a second terminal minted by it would
    // be visible in the receipt buffer now. Exactly one terminal is the invariant.
    const released = await waitForFreshSnapshot(client, {
      minRevision: interrupted.revision,
      timeoutMs: postconditionTimeoutMs,
      check: (snapshot) => snapshot.activeExecution == null,
    });
    if (released.activeExecution != null) throw new Error("interrupt_owner_not_released");
    const interruptTerminalCount = countTerminalsForExecution(receipts, firstAccepted.executionId);
    if (interruptTerminalCount !== 1)
      throw new Error(
        `interrupt_double_terminal:count=${interruptTerminalCount};execution=${firstAccepted.executionId}`,
      );

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
      check: (snapshot) => snapshot.activeExecution == null && hasTarget(snapshot, target),
    });
    if (readyForRetry.activeExecution != null || !hasTarget(readyForRetry, target))
      throw new Error("retry_precondition_mismatch");

    // Phase 3: re-submit the same target identity after the modal is gone.
    const retryAccepted = await executeCollect("retry", target, readyForRetry, trace, client);
    if (retryAccepted.state !== "accepted")
      throw new Error(`retry_not_accepted:${retryAccepted.reasonCode}`);
    const retryAcceptedEvidence = parseStrictEvidence(retryAccepted.evidence);
    if (
      retryAcceptedEvidence.target !== target.targetId ||
      retryAcceptedEvidence.produce !== target.qualifiedProduceItemId ||
      retryAcceptedEvidence.tool !== target.toolKind
    )
      throw new Error("retry_native_target_boundary_missing");

    const retry = await waitForTerminal(receipts, retryAccepted, terminalTimeoutMs);
    if (retry.state !== "succeeded" || retry.reasonCode !== "animal_product_collected")
      throw new Error(`retry_failed:state=${retry.state};reason=${retry.reasonCode}`);
    const retryEvidence = parseStrictEvidence(retry.evidence);
    const retryTerminalCount = countTerminalsForExecution(receipts, retryAccepted.executionId);
    if (retryTerminalCount !== 1)
      throw new Error(`retry_double_terminal:count=${retryTerminalCount}`);

    const after = await waitForFreshSnapshot(client, {
      minRevision: retry.revision,
      timeoutMs: postconditionTimeoutMs,
      requireActionable: true,
      check: (snapshot) => snapshot.activeExecution == null && !hasTarget(snapshot, target),
    });
    const retryPostcondition =
      after.activeExecution == null &&
      !hasTarget(after, target) &&
      retryEvidence.target === target.targetId &&
      retryEvidence.produce === target.qualifiedProduceItemId &&
      retryEvidence.tool === target.toolKind &&
      retryEvidence.produce_stack === String(target.produceStack) &&
      retryEvidence.produce_cleared === "true" &&
      retryEvidence.inventory_gained === "true" &&
      retryEvidence.animation_complete === "true";
    if (!retryPostcondition) throw new Error("retry_animal_product_postcondition_mismatch");

    return {
      state: "passed",
      topology: "native_local_player_fixture",
      reasonCode: "wia_animal_product_interrupt_retry_complete",
      target: targetSummary(target),
      phases: {
        interrupt: summarizeReceipt(interrupted),
        dismiss: summarizeReceipt(dismissed),
        retry: summarizeReceipt(retry),
      },
      firstAcceptedShape,
      interruptEvidence,
      interruptEvidenceOk,
      interruptTerminalCount,
      retryTerminalCount,
      retryEvidence,
      retryPostcondition,
      releaseOk: released.activeExecution == null,
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
    const result = await runWiaAnimalProductInterruptSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}

async function executeCollect(phase, target, snapshot, trace, client) {
  return executeAction(
    phase,
    "collect_animal_product",
    { slot: target.slot, x: target.x, y: target.y, expectedTargetId: target.targetId },
    snapshot,
    trace,
    client,
  );
}

async function executeAction(phase, action, args, snapshot, trace, client, { requireActionable = true } = {}) {
  if (requireActionable && (snapshot.actionable !== true || snapshot.activeExecution != null))
    throw new Error(`${phase}_player_not_actionable`);
  const nonce = `${Date.now()}_${trace.length}`;
  const requestId = `native_local_wia_animal_product_${phase}_${nonce}`;
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

/** Count authoritative terminals for one execution across the receipt buffer. */
function countTerminalsForExecution(receipts, executionId) {
  if (typeof executionId !== "string" || executionId.length === 0) throw new Error("invalid_execution_identity");
  return receipts.filter(
    (receipt) => receipt?.executionId === executionId && TERMINAL_STATES.has(receipt.state),
  ).length;
}

function validateWiaAnimalProductConfig(value) {
  const requiredFields = ["SaveId", "WorldId", "PlayerId", "CompanionId", "PipeName", "BridgeToken"];
  if (requiredFields.some((key) => typeof value?.[key] !== "string" || value[key].length === 0))
    throw new Error("invalid_client_config");
  if (
    value.NativeLocalPlayerFixture?.Enable !== true ||
    value.NativeLocalPlayerFixture?.Bootstrap?.Enable === true ||
    value.NativeLocalPlayerFixture?.FixtureScenario !== SCENARIO
  )
    throw new Error("native_local_wia_animal_product_fixture_config_invalid");
  if (
    value.Portfolio?.Enable === true ||
    value.HostAutomation?.Enable === true ||
    value.HostFarmhandProvisioning?.Enable === true ||
    value.FarmhandProvisioner?.Enable === true
  )
    throw new Error("native_local_fixture_topology_not_isolated");
  validateNativeLocalFixturePolicy(value, { requiredActions: EXPECTED_ACTIONS });
}

function requireAnimalProductSnapshot(snapshot, errorCode) {
  if (
    !Number.isSafeInteger(snapshot?.revision) ||
    typeof snapshot.location !== "string" ||
    !Number.isInteger(snapshot.tile?.x) ||
    !Number.isInteger(snapshot.tile?.y) ||
    !Array.isArray(snapshot.capabilities) ||
    !Array.isArray(snapshot.animalProductTargets)
  )
    throw new Error(errorCode);
}

function chooseLiveAnimalProductTarget(snapshot) {
  const targets = (snapshot.animalProductTargets ?? []).filter(
    (entry) =>
      typeof entry?.targetId === "string" &&
      entry.targetId.length > 0 &&
      Number.isInteger(entry.slot) &&
      Number.isInteger(entry.x) &&
      Number.isInteger(entry.y) &&
      typeof entry.qualifiedProduceItemId === "string" &&
      (entry.toolKind === "milk_pail" || entry.toolKind === "shears") &&
      (entry.produceStack === 1 || entry.produceStack === 2),
  );
  if (targets.length === 0) throw new Error("no_live_animal_product_target");
  // SetupBigFarm can lawfully expose several independent ready animals. Pick one
  // fresh opaque target deterministically; never synthesize or replace it.
  targets.sort((left, right) => left.y - right.y || left.x - right.x || left.targetId.localeCompare(right.targetId));
  return targets[0];
}

function hasTarget(snapshot, target) {
  return (snapshot.animalProductTargets ?? []).some((entry) => entry?.targetId === target.targetId);
}

function parseStrictEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  if (detail.length === 0 || detail.length > 4_096) throw new Error("invalid_wia_animal_product_evidence");
  const result = {};
  for (const field of detail.split(";")) {
    const separator = field.indexOf("=");
    if (separator <= 0 || separator === field.length - 1) throw new Error("invalid_wia_animal_product_evidence");
    const key = field.slice(0, separator);
    const value = field.slice(separator + 1);
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || value.length > 512 || Object.hasOwn(result, key))
      throw new Error("invalid_wia_animal_product_evidence");
    result[key] = value;
  }
  return result;
}

function targetSummary(target) {
  return {
    targetId: target.targetId,
    slot: target.slot,
    x: target.x,
    y: target.y,
    qualifiedProduceItemId: target.qualifiedProduceItemId,
    produceStack: target.produceStack,
    toolKind: target.toolKind,
  };
}
