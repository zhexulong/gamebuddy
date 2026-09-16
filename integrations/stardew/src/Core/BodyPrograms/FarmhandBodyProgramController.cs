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
    BodyNodeAdmissionResult? TryTakeResult(string programId, string nodeId, int nodeAttempt, int admissionAttempt);
}

/// <summary>
/// Action-owned native execution seam for one exact dispatch tuple, revisited
/// on later game-thread ticks while a run stays bound-Running. It runs the
/// registered native producer on the game thread and either returns the
/// action-owned terminal projection (receipt, non-empty action-specific
/// evidence, fresh postcondition verification, and declared output facts) for
/// that exact tuple, or a null continuation sentinel meaning the native side
/// has not yet reached a terminal state for that exact tuple and the pump must
/// keep the node bound-Running and revisit it on the next Update. The journal
/// authority rejects any terminal whose execution binding does not equal the
/// dispatched grant binding, so the action-owned truth can never be substituted
/// from another tuple. Synchronous single-pass actions simply return their
/// terminal on the first visit; visiting never re-begins a dispatch or creates
/// a retry.
/// </summary>
public interface IBodyProgramNodeExecutor
{
    BodyProgramTerminalResult? Execute(HostAdmissionGrant grant, NodeExecutionBinding execution);
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
    // Dispatch tuple every subset pass (admission, policy, deadline, exact
    // binding) has acknowledged. A node whose last Execute returned the null
    // Running continuation sentinel stays here until the same tuple produces a
    // terminal, the authority settles it, or the controller closes.
    private readonly Dictionary<string, HostAdmissionGrant> boundRunning = new(StringComparer.Ordinal);
    // Dispatch tuples entered this Update pass. A tuple is only revisited by a
    // later Update pass, so the dispatch tick itself never re-enters it.
    private readonly HashSet<string> recentlyDispatched = new(StringComparer.Ordinal);

    public FarmhandBodyProgramController(OpenBodyProgramJournalAuthority authority, IBodyProgramAdmissionTransport? admission = null, IBodyProgramNodeExecutor? executor = null)
    {
        this.authority = authority ?? throw new ArgumentNullException(nameof(authority));
        this.admission = admission;
        this.executor = executor;
    }

    public BodyProgramJournalOpenStatus OpenStatus => this.authority.OpenStatus;

    /// <summary>Revokes this controller's exact authority tuple and drains any active update.</summary>
    public BodyProgramAuthorityLifecycleState Close()
    {
        this.boundRunning.Clear();
        return this.authority.Close();
    }

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
    /// native producer, and durably projects a terminal result. A node the
    /// producer left Running is re-entered (never re-begun) on later Update
    /// ticks until the tuple-keyed receipt goes terminal, using the same
    /// admission/policy/deadline/exact-binding gate initial dispatch runs; a
    /// mid-run gate change settles the still-Running node to RecoveryRequired.
    /// It never waits for Host IPC and never formulates an Agent B request. With
    /// no wired seams the pump is parked: it invents no challenge, grant,
    /// receipt, evidence, postcondition, or fact. An executor failure or a
    /// terminal the authority refuses after dispatch is durably settled to
    /// RecoveryRequired/Uncertain; it never escapes onto the game thread and
    /// never leaves a Running node silently abandoned.
    /// </summary>
    public void Update()
    {
        if (!this.authority.TryEnterControllerUpdate()) return;
        try
        {
            if (this.admission is null) return;
            this.recentlyDispatched.Clear();
            foreach (BodyProgramJournalProgram program in this.authority.Snapshot.Programs)
            {
                if (program.State != BodyProgramState.Active)
                {
                    // The authority already resolved this program (STOP, recovery,
                    // rejection, completion): none of its nodes can still be
                    // Running, so its retained continuation tuples are dropped
                    // instead of being revisited or left to leak.
                    this.DropRunningTuple(program.Program.ProgramId);
                    continue;
                }
                this.StartEligibleNodes(program.Program.ProgramId);
                if (!this.authority.IsLifecycleOpen) return;
                this.AdvanceAwaitingNodes(program.Program.ProgramId);
                if (!this.authority.IsLifecycleOpen) return;
                this.AdvanceRunningNodes(program.Program.ProgramId);
                if (!this.authority.IsLifecycleOpen) return;
            }
        }
        finally
        {
            this.authority.ExitControllerUpdate();
        }
    }

    private void StartEligibleNodes(string programId)
    {
        while (true)
        {
            BodyProgramControllerResult<NodeAdmissionChallenge> started = this.authority.TryCreateAdmissionChallenge(programId);
            if (!started.IsSuccess || !this.authority.IsLifecycleOpen) return;
            this.admission!.Send(started.Value!);
            if (!this.authority.IsLifecycleOpen) return;
        }
    }

    private void AdvanceAwaitingNodes(string programId)
    {
        // The journal snapshot is immutable and the authority mutates on every
        // transition, so the current program is re-read after each step instead
        // of driving against a stale copy.
        if (!this.authority.IsLifecycleOpen) return;
        BodyProgramJournalProgram? current = this.authority.Snapshot.Programs.SingleOrDefault(item => item.Program.ProgramId == programId);
        if (current is null || current.State != BodyProgramState.Active) return;
        foreach (BodyProgramJournalNode node in current.Nodes)
        {
            if (!this.authority.IsLifecycleOpen) return;
            if (node.State != BodyProgramNodeState.AwaitingHostAdmission) continue;
            BodyNodeAdmissionResult? admissionResult = this.admission!.TryTakeResult(programId, node.NodeId, node.NodeAttempt, node.AdmissionAttempt);
            if (!this.authority.IsLifecycleOpen) return;
            if (admissionResult is null) continue;
            if (admissionResult is BodyNodeAdmissionUnavailableResult) continue;
            if (admissionResult is BodyNodeAdmissionRejectedResult rejected)
            {
                this.authority.TryRejectAdmission(rejected.Challenge, rejected.Code);
                continue;
            }
            if (admissionResult is not BodyNodeAdmissionGrantedResult granted || this.executor is null) continue;
            BodyProgramControllerResult<HostAdmissionGrant> consumed = this.authority.TryConsumeHostGrant(granted.Grant);
            if (!consumed.IsSuccess || consumed.Value is null) continue;
            this.RunAdmittedNode(consumed.Value);
        }
    }

    /// <summary>
    /// When the executor returns the null continuation sentinel, the node stays
    /// bound-Running and its exact dispatch tuple is retained so a later Update
    /// re-enters the running producer on the game thread until its receipt goes
    /// terminal or the mid-run gate settles it. The tuple key is the frozen
    /// binding the grant was dispatched with, so every continuation visit
    /// returns to exactly the running action-owned lineage.
    /// </summary>
    private void RunAdmittedNode(HostAdmissionGrant boundGrant)
    {
        NodeExecutionBinding? execution = boundGrant.ExecutionBinding;
        if (execution is null || !this.authority.IsLifecycleOpen || !this.authority.TryBeginNativeDispatch(boundGrant, execution).IsSuccess) return;
        if (!this.authority.IsLifecycleOpen) return;
        BodyProgramTerminalResult? terminal;
        try
        {
            terminal = this.executor!.Execute(boundGrant, execution);
        }
        catch (Exception)
        {
            // The exact binding is durably Running now, so an executor failure
            // must neither escape onto the game thread nor leave that Running
            // node silently abandoned: convert it into an exact-binding
            // Uncertain terminal with no action-owned facts or proof and hand it
            // back to the authority exactly like any other terminal projection.
            terminal = new BodyProgramTerminalResult(execution, BodyProgramNodeOutcome.Uncertain, Array.Empty<RuntimeFact>(), null, null, null);
        }
        if (!this.authority.IsLifecycleOpen) return;
        if (terminal is null)
        {
            // Fire-and-forget continuation: the native side is still running for
            // this exact tuple, so it is kept bound-Running and revisited on a
            // later game-thread tick. It is never re-begun within the same
            // Update pass and never settled prematurely here.
            this.recentlyDispatched.Add(execution.ExecutionId);
            this.boundRunning[execution.ExecutionId] = boundGrant;
            return;
        }
        this.boundRunning.Remove(execution.ExecutionId);
        if (this.authority.TryComplete(boundGrant, terminal).IsSuccess) return;
        // The strict completion path refused this terminal because a live
        // deadline or policy revalidation changed after dispatch (or another
        // acceptance gate failed). That is not silently ignored: the
        // authority-owned settlement seam durably transitions exactly the
        // still-Running bound node to RecoveryRequired without accepting
        // facts/proofs, creating a new attempt, or retrying.
        if (!this.authority.TrySettleRecoveryRequired(boundGrant, execution).IsSuccess)
        {
            // Persistence or lifecycle is unavailable (e.g. TryPersist failed,
            // leaving OpenStatus = PersistenceWriteFailed). The node is still
            // Running and no settle could be durably written; keep the tuple
            // retained so a later tick (or a reconciled lifecycle) can retry
            // the settle instead of stranding the node forever with no owner.
            this.boundRunning[execution.ExecutionId] = boundGrant;
            this.recentlyDispatched.Remove(execution.ExecutionId);
        }
    }

    /// <summary>
    /// Drops the retained continuation tuples of a program the journal no
    /// longer holds Active, so a resolved node is never revisited and never
    /// leaks in the controller's in-flight map.
    /// </summary>
    private void DropRunningTuple(string programId)
    {
        if (this.boundRunning.Count == 0) return;
        foreach (HostAdmissionGrant boundGrant in this.boundRunning.Values.ToArray())
        {
            if (boundGrant.ProgramId != programId || boundGrant.ExecutionBinding is null) continue;
            this.boundRunning.Remove(boundGrant.ExecutionBinding.ExecutionId);
            this.recentlyDispatched.Remove(boundGrant.ExecutionBinding.ExecutionId);
        }
    }

    /// <summary>
    /// Re-enters a tuple the executor left bound-Running. The gate mirrors the
    /// initial dispatch gate exactly (mutable authority, stop epoch, policy
    /// identity, live deadline, exact grant identity, GrantId binding, and
    /// execution binding); when it changed after dispatch the run is settled to
    /// RecoveryRequired through the exact authority seam rather than executed,
    /// retried, or abandoned. A settled tuple stops being revisited.
    /// </summary>
    private void AdvanceRunningNodes(string programId)
    {
        if (this.boundRunning.Count == 0 || !this.authority.IsLifecycleOpen) return;
        BodyProgramJournalProgram? current = this.authority.Snapshot.Programs.SingleOrDefault(item => item.Program.ProgramId == programId);
        if (current is null || current.State != BodyProgramState.Active) return;
        foreach (HostAdmissionGrant boundGrant in this.boundRunning.Values.ToArray())
        {
            if (boundGrant.ProgramId != programId || !this.authority.IsLifecycleOpen) continue;
            NodeExecutionBinding? execution = boundGrant.ExecutionBinding;
            if (execution is null || this.recentlyDispatched.Contains(execution.ExecutionId) || !this.boundRunning.ContainsKey(execution.ExecutionId)) continue;
            if (!this.authority.IsLifecycleOpen || this.authority.RevalidateRunningDispatch(boundGrant, execution) != BodyProgramControllerResultCode.Succeeded)
            {
                if (!this.authority.IsLifecycleOpen) return;
                // The mid-run gate changed (deadline/policy/stop): settle the
                // exact still-Running node through the authority-owned seam.
                this.boundRunning.Remove(execution.ExecutionId);
                this.authority.TrySettleRecoveryRequired(boundGrant, execution);
                if (!this.authority.IsLifecycleOpen) return;
                continue;
            }
            BodyProgramTerminalResult? terminal;
            try
            {
                terminal = this.executor!.Execute(boundGrant, execution);
            }
            catch (Exception)
            {
                terminal = new BodyProgramTerminalResult(execution, BodyProgramNodeOutcome.Uncertain, Array.Empty<RuntimeFact>(), null, null, null);
            }
            if (!this.authority.IsLifecycleOpen) return;
            if (terminal is null) continue;
            this.boundRunning.Remove(execution.ExecutionId);
            if (this.authority.TryComplete(boundGrant, terminal).IsSuccess) continue;
            if (!this.authority.TrySettleRecoveryRequired(boundGrant, execution).IsSuccess)
            {
                // Settle unavailable (persistence/lifecycle): retain the tuple
                // so a later tick retries instead of stranding the node.
                this.boundRunning[execution.ExecutionId] = boundGrant;
                this.recentlyDispatched.Remove(execution.ExecutionId);
            }
        }
    }
}