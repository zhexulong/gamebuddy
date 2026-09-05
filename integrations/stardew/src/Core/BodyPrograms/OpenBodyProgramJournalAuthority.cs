using System.Collections.ObjectModel;
using System.Text.Json;
using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew.Core.BodyPrograms;

/// <summary>Single Mod-owned dynamic program authority. Host candidates never become authority before journal commit.</summary>
public sealed class OpenBodyProgramJournalAuthority
{
    private readonly IBodyProgramJournalStore store;
    private readonly BodyProgramActionCatalog catalog;
    private readonly BridgeScope scope;
    private readonly Func<BodyProgramPolicyIdentity> currentPolicy;
    private readonly Func<long> nowMs;
    private bool policyIdentityChanged;
    private BodyProgramJournalState state;

    private OpenBodyProgramJournalAuthority(IBodyProgramJournalStore store, BodyProgramActionCatalog catalog, BridgeScope scope, Func<BodyProgramPolicyIdentity> currentPolicy,
        Func<long> nowMs, BodyProgramJournalState state, BodyProgramJournalOpenStatus status)
    {
        this.store = store; this.catalog = catalog; this.scope = scope; this.currentPolicy = currentPolicy; this.nowMs = nowMs; this.state = state; this.OpenStatus = status;
    }

    public BodyProgramJournalOpenStatus OpenStatus { get; private set; }
    public BodyProgramJournalState Snapshot => this.state;

    public static OpenBodyProgramJournalAuthority Open(IBodyProgramJournalStore store, BodyProgramActionCatalog catalog, BridgeScope scope, Func<BodyProgramPolicyIdentity> currentPolicy, Func<long> nowMs)
    {
        ArgumentNullException.ThrowIfNull(store); ArgumentNullException.ThrowIfNull(catalog); ArgumentNullException.ThrowIfNull(scope); ArgumentNullException.ThrowIfNull(currentPolicy); ArgumentNullException.ThrowIfNull(nowMs);
        BodyProgramPolicyIdentity policy = currentPolicy();
        if (!scope.IsValid || !policy.IsValid) throw new ArgumentException("Scope and policy identity must be valid.");
        try
        {
            string? encoded = store.Read();
            if (encoded is null) return new(store, catalog, scope, currentPolicy, nowMs, Empty(scope, policy), BodyProgramJournalOpenStatus.Empty);
            if (!BodyProgramJournalPersistence.TryDecode(encoded, catalog, scope, out BodyProgramJournalState? decoded) || decoded is null)
                return new(store, catalog, scope, currentPolicy, nowMs, Empty(scope, policy), BodyProgramJournalOpenStatus.Corrupt);
            BodyProgramJournalState fenced = RestartFence(decoded, out bool changed);
            var authority = new OpenBodyProgramJournalAuthority(store, catalog, scope, currentPolicy, nowMs, fenced, changed ? BodyProgramJournalOpenStatus.RecoveryRequired : BodyProgramJournalOpenStatus.Opened);
            if (changed && !authority.TryPersist(fenced)) authority.OpenStatus = BodyProgramJournalOpenStatus.PersistenceWriteFailed;
            return authority;
        }
        catch { return new(store, catalog, scope, currentPolicy, nowMs, Empty(scope, policy), BodyProgramJournalOpenStatus.PersistenceReadFailed); }
    }

    public BodyProgramVerificationReport Verify(ActionProgramCandidate candidate, IReadOnlySet<string>? restrictiveActionIds = null) => BodyProgramVerifier.Verify(candidate, this.catalog, restrictiveActionIds);

    public BodyProgramSubmitResult Submit(ActionProgramCandidate candidate, IReadOnlySet<string>? restrictiveActionIds = null)
    {
        if (!IsMutable) return new(BodyProgramSubmitCode.Quarantined, Rejected("authority_unavailable", null, "/"), null);
        BodyProgramVerificationReport verification = Verify(candidate, restrictiveActionIds);
        if (!verification.Accepted || verification.CanonicalProgram is null) return new(BodyProgramSubmitCode.Rejected, verification, null);
        BodyProgramPolicyIdentity policy = ObservePolicy();
        if (!policy.IsValid) return new(BodyProgramSubmitCode.Rejected, Rejected("policy_identity_invalid", null, "/"), null);
        bool emptyJournal = this.state.Programs.Count == 0 && this.state.Events.Count == 0;
        if (!emptyJournal && !PolicyMatches(policy, this.state.PolicyIdentity))
            return new(BodyProgramSubmitCode.Rejected, Rejected("policy_identity_stale", null, "/"), null);
        BodyProgramJournalProgram? existing = this.state.Programs.SingleOrDefault(program => program.Program.ProgramId == candidate.ProgramId);
        if (existing is not null) return new(BodyProgramCanonical.CandidateEquals(verification.CanonicalProgram, ToCandidate(existing.Program)) ? BodyProgramSubmitCode.Idempotent : BodyProgramSubmitCode.Conflict, verification, SnapshotFor(existing));
        VerifiedBodyProgram verified = BodyProgramVerifier.Accept(verification.CanonicalProgram, this.catalog, this.scope);
        var program = new BodyProgramJournalProgram(verified, BodyProgramState.Active, 0,
            Array.AsReadOnly(verified.Nodes.Select(node => new BodyProgramJournalNode(node.NodeId, BodyProgramNodeState.Pending, 0, 0, null, null)).ToArray()), Array.Empty<RuntimeFact>());
        BodyProgramJournalState next = AppendEvent(this.state with { PolicyIdentity = policy, Programs = Array.AsReadOnly(this.state.Programs.Append(program).ToArray()) }, program.Program.ProgramId, "accepted", null, null);
        if (!TryPersist(next)) return new(BodyProgramSubmitCode.PersistenceFailure, verification, null);
        return new(BodyProgramSubmitCode.Accepted, verification, SnapshotFor(this.state.Programs.Single(p => p.Program.ProgramId == program.Program.ProgramId)));
    }

    public BodyProgramStatusResult Status(string programId)
    {
        if (!BodyProgramValidation.IsIdentifier(programId)) return new(BodyProgramQueryCode.InvalidInput, null);
        BodyProgramJournalProgram? program = this.state.Programs.SingleOrDefault(item => item.Program.ProgramId == programId);
        return program is null ? new(BodyProgramQueryCode.NotFound, null) : new(BodyProgramQueryCode.Found, SnapshotFor(program));
    }

    public BodyProgramEventsResult Events(string programId, long cursor, int pageSize)
    {
        if (!BodyProgramValidation.IsIdentifier(programId) || cursor < 0 || pageSize is < 1 or > 32) return new(programId, BodyProgramQueryCode.InvalidInput, Array.Empty<BodyProgramJournalEvent>(), cursor, this.state.EventHighWater);
        if (!this.state.Programs.Any(program => program.Program.ProgramId == programId)) return new(programId, BodyProgramQueryCode.NotFound, Array.Empty<BodyProgramJournalEvent>(), cursor, this.state.EventHighWater);
        BodyProgramJournalEvent[] events = this.state.Events.Where(@event => @event.ProgramId == programId && @event.Cursor > cursor).Take(pageSize).ToArray();
        return new(programId, BodyProgramQueryCode.Found, Array.AsReadOnly(events), events.LastOrDefault()?.Cursor ?? cursor, this.state.EventHighWater);
    }

    public BodyProgramControllerResult<BodyProgramStatusSnapshot> TryStop(string programId, long stopEpoch)
    {
        if (!IsMutable) return BodyProgramControllerResult.Failure<BodyProgramStatusSnapshot>(BodyProgramControllerResultCode.RecoveryRequired);
        if (!PolicyMatches(ObservePolicy(), this.state.PolicyIdentity)) return BodyProgramControllerResult.Failure<BodyProgramStatusSnapshot>(BodyProgramControllerResultCode.PolicyIdentityStale);
        if (!TryProgram(programId, out BodyProgramJournalProgram? program)) return BodyProgramControllerResult.Failure<BodyProgramStatusSnapshot>(BodyProgramControllerResultCode.NotFound);
        if (stopEpoch <= program!.StopEpoch) return BodyProgramControllerResult.Failure<BodyProgramStatusSnapshot>(BodyProgramControllerResultCode.InvalidInput);
        BodyProgramJournalProgram stopped = program with { State = BodyProgramState.Cancelled, StopEpoch = stopEpoch,
            Nodes = Array.AsReadOnly(program.Nodes.Select(node => IsTerminal(node.State) ? node : node with { State = BodyProgramNodeState.Cancelled, GrantId = null, ExecutionBinding = null }).ToArray()) };
        if (!TryPersist(AppendEvent(ReplaceProgram(this.state, stopped), program.Program.ProgramId, "stopped", null, null))) return BodyProgramControllerResult.Failure<BodyProgramStatusSnapshot>(BodyProgramControllerResultCode.PersistenceWriteFailed);
        return BodyProgramControllerResult.Success(SnapshotFor(this.state.Programs.Single(item => item.Program.ProgramId == programId)));
    }

    public BodyProgramControllerResult<NodeAdmissionChallenge> TryCreateAdmissionChallenge(string programId)
    {
        if (!IsMutable) return BodyProgramControllerResult.Failure<NodeAdmissionChallenge>(BodyProgramControllerResultCode.RecoveryRequired);
        if (!TryProgram(programId, out BodyProgramJournalProgram? program)) return BodyProgramControllerResult.Failure<NodeAdmissionChallenge>(BodyProgramControllerResultCode.NotFound);
        BodyProgramPolicyIdentity policy = ObservePolicy();
        if (!PolicyMatches(policy, this.state.PolicyIdentity)) return BodyProgramControllerResult.Failure<NodeAdmissionChallenge>(BodyProgramControllerResultCode.PolicyIdentityStale);
        BodyProgramJournalNode? node = program!.Nodes.OrderBy(item => item.NodeId, StringComparer.Ordinal).FirstOrDefault(item => item.State == BodyProgramNodeState.Pending && DependenciesSatisfied(program, item.NodeId));
        if (node is null) return BodyProgramControllerResult.Failure<NodeAdmissionChallenge>(BodyProgramControllerResultCode.NodeNotEligible);
        VerifiedBodyProgramNode descriptor = program.Program.Nodes.Single(item => item.NodeId == node.NodeId);
        if (descriptor.DeadlineMs < this.nowMs()) return BodyProgramControllerResult.Failure<NodeAdmissionChallenge>(BodyProgramControllerResultCode.DeadlineExpired);
        BodyProgramJournalNode changed = node with { State = BodyProgramNodeState.AwaitingHostAdmission, NodeAttempt = node.NodeAttempt + 1, AdmissionAttempt = node.AdmissionAttempt + 1, GrantId = null };
        if (!TryPersist(AppendEvent(ReplaceProgram(this.state, ReplaceNode(program, changed)), program.Program.ProgramId, "admission_challenge", changed.NodeId, changed.NodeAttempt))) return BodyProgramControllerResult.Failure<NodeAdmissionChallenge>(BodyProgramControllerResultCode.PersistenceWriteFailed);
        return BodyProgramControllerResult.Success(Challenge(program, changed, descriptor, policy));
    }

    public BodyProgramControllerResult<HostAdmissionGrant> TryConsumeHostGrant(HostAdmissionGrant grant)
    {
        if (!IsMutable) return BodyProgramControllerResult.Failure<HostAdmissionGrant>(BodyProgramControllerResultCode.RecoveryRequired);
        if (grant?.ExecutionBinding is not null) return BodyProgramControllerResult.Failure<HostAdmissionGrant>(BodyProgramControllerResultCode.ExecutionBindingMismatch);
        if (!TryGrant(grant, BodyProgramNodeState.AwaitingHostAdmission, out BodyProgramJournalProgram? program, out BodyProgramJournalNode? node, out VerifiedBodyProgramNode? descriptor, out BodyProgramControllerResultCode failure)) return BodyProgramControllerResult.Failure<HostAdmissionGrant>(failure);
        NodeExecutionBinding execution = new(program!.Program.ProgramId, node!.NodeId, node.NodeAttempt, Guid.NewGuid().ToString("N"), Guid.NewGuid().ToString("N"), Guid.NewGuid().ToString("N"));
        HostAdmissionGrant boundGrant = grant! with { ExecutionBinding = execution };
        if (!TryPersist(AppendEvent(ReplaceProgram(this.state, ReplaceNode(program, node with { State = BodyProgramNodeState.HostAdmitted, GrantId = grant.GrantId, ExecutionBinding = execution })), program.Program.ProgramId, "host_admitted", node.NodeId, node.NodeAttempt))) return BodyProgramControllerResult.Failure<HostAdmissionGrant>(BodyProgramControllerResultCode.PersistenceWriteFailed);
        return BodyProgramControllerResult.Success(boundGrant);
    }

    public BodyProgramControllerResult<NodeExecutionBinding> TryBeginNativeDispatch(HostAdmissionGrant grant, NodeExecutionBinding execution)
    {
        if (!IsMutable) return BodyProgramControllerResult.Failure<NodeExecutionBinding>(BodyProgramControllerResultCode.RecoveryRequired);
        if (!TryGrant(grant, BodyProgramNodeState.HostAdmitted, out BodyProgramJournalProgram? program, out BodyProgramJournalNode? node, out _, out BodyProgramControllerResultCode failure)
            || node!.GrantId != grant.GrantId) return BodyProgramControllerResult.Failure<NodeExecutionBinding>(failure == BodyProgramControllerResultCode.Succeeded ? BodyProgramControllerResultCode.GrantMismatch : failure);
        if (!MatchesNode(execution, program!, node!) || grant.ExecutionBinding is null || !Equals(node.ExecutionBinding, grant.ExecutionBinding) || !Equals(execution, grant.ExecutionBinding)) return BodyProgramControllerResult.Failure<NodeExecutionBinding>(BodyProgramControllerResultCode.ExecutionBindingMismatch);
        BodyProgramJournalNode running = node with { State = BodyProgramNodeState.Running };
        if (!TryPersist(AppendEvent(ReplaceProgram(this.state, ReplaceNode(program!, running)), program!.Program.ProgramId, "native_dispatch", node.NodeId, node.NodeAttempt))) return BodyProgramControllerResult.Failure<NodeExecutionBinding>(BodyProgramControllerResultCode.PersistenceWriteFailed);
        return BodyProgramControllerResult.Success(execution);
    }

    public BodyProgramControllerResult<BodyProgramTerminalResult> TryComplete(HostAdmissionGrant grant, BodyProgramTerminalResult result)
    {
        if (result is null || !Enum.IsDefined(typeof(BodyProgramNodeOutcome), result.Outcome)) return BodyProgramControllerResult.Failure<BodyProgramTerminalResult>(BodyProgramControllerResultCode.InvalidInput);
        if (!IsMutable) return BodyProgramControllerResult.Failure<BodyProgramTerminalResult>(BodyProgramControllerResultCode.RecoveryRequired);
        if (!TryGrant(grant, BodyProgramNodeState.Running, out BodyProgramJournalProgram? program, out BodyProgramJournalNode? node, out VerifiedBodyProgramNode? descriptor, out BodyProgramControllerResultCode failure)
            || node!.GrantId != grant.GrantId) return BodyProgramControllerResult.Failure<BodyProgramTerminalResult>(failure == BodyProgramControllerResultCode.Succeeded ? BodyProgramControllerResultCode.GrantMismatch : failure);
        if (grant.ExecutionBinding is null || !Equals(node.ExecutionBinding, grant.ExecutionBinding) || !Equals(result.Execution, grant.ExecutionBinding)) return BodyProgramControllerResult.Failure<BodyProgramTerminalResult>(BodyProgramControllerResultCode.ExecutionBindingMismatch);
        if (result.Outcome == BodyProgramNodeOutcome.Succeeded)
        {
            if (!BodyProgramValidation.IsOpaqueTerminalProof(result.ReceiptId) || !BodyProgramValidation.IsOpaqueTerminalProof(result.Evidence) || !BodyProgramValidation.IsOpaqueTerminalProof(result.PostconditionVerification)) return BodyProgramControllerResult.Failure<BodyProgramTerminalResult>(BodyProgramControllerResultCode.TerminalProofMissing);
            bool declaresOutputFacts = this.catalog.TryGetAction(descriptor!.ActionId, out BodyProgramActionDescriptor? action) && action!.OutputFacts.Count > 0;
            if (declaresOutputFacts && (result.Fact is null || result.Fact.ProgramId != grant.ProgramId || result.Fact.NodeId != grant.NodeId || result.Fact.NodeAttempt != grant.NodeAttempt || !ValidFact(program!, result.Fact))) return BodyProgramControllerResult.Failure<BodyProgramTerminalResult>(BodyProgramControllerResultCode.FactProvenanceMismatch);
            if (!declaresOutputFacts && result.Fact is not null) return BodyProgramControllerResult.Failure<BodyProgramTerminalResult>(BodyProgramControllerResultCode.FactProvenanceMismatch);
        }
        else if (result.Fact is not null || result.ReceiptId is not null || result.Evidence is not null || result.PostconditionVerification is not null) return BodyProgramControllerResult.Failure<BodyProgramTerminalResult>(BodyProgramControllerResultCode.InvalidInput);
        BodyProgramNodeState nodeState = result.Outcome switch { BodyProgramNodeOutcome.Succeeded => BodyProgramNodeState.Succeeded, BodyProgramNodeOutcome.Failed => BodyProgramNodeState.Failed, BodyProgramNodeOutcome.Cancelled => BodyProgramNodeState.Cancelled, _ => BodyProgramNodeState.RecoveryRequired };
        BodyProgramJournalProgram updated = ReplaceNode(program!, node with { State = nodeState, GrantId = null, ExecutionBinding = null }) with { Facts = result.Outcome == BodyProgramNodeOutcome.Succeeded && result.Fact is not null ? Array.AsReadOnly(program!.Facts.Append(result.Fact).ToArray()) : program!.Facts };
        updated = updated with { State = result.Outcome switch { BodyProgramNodeOutcome.Failed => BodyProgramState.Failed, BodyProgramNodeOutcome.Cancelled => BodyProgramState.Cancelled, BodyProgramNodeOutcome.Uncertain => BodyProgramState.RecoveryRequired, _ when updated.Nodes.All(item => item.State == BodyProgramNodeState.Succeeded) => BodyProgramState.Succeeded, _ => BodyProgramState.Active } };
        if (!TryPersist(AppendEvent(ReplaceProgram(this.state, updated), program!.Program.ProgramId, "node_completed", node.NodeId, node.NodeAttempt))) return BodyProgramControllerResult.Failure<BodyProgramTerminalResult>(BodyProgramControllerResultCode.PersistenceWriteFailed);
        return BodyProgramControllerResult.Success(result);
    }

    private bool TryGrant(HostAdmissionGrant? grant, BodyProgramNodeState expected, out BodyProgramJournalProgram? program, out BodyProgramJournalNode? node, out VerifiedBodyProgramNode? descriptor, out BodyProgramControllerResultCode failure)
    {
        program = null; node = null; descriptor = null; failure = BodyProgramControllerResultCode.GrantMismatch;
        if (grant is null || !BodyProgramValidation.IsIdentifier(grant.GrantId) || !TryProgram(grant.ProgramId, out program)) return false;
        node = program!.Nodes.SingleOrDefault(item => item.NodeId == grant.NodeId);
        descriptor = program.Program.Nodes.SingleOrDefault(item => item.NodeId == grant.NodeId);
        BodyProgramPolicyIdentity policy = ObservePolicy();
        if (!PolicyMatches(policy, this.state.PolicyIdentity) || !PolicyMatches(policy, grant.PolicyIdentity)) { failure = BodyProgramControllerResultCode.PolicyIdentityStale; return false; }
        if (node is null || descriptor is null || descriptor.DeadlineMs < this.nowMs()) { failure = descriptor is not null && descriptor.DeadlineMs < this.nowMs() ? BodyProgramControllerResultCode.DeadlineExpired : failure; return false; }
        if (node.State != expected || node.NodeAttempt != grant.NodeAttempt || node.AdmissionAttempt != grant.AdmissionAttempt || grant.StopEpoch != program.StopEpoch
            || grant.CatalogRevision != program.Program.CatalogRevision || grant.CatalogRevision != this.catalog.Revision || grant.ActionId != descriptor.ActionId || grant.DeadlineMs != descriptor.DeadlineMs
            || !BodyProgramCanonical.CanonicalMapsEqual(grant.CanonicalArguments, descriptor.CanonicalArguments) || !BodyProgramCanonical.StringMapsEqual(grant.DerivedResourceClaims, descriptor.DerivedResourceClaims)
            || !DescriptorMatchesLive(descriptor)) return false;
        failure = BodyProgramControllerResultCode.Succeeded;
        return true;
    }

    private static bool MatchesNode(NodeExecutionBinding? execution, BodyProgramJournalProgram program, BodyProgramJournalNode node) => BodyProgramValidation.IsValidExecutionBinding(execution)
        && execution!.ProgramId == program.Program.ProgramId && execution.NodeId == node.NodeId && execution.NodeAttempt == node.NodeAttempt;
    private bool DescriptorMatchesLive(VerifiedBodyProgramNode node) => this.catalog.TryGetAction(node.ActionId, out BodyProgramActionDescriptor? action)
        && BodyProgramVerifier.ArgumentsMatch(node.CanonicalArguments, action!) && BodyProgramVerifier.ResourceClaimsMatch(node.DerivedResourceClaims, action!, this.scope);
    private bool IsMutable => this.OpenStatus is BodyProgramJournalOpenStatus.Empty or BodyProgramJournalOpenStatus.Opened;
    private BodyProgramPolicyIdentity ObservePolicy()
    {
        BodyProgramPolicyIdentity identity = this.currentPolicy();
        if (identity.IsValid && !identity.Equals(this.state.PolicyIdentity)) this.policyIdentityChanged = true;
        return identity;
    }
    private bool PolicyMatches(BodyProgramPolicyIdentity current, BodyProgramPolicyIdentity expected) => current.IsValid && expected.IsValid && current.Equals(expected) && !this.policyIdentityChanged;
    private bool TryProgram(string id, out BodyProgramJournalProgram? program) { program = this.state.Programs.SingleOrDefault(item => item.Program.ProgramId == id); return program is not null && program.State == BodyProgramState.Active; }
    private bool TryPersist(BodyProgramJournalState next) { if (!BodyProgramJournalPersistence.TryValidate(next, out _)) { this.OpenStatus = BodyProgramJournalOpenStatus.PersistenceWriteFailed; return false; } try { if (!this.store.TryWrite(BodyProgramJournalPersistence.Encode(next))) { this.OpenStatus = BodyProgramJournalOpenStatus.PersistenceWriteFailed; return false; } this.state = BodyProgramJournalPersistence.FreezeState(next); return true; } catch { this.OpenStatus = BodyProgramJournalOpenStatus.PersistenceWriteFailed; return false; } }
    private static BodyProgramJournalState Empty(BridgeScope scope, BodyProgramPolicyIdentity policy) => new(BodyProgramJournalPersistence.SchemaVersion, scope, policy, 0, Array.Empty<BodyProgramJournalProgram>(), Array.Empty<BodyProgramJournalEvent>());
    private static BodyProgramJournalState AppendEvent(BodyProgramJournalState source, string programId, string kind, string? nodeId, int? attempt) { long cursor = source.EventHighWater + 1; long revision = source.Programs.Single(program => program.Program.ProgramId == programId).Program.CatalogRevision; return source with { EventHighWater = cursor, Events = Array.AsReadOnly(source.Events.Append(new BodyProgramJournalEvent(cursor, programId, kind, revision, nodeId, attempt)).ToArray()) }; }
    private static BodyProgramJournalState ReplaceProgram(BodyProgramJournalState source, BodyProgramJournalProgram replacement) => source with { Programs = Array.AsReadOnly(source.Programs.Select(item => item.Program.ProgramId == replacement.Program.ProgramId ? replacement : item).ToArray()) };
    private static BodyProgramJournalProgram ReplaceNode(BodyProgramJournalProgram source, BodyProgramJournalNode replacement) => source with { Nodes = Array.AsReadOnly(source.Nodes.Select(item => item.NodeId == replacement.NodeId ? replacement : item).ToArray()) };
    private static bool DependenciesSatisfied(BodyProgramJournalProgram program, string nodeId) => program.Program.Nodes.Single(node => node.NodeId == nodeId).DependsOn.All(dependency => program.Nodes.Single(node => node.NodeId == dependency).State == BodyProgramNodeState.Succeeded);
    private bool ValidFact(BodyProgramJournalProgram program, RuntimeFact fact) { VerifiedBodyProgramNode descriptor = program.Program.Nodes.Single(node => node.NodeId == fact.NodeId); return this.catalog.TryGetAction(descriptor.ActionId, out BodyProgramActionDescriptor? action) && action!.OutputFacts.SingleOrDefault(output => output.Name == fact.FactName) is BodyProgramFactDescriptor output && fact.Values is { Count: 1 } && fact.Values.TryGetValue(fact.FactName, out BodyProgramCanonicalValue? value) && BodyProgramValidation.IsValidCanonicalValue(value, output.Kind); }
    private BodyProgramStatusSnapshot SnapshotFor(BodyProgramJournalProgram program) => new(program.Program.ProgramId, program.State, program.Program.CatalogRevision, program.StopEpoch, this.state.EventHighWater, Array.AsReadOnly(program.Nodes.ToArray()));
    private static NodeAdmissionChallenge Challenge(BodyProgramJournalProgram program, BodyProgramJournalNode node, VerifiedBodyProgramNode descriptor, BodyProgramPolicyIdentity policy) => new(program.Program.ProgramId, node.NodeId, node.NodeAttempt, node.AdmissionAttempt, program.StopEpoch, program.Program.CatalogRevision, policy, descriptor.ActionId, descriptor.CanonicalArguments, descriptor.DerivedResourceClaims, descriptor.DeadlineMs);
    private static bool IsTerminal(BodyProgramNodeState state) => state is BodyProgramNodeState.Succeeded or BodyProgramNodeState.Failed or BodyProgramNodeState.Cancelled or BodyProgramNodeState.Rejected;
    private static BodyProgramVerificationReport Rejected(string code, string? node, string path) => new(false, 0, null, new[] { new BodyProgramDiagnostic(BodyProgramDiagnosticSeverity.Error, code, node, path, code) });
    private static ActionProgramCandidate ToCandidate(VerifiedBodyProgram program) => new(program.ProgramId, program.Nodes.Select(node => new ActionProgramCandidateNode(node.NodeId, node.ActionId, node.CanonicalArguments.ToDictionary(pair => pair.Key, pair => BodyProgramValidation.ToRuntimeValue(pair.Value), StringComparer.Ordinal), node.DependsOn, node.Bindings, node.DeadlineMs)).ToArray());
    private static BodyProgramJournalState RestartFence(BodyProgramJournalState persisted, out bool changed)
    {
        changed = persisted.Programs.Any(program => !program.Nodes.All(node => IsTerminal(node.State)));
        if (!changed) return persisted;
        BodyProgramJournalProgram[] programs = persisted.Programs.Select(program => program.Nodes.All(node => IsTerminal(node.State)) ? program : program with { State = BodyProgramState.RecoveryRequired, Nodes = Array.AsReadOnly(program.Nodes.Select(node => IsTerminal(node.State) ? node : node with { State = BodyProgramNodeState.RecoveryRequired, GrantId = null, ExecutionBinding = null }).ToArray()) }).ToArray();
        return new BodyProgramJournalState(persisted.SchemaVersion, persisted.Scope, persisted.PolicyIdentity, persisted.EventHighWater, Array.AsReadOnly(programs), persisted.Events);
    }
}

internal static class BodyProgramVerifier
{
    internal static BodyProgramVerificationReport Verify(ActionProgramCandidate candidate, BodyProgramActionCatalog catalog, IReadOnlySet<string>? restrictiveActionIds)
    {
        List<BodyProgramDiagnostic> diagnostics = new();
        if (candidate is null || !BodyProgramValidation.IsIdentifier(candidate.ProgramId) || candidate.Nodes is not { Count: >= 1 and <= BodyProgramValidation.MaximumNodes }) return Reject(catalog, diagnostics, "invalid_program", null, "/");
        Dictionary<string, ActionProgramCandidateNode> nodes = new(StringComparer.Ordinal); int edges = 0;
        foreach (ActionProgramCandidateNode node in candidate.Nodes)
        {
            string path = $"/nodes/{nodes.Count}";
            if (node is null || !BodyProgramValidation.IsIdentifier(node.NodeId) || !BodyProgramValidation.IsIdentifier(node.ActionId) || node.Arguments is null || node.DependsOn is null || node.Bindings is null || !BodyProgramValidation.IsValidDeadlineMs(node.DeadlineMs) || node.DependsOn.Count > 8 || node.Bindings.Count > 4 || !nodes.TryAdd(node.NodeId, node)) { diagnostics.Add(Error("invalid_node", node?.NodeId, path)); continue; }
            edges += node.DependsOn.Count;
            if (!catalog.TryGetAction(node.ActionId, out BodyProgramActionDescriptor? action)) diagnostics.Add(Error("unknown_action", node.NodeId, path + "/actionId"));
            else if (restrictiveActionIds is not null && !restrictiveActionIds.Contains(node.ActionId)) diagnostics.Add(Error("action_not_enabled", node.NodeId, path + "/actionId"));
            else ValidateArguments(node, action!, diagnostics, path);
        }
        if (edges > 32) diagnostics.Add(Error("too_many_edges", null, "/nodes"));
        foreach (ActionProgramCandidateNode node in nodes.Values)
            if (node.DependsOn.Distinct(StringComparer.Ordinal).Count() != node.DependsOn.Count || node.DependsOn.Any(dependency => !nodes.ContainsKey(dependency) || dependency == node.NodeId))
                diagnostics.Add(Error("invalid_dependency", node.NodeId, "/nodes"));
        if (HasCycle(nodes)) diagnostics.Add(Error("cycle", null, "/nodes"));
        foreach (ActionProgramCandidateNode node in nodes.Values) ValidateBindings(node, nodes, catalog, diagnostics);
        ValidateResourceConflicts(nodes, catalog, diagnostics);
        return diagnostics.Count > 0 ? Reject(catalog, diagnostics) : new(true, catalog.Revision, Canonicalize(candidate), Array.Empty<BodyProgramDiagnostic>());
    }
    internal static VerifiedBodyProgram Accept(ActionProgramCandidate candidate, BodyProgramActionCatalog catalog, BridgeScope scope) => new(candidate.ProgramId, catalog.Revision, Array.AsReadOnly(candidate.Nodes.Select(node => new VerifiedBodyProgramNode(node.NodeId, node.ActionId, CanonicalArguments(node, catalog), Array.AsReadOnly(node.DependsOn.OrderBy(id => id, StringComparer.Ordinal).ToArray()), BodyProgramValidation.FreezeMap(node.Bindings), DeriveClaims(catalog, node.ActionId, scope), node.DeadlineMs)).ToArray()));
    internal static bool ArgumentsMatch(IReadOnlyDictionary<string, BodyProgramCanonicalValue> values, BodyProgramActionDescriptor action) => values.Count == action.Arguments.Count && action.Arguments.All(argument => values.TryGetValue(argument.Name, out BodyProgramCanonicalValue? value) && BodyProgramValidation.IsValidCanonicalValue(value, argument.Kind));
    internal static bool ResourceClaimsMatch(IReadOnlyDictionary<string, string> actual, BodyProgramActionDescriptor action, BridgeScope scope) => BodyProgramCanonical.StringMapsEqual(actual, DeriveClaims(action, scope));
    private static void ValidateArguments(ActionProgramCandidateNode node, BodyProgramActionDescriptor action, List<BodyProgramDiagnostic> diagnostics, string path) { if (node.Arguments.Count != action.Arguments.Count || action.Arguments.Any(argument => !node.Arguments.TryGetValue(argument.Name, out BodyProgramRuntimeValue? value) || !BodyProgramValidation.TryDecodeRuntimeValue(value, argument.Kind, out _))) diagnostics.Add(Error("invalid_arguments", node.NodeId, path + "/arguments")); }
    private static IReadOnlyDictionary<string, BodyProgramCanonicalValue> CanonicalArguments(ActionProgramCandidateNode node, BodyProgramActionCatalog catalog) { BodyProgramActionCatalog _ = catalog; BodyProgramActionDescriptor action = catalog.TryGetAction(node.ActionId, out BodyProgramActionDescriptor? found) ? found! : throw new InvalidOperationException(); Dictionary<string, BodyProgramCanonicalValue> result = new(StringComparer.Ordinal); foreach (BodyProgramArgumentDescriptor argument in action.Arguments) { if (!node.Arguments.TryGetValue(argument.Name, out BodyProgramRuntimeValue? value) || !BodyProgramValidation.TryDecodeRuntimeValue(value, argument.Kind, out BodyProgramCanonicalValue? canonical) || !result.TryAdd(argument.Name, canonical!)) throw new InvalidOperationException(); } return new ReadOnlyDictionary<string, BodyProgramCanonicalValue>(result); }
    private static void ValidateBindings(ActionProgramCandidateNode node, IReadOnlyDictionary<string, ActionProgramCandidateNode> nodes, BodyProgramActionCatalog catalog, List<BodyProgramDiagnostic> diagnostics) { if (!catalog.TryGetAction(node.ActionId, out BodyProgramActionDescriptor? consumerAction)) { diagnostics.Add(Error("invalid_binding", node.NodeId, "/nodes")); return; } foreach ((string argument, ActionProgramBinding binding) in node.Bindings) { BodyProgramArgumentDescriptor? consumerArgument = consumerAction!.Arguments.SingleOrDefault(item => item.Name == argument); if (binding is null || !nodes.TryGetValue(binding.ProducerNodeId, out ActionProgramCandidateNode? producer) || !node.DependsOn.Contains(binding.ProducerNodeId, StringComparer.Ordinal) || !catalog.TryGetAction(producer.ActionId, out BodyProgramActionDescriptor? producerAction) || consumerArgument is null || !producerAction!.OutputFacts.Any(fact => fact.Name == binding.FactName && fact.Kind == consumerArgument.Kind)) diagnostics.Add(Error("invalid_binding", node.NodeId, "/nodes")); } }
    private static void ValidateResourceConflicts(IReadOnlyDictionary<string, ActionProgramCandidateNode> nodes, BodyProgramActionCatalog catalog, List<BodyProgramDiagnostic> diagnostics) { ActionProgramCandidateNode[] all = nodes.Values.ToArray(); for (int index = 0; index < all.Length; index++) for (int other = index + 1; other < all.Length; other++) { if (!catalog.TryGetAction(all[index].ActionId, out BodyProgramActionDescriptor? left) || !catalog.TryGetAction(all[other].ActionId, out BodyProgramActionDescriptor? right)) continue; bool conflicts = left!.ResourceTemplate.Select(claim => claim.Key).Intersect(right!.ResourceTemplate.Select(claim => claim.Key), StringComparer.Ordinal).Any(); if (conflicts && !DependsTransitively(all[index].NodeId, all[other].NodeId, nodes) && !DependsTransitively(all[other].NodeId, all[index].NodeId, nodes)) diagnostics.Add(Error("resource_conflict", all[other].NodeId, "/nodes")); } }
    private static bool DependsTransitively(string nodeId, string targetId, IReadOnlyDictionary<string, ActionProgramCandidateNode> nodes) => nodes[nodeId].DependsOn.Any(dependency => dependency == targetId || (nodes.ContainsKey(dependency) && DependsTransitively(dependency, targetId, nodes)));
    private static IReadOnlyDictionary<string, string> DeriveClaims(BodyProgramActionCatalog catalog, string actionId, BridgeScope scope) => DeriveClaims(catalog.TryGetAction(actionId, out BodyProgramActionDescriptor? found) ? found! : throw new InvalidOperationException(), scope);
    private static IReadOnlyDictionary<string, string> DeriveClaims(BodyProgramActionDescriptor action, BridgeScope scope) { Dictionary<string, string> claims = new(StringComparer.Ordinal); foreach (BodyProgramResourceTemplateClaim claim in action.ResourceTemplate) if (!claims.TryAdd(claim.Key, claim.Value switch { BodyProgramResourceTemplateValue.ScopePlayer => scope.PlayerId, BodyProgramResourceTemplateValue.ActionId => action.ActionId, _ => throw new InvalidOperationException() })) throw new InvalidOperationException(); return new ReadOnlyDictionary<string, string>(claims); }
    private static bool HasCycle(IReadOnlyDictionary<string, ActionProgramCandidateNode> nodes) { HashSet<string> visited = new(StringComparer.Ordinal), active = new(StringComparer.Ordinal); bool Visit(string id) { if (!visited.Add(id)) return active.Contains(id); active.Add(id); bool cycle = nodes[id].DependsOn.Any(dependency => nodes.ContainsKey(dependency) && Visit(dependency)); active.Remove(id); return cycle; } return nodes.Keys.Any(Visit); }
    private static ActionProgramCandidate Canonicalize(ActionProgramCandidate candidate) => new(candidate.ProgramId, Array.AsReadOnly(candidate.Nodes.OrderBy(node => node.NodeId, StringComparer.Ordinal).Select(node => new ActionProgramCandidateNode(node.NodeId, node.ActionId, BodyProgramValidation.FreezeMap(node.Arguments), Array.AsReadOnly(node.DependsOn.OrderBy(id => id, StringComparer.Ordinal).ToArray()), BodyProgramValidation.FreezeMap(node.Bindings), node.DeadlineMs)).ToArray()));
    private static BodyProgramDiagnostic Error(string code, string? node, string path) => new(BodyProgramDiagnosticSeverity.Error, code, node, path, code);
    private static BodyProgramVerificationReport Reject(BodyProgramActionCatalog catalog, List<BodyProgramDiagnostic> diagnostics, string? code = null, string? node = null, string path = "/") { if (code is not null) diagnostics.Add(Error(code, node, path)); return new(false, catalog.Revision, null, Array.AsReadOnly(diagnostics.OrderBy(diagnostic => diagnostic.Path, StringComparer.Ordinal).ThenBy(diagnostic => diagnostic.Code, StringComparer.Ordinal).Take(64).ToArray())); }
}

internal static class BodyProgramCanonical
{
    internal static bool CandidateEquals(ActionProgramCandidate left, ActionProgramCandidate right) => left.ProgramId == right.ProgramId && left.Nodes.Count == right.Nodes.Count && left.Nodes.Zip(right.Nodes).All(pair => pair.First.NodeId == pair.Second.NodeId && pair.First.ActionId == pair.Second.ActionId && pair.First.DeadlineMs == pair.Second.DeadlineMs && RuntimeMapsEqual(pair.First.Arguments, pair.Second.Arguments) && pair.First.DependsOn.SequenceEqual(pair.Second.DependsOn) && pair.First.Bindings.OrderBy(item => item.Key).SequenceEqual(pair.Second.Bindings.OrderBy(item => item.Key)));
    internal static bool RuntimeMapsEqual(IReadOnlyDictionary<string, BodyProgramRuntimeValue> left, IReadOnlyDictionary<string, BodyProgramRuntimeValue> right) => left.Count == right.Count && left.All(pair => right.TryGetValue(pair.Key, out BodyProgramRuntimeValue? other) && pair.Value == other);
    internal static bool CanonicalMapsEqual(IReadOnlyDictionary<string, BodyProgramCanonicalValue> left, IReadOnlyDictionary<string, BodyProgramCanonicalValue> right) => left.Count == right.Count && left.All(pair => right.TryGetValue(pair.Key, out BodyProgramCanonicalValue? other) && pair.Value == other);
    internal static bool StringMapsEqual(IReadOnlyDictionary<string, string> left, IReadOnlyDictionary<string, string> right) => left.Count == right.Count && left.All(pair => right.TryGetValue(pair.Key, out string? other) && pair.Value == other);
}

public static class ActionProgramCandidateCodec
{
    public static bool TryDecode(string json, out ActionProgramCandidate? candidate, out string reason)
    {
        candidate = null; reason = "invalid_candidate";
        if (string.IsNullOrEmpty(json)) return false;
        try
        {
            using JsonDocument document = JsonDocument.Parse(json, new JsonDocumentOptions { MaxDepth = 16 });
            JsonElement root = document.RootElement;
            if (!NoDuplicateKeys(root, 0) || !Exact(root, "programId", "nodes") || root.GetProperty("programId").ValueKind != JsonValueKind.String || root.GetProperty("nodes").ValueKind != JsonValueKind.Array || root.GetProperty("nodes").GetArrayLength() is < 1 or > BodyProgramValidation.MaximumNodes) return false;
            List<ActionProgramCandidateNode> nodes = new();
            foreach (JsonElement node in root.GetProperty("nodes").EnumerateArray())
            {
                if (!Exact(node, "nodeId", "actionId", "arguments", "dependsOn", "bindings", "deadlineMs") || node.GetProperty("nodeId").ValueKind != JsonValueKind.String || node.GetProperty("actionId").ValueKind != JsonValueKind.String || !node.GetProperty("deadlineMs").TryGetInt64(out long deadline) || !BodyProgramValidation.IsValidDeadlineMs(deadline) || !ReadRuntimeMap(node.GetProperty("arguments"), out IReadOnlyDictionary<string, BodyProgramRuntimeValue>? arguments) || !ReadStringList(node.GetProperty("dependsOn"), out IReadOnlyList<string>? dependsOn) || !ReadBindings(node.GetProperty("bindings"), out IReadOnlyDictionary<string, ActionProgramBinding>? bindings)) return false;
                nodes.Add(new ActionProgramCandidateNode(node.GetProperty("nodeId").GetString()!, node.GetProperty("actionId").GetString()!, arguments!, dependsOn!, bindings!, deadline));
            }
            candidate = new ActionProgramCandidate(root.GetProperty("programId").GetString()!, Array.AsReadOnly(nodes.ToArray()));
            return true;
        }
        catch (JsonException) { return false; }
    }
    private static bool ReadRuntimeMap(JsonElement value, out IReadOnlyDictionary<string, BodyProgramRuntimeValue>? map)
    {
        map = null; if (value.ValueKind != JsonValueKind.Object || value.EnumerateObject().Count() > 32) return false;
        Dictionary<string, BodyProgramRuntimeValue> result = new(StringComparer.Ordinal);
        foreach (JsonProperty property in value.EnumerateObject())
        {
            if (!BodyProgramValidation.IsIdentifier(property.Name) || property.Value.ValueKind != JsonValueKind.Object || !property.Value.TryGetProperty("type", out JsonElement type) || type.ValueKind != JsonValueKind.String) return false;
            string token = type.GetString()!;
            BodyProgramRuntimeValue item;
            if (token == "destination_selector")
            {
                if (!Exact(property.Value, "type", "destination") || !ReadSelector(property.Value.GetProperty("destination"), out BodyProgramDestinationSelector? selector)) return false;
                item = new(token, null, selector);
            }
            else
            {
                if (!Exact(property.Value, "type", "canonicalValue") || property.Value.GetProperty("canonicalValue").ValueKind != JsonValueKind.String) return false;
                item = new(token, property.Value.GetProperty("canonicalValue").GetString());
            }
            if (!result.TryAdd(property.Name, item)) return false;
        }
        map = new ReadOnlyDictionary<string, BodyProgramRuntimeValue>(result); return true;
    }
    private static bool ReadSelector(JsonElement value, out BodyProgramDestinationSelector? selector)
    {
        selector = null; if (value.ValueKind != JsonValueKind.Object || !value.TryGetProperty("kind", out JsonElement kind) || kind.ValueKind != JsonValueKind.String) return false;
        if (kind.GetString() == "label" && Exact(value, "kind", "label") && value.GetProperty("label").ValueKind == JsonValueKind.String) selector = new("label", value.GetProperty("label").GetString(), null);
        else if (kind.GetString() == "ref" && Exact(value, "kind", "ref") && value.GetProperty("ref").ValueKind == JsonValueKind.String) selector = new("ref", null, value.GetProperty("ref").GetString());
        return selector is not null && BodyProgramValidation.IsValidSelector(selector);
    }
    private static bool ReadStringList(JsonElement value, out IReadOnlyList<string>? values) { values = null; if (value.ValueKind != JsonValueKind.Array || value.GetArrayLength() > 8) return false; List<string> result = new(); foreach (JsonElement item in value.EnumerateArray()) if (item.ValueKind != JsonValueKind.String || !BodyProgramValidation.IsIdentifier(item.GetString())) return false; else result.Add(item.GetString()!); values = Array.AsReadOnly(result.ToArray()); return true; }
    private static bool ReadBindings(JsonElement value, out IReadOnlyDictionary<string, ActionProgramBinding>? bindings) { bindings = null; if (value.ValueKind != JsonValueKind.Object || value.EnumerateObject().Count() > 32) return false; Dictionary<string, ActionProgramBinding> result = new(StringComparer.Ordinal); foreach (JsonProperty property in value.EnumerateObject()) { if (!BodyProgramValidation.IsIdentifier(property.Name) || !Exact(property.Value, "producerNodeId", "factName") || property.Value.GetProperty("producerNodeId").ValueKind != JsonValueKind.String || property.Value.GetProperty("factName").ValueKind != JsonValueKind.String || !result.TryAdd(property.Name, new(property.Value.GetProperty("producerNodeId").GetString()!, property.Value.GetProperty("factName").GetString()!))) return false; } bindings = new ReadOnlyDictionary<string, ActionProgramBinding>(result); return true; }
    private static bool NoDuplicateKeys(JsonElement value, int depth) { if (depth > 16) return false; if (value.ValueKind == JsonValueKind.Array) return value.EnumerateArray().All(item => NoDuplicateKeys(item, depth + 1)); if (value.ValueKind != JsonValueKind.Object) return true; JsonProperty[] properties = value.EnumerateObject().ToArray(); return properties.Select(property => property.Name).Distinct(StringComparer.Ordinal).Count() == properties.Length && properties.All(property => NoDuplicateKeys(property.Value, depth + 1)); }
    private static bool Exact(JsonElement value, params string[] names) => value.ValueKind == JsonValueKind.Object && value.EnumerateObject().Count() == names.Length && value.EnumerateObject().Select(property => property.Name).Distinct(StringComparer.Ordinal).Count() == names.Length && value.EnumerateObject().All(property => names.Contains(property.Name, StringComparer.Ordinal));
}
