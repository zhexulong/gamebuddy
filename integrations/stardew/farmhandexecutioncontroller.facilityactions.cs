using Microsoft.Xna.Framework;
using GameBuddy.Stardew.Core;
using StardewValley;
using StardewValley.Buildings;
using StardewValley.Tools;
using StardewValley.Objects;

namespace GameBuddy.Stardew;

// WHERE A BUILDING MAY BE TOUCHED FROM.
//
// The engine answers this in three shapes, and the facility family used to assume all three were the same
// point (`getPointForHumanDoor()`). They are not:
//
//   * a human door is `tileX + humanDoor.X, tileY + humanDoor.Y`, and `humanDoor` is deserialised from the
//     building's DATA (`Building.cs:502-503`);
//   * a building whose data declares no human door keeps the default `NetPoint`. Measured against this
//     installation's own `Data/Buildings`: the Silo, Fish Pond, Well, Mill, Stable, Shipping Bin, Pet Bowl,
//     Junimo Hut and all four obelisks declare `HumanDoor = (-1,-1)`; coop/barn/shed/cabin declare a real
//     offset (1,2 / 1,3 / 3,2 / 2,1) and the farmhouse (5,2).
//
// So `getPointForHumanDoor()` on a Silo is `(tileX - 1, tileY - 1)` - one tile DIAGONALLY outside the
// building, not a door. A reach test against that point admits only an actor in the silo's north-west
// quadrant and refuses a companion at its south face as "out of range", naming the distance instead of the
// missing door. `BuildingContact` (Core) makes the three outcomes explicit; the projection below is the one
// place that reads the engine to choose between them.

internal sealed partial class ExecutionManager
{
    public LocalExecutionReceipt RequestLocalClearCask(string requestId, int slot, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.Physical) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;
        if (!TryGetEquippedCaskTool(slot, out _))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "tool_not_equipped_in_requested_slot", $"slot={slot}");
        GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.objects.TryGetValue(tile, out StardewValley.Object? probeObject)
            || probeObject is not StardewValley.Objects.Cask probeCask
            || !string.Equals(BuildCaskTargetId(location, targetX, targetY, probeCask), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "cask_target_changed", $"target={targetX},{targetY}");
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
            return this.TryBeginToolApproach(requestId, executionId, "clear_cask", location, targetX, targetY, expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteClearCask(arrivalExecutionId, arrivalRequestId, slot, targetX, targetY, expectedTargetId), nowMs, requestedDeadlineMs);
        return this.ExecuteClearCask(executionId, requestId, slot, targetX, targetY, expectedTargetId);
    }

    private LocalExecutionReceipt ExecuteClearCask(string executionId, string requestId, int slot, int targetX, int targetY, string expectedTargetId)
    {
        if (!TryGetEquippedCaskTool(slot, out Tool? tool))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "tool_not_equipped_in_requested_slot", $"slot={slot}");
        GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.objects.TryGetValue(tile, out StardewValley.Object? targetObject)
            || targetObject is not StardewValley.Objects.Cask cask
            || !string.Equals(BuildCaskTargetId(location, targetX, targetY, cask), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "cask_target_changed", $"target={targetX},{targetY}");
        bool hadHeldObject = cask.heldObject.Value is not null;
        string? heldQualifiedItemId = cask.heldObject.Value?.QualifiedItemId;
        bool removed = cask.performToolAction(tool);
        if (removed) location.objects.Remove(tile);
        bool postcondition = removed
            ? !location.objects.ContainsKey(tile)
            : location.objects.TryGetValue(tile, out StardewValley.Object? remaining) && ReferenceEquals(remaining, cask) && cask.heldObject.Value is null;
        string evidence = $"target={expectedTargetId};tool={DescribeTool(tool) ?? "tool"};had_held_object={hadHeldObject.ToString().ToLowerInvariant()};held_qualified_item_id={heldQualifiedItemId ?? "none"};removed={removed.ToString().ToLowerInvariant()};postcondition={postcondition.ToString().ToLowerInvariant()}";
        return postcondition
            ? this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "cask_cleared", evidence)
            : this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "cask_clear_postcondition_unavailable", evidence);
    }

    public LocalExecutionReceipt RequestLocalDressMannequin(string requestId, int slot, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.Physical) is LocalExecutionReceipt rejection) return rejection;
        if (!TryGetHeldItem(slot, out Item? item) || item is not (Hat or Clothing or Boots))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "clothing_not_held_in_requested_slot", $"slot={slot}");
        GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.objects.TryGetValue(tile, out StardewValley.Object? value) || value is not StardewValley.Objects.Mannequin mannequin
            || !string.Equals(BuildMannequinTargetId(location, targetX, targetY), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "mannequin_target_changed", $"target={targetX},{targetY}");
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
            return this.TryBeginToolApproach(requestId, executionId, "dress_mannequin", location, targetX, targetY, expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteDressMannequin(arrivalExecutionId, arrivalRequestId, slot, targetX, targetY, expectedTargetId), nowMs, requestedDeadlineMs);
        return this.ExecuteDressMannequin(executionId, requestId, slot, targetX, targetY, expectedTargetId);
    }

    private LocalExecutionReceipt ExecuteDressMannequin(string executionId, string requestId, int slot, int x, int y, string targetId)
    {
        if (!TryGetHeldItem(slot, out Item? item) || item is not (Hat or Clothing or Boots))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "clothing_not_held_in_requested_slot", $"slot={slot}");
        GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(x, y);
        if (!location.objects.TryGetValue(tile, out StardewValley.Object? value) || value is not StardewValley.Objects.Mannequin mannequin
            || !string.Equals(BuildMannequinTargetId(location, x, y), targetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "mannequin_target_changed", $"target={x},{y}");
        string qualifiedItemId = item!.QualifiedItemId;
        int stackBefore = item.Stack;
        bool accepted = mannequin.performObjectDropInAction(item, false, Game1.player);
        if (accepted) ConsumeFromSlot(slot, item, 1);
        bool stored = item switch
        {
            Hat => mannequin.hat.Value?.QualifiedItemId == qualifiedItemId,
            Clothing clothing when clothing.clothesType.Value == Clothing.ClothesType.SHIRT => mannequin.shirt.Value?.QualifiedItemId == qualifiedItemId,
            Clothing => mannequin.pants.Value?.QualifiedItemId == qualifiedItemId,
            Boots => mannequin.boots.Value?.QualifiedItemId == qualifiedItemId,
            _ => false,
        };
        bool consumed = accepted && (Game1.player.Items[slot] is null || Game1.player.Items[slot]!.QualifiedItemId != qualifiedItemId || Game1.player.Items[slot]!.Stack == stackBefore - 1);
        return accepted && stored && consumed
            ? this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "mannequin_dressed", $"target={targetId};slot={slot};item={item.QualifiedItemId};stored=true")
            : this.RememberTerminal(requestId, executionId, accepted ? ExecutionState.Uncertain : ExecutionState.Rejected, accepted ? "mannequin_postcondition_unavailable" : "mannequin_rejected_item", $"target={targetId};slot={slot};stored={stored};consumed={consumed}");
    }

    public LocalExecutionReceipt RequestLocalSetSignDisplay(string requestId, int slot, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.Physical) is LocalExecutionReceipt rejection) return rejection;
        if (!TryGetHeldItem(slot, out _)) return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_not_held_in_requested_slot", $"slot={slot}");
        GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.objects.TryGetValue(tile, out StardewValley.Object? value) || value is not StardewValley.Objects.Sign sign
            || !string.Equals(BuildSignTargetId(location, targetX, targetY, sign), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "sign_target_changed", $"target={targetX},{targetY}");
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
            return this.TryBeginToolApproach(requestId, executionId, "set_sign_display", location, targetX, targetY, expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteSetSignDisplay(arrivalExecutionId, arrivalRequestId, slot, targetX, targetY, expectedTargetId), nowMs, requestedDeadlineMs);
        return this.ExecuteSetSignDisplay(executionId, requestId, slot, targetX, targetY, expectedTargetId);
    }

    private LocalExecutionReceipt ExecuteSetSignDisplay(string executionId, string requestId, int slot, int x, int y, string targetId)
    {
        if (!TryGetHeldItem(slot, out Item? item)) return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_not_held_in_requested_slot", $"slot={slot}");
        GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(x, y);
        if (!location.objects.TryGetValue(tile, out StardewValley.Object? value) || value is not StardewValley.Objects.Sign sign
            || !string.Equals(BuildSignTargetId(location, x, y, sign), targetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "sign_target_changed", $"target={x},{y}");
        string qualifiedItemId = item!.QualifiedItemId;
        bool handled = sign.checkForAction(Game1.player, justCheckingForActivity: false);
        bool displayed = handled && sign.displayItem.Value?.QualifiedItemId == qualifiedItemId;
        return displayed
            ? this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "sign_display_set", $"target={targetId};slot={slot};item={qualifiedItemId}")
            : this.RememberTerminal(requestId, executionId, handled ? ExecutionState.Uncertain : ExecutionState.Rejected, handled ? "sign_display_postcondition_unavailable" : "sign_action_not_handled", $"target={targetId};slot={slot}");
    }

    public LocalExecutionReceipt RequestLocalDepositSiloHay(string requestId, int slot, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.Physical) is LocalExecutionReceipt rejection) return rejection;
        if (!TryGetHeldItem(slot, out Item? item) || item is not StardewValley.Object hay || hay.QualifiedItemId != "(O)178" || hay.Stack <= 0)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "hay_not_held_in_requested_slot", $"slot={slot}");
        if (Game1.player.currentLocation is not Farm farm || !TryResolveSilo(farm, targetX, targetY, expectedTargetId, out Building? silo))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "silo_target_changed", $"target={targetX},{targetY}");
        if (!IsWithinBuildingContact(silo!, Game1.player))
            return this.TryBeginBuildingApproach(requestId, executionId, "deposit_silo_hay", farm, silo!, expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteDepositSiloHay(arrivalExecutionId, arrivalRequestId, slot, targetX, targetY, expectedTargetId), nowMs, requestedDeadlineMs);
        return this.ExecuteDepositSiloHay(executionId, requestId, slot, targetX, targetY, expectedTargetId);
    }

    private LocalExecutionReceipt ExecuteDepositSiloHay(string executionId, string requestId, int slot, int x, int y, string targetId)
    {
        if (Game1.player.currentLocation is not Farm farm || !TryResolveSilo(farm, x, y, targetId, out Building? silo))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "silo_target_changed", $"target={x},{y}");
        if (!TryGetHeldItem(slot, out Item? item) || item is not StardewValley.Object hay || hay.QualifiedItemId != "(O)178" || hay.Stack <= 0)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "hay_not_held_in_requested_slot", $"slot={slot}");
        if (!IsWithinBuildingContact(silo!, Game1.player))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "silo_target_out_of_range",
                $"target={targetId};tile={x},{y};actor_tile={(int)Game1.player.Tile.X},{(int)Game1.player.Tile.Y};contact={DescribeBuildingContact(silo!)}");
        int stackBefore = hay.Stack;
        int hayBefore = farm.piecesOfHay.Value;
        int remaining = farm.tryToAddHay(stackBefore);
        int stored = stackBefore - remaining;
        if (stored > 0) ConsumeFromSlot(slot, hay, stored);
        int hayAfter = farm.piecesOfHay.Value;
        bool postcondition = stored > 0 && hayAfter == hayBefore + stored && (Game1.player.Items[slot] is null || Game1.player.Items[slot]!.Stack == stackBefore - stored);
        return postcondition
            ? this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "silo_hay_deposited", $"target={targetId};slot={slot};stored={stored};hay_before={hayBefore};hay_after={hayAfter}")
            : this.RememberTerminal(requestId, executionId, stored > 0 ? ExecutionState.Uncertain : ExecutionState.Rejected, stored > 0 ? "silo_deposit_postcondition_unavailable" : "silo_full", $"target={targetId};slot={slot};stored={stored};hay_before={hayBefore};hay_after={hayAfter}");
    }

    public LocalExecutionReceipt RequestLocalToggleToolLight(string requestId, int slot, int x, int y, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.Physical) is LocalExecutionReceipt rejection) return rejection;
        if (!IsEquippedLantern(slot, out StardewValley.Tools.Lantern? lantern))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "lantern_not_equipped_in_requested_slot", $"slot={slot}");
        bool wasOn = lantern!.on;
        lantern.DoFunction(Game1.player.currentLocation, x, y, 0, Game1.player);
        bool toggled = lantern.on != wasOn;
        return toggled
            ? this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "tool_light_toggled", $"slot={slot};was_on={wasOn.ToString().ToLowerInvariant()};is_on={lantern.on.ToString().ToLowerInvariant()}")
            : this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "tool_light_postcondition_unavailable", $"slot={slot};was_on={wasOn.ToString().ToLowerInvariant()}");
    }

    private static bool TryGetEquippedCaskTool(int slot, out Tool? tool)
    {
        tool = null;
        Farmer player = Game1.player;
        if (slot < 0 || slot >= player.Items.Count || player.CurrentToolIndex != slot
            || player.Items[slot] is not Tool candidate || candidate is not (Axe or Pickaxe or Hoe)
            || !candidate.isHeavyHitter() || !ReferenceEquals(player.CurrentTool, candidate)) return false;
        tool = candidate;
        return true;
    }

    private static bool TryGetHeldItem(int slot, out Item? item)
    {
        item = null;
        Farmer player = Game1.player;
        if (slot < 0 || slot >= player.Items.Count || player.CurrentToolIndex != slot || player.Items[slot] is not Item candidate
            || !ReferenceEquals(player.CurrentItem, candidate)) return false;
        item = candidate;
        return true;
    }

    private static void ConsumeFromSlot(int slot, Item item, int count)
    {
        if (count <= 0) return;
        item.Stack -= count;
        if (item.Stack <= 0 && slot >= 0 && slot < Game1.player.Items.Count && ReferenceEquals(Game1.player.Items[slot], item))
            Game1.player.Items[slot] = null;
    }

    /// <summary>
    /// Begins the walk to a building the actor is not yet in contact with, for any facility action that
    /// interacts with the building itself rather than with a single named tile.
    ///
    /// The multi-tile approach form takes the contact tiles, so a door-less building is reached from ANY face
    /// and the footprint tile that answered is the one the arrival is re-checked against. Handing it the
    /// published <c>x,y</c> instead would walk the actor to the collapsed <c>(-1,-1)</c> door point - a tile
    /// outside the building - and then measure arrival against the same wrong tile.
    /// </summary>
    private LocalExecutionReceipt TryBeginBuildingApproach(
        string requestId,
        string executionId,
        string actionId,
        GameLocation location,
        Building building,
        string expectedTargetId,
        Func<string, string, LocalExecutionReceipt> onArrival,
        long nowMs,
        long requestedDeadlineMs)
    {
        (int X, int Y)[] contactTiles = BuildingApproachTargets(building);
        if (contactTiles.Length == 0)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "building_unreachable",
                $"building_type={building.buildingType.Value};tile={building.tileX.Value},{building.tileY.Value};footprint=empty");

        return this.TryBeginToolApproach(
            requestId,
            executionId,
            actionId,
            location,
            contactTiles[0],
            contactTiles,
            expectedTargetId,
            onArrival,
            nowMs,
            requestedDeadlineMs);
    }

    /// <summary>
    /// The building's contact shape as receipt evidence: which outcome was chosen and the tiles it covers, so
    /// an "out of range" refusal names the relationship that was tested instead of only a distance.
    /// </summary>
    internal static string DescribeBuildingContact(Building building)
    {
        BuildingContact contact = BuildingContactOf(building);
        return contact.Kind switch
        {
            BuildingContactKind.HumanDoor => $"human_door={contact.HumanDoor!.Value.X},{contact.HumanDoor.Value.Y}",
            BuildingContactKind.Ring => $"ring={contact.Footprint.X},{contact.Footprint.Y},{contact.Footprint.Width},{contact.Footprint.Height}",
            _ => "unreachable",
        };
    }

    private static bool TryResolveSilo(Farm farm, int x, int y, string expectedTargetId, out Building? silo)
    {
        silo = farm.buildings.FirstOrDefault(candidate => candidate.buildingType.Value == "Silo"
            && candidate.getPointForHumanDoor() == new Point(x, y)
            && string.Equals(BuildSiloTargetId(farm, candidate), expectedTargetId, StringComparison.Ordinal));
        return silo is not null;
    }

    /// <summary>
    /// Projects a live building into the engine-free <see cref="BuildingContact"/> the Core predicate takes,
    /// so the Mod and Core cannot disagree about where a building may be touched from. See the file header
    /// for the three engine shapes this collapses into three explicit outcomes.
    /// </summary>
    internal static BuildingContact BuildingContactOf(Building building)
    {
        var footprint = new FootprintRect(
            building.tileX.Value,
            building.tileY.Value,
            building.tilesWide.Value,
            building.tilesHigh.Value);
        if (footprint.IsEmpty) return BuildingContact.Unreachable();

        Point declared = building.GetData()?.HumanDoor ?? new Point(-1, -1);
        return declared.X >= 0 && declared.Y >= 0
            ? BuildingContact.WithHumanDoor(new TilePoint(building.tileX.Value + declared.X, building.tileY.Value + declared.Y), footprint)
            : BuildingContact.WithoutHumanDoor(footprint);
    }

    /// <summary>
    /// Whether an actor may interact with the building right now, using whichever relationship the building
    /// actually has: a door is touched from its own or an adjacent tile, a door-less building from the ring
    /// around its footprint. One rule for every door-less building, so a silo and a fish pond cannot drift
    /// into two different answers.
    /// </summary>
    internal static bool IsWithinBuildingContact(Building building, Farmer actor) =>
        BuildingContactOf(building).IsWithinContact(new TilePoint((int)actor.Tile.X, (int)actor.Tile.Y));

    /// <summary>
    /// The tiles a walk selector should treat as the target when the actor has to reach the building: the
    /// door tile when there is one, the occupied footprint when there is not (the tiles worth standing beside
    /// are that footprint's neighbours). Empty means refuse by name - there is nothing to stand beside.
    /// </summary>
    internal static (int X, int Y)[] BuildingApproachTargets(Building building)
    {
        System.Collections.Generic.IReadOnlyList<TilePoint> tiles = BuildingContactOf(building).ContactTiles();
        (int X, int Y)[] result = new (int X, int Y)[tiles.Count];
        for (int index = 0; index < tiles.Count; index += 1) result[index] = (tiles[index].X, tiles[index].Y);
        return result;
    }

    private static bool IsEquippedLantern(int slot, out StardewValley.Tools.Lantern? lantern)
    {
        lantern = null;
        Farmer player = Game1.player;
        if (slot < 0 || slot >= player.Items.Count || player.CurrentToolIndex != slot
            || player.Items[slot] is not StardewValley.Tools.Lantern candidate || !ReferenceEquals(player.CurrentTool, candidate)) return false;
        lantern = candidate;
        return true;
    }
}
