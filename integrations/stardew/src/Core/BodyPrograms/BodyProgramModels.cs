using System.Collections.ObjectModel;
using System.Text.Json;
using System.Text.Json.Serialization;
using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew.Core.BodyPrograms;

/// <summary>Opaque projection of the Mod publication identity and its independent capability revision.</summary>
public sealed record BodyProgramPolicyIdentity(string Value, long CapabilityRevision)
{
    [JsonIgnore]
    public bool IsValid => BodyProgramValidation.IsOpaquePolicyValue(this.Value) && this.CapabilityRevision >= 0;
}

#pragma warning disable CA1720 // Wire-level scalar-kind tokens intentionally name JSON scalar types.
public enum BodyProgramArgumentKind { Integer = 1, String = 2, Boolean = 3, DestinationSelector = 4, DestinationArrival = 5 }
#pragma warning restore CA1720
public sealed record BodyProgramArgumentDescriptor(string Name, BodyProgramArgumentKind Kind);
public sealed record BodyProgramFactDescriptor(string Name, BodyProgramArgumentKind Kind);
/// <summary>
/// What a <see cref="BodyProgramResourceTemplateClaim"/> materializes to. <see cref="ToolAnyUpgrade"/> and
/// <see cref="ToolBasicOnly"/> are the upgrade-level half of a `tool:&lt;category&gt;` claim: the category is in the
/// claim KEY (the resource identity the journal conflicts on), the level requirement is here.
/// </summary>
public enum BodyProgramResourceTemplateValue { ScopePlayer = 1, ActionId = 2, ToolAnyUpgrade = 3, ToolBasicOnly = 4 }
public sealed record BodyProgramResourceTemplateClaim(string Key, BodyProgramResourceTemplateValue Value);

/// <summary>Mod registration projection used to verify candidates; it is the only action membership source for this Core slice.</summary>
/// <summary>Canonical descriptor metadata retained opaquely by the Body Program catalog.</summary>
public sealed record BodyProgramActionMetadata(string Lifecycle, string OperationKind, string Effect, string Postcondition);

/// <summary>
/// Mod-owned action descriptor. <see cref="WatchdogMs"/> is the descriptor-owned
/// static execution budget for ordinary short actions; the Mod derives a fresh
/// absolute deadline from it at admission time. Agent-authored candidates never
/// carry a clock field (watchdog governing authority; see open-gameplay-release).
/// </summary>
public sealed record BodyProgramActionDescriptor(string ActionId, int IdentityVersion, IReadOnlyList<BodyProgramArgumentDescriptor> Arguments,
    IReadOnlyList<BodyProgramFactDescriptor> OutputFacts, IReadOnlyList<BodyProgramResourceTemplateClaim> ResourceTemplate,
    BodyProgramActionMetadata? Metadata = null, long WatchdogMs = 60000);

public sealed class BodyProgramActionCatalog
{
    private readonly IReadOnlyDictionary<string, BodyProgramActionDescriptor> actions;
    public BodyProgramActionCatalog(long revision, IEnumerable<BodyProgramActionDescriptor> actions)
    {
        if (revision < 0 || actions is null) throw new ArgumentException("Catalog is malformed.");
        Dictionary<string, BodyProgramActionDescriptor> copied = new(StringComparer.Ordinal);
        foreach (BodyProgramActionDescriptor action in actions)
            if (!BodyProgramValidation.IsValidActionDescriptor(action) || !copied.TryAdd(action.ActionId, BodyProgramValidation.FreezeActionDescriptor(action)))
                throw new ArgumentException("Catalog contains an invalid action descriptor.", nameof(actions));
        this.Revision = revision;
        this.actions = new ReadOnlyDictionary<string, BodyProgramActionDescriptor>(copied);
    }
    public long Revision { get; }
    public bool TryGetAction(string actionId, out BodyProgramActionDescriptor? action) => this.actions.TryGetValue(actionId, out action);
}

public sealed record BodyProgramDestinationSelector(
    string Kind,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Label,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? Ref);
public sealed record BodyProgramArrivalDestination(
    string Label,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? ContextLabel);
public sealed record BodyProgramDestinationArrival(string Reason, BodyProgramArrivalDestination Destination);

/// <summary>Exact Host value. Scalar values retain canonicalValue; typed values retain their object payload.</summary>
public sealed record BodyProgramRuntimeValue(
    string Type,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? CanonicalValue = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] BodyProgramDestinationSelector? Destination = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] BodyProgramDestinationArrival? Arrival = null);
/// <summary>Mod-owned canonical value, produced only after descriptor-aware decoding.</summary>
public sealed record BodyProgramCanonicalValue(
    BodyProgramArgumentKind Kind,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? CanonicalValue = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] BodyProgramDestinationSelector? Destination = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] BodyProgramDestinationArrival? Arrival = null);

/// <summary>Strict Host transport candidate. Program-level deadline and resources are deliberately absent from the frozen wire contract.</summary>
public sealed record ActionProgramCandidate(string ProgramId, IReadOnlyList<ActionProgramCandidateNode> Nodes);
public sealed record ActionProgramCandidateNode(string NodeId, string ActionId, IReadOnlyDictionary<string, BodyProgramRuntimeValue> Arguments,
    IReadOnlyList<string> DependsOn, IReadOnlyDictionary<string, ActionProgramBinding> Bindings);
public sealed record ActionProgramBinding(string ProducerNodeId, string FactName);

public enum BodyProgramDiagnosticSeverity { Error = 1 }

/// <summary>
/// The failed precondition named by a refusal, in the same vocabulary the argument refusals already use. One spelling per
/// concept, because a caller that has to match several spellings of "the tool is not equipped" cannot act on either.
/// </summary>
public static class BodyProgramFailedPrecondition
{
    /// <summary>The submission itself is malformed (program identity, node count, node identity or shape).</summary>
    public const string ProgramShape = "program_shape";
    /// <summary>The node names an action that no published/live-verified execution registration projects.</summary>
    public const string ActionRegistration = "action_registration";
    /// <summary>The action is registered but the live action policy on this snapshot does not enable it.</summary>
    public const string LiveActionPolicy = "live_action_policy";
    /// <summary>The node's declared arguments do not match the descriptor's own argument contract.</summary>
    public const string ArgumentShape = "argument_shape";
    /// <summary>The dependency graph is malformed (duplicate/unknown/self edge, or a cycle).</summary>
    public const string DependencyGraph = "dependency_graph";
    /// <summary>A declared fact binding cannot be resolved to a producer fact of the claimed kind.</summary>
    public const string FactBinding = "fact_binding";
    /// <summary>Two nodes claim the same resource without depending on each other.</summary>
    public const string ResourceClaim = "resource_claim";
    /// <summary>The authority's journal or policy identity cannot accept this submission.</summary>
    public const string AuthorityState = "authority_state";
}

/// <summary>
/// One preflight refusal. <see cref="Code"/> is the machine reason code (already the one the wire carries) and
/// <see cref="NodeId"/> is the node it names; the last three fields are the cause, in the same spirit as the argument
/// refusals: WHICH precondition failed, what was expected, and what was actually observed. A refusal that leaves these
/// null is a refusal a caller can only guess about, which is the defect this shape exists to close.
/// </summary>
public sealed record BodyProgramDiagnostic(
    BodyProgramDiagnosticSeverity Severity,
    string Code,
    string? NodeId,
    string Path,
    string Message,
    string? FailedPrecondition = null,
    string? Expected = null,
    string? Actual = null)
{
    /// <summary>
    /// The canonical, machine-parseable rendering of the cause that rides INSIDE the wire's existing `message`
    /// field. It is a separate method, not a second field, because `BridgeBodyProgramDiagnostic` has an exact-key
    /// boundary that both sides validate: adding keys would make every refusal unreadable to a reader that predates
    /// them. So the cause is rendered the way the argument refusals already render theirs (`missing [...]` lives in
    /// the message too), and `expected=`/`actual=` remain greppable without a schema change.
    /// </summary>
    public string WireMessage => this.FailedPrecondition is null
        ? this.Message
        : $"{this.Message} failed_precondition={this.FailedPrecondition} expected={this.Expected ?? "unspecified"} actual={this.Actual ?? "unspecified"}";
}
public sealed record BodyProgramVerificationReport(bool Accepted, long CatalogRevision, ActionProgramCandidate? CanonicalProgram, IReadOnlyList<BodyProgramDiagnostic> Diagnostics);
public enum BodyProgramSubmitCode { Accepted, Rejected, Idempotent, Conflict, PersistenceFailure, Quarantined }
public sealed record BodyProgramSubmitResult(BodyProgramSubmitCode Code, BodyProgramVerificationReport Verification, BodyProgramStatusSnapshot? Snapshot);

public enum BodyProgramState { Active = 1, Succeeded = 2, Failed = 3, Cancelled = 4, RecoveryRequired = 5, Quarantined = 6 }
public enum BodyProgramNodeState
    {
        Pending = 1,
        AwaitingHostAdmission = 2,
        HostAdmitted = 3,
        Running = 4,
        Succeeded = 5,
        Failed = 6,
        Cancelled = 7,
        RecoveryRequired = 8,
        Rejected = 9,
        SkippedDependency = 10,
        /// <summary>
        /// Dispatched, and its outcome can never be determined. Terminal, durable value 11 (ADR-006 amendment).
        ///
        /// Why it exists: a node whose outcome cannot be determined is settled as RecoveryRequired, which makes the whole
        /// authority non-mutable - every later submission for that save answered Quarantined/authority_unavailable, for ever,
        /// with no path out. The settlement states ignorance honestly, but ignorance must not be a life sentence. This state
        /// records "this WAS dispatched (attempt and binding retained) and the truth will never be known", so the program can
        /// end as Failed and the save scope becomes writable again.
        /// </summary>
        Abandoned = 11,
    }
public enum BodyProgramNodeOutcome { Succeeded = 1, Failed = 2, Cancelled = 3, Uncertain = 4 }
public enum BodyProgramClaimOwnershipState { NotAcquired = 1, Acquired = 2, Released = 3 }

/// <summary>Immutable action dispatch lineage, bound to one exact accepted node attempt.</summary>
public sealed record NodeExecutionBinding(string ProgramId, string NodeId, int NodeAttempt, string RequestId, string IdempotencyKey, string ExecutionId);
/// <summary>Action-owned terminal input. Successful results require receipt, evidence, and postcondition verification projections.</summary>
public sealed record BodyProgramTerminalResult(NodeExecutionBinding Execution, BodyProgramNodeOutcome Outcome, IReadOnlyList<RuntimeFact>? Facts,
    string? ReceiptId, string? Evidence, string? PostconditionVerification);

public sealed record VerifiedBodyProgramNode(string NodeId, string ActionId, IReadOnlyDictionary<string, BodyProgramCanonicalValue> CanonicalArguments,
    IReadOnlyList<string> DependsOn, IReadOnlyDictionary<string, ActionProgramBinding> Bindings, IReadOnlyDictionary<string, string> DerivedResourceClaims);
public sealed record VerifiedBodyProgram(string ProgramId, long CatalogRevision, IReadOnlyList<VerifiedBodyProgramNode> Nodes);

/// <summary>Exact diagnostic projection for one accepted node attempt. Claim
/// ownership records the Mod-owned fresh-acquire (HostAdmitted) and release
/// (terminal settle) transitions; see OpenBodyProgramJournalAuthority.</summary>
public sealed record BodyProgramJournalNode(string NodeId, BodyProgramNodeState State, int NodeAttempt, int AdmissionAttempt, string? GrantId,
    NodeExecutionBinding? ExecutionBinding,
    IReadOnlyDictionary<string, BodyProgramCanonicalValue>? CanonicalBoundArguments = null,
    BodyProgramPolicyIdentity? AttemptPolicyIdentity = null,
    IReadOnlyDictionary<string, BodyProgramClaimOwnershipState>? ClaimOwnership = null,
    long? DerivedDeadlineMs = null,
    string? ReceiptId = null,
    string? Evidence = null,
    string? PostconditionVerification = null,
    string? RecoveryDiagnostic = null,
    string? RejectionCode = null);
public sealed record RuntimeFact(string ProgramId, string NodeId, int NodeAttempt, string FactName, IReadOnlyDictionary<string, BodyProgramCanonicalValue> Values);
public sealed record BodyProgramJournalProgram(VerifiedBodyProgram Program, BodyProgramState State, long StopEpoch, IReadOnlyList<BodyProgramJournalNode> Nodes, IReadOnlyList<RuntimeFact> Facts);
/// <summary>Addressed event projection. CatalogRevision is persisted at the event, never guessed by an adapter.</summary>
public sealed record BodyProgramJournalEvent(long Cursor, string ProgramId, string Kind, long CatalogRevision, string? NodeId, int? NodeAttempt);
public sealed record BodyProgramJournalState(int SchemaVersion, BridgeScope Scope, BodyProgramPolicyIdentity PolicyIdentity, long EventHighWater,
    IReadOnlyList<BodyProgramJournalProgram> Programs, IReadOnlyList<BodyProgramJournalEvent> Events);
public sealed record BodyProgramStatusSnapshot(string ProgramId, BodyProgramState State, long CatalogRevision, long StopEpoch, long EventHighWater, IReadOnlyList<BodyProgramJournalNode> Nodes);
public enum BodyProgramQueryCode { Found, NotFound, InvalidInput }
public sealed record BodyProgramStatusResult(BodyProgramQueryCode Code, BodyProgramStatusSnapshot? Snapshot);
public sealed record BodyProgramEventsResult(string ProgramId, BodyProgramQueryCode Code, IReadOnlyList<BodyProgramJournalEvent> Events, long NextCursor, long HighWater);

public sealed record NodeAdmissionChallenge(string ProgramId, string NodeId, int NodeAttempt, int AdmissionAttempt, long StopEpoch, long CatalogRevision,
    BodyProgramPolicyIdentity PolicyIdentity, string ActionId, IReadOnlyDictionary<string, BodyProgramCanonicalValue> CanonicalArguments,
    IReadOnlyDictionary<string, string> DerivedResourceClaims, long DeadlineMs);
public sealed record HostAdmissionGrant(string ProgramId, string NodeId, int NodeAttempt, int AdmissionAttempt, long StopEpoch, long CatalogRevision,
    BodyProgramPolicyIdentity PolicyIdentity, string ActionId, IReadOnlyDictionary<string, BodyProgramCanonicalValue> CanonicalArguments,
    IReadOnlyDictionary<string, string> DerivedResourceClaims, long DeadlineMs, string GrantId, string AttachmentGeneration, string PolicyRevision, NodeExecutionBinding? ExecutionBinding = null);

public abstract record BodyNodeAdmissionResult;
public sealed record BodyNodeAdmissionGrantedResult(HostAdmissionGrant Grant) : BodyNodeAdmissionResult;
public sealed record BodyNodeAdmissionRejectedResult(NodeAdmissionChallenge Challenge, string Code) : BodyNodeAdmissionResult;
public sealed record BodyNodeAdmissionUnavailableResult(NodeAdmissionChallenge Challenge) : BodyNodeAdmissionResult;

public enum BodyProgramJournalReadStatus { Empty, Present, ReadFailed }
public sealed record BodyProgramJournalReadResult(BodyProgramJournalReadStatus Status, string? Payload);
public interface IBodyProgramJournalStore { BodyProgramJournalReadResult Read(); bool TryWrite(string encodedState); }
public enum BodyProgramJournalOpenStatus { Empty, Opened, RecoveryRequired, Corrupt, PersistenceReadFailed, PersistenceWriteFailed }
public enum BodyProgramControllerResultCode { Succeeded, NotFound, InvalidInput, ProgramNotActive, NodeNotEligible, PolicyIdentityStale, GrantMismatch, ExecutionBindingMismatch, FactProvenanceMismatch, InvalidFact, TerminalProofMissing, RecoveryRequired, PersistenceWriteFailed, DeadlineExpired }
public readonly record struct BodyProgramControllerResult<T>(BodyProgramControllerResultCode Code, T? Value) where T : class { public bool IsSuccess => this.Code == BodyProgramControllerResultCode.Succeeded && this.Value is not null; }
public static class BodyProgramControllerResult { public static BodyProgramControllerResult<T> Success<T>(T value) where T : class => new(BodyProgramControllerResultCode.Succeeded, value); public static BodyProgramControllerResult<T> Failure<T>(BodyProgramControllerResultCode code) where T : class => new(code, null); }

internal static class BodyProgramValidation
{
    internal const int MaximumNodes = 16;
    internal const long MaximumJavaScriptSafeInteger = 9007199254740991L;
    /// <summary>Descriptor-owned static watchdog budget for ordinary short actions (hang protection, not ETA).</summary>
    internal const long DefaultWatchdogMs = 60_000;
    internal static bool IsValidWatchdogMs(long value) => value is > 0 and <= MaximumJavaScriptSafeInteger;
    internal static bool IsValidDerivedDeadlineMs(long? value) => value is not null and > 0 and <= MaximumJavaScriptSafeInteger;
    internal static bool IsIdentifier(string? value) => value is { Length: >= 1 and <= 128 } && value.All(c => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c is '_' or '-');
    /// <summary>
    /// A resource-claim key: one or more lowercase identifier segments joined by `:`, so `embodied_actor` and
    /// `tool:scythe` are the same shape and a future subject (`inventory:seed_maker`) needs no new rule. The colon is
    /// admitted here and not by widening <see cref="IsIdentifier"/>, because that rule also guards program, node,
    /// request and argument identities that must never carry one. Anything outside the shape is refused, never
    /// silently normalized: the key IS the resource identity the journal conflicts on, so a re-spelled key would
    /// collide two resources that are not the same.
    /// </summary>
    internal static bool IsResourceClaimKey(string? value)
    {
        if (value is null || value.Length > 128) return false;
        int segmentStart = 0;
        for (int index = 0; index <= value.Length; index++)
        {
            if (index != value.Length && value[index] != ':') continue;
            if (index == segmentStart) return false;
            for (int position = segmentStart; position < index; position++)
            {
                char character = value[position];
                if (!((character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character == '_')) return false;
            }
            segmentStart = index + 1;
        }
        return true;
    }
    internal static bool IsValidExecutionBinding(NodeExecutionBinding? value) => value is not null
        && IsIdentifier(value.ProgramId) && IsIdentifier(value.NodeId) && value.NodeAttempt > 0
        && IsIdentifier(value.RequestId) && IsIdentifier(value.IdempotencyKey) && IsIdentifier(value.ExecutionId);
    internal static bool IsOpaqueTerminalProof(string? value) => value is { Length: >= 1 and <= 4096 } && !value.Any(char.IsControl);
    internal static bool IsOpaqueDiagnostic(string? value) => value is { Length: >= 1 and <= 4096 } && !value.Any(char.IsControl);
    internal static bool IsOpaquePolicyValue(string? value) => value is { Length: >= 1 and <= 4096 } && !value.Any(char.IsControl);
    internal static bool IsValidRejectionCode(string? value) => value is "policy_denied" or "deadline_expired" or "resource_conflict" or "catalog_stale"
        or "schema_rejected" or "scope_mismatch" or "stop_epoch_closed" or "policy_identity_mismatch";
    internal static bool IsValidActionDescriptor(BodyProgramActionDescriptor? action) => action is not null && IsIdentifier(action.ActionId) && action.IdentityVersion > 0
        && (action.Metadata is null || IsOpaqueDescriptorMetadata(action.Metadata))
        && IsValidWatchdogMs(action.WatchdogMs)
        && action.Arguments is { Count: <= 32 } && action.OutputFacts is { Count: <= 32 } && action.ResourceTemplate is { Count: <= 16 }
        && action.Arguments.All(argument => argument is not null && IsIdentifier(argument.Name) && Enum.IsDefined(argument.Kind) && argument.Kind != BodyProgramArgumentKind.DestinationArrival)
        && action.OutputFacts.All(fact => fact is not null && IsIdentifier(fact.Name) && Enum.IsDefined(fact.Kind) && fact.Kind != BodyProgramArgumentKind.DestinationSelector)
        && action.ResourceTemplate.All(claim => claim is not null && IsResourceClaimKey(claim.Key) && Enum.IsDefined(claim.Value))
        && action.Arguments.Select(argument => argument.Name).Distinct(StringComparer.Ordinal).Count() == action.Arguments.Count
        && action.OutputFacts.Select(fact => fact.Name).Distinct(StringComparer.Ordinal).Count() == action.OutputFacts.Count
        && action.ResourceTemplate.Select(claim => claim.Key).Distinct(StringComparer.Ordinal).Count() == action.ResourceTemplate.Count;
    internal static bool IsOpaqueDescriptorMetadata(BodyProgramActionMetadata? metadata) => metadata is not null
        && IsOpaqueMetadataValue(metadata.Lifecycle) && IsOpaqueMetadataValue(metadata.OperationKind)
        && IsOpaqueMetadataValue(metadata.Effect) && IsOpaqueMetadataValue(metadata.Postcondition);
    private static bool IsOpaqueMetadataValue(string? value) => value is { Length: >= 1 and <= 128 } && !value.Any(char.IsControl);
    internal static BodyProgramActionDescriptor FreezeActionDescriptor(BodyProgramActionDescriptor action) => new(action.ActionId, action.IdentityVersion,
        Array.AsReadOnly(action.Arguments.ToArray()), Array.AsReadOnly(action.OutputFacts.ToArray()), Array.AsReadOnly(action.ResourceTemplate.ToArray()), action.Metadata!, action.WatchdogMs);
    internal static IReadOnlyDictionary<T, U> FreezeMap<T, U>(IReadOnlyDictionary<T, U> values) where T : notnull => new ReadOnlyDictionary<T, U>(new Dictionary<T, U>(values));
    internal static bool TryDecodeRuntimeValue(BodyProgramRuntimeValue? value, BodyProgramArgumentKind kind, out BodyProgramCanonicalValue? canonical)
    {
        canonical = null;
        if (value is null || value.Type is not { Length: >= 1 and <= 64 }) return false;
        if (kind is BodyProgramArgumentKind.DestinationSelector)
        {
            if (value.Type != "destination_selector" || value.CanonicalValue is not null || value.Arrival is not null || !IsValidSelector(value.Destination)) return false;
            canonical = new(kind, null, value.Destination); return true;
        }
        if (kind is BodyProgramArgumentKind.DestinationArrival) return false;
        string expected = kind switch { BodyProgramArgumentKind.Integer => "integer", BodyProgramArgumentKind.String => "string", BodyProgramArgumentKind.Boolean => "boolean", _ => "" };
        if (value.Type != expected || value.CanonicalValue is null || value.CanonicalValue.Length > 512 || value.Destination is not null || value.Arrival is not null) return false;
        switch (kind)
        {
            case BodyProgramArgumentKind.Integer:
                if (!long.TryParse(value.CanonicalValue, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out long integer) || integer.ToString(System.Globalization.CultureInfo.InvariantCulture) != value.CanonicalValue) return false;
                break;
            case BodyProgramArgumentKind.Boolean: if (value.CanonicalValue is not ("true" or "false")) return false; break;
            case BodyProgramArgumentKind.String: break;
            default: return false;
        }
        canonical = new BodyProgramCanonicalValue(kind, value.CanonicalValue); return true;
    }
    internal static bool IsValidCanonicalValue(BodyProgramCanonicalValue? value, BodyProgramArgumentKind expected)
    {
        if (value is null || value.Kind != expected) return false;
        if (expected == BodyProgramArgumentKind.DestinationSelector) return value.CanonicalValue is null && value.Arrival is null && IsValidSelector(value.Destination);
        if (expected == BodyProgramArgumentKind.DestinationArrival) return value.CanonicalValue is null && value.Destination is null && IsValidArrival(value.Arrival);
        return TryDecodeRuntimeValue(new BodyProgramRuntimeValue(expected switch { BodyProgramArgumentKind.Integer => "integer", BodyProgramArgumentKind.String => "string", BodyProgramArgumentKind.Boolean => "boolean", _ => "" }, value.CanonicalValue), expected, out _);
    }
    internal static BodyProgramRuntimeValue ToRuntimeValue(BodyProgramCanonicalValue value) => value.Kind switch
    {
        BodyProgramArgumentKind.DestinationSelector => new("destination_selector", null, value.Destination),
        BodyProgramArgumentKind.DestinationArrival => throw new ArgumentException("Arrival values are output-only.", nameof(value)),
        _ => new(value.Kind switch { BodyProgramArgumentKind.Integer => "integer", BodyProgramArgumentKind.String => "string", BodyProgramArgumentKind.Boolean => "boolean", _ => throw new ArgumentOutOfRangeException(nameof(value)) }, value.CanonicalValue)
    };
    internal static bool IsValidSelector(BodyProgramDestinationSelector? selector) => selector is not null && ((selector.Kind == "label" && IsPlayerText(selector.Label) && selector.Ref is null) || (selector.Kind == "ref" && selector.Label is null && IsNavigationRef(selector.Ref)));
    internal static bool IsValidArrival(BodyProgramDestinationArrival? arrival)
    {
        if (arrival is null || (arrival.Reason is not ("destination_arrived" or "already_at_destination")) || arrival.Destination is null)
            return false;
        return IsPlayerText(arrival.Destination.Label)
            && (arrival.Destination.ContextLabel is null || IsPlayerText(arrival.Destination.ContextLabel));
    }
    private static bool IsPlayerText(string? value) => value is not null && value.Length is >= 1 and <= 128 && value.Trim().Length > 0 && value.Normalize(System.Text.NormalizationForm.FormC) == value;
    private static bool IsNavigationRef(string? value)
    {
        if (value is null || !value.StartsWith("dr1_", StringComparison.Ordinal) || value.Length != 26) return false;
        string encoded = value[4..];
        if (encoded.Any(c => !char.IsLetterOrDigit(c) && c is not '-' and not '_') || encoded[^1] is not ('A' or 'Q' or 'g' or 'w')) return false;
        Span<byte> bytes = stackalloc byte[16]; return Convert.TryFromBase64String(encoded.Replace('-', '+').Replace('_', '/') + "==", bytes, out int written) && written == 16;
    }
}
