using System.Collections.ObjectModel;
using GameBuddy.Stardew.Core.Models;

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
    string? DestinationReference = null)
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
    string? Evidence);

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
/// it in the current vertical slice. Every operation reloads and validates the
/// complete payload so an invalid, stale-version, or duplicate payload never
/// becomes execution authority.
/// </summary>
internal sealed class FarmhandExecutionJournal
{
    internal const int SchemaVersion = 1;
    internal const int MaximumRecords = 1024;
    internal const string GlobalDataKey = "GameBuddy.farmhand-execution-journal-v1";

    private readonly IModGlobalDataPersistence persistence;
    private readonly object gate = new();

    internal FarmhandExecutionJournal(IModGlobalDataPersistence persistence)
    {
        this.persistence = persistence ?? throw new ArgumentNullException(nameof(persistence));
    }

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

            StateLoadResult loaded = this.ReadValidatedState();
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
            // Never evict a terminal receipt or pending admission: doing so could
            // turn a later response-loss retry into a second native execution.
            // Capacity exhaustion therefore fails closed until an owning product
            // lifecycle introduces an explicit, recovery-safe archival boundary.
            if (records.Count >= MaximumRecords)
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
            FarmhandExecutionJournalState next = NewState(records.Append(record));
            return this.TryPersist(next, record);
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

            StateLoadResult loaded = this.ReadValidatedState();
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
                State = IsTerminal(receipt.State)
                    ? FarmhandExecutionJournalRecordState.TerminalSettled
                    : FarmhandExecutionJournalRecordState.AcceptedOrPending,
                Receipt = receipt,
            };
            FarmhandExecutionJournalState next = NewState(records.Select(record =>
                ReferenceEquals(record, current) ? updated : record));
            return this.TryPersist(next, updated);
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

            StateLoadResult loaded = this.ReadValidatedState();
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
        FarmhandExecutionJournalState state,
        FarmhandExecutionJournalRecord record)
    {
        bool written;
        try
        {
            written = this.persistence.TryWrite(GlobalDataKey, state);
        }
        catch (Exception)
        {
            return FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord>.Failure(
                FarmhandExecutionJournalResultCode.PersistenceWriteFailed);
        }

        return written
            ? FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord>.Success(record)
            : FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord>.Failure(
                FarmhandExecutionJournalResultCode.PersistenceWriteFailed);
    }

    private StateLoadResult ReadValidatedState()
    {
        FarmhandExecutionJournalState? persisted;
        try
        {
            persisted = this.persistence.Read(GlobalDataKey);
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
        for (int index = 0; index < records.Length; index++)
        {
            for (int other = index + 1; other < records.Length; other++)
            {
                if (SameScope(records[index].Scope, records[other].Scope)
                    && (string.Equals(records[index].RequestId, records[other].RequestId, StringComparison.Ordinal)
                        || string.Equals(records[index].IdempotencyKey, records[other].IdempotencyKey, StringComparison.Ordinal)))
                {
                    return new StateLoadResult(null, FarmhandExecutionJournalResultCode.DuplicateRecord);
                }
            }
        }

        return new StateLoadResult(NewState(records), FarmhandExecutionJournalResultCode.Succeeded);
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
            FarmhandExecutionJournalRecordState.AcceptedOrPending => record.Receipt is null || !IsTerminal(record.Receipt.State),
            FarmhandExecutionJournalRecordState.TerminalSettled => record.Receipt is not null && IsTerminal(record.Receipt.State),
            _ => false,
        };
    }

    private static bool ValidateReceipt(FarmhandExecutionReceipt? receipt)
    {
        return receipt is not null
            && IsValidId(receipt.ExecutionId)
            && IsValidId(receipt.RequestId)
            && IsValidId(receipt.ActionId)
            && Enum.IsDefined(receipt.State)
            && IsValidReasonCode(receipt.ReasonCode)
            && receipt.Revision >= 0
            && (receipt.Evidence is null || receipt.Evidence.Length <= 4096);
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
            _ => false,
        };
        return valid;
    }

    private static bool HasNoArguments(FarmhandCanonicalRequest request) =>
        request.X is null && request.Y is null && request.Slot is null
        && request.ExpectedQualifiedItemId is null && request.ExpectedTargetId is null
        && request.DestinationKind is null && request.DestinationLabel is null && request.DestinationReference is null;

    private static bool HasTile(FarmhandCanonicalRequest request) =>
        request.X is >= 0 && request.Y is >= 0
        && request.DestinationKind is null && request.DestinationLabel is null && request.DestinationReference is null;

    private static bool ValidateDestination(FarmhandCanonicalRequest request)
    {
        if (request.X is not null || request.Y is not null || request.Slot is not null
            || request.ExpectedQualifiedItemId is not null || request.ExpectedTargetId is not null
            || request.DestinationKind is null)
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
        _ when IsTerminal(state) => 3,
        _ => -1,
    };

    private static bool IsTerminal(ExecutionState state) => state is not (
        ExecutionState.Accepted or ExecutionState.Running or ExecutionState.MeaningfulProgress);

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

    private static bool SameScope(BridgeScope left, BridgeScope right) => left.Equals(right);

    private static bool IsValidScope(BridgeScope? scope) => scope is not null && scope.IsValid;

    private static bool IsValidId(string? value) => value is not null && value.Length is >= 1 and <= 128 && value.All(character =>
        (character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z')
        || (character >= '0' && character <= '9') || character is '_' or '-');

    private static bool IsValidReasonCode(string? value) => value is not null && value.Length is >= 1 and <= 128 && value.All(character =>
        (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z')
        || (character >= '0' && character <= '9') || character is '_' or '-' or ':');

    private readonly record struct StateLoadResult(
        FarmhandExecutionJournalState? State,
        FarmhandExecutionJournalResultCode Code);
}
