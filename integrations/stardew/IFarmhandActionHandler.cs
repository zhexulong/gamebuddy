namespace GameBuddy.Stardew;

/// <summary>
/// Game-thread-only handler contract for a single Farmhand action capability.
/// </summary>
internal interface IFarmhandActionHandler
{
    string ActionId { get; }
    LocalExecutionReceipt ExecuteOnGameThread(BridgeExecutionRequest request, ExecutionManager executions);
}
