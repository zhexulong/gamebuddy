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
 * Native-local recovery-chain contract for Lane G「断点续作 / 部分完成」(partial
 * completion).
 *
 * Unlike the rejection-triggered modes, this one never rejects: the native recipe
 * transaction really runs, and the product really exists afterwards — part in the
 * backpack, part on the ground. `farmhandexecutioncontroller.craftingactions.cs`
 * models exactly that with `ExecutionState.PartiallySucceeded`, which the bridge
 * publishes as `partially_succeeded` (`host/src/protocol.ts`), and explicitly
 * refuses to report a full success: "the craft happened and the product exists
 * (backpack and/or ground), but part or all of it did not enter the backpack:
 * never report a full success."
 *
 * The breakpoint is therefore a READING in the first receipt (its `disposition`
 * field), not a `rejected` terminal. Chain on one journal, one session, against
 * `native_craft_item_partial_v1` (a backpack already holding 998 Bait beside one
 * Bug Meat, plus one owned Chest on an adjacent tile):
 *
 *   1. breakpoint : `craft_item` for Bait. Bait's data row is
 *                   `684 1/Home/685 5/false/Fishing 2/` — one Bug Meat becomes
 *                   FIVE Bait — and (O)685's native max stack is 999, so the
 *                   existing 998 stack absorbs exactly one and four leave the
 *                   backpack as native debris. The receipt must be
 *                   `partially_succeeded/crafted_item_created` with
 *                   `disposition=partially_dropped_on_ground`, and the ingredient
 *                   must have been consumed exactly once.
 *   2. recovery   : `chest_store` the retained product stack into the chest
 *                   -> `succeeded/chest_stored`, freeing the backpack slot.
 *   3. resume     : `pickup_item` the FOUR dropped Bait back off the ground
 *                   -> `succeeded/item_picked_up`.
 *
 * Conservation is the point: 999 stored + 4 recovered = the 998 that already
 * existed plus the 5 the recipe produced. A chain that silently lost the dropped
 * remainder would still show a `partially_succeeded` receipt, so the resume leg —
 * not the breakpoint alone — is what makes this an honest completion.
 *
 * Request/execution identity correlation is enforced upstream by the shared
 * harness (`executeFresh` validates every receipt against the exact request it
 * submitted), so this runner does not re-derive that proof.
 *
 * This is a harness-only chain scenario; it grants no capability and changes no
 * action lifecycle.
 */
const SCENARIO = "native_craft_item_partial_v1";
const EXPECTED_ACTIONS = ["move_to_tile", "travel", "craft_item", "chest_store", "pickup_item"];
const EXPECTED_CAPABILITIES = [
  "cancel_active_execution",
  "chest_store",
  "craft_item",
  "inspect_self",
  "move_to_tile",
  "pickup_item",
  "travel",
].sort();

const RECIPE_ALIAS = "Bait";
const PRODUCT_ITEM_ID = "(O)685";
const INGREDIENT_ITEM_ID = "(O)684";
/** Bait's data row produces five per craft; (O)685's native max stack is 999. */
const PRODUCED_STACK = 5;
const EXISTING_STACK = 998;

// Terminal reason codes, asserted against the Mod source by the offline test.
const BREAKPOINT_REASON = "crafted_item_created";
const RECOVERY_REASON = "chest_stored";
const RESUME_REASON = "item_picked_up";
// The partial disposition the breakpoint must prove.
const PARTIAL_DISPOSITION = "partially_dropped_on_ground";

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
    // travel leg is required; a FarmHouse start would still be reachable here
    // because craft/pickup above need no particular map.
    if (snapshot.location !== "Farm")
      snapshot = await travelToFarm(client, receipts, snapshot, trace, stabilizeTimeoutMs, travelTimeoutMs);
    snapshot = await observeCraftPartialActionable(client);
    assertExactCapabilities(snapshot, EXPECTED_CAPABILITIES);

    // The declared Given is a backpack that cannot hold the whole product. A chain
    // whose breakpoint never happened proves nothing, so refuse before submitting.
    // The Mod's own advertised storable slot is the retained Bait stack, so it is
    // the authoritative reading of "how much product the actor is carrying".
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
    const breakpointEvidence = parseEvidence(breakpoint.evidence, [
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
    ]);
    const partialDisposition = breakpointEvidence.disposition === PARTIAL_DISPOSITION;
    const droppedStack = Number(breakpointEvidence.dropped_stack);
    const gainedStack = Number(breakpointEvidence.inventory_gained_stack);
    const producedStack = Number(breakpointEvidence.produced_stack);
    const partialConservation =
      Number.isSafeInteger(droppedStack) &&
      Number.isSafeInteger(gainedStack) &&
      Number.isSafeInteger(producedStack) &&
      droppedStack > 0 &&
      gainedStack > 0 &&
      gainedStack + droppedStack === producedStack &&
      producedStack === PRODUCED_STACK;
    const breakpointHonest =
      breakpointEvidence.inventory_postcondition === "true" &&
      breakpointEvidence.count_postcondition === "true" &&
      breakpointEvidence.materials_consumed_exactly === "true" &&
      breakpointEvidence.native_menu_opened === "false" &&
      breakpointEvidence.output === PRODUCT_ITEM_ID &&
      Number(breakpointEvidence.dropped_debris) > 0;
    if (!partialDisposition)
      throw new Error(`recovery_chain_breakpoint_disposition:${breakpointEvidence.disposition}`);
    if (!partialConservation || !breakpointHonest) throw new Error("recovery_chain_breakpoint_postcondition_mismatch");

    // The product the actor KEEPS must now be visible as the advertised storable
    // stack, and the dropped remainder must be discoverable as a live item target.
    snapshot = await waitForFreshSnapshot(client, {
      minRevision: breakpoint.revision,
      timeoutMs: stabilizeTimeoutMs,
      requireActionable: true,
      check: (latest) =>
        latest.activeExecution == null &&
        advertisedProductStack(latest) === EXISTING_STACK + gainedStack &&
        discoverableDroppedTargets(latest).length > 0,
    });

    // 2. Recovery: store the retained stack, freeing a backpack slot. The store
    //    target's slot is the one the Mod itself advertises for storable items.
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
    if (!storeConsumed || !Number.isSafeInteger(storedStack) || storedStack <= Number(recoveryEvidence.chest_stack_before))
      throw new Error("recovery_store_postcondition_mismatch");
    snapshot = await waitForFreshSnapshot(client, {
      minRevision: recovery.revision,
      timeoutMs: stabilizeTimeoutMs,
      requireActionable: true,
      check: (latest) => latest.activeExecution == null && discoverableDroppedTargets(latest).length > 0,
    });

    // 3. Resume: pick the dropped remainder back off the ground. This is what
    //    makes the partial completion honest instead of a silent loss.
    const dropTarget = chooseDroppedTarget(snapshot);
    const resumeAccepted = await execute(
      "resume_pickup",
      "pickup_item",
      {
        x: dropTarget.x,
        y: dropTarget.y,
        expectedQualifiedItemId: dropTarget.qualifiedItemId,
        expectedTargetId: dropTarget.targetId,
      },
      snapshot,
      trace,
      client,
    );
    const resume = await waitForTerminal(receipts, resumeAccepted, terminalTimeoutMs);
    if (resume.state !== "succeeded" || resume.reasonCode !== RESUME_REASON)
      throw new Error(`resume_pickup_failed:${resume.reasonCode}`);
    const resumeEvidence = parseEvidence(resume.evidence, [
      "inventory_after",
      "inventory_before",
      "item",
      "location",
      "target",
      "tile",
    ]);
    const after = await waitForFreshSnapshot(client, {
      minRevision: resume.revision,
      timeoutMs: postconditionTimeoutMs,
      requireActionable: true,
      check: (latest) => latest.activeExecution == null && Array.isArray(latest.itemTargets),
    });
    const resumeTargetGone = after.itemTargets.every((entry) => entry?.targetId !== dropTarget.targetId);
    const inventoryBefore = Number(resumeEvidence.inventory_before);
    const inventoryAfter = Number(resumeEvidence.inventory_after);
    const recoveredStack = inventoryAfter - inventoryBefore;
    const resumeBound =
      resumeEvidence.item === PRODUCT_ITEM_ID &&
      resumeEvidence.location === snapshot.location &&
      resumeEvidence.target === dropTarget.targetId &&
      resumeEvidence.tile === `${dropTarget.x},${dropTarget.y}`;
    // Conservation: what the chest holds plus what the pickup leg recovered must
    // equal the pre-existing stack plus the five the recipe produced. Anything less
    // means the partial remainder was lost, which is the failure this whole mode
    // exists to catch. Every term is a Mod-authored receipt field, never a value
    // this runner derives from a snapshot field gated on another capability.
    const conserved = storedStack + recoveredStack === EXISTING_STACK + PRODUCED_STACK && recoveredStack === droppedStack;
    // Same-journal lineage: three terminals, strictly advancing revision, distinct
    // execution identities. Request identity is correlated by the shared harness.
    const sameJournalLineage =
      Number.isSafeInteger(breakpoint.revision) &&
      Number.isSafeInteger(recovery.revision) &&
      Number.isSafeInteger(resume.revision) &&
      breakpoint.revision < recovery.revision &&
      recovery.revision < resume.revision &&
      typeof breakpoint.executionId === "string" &&
      typeof recovery.executionId === "string" &&
      typeof resume.executionId === "string" &&
      breakpoint.executionId !== recovery.executionId &&
      recovery.executionId !== resume.executionId &&
      breakpoint.executionId !== resume.executionId;
    const passed =
      partialDisposition &&
      partialConservation &&
      breakpointHonest &&
      storeConsumed &&
      resumeBound &&
      resumeTargetGone &&
      conserved &&
      sameJournalLineage;
    if (!passed) throw new Error("recovery_chain_postcondition_mismatch");
    return {
      state: "passed",
      topology: "native_local_player_fixture",
      reasonCode: RESUME_REASON,
      chain: {
        breakpoint: summarizeReceipt(breakpoint),
        recovery: summarizeReceipt(recovery),
        resume: summarizeReceipt(resume),
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
        resumeReceipt: {
          requestId: resume.requestId,
          executionId: resume.executionId,
          state: resume.state,
          reasonCode: resume.reasonCode,
          revision: resume.revision,
        },
      },
      recipe,
      storeTarget,
      dropTarget,
      receipt: summarizeReceipt(resume),
      breakpointEvidence,
      recoveryEvidence,
      resumeEvidence,
      partialDisposition,
      partialConservation,
      breakpointHonest,
      storeConsumed,
      resumeBound,
      resumeTargetGone,
      conserved,
      sameJournalLineage,
      storedStack,
      recoveredStack,
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
  const accepted = await execute("travel_to_farm", "travel", { x: freshWarp.sourceX, y: freshWarp.sourceY }, fresh, trace, client);
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

/** The Mod advertises learned recipes as `BridgeRecipeTarget(<wire identity>, …)`. */
function chooseBaitRecipe(snapshot) {
  const targets = (snapshot.craftingRecipeTargets ?? []).filter(
    (target) =>
      typeof target?.targetId === "string" &&
      target.targetId.length > 0 &&
      target.ingredientsAvailable === true &&
      String(target.displayName ?? "").toLowerCase() === RECIPE_ALIAS.toLowerCase(),
  );
  if (targets.length === 0) {
    const seen = (snapshot.craftingRecipeTargets ?? []).map((target) => target?.targetId);
    throw new Error(`bait_recipe_target_missing:${JSON.stringify(seen)}`);
  }
  // The alias resolves to exactly one live recipe; the Mod rejects ambiguity, so a
  // second match here would be a protocol surprise rather than a choice.
  if (targets.length > 1) throw new Error("ambiguous_bait_recipe_target");
  return { targetId: targets[0].targetId, displayName: targets[0].displayName };
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

/** The dropped remainder, discoverable inside the Mod's item-target radius. */
function discoverableDroppedTargets(snapshot) {
  return (snapshot.itemTargets ?? []).filter(
    (target) =>
      typeof target?.targetId === "string" &&
      target.targetId.length > 0 &&
      target.qualifiedItemId === PRODUCT_ITEM_ID &&
      Number.isInteger(target.x) &&
      Number.isInteger(target.y) &&
      target.x >= 0 &&
      target.y >= 0,
  );
}

function chooseDroppedTarget(snapshot) {
  const targets = discoverableDroppedTargets(snapshot);
  if (targets.length === 0) throw new Error("no_discoverable_dropped_product_target");
  // The recipe drops one debris entity per craft; more than one would mean the
  // fixture produced an ambiguous world, not that any pick is equally valid.
  if (targets.length > 1) throw new Error("ambiguous_discoverable_dropped_product_targets");
  return targets[0];
}

/** The retained product stack the Mod itself advertises as storable. */
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
    !Array.isArray(snapshot.chestStoreTargets) ||
    !Array.isArray(snapshot.itemTargets)
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
    itemTargets: snapshot.itemTargets?.length ?? 0,
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
        apiVersion: value.ActionPolicyVersion,
      })}`,
    );
  if (value.ActionPolicyVersion !== 0 || JSON.stringify(value.EnabledActions) !== JSON.stringify(EXPECTED_ACTIONS))
    throw new Error("native_local_craft_partial_action_policy_invalid");
}

function validFixtureSlotRelationship(logicalName, observedSaveSlot) {
  return (
    typeof logicalName === "string" &&
    /^GameBuddyFixture[A-Za-z0-9]{0,64}$/.test(logicalName) &&
    typeof observedSaveSlot === "string" &&
    new RegExp(`^${logicalName}_[0-9]{1,32}$`).test(observedSaveSlot)
  );
}
