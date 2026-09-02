using System.Collections.ObjectModel;
using System.Text.Json.Serialization;
using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew.Core.BodyPrograms;

/// <summary>Opaque live-capability generation minted by the Mod. It is never supplied by a candidate.</summary>
public sealed record BodyProgramPolicyIdentity(string EmbodimentId, long Generation)
{
    [JsonIgnore]
    public bool IsValid => BodyProgramValidation.IsIdentifier(this.EmbodimentId) && this.Generation >= 0;
}

#pragma warning disable CA1720 // Wire-level scalar-kind tokens intentionally name JSON scalar types.
public enum BodyProgramArgumentKind { Integer = 1, String = 2, Boolean = 3 }
#pragma warning restore CA1720
public sealed record BodyProgramArgumentDescriptor(string Name, BodyProgramArgumentKind Kind);
public sealed record BodyProgramFactDescriptor(string Name, BodyProgramArgumentKind Kind);
public enum BodyProgramResourceTemplateValue { ScopePlayer = 1, ActionId = 2 }
public sealed record BodyProgramResourceTemplateClaim(string Key, BodyProgramResourceTemplateValue Value);

/// <summary>Mod registration projection used to verify candidates; it is the only action membership source for this Core slice.</summary>
public sealed record BodyProgramActionDescriptor(string ActionId, int IdentityVersion, IReadOnlyList<BodyProgramArgumentDescriptor> Arguments,
    IReadOnlyList<BodyProgramFactDescriptor> OutputFacts, IReadOnlyList<BodyProgramResourceTemplateClaim> ResourceTemplate);

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

/// <summary>Exact Host wire value. Its type token and canonical string are decoded by the Mod, never treated as JSON.</summary>
public sealed record BodyProgramRuntimeValue(string Type, string CanonicalValue);
/// <summary>Mod-owned canonical scalar, produced only after descriptor-aware decoding.</summary>
public sealed record BodyProgramCanonicalValue(BodyProgramArgumentKind Kind, string CanonicalValue);

/// <summary>Strict Host transport candidate. Program-level deadline and resources are deliberately absent from the frozen wire contract.</summary>
public sealed record ActionProgramCandidate(string ProgramId, IReadOnlyList<ActionProgramCandidateNode> Nodes);
public sealed record ActionProgramCandidateNode(string NodeId, string ActionId, IReadOnlyDictionary<string, BodyProgramRuntimeValue> Arguments,
    IReadOnlyList<string> DependsOn, IReadOnlyDictionary<string, ActionProgramBinding> Bindings, long DeadlineMs);
public sealed record ActionProgramBinding(string ProducerNodeId, string FactName);

public enum BodyProgramDiagnosticSeverity { Error = 1 }
public sealed record BodyProgramDiagnostic(BodyProgramDiagnosticSeverity Severity, string Code, string? NodeId, string Path, string Message);
public sealed record BodyProgramVerificationReport(bool Accepted, long CatalogRevision, ActionProgramCandidate? CanonicalProgram, IReadOnlyList<BodyProgramDiagnostic> Diagnostics);
public enum BodyProgramSubmitCode { Accepted, Rejected, Idempotent, Conflict, PersistenceFailure, Quarantined }
public sealed record BodyProgramSubmitResult(BodyProgramSubmitCode Code, BodyProgramVerificationReport Verification, BodyProgramStatusSnapshot? Snapshot);

public enum BodyProgramState { Active = 1, Succeeded = 2, Failed = 3, Cancelled = 4, RecoveryRequired = 5, Quarantined = 6 }
public enum BodyProgramNodeState { Pending = 1, AwaitingHostAdmission = 2, HostAdmitted = 3, Running = 4, Succeeded = 5, Failed = 6, Cancelled = 7, RecoveryRequired = 8, Rejected = 9 }
public enum BodyProgramNodeOutcome { Succeeded = 1, Failed = 2, Cancelled = 3 }

public sealed record VerifiedBodyProgramNode(string NodeId, string ActionId, IReadOnlyDictionary<string, BodyProgramCanonicalValue> CanonicalArguments,
    IReadOnlyList<string> DependsOn, IReadOnlyDictionary<string, ActionProgramBinding> Bindings, IReadOnlyDictionary<string, string> DerivedResourceClaims, long DeadlineMs);
public sealed record VerifiedBodyProgram(string ProgramId, long CatalogRevision, IReadOnlyList<VerifiedBodyProgramNode> Nodes);

public sealed record BodyProgramJournalNode(string NodeId, BodyProgramNodeState State, int NodeAttempt, int AdmissionAttempt, string? GrantId);
public sealed record RuntimeFact(string ProgramId, string NodeId, int NodeAttempt, string FactName, IReadOnlyDictionary<string, BodyProgramCanonicalValue> Values);
public sealed record BodyProgramJournalProgram(VerifiedBodyProgram Program, BodyProgramState State, long StopEpoch, IReadOnlyList<BodyProgramJournalNode> Nodes, IReadOnlyList<RuntimeFact> Facts);
/// <summary>Addressed event projection. CatalogRevision is persisted at the event, never guessed by an adapter.</summary>
public sealed record BodyProgramJournalEvent(long Cursor, string ProgramId, string Kind, long CatalogRevision, string? NodeId, int? NodeAttempt);
public sealed record BodyProgramJournalState(int SchemaVersion, BridgeScope Scope, BodyProgramPolicyIdentity PolicyIdentity, long EventHighWater,
    IReadOnlyList<BodyProgramJournalProgram> Programs, IReadOnlyList<BodyProgramJournalEvent> Events);
public sealed record BodyProgramStatusSnapshot(string ProgramId, BodyProgramState State, long CatalogRevision, long StopEpoch, long EventHighWater, IReadOnlyList<BodyProgramJournalNode> Nodes);
public enum BodyProgramQueryCode { Found, NotFound, InvalidInput }
public sealed record BodyProgramStatusResult(BodyProgramQueryCode Code, BodyProgramStatusSnapshot? Snapshot);
public sealed record BodyProgramEventsResult(BodyProgramQueryCode Code, IReadOnlyList<BodyProgramJournalEvent> Events, long NextCursor, long HighWater);

public sealed record NodeAdmissionChallenge(string ProgramId, string NodeId, int NodeAttempt, int AdmissionAttempt, long StopEpoch, long CatalogRevision,
    BodyProgramPolicyIdentity PolicyIdentity, string ActionId, IReadOnlyDictionary<string, BodyProgramCanonicalValue> CanonicalArguments,
    IReadOnlyDictionary<string, string> DerivedResourceClaims, long DeadlineMs);
public sealed record HostAdmissionGrant(string ProgramId, string NodeId, int NodeAttempt, int AdmissionAttempt, long StopEpoch, long CatalogRevision,
    BodyProgramPolicyIdentity PolicyIdentity, string ActionId, IReadOnlyDictionary<string, BodyProgramCanonicalValue> CanonicalArguments,
    IReadOnlyDictionary<string, string> DerivedResourceClaims, long DeadlineMs, string GrantId);

public interface IBodyProgramJournalStore { string? Read(); bool TryWrite(string encodedState); }
public enum BodyProgramJournalOpenStatus { Empty, Opened, RecoveryRequired, Corrupt, PersistenceReadFailed, PersistenceWriteFailed }
public enum BodyProgramControllerResultCode { Succeeded, NotFound, InvalidInput, ProgramNotActive, NodeNotEligible, PolicyIdentityStale, GrantMismatch, FactProvenanceMismatch, InvalidFact, RecoveryRequired, PersistenceWriteFailed, DeadlineExpired }
public readonly record struct BodyProgramControllerResult<T>(BodyProgramControllerResultCode Code, T? Value) where T : class { public bool IsSuccess => this.Code == BodyProgramControllerResultCode.Succeeded && this.Value is not null; }
public static class BodyProgramControllerResult { public static BodyProgramControllerResult<T> Success<T>(T value) where T : class => new(BodyProgramControllerResultCode.Succeeded, value); public static BodyProgramControllerResult<T> Failure<T>(BodyProgramControllerResultCode code) where T : class => new(code, null); }

internal static class BodyProgramValidation
{
    internal const int MaximumNodes = 16;
    internal const long MaximumJavaScriptSafeInteger = 9007199254740991L;
    internal static bool IsValidDeadlineMs(long value) => value is > 0 and <= MaximumJavaScriptSafeInteger;
    internal static bool IsIdentifier(string? value) => value is { Length: >= 1 and <= 128 } && value.All(c => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c is '_' or '-');
    internal static bool IsValidActionDescriptor(BodyProgramActionDescriptor? action) => action is not null && IsIdentifier(action.ActionId) && action.IdentityVersion > 0
        && action.Arguments is { Count: <= 32 } && action.OutputFacts is { Count: <= 32 } && action.ResourceTemplate is { Count: <= 16 }
        && action.Arguments.All(argument => argument is not null && IsIdentifier(argument.Name) && Enum.IsDefined(argument.Kind))
        && action.OutputFacts.All(fact => fact is not null && IsIdentifier(fact.Name) && Enum.IsDefined(fact.Kind))
        && action.ResourceTemplate.All(claim => claim is not null && IsIdentifier(claim.Key) && Enum.IsDefined(claim.Value))
        && action.Arguments.Select(argument => argument.Name).Distinct(StringComparer.Ordinal).Count() == action.Arguments.Count
        && action.OutputFacts.Select(fact => fact.Name).Distinct(StringComparer.Ordinal).Count() == action.OutputFacts.Count
        && action.ResourceTemplate.Select(claim => claim.Key).Distinct(StringComparer.Ordinal).Count() == action.ResourceTemplate.Count;
    internal static BodyProgramActionDescriptor FreezeActionDescriptor(BodyProgramActionDescriptor action) => new(action.ActionId, action.IdentityVersion,
        Array.AsReadOnly(action.Arguments.ToArray()), Array.AsReadOnly(action.OutputFacts.ToArray()), Array.AsReadOnly(action.ResourceTemplate.ToArray()));
    internal static IReadOnlyDictionary<T, U> FreezeMap<T, U>(IReadOnlyDictionary<T, U> values) where T : notnull => new ReadOnlyDictionary<T, U>(new Dictionary<T, U>(values));
    internal static bool TryDecodeRuntimeValue(BodyProgramRuntimeValue? value, BodyProgramArgumentKind kind, out BodyProgramCanonicalValue? canonical)
    {
        canonical = null;
        if (value is null || value.Type is not { Length: >= 1 and <= 64 } || value.CanonicalValue is null || value.CanonicalValue.Length > 512) return false;
        string expected = kind switch { BodyProgramArgumentKind.Integer => "integer", BodyProgramArgumentKind.String => "string", BodyProgramArgumentKind.Boolean => "boolean", _ => "" };
        if (value.Type != expected) return false;
        switch (kind)
        {
            case BodyProgramArgumentKind.Integer:
                if (!long.TryParse(value.CanonicalValue, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out long integer)
                    || integer.ToString(System.Globalization.CultureInfo.InvariantCulture) != value.CanonicalValue) return false;
                break;
            case BodyProgramArgumentKind.Boolean:
                if (value.CanonicalValue is not ("true" or "false")) return false;
                break;
        }
        canonical = new BodyProgramCanonicalValue(kind, value.CanonicalValue);
        return true;
    }
    internal static bool IsValidCanonicalValue(BodyProgramCanonicalValue? value, BodyProgramArgumentKind expected) => value is not null && value.Kind == expected
        && TryDecodeRuntimeValue(new BodyProgramRuntimeValue(expected switch { BodyProgramArgumentKind.Integer => "integer", BodyProgramArgumentKind.String => "string", BodyProgramArgumentKind.Boolean => "boolean", _ => "" }, value.CanonicalValue), expected, out _);
    internal static BodyProgramRuntimeValue ToRuntimeValue(BodyProgramCanonicalValue value) => new(value.Kind switch { BodyProgramArgumentKind.Integer => "integer", BodyProgramArgumentKind.String => "string", BodyProgramArgumentKind.Boolean => "boolean", _ => throw new ArgumentOutOfRangeException(nameof(value)) }, value.CanonicalValue);
}
