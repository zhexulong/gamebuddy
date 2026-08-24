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

    public IReadOnlyCollection<string> SupportedActions { get; } = new[]
    {
        "machine_inspect",
        "machine_load",
        "machine_collect_output",
        "npc_relationship",
        "pet_animal",
        "collect_animal_product",
        "feed_animal",
        "use_item",
    };

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

            _ => new LocalExecutionReceipt(Guid.NewGuid().ToString("N"), request.RequestId, ExecutionState.Blocked, "unsupported_action", ledger.CurrentRevision, null),
        };
    }
}
