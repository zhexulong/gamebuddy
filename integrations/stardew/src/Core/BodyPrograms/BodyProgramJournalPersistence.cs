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

    public static string Encode(BodyProgramJournalState state, BodyProgramActionCatalog? catalog = null, BridgeScope? expectedScope = null)
    {
        if (!TryValidate(state, out _)
            || (catalog is null) != (expectedScope is null)
            || (catalog is not null && (!expectedScope!.IsValid || !state.Scope!.Equals(expectedScope) || !MatchesCatalogProgram(state, catalog, expectedScope))))
            throw new ArgumentException("Body Program journal state is malformed.", nameof(state));
        return JsonSerializer.Serialize(state, WriteOptions);
    }

    public static bool TryDecode(string? encoded, BodyProgramActionCatalog catalog, BridgeScope expectedScope, out BodyProgramJournalState? state)
    {
        state = null;
        if (string.IsNullOrEmpty(encoded) || catalog is null || expectedScope is null || !expectedScope.IsValid) return false;
        try
        {
            using JsonDocument document = JsonDocument.Parse(encoded, new JsonDocumentOptions { MaxDepth = 16 });
            if (!TryReadState(document.RootElement, out BodyProgramJournalState? decoded) || decoded is null || !decoded.Scope!.Equals(expectedScope)
                || !TryValidate(decoded, out _) || !MatchesCatalogProgram(decoded, catalog, expectedScope)) return false;
            state = FreezeState(decoded);
            return true;
        }
        catch (JsonException) { return false; }
        catch (InvalidOperationException) { return false; }
        catch (ArgumentException) { return false; }
        catch (KeyNotFoundException) { return false; }
    }

    internal static bool TryValidate(BodyProgramJournalState? state, out string? reason)
    {
        reason = null;
        try
        {
            if (state is null || state.SchemaVersion != SchemaVersion || state.Scope is null || !state.Scope.IsValid || state.PolicyIdentity is null || !state.PolicyIdentity.IsValid
                || state.EventHighWater < 0 || state.Programs is null || state.Events is null || state.Programs.Count > 128 || state.Events.Count > 4096)
            { reason = "invalid_state"; return false; }

            HashSet<string> ids = new(StringComparer.Ordinal);
            foreach (BodyProgramJournalProgram program in state.Programs)
                if (program is null || program.Program is null || !ids.Add(program.Program.ProgramId) || !ValidateProgram(program, state.PolicyIdentity))
                { reason = "invalid_program"; return false; }

            long expectedCursor = 1;
            foreach (BodyProgramJournalEvent @event in state.Events)
            {
                 if (@event is null || @event.Cursor != expectedCursor || @event.Cursor > state.EventHighWater || !ids.Contains(@event.ProgramId) || !IsValidEventKind(@event.Kind)
                    || @event.CatalogRevision < 0 || (@event.NodeId is not null && !BodyProgramValidation.IsIdentifier(@event.NodeId))
                     || (@event.NodeId is null) != (@event.NodeAttempt is null))
                 { reason = "invalid_event"; return false; }

                BodyProgramJournalProgram program = state.Programs.Single(item => item.Program.ProgramId == @event.ProgramId);
                if (@event.CatalogRevision != program.Program.CatalogRevision)
                { reason = "event_catalog_revision"; return false; }
                 if (@event.NodeId is not null)
                 {
                     BodyProgramJournalNode node = program.Nodes.SingleOrDefault(item => item.NodeId == @event.NodeId)!;
                      if (node is null || (@event.Kind == "node_skipped"
                              ? node.State != BodyProgramNodeState.SkippedDependency || @event.NodeAttempt != 0
                              : @event.NodeAttempt is not >= 1 || @event.NodeAttempt > node.NodeAttempt)
                          || (@event.Kind == "admission_rejected"
                              && (node.State != BodyProgramNodeState.Rejected || @event.NodeAttempt != node.NodeAttempt)))
                      { reason = "event_node_address"; return false; }
                 }
                 else if (@event.Kind == "admission_rejected")
                 { reason = "event_node_address"; return false; }
                expectedCursor++;
            }
            if ((state.Events.Count == 0 && state.EventHighWater != 0) || (state.Events.Count > 0 && state.EventHighWater != state.Events.Count))
            { reason = "event_high_water"; return false; }
            return true;
        }
        catch (InvalidOperationException) { reason = "invalid_state"; return false; }
        catch (ArgumentException) { reason = "invalid_state"; return false; }
        catch (KeyNotFoundException) { reason = "invalid_state"; return false; }
    }

    internal static BodyProgramJournalState FreezeState(BodyProgramJournalState state) => new(state.SchemaVersion, state.Scope, state.PolicyIdentity, state.EventHighWater,
        Array.AsReadOnly(state.Programs.Select(FreezeProgram).ToArray()), Array.AsReadOnly(state.Events.Select(@event => @event with { }).ToArray()));

    private static BodyProgramJournalProgram FreezeProgram(BodyProgramJournalProgram program) => new(FreezeVerified(program.Program), program.State, program.StopEpoch,
        Array.AsReadOnly(program.Nodes.Select(node => new BodyProgramJournalNode(node.NodeId, node.State, node.NodeAttempt, node.AdmissionAttempt, node.GrantId,
            node.ExecutionBinding is null ? null : node.ExecutionBinding with { },
            node.CanonicalBoundArguments is null ? null : BodyProgramValidation.FreezeMap(node.CanonicalBoundArguments),
            node.AttemptPolicyIdentity is null ? null : node.AttemptPolicyIdentity with { },
            node.ClaimOwnership is null ? null : BodyProgramValidation.FreezeMap(node.ClaimOwnership),
            node.DerivedDeadlineMs,
            node.ReceiptId, node.Evidence, node.PostconditionVerification, node.RecoveryDiagnostic, node.RejectionCode)).ToArray()),
        Array.AsReadOnly(program.Facts.Select(fact => new RuntimeFact(fact.ProgramId, fact.NodeId, fact.NodeAttempt, fact.FactName, BodyProgramValidation.FreezeMap(fact.Values))).ToArray()));

    internal static VerifiedBodyProgram FreezeVerified(VerifiedBodyProgram program) => new(program.ProgramId, program.CatalogRevision,
        Array.AsReadOnly(program.Nodes.Select(node => new VerifiedBodyProgramNode(node.NodeId, node.ActionId, BodyProgramValidation.FreezeMap(node.CanonicalArguments), Array.AsReadOnly(node.DependsOn.ToArray()), BodyProgramValidation.FreezeMap(node.Bindings), BodyProgramValidation.FreezeMap(node.DerivedResourceClaims))).ToArray()));

    private static bool ValidateProgram(BodyProgramJournalProgram program, BodyProgramPolicyIdentity journalPolicy)
    {
        if (program.Program is null || !IsValidVerified(program.Program) || HasUnorderedResourceConflict(program.Program.Nodes) || !Enum.IsDefined(program.State) || program.StopEpoch < 0
            || program.Nodes is null || program.Facts is null || program.Nodes.Count != program.Program.Nodes.Count) return false;

        Dictionary<string, BodyProgramJournalNode> nodes = new(StringComparer.Ordinal);
        foreach (BodyProgramJournalNode node in program.Nodes)
            if (node is null || !nodes.TryAdd(node.NodeId, node)) return false;
        if (!program.Program.Nodes.All(descriptor => nodes.TryGetValue(descriptor.NodeId, out BodyProgramJournalNode? node) && ValidateNode(program, descriptor, node, journalPolicy))) return false;

        HashSet<string> factKeys = new(StringComparer.Ordinal);
        foreach (RuntimeFact fact in program.Facts)
        {
            if (fact is null || fact.ProgramId != program.Program.ProgramId || !nodes.TryGetValue(fact.NodeId, out BodyProgramJournalNode? node) || node.State != BodyProgramNodeState.Succeeded
                || node.NodeAttempt < 1 || fact.NodeAttempt != node.NodeAttempt || !BodyProgramValidation.IsIdentifier(fact.FactName) || fact.Values is null || fact.Values.Count != 1
                || !factKeys.Add($"{fact.NodeId}\u001f{fact.NodeAttempt}\u001f{fact.FactName}") || !fact.Values.TryGetValue(fact.FactName, out BodyProgramCanonicalValue? value)
                || value is null || !BodyProgramValidation.IsValidCanonicalValue(value, value.Kind)) return false;
        }

        return program.State switch
        {
            BodyProgramState.Active => HasExecutableWork(program)
                && nodes.Values.All(node => node.State is not (BodyProgramNodeState.RecoveryRequired or BodyProgramNodeState.Cancelled)),
            BodyProgramState.Succeeded => nodes.Values.All(node => node.State == BodyProgramNodeState.Succeeded),
             BodyProgramState.Failed => nodes.Values.Any(node => node.State is BodyProgramNodeState.Failed or BodyProgramNodeState.Rejected)
                 && !HasExecutableWork(program),
            BodyProgramState.Cancelled => nodes.Values.Any(node => node.State == BodyProgramNodeState.Cancelled),
            BodyProgramState.RecoveryRequired => nodes.Values.Any(node => node.State is BodyProgramNodeState.Pending or BodyProgramNodeState.RecoveryRequired)
                && nodes.Values.All(node => node.State is BodyProgramNodeState.Pending or BodyProgramNodeState.Succeeded or BodyProgramNodeState.Failed or BodyProgramNodeState.Cancelled or BodyProgramNodeState.Rejected or BodyProgramNodeState.SkippedDependency or BodyProgramNodeState.RecoveryRequired)
                && nodes.Values.Where(node => node.State == BodyProgramNodeState.Pending).All(node => node.NodeAttempt == 0),
            BodyProgramState.Quarantined => nodes.Values.Any(node => node.State == BodyProgramNodeState.RecoveryRequired)
                && nodes.Values.All(node => node.State is BodyProgramNodeState.Succeeded or BodyProgramNodeState.Failed or BodyProgramNodeState.Cancelled or BodyProgramNodeState.Rejected or BodyProgramNodeState.SkippedDependency or BodyProgramNodeState.RecoveryRequired),
            _ => false,
        };
    }

    private static bool ValidateNode(BodyProgramJournalProgram program, VerifiedBodyProgramNode descriptor, BodyProgramJournalNode node, BodyProgramPolicyIdentity journalPolicy)
    {
        if (!BodyProgramValidation.IsIdentifier(node.NodeId) || node.NodeId != descriptor.NodeId || !Enum.IsDefined(node.State) || node.NodeAttempt < 0 || node.AdmissionAttempt < 0
            || (node.GrantId is not null && !BodyProgramValidation.IsIdentifier(node.GrantId))) return false;

        bool hasAttempt = node.NodeAttempt > 0;
        if (!hasAttempt)
        {
            if (node.AdmissionAttempt != 0 || node.CanonicalBoundArguments is not null || node.AttemptPolicyIdentity is not null || node.ClaimOwnership is not null
                || node.DerivedDeadlineMs is not null
                || node.ReceiptId is not null || node.Evidence is not null || node.PostconditionVerification is not null || node.RejectionCode is not null)
                return false;
        }
        else
        {
            if (node.AdmissionAttempt != node.NodeAttempt || node.CanonicalBoundArguments is null || node.AttemptPolicyIdentity is null || !node.AttemptPolicyIdentity.IsValid
                || !node.AttemptPolicyIdentity.Equals(journalPolicy) || node.ClaimOwnership is null || node.ClaimOwnership.Count != descriptor.DerivedResourceClaims.Count
                || !BodyProgramValidation.IsValidDerivedDeadlineMs(node.DerivedDeadlineMs)
                || !descriptor.DerivedResourceClaims.Keys.OrderBy(key => key, StringComparer.Ordinal).SequenceEqual(node.ClaimOwnership.Keys.OrderBy(key => key, StringComparer.Ordinal), StringComparer.Ordinal)
                || node.ClaimOwnership.Any(pair => !BodyProgramValidation.IsIdentifier(pair.Key) || !Enum.IsDefined(pair.Value) || !IsClaimOwnershipValidForState(node.State, pair.Value))
                || node.CanonicalBoundArguments.Count != descriptor.CanonicalArguments.Count
                || !descriptor.CanonicalArguments.Keys.OrderBy(key => key, StringComparer.Ordinal).SequenceEqual(node.CanonicalBoundArguments.Keys.OrderBy(key => key, StringComparer.Ordinal), StringComparer.Ordinal)
                || node.CanonicalBoundArguments.Any(pair => !BodyProgramValidation.IsIdentifier(pair.Key) || pair.Value is null || !BodyProgramValidation.IsValidCanonicalValue(pair.Value, pair.Value.Kind)
                    || !descriptor.CanonicalArguments.TryGetValue(pair.Key, out BodyProgramCanonicalValue? declared) || declared is null || pair.Value.Kind != declared.Kind))
                return false;
        }

        if (node.ExecutionBinding is not null && (!BodyProgramValidation.IsValidExecutionBinding(node.ExecutionBinding) || node.ExecutionBinding.NodeId != node.NodeId
            || node.ExecutionBinding.NodeAttempt != node.NodeAttempt || node.ExecutionBinding.ProgramId != program.Program.ProgramId)) return false;

        bool hasProof = node.ReceiptId is not null || node.Evidence is not null || node.PostconditionVerification is not null;
        bool hasCompleteProof = BodyProgramValidation.IsOpaqueTerminalProof(node.ReceiptId) && BodyProgramValidation.IsOpaqueTerminalProof(node.Evidence)
            && BodyProgramValidation.IsOpaqueTerminalProof(node.PostconditionVerification);
        if (node.State == BodyProgramNodeState.Rejected)
        {
            if (!hasAttempt || node.RejectionCode is null || !BodyProgramValidation.IsValidRejectionCode(node.RejectionCode)
                || node.RecoveryDiagnostic is not null || hasProof || node.GrantId is not null || node.ExecutionBinding is not null) return false;
        }
        else if (node.State == BodyProgramNodeState.SkippedDependency)
        {
            if (hasAttempt || node.NodeAttempt != 0 || node.AdmissionAttempt != 0 || node.GrantId is not null || node.ExecutionBinding is not null
                || node.CanonicalBoundArguments is not null || node.AttemptPolicyIdentity is not null || node.ClaimOwnership is not null
                || node.DerivedDeadlineMs is not null
                || hasProof || node.RecoveryDiagnostic is not null || node.RejectionCode is not null) return false;
        }
        else if (node.State == BodyProgramNodeState.Succeeded)
        {
            if (!hasAttempt || node.RejectionCode is not null || node.GrantId is not null || node.ExecutionBinding is null || !hasCompleteProof || node.RecoveryDiagnostic is not null) return false;
        }
        else if (node.State is BodyProgramNodeState.Pending or BodyProgramNodeState.AwaitingHostAdmission or BodyProgramNodeState.HostAdmitted or BodyProgramNodeState.Running
            or BodyProgramNodeState.Failed or BodyProgramNodeState.Cancelled)
        {
            if (node.RejectionCode is not null || hasProof || node.RecoveryDiagnostic is not null) return false;
        }
        else if (node.State == BodyProgramNodeState.RecoveryRequired && (node.RejectionCode is not null || hasProof))
        {
            return false;
        }

        switch (node.State)
        {
            case BodyProgramNodeState.Pending:
                return !hasAttempt && node.GrantId is null && node.ExecutionBinding is null;
            case BodyProgramNodeState.AwaitingHostAdmission:
                return hasAttempt && node.GrantId is null && node.ExecutionBinding is null;
            case BodyProgramNodeState.HostAdmitted:
            case BodyProgramNodeState.Running:
                return hasAttempt && node.GrantId is not null && node.ExecutionBinding is not null;
            case BodyProgramNodeState.Succeeded:
                return true;
            case BodyProgramNodeState.Failed:
                return hasAttempt && node.GrantId is null && node.ExecutionBinding is not null;
            case BodyProgramNodeState.Cancelled:
                return node.GrantId is null;
            case BodyProgramNodeState.Rejected:
                return hasAttempt && node.GrantId is null && node.ExecutionBinding is null;
            case BodyProgramNodeState.SkippedDependency:
                return !hasAttempt && node.NodeAttempt == 0 && node.AdmissionAttempt == 0 && node.GrantId is null && node.ExecutionBinding is null;
            case BodyProgramNodeState.RecoveryRequired:
                return hasAttempt && BodyProgramValidation.IsOpaqueDiagnostic(node.RecoveryDiagnostic) && node.GrantId is null;
            default:
                return false;
        }
    }

      private static bool HasExecutableWork(BodyProgramJournalProgram program)
      {
          if (program.Nodes.Any(node => node.State is BodyProgramNodeState.AwaitingHostAdmission or BodyProgramNodeState.HostAdmitted or BodyProgramNodeState.Running)) return true;
          Dictionary<string, BodyProgramJournalNode> nodes = program.Nodes.ToDictionary(node => node.NodeId, StringComparer.Ordinal);
          return program.Program.Nodes.Any(descriptor => nodes[descriptor.NodeId].State == BodyProgramNodeState.Pending
              && descriptor.DependsOn.All(dependency => nodes[dependency].State == BodyProgramNodeState.Succeeded));
      }

      /// <summary>
      /// Claim ownership must match the node's durable state: not started =
      /// NotAcquired, mid-flight (HostAdmitted/Running) = Acquired, terminal
      /// (Succeeded/Failed/Cancelled/Rejected/RecoveryRequired) = Released.
      /// SkippedDependency never touches claims. Every ownership value is the
      /// Mod-owned acquire/release transition record (ADR-006 durable
      /// ownership); a state/ownership mismatch fails closed on reopen.
      /// </summary>
      private static bool IsClaimOwnershipValidForState(BodyProgramNodeState state, BodyProgramClaimOwnershipState ownership) => state switch
      {
          BodyProgramNodeState.HostAdmitted or BodyProgramNodeState.Running => ownership == BodyProgramClaimOwnershipState.Acquired,
          BodyProgramNodeState.Succeeded or BodyProgramNodeState.Failed or BodyProgramNodeState.RecoveryRequired => ownership == BodyProgramClaimOwnershipState.Released,
          // Rejected nodes never acquired (the Host veto lands while the node
          // is still AwaitingHostAdmission), so both NotAcquired and Released
          // are valid on the durable record. Cancelled covers both shapes too:
          // pre-admission cancellation never acquired; a mid-run cancellation
          // settles from Acquired to Released.
          BodyProgramNodeState.Rejected or BodyProgramNodeState.Cancelled => ownership is BodyProgramClaimOwnershipState.NotAcquired or BodyProgramClaimOwnershipState.Released,
          _ => ownership == BodyProgramClaimOwnershipState.NotAcquired,
      };
      private static bool IsValidEventKind(string? kind) => kind is "accepted" or "stopped" or "admission_challenge" or "admission_rejected"
          or "node_skipped" or "host_admitted" or "native_dispatch" or "node_completed" or "node_settled";
      private static bool IsTerminal(BodyProgramNodeState state) => state is BodyProgramNodeState.Succeeded or BodyProgramNodeState.Failed or BodyProgramNodeState.Cancelled or BodyProgramNodeState.Rejected or BodyProgramNodeState.SkippedDependency;

    internal static bool IsValidVerified(VerifiedBodyProgram? program) => program is not null && BodyProgramValidation.IsIdentifier(program.ProgramId) && program.CatalogRevision >= 0
        && program.Nodes is { Count: >= 1 and <= BodyProgramValidation.MaximumNodes } && program.Nodes.All(node => node is not null && BodyProgramValidation.IsIdentifier(node.NodeId) && BodyProgramValidation.IsIdentifier(node.ActionId)
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
                if (!node.DependsOn.Contains(binding.ProducerNodeId, StringComparer.Ordinal) || !nodes.TryGetValue(binding.ProducerNodeId, out VerifiedBodyProgramNode? producer)
                    || !catalog.TryGetAction(producer.ActionId, out BodyProgramActionDescriptor? producerAction) || consumer is null
                    || !producerAction!.OutputFacts.Any(fact => fact.Name == binding.FactName && fact.Kind == consumer.Kind)) return false;
            }
        }

        foreach (VerifiedBodyProgramNode node in program.Nodes)
        {
            if (!catalog.TryGetAction(node.ActionId, out BodyProgramActionDescriptor? action) || !FactSetMatchesDescriptor(journal, node, action!)) return false;
            BodyProgramJournalNode journalNode = journal.Nodes.Single(item => item.NodeId == node.NodeId);
            if (journalNode.NodeAttempt > 0 && (!TryMaterializeArguments(journal, node, action!, out IReadOnlyDictionary<string, BodyProgramCanonicalValue>? materialized)
                || materialized is null || journalNode.CanonicalBoundArguments is null || !BodyProgramCanonical.CanonicalMapsEqual(journalNode.CanonicalBoundArguments, materialized))) return false;
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
                || fact.Values is not { Count: 1 } || !fact.Values.TryGetValue(fact.FactName, out BodyProgramCanonicalValue? value)
                || value is null || !BodyProgramValidation.IsValidCanonicalValue(value, output.Kind)) return false;
        }
        return action.OutputFacts.All(output => names.Contains(output.Name));
    }

    private static bool TryMaterializeArguments(BodyProgramJournalProgram journal, VerifiedBodyProgramNode descriptor, BodyProgramActionDescriptor action,
        out IReadOnlyDictionary<string, BodyProgramCanonicalValue>? materialized)
    {
        materialized = null;
        Dictionary<string, BodyProgramCanonicalValue> result = new(descriptor.CanonicalArguments, StringComparer.Ordinal);
        foreach ((string argument, ActionProgramBinding binding) in descriptor.Bindings)
        {
            BodyProgramJournalNode? producer = journal.Nodes.SingleOrDefault(item => item.NodeId == binding.ProducerNodeId);
            RuntimeFact? fact = producer is { State: BodyProgramNodeState.Succeeded }
                ? journal.Facts.SingleOrDefault(item => item.NodeId == binding.ProducerNodeId && item.NodeAttempt == producer.NodeAttempt && item.FactName == binding.FactName)
                : null;
            BodyProgramArgumentDescriptor? consumer = action.Arguments.SingleOrDefault(item => item.Name == argument);
            if (fact is null || consumer is null || fact.ProgramId != journal.Program.ProgramId || fact.Values is not { Count: 1 }
                || !fact.Values.TryGetValue(binding.FactName, out BodyProgramCanonicalValue? value) || value is null
                || !BodyProgramValidation.IsValidCanonicalValue(value, consumer.Kind)) return false;
            result[argument] = value;
        }
        materialized = BodyProgramValidation.FreezeMap(result);
        return true;
    }

    private static bool HasCycle(IReadOnlyDictionary<string, VerifiedBodyProgramNode> nodes)
    {
        HashSet<string> done = new(StringComparer.Ordinal), active = new(StringComparer.Ordinal);
        bool Visit(string id) { if (!done.Add(id)) return active.Contains(id); active.Add(id); bool cycle = nodes[id].DependsOn.Any(Visit); active.Remove(id); return cycle; }
        return nodes.Keys.Any(Visit);
    }

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
        if (!Exact(root, "schemaVersion", "scope", "policyIdentity", "eventHighWater", "programs", "events") || !ReadScope(root.GetProperty("scope"), out BridgeScope? scope)
            || !ReadPolicy(root.GetProperty("policyIdentity"), out BodyProgramPolicyIdentity? identity) || !root.GetProperty("schemaVersion").TryGetInt32(out int version)
            || !root.GetProperty("eventHighWater").TryGetInt64(out long highWater) || !ReadArray(root.GetProperty("programs"), ReadProgram, out BodyProgramJournalProgram[] programs)
            || !ReadArray(root.GetProperty("events"), ReadEvent, out BodyProgramJournalEvent[] events)) return false;
        state = new BodyProgramJournalState(version, scope!, identity!, highWater, programs, events); return true;
    }

    private static bool ReadProgram(JsonElement value, out BodyProgramJournalProgram? program)
    {
        program = null;
        if (!Exact(value, "program", "state", "stopEpoch", "nodes", "facts") || !ReadVerified(value.GetProperty("program"), out VerifiedBodyProgram? verified)
            || !ReadEnum<BodyProgramState>(value.GetProperty("state"), out BodyProgramState state) || !value.GetProperty("stopEpoch").TryGetInt64(out long stopEpoch)
            || !ReadArray(value.GetProperty("nodes"), ReadNode, out BodyProgramJournalNode[] nodes) || !ReadArray(value.GetProperty("facts"), ReadFact, out RuntimeFact[] facts)) return false;
        program = new(verified!, state, stopEpoch, nodes, facts); return true;
    }

    private static bool ReadVerified(JsonElement value, out VerifiedBodyProgram? program)
    {
        program = null;
        if (!Exact(value, "programId", "catalogRevision", "nodes") || !ReadString(value.GetProperty("programId"), out string? id)
            || !value.GetProperty("catalogRevision").TryGetInt64(out long revision) || !ReadArray(value.GetProperty("nodes"), ReadVerifiedNode, out VerifiedBodyProgramNode[] nodes)) return false;
        program = new(id!, revision, nodes); return true;
    }

    private static bool ReadVerifiedNode(JsonElement value, out VerifiedBodyProgramNode? node)
    {
        node = null;
        if (!Exact(value, "nodeId", "actionId", "canonicalArguments", "dependsOn", "bindings", "derivedResourceClaims")
            || !ReadString(value.GetProperty("nodeId"), out string? id) || !ReadString(value.GetProperty("actionId"), out string? action)
            || !ReadCanonicalMap(value.GetProperty("canonicalArguments"), out IReadOnlyDictionary<string, BodyProgramCanonicalValue>? arguments)
            || !ReadStringArray(value.GetProperty("dependsOn"), out string[] dependsOn) || !ReadBindings(value.GetProperty("bindings"), out IReadOnlyDictionary<string, ActionProgramBinding>? bindings)
            || !ReadStringMap(value.GetProperty("derivedResourceClaims"), out IReadOnlyDictionary<string, string>? claims)) return false;
        node = new(id!, action!, arguments!, dependsOn, bindings!, claims!); return true;
    }

    private static bool ReadNode(JsonElement value, out BodyProgramJournalNode? node)
    {
        node = null;
        if (!Exact(value, "nodeId", "state", "nodeAttempt", "admissionAttempt", "grantId", "executionBinding", "canonicalBoundArguments", "attemptPolicyIdentity", "claimOwnership", "derivedDeadlineMs", "receiptId", "evidence", "postconditionVerification", "recoveryDiagnostic", "rejectionCode")
            || !ReadString(value.GetProperty("nodeId"), out string? id) || !ReadEnum<BodyProgramNodeState>(value.GetProperty("state"), out BodyProgramNodeState state)
            || !value.GetProperty("nodeAttempt").TryGetInt32(out int attempt) || !value.GetProperty("admissionAttempt").TryGetInt32(out int admission)
            || !ReadNullableString(value.GetProperty("grantId"), out string? grant) || !ReadNullableExecutionBinding(value.GetProperty("executionBinding"), out NodeExecutionBinding? binding)
            || !ReadNullableCanonicalMap(value.GetProperty("canonicalBoundArguments"), out IReadOnlyDictionary<string, BodyProgramCanonicalValue>? canonical)
            || !ReadNullablePolicy(value.GetProperty("attemptPolicyIdentity"), out BodyProgramPolicyIdentity? policy)
            || !ReadNullableClaimOwnership(value.GetProperty("claimOwnership"), out IReadOnlyDictionary<string, BodyProgramClaimOwnershipState>? ownership)
            || !ReadNullableDeadline(value.GetProperty("derivedDeadlineMs"), out long? derivedDeadline)
            || !ReadNullableProof(value.GetProperty("receiptId"), out string? receipt) || !ReadNullableProof(value.GetProperty("evidence"), out string? evidence)
             || !ReadNullableProof(value.GetProperty("postconditionVerification"), out string? postcondition) || !ReadNullableDiagnostic(value.GetProperty("recoveryDiagnostic"), out string? diagnostic)
             || !ReadNullableString(value.GetProperty("rejectionCode"), out string? rejectionCode)) return false;
         node = new(id!, state, attempt, admission, grant, binding, canonical, policy, ownership, derivedDeadline, receipt, evidence, postcondition, diagnostic, rejectionCode); return true;
    }

    private static bool ReadNullableDeadline(JsonElement value, out long? deadline)
    {
        deadline = null;
        if (value.ValueKind == JsonValueKind.Null) return true;
        if (!value.TryGetInt64(out long parsed) || !BodyProgramValidation.IsValidDerivedDeadlineMs(parsed)) return false;
        deadline = parsed;
        return true;
    }

    private static bool ReadNullableExecutionBinding(JsonElement value, out NodeExecutionBinding? binding)
    {
        binding = null;
        if (value.ValueKind == JsonValueKind.Null) return true;
        if (!Exact(value, "programId", "nodeId", "nodeAttempt", "requestId", "idempotencyKey", "executionId") || !ReadString(value.GetProperty("programId"), out string? program)
            || !ReadString(value.GetProperty("nodeId"), out string? node) || !value.GetProperty("nodeAttempt").TryGetInt32(out int attempt)
            || !ReadString(value.GetProperty("requestId"), out string? request) || !ReadString(value.GetProperty("idempotencyKey"), out string? key)
            || !ReadString(value.GetProperty("executionId"), out string? execution)) return false;
        binding = new(program!, node!, attempt, request!, key!, execution!); return BodyProgramValidation.IsValidExecutionBinding(binding);
    }

    private static bool ReadFact(JsonElement value, out RuntimeFact? fact)
    {
        fact = null;
        if (!Exact(value, "programId", "nodeId", "nodeAttempt", "factName", "values") || !ReadString(value.GetProperty("programId"), out string? program)
            || !ReadString(value.GetProperty("nodeId"), out string? node) || !value.GetProperty("nodeAttempt").TryGetInt32(out int attempt)
            || !ReadString(value.GetProperty("factName"), out string? name) || !ReadCanonicalMap(value.GetProperty("values"), out IReadOnlyDictionary<string, BodyProgramCanonicalValue>? values)) return false;
        fact = new(program!, node!, attempt, name!, values!); return true;
    }

    private static bool ReadEvent(JsonElement value, out BodyProgramJournalEvent? @event)
    {
        @event = null;
        if (!Exact(value, "cursor", "programId", "kind", "catalogRevision", "nodeId", "nodeAttempt") || !value.GetProperty("cursor").TryGetInt64(out long cursor)
            || !ReadString(value.GetProperty("programId"), out string? program) || !ReadString(value.GetProperty("kind"), out string? kind)
            || !value.GetProperty("catalogRevision").TryGetInt64(out long revision) || !ReadNullableString(value.GetProperty("nodeId"), out string? node)
            || !ReadNullableInt(value.GetProperty("nodeAttempt"), out int? attempt)) return false;
        @event = new(cursor, program!, kind!, revision, node, attempt); return true;
    }

    private static bool ReadScope(JsonElement value, out BridgeScope? scope)
    {
        scope = null;
        if (!Exact(value, "integrationId", "saveId", "worldId", "playerId", "companionId") || !ReadString(value.GetProperty("integrationId"), out string? i)
            || !ReadString(value.GetProperty("saveId"), out string? s) || !ReadString(value.GetProperty("worldId"), out string? w)
            || !ReadString(value.GetProperty("playerId"), out string? p) || !ReadString(value.GetProperty("companionId"), out string? c)) return false;
        scope = new(i!, s!, w!, p!, c!); return true;
    }

    private static bool ReadPolicy(JsonElement value, out BodyProgramPolicyIdentity? policy)
    {
        policy = null;
        if (!Exact(value, "value", "capabilityRevision") || !ReadString(value.GetProperty("value"), out string? valueText)
            || !value.GetProperty("capabilityRevision").TryGetInt64(out long revision)) return false;
        policy = new(valueText!, revision); return true;
    }

    private delegate bool Reader<T>(JsonElement element, out T? value);

    private static bool ReadArray<T>(JsonElement element, Reader<T> reader, out T[] values)
    {
        values = Array.Empty<T>();
        if (element.ValueKind != JsonValueKind.Array || element.GetArrayLength() > 4096) return false;
        List<T> result = new();
        foreach (JsonElement item in element.EnumerateArray())
        {
            if (!reader(item, out T? itemValue) || itemValue is null) return false;
            result.Add(itemValue);
        }
        values = result.ToArray(); return true;
    }

    private static bool ReadStringArray(JsonElement value, out string[] values) => ReadArray(value, ReadString, out values);

    private static bool ReadCanonicalMap(JsonElement value, out IReadOnlyDictionary<string, BodyProgramCanonicalValue>? map)
    {
        map = null;
        if (value.ValueKind != JsonValueKind.Object || value.EnumerateObject().Count() > 32) return false;
        Dictionary<string, BodyProgramCanonicalValue> result = new(StringComparer.Ordinal);
        foreach (JsonProperty property in value.EnumerateObject())
        {
            if (!BodyProgramValidation.IsIdentifier(property.Name) || property.Value.ValueKind != JsonValueKind.Object || !property.Value.TryGetProperty("kind", out JsonElement kindElement)
                || !ReadEnum<BodyProgramArgumentKind>(kindElement, out BodyProgramArgumentKind kind)) return false;
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
                if (!Exact(property.Value, "kind", "canonicalValue") || !ReadString(property.Value.GetProperty("canonicalValue"), out string? canonical)
                    || !BodyProgramValidation.IsValidCanonicalValue(new(kind, canonical!), kind)) return false;
                item = new(kind, canonical);
            }
            if (!result.TryAdd(property.Name, item)) return false;
        }
        map = new ReadOnlyDictionary<string, BodyProgramCanonicalValue>(result); return true;
    }

    private static bool ReadNullableCanonicalMap(JsonElement value, out IReadOnlyDictionary<string, BodyProgramCanonicalValue>? map)
    {
        map = null;
        return value.ValueKind == JsonValueKind.Null || ReadCanonicalMap(value, out map);
    }

    private static bool ReadSelector(JsonElement value, out BodyProgramDestinationSelector? selector)
    {
        selector = null;
        if (value.ValueKind != JsonValueKind.Object || !value.TryGetProperty("kind", out JsonElement kind) || kind.ValueKind != JsonValueKind.String) return false;
        if (kind.GetString() == "label" && Exact(value, "kind", "label") && value.GetProperty("label").ValueKind == JsonValueKind.String) selector = new("label", value.GetProperty("label").GetString(), null);
        else if (kind.GetString() == "ref" && Exact(value, "kind", "ref") && value.GetProperty("ref").ValueKind == JsonValueKind.String) selector = new("ref", null, value.GetProperty("ref").GetString());
        return selector is not null && BodyProgramValidation.IsValidSelector(selector);
    }

    private static bool ReadArrival(JsonElement value, out BodyProgramDestinationArrival? arrival)
    {
        arrival = null;
        if (!Exact(value, "reason", "destination") || value.GetProperty("reason").ValueKind != JsonValueKind.String || value.GetProperty("destination").ValueKind != JsonValueKind.Object
            || !ReadArrivalDestination(value.GetProperty("destination"), out BodyProgramArrivalDestination? destination)) return false;
        arrival = new(value.GetProperty("reason").GetString()!, destination!); return BodyProgramValidation.IsValidArrival(arrival);
    }

    private static bool ReadArrivalDestination(JsonElement value, out BodyProgramArrivalDestination? destination)
    {
        destination = null;
        if (value.ValueKind != JsonValueKind.Object || !value.TryGetProperty("label", out JsonElement label) || label.ValueKind != JsonValueKind.String
            || value.EnumerateObject().Count() is < 1 or > 2 || value.EnumerateObject().Select(property => property.Name).Distinct(StringComparer.Ordinal).Count() != value.EnumerateObject().Count()
            || value.EnumerateObject().Any(property => property.Name is not ("label" or "contextLabel"))) return false;
        string? context = null;
        if (value.TryGetProperty("contextLabel", out JsonElement contextElement))
        {
            if (contextElement.ValueKind != JsonValueKind.String) return false;
            context = contextElement.GetString();
        }
        destination = new(label.GetString()!, context); return true;
    }

    private static bool ReadNullablePolicy(JsonElement value, out BodyProgramPolicyIdentity? policy)
    {
        policy = null;
        return value.ValueKind == JsonValueKind.Null || ReadPolicy(value, out policy);
    }

    private static bool ReadNullableClaimOwnership(JsonElement value, out IReadOnlyDictionary<string, BodyProgramClaimOwnershipState>? ownership)
    {
        ownership = null;
        if (value.ValueKind == JsonValueKind.Null) return true;
        if (value.ValueKind != JsonValueKind.Object || value.EnumerateObject().Count() > 16) return false;
        Dictionary<string, BodyProgramClaimOwnershipState> result = new(StringComparer.Ordinal);
        foreach (JsonProperty property in value.EnumerateObject())
        {
            if (!BodyProgramValidation.IsIdentifier(property.Name) || !ReadEnum<BodyProgramClaimOwnershipState>(property.Value, out BodyProgramClaimOwnershipState status)
                || !result.TryAdd(property.Name, status)) return false;
        }
        ownership = new ReadOnlyDictionary<string, BodyProgramClaimOwnershipState>(result); return true;
    }

    private static bool ReadNullableProof(JsonElement value, out string? result)
    {
        result = value.ValueKind == JsonValueKind.Null ? null : value.ValueKind == JsonValueKind.String ? value.GetString() : null;
        return value.ValueKind == JsonValueKind.Null || BodyProgramValidation.IsOpaqueTerminalProof(result);
    }

    private static bool ReadNullableDiagnostic(JsonElement value, out string? result)
    {
        result = value.ValueKind == JsonValueKind.Null ? null : value.ValueKind == JsonValueKind.String ? value.GetString() : null;
        return value.ValueKind == JsonValueKind.Null || BodyProgramValidation.IsOpaqueDiagnostic(result);
    }

    private static bool ReadStringMap(JsonElement value, out IReadOnlyDictionary<string, string>? map)
    {
        map = null;
        if (!ReadMap(value, ReadString, out Dictionary<string, string>? result)) return false;
        map = new ReadOnlyDictionary<string, string>(result!); return true;
    }

    private static bool ReadBindings(JsonElement value, out IReadOnlyDictionary<string, ActionProgramBinding>? bindings)
    {
        bindings = null;
        if (value.ValueKind != JsonValueKind.Object || value.EnumerateObject().Count() > 32) return false;
        Dictionary<string, ActionProgramBinding> result = new(StringComparer.Ordinal);
        foreach (JsonProperty property in value.EnumerateObject())
        {
            if (!BodyProgramValidation.IsIdentifier(property.Name) || !Exact(property.Value, "producerNodeId", "factName")
                || !ReadString(property.Value.GetProperty("producerNodeId"), out string? producer) || !ReadString(property.Value.GetProperty("factName"), out string? fact)
                || !result.TryAdd(property.Name, new(producer!, fact!))) return false;
        }
        bindings = new ReadOnlyDictionary<string, ActionProgramBinding>(result); return true;
    }

    private static bool ReadMap<T>(JsonElement value, Reader<T> reader, out Dictionary<string, T>? map)
    {
        map = null;
        if (value.ValueKind != JsonValueKind.Object || value.EnumerateObject().Count() > 32) return false;
        Dictionary<string, T> result = new(StringComparer.Ordinal);
        foreach (JsonProperty property in value.EnumerateObject())
        {
            if (!BodyProgramValidation.IsIdentifier(property.Name) || !reader(property.Value, out T? item) || item is null || !result.TryAdd(property.Name, item)) return false;
        }
        map = result; return true;
    }

    private static bool ReadString(JsonElement value, out string? result)
    {
        result = value.ValueKind == JsonValueKind.String ? value.GetString() : null;
        return result is { Length: <= 4096 };
    }

    private static bool ReadNullableString(JsonElement value, out string? result)
    {
        result = value.ValueKind == JsonValueKind.Null ? null : value.ValueKind == JsonValueKind.String ? value.GetString() : null;
        return value.ValueKind == JsonValueKind.Null || result is { Length: <= 128 };
    }

    private static bool ReadNullableInt(JsonElement value, out int? result)
    {
        result = value.ValueKind == JsonValueKind.Null ? null : value.TryGetInt32(out int parsed) ? parsed : null;
        return value.ValueKind == JsonValueKind.Null || result is not null;
    }

    private static bool ReadEnum<T>(JsonElement value, out T result) where T : struct, Enum
    {
        result = default;
        if (!value.TryGetInt32(out int raw) || !Enum.IsDefined(typeof(T), raw)) return false;
        result = (T)Enum.ToObject(typeof(T), raw); return true;
    }

    private static bool Exact(JsonElement value, params string[] names) => value.ValueKind == JsonValueKind.Object && value.EnumerateObject().Count() == names.Length
        && value.EnumerateObject().Select(property => property.Name).Distinct(StringComparer.Ordinal).Count() == names.Length
        && value.EnumerateObject().All(property => names.Contains(property.Name, StringComparer.Ordinal));
}
