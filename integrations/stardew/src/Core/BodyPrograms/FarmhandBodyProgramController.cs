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
    /// <summary>
    /// Hands one node's admission challenge to the transport, and answers <see langword="null" /> when it took it.
    ///
    /// <para>
    /// WHY A REFUSAL IS RETURNED AND NOT SWALLOWED. Measured `round73`: `send_skipped; reason=enqueue_failed;
    /// program=plan_311; node=n15` sat in the SMAPI console while the node stayed `AwaitingHostAdmission` for ever - the
    /// frame had never left this process, no Host answer could ever arrive for it, and nothing in the programme's
    /// settlement counted it. The pump therefore has to learn the refusal HERE, where it still holds the exact challenge,
    /// so the node ends in a NAMED outcome of its own instead of being dropped: `rejected/&lt;the transport's own code&gt;`.
    /// </para>
    /// </summary>
    /// <returns>The refusal code, or <see langword="null" /> when the challenge was accepted for delivery.</returns>
    string? Send(NodeAdmissionChallenge challenge);

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
    private void DiagnoseWaiting(string programId, BodyProgramControllerResult<NodeAdmissionChallenge> started)
    {
        if (this.Diagnostics is null) return;
        // THE CLAUSE, NOT JUST ITS FAMILY. `code=NodeNotEligible` stood for four different answers - a node already in
        // flight, no pending node whose dependencies settled, a binding that could not be materialized - and a reader of
        // the log could not tell which (40+ lines in the measured 2026-11-21 run). The authority names its own clause, so
        // the envelope is built from what IT answered rather than guessed at here.
        string detail = started.Detail ?? BodyProgramRefusal.Envelope(
            started.Code.ToString(), null, null, BodyProgramRefusal.UnknownField, null, null, WaitingRemedy(started.Code));
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
        if (this.diagnosticsLastWaiting.TryGetValue(programId, out string? last) && last == detail)
            return;
        this.diagnosticsLastWaiting[programId] = detail;
        this.Diagnostics($"[GameBuddy-body-program] challenge_not_created;program={programId};{detail}");
    }

    /** What a caller can do about a wait, from the code the authority answered - one sentence per wait it can give. */
    private static string WaitingRemedy(BodyProgramControllerResultCode code) => code switch
    {
        BodyProgramControllerResultCode.ProgramNotActive => "this program is already finished; submit a new one if the work is still needed",
        BodyProgramControllerResultCode.NotFound => "this program is not in the journal; observe and submit a fresh program",
        BodyProgramControllerResultCode.DeadlineExpired => "the node's own watchdog has passed; submit the remaining work as a new program",
        BodyProgramControllerResultCode.PolicyIdentityStale => "the published policy identity moved; observe again before the next submission",
        BodyProgramControllerResultCode.RecoveryRequired => "an unknown dispatch is outstanding on this journal; it waits for recovery",
        BodyProgramControllerResultCode.PersistenceWriteFailed => "the journal could not be written; nothing of this attempt is durable",
        _ => "wait: nothing about the program changed, so the answer cannot either",
    };

    /** The last waiting code printed for each program, so a repeat says nothing. */
    private readonly Dictionary<string, string> diagnosticsLastWaiting = new(StringComparer.Ordinal);
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
    /// Whether the host that owns the world may hand THIS action to it on this tick, and if not, WHAT HOLDS IT.
    ///
    /// <para>
    /// WHY A NAMED HOLD AND NOT A BOOLEAN. The pump used to ask "may this action be dispatched?" and the answer was
    /// applied only AFTER the admission had been minted: a node held by a modal was minted, deferred for the cadence
    /// window and then dispatched into a world that refused it with `player_not_actionable` - the node became the
    /// message. The hold carries its own evidence (`held_by=dialogue_box;answer_it=answer_dialogue`), so the two
    /// decision points that read it can differ where they must: the START gate refuses to admit a node while a MODAL
    /// holds its action (only an action or the player clears one, so waiting is not a policy, it is a stall), and the
    /// dispatch gate still defers an already-admitted node through any hold it meets (a transient body lock clears
    /// itself, and that deferral is bounded).
    /// </para>
    /// <para>
    /// Why the ACTION is the argument and not the tick: "the world is busy" is not one fact. A menu holds the body
    /// against every action that needs it, and is the WORKING PRECONDITION of the handful that exist to close it
    /// (`dismiss_modal`, `answer_dialogue`, `respond_level_up` - <see cref="FarmhandActionCatalog.ModalResolvingActionIds"/>).
    /// A world-only gate deferred those nodes for the whole cadence window, so the pump waited out the modal it was
    /// itself able to dismiss; the flat admission (which reads the same catalog family) never had that defect. The
    /// pump therefore asks the host per ACTION and lets the host's own answer name which holds are per-action.
    /// </para>
    ///
    /// <para>Null (or no probe at all) means "always dispatchable", which is what a harness without a world wants.</para>
    /// </summary>
    public Func<string, BodyProgramHold?>? HoldOf { get; init; }

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

    /// <summary>
    /// Each programme's CARRIED ADMISSION: the Host's grant for that programme's first node, kept for the programme's
    /// own lifetime so the nodes after it are not each asked the same question over the pipe.
    ///
    /// <para>
    /// WHY THE ANSWER COVERS THE PROGRAMME AND NOT THE NODE. Everything the Host decides per node - the action's
    /// membership of the catalogue, the policy identity and capability revision, the catalogue revision - is a fact
    /// about the PROGRAMME's scope, and the Host compiled and preflighted the whole programme under it before the Mod
    /// could submit it. A later node's challenge cannot get a different answer unless that scope moved, and a scope
    /// that moved is a policy-identity change, a STOP, or the attachment going away. So the round trip bought the
    /// second answer to a question already answered: measured `round84`, 331 `admission` challenges for 329 program
    /// nodes and 272 intra-programme node switches costing 43.7 s (161 ms each, about ten frames).
    /// </para>
    /// <para>
    /// WHAT IT IS NOT. It replaces no check: every node is still minted by `TryCreateAdmissionChallenge` (policy
    /// revision, deadline derivation, exact materialized arguments), still admitted through
    /// `TryConsumeHostGrant`/`TryGrant` (live policy identity, live deadline, exact grant identity, live catalog and
    /// claim conformance), still bound by `TryBeginNativeDispatch`, and still executed against the world preconditions
    /// in the executor. What goes is the cross-process wait, not the gate.
    /// </para>
    /// <para>
    /// WHAT KILLS IT: the programme ending - STOP, cancellation, completion or recovery, dropped by `Update` beside
    /// `DropRunningTuple` - the authenticated attachment generation changing, and the live policy identity moving, which
    /// makes the mint answer `PolicyIdentityStale` and drops the lease here. It needs no clock of its own: each node's
    /// deadline is derived at its own mint and `TryGrant` refuses the tuple past it, so a carried admission cannot
    /// outlive the node it covers.
    /// </para>
    /// </summary>
    private readonly Dictionary<string, ProgramAdmissionLease> programAdmissionLeases = new(StringComparer.Ordinal);

    /// <summary>
    /// One programme's carried admission exactly as the Host minted it, so a later node's grant can repeat the
    /// Host's own answer instead of a second guess at it.
    /// </summary>
    /// <param name="TransportGeneration">The authenticated generation the answer arrived on. A different one is a different session, and an admission carried out of it is a claim nobody made.</param>
    /// <param name="AttachmentGeneration">The Host's own name for the attachment it answered on.</param>
    /// <param name="PolicyRevision">The policy revision the Host answered under.</param>
    private sealed record ProgramAdmissionLease(long TransportGeneration, string AttachmentGeneration, string PolicyRevision);

    public BodyProgramJournalOpenStatus OpenStatus => this.authority.OpenStatus;

    /// <summary>Revokes this controller's exact authority tuple and drains any active update.</summary>
    public BodyProgramAuthorityLifecycleState Close()
    {
        this.boundRunning.Clear();
        this.admissionChallenges.Clear();
        this.admissionAttachmentGenerations.Clear();
        this.programAdmissionLeases.Clear();
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
                    // A finished programme carries no admission: its carried answer dies with it, so a resubmission under
                    // the same id cannot inherit one.
                    this.programAdmissionLeases.Remove(program.Program.ProgramId);
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
            // ONE PROGRAMME AT A TIME, ACROSS EVERY OTHER. The body is one actor: a second admitted node - the first node
            // of a plan submitted while another plan is mid-action, or an independent branch of the same graph - collides
            // with the one already running and the collision is spent from BOTH sides. Measured `round73`: `plan_311`
            // still had nodes when `plan_327` was submitted, the two programmes' nodes fought for one farmhand, and a
            // node of the first was dropped by the outbound queue while the second's nodes re-routed underneath it.
            //
            // WHAT WAITING IS HERE: the node stays `Pending` and NOTHING IS MINTED for it. That is the only wait this
            // vocabulary has that costs nothing: a durable admission starts the node's watchdog, so a node admitted into
            // a busy body is a node that will later be settled `deadline_expired` for a wait it never got to start -
            // a wait published as an outcome, one layer up. The gate therefore runs BEFORE the mint, exactly as the
            // modal start gate above it does, and for the same reason.
            //
            // ...AND IT ASKS ON BEHALF OF THIS PROGRAMME, which is the half `round85` cost 24 s: a programme with a node
            // it could start on this pass holds the body against the queued ones, so its own nodes stay together instead
            // of being separated by whatever was submitted after it. See `ProgramHoldingTheBody`.
            if (this.ProgramHoldingTheBody(programId) is { } occupying)
            {
                this.DiagnoseStartHeldBehindProgram(programId, occupying);
                return;
            }
            // THE START GATE RUNS BEFORE THE MINT, and that ordering is the whole fix.
            //
            // A node whose action needs a free body must not be admitted while a modal holds the actor. The admission
            // is durable and the node's watchdog starts with it, so a node minted into that world has only two ways
            // out: deferred until its derived deadline, or dispatched into the refusal the hold ALREADY named - and a
            // successor that starts while a question box is still open is exactly how `player_not_actionable` came to
            // be a node's epitaph. Asking here costs one selection the mint would repeat; the selection itself is
            // shared (`TryNextNode` and `TryCreateAdmissionChallenge` both run `SelectStartCandidate`), so the node
            // the gate answers for and the node admitted next cannot disagree.
            if (this.HoldOf is { } hold && this.TryHoldStart(programId, hold)) return;
            BodyProgramControllerResult<NodeAdmissionChallenge> started = this.authority.TryCreateAdmissionChallenge(programId);
            if (!started.IsSuccess)
            {
                // A policy that moved on ends the programme's carried admission here, where the mint saw it: the
                // answer the Host gave was for the policy this node's attempt would have been minted under, and the
                // next node must ask again. A not-yet-eligible node is the ordinary state of a program whose current
                // action is running, and changes nothing.
                if (started.Code == BodyProgramControllerResultCode.PolicyIdentityStale)
                    this.DropAdmissionLease(programId, "policy_identity_stale");
                this.DiagnoseWaiting(programId, started);
                return;
            }
            if (!this.authority.IsLifecycleOpen)
            {
                this.Diagnose($"lifecycle_closed_before_send;program={programId}");
                return;
            }
            // Recorded BEFORE the send: the answer is taken on a later tick, and the question it has to be compared
            // against is which attachment this admission was ASKED through, not which one happens to be current.
            string attemptKey = AttemptKey(programId, started.Value!.NodeId, started.Value!.NodeAttempt);
            this.admissionAttachmentGenerations[attemptKey] = this.admission!.AttachmentGeneration;
            this.admissionChallenges[attemptKey] = started.Value!;
            // THE PROGRAMME'S CARRIED ADMISSION IS TAKEN, NOT RE-ASKED. The challenge is minted and recorded exactly as
            // it is for a first node - it is what the journal's own gates and the deadline settlement present - and
            // the pass that follows admits this node from it, so nothing goes on the pipe and nothing waits.
            if (this.LiveAdmissionLease(programId) is not null)
            {
                this.Diagnose($"admission_lease_carried;program={programId};node={started.Value!.NodeId}");
                return;
            }
            this.Diagnose($"sending;program={programId};node={started.Value!.NodeId}");
            if (this.admission!.Send(started.Value!) is { } refusal)
            {
                // THE QUEUE'S REFUSAL IS THE NODE'S OUTCOME. The frame never left this process, so no answer can ever
                // arrive for this attempt - and a node left `AwaitingHostAdmission` for that is a node dropped in
                // silence: measured `round73`, `send_skipped; reason=enqueue_failed; program=plan_311; node=n15` in the
                // SMAPI console, with nothing in the programme's settlement to count it.
                this.SettleRefusedSend(programId, started.Value!, refusal);
                if (!this.authority.IsLifecycleOpen) return;
                continue;
            }
            if (!this.authority.IsLifecycleOpen) return;
        }
    }

    /// <summary>
    /// Settles one node whose admission challenge the transport refused to take, as `rejected/&lt;the transport's own
    /// code&gt;` naming what happened, so the programme's settlement counts the node and the plan never claims work it
    /// never queued.
    ///
    /// <para>
    /// The code is the TRANSPORT's, not a word chosen here: only the transport knows whether the outbound queue was full,
    /// whether there was no authenticated attachment to send on, or whether the frame could not be built at all. What the
    /// controller contributes is the exact challenge - the rejection may only be recorded for the tuple it minted - and
    /// the evidence sentence that says the frame never reached the Host.
    /// </para>
    /// </summary>
    private void SettleRefusedSend(string programId, NodeAdmissionChallenge asked, string refusalCode)
    {
        string key = AttemptKey(programId, asked.NodeId, asked.NodeAttempt);
        this.admissionChallenges.Remove(key);
        this.admissionAttachmentGenerations.Remove(key);
        this.Diagnose($"send_refused;program={programId};node={asked.NodeId};code={refusalCode}");
        this.authority.TryRejectAdmission(
            asked,
            refusalCode,
            $"transport={refusalCode};phases=send;delivered=false;node_attempt={asked.NodeAttempt}");
    }

    /// <summary>
    /// This programme's carried admission while it still stands, or null.
    ///
    /// The attachment generation is checked here rather than at the point of use because it is the one part of the
    /// Host's answer that is about the ATTACHMENT: an admission answered through one authenticated generation says
    /// nothing about another, and a lease that outlived its generation would dispatch into a session the Host never
    /// admitted the programme on.
    /// </summary>
    private ProgramAdmissionLease? LiveAdmissionLease(string programId)
    {
        if (!this.programAdmissionLeases.TryGetValue(programId, out ProgramAdmissionLease? lease)) return null;
        long current = this.admission!.AttachmentGeneration;
        if (lease.TransportGeneration == current) return lease;
        this.DropAdmissionLease(programId, $"attachment_changed;askedOn={lease.TransportGeneration};generation={current}");
        return null;
    }

    /// <summary>Ends one programme's carried admission, saying why, so the next node asks the Host again.</summary>
    private void DropAdmissionLease(string programId, string reason)
    {
        if (!this.programAdmissionLeases.Remove(programId)) return;
        this.Diagnose($"admission_lease_dropped;program={programId};reason={reason}");
    }

    /// <summary>
    /// Admits and runs one node under its programme's carried admission. False means there was nothing to carry, or the
    /// journal refused the tuple it covers - and then the caller's ordinary path takes over, with the challenge already
    /// back on the pipe so a real answer can still arrive.
    ///
    /// <para>
    /// THE CHALLENGE IS THE ARGUMENT, not a reconstruction of one: it carries the attempt's own policy identity, its
    /// derived deadline, its materialized canonical arguments and its descriptor-owned claims, and it is the object the
    /// journal minted. Only the three fields the Host owns - the grant id, the attachment generation and the policy
    /// revision - come from the lease, which is what makes this the Host's answer repeated rather than a second decision.
    /// The grant id says so in the durable record: a `lease_` grant is one this pump minted under a carried admission,
    /// a `grant_` one is the Host's own.
    /// </para>
    /// </summary>
    private bool TryRunUnderCarriedAdmission(string programId, BodyProgramJournalNode node)
    {
        if (this.LiveAdmissionLease(programId) is not { } lease) return false;
        if (!this.admissionChallenges.TryGetValue(AttemptKey(programId, node.NodeId, node.NodeAttempt), out NodeAdmissionChallenge? challenge)) return false;
        BodyProgramControllerResult<HostAdmissionGrant> consumed = this.authority.TryConsumeHostGrant(
            new HostAdmissionGrant(challenge.ProgramId, challenge.NodeId, challenge.NodeAttempt, challenge.AdmissionAttempt,
                challenge.StopEpoch, challenge.CatalogRevision, challenge.PolicyIdentity, challenge.ActionId,
                challenge.CanonicalArguments, challenge.DerivedResourceClaims, challenge.DeadlineMs,
                $"lease_{Guid.NewGuid():N}", lease.AttachmentGeneration, lease.PolicyRevision));
        if (consumed.IsSuccess && consumed.Value is not null)
        {
            this.RunAdmittedNode(consumed.Value);
            return true;
        }
        // THE CARRIED ANSWER NO LONGER COVERS THIS NODE: the journal refused the exact tuple, which is what a live policy
        // identity that moved (or an attempt identity that no longer matches what it minted) looks like from here. The
        // programme stops carrying an admission and asks the Host again, so the rest of its nodes are settled by a real
        // answer instead of by an answer that has stopped being true.
        this.DropAdmissionLease(programId, $"node_refused;node={node.NodeId};code={consumed.Code}");
        if (this.admission!.Send(challenge) is { } refusal) this.SettleRefusedSend(programId, challenge, refusal);
        return false;
    }

    /// <summary>
    /// Whose programme holds the one embodied actor: the programme with a node IN FLIGHT, or the programme that is
    /// ADVANCING - its journal holds a node this pump could start on this pass. Null means the body is free.
    ///
    /// <para>
    /// WHY A PROGRAMME THAT IS ADVANCING HOLDS ANYTHING AT ALL. `round85` measured `plan_453`'s own
    /// `n16 refill_watering_can -> n17 water_crop` with a 24 172 ms gap between the two, and inside that gap two LATER
    /// submissions, `plan_471` and `plan_475`, ran (`node_waiting; program=plan_453; held_by=body_program:plan_471`, then
    /// `plan_475`). The gap is one pass wide and it is structural: a node settles in <see cref="AdvanceRunningNodes"/>,
    /// which runs AFTER <see cref="StartEligibleNodes"/> for the same programme, so for the rest of that pass the programme
    /// that just finished a node owns nothing - and the next programme in the journal's order took the body on its own
    /// `StartEligibleNodes`. From then on the programme that was MID-PLAN sat behind a queue of later submissions:
    /// intra-programme node switches went 161 ms to 350 ms, `water_crop` failed 17 times `crop_target_unavailable` against
    /// a plot it had already prepared (`plan_453` and `plan_515` alike), and the run's overlap residual - 68 s of two
    /// programmes' nodes claiming one actor's time - reddened `a_residual_is_either_named_or_bounded`. One node in flight
    /// was never the same rule as one programme at a time, and only the second keeps a plan's nodes together.
    /// </para>
    /// <para>
    /// AN ADMISSION PAST ITS OWN DEADLINE IS NOT IN FLIGHT. A node that outlived <see cref="BodyProgramJournalNode.DerivedDeadlineMs"/>
    /// cannot dispatch at all (<c>TryConsumeHostGrant</c> refuses there), so a body it "holds" is a body nobody can use.
    /// That is the whole cost of the defect this gate was taught about: a settlement the authority refused left one awaiting
    /// node owning the only farmhand, and every later programme was refused <c>held_by=body_program:&lt;it&gt;</c>. Settling
    /// the node is still the only way to END it, and the pump keeps trying every pass; but whether it manages to is a
    /// question about the journal's writability, and it may not be answered with the body.
    /// </para>
    /// <para>
    /// WHAT MAY STILL TAKE THE BODY AWAY. This hold is over the programmes that are QUEUED beside this one; it is never a
    /// lease on a programme's whole life, because the hold ends the moment the programme stops being in flight or
    /// advancing:
    ///   * THE HOST, transitively and on its own terms: a STOP settles the programme <c>Cancelled</c> and a rejection settles
    ///     the node; a programme that is no longer <c>Active</c> holds nothing here. That is what makes the hold
    ///     revocable - there is no token to revoke, only the journal state the Host already owns.
    ///   * THE WORLD, directly: a programme whose next action the world holds is WAITING, not advancing, so it yields. A
    ///     plan parked behind a dialogue box would otherwise starve every other plan for as long as the box stood open -
    ///     the same starvation this gate exists to end, one layer up.
    ///   * A NODE still waiting for its dependency is not advancing either: `TryNextNode` answers `NodeNotEligible`.
    /// </para>
    /// <para>
    /// THE ORDER IS THE TIE-BREAK, and there has to be exactly one. The first <c>Active</c> programme in the journal's own
    /// order that is in flight or advancing is the answer, and <paramref name="askingProgramId"/> proceeds only when it IS
    /// that programme. The journal appends programmes in submission order, so this is FIFO. A symmetric "is any other
    /// programme advancing?" answer would make two advancing programmes wait for each other for ever.
    /// </para>
    /// </summary>
    internal string? ProgramHoldingTheBody(string? askingProgramId = null)
    {
        foreach (BodyProgramJournalProgram program in this.authority.Snapshot.Programs)
        {
            if (program.State != BodyProgramState.Active) continue;
            string programId = program.Program.ProgramId;
            if (!this.HasNodeInFlight(program) && !this.IsAdvancing(programId)) continue;
            return string.Equals(programId, askingProgramId, StringComparison.Ordinal) ? null : programId;
        }
        return null;
    }

    /// <summary>Is one of this programme's nodes using, or about to use, the actor right now?</summary>
    private bool HasNodeInFlight(BodyProgramJournalProgram program) => program.Nodes.Any(node =>
        node.State == BodyProgramNodeState.Running
        || (node.State == BodyProgramNodeState.AwaitingHostAdmission && this.ExpiredAdmissionDeadline(node) is null));

    /// <summary>
    /// Could this programme start a node on this pass? Two authorities answer, and both have to say yes: the journal's own
    /// selection - the SAME <c>SelectStartCandidate</c> the mint runs, so this answer and the node the mint would take
    /// cannot disagree - and the world, which holds an action it is not ready for.
    /// </summary>
    private bool IsAdvancing(string programId)
    {
        BodyProgramControllerResult<BodyProgramNextNode> next = this.authority.TryNextNode(programId);
        if (!next.IsSuccess || next.Value is null) return false;
        // The hold is asked per ACTION, which is the only way the question has an answer: a modal holds the body against
        // everything except the handful of actions that exist to close it, and the world is the one that knows which.
        return this.HoldOf?.Invoke(next.Value.ActionId) is null;
    }

    /// <summary>
    /// This attempt's admission deadline once it has passed, or null while an admission can still be consumed.
    ///
    /// <para>
    /// ONE SPELLING OF ONE BOUNDARY. `TryConsumeHostGrant` refuses a grant while <c>DerivedDeadlineMs &lt; nowMs</c>, so
    /// <c>&lt;</c> is the first instant at which nothing can dispatch - the settlement waits for it (settling at
    /// <c>&lt;=</c> would preempt a grant the authority itself would still honour) and the single-flight gate reads the same
    /// instant (counting a node as in flight at <c>&lt;</c> would let an attempt that cannot dispatch hold the one body).
    /// </para>
    /// </summary>
    private long? ExpiredAdmissionDeadline(BodyProgramJournalNode node) =>
        node.DerivedDeadlineMs is { } deadlineMs && deadlineMs < this.NowMs() ? deadlineMs : null;

    private void DiagnoseStartHeldBehindProgram(string programId, string occupying)
    {
        if (this.Diagnostics is null) return;
        string detail = $"state=pending;program={programId};held_by=body_program:{occupying};next_step=wait_for_that_program_to_finish_or_yield";
        if (this.diagnosticsLastStartHold.TryGetValue(programId, out string? last) && last == detail) return;
        this.diagnosticsLastStartHold[programId] = detail;
        this.Diagnostics($"[GameBuddy-body-program] node_waiting;{detail}");
    }

    /// <summary>
    /// Asks the world about the action of the node this program would start next, and reports a MODAL hold instead of
    /// admitting it. True means the program's pass is over: nothing was minted, sent or dispatched.
    ///
    /// <para>
    /// Only a modal hold stops a start. A cutscene or a transient body lock keeps the behaviour it had - the node is
    /// admitted and the bounded deferral in <see cref="AdvanceAwaitingNodes"/> waits the lock out - because those clear
    /// on their own, while a modal is cleared by an ACTION or by the player and never by this pump.
    /// </para>
    /// </summary>
    private bool TryHoldStart(string programId, Func<string, BodyProgramHold?> hold)
    {
        BodyProgramControllerResult<BodyProgramNextNode> next = this.authority.TryNextNode(programId);
        if (!next.IsSuccess || next.Value is null) return false;
        if (hold(next.Value.ActionId) is not { IsModal: true } held) return false;
        this.DiagnoseStartHeld(programId, next.Value.NodeId, next.Value.ActionId, held.Evidence);
        return true;
    }

    /// <summary>
    /// Reports a start hold once per program, until it changes - the same treatment <see cref="DiagnoseWaiting"/> gives
    /// a waiting code, and for the same reason: a hold that stands for a whole day is one line, not sixty a second.
    /// </summary>
    private void DiagnoseStartHeld(string programId, string nodeId, string actionId, string evidence)
    {
        if (this.Diagnostics is null) return;
        string detail = $"node_held;program={programId};node={nodeId};action={actionId};{evidence}";
        if (this.diagnosticsLastStartHold.TryGetValue(programId, out string? last) && last == detail) return;
        this.diagnosticsLastStartHold[programId] = detail;
        this.Diagnostics($"[GameBuddy-body-program] {detail}");
    }

    /** The last start hold printed for each program, so a repeat says nothing. */
    private readonly Dictionary<string, string> diagnosticsLastStartHold = new(StringComparer.Ordinal);

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
            if (this.HoldOf is { } hold && hold(ActionIdOf(current, node.NodeId)) is { } met)
            {
                // A HOLD THAT CLEARS ON ITS OWN IS WAITED OUT, not spent. See `WaitOutTheHold`.
                if (met.Wait == BodyHoldWait.RequestDeadline && this.WaitOutTheHold(programId, node, met)) return;
                string deferralKey = AttemptKey(programId, node.NodeId, node.NodeAttempt);
                int deferred = this.cadenceDeferrals.TryGetValue(deferralKey, out int seen) ? seen : 0;
                if (deferred < this.MaxCadenceDeferrals)
                {
                    this.cadenceDeferrals[deferralKey] = deferred + 1;
                    return;
                }
            }
            // The programme's own answer, taken once for its first node, admits this one without a round trip. False
            // here means the lease is gone or was refused, and the ordinary transport path below asks the Host.
            if (this.TryRunUnderCarriedAdmission(programId, node)) continue;
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
                this.TryReject(programId, node, rejected.Challenge, rejected.Code, null);
                continue;
            }
            if (admissionResult is not BodyNodeAdmissionGrantedResult granted || this.executor is null) continue;
            BodyProgramControllerResult<HostAdmissionGrant> consumed = this.authority.TryConsumeHostGrant(granted.Grant);
            if (consumed.IsSuccess)
            {
                // The Host answered for this programme, so the answer covers the programme's remaining nodes. It is
                // recorded only for a grant the journal ACCEPTED: a refused one admitted nothing and carries nothing.
                this.programAdmissionLeases[programId] = new ProgramAdmissionLease(
                    this.admission.AttachmentGeneration, granted.Grant.AttachmentGeneration, granted.Grant.PolicyRevision);
            }
            if (!consumed.IsSuccess || consumed.Value is null)
            {
                // AN ANSWER THAT WAS TAKEN IS AN ANSWER THAT WILL NOT COME AGAIN: `TryTakeResult` removed it on its way
                // out, so `continue` here is a node waiting for the next answer to something nobody will ask again.
                //
                // Past the node's own deadline the expiry settlement is the only forward path there is, and it is not
                // optional: a node left `AwaitingHostAdmission` after its deadline holds the single-flight lock on the
                // one embodied actor for the rest of the session. Measured 2026-11-18: `n01` of `plan_346` collided with
                // Lewis's cutscene, its 60 s deadline passed at 23:05:21, the Host's late grant arrived at 23:05:23 and
                // was refused `DeadlineExpired` - and the node then held the body for three in-game hours, refusing
                // `plan_347` twice (`held_by=body_program:plan_346_…`) until the companion passed out at 02:00.
                if (this.TrySettleExpiredAdmission(programId, node)) return;
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
        if (this.admission!.Send(asked) is { } refusedAgain)
            this.SettleRefusedSend(programId, asked, refusedAgain);
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
    private bool TrySettleExpiredAdmission(string programId, BodyProgramJournalNode node, string? refusalDetail = null)
    {
        if (this.ExpiredAdmissionDeadline(node) is not { } deadlineMs) return false;
        string key = AttemptKey(programId, node.NodeId, node.NodeAttempt);
        // The challenge is the settlement's own argument: the authority accepts a rejection only for the exact tuple it
        // minted, so nothing is settled unless the object that was SENT is still here to be presented.
        if (!this.admissionChallenges.TryGetValue(key, out NodeAdmissionChallenge? asked)) return false;
        // IT IS KEPT UNTIL THE REJECTION PROVES ITSELF, and that ordering is the difference between a retry and a strand.
        // Measured 2026-11-18: this dropped the challenge first, the refusal below was discarded, and the next pass had
        // neither an answer to take nor a challenge to present - so `n01` could not be settled by anything, for three
        // in-game hours, while its program held the only body.
        if (!this.TryReject(programId, node, asked, "deadline_expired", refusalDetail)) return false;
        this.Diagnose($"admission_deadline_settled;program={programId};node={node.NodeId};deadlineMs={deadlineMs};detail={refusalDetail ?? "none"}");
        this.admissionChallenges.Remove(key);
        this.admissionAttachmentGenerations.Remove(key);
        return true;
    }

    /// <summary>
    /// Records one node rejection and REPORTS the authority's answer, so a rejection the journal refused is a line in the
    /// log instead of a node that quietly stops moving. True means the node is now <c>Rejected</c>.
    ///
    /// <para>
    /// The refusal is the same defect family as every other unnamed answer in this pump: `TryRejectAdmission` can answer
    /// `InvalidInput` (a code outside the allowlist, or a tuple the journal no longer accepts as the one this pump minted)
    /// and `PersistenceWriteFailed`, and both leave the node exactly where it was. Discarding that answer
    /// is what made the measured strand invisible - the log said the deadline was settled, and nothing said it was not.
    /// The journal's own last persistence refusal travels with the line, because for the write failure it is the only
    /// sentence that names the rule which refused.
    /// </para>
    /// <para>
    /// TWO NAMES, BECAUSE THE TWO ANSWERS ASK FOR DIFFERENT THINGS. `admission_rejection_refused_by_policy` is the
    /// authority answering about THE TUPLE - the attempt's own identity no longer matches what the journal holds, the class
    /// 2026-11-18 measured when a policy push landed between an admission and its deadline. Nothing about the node changed,
    /// so the pump keeps the challenge and presents it again; what it must not do is let that attempt hold the body, and
    /// the single-flight gate reads the deadline rather than this answer (see <see cref="ProgramHoldingTheBody"/>).
    /// `admission_rejection_refused` is the journal refusing to RECORD anything, which no answer from this pump can repair.
    /// </para>
    /// </summary>
    /// <summary>
    /// What a caller can do about a rejection the HOST answered - one sentence per code the Mod can durably record.
    ///
    /// Only the codes whose remedy this side really knows are named; anything else falls back to the one true sentence
    /// about a durable veto, so a code added on the Host tomorrow reads as "a veto you cannot retry unchanged" rather than
    /// as an empty remedy.
    /// </summary>
    private static string RejectionRemedy(string code) => code switch
    {
        "policy_denied" => "the Host's live catalogue did not offer this node's action: observe the world and resubmit against what it offers",
        "catalog_stale" => "the catalogue moved after this program was submitted: resubmit against a fresh observation",
        "policy_identity_mismatch" => "the runtime and the Mod disagree about the policy identity: resubmit once the runtime is re-attached",
        "deadline_expired" => "the node's admission deadline passed: submit the remaining work as a new program",
        "resource_conflict" => "another node holds the claim this one needs: order the nodes so the claim is free",
        "stop_epoch_closed" => "a STOP closed this program: start a new one",
        _ => "this node is a durable veto and cannot be retried unchanged: change the node or the world, then resubmit",
    };

    private bool TryReject(string programId, BodyProgramJournalNode node, NodeAdmissionChallenge challenge, string code, string? refusalDetail)
    {
        // THE SENTENCE BESIDE THE CODE, ALWAYS. `refusalDetail` was `null` on the Host's answer, so the model's status row
        // said `rejectionCode=policy_denied` and nothing else - the same defect one level down from the Host's bare
        // `body_program_preflight_rejected`. The delta here is the Mod's own: it holds the code, the node and the action,
        // and it does NOT hold the field the Host judged, which it says as `field=unknown` rather than inventing one.
        string detail = refusalDetail ?? BodyProgramRefusal.Envelope(
            code, node.NodeId, challenge.ActionId, BodyProgramRefusal.UnknownField, null, null, RejectionRemedy(code));
        BodyProgramControllerResult<NodeAdmissionChallenge> rejected = this.authority.TryRejectAdmission(challenge, code, detail);
        if (rejected.IsSuccess)
        {
            // AN ACCEPTED REJECTION IS A NODE'S WHOLE STORY, and it used to be the one line this pump never wrote: only a
            // REFUSED rejection was reported, so a program the Host rejected inside a millisecond left `sent` and then
            // silence in the log. Measured `round99`: `plan_0`'s two nodes were answered `rejected` in 372 µs, both were
            // durably settled, and the absence of this line made 44 s of the MODEL's own thinking read as a request that
            // was never answered at all. The line is one per node, because a node rejects once - the journal refuses a
            // second rejection of the same node.
            this.Diagnose($"admission_rejected;program={programId};{detail}");
            return true;
        }
        string name = rejected.Code == BodyProgramControllerResultCode.InvalidInput
            ? "admission_rejection_refused_by_policy"
            : "admission_rejection_refused";
        this.DiagnoseRefusal(programId, $"{name};program={programId};node={node.NodeId};code={code};answer={rejected.Code};journal_refusal={this.authority.LastPersistenceRefusal ?? "none"}");
        return false;
    }

    /// <summary>
    /// Reports a refused rejection once per program until it changes. The condition it describes stands for as long as the
    /// journal keeps refusing - the whole session, in the measured case - so repeating it is the same defect the other
    /// `Diagnose*` helpers exist to avoid: a fact that never changes is stated once.
    /// </summary>
    private void DiagnoseRefusal(string programId, string detail)
    {
        if (this.Diagnostics is null) return;
        if (this.diagnosticsLastRefusal.TryGetValue(programId, out string? last) && last == detail) return;
        this.diagnosticsLastRefusal[programId] = detail;
        this.Diagnostics($"[GameBuddy-body-program] {detail}");
    }

    /** The last refusal printed for each program, so a repeat says nothing. */
    private readonly Dictionary<string, string> diagnosticsLastRefusal = new(StringComparer.Ordinal);

    /// <summary>
    /// Waits out a hold declared <see cref="BodyHoldWait.RequestDeadline"/> for as long as this node's own watchdog
    /// still allows the dispatch. True means the node was left waiting (or settled because the watchdog ran out).
    ///
    /// <para>
    /// WHY THE CADENCE WINDOW IS THE WRONG BOUND FOR THESE. `MaxCadenceDeferrals` is the flat admission's own parking
    /// window (two seconds, the same number that evidence publishes as `retry_window_ms`), and it is right for a hold
    /// that ends inside it - a tool cooldown, an eating pause. A cutscene is not that, and the same two seconds made
    /// it a terminal. Measured `round56` (day 6, 06:00, the furnace cutscene): one clear-and-plant program's three
    /// nodes were deferred for the cadence window, dispatched into the running event, and settled
    /// `Rejected:cutscene_active` - four row receipts and one node receipt, `0/3` nodes - while the world was free
    /// again four seconds later. Nothing was spent but the plan: the three nodes were the plan.
    /// </para>
    /// <para>
    /// THE BOUND IS THE NODE'S OWN WATCHDOG (<see cref="BodyProgramJournalNode.DerivedDeadlineMs"/>), which is not a
    /// new number: it is the instant this node's admission can no longer be consumed at all (`TryConsumeHostGrant`
    /// refuses a grant past it), so a wait longer than it would be a wait for a dispatch that cannot happen. While it
    /// stands the node is neither dispatched nor settled and nothing is spent; when it passes with the hold still up,
    /// the node settles `deadline_expired` CARRYING THE HOLD in <see cref="BodyProgramJournalNode.RefusalDetail"/>,
    /// because "the deadline passed" and "what held her for the whole window" are two facts and a receipt that states
    /// only the first is the one the companion cannot act on.
    /// </para>
    /// </summary>
    private bool WaitOutTheHold(string programId, BodyProgramJournalNode node, BodyProgramHold met)
    {
        if (node.DerivedDeadlineMs is not { } deadlineMs) return false;
        if (this.ExpiredAdmissionDeadline(node) is null)
        {
            this.DiagnoseHeld(programId, node, met, deadlineMs);
            return true;
        }
        this.TrySettleExpiredAdmission(programId, node, met.Evidence);
        // THE WAIT IS OVER EITHER WAY. Past the watchdog there is nothing left to wait FOR, so falling through on a
        // refused settlement would hand the node to the cadence window and then to a world that is still holding it.
        return true;
    }

    /// <summary>
    /// Reports a node waiting out a hold once per program per hold, for the same reason <see cref="DiagnoseStartHeld"/> does:
    /// a hold that stands for a whole cutscene is one line, not one per tick.
    /// </summary>
    private void DiagnoseHeld(string programId, BodyProgramJournalNode node, BodyProgramHold met, long deadlineMs)
    {
        if (this.Diagnostics is null) return;
        string detail = $"node_waiting_out_hold;program={programId};node={node.NodeId};deadlineMs={deadlineMs};{met.Evidence}";
        if (this.diagnosticsLastHold.TryGetValue(programId, out string? last) && last == detail) return;
        this.diagnosticsLastHold[programId] = detail;
        this.Diagnostics($"[GameBuddy-body-program] {detail}");
    }

    /** The last hold printed per program, so a repeat says nothing. */
    private readonly Dictionary<string, string> diagnosticsLastHold = new(StringComparer.Ordinal);

    private static string AttemptKey(string programId, string nodeId, int nodeAttempt) =>
        $"{programId}\u001f{nodeId}\u001f{nodeAttempt}";

    /// <summary>
    /// The catalog action a journal node runs.
    ///
    /// The journal node does NOT carry it: its identity is the node id, and the durable node record is deliberately
    /// action-free so a resumed program cannot disagree with the catalog it was verified against. The descriptor set
    /// the program was verified into does carry it, and every journal node is created from that descriptor set
    /// (`OpenBodyProgramJournalAuthority`), so this lookup is total for a live program.
    /// </summary>
    private static string ActionIdOf(BodyProgramJournalProgram program, string nodeId) =>
        program.Program.Nodes.Single(descriptor => descriptor.NodeId == nodeId).ActionId;

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