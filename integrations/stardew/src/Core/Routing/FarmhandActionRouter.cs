using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew.Core.Routing;

/// <summary>
/// Authoritative game-thread dispatch table for registered Farmhand actions.
/// Router enforces unique handler registration and fails closed if an action is not mapped or called off-thread.
/// </summary>
public sealed class FarmhandActionRouter
{
    private readonly Dictionary<string, IFarmhandActionHandler> handlers = new(StringComparer.Ordinal);
    private readonly int ownerManagedThreadId;

    public FarmhandActionRouter(int? ownerManagedThreadId = null)
    {
        this.ownerManagedThreadId = ownerManagedThreadId ?? Environment.CurrentManagedThreadId;
    }

    public void Register(IFarmhandActionHandler handler)
    {
        ArgumentNullException.ThrowIfNull(handler);
        foreach (string actionId in handler.SupportedActions)
        {
            if (this.handlers.ContainsKey(actionId))
                throw new InvalidOperationException($"Duplicate farmhand action handler registration: {actionId}");
            this.handlers[actionId] = handler;
        }
    }

    public bool IsOnOwnerThread => Environment.CurrentManagedThreadId == this.ownerManagedThreadId;

    public bool TryRoute(
        BridgeExecutionRequest request,
        IExecutionLedger ledger,
        out LocalExecutionReceipt receipt,
        out string reasonCode)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(ledger);

        if (!this.IsOnOwnerThread)
        {
            receipt = default!;
            reasonCode = "game_thread_required";
            return false;
        }

        if (ledger.TryGetExistingReceipt(request.RequestId, out LocalExecutionReceipt existing))
        {
            receipt = existing;
            reasonCode = "replayed_existing_receipt";
            return true;
        }

        if (!this.handlers.TryGetValue(request.Action, out IFarmhandActionHandler? handler))
        {
            receipt = default!;
            reasonCode = "action_not_available";
            return false;
        }

        receipt = handler.Execute(request, ledger);
        reasonCode = "accepted";
        return true;
    }
}
