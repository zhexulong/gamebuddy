namespace GameBuddy.Stardew.Core.Abstractions;

/// <summary>
/// The two questions the receipt ledger asks of the body that owns the actor: whether an execution still holds it, and
/// the release of the modal-owner lease an execution took when it opened a modal of its own. Both stay with the owner,
/// so the ledger never reads a body slot or a lease it does not own.
/// </summary>
public interface IActiveBodyOwnership
{
    /** Whether any manager-owned representation of this execution still holds the actor. */
    bool HasOwnership(string executionId);

    /** Releases the modal-owner lease; only the owning execution may clear it. */
    void ReleaseModalLease(string executionId);
}
