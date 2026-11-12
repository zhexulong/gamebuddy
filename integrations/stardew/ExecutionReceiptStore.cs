using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew;

/// <summary>
/// The Mod's receipt ledger: every receipt remembered for idempotent replay, the immutable action and execution
/// identity bound to a request before a handler runs, the idle transition an execution still owes and the revision last
/// PUBLISHED for it.
///
/// <para>
/// This store is the only writer of that state. <see cref="ExecutionManager"/> reads the receipts through
/// <see cref="ByRequestId"/> and asks here for every mutation, so the one delivery funnel remains the only producer of a
/// published fact and this remains the only producer of a stored receipt.
/// </para>
///
/// <para>
/// It reaches outward exactly twice, and neither is a reference back to the manager's own state:
/// <see cref="IActiveBodyOwnership"/> answers whether an execution still owns the actor (and receives the one modal
/// lease release, from <see cref="Remember"/>), while the injected publication writes the <c>body_idle</c> trace, which
/// belongs to the manager because it carries its tick and its revision.
/// </para>
/// </summary>
internal sealed class ExecutionReceiptStore : IDispatchExecutionLedger
{
    /// <summary>The one bound on both remembered receipts and the public trace: the same number, one spelling.</summary>
    internal const int MaximumRememberedReceipts = 256;

    private readonly Dictionary<string, LocalExecutionReceipt> receiptsByRequestId = new(StringComparer.Ordinal);
    /** Same bounded lifetime as receipts; the action identity is ledger-owned, not bridge cache state. */
    private readonly Dictionary<string, string> actionIdsByRequestId = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> executionIdsByRequestId = new(StringComparer.Ordinal);
    private readonly Queue<string> receiptOrder = new();
    // An execution may have several native completion observations, but it announces its single post-release idle
    // transition once, from here.
    private readonly HashSet<string> idlePublishedExecutionIds = new(StringComparer.Ordinal);
    private readonly Dictionary<string, string> pendingIdleByExecutionId = new(StringComparer.Ordinal);
    // Navigation progress remains private until its single terminal receipt; it must not emit primitive route traces
    // or duplicate public idle transitions.
    private readonly HashSet<string> navigationExecutionIds = new(StringComparer.Ordinal);
    private readonly HashSet<string> durabilityFailuresByRequestId = new(StringComparer.Ordinal);
    // How long a held request waited, consumed by the first receipt its dispatch stores.
    private readonly Dictionary<string, long> heldMsByRequestId = new(StringComparer.Ordinal);
    /// <summary>
    /// The revision most recently PUBLISHED for each execution, which is what the Host's receipt-order audit
    /// compares against. Kept beside the mint-time revision rather than derived from it: the mint sites read a
    /// shared world counter, so two distinct transitions of one execution can legitimately mint the same number
    /// (see the publish funnel).
    /// </summary>
    private readonly Dictionary<string, long> publishedReceiptRevisionByExecutionId = new(StringComparer.Ordinal);
    private readonly IActiveBodyOwnership ownership;
    private readonly Action<string, string> publishBodyIdleTrace;

    internal ExecutionReceiptStore(IActiveBodyOwnership ownership, Action<string, string> publishBodyIdleTrace)
    {
        this.ownership = ownership;
        this.publishBodyIdleTrace = publishBodyIdleTrace;
    }

    /// <summary>
    /// The stored receipts as their readers see them. Read-only on purpose: the request prologues still read a
    /// request's receipt directly (the conversion to <see cref="IExecutionLedger.TryGetExistingReceipt"/> belongs to the
    /// admission seam), but no caller outside this store can replace one.
    /// </summary>
    internal IReadOnlyDictionary<string, LocalExecutionReceipt> ByRequestId => this.receiptsByRequestId;

    /// <summary>
    /// Stores one receipt and returns the instance the map now holds - the caller publishes what was stored, never a
    /// copy of what it passed in.
    ///
    /// <para>
    /// The eviction below is one block on purpose: the request's receipt, its action identity, its execution identity
    /// and its navigation marker are one record, and a store that dropped the receipt while leaving the marker behind
    /// would retire an execution the idle drain still believes it owes a silence to.
    /// </para>
    /// </summary>
    internal LocalExecutionReceipt Remember(LocalExecutionReceipt receipt)
    {
        if (!this.receiptsByRequestId.ContainsKey(receipt.RequestId))
        {
            this.receiptOrder.Enqueue(receipt.RequestId);
            if (this.receiptOrder.Count > MaximumRememberedReceipts)
            {
                string evictedRequestId = this.receiptOrder.Dequeue();
                if (this.receiptsByRequestId.TryGetValue(evictedRequestId, out LocalExecutionReceipt? evictedReceipt))
                    this.navigationExecutionIds.Remove(evictedReceipt.ExecutionId);
                this.receiptsByRequestId.Remove(evictedRequestId);
                this.actionIdsByRequestId.Remove(evictedRequestId);
                this.executionIdsByRequestId.Remove(evictedRequestId);
            }
        }

        this.receiptsByRequestId[receipt.RequestId] = receipt;
        // The ONE release of a modal owner lease. Every terminal of an execution passes through this map - rejection,
        // invalidation, deadline expiry, cancellation, the native warp's own success - so releasing here cannot be
        // forgotten by a new exit path, and nothing else in this Mod clears the lease. A lease that outlived its
        // execution would suppress the next world interruption (WorldModel.OwnsCurrentModal re-checks activity as the
        // second line of defence).
        if (receipt.State.IsTerminal())
            this.ownership.ReleaseModalLease(receipt.ExecutionId);
        return receipt;
    }

    /// <summary>
    /// Folds the native notices observed during a dispatch into that request's stored receipt, through
    /// <see cref="Remember"/>, so this store stays the only writer of the receipt map. Returns the receipt the caller
    /// should publish.
    ///
    /// A receipt that is absent, or that already settled with notices, keeps whatever it has: notices are evidence
    /// about one synchronous window, and a replay must never rewrite a settled receipt's meaning.
    /// </summary>
    internal LocalExecutionReceipt AttachNativeNotices(
        LocalExecutionReceipt receipt,
        IReadOnlyList<string> nativeNotices)
    {
        // Notices annotate the receipt the dispatch just produced; they are not an outcome of their own. A receipt that
        // cannot be matched (or that already carries notices, as a replay does) is returned untouched rather than
        // replaced, so this can never manufacture a terminal state.
        if (!this.receiptsByRequestId.TryGetValue(receipt.RequestId, out LocalExecutionReceipt? stored)
            || stored.NativeNotices is not null)
            return receipt;

        LocalExecutionReceipt annotated = receipt with { NativeNotices = nativeNotices };
        this.Remember(annotated);
        return annotated;
    }

    /// <summary>
    /// Publishes the one idle transition for an execution only after every manager-owned representation of that
    /// execution has been released. This deliberately is not part of generic terminal receipt tracing: native
    /// animations may retain ownership after a terminal observation.
    /// </summary>
    internal void PublishIdleAfterRelease(string executionId, string requestId)
    {
        if (this.idlePublishedExecutionIds.Contains(executionId))
            return;
        this.pendingIdleByExecutionId[executionId] = requestId;
        this.DrainPendingIdleAfterRelease();
    }

    internal void DrainPendingIdleAfterRelease()
    {
        foreach ((string executionId, string requestId) in this.pendingIdleByExecutionId.ToArray())
        {
            if (this.ownership.HasOwnership(executionId) || !this.idlePublishedExecutionIds.Add(executionId))
                continue;
            this.pendingIdleByExecutionId.Remove(executionId);
            if (!this.navigationExecutionIds.Remove(executionId))
                this.publishBodyIdleTrace(executionId, requestId);
        }
    }

    /// <summary>Whether an execution's idle transition is still waiting for the actor to be released.</summary>
    internal bool HasPendingIdle(string executionId) => this.pendingIdleByExecutionId.ContainsKey(executionId);

    /// <summary>Marks a navigation lineage, whose idle its own settle publishes rather than the drain.</summary>
    internal void MarkNavigationExecution(string executionId) => this.navigationExecutionIds.Add(executionId);

    internal bool IsNavigationExecution(string executionId) => this.navigationExecutionIds.Contains(executionId);

    /// <summary>Quarantines a request whose own durable admission could not be written.</summary>
    internal void MarkDurabilityFailure(string requestId) => this.durabilityFailuresByRequestId.Add(requestId);

    internal bool HasDurabilityFailure(string requestId) => this.durabilityFailuresByRequestId.Contains(requestId);

    internal void RecordHoldWait(string requestId, long heldMs) => this.heldMsByRequestId[requestId] = heldMs;

    internal bool TryGetHeldMs(string requestId, out long heldMs) => this.heldMsByRequestId.TryGetValue(requestId, out heldMs);

    internal void ClearHeldMs(string requestId) => this.heldMsByRequestId.Remove(requestId);

    internal bool TryGetPublishedRevision(string executionId, out long revision) =>
        this.publishedReceiptRevisionByExecutionId.TryGetValue(executionId, out revision);

    internal void RecordPublishedRevision(string executionId, long revision) =>
        this.publishedReceiptRevisionByExecutionId[executionId] = revision;

    /// <summary>Returns the latest authoritative receipt for idempotent bridge replay.</summary>
    internal bool TryGetReceipt(string requestId, out LocalExecutionReceipt receipt) => this.receiptsByRequestId.TryGetValue(requestId, out receipt!);

    /// <summary>Returns the action identity captured on the game-thread dispatch lineage.</summary>
    internal bool TryGetActionId(string requestId, out string actionId) => this.actionIdsByRequestId.TryGetValue(requestId, out actionId!);

    public bool TryGetBoundExecutionId(string requestId, out string executionId) =>
        this.executionIdsByRequestId.TryGetValue(requestId, out executionId!);

    public bool TryBindDispatch(string requestId, string actionId, string executionId, out string reasonCode)
    {
        reasonCode = string.Empty;
        if (string.IsNullOrWhiteSpace(requestId)
            || string.IsNullOrWhiteSpace(actionId)
            || string.IsNullOrWhiteSpace(executionId))
        {
            reasonCode = "invalid_execution_identity";
            return false;
        }
        if (this.receiptsByRequestId.ContainsKey(requestId))
        {
            reasonCode = "request_already_started";
            return false;
        }
        if (this.actionIdsByRequestId.TryGetValue(requestId, out string? existingAction)
            && !string.Equals(existingAction, actionId, StringComparison.Ordinal))
        {
            reasonCode = "request_action_conflict";
            return false;
        }
        if (this.executionIdsByRequestId.TryGetValue(requestId, out string? existingExecution))
        {
            reasonCode = string.Equals(existingExecution, executionId, StringComparison.Ordinal)
                ? "execution_identity_already_bound"
                : "execution_identity_conflict";
            return false;
        }
        if (this.executionIdsByRequestId.Values.Contains(executionId, StringComparer.Ordinal))
        {
            reasonCode = "execution_identity_reused";
            return false;
        }
        this.actionIdsByRequestId[requestId] = actionId;
        this.executionIdsByRequestId[requestId] = executionId;
        reasonCode = "bound";
        return true;
    }

    internal string NewExecutionId(string requestId)
    {
        if (this.executionIdsByRequestId.TryGetValue(requestId, out string? bound))
            return bound;
        string executionId = Guid.NewGuid().ToString("N");
        this.executionIdsByRequestId[requestId] = executionId;
        return executionId;
    }

    internal void BindAction(string requestId, string actionId)
    {
        if (string.IsNullOrWhiteSpace(requestId))
            throw new ArgumentException("Request ID is required.", nameof(requestId));
        if (string.IsNullOrWhiteSpace(actionId))
            throw new ArgumentException("Action ID is required.", nameof(actionId));
        if (this.actionIdsByRequestId.TryGetValue(requestId, out string? existing) && !string.Equals(existing, actionId, StringComparison.Ordinal))
            throw new InvalidOperationException("Request action lineage conflict.");
        this.actionIdsByRequestId[requestId] = actionId;
    }
}
