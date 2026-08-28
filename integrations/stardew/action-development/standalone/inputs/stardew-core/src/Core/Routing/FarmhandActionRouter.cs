using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;

namespace GameBuddy.Stardew.Core.Routing;

/// <summary>
/// Authoritative game-thread dispatch table. It is composed from the one
/// closed Mod registration catalog and fails closed for unknown, duplicate, or
/// off-thread action requests.
/// </summary>
public sealed class FarmhandActionRouter
{
    private readonly Dictionary<string, IFarmhandActionHandler> handlers = new(StringComparer.Ordinal);
    private readonly int ownerManagedThreadId;

    public FarmhandActionRouter(int? ownerManagedThreadId = null)
    {
        this.ownerManagedThreadId = ownerManagedThreadId ?? Environment.CurrentManagedThreadId;
    }

    public void Register(FarmhandActionRegistration registration, IFarmhandActionHandler handler)
    {
        ArgumentNullException.ThrowIfNull(registration);
        ArgumentNullException.ThrowIfNull(handler);
        if (registration.Kind != FarmhandOperationKind.Execution || registration.HandlerGroup is null)
            throw new InvalidOperationException("Read-only Farmhand operations cannot be registered for execution.");
        if (!this.handlers.TryAdd(registration.ActionId, handler))
            throw new InvalidOperationException($"Duplicate farmhand action handler registration: {registration.ActionId}");
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

        // The action identity belongs to the Mod's dispatch/ledger lineage and
        // is bound before a handler can synchronously publish any receipt.
        ledger.BindAction(request.RequestId, request.Action);
        receipt = handler.Execute(request, ledger);
        reasonCode = "accepted";
        return true;
    }
}
