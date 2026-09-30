import {
  assertRequiredCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  validateNativeLocalFixturePolicy,
  summarizeReceipt,
  summarizeSnapshot,
  waitForActionable,
  waitForFreshSnapshot,
  waitForStableRevision,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

/**
 * Native-local recovery-chain contract for Lane G「资源枯竭」(resource depletion).
 *
 * Drives one full Agent recovery loop inside a single game session against the
 * `native_water_crop_empty_can_recovery_v1` fixture (dry unwatered crops on the
 * Farm, exactly one EMPTY Watering Can, and one reachable native refill tile):
 *
 *   1. breakpoint : equip the empty can, then `water_crop`
 *                   -> terminal `rejected/watering_can_empty` (deterministic,
 *                      rejected before any native ingress).
 *   2. recovery   : `refill_watering_can` at the discovered source tile
 *                   -> `succeeded/watering_can_refilled`.
 *   3. retry      : `water_crop` on the SAME crop target
 *                   -> `succeeded/crop_watered` (same-execution evidence plus a
 *                      fresh target-gone postcondition).
 *
 * All three receipts come from the same journal (one connect session), each with
 * its own requestId/executionId and strictly advancing revision. Prerequisite
 * equip/movement receipts are separate and are never attributed to the
 * breakpoint/recovery/retry triplet.
 *
 * This is a harness-only chain scenario; it grants no capability and changes no
 * action lifecycle.
 */
const SCENARIO = "native_water_crop_empty_can_recovery_v1";
const EXPECTED_ACTIONS = ["move_to_tile", "travel", "equip_tool", "water_crop", "refill_watering_can"];
const REQUIRED_CAPABILITIES = [
  "cancel_active_execution",
  "equip_tool",
  "inspect_self",
  "move_to_tile",
  "refill_watering_can",
  "travel",
  "water_crop",
].sort();

const BREAKPOINT_REASON = "watering_can_empty";
const RECOVERY_REASON = "watering_can_refilled";
const RETRY_REASON = "crop_watered";

/** Execute the resource-depletion recovery chain against an already-connected bridge session. */
export async function runWaterCropResourceRecoveryChainSmoke(
  client,
  receipts,
  config,
  {
    terminalTimeoutMs = 5_000,
    postconditionTimeoutMs = 5_000,
    stabilizeTimeoutMs = 10_000,
    moveTimeoutMs = 55_000,
    travelTimeoutMs = 15_000,
  } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  validateNativeLocalFixtureConfig(config);
  try {
    let snapshot = await waitForActionable(client, undefined, stabilizeTimeoutMs);
    snapshot = await waitForFreshSnapshot(client, {
      minRevision: snapshot.revision,
      timeoutMs: stabilizeTimeoutMs,
      requireActionable: true,
      check: (latest) =>
        typeof latest.location === "string" && latest.location === "Farm" && latest.activeExecution == null,
    });
    assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);

    // The fixture's documented precondition is exactly one EMPTY can. Fail closed
    // on template drift rather than producing a chain with no rejection: a
    // "recovery" whose breakpoint never happened proves nothing.
    const wateringCan = chooseWateringCan(snapshot);
    const canFacts = (snapshot.wateringCanFacts ?? []).find((entry) => entry?.slot === wateringCan.slot);
    if (!canFacts) throw new Error("watering_can_facts_missing_for_supplied_can");
    if (Number(canFacts.water) !== 0) throw new Error("recovery_chain_breakpoint_unavailable_can_not_empty");

    snapshot = await waitForActionable(client, snapshot, stabilizeTimeoutMs);
    snapshot = await moveToReachableCrop(client, receipts, snapshot, trace, stabilizeTimeoutMs, moveTimeoutMs);
    snapshot = await waitForActionable(client, snapshot, 3_000);
    if (snapshot.actionable !== true || snapshot.activeExecution != null)
      throw new Error(
        `player_not_actionable_after_navigation:location=${snapshot.location};tile=${snapshot.tile?.x},${snapshot.tile?.y};active=${snapshot.activeExecution?.executionId ?? "none"}`,
      );

    const target = chooseOnlyReachableCrop(snapshot);

    // 0. Equip the supplied (empty) can. Its own receipt, not part of the triplet.
    snapShotMustBeActionable(snapshot, "before_equip");
    const equipAccepted = await execute(
      "equip_empty_can",
      "equip_tool",
      { tool: "watering_can" },
      snapshot,
      trace,
      client,
    );
    const equipTerminal = await waitForTerminal(receipts, equipAccepted, terminalTimeoutMs);
    if (
      equipTerminal.state !== "succeeded" ||
      (equipTerminal.reasonCode !== "tool_equipped" && equipTerminal.reasonCode !== "already_equipped")
    )
      throw new Error(`empty_can_equip_failed:${equipTerminal.reasonCode}`);
    snapshot = await waitForFreshSnapshot(client, {
      minRevision: equipTerminal.revision,
      timeoutMs: stabilizeTimeoutMs,
      requireActionable: true,
      check: (latest) =>
        typeof latest.currentTool === "string" &&
        isWateringCanLabel(latest.currentTool) &&
        latest.activeExecution == null,
    });
    // The can must still be empty after equipping, or the breakpoint below cannot
    // occur and the chain would silently become a plain success.
    const equippedFacts = (snapshot.wateringCanFacts ?? []).find((entry) => entry?.slot === wateringCan.slot);
    if (!equippedFacts || Number(equippedFacts.water) !== 0)
      throw new Error("recovery_chain_breakpoint_unavailable_can_not_empty_after_equip");
    snapshot = await moveToReachableCrop(client, receipts, snapshot, trace, stabilizeTimeoutMs, moveTimeoutMs);
    snapshot = await waitForActionable(client, snapshot, 3_000);

    // 1. Breakpoint: water_crop with an empty equipped can -> deterministic
    //    rejection before any native ingress.
    if (!hasCropTarget(snapshot, target))
      throw new Error("breakpoint_crop_target_missing_after_equip");
    const breakpointAccepted = await execute(
      "breakpoint_water",
      "water_crop",
      { x: target.x, y: target.y, expectedTargetId: target.targetId },
      snapshot,
      trace,
      client,
    );
    const breakpoint = await waitForTerminal(receipts, breakpointAccepted, terminalTimeoutMs);
    if (breakpoint.state !== "rejected" || breakpoint.reasonCode !== BREAKPOINT_REASON)
      throw new Error(
        `recovery_chain_breakpoint_missing:expected=rejected/${BREAKPOINT_REASON};actual=${breakpoint.state}/${breakpoint.reasonCode}`,
      );
    // The rejection is a side-effect-free terminal at `breakpoint.revision`; the
    // pre-rejection snapshot is stale by definition. Re-observe at or past that
    // revision before the recovery request, never reuse the old snapshot.
    snapshot = await waitForFreshSnapshot(client, {
      minRevision: breakpoint.revision,
      timeoutMs: stabilizeTimeoutMs,
      requireActionable: true,
      check: (latest) => hasCropTarget(latest, target) && latest.activeExecution == null,
    });

    // 2. Recovery: refill at a discovered native source -> authoritative success.
    const refillTarget = chooseOnlyReachableRefill(snapshot);
    const refillAccepted = await execute(
      "recover_refill",
      "refill_watering_can",
      {
        slot: wateringCan.slot,
        x: refillTarget.x,
        y: refillTarget.y,
        expectedTargetId: refillTarget.targetId,
      },
      snapshot,
      trace,
      client,
    );
    const recovery = await waitForTerminal(receipts, refillAccepted, terminalTimeoutMs);
    if (recovery.state !== "succeeded" || recovery.reasonCode !== RECOVERY_REASON)
      throw new Error(`recovery_refill_failed:${recovery.reasonCode}`);
    const recoveryEvidence = parseEvidence(recovery.evidence, [
      "expected_stamina_cost",
      "slot",
      "stamina_after",
      "stamina_before",
      "stamina_delta",
      "target",
      "water_after",
      "water_before",
      "water_max",
    ]);
    const waterBefore = Number(recoveryEvidence.water_before);
    const waterAfter = Number(recoveryEvidence.water_after);
    const waterMax = Number(recoveryEvidence.water_max);
    const refillRefilled =
      Number.isSafeInteger(waterBefore) &&
      Number.isSafeInteger(waterAfter) &&
      Number.isSafeInteger(waterMax) &&
      waterBefore < waterMax &&
      waterAfter === waterMax &&
      recoveryEvidence.slot === String(wateringCan.slot) &&
      recoveryEvidence.target === refillTarget.targetId;
    if (!refillRefilled) throw new Error("recovery_refill_postcondition_mismatch");
    snapshot = await waitForFreshSnapshot(client, {
      minRevision: recovery.revision,
      timeoutMs: stabilizeTimeoutMs,
      requireActionable: true,
      check: (latest) => {
        const facts = (latest.wateringCanFacts ?? []).find((entry) => entry?.slot === wateringCan.slot);
        return facts !== undefined && Number(facts.water) === waterMax && latest.activeExecution == null;
      },
    });

    // 3. Retry the SAME target -> authoritative succeeded receipt + fresh
    //    postcondition. The crop target must have survived the whole chain.
    if (!hasCropTarget(snapshot, target))
      throw new Error("retry_crop_target_missing_after_recovery");
    const retryAccepted = await execute(
      "retry_water",
      "water_crop",
      { x: target.x, y: target.y, expectedTargetId: target.targetId },
      snapshot,
      trace,
      client,
    );
    const retry = await waitForTerminal(receipts, retryAccepted, terminalTimeoutMs);
    if (retry.state !== "succeeded" || retry.reasonCode !== RETRY_REASON)
      throw new Error(`retry_water_failed:${retry.reasonCode}`);
    const evidence = parseEvidence(retry.evidence, [
      "after_watered",
      "before_watered",
      "expected_stamina_cost",
      "location",
      "stamina_after",
      "stamina_before",
      "stamina_delta",
      "target",
      "tile",
      "water_after",
      "water_before",
      "water_consumed",
    ]);
    const after = await waitForStableRevision(client, {
      revision: retry.revision,
      timeoutMs: postconditionTimeoutMs,
      check: (latest) =>
        latest.actionable === true &&
        latest.activeExecution == null &&
        latest.location === snapshot.location &&
        sameTile(latest.tile, snapshot.tile) &&
        Array.isArray(latest.cropTargets) &&
        latest.cropTargets.every(
          (entry) => entry?.targetId !== target.targetId && (entry?.x !== target.x || entry?.y !== target.y),
        ),
    });
    const freshTargetGone =
      Array.isArray(after.cropTargets) &&
      !after.cropTargets.some((entry) => entry?.targetId === target.targetId || (entry?.x === target.x && entry?.y === target.y));
    const retryWaterBefore = Number(evidence.water_before);
    const retryWaterAfter = Number(evidence.water_after);
    const retryWaterDelta =
      Number.isSafeInteger(retryWaterBefore) &&
      Number.isSafeInteger(retryWaterAfter) &&
      retryWaterBefore > 0 &&
      retryWaterAfter === retryWaterBefore - 1 &&
      evidence.water_consumed === "true";
    const evidenceBound =
      evidence.location === snapshot.location &&
      evidence.target === target.targetId &&
      evidence.tile === `${target.x},${target.y}` &&
      evidence.before_watered === "false" &&
      evidence.after_watered === "true";
    const sameJournalLineage =
      Number.isSafeInteger(breakpoint.revision) &&
      Number.isSafeInteger(recovery.revision) &&
      Number.isSafeInteger(retry.revision) &&
      breakpoint.revision < recovery.revision &&
      recovery.revision < retry.revision &&
      typeof breakpoint.executionId === "string" &&
      typeof recovery.executionId === "string" &&
      typeof retry.executionId === "string" &&
      breakpoint.executionId !== recovery.executionId &&
      recovery.executionId !== retry.executionId &&
      breakpoint.executionId !== retry.executionId;
    // Request-identity correlation is enforced upstream by the shared harness:
    // `executeFresh` validates every immediate/long-poll receipt against the exact
    // request it submitted (`assertImmediateReceipt` / `assertReceiptIdentity` raise
    // `native_receipt_request_id_mismatch` / `..._execution_id_mismatch`). A runner
    // therefore cannot observe a receipt belonging to a different request, so the
    // chain does not re-derive that proof here.
    const freshPostcondition =
      after.revision === retry.revision &&
      after.actionable === true &&
      after.activeExecution == null &&
      after.location === snapshot.location &&
      sameTile(after.tile, snapshot.tile) &&
      freshTargetGone;
    const passed =
      refillRefilled &&
      retryWaterDelta &&
      evidenceBound &&
      sameJournalLineage &&
      freshPostcondition;
    if (!passed) throw new Error("recovery_chain_postcondition_mismatch");
    return {
      state: "passed",
      topology: "native_local_player_fixture",
      reasonCode: RETRY_REASON,
      chain: {
        breakpoint: summarizeReceipt(breakpoint),
        recovery: summarizeReceipt(recovery),
        retry: summarizeReceipt(retry),
        contiguousJournal: sameJournalLineage,
        breakpointReceipt: {
          requestId: breakpoint.requestId,
          executionId: breakpoint.executionId,
          state: breakpoint.state,
          reasonCode: breakpoint.reasonCode,
          revision: breakpoint.revision,
        },
        recoveryReceipt: {
          requestId: recovery.requestId,
          executionId: recovery.executionId,
          state: recovery.state,
          reasonCode: recovery.reasonCode,
          revision: recovery.revision,
        },
        retryReceipt: {
          requestId: retry.requestId,
          executionId: retry.executionId,
          state: retry.state,
          reasonCode: retry.reasonCode,
          revision: retry.revision,
        },
      },
      target,
      refillTarget,
      receipt: summarizeReceipt(retry),
      evidence,
      recoveryEvidence,
      freshTargetGone,
      refillRefilled,
      sameJournalLineage,
      freshPostcondition,
      trace,
      before: summarizeWithTargets(snapshot),
      after: summarizeWithTargets(after),
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
  // This scenario is newer than the immutable production generation, so the live
  // client must come from the compiled test artifact carrying its protocol fields.
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runWaterCropResourceRecoveryChainSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}

function snapShotMustBeActionable(snapshot, phase) {
  if (snapshot.actionable !== true || snapshot.activeExecution != null) throw new Error(`${phase}_player_not_actionable`);
}

async function execute(phase, action, args, snapshot, trace, client) {
  snapShotMustBeActionable(snapshot, phase);
  const nonce = `${Date.now()}_${trace.length}`;
  const requestId = `native_local_chain_${phase}_${nonce}`;
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

async function moveToReachableCrop(client, receipts, snapshot, trace, stabilizeTimeoutMs, moveTimeoutMs) {
  if (chooseReachableCropOrNull(snapshot)) return snapshot;
  for (let radius = 2; radius <= 12; radius++) {
    const candidates = [];
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        candidates.push({ x: snapshot.tile.x + dx, y: snapshot.tile.y + dy });
      }
    }
    for (const waypoint of candidates) {
      try {
        const moved = await moveToTile(
          client,
          receipts,
          snapshot,
          waypoint,
          "move_to_native_water_crop_empty_can_fixture",
          trace,
          stabilizeTimeoutMs,
          moveTimeoutMs,
        );
        if (chooseReachableCropOrNull(moved)) return moved;
        snapshot = moved;
      } catch (error) {
        const reason = String(error instanceof Error ? error.message : error);
        if (!reason.endsWith("_not_accepted:no_native_path") && !reason.startsWith("navigation_failed:no_native_path"))
          throw error;
        snapshot = await observeFresh(client);
        if (chooseReachableCropOrNull(snapshot)) return snapshot;
      }
    }
  }
  throw new Error("no_reachable_native_water_crop_empty_can_fixture_target");
}

async function moveToTile(client, receipts, snapshot, target, phase, trace, stabilizeTimeoutMs, terminalTimeoutMs) {
  const fresh = await waitForActionable(client, snapshot, stabilizeTimeoutMs);
  const accepted = await execute(phase, "move_to_tile", target, fresh, trace, client);
  if (accepted.state !== "accepted") throw new Error(`${phase}_not_accepted:${accepted.reasonCode}`);
  const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "target_reached")
    throw new Error(`${phase}_failed:${terminal.reasonCode}`);
  // `move_to_tile` reports `target_reached` on exact arrival OR on a cardinal
  // adjacent approach (StardewBodyController.cs:129-135), so accept both.
  return waitForFreshSnapshot(client, {
    minRevision: terminal.revision,
    timeoutMs: stabilizeTimeoutMs,
    requireActionable: true,
    check: (latest) =>
      latest.activeExecution == null &&
      (sameTile(latest.tile, target) || cardinalAdjacent(latest.tile, target)),
  });
}

function chooseOnlyReachableCrop(snapshot) {
  const targets = validCropTargets(snapshot);
  if (targets.length !== 1)
    throw new Error(targets.length === 0 ? "no_adjacent_live_crop_target" : "ambiguous_adjacent_live_crop_targets");
  return targets[0];
}

function chooseReachableCropOrNull(snapshot) {
  const targets = validCropTargets(snapshot);
  return targets.length === 1 ? targets[0] : null;
}

function validCropTargets(snapshot) {
  return (snapshot.cropTargets ?? []).filter(
    (target) =>
      /^crop_[a-f0-9]{16}$/.test(target?.targetId ?? "") &&
      Number.isInteger(target.x) &&
      Number.isInteger(target.y) &&
      target.x >= 0 &&
      target.y >= 0 &&
      typeof target.cropId === "string" &&
      target.cropId.length > 0 &&
      adjacent(snapshot.tile, target),
  );
}

function hasCropTarget(snapshot, target) {
  return (snapshot.cropTargets ?? []).some(
    (entry) => entry?.targetId === target.targetId && entry?.x === target.x && entry?.y === target.y,
  );
}

function chooseOnlyReachableRefill(snapshot) {
  const targets = (snapshot.refillWateringCanTargets ?? []).filter(
    (target) =>
      /^watering_can_refill_[a-f0-9]{16}$/.test(target?.targetId ?? "") &&
      Number.isInteger(target.x) &&
      Number.isInteger(target.y) &&
      target.x >= 0 &&
      target.y >= 0 &&
      adjacent(snapshot.tile, target),
  );
  if (targets.length === 0) throw new Error("no_adjacent_live_refill_target");
  // Prefer the tile the actor is standing on: the fixture stamps one tile as a
  // native water source and warps the actor onto it, and a farm can legitimately
  // also expose other water tiles (a pond) inside the discovery radius. Any
  // adjacent target is the same refill semantic, so order deterministically
  // (distance 0 first, then discovery order) instead of requiring exactly one.
  const stationary = targets.find((target) => target.x === snapshot.tile?.x && target.y === snapshot.tile?.y);
  return stationary ?? targets[0];
}

function chooseWateringCan(snapshot) {
  const cans = (snapshot.toolSlots ?? []).filter(
    (entry) => Number.isInteger(entry?.slot) && typeof entry.label === "string" && isWateringCanLabel(entry.label),
  );
  if (cans.length !== 1)
    throw new Error(
      cans.length === 0 ? "watering_can_not_found_in_live_tool_slots" : "ambiguous_live_watering_can_slots",
    );
  return cans[0];
}

function isWateringCanLabel(label) {
  return (
    typeof label === "string" &&
    label
      .replaceAll(/[^a-z0-9]/gi, "")
      .toLowerCase()
      .includes("wateringcan")
  );
}

function parseEvidence(evidence, requiredKeys) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  if (detail.length === 0) throw new Error("native_local_evidence_empty");
  const fields = Object.fromEntries(
    detail
      .split(";")
      .map((pair) => {
        const index = pair.indexOf("=");
        return index > 0 ? [pair.slice(0, index), pair.slice(index + 1)] : null;
      })
      .filter(Boolean),
  );
  for (const key of requiredKeys)
    if (typeof fields[key] !== "string") throw new Error(`native_local_evidence_missing_key:${key}`);
  return fields;
}

function adjacent(tile, target) {
  return (
    Number.isInteger(tile?.x) &&
    Number.isInteger(tile?.y) &&
    Number.isInteger(target?.x) &&
    Number.isInteger(target?.y) &&
    Math.abs(tile.x - target.x) <= 1 &&
    Math.abs(tile.y - target.y) <= 1
  );
}

function cardinalAdjacent(tile, target) {
  if (!Number.isInteger(tile?.x) || !Number.isInteger(tile?.y)) return false;
  return Math.abs(tile.x - target.x) + Math.abs(tile.y - target.y) === 1;
}

function sameTile(left, right) {
  return Number.isInteger(left?.x) && Number.isInteger(left?.y) && left.x === right?.x && left.y === right?.y;
}

function summarizeWithTargets(snapshot) {
  return {
    ...summarizeSnapshot(snapshot),
    cropTargets: snapshot.cropTargets?.length ?? 0,
    refillWateringCanTargets: snapshot.refillWateringCanTargets?.length ?? 0,
  };
}

function validateNativeLocalFixtureConfig(value) {
  const fixture = value?.NativeLocalPlayerFixture;
  if (
    fixture?.Enable !== true ||
    fixture.Bootstrap?.Enable === true ||
    fixture.FixtureScenario !== SCENARIO ||
    !validFixtureSlotRelationship(fixture.LogicalSaveName, fixture.ObservedSaveSlot)
  )
    throw new Error("native_local_fixture_config_invalid");
  // Isolation matches the Mod's own runtime check (`ModEntry.OnGameLaunched`,
  // which validates only the three Mod-owned topology keys). `Portfolio` is not
  // a C# `ModConfig` property, so a Mod `WriteConfig` legitimately drops it;
  // judging it mandatory would reject a fresh game read for a reason the action
  // cannot fix. Presence with a truthy Enable still fails closed.
  if (
    value.HostAutomation?.Enable === true ||
    value.HostFarmhandProvisioning?.Enable === true ||
    value.FarmhandProvisioner?.Enable === true ||
    (value.Portfolio?.Enable === true)
  )
    throw new Error(
      `native_local_fixture_topology_not_isolated:${JSON.stringify({
        portfolio: value.Portfolio?.Enable,
        hostAutomation: value.HostAutomation?.Enable,
        hostFarmhand: value.HostFarmhandProvisioning?.Enable,
        farmhandProvisioner: value.FarmhandProvisioner?.Enable,
      })}`,
    );
  validateNativeLocalFixturePolicy(value, { requiredActions: EXPECTED_ACTIONS });
}

function validFixtureSlotRelationship(logicalName, observedSaveSlot) {
  return (
    typeof logicalName === "string" &&
    /^GameBuddyFixture[A-Za-z0-9]{0,64}$/.test(logicalName) &&
    typeof observedSaveSlot === "string" &&
    new RegExp(`^${logicalName}_[0-9]{1,32}$`).test(observedSaveSlot)
  );
}
