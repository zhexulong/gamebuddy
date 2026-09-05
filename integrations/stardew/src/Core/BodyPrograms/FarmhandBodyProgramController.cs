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
    public BodyProgramControllerResult<NodeExecutionBinding> TryBeginNativeDispatch(HostAdmissionGrant grant, NodeExecutionBinding execution) => this.authority.TryBeginNativeDispatch(grant, execution);
    public BodyProgramControllerResult<BodyProgramTerminalResult> TryComplete(HostAdmissionGrant grant, BodyProgramTerminalResult result) => this.authority.TryComplete(grant, result);
}
