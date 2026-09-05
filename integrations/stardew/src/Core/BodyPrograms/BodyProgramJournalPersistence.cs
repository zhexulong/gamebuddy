using System.Collections.ObjectModel;
using System.Text.Json;
using System.Text.Json.Serialization;
using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew.Core.BodyPrograms;

/// <summary>Strict exact-key codec for the complete Mod-owned dynamic BodyProgramJournal/v1.</summary>
public static class BodyProgramJournalPersistence
{
    public const int SchemaVersion = 1;
    private static readonly JsonSerializerOptions WriteOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public static string Encode(BodyProgramJournalState state)
    {
        if (!TryValidate(state, out _)) throw new ArgumentException("Body Program journal state is malformed.", nameof(state));
        return JsonSerializer.Serialize(state, WriteOptions);
    }

    public static bool TryDecode(string? encoded, BodyProgramActionCatalog catalog, BridgeScope expectedScope, out BodyProgramJournalState? state)
    {
        state = null;
        if (string.IsNullOrEmpty(encoded) || catalog is null || expectedScope is null || !expectedScope.IsValid) return false;
        try
        {
            using JsonDocument document = JsonDocument.Parse(encoded, new JsonDocumentOptions { MaxDepth = 16 });
            if (!TryReadState(document.RootElement, out BodyProgramJournalState? decoded) || decoded is null || !decoded.Scope.Equals(expectedScope)
                || !TryValidate(decoded, out _) || !decoded.Programs.All(program => MatchesCatalog(program, catalog, expectedScope))) return false;
            state = FreezeState(decoded);
            return true;
        }
        catch (JsonException) { return false; }
    }

    internal static bool TryValidate(BodyProgramJournalState? state, out string? reason)
    {
        reason = null;
        if (state is null || state.SchemaVersion != SchemaVersion || state.Scope is null || !state.Scope.IsValid || state.PolicyIdentity is null || !state.PolicyIdentity.IsValid
            || state.EventHighWater < 0 || state.Programs is null || state.Events is null || state.Programs.Count > 128 || state.Events.Count > 4096) { reason = "invalid_state"; return false; }
        HashSet<string> ids = new(StringComparer.Ordinal);
        if (state.Programs.Any(program => program is null || !ids.Add(program.Program.ProgramId) || !ValidateProgram(program))) { reason = "invalid_program"; return false; }
        long prior = 0;
        foreach (BodyProgramJournalEvent @event in state.Events)
        {
            if (@event is null || @event.Cursor <= prior || @event.Cursor > state.EventHighWater || !ids.Contains(@event.ProgramId) || !BodyProgramValidation.IsIdentifier(@event.Kind)
                || @event.CatalogRevision < 0 || (@event.NodeId is not null && !BodyProgramValidation.IsIdentifier(@event.NodeId)) || @event.NodeAttempt is < 1) { reason = "invalid_event"; return false; }
            BodyProgramJournalProgram program = state.Programs.Single(item => item.Program.ProgramId == @event.ProgramId);
            if (@event.CatalogRevision != program.Program.CatalogRevision) { reason = "event_catalog_revision"; return false; }
            prior = @event.Cursor;
        }
        if (state.Events.Count > 0 && prior != state.EventHighWater) { reason = "event_high_water"; return false; }
        return true;
    }

    internal static BodyProgramJournalState FreezeState(BodyProgramJournalState state) => new(state.SchemaVersion, state.Scope, state.PolicyIdentity, state.EventHighWater,
        Array.AsReadOnly(state.Programs.Select(FreezeProgram).ToArray()), Array.AsReadOnly(state.Events.Select(@event => @event with { }).ToArray()));
    private static BodyProgramJournalProgram FreezeProgram(BodyProgramJournalProgram program) => new(FreezeVerified(program.Program), program.State, program.StopEpoch,
        Array.AsReadOnly(program.Nodes.Select(node => node with { ExecutionBinding = node.ExecutionBinding is null ? null : node.ExecutionBinding with { } }).ToArray()), Array.AsReadOnly(program.Facts.Select(fact => new RuntimeFact(fact.ProgramId, fact.NodeId, fact.NodeAttempt, fact.FactName, BodyProgramValidation.FreezeMap(fact.Values))).ToArray()));
    internal static VerifiedBodyProgram FreezeVerified(VerifiedBodyProgram program) => new(program.ProgramId, program.CatalogRevision,
        Array.AsReadOnly(program.Nodes.Select(node => new VerifiedBodyProgramNode(node.NodeId, node.ActionId, BodyProgramValidation.FreezeMap(node.CanonicalArguments), Array.AsReadOnly(node.DependsOn.ToArray()), BodyProgramValidation.FreezeMap(node.Bindings), BodyProgramValidation.FreezeMap(node.DerivedResourceClaims), node.DeadlineMs)).ToArray()));

    private static bool ValidateProgram(BodyProgramJournalProgram program)
    {
        if (program.Program is null || !IsValidVerified(program.Program) || HasUnorderedResourceConflict(program.Program.Nodes) || !Enum.IsDefined(program.State) || program.StopEpoch < 0 || program.Nodes is null || program.Facts is null || program.Nodes.Count != program.Program.Nodes.Count) return false;
        Dictionary<string, BodyProgramJournalNode> nodes = new(StringComparer.Ordinal);
        foreach (BodyProgramJournalNode node in program.Nodes)
            if (node is null || !nodes.TryAdd(node.NodeId, node) || !Enum.IsDefined(node.State) || node.NodeAttempt < 0 || node.AdmissionAttempt < 0 || (node.GrantId is not null && !BodyProgramValidation.IsIdentifier(node.GrantId))
                || (node.ExecutionBinding is not null && (!BodyProgramValidation.IsValidExecutionBinding(node.ExecutionBinding) || node.ExecutionBinding.NodeId != node.NodeId || node.ExecutionBinding.NodeAttempt != node.NodeAttempt || node.ExecutionBinding.ProgramId != program.Program.ProgramId))
                || (node.State is BodyProgramNodeState.HostAdmitted or BodyProgramNodeState.Running) != (node.ExecutionBinding is not null)) return false;
        if (!program.Program.Nodes.All(node => nodes.ContainsKey(node.NodeId))) return false;
        HashSet<string> factKeys = new(StringComparer.Ordinal);
        foreach (RuntimeFact fact in program.Facts)
        {
            if (fact is null || fact.ProgramId != program.Program.ProgramId || !nodes.TryGetValue(fact.NodeId, out BodyProgramJournalNode? node) || fact.NodeAttempt != node.NodeAttempt
                || node.State != BodyProgramNodeState.Succeeded || !BodyProgramValidation.IsIdentifier(fact.FactName) || fact.Values is null || fact.Values.Count > 32
                || !factKeys.Add($"{fact.NodeId}\u001f{fact.NodeAttempt}\u001f{fact.FactName}")) return false;
            VerifiedBodyProgramNode descriptor = program.Program.Nodes.Single(item => item.NodeId == fact.NodeId);
            if (descriptor.ActionId.Length == 0 || fact.Values.Count != 1 || !fact.Values.TryGetValue(fact.FactName, out BodyProgramCanonicalValue? value)
                || !BodyProgramValidation.IsValidCanonicalValue(value, value.Kind)) return false;
        }
        return program.State switch
        {
            BodyProgramState.Active => nodes.Values.All(node => node.State is not (BodyProgramNodeState.RecoveryRequired or BodyProgramNodeState.Failed or BodyProgramNodeState.Cancelled)),
            BodyProgramState.Succeeded => nodes.Values.All(node => node.State == BodyProgramNodeState.Succeeded),
            BodyProgramState.Failed => nodes.Values.Any(node => node.State == BodyProgramNodeState.Failed),
            BodyProgramState.Cancelled => nodes.Values.Any(node => node.State == BodyProgramNodeState.Cancelled),
            BodyProgramState.RecoveryRequired or BodyProgramState.Quarantined => nodes.Values.Any(node => node.State == BodyProgramNodeState.RecoveryRequired),
            _ => false,
        };
    }

    internal static bool IsValidVerified(VerifiedBodyProgram? program) => program is not null && BodyProgramValidation.IsIdentifier(program.ProgramId) && program.CatalogRevision >= 0
        && program.Nodes is { Count: >= 1 and <= BodyProgramValidation.MaximumNodes } && program.Nodes.All(node => node is not null && BodyProgramValidation.IsIdentifier(node.NodeId) && BodyProgramValidation.IsIdentifier(node.ActionId) && BodyProgramValidation.IsValidDeadlineMs(node.DeadlineMs)
            && node.CanonicalArguments is { Count: <= 32 } && node.DependsOn is { Count: <= 8 } && node.Bindings is { Count: <= 4 } && node.DerivedResourceClaims is { Count: <= 16 }
            && node.CanonicalArguments.All(pair => BodyProgramValidation.IsIdentifier(pair.Key) && pair.Value is not null && BodyProgramValidation.IsValidCanonicalValue(pair.Value, pair.Value.Kind))
            && node.DependsOn.All(BodyProgramValidation.IsIdentifier) && node.DependsOn.Distinct(StringComparer.Ordinal).Count() == node.DependsOn.Count
            && node.Bindings.All(pair => BodyProgramValidation.IsIdentifier(pair.Key) && pair.Value is not null && BodyProgramValidation.IsIdentifier(pair.Value.ProducerNodeId) && BodyProgramValidation.IsIdentifier(pair.Value.FactName))
            && node.DerivedResourceClaims.All(pair => BodyProgramValidation.IsIdentifier(pair.Key) && pair.Value is { Length: <= 4096 }))
        && program.Nodes.Select(node => node.NodeId).Distinct(StringComparer.Ordinal).Count() == program.Nodes.Count;
    internal static bool MatchesCatalogProgram(BodyProgramJournalState state, BodyProgramActionCatalog catalog, BridgeScope scope) => state.Programs.All(program => MatchesCatalog(program, catalog, scope));
    private static bool MatchesCatalog(BodyProgramJournalProgram journal, BodyProgramActionCatalog catalog, BridgeScope scope)
    {
        VerifiedBodyProgram program = journal.Program;
        if (program.CatalogRevision != catalog.Revision) return false;
        Dictionary<string, VerifiedBodyProgramNode> nodes = program.Nodes.ToDictionary(node => node.NodeId, StringComparer.Ordinal);
        foreach (VerifiedBodyProgramNode node in program.Nodes)
        {
            if (!catalog.TryGetAction(node.ActionId, out BodyProgramActionDescriptor? action) || !BodyProgramVerifier.ArgumentsMatch(node.CanonicalArguments, action!) || !BodyProgramVerifier.ResourceClaimsMatch(node.DerivedResourceClaims, action!, scope)) return false;
            if (node.DependsOn.Any(dependency => !nodes.ContainsKey(dependency) || dependency == node.NodeId)) return false;
            foreach ((string argument, ActionProgramBinding binding) in node.Bindings)
            {
                BodyProgramArgumentDescriptor? consumer = action!.Arguments.SingleOrDefault(item => item.Name == argument);
                if (!node.DependsOn.Contains(binding.ProducerNodeId, StringComparer.Ordinal) || !nodes.TryGetValue(binding.ProducerNodeId, out VerifiedBodyProgramNode? producer) || !catalog.TryGetAction(producer.ActionId, out BodyProgramActionDescriptor? producerAction) || consumer is null || !producerAction!.OutputFacts.Any(fact => fact.Name == binding.FactName && fact.Kind == consumer.Kind)) return false;
            }
        }
        foreach (VerifiedBodyProgramNode node in program.Nodes)
        {
            if (!catalog.TryGetAction(node.ActionId, out BodyProgramActionDescriptor? action)
                || !FactSetMatchesDescriptor(journal, node, action!)) return false;
        }
        return !HasCycle(nodes) && !HasUnorderedResourceConflict(program.Nodes);
    }
    private static bool FactSetMatchesDescriptor(BodyProgramJournalProgram journal, VerifiedBodyProgramNode node, BodyProgramActionDescriptor action)
    {
        BodyProgramJournalNode state = journal.Nodes.Single(item => item.NodeId == node.NodeId);
        RuntimeFact[] facts = journal.Facts.Where(fact => fact.NodeId == node.NodeId && fact.NodeAttempt == state.NodeAttempt).ToArray();
        if (state.State != BodyProgramNodeState.Succeeded) return facts.Length == 0;
        if (facts.Length != action.OutputFacts.Count) return false;
        HashSet<string> names = new(StringComparer.Ordinal);
        foreach (RuntimeFact fact in facts)
        {
            if (fact.ProgramId != journal.Program.ProgramId || !names.Add(fact.FactName)
                || action.OutputFacts.SingleOrDefault(output => output.Name == fact.FactName) is not BodyProgramFactDescriptor output
                || fact.Values.Count != 1 || !fact.Values.TryGetValue(fact.FactName, out BodyProgramCanonicalValue? value)
                || !BodyProgramValidation.IsValidCanonicalValue(value, output.Kind)) return false;
        }
        return action.OutputFacts.All(output => names.Contains(output.Name));
    }
    private static bool HasCycle(IReadOnlyDictionary<string, VerifiedBodyProgramNode> nodes) { HashSet<string> done = new(StringComparer.Ordinal), active = new(StringComparer.Ordinal); bool Visit(string id) { if (!done.Add(id)) return active.Contains(id); active.Add(id); bool cycle = nodes[id].DependsOn.Any(Visit); active.Remove(id); return cycle; } return nodes.Keys.Any(Visit); }
    private static bool HasUnorderedResourceConflict(IReadOnlyList<VerifiedBodyProgramNode> programNodes)
    {
        Dictionary<string, VerifiedBodyProgramNode> nodes = programNodes.ToDictionary(node => node.NodeId, StringComparer.Ordinal);
        VerifiedBodyProgramNode[] all = programNodes.ToArray();
        for (int index = 0; index < all.Length; index++)
        for (int other = index + 1; other < all.Length; other++)
            if (all[index].DerivedResourceClaims.Keys.Intersect(all[other].DerivedResourceClaims.Keys, StringComparer.Ordinal).Any()
                && !DependsTransitively(all[index].NodeId, all[other].NodeId, nodes)
                && !DependsTransitively(all[other].NodeId, all[index].NodeId, nodes)) return true;
        return false;
    }
    private static bool DependsTransitively(string nodeId, string targetId, IReadOnlyDictionary<string, VerifiedBodyProgramNode> nodes)
    {
        HashSet<string> visited = new(StringComparer.Ordinal);
        bool Visit(string id) => visited.Add(id) && nodes[id].DependsOn.Any(dependency => dependency == targetId || (nodes.ContainsKey(dependency) && Visit(dependency)));
        return Visit(nodeId);
    }

    private static bool TryReadState(JsonElement root, out BodyProgramJournalState? state)
    {
        state = null;
        if (!Exact(root, "schemaVersion", "scope", "policyIdentity", "eventHighWater", "programs", "events") || !ReadScope(root.GetProperty("scope"), out BridgeScope? scope) || !ReadPolicy(root.GetProperty("policyIdentity"), out BodyProgramPolicyIdentity? identity) || !root.GetProperty("schemaVersion").TryGetInt32(out int version) || !root.GetProperty("eventHighWater").TryGetInt64(out long highWater) || !ReadArray(root.GetProperty("programs"), ReadProgram, out BodyProgramJournalProgram[] programs) || !ReadArray(root.GetProperty("events"), ReadEvent, out BodyProgramJournalEvent[] events)) return false;
        state = new BodyProgramJournalState(version, scope!, identity!, highWater, programs, events); return true;
    }
    private static bool ReadProgram(JsonElement value, out BodyProgramJournalProgram? program) { program = null; if (!Exact(value, "program", "state", "stopEpoch", "nodes", "facts") || !ReadVerified(value.GetProperty("program"), out VerifiedBodyProgram? verified) || !ReadEnum<BodyProgramState>(value.GetProperty("state"), out BodyProgramState state) || !value.GetProperty("stopEpoch").TryGetInt64(out long stopEpoch) || !ReadArray(value.GetProperty("nodes"), ReadNode, out BodyProgramJournalNode[] nodes) || !ReadArray(value.GetProperty("facts"), ReadFact, out RuntimeFact[] facts)) return false; program = new(verified!, state, stopEpoch, nodes, facts); return true; }
    private static bool ReadVerified(JsonElement value, out VerifiedBodyProgram? program) { program = null; if (!Exact(value, "programId", "catalogRevision", "nodes") || !ReadString(value.GetProperty("programId"), out string? id) || !value.GetProperty("catalogRevision").TryGetInt64(out long revision) || !ReadArray(value.GetProperty("nodes"), ReadVerifiedNode, out VerifiedBodyProgramNode[] nodes)) return false; program = new(id!, revision, nodes); return true; }
    private static bool ReadVerifiedNode(JsonElement value, out VerifiedBodyProgramNode? node) { node = null; if (!Exact(value, "nodeId", "actionId", "canonicalArguments", "dependsOn", "bindings", "derivedResourceClaims", "deadlineMs") || !ReadString(value.GetProperty("nodeId"), out string? id) || !ReadString(value.GetProperty("actionId"), out string? action) || !ReadCanonicalMap(value.GetProperty("canonicalArguments"), out IReadOnlyDictionary<string, BodyProgramCanonicalValue>? arguments) || !ReadStringArray(value.GetProperty("dependsOn"), out string[] dependsOn) || !ReadBindings(value.GetProperty("bindings"), out IReadOnlyDictionary<string, ActionProgramBinding>? bindings) || !ReadStringMap(value.GetProperty("derivedResourceClaims"), out IReadOnlyDictionary<string, string>? claims) || !value.GetProperty("deadlineMs").TryGetInt64(out long deadline)) return false; node = new(id!, action!, arguments!, dependsOn, bindings!, claims!, deadline); return true; }
    private static bool ReadNode(JsonElement value, out BodyProgramJournalNode? node) { node = null; if (!Exact(value, "nodeId", "state", "nodeAttempt", "admissionAttempt", "grantId", "executionBinding") || !ReadString(value.GetProperty("nodeId"), out string? id) || !ReadEnum<BodyProgramNodeState>(value.GetProperty("state"), out BodyProgramNodeState state) || !value.GetProperty("nodeAttempt").TryGetInt32(out int attempt) || !value.GetProperty("admissionAttempt").TryGetInt32(out int admission) || !ReadNullableString(value.GetProperty("grantId"), out string? grant) || !ReadNullableExecutionBinding(value.GetProperty("executionBinding"), out NodeExecutionBinding? binding)) return false; node = new(id!, state, attempt, admission, grant, binding); return true; }
    private static bool ReadNullableExecutionBinding(JsonElement value, out NodeExecutionBinding? binding) { binding = null; if (value.ValueKind == JsonValueKind.Null) return true; if (!Exact(value, "programId", "nodeId", "nodeAttempt", "requestId", "idempotencyKey", "executionId") || !ReadString(value.GetProperty("programId"), out string? program) || !ReadString(value.GetProperty("nodeId"), out string? node) || !value.GetProperty("nodeAttempt").TryGetInt32(out int attempt) || !ReadString(value.GetProperty("requestId"), out string? request) || !ReadString(value.GetProperty("idempotencyKey"), out string? key) || !ReadString(value.GetProperty("executionId"), out string? execution)) return false; binding = new(program!, node!, attempt, request!, key!, execution!); return BodyProgramValidation.IsValidExecutionBinding(binding); }
    private static bool ReadFact(JsonElement value, out RuntimeFact? fact) { fact = null; if (!Exact(value, "programId", "nodeId", "nodeAttempt", "factName", "values") || !ReadString(value.GetProperty("programId"), out string? program) || !ReadString(value.GetProperty("nodeId"), out string? node) || !value.GetProperty("nodeAttempt").TryGetInt32(out int attempt) || !ReadString(value.GetProperty("factName"), out string? name) || !ReadCanonicalMap(value.GetProperty("values"), out IReadOnlyDictionary<string, BodyProgramCanonicalValue>? values)) return false; fact = new(program!, node!, attempt, name!, values!); return true; }
    private static bool ReadEvent(JsonElement value, out BodyProgramJournalEvent? @event) { @event = null; if (!Exact(value, "cursor", "programId", "kind", "catalogRevision", "nodeId", "nodeAttempt") || !value.GetProperty("cursor").TryGetInt64(out long cursor) || !ReadString(value.GetProperty("programId"), out string? program) || !ReadString(value.GetProperty("kind"), out string? kind) || !value.GetProperty("catalogRevision").TryGetInt64(out long revision) || !ReadNullableString(value.GetProperty("nodeId"), out string? node) || !ReadNullableInt(value.GetProperty("nodeAttempt"), out int? attempt)) return false; @event = new(cursor, program!, kind!, revision, node, attempt); return true; }
    private static bool ReadScope(JsonElement value, out BridgeScope? scope) { scope = null; if (!Exact(value, "integrationId", "saveId", "worldId", "playerId", "companionId") || !ReadString(value.GetProperty("integrationId"), out string? i) || !ReadString(value.GetProperty("saveId"), out string? s) || !ReadString(value.GetProperty("worldId"), out string? w) || !ReadString(value.GetProperty("playerId"), out string? p) || !ReadString(value.GetProperty("companionId"), out string? c)) return false; scope = new(i!, s!, w!, p!, c!); return true; }
    private static bool ReadPolicy(JsonElement value, out BodyProgramPolicyIdentity? policy) { policy = null; if (!Exact(value, "value", "capabilityRevision") || !ReadString(value.GetProperty("value"), out string? valueText) || !value.GetProperty("capabilityRevision").TryGetInt64(out long revision)) return false; policy = new(valueText!, revision); return true; }
    private delegate bool Reader<T>(JsonElement element, out T? value);
    private static bool ReadArray<T>(JsonElement element, Reader<T> reader, out T[] values) { values = Array.Empty<T>(); if (element.ValueKind != JsonValueKind.Array || element.GetArrayLength() > 4096) return false; List<T> result = new(); foreach (JsonElement item in element.EnumerateArray()) { if (!reader(item, out T? itemValue) || itemValue is null) return false; result.Add(itemValue); } values = result.ToArray(); return true; }
    private static bool ReadStringArray(JsonElement value, out string[] values) => ReadArray(value, ReadString, out values);
    private static bool ReadCanonicalMap(JsonElement value, out IReadOnlyDictionary<string, BodyProgramCanonicalValue>? map)
    {
        map = null; if (value.ValueKind != JsonValueKind.Object || value.EnumerateObject().Count() > 32) return false;
        Dictionary<string, BodyProgramCanonicalValue> result = new(StringComparer.Ordinal);
        foreach (JsonProperty property in value.EnumerateObject())
        {
            if (!BodyProgramValidation.IsIdentifier(property.Name) || property.Value.ValueKind != JsonValueKind.Object || !property.Value.TryGetProperty("kind", out JsonElement kindElement) || !ReadEnum<BodyProgramArgumentKind>(kindElement, out BodyProgramArgumentKind kind)) return false;
            BodyProgramCanonicalValue item;
            if (kind == BodyProgramArgumentKind.DestinationSelector)
            {
                if (!Exact(property.Value, "kind", "destination") || !ReadSelector(property.Value.GetProperty("destination"), out BodyProgramDestinationSelector? selector)) return false;
                item = new(kind, null, selector);
            }
            else if (kind == BodyProgramArgumentKind.DestinationArrival)
            {
                if (!Exact(property.Value, "kind", "arrival") || !ReadArrival(property.Value.GetProperty("arrival"), out BodyProgramDestinationArrival? arrival)) return false;
                item = new(kind, null, null, arrival);
            }
            else
            {
                if (!Exact(property.Value, "kind", "canonicalValue") || !ReadString(property.Value.GetProperty("canonicalValue"), out string? canonical) || !BodyProgramValidation.IsValidCanonicalValue(new(kind, canonical!), kind)) return false;
                item = new(kind, canonical);
            }
            if (!result.TryAdd(property.Name, item)) return false;
        }
        map = new ReadOnlyDictionary<string, BodyProgramCanonicalValue>(result); return true;
    }
    private static bool ReadSelector(JsonElement value, out BodyProgramDestinationSelector? selector)
    {
        selector = null; if (value.ValueKind != JsonValueKind.Object || !value.TryGetProperty("kind", out JsonElement kind) || kind.ValueKind != JsonValueKind.String) return false;
        if (kind.GetString() == "label" && Exact(value, "kind", "label") && value.GetProperty("label").ValueKind == JsonValueKind.String) selector = new("label", value.GetProperty("label").GetString(), null);
        else if (kind.GetString() == "ref" && Exact(value, "kind", "ref") && value.GetProperty("ref").ValueKind == JsonValueKind.String) selector = new("ref", null, value.GetProperty("ref").GetString());
        return selector is not null && BodyProgramValidation.IsValidSelector(selector);
    }
    private static bool ReadArrival(JsonElement value, out BodyProgramDestinationArrival? arrival)
    {
        arrival = null; if (!Exact(value, "reason", "destination") || value.GetProperty("reason").ValueKind != JsonValueKind.String || value.GetProperty("destination").ValueKind != JsonValueKind.Object || !ReadArrivalDestination(value.GetProperty("destination"), out BodyProgramArrivalDestination? destination)) return false;
        arrival = new(value.GetProperty("reason").GetString()!, destination!); return BodyProgramValidation.IsValidArrival(arrival);
    }
    private static bool ReadArrivalDestination(JsonElement value, out BodyProgramArrivalDestination? destination)
    {
        destination = null; if (value.ValueKind != JsonValueKind.Object || !value.TryGetProperty("label", out JsonElement label) || label.ValueKind != JsonValueKind.String || value.EnumerateObject().Any(property => property.Name is not ("label" or "contextLabel"))) return false;
        string? context = null;
        if (value.TryGetProperty("contextLabel", out JsonElement contextElement))
        {
            if (contextElement.ValueKind != JsonValueKind.String) return false;
            context = contextElement.GetString();
        }
        destination = new(label.GetString()!, context); return true;
    }
    private static bool ReadStringMap(JsonElement value, out IReadOnlyDictionary<string, string>? map) { map = null; if (!ReadMap(value, ReadString, out Dictionary<string, string>? result)) return false; map = new ReadOnlyDictionary<string, string>(result!); return true; }
    private static bool ReadBindings(JsonElement value, out IReadOnlyDictionary<string, ActionProgramBinding>? bindings) { bindings = null; if (value.ValueKind != JsonValueKind.Object || value.EnumerateObject().Count() > 32) return false; Dictionary<string, ActionProgramBinding> result = new(StringComparer.Ordinal); foreach (JsonProperty property in value.EnumerateObject()) { if (!BodyProgramValidation.IsIdentifier(property.Name) || !Exact(property.Value, "producerNodeId", "factName") || !ReadString(property.Value.GetProperty("producerNodeId"), out string? producer) || !ReadString(property.Value.GetProperty("factName"), out string? fact) || !result.TryAdd(property.Name, new(producer!, fact!))) return false; } bindings = new ReadOnlyDictionary<string, ActionProgramBinding>(result); return true; }
    private static bool ReadMap<T>(JsonElement value, Reader<T> reader, out Dictionary<string, T>? map) { map = null; if (value.ValueKind != JsonValueKind.Object || value.EnumerateObject().Count() > 32) return false; Dictionary<string, T> result = new(StringComparer.Ordinal); foreach (JsonProperty property in value.EnumerateObject()) { if (!BodyProgramValidation.IsIdentifier(property.Name) || !reader(property.Value, out T? item) || !result.TryAdd(property.Name, item!)) return false; } map = result; return true; }
    private static bool ReadString(JsonElement value, out string? result) { result = value.ValueKind == JsonValueKind.String ? value.GetString() : null; return result is { Length: <= 4096 }; }
    private static bool ReadNullableString(JsonElement value, out string? result) { result = value.ValueKind == JsonValueKind.Null ? null : value.ValueKind == JsonValueKind.String ? value.GetString() : null; return value.ValueKind == JsonValueKind.Null || result is { Length: <= 128 }; }
    private static bool ReadNullableInt(JsonElement value, out int? result) { result = value.ValueKind == JsonValueKind.Null ? null : value.TryGetInt32(out int parsed) ? parsed : null; return value.ValueKind == JsonValueKind.Null || result is not null; }
    private static bool ReadEnum<T>(JsonElement value, out T result) where T : struct, Enum { result = default; if (!value.TryGetInt32(out int raw) || !Enum.IsDefined(typeof(T), raw)) return false; result = (T)Enum.ToObject(typeof(T), raw); return true; }
    private static bool Exact(JsonElement value, params string[] names) => value.ValueKind == JsonValueKind.Object && value.EnumerateObject().Count() == names.Length && value.EnumerateObject().Select(property => property.Name).Distinct(StringComparer.Ordinal).Count() == names.Length && value.EnumerateObject().All(property => names.Contains(property.Name, StringComparer.Ordinal));
}
