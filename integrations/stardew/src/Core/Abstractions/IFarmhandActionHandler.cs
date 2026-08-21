using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew.Core.Abstractions;

/// <summary>
/// Game-thread-only handler contract for a single domain capability or cluster of actions.
/// </summary>
public interface IFarmhandActionHandler
{
    IReadOnlyCollection<string> SupportedActions { get; }
    LocalExecutionReceipt Execute(BridgeExecutionRequest request, IExecutionLedger ledger);
}
