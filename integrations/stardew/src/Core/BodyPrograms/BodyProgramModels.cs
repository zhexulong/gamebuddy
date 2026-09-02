using System.Collections.ObjectModel;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;

namespace GameBuddy.Stardew.Core.BodyPrograms;

/// <summary>One embodiment-local policy generation. It is intentionally not persisted as an executable restart identity.</summary>
public sealed record BodyProgramPolicyIdentity(string EmbodimentId, long Generation)
{
    [System.Text.Json.Serialization.JsonIgnore]
    public bool IsValid => BodyProgramValidation.IsIdentifier(this.EmbodimentId) && this.Generation >= 0;
}

/// <summary>
/// Mod-owned immutable node descriptor. Arguments, bindings, and resource claims
/// are canonical ingress values, not Host-provided executable instructions.
/// </summary>
public sealed record BodyProgramNodeDescriptor(
    string NodeId,
    string ActionId,
    IReadOnlyDictionary<string, string> Arguments,
    IReadOnlyDictionary<string, string> Bindings,
    IReadOnlyDictionary<string, string> ResourceClaims,
    IReadOnlyList<string> SuccessorNodeIds);

/// <summary>A finite, acyclic Mod-defined action program.</summary>
public sealed record BodyProgramDescriptor(string ProgramId, IReadOnlyList<BodyProgramNodeDescriptor> Nodes);

/// <summary>
/// Fixed Mod authority for Body Program descriptors. Construction rejects every
/// descriptor that is not a finite DAG over the current Mod action catalog.
/// </summary>
public sealed class VerifiedBodyPrograms
{
    private readonly IReadOnlyDictionary<string, BodyProgramDescriptor> descriptors;

    public VerifiedBodyPrograms(IEnumerable<BodyProgramDescriptor> descriptors)
    {
        ArgumentNullException.ThrowIfNull(descriptors);
        Dictionary<string, BodyProgramDescriptor> verified = new(StringComparer.Ordinal);
        foreach (BodyProgramDescriptor descriptor in descriptors)
        {
            if (!BodyProgramValidation.IsValidDescriptor(descriptor))
                throw new ArgumentException("Body Program descriptor is malformed.", nameof(descriptors));
            if (!verified.TryAdd(descriptor.ProgramId, BodyProgramValidation.FreezeDescriptor(descriptor)))
                throw new ArgumentException("Body Program IDs must be unique.", nameof(descriptors));
        }
        this.descriptors = new ReadOnlyDictionary<string, BodyProgramDescriptor>(verified);
    }

    public IReadOnlyCollection<BodyProgramDescriptor> Descriptors => this.descriptors.Values.ToArray();

    public bool TryGetDescriptor(string programId, out BodyProgramDescriptor? descriptor) =>
        this.descriptors.TryGetValue(programId, out descriptor);

    internal bool MatchesCanonical(BodyProgramDescriptor descriptor) =>
        this.descriptors.TryGetValue(descriptor.ProgramId, out BodyProgramDescriptor? expected)
        && BodyProgramValidation.DescriptorsEqual(expected, descriptor);
}

public enum BodyProgramState
{
    Active = 1,
    Succeeded = 2,
    Failed = 3,
    Cancelled = 4,
    RecoveryRequired = 5,
    Quarantined = 6,
}

public enum BodyProgramNodeState
{
    Pending = 1,
    Granted = 2,
    Running = 3,
    Succeeded = 4,
    Failed = 5,
    Cancelled = 6,
    RecoveryRequired = 7,
    Quarantined = 8,
}

public enum RuntimeFactKind
{
    Progress = 1,
    Terminal = 2,
    ResourceReleased = 3,
    RecoveryRequired = 4,
}

/// <summary>Addressed execution fact. Provenance is always this exact triple.</summary>
public sealed record RuntimeFact(
    string ProgramId,
    string NodeId,
    int NodeAttempt,
    RuntimeFactKind Kind,
    IReadOnlyDictionary<string, string> Values);

/// <summary>Opaque-to-transport grant for a single embodiment-local node attempt.</summary>
public sealed record BodyProgramGrant(
    string ProgramId,
    string NodeId,
    int NodeAttempt,
    string ActionId,
    BodyProgramPolicyIdentity PolicyIdentity);

public enum BodyProgramNodeOutcome
{
    Succeeded = 1,
    Failed = 2,
    Cancelled = 3,
}

public sealed record BodyProgramJournalNode(
    string NodeId,
    BodyProgramNodeState State,
    int Attempt,
    IReadOnlyDictionary<string, int> PredecessorAttempts);

public sealed record BodyProgramJournalProgram(
    string ProgramId,
    BodyProgramDescriptor Descriptor,
    BodyProgramState State,
    IReadOnlyList<BodyProgramJournalNode> Nodes);

public sealed record BodyProgramJournalState(
    int SchemaVersion,
    BridgeScope Scope,
    BodyProgramPolicyIdentity PolicyIdentity,
    IReadOnlyList<BodyProgramJournalProgram> Programs);

public interface IBodyProgramJournalStore
{
    string? Read();
    bool TryWrite(string encodedState);
}

public enum BodyProgramJournalOpenStatus
{
    Empty,
    Opened,
    RecoveryRequired,
    Corrupt,
    PersistenceReadFailed,
    PersistenceWriteFailed,
}

public enum BodyProgramControllerResultCode
{
    Succeeded,
    NotFound,
    InvalidInput,
    ProgramNotActive,
    NodeNotEligible,
    NodeAlreadyStarted,
    PolicyIdentityStale,
    ActionNotEnabled,
    ResourceBusy,
    GrantMismatch,
    FactProvenanceMismatch,
    InvalidFact,
    RecoveryRequired,
    PersistenceWriteFailed,
}

public readonly record struct BodyProgramControllerResult<T>(BodyProgramControllerResultCode Code, T? Value)
    where T : class
{
    public bool IsSuccess => this.Code == BodyProgramControllerResultCode.Succeeded && this.Value is not null;
}

public static class BodyProgramControllerResult
{
    public static BodyProgramControllerResult<T> Success<T>(T value) where T : class => new(BodyProgramControllerResultCode.Succeeded, value);
    public static BodyProgramControllerResult<T> Failure<T>(BodyProgramControllerResultCode code) where T : class => new(code, null);
}

internal static class BodyProgramValidation
{
    internal static bool IsIdentifier(string? value) => value is { Length: >= 1 and <= 128 }
        && value.All(character => (character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z')
            || (character >= '0' && character <= '9') || character is '_' or '-');

    internal static bool IsValidDescriptor(BodyProgramDescriptor? descriptor)
    {
        if (descriptor is null || !IsIdentifier(descriptor.ProgramId) || descriptor.Nodes is null
            || descriptor.Nodes.Count is < 1 or > 128)
            return false;

        Dictionary<string, BodyProgramNodeDescriptor> nodes = new(StringComparer.Ordinal);
        foreach (BodyProgramNodeDescriptor? node in descriptor.Nodes)
        {
            if (node is null || !IsIdentifier(node.NodeId) || !IsIdentifier(node.ActionId)
                || node.Arguments is null || node.Bindings is null || node.ResourceClaims is null || node.SuccessorNodeIds is null
                || !IsStringMap(node.Arguments) || !IsStringMap(node.Bindings) || !IsStringMap(node.ResourceClaims)
                || node.SuccessorNodeIds.Count > 128 || !nodes.TryAdd(node.NodeId, node)
                || !FarmhandActionCatalog.Registrations.Any(registration => registration.ActionId == node.ActionId
                    && registration.Kind == FarmhandOperationKind.Execution))
                return false;
        }
        if (nodes.Values.Any(node => node.SuccessorNodeIds.Any(successor => !IsIdentifier(successor) || !nodes.ContainsKey(successor)))
            || nodes.Values.Any(node => node.SuccessorNodeIds.Distinct(StringComparer.Ordinal).Count() != node.SuccessorNodeIds.Count))
            return false;

        Dictionary<string, int> marks = new(StringComparer.Ordinal);
        return nodes.Keys.All(nodeId => IsAcyclic(nodeId, nodes, marks));
    }

    internal static BodyProgramDescriptor FreezeDescriptor(BodyProgramDescriptor descriptor) => new(
        descriptor.ProgramId,
        Array.AsReadOnly(descriptor.Nodes.Select(node => new BodyProgramNodeDescriptor(
            node.NodeId,
            node.ActionId,
            FreezeMap(node.Arguments),
            FreezeMap(node.Bindings),
            FreezeMap(node.ResourceClaims),
            Array.AsReadOnly(node.SuccessorNodeIds.ToArray()))).ToArray()));

    internal static bool DescriptorsEqual(BodyProgramDescriptor left, BodyProgramDescriptor right) =>
        left.ProgramId == right.ProgramId && left.Nodes.Count == right.Nodes.Count
        && left.Nodes.Zip(right.Nodes).All(pair => pair.First.NodeId == pair.Second.NodeId
            && pair.First.ActionId == pair.Second.ActionId
            && MapsEqual(pair.First.Arguments, pair.Second.Arguments)
            && MapsEqual(pair.First.Bindings, pair.Second.Bindings)
            && MapsEqual(pair.First.ResourceClaims, pair.Second.ResourceClaims)
            && pair.First.SuccessorNodeIds.SequenceEqual(pair.Second.SuccessorNodeIds, StringComparer.Ordinal));

    internal static bool IsStringMap(IReadOnlyDictionary<string, string> values) => values.Count <= 128
        && values.All(pair => IsIdentifier(pair.Key) && pair.Value is { Length: <= 4096 });

    internal static IReadOnlyDictionary<string, string> FreezeMap(IReadOnlyDictionary<string, string> values) =>
        new ReadOnlyDictionary<string, string>(new Dictionary<string, string>(values, StringComparer.Ordinal));

    internal static bool MapsEqual<T>(IReadOnlyDictionary<string, T> left, IReadOnlyDictionary<string, T> right)
        where T : IEquatable<T> => left.Count == right.Count && left.All(pair => right.TryGetValue(pair.Key, out T? value) && pair.Value.Equals(value));

    private static bool IsAcyclic(string nodeId, IReadOnlyDictionary<string, BodyProgramNodeDescriptor> nodes, IDictionary<string, int> marks)
    {
        if (marks.TryGetValue(nodeId, out int mark)) return mark == 2;
        marks[nodeId] = 1;
        foreach (string successor in nodes[nodeId].SuccessorNodeIds)
        {
            if (marks.TryGetValue(successor, out int successorMark) && successorMark == 1)
                return false;
            if (!IsAcyclic(successor, nodes, marks))
                return false;
        }
        marks[nodeId] = 2;
        return true;
    }
}
