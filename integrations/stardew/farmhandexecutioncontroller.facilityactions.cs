using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.Tools;
using StardewValley.Objects;

namespace GameBuddy.Stardew;

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
        if (Game1.player.currentLocation is not Farm farm || !TryResolveSilo(farm, targetX, targetY, expectedTargetId, out _))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "silo_target_changed", $"target={targetX},{targetY}");
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
            return this.TryBeginToolApproach(requestId, executionId, "deposit_silo_hay", farm, targetX, targetY, expectedTargetId,
                (arrivalExecutionId, arrivalRequestId) => this.ExecuteDepositSiloHay(arrivalExecutionId, arrivalRequestId, slot, targetX, targetY, expectedTargetId), nowMs, requestedDeadlineMs);
        return this.ExecuteDepositSiloHay(executionId, requestId, slot, targetX, targetY, expectedTargetId);
    }

    private LocalExecutionReceipt ExecuteDepositSiloHay(string executionId, string requestId, int slot, int x, int y, string targetId)
    {
        if (Game1.player.currentLocation is not Farm farm || !TryResolveSilo(farm, x, y, targetId, out StardewValley.Buildings.Building? silo))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "silo_target_changed", $"target={x},{y}");
        if (!TryGetHeldItem(slot, out Item? item) || item is not StardewValley.Object hay || hay.QualifiedItemId != "(O)178" || hay.Stack <= 0)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "hay_not_held_in_requested_slot", $"slot={slot}");
        Vector2 door = silo!.getPointForHumanDoor().ToVector2();
        if (!IsTileWithinChebyshevRadius(Game1.player, (int)door.X, (int)door.Y, 1))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "silo_target_out_of_range", $"target={targetId}");
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

    private static bool TryResolveSilo(Farm farm, int x, int y, string expectedTargetId, out StardewValley.Buildings.Building? silo)
    {
        silo = farm.buildings.FirstOrDefault(candidate => candidate.buildingType.Value == "Silo"
            && candidate.getPointForHumanDoor() == new Point(x, y)
            && string.Equals(BuildSiloTargetId(farm, candidate), expectedTargetId, StringComparison.Ordinal));
        return silo is not null;
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
