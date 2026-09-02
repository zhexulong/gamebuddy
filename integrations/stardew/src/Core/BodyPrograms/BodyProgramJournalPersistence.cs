using System.Collections.ObjectModel;
using System.Text.Json;
using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew.Core.BodyPrograms;

/// <summary>Strict versioned codec for the complete Mod-owned Body Program journal.</summary>
public static class BodyProgramJournalPersistence
{
    public const int SchemaVersion = 1;
    private static readonly JsonSerializerOptions WriteOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = false,
    };

    public static string Encode(BodyProgramJournalState state)
    {
        if (!TryValidate(state, out _))
            throw new ArgumentException("Body Program journal state is malformed.", nameof(state));
        return JsonSerializer.Serialize(state, WriteOptions);
    }

    public static bool TryDecode(string? encoded, VerifiedBodyPrograms catalog, BridgeScope expectedScope, out BodyProgramJournalState? state)
    {
        state = null;
        if (string.IsNullOrEmpty(encoded) || catalog is null || expectedScope is null || !expectedScope.IsValid)
            return false;
        try
        {
            using JsonDocument document = JsonDocument.Parse(encoded);
            if (!TryReadState(document.RootElement, out BodyProgramJournalState? decoded)
                || decoded is null || !decoded.Scope.Equals(expectedScope)
                || !TryValidate(decoded, out _)
                || !decoded.Programs.All(program => catalog.MatchesCanonical(program.Descriptor)))
                return false;
            state = FreezeState(decoded);
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    internal static bool TryValidate(BodyProgramJournalState? state, out string? reason)
    {
        reason = null;
        if (state is null || state.SchemaVersion != SchemaVersion || state.Scope is null || !state.Scope.IsValid
            || state.PolicyIdentity is null || !state.PolicyIdentity.IsValid || state.Programs is null || state.Programs.Count > 128)
        {
            reason = "invalid_state";
            return false;
        }
        HashSet<string> programs = new(StringComparer.Ordinal);
        foreach (BodyProgramJournalProgram? program in state.Programs)
        {
            if (program is null || !programs.Add(program.ProgramId) || !ValidateProgram(program))
            {
                reason = "invalid_program";
                return false;
            }
        }
        return true;
    }

    internal static BodyProgramJournalState FreezeState(BodyProgramJournalState state) => new(
        state.SchemaVersion,
        state.Scope,
        state.PolicyIdentity,
        Array.AsReadOnly(state.Programs.Select(program => new BodyProgramJournalProgram(
            program.ProgramId,
            BodyProgramValidation.FreezeDescriptor(program.Descriptor),
            program.State,
            Array.AsReadOnly(program.Nodes.Select(node => new BodyProgramJournalNode(
                node.NodeId,
                node.State,
                node.Attempt,
                new ReadOnlyDictionary<string, int>(new Dictionary<string, int>(node.PredecessorAttempts, StringComparer.Ordinal)))).ToArray()))).ToArray()));

    private static bool ValidateProgram(BodyProgramJournalProgram program)
    {
        if (!BodyProgramValidation.IsIdentifier(program.ProgramId) || program.Descriptor is null
            || program.ProgramId != program.Descriptor.ProgramId || !BodyProgramValidation.IsValidDescriptor(program.Descriptor)
            || !Enum.IsDefined(program.State) || program.Nodes is null || program.Nodes.Count != program.Descriptor.Nodes.Count)
            return false;
        Dictionary<string, BodyProgramNodeDescriptor> descriptors = program.Descriptor.Nodes.ToDictionary(node => node.NodeId, StringComparer.Ordinal);
        Dictionary<string, BodyProgramJournalNode> nodes = new(StringComparer.Ordinal);
        foreach (BodyProgramJournalNode? node in program.Nodes)
        {
            if (node is null || !nodes.TryAdd(node.NodeId, node) || !descriptors.ContainsKey(node.NodeId)
                || !Enum.IsDefined(node.State) || node.Attempt < 0 || node.PredecessorAttempts is null
                || !node.PredecessorAttempts.All(pair => BodyProgramValidation.IsIdentifier(pair.Key) && pair.Value > 0))
                return false;
        }
        if (nodes.Count != descriptors.Count)
            return false;
        IReadOnlyDictionary<string, IReadOnlyList<string>> predecessors = BuildPredecessors(program.Descriptor);
        foreach ((string nodeId, BodyProgramJournalNode node) in nodes)
        {
            IReadOnlyList<string> expectedPredecessors = predecessors[nodeId];
            bool requiresAttempt = node.State is not (BodyProgramNodeState.Pending or BodyProgramNodeState.RecoveryRequired or BodyProgramNodeState.Quarantined);
            if (requiresAttempt && node.Attempt < 1)
                return false;
            if (node.Attempt == 0 && node.PredecessorAttempts.Count != 0)
                return false;
            if (node.Attempt > 0 && (!expectedPredecessors.All(node.PredecessorAttempts.ContainsKey)
                || node.PredecessorAttempts.Keys.Any(key => !expectedPredecessors.Contains(key, StringComparer.Ordinal))
                || expectedPredecessors.Any(predecessor => nodes[predecessor].State != BodyProgramNodeState.Succeeded
                    || nodes[predecessor].Attempt != node.PredecessorAttempts[predecessor])))
                return false;
        }
        return ValidateProgramTerminalParity(program, nodes.Values);
    }

    private static bool ValidateProgramTerminalParity(BodyProgramJournalProgram program, IEnumerable<BodyProgramJournalNode> nodes)
    {
        BodyProgramJournalNode[] materialized = nodes.ToArray();
        return program.State switch
        {
            BodyProgramState.Active => materialized.All(node => node.State is not (BodyProgramNodeState.Failed or BodyProgramNodeState.Cancelled
                or BodyProgramNodeState.RecoveryRequired or BodyProgramNodeState.Quarantined)),
            BodyProgramState.Succeeded => materialized.All(node => node.State == BodyProgramNodeState.Succeeded),
            BodyProgramState.Failed => materialized.Any(node => node.State == BodyProgramNodeState.Failed),
            BodyProgramState.Cancelled => materialized.Any(node => node.State == BodyProgramNodeState.Cancelled),
            BodyProgramState.RecoveryRequired => materialized.Any(node => node.State is BodyProgramNodeState.RecoveryRequired or BodyProgramNodeState.Quarantined),
            BodyProgramState.Quarantined => materialized.Any(node => node.State == BodyProgramNodeState.Quarantined),
            _ => false,
        };
    }

    private static IReadOnlyDictionary<string, IReadOnlyList<string>> BuildPredecessors(BodyProgramDescriptor descriptor)
    {
        Dictionary<string, List<string>> mutable = descriptor.Nodes.ToDictionary(node => node.NodeId, _ => new List<string>(), StringComparer.Ordinal);
        foreach (BodyProgramNodeDescriptor node in descriptor.Nodes)
        foreach (string successor in node.SuccessorNodeIds)
            mutable[successor].Add(node.NodeId);
        return new ReadOnlyDictionary<string, IReadOnlyList<string>>(mutable.ToDictionary(
            pair => pair.Key,
            pair => (IReadOnlyList<string>)Array.AsReadOnly(pair.Value.OrderBy(value => value, StringComparer.Ordinal).ToArray()),
            StringComparer.Ordinal));
    }

    private static bool TryReadState(JsonElement root, out BodyProgramJournalState? state)
    {
        state = null;
        if (!HasExactProperties(root, "schemaVersion", "scope", "policyIdentity", "programs")
            || !TryReadScope(root.GetProperty("scope"), out BridgeScope? scope)
            || !TryReadPolicyIdentity(root.GetProperty("policyIdentity"), out BodyProgramPolicyIdentity? identity)
            || !TryReadArray(root.GetProperty("programs"), TryReadProgram, out BodyProgramJournalProgram[] programs))
            return false;
        if (!root.GetProperty("schemaVersion").TryGetInt32(out int schemaVersion))
            return false;
        state = new BodyProgramJournalState(schemaVersion, scope!, identity!, programs);
        return true;
    }

    private static bool TryReadProgram(JsonElement element, out BodyProgramJournalProgram? program)
    {
        program = null;
        if (!HasExactProperties(element, "programId", "descriptor", "state", "nodes")
            || !TryReadString(element.GetProperty("programId"), out string? programId)
            || !TryReadDescriptor(element.GetProperty("descriptor"), out BodyProgramDescriptor? descriptor)
            || !TryReadEnum<BodyProgramState>(element.GetProperty("state"), out BodyProgramState? state)
            || !TryReadArray(element.GetProperty("nodes"), TryReadNode, out BodyProgramJournalNode[] nodes))
            return false;
        program = new BodyProgramJournalProgram(programId!, descriptor!, state!.Value, nodes);
        return true;
    }

    private static bool TryReadNode(JsonElement element, out BodyProgramJournalNode? node)
    {
        node = null;
        if (!HasExactProperties(element, "nodeId", "state", "attempt", "predecessorAttempts")
            || !TryReadString(element.GetProperty("nodeId"), out string? nodeId)
            || !TryReadEnum<BodyProgramNodeState>(element.GetProperty("state"), out BodyProgramNodeState? state)
            || !TryReadInt(element.GetProperty("attempt"), out int? attempt)
            || !TryReadIntMap(element.GetProperty("predecessorAttempts"), out IReadOnlyDictionary<string, int>? predecessors))
            return false;
        node = new BodyProgramJournalNode(nodeId!, state!.Value, attempt!.Value, predecessors!);
        return true;
    }

    private static bool TryReadDescriptor(JsonElement element, out BodyProgramDescriptor? descriptor)
    {
        descriptor = null;
        if (!HasExactProperties(element, "programId", "nodes") || !TryReadString(element.GetProperty("programId"), out string? programId)
            || !TryReadArray(element.GetProperty("nodes"), TryReadDescriptorNode, out BodyProgramNodeDescriptor[] nodes))
            return false;
        descriptor = new BodyProgramDescriptor(programId!, nodes);
        return true;
    }

    private static bool TryReadDescriptorNode(JsonElement element, out BodyProgramNodeDescriptor? node)
    {
        node = null;
        if (!HasExactProperties(element, "nodeId", "actionId", "arguments", "bindings", "resourceClaims", "successorNodeIds")
            || !TryReadString(element.GetProperty("nodeId"), out string? nodeId)
            || !TryReadString(element.GetProperty("actionId"), out string? actionId)
            || !TryReadStringMap(element.GetProperty("arguments"), out IReadOnlyDictionary<string, string>? arguments, TryReadString)
            || !TryReadStringMap(element.GetProperty("bindings"), out IReadOnlyDictionary<string, string>? bindings, TryReadString)
            || !TryReadStringMap(element.GetProperty("resourceClaims"), out IReadOnlyDictionary<string, string>? claims, TryReadString)
            || !TryReadStringArray(element.GetProperty("successorNodeIds"), out string[] successors))
            return false;
        node = new BodyProgramNodeDescriptor(nodeId!, actionId!, arguments!, bindings!, claims!, successors);
        return true;
    }

    private static bool TryReadScope(JsonElement element, out BridgeScope? scope)
    {
        scope = null;
        if (!HasExactProperties(element, "integrationId", "saveId", "worldId", "playerId", "companionId")
            || !TryReadString(element.GetProperty("integrationId"), out string? integrationId)
            || !TryReadString(element.GetProperty("saveId"), out string? saveId)
            || !TryReadString(element.GetProperty("worldId"), out string? worldId)
            || !TryReadString(element.GetProperty("playerId"), out string? playerId)
            || !TryReadString(element.GetProperty("companionId"), out string? companionId))
            return false;
        scope = new BridgeScope(integrationId!, saveId!, worldId!, playerId!, companionId!);
        return true;
    }

    private static bool TryReadPolicyIdentity(JsonElement element, out BodyProgramPolicyIdentity? identity)
    {
        identity = null;
        if (!HasExactProperties(element, "embodimentId", "generation")
            || !TryReadString(element.GetProperty("embodimentId"), out string? embodimentId)
            || !TryReadLong(element.GetProperty("generation"), out long? generation))
            return false;
        identity = new BodyProgramPolicyIdentity(embodimentId!, generation!.Value);
        return true;
    }

    private delegate bool ElementReader<T>(JsonElement element, out T? value);

    private static bool TryReadArray<T>(JsonElement element, ElementReader<T> reader, out T[] values)
    {
        values = Array.Empty<T>();
        if (element.ValueKind != JsonValueKind.Array || element.GetArrayLength() > 128)
            return false;
        List<T> result = new();
        foreach (JsonElement item in element.EnumerateArray())
        {
            if (!reader(item, out T? value) || value is null) return false;
            result.Add(value);
        }
        values = result.ToArray();
        return true;
    }

    private static bool TryReadStringArray(JsonElement element, out string[] values) => TryReadArray(element, TryReadString, out values);

    private static bool TryReadStringMap<T>(JsonElement element, out IReadOnlyDictionary<string, T>? map, ElementReader<T> valueReader)
    {
        map = null;
        if (element.ValueKind != JsonValueKind.Object || element.EnumerateObject().Count() > 128)
            return false;
        Dictionary<string, T> result = new(StringComparer.Ordinal);
        foreach (JsonProperty property in element.EnumerateObject())
        {
            if (!BodyProgramValidation.IsIdentifier(property.Name) || !valueReader(property.Value, out T? value) || value is null || !result.TryAdd(property.Name, value))
                return false;
        }
        map = new ReadOnlyDictionary<string, T>(result);
        return true;
    }

    private static bool TryReadIntMap(JsonElement element, out IReadOnlyDictionary<string, int>? map)
    {
        map = null;
        if (element.ValueKind != JsonValueKind.Object || element.EnumerateObject().Count() > 128)
            return false;
        Dictionary<string, int> result = new(StringComparer.Ordinal);
        foreach (JsonProperty property in element.EnumerateObject())
        {
            if (!BodyProgramValidation.IsIdentifier(property.Name) || !property.Value.TryGetInt32(out int value) || !result.TryAdd(property.Name, value))
                return false;
        }
        map = new ReadOnlyDictionary<string, int>(result);
        return true;
    }

    private static bool TryReadString(JsonElement element, out string? value)
    {
        value = element.ValueKind == JsonValueKind.String ? element.GetString() : null;
        return value is not null;
    }

    private static bool TryReadInt(JsonElement element, out int? value)
    {
        bool valid = element.TryGetInt32(out int raw);
        value = valid ? raw : null;
        return valid;
    }

    private static bool TryReadLong(JsonElement element, out long? value)
    {
        bool valid = element.TryGetInt64(out long raw);
        value = valid ? raw : null;
        return valid;
    }

    private static bool TryReadEnum<T>(JsonElement element, out T? value) where T : struct, Enum
    {
        bool valid = element.TryGetInt32(out int raw) && Enum.IsDefined(typeof(T), raw);
        value = valid ? (T)Enum.ToObject(typeof(T), raw) : null;
        return valid;
    }

    private static bool HasExactProperties(JsonElement element, params string[] expected)
    {
        if (element.ValueKind != JsonValueKind.Object) return false;
        JsonProperty[] properties = element.EnumerateObject().ToArray();
        return properties.Length == expected.Length
            && properties.Select(property => property.Name).Distinct(StringComparer.Ordinal).Count() == expected.Length
            && properties.All(property => expected.Contains(property.Name, StringComparer.Ordinal));
    }
}
