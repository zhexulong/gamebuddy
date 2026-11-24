using System.Collections.ObjectModel;
using System.Text;
using GameBuddy.Stardew.Core.Diagnostics;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;

namespace GameBuddy.Stardew;

/// <summary>
/// The only persistence surface required by <see cref="FarmhandExecutionJournal"/>.
/// A production adapter can bind these operations to SMAPI global data without
/// exposing IDataHelper, files, or a second execution registry to the journal.
/// A null read means that this journal has not been created for the current save.
/// </summary>
internal interface IModGlobalDataPersistence
{
    FarmhandExecutionJournalState? Read(string key);

    bool TryWrite(string key, FarmhandExecutionJournalState state);
}

/// <summary>
/// The write lease one global-data key may have, claimed by the adapter that owns the file rather than by the journal.
///
/// <para>
/// WHY IT EXISTS. <see cref="FarmhandExecutionJournal.KeyFor"/> names the document a save's journal lives in, and two
/// live game processes on the same machine can name the same document. Last-writer-wins is not an acceptable answer for
/// a durable execution record: whatever the second process wrote would be silently overwritten by the first, and neither
/// would ever know. The claim is the operating system's own cross-process handle - the same guarantee
/// <c>WindowsBodyProgramJournalStore.TryHoldScopeLease</c> takes for the Body Program journal - held for the adapter's
/// lifetime and released when the process ends, so a crashed owner never becomes a permanent refusal.
/// </para>
///
/// <para>
/// IT IS A SEPARATE INTERFACE so a test double that never claims anything is not forced to fake an OS handle, while
/// production must implement it: <c>SmapiGlobalDataPersistence</c> does, and a persistence that does not is treated as
/// the only writer of its key (which a single-process fixture is).
/// </para>
/// </summary>
internal interface IModGlobalDataKeyLease
{
    /// <summary>
    /// Claims <paramref name="key"/> for the lifetime of this adapter. Answers false with
    /// <paramref name="ownedByAnotherProcess"/> set when another live process holds it.
    /// </summary>
    bool TryClaim(string key, out bool ownedByAnotherProcess);
}

/// <summary>
/// Explicit, ingress-owned argument shapes. The journal intentionally accepts
/// this value rather than a wire request or an arbitrary JSON object. Future
/// ingress code is responsible for constructing the canonical shape once.
/// </summary>
internal enum FarmhandCanonicalArgumentKind
{
    None = 0,
    Tile = 1,
    Slot = 2,
    TargetTile = 3,
    ItemTargetTile = 4,
    SlotTargetTile = 5,
    SlotItemTargetTile = 6,
    NavigationDestination = 7,
    Emote = 8,
    Direction = 9,
}

/// <summary>
/// Canonical request data owned by the Mod boundary. Only fields represented by
/// <see cref="ArgumentKind"/> may be populated; no extension data is retained.
/// Coordinates and slots are already normalized integer values.
/// </summary>
internal sealed record FarmhandCanonicalRequest(
    string ActionId,
    FarmhandCanonicalArgumentKind ArgumentKind,
    int? X = null,
    int? Y = null,
    int? Slot = null,
    string? ExpectedQualifiedItemId = null,
    string? ExpectedTargetId = null,
    string? DestinationKind = null,
    string? DestinationLabel = null,
    string? DestinationReference = null,
    string? Emote = null,
    string? Direction = null)
{
    internal static FarmhandCanonicalRequest NoArguments(string actionId) =>
        new(actionId, FarmhandCanonicalArgumentKind.None);

    internal static FarmhandCanonicalRequest Tile(string actionId, int x, int y) =>
        new(actionId, FarmhandCanonicalArgumentKind.Tile, X: x, Y: y);

    internal static FarmhandCanonicalRequest ForSlot(string actionId, int slot) =>
        new(actionId, FarmhandCanonicalArgumentKind.Slot, Slot: slot);

    internal static FarmhandCanonicalRequest TargetTile(string actionId, int x, int y, string targetId) =>
        new(actionId, FarmhandCanonicalArgumentKind.TargetTile, X: x, Y: y, ExpectedTargetId: targetId);

    internal static FarmhandCanonicalRequest ItemTargetTile(string actionId, int x, int y, string targetId, string qualifiedItemId) =>
        new(actionId, FarmhandCanonicalArgumentKind.ItemTargetTile, X: x, Y: y, ExpectedQualifiedItemId: qualifiedItemId, ExpectedTargetId: targetId);

    internal static FarmhandCanonicalRequest SlotTargetTile(string actionId, int slot, int x, int y, string targetId) =>
        new(actionId, FarmhandCanonicalArgumentKind.SlotTargetTile, X: x, Y: y, Slot: slot, ExpectedTargetId: targetId);

    internal static FarmhandCanonicalRequest SlotItemTargetTile(string actionId, int slot, int x, int y, string targetId, string qualifiedItemId) =>
        new(actionId, FarmhandCanonicalArgumentKind.SlotItemTargetTile, X: x, Y: y, Slot: slot, ExpectedQualifiedItemId: qualifiedItemId, ExpectedTargetId: targetId);

    internal static FarmhandCanonicalRequest NavigationDestination(string actionId, string kind, string? label, string? reference) =>
        new(actionId, FarmhandCanonicalArgumentKind.NavigationDestination, DestinationKind: kind, DestinationLabel: label, DestinationReference: reference);

    internal static FarmhandCanonicalRequest EmoteRequest(string actionId, string emote) =>
        new(actionId, FarmhandCanonicalArgumentKind.Emote, Emote: emote);

    internal static FarmhandCanonicalRequest DirectionRequest(string actionId, string direction) =>
        new(actionId, FarmhandCanonicalArgumentKind.Direction, Direction: direction);

    /// <summary>
    /// The canonical form of one execution request, or none when its wire arguments are not a shape the journal can
    /// express.
    ///
    /// THIS IS THE DURABLE-ADMISSION POPULATION, and it is the request's OWN DECLARED SHAPE rather than a list of
    /// action ids. <c>FarmhandExecutionAcceptance.TryValidate</c> has already refused any request carrying an argument
    /// its catalogue row does not declare, so "this request carries a destination / emote / direction" and "this is a
    /// catalogue row that declares one" are one statement, held in the descriptor.
    ///
    /// <see cref="BridgeSession.TryExecute"/> reads this for three decisions that each spelled the same three ids
    /// before it existed: whether a replay can be answered from the journal, whether a journal answer other than
    /// `receipt_not_found` is this request's refusal, and whether the request is durably admitted before dispatch.
    /// </summary>
    internal static bool TryCreate(BridgeExecutionRequest request, out FarmhandCanonicalRequest canonical)
    {
        if (request.Args.Destination is { } destination)
        {
            canonical = NavigationDestination(request.Action, destination.Kind, destination.Label, destination.Ref);
            return true;
        }

        if (request.Args.Emote is { } emote)
        {
            canonical = EmoteRequest(request.Action, emote);
            return true;
        }

        if (request.Args.Direction is { } direction)
        {
            canonical = DirectionRequest(request.Action, direction);
            return true;
        }

        canonical = null!;
        return false;
    }
}

/// <summary>Immutable dispatch facts supplied when an action is admitted.</summary>
internal sealed record FarmhandExecutionAdmission(
    BridgeScope Scope,
    string RequestId,
    string IdempotencyKey,
    string ActionId,
    FarmhandCanonicalRequest Request,
    long ExpectedRevision,
    long DeadlineMs,
    string ExecutionId);

/// <summary>
/// The bounded receipt shape retained by the Mod journal. Action identity is
/// repeated here so a terminal update can be checked independently of its
/// selected record and can never silently change action lineage.
/// </summary>
internal sealed record FarmhandExecutionReceipt(
    string ExecutionId,
    string RequestId,
    string ActionId,
    ExecutionState State,
    string ReasonCode,
    long Revision,
    string? Evidence,
    BridgeLocalObservation? Observation = null);

internal enum FarmhandExecutionJournalRecordState
{
    AcceptedOrPending = 1,
    TerminalSettled = 2,
}

/// <summary>One durable scoped execution record.</summary>
internal sealed record FarmhandExecutionJournalRecord(
    BridgeScope Scope,
    string RequestId,
    string IdempotencyKey,
    string ActionId,
    FarmhandCanonicalRequest Request,
    long ExpectedRevision,
    long DeadlineMs,
    string ExecutionId,
    FarmhandExecutionJournalRecordState State,
    FarmhandExecutionReceipt? Receipt);

/// <summary>
/// Versioned global-data payload. A null record list is malformed; an empty
/// list is the valid initial journal state after a successful write.
/// </summary>
internal sealed record FarmhandExecutionJournalState(
    int SchemaVersion,
    IReadOnlyList<FarmhandExecutionJournalRecord>? Records);

internal enum FarmhandExecutionJournalResultCode
{
    Succeeded,
    NotFound,
    PersistenceReadFailed,
    PersistenceWriteFailed,
    MalformedState,
    VersionMismatch,
    DuplicateRecord,
    CapacityExceeded,
    InvalidAdmission,
    ScopeMismatch,
    RequestMismatch,
    IdempotencyMismatch,
    ImmutableTupleMismatch,
    ReceiptMismatch,
    IllegalStateTransition,

    /// <summary>
    /// Another live process holds this save's journal document (<see cref="IModGlobalDataKeyLease"/>), so no reading of
    /// it here would be authority and no write of it could avoid overwriting that process's records.
    /// </summary>
    JournalKeyOwnedByAnotherProcess,
}

/// <summary>
/// The one wire spelling of a journal result code.
///
/// <para>
/// A reason code is lowercase ASCII with <c>_</c>/<c>:</c>/<c>-</c> (<see cref="BridgeProtocol.IsReasonCode"/>), so
/// the C# member name is not itself sayable on the wire. The name is therefore derived from the member - one authority,
/// no table that could list thirteen codes and forget the fourteenth - and both the receipt funnel and the admission jam
/// refuse with the same sentence.
/// </para>
/// </summary>
internal static class FarmhandExecutionJournalResultCodeNames
{
    internal static string WireCode(FarmhandExecutionJournalResultCode code)
    {
        string name = code.ToString();
        var builder = new StringBuilder(name.Length + 4);
        for (int index = 0; index < name.Length; index++)
        {
            char character = name[index];
            if (index > 0 && char.IsUpper(character))
                builder.Append('_');
            builder.Append(char.ToLowerInvariant(character));
        }

        return builder.ToString();
    }
}

/// <summary>
/// Typed journal outcome. Every failure carries a null record, including
/// persistence failures and key/scope mismatches.
/// </summary>
internal readonly record struct FarmhandExecutionJournalResult<T>(
    FarmhandExecutionJournalResultCode Code,
    T? Record)
    where T : class
{
    internal bool IsSuccess => this.Code == FarmhandExecutionJournalResultCode.Succeeded && this.Record is not null;

    internal static FarmhandExecutionJournalResult<T> Success(T record) =>
        new(FarmhandExecutionJournalResultCode.Succeeded, record);

    internal static FarmhandExecutionJournalResult<T> Failure(FarmhandExecutionJournalResultCode code) =>
        new(code, null);
}

/// <summary>
/// Private Mod-owned durable execution journal. Mod composition supplies the
/// global-data adapter; only Navigation ingress and receipt publication consume
/// it in the current vertical slice. The complete payload is reloaded and
/// validated before it becomes execution authority - once per document per
/// journal instance, since this journal is the only writer of that document - and
/// a write that does not land drops that reading rather than serving it.
/// </summary>
internal sealed class FarmhandExecutionJournal
{
    internal const int SchemaVersion = 1;
    internal const int MaximumRecords = 1024;

    /// <summary>
    /// The document name's fixed prefix. The name carries the SAVE IDENTITY (<see cref="KeyFor"/>), because the records
    /// in it are one world's executions: the app-global name this replaces (`…-journal-v1`) held every record of every
    /// save the Mod had ever been played in, so it could not say which world an admitted request belonged to, it grew
    /// with actions that were not this save's, and two game processes shared one document. The old key is NOT read and
    /// there is no migration: a payload that cannot name its world is not authority.
    /// </summary>
    internal const string KeyPrefix = "GameBuddy.farmhand-execution-journal-v2";

    /// <summary>The one spelling of "which document does this world's journal live in".</summary>
    internal static string KeyFor(BridgeScope scope) => $"{KeyPrefix}.{scope.SaveId}";

    /// <summary>
    /// The record ceiling one save's journal keeps before it drops the records a replay could not need.
    ///
    /// <para>
    /// THE MEASUREMENTS IT IS CHOSEN FROM. One whole-payload write cost 8.27 ms at the 1,182,257 B / 738-record payload
    /// `round99` left behind, and two writes (admission + terminal, the pair every world-changing action performs) cost
    /// 17.22 ms at a 332,429 B / 256-record one - so at these sizes the file flush dominates the write and the ceiling
    /// does NOT buy a cheaper flush. What it buys, measured, is everything that scales with the bytes: the read was
    /// 32.77 ms at 1.14 MB (deserialize + validate), it is what a restart pays before its first action, and the document
    /// can no longer grow into <see cref="MaximumRecords"/>, where capacity FAILS CLOSED and no drain exists to rescue it
    /// - a session that filled it was one that could not admit another action for the rest of its life.
    /// </para>
    /// </summary>
    internal const int RetainedRecords = 256;

    private readonly IModGlobalDataPersistence persistence;
    private readonly object gate = new();

    /// <summary>
    /// The payload of each document this instance has read or written successfully, by
    /// <see cref="KeyFor"/> - <c>null</c> for a document it has not touched yet, and dropped whenever a write to it does
    /// not land.
    /// </summary>
    private readonly Dictionary<string, FarmhandExecutionJournalState> validated = new(StringComparer.Ordinal);

    internal FarmhandExecutionJournal(IModGlobalDataPersistence persistence, Action<string>? report = null)
    {
        this.persistence = persistence ?? throw new ArgumentNullException(nameof(persistence));
        this.report = report;
    }

    /// <summary>Where a drain's own line goes. Null in every test that does not ask for one, which keeps the suite quiet.</summary>
    private readonly Action<string>? report;

    /// <summary>Records the most recent drain removed, so a caller can observe the compaction rather than infer it.</summary>
    internal int LastDrainedRecords { get; private set; }

    /// <summary>Loads one exact record, whether it is pending or terminal.</summary>
    internal FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord> TryLoadAdmission(
        BridgeScope scope,
        string requestId,
        string idempotencyKey)
    {
        return this.TryLookup(scope, requestId, idempotencyKey);
    }

    /// <summary>
    /// Durably records a new accepted-or-pending admission. The first native
    /// body must not be started from a failed result.
    /// </summary>
    internal FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord> TryRecordAdmission(
        FarmhandExecutionAdmission admission)
    {
        lock (this.gate)
        {
            FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord>? invalid = ValidateAdmissionResult(admission);
            if (invalid is not null)
                return invalid.Value;

            StateLoadResult loaded = this.ReadValidatedState(admission.Scope);
            if (loaded.Code != FarmhandExecutionJournalResultCode.Succeeded)
                return FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord>.Failure(loaded.Code);

            IReadOnlyList<FarmhandExecutionJournalRecord> records = loaded.State!.Records!;
            FarmhandExecutionJournalRecord? exact = FindExact(records, admission.Scope, admission.RequestId, admission.IdempotencyKey);
            if (exact is not null)
                return FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord>.Failure(FarmhandExecutionJournalResultCode.DuplicateRecord);
            if (records.Any(record => SameScope(record.Scope, admission.Scope)
                && string.Equals(record.RequestId, admission.RequestId, StringComparison.Ordinal)))
            {
                return FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord>.Failure(FarmhandExecutionJournalResultCode.RequestMismatch);
            }
            if (records.Any(record => SameScope(record.Scope, admission.Scope)
                && string.Equals(record.IdempotencyKey, admission.IdempotencyKey, StringComparison.Ordinal)))
            {
                return FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord>.Failure(FarmhandExecutionJournalResultCode.IdempotencyMismatch);
            }
            // A BOUNDED COLLECTION NEEDS A DRAIN, and this one is rewritten whole on every admission and every terminal,
            // so the drain is what keeps ONE action's cost from scaling with the session's history. It runs here - the
            // only place the payload grows - and it drops only records a replay could not need (`IsReplayNoOp`); what it
            // keeps is what a recovery has to read.
            IReadOnlyList<FarmhandExecutionJournalRecord> retained = Drained(records, out int dropped);
            if (dropped > 0)
            {
                this.LastDrainedRecords = dropped;
                this.report?.Invoke(
                    $"[journal-drain] key={KeyFor(admission.Scope)};dropped={dropped};retained={retained.Count}"
                    + $";ceiling={RetainedRecords};reason=replay_is_a_no_op");
            }

            // Never evict a terminal receipt or pending admission: doing so could
            // turn a later response-loss retry into a second native execution.
            // Capacity exhaustion therefore fails closed until an owning product
            // lifecycle introduces an explicit, recovery-safe archival boundary.
            if (retained.Count >= MaximumRecords)
            {
                return FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord>.Failure(
                    FarmhandExecutionJournalResultCode.CapacityExceeded);
            }

            FarmhandExecutionJournalRecord record = new(
                admission.Scope,
                admission.RequestId,
                admission.IdempotencyKey,
                admission.ActionId,
                admission.Request,
                admission.ExpectedRevision,
                admission.DeadlineMs,
                admission.ExecutionId,
                FarmhandExecutionJournalRecordState.AcceptedOrPending,
                null);
            FarmhandExecutionJournalState next = NewState(retained.Append(record));
            return this.TryPersist(KeyFor(admission.Scope), next, record);
        }
    }

    /// <summary>
    /// Persists one monotonic receipt transition against the complete immutable
    /// admission tuple. It never changes scope, request, idempotency, action,
    /// canonical arguments, revision, deadline, or execution identity.
    /// </summary>
    internal FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord> TryPersistReceiptTransition(
        FarmhandExecutionAdmission admission,
        FarmhandExecutionReceipt receipt)
    {
        lock (this.gate)
        {
            FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord>? invalidAdmission = ValidateAdmissionResult(admission);
            if (invalidAdmission is not null)
                return invalidAdmission.Value;
            if (!ValidateReceipt(receipt))
            {
                return FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord>.Failure(
                    FarmhandExecutionJournalResultCode.ReceiptMismatch);
            }

            StateLoadResult loaded = this.ReadValidatedState(admission.Scope);
            if (loaded.Code != FarmhandExecutionJournalResultCode.Succeeded)
                return FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord>.Failure(loaded.Code);

            IReadOnlyList<FarmhandExecutionJournalRecord> records = loaded.State!.Records!;
            FarmhandExecutionJournalRecord? current = FindExact(records, admission.Scope, admission.RequestId, admission.IdempotencyKey);
            if (current is null)
            {
                return FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord>.Failure(
                    ClassifyMissingRecord(records, admission.Scope, admission.RequestId, admission.IdempotencyKey));
            }
            if (!SameImmutableTuple(current, admission))
            {
                return FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord>.Failure(
                    FarmhandExecutionJournalResultCode.ImmutableTupleMismatch);
            }
            if (!string.Equals(receipt.ExecutionId, current.ExecutionId, StringComparison.Ordinal)
                || !string.Equals(receipt.RequestId, current.RequestId, StringComparison.Ordinal)
                || !string.Equals(receipt.ActionId, current.ActionId, StringComparison.Ordinal))
            {
                return FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord>.Failure(
                    FarmhandExecutionJournalResultCode.ReceiptMismatch);
            }
            if (current.State == FarmhandExecutionJournalRecordState.TerminalSettled
                || !IsAllowedTransition(current.Receipt?.State, receipt.State))
            {
                return FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord>.Failure(
                    FarmhandExecutionJournalResultCode.IllegalStateTransition);
            }

            FarmhandExecutionJournalRecord updated = current with
            {
                State = receipt.State.IsTerminal()
                    ? FarmhandExecutionJournalRecordState.TerminalSettled
                    : FarmhandExecutionJournalRecordState.AcceptedOrPending,
                Receipt = receipt,
            };
            FarmhandExecutionJournalState next = NewState(records.Select(record =>
                ReferenceEquals(record, current) ? updated : record));
            return this.TryPersist(KeyFor(admission.Scope), next, updated);
        }
    }

    /// <summary>Performs an exact read-only scope/request/idempotency lookup.</summary>
    internal FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord> TryLookup(
        BridgeScope scope,
        string requestId,
        string idempotencyKey)
    {
        lock (this.gate)
        {
            if (!IsValidScope(scope) || !IsValidId(requestId) || !IsValidId(idempotencyKey))
            {
                return FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord>.Failure(
                    FarmhandExecutionJournalResultCode.InvalidAdmission);
            }

            StateLoadResult loaded = this.ReadValidatedState(scope);
            if (loaded.Code != FarmhandExecutionJournalResultCode.Succeeded)
                return FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord>.Failure(loaded.Code);

            IReadOnlyList<FarmhandExecutionJournalRecord> records = loaded.State!.Records!;
            FarmhandExecutionJournalRecord? record = FindExact(records, scope, requestId, idempotencyKey);
            return record is not null
                ? FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord>.Success(record)
                : FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord>.Failure(
                    ClassifyMissingRecord(records, scope, requestId, idempotencyKey));
        }
    }

    private FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord> TryPersist(
        string key,
        FarmhandExecutionJournalState state,
        FarmhandExecutionJournalRecord record)
    {
        using GameThreadCost.SeamScope write = new(GameThreadCost.JournalWriteSeam);
        bool written;
        try
        {
            written = this.persistence.TryWrite(key, state);
        }
        catch (Exception)
        {
            this.validated.Remove(key);
            return FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord>.Failure(
                FarmhandExecutionJournalResultCode.PersistenceWriteFailed);
        }

        // THE CACHE IS WHAT IS ON DISK, OR NOTHING. A payload that did not land never becomes the authority a later
        // operation reads, so a failed write drops the cached document and the next operation loads it again.
        if (written)
            this.validated[key] = state;
        else
            this.validated.Remove(key);
        return written
            ? FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord>.Success(record)
            : FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord>.Failure(
                FarmhandExecutionJournalResultCode.PersistenceWriteFailed);
    }

    /// <summary>
    /// The validated payload of <paramref name="scope"/>'s document: read and validated ONCE per document, then served
    /// from <see cref="validated"/>, which is only ever what this journal's own last successful write put there.
    ///
    /// <para>
    /// WHY IT IS CACHED. Reloading and revalidating the complete payload on every operation made the cost of an action
    /// proportional to the session's accumulated history: measured `round99`, a `navigate_to_destination` read the whole
    /// 1.14 MB / 738-record payload and then rewrote it on the game thread, 32.77 ms of it in the read alone. The payload
    /// cannot change without this journal writing it - the document is this save's own key, written nowhere else and
    /// gated by <see cref="gate"/>, and a second process holding the key is refused by
    /// <see cref="IModGlobalDataKeyLease"/> before this point - so re-reading it mid-dispatch answered a question the
    /// previous write had already answered.
    /// </para>
    /// </summary>
    private StateLoadResult ReadValidatedState(BridgeScope scope)
    {
        string key = KeyFor(scope);
        if (this.validated.TryGetValue(key, out FarmhandExecutionJournalState? cached))
            return new StateLoadResult(cached, FarmhandExecutionJournalResultCode.Succeeded);

        // ONE WRITER PER KEY, OR NONE. The adapter owns the document; if another live process holds it, no read of this
        // one is authority and no write may race it - the request is refused by name instead of losing the other
        // process's records on the next whole-payload rewrite.
        if (this.persistence is IModGlobalDataKeyLease lease && !lease.TryClaim(key, out bool ownedByAnotherProcess))
        {
            return new StateLoadResult(
                null,
                ownedByAnotherProcess
                    ? FarmhandExecutionJournalResultCode.JournalKeyOwnedByAnotherProcess
                    : FarmhandExecutionJournalResultCode.PersistenceReadFailed);
        }

        using GameThreadCost.SeamScope read = new(GameThreadCost.JournalReadSeam);
        FarmhandExecutionJournalState? persisted;
        try
        {
            persisted = this.persistence.Read(key);
        }
        catch (Exception)
        {
            return new StateLoadResult(null, FarmhandExecutionJournalResultCode.PersistenceReadFailed);
        }

        if (persisted is null)
            return new StateLoadResult(NewState(Array.Empty<FarmhandExecutionJournalRecord>()), FarmhandExecutionJournalResultCode.Succeeded);
        if (persisted.SchemaVersion != SchemaVersion)
            return new StateLoadResult(null, FarmhandExecutionJournalResultCode.VersionMismatch);
        if (persisted.Records is null)
            return new StateLoadResult(null, FarmhandExecutionJournalResultCode.MalformedState);
        if (persisted.Records.Count > MaximumRecords)
            return new StateLoadResult(null, FarmhandExecutionJournalResultCode.CapacityExceeded);

        FarmhandExecutionJournalRecord[] records;
        try
        {
            records = persisted.Records.ToArray();
        }
        catch (Exception)
        {
            return new StateLoadResult(null, FarmhandExecutionJournalResultCode.MalformedState);
        }

        foreach (FarmhandExecutionJournalRecord? record in records)
        {
            if (!ValidateRecord(record))
                return new StateLoadResult(null, FarmhandExecutionJournalResultCode.MalformedState);
        }

        // TWO RECORDS ARE THE SAME EXECUTION when they share the scope and either identity, so the population is keyed
        // by those two identities as it is walked - once. The pairwise form this replaces compared every record with
        // every other one (1024 records = 523,776 comparisons), which is a cost per read rather than a check per record.
        HashSet<(BridgeScope Scope, string Id)> requestIds = new();
        HashSet<(BridgeScope Scope, string Id)> idempotencyKeys = new();
        foreach (FarmhandExecutionJournalRecord record in records)
        {
            if (!requestIds.Add((record.Scope, record.RequestId))
                || !idempotencyKeys.Add((record.Scope, record.IdempotencyKey)))
            {
                return new StateLoadResult(null, FarmhandExecutionJournalResultCode.DuplicateRecord);
            }
        }

        this.validated[key] = NewState(records);
        return new StateLoadResult(this.validated[key], FarmhandExecutionJournalResultCode.Succeeded);
    }

    private static FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord>? ValidateAdmissionResult(
        FarmhandExecutionAdmission admission)
    {
        return ValidateAdmission(admission)
            ? null
            : FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord>.Failure(
                FarmhandExecutionJournalResultCode.InvalidAdmission);
    }

    private static bool ValidateAdmission(FarmhandExecutionAdmission? admission)
    {
        return admission is not null
            && IsValidScope(admission.Scope)
            && IsValidId(admission.RequestId)
            && IsValidId(admission.IdempotencyKey)
            && IsValidId(admission.ActionId)
            && IsValidId(admission.ExecutionId)
            && admission.ExpectedRevision >= 0
            && admission.DeadlineMs > 0
            && ValidateCanonicalRequest(admission.Request)
            && string.Equals(admission.ActionId, admission.Request.ActionId, StringComparison.Ordinal);
    }

    private static bool ValidateRecord(FarmhandExecutionJournalRecord? record)
    {
        if (record is null
            || !IsValidScope(record.Scope)
            || !IsValidId(record.RequestId)
            || !IsValidId(record.IdempotencyKey)
            || !IsValidId(record.ActionId)
            || !IsValidId(record.ExecutionId)
            || record.ExpectedRevision < 0
            || record.DeadlineMs <= 0
            || !ValidateCanonicalRequest(record.Request)
            || !string.Equals(record.ActionId, record.Request.ActionId, StringComparison.Ordinal)
            || !Enum.IsDefined(record.State))
        {
            return false;
        }

        if (record.Receipt is not null && (!ValidateReceipt(record.Receipt)
            || !string.Equals(record.Receipt.ExecutionId, record.ExecutionId, StringComparison.Ordinal)
            || !string.Equals(record.Receipt.RequestId, record.RequestId, StringComparison.Ordinal)
            || !string.Equals(record.Receipt.ActionId, record.ActionId, StringComparison.Ordinal)))
        {
            return false;
        }

        return record.State switch
        {
            FarmhandExecutionJournalRecordState.AcceptedOrPending => record.Receipt is null || !record.Receipt.State.IsTerminal(),
            FarmhandExecutionJournalRecordState.TerminalSettled => record.Receipt is not null && record.Receipt.State.IsTerminal(),
            _ => false,
        };
    }

    /// <summary>
    /// How long one receipt's evidence may be before this journal refuses it. It is a RECEIPT bound, and the one the
    /// Host's own reader restates (`MAX_ACTION_RECEIPT_EVIDENCE_LENGTH`) because it is the number the producer enforces.
    /// A detail that reaches it has evidence of the wrong shape, not a bound that should move: `shop_purchase` printed
    /// one diagnostic entry per unit bought until a 25-seed purchase was 5,059 characters.
    /// </summary>
    internal const int MaximumReceiptEvidenceLength = 4096;

    private static bool ValidateReceipt(FarmhandExecutionReceipt? receipt)
    {
        return receipt is not null
            && IsValidId(receipt.ExecutionId)
            && IsValidId(receipt.RequestId)
            && IsValidId(receipt.ActionId)
            && Enum.IsDefined(receipt.State)
            && IsValidReasonCode(receipt.ReasonCode)
            && receipt.Revision >= 0
            && (receipt.Evidence is null || receipt.Evidence.Length <= MaximumReceiptEvidenceLength)
            && ValidateObservation(receipt.Observation);
    }

    private static bool ValidateObservation(BridgeLocalObservation? observation)
    {
        if (observation is null)
            return true;
        return observation.Location is { Length: >= 0 and <= 128 }
            && observation.TileX >= 0
            && observation.TileY >= 0
            && observation.Facing is >= 0 and <= 3
            && observation.InGameTime is { Length: 4 }
            && observation.Revision >= 0;
    }

    private static bool ValidateCanonicalRequest(FarmhandCanonicalRequest? request)
    {
        if (request is null || !IsValidId(request.ActionId) || !Enum.IsDefined(request.ArgumentKind))
            return false;

        bool valid = request.ArgumentKind switch
        {
            FarmhandCanonicalArgumentKind.None => HasNoArguments(request),
            FarmhandCanonicalArgumentKind.Tile => HasTile(request) && request.Slot is null
                && request.ExpectedQualifiedItemId is null && request.ExpectedTargetId is null,
            FarmhandCanonicalArgumentKind.Slot => request.Slot is >= 0 and <= 36
                && request.X is null && request.Y is null && request.ExpectedQualifiedItemId is null && request.ExpectedTargetId is null,
            FarmhandCanonicalArgumentKind.TargetTile => HasTile(request) && IsValidId(request.ExpectedTargetId)
                && request.Slot is null && request.ExpectedQualifiedItemId is null,
            FarmhandCanonicalArgumentKind.ItemTargetTile => HasTile(request) && IsValidId(request.ExpectedTargetId)
                && IsValidId(request.ExpectedQualifiedItemId) && request.Slot is null,
            FarmhandCanonicalArgumentKind.SlotTargetTile => HasTile(request) && request.Slot is >= 0 and <= 36
                && IsValidId(request.ExpectedTargetId) && request.ExpectedQualifiedItemId is null,
            FarmhandCanonicalArgumentKind.SlotItemTargetTile => HasTile(request) && request.Slot is >= 0 and <= 36
                && IsValidId(request.ExpectedTargetId) && IsValidId(request.ExpectedQualifiedItemId),
            FarmhandCanonicalArgumentKind.NavigationDestination => ValidateDestination(request),
            FarmhandCanonicalArgumentKind.Emote => ValidateEmote(request),
            FarmhandCanonicalArgumentKind.Direction => ValidateDirection(request),
            _ => false,
        };
        return valid;
    }

    private static bool HasNoArguments(FarmhandCanonicalRequest request) =>
        request.X is null && request.Y is null && request.Slot is null
        && request.ExpectedQualifiedItemId is null && request.ExpectedTargetId is null
        && request.DestinationKind is null && request.DestinationLabel is null && request.DestinationReference is null
        && request.Emote is null && request.Direction is null;

    private static bool HasTile(FarmhandCanonicalRequest request) =>
        request.X is >= 0 && request.Y is >= 0
        && request.DestinationKind is null && request.DestinationLabel is null && request.DestinationReference is null
        && request.Emote is null && request.Direction is null;

    private static bool ValidateDestination(FarmhandCanonicalRequest request)
    {
        if (request.X is not null || request.Y is not null || request.Slot is not null
            || request.ExpectedQualifiedItemId is not null || request.ExpectedTargetId is not null
            || request.DestinationKind is null || request.Emote is not null || request.Direction is not null)
        {
            return false;
        }

        return request.DestinationKind switch
        {
            "label" => request.DestinationLabel is { Length: >= 1 and <= 128 }
                && request.DestinationReference is null,
            "ref" => request.DestinationLabel is null && IsValidId(request.DestinationReference),
            _ => false,
        };
    }

    private static bool ValidateEmote(FarmhandCanonicalRequest request)
    {
        return request.Emote is not null
            && FarmhandActionCatalog.EmoteEnum.Contains(request.Emote)
            && request.X is null && request.Y is null && request.Slot is null
            && request.ExpectedQualifiedItemId is null && request.ExpectedTargetId is null
            && request.DestinationKind is null && request.DestinationLabel is null && request.DestinationReference is null
            && request.Direction is null;
    }

    private static bool ValidateDirection(FarmhandCanonicalRequest request)
    {
        return request.Direction is not null
            && FarmhandActionCatalog.DirectionEnum.Contains(request.Direction)
            && request.X is null && request.Y is null && request.Slot is null
            && request.ExpectedQualifiedItemId is null && request.ExpectedTargetId is null
            && request.DestinationKind is null && request.DestinationLabel is null && request.DestinationReference is null
            && request.Emote is null;
    }

    private static bool SameImmutableTuple(
        FarmhandExecutionJournalRecord record,
        FarmhandExecutionAdmission admission)
    {
        return SameScope(record.Scope, admission.Scope)
            && string.Equals(record.RequestId, admission.RequestId, StringComparison.Ordinal)
            && string.Equals(record.IdempotencyKey, admission.IdempotencyKey, StringComparison.Ordinal)
            && string.Equals(record.ActionId, admission.ActionId, StringComparison.Ordinal)
            && Equals(record.Request, admission.Request)
            && record.ExpectedRevision == admission.ExpectedRevision
            && record.DeadlineMs == admission.DeadlineMs
            && string.Equals(record.ExecutionId, admission.ExecutionId, StringComparison.Ordinal);
    }

    private static bool IsAllowedTransition(ExecutionState? current, ExecutionState next)
    {
        if (!Enum.IsDefined(next))
            return false;
        int nextRank = ReceiptRank(next);
        if (current is null)
            return true;
        return nextRank > ReceiptRank(current.Value);
    }

    private static int ReceiptRank(ExecutionState state) => state switch
    {
        ExecutionState.Accepted => 0,
        ExecutionState.Running => 1,
        ExecutionState.MeaningfulProgress => 2,
        _ when state.IsTerminal() => 3,
        _ => -1,
    };

    private static FarmhandExecutionJournalRecord? FindExact(
        IReadOnlyList<FarmhandExecutionJournalRecord> records,
        BridgeScope scope,
        string requestId,
        string idempotencyKey)
    {
        return records.FirstOrDefault(record => SameScope(record.Scope, scope)
            && string.Equals(record.RequestId, requestId, StringComparison.Ordinal)
            && string.Equals(record.IdempotencyKey, idempotencyKey, StringComparison.Ordinal));
    }

    private static FarmhandExecutionJournalResultCode ClassifyMissingRecord(
        IReadOnlyList<FarmhandExecutionJournalRecord> records,
        BridgeScope scope,
        string requestId,
        string idempotencyKey)
    {
        if (records.Any(record => string.Equals(record.RequestId, requestId, StringComparison.Ordinal)
            && string.Equals(record.IdempotencyKey, idempotencyKey, StringComparison.Ordinal)
            && !SameScope(record.Scope, scope)))
        {
            return FarmhandExecutionJournalResultCode.ScopeMismatch;
        }
        if (records.Any(record => SameScope(record.Scope, scope)
            && string.Equals(record.RequestId, requestId, StringComparison.Ordinal)))
        {
            return FarmhandExecutionJournalResultCode.IdempotencyMismatch;
        }
        if (records.Any(record => SameScope(record.Scope, scope)
            && string.Equals(record.IdempotencyKey, idempotencyKey, StringComparison.Ordinal)))
        {
            return FarmhandExecutionJournalResultCode.RequestMismatch;
        }
        return FarmhandExecutionJournalResultCode.NotFound;
    }

    private static FarmhandExecutionJournalState NewState(IEnumerable<FarmhandExecutionJournalRecord> records) =>
        new(SchemaVersion, new ReadOnlyCollection<FarmhandExecutionJournalRecord>(records.ToArray()));

    /// <summary>
    /// The records left after dropping the OLDEST ones a replay could not need, down to <see cref="RetainedRecords"/>.
    /// Order is the payload's, so a drain never reorders what it keeps.
    /// </summary>
    private static IReadOnlyList<FarmhandExecutionJournalRecord> Drained(
        IReadOnlyList<FarmhandExecutionJournalRecord> records,
        out int dropped)
    {
        dropped = 0;
        int surplus = records.Count - RetainedRecords;
        if (surplus <= 0)
            return records;

        var retained = new List<FarmhandExecutionJournalRecord>(records.Count);
        foreach (FarmhandExecutionJournalRecord record in records)
        {
            if (surplus > 0 && IsReplayNoOp(record))
            {
                surplus--;
                dropped++;
                continue;
            }

            retained.Add(record);
        }

        return retained;
    }

    /// <summary>
    /// Whether dropping this record could cost a retry anything.
    ///
    /// <para>
    /// TWO THINGS MAY GO. A gesture's record, because its action cannot change the world and re-executing it is the same
    /// visible outcome (`ActionsThatChangeNothing` is the authority and states the native reason for each); and a settled
    /// `succeeded` record, because the receipt says the change happened and the world it named is the world a retry would
    /// observe anyway. NOTHING ELSE: a record whose native effect landed without its terminal write has no receipt, and
    /// that is exactly what a recovery reads; an `Uncertain`, `Blocked` or `Failed` settlement is the only statement that
    /// something may have happened and nobody can say what; a rejection is kept, because a retry of it must be answered the
    /// same way rather than dispatched again.
    /// </para>
    /// </summary>
    private static bool IsReplayNoOp(FarmhandExecutionJournalRecord record)
    {
        if (record.Receipt is not { } receipt || !receipt.State.IsTerminal())
            return false;
        if (!FarmhandActionCatalog.ChangesTheWorld(record.ActionId))
            return true;
        return receipt.State == ExecutionState.Succeeded;
    }

    private static bool SameScope(BridgeScope left, BridgeScope right) => left.Equals(right);

    private static bool IsValidScope(BridgeScope? scope) => scope is not null && scope.IsValid;

    private static bool IsValidId(string? value) => value is not null && value.Length is >= 1 and <= 128 && value.All(character =>
        (character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z')
        || (character >= '0' && character <= '9') || character is '_' or '-');

    // Internal rather than private so the Mod's own test project can assert an emitted reason
    // code against the validator that will judge it, instead of against a second copy of the
    // pattern that could drift from this one.
    internal static bool IsValidReasonCode(string? value) => value is not null && value.Length is >= 1 and <= 128 && value.All(character =>
        (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z')
        || (character >= '0' && character <= '9') || character is '_' or '-' or ':');

    private readonly record struct StateLoadResult(
        FarmhandExecutionJournalState? State,
        FarmhandExecutionJournalResultCode Code);
}
