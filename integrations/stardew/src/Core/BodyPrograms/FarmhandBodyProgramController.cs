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

    /// <summary>
    /// The authenticated attachment this transport currently speaks through, or -1 when there is none.
    ///
    /// This is the one fact that tells an `unavailable` answer apart from a refusal. ADR-006 `:33` allows the
    /// Controller to open a NEW admission for a NEW attachment while keeping the same node attempt, and every
    /// cause the Host can answer here (`gate_not_executable`, `not_connected`, `read_state_threw`,
    /// `state_malformed`, `no_registrations`) is a property of THE ATTACHMENT rather than of the node. So the
    /// value changing IS the event that makes re-asking meaningful, and the value standing still is what makes
    /// re-asking pointless. Exposing it here rather than reading it from the journal keeps the fact with its owner:
    /// the transport knows which attachment it is speaking through; the journal does not.
    /// </summary>
    long AttachmentGeneration { get; }
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

    /// <summary>
    /// Where this pump reports why it declined to start a node. Null is allowed: the Core assembly has no logger, and
    /// the Mod wires this to SMAPI's. Without it a silent early-return is indistinguishable from a pump that never ran.
    /// </summary>
    public Action<string>? Diagnostics { get; set; }

    /// <summary>Last time each diagnostic key was reported, so a per-frame condition cannot flood the log.</summary>
    private readonly Dictionary<string, long> diagnosticsLastReportedMs = new(StringComparer.Ordinal);

    /// <summary>
    /// Reports a pump decision, throttled per key. Measured 2026-10-26: the unthrottled version emitted 58 412 lines in
    /// five minutes and a 10 MB log, burying every other marker in the file it was added to make readable.
    /// </summary>
    private void Diagnose(string detail)
    {
        if (this.Diagnostics is null) return;
        long now = Environment.TickCount64;
        if (this.diagnosticsLastReportedMs.TryGetValue(detail, out long last) && now - last < 2_000) return;
        this.diagnosticsLastReportedMs[detail] = now;
        this.Diagnostics($"[GameBuddy-body-program] {detail}");
    }

    /// <summary>
    /// A poll that came back with nothing to do is the controller WORKING, not a problem.
    ///
    /// `StartEligibleNodes` runs every Update pass. While a node is mid-action its dependency is unsatisfied, so
    /// `TryCreateAdmissionChallenge` answers `NodeNotEligible` and the loop exits - correctly, and then the next frame
    /// asks again. A two-second throttle on the message did not help, because a chop or a walk takes longer than two
    /// seconds: measured 2026-10-27, 400+ identical `challenge_not_created;code=NodeNotEligible` lines in one run,
    /// which reads as a fault in every log review and buries the one line that would matter.
    ///
    /// The state is what a reader needs to see CHANGE. Repeating an unchanged answer is the same defect as
    /// re-delivering an unchanged fact to the model, and it gets the same fix: say it once, until it is different.
    /// </summary>
    private void DiagnoseWaiting(string programId, BodyProgramControllerResultCode code)
    {
        if (this.Diagnostics is null) return;
        // PER PROGRAM, keyed by program alone: a program that is still waiting for the same reason says the same
        // thing, no matter how many other programs are doing the same beside it.
        //
        // Measured 2026-10-28 (`round4`): 314 `challenge_not_created` lines, of which `plan_273` accounted for 122
        // and `plan_344` for 121. Two programs waiting in alternation made every frame look like a change to a
        // single "last reason" field - so the de-duplication did nothing for exactly the case that matters, several
        // programs alive at once, which is the normal state of a multi-program run.
        //
        // Whether the reason is unchanged is a per-program fact. The frame is not involved: a program can wait for
        // `NodeNotEligible` for a whole day, and that is one line, not 60 per second.
        if (this.diagnosticsLastWaiting.TryGetValue(programId, out BodyProgramControllerResultCode last) && last == code)
            return;
        this.diagnosticsLastWaiting[programId] = code;
        this.Diagnostics($"[GameBuddy-body-program] challenge_not_created;program={programId};code={code}");
    }

    /** The last waiting code printed for each program, so a repeat says nothing. */
    private readonly Dictionary<string, BodyProgramControllerResultCode> diagnosticsLastWaiting = new(StringComparer.Ordinal);
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

    /// <summary>
    /// Whether a native action may be dispatched on THIS tick, supplied by the host that owns the world.
    ///
    /// Why the program path needs it: a successor is dispatched as soon as its predecessor settles, and a
    /// predecessor often settles on the same frame its native animation starts. Re-entering the actor during that
    /// animation is refused by the router (`player_not_actionable` - a one-frame cooldown: measured 2026-10-19, the
    /// refusal arrived one tick after the previous harvest and the actor was movable again a second later). The
    /// refusal is now an honest node failure rather than a poisoned scope, but a failure stops the successor chain,
    /// so the pass is SKIPPED while the world is mid-animation instead of forcing a refusal a node cannot retry.
    ///
    /// Null means "always dispatchable", which is what a harness without a world wants.
    /// </summary>
    public Func<bool>? CanDispatchNow { get; init; }

    /// <summary>
    /// How many passes one node ATTEMPT may be deferred for the world's sake.
    ///
    /// It is the SAME window the flat admission holds a parked action for: the Mod passes this in derived
    /// from `WorldModel.TransientRetryWindowMs`, the one number it publishes to the Agent as
    /// `retry_window_ms`, so a node waits exactly as long as an animation may hold the body instead of for a
    /// second number that merely looks like the first. The default is this pump's own bound for a caller that
    /// wires a cadence probe without a window.
    ///
    /// Bounded on purpose: an unbounded wait would let a permanently non-actionable world hold a node forever -
    /// which is a strand, not a wait. Past this many passes the node is dispatched anyway, and if the world
    /// really is busy the refusal is recorded as the honest node failure it is (the terminal shape fix is what
    /// makes that survivable).
    /// </summary>
    public int MaxCadenceDeferrals { get; init; } = 90;

    /// <summary>
    /// The wall clock this pump reads, in the same epoch as the node's derived admission deadline.
    ///
    /// It is needed for exactly one decision - whether that deadline has passed - and the deadline is an absolute
    /// unix-ms value the authority derived from the same clock, so this reads unix ms rather than a tick counter.
    /// Injectable so a harness can drive the deadline without sleeping.
    /// </summary>
    public Func<long> NowMs { get; init; } = static () => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    private readonly Dictionary<string, int> cadenceDeferrals = new(StringComparer.Ordinal);

    /// <summary>
    /// The exact challenge each attempt was SENT with, so a re-ask re-sends it verbatim.
    ///
    /// The authority will not mint it a second time: `TryCreateAdmissionChallenge` selects `Pending` nodes only, and this
    /// node has been `AwaitingHostAdmission` since it was first asked. Keeping the minted object is what makes a re-ask an
    /// idempotent re-send of the same tuple rather than a new admission attempt the journal cannot represent.
    /// </summary>
    private readonly Dictionary<string, NodeAdmissionChallenge> admissionChallenges = new(StringComparer.Ordinal);

    /// <summary>
    /// The attachment generation each attempt was last sent on, so `unavailable` can be told apart from a refusal: see
    /// <see cref="SettleUnavailableAdmission"/> for why the attachment is the trigger and the clock is not.
    /// </summary>
    private readonly Dictionary<string, long> admissionAttachmentGenerations = new(StringComparer.Ordinal);

    public BodyProgramJournalOpenStatus OpenStatus => this.authority.OpenStatus;

    /// <summary>Revokes this controller's exact authority tuple and drains any active update.</summary>
    public BodyProgramAuthorityLifecycleState Close()
    {
        this.boundRunning.Clear();
        this.admissionChallenges.Clear();
        this.admissionAttachmentGenerations.Clear();
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
            if (!started.IsSuccess)
            {
                // A not-yet-eligible node is the ordinary state of a program whose current action is running.
                this.DiagnoseWaiting(programId, started.Code);
                return;
            }
            if (!this.authority.IsLifecycleOpen)
            {
                this.Diagnose($"lifecycle_closed_before_send;program={programId}");
                return;
            }
            this.Diagnose($"sending;program={programId};node={started.Value!.NodeId}");
            // Recorded BEFORE the send: the answer is taken on a later tick, and the question it has to be compared
            // against is which attachment this admission was ASKED through, not which one happens to be current.
            string attemptKey = AttemptKey(programId, started.Value!.NodeId, started.Value!.NodeAttempt);
            this.admissionAttachmentGenerations[attemptKey] = this.admission!.AttachmentGeneration;
            this.admissionChallenges[attemptKey] = started.Value!;
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
            // The world gets its say BEFORE the transport result is taken: taking it and then skipping would consume
            // the admission and strand the node awaiting a result that no longer exists. The deferral is bounded, so a
            // world that never becomes ready delays a node instead of holding it for ever.
            if (this.CanDispatchNow is { } canDispatch && !canDispatch())
            {
                string deferralKey = AttemptKey(programId, node.NodeId, node.NodeAttempt);
                int deferred = this.cadenceDeferrals.TryGetValue(deferralKey, out int seen) ? seen : 0;
                if (deferred < this.MaxCadenceDeferrals)
                {
                    this.cadenceDeferrals[deferralKey] = deferred + 1;
                    return;
                }
            }
            BodyNodeAdmissionResult? admissionResult = this.admission!.TryTakeResult(programId, node.NodeId, node.NodeAttempt, node.AdmissionAttempt);
            if (!this.authority.IsLifecycleOpen) return;
            if (admissionResult is null)
            {
                // Nothing to consume. That is normally the ordinary wait - but once the node's own admission deadline has
                // passed, NO answer can legitimately still arrive: the Host refuses a grant past the same deadline
                // (`TryGrant`), so a grant that showed up now would be refused anyway. A node left here with the bridge
                // gone would wait for ever, which is the same strand the `unavailable` branch had.
                if (this.TrySettleExpiredAdmission(programId, node)) return;
                continue;
            }
            if (admissionResult is BodyNodeAdmissionUnavailableResult unavailable)
            {
                if (this.TrySettleExpiredAdmission(programId, node)) return;
                this.ReaskUnavailableAdmission(programId, node, unavailable);
                continue;
            }
            if (admissionResult is BodyNodeAdmissionRejectedResult rejected)
            {
                this.authority.TryRejectAdmission(rejected.Challenge, rejected.Code);
                continue;
            }
            if (admissionResult is not BodyNodeAdmissionGrantedResult granted || this.executor is null) continue;
            BodyProgramControllerResult<HostAdmissionGrant> consumed = this.authority.TryConsumeHostGrant(granted.Grant);
            if (!consumed.IsSuccess || consumed.Value is null)
            {
                this.Diagnose($"grant_not_consumed;program={programId};node={node.NodeId};code={consumed.Code}");
                continue;
            }
            this.RunAdmittedNode(consumed.Value);
        }
    }

    /// <summary>
    /// Concludes a node attempt whose admission the Host answered `unavailable`, or whose admission never gets an answer.
    ///
    /// WHAT WAS BROKEN. `unavailable` was logged and skipped. `TryTakeResult` removes the answer on its way out, the
    /// node is `AwaitingHostAdmission` so `TryCreateAdmissionChallenge` will never select it again, and no seam settles
    /// a non-Running node - so the program stayed `Active` for ever with a node no authority would ever answer again.
    /// The same strand exists with NO answer at all (a bridge that closed mid-handshake), which is why the expiry
    /// check lives in the caller's `null` branch too.
    ///
    /// WHY IT IS NOT A REJECTION. ADR-006 `:33` is explicit: `admission_unavailable` is NOT `not_accepted`, and the
    /// Controller keeps the same node attempt so a NEW attachment can open a new admission. Every cause the Host can
    /// answer here (`gate_not_executable`, `not_connected`, `read_state_threw`, `state_malformed`, `no_registrations`)
    /// is a property of the ATTACHMENT, not of the node, so none of them may become a durable veto against the node.
    /// `IsValidRejectionCode` would have to be widened to even hold them - the ADR amendment this avoids.
    ///
    /// WHAT REPLACES IT, in order:
    ///   1. RE-ASK on a NEW authenticated attachment generation, with the same node attempt and the same challenge
    ///      re-sent verbatim. The trigger is the attachment changing, never the passage of time: a timer would re-send
    ///      into a bridge already known to answer `unavailable`, which is a busy-wait dressed as resilience. The attempt
    ///      is deliberately NOT bumped: the journal validator pins `node.AdmissionAttempt == node.NodeAttempt`
    ///      (`BodyProgramJournalPersistence.cs`), so the ADR's literal "new `admissionAttempt`" is not
    ///      durable-representable today. Re-sending the identical challenge is idempotent at the Host, which answers from
    ///      its own journal (`HostNodeAdmissionService.admit`).
    ///   2. FALLBACK, once the node's own admission deadline has passed: settle locally as `deadline_expired`. The
    ///      ordinary path is the Host's own answer - it is the authority on its deadline - and this exists for when no
    ///      answer can arrive at all. The comparison is the stricter of the two the system already uses, so a local
    ///      verdict can never preempt an answer the authority would still have honoured.
    ///
    /// NOT `Failed`/`Cancelled`: `IsClaimOwnershipValidForState` requires `Released` for both, and an awaiting node holds
    /// `NotAcquired` claims because nothing was ever acquired. Writing `Released` there would be a durable statement
    /// that a resource was handed back after being taken, which is untrue.
    /// </summary>
    private void ReaskUnavailableAdmission(string programId, BodyProgramJournalNode node, BodyNodeAdmissionUnavailableResult unavailable)
    {
        this.Diagnose($"admission_unavailable;program={programId};node={node.NodeId};reason={unavailable.Code ?? "null_from_wire"}");
        string key = AttemptKey(programId, node.NodeId, node.NodeAttempt);
        long current = this.admission!.AttachmentGeneration;
        long askedOn = this.admissionAttachmentGenerations.TryGetValue(key, out long recorded) ? recorded : -1;
        if (current < 0 || current == askedOn || !this.admissionChallenges.TryGetValue(key, out NodeAdmissionChallenge? asked))
        {
            // Nothing about the asking changed, so the answer cannot either. Re-sending would spend the node's remaining
            // budget on an answer already known; wait for the attachment to change or the deadline to pass.
            this.Diagnose($"admission_unavailable_waiting;program={programId};node={node.NodeId};generation={current};askedOn={askedOn}");
            return;
        }
        this.Diagnose($"admission_reasked;program={programId};node={node.NodeId};generation={current};askedOn={askedOn}");
        this.admissionAttachmentGenerations[key] = current;
        this.admission!.Send(asked);
    }

    /// <summary>
    /// The only forward path an awaiting node has once its own admission deadline has passed: settle it as an
    /// allowlisted `deadline_expired` rejection, which is the one durable shape the validator accepts for a node that
    /// never dispatched (`NotAcquired` claims, no proof, `SkippedDependency` for pending descendants).
    ///
    /// The comparison is deliberately the STRICTER one, and it is not a second opinion about the boundary: the Mod's own
    /// `TryGrant` accepts a grant while `DerivedDeadlineMs &lt; nowMs`, so settling at `&lt;=` would preempt a grant that the
    /// authority itself would still have honoured. Past `&lt;` no path accepts anything - `TryGrant` refuses there and the
    /// Host refuses to issue at `&lt;=` - so this is the first instant at which a local verdict cannot contradict a real
    /// answer that is merely slow.
    /// </summary>
    private bool TrySettleExpiredAdmission(string programId, BodyProgramJournalNode node)
    {
        if (node.DerivedDeadlineMs is not { } deadlineMs || deadlineMs >= this.NowMs()) return false;
        string key = AttemptKey(programId, node.NodeId, node.NodeAttempt);
        // The challenge is the settlement's own argument: the authority accepts a rejection only for the exact tuple it
        // minted, so nothing is settled unless the object that was SENT is still here to be presented.
        if (!this.admissionChallenges.TryGetValue(key, out NodeAdmissionChallenge? asked)) return false;
        this.Diagnose($"admission_deadline_settled;program={programId};node={node.NodeId};deadlineMs={deadlineMs}");
        this.admissionChallenges.Remove(key);
        this.admissionAttachmentGenerations.Remove(key);
        this.authority.TryRejectAdmission(asked, "deadline_expired");
        return true;
    }

    private static string AttemptKey(string programId, string nodeId, int nodeAttempt) =>
        $"{programId}\u001f{nodeId}\u001f{nodeAttempt}";

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
        if (!this.authority.TrySettleRecoveryRequired(boundGrant, execution, "terminal_rejected_by_authority").IsSuccess)
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
            // "The authority is no longer writable" is not "this dispatch failed".
            //
            // `RevalidateRunningDispatch` answers `RecoveryRequired` as its FIRST line whenever the authority is not
            // mutable, and this block used to read that answer as a mid-run gate change, settle the node to
            // RecoveryRequired, and record `mid_run_revalidation_failed`. That made the diagnostic a record of its own
            // consequence: once anything closed the authority, every bound node in it "failed" the same way, one per
            // tick, each "confirming" the state it was created by. Measured 2026-10-26 on `plan_1307_59cb6e9dca78c4d6`,
            // whose n02 is a plain `pickup_item`.
            //
            // The honest action when the authority is closed is to do nothing: the node is still bound, its executor is
            // still whoever owns it, and nothing here knows that it failed. Stopping is reversible; settling is not.
            // The same distinction the authority names: "the journal cannot be written" is not "this program is
            // waiting for recovery". Using the narrower question here stopped every RUNNING node in every program
            // whenever one neighbour became unknown - measured 2026-10-27, `plan_254` n01 Running while n02..n07
            // answered `NodeNotEligible` forever, because their dependency never settled.
            if (!this.authority.MayOperateOnPrograms) return;
            if (this.authority.RevalidateRunningDispatch(boundGrant, execution) != BodyProgramControllerResultCode.Succeeded)
            {
                if (!this.authority.IsLifecycleOpen) return;
                // The mid-run gate changed (deadline/policy/stop): settle the
                // exact still-Running node through the authority-owned seam.
                this.boundRunning.Remove(execution.ExecutionId);
                this.authority.TrySettleRecoveryRequired(boundGrant, execution, "mid_run_revalidation_failed");
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
            if (!this.authority.TrySettleRecoveryRequired(boundGrant, execution, "terminal_rejected_by_authority").IsSuccess)
            {
                // Settle unavailable (persistence/lifecycle): retain the tuple
                // so a later tick retries instead of stranding the node.
                this.boundRunning[execution.ExecutionId] = boundGrant;
                this.recentlyDispatched.Remove(execution.ExecutionId);
            }
        }
    }
}