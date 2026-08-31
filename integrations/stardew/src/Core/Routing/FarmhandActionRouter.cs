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
        out string reasonCode) =>
        this.TryRoute(request, ledger, executionId: null, out receipt, out reasonCode);

    /// <summary>
    /// Routes a dispatch whose execution identity was minted by the authenticated
    /// caller. The identity is bound before the handler can start a native body.
    /// </summary>
    public bool TryRoute(
        BridgeExecutionRequest request,
        IExecutionLedger ledger,
        string? executionId,
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
            if (executionId is not null
                && ledger is IDispatchExecutionLedger dispatchLedger
                && dispatchLedger.TryGetBoundExecutionId(request.RequestId, out string existingExecutionId)
                && !string.Equals(existingExecutionId, executionId, StringComparison.Ordinal))
            {
                receipt = default!;
                reasonCode = "execution_identity_conflict";
                return false;
            }

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

        if (executionId is not null)
        {
            string bindingReason = "execution_identity_unavailable";
            if (ledger is not IDispatchExecutionLedger dispatchLedger
                || (!dispatchLedger.TryBindDispatch(request.RequestId, request.Action, executionId, out bindingReason)
                    && bindingReason != "execution_identity_already_bound"))
            {
                receipt = default!;
                reasonCode = string.IsNullOrEmpty(bindingReason) ? "execution_identity_unavailable" : bindingReason;
                return false;
            }
        }
        else
        {
            // Direct/local callers retain the legacy action-only binding path.
            ledger.BindAction(request.RequestId, request.Action);
        }

        receipt = handler.Execute(request, ledger);
        reasonCode = "accepted";
        return true;
    }
}
