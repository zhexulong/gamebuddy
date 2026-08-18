namespace GameBuddy.Stardew;

/// <summary>
/// Authoritative game-thread dispatch table for registered Farmhand actions.
/// Router enforces unique handler registration and fails closed if an action is not mapped.
/// </summary>
internal sealed class FarmhandActionRouter
{
    private readonly Dictionary<string, IFarmhandActionHandler> handlers = new(StringComparer.Ordinal);
    private readonly int ownerManagedThreadId = Environment.CurrentManagedThreadId;

    public FarmhandActionRouter()
    {
        this.Register(new DelegateActionHandler("move_to_tile", (req, exec) =>
            exec.RequestLocalMove(req.RequestId, new Microsoft.Xna.Framework.Vector2(req.Args.X!.Value, req.Args.Y!.Value), req.DeadlineMs)));
        this.Register(new DelegateActionHandler("enter_exit", (req, exec) =>
            exec.RequestLocalEnterExit(req.RequestId, (int)req.Args.X!.Value, (int)req.Args.Y!.Value, req.DeadlineMs)));
        this.Register(new DelegateActionHandler("travel", (req, exec) =>
            exec.RequestLocalTravel(req.RequestId, (int)req.Args.X!.Value, (int)req.Args.Y!.Value, req.DeadlineMs)));
        this.Register(new DelegateActionHandler("till_soil", (req, exec) =>
            exec.RequestLocalTillSoil(req.RequestId, (int)req.Args.X!.Value, (int)req.Args.Y!.Value, req.DeadlineMs)));
        this.Register(new DelegateActionHandler("pickup_forage", (req, exec) =>
            exec.RequestLocalPickupForage(req.RequestId, (int)req.Args.X!.Value, (int)req.Args.Y!.Value, req.Args.ExpectedQualifiedItemId!, req.Args.ExpectedTargetId!, req.DeadlineMs)));
        this.Register(new DelegateActionHandler("pickup_item", (req, exec) =>
            exec.RequestLocalPickupItem(req.RequestId, (int)req.Args.X!.Value, (int)req.Args.Y!.Value, req.Args.ExpectedQualifiedItemId!, req.Args.ExpectedTargetId!, req.DeadlineMs)));
        this.Register(new DelegateActionHandler("water_crop", (req, exec) =>
            exec.RequestLocalWaterCrop(req.RequestId, (int)req.Args.X!.Value, (int)req.Args.Y!.Value, req.Args.ExpectedTargetId!, req.DeadlineMs)));
        this.Register(new DelegateActionHandler("harvest_crop", (req, exec) =>
            exec.RequestLocalHarvestCrop(req.RequestId, (int)req.Args.X!.Value, (int)req.Args.Y!.Value, req.Args.ExpectedQualifiedItemId!, req.Args.ExpectedTargetId!, req.DeadlineMs)));
        this.Register(new DelegateActionHandler("plant_seed", (req, exec) =>
            exec.RequestLocalPlantSeed(req.RequestId, req.Args.Slot!.Value, (int)req.Args.X!.Value, (int)req.Args.Y!.Value, req.Args.ExpectedQualifiedItemId!, req.Args.ExpectedTargetId!, req.DeadlineMs)));
        this.Register(new DelegateActionHandler("fertilize_tile", (req, exec) =>
            exec.RequestLocalFertilizeTile(req.RequestId, req.Args.Slot!.Value, (int)req.Args.X!.Value, (int)req.Args.Y!.Value, req.Args.ExpectedQualifiedItemId!, req.Args.ExpectedTargetId!, req.DeadlineMs)));
        this.Register(new DelegateActionHandler("place_wood_fence", (req, exec) =>
            exec.RequestLocalPlaceWoodFence(req.RequestId, req.Args.Slot!.Value, (int)req.Args.X!.Value, (int)req.Args.Y!.Value, req.Args.ExpectedQualifiedItemId!, req.Args.ExpectedTargetId!, req.DeadlineMs)));
        this.Register(new DelegateActionHandler("place_crab_pot", (req, exec) =>
            exec.RequestLocalPlaceCrabPot(req.RequestId, req.Args.Slot!.Value, (int)req.Args.X!.Value, (int)req.Args.Y!.Value, req.Args.ExpectedQualifiedItemId!, req.Args.ExpectedTargetId!, req.DeadlineMs)));
        this.Register(new DelegateActionHandler("bait_crab_pot", (req, exec) =>
            exec.RequestLocalBaitCrabPot(req.RequestId, req.Args.Slot!.Value, (int)req.Args.X!.Value, (int)req.Args.Y!.Value, req.Args.ExpectedQualifiedItemId!, req.Args.ExpectedTargetId!, req.DeadlineMs)));
        this.Register(new DelegateActionHandler("clear_debris", (req, exec) =>
            exec.RequestLocalClearDebris(req.RequestId, req.Args.Slot!.Value, (int)req.Args.X!.Value, (int)req.Args.Y!.Value, req.Args.ExpectedTargetId!, req.DeadlineMs)));
        this.Register(new DelegateActionHandler("machine_inspect", (req, exec) =>
            exec.RequestLocalInspectMachine(req.RequestId, (int)req.Args.X!.Value, (int)req.Args.Y!.Value, req.Args.ExpectedTargetId!, req.DeadlineMs)));
        this.Register(new DelegateActionHandler("machine_load", (req, exec) =>
            exec.RequestLocalLoadCoffeeIntoKeg(req.RequestId, req.Args.Slot!.Value, (int)req.Args.X!.Value, (int)req.Args.Y!.Value, req.Args.ExpectedQualifiedItemId!, req.Args.ExpectedTargetId!, req.DeadlineMs)));
        this.Register(new DelegateActionHandler("machine_collect_output", (req, exec) =>
            exec.RequestLocalCollectCoffeeFromKeg(req.RequestId, (int)req.Args.X!.Value, (int)req.Args.Y!.Value, req.Args.ExpectedTargetId!, req.DeadlineMs)));
        this.Register(new DelegateActionHandler("npc_relationship", (req, exec) =>
            exec.RequestLocalInspectNpcRelationship(req.RequestId, (int)req.Args.X!.Value, (int)req.Args.Y!.Value, req.Args.ExpectedTargetId!, req.DeadlineMs)));
        this.Register(new DelegateActionHandler("pet_animal", (req, exec) =>
            exec.RequestLocalPetAnimal(req.RequestId, (int)req.Args.X!.Value, (int)req.Args.Y!.Value, req.Args.ExpectedTargetId!, req.DeadlineMs)));
        this.Register(new DelegateActionHandler("collect_animal_product", (req, exec) =>
            exec.RequestLocalCollectAnimalProduct(req.RequestId, req.Args.Slot!.Value, (int)req.Args.X!.Value, (int)req.Args.Y!.Value, req.Args.ExpectedTargetId!, req.DeadlineMs)));
        this.Register(new DelegateActionHandler("feed_animal", (req, exec) =>
            exec.RequestLocalFeedAnimal(req.RequestId, req.Args.Slot!.Value, (int)req.Args.X!.Value, (int)req.Args.Y!.Value, req.Args.ExpectedTargetId!, req.DeadlineMs)));
        this.Register(new DelegateActionHandler("use_item", (req, exec) =>
            exec.RequestLocalUseItem(req.RequestId, req.Args.Slot!.Value, req.Args.ExpectedQualifiedItemId!, req.DeadlineMs)));
        this.Register(new DelegateActionHandler("refill_watering_can", (req, exec) =>
            exec.RequestLocalRefillWateringCan(req.RequestId, req.Args.Slot!.Value, (int)req.Args.X!.Value, (int)req.Args.Y!.Value, req.Args.ExpectedTargetId!, req.DeadlineMs)));
        this.Register(new DelegateActionHandler("clear_hoedirt", (req, exec) =>
            exec.RequestLocalClearHoeDirt(req.RequestId, req.Args.Slot!.Value, (int)req.Args.X!.Value, (int)req.Args.Y!.Value, req.Args.ExpectedTargetId!, req.DeadlineMs)));
        this.Register(new DelegateActionHandler("dig_artifact_spot", (req, exec) =>
            exec.RequestLocalDigArtifactSpot(req.RequestId, req.Args.Slot!.Value, (int)req.Args.X!.Value, (int)req.Args.Y!.Value, req.Args.ExpectedTargetId!, req.DeadlineMs)));
        this.Register(new DelegateActionHandler("break_rock_source", (req, exec) =>
            exec.RequestLocalBreakRockSource(req.RequestId, req.Args.Slot!.Value, (int)req.Args.X!.Value, (int)req.Args.Y!.Value, req.Args.ExpectedTargetId!, req.DeadlineMs)));
        this.Register(new DelegateActionHandler("chop_tree_source", (req, exec) =>
            exec.RequestLocalChopTreeSource(req.RequestId, req.Args.Slot!.Value, (int)req.Args.X!.Value, (int)req.Args.Y!.Value, req.Args.ExpectedTargetId!, req.DeadlineMs)));
        this.Register(new DelegateActionHandler("equip_tool", (req, exec) =>
            exec.RequestLocalEquipTool(req.RequestId, req.Args.Slot!.Value)));

        this.RequireCanonicalDefinitionCoverage();
    }

    private void Register(IFarmhandActionHandler handler)
    {
        if (this.handlers.ContainsKey(handler.ActionId))
            throw new InvalidOperationException($"Duplicate farmhand action handler registration: {handler.ActionId}");
        this.handlers[handler.ActionId] = handler;
    }

    internal bool IsOnOwnerThread => Environment.CurrentManagedThreadId == this.ownerManagedThreadId;

    public bool TryRoute(
        BridgeExecutionRequest request,
        ExecutionManager executions,
        FarmhandCapabilitySurface capabilities,
        out LocalExecutionReceipt receipt,
        out string reasonCode)
    {
        if (!this.IsOnOwnerThread)
        {
            receipt = default!;
            reasonCode = "game_thread_required";
            return false;
        }
        if (!capabilities.ContainsGameAction(request.Action))
        {
            receipt = default!;
            reasonCode = "action_not_available";
            return false;
        }
        if (!this.handlers.TryGetValue(request.Action, out IFarmhandActionHandler? handler))
        {
            receipt = default!;
            reasonCode = "invalid_execution_request";
            return false;
        }

        receipt = handler.ExecuteOnGameThread(request, executions);
        reasonCode = "accepted";
        return true;
    }

    private void RequireCanonicalDefinitionCoverage()
    {
        HashSet<string> definitionIds = ModConfig.FarmhandActionDefinitions
            .Select(definition => definition.ActionId)
            .ToHashSet(StringComparer.Ordinal);
        if (definitionIds.Count != ModConfig.FarmhandActionDefinitions.Count
            || !definitionIds.SetEquals(this.handlers.Keys))
        {
            throw new InvalidOperationException(
                "Farmhand action router handlers must exactly match the canonical Mod action definitions.");
        }
    }

    private sealed class DelegateActionHandler : IFarmhandActionHandler
    {
        private readonly Func<BridgeExecutionRequest, ExecutionManager, LocalExecutionReceipt> handler;

        public DelegateActionHandler(string actionId, Func<BridgeExecutionRequest, ExecutionManager, LocalExecutionReceipt> handler)
        {
            this.ActionId = actionId;
            this.handler = handler;
        }

        public string ActionId { get; }

        public LocalExecutionReceipt ExecuteOnGameThread(BridgeExecutionRequest request, ExecutionManager executions)
            => this.handler(request, executions);
    }
}
