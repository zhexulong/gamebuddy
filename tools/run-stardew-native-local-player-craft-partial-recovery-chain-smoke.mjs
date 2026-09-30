import {
  assertExactCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  validateNativeLocalFixturePolicy,
  summarizeSnapshot,
  waitForFreshSnapshot,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

/**
 * Native-local recovery-chain contract for Lane G「断点续作 / 部分完成」(partial
 * completion).
 *
 * Unlike the rejection-triggered modes, the breakpoint here is NOT a `rejected`
 * terminal: the native recipe transaction really runs and the product really
 * exists. `farmhandexecutioncontroller.craftingactions.cs` models exactly that
 * with `ExecutionState.PartiallySucceeded` (published as `partially_succeeded`)
 * and explicitly refuses to report a full success: "the craft happened and the
 * product exists (backpack and/or ground), but part or all of it did not enter
 * the backpack: never report a full success." The breakpoint is therefore the
 * `disposition=partially_dropped_on_ground` READING inside the receipt.
 *
 * Chain on one journal, one session, against `native_craft_item_partial_v1` (a
 * backpack already holding 998 Bait beside two Bug Meat, plus one owned Chest on
 * an adjacent tile):
 *
 *   1. breakpoint : `craft_item` for Bait. Bait's data row is
 *                   `684 1/Home/685 5/false/Fishing 2/` — one Bug Meat becomes
 *                   FIVE Bait — and (O)685's native max stack is 999, so the
 *                   existing 998 stack absorbs exactly one and four leave the
 *                   backpack as native debris. Receipt:
 *                   `partially_succeeded/crafted_item_created`,
 *                   `disposition=partially_dropped_on_ground`, gained 1 + dropped
 *                   4 = produced 5.
 *   2. recovery   : `chest_store` the retained stack -> `succeeded/chest_stored`.
 *                   This is the contract's own container recovery, and freeing the
 *                   slot is what the native debris homing needs.
 *   3. retry      : `craft_item` the SAME recipe -> `succeeded/crafted_item_created`
 *                   with `disposition=added_to_inventory` (gained 5, dropped 0):
 *                   the breakpoint action now completes fully.
 *
 * The dropped remainder is delivered by the game, not by a bridge request.
 * `Debris.updateChunks` homes the chunks onto the nearest farmer only while
 * `farmer.couldInventoryAcceptThisItem(this.item)` is true (`Debris.cs`), so with
 * a full backpack the four chunks sit still — and the moment `chest_store` frees
 * a slot they fly in and are collected. Measured live: an explicit `pickup_item`
 * submitted after the store failed `rejected/no_native_path` (the chunk was still
 * mid-bounce), and a settle-then-pick variant then found no target at all because
 * the homing had already collected it. The honest contract is therefore: the
 * agent frees space, and the world delivers the remainder; the completion is
 * proven by conservation, not by claiming a pickup the agent never needed.
 *
 * Conservation is the point: the chest holds exactly `998 + 1`, and the backpack
 * afterwards holds `4 + 5`. Nothing the recipe produced is lost — which a chain
 * that merely reported `partially_succeeded` would not prove.
 *
 * Request/execution identity correlation is enforced upstream by the shared
 * harness (`executeFresh` validates every receipt against the exact request it
 * submitted), so this runner does not re-derive that proof.
 *
 * This is a harness-only chain scenario; it grants no capability and changes no
 * action lifecycle.
 */
const SCENARIO = "native_craft_item_partial_v1";
const EXPECTED_ACTIONS = ["move_to_tile", "travel", "craft_item", "chest_store"];
const EXPECTED_CAPABILITIES = [
  "cancel_active_execution",
  "chest_store",
  "craft_item",
  "inspect_self",
  "move_to_tile",
  "travel",
].sort();

const RECIPE_ALIAS = "Bait";
const PRODUCT_ITEM_ID = "(O)685";

/** Evidence keys the craft terminal always carries. Declared before use: a `const`
 *  read from an earlier-executing statement would be a temporal-dead-zone error. */
const CRAFT_EVIDENCE_KEYS = [
  "count_after",
  "count_before",
  "count_postcondition",
  "disposition",
  "dropped_debris",
  "dropped_stack",
  "inventory_accepting_before",
  "inventory_gained_stack",
  "inventory_postcondition",
  "location",
  "materials_consumed_exactly",
  "native_menu_opened",
  "output",
  "produced_per_craft",
  "produced_stack",
  "recipe",
];
/** Bait's data row produces five per craft; (O)685's native max stack is 999. */
const PRODUCED_STACK = 5;
const EXISTING_STACK = 998;

// Terminal reason codes and the partial disposition, asserted against the Mod
// source by the offline test so a drift in the Mod fails the suite.
const BREAKPOINT_REASON = "crafted_item_created";
const RECOVERY_REASON = "chest_stored";
const RETRY_REASON = "crafted_item_created";
const PARTIAL_DISPOSITION = "partially_dropped_on_ground";
const FULL_DISPOSITION = "added_to_inventory";

/** Execute the partial-completion recovery chain against an already-connected bridge session. */
export async function runCraftPartialRecoveryChainSmoke(
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
    let snapshot = await observeCraftPartialActionable(client);
    assertExactCapabilities(snapshot, EXPECTED_CAPABILITIES);

    // The fixture warps the actor onto the chest's standable neighbour, so no
    // travel leg is required; a FarmHouse start would still be reachable because
    // crafting and storage need no particular map tile.
    if (snapshot.location !== "Farm")
      snapshot = await travelToFarm(client, receipts, snapshot, trace, stabilizeTimeoutMs, travelTimeoutMs);
    snapshot = await observeCraftPartialActionable(client);
    assertExactCapabilities(snapshot, EXPECTED_CAPABILITIES);

    // The declared Given is a backpack that cannot hold the whole product. A chain
    // whose breakpoint never happened proves nothing, so refuse before submitting.
    // The Mod's own advertised storable stack is the authoritative reading of "how
    // much product the actor is carrying".
    const stackBefore = advertisedProductStack(snapshot);
    if (stackBefore !== EXISTING_STACK)
      throw new Error(`recovery_chain_breakpoint_unavailable_existing_stack:${stackBefore}`);

    // 1. Breakpoint: one real native recipe transaction that cannot fully fit.
    const recipe = chooseBaitRecipe(snapshot);
    const breakpointAccepted = await execute(
      "breakpoint_craft",
      "craft_item",
      { expectedTargetId: recipe.targetId },
      snapshot,
      trace,
      client,
    );
    const breakpoint = await waitForTerminal(receipts, breakpointAccepted, terminalTimeoutMs);
    if (breakpoint.state !== "partially_succeeded" || breakpoint.reasonCode !== BREAKPOINT_REASON)
      throw new Error(
        `recovery_chain_breakpoint_missing:expected=partially_succeeded/${BREAKPOINT_REASON};actual=${breakpoint.state}/${breakpoint.reasonCode}`,
      );
    const breakpointEvidence = parseEvidence(breakpoint.evidence, CRAFT_EVIDENCE_KEYS);
    const breakpointDisposition = breakpointEvidence.disposition;
    const breakpointGained = Number(breakpointEvidence.inventory_gained_stack);
    const breakpointDropped = Number(breakpointEvidence.dropped_stack);
    const producedStack = Number(breakpointEvidence.produced_stack);
    const partialDisposition = breakpointDisposition === PARTIAL_DISPOSITION;
    const partialConservation =
      Number.isSafeInteger(breakpointDropped) &&
      Number.isSafeInteger(breakpointGained) &&
      Number.isSafeInteger(producedStack) &&
      breakpointDropped > 0 &&
      breakpointGained > 0 &&
      breakpointGained + breakpointDropped === producedStack &&
      producedStack === PRODUCED_STACK;
    // The Mod must reach this terminal only after its own postconditions held, so
    // assert them rather than trusting the state name.
    const breakpointHonest = craftHonest(breakpointEvidence);
    if (!partialDisposition)
      throw new Error(`recovery_chain_breakpoint_disposition:${breakpointDisposition}`);
    if (!partialConservation) throw new Error("recovery_chain_breakpoint_conservation_mismatch");
    if (!breakpointHonest) throw new Error("recovery_chain_breakpoint_postcondition_mismatch");

    // Re-observe past the breakpoint revision; the retained stack must now be the
    // advertised one, and the chest must still be empty.
    snapshot = await waitForFreshSnapshot(client, {
      minRevision: breakpoint.revision,
      timeoutMs: stabilizeTimeoutMs,
      requireActionable: true,
      check: (latest) =>
        latest.activeExecution == null &&
        advertisedProductStack(latest) === EXISTING_STACK + breakpointGained,
    });

    // 2. Recovery: store the retained stack into the container. This frees the
    //    slot the native debris homing needs, and the game then delivers the
    //    dropped remainder on its own.
    const storeTarget = chooseChestStoreTarget(snapshot);
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
      "container",
      "item",
      "native_menu_opened",
      "player_stack_after",
      "player_stack_before",
      "source_consumed",
      "target",
      "tile",
    ]);
    const storeConsumed =
      recoveryEvidence.source_consumed === "true" &&
      recoveryEvidence.item === PRODUCT_ITEM_ID &&
      recoveryEvidence.target === storeTarget.targetId &&
      recoveryEvidence.native_menu_opened === "false";
    const storedStack = Number(recoveryEvidence.chest_stack_after);
    // The chest must hold exactly the pre-existing stack plus what the breakpoint
    // retained — no more, no less.
    const storeConserved = storedStack === EXISTING_STACK + breakpointGained;
    if (!storeConsumed) throw new Error("recovery_store_postcondition_mismatch");
    if (!storeConserved)
      throw new Error(
        `recovery_store_conservation_mismatch:expected=${EXISTING_STACK + breakpointGained};actual=${storedStack}`,
      );

    // 3. Retry the SAME breakpoint action. It must now complete fully: consuming
    //    the surviving ingredient frees its slot and the product fits.
    snapshot = await waitForFreshSnapshot(client, {
      minRevision: recovery.revision,
      timeoutMs: stabilizeTimeoutMs,
      requireActionable: true,
      check: (latest) => latest.activeExecution == null && discoverableRecipe(latest, recipe.targetId),
    });
    const retryAccepted = await execute(
      "retry_craft",
      "craft_item",
      { expectedTargetId: recipe.targetId },
      snapshot,
      trace,
      client,
    );
    const retry = await waitForTerminal(receipts, retryAccepted, terminalTimeoutMs);
    if (retry.state !== "succeeded" || retry.reasonCode !== RETRY_REASON)
      throw new Error(`retry_craft_failed:${retry.state}/${retry.reasonCode}`);
    const retryEvidence = parseEvidence(retry.evidence, CRAFT_EVIDENCE_KEYS);
    const retryDisposition = retryEvidence.disposition;
    const retryGained = Number(retryEvidence.inventory_gained_stack);
    const retryDropped = Number(retryEvidence.dropped_stack);
    const fullDisposition = retryDisposition === FULL_DISPOSITION;
    const retryHonest = craftHonest(retryEvidence);
    const retryComplete = fullDisposition && retryGained === PRODUCED_STACK && retryDropped === 0;
    if (!fullDisposition)
      throw new Error(`retry_craft_disposition:${retryDisposition}`);
    if (!retryComplete) throw new Error("retry_craft_postcondition_mismatch");
    if (!retryHonest) throw new Error("retry_craft_honesty_mismatch");

    // Final fresh postcondition: the backpack must hold every unit the recipe
    // produced across both crafts except the ones the chest holds. This is what
    // proves the dropped remainder was not lost.
    const expectedFinalStack = breakpointDropped + retryGained;
    const after = await waitForFreshSnapshot(client, {
      minRevision: retry.revision,
      timeoutMs: postconditionTimeoutMs,
      requireActionable: true,
      check: (latest) => latest.activeExecution == null && advertisedProductStack(latest) === expectedFinalStack,
    });
    const finalStack = advertisedProductStack(after);
    const conserved = storedStack + finalStack === EXISTING_STACK + PRODUCED_STACK * 2;
    if (!conserved)
      throw new Error(
        `recovery_chain_conservation_mismatch:stored=${storedStack};final=${finalStack};expected=${EXISTING_STACK + PRODUCED_STACK * 2}`,
      );

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
    if (!sameJournalLineage) throw new Error("recovery_chain_journal_lineage_mismatch");
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
      recipe,
      storeTarget,
      receipt: summarizeReceipt(retry),
      breakpointEvidence,
      recoveryEvidence,
      retryEvidence,
      partialDisposition,
      partialConservation,
      breakpointHonest,
      storeConsumed,
      storeConserved,
      fullDisposition,
      retryComplete,
      retryHonest,
      conserved,
      sameJournalLineage,
      breakpointGained,
      breakpointDropped,
      storedStack,
      retryGained,
      finalStack,
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
    const result = await runCraftPartialRecoveryChainSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}

/** Every craft honesty field the Mod itself asserted before its terminal. */
function craftHonest(evidence) {
  return (
    evidence.output === PRODUCT_ITEM_ID &&
    evidence.inventory_postcondition === "true" &&
    evidence.count_postcondition === "true" &&
    evidence.materials_consumed_exactly === "true" &&
    evidence.native_menu_opened === "false" &&
    // Mirrors the Mod's droppedToGround guard (craftingactions.cs): the stack it
    // reports as left out must be zero, or exactly one debris chunk must have
    // appeared. Without this the chain could pass on a receipt the Mod itself
    // would have called Uncertain.
    (Number(evidence.dropped_stack) === 0 || Number(evidence.dropped_debris) === 1) &&
    Number.isSafeInteger(Number(evidence.count_before)) &&
    Number(evidence.count_after) === Number(evidence.count_before) + Number(evidence.produced_per_craft)
  );
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

async function travelToFarm(client, receipts, snapshot, trace, stabilizeTimeoutMs, terminalTimeoutMs) {
  let fresh = await observeCraftPartialActionable(client);
  const warp = resolveFarmWarp(fresh);
  if (!adjacent(fresh.tile, { x: warp.sourceX, y: warp.sourceY }))
    fresh = await moveToTile(
      client,
      receipts,
      fresh,
      { x: warp.sourceX, y: warp.sourceY },
      "move_to_farm_warp",
      trace,
      stabilizeTimeoutMs,
      terminalTimeoutMs,
    );
  fresh = await observeCraftPartialActionable(client);
  const freshWarp = fresh.warps.find(
    (entry) =>
      validWarp(entry) &&
      entry.sourceX === warp.sourceX &&
      entry.sourceY === warp.sourceY &&
      entry.targetLocation === "Farm" &&
      entry.targetX === warp.targetX &&
      entry.targetY === warp.targetY,
  );
  if (!freshWarp || !adjacent(fresh.tile, { x: freshWarp.sourceX, y: freshWarp.sourceY }))
    throw new Error("fresh_farm_warp_unavailable");
  const accepted = await execute(
    "travel_to_farm",
    "travel",
    { x: freshWarp.sourceX, y: freshWarp.sourceY },
    fresh,
    trace,
    client,
  );
  if (accepted.state !== "accepted") throw new Error(`travel_not_accepted:${accepted.reasonCode}`);
  const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "travel_completed")
    throw new Error(`travel_failed:${terminal.reasonCode}`);
  return waitForFreshSnapshot(client, {
    minRevision: terminal.revision,
    timeoutMs: stabilizeTimeoutMs,
    requireActionable: true,
    check: (latest) => latest.location === "Farm" && latest.activeExecution == null,
  });
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
      latest.activeExecution == null && (sameTile(latest.tile, target) || cardinalAdjacent(latest.tile, target)),
  });
}

function resolveFarmWarp(snapshot) {
  const matches = Array.isArray(snapshot.warps)
    ? snapshot.warps.filter(
        (warp) =>
          warp?.targetLocation === "Farm" &&
          Number.isInteger(warp.sourceX) &&
          Number.isInteger(warp.sourceY) &&
          Number.isInteger(warp.targetX) &&
          Number.isInteger(warp.targetY) &&
          warp.sourceX >= 0 &&
          warp.sourceY >= 0,
      )
    : [];
  if (matches.length !== 1) throw new Error(matches.length ? "ambiguous_farm_warp" : "farm_warp_missing");
  return matches[0];
}

function validWarp(entry) {
  return (
    typeof entry?.targetLocation === "string" &&
    Number.isInteger(entry?.sourceX) &&
    Number.isInteger(entry?.sourceY) &&
    Number.isInteger(entry?.targetX) &&
    Number.isInteger(entry?.targetY)
  );
}

/**
 * The Mod advertises learned recipes as `BridgeRecipeTarget(wireIdentity, displayName, …)`.
 * The display name is LOCALIZED (the content row for Bait carries
 * "[LocalizedText Strings\\Objects:Bait_Name]"), so it is not a stable selector — the live
 * gate caught exactly that. The wire identity is: it is what `TryResolveRecipeIdentity`
 * maps back to the live key and what the action receives as `expectedTargetId`.
 */
function chooseBaitRecipe(snapshot) {
  const targets = (snapshot.craftingRecipeTargets ?? []).filter(
    (target) =>
      typeof target?.targetId === "string" &&
      target.targetId === RECIPE_ALIAS &&
      target.ingredientsAvailable === true,
  );
  if (targets.length === 0)
    throw new Error(
      `bait_recipe_target_missing:${JSON.stringify((snapshot.craftingRecipeTargets ?? []).map((t) => t?.targetId))}`,
    );
  // The alias resolves to exactly one live recipe; the Mod rejects ambiguity, so a
  // second match here would be a protocol surprise rather than a choice.
  if (targets.length > 1) throw new Error("ambiguous_bait_recipe_target");
  return { targetId: targets[0].targetId, displayName: targets[0].displayName };
}

function discoverableRecipe(snapshot, targetId) {
  return (snapshot.craftingRecipeTargets ?? []).some(
    (target) => target?.targetId === targetId && target.ingredientsAvailable === true,
  );
}

/** The Mod's own storable-slot target for the adjacent chest. */
function chooseChestStoreTarget(snapshot) {
  const targets = (snapshot.chestStoreTargets ?? []).filter(
    (target) =>
      /^chest_[a-f0-9]{16}$/.test(target?.targetId ?? "") &&
      Number.isInteger(target.x) &&
      Number.isInteger(target.y) &&
      Number.isInteger(target.slot) &&
      target.qualifiedItemId === PRODUCT_ITEM_ID &&
      adjacent(snapshot.tile, target),
  );
  if (targets.length === 0) throw new Error("no_adjacent_live_chest_store_target");
  return targets[0];
}

/**
 * The retained product stack the Mod itself advertises as storable. Deliberately
 * NOT `inventoryItemFacts`: that field is published only for the animal-product /
 * inventory-offer capability set, so it is absent here and would silently read 0.
 */
function advertisedProductStack(snapshot) {
  const target = (snapshot.chestStoreTargets ?? []).find(
    (entry) => entry?.qualifiedItemId === PRODUCT_ITEM_ID && Number.isSafeInteger(entry?.stack),
  );
  return target === undefined ? -1 : target.stack;
}

async function observeCraftPartialActionable(client) {
  const snapshot = await observeFresh(client, { actionable: true });
  assertExactCapabilities(snapshot, EXPECTED_CAPABILITIES);
  if (
    !Number.isInteger(snapshot.revision) ||
    typeof snapshot.location !== "string" ||
    !Number.isInteger(snapshot.tile?.x) ||
    !Number.isInteger(snapshot.tile?.y) ||
    !Array.isArray(snapshot.craftingRecipeTargets) ||
    !Array.isArray(snapshot.chestStoreTargets)
  )
    throw new Error("native_local_craft_partial_snapshot_invalid");
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
    craftingRecipeTargets: snapshot.craftingRecipeTargets?.length ?? 0,
    chestStoreTargets: snapshot.chestStoreTargets?.length ?? 0,
    advertisedProductStack: advertisedProductStack(snapshot),
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
    value.Portfolio?.Enable === true
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
