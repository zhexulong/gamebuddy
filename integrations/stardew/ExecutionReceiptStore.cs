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
/// It reaches outward exactly once: <see cref="IActiveBodyOwnership"/> answers whether an execution still owns the
/// actor (and receives the one modal lease release, from <see cref="Remember"/>). The idle transition that this store
/// retires used to be announced as a <c>body_idle</c> fact; that announcement was a trace of the body rather than a change
/// of the world, so it is gone and this store no longer publishes anything.
/// </para>
/// </summary>
internal sealed class ExecutionReceiptStore : IDispatchExecutionLedger
{
    /// <summary>The one bound on remembered receipts.</summary>
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
    // The journal's own cause for each quarantined request, kept rather than a flag: `execution_receipt_persistence_failed`
    // covered a read failure, a malformed payload, a version mismatch, a lost write and five tuple mismatches alike, so the
    // Host could not tell one from another. The refusal now names the cause; the FIRST cause stands, because every later
    // attempt is already answering a quarantine.
    private readonly Dictionary<string, FarmhandExecutionJournalResultCode> durabilityFailureCausesByRequestId = new(StringComparer.Ordinal);
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

    internal ExecutionReceiptStore(IActiveBodyOwnership ownership)
    {
        this.ownership = ownership;
    }

    /// <summary>
    /// The stored receipts as their readers see them. Read-only on purpose: the request prologues still read a
    /// request's receipt directly (the conversion to <see cref="IExecutionLedger.TryGetExistingReceipt"/> belongs to the
    /// admission seam), but no caller outside this store can replace one.
    /// </summary>
    internal IReadOnlyDictionary<string, LocalExecutionReceipt> ByRequestId => this.receiptsByRequestId;

    /// <summary>
    /// The receipt stored most recently, or null when none has been.
    ///
    /// <para>
    /// A refusal asks this to tell a repeat from a new fact (<c>ExecutionManager.NoteRepeatedRefusal</c>): "the answer
    /// before mine" is the previous SETTLEMENT, so anything that resolved in between breaks the chain. The order is the
    /// order requests arrived, which is the same order their terminals were stored - one request's dispatch answers it
    /// synchronously, and a later transition of the same request rewrites that request's own entry rather than adding one.
    /// </para>
    /// </summary>
    internal LocalExecutionReceipt? MostRecentReceipt =>
        this.receiptOrder.Count > 0
        && this.receiptsByRequestId.TryGetValue(this.receiptOrder.Last(), out LocalExecutionReceipt? receipt)
            ? receipt
            : null;

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
        // A SETTLED RECEIPT IS NEVER REWRITTEN BY A LATER PROGRESS TRANSITION. The one funnel stores every receipt it
        // is handed, and a body controller can still report a step of an execution that was already answered (round66:
        // `rejected` at revision 840 for the request, then `tool_approach_completed` for the walk underneath it). Storing
        // the second would leave every reader - exact receipt query, idempotent replay, held request - answering with a
        // state the execution already left, so the settled receipt stands and the late one is refused.
        if (!receipt.State.IsTerminal()
            && this.receiptsByRequestId.TryGetValue(receipt.RequestId, out LocalExecutionReceipt? settled)
            && settled.State.IsTerminal())
            return settled;
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
    /// Retires an execution's one pending idle transition once every manager-owned representation of that execution has
    /// been released. This deliberately is not part of generic terminal receipt tracing: native animations may retain
    /// ownership after a terminal observation.
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
        foreach ((string executionId, _) in this.pendingIdleByExecutionId.ToArray())
        {
            if (this.ownership.HasOwnership(executionId) || !this.idlePublishedExecutionIds.Add(executionId))
                continue;
            this.pendingIdleByExecutionId.Remove(executionId);
            this.navigationExecutionIds.Remove(executionId);
        }
    }

    /// <summary>Whether an execution's idle transition is still waiting for the actor to be released.</summary>
    internal bool HasPendingIdle(string executionId) => this.pendingIdleByExecutionId.ContainsKey(executionId);

    /// <summary>Marks a navigation lineage, whose idle its own settle publishes rather than the drain.</summary>
    internal void MarkNavigationExecution(string executionId) => this.navigationExecutionIds.Add(executionId);

    internal bool IsNavigationExecution(string executionId) => this.navigationExecutionIds.Contains(executionId);

    /// <summary>
    /// The one spelling of a durability refusal: the class the Host already routes, and the journal's own cause in the
    /// wire's own reason-code grammar. Both the settlement funnel and the admission jam answer with this sentence, so one
    /// cause never has two names.
    /// </summary>
    internal const string DurabilityFailureReasonPrefix = "execution_receipt_persistence_failed";

    internal static string DurabilityFailureReason(FarmhandExecutionJournalResultCode cause) =>
        $"{DurabilityFailureReasonPrefix}:{FarmhandExecutionJournalResultCodeNames.WireCode(cause)}";

    /// <summary>Quarantines a request whose own admission or receipt could not be recorded, under the journal's cause.</summary>
    internal void MarkDurabilityFailure(string requestId, FarmhandExecutionJournalResultCode cause) =>
        this.durabilityFailureCausesByRequestId.TryAdd(requestId, cause);

    internal bool HasDurabilityFailure(string requestId) => this.durabilityFailureCausesByRequestId.ContainsKey(requestId);

    /// <summary>The refusal a quarantined request is answered with, cause included; false when it is not quarantined.</summary>
    internal bool TryGetDurabilityFailureReason(string requestId, out string reasonCode)
    {
        if (this.durabilityFailureCausesByRequestId.TryGetValue(requestId, out FarmhandExecutionJournalResultCode cause))
        {
            reasonCode = DurabilityFailureReason(cause);
            return true;
        }

        reasonCode = string.Empty;
        return false;
    }

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
