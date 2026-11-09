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
    IReadOnlyList<string> DependsOn, IReadOnlyDictionary<string, ActionProgramBinding> Bindings)
{
    /// <summary>
    /// Predecessors this node must wait for WITHOUT consuming anything from them: it does not start before they are
    /// terminal, and it is NOT skipped when one of them fails.
    ///
    /// <para>
    /// <see cref="DependsOn"/> carried both meanings alone, and every published action claims <c>embodied_actor</c>, so the
    /// claim-ordering rule forced two independent steps into a chain - which made the second a dependent that a failure of
    /// the first skipped. Absent is the older meaning exactly (no ordering-only edges existed), so a 5-key node is not
    /// reinterpreted; present, this edge orders without feeding.
    /// </para>
    /// </summary>
    public IReadOnlyList<string> OrderedAfter { get; init; } = Array.Empty<string>();
}
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
/// <summary>
/// Action-owned terminal input. Successful results require receipt, evidence, and postcondition verification projections.
///
/// <para>
/// <see cref="FailureCode"/> is the receipt's own `ReasonCode` for a terminal that did NOT succeed - `door_out_of_range`,
/// `player_not_actionable`, `stamina_depleted`. It is deliberately NOT <see cref="Evidence"/>: ADR-006 defines evidence as
/// the projection component that licenses `succeeded` (`:175`), so a node that claims no effect must not carry it. The
/// reason is a third, disjoint statement ("why nothing happened") and lives in its own field, exactly as the ADR already
/// decided for `Rejected`/`RejectionCode` (`:163`, "the code is not free-form text").
/// </para>
/// </summary>
public sealed record BodyProgramTerminalResult(NodeExecutionBinding Execution, BodyProgramNodeOutcome Outcome, IReadOnlyList<RuntimeFact>? Facts,
    string? ReceiptId, string? Evidence, string? PostconditionVerification, string? FailureCode = null, string? Hint = null);

public sealed record VerifiedBodyProgramNode(string NodeId, string ActionId, IReadOnlyDictionary<string, BodyProgramCanonicalValue> CanonicalArguments,
    IReadOnlyList<string> DependsOn, IReadOnlyDictionary<string, ActionProgramBinding> Bindings, IReadOnlyDictionary<string, string> DerivedResourceClaims)
{
    /// <summary>
    /// The ordering-only predecessors of this node, persisted rather than derived.
    ///
    /// <para>
    /// The durable record is compared against a fresh candidate on every re-submission (<c>BodyProgramCanonical.
    /// CandidateEquals</c>), and `programId` is Host-chosen, so dropping this key would answer `Idempotent` for a
    /// different graph - or `Conflict` for the same one after a reload.
    /// </para>
    /// </summary>
    public IReadOnlyList<string> OrderedAfter { get; init; } = Array.Empty<string>();
}
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
    string? RejectionCode = null,
    /// <summary>
    /// Why a dispatched node settled without succeeding, in the action-owned receipt's own vocabulary. Legal only on
    /// <see cref="BodyProgramNodeState.Failed"/> and <see cref="BodyProgramNodeState.Cancelled"/>; null everywhere else.
    /// This is a reason, never proof of an effect - `ReceiptId`, `Evidence` and `PostconditionVerification` stay absent on
    /// those states (ADR-006 `:163`, `:175`), which is what makes it safe to carry.
    /// </summary>
    string? FailureCode = null,
    /// <summary>
    /// Where the caller can actually go, when the reason is "the target is unreachable".
    ///
    /// <para>
    /// A hint, not evidence: it claims nothing happened, names no receipt and proves no effect, so ADR-006's ban on
    /// evidence for a failed node (`:163`, `:175`) does not reach it - the same footing as <see cref="FailureCode"/>,
    /// which is why it carries the same state restriction.
    /// </para>
    /// <para>
    /// Measured 2026-11-01 (`round21`): nine `move_to_tile` refusals in Mountain arrived at the model as a bare
    /// `{"failureCode":"no_native_path"}`. The Mod had already computed 284 bytes of reachability evidence per refusal and
    /// thrown it away at the success-only `Evidence` assignment, and the one field that would have ended the loop - the
    /// closest tile the actor can actually reach - was in that evidence. Counted in the model's own session file:
    /// `component_tiles` 0, `target_enclosed` 0, `route_exists_cardinal` 0, `no_native_path` 26. The companion re-aimed at
    /// nine different coordinates because nothing in its input distinguished them.
    /// </para>
    /// <para>
    /// Bounded by <see cref="BodyProgramValidation.MaximumNodeHintLength"/>: `closest=49,14;closest_distance=1` is 33
    /// characters, and the ceiling leaves room for a longer form without letting a free-form string become a payload.
    /// </para>
    string? Hint = null);
public sealed record RuntimeFact(string ProgramId, string NodeId, int NodeAttempt, string FactName, IReadOnlyDictionary<string, BodyProgramCanonicalValue> Values);
public sealed record BodyProgramJournalProgram(VerifiedBodyProgram Program, BodyProgramState State, long StopEpoch, IReadOnlyList<BodyProgramJournalNode> Nodes, IReadOnlyList<RuntimeFact> Facts);

/// <summary>
/// One node's own work, kept BESIDE the durable journal node rather than inside it: the action it runs and the tile it
/// addressed.
///
/// <para>
/// Third instance of the same defect class as <see cref="BodyProgramJournalNode.FailureCode"/> and
/// <see cref="BodyProgramJournalNode.Hint"/>: the journal held the fact and the projection dropped it. Measured
/// 2026-11-08, a 48-minute run forked afterwards and asked what it had done answered "15 plan submissions, 0 tiles
/// tilled" against 143 submissions and ~20 tilled tiles. The action ids were in this journal the whole time; the only
/// program identity the model ever received was a `programId` inside an unprotected `plan_work` tool result, which a
/// context fold removes.
/// </para>
/// <para>
/// A SEPARATE row rather than three more fields on <see cref="BodyProgramJournalNode"/>: neither fact is journal state. The
/// action id lives on the program's compiled descriptor and the tile is a bounded reading of the canonical arguments the
/// Mod bound at admission, so copying them into the durable record would be a second spelling of facts the journal already
/// holds - and the persisted document would grow fields no writer ever sets.
/// </para>
/// </summary>
/// <param name="X">The tile's x, or null when this node's arguments name no tile. X and Y travel together or not at all.</param>
/// <param name="Y">The tile's y, beside <see cref="X"/>.</param>
public sealed record BodyProgramNodeWork(string NodeId, string ActionId, int? X, int? Y);
/// <summary>
/// Addressed event projection. CatalogRevision is persisted at the event, never guessed by an adapter.
///
/// <para>
/// <see cref="AtMs"/> is the moment the Mod appended this event, on the process's monotonic clock
/// (<see cref="BodyProgramJournalClock"/>) and NOT on the wall clock and NOT at the moment a Host read the frame: a
/// receipt that carried the reader's clock would measure the bridge instead of the game. It is therefore the moment the
/// native effect was DISPATCHED on a <c>native_dispatch</c> event and the moment it SETTLED on <c>node_completed</c> /
/// <c>node_settled</c>, which is what makes a node's execution time computable at all. Persisted with the event, so an
/// execution read back from the journal after a restart keeps its original stamp.
/// </para>
/// </summary>
public sealed record BodyProgramJournalEvent(long Cursor, string ProgramId, string Kind, long CatalogRevision, string? NodeId, int? NodeAttempt, long AtMs);
public sealed record BodyProgramJournalState(int SchemaVersion, BridgeScope Scope, BodyProgramPolicyIdentity PolicyIdentity, long EventHighWater,
    IReadOnlyList<BodyProgramJournalProgram> Programs, IReadOnlyList<BodyProgramJournalEvent> Events);
/// <summary>
/// One program as the journal reports it: its durable node records in <see cref="Nodes"/>, and one <see cref="Work"/> row per
/// node in the SAME order carrying what the durable record cannot say - which action the node runs, and which tile it
/// addressed.
/// </summary>
public sealed record BodyProgramStatusSnapshot(string ProgramId, BodyProgramState State, long CatalogRevision, long StopEpoch, long EventHighWater, IReadOnlyList<BodyProgramJournalNode> Nodes, IReadOnlyList<BodyProgramNodeWork> Work);
public enum BodyProgramQueryCode { Found, NotFound, InvalidInput }

/// <summary>
/// One `program_status` answer: by id (<see cref="Snapshot"/>) or, when the caller named no id, the journal's newest
/// programs (<see cref="Programs"/>).
///
/// <para>
/// <see cref="ProgramCount"/> is the journal's TOTAL program count on both paths, so a bounded page can be reported as
/// "read 8 of 143" instead of reading as an empty history. An absent id is not a second source of truth: it is the same
/// journal answering the only question a caller can still ask after a context fold, when it holds no id to name.
/// </para>
/// </summary>
public sealed record BodyProgramStatusResult(BodyProgramQueryCode Code, BodyProgramStatusSnapshot? Snapshot,
    IReadOnlyList<BodyProgramStatusSnapshot>? Programs = null, int ProgramCount = 0);
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
// `Code` is optional so an older Host that sends none still works, and present whenever the Host named a cause:
// five different failures used to share one word, which is why a run could spend a day retrying.
public sealed record BodyNodeAdmissionUnavailableResult(NodeAdmissionChallenge Challenge, string? Code = null) : BodyNodeAdmissionResult;

public enum BodyProgramJournalReadStatus { Empty, Present, ReadFailed }
public sealed record BodyProgramJournalReadResult(BodyProgramJournalReadStatus Status, string? Payload);

/// <summary>
/// An older journal that was set aside rather than read: the shape it was written in, and the lengths of what was in it.
///
/// <para>
/// Counts, not contents: the operation is published once so that "a fresh journal started" is a fact the operator can see,
/// while nothing of the old document becomes an input. The condition has no <see cref="BodyProgramJournalOpenStatus"/>
/// member on purpose - that enum is a WRITABILITY statement, and a superseded journal is writable.
/// </para>
/// </summary>
public sealed record BodyProgramJournalSupersede(int FromSchema, int DiscardedPrograms, long DiscardedNodes);

public interface IBodyProgramJournalStore
{
    BodyProgramJournalReadResult Read();

    /// <summary>
    /// Commits <paramref name="encodedState"/>. When <paramref name="replacedSiblingFileName"/> is given, the bytes this
    /// write REPLACES are kept under that name in the same commit, so a caller that is setting an unreadable record aside
    /// never leaves an instant in which neither exists.
    /// </summary>
    bool TryWrite(string encodedState, string? replacedSiblingFileName = null);
}
public enum BodyProgramJournalOpenStatus { Empty, Opened, RecoveryRequired, Corrupt, PersistenceReadFailed, PersistenceWriteFailed }
public enum BodyProgramControllerResultCode { Succeeded, NotFound, InvalidInput, ProgramNotActive, NodeNotEligible, PolicyIdentityStale, GrantMismatch, ExecutionBindingMismatch, FactProvenanceMismatch, InvalidFact, TerminalProofMissing, RecoveryRequired, PersistenceWriteFailed, DeadlineExpired }
public readonly record struct BodyProgramControllerResult<T>(BodyProgramControllerResultCode Code, T? Value) where T : class { public bool IsSuccess => this.Code == BodyProgramControllerResultCode.Succeeded && this.Value is not null; }
public static class BodyProgramControllerResult { public static BodyProgramControllerResult<T> Success<T>(T value) where T : class => new(BodyProgramControllerResultCode.Succeeded, value); public static BodyProgramControllerResult<T> Failure<T>(BodyProgramControllerResultCode code) where T : class => new(code, null); }

internal static class BodyProgramValidation
{
    /// <summary>
    /// The largest node count a journal this product could have written may declare.
    ///
    /// <para>
    /// A CORRUPTION BOUND, in the same class as `state.Programs.Count > 128` and `state.Events.Count > 4096` beside it in
    /// `TryValidate`: it refuses a decoded file that cannot be a journal this build produced. It was 16, which is not a
    /// corruption bound at all - a 16-node program is perfectly ordinary, so the reader was enforcing the writer's policy.
    /// </para>
    /// <para>
    /// MEASURED 2026-10-31: of 26 programs in one run, **eight were exactly 16 and none was larger**, and over 117
    /// historical `plan_work` calls 31 used `builder.isFull()` - the guard this number publishes to the model. A companion
    /// that can see 16 weeds and can only act on 16 of them never learns the field is bigger.
    /// </para>
    /// </summary>
    internal const int MaximumNodes = 256;
    /// <summary>
    /// How many programs a no-id `program_status` answers with, newest first.
    ///
    /// <para>
    /// A transport bound, not a product one: the answer names recent programs so a reader can pick an id out of it, and
    /// the journal's own total travels beside it as `programCount`, so a truncated page is visible rather than looking
    /// like a short history.
    /// </para>
    /// </summary>
    internal const int MaximumRecentPrograms = 8;
    /// <summary>
    /// The largest a node's actionable hint may be.
    ///
    /// <para>
    /// A BOUNDED ADVISORY, not free-form text. `closest=49,14;closest_distance=1` is 33 characters; 256 leaves room for a
    /// richer form without letting a hint become a second evidence channel. The value is checked on the write path and
    /// on the read-back path, so a journal carrying a longer one fails closed rather than reaching a model.
    /// </para>
    /// </summary>
    internal const int MaximumNodeHintLength = 256;
    internal static bool IsValidNodeHint(string? value) => value is null or { Length: <= MaximumNodeHintLength };
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
    /// <summary>
    /// The prefix of a rejection that names the loop ROW the live policy does not offer.
    ///
    /// <para>
    /// One spelling, because two gates say this sentence: the row gate at dispatch
    /// (<see cref="RouteReenteringBodyProgramExecutor"/>) and the Host's answer to one form's admission challenge. A
    /// rejection that named only the form would blame the wrong node - the form is not what the policy judged - and a
    /// rejection that said `policy_denied` would throw away the one part a caller can act on.
    /// </para>
    /// </summary>
    internal const string RowActionNotEnabledPrefix = "row_action_not_enabled:";
    /// <summary>
    /// The rejection codes the Host may answer one node's admission with.
    ///
    /// <para>
    /// The closed set is deliberate: a rejection is a durable veto against the node, so only words this product can
    /// honour are admitted. `RowActionNotEnabledPrefix` widens it by exactly one SENTENCE rather than by a free-form
    /// field - the prefix plus an action identifier the model already validates - because the Host can distinguish WHICH
    /// row of a loop the policy does not offer, and `policy_denied` would settle that node as a refusal the caller cannot
    /// act on. This is the ADR-006 amendment `FarmhandBodyProgramController` names where it declines to widen the set for
    /// `admission_unavailable`: those causes are properties of the ATTACHMENT; this one is a property of the node.
    /// </para>
    /// </summary>
    internal static bool IsValidRejectionCode(string? value) => value is "policy_denied" or "deadline_expired" or "resource_conflict" or "catalog_stale"
        or "schema_rejected" or "scope_mismatch" or "stop_epoch_closed" or "policy_identity_mismatch"
        || (value is not null && IsReasonCode(value) && value.StartsWith(RowActionNotEnabledPrefix, StringComparison.Ordinal)
            && IsIdentifier(value[RowActionNotEnabledPrefix.Length..]));
    /// <summary>
    /// The one spelling of the reason-code grammar on this side of the boundary: lowercase ASCII, digits, and `_`/`:`/`-`.
    ///
    /// <para>
    /// A failure reason is a machine code, not prose (ADR-006 `:163` says the same of `RejectionCode`), and this is also
    /// the grammar every wire reason code already uses - so <c>BridgeProtocol.IsReasonCode</c> delegates here rather than
    /// restating the character class a second time.
    /// </para>
    /// </summary>
    internal static bool IsReasonCode(string? value) => value is { Length: >= 1 and <= 128 } && value.All(character =>
        (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character is '_' or ':' or '-');
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
