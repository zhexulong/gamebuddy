using System.Globalization;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Tools;
using StardewValley.Characters;

namespace GameBuddy.Stardew;

// Native handler bodies remain action/family-owned. All parts share the one
// ExecutionManager game-thread ledger, receipt store, snapshot, and cancel state.
internal sealed partial class ExecutionManager
{
    public LocalExecutionReceipt RequestLocalLoadCoffeeIntoKeg(string requestId, int slot, int targetX, int targetY, string expectedQualifiedItemId, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (!Context.IsWorldReady || Context.IsMultiplayer || !Game1.IsMasterGame || Game1.server is not null || Game1.player is null || Game1.getAllFarmers().Count() != 1 || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "native_local_player_required", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove || Game1.player.UsingTool || Game1.player.toolPower.Value != 0)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.activeItemPickup is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", null);
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
        if (!Context.IsWorldReady || Context.IsMultiplayer || !Game1.IsMasterGame || Game1.server is not null || Game1.player is null || Game1.getAllFarmers().Count() != 1 || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "native_local_player_required", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove || Game1.player.UsingTool || Game1.player.toolPower.Value != 0)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.activeItemPickup is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", null);
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
        if (!IsAnimalProductTargetInRange(Game1.player, targetX, targetY))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={targetX},{targetY}");

        StardewValley.GameLocation location = Game1.player.currentLocation;
        FarmAnimal? animal = location.animals.Values.FirstOrDefault(candidate => (int)candidate.Tile.X == targetX && (int)candidate.Tile.Y == targetY
            && string.Equals(BuildAnimalProductTargetId(location, slot, candidate, tool), expectedTargetId, StringComparison.Ordinal));
        if (animal is null || animal.currentProduce.Value is null || !animal.isAdult() || !animal.CanGetProduceWithTool(tool))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "animal_product_target_changed", $"target={targetX},{targetY}");
        int produceStack = animal.hasEatenAnimalCracker.Value ? 2 : 1;
        StardewValley.Object produce = ItemRegistry.Create<StardewValley.Object>("(O)" + animal.currentProduce.Value);
        if (!Game1.player.couldInventoryAcceptThisItem(produce.QualifiedItemId, produceStack))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "inventory_full", null);

        int inventoryBefore = CountQualifiedItem(Game1.player, produce.QualifiedItemId);
        int previousSlot = Game1.player.CurrentToolIndex;
        int previousFacingDirection = Game1.player.FacingDirection;
        string toolKind = tool is MilkPail ? "milk_pail" : "shears";
        LocalAnimalProductCollectionSpec specification = new(executionId, requestId, location.NameOrUniqueName, slot, targetX, targetY, expectedTargetId,
            animal.myID.Value, animal.type.Value, produce.QualifiedItemId, toolKind, produceStack, inventoryBefore, previousSlot, this.revision, requestedDeadlineMs);
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
        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", this.active?.ExecutionId ?? this.activeTravel?.ExecutionId ?? this.activePet?.ExecutionId ?? this.activeAnimalProduct?.ExecutionId ?? this.activeItemUse?.ExecutionId);
        if (!Utility.tileWithinRadiusOfPlayer(targetX, targetY, 1, Game1.player))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={targetX},{targetY}");
        if (Game1.player.CurrentItem is not null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "hands_not_empty", null);

        StardewValley.GameLocation location = Game1.player.currentLocation;
        Pet? pet = location.characters.OfType<Pet>().FirstOrDefault(candidate =>
            (int)candidate.Tile.X == targetX && (int)candidate.Tile.Y == targetY
            && string.Equals(BuildPetTargetId(location, targetX, targetY, candidate), expectedTargetId, StringComparison.Ordinal)
            && (!candidate.lastPetDay.TryGetValue(Game1.player.UniqueMultiplayerID, out int lastDay) || lastDay != Game1.Date.TotalDays));
        if (pet is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "pet_target_changed", $"target={targetX},{targetY}");

        int friendshipBefore = pet.friendshipTowardFarmer.Value;
        LocalPettingSpec specification = new(executionId, requestId, location.NameOrUniqueName, targetX, targetY, expectedTargetId, pet.petId.Value.ToString("N"), friendshipBefore, Math.Min(1000, friendshipBefore + 12), Game1.Date.TotalDays, this.revision, requestedDeadlineMs);
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
        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", this.active?.ExecutionId ?? this.activeTravel?.ExecutionId ?? this.activePet?.ExecutionId ?? this.activeAnimalProduct?.ExecutionId ?? this.activeItemUse?.ExecutionId);
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={targetX},{targetY}");

        StardewValley.GameLocation location = Game1.player.currentLocation;
        StardewValley.NPC? npc = location.characters
            .OfType<StardewValley.NPC>()
            .FirstOrDefault(candidate => candidate.IsVillager
                && (int)candidate.Tile.X == targetX
                && (int)candidate.Tile.Y == targetY
                && !string.IsNullOrWhiteSpace(candidate.Name)
                && string.Equals(BuildNpcRelationshipTargetId(location, targetX, targetY, candidate.Name), expectedTargetId, StringComparison.Ordinal));
        if (npc is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "npc_relationship_target_changed", $"target={targetX},{targetY}");
        if (!Game1.player.friendshipData.TryGetValue(npc.Name, out Friendship? friendship))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "friendship_fact_unavailable", $"npc={npc.Name}");

        LocalNpcRelationshipInspectionSpec specification = new(executionId, requestId, location.NameOrUniqueName, targetX, targetY, expectedTargetId, npc.Name, this.revision, requestedDeadlineMs);
        string evidence = $"location={specification.Location};target={expectedTargetId};tile={targetX},{targetY};npc={specification.NpcName};points={friendship.Points};status={friendship.Status};talked_to_today={friendship.TalkedToToday.ToString().ToLowerInvariant()};gifts_today={friendship.GiftsToday};gifts_this_week={friendship.GiftsThisWeek}";
        LocalExecutionReceipt receipt = new(executionId, requestId, ExecutionState.Succeeded, "npc_relationship_inspected", this.revision, evidence);
        this.Remember(receipt);
        this.AddTrace(receipt);
        return receipt;
    }


    /// <summary>One native Axe strike which fells the exact mature health-one tree into its native stump state; drops remain separate pickup targets.</summary>
}
