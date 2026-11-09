using System.Collections.ObjectModel;
using System.Text.Json;
using System.Text.Json.Serialization;
using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew.Core.BodyPrograms;

/// <summary>
/// Strict exact-key codec for the complete Mod-owned dynamic BodyProgramJournal.
///
/// <para>
/// The class name and ADR-006 still call the authority `BodyProgramJournal/v1`; <see cref="SchemaVersion"/> is the
/// PAYLOAD SHAPE number and moves independently of that name. It is 5 as of the node `refusalDetail` key.
/// </para>
/// </summary>
public static class BodyProgramJournalPersistence
{
    /// <summary>
    /// The durable journal's shape version.
    ///
    /// <para>
    /// RAISED 2026-10-31 from 1, which does not cover a node's `failureCode` key, again to 3 for the event `atMs` key, and
    /// to 4 for the node `orderedAfter` key. ADR-006 requires a codec change to be an explicit schema-version decision
    /// rather than a silent reinterpretation of the old shape: a v1 payload has no `failureCode` key and must not be read
    /// as if it did, a v2 payload has no `atMs` on its events and must not be read as if its executions were timed, and a
    /// v3 payload has no `orderedAfter` on its nodes and must not be read as if every ordering edge were a dependency.
    /// </para>
    /// <para>
    /// RAISED to 5 for the node `refusalDetail` key. A v4 payload has no such key and must not be read as a node that
    /// refused without a reason: that is the difference between "this build cannot use this data" and "the Mod never had
    /// a reason", and only the version number can tell them apart.
    /// </para>
    /// <para>
    /// There is no migration/dual-read path here by design, and the two directions are NOT the same fact. An OLDER journal
    /// is superseded: counted, set aside intact, and replaced by a fresh writable one (<see cref="TryReadSchemaVersion"/>).
    /// A NEWER one stays fail-closed (`Corrupt`), because a downgrade must never destroy records it cannot read - that is
    /// the difference between "this build cannot use this data" and "this build may throw it away".
    /// </para>
    /// </summary>
    public const int SchemaVersion = 5;
    private static readonly JsonSerializerOptions WriteOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

    public static string Encode(BodyProgramJournalState state, BodyProgramActionCatalog? catalog = null, BridgeScope? expectedScope = null)
    {
        if (!TryValidate(state, out _)
            || (catalog is null) != (expectedScope is null)
            || (catalog is not null && (!expectedScope!.IsValid || !state.Scope!.Equals(expectedScope) || !MatchesCatalogProgram(state, catalog, expectedScope))))
            throw new ArgumentException("Body Program journal state is malformed.", nameof(state));
        return JsonSerializer.Serialize(state, WriteOptions);
    }

    /// <summary>
    /// The shape an older journal was written in, and the LENGTHS of what it held - no other field of it is read.
    ///
    /// <para>
    /// This is the whole read path for a payload this build is not going to interpret: <c>schemaVersion</c>, the number of
    /// programs, and the total number of node objects. Nothing is decoded, so no node - and therefore no `orderedAfter` -
    /// can be constructed from a shape that did not have one. The counts exist so the supersede can be published as a fact
    /// rather than as prose: "a fresh journal started" is not an operational statement without "and this is what it set
    /// aside".
    /// </para>
    /// <para>
    /// A payload whose version is unreadable, or whose program/node lists are not lists, answers false: that is a
    /// corruption, not a version, and the caller reads it as `Corrupt`.
    /// </para>
    /// </summary>
    internal static bool TryReadSchemaVersion(string? encoded, out int schemaVersion, out int programs, out long nodes)
    {
        schemaVersion = 0; programs = 0; nodes = 0;
        if (string.IsNullOrEmpty(encoded)) return false;
        try
        {
            using JsonDocument document = JsonDocument.Parse(encoded, new JsonDocumentOptions { MaxDepth = 16 });
            if (document.RootElement.ValueKind != JsonValueKind.Object
                || !document.RootElement.TryGetProperty("schemaVersion", out JsonElement version) || !version.TryGetInt32(out schemaVersion)
                || !document.RootElement.TryGetProperty("programs", out JsonElement list) || list.ValueKind != JsonValueKind.Array) return false;
            programs = list.GetArrayLength();
            foreach (JsonElement program in list.EnumerateArray())
            {
                if (program.ValueKind != JsonValueKind.Object || !program.TryGetProperty("nodes", out JsonElement programNodes)
                    || programNodes.ValueKind != JsonValueKind.Array) return false;
                nodes += programNodes.GetArrayLength();
            }
            return true;
        }
        catch (JsonException) { return false; }
        catch (InvalidOperationException) { return false; }
    }

    /// <summary>
    /// The name an older journal's bytes are kept under, beside the journal they were replaced in.
    ///
    /// <para>
    /// One declaration, because two readers need the same spelling: the authority asks the store to keep the bytes under
    /// this name, and the test that proves the bytes survived looks for exactly this file.
    /// </para>
    /// </summary>
    internal static string SupersededFileName(int fromSchema) => $"journal.superseded-schema-{fromSchema}.json";

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
                || state.EventHighWater < 0 || state.Programs is null || state.Events is null
                || state.Programs.Count > BodyProgramJournalRetention.MaximumPrograms || state.Events.Count > BodyProgramJournalRetention.MaximumEvents)
            { reason = "invalid_state"; return false; }

            HashSet<string> ids = new(StringComparer.Ordinal);
            foreach (BodyProgramJournalProgram program in state.Programs)
            {
                string? programRefusal = null;
                if (program is null || program.Program is null || !ids.Add(program.Program.ProgramId) || !ValidateProgram(program, state.PolicyIdentity, out programRefusal))
                { reason = "invalid_program:" + (programRefusal ?? "unknown"); return false; }
            }

            long expectedCursor = 1;
            foreach (BodyProgramJournalEvent @event in state.Events)
            {
                 if (@event is null || @event.Cursor != expectedCursor || @event.Cursor > state.EventHighWater || !ids.Contains(@event.ProgramId) || !IsValidEventKind(@event.Kind)
                    || @event.CatalogRevision < 0 || @event.AtMs < 0 || @event.AtMs > BodyProgramValidation.MaximumJavaScriptSafeInteger
                    || (@event.NodeId is not null && !BodyProgramValidation.IsIdentifier(@event.NodeId))
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
            node.ReceiptId, node.Evidence, node.PostconditionVerification, node.RecoveryDiagnostic, node.RejectionCode, node.FailureCode,
            // `Hint` and `RefusalDetail` are the last two fields of the record, and leaving either out here drops it on
            // EVERY persist: the journal held it, the projection to the wire read it, and the frozen state this authority
            // keeps answering from did not. Measured while a failed `for_each` pass tried to state its per-reason counts -
            // the counts never arrived.
            node.Hint, node.RefusalDetail)).ToArray()),
        Array.AsReadOnly(program.Facts.Select(fact => new RuntimeFact(fact.ProgramId, fact.NodeId, fact.NodeAttempt, fact.FactName, BodyProgramValidation.FreezeMap(fact.Values))).ToArray()));

    internal static VerifiedBodyProgram FreezeVerified(VerifiedBodyProgram program) => new(program.ProgramId, program.CatalogRevision,
        Array.AsReadOnly(program.Nodes.Select(node => new VerifiedBodyProgramNode(node.NodeId, node.ActionId, BodyProgramValidation.FreezeMap(node.CanonicalArguments), Array.AsReadOnly(node.DependsOn.ToArray()), BodyProgramValidation.FreezeMap(node.Bindings), BodyProgramValidation.FreezeMap(node.DerivedResourceClaims))
        {
            OrderedAfter = Array.AsReadOnly(node.OrderedAfter.ToArray()),
        }).ToArray()));

    private static bool ValidateProgram(BodyProgramJournalProgram program, BodyProgramPolicyIdentity journalPolicy, out string? refusal)
    {
        refusal = null;
        if (program.Program is null || !IsValidVerified(program.Program) || !Enum.IsDefined(program.State) || program.StopEpoch < 0
            || program.Nodes is null || program.Facts is null || program.Nodes.Count != program.Program.Nodes.Count) { refusal = "program_header"; return false; }
        // The claim-ordering rule is the verifier's own rule (`BodyProgramGraphRules.UnorderedClaimPairs`), asked of the
        // same graph the wire candidate was judged on. It answers PAIRS rather than a bool so this reader can name the node
        // the way the wire refusal does instead of answering a bare header refusal that names nothing: the same document
        // must not be `resource_conflict:<actionId>` when it is submitted and anonymous when it is persisted.
        IReadOnlyList<BodyProgramGraphNode> graph = BodyProgramGraphRules.FromJournalNodes(program);
        IReadOnlyList<(BodyProgramGraphNode First, BodyProgramGraphNode Second)> unordered = BodyProgramGraphRules.UnorderedClaimPairs(graph);
        if (unordered.Count > 0)
        {
            BodyProgramGraphNode offender = unordered[0].Second;
            refusal = $"resource_conflict:{program.Program.Nodes.Single(node => node.NodeId == offender.NodeId).ActionId}@{offender.NodeId}";
            return false;
        }

        Dictionary<string, BodyProgramJournalNode> nodes = new(StringComparer.Ordinal);
        foreach (BodyProgramJournalNode node in program.Nodes)
            if (node is null || !nodes.TryAdd(node.NodeId, node)) return false;
        foreach (VerifiedBodyProgramNode descriptor in program.Program.Nodes)
            if (!nodes.TryGetValue(descriptor.NodeId, out BodyProgramJournalNode? candidate) || !ValidateNode(program, descriptor, candidate, journalPolicy, out refusal))
            {
                refusal = "node:" + descriptor.NodeId + "/" + (refusal ?? "?");
                return false;
            }
        if (HasRejectionInconsistency(program.Program.Nodes, nodes, program.State)) { refusal = "rejection_inconsistency"; return false; }

        HashSet<string> factKeys = new(StringComparer.Ordinal);
        foreach (RuntimeFact fact in program.Facts)
        {
            if (fact is null || fact.ProgramId != program.Program.ProgramId || !nodes.TryGetValue(fact.NodeId, out BodyProgramJournalNode? node) || node.State != BodyProgramNodeState.Succeeded
                || node.NodeAttempt < 1 || fact.NodeAttempt != node.NodeAttempt || !BodyProgramValidation.IsIdentifier(fact.FactName) || fact.Values is null || fact.Values.Count != 1
                || !factKeys.Add($"{fact.NodeId}\u001f{fact.NodeAttempt}\u001f{fact.FactName}") || !fact.Values.TryGetValue(fact.FactName, out BodyProgramCanonicalValue? value)
                || value is null || !BodyProgramValidation.IsValidCanonicalValue(value, value.Kind)) return false;
        }

        IReadOnlyDictionary<string, BodyProgramNodeState> states = BodyProgramGraphRules.StatesOf(program);
        bool stateValid = program.State switch
        {
            BodyProgramState.Active => BodyProgramGraphRules.HasExecutableWork(graph, states)
                && nodes.Values.All(node => node.State is not (BodyProgramNodeState.RecoveryRequired or BodyProgramNodeState.Cancelled or BodyProgramNodeState.Abandoned)),
            BodyProgramState.Succeeded => nodes.Values.All(node => node.State == BodyProgramNodeState.Succeeded),
             BodyProgramState.Failed => nodes.Values.Any(node => node.State is BodyProgramNodeState.Failed or BodyProgramNodeState.Rejected or BodyProgramNodeState.Abandoned)
                 && !BodyProgramGraphRules.HasExecutableWork(graph, states),
            BodyProgramState.Cancelled => nodes.Values.Any(node => node.State == BodyProgramNodeState.Cancelled),
            BodyProgramState.RecoveryRequired => nodes.Values.Any(node => node.State is BodyProgramNodeState.Pending or BodyProgramNodeState.RecoveryRequired)
                && nodes.Values.All(node => node.State is BodyProgramNodeState.Pending or BodyProgramNodeState.Succeeded or BodyProgramNodeState.Failed or BodyProgramNodeState.Cancelled or BodyProgramNodeState.Rejected or BodyProgramNodeState.SkippedDependency or BodyProgramNodeState.RecoveryRequired)
                && nodes.Values.Where(node => node.State == BodyProgramNodeState.Pending).All(node => node.NodeAttempt == 0),
            BodyProgramState.Quarantined => nodes.Values.Any(node => node.State == BodyProgramNodeState.RecoveryRequired)
                && nodes.Values.All(node => node.State is BodyProgramNodeState.Succeeded or BodyProgramNodeState.Failed or BodyProgramNodeState.Cancelled or BodyProgramNodeState.Rejected or BodyProgramNodeState.SkippedDependency or BodyProgramNodeState.RecoveryRequired),
            _ => false,
        };
        if (!stateValid) refusal = "state_rule:" + program.State;
        return stateValid;
    }

    private static bool ValidateNode(BodyProgramJournalProgram program, VerifiedBodyProgramNode descriptor, BodyProgramJournalNode node, BodyProgramPolicyIdentity journalPolicy, out string? refusal)
    {
        refusal = null;
        if (!BodyProgramValidation.IsIdentifier(node.NodeId) || node.NodeId != descriptor.NodeId || !Enum.IsDefined(node.State) || node.NodeAttempt < 0 || node.AdmissionAttempt < 0
            || (node.GrantId is not null && !BodyProgramValidation.IsIdentifier(node.GrantId))) { refusal = "identity"; return false; }

        bool hasAttempt = node.NodeAttempt > 0;
        if (!hasAttempt)
        {
            if (node.AdmissionAttempt != 0 || node.CanonicalBoundArguments is not null || node.AttemptPolicyIdentity is not null || node.ClaimOwnership is not null
                || node.DerivedDeadlineMs is not null
                || node.ReceiptId is not null || node.Evidence is not null || node.PostconditionVerification is not null || node.RejectionCode is not null || node.FailureCode is not null
                || node.RefusalDetail is not null)
                { refusal = "unattempted_shape"; return false; }
        }
        else
        {
            if (node.AdmissionAttempt != node.NodeAttempt || node.CanonicalBoundArguments is null || node.AttemptPolicyIdentity is null || !node.AttemptPolicyIdentity.IsValid
                || !node.AttemptPolicyIdentity.Equals(journalPolicy) || node.ClaimOwnership is null || node.ClaimOwnership.Count != descriptor.DerivedResourceClaims.Count
                || !BodyProgramValidation.IsValidDerivedDeadlineMs(node.DerivedDeadlineMs)
                || !descriptor.DerivedResourceClaims.Keys.OrderBy(key => key, StringComparer.Ordinal).SequenceEqual(node.ClaimOwnership.Keys.OrderBy(key => key, StringComparer.Ordinal), StringComparer.Ordinal)
                || node.ClaimOwnership.Any(pair => !BodyProgramValidation.IsResourceClaimKey(pair.Key) || !Enum.IsDefined(pair.Value) || !IsClaimOwnershipValidForState(node.State, pair.Value))
                || node.CanonicalBoundArguments.Count != descriptor.CanonicalArguments.Count
                || !descriptor.CanonicalArguments.Keys.OrderBy(key => key, StringComparer.Ordinal).SequenceEqual(node.CanonicalBoundArguments.Keys.OrderBy(key => key, StringComparer.Ordinal), StringComparer.Ordinal)
                || node.CanonicalBoundArguments.Any(pair => !BodyProgramValidation.IsIdentifier(pair.Key) || pair.Value is null || !BodyProgramValidation.IsValidCanonicalValue(pair.Value, pair.Value.Kind)
                    || !descriptor.CanonicalArguments.TryGetValue(pair.Key, out BodyProgramCanonicalValue? declared) || declared is null || pair.Value.Kind != declared.Kind))
                { refusal = "attempt_shape"; return false; }
        }

        if (node.ExecutionBinding is not null && (!BodyProgramValidation.IsValidExecutionBinding(node.ExecutionBinding) || node.ExecutionBinding.NodeId != node.NodeId
            || node.ExecutionBinding.NodeAttempt != node.NodeAttempt || node.ExecutionBinding.ProgramId != program.Program.ProgramId)) { refusal = "binding"; return false; }

        bool hasRefusalDetail = node.RefusalDetail is not null;
        if (hasRefusalDetail && (!BodyProgramValidation.IsValidRefusalDetail(node.RefusalDetail) || !BodyProgramValidation.MayCarryRefusalDetail(node.State)))
            { refusal = "refusal_detail"; return false; }
        if (node.RecoveryDiagnostic is not null && !BodyProgramValidation.MayCarryRecoveryDiagnostic(node.State))
            { refusal = "recovery_diagnostic"; return false; }
        bool hasProof = node.ReceiptId is not null || node.Evidence is not null || node.PostconditionVerification is not null;
        bool hasCompleteProof = BodyProgramValidation.IsOpaqueTerminalProof(node.ReceiptId) && BodyProgramValidation.IsOpaqueTerminalProof(node.Evidence)
            && BodyProgramValidation.IsOpaqueTerminalProof(node.PostconditionVerification);
        if (node.State == BodyProgramNodeState.Rejected)
        {
            if (!hasAttempt || node.RejectionCode is null || !BodyProgramValidation.IsValidRejectionCode(node.RejectionCode)
                || node.RecoveryDiagnostic is not null || hasProof || node.GrantId is not null || node.ExecutionBinding is not null || node.FailureCode is not null) { refusal = "rejected_shape"; return false; }
        }
        else if (node.State == BodyProgramNodeState.SkippedDependency)
        {
            if (hasAttempt || node.NodeAttempt != 0 || node.AdmissionAttempt != 0 || node.GrantId is not null || node.ExecutionBinding is not null
                || node.CanonicalBoundArguments is not null || node.AttemptPolicyIdentity is not null || node.ClaimOwnership is not null
                || node.DerivedDeadlineMs is not null
                || hasProof || node.RecoveryDiagnostic is not null || node.RejectionCode is not null || node.FailureCode is not null) { refusal = "skipped_shape"; return false; }
        }
        else if (node.State == BodyProgramNodeState.Succeeded)
        {
            if (!hasAttempt || node.RejectionCode is not null || node.FailureCode is not null || node.GrantId is not null || node.ExecutionBinding is null || !hasCompleteProof || node.RecoveryDiagnostic is not null) { refusal = "succeeded_shape"; return false; }
        }
        else if (node.State is BodyProgramNodeState.Failed or BodyProgramNodeState.Cancelled)
        {
            // A dispatched node that did not succeed may name WHY - and only why. `FailureCode` is legal here because it
            // states that no effect happened; `ReceiptId`/`Evidence`/`PostconditionVerification` stay forbidden because
            // they are the proof an effect DID happen (ADR-006 `:175`), and `RejectionCode` because a deterministic veto
            // is never represented by a failed native execution (ADR-006 `:163`).
            if (node.RejectionCode is not null || hasProof || node.RecoveryDiagnostic is not null
                || (node.FailureCode is not null && !BodyProgramValidation.IsReasonCode(node.FailureCode))) { refusal = "failed_shape"; return false; }
        }
        else if (node.State is BodyProgramNodeState.Pending or BodyProgramNodeState.AwaitingHostAdmission or BodyProgramNodeState.HostAdmitted or BodyProgramNodeState.Running)
        {
            if (node.RejectionCode is not null || hasProof || node.RecoveryDiagnostic is not null || node.FailureCode is not null) { refusal = "ordinary_shape"; return false; }
        }
        else if (node.State == BodyProgramNodeState.Abandoned)
        {
            // An abandonment is only meaningful for a node that WAS dispatched: no attempt, nothing to abandon.
            if (!hasAttempt || node.ExecutionBinding is null || node.RejectionCode is not null || hasProof || node.RecoveryDiagnostic is not null || node.FailureCode is not null) { refusal = "abandoned_shape"; return false; }
        }
        else if (node.State == BodyProgramNodeState.RecoveryRequired && (node.RejectionCode is not null || hasProof || node.FailureCode is not null))
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
            case BodyProgramNodeState.Abandoned:
                // The execution binding is REQUIRED here: the whole point of the state is that it records a dispatch that
                // happened and whose outcome will never be known. Grant released, no proof, no diagnostic (the reason is
                // on the program-level abandoned event).
                return hasAttempt && node.GrantId is null && node.ExecutionBinding is not null;
            default:
                return false;
        }
    }

      /// <summary>
      /// Rejection consistency for the durable admission-outcome contract. A
      /// `Rejected` node is a deterministic terminal veto: it can never succeed,
      /// so no node depending on it can ever be attempted. Every such descendant
      /// must therefore already be `SkippedDependency`, and a `SkippedDependency`
      /// node must itself trace to a `Rejected` or `RecoveryRequired` ancestor. A
      /// rejected node whose descendant is still pending, awaiting admission, or
      /// dispatched would look runnable, so it fails closed on reopen instead of
      /// letting a reader see a rejected node with runnable-looking descendants.
      /// </summary>
      private static bool HasRejectionInconsistency(IReadOnlyList<VerifiedBodyProgramNode> descriptors, Dictionary<string, BodyProgramJournalNode> nodes, BodyProgramState programState)
      {
          Dictionary<string, VerifiedBodyProgramNode> byId = descriptors.ToDictionary(descriptor => descriptor.NodeId, StringComparer.Ordinal);
          Dictionary<string, bool> rejectedAncestor = new(StringComparer.Ordinal);
          Dictionary<string, bool> rejectedOrRecoveryAncestor = new(StringComparer.Ordinal);
          foreach (VerifiedBodyProgramNode descriptor in descriptors)
          {
              BodyProgramJournalNode node = nodes[descriptor.NodeId];
              if (node.State is BodyProgramNodeState.Pending or BodyProgramNodeState.AwaitingHostAdmission or BodyProgramNodeState.HostAdmitted or BodyProgramNodeState.Running
                  && HasAncestorIn(descriptor.NodeId, byId, nodes, rejectedAncestor, state => state == BodyProgramNodeState.Rejected)) return true;
              // A node that was skipped needs a reason UPSTREAM, unless the program itself ended as Failed - then the
              // program-level fact is the reason, which is what lets an abandoned program close its never-attempted nodes
              // instead of leaving them Pending (and therefore the program still having work, which is the poison).
              //
              // `Failed` is in the ancestor set for the same reason it is in that exception: a node whose dependency
              // failed can never be attempted, exactly as when the dependency was rejected. Without it, propagating
              // skipped to the dependents of a failed node produced a document this same validator refused - the
              // asymmetry moved rather than closed.
              if (node.State == BodyProgramNodeState.SkippedDependency && programState != BodyProgramState.Failed
                  && programState != BodyProgramState.Cancelled
                  && !HasAncestorIn(descriptor.NodeId, byId, nodes, rejectedOrRecoveryAncestor, state => state is BodyProgramNodeState.Rejected or BodyProgramNodeState.RecoveryRequired or BodyProgramNodeState.Abandoned or BodyProgramNodeState.Failed or BodyProgramNodeState.Cancelled)) return true;
          }
          return false;
      }

      private static bool HasAncestorIn(string nodeId, IReadOnlyDictionary<string, VerifiedBodyProgramNode> byId, Dictionary<string, BodyProgramJournalNode> nodes,
          Dictionary<string, bool> cache, Func<BodyProgramNodeState, bool> predicate)
      {
          if (cache.TryGetValue(nodeId, out bool cached)) return cached;
          // Provisional negative entry: a dependency cycle must not recurse forever
          // while this node's own answer is still being computed.
          cache[nodeId] = false;
          bool found = false;
          foreach (string dependency in byId[nodeId].DependsOn)
              if (nodes.TryGetValue(dependency, out BodyProgramJournalNode? dependencyNode)
                  && (predicate(dependencyNode.State) || (byId.ContainsKey(dependency) && HasAncestorIn(dependency, byId, nodes, cache, predicate))))
              { found = true; break; }
          cache[nodeId] = found;
          return found;
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
          BodyProgramNodeState.Succeeded or BodyProgramNodeState.Failed or BodyProgramNodeState.RecoveryRequired or BodyProgramNodeState.Abandoned => ownership == BodyProgramClaimOwnershipState.Released,
          // Rejected nodes never acquired (the Host veto lands while the node
          // is still AwaitingHostAdmission), so both NotAcquired and Released
          // are valid on the durable record. Cancelled covers both shapes too:
          // pre-admission cancellation never acquired; a mid-run cancellation
          // settles from Acquired to Released.
          BodyProgramNodeState.Rejected or BodyProgramNodeState.Cancelled => ownership is BodyProgramClaimOwnershipState.NotAcquired or BodyProgramClaimOwnershipState.Released,
          _ => ownership == BodyProgramClaimOwnershipState.NotAcquired,
      };
      private static bool IsValidEventKind(string? kind) => kind is "accepted" or "stopped" or "admission_challenge" or "admission_rejected"
          or "node_skipped" or "host_admitted" or "native_dispatch" or "node_completed" or "node_settled" or "abandoned";

    internal static bool IsValidVerified(VerifiedBodyProgram? program) => program is not null && BodyProgramValidation.IsIdentifier(program.ProgramId) && program.CatalogRevision >= 0
        && program.Nodes is { Count: >= 1 and <= BodyProgramValidation.MaximumNodes } && program.Nodes.All(node => node is not null && BodyProgramValidation.IsIdentifier(node.NodeId) && BodyProgramValidation.IsIdentifier(node.ActionId)
            && node.CanonicalArguments is { Count: <= 32 } && node.DependsOn is { Count: <= 8 } && node.Bindings is { Count: <= 4 } && node.DerivedResourceClaims is { Count: <= 16 }
            && node.CanonicalArguments.All(pair => BodyProgramValidation.IsIdentifier(pair.Key) && pair.Value is not null && BodyProgramValidation.IsValidCanonicalValue(pair.Value, pair.Value.Kind))
            && node.DependsOn.All(BodyProgramValidation.IsIdentifier) && node.DependsOn.Distinct(StringComparer.Ordinal).Count() == node.DependsOn.Count
            && node.OrderedAfter is { Count: <= 8 } && node.OrderedAfter.All(BodyProgramValidation.IsIdentifier)
            && node.OrderedAfter.Distinct(StringComparer.Ordinal).Count() == node.OrderedAfter.Count
            && node.Bindings.All(pair => BodyProgramValidation.IsIdentifier(pair.Key) && pair.Value is not null && BodyProgramValidation.IsIdentifier(pair.Value.ProducerNodeId) && BodyProgramValidation.IsIdentifier(pair.Value.FactName))
            && node.DerivedResourceClaims.All(pair => BodyProgramValidation.IsResourceClaimKey(pair.Key) && pair.Value is { Length: <= 4096 }))
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
            // An ordering-only predecessor is an edge of the SAME graph: it must exist and it must not be this node. Whether
            // the union is acyclic is the shared rule's question (`BodyProgramGraphRules.HasCycle`, below).
            if (node.OrderedAfter.Any(predecessor => !nodes.ContainsKey(predecessor) || predecessor == node.NodeId)) return false;
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
        IReadOnlyList<BodyProgramGraphNode> graph = BodyProgramGraphRules.FromVerified(program);
        return !BodyProgramGraphRules.HasCycle(graph) && BodyProgramGraphRules.UnorderedClaimPairs(graph).Count == 0;
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
        if (!Exact(value, "nodeId", "actionId", "canonicalArguments", "dependsOn", "orderedAfter", "bindings", "derivedResourceClaims")
            || !ReadString(value.GetProperty("nodeId"), out string? id) || !ReadString(value.GetProperty("actionId"), out string? action)
            || !ReadCanonicalMap(value.GetProperty("canonicalArguments"), out IReadOnlyDictionary<string, BodyProgramCanonicalValue>? arguments)
            || !ReadStringArray(value.GetProperty("dependsOn"), out string[] dependsOn) || !ReadStringArray(value.GetProperty("orderedAfter"), out string[] orderedAfter)
            || !ReadBindings(value.GetProperty("bindings"), out IReadOnlyDictionary<string, ActionProgramBinding>? bindings)
            || !ReadStringMap(value.GetProperty("derivedResourceClaims"), out IReadOnlyDictionary<string, string>? claims)) return false;
        node = new(id!, action!, arguments!, dependsOn, bindings!, claims!) { OrderedAfter = Array.AsReadOnly(orderedAfter) };
        return true;
    }

    private static bool ReadNode(JsonElement value, out BodyProgramJournalNode? node)
    {
        node = null;
        if (!Exact(value, "nodeId", "state", "nodeAttempt", "admissionAttempt", "grantId", "executionBinding", "canonicalBoundArguments", "attemptPolicyIdentity", "claimOwnership", "derivedDeadlineMs", "receiptId", "evidence", "postconditionVerification", "recoveryDiagnostic", "rejectionCode", "failureCode", "hint", "refusalDetail")
            || !ReadString(value.GetProperty("nodeId"), out string? id) || !ReadEnum<BodyProgramNodeState>(value.GetProperty("state"), out BodyProgramNodeState state)
            || !value.GetProperty("nodeAttempt").TryGetInt32(out int attempt) || !value.GetProperty("admissionAttempt").TryGetInt32(out int admission)
            || !ReadNullableString(value.GetProperty("grantId"), out string? grant) || !ReadNullableExecutionBinding(value.GetProperty("executionBinding"), out NodeExecutionBinding? binding)
            || !ReadNullableCanonicalMap(value.GetProperty("canonicalBoundArguments"), out IReadOnlyDictionary<string, BodyProgramCanonicalValue>? canonical)
            || !ReadNullablePolicy(value.GetProperty("attemptPolicyIdentity"), out BodyProgramPolicyIdentity? policy)
            || !ReadNullableClaimOwnership(value.GetProperty("claimOwnership"), out IReadOnlyDictionary<string, BodyProgramClaimOwnershipState>? ownership)
            || !ReadNullableDeadline(value.GetProperty("derivedDeadlineMs"), out long? derivedDeadline)
            || !ReadNullableProof(value.GetProperty("receiptId"), out string? receipt) || !ReadNullableProof(value.GetProperty("evidence"), out string? evidence)
             || !ReadNullableProof(value.GetProperty("postconditionVerification"), out string? postcondition) || !ReadNullableDiagnostic(value.GetProperty("recoveryDiagnostic"), out string? diagnostic)
             || !ReadNullableString(value.GetProperty("rejectionCode"), out string? rejectionCode)
             || !ReadNullableReasonCode(value.GetProperty("failureCode"), out string? failureCode)
             || !ReadNullableHint(value.GetProperty("hint"), out string? hint)
             || !ReadNullableRefusalDetail(value.GetProperty("refusalDetail"), out string? refusalDetail)) return false;
         node = new(id!, state, attempt, admission, grant, binding, canonical, policy, ownership, derivedDeadline, receipt, evidence, postcondition, diagnostic, rejectionCode, failureCode, hint, refusalDetail); return true;
    }

    /// <summary>
    /// A null-or-reason-code field. Anything that is neither null nor a code in the reason-code grammar fails the whole
    /// document closed: a malformed cause must never be read as "no cause", which is the defect this field exists to close.
    /// </summary>
    private static bool ReadNullableReasonCode(JsonElement value, out string? result)
    {
        result = value.ValueKind == JsonValueKind.String ? value.GetString() : null;
        return value.ValueKind == JsonValueKind.Null || (value.ValueKind == JsonValueKind.String && BodyProgramValidation.IsReasonCode(result));
    }

    /// <summary>
    /// A null-or-bounded-hint field. Anything that is neither null nor within the length bound fails the whole document
    /// closed: a malformed hint must never be read as "no hint", which is the shape this field exists to close one level
    /// up - a node that settled without telling the caller where it could go.
    /// </summary>
    private static bool ReadNullableHint(JsonElement value, out string? result)
    {
        result = value.ValueKind == JsonValueKind.String ? value.GetString() : null;
        return value.ValueKind == JsonValueKind.Null || (value.ValueKind == JsonValueKind.String && BodyProgramValidation.IsValidNodeHint(result));
    }

    /// <summary>
    /// A null-or-bounded-refusal-detail field. Anything that is neither null nor within the bound fails the whole document
    /// closed: a malformed reason must never be read as "no reason", which is the silence this field exists to end.
    /// </summary>
    private static bool ReadNullableRefusalDetail(JsonElement value, out string? result)
    {
        result = value.ValueKind == JsonValueKind.String ? value.GetString() : null;
        return value.ValueKind == JsonValueKind.Null || (value.ValueKind == JsonValueKind.String && BodyProgramValidation.IsValidRefusalDetail(result));
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
        if (!Exact(value, "cursor", "programId", "kind", "catalogRevision", "nodeId", "nodeAttempt", "atMs") || !value.GetProperty("cursor").TryGetInt64(out long cursor)
            || !ReadString(value.GetProperty("programId"), out string? program) || !ReadString(value.GetProperty("kind"), out string? kind)
            || !value.GetProperty("catalogRevision").TryGetInt64(out long revision) || !ReadNullableString(value.GetProperty("nodeId"), out string? node)
            || !ReadNullableInt(value.GetProperty("nodeAttempt"), out int? attempt) || !value.GetProperty("atMs").TryGetInt64(out long atMs)) return false;
        @event = new(cursor, program!, kind!, revision, node, attempt, atMs); return true;
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
        if (element.ValueKind != JsonValueKind.Array || element.GetArrayLength() > BodyProgramJournalRetention.MaximumEvents) return false;
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
            if (!BodyProgramValidation.IsResourceClaimKey(property.Name) || !ReadEnum<BodyProgramClaimOwnershipState>(property.Value, out BodyProgramClaimOwnershipState status)
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

    /// <summary>
    /// The derived-resource-claim map is the one string map whose keys are resource identities, not argument names:
    /// a `tool:scythe` subject is a legal key and must survive a round trip through the journal unchanged, so the
    /// key rule here is <see cref="BodyProgramValidation.IsResourceClaimKey"/> and not the bare identifier rule.
    /// </summary>
    private static bool ReadStringMap(JsonElement value, out IReadOnlyDictionary<string, string>? map)
    {
        map = null;
        if (value.ValueKind != JsonValueKind.Object || value.EnumerateObject().Count() > 32) return false;
        Dictionary<string, string> result = new(StringComparer.Ordinal);
        foreach (JsonProperty property in value.EnumerateObject())
        {
            if (!BodyProgramValidation.IsResourceClaimKey(property.Name) || !ReadString(property.Value, out string? item) || item is null
                || !result.TryAdd(property.Name, item)) return false;
        }
        map = new ReadOnlyDictionary<string, string>(result); return true;
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
