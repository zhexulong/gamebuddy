using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew.Core.Abstractions;

/// <summary>Game-thread-only handler implementation selected by a closed Mod registration.</summary>
public interface IFarmhandActionHandler
{
    LocalExecutionReceipt Execute(BridgeExecutionRequest request, IExecutionLedger ledger);
}
