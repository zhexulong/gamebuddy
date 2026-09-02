namespace GameBuddy.Stardew.Core.BodyPrograms;

/// <summary>
/// Dynamic accepted-graph scheduler facade. It intentionally exposes no static
/// descriptor selection or TryStart(programId) path: Mod submission is admission.
/// </summary>
public sealed class FarmhandBodyProgramController
{
    private readonly OpenBodyProgramJournalAuthority authority;

    public FarmhandBodyProgramController(OpenBodyProgramJournalAuthority authority) =>
        this.authority = authority ?? throw new ArgumentNullException(nameof(authority));

    public BodyProgramJournalOpenStatus OpenStatus => this.authority.OpenStatus;
    public BodyProgramControllerResult<BodyProgramStatusSnapshot> TryStop(string programId, long stopEpoch) => this.authority.TryStop(programId, stopEpoch);
    public BodyProgramControllerResult<NodeAdmissionChallenge> TryCreateAdmissionChallenge(string programId) => this.authority.TryCreateAdmissionChallenge(programId);
    public BodyProgramControllerResult<HostAdmissionGrant> TryConsumeHostGrant(HostAdmissionGrant grant) => this.authority.TryConsumeHostGrant(grant);
    public BodyProgramControllerResult<HostAdmissionGrant> TryBeginNativeDispatch(HostAdmissionGrant grant) => this.authority.TryBeginNativeDispatch(grant);
    public BodyProgramControllerResult<RuntimeFact> TryComplete(HostAdmissionGrant grant, RuntimeFact fact, BodyProgramNodeOutcome outcome)
    {
        if (!Enum.IsDefined(typeof(BodyProgramNodeOutcome), outcome))
            return BodyProgramControllerResult.Failure<RuntimeFact>(BodyProgramControllerResultCode.InvalidInput);

        return this.authority.TryComplete(grant, fact, outcome);
    }
}
