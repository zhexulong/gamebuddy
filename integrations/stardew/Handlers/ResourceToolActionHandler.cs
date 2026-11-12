using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew.Handlers;

/// <summary>
/// The resource/tool action family: one row per action, naming the <see cref="ExecutionManager"/> seam that owns it and
/// handing that seam the request it executes.
///
/// A row is all this family adds to an action. The pipeline behind the seam - admission, the precondition reads, the
/// native call, the postcondition and the receipt that carries it - belongs to ExecutionManager, where each action's
/// `RequestLocal*` method owns it; nothing here reads the world, decides an outcome, or builds a receipt, except the one
/// refusal for an id this family does not own.
///
/// THE ROW IS SPELLED FOR THREE READERS, so its form is not free. Two of them read this file as TEXT:
/// `action-source-projection-producer.mjs` reads the quoted arm labels as the family's declaration
/// (`nativeOwnership.ResourceTools` in the pinned projection), and `handlerDispatch` in
/// `stardew-action-inventory-reconciliation.mjs` reads `this.executions.Method(` at the head of an arm to map an action to
/// the request method that owns its postcondition (the population of the postcondition-delta gate). Those two are a
/// FINDING and not a virtue - a reader that parses source text reds on a rename while the product is fine, which is the
/// defect class this repository has been deleting - and the durable reading is the third one,
/// `ActionDefinitionRoutingParityTests`, which reads the action ids out of this method's IL against
/// `FarmhandActionCatalog`. Until the two text readers are moved onto that footing they are honoured here: an arm is a
/// switch arm naming `this.executions` and never a dictionary entry, because the bracketed-key form says the same thing
/// in a spelling all three readers stop seeing. This paragraph is what makes them findable for their own unit.
/// </summary>
internal sealed class ResourceToolActionHandler : IFarmhandActionHandler
{
    private readonly ExecutionManager executions;

    public ResourceToolActionHandler(ExecutionManager executions)
    {
        this.executions = executions ?? throw new ArgumentNullException(nameof(executions));
    }

    public LocalExecutionReceipt Execute(BridgeExecutionRequest request, IExecutionLedger ledger)
    {
        ResourceToolCall call = new(request);
        return request.Action switch
        {
            "equip_tool" => this.executions.RequestLocalEquipTool(call.RequestId, call.Tool, call.DeadlineMs),
            "clear_debris" => this.executions.RequestLocalClearDebris(call.RequestId, call.Slot, call.X, call.Y, call.TargetId, call.DeadlineMs),
            "break_resource_clump" => this.executions.RequestLocalBreakResourceClump(call.RequestId, call.X, call.Y, call.TargetId, call.DeadlineMs),
            "chop_tree" => this.executions.RequestLocalChopTreeSource(call.RequestId, call.Slot, call.X, call.Y, call.TargetId, call.DeadlineMs),
            "chop_stump" => this.executions.RequestLocalChopStump(call.RequestId, call.Slot, call.X, call.Y, call.TargetId, call.DeadlineMs),
            "cut_weeds" => this.executions.RequestLocalCutWeeds(call.RequestId, call.Slot, call.X, call.Y, call.TargetId, call.DeadlineMs),
            "cut_grass" => this.executions.RequestLocalCutGrass(call.RequestId, call.Slot, call.X, call.Y, call.TargetId, call.DeadlineMs),
            "sweep_scythe" => this.executions.RequestLocalSweepScythe(call.RequestId, call.X, call.Y, call.DeadlineMs),
            "toggle_fence_gate" => this.executions.RequestLocalToggleFenceGate(call.RequestId, call.X, call.Y, call.TargetId, call.DeadlineMs),
            "clear_cask" => this.executions.RequestLocalClearCask(call.RequestId, call.Slot, call.X, call.Y, call.TargetId, call.DeadlineMs),
            "dress_mannequin" => this.executions.RequestLocalDressMannequin(call.RequestId, call.Slot, call.X, call.Y, call.TargetId, call.DeadlineMs),
            "set_sign_display" => this.executions.RequestLocalSetSignDisplay(call.RequestId, call.Slot, call.X, call.Y, call.TargetId, call.DeadlineMs),
            "deposit_silo_hay" => this.executions.RequestLocalDepositSiloHay(call.RequestId, call.Slot, call.X, call.Y, call.TargetId, call.DeadlineMs),
            "withdraw_silo_hay" => this.executions.RequestLocalWithdrawSiloHay(call.RequestId, call.X, call.Y, call.TargetId, call.DeadlineMs),
            // The one row that reads the request directly: this seam is handed the tile WITHOUT a default, so the row
            // keeps a missing tile a missing tile instead of letting ResourceToolCall turn it into tile 0.
            "clear_fish_pond" => this.executions.RequestLocalClearFishPond(call.RequestId, (int)request.Args.X!, (int)request.Args.Y!, request.Args.ExpectedTargetId!, call.DeadlineMs),
            "toggle_animal_door" => this.executions.RequestLocalToggleAnimalDoor(call.RequestId, call.X, call.Y, call.TargetId, call.DeadlineMs),
            "build_farm_building" => this.executions.RequestLocalBuildFarmBuilding(call.RequestId, call.BuildingType, call.X, call.Y, call.TargetId, call.DeadlineMs),
            "break_container" => this.executions.RequestLocalBreakContainerSource(call.RequestId, call.Slot, call.X, call.Y, call.TargetId, call.DeadlineMs),
            "remove_placed_item" => this.executions.RequestLocalRemovePlacedItem(call.RequestId, call.Slot, call.X, call.Y, call.TargetId, call.DeadlineMs),
            "move_placed_furniture" => this.executions.RequestLocalMovePlacedFurniture(call.RequestId, call.X, call.Y, call.TargetId, call.DeadlineMs),
            "rotate_furniture" => this.executions.RequestLocalRotateFurniture(call.RequestId, call.X, call.Y, call.TargetId, call.DeadlineMs),
            "remove_fence" => this.executions.RequestLocalRemoveFence(call.RequestId, call.Slot, call.X, call.Y, call.TargetId, call.DeadlineMs),
            "put_item_in_fish_tank" => this.executions.RequestLocalPutItemInFishTank(call.RequestId, call.Slot, call.X, call.Y, call.QualifiedItemId, call.TargetId, call.DeadlineMs),
            "place_item_on_pedestal" => this.executions.RequestLocalPlaceItemOnPedestal(call.RequestId, call.Slot, call.X, call.Y, call.QualifiedItemId, call.TargetId, call.DeadlineMs),
            "place_owned_object" => this.executions.RequestLocalPlaceOwnedObject(call.RequestId, call.Slot, call.X, call.Y, call.QualifiedItemId, call.TargetId, call.DeadlineMs),
            "color_placed_object" => this.executions.RequestLocalColorPlacedObject(call.RequestId, call.X, call.Y, call.TargetId, call.ColorSelection, call.DeadlineMs),
            "pan_ore" => this.executions.RequestLocalPanOre(call.RequestId, call.Slot, call.X, call.Y, call.DeadlineMs),
            "claim_mail_attachment" => this.executions.RequestLocalClaimMailAttachment(call.RequestId, call.X, call.Y, call.TargetId, call.DeadlineMs),
            "load_building_chest" => this.executions.RequestLocalLoadBuildingChest(call.RequestId, call.X, call.Y, call.Slot, call.TargetId, call.DeadlineMs),
            "collect_building_chest_output" => this.executions.RequestLocalCollectBuildingChestOutput(call.RequestId, call.X, call.Y, call.TargetId, call.DeadlineMs),
            "toggle_tool_light" => this.executions.RequestLocalToggleToolLight(call.RequestId, call.Slot, call.X, call.Y, call.DeadlineMs),
            "equip_wearable" => this.executions.RequestLocalEquipWearable(call.RequestId, call.Slot, call.QualifiedItemId, call.TargetId, call.DeadlineMs),
            "unequip_wearable" => this.executions.RequestLocalUnequipWearable(call.RequestId, call.Slot, call.TargetId, call.DeadlineMs),
            "break_rock" => this.executions.RequestLocalBreakRockSource(call.RequestId, call.Slot, call.X, call.Y, call.TargetId, call.DeadlineMs),
            "dig_artifact_spot" => this.executions.RequestLocalDigArtifactSpot(call.RequestId, call.Slot, call.X, call.Y, call.TargetId, call.DeadlineMs),
            "refill_watering_can" => this.executions.RequestLocalRefillWateringCan(call.RequestId, call.Slot, call.X, call.Y, call.TargetId, call.DeadlineMs),
            "fish_here" => this.executions.RequestLocalFishHere(call.RequestId, call.X, call.Y, call.TargetId, call.DeadlineMs),
            "place_wood_fence" => this.executions.RequestLocalPlaceWoodFence(call.RequestId, call.Slot, call.X, call.Y, call.QualifiedItemId, call.TargetId, call.DeadlineMs),
            "place_crab_pot" => this.executions.RequestLocalPlaceCrabPot(call.RequestId, call.Slot, call.X, call.Y, call.QualifiedItemId, call.TargetId, call.DeadlineMs),
            "bait_crab_pot" => this.executions.RequestLocalBaitCrabPot(call.RequestId, call.Slot, call.X, call.Y, call.QualifiedItemId, call.TargetId, call.DeadlineMs),
            "tailor_clothing" => this.executions.RequestLocalTailorClothing(call.RequestId, call.LeftSlot, call.RightSlot, call.TargetId, call.DeadlineMs),
            "dye_clothing_with_item" => this.executions.RequestLocalDyeClothingWithItem(call.RequestId, call.LeftSlot, call.RightSlot, call.TargetId, call.DeadlineMs),
            "open_geode" => this.executions.RequestLocalOpenGeode(call.RequestId, call.Slot, call.QualifiedItemId, call.DeadlineMs),
            _ => new LocalExecutionReceipt(Guid.NewGuid().ToString("N"), request.RequestId, ExecutionState.Blocked, "unsupported_action", ledger.CurrentRevision, null),
        };
    }

    /// <summary>
    /// One inbound request as the seams above take it.
    ///
    /// Every argument is optional on the wire and every seam asks for a concrete value, so "what an absent argument
    /// means" is ONE fact. It was respelled at each row instead - `Slot ?? 0` 27 times, `(int)(X ?? 0)` and
    /// `(int)(Y ?? 0)` 35 times each, `ExpectedTargetId ?? string.Empty` 37 times - so an action that came to need a
    /// different default had no single place to say so. The envelope's own id and deadline are carried here too, so a
    /// row is exactly the seam call and says nothing about where a value came from.
    ///
    /// Each property evaluates exactly the expression its rows carried before, on read, so a row that never reads
    /// <see cref="Y"/> never evaluates it.
    /// </summary>
    private readonly struct ResourceToolCall
    {
        private readonly BridgeExecutionRequest request;

        public ResourceToolCall(BridgeExecutionRequest request)
        {
            this.request = request;
        }

        /// <summary>The id the receipt and the ledger key an execution on.</summary>
        public string RequestId => this.request.RequestId;

        /// <summary>The absolute millisecond timestamp after which a seam refuses this execution as `invalid_deadline`.</summary>
        public long DeadlineMs => this.request.DeadlineMs;

        /// <summary>The backpack slot an action names, or slot 0 when the request names none.</summary>
        public int Slot => this.request.Args.Slot ?? 0;

        /// <summary>The tile column: the wire carries a float, every seam takes the truncated column.</summary>
        public int X => (int)(this.request.Args.X ?? 0);

        /// <summary>The tile row: the wire carries a float, every seam takes the truncated row.</summary>
        public int Y => (int)(this.request.Args.Y ?? 0);

        /// <summary>The opaque id of the target the caller believes it is acting on, empty when it names none.</summary>
        public string TargetId => this.request.Args.ExpectedTargetId ?? string.Empty;

        /// <summary>The qualified id the caller believes a slot holds, empty when it names none.</summary>
        public string QualifiedItemId => this.request.Args.ExpectedQualifiedItemId ?? string.Empty;

        /// <summary>The Data/Buildings type id a commission is for, empty when it names none.</summary>
        public string BuildingType => this.request.Args.BuildingType ?? string.Empty;

        /// <summary>The palette index a repaint asks for; the game owns the bound.</summary>
        public int ColorSelection => this.request.Args.ColorSelection ?? 0;

        /// <summary>The first sewing-machine slot a tailoring request names, or slot 0.</summary>
        public int LeftSlot => this.request.Args.LeftSlot ?? 0;

        /// <summary>The second sewing-machine slot a tailoring request names, or slot 0.</summary>
        public int RightSlot => this.request.Args.RightSlot ?? 0;

        /// <summary>The declared tool selector `equip_tool` resolves; absent when the request names none.</summary>
        public string? Tool => this.request.Args.Tool;
    }
}
