using System.Collections.ObjectModel;
using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew.Core.BodyPrograms;

/// <summary>
/// Opens the sole Body Program journal authority for one scope. Reopen never
/// creates executable continuation: non-terminal work becomes diagnostic-only.
/// </summary>
public sealed class OpenBodyProgramJournalAuthority
{
    private readonly IBodyProgramJournalStore store;
    private readonly VerifiedBodyPrograms catalog;
    private readonly BridgeScope scope;
    private BodyProgramJournalState state;

    private OpenBodyProgramJournalAuthority(
        IBodyProgramJournalStore store,
        VerifiedBodyPrograms catalog,
        BridgeScope scope,
        BodyProgramJournalState state,
        BodyProgramJournalOpenStatus status)
    {
        this.store = store;
        this.catalog = catalog;
        this.scope = scope;
        this.state = state;
        this.Status = status;
    }

    public BodyProgramJournalOpenStatus Status { get; private set; }
    public BodyProgramJournalState Snapshot => this.state;

    public static OpenBodyProgramJournalAuthority Open(
        IBodyProgramJournalStore store,
        VerifiedBodyPrograms catalog,
        BridgeScope scope,
        BodyProgramPolicyIdentity policyIdentity)
    {
        ArgumentNullException.ThrowIfNull(store);
        ArgumentNullException.ThrowIfNull(catalog);
        ArgumentNullException.ThrowIfNull(scope);
        ArgumentNullException.ThrowIfNull(policyIdentity);
        if (!scope.IsValid || !policyIdentity.IsValid)
            throw new ArgumentException("Scope and policy identity must be valid.");

        string? encoded;
        try { encoded = store.Read(); }
        catch (Exception)
        {
            return new OpenBodyProgramJournalAuthority(store, catalog, scope, Empty(scope, policyIdentity), BodyProgramJournalOpenStatus.PersistenceReadFailed);
        }
        if (encoded is null)
            return new OpenBodyProgramJournalAuthority(store, catalog, scope, Empty(scope, policyIdentity), BodyProgramJournalOpenStatus.Empty);
        if (!BodyProgramJournalPersistence.TryDecode(encoded, catalog, scope, out BodyProgramJournalState? decoded) || decoded is null)
            return new OpenBodyProgramJournalAuthority(store, catalog, scope, Empty(scope, policyIdentity), BodyProgramJournalOpenStatus.Corrupt);

        BodyProgramJournalState fenced = ApplyRestartFence(decoded, policyIdentity, out bool recoveryRequired);
        var authority = new OpenBodyProgramJournalAuthority(
            store,
            catalog,
            scope,
            fenced,
            recoveryRequired ? BodyProgramJournalOpenStatus.RecoveryRequired : BodyProgramJournalOpenStatus.Opened);
        if (recoveryRequired && !authority.TryPersist(fenced))
            authority.Status = BodyProgramJournalOpenStatus.PersistenceWriteFailed;
        return authority;
    }

    internal bool TryPersist(BodyProgramJournalState next)
    {
        if (!BodyProgramJournalPersistence.TryValidate(next, out _))
            return false;
        try
        {
            if (!this.store.TryWrite(BodyProgramJournalPersistence.Encode(next)))
                return false;
            this.state = BodyProgramJournalPersistence.FreezeState(next);
            return true;
        }
        catch (Exception)
        {
            return false;
        }
    }

    internal bool IsUsable => this.Status is BodyProgramJournalOpenStatus.Empty or BodyProgramJournalOpenStatus.Opened;
    internal VerifiedBodyPrograms Catalog => this.catalog;
    internal BridgeScope Scope => this.scope;

    private static BodyProgramJournalState Empty(BridgeScope scope, BodyProgramPolicyIdentity policyIdentity) => new(
        BodyProgramJournalPersistence.SchemaVersion,
        scope,
        policyIdentity,
        Array.Empty<BodyProgramJournalProgram>());

    private static BodyProgramJournalState ApplyRestartFence(
        BodyProgramJournalState persisted,
        BodyProgramPolicyIdentity currentIdentity,
        out bool changed)
    {
        changed = false;
        bool requiresRecovery = persisted.Programs.Any(RequiresRestartFence);
        BodyProgramJournalProgram[] programs = persisted.Programs.Select(program =>
        {
            if (!RequiresRestartFence(program))
                return program;
            BodyProgramJournalNode[] nodes = program.Nodes.Select(node => node.State is BodyProgramNodeState.Succeeded or BodyProgramNodeState.Failed or BodyProgramNodeState.Cancelled
                ? node
                : node with { State = BodyProgramNodeState.RecoveryRequired }).ToArray();
            return program with { State = BodyProgramState.RecoveryRequired, Nodes = nodes };
        }).ToArray();
        changed = requiresRecovery;
        return changed
            ? new BodyProgramJournalState(persisted.SchemaVersion, persisted.Scope, currentIdentity, Array.AsReadOnly(programs))
            : persisted;
    }

    private static bool RequiresRestartFence(BodyProgramJournalProgram program) =>
        program.State is BodyProgramState.Active or BodyProgramState.RecoveryRequired
        || (program.State is BodyProgramState.Failed or BodyProgramState.Cancelled
            && program.Nodes.Any(node => node.State is BodyProgramNodeState.Pending or BodyProgramNodeState.Granted
                or BodyProgramNodeState.Running or BodyProgramNodeState.RecoveryRequired or BodyProgramNodeState.Quarantined));
}
