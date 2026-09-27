using System.Globalization;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Tools;
using StardewValley.Characters;

namespace GameBuddy.Stardew;

// Native handler bodies remain action/family-owned. All parts share the one
// FarmhandExecutionController game-thread ledger, receipt store, snapshot, and cancel state.
internal sealed partial class ExecutionManager
{
    public LocalExecutionReceipt RequestLocalLoadCoffeeIntoKeg(string requestId, int slot, int targetX, int targetY, string expectedQualifiedItemId, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // Shared mechanical admission (identity → actionability → deadline →
        // body exclusivity), behavior-equivalent to the inline sequence it
        // replaced: identical reasonCodes, identical order. Geometry, target
        // identity and the postcondition stay action-specific.
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.Physical) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={targetX},{targetY}");
        if (expectedQualifiedItemId != "(O)433" || slot < 0 || slot >= Game1.player.Items.Count || Game1.player.Items[slot] is not StardewValley.Object input || input.QualifiedItemId != "(O)433" || input.Stack != 5)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "coffee_beans_not_owned_in_exact_slot", $"slot={slot}");

        GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.objects.TryGetValue(tile, out StardewValley.Object? machine)
            || machine.QualifiedItemId != "(BC)12"
            || machine.GetMachineData() is null
            || machine.heldObject.Value is not null
            || machine.readyForHarvest.Value
            || machine.MinutesUntilReady > 0
            || !string.Equals(BuildMachineTargetId(location, targetX, targetY, machine.QualifiedItemId), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "machine_load_target_changed", $"target={targetX},{targetY}");

        int previousSlot = Game1.player.CurrentToolIndex;
        bool nativeHandled;
        try
        {
            Game1.player.CurrentToolIndex = slot;
            nativeHandled = location.checkAction(new xTile.Dimensions.Location(targetX, targetY), Game1.viewport, Game1.player);
        }
        finally
        {
            Game1.player.CurrentToolIndex = previousSlot;
        }

        bool sourceConsumed = Game1.player.Items[slot] is null;
        bool machineAcceptedInput = machine.lastInputItem.Value?.QualifiedItemId == "(O)433";
        bool machineHasCoffee = machine.heldObject.Value?.QualifiedItemId == "(O)395";
        bool processing = !machine.readyForHarvest.Value && machine.MinutesUntilReady == 120;
        bool succeeded = nativeHandled && sourceConsumed && machineAcceptedInput && machineHasCoffee && processing;
        string evidence = $"location={location.NameOrUniqueName};target={expectedTargetId};tile={targetX},{targetY};machine=(BC)12;slot={slot};input=(O)433;input_stack_before=5;input_stack_after={(Game1.player.Items[slot]?.Stack.ToString(CultureInfo.InvariantCulture) ?? "removed")};last_input={(machine.lastInputItem.Value?.QualifiedItemId ?? "none")};held={(machine.heldObject.Value?.QualifiedItemId ?? "none")};ready_for_harvest={machine.readyForHarvest.Value.ToString().ToLowerInvariant()};minutes_until_ready={machine.MinutesUntilReady};native_check_action={nativeHandled.ToString().ToLowerInvariant()}";
        return this.RememberTerminal(requestId, executionId, succeeded ? ExecutionState.Succeeded : ExecutionState.Uncertain, succeeded ? "machine_coffee_loaded" : "machine_coffee_load_postcondition_unavailable", evidence);
    }

    /// <summary>
    /// Collect the finite Coffee output only when the native machine time
    /// lifecycle has already made it ready. Like loading, this enters through
    /// GameLocation.checkAction; it never calls the downstream object helper
    /// or mutates held output/inventory directly.
    /// </summary>
    public LocalExecutionReceipt RequestLocalCollectCoffeeFromKeg(string requestId, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // Shared mechanical admission (identity → actionability → deadline →
        // body exclusivity), behavior-equivalent to the inline sequence it
        // replaced: identical reasonCodes, identical order. Geometry, target
        // identity and the postcondition stay action-specific.
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.Physical) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={targetX},{targetY}");

        GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.objects.TryGetValue(tile, out StardewValley.Object? machine)
            || machine.QualifiedItemId != "(BC)12"
            || machine.GetMachineData() is null
            || !machine.readyForHarvest.Value
            || machine.MinutesUntilReady != 0
            || machine.heldObject.Value?.QualifiedItemId != "(O)395"
            || machine.lastInputItem.Value?.QualifiedItemId != "(O)433"
            || !string.Equals(BuildMachineTargetId(location, targetX, targetY, machine.QualifiedItemId), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "machine_collect_target_not_ready", $"target={targetX},{targetY}");

        StardewValley.Object output = machine.heldObject.Value;
        if (!Game1.player.couldInventoryAcceptThisItem(output))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "machine_output_inventory_full", $"target={expectedTargetId};output=(O)395");
        int coffeeBefore = Game1.player.Items.OfType<StardewValley.Object>().Where(item => item.QualifiedItemId == "(O)395").Sum(item => item.Stack);
        bool nativeHandled = location.checkAction(new xTile.Dimensions.Location(targetX, targetY), Game1.viewport, Game1.player);

        int coffeeAfter = Game1.player.Items.OfType<StardewValley.Object>().Where(item => item.QualifiedItemId == "(O)395").Sum(item => item.Stack);
        bool succeeded = nativeHandled && machine.heldObject.Value is null && !machine.readyForHarvest.Value && machine.MinutesUntilReady <= 0 && coffeeAfter == coffeeBefore + 1;
        string evidence = $"location={location.NameOrUniqueName};target={expectedTargetId};tile={targetX},{targetY};machine=(BC)12;output=(O)395;input=(O)433;ready_before=true;minutes_until_ready_before=0;inventory_coffee_before={coffeeBefore};inventory_coffee_after={coffeeAfter};held_after={(machine.heldObject.Value?.QualifiedItemId ?? "none")};ready_after={machine.readyForHarvest.Value.ToString().ToLowerInvariant()};native_check_action={nativeHandled.ToString().ToLowerInvariant()}";
        return this.RememberTerminal(requestId, executionId, succeeded ? ExecutionState.Succeeded : ExecutionState.Uncertain, succeeded ? "machine_coffee_collected" : "machine_coffee_collect_postcondition_unavailable", evidence);
    }

    /// <summary>Published read-only machine inspection. It reads only the live machine object and never invokes the interaction menu or mutates machine state.</summary>
    public LocalExecutionReceipt RequestLocalInspectMachine(string requestId, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // Scope-bound actor proof. Authorization precedes the world/location
        // readiness checks: a caller that is not the scope-bound actor is refused
        // for that reason rather than for where it happens to be standing.
        if (!this.TryGetBoundActor(out Farmer? boundActor, out string scopeReason) || boundActor is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, scopeReason, null);

        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", this.active?.ExecutionId ?? this.activeTravel?.ExecutionId ?? this.activeAnimalProduct?.ExecutionId ?? this.activeItemUse?.ExecutionId);
        if (!IsMachineTargetInRange(Game1.player, targetX, targetY))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={targetX},{targetY}");

        StardewValley.GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.objects.TryGetValue(tile, out StardewValley.Object? machine)
            || machine.GetMachineData() is null
            || !string.Equals(BuildMachineTargetId(location, targetX, targetY, machine.QualifiedItemId), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "machine_target_changed", $"target={targetX},{targetY}");

        LocalMachineInspectionSpec specification = new(executionId, requestId, location.NameOrUniqueName, targetX, targetY, expectedTargetId, this.revision, requestedDeadlineMs);
        string? held = machine.heldObject.Value?.QualifiedItemId;
        string? input = machine.lastInputItem.Value?.QualifiedItemId;
        string evidence = $"location={specification.Location};target={expectedTargetId};tile={targetX},{targetY};machine={machine.QualifiedItemId};ready_for_harvest={machine.readyForHarvest.Value.ToString().ToLowerInvariant()};minutes_until_ready={machine.MinutesUntilReady};held={held ?? "none"};last_input={input ?? "none"}";
        LocalExecutionReceipt receipt = new(executionId, requestId, ExecutionState.Succeeded, "machine_inspected", this.revision, evidence);
        this.Remember(receipt);
        this.AddTrace(receipt);
        return receipt;
    }


    /// <summary>Experimental native item consumption. The Farmer owns animation, stat/buff changes, and inventory decrement.</summary>
    public LocalExecutionReceipt RequestLocalUseItem(string requestId, int slot, string expectedQualifiedItemId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // Scope-bound actor proof. Authorization precedes the world/location
        // readiness checks: a caller that is not the scope-bound actor is refused
        // for that reason rather than for where it happens to be standing.
        if (!this.TryGetBoundActor(out Farmer? boundActor, out string scopeReason) || boundActor is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, scopeReason, null);

        if (!Context.IsWorldReady || Game1.player is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove || Game1.player.isEating)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", this.active?.ExecutionId ?? this.activeTravel?.ExecutionId ?? this.activePet?.ExecutionId ?? this.activeAnimalProduct?.ExecutionId ?? this.activeItemUse?.ExecutionId);
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.Items[slot] is not StardewValley.Object food)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_not_owned_in_slot", $"slot={slot}");
        if (!string.Equals(food.QualifiedItemId, expectedQualifiedItemId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_slot_changed", $"slot={slot}");
        bool isDrink = Game1.objectData.TryGetValue(food.ItemId, out var objectData) && objectData.IsDrink;
        if (food.QualifiedItemId == "(O)434" || (!isDrink && food.Edibility == -300))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_not_consumable", $"slot={slot};item={expectedQualifiedItemId}");

        int stackBefore = food.Stack;
        LocalItemUseSpec specification = new(executionId, requestId, slot, expectedQualifiedItemId, stackBefore, food.Edibility, isDrink, Game1.player.Stamina, Game1.player.health, this.revision, requestedDeadlineMs);
        int previousSlot = Game1.player.CurrentToolIndex;
        try
        {
            Game1.player.CurrentToolIndex = slot;
            Game1.player.mostRecentlyGrabbedItem = food;
            Game1.player.eatHeldObject();
        }
        finally
        {
            Game1.player.CurrentToolIndex = previousSlot;
        }

        StardewValley.Object? remaining = slot < Game1.player.Items.Count ? Game1.player.Items[slot] as StardewValley.Object : null;
        bool started = Game1.player.isEating;
        bool consumed = remaining is null || (string.Equals(remaining.QualifiedItemId, expectedQualifiedItemId, StringComparison.Ordinal) && remaining.Stack == stackBefore - 1);
        if (!started)
        {
            ExecutionState state = consumed ? ExecutionState.Uncertain : ExecutionState.Rejected;
            return this.RememberTerminal(requestId, executionId, state, consumed ? "item_use_started_without_animation" : "item_use_not_started", $"slot={slot};started=false;consumed={consumed.ToString().ToLowerInvariant()}");
        }

        this.activeItemUse = specification;
        LocalExecutionReceipt accepted = new(executionId, requestId, ExecutionState.Accepted, "accepted", this.revision,
            $"slot={slot};item={expectedQualifiedItemId};stack_before={stackBefore};edibility={food.Edibility};drink={isDrink.ToString().ToLowerInvariant()}");
        this.Remember(accepted);
        this.AddTrace(accepted);
        return accepted;
    }

    /// <summary>
    /// Experimental native feeding action, strictly limited to placing one owned Hay item into a live empty AnimalHouse Trough.
    /// This deliberately proves placement only: native AnimalHouse day update owns later animal fullness.
    /// </summary>
    public LocalExecutionReceipt RequestLocalFeedAnimal(string requestId, int slot, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;

        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // Scope-bound actor proof. Authorization precedes the world/location
        // readiness checks: a caller that is not the scope-bound actor is refused
        // for that reason rather than for where it happens to be standing.
        if (!this.TryGetBoundActor(out Farmer? boundActor, out string scopeReason) || boundActor is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, scopeReason, null);

        if (!Context.IsWorldReady || Game1.player?.currentLocation is not AnimalHouse location)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "animal_house_not_available", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", this.active?.ExecutionId ?? this.activeTravel?.ExecutionId ?? this.activePet?.ExecutionId ?? this.activeAnimalProduct?.ExecutionId ?? this.activeItemUse?.ExecutionId);
        if (!IsFeedTroughTargetInRange(Game1.player, targetX, targetY))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={targetX},{targetY}");
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.Items[slot] is not StardewValley.Object hay
            || !string.Equals(hay.QualifiedItemId, "(O)178", StringComparison.Ordinal) || hay.Stack < 1)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "hay_not_owned_in_slot", $"slot={slot}");

        Vector2 tile = new(targetX, targetY);
        if (location.doesTileHaveProperty(targetX, targetY, "Trough", "Back") is null || location.objects.ContainsKey(tile)
            || !string.Equals(BuildFeedTroughTargetId(location, slot, targetX, targetY, hay.Stack), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "feed_trough_target_changed", $"target={targetX},{targetY}");

        int hayBefore = CountQualifiedItem(Game1.player, "(O)178");
        int previousSlot = Game1.player.CurrentToolIndex;
        bool nativeHandled;
        try
        {
            Game1.player.CurrentToolIndex = slot;
            nativeHandled = location.checkAction(new xTile.Dimensions.Location(targetX, targetY), Game1.viewport, Game1.player);
        }
        finally
        {
            Game1.player.CurrentToolIndex = previousSlot;
        }
        int hayAfter = CountQualifiedItem(Game1.player, "(O)178");
        bool troughFilled = location.objects.TryGetValue(tile, out StardewValley.Object? placed)
            && string.Equals(placed.QualifiedItemId, "(O)178", StringComparison.Ordinal);
        bool hayConsumed = hayAfter == hayBefore - 1;
        bool succeeded = nativeHandled && troughFilled && hayConsumed;
        LocalExecutionReceipt receipt = new(executionId, requestId, succeeded ? ExecutionState.Succeeded : ExecutionState.Uncertain,
            succeeded ? "hay_placed_in_trough" : "feed_trough_postcondition_unavailable", this.revision,
            $"location={location.NameOrUniqueName};target={expectedTargetId};tile={targetX},{targetY};slot={slot};native_handled={nativeHandled.ToString().ToLowerInvariant()};trough_filled={troughFilled.ToString().ToLowerInvariant()};hay_before={hayBefore};hay_after={hayAfter};hay_consumed={hayConsumed.ToString().ToLowerInvariant()}");
        this.Remember(receipt);
        this.AddTrace(receipt);
        return receipt;
    }

    /// <summary>Experimental native animal-product collection. Only MilkPail/Shears can start their version-locked animation and completion lifecycle.</summary>
    public LocalExecutionReceipt RequestLocalCollectAnimalProduct(string requestId, int slot, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;

        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // Scope-bound actor proof. Authorization precedes the world/location
        // readiness checks: a caller that is not the scope-bound actor is refused
        // for that reason rather than for where it happens to be standing.
        if (!this.TryGetBoundActor(out Farmer? boundActor, out string scopeReason) || boundActor is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, scopeReason, null);

        if (!Context.IsWorldReady || Game1.player?.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", this.active?.ExecutionId ?? this.activeTravel?.ExecutionId ?? this.activePet?.ExecutionId ?? this.activeAnimalProduct?.ExecutionId ?? this.activeItemUse?.ExecutionId);
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.Items[slot] is not Tool tool || tool is not MilkPail and not Shears)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "animal_product_tool_not_owned", $"slot={slot}");
        // Identity-bound admission, same reasoning as RequestLocalPetAnimal: a
        // FarmAnimal wanders inside its building, so matching its live tile to the
        // coordinate captured at snapshot time makes the request a race.
        // BuildAnimalProductTargetId hashes location + myID + slot + tool + produce
        // and takes no coordinate at all, so the coordinate comparison was an
        // extra binding that could only ever reject a legitimate request.
        StardewValley.GameLocation location = Game1.player.currentLocation;
        FarmAnimal? animal = location.animals.Values.FirstOrDefault(candidate =>
            string.Equals(BuildAnimalProductTargetId(location, slot, candidate, tool), expectedTargetId, StringComparison.Ordinal));
        if (animal is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "animal_product_target_gone", $"target={expectedTargetId}");
        // Range against the animal's current tile -- what the interaction needs.
        if (!IsAnimalProductTargetInRange(Game1.player, (int)animal.Tile.X, (int)animal.Tile.Y))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={expectedTargetId};animal={(int)animal.Tile.X},{(int)animal.Tile.Y}");
        if (animal.currentProduce.Value is null || !animal.isAdult() || !animal.CanGetProduceWithTool(tool))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "animal_product_target_changed", $"target={expectedTargetId}");
        int produceStack = animal.hasEatenAnimalCracker.Value ? 2 : 1;
        StardewValley.Object produce = ItemRegistry.Create<StardewValley.Object>("(O)" + animal.currentProduce.Value);
        if (!Game1.player.couldInventoryAcceptThisItem(produce.QualifiedItemId, produceStack))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "inventory_full", null);

        int inventoryBefore = CountQualifiedItem(Game1.player, produce.QualifiedItemId);
        int previousSlot = Game1.player.CurrentToolIndex;
        int previousFacingDirection = Game1.player.FacingDirection;
        string toolKind = tool is MilkPail ? "milk_pail" : "shears";
        float staminaBefore = Game1.player.Stamina;
        LocalAnimalProductCollectionSpec specification = new(executionId, requestId, location.NameOrUniqueName, slot, targetX, targetY, expectedTargetId,
            animal.myID.Value, animal.type.Value, produce.QualifiedItemId, toolKind, produceStack, inventoryBefore, previousSlot, staminaBefore, this.revision, requestedDeadlineMs);
        Game1.player.CurrentToolIndex = slot;
        // Follow the target-version input path, rather than calling Tool.beginUsing
        // directly: the Farmer-owned event schedules performBeginUsingTool, which
        // starts the tool animation and later invokes Farmer.useTool/Tool.DoFunction.
        // MilkPail/Shears select from GetToolLocation, so orient the Farmhand at the
        // already-revalidated exact animal before beginning that native lifecycle.
        Game1.player.FacingDirection = GetCardinalFacingDirectionToTile(Game1.player, targetX, targetY);
        Game1.player.lastClick = new Vector2(targetX * 64f + 32f, targetY * 64f + 32f);
        Game1.player.BeginUsingTool();
        FarmAnimal? boundAnimal = tool switch
        {
            Shears shears => shears.animal,
            MilkPail milkPail => milkPail.animal,
            _ => null,
        };
        Vector2 nativeToolLocation = Game1.player.GetToolLocation();
        if (!Game1.player.UsingTool || boundAnimal is null || boundAnimal.myID.Value != animal.myID.Value)
        {
            Game1.player.CurrentToolIndex = previousSlot;
            Game1.player.FacingDirection = previousFacingDirection;
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "animal_product_native_target_not_bound",
                $"tool={toolKind};expected_animal={animal.myID.Value};bound_animal={boundAnimal?.myID.Value.ToString() ?? "none"};tool_tile={(int)(nativeToolLocation.X / 64f)},{(int)(nativeToolLocation.Y / 64f)}");
        }
        this.activeAnimalProduct = specification;
        LocalExecutionReceipt accepted = new(executionId, requestId, ExecutionState.Accepted, "accepted", this.revision,
            $"location={specification.Location};target={expectedTargetId};animal={animal.myID.Value};bound_animal={boundAnimal.myID.Value};tool={toolKind};tool_tile={(int)(nativeToolLocation.X / 64f)},{(int)(nativeToolLocation.Y / 64f)};produce={produce.QualifiedItemId};produce_stack={produceStack}");
        this.Remember(accepted);
        this.AddTrace(accepted);
        return accepted;
    }

    /// <summary>Experimental native pet interaction. The native Pet.checkAction path owns daily petting and friendship mutation.</summary>
    public LocalExecutionReceipt RequestLocalPetAnimal(string requestId, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // Scope-bound actor proof. Authorization precedes the world/location
        // readiness checks: a caller that is not the scope-bound actor is refused
        // for that reason rather than for where it happens to be standing.
        if (!this.TryGetBoundActor(out Farmer? boundActor, out string scopeReason) || boundActor is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, scopeReason, null);

        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", this.active?.ExecutionId ?? this.activeTravel?.ExecutionId ?? this.activePet?.ExecutionId ?? this.activeAnimalProduct?.ExecutionId ?? this.activeItemUse?.ExecutionId);
        // Admission is identity-bound, not coordinate-bound. A Pet walks on its
        // own -- Data/Pets gives 'Walk' WalkInDirection=true with
        // RandomizeDirection=true, and Pet.RunState re-rolls the facing each tick
        // -- so binding the request to the tile it occupied when the snapshot was
        // taken makes every attempt a race. The caller means "that pet", not
        // "whatever is standing on 26,33". BuildPetTargetId already hashes only
        // location + petId, so the coordinate comparison was a second, redundant
        // binding: redundant, and weaker, because it proved where the pet had been
        // rather than where it is.
        StardewValley.GameLocation location = Game1.player.currentLocation;
        Pet? pet = location.characters.OfType<Pet>().FirstOrDefault(candidate =>
            string.Equals(BuildPetTargetId(location, (int)candidate.Tile.X, (int)candidate.Tile.Y, candidate), expectedTargetId, StringComparison.Ordinal)
            && (!candidate.lastPetDay.TryGetValue(Game1.player.UniqueMultiplayerID, out int lastDay) || lastDay != Game1.Date.TotalDays));
        if (pet is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "pet_target_gone", $"target={expectedTargetId}");
        if (Game1.player.CurrentItem is not null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "hands_not_empty", null);
        // Range is measured against the pet's current tile, which is what
        // interaction actually requires. Checking the requested coordinate would
        // accept a stale position and reject a pet that had walked into reach.
        int petTileX = (int)pet.Tile.X;
        int petTileY = (int)pet.Tile.Y;
        if (!Utility.tileWithinRadiusOfPlayer(petTileX, petTileY, 1, Game1.player))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={expectedTargetId};pet={petTileX},{petTileY}");

        int friendshipBefore = pet.friendshipTowardFarmer.Value;
        LocalPettingSpec specification = new(executionId, requestId, location.NameOrUniqueName, petTileX, petTileY, expectedTargetId, pet.petId.Value.ToString("N"), friendshipBefore, Math.Min(1000, friendshipBefore + 12), Game1.Date.TotalDays, this.revision, requestedDeadlineMs);
        this.activePet = specification;
        bool handled = pet.checkAction(Game1.player, location);
        if (!handled)
        {
            this.activePet = null;
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "pet_action_not_handled", $"target={expectedTargetId}");
        }

        LocalExecutionReceipt accepted = new(executionId, requestId, ExecutionState.Accepted, "accepted", this.revision, $"target={expectedTargetId};pet_day={specification.PetDay};friendship_before={friendshipBefore};expected_friendship_after={specification.ExpectedFriendshipAfter}");
        this.Remember(accepted);
        this.AddTrace(accepted);
        return accepted;
    }

    /// <summary>Experimental read-only NPC relationship inspection. It never invokes NPC interaction or creates missing friendship records.</summary>
    public LocalExecutionReceipt RequestLocalInspectNpcRelationship(string requestId, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // Scope-bound actor proof. Authorization precedes the world/location
        // readiness checks: a caller that is not the scope-bound actor is refused
        // for that reason rather than for where it happens to be standing.
        if (!this.TryGetBoundActor(out Farmer? boundActor, out string scopeReason) || boundActor is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, scopeReason, null);

        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", this.active?.ExecutionId ?? this.activeTravel?.ExecutionId ?? this.activePet?.ExecutionId ?? this.activeAnimalProduct?.ExecutionId ?? this.activeItemUse?.ExecutionId);
        // Identity-bound admission (see BuildNpcRelationshipTargetId). A villager
        // follows a daily schedule, so binding the request to the tile it occupied
        // at snapshot time made every attempt a race.
        StardewValley.GameLocation location = Game1.player.currentLocation;
        StardewValley.NPC? npc = location.characters
            .OfType<StardewValley.NPC>()
            .FirstOrDefault(candidate => candidate.IsVillager
                && !string.IsNullOrWhiteSpace(candidate.Name)
                && string.Equals(BuildNpcRelationshipTargetId(location, candidate.Name), expectedTargetId, StringComparison.Ordinal));
        if (npc is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "npc_relationship_target_gone", $"target={expectedTargetId}");
        // Range against the villager's current tile -- what the inspection needs.
        if (!IsTileWithinChebyshevRadius(Game1.player, (int)npc.Tile.X, (int)npc.Tile.Y, 1))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={expectedTargetId};npc={(int)npc.Tile.X},{(int)npc.Tile.Y}");
        if (!Game1.player.friendshipData.TryGetValue(npc.Name, out Friendship? friendship))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "friendship_fact_unavailable", $"npc={npc.Name}");

        int npcTileX = (int)npc.Tile.X;
        int npcTileY = (int)npc.Tile.Y;
        LocalNpcRelationshipInspectionSpec specification = new(executionId, requestId, location.NameOrUniqueName, npcTileX, npcTileY, expectedTargetId, npc.Name, this.revision, requestedDeadlineMs);
        string evidence = $"location={specification.Location};target={expectedTargetId};tile={npcTileX},{npcTileY};npc={specification.NpcName};points={friendship.Points};status={friendship.Status};talked_to_today={friendship.TalkedToToday.ToString().ToLowerInvariant()};gifts_today={friendship.GiftsToday};gifts_this_week={friendship.GiftsThisWeek}";
        LocalExecutionReceipt receipt = new(executionId, requestId, ExecutionState.Succeeded, "npc_relationship_inspected", this.revision, evidence);
        this.Remember(receipt);
        this.AddTrace(receipt);
        return receipt;
    }


    /// <summary>
    /// Experimental native NPC gift interaction (seam decision (a), recorded in
    /// design/tasks/active/cards/loop-lane-a-gift.md). The Mod reproduces the
    /// tryToReceiveActiveObject gift gates (NPC.cs:1943/2209/2282/2297-2298/
    /// 2300-2310/2313/2315-2322/2323/2327-2329/2331-2336/2337-2341/2358-2364)
    /// and then calls NPC.receiveGift(..., showResponse: false) directly
    /// (NPC.cs:4766; response gated at :4844), so no DialogueBox or
    /// activeClickableMenu is ever mounted. Native-faithful reproductions:
    /// friendshipData dictionary protection (:2327-2329), farmer.completeQuest
    /// ("25") (:2313), and the spouse-jealousy branch (:2346-2356) with its
    /// content-driven SpouseGiftJealousyFriendshipChange and
    /// GameStateQuery.CheckConditions gate. A matching unsatisfied native
    /// ItemDeliveryQuest is delivered first, exactly where the native ingress
    /// runs its quest hook (before any gift handling); only an offer that no
    /// pending delivery quest claims reaches the gift path below.
    ///
    /// Task-delivery seam: NPC.tryToReceiveActiveObject (NPC.cs:1776) runs
    /// `who.NotifyQuests(quest => quest.OnItemOfferedToNpc(this, activeObj,
    /// probe), onlyOneQuest: true)` before its special-item switch (:1788) and
    /// before every gift gate, and NotifyQuests walks the quest log last-to-
    /// first (Farmer.decompiled.cs:8968). Only ItemDeliveryQuest overrides
    /// OnItemOfferedToNpc in the target version, so quest selection here
    /// reproduces the predicate at ItemDeliveryQuest.cs:497 in that order, then
    /// lets the native hook itself make the accept/decline decision through
    /// `probe: true` (:499/:517, side-effect free). The delivery mutations are
    /// the non-probe body (:503/:504/:507-515) minus its two UI-mounting lines:
    /// the NPC dialogue push at :505 and the dialogue-box draw at :506 are
    /// omitted, so the headless body never mounts a modal and never runs
    /// dialogue parsing/content loading.
    /// A pending delivery quest for the offered item therefore preempts the
    /// gift path exactly as it does natively, with `quest_item_delivered`
    /// proving `quest.completed.Value` plus the exact `number.Value`
    /// consumption.
    /// </summary>
    public LocalExecutionReceipt RequestLocalInteractNpcWithItem(string requestId, int slot, int targetX, int targetY, string expectedQualifiedItemId, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        // Scope-bound actor proof. Authorization precedes the world/location
        // readiness checks: a caller that is not the scope-bound actor is refused
        // for that reason rather than for where it happens to be standing.
        if (!this.TryGetBoundActor(out Farmer? boundActor, out string scopeReason) || boundActor is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, scopeReason, null);

        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.activeItemPickup is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", this.active?.ExecutionId ?? this.activeTravel?.ExecutionId ?? this.activePet?.ExecutionId ?? this.activeAnimalProduct?.ExecutionId ?? this.activeItemUse?.ExecutionId);
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.Items[slot] is not StardewValley.Object offered || offered.Stack < 1)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_not_owned_in_slot", $"slot={slot}");
        if (!string.Equals(offered.QualifiedItemId, expectedQualifiedItemId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_slot_changed", $"slot={slot}");

        // Identity-bound admission (see BuildNpcRelationshipTargetId). A villager
        // follows a daily schedule, so a request bound to the tile it occupied at
        // snapshot time would be refused as soon as it walked, even though the
        // caller meant that villager.
        StardewValley.GameLocation location = Game1.player.currentLocation;
        StardewValley.NPC? npc = location.characters
            .OfType<StardewValley.NPC>()
            .FirstOrDefault(candidate => candidate.IsVillager
                && !string.IsNullOrWhiteSpace(candidate.Name)
                && string.Equals(BuildNpcRelationshipTargetId(location, candidate.Name), expectedTargetId, StringComparison.Ordinal));
        if (npc is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "npc_interaction_target_gone", $"target={expectedTargetId}");
        // Range against the villager's current tile -- what the interaction needs.
        if (!IsTileWithinChebyshevRadius(Game1.player, (int)npc.Tile.X, (int)npc.Tile.Y, 1))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={expectedTargetId};npc={(int)npc.Tile.X},{(int)npc.Tile.Y}");

        Farmer player = Game1.player;
        // Mirrors NPC.tryToReceiveActiveObject `if (!probe) { who.Halt();
        // who.faceGeneralDirection(this.getStandingPosition(), 0, opposite:
        // false, useTileCalculations: false); }` (NPC.cs:1725-1728).
        player.Halt();
        player.faceGeneralDirection(npc.getStandingPosition(), 0, opposite: false, useTileCalculations: false);

        Friendship? friendship = player.friendshipData.TryGetValue(npc.Name, out Friendship? existingFriendship) ? existingFriendship : null;
        int pointsBefore = friendship?.Points ?? 0;
        int giftsTodayBefore = friendship?.GiftsToday ?? 0;
        int giftsThisWeekBefore = friendship?.GiftsThisWeek ?? 0;
        bool quest25CompletedBefore = player.questLog.Any(quest => quest.id.Value == "25" && quest.completed.Value);
        int stackBefore = offered.Stack;
        int completedQuestsBefore = player.questLog.Count(quest => quest.completed.Value);

        // Task delivery owns the offer exactly where the native ingress runs its
        // quest hook (NPC.cs:1776), i.e. before the special-item switch and
        // before every gift gate. Selection reproduces
        // `Farmer.NotifyQuests(quest => quest.OnItemOfferedToNpc(this,
        // activeObj, probe), onlyOneQuest: true)` walking the log last-to-first
        // (Farmer.decompiled.cs:8968-8984) and asks the target version's own
        // hook - ItemDeliveryQuest.OnItemOfferedToNpc, the only override in
        // 1.6.15 - whether it claims this offer through its side-effect-free
        // `probe: true` path (ItemDeliveryQuest.cs:499/:517). The hook decides;
        // this body never reimplements its predicate. A quest that matched the
        // villager/item but failed the hook's own stack gate is remembered only
        // so that offer settles as an explicit quantity refusal instead of
        // silently sliding into the gift path.
        StardewValley.Quests.ItemDeliveryQuest? deliveryQuest = null;
        StardewValley.Quests.ItemDeliveryQuest? undersuppliedQuest = null;
        for (int index = player.questLog.Count - 1; index >= 0; index--)
        {
            if (player.questLog[index] is not StardewValley.Quests.ItemDeliveryQuest candidate || candidate.completed.Value)
                continue;
            if (candidate.OnItemOfferedToNpc(npc, offered, probe: true))
            {
                deliveryQuest = candidate;
                break;
            }
            if (npc.IsVillager
                && string.Equals(npc.Name, candidate.target.Value, StringComparison.Ordinal)
                && string.Equals(offered.QualifiedItemId, candidate.ItemId.Value, StringComparison.Ordinal))
                undersuppliedQuest ??= candidate;
        }

        if (deliveryQuest is null && undersuppliedQuest is not null)
        {
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "quest_quantity_mismatch",
                GiftEvidencePrefix(location, expectedTargetId, targetX, targetY, npc, expectedQualifiedItemId, slot, stackBefore, pointsBefore, giftsTodayBefore, giftsThisWeekBefore, quest25CompletedBefore)
                + $";quest_id={undersuppliedQuest.id.Value};quest_target={undersuppliedQuest.target.Value};quest_item={undersuppliedQuest.ItemId.Value};quest_number={undersuppliedQuest.number.Value};quest_required_stack={undersuppliedQuest.number.Value};stack_after={stackBefore};completed_quests_before={completedQuestsBefore};completed_quests_after={completedQuestsBefore};quest_completed_after=false");
        }

        if (deliveryQuest is not null)
        {
            int requiredNumber = deliveryQuest.number.Value;
            int friendshipAmount = deliveryQuest.dailyQuest.Value ? 150 : 255;
            bool questCompletedBefore = deliveryQuest.completed.Value;
            bool deliveryCompleted = false;
            int previousToolIndex = player.CurrentToolIndex;
            try
            {
                // Native non-probe delivery body (ItemDeliveryQuest.cs:503-515)
                // minus its two UI-mounting lines (:505 dialogue push and :506
                // dialogue-box draw), which would mount a modal the headless
                // companion has no one to dismiss; the RNG-gated NPC emote the
                // caller adds for this branch (NPC.cs:1781-1784) is a cosmetic
                // animation with no observable product effect.
                player.CurrentToolIndex = slot;
                player.Items.Reduce(offered, requiredNumber);
                deliveryQuest.reloadDescription();
                player.changeFriendship(friendshipAmount, npc);
                deliveryQuest.questComplete();
                player.completelyStopAnimatingOrDoingAction();
                deliveryCompleted = deliveryQuest.completed.Value;
            }
            catch (Exception)
            {
                return this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "quest_delivery_postcondition_unavailable",
                    GiftEvidencePrefix(location, expectedTargetId, targetX, targetY, npc, expectedQualifiedItemId, slot, stackBefore, pointsBefore, giftsTodayBefore, giftsThisWeekBefore, quest25CompletedBefore)
                    + $";quest_id={deliveryQuest.id.Value};quest_target={deliveryQuest.target.Value};quest_item={deliveryQuest.ItemId.Value};quest_number={requiredNumber};completed_quests_before={completedQuestsBefore}");
            }
            finally
            {
                player.CurrentToolIndex = previousToolIndex;
            }

            int deliveryStackAfter = slot < player.Items.Count
                && player.Items[slot] is StardewValley.Object remainingDelivery
                && string.Equals(remainingDelivery.QualifiedItemId, expectedQualifiedItemId, StringComparison.Ordinal)
                ? remainingDelivery.Stack
                : 0;
            bool consumedRequiredNumber = deliveryStackAfter == stackBefore - requiredNumber;
            int pointsAfter = player.friendshipData.TryGetValue(npc.Name, out Friendship? deliveredFriendship) ? deliveredFriendship.Points : -1;
            int completedQuestsAfter = player.questLog.Count(quest => quest.completed.Value);
            // questComplete keeps a rewarded quest in the log and only flips its
            // completed flag (Quest.decompiled.cs:622-629), so the receipt proves
            // completion from the quest object itself, not from log membership.
            bool questStaysInLog = deliveryQuest.moneyReward.Value > 0
                || (deliveryQuest.rewardDescription.Value is not null && deliveryQuest.rewardDescription.Value.Length > 2);
            // This branch reproduces the native non-probe delivery body without
            // the two lines that mount UI, so a modal that is nonetheless up
            // after the mutation means the delivery did not run through this body
            // and the outcome is not attributable.
            bool noModalMounted = Game1.activeClickableMenu is null && !Game1.dialogueUp;
            string deliveryEvidence = GiftEvidencePrefix(location, expectedTargetId, targetX, targetY, npc, expectedQualifiedItemId, slot, stackBefore, pointsBefore, giftsTodayBefore, giftsThisWeekBefore, quest25CompletedBefore)
                + $";quest_id={deliveryQuest.id.Value};quest_target={deliveryQuest.target.Value};quest_item={deliveryQuest.ItemId.Value};quest_number={requiredNumber};quest_daily={deliveryQuest.dailyQuest.Value.ToString().ToLowerInvariant()};quest_completed_before={questCompletedBefore.ToString().ToLowerInvariant()};quest_completed_after={deliveryCompleted.ToString().ToLowerInvariant()};quest_stays_in_log={questStaysInLog.ToString().ToLowerInvariant()};completed_quests_before={completedQuestsBefore};completed_quests_after={completedQuestsAfter};stack_after={deliveryStackAfter};points_after={pointsAfter};friendship_amount={friendshipAmount};quest_25_completed_after={player.questLog.Any(quest => quest.id.Value == "25" && quest.completed.Value).ToString().ToLowerInvariant()};showed_response=false;dialogue_open_after={Game1.dialogueUp.ToString().ToLowerInvariant()};menu_open_after={(Game1.activeClickableMenu is not null).ToString().ToLowerInvariant()}";

            if (deliveryCompleted && consumedRequiredNumber && noModalMounted)
                return this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "quest_item_delivered", deliveryEvidence);
            return this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "quest_delivery_postcondition_unavailable", deliveryEvidence);
        }

        // Gate 0: proposal items never enter the gift path. Mirrors the native
        // mermaid-pendant case (NPC.cs:2209) and the propose_roommate context tag
        // (NPC.cs:2282); both would mount dialogue/romance flows.
        if (string.Equals(offered.QualifiedItemId, "(O)460", StringComparison.Ordinal)
            || (npc.CanReceiveGifts() && offered.HasContextTag(ItemContextTagManager.SanitizeContextTag("propose_roommate_" + npc.Name))))
        {
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "gift_rejected_proposal_item", GiftEvidencePrefix(location, expectedTargetId, targetX, targetY, npc, expectedQualifiedItemId, slot, stackBefore, pointsBefore, giftsTodayBefore, giftsThisWeekBefore, quest25CompletedBefore));
        }

        // Gates 1-3 (NPC.cs:1943/2297-2298): can-receive, can-be-given, not_giftable.
        if (!npc.CanReceiveGifts())
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "gift_rejected_cannot_receive", GiftEvidencePrefix(location, expectedTargetId, targetX, targetY, npc, expectedQualifiedItemId, slot, stackBefore, pointsBefore, giftsTodayBefore, giftsThisWeekBefore, quest25CompletedBefore));
        if (!offered.canBeGivenAsGift() || ItemContextTagManager.HasBaseTag(offered.QualifiedItemId, "not_giftable"))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "gift_rejected_not_giftable", GiftEvidencePrefix(location, expectedTargetId, targetX, targetY, npc, expectedQualifiedItemId, slot, stackBefore, pointsBefore, giftsTodayBefore, giftsThisWeekBefore, quest25CompletedBefore));

        // Dumped refusal (NPC.cs:2300-2310): native refuses with an emote and
        // never reaches the gift path; the Mod settles the same refusal as a
        // receipt without the emote.
        if (player.activeDialogueEvents.Keys.Any(activeKey => activeKey.Contains("dumped") && npc.Dialogue.ContainsKey(activeKey)))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "gift_rejected_dumped", GiftEvidencePrefix(location, expectedTargetId, targetX, targetY, npc, expectedQualifiedItemId, slot, stackBefore, pointsBefore, giftsTodayBefore, giftsThisWeekBefore, quest25CompletedBefore));

        // Introduction quest (NPC.cs:2313): completed for any giftable offer,
        // before the limit gates -- exactly the native position.
        player.completeQuest("25");
        bool quest25CompletedAfter = player.questLog.Any(quest => quest.id.Value == "25" && quest.completed.Value);

        // Green-rain refusal (NPC.cs:2315-2322): native returns unhandled with a
        // red message; the Mod settles the same refusal without the message.
        if (Game1.IsGreenRainingHere() && Game1.year == 1 && !npc.isMarried())
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "npc_interaction_not_handled", GiftEvidencePrefix(location, expectedTargetId, targetX, targetY, npc, expectedQualifiedItemId, slot, stackBefore, pointsBefore, giftsTodayBefore, giftsThisWeekBefore, quest25CompletedBefore) + $";quest_25_completed_after={quest25CompletedAfter.ToString().ToLowerInvariant()}");

        // Weekly allowance gate (NPC.cs:2323).
        bool limitAllowsGift = (friendship != null && friendship.GiftsThisWeek < 2)
            || player.spouse == npc.Name
            || npc is Child
            || npc.isBirthday()
            || offered.QualifiedItemId == "(O)StardropTea";
        if (!limitAllowsGift)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "gift_rejected_weekly_limit", GiftEvidencePrefix(location, expectedTargetId, targetX, targetY, npc, expectedQualifiedItemId, slot, stackBefore, pointsBefore, giftsTodayBefore, giftsThisWeekBefore, quest25CompletedBefore) + $";quest_25_completed_after={quest25CompletedAfter.ToString().ToLowerInvariant()}");

        // Dictionary protection (NPC.cs:2327-2329) exactly before any friendship
        // mutation: without it receiveGift's `giver.friendshipData[base.Name].
        // GiftsToday++` (NPC.cs:4796) throws KeyNotFoundException when the
        // companion never interacted with this NPC before.
        if (friendship is null)
            friendship = player.friendshipData[npc.Name] = new Friendship();
        if (friendship.IsDivorced())
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "gift_rejected_divorced", GiftEvidencePrefix(location, expectedTargetId, targetX, targetY, npc, expectedQualifiedItemId, slot, stackBefore, pointsBefore, giftsTodayBefore, giftsThisWeekBefore, quest25CompletedBefore) + $";quest_25_completed_after={quest25CompletedAfter.ToString().ToLowerInvariant()}");
        if (friendship.GiftsToday == 1 && offered.QualifiedItemId != "(O)StardropTea")
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "gift_rejected_daily_limit", GiftEvidencePrefix(location, expectedTargetId, targetX, targetY, npc, expectedQualifiedItemId, slot, stackBefore, pointsBefore, giftsTodayBefore, giftsThisWeekBefore, quest25CompletedBefore) + $";quest_25_completed_after={quest25CompletedAfter.ToString().ToLowerInvariant()}");

        // Native accept sequence (NPC.cs:2342-2345), showResponse: false so no
        // dialogue is mounted (NPC.cs:4766 signature, :4844 gate).
        bool updateGiftLimitInfo = offered.QualifiedItemId != "(O)StardropTea";
        bool giftGiven = false;
        bool spouseJealousy = false;
        int spousePointsBefore = -1;
        int spousePointsAfter = -1;
        int previousSlot = player.CurrentToolIndex;
        try
        {
            player.CurrentToolIndex = slot;
            npc.receiveGift(offered, player, updateGiftLimitInfo, 1f, showResponse: false);
            player.reduceActiveItemByOne();
            player.completelyStopAnimatingOrDoingAction();
            npc.faceTowardFarmerForPeriod(4000, 3, faceAway: false, player);
            // Spouse jealousy (NPC.cs:2346-2356), reproduced verbatim: gated by
            // GameStateQuery.CheckConditions and content-driven
            // SpouseGiftJealousyFriendshipChange (no hardcoded value beyond the
            // native `?? -30` fallback); the native branch queues dialogue on the
            // spouse only, so no modal is mounted.
            if (npc.datable.Value
                && player.spouse != null && player.spouse != npc.Name
                && !player.hasCurrentOrPendingRoommate()
                && Utility.isMale(player.spouse) == Utility.isMale(npc.Name)
                && Game1.random.NextDouble() < 0.3 - (double)((float)player.LuckLevel / 100f) - player.DailyLuck
                && !npc.isBirthday()
                && friendship.IsDating())
            {
                StardewValley.NPC? spouse = Game1.getCharacterFromName(player.spouse);
                var spouseData = spouse?.GetData();
                if (spouse is not null && GameStateQuery.CheckConditions(spouseData?.SpouseGiftJealousy, null, player, offered))
                {
                    spousePointsBefore = player.friendshipData.TryGetValue(spouse.Name, out Friendship? spouseFriendshipBefore) ? spouseFriendshipBefore.Points : -1;
                    player.changeFriendship(spouseData?.SpouseGiftJealousyFriendshipChange ?? -30, spouse);
                    spousePointsAfter = player.friendshipData.TryGetValue(spouse.Name, out Friendship? spouseFriendshipAfter) ? spouseFriendshipAfter.Points : -1;
                    spouse.CurrentDialogue.Clear();
                    spouse.CurrentDialogue.Push(spouse.TryGetDialogue("SpouseGiftJealous", npc.displayName, offered.DisplayName) ?? Dialogue.FromTranslation(spouse, "Strings\\StringsFromCSFiles:NPC.cs.3985", npc.displayName));
                    spouseJealousy = true;
                }
            }
            giftGiven = true;
        }
        catch (Exception)
        {
            // Never fabricate success: an exception after a partial native
            // mutation settles as Uncertain so recovery stays receipt-driven
            // (no blind re-execution of an unknown native side effect).
            return this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "gift_postcondition_unavailable", GiftEvidencePrefix(location, expectedTargetId, targetX, targetY, npc, expectedQualifiedItemId, slot, stackBefore, pointsBefore, giftsTodayBefore, giftsThisWeekBefore, quest25CompletedBefore));
        }
        finally
        {
            player.CurrentToolIndex = previousSlot;
        }

        int stackAfter = slot < player.Items.Count && player.Items[slot] is StardewValley.Object remaining && string.Equals(remaining.QualifiedItemId, expectedQualifiedItemId, StringComparison.Ordinal)
            ? remaining.Stack
            : 0;
        bool consumedExactlyOne = stackAfter == stackBefore - 1;
        Friendship friendshipAfter = player.friendshipData.TryGetValue(npc.Name, out Friendship? afterFriendship) ? afterFriendship : friendship;
        bool giftRecorded = friendshipAfter.GiftsToday > giftsTodayBefore || friendshipAfter.GiftsThisWeek > giftsThisWeekBefore;
        bool pointsChanged = friendshipAfter.Points != pointsBefore;
        string evidence = GiftEvidencePrefix(location, expectedTargetId, targetX, targetY, npc, expectedQualifiedItemId, slot, stackBefore, pointsBefore, giftsTodayBefore, giftsThisWeekBefore, quest25CompletedBefore)
            + $";stack_after={stackAfter};points_after={friendshipAfter.Points};gifts_today_after={friendshipAfter.GiftsToday};gifts_this_week_after={friendshipAfter.GiftsThisWeek};quest_25_completed_after={quest25CompletedAfter.ToString().ToLowerInvariant()};update_gift_limit={updateGiftLimitInfo.ToString().ToLowerInvariant()};showed_response=false;gift_recorded={giftRecorded.ToString().ToLowerInvariant()};points_changed={pointsChanged.ToString().ToLowerInvariant()};spouse_jealousy={spouseJealousy.ToString().ToLowerInvariant()};spouse_points_before={spousePointsBefore};spouse_points_after={spousePointsAfter};menu_open_after={(Game1.activeClickableMenu is not null).ToString().ToLowerInvariant()};dialogue_open_after={Game1.dialogueUp.ToString().ToLowerInvariant()}";

        if (giftGiven && consumedExactlyOne && (giftRecorded || pointsChanged))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "gift_given", evidence);
        return this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "gift_postcondition_unavailable", evidence);
    }

    private static string GiftEvidencePrefix(StardewValley.GameLocation location, string expectedTargetId, int targetX, int targetY, StardewValley.NPC npc, string expectedQualifiedItemId, int slot, int stackBefore, int pointsBefore, int giftsTodayBefore, int giftsThisWeekBefore, bool quest25CompletedBefore)
        => $"location={location.NameOrUniqueName};target={expectedTargetId};tile={targetX},{targetY};npc={npc.Name};item={expectedQualifiedItemId};slot={slot};stack_before={stackBefore};points_before={pointsBefore};gifts_today_before={giftsTodayBefore};gifts_this_week_before={giftsThisWeekBefore};quest_25_completed_before={quest25CompletedBefore.ToString().ToLowerInvariant()}";

    /// <summary>One native Axe strike which fells the exact mature health-one tree into its native stump state; drops remain separate pickup targets.</summary>
}
