using System;
using System.Collections.Generic;
using System.Diagnostics.CodeAnalysis;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Buildings;
using StardewValley.GameData.Buildings;
using StardewValley.Objects;

namespace GameBuddy.Stardew;

// The building-chest pair: `load_building_chest` and `collect_building_chest_output`.
//
// WHY THIS IS NOT chest_store/chest_retrieve. Those two own the PLAYER-OWNED ordinary
// Chest and the kitchen fridge (`Chest.addItem` / `GetItemsForPlayer`), and
// `machine_load`/`machine_collect_output` bind to one machine Object's `heldObject`. Some
// buildings ship their OWN storage, declared in DATA rather than by any C# class:
// `BuildingData.Chests` (StardewValley.GameData.Buildings/BuildingChest.cs) declares named
// inventories with a `Type`, and `BuildingData.ItemConversions` declares what may go in and
// what comes out. Vanilla uses it: the Mill declares Input (Load) and Output (Collect)
// chests, and the Junimo Hut declares an Output (Collect) chest. None of the four existing
// container/machine actions can reach those, so the production half-loop was missing.
//
// THE SEAM, AND THE BRANCH IT TAKES. A building chest is reached by a CLICK on a building
// tile: `GameLocation.checkAction` (GameLocation.cs:7647-7653) calls `Building.doAction`
// for the clicked tile, `Building.doAction` (Building.cs:981-992) asks
// `BuildingData.GetActionAtTile` (BuildingData.cs:271-291) for that tile's action and hands
// it to `GameLocation.performAction`, whose `BuildingChest` case (:10128-10136) calls
// `getBuildingAt(tile)?.PerformBuildingChestAction(name, who)`. Nothing on that path is
// input-gated (unlike `BuildingToggleAnimalDoor`, which needs
// `Game1.didPlayerJustRightClick`) and nothing in it needs a click, so this action calls
// the TERMINAL public method directly: `Building.PerformBuildingChestAction(string name,
// Farmer who)` (Building.cs:746-811). It is public, UI-free for the Load/Collect branches,
// and synchronous. What is NOT called: `GameLocation.performAction`/`checkAction`,
// `Building.doAction`, any synthesized click, and any menu driving.
//
// THE THREE NATIVE BRANCHES (Building.cs:758-810), and which of them this pair serves:
//   * `BuildingChestType.Chest` (:760-762) sets `Game1.activeClickableMenu = new
//     ItemGrabMenu(...)` UNCONDITIONALLY. It is a pure container-UI entry point, so it is
//     never published as a target and a request that names one by its opaque id is refused
//     by NAME (`building_chest_requires_menu`) rather than driven. There is no generic
//     container-menu driver in this Mod (only `shop_purchase` drives a shop-specific menu),
//     so menu driving is a new capability, not an implementation detail.
//   * `BuildingChestType.Load` (:763-804) requires `who.ActiveObject != null` (:764) — the
//     HELD item, which is `Items[CurrentToolIndex]` (`Farmer.ActiveObject` is
//     `ActiveItem as Object`, Farmer.cs:1686-1696, and `ActiveItem` reads
//     `Items[currentToolIndex.Value]`, :1653-1670). That is why `load_building_chest`
//     carries a required `slot`: it names the inventory slot to HOLD for the call. The action
//     selects that slot and restores the actor's previous selection afterwards, exactly as
//     `machine_load` does its own native input load
//     (farmhandexecutioncontroller.machinesanimalsitemsactions.cs:89-99), so a request can
//     never silently leave the actor holding something else; a slot that holds no Object is
//     refused with the family's `item_not_owned_in_slot`.
//   * `BuildingChestType.Collect` (:805-807) delegates to
//     `Utility.CollectSingleItemOrShowChestMenu(chest)` (Utility.cs:2045-2085), which
//     AUTO-COLLECTS only when the chest holds exactly ONE non-null stack: it counts
//     non-null slots, stops at the second one, and for two or more it falls through to
//     `Game1.activeClickableMenu = new ItemGrabMenu(...)` (:2085). The owner's ruling for
//     that case is a NAMED REFUSAL (`building_chest_requires_menu`), not menu driving.
//
// THE LOAD BRANCH'S OWN FAILURE PATHS, AND WHY THEY GET NO INVENTED CODES. Every Load
// refusal is native: `Game1.showRedMessage(...)` with the chest data's own
// `InvalidItemMessage` (:770, when `IsValidObjectForChest` is false),
// `ChestFullMessage` (:780, when the held stack exceeds `RequiredCount` and the chest
// cannot take one quantum) and `InvalidCountMessage` (:788, when the quantised
// `num = min(capacity, stack) / RequiredCount * RequiredCount` is 0). Those messages reach
// the Agent through the established `nativeNotices` channel, so this action does NOT
// pre-refuse them and does not invent a parallel reason vocabulary: the native call runs,
// the game posts its own message, and the receipt reports the observed facts plus
// `native_refusal=`, naming the native data field that gate belongs to
// (`InvalidItemMessage` / `ChestFullMessage` / `InvalidCountMessage` / `none`). That label
// is computed from the same public predicates the native branch reads, AFTER the refusal
// was observed, so it can only describe a refusal that happened — never refuse a world the
// native call would have served.
//
// ARGUMENTS (frozen; the protocol has no optional arguments):
//   * `load_building_chest {x, y, slot, expectedTargetId}`
//   * `collect_building_chest_output {x, y, expectedTargetId}`
// `x,y` is the tile the target was PUBLISHED at, used as the walk leg's destination: the
// target is re-resolved from the opaque id on the game thread, and reach is measured
// against the tile the live data maps to that chest, never against the snapshot. There is
// no Chest-type form of either action and no menu-driving form of collect.//
// THE PUBLISHED TILE IS THE NATIVE INTERACTION TILE, DERIVED FROM DATA. For each declared
// chest the anchor is the first tile inside the building's own footprint at which
// `BuildingData.GetActionAtTile(relativeX, relativeY)` names this chest (`BuildingChest
// <chestId>`) AND `Building.isTilePassable` is false — the exact pair `Building.doAction`
// requires to reach the chest at all (:981-983). That single rule covers both ways the game
// declares the entry: an explicit `ActionTiles` entry, and `DefaultAction` (the fallback
// `GetActionAtTile` returns for every tile inside the building's size). It deliberately does
// not require the building to have a human door (a Mill's chests are reached from the
// building's own tiles, not from a door) and it never hardcodes a building type: a furniture
// or mod-provided building whose data declares chests is published identically.
//
// THE OPAQUE TARGET IDENTITY binds the location, the building's origin, its building type,
// the chest id, the chest's DECLARED type and the interaction tile, so "the Output chest of
// THIS Mill, reached at THIS tile" is what a request names. It deliberately does NOT bind
// the chest's contents: contents are the postcondition's moving part, and an identity that
// moved with them would turn a legitimate second load into a "stale target" refusal. A
// building whose data changed (chest removed, type changed, tile moved) derives a different
// id, which is what makes `building_chest_target_changed` an honest staleness refusal.
//
// POSTCONDITIONS ARE OBSERVED WORLD CHANGES, re-read after the call. Neither the Load
// branch's `bool` nor the Collect branch's is accepted as evidence:
//   * load succeeds only when the chest's count of the held item rose, the held stack fell
//     by the SAME amount, and that amount is a positive whole number of the conversion's
//     `RequiredCount` quanta (`BuildingItemConversion.RequiredCount`, applied at
//     Building.cs:783);
//   * collect succeeds only when the named stack left the chest (the chest's count of it
//     fell, and its slot count fell) AND the actor's inventory gained exactly that many of
//     the same item.
// A call that completed without that change is `Uncertain`
// (`building_chest_*_postcondition_unavailable`), never a success.
//
// LIFECYCLE. Both are registered in FarmhandActionCatalog as
// `FarmhandActionLifecycle.Experimental` (family `buildings_farm_management`, handler group
// ResourceTools, postconditions `building_chest_loaded` / `building_chest_output_collected`,
// native binding `Building.PerformBuildingChestAction`). Experimental keeps them off the
// Agent surface until each has passed its own native-local live gate; promotion to
// LiveVerified is a separate, explicit catalog edit owned by the parent.
//
// FAILURE MODES, each with its own terminal code, so no two stories collapse:
//   * `building_chest_target_not_found` — no building occupies the published tile;
//   * `building_chest_missing` — the building declares no chests at all;
//   * `building_chest_target_changed` — the published id no longer describes the live
//     building/chest/tile (chest removed, type changed, tile moved);
//   * `building_chest_requires_menu` — the named chest's branch is the unconditional
//     `ItemGrabMenu` branch (Chest type), or collect found two or more stacks;
//   * `building_chest_not_loadable` / `building_chest_not_collectable` — the wrong branch
//     for this action (collecting from an Input chest, loading an Output chest);
//   * `item_not_owned_in_slot` — the requested slot does not exist or holds no Object to load
//     (the family's existing code);
//   * `building_chest_out_of_range` — the actor never reached the interaction tile;
//   * `building_chest_native_exception` — the native call threw;
//   * `building_chest_empty` — collect found no stack to take;
//   * `inventory_full` — collect would leave part of the single stack behind, and the native
//     branch would then open a menu this action must not leave open (the family's existing
//     code, the same one `chest_retrieve` uses);
//   * `building_chest_load_refused` / `building_chest_collect_refused` — the native branch
//     declined (its own red message reaches the Agent through `nativeNotices`);
//   * `building_chest_load_postcondition_unavailable` /
//     `building_chest_collect_postcondition_unavailable` — the call ran and the world did
//     not move;
//   * `building_chest_loaded` / `building_chest_output_collected` — success.
internal sealed partial class ExecutionManager
{
    /// <summary>
    /// Loads the actor's held item into one published building chest, resolving the target
    /// from its opaque id on the game thread and proving the quantised transfer from the
    /// world afterwards. See the file header for the seam, the arguments and the failure
    /// modes.
    /// </summary>
    public LocalExecutionReceipt RequestLocalLoadBuildingChest(
        string requestId,
        int targetX,
        int targetY,
        int slot,
        string expectedTargetId,
        long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // General, not Physical: this seam starts no tool swing and drives no tool
        // lifecycle — it is the same instantaneous non-tool container transaction
        // `chest_store` admits through this path.
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;

        BuildingChestResolution resolution = ResolveBuildingChest(targetX, targetY, expectedTargetId, BuildingChestAction.Load);
        if (!resolution.Accepted)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, resolution.ReasonCode, resolution.Evidence);

        if (!TryGetInventoryObjectInSlot(slot, out StardewValley.Object? heldObject))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_not_owned_in_slot", $"{resolution.Identity};slot={slot}");

        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
            return this.TryBeginToolApproach(
                requestId,
                executionId,
                "load_building_chest",
                Game1.player.currentLocation,
                targetX,
                targetY,
                expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteLoadBuildingChest(arrivalExecutionId, arrivalRequestId, slot, targetX, targetY, expectedTargetId),
                nowMs,
                requestedDeadlineMs);
        return this.ExecuteLoadBuildingChest(executionId, requestId, slot, targetX, targetY, expectedTargetId);
    }

    /// <summary>
    /// The one load execution body, reached both in range and on arrival from the approach
    /// leg. It re-resolves the target, the held item and the geometry, because the walk can
    /// take several ticks and any of them can change.
    /// </summary>
    private LocalExecutionReceipt ExecuteLoadBuildingChest(string executionId, string requestId, int slot, int x, int y, string targetId)
    {
        BuildingChestResolution resolution = ResolveBuildingChest(x, y, targetId, BuildingChestAction.Load);
        if (!resolution.Accepted)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, resolution.ReasonCode, resolution.Evidence);
        if (!TryGetInventoryObjectInSlot(slot, out StardewValley.Object? heldObject))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_not_owned_in_slot", $"{resolution.Identity};slot={slot}");
        if (!IsTileWithinChebyshevRadius(Game1.player, x, y, 1))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "building_chest_out_of_range",
                $"{resolution.Identity};actor_tile={Game1.player.TilePoint.X},{Game1.player.TilePoint.Y}");

        Building building = resolution.Building!;
        Chest chest = building.GetBuildingChest(resolution.ChestId)!;
        string qualifiedItemId = heldObject.QualifiedItemId;
        // The native branch's own two admission facts, read with the SAME public API it
        // reads (:774 GetItemConversionForItem, :777 GetNumberOfItemThatCanBeAddedToThis-
        // InventoryList). They LABEL an observed refusal; they never refuse before the call,
        // because the game's own red message is the Agent-facing reason. The capacity is
        // read before the native branch's own `consolidateStacks`/`clearNulls` (:775-776),
        // so it is the chest's addable count as this action found it, not as the branch
        // normalised it.
        BuildingItemConversion? conversion = building.GetItemConversionForItem(heldObject, chest);
        int requiredCount = conversion?.RequiredCount ?? 0;
        int chestCapacityBefore = conversion is null ? 0 : Utility.GetNumberOfItemThatCanBeAddedToThisInventoryList(heldObject, chest.Items, 36);
        int heldStackBefore = heldObject.Stack;
        int chestItemBefore = ChestItemCount(chest, qualifiedItemId);
        int chestSlotsBefore = BuildingChestSlotCount(chest);
        bool menuBefore = Game1.activeClickableMenu is not null;
        int previousSlot = Game1.player.CurrentToolIndex;
        bool nativeAccepted;
        try
        {
            // THE SEAM, reached with the requested slot HELD. The native Load branch reads
            // `who.ActiveObject` (:764) — `Items[CurrentToolIndex]` — so the slot is selected for
            // the call and the actor's previous selection is restored afterwards, exactly as
            // `machine_load` does its own native load (farmhandexecutioncontroller
            // .machinesanimalsitemsactions.cs:89-99). No click, no menu, no reproduced conversion
            // arithmetic: the branch owns them.
            Game1.player.CurrentToolIndex = slot;
            nativeAccepted = building.PerformBuildingChestAction(resolution.ChestId, Game1.player);
        }
        catch (Exception nativeException)
        {
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Uncertain,
                "building_chest_native_exception",
                $"{resolution.Identity};item={qualifiedItemId};held_stack_before={heldStackBefore};chest_item_before={chestItemBefore};native_exception={nativeException.GetType().Name};native_call_ran_unknown=true");
        }
        finally
        {
            Game1.player.CurrentToolIndex = previousSlot;
        }

        // Re-read the world AFTER the call: both halves of the quantised transfer are
        // observations, not the seam's return value.
        int chestItemAfter = ChestItemCount(chest, qualifiedItemId);
        int chestSlotsAfter = BuildingChestSlotCount(chest);
        int movedCount = chestItemAfter - chestItemBefore;
        int releasedCount = heldStackBefore - heldObject.Stack;
        bool nativeMenuOpened = Game1.activeClickableMenu is not null && !menuBefore;
        string evidence =
            $"{resolution.Identity};item={qualifiedItemId};held_stack_before={heldStackBefore};held_stack_after={heldObject.Stack};"
            + $"chest_item_before={chestItemBefore};chest_item_after={chestItemAfter};chest_slots_before={chestSlotsBefore};chest_slots_after={chestSlotsAfter};"
            + $"moved_count={movedCount};released_count={releasedCount};required_count={requiredCount};chest_capacity_before={chestCapacityBefore};"
            + $"item_accepted={(conversion is not null).ToString().ToLowerInvariant()};native_accepted={nativeAccepted.ToString().ToLowerInvariant()};"
            + $"native_refusal={DescribeNativeLoadRefusal(conversion is not null, requiredCount, heldStackBefore, chestCapacityBefore)};"
            + $"native_menu_opened={nativeMenuOpened.ToString().ToLowerInvariant()}";

        bool postcondition = nativeAccepted
            && !nativeMenuOpened
            && movedCount > 0
            && movedCount == releasedCount
            && requiredCount > 0
            && movedCount % requiredCount == 0;
        if (postcondition)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "building_chest_loaded", evidence);
        if (!nativeAccepted)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "building_chest_load_refused", evidence);
        return this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "building_chest_load_postcondition_unavailable", evidence);
    }

    /// <summary>
    /// Collects the single stack one published building chest currently holds, proving both
    /// halves of the transfer from the world afterwards. Two or more stacks are refused by
    /// name instead of being handed to the native menu. See the file header.
    /// </summary>
    public LocalExecutionReceipt RequestLocalCollectBuildingChestOutput(
        string requestId,
        int targetX,
        int targetY,
        string expectedTargetId,
        long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;

        BuildingChestResolution resolution = ResolveBuildingChest(targetX, targetY, expectedTargetId, BuildingChestAction.Collect);
        if (!resolution.Accepted)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, resolution.ReasonCode, resolution.Evidence);

        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
            return this.TryBeginToolApproach(
                requestId,
                executionId,
                "collect_building_chest_output",
                Game1.player.currentLocation,
                targetX,
                targetY,
                expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteCollectBuildingChestOutput(arrivalExecutionId, arrivalRequestId, targetX, targetY, expectedTargetId),
                nowMs,
                requestedDeadlineMs);
        return this.ExecuteCollectBuildingChestOutput(executionId, requestId, targetX, targetY, expectedTargetId);
    }

    /// <summary>
    /// The one collect execution body, reached both in range and on arrival from the
    /// approach leg. It re-resolves the target and re-reads the chest's own stack layout,
    /// because the walk can take several ticks.
    /// </summary>
    private LocalExecutionReceipt ExecuteCollectBuildingChestOutput(string executionId, string requestId, int x, int y, string targetId)
    {
        BuildingChestResolution resolution = ResolveBuildingChest(x, y, targetId, BuildingChestAction.Collect);
        if (!resolution.Accepted)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, resolution.ReasonCode, resolution.Evidence);
        if (!IsTileWithinChebyshevRadius(Game1.player, x, y, 1))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "building_chest_out_of_range",
                $"{resolution.Identity};actor_tile={Game1.player.TilePoint.X},{Game1.player.TilePoint.Y}");

        Building building = resolution.Building!;
        Chest chest = building.GetBuildingChest(resolution.ChestId)!;
        // The native collect branch counts NON-NULL SLOTS and stops at the second one
        // (Utility.cs:2047-2065), so the slot count is the branch's own precondition.
        int chestSlotsBefore = BuildingChestSlotCount(chest);
        Item? single = chest.GetItemsForPlayer().FirstOrDefault(item => item is not null);
        int chestItemBefore = single is null ? 0 : ChestItemCount(chest, single.QualifiedItemId);
        int carriedBefore = single is null ? 0 : CountQualifiedItem(Game1.player, single.QualifiedItemId);
        bool menuBefore = Game1.activeClickableMenu is not null;

        // Every refusal this branch can name is decided BEFORE anything is touched, and the
        // three cases are mutually exclusive: an empty chest, the >= 2-stack case the owner
        // ruled a named refusal, and a single stack that does not entirely fit — because the
        // native branch adds what it can and then opens `ItemGrabMenu` for the remainder
        // (:2080-2085), and this action must not leave an undriveable menu open. The
        // `couldInventoryAcceptThisItem` precondition is the same one `chest_retrieve` uses.
        if (chestSlotsBefore == 0 || chestSlotsBefore >= 2 || single is null || !Game1.player.couldInventoryAcceptThisItem(single))
        {
            string reasonCode = chestSlotsBefore == 0
                ? "building_chest_empty"
                : chestSlotsBefore >= 2
                    ? "building_chest_requires_menu"
                    : "inventory_full";
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                reasonCode,
                $"{resolution.Identity};item={single?.QualifiedItemId ?? "absent"};chest_slots_before={chestSlotsBefore};chest_slots_after={chestSlotsBefore};"
                + $"chest_item_before={chestItemBefore};chest_item_after={chestItemBefore};moved_count=0;carried_before={carriedBefore};carried_after={carriedBefore};"
                + "native_accepted=false;native_menu_opened=false");
        }

        bool nativeAccepted;
        try
        {
            nativeAccepted = building.PerformBuildingChestAction(resolution.ChestId, Game1.player);
        }
        catch (Exception nativeException)
        {
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Uncertain,
                "building_chest_native_exception",
                $"{resolution.Identity};item={single.QualifiedItemId};chest_slots_before={chestSlotsBefore};native_exception={nativeException.GetType().Name};native_call_ran_unknown=true");
        }

        int chestSlotsAfter = BuildingChestSlotCount(chest);
        int chestItemAfter = ChestItemCount(chest, single.QualifiedItemId);
        int carriedAfter = CountQualifiedItem(Game1.player, single.QualifiedItemId);
        int movedCount = chestItemBefore - chestItemAfter;
        bool nativeMenuOpened = Game1.activeClickableMenu is not null && !menuBefore;
        string evidence =
            $"{resolution.Identity};item={single.QualifiedItemId};chest_slots_before={chestSlotsBefore};chest_slots_after={chestSlotsAfter};"
            + $"chest_item_before={chestItemBefore};chest_item_after={chestItemAfter};moved_count={movedCount};"
            + $"carried_before={carriedBefore};carried_after={carriedAfter};"
            + $"native_accepted={nativeAccepted.ToString().ToLowerInvariant()};native_menu_opened={nativeMenuOpened.ToString().ToLowerInvariant()}";

        bool postcondition = nativeAccepted
            && !nativeMenuOpened
            && movedCount > 0
            && chestSlotsAfter < chestSlotsBefore
            && carriedAfter - carriedBefore == movedCount;
        if (postcondition)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "building_chest_output_collected", evidence);
        if (!nativeAccepted)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "building_chest_collect_refused", evidence);
        return this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "building_chest_collect_postcondition_unavailable", evidence);
    }

    /// <summary>
    /// One resolved building chest, or the named reason the published target no longer
    /// matches the live world. <see cref="Identity"/> is the evidence prefix shared by every
    /// receipt this pair mints.
    /// </summary>
    private sealed record BuildingChestResolution(
        bool Accepted,
        string ReasonCode,
        string Evidence,
        string Identity,
        Building? Building,
        string ChestId)
    {
        internal static BuildingChestResolution Reject(string reasonCode, string evidence) =>
            new(false, reasonCode, evidence, string.Empty, null, string.Empty);
    }

    /// <summary>Which of the two scriptable native branches the caller wants.</summary>
    private enum BuildingChestAction
    {
        Load,
        Collect,
    }

    /// <summary>
    /// Re-derives the named building chest on the game thread. A mismatch is a named
    /// refusal, never a silent re-target, and the branch the native code would take is named
    /// before anything is called.
    /// </summary>
    private static BuildingChestResolution ResolveBuildingChest(int x, int y, string expectedTargetId, BuildingChestAction action)
    {
        GameLocation location = Game1.player.currentLocation;
        string published = $"tile={x},{y};location={location.NameOrUniqueName};target={expectedTargetId}";
        Building? building = location.buildings.FirstOrDefault(candidate => candidate is not null && candidate.occupiesTile(x, y, applyTilePropertyRadius: true));
        if (building is null)
            return BuildingChestResolution.Reject("building_chest_target_not_found", $"{published};building=none");

        string identity = $"{published};building_type={building.buildingType.Value};building_origin={building.tileX.Value},{building.tileY.Value}";
        BuildingData? data = building.GetData();
        if (data?.Chests is null || data.Chests.Count == 0)
            return BuildingChestResolution.Reject("building_chest_missing", $"{identity};declared_chests=0");

        foreach (BuildingChest declared in data.Chests)
        {
            if (declared is null || string.IsNullOrWhiteSpace(declared.Id)) continue;
            Chest? live = building.GetBuildingChest(declared.Id);
            if (live is null) continue;
            if (!string.Equals(BuildBuildingChestTargetId(location, building, declared.Id, declared.Type, x, y), expectedTargetId, StringComparison.Ordinal)) continue;

            string branch = DescribeBuildingChestBranch(declared.Type);
            string chestIdentity = $"{identity};chest_id={declared.Id};branch={branch}";
            // The Chest type opens `ItemGrabMenu` unconditionally (:760-762), so it is not a
            // target this Mod can serve whichever half the caller wanted.
            if (declared.Type == BuildingChestType.Chest)
                return BuildingChestResolution.Reject("building_chest_requires_menu", $"{chestIdentity};native_menu_required=true");
            if (action == BuildingChestAction.Load && declared.Type != BuildingChestType.Load)
                return BuildingChestResolution.Reject("building_chest_not_loadable", $"{chestIdentity};action=load");
            if (action == BuildingChestAction.Collect && declared.Type != BuildingChestType.Collect)
                return BuildingChestResolution.Reject("building_chest_not_collectable", $"{chestIdentity};action=collect");
            return new BuildingChestResolution(true, "accepted", string.Empty, chestIdentity, building, declared.Id);
        }

        return BuildingChestResolution.Reject("building_chest_target_changed", $"{identity};declared_chests={data.Chests.Count};live_match=none");
    }

    /// <summary>
    /// The chests this actor can name right now, projected read-only from live state: every
    /// finished building in the current location whose data declares a Load or Collect chest
    /// it actually owns a live inventory for, with the tile the game itself maps a click on
    /// this chest to. Nothing is synthesized — a chest that is not there is not advertised —
    /// and the Chest type is deliberately absent, because a target that can only open a menu
    /// is not a target this Mod can serve.
    ///
    /// `stackCount` is the number of occupied slots and `itemCount` the number of items,
    /// both read from the live chest. They are published because the two branches' own
    /// preconditions are stated in those terms — collect auto-collects exactly ONE slot
    /// (Utility.cs:2055-2063) while a load moves a whole number of `RequiredCount` quanta —
    /// so an Agent that could not see them would have to guess whether a call can succeed.
    /// The same rule the `animalDoorTargets` projection follows: publish the state the
    /// action's own outcome is measured against.
    ///
    /// A Load chest ALSO publishes the inventory slot that currently holds an item its own
    /// conversion accepts and that carries at least one whole `RequiredCount` quantum — the
    /// `slot` argument `load_building_chest` requires — or omits all three hint fields when the
    /// actor holds nothing that could be loaded. That is the same shape `machineTargets` publishes
    /// for the machine load input (farmhandexecutioncontroller.cs:2193-2203).
    /// </summary>
    private static IReadOnlyList<BridgeBuildingChestTarget> DiscoverBuildingChestTargets(Farmer player)
    {
        GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeBuildingChestTarget>();
        List<BridgeBuildingChestTarget> result = new();
        foreach (Building building in location.buildings)
        {
            if (building is null || building.daysOfConstructionLeft.Value > 0) continue;
            BuildingData? data = building.GetData();
            if (data?.Chests is null) continue;
            foreach (BuildingChest declared in data.Chests)
            {
                if (result.Count >= 16) break;
                if (declared is null || string.IsNullOrWhiteSpace(declared.Id)) continue;
                if (declared.Type is not (BuildingChestType.Load or BuildingChestType.Collect)) continue;
                Chest? chest = building.GetBuildingChest(declared.Id);
                if (chest is null) continue;
                if (!TryFindBuildingChestInteractionTile(building, declared.Id, out int tileX, out int tileY)) continue;
                if (!IsTileWithinChebyshevRadius(player, tileX, tileY, TargetDiscoveryRadius)) continue;
                BridgeBuildingChestTarget target = new(
                    BuildBuildingChestTargetId(location, building, declared.Id, declared.Type, tileX, tileY),
                    location.NameOrUniqueName,
                    tileX,
                    tileY,
                    building.buildingType.Value,
                    declared.Id,
                    DescribeBuildingChestBranch(declared.Type),
                    BuildingChestSlotCount(chest),
                    BuildingChestItemCount(chest));
                if (declared.Type == BuildingChestType.Load && TryFindLoadableInventorySlot(building, chest, out int slot, out string itemId, out int stack))
                    target = target with { LoadInputSlot = slot, LoadInputQualifiedItemId = itemId, LoadInputStack = stack };
                result.Add(target);
            }
            if (result.Count >= 16) break;
        }
        return result;
    }

    /// <summary>
    /// The first inventory slot holding an item this Load chest's conversion accepts and that
    /// carries at least one whole `RequiredCount` quantum — the exact `slot` argument
    /// `load_building_chest` needs — or false when the actor holds nothing loadable right now.
    /// The acceptance test is the native branch's own predicate, so the published hint can never
    /// offer a slot the native branch would refuse as the wrong item.
    /// </summary>
    private static bool TryFindLoadableInventorySlot(Building building, Chest chest, out int slot, out string itemId, out int stack)
    {
        slot = -1;
        itemId = string.Empty;
        stack = 0;
        Farmer player = Game1.player;
        for (int index = 0; index < player.Items.Count; index++)
        {
            if (player.Items[index] is not StardewValley.Object candidate || candidate.Stack <= 0) continue;
            BuildingItemConversion? conversion = building.GetItemConversionForItem(candidate, chest);
            if (conversion is null || conversion.RequiredCount <= 0 || candidate.Stack < conversion.RequiredCount) continue;
            slot = index;
            itemId = candidate.QualifiedItemId;
            stack = candidate.Stack;
            return true;
        }
        return false;
    }

    /// <summary>
    /// The first tile inside the building's own footprint at which the native click reaches
    /// this chest: `BuildingData.GetActionAtTile` names it AND the tile is blocked, which is
    /// exactly the pair `Building.doAction` (:981-983) requires. One rule covers an explicit
    /// `ActionTiles` entry and the `DefaultAction` fallback (BuildingData.cs:282-289), so it
    /// never depends on how a particular building declares the entry, and it needs no human
    /// door.
    /// </summary>
    internal static bool TryFindBuildingChestInteractionTile(Building building, string chestId, out int x, out int y)
    {
        x = 0;
        y = 0;
        BuildingData? data = building.GetData();
        if (data is null) return false;
        for (int relativeY = 0; relativeY < data.Size.Y; relativeY++)
        {
            for (int relativeX = 0; relativeX < data.Size.X; relativeX++)
            {
                string? action = data.GetActionAtTile(relativeX, relativeY);
                if (!NamesBuildingChest(action, chestId)) continue;
                int tileX = building.tileX.Value + relativeX;
                int tileY = building.tileY.Value + relativeY;
                if (!building.occupiesTile(tileX, tileY, applyTilePropertyRadius: true)) continue;
                if (building.isTilePassable(new Vector2(tileX, tileY))) continue;
                x = tileX;
                y = tileY;
                return true;
            }
        }
        return false;
    }

    /// <summary>
    /// Whether one map action string is the native `BuildingChest` action for this chest,
    /// parsed with the game's own space splitter and the same argument position
    /// `GameLocation.performAction` reads (:10130).
    /// </summary>
    private static bool NamesBuildingChest(string? action, string chestId)
    {
        if (string.IsNullOrWhiteSpace(action)) return false;
        string[] parts = ArgUtility.SplitBySpace(action);
        return string.Equals(ArgUtility.Get(parts, 0), "BuildingChest", StringComparison.Ordinal)
            && string.Equals(ArgUtility.Get(parts, 1), chestId, StringComparison.Ordinal);
    }

    /// <summary>
    /// Opaque, stable selector for one building's named chest. The declared type and the
    /// interaction tile are part of the identity (a chest that changed its branch, or is
    /// reached from a different tile now, is a different target) while the chest's CONTENTS
    /// deliberately are not: contents are the postcondition's moving part, and binding them
    /// would turn a legitimate second load into a stale-target refusal.
    /// </summary>
    internal static string BuildBuildingChestTargetId(GameLocation location, Building building, string chestId, BuildingChestType type, int tileX, int tileY)
    {
        string raw = $"{location.NameOrUniqueName}:{building.tileX.Value},{building.tileY.Value}:{building.buildingType.Value}:{chestId}:{DescribeBuildingChestBranch(type)}:{tileX},{tileY}:building_chest";
        return $"building_chest_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static string DescribeBuildingChestBranch(BuildingChestType type) => type switch
    {
        BuildingChestType.Load => "load",
        BuildingChestType.Collect => "collect",
        BuildingChestType.Chest => "chest",
        _ => "unknown",
    };

    /// <summary>
    /// The Object held in one inventory slot, or false when the slot does not exist or holds
    /// something that is not an Object (a Tool has no `ActiveObject`). The slot is selected as the
    /// held one around the native call rather than required to already be held, mirroring
    /// `machine_load`: the native branch reads `who.ActiveObject` and this action supplies it.
    /// </summary>
    private static bool TryGetInventoryObjectInSlot(int slot, [NotNullWhen(true)] out StardewValley.Object? heldObject)
    {
        heldObject = null;
        Farmer player = Game1.player;
        if (slot < 0 || slot >= player.Items.Count || player.Items[slot] is not StardewValley.Object candidate || candidate.Stack <= 0)
            return false;
        heldObject = candidate;
        return true;
    }

    /// <summary>
    /// The chest's own live slot count, mirroring what the native collect branch counts
    /// before it decides between auto-collecting and opening a menu: it counts NON-NULL
    /// slots and stops at the second one (Utility.cs:2047-2065).
    /// </summary>
    private static int BuildingChestSlotCount(Chest chest) =>
        chest.GetItemsForPlayer().Where(item => item is not null).Count();

    /// <summary>The chest's own live item count, across every stack it holds.</summary>
    private static int BuildingChestItemCount(Chest chest) =>
        chest.GetItemsForPlayer().Where(item => item is not null).Sum(item => item.Stack);

    /// <summary>
    /// The native Load branch's own three gates, named by the chest data field whose message
    /// the game posts for each (Building.cs:768-790), so a refusal separates the modes
    /// without a second vocabulary that could disagree with the game's message. The message
    /// text the game actually posted remains the authority; this label says which native
    /// field's gate the observed facts match.
    /// </summary>
    private static string DescribeNativeLoadRefusal(bool itemAccepted, int requiredCount, int heldStack, int chestCapacity)
    {
        if (!itemAccepted) return "InvalidItemMessage";
        if (requiredCount <= 0) return "none";
        if (heldStack > requiredCount && chestCapacity < requiredCount) return "ChestFullMessage";
        if (Math.Min(chestCapacity, heldStack) / requiredCount * requiredCount == 0) return "InvalidCountMessage";
        return "none";
    }
}
