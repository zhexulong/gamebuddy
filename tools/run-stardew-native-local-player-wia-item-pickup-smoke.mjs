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

const SCENARIO = "native_wia_item_pickup_interrupt_v1";
const EXPECTED_ACTIONS = ["dismiss_modal", "pickup_item"];
const REQUIRED_CAPABILITIES = [...EXPECTED_ACTIONS].sort();

/**
 * WIA §4.1 ② live proof for the item-pickup slot.
 *
 * `pickup_item` is the second WIA slot whose world finishes the work later:
 * production owns only the native approach (`activeItemPickup` plus its move
 * spec), and target-version `Debris.updateChunks` owns the magnetic delivery
 * that follows it. That makes three properties provable here:
 *
 *   1. a request issued while the debris is out of magnetic range is ACCEPTED as
 *      an approach, and the world modal interrupts the WALK with
 *      invalidated/modal_interrupted carrying the WIA intent breakpoint
 *      (`interrupted_by`) plus the pickup slot's own identity (`target`, `tile`)
 *      and the release marker `native_auto_collect_pending=false`;
 *   2. the slot is released with nothing delivered — the fresh snapshot has
 *      `activeExecution == null` AND the same opaque target still present with an
 *      unchanged stack, which is how "the walk delivered nothing" is observable;
 *   3. the re-issued SAME intent settles `succeeded/item_picked_up` with
 *      `native_auto_collect=true`, `chunk_removed=true`, the native inventory
 *      delta equal to the chunk's stack, and the target gone from the fresh
 *      publication.
 *
 * The magnetic race is reported, never hidden: if the first execution settles
 * `succeeded/item_picked_up`, the world delivered the chunk before the modal
 * could interrupt the walk, and the run is blocked with that explicit reason
 * instead of being counted as an interruption proof.
 */
export async function runWiaItemPickupInterruptSmoke(
  client,
  receipts,
  config,
  { terminalTimeoutMs = 40_000, postconditionTimeoutMs = 15_000 } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  validateNativeLocalItemPickupConfig(config);
  try {
    const before = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(before, REQUIRED_CAPABILITIES);
    requireItemPickupSnapshot(before, "native_local_wia_item_pickup_snapshot_facts_missing");
    if (before.location !== "Farm") throw new Error(`item_pickup_route_must_start_on_farm:${before.location}`);
    const target = chooseOnlyLiveItemTarget(before);
    const approachDistance = tileGap(before.tile, target);
    if (approachDistance <= 1) throw new Error(`approach_precondition_not_established:distance=${approachDistance}`);

    // ---- phase 1: the approach walk is interrupted by a real native modal ----
    const interruptAccepted = await executePickup(target, "interrupt", before, trace, client);
    if (interruptAccepted.state !== "accepted")
      throw new Error(`interrupt_not_accepted:${interruptAccepted.state}:${interruptAccepted.reasonCode}`);
    const interrupted = await waitForTerminal(receipts, interruptAccepted, terminalTimeoutMs);
    const interrupt = classifyInterrupt(interrupted, target);
    if (interrupt.race) throw new Error(interrupt.reason);
    if (!interrupt.classified) throw new Error(interrupt.reason);
    const { interruptEvidence, interruptShape } = interrupt;

    // ---- phase 2: the slot is released and the walk delivered nothing ----
    const released = await waitForFreshSnapshot(client, {
      minRevision: interrupted.revision,
      timeoutMs: postconditionTimeoutMs,
      check: (candidate) =>
        isItemPickupSnapshot(candidate) &&
        candidate.activeExecution == null &&
        findSameItemTarget(candidate, target) !== undefined,
    });
    const releasedTarget = findSameItemTarget(released, target);
    const releaseOk =
      released.activeExecution == null && releasedTarget !== undefined && releasedTarget.stack === target.stack;
    if (!releaseOk) throw new Error("interrupt_slot_not_released");

    // ---- phase 3: dismiss the modal (instantaneous: the bridge response IS the terminal) ----
    const dismissAccepted = await executeAction("dismiss", "dismiss_modal", {}, released, trace, client, {
      requireActionable: false,
    });
    let dismissed = dismissAccepted;
    if (dismissed.state === "accepted") dismissed = await waitForTerminal(receipts, dismissAccepted, terminalTimeoutMs);
    if (dismissed.state !== "succeeded" || dismissed.reasonCode !== "modal_dismissed")
      throw new Error(`dismiss_missing:state=${dismissed.state};reason=${dismissed.reasonCode}`);
    const dismissEvidence = parseStrictEvidence(dismissed.evidence);
    if (dismissEvidence.modal_type !== "DialogueBox" || dismissEvidence.dismissed !== "true")
      throw new Error("dismiss_evidence_missing");

    // ---- phase 4: the same intent is re-issued and the world delivers it ----
    const retryReady = await waitForFreshSnapshot(client, {
      minRevision: dismissed.revision,
      timeoutMs: postconditionTimeoutMs,
      requireActionable: true,
      check: (candidate) => isItemPickupSnapshot(candidate) && candidate.activeExecution == null,
    });
    requireItemPickupSnapshot(retryReady, "native_local_wia_item_pickup_snapshot_facts_missing");
    const retryTarget = findSameItemTarget(retryReady, target);
    if (!retryTarget) throw new Error("item_pickup_target_changed_after_dismiss");
    const retryAccepted = await executePickup(retryTarget, "retry", retryReady, trace, client);
    // A rejected retry with `body_owned` would mean the interrupted approach was
    // never released; the accepted state is part of the release proof.
    if (retryAccepted.state !== "accepted")
      throw new Error(`retry_not_accepted:${retryAccepted.state}:${retryAccepted.reasonCode}`);
    const retry = await waitForTerminal(receipts, retryAccepted, terminalTimeoutMs);
    if (retry.state !== "succeeded" || retry.reasonCode !== "item_picked_up")
      throw new Error(`retry_failed:state=${retry.state};reason=${retry.reasonCode}`);
    const retryEvidence = parseStrictEvidence(retry.evidence);
    const inventoryBefore = parseSafeInteger(retryEvidence.inventory_before);
    const inventoryAfter = parseSafeInteger(retryEvidence.inventory_after);
    const inventoryDelta =
      inventoryBefore !== null && inventoryAfter !== null ? inventoryAfter - inventoryBefore : null;
    const after = await waitForFreshSnapshot(client, {
      minRevision: retry.revision,
      timeoutMs: postconditionTimeoutMs,
      requireActionable: true,
      check: (candidate) => isItemPickupSnapshot(candidate) && candidate.activeExecution == null,
    });
    requireItemPickupSnapshot(after, "native_local_wia_item_pickup_snapshot_facts_missing");
    const targetGone = after.itemTargets.every((entry) => entry?.targetId !== target.targetId);
    const retryPostcondition =
      after.activeExecution == null &&
      targetGone &&
      retryEvidence.location === before.location &&
      retryEvidence.target === retryTarget.targetId &&
      retryEvidence.tile === `${retryTarget.x},${retryTarget.y}` &&
      retryEvidence.item === retryTarget.qualifiedItemId &&
      parseSafeInteger(retryEvidence.stack) === retryTarget.stack &&
      retryEvidence.native_auto_collect === "true" &&
      retryEvidence.chunk_removed === "true" &&
      inventoryDelta === retryTarget.stack;
    if (!retryPostcondition) throw new Error("retry_item_pickup_postcondition_mismatch");

    return {
      state: "passed",
      topology: "native_local_player_fixture",
      reasonCode: "wia_item_pickup_interrupt_retry_complete",
      target: targetSummary(retryTarget),
      approachDistance,
      targetTileStable: retryTarget.x === target.x && retryTarget.y === target.y,
      phases: {
        interrupt: summarizeReceipt(interrupted),
        dismiss: summarizeReceipt(dismissed),
        retry: summarizeReceipt(retry),
      },
      interruptEvidence,
      interruptShape,
      releaseOk,
      retryEvidence,
      inventoryDelta,
      targetGone,
      retryPostcondition,
      before: pickupSnapshotSummary(before),
      released: pickupSnapshotSummary(released),
      after: pickupSnapshotSummary(after),
      trace,
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
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runWiaItemPickupInterruptSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}

async function executePickup(target, phase, snapshot, trace, client) {
  return executeAction(
    phase,
    "pickup_item",
    {
      x: target.x,
      y: target.y,
      expectedQualifiedItemId: target.qualifiedItemId,
      expectedTargetId: target.targetId,
    },
    snapshot,
    trace,
    client,
  );
}

async function executeAction(phase, action, args, snapshot, trace, client, { requireActionable = true } = {}) {
  if (requireActionable && (snapshot.actionable !== true || snapshot.activeExecution != null))
    throw new Error(`${phase}_player_not_actionable`);
  const nonce = `${Date.now()}_${trace.length}`;
  const requestId = `native_local_wia_item_pickup_${phase}_${nonce}`;
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

/**
 * Classify the first execution's terminal BEFORE any retry may run.
 *
 * `race` is the magnet winning: the world delivered the chunk before the modal
 * could cut the walk. That is not an interruption proof, so it is reported as
 * itself. A classified interruption is the WIA world-change ruling plus the
 * pickup slot's own binding: the receipt's `native_auto_collect_pending=false`
 * proves no native delivery was in flight when the walk was cut, and its
 * `body_evidence` carries the body controller's intent breakpoint, whose first
 * field names what interrupted. The breakpoint's remaining fields
 * (target_tile/interrupted_at/remaining_distance/revision) land as ordinary
 * evidence fields, because RecordControllerTransition concatenates the
 * breakpoint into the pickup receipt unescaped.
 */
function classifyInterrupt(interrupted, target) {
  if (interrupted.state === "succeeded" && interrupted.reasonCode === "item_picked_up")
    return {
      race: true,
      reason:
        "interrupt_magnet_race_won:state=succeeded;reason=item_picked_up;native_auto_collect_completed_before_the_modal",
    };
  if (interrupted.state !== "invalidated" || interrupted.reasonCode !== "modal_interrupted")
    return { race: false, reason: `interrupt_missing:state=${interrupted.state};reason=${interrupted.reasonCode}` };

  const interruptEvidence = parseStrictEvidence(interrupted.evidence);
  const bodyEvidence = typeof interruptEvidence.body_evidence === "string" ? interruptEvidence.body_evidence : "";
  const interrupterPrefix = "interrupted_by=";
  const interruptShape = {
    interruptedBy:
      bodyEvidence.startsWith(interrupterPrefix) && bodyEvidence.slice(interrupterPrefix.length) === "DialogueBox",
    targetIdentity: interruptEvidence.target === target.targetId,
    targetTile: interruptEvidence.tile === `${target.x},${target.y}`,
    breakpointTile: interruptEvidence.target_tile === `${target.x},${target.y}`,
    nativeCollectNotPending: interruptEvidence.native_auto_collect_pending === "false",
  };
  const missing = Object.entries(interruptShape)
    .filter(([, present]) => !present)
    .map(([fact]) => fact);
  if (missing.length > 0) return { race: false, reason: `interrupt_evidence_missing:${missing.join(",")}` };
  return { race: false, classified: true, interruptEvidence, interruptShape };
}

function validateNativeLocalItemPickupConfig(value) {
  const requiredFields = ["SaveId", "WorldId", "PlayerId", "CompanionId", "PipeName", "BridgeToken"];
  if (requiredFields.some((key) => typeof value?.[key] !== "string" || value[key].length === 0))
    throw new Error("invalid_client_config");
  // Only the geometry and topology the fixture is responsible for are asserted
  // here; the modal itself is staged by the fixture and observed through the
  // receipt, never by the bridge publication.
  if (
    value.NativeLocalPlayerFixture?.Enable !== true ||
    value.NativeLocalPlayerFixture?.Bootstrap?.Enable === true ||
    value.NativeLocalPlayerFixture?.FixtureScenario !== SCENARIO
  )
    throw new Error("native_local_wia_item_pickup_fixture_config_invalid");
  if (
    value.Portfolio?.Enable === true ||
    value.HostAutomation?.Enable === true ||
    value.HostFarmhandProvisioning?.Enable === true ||
    value.FarmhandProvisioner?.Enable === true
  )
    throw new Error("native_local_fixture_topology_not_isolated");
  validateNativeLocalFixturePolicy(value, { requiredActions: EXPECTED_ACTIONS });
}

function isItemPickupSnapshot(snapshot) {
  return (
    Number.isSafeInteger(snapshot?.revision) &&
    Number.isInteger(snapshot.tile?.x) &&
    Number.isInteger(snapshot.tile?.y) &&
    Array.isArray(snapshot.capabilities) &&
    Array.isArray(snapshot.itemTargets)
  );
}

function requireItemPickupSnapshot(snapshot, errorCode) {
  if (!isItemPickupSnapshot(snapshot)) throw new Error(errorCode);
  return snapshot;
}

function chooseOnlyLiveItemTarget(snapshot) {
  const targets = snapshot.itemTargets.filter((entry) => validItemTarget(entry));
  if (targets.length !== 1)
    throw new Error(targets.length ? "ambiguous_live_item_targets" : "no_fresh_live_item_target");
  return targets[0];
}

/**
 * The live production item-target publication, exactly as the ordinary
 * `pickup_item` gate reads it: the opaque identity, the chunk's own tile, the
 * qualified item and the remaining stack.
 */
function validItemTarget(target) {
  return (
    Number.isInteger(target?.x) &&
    Number.isInteger(target?.y) &&
    target.x >= 0 &&
    target.y >= 0 &&
    typeof target.targetId === "string" &&
    target.targetId.length > 0 &&
    typeof target.qualifiedItemId === "string" &&
    target.qualifiedItemId.length > 0 &&
    Number.isSafeInteger(target.stack) &&
    target.stack > 0
  );
}

function findSameItemTarget(snapshot, target) {
  return (snapshot.itemTargets ?? []).find(
    (entry) =>
      entry?.targetId === target.targetId &&
      entry?.qualifiedItemId === target.qualifiedItemId &&
      validItemTarget(entry),
  );
}

function tileGap(left, right) {
  if (!isLiveTile(left)) throw new Error("invalid_live_tile");
  if (!isLiveTile(right)) throw new Error("invalid_live_tile");
  return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y));
}

function isLiveTile(tile) {
  return Number.isInteger(tile?.x) && Number.isInteger(tile?.y);
}

function parseStrictEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  if (detail.length === 0 || detail.length > 4_096) throw new Error("invalid_wia_item_pickup_evidence");
  const result = {};
  for (const field of detail.split(";")) {
    const separator = field.indexOf("=");
    if (separator <= 0 || separator === field.length - 1) throw new Error("invalid_wia_item_pickup_evidence");
    const key = field.slice(0, separator);
    const value = field.slice(separator + 1);
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || value.length > 512 || Object.hasOwn(result, key))
      throw new Error("invalid_wia_item_pickup_evidence");
    result[key] = value;
  }
  return result;
}

function parseSafeInteger(value) {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function targetSummary(target) {
  return {
    targetId: target.targetId,
    x: target.x,
    y: target.y,
    qualifiedItemId: target.qualifiedItemId,
    stack: target.stack,
  };
}

function pickupSnapshotSummary(snapshot) {
  return {
    ...summarizeSnapshot(snapshot),
    location: snapshot.location,
    itemTargets: snapshot.itemTargets?.map(targetSummary) ?? [],
  };
}
