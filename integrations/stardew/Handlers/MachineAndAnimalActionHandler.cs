using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew.Handlers;

internal sealed class MachineAndAnimalActionHandler : IFarmhandActionHandler
{
    private readonly ExecutionManager executions;

    public MachineAndAnimalActionHandler(ExecutionManager executions)
    {
        this.executions = executions ?? throw new ArgumentNullException(nameof(executions));
    }

    public LocalExecutionReceipt Execute(BridgeExecutionRequest request, IExecutionLedger ledger)
    {
        return request.Action switch
        {
            "machine_inspect" => this.executions.RequestLocalInspectMachine(
                request.RequestId,
                (int)(request.Args.X ?? 0),
                (int)(request.Args.Y ?? 0),
                request.Args.ExpectedTargetId ?? string.Empty,
                request.DeadlineMs),

            "machine_load" => this.executions.RequestLocalLoadCoffeeIntoKeg(
                request.RequestId,
                request.Args.Slot ?? 0,
                (int)(request.Args.X ?? 0),
                (int)(request.Args.Y ?? 0),
                request.Args.ExpectedQualifiedItemId ?? string.Empty,
                request.Args.ExpectedTargetId ?? string.Empty,
                request.DeadlineMs),

            "machine_collect_output" => this.executions.RequestLocalCollectCoffeeFromKeg(
                request.RequestId,
                (int)(request.Args.X ?? 0),
                (int)(request.Args.Y ?? 0),
                request.Args.ExpectedTargetId ?? string.Empty,
                request.DeadlineMs),

            "npc_relationship" => this.executions.RequestLocalInspectNpcRelationship(
                request.RequestId,
                (int)(request.Args.X ?? 0),
                (int)(request.Args.Y ?? 0),
                request.Args.ExpectedTargetId ?? string.Empty,
                request.DeadlineMs),

            "interact_npc_with_item" => this.executions.RequestLocalInteractNpcWithItem(
                request.RequestId,
                request.Args.Slot ?? 0,
                (int)(request.Args.X ?? 0),
                (int)(request.Args.Y ?? 0),
                request.Args.ExpectedQualifiedItemId ?? string.Empty,
                request.Args.ExpectedTargetId ?? string.Empty,
                request.DeadlineMs),

            "pet_animal" => this.executions.RequestLocalPetAnimal(
                request.RequestId,
                (int)(request.Args.X ?? 0),
                (int)(request.Args.Y ?? 0),
                request.Args.ExpectedTargetId ?? string.Empty,
                request.DeadlineMs),

            "collect_animal_product" => this.executions.RequestLocalCollectAnimalProduct(
                request.RequestId,
                request.Args.Slot ?? 0,
                (int)(request.Args.X ?? 0),
                (int)(request.Args.Y ?? 0),
                request.Args.ExpectedTargetId ?? string.Empty,
                request.DeadlineMs),

            "feed_animal" => this.executions.RequestLocalFeedAnimal(
                request.RequestId,
                request.Args.Slot ?? 0,
                (int)(request.Args.X ?? 0),
                (int)(request.Args.Y ?? 0),
                request.Args.ExpectedTargetId ?? string.Empty,
                request.DeadlineMs),

            "use_item" => this.executions.RequestLocalUseItem(
                request.RequestId,
                request.Args.Slot ?? 0,
                request.Args.ExpectedQualifiedItemId ?? string.Empty,
                request.DeadlineMs),

            "chest_store" => this.executions.RequestLocalChestStore(
                request.RequestId,
                request.Args.Slot ?? 0,
                (int)(request.Args.X ?? 0),
                (int)(request.Args.Y ?? 0),
                request.Args.ExpectedQualifiedItemId ?? string.Empty,
                request.Args.ExpectedTargetId ?? string.Empty,
                request.DeadlineMs),

            "chest_retrieve" => this.executions.RequestLocalChestRetrieve(
                request.RequestId,
                request.Args.Slot ?? 0,
                (int)(request.Args.X ?? 0),
                (int)(request.Args.Y ?? 0),
                request.Args.ExpectedQualifiedItemId ?? string.Empty,
                request.Args.ExpectedTargetId ?? string.Empty,
                request.DeadlineMs),

            // Loop-closure W0a routing. The four bodies live in the lane-owned
            // partials (farmhandexecutioncontroller.{crafting,cooking,crabpot,
            // shipping}actions.cs) and are replaced by lanes B/C/D/E; W0a only
            // freezes this dispatch seam and the cross-lane signatures. Each
            // placeholder fails closed as action_not_implemented.
            "craft_item" => this.executions.RequestLocalCraftItem(
                request.RequestId,
                request.Args.ExpectedTargetId ?? string.Empty,
                request.DeadlineMs),

            "cook_recipe" => this.executions.RequestLocalCookRecipe(
                request.RequestId,
                request.Args.ExpectedTargetId ?? string.Empty,
                request.DeadlineMs),

            "collect_crab_pot_output" => this.executions.RequestLocalCollectCrabPotOutput(
                request.RequestId,
                (int)(request.Args.X ?? 0),
                (int)(request.Args.Y ?? 0),
                request.Args.ExpectedTargetId ?? string.Empty,
                request.DeadlineMs),

            "ship_item" => this.executions.RequestLocalShipItem(
                request.RequestId,
                request.Args.Slot ?? 0,
                (int)(request.Args.X ?? 0),
                (int)(request.Args.Y ?? 0),
                request.Args.ExpectedQualifiedItemId ?? string.Empty,
                request.Args.ExpectedTargetId ?? string.Empty,
                request.DeadlineMs),


            _ => new LocalExecutionReceipt(Guid.NewGuid().ToString("N"), request.RequestId, ExecutionState.Blocked, "unsupported_action", ledger.CurrentRevision, null),
        };
    }
}
