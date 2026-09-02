using System.Collections.ObjectModel;
using GameBuddy.Stardew.Core.Policy;

namespace GameBuddy.Stardew.Core.BodyPrograms;

/// <summary>
/// Game-thread Body Program authority. It admits only catalog-defined nodes and
/// rechecks embodiment-local policy identity at grant consume and completion.
/// </summary>
public sealed class FarmhandBodyProgramController
{
    private readonly OpenBodyProgramJournalAuthority authority;
    private readonly Func<FarmhandCapabilityPublication> publication;
    private readonly Func<BodyProgramPolicyIdentity> policyIdentity;

    public FarmhandBodyProgramController(
        OpenBodyProgramJournalAuthority authority,
        Func<FarmhandCapabilityPublication> publication,
        Func<BodyProgramPolicyIdentity> policyIdentity)
    {
        this.authority = authority ?? throw new ArgumentNullException(nameof(authority));
        this.publication = publication ?? throw new ArgumentNullException(nameof(publication));
        this.policyIdentity = policyIdentity ?? throw new ArgumentNullException(nameof(policyIdentity));
    }

    public BodyProgramJournalOpenStatus OpenStatus => this.authority.Status;

    public BodyProgramControllerResult<BodyProgramJournalProgram> TryStart(string programId)
    {
        if (!this.authority.IsUsable)
            return BodyProgramControllerResult.Failure<BodyProgramJournalProgram>(BodyProgramControllerResultCode.RecoveryRequired);
        if (!BodyProgramValidation.IsIdentifier(programId) || !this.authority.Catalog.TryGetDescriptor(programId, out BodyProgramDescriptor? descriptor))
            return BodyProgramControllerResult.Failure<BodyProgramJournalProgram>(BodyProgramControllerResultCode.NotFound);
        if (this.authority.Snapshot.Programs.Any(program => program.ProgramId == programId))
            return BodyProgramControllerResult.Failure<BodyProgramJournalProgram>(BodyProgramControllerResultCode.InvalidInput);
        BodyProgramPolicyIdentity identity = this.policyIdentity();
        if (!identity.IsValid)
            return BodyProgramControllerResult.Failure<BodyProgramJournalProgram>(BodyProgramControllerResultCode.PolicyIdentityStale);
        BodyProgramJournalProgram program = new(
            programId,
            descriptor!,
            BodyProgramState.Active,
            Array.AsReadOnly(descriptor!.Nodes.Select(node => new BodyProgramJournalNode(
                node.NodeId,
                BodyProgramNodeState.Pending,
                0,
                EmptyAttempts())).ToArray()));
        BodyProgramJournalState next = this.authority.Snapshot with
        {
            PolicyIdentity = identity,
            Programs = Array.AsReadOnly(this.authority.Snapshot.Programs.Append(program).ToArray()),
        };
        return this.authority.TryPersist(next)
            ? BodyProgramControllerResult.Success(program)
            : BodyProgramControllerResult.Failure<BodyProgramJournalProgram>(BodyProgramControllerResultCode.PersistenceWriteFailed);
    }

    public BodyProgramControllerResult<BodyProgramGrant> TryGrant(string programId, string nodeId)
    {
        if (!this.authority.IsUsable)
            return BodyProgramControllerResult.Failure<BodyProgramGrant>(BodyProgramControllerResultCode.RecoveryRequired);
        if (!TryGetActive(programId, nodeId, out BodyProgramJournalProgram? program, out BodyProgramJournalNode? node, out BodyProgramNodeDescriptor? descriptor))
            return BodyProgramControllerResult.Failure<BodyProgramGrant>(BodyProgramControllerResultCode.NotFound);
        if (node!.State != BodyProgramNodeState.Pending)
            return BodyProgramControllerResult.Failure<BodyProgramGrant>(BodyProgramControllerResultCode.NodeAlreadyStarted);
        BodyProgramPolicyIdentity identity = this.policyIdentity();
        if (!IsFreshIdentity(identity))
            return BodyProgramControllerResult.Failure<BodyProgramGrant>(BodyProgramControllerResultCode.PolicyIdentityStale);
        if (!this.publication().CapabilitySet.AllowsExecutionAction(descriptor!.ActionId))
            return BodyProgramControllerResult.Failure<BodyProgramGrant>(BodyProgramControllerResultCode.ActionNotEnabled);
        if (!PredecessorsSucceeded(program!, nodeId))
            return BodyProgramControllerResult.Failure<BodyProgramGrant>(BodyProgramControllerResultCode.NodeNotEligible);
        if (ClaimsConflict(program!, nodeId))
            return BodyProgramControllerResult.Failure<BodyProgramGrant>(BodyProgramControllerResultCode.ResourceBusy);

        BodyProgramJournalNode granted = node with
        {
            State = BodyProgramNodeState.Granted,
            Attempt = node.Attempt + 1,
            PredecessorAttempts = CapturePredecessorAttempts(program!, nodeId),
        };
        BodyProgramJournalProgram updated = ReplaceNode(program!, granted);
        if (!PersistProgram(updated, identity))
            return BodyProgramControllerResult.Failure<BodyProgramGrant>(BodyProgramControllerResultCode.PersistenceWriteFailed);
        return BodyProgramControllerResult.Success(new BodyProgramGrant(
            programId, nodeId, granted.Attempt, descriptor!.ActionId, identity));
    }

    public BodyProgramControllerResult<BodyProgramGrant> TryConsumeGrant(BodyProgramGrant grant)
    {
        if (!this.authority.IsUsable)
            return BodyProgramControllerResult.Failure<BodyProgramGrant>(BodyProgramControllerResultCode.RecoveryRequired);
        if (grant is null || !TryGetActive(grant.ProgramId, grant.NodeId, out BodyProgramJournalProgram? program, out BodyProgramJournalNode? node, out BodyProgramNodeDescriptor? descriptor))
            return BodyProgramControllerResult.Failure<BodyProgramGrant>(BodyProgramControllerResultCode.GrantMismatch);
        BodyProgramPolicyIdentity identity = this.policyIdentity();
        if (!IsFreshIdentity(identity) || !identity.Equals(grant.PolicyIdentity))
            return BodyProgramControllerResult.Failure<BodyProgramGrant>(BodyProgramControllerResultCode.PolicyIdentityStale);
        if (node!.State != BodyProgramNodeState.Granted || node.Attempt != grant.NodeAttempt || descriptor!.ActionId != grant.ActionId
            || !this.publication().CapabilitySet.AllowsExecutionAction(grant.ActionId))
            return BodyProgramControllerResult.Failure<BodyProgramGrant>(BodyProgramControllerResultCode.GrantMismatch);
        BodyProgramJournalProgram updated = ReplaceNode(program!, node with { State = BodyProgramNodeState.Running });
        return PersistProgram(updated, identity)
            ? BodyProgramControllerResult.Success(grant)
            : BodyProgramControllerResult.Failure<BodyProgramGrant>(BodyProgramControllerResultCode.PersistenceWriteFailed);
    }

    public BodyProgramControllerResult<RuntimeFact> TryComplete(BodyProgramGrant grant, RuntimeFact fact, BodyProgramNodeOutcome outcome)
    {
        if (!this.authority.IsUsable)
            return BodyProgramControllerResult.Failure<RuntimeFact>(BodyProgramControllerResultCode.RecoveryRequired);
        if (grant is null || fact is null)
            return BodyProgramControllerResult.Failure<RuntimeFact>(BodyProgramControllerResultCode.GrantMismatch);
        if (fact.Values is null)
            return BodyProgramControllerResult.Failure<RuntimeFact>(BodyProgramControllerResultCode.InvalidFact);
        if (!TryGetActive(grant.ProgramId, grant.NodeId, out BodyProgramJournalProgram? program, out BodyProgramJournalNode? node, out _))
            return BodyProgramControllerResult.Failure<RuntimeFact>(BodyProgramControllerResultCode.GrantMismatch);
        BodyProgramPolicyIdentity identity = this.policyIdentity();
        if (!IsFreshIdentity(identity) || !identity.Equals(grant.PolicyIdentity))
            return BodyProgramControllerResult.Failure<RuntimeFact>(BodyProgramControllerResultCode.PolicyIdentityStale);
        if (!MatchesFact(fact, grant) || node!.State != BodyProgramNodeState.Running || node.Attempt != grant.NodeAttempt)
            return BodyProgramControllerResult.Failure<RuntimeFact>(BodyProgramControllerResultCode.FactProvenanceMismatch);
        if (fact.Kind != RuntimeFactKind.Terminal || !BodyProgramValidation.IsStringMap(fact.Values))
            return BodyProgramControllerResult.Failure<RuntimeFact>(BodyProgramControllerResultCode.InvalidFact);
        BodyProgramNodeState terminal = outcome switch
        {
            BodyProgramNodeOutcome.Succeeded => BodyProgramNodeState.Succeeded,
            BodyProgramNodeOutcome.Failed => BodyProgramNodeState.Failed,
            BodyProgramNodeOutcome.Cancelled => BodyProgramNodeState.Cancelled,
            _ => throw new ArgumentOutOfRangeException(nameof(outcome)),
        };
        BodyProgramJournalProgram nodeUpdated = ReplaceNode(program!, node with { State = terminal });
        BodyProgramState programState = outcome switch
        {
            BodyProgramNodeOutcome.Failed => BodyProgramState.Failed,
            BodyProgramNodeOutcome.Cancelled => BodyProgramState.Cancelled,
            _ when nodeUpdated.Nodes.All(candidate => candidate.State == BodyProgramNodeState.Succeeded) => BodyProgramState.Succeeded,
            _ => BodyProgramState.Active,
        };
        BodyProgramJournalProgram updated = nodeUpdated with { State = programState };
        return PersistProgram(updated, identity)
            ? BodyProgramControllerResult.Success(fact)
            : BodyProgramControllerResult.Failure<RuntimeFact>(BodyProgramControllerResultCode.PersistenceWriteFailed);
    }

    private bool TryGetActive(string programId, string nodeId, out BodyProgramJournalProgram? program, out BodyProgramJournalNode? node, out BodyProgramNodeDescriptor? descriptor)
    {
        program = this.authority.Snapshot.Programs.SingleOrDefault(candidate => candidate.ProgramId == programId);
        node = null;
        descriptor = null;
        if (program is null || program.State != BodyProgramState.Active) return false;
        node = program.Nodes.SingleOrDefault(candidate => candidate.NodeId == nodeId);
        descriptor = program.Descriptor.Nodes.SingleOrDefault(candidate => candidate.NodeId == nodeId);
        return node is not null && descriptor is not null;
    }

    private bool IsFreshIdentity(BodyProgramPolicyIdentity identity) => identity.IsValid && identity.Equals(this.authority.Snapshot.PolicyIdentity);

    private bool PersistProgram(BodyProgramJournalProgram updated, BodyProgramPolicyIdentity identity)
    {
        BodyProgramJournalState next = this.authority.Snapshot with
        {
            PolicyIdentity = identity,
            Programs = Array.AsReadOnly(this.authority.Snapshot.Programs.Select(program =>
                program.ProgramId == updated.ProgramId ? updated : program).ToArray()),
        };
        return this.authority.TryPersist(next);
    }

    private static bool MatchesFact(RuntimeFact fact, BodyProgramGrant grant) =>
        fact.ProgramId == grant.ProgramId && fact.NodeId == grant.NodeId && fact.NodeAttempt == grant.NodeAttempt
        && Enum.IsDefined(fact.Kind);

    private static BodyProgramJournalProgram ReplaceNode(BodyProgramJournalProgram program, BodyProgramJournalNode replacement) => program with
    {
        Nodes = Array.AsReadOnly(program.Nodes.Select(node => node.NodeId == replacement.NodeId ? replacement : node).ToArray()),
    };

    private static IReadOnlyDictionary<string, int> EmptyAttempts() => new ReadOnlyDictionary<string, int>(new Dictionary<string, int>(StringComparer.Ordinal));

    private static IReadOnlyDictionary<string, int> CapturePredecessorAttempts(BodyProgramJournalProgram program, string nodeId)
    {
        HashSet<string> predecessors = program.Descriptor.Nodes
            .Where(node => node.SuccessorNodeIds.Contains(nodeId, StringComparer.Ordinal))
            .Select(node => node.NodeId)
            .ToHashSet(StringComparer.Ordinal);
        return new ReadOnlyDictionary<string, int>(program.Nodes
            .Where(node => predecessors.Contains(node.NodeId))
            .ToDictionary(node => node.NodeId, node => node.Attempt, StringComparer.Ordinal));
    }

    private static bool PredecessorsSucceeded(BodyProgramJournalProgram program, string nodeId)
    {
        IReadOnlyDictionary<string, int> required = CapturePredecessorAttempts(program, nodeId);
        return required.All(pair => program.Nodes.Single(node => node.NodeId == pair.Key).State == BodyProgramNodeState.Succeeded);
    }

    private static bool ClaimsConflict(BodyProgramJournalProgram program, string nodeId)
    {
        BodyProgramNodeDescriptor candidate = program.Descriptor.Nodes.Single(node => node.NodeId == nodeId);
        HashSet<string> claims = candidate.ResourceClaims.Select(pair => $"{pair.Key}:{pair.Value}").ToHashSet(StringComparer.Ordinal);
        return program.Nodes.Where(node => node.State is BodyProgramNodeState.Granted or BodyProgramNodeState.Running)
            .Join(program.Descriptor.Nodes, node => node.NodeId, descriptor => descriptor.NodeId, (_, descriptor) => descriptor)
            .Any(active => active.ResourceClaims.Any(pair => claims.Contains($"{pair.Key}:{pair.Value}")));
    }
}
