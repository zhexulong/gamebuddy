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
import { loadHostTestModule } from "./lib/host-test-module.mjs";

/**
 * Native-local recovery-chain contract for Lane G「容器满」(container full).
 *
 * Drives one full Agent recovery loop inside a single game session against the
 * `native_harvest_crop_inventory_full_recovery_v1` fixture (one ready grab-harvest
 * crop, a FULL backpack, and one owned ordinary Chest beside that crop):
 *
 *   1. breakpoint : `harvest_crop` on the ready crop with a full backpack
 *                   -> terminal `rejected/inventory_full` (deterministic,
 *                      rejected before any native ingress; the crop is untouched).
 *   2. recovery   : `chest_store` moves one carried item into the chest
 *                   -> `succeeded/chest_stored` (frees a backpack slot).
 *   3. retry      : `harvest_crop` on the SAME crop target
 *                   -> `succeeded/crop_harvested`.
 *
 * All three receipts come from the same journal (one connect session), each with
 * its own executionId and strictly advancing revision. The prerequisite
 * equip/movement receipts are separate and are never attributed to the triplet.
 *
 * Request/execution identity correlation is enforced upstream by the shared
 * harness (`executeFresh` validates every receipt against the exact request it
 * submitted), so this runner does not re-derive that proof.
 *
 * This is a harness-only chain scenario; it grants no capability and changes no
 * action lifecycle.
 */
const SCENARIO = "native_harvest_crop_inventory_full_recovery_v1";
const EXPECTED_ACTIONS = ["move_to_tile", "travel", "harvest_crop", "chest_store"];
const EXPECTED_CAPABILITIES = [
  "cancel_active_execution",
  "chest_store",
  "harvest_crop",
  "inspect_self",
  "move_to_tile",
  "travel",
].sort();

const BREAKPOINT_REASON = "inventory_full";
const RECOVERY_REASON = "chest_stored";
const RETRY_REASON = "crop_harvested";

/** Execute the container-full recovery chain against an already-connected bridge session. */
export async function runHarvestInventoryFullRecoveryChainSmoke(
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
  validateNativeLocalFixtureConfig(config);
  try {
    let snapshot = await observeHarvestActionable(client);
    assertExactCapabilities(snapshot, EXPECTED_CAPABILITIES);

    // The fixture's declared Given is a FULL backpack, so the breakpoint below is
    // deterministic. Reach a lawful crop target first.
    snapshot = await waitForReachableHarvestTarget(client, snapshot, trace, receipts, stabilizeTimeoutMs, moveTimeoutMs);
    const breakpointTarget = chooseOnlyFreshHarvestTarget(snapshot);

    // 1. Breakpoint: harvest with a full backpack -> deterministic rejection
    //    before any native ingress. The crop must survive untouched.
    const breakpointAccepted = await execute(
      "breakpoint_harvest",
      "harvest_crop",
      {
        x: breakpointTarget.x,
        y: breakpointTarget.y,
        expectedQualifiedItemId: breakpointTarget.qualifiedHarvestItemId,
        expectedTargetId: breakpointTarget.targetId,
      },
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
    // pre-rejection snapshot is stale by definition. Re-observe past that revision
    // and require the SAME crop target still present, or this is not a
    // breakpoint-retry pair.
    snapshot = await waitForFreshSnapshot(client, {
      minRevision: breakpoint.revision,
      timeoutMs: stabilizeTimeoutMs,
      requireActionable: true,
      check: (latest) => hasHarvestTarget(latest, breakpointTarget) && latest.activeExecution == null,
    });

    // 2. Recovery: store one carried item so a backpack slot frees up.
    const storeTarget = chooseOnlyChestStoreTarget(snapshot);
    const recoveryAccepted = await execute(
      "recover_store",
      "chest_store",
      {
        slot: storeTarget.slot,
        x: storeTarget.x,
        y: storeTarget.y,
        expectedQualifiedItemId: storeTarget.qualifiedItemId,
        expectedTargetId: storeTarget.targetId,
      },
      snapshot,
      trace,
      client,
    );
    const recovery = await waitForTerminal(receipts, recoveryAccepted, terminalTimeoutMs);
    if (recovery.state !== "succeeded" || recovery.reasonCode !== RECOVERY_REASON)
      throw new Error(`recovery_store_failed:${recovery.reasonCode}`);
    const recoveryEvidence = parseEvidence(recovery.evidence, [
      "chest_stack_after",
      "chest_stack_before",
      "item",
      "native_menu_opened",
      "source_consumed",
      "target",
      "tile",
    ]);
    const storeConsumed =
      recoveryEvidence.source_consumed === "true" &&
      recoveryEvidence.item === storeTarget.qualifiedItemId &&
      recoveryEvidence.target === storeTarget.targetId &&
      recoveryEvidence.native_menu_opened === "false";
    if (!storeConsumed) throw new Error("recovery_store_postcondition_mismatch");
    snapshot = await waitForFreshSnapshot(client, {
      minRevision: recovery.revision,
      timeoutMs: stabilizeTimeoutMs,
      requireActionable: true,
      check: (latest) => latest.activeExecution == null && hasHarvestTarget(latest, breakpointTarget),
    });

    // 3. Retry the SAME crop target -> authoritative succeeded receipt plus a
    //    fresh target-gone postcondition.
    const retryAccepted = await execute(
      "retry_harvest",
      "harvest_crop",
      {
        x: breakpointTarget.x,
        y: breakpointTarget.y,
        expectedQualifiedItemId: breakpointTarget.qualifiedHarvestItemId,
        expectedTargetId: breakpointTarget.targetId,
      },
      snapshot,
      trace,
      client,
    );
    const retry = await waitForTerminal(receipts, retryAccepted, terminalTimeoutMs);
    if (retry.state !== "succeeded" || retry.reasonCode !== RETRY_REASON)
      throw new Error(`retry_harvest_failed:${retry.reasonCode}`);
    const evidence = parseEvidence(retry.evidence, [
      "crop_present_after",
      "inventory_after",
      "inventory_before",
      "inventory_gained",
      "item",
      "native_accepted",
      "regrow_advanced",
      "regrows",
      "target",
      "tile",
    ]);
    const after = await waitForFreshSnapshot(client, {
      minRevision: retry.revision,
      timeoutMs: postconditionTimeoutMs,
      requireActionable: true,
      check: (latest) =>
        Number.isInteger(latest.tile?.x) &&
        Number.isInteger(latest.tile?.y) &&
        Array.isArray(latest.harvestTargets) &&
        latest.activeExecution == null,
    });
    const targetGone = after.harvestTargets.every((entry) => entry.targetId !== breakpointTarget.targetId);
    const inventoryBefore = Number(evidence.inventory_before);
    const inventoryAfter = Number(evidence.inventory_after);
    const inventoryGained =
      Number.isSafeInteger(inventoryBefore) &&
      Number.isSafeInteger(inventoryAfter) &&
      inventoryAfter > inventoryBefore &&
      evidence.inventory_gained === "true";
    // `harvestTargets` contains only ready-to-grab crops, so a non-regrowing crop
    // is fresh only when its bound target disappears.
    const freshPostcondition = breakpointTarget.regrowsAfterHarvest
      ? evidence.crop_present_after === "true" && evidence.regrow_advanced === "true" && targetGone
      : evidence.crop_present_after === "false" && targetGone;
    const evidenceBound =
      evidence.target === breakpointTarget.targetId &&
      evidence.item === breakpointTarget.qualifiedHarvestItemId &&
      evidence.regrows === String(breakpointTarget.regrowsAfterHarvest) &&
      evidence.native_accepted === "true";
    // Same-journal lineage: three terminals, strictly advancing revision, distinct
    // execution identities. Request identity is correlated by the shared harness.
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
    const passed = storeConsumed && inventoryGained && evidenceBound && sameJournalLineage && freshPostcondition;
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
      target: breakpointTarget,
      storeTarget,
      receipt: summarizeReceipt(retry),
      evidence,
      recoveryEvidence,
      inventoryGained,
      storeConsumed,
      targetGone,
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
    const result = await runHarvestInventoryFullRecoveryChainSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}

async function execute(phase, action, args, snapshot, trace, client) {
  if (snapshot.actionable !== true || snapshot.activeExecution != null)
    throw new Error(`${phase}_player_not_actionable`);
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

async function waitForReachableHarvestTarget(client, snapshot, trace, receipts, stabilizeTimeoutMs, moveTimeoutMs) {
  if (chooseReachableHarvestTargetOrNull(snapshot)) return snapshot;
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
          "move_to_native_harvest_full_bag_fixture",
          trace,
          stabilizeTimeoutMs,
          moveTimeoutMs,
        );
        if (chooseReachableHarvestTargetOrNull(moved)) return moved;
        snapshot = moved;
      } catch (error) {
        const reason = String(error instanceof Error ? error.message : error);
        if (!reason.endsWith("_not_accepted:no_native_path") && !reason.startsWith("navigation_failed:no_native_path"))
          throw error;
        snapshot = await observeFresh(client);
        if (chooseReachableHarvestTargetOrNull(snapshot)) return snapshot;
      }
    }
  }
  throw new Error("no_reachable_native_harvest_full_bag_fixture_target");
}

async function moveToTile(client, receipts, snapshot, target, phase, trace, stabilizeTimeoutMs, terminalTimeoutMs) {
  const accepted = await execute(phase, "move_to_tile", target, snapshot, trace, client);
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

function chooseOnlyFreshHarvestTarget(snapshot) {
  const targets = validHarvestTargets(snapshot);
  if (targets.length !== 1)
    throw new Error(
      targets.length === 0 ? "no_adjacent_live_harvest_target" : "ambiguous_adjacent_live_harvest_targets",
    );
  return targets[0];
}

function chooseReachableHarvestTargetOrNull(snapshot) {
  const targets = validHarvestTargets(snapshot);
  return targets.length === 1 ? targets[0] : null;
}

function validHarvestTargets(snapshot) {
  return (snapshot.harvestTargets ?? []).filter(
    (target) =>
      /^harvest_[a-f0-9]{16}$/.test(target?.targetId ?? "") &&
      Number.isInteger(target.x) &&
      Number.isInteger(target.y) &&
      target.x >= 0 &&
      target.y >= 0 &&
      typeof target.qualifiedHarvestItemId === "string" &&
      target.qualifiedHarvestItemId.length > 0 &&
      adjacent(snapshot.tile, target),
  );
}

function hasHarvestTarget(snapshot, target) {
  return (snapshot.harvestTargets ?? []).some(
    (entry) => entry?.targetId === target.targetId && entry?.x === target.x && entry?.y === target.y,
  );
}

function chooseOnlyChestStoreTarget(snapshot) {
  const targets = (snapshot.chestStoreTargets ?? []).filter(
    (target) =>
      /^chest_[a-f0-9]{16}$/.test(target?.targetId ?? "") &&
      Number.isInteger(target.x) &&
      Number.isInteger(target.y) &&
      Number.isInteger(target.slot) &&
      typeof target.qualifiedItemId === "string" &&
      target.qualifiedItemId.length > 0 &&
      adjacent(snapshot.tile, target),
  );
  if (targets.length === 0) throw new Error("no_adjacent_live_chest_store_target");
  // A chest can offer several storable slots; any one frees a backpack slot, which
  // is the whole recovery. Order deterministically rather than requiring exactly one.
  return targets[0];
}

async function observeHarvestActionable(client) {
  const snapshot = await observeFresh(client, { actionable: true });
  assertExactCapabilities(snapshot, EXPECTED_CAPABILITIES);
  if (
    !Number.isInteger(snapshot.revision) ||
    typeof snapshot.location !== "string" ||
    !Number.isInteger(snapshot.tile?.x) ||
    !Number.isInteger(snapshot.tile?.y) ||
    !Array.isArray(snapshot.harvestTargets) ||
    !Array.isArray(snapshot.chestStoreTargets)
  )
    throw new Error("native_local_harvest_full_bag_snapshot_invalid");
  return snapshot;
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
    Math.max(Math.abs(tile.x - target.x), Math.abs(tile.y - target.y)) <= 1
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
    harvestTargets: snapshot.harvestTargets?.length ?? 0,
    chestStoreTargets: snapshot.chestStoreTargets?.length ?? 0,
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
        apiVersion: value.ActionPolicyVersion,
      })}`,
    );
  if (value.ActionPolicyVersion !== 0 || JSON.stringify(value.EnabledActions) !== JSON.stringify(EXPECTED_ACTIONS))
    throw new Error("native_local_harvest_full_bag_action_policy_invalid");
}

function validFixtureSlotRelationship(logicalName, observedSaveSlot) {
  return (
    typeof logicalName === "string" &&
    /^GameBuddyFixture[A-Za-z0-9]{0,64}$/.test(logicalName) &&
    typeof observedSaveSlot === "string" &&
    new RegExp(`^${logicalName}_[0-9]{1,32}$`).test(observedSaveSlot)
  );
}
