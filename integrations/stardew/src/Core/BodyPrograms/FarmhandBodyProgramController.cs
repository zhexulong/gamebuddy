namespace GameBuddy.Stardew.Core.BodyPrograms;

/// <summary>
/// Nonblocking authenticated Mod→Host admission seam for one BridgeSession.
/// The game thread never synchronously waits for Host IPC or a grant response:
/// Send only enqueues the exact durable NodeAdmissionChallenge and
/// TryTakeGrant returns a HostAdmissionGrant only when the Host has already
/// delivered one for that exact admission tuple. A Host that never answers
/// leaves the node awaiting admission; the Controller creates no grant and
/// issues no retry until a later STOP/deadline gate.
/// </summary>
public interface IBodyProgramAdmissionTransport
{
    void Send(NodeAdmissionChallenge challenge);
    HostAdmissionGrant? TryTakeGrant(string programId, string nodeId, int nodeAttempt, int admissionAttempt);
}

/// <summary>
/// Action-owned native execution seam for one exact dispatch tuple. It runs the
/// registered native producer on the game thread and returns the action-owned
/// terminal projection (receipt, non-empty action-specific evidence, fresh
/// postcondition verification, and declared output facts) for that exact tuple.
/// The journal authority rejects any terminal whose execution binding does not
/// equal the dispatched grant binding, so the action-owned truth can never be
/// substituted from another tuple.
/// </summary>
public interface IBodyProgramNodeExecutor
{
    BodyProgramTerminalResult Execute(HostAdmissionGrant grant, NodeExecutionBinding execution);
}

/// <summary>
/// Dynamic accepted-graph scheduler facade. It intentionally exposes no static
/// descriptor selection or TryStart(programId) path: Mod submission is admission.
/// Source nodes and successors are started by one node-start state machine on
/// the game thread; a successor is selected only after the journal has durably
/// projected the predecessor's matching terminal receipt/evidence/postcondition
/// and declared RuntimeFacts from that exact producing attempt.
/// </summary>
public sealed class FarmhandBodyProgramController
{
    private readonly OpenBodyProgramJournalAuthority authority;
    private readonly IBodyProgramAdmissionTransport? admission;
    private readonly IBodyProgramNodeExecutor? executor;

    public FarmhandBodyProgramController(OpenBodyProgramJournalAuthority authority, IBodyProgramAdmissionTransport? admission = null, IBodyProgramNodeExecutor? executor = null)
    {
        this.authority = authority ?? throw new ArgumentNullException(nameof(authority));
        this.admission = admission;
        this.executor = executor;
    }

    public BodyProgramJournalOpenStatus OpenStatus => this.authority.OpenStatus;
    public BodyProgramControllerResult<BodyProgramStatusSnapshot> TryStop(string programId, long stopEpoch) => this.authority.TryStop(programId, stopEpoch);
    public BodyProgramControllerResult<NodeAdmissionChallenge> TryCreateAdmissionChallenge(string programId) => this.authority.TryCreateAdmissionChallenge(programId);
    public BodyProgramControllerResult<HostAdmissionGrant> TryConsumeHostGrant(HostAdmissionGrant grant) => this.authority.TryConsumeHostGrant(grant);
    public BodyProgramControllerResult<NodeExecutionBinding> TryBeginNativeDispatch(HostAdmissionGrant grant, NodeExecutionBinding execution) => this.authority.TryBeginNativeDispatch(grant, execution);
    public BodyProgramControllerResult<BodyProgramTerminalResult> TryComplete(HostAdmissionGrant grant, BodyProgramTerminalResult result) => this.authority.TryComplete(grant, result);

    /// <summary>
    /// Game-thread successor pump. One node-start state machine drives every
    /// node: the controller deterministically selects the dependency-free ready
    /// source or the successor whose predecessor proof/facts are durably
    /// projected, durably records the exact admission challenge, forwards it
    /// over the nonblocking admission seam, consumes only a matching grant the
    /// Host already returned, dispatches the exact tuple, runs the action-owned
    /// native producer, and durably projects its terminal result. It never
    /// waits for Host IPC and never formulates an Agent B request. With no wired
    /// seams the pump is parked: it invents no challenge, grant, receipt,
    /// evidence, postcondition, or fact.
    /// </summary>
    public void Update()
    {
        if (this.admission is null || this.executor is null) return;
        foreach (BodyProgramJournalProgram program in this.authority.Snapshot.Programs)
        {
            if (program.State != BodyProgramState.Active) continue;
            this.StartEligibleNodes(program.Program.ProgramId);
            this.AdvanceAwaitingNodes(program.Program.ProgramId);
        }
    }

    private void StartEligibleNodes(string programId)
    {
        while (true)
        {
            BodyProgramControllerResult<NodeAdmissionChallenge> started = this.authority.TryCreateAdmissionChallenge(programId);
            if (!started.IsSuccess) return;
            this.admission!.Send(started.Value!);
        }
    }

    private void AdvanceAwaitingNodes(string programId)
    {
        // The journal snapshot is immutable and the authority mutates on every
        // transition, so the current program is re-read after each step instead
        // of driving against a stale copy.
        BodyProgramJournalProgram? current = this.authority.Snapshot.Programs.SingleOrDefault(item => item.Program.ProgramId == programId);
        if (current is null || current.State != BodyProgramState.Active) return;
        foreach (BodyProgramJournalNode node in current.Nodes)
        {
            if (node.State != BodyProgramNodeState.AwaitingHostAdmission) continue;
            HostAdmissionGrant? grant = this.admission!.TryTakeGrant(programId, node.NodeId, node.NodeAttempt, node.AdmissionAttempt);
            if (grant is null) continue;
            BodyProgramControllerResult<HostAdmissionGrant> consumed = this.authority.TryConsumeHostGrant(grant);
            if (!consumed.IsSuccess || consumed.Value is null) continue;
            this.RunAdmittedNode(consumed.Value);
        }
    }

    private void RunAdmittedNode(HostAdmissionGrant boundGrant)
    {
        NodeExecutionBinding? execution = boundGrant.ExecutionBinding;
        if (execution is null || !this.authority.TryBeginNativeDispatch(boundGrant, execution).IsSuccess) return;
        BodyProgramTerminalResult terminal = this.executor!.Execute(boundGrant, execution);
        this.authority.TryComplete(boundGrant, terminal);
    }
}