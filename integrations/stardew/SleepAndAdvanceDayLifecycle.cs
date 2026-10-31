using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Locations;
using StardewValley.Menus;
using StardewValley.Pathfinding;

namespace GameBuddy.Stardew;

/// <summary>
/// The cross-day lifecycle (<c>single_player_sleep_and_advance_day</c> and the
/// multiplayer ready-barrier variants, catalog coordinationContract
/// <c>host_save</c> / <c>native_ready_barrier</c>).
///
/// This is deliberately NOT a wire action: the Agent does not submit an execution
/// request and does not receive an action receipt. It is a bounded, typed
/// lifecycle that starts from a legal live sleep-eligible state, lets the native
/// sleep path run the way the native input paths do, and then observes the
/// native <c>Saving → Saved → DayStarted</c> pipeline. Every claim is read from
/// native facts; nothing is mirrored and no day is advanced by hand.
///
/// The two topologies drive genuinely different native machines
/// (<c>GameLocation.startSleep</c>, <c>GameLocation.doSleep</c>):
///
///  - Single player: <c>answerDialogue(Response)</c> → <c>startSleep</c> →
///    <c>doSleep</c> → <c>Game1.NewDay</c>. The lifecycle answers the
///    game-owned DialogueBox because the native keyboard/mouse paths do.
///  - Multiplayer: <c>startSleep</c> calls <c>netReady.SetLocalReady("sleep")</c>
///    and installs the game-owned <see cref="ReadyCheckDialog"/>, whose own
///    <c>update()</c> keeps the local ready state set and calls <c>doSleep</c>
///    once every required farmer is ready. The modal is a ready barrier, not a
///    yes/no question, so the lifecycle MUST NOT answer it. It declares ready by
///    letting the native path run, waits, and reports honestly — it never marks
///    another player ready and never forges the barrier, so a barrier that never
///    completes terminates as <c>requires_other_player</c>.
/// </summary>
internal sealed class SleepAndAdvanceDayLifecycle
{
    private const string Schema = "gamebuddy-sleep-lifecycle/v1";
    private static readonly JsonSerializerOptions EvidenceJsonOptions = new() { WriteIndented = true };
    private const string SleepReadyCheckId = "sleep";

    /// <summary>
    /// Frames to keep watching for the native save boundary before continuing.
    /// The day fact is the authority; a client observes the rollover over the
    /// network without saving locally at all, so this must never block.
    /// </summary>
    private const int SaveBoundaryFrameBudget = 300;

    /// <summary>
    /// Bounds how long the lifecycle may wait to become eligible. The operational
    /// deadline only starts at eligibility, so a lifecycle that never becomes
    /// eligible (actor passed out, menu open, wrong time) would otherwise spin
    /// forever and be misreported as a generic timeout.
    /// </summary>
    private const int EligibilityFrameBudget = 36000;

    /// <summary>
    /// Frames to keep waiting for the new day to truly begin (SMAPI DayStarted)
    /// once the date counter has advanced. The counter alone is NOT the day
    /// start: on the master it advances while the save is still in flight, and on
    /// a client it syncs over the network; both happen before the new day is
    /// actually playable. Claiming <c>day_advanced</c> before DayStarted would
    /// let the Agent act mid-save.
    ///
    /// The budget is the ACTION's own (its descriptor allows 540 s), not a tighter
    /// one of its own: measured live, a native night had not reached DayStarted 60 s
    /// after the counter advanced - the run reported <c>day_start_not_observed</c> and
    /// then the new day's own snapshot arrived (dayOfMonth +1, clock +120, actionable)
    /// - so the previous 3600-frame budget was reporting the engine as late clock rather
    /// than the night as unfinished. The lifecycle's overall <c>timeoutSeconds</c>
    /// deadline still bounds this, so a night that genuinely never starts cannot spin.
    /// </summary>
    private const int DayStartFrameBudget = 540 * 60;

    private readonly int minimumOnlineFarmers;

    private readonly IMonitor monitor;
    private readonly string evidencePath;
    private readonly int settleFrameBudget;
    private readonly int readyBarrierFrameBudget;
    private readonly Func<DateTimeOffset> clock;
    private readonly Func<ShippingMenu, bool> commitShippingSummary;
    private readonly int timeoutSeconds;
    private DateTimeOffset deadline;
    private readonly List<string> trace = new();

    private Phase phase = Phase.AwaitingEligibility;
    private string lastEligibilityReason = string.Empty;
    private int eligibilityWaitFrames;
    private PathFindController? installedController;
    private bool yieldedToPassOut;
    private string enteredVia = "native_sleep_prompt";
    private bool arrivalDispatched;
    private bool answerDispatched;
    private bool savedTraceLogged;
    private int settleFrames;
    private int readyBarrierFrames;
    private int saveBoundaryFrames;
    /// <summary>True once the save-boundary budget expired without observing a save, so the receipt can say so.</summary>
    private bool saveBoundaryNotObserved;
    private int ticks;
    private int dayBefore;
    private int daysBefore;
    private bool dayBaselineCaptured;
    private bool multiPlayer;
    private bool savingObserved;
    private int dayStartWaitFrames;

    // Event edges are COUNTERS, not sticky flags. The load-time Saved/DayStarted
    // fire long before the night is slept, so a boolean would already be true when
    // the night begins and the gate below would be vacuous. Measured live: the
    // host's sticky dayStartedObserved was set at 23:02:34 by the initial load,
    // and the lifecycle then minted day_advanced at 23:02:49 while the real save
    // only began at 23:02:49 and the new day started at 23:02:51.
    private int savedCount;
    private int dayStartedCount;
    private int savedBaseline;
    private int dayStartedBaseline;
    private bool eventEdgeBaselineCaptured;
    private bool readyCheckObserved;
    private int readyAtCompletion;
    private int requiredAtCompletion;
    private bool finished;

    /// <summary>
    /// The settlement menu this lifecycle has already dispatched the engine commit for.
    ///
    /// `okClicked` is not idempotent in effect: it restarts the outro fade (ShippingMenu.cs:690-696), so dispatching
    /// it again while that outro runs freezes it. The commit is therefore dispatched once per menu INSTANCE, however
    /// many frames or terminals ask for it.
    /// </summary>
    private ShippingMenu? committedShippingSummary;

    /// <summary>What this lifecycle's terminal left a standing settlement menu as.</summary>
    private SettlementMenuOutcome settlementMenuOutcome;

    /// <summary>
    /// Terminal outcome handed back to the owning execution. The lifecycle is the
    /// mechanism owner; the wire receipt is still minted by the one execution
    /// ledger, so both the evidence file and the bridge receipt describe the same
    /// run rather than two authorities.
    /// </summary>
    internal string TerminalState { get; private set; } = string.Empty;

    internal string TerminalReasonCode { get; private set; } = string.Empty;

    internal string TerminalEvidence { get; private set; } = string.Empty;

    /// <summary>
    /// Whether the night is accepted but cannot start yet - the actor is not where the sleep can begin.
    ///
    /// Exposed because body ownership depends on it: a dispatched night that is still waiting does not own the actor,
    /// and the companion has to be able to walk home for it to ever begin (measured 2026-10-20: an outdoor
    /// `advance_day` held the body as committed, refused the `enter_exit` that would have brought the actor inside, and
    /// ran until the engine's 2:00 AM pass-out).
    /// </summary>
    internal bool IsAwaitingEligibility => this.phase == Phase.AwaitingEligibility;

    /// <summary>
    /// True once this lifecycle has handed its terminal back and stopped owning anything.
    ///
    /// `Update` reports completion and the Mod then drops the handle, so a caller that must act only when NOTHING owns
    /// the rollover menus needs to see both that state and the dropped handle. Exposed as a property rather than
    /// inferred from the phase because a finished lifecycle keeps reporting its last phase.
    /// </summary>
    internal bool IsFinished => this.finished;

    /// <summary>
    /// The terminal's disposition of a morning-after settlement menu, named so a receipt can state it.
    /// </summary>
    internal enum SettlementMenuOutcome
    {
        /// <summary>No settlement menu was standing when the lifecycle settled.</summary>
        NotPresent,

        /// <summary>One was standing and this lifecycle had already dispatched its commit, so the outro owns it.</summary>
        AlreadyCommitted,

        /// <summary>One was standing and the engine commit was dispatched now.</summary>
        Committed,

        /// <summary>One was standing and the engine commit seam could not be reached.</summary>
        CommitUnavailable,

        /// <summary>One was standing, the seam ran, and it threw. The menu is still standing and the receipt says so.</summary>
        CommitFailed,
    }

    private enum Phase
    {
        AwaitingEligibility,
        WalkingToBed,
        AwaitingModal,
        AwaitingSettlement,
        AwaitingPassOutPipeline,
        AwaitingReadyBarrier,
        AwaitingSave,
        AwaitingDayStart,
    }

    private SleepAndAdvanceDayLifecycle(
        IMonitor monitor,
        SleepAndAdvanceDayLifecycleConfig config,
        Func<DateTimeOffset> clock,
        Func<ShippingMenu, bool>? commitShippingSummary)
    {
        this.monitor = monitor;
        this.commitShippingSummary = commitShippingSummary ?? EngineShippingCommit;
        this.evidencePath = config.EvidencePath;
        this.settleFrameBudget = Math.Clamp(config.SettleFrameBudget, 1, 600);
        // The ready barrier is a different budget from the modal settle: other
        // players may legitimately take much longer than an animation.
        this.readyBarrierFrameBudget = Math.Clamp(config.ReadyBarrierFrameBudget, 1, 36000);
        this.minimumOnlineFarmers = Math.Clamp(config.MinimumOnlineFarmers, 1, 8);
        this.clock = clock;
        this.timeoutSeconds = Math.Clamp(config.TimeoutSeconds, 10, 3600);
        // The budget starts when the lifecycle actually begins, not when the Mod
        // entry constructed it: loading a save and attaching a Farmhand can take
        // tens of seconds, and charging that against the lifecycle would make a
        // healthy run look like a timeout.
        this.deadline = DateTimeOffset.MaxValue;
    }

    /// <summary>Fail-closed construction: an invalid config starts nothing.</summary>
    /// <param name="monitor">The Mod log the lifecycle reports through.</param>
    /// <param name="config">The opt-in configuration; an invalid one starts nothing.</param>
    /// <param name="clock">The wall clock the deadline is measured against.</param>
    /// <param name="commitShippingSummary">
    /// The engine commit seam, or null for the installed engine's own. Injected rather than hidden so a headless test
    /// can observe that a terminal really dispatches the commit, without a running game's audio track and player that
    /// `okClicked` itself dereferences (ShippingMenu.cs:690-696 -> Game1.changeMusicTrack -> Game1.player).
    /// </param>
    internal static SleepAndAdvanceDayLifecycle? TryStart(
        IMonitor monitor,
        SleepAndAdvanceDayLifecycleConfig? config,
        Func<DateTimeOffset>? clock = null,
        Func<ShippingMenu, bool>? commitShippingSummary = null)
    {
        if (config is not { IsValid: true })
            return null;
        var lifecycle = new SleepAndAdvanceDayLifecycle(
            monitor,
            config,
            clock ?? (() => DateTimeOffset.UtcNow),
            commitShippingSummary);
        monitor.Log(
            $"GameBuddy sleep lifecycle started; evidence='{config.EvidencePath}'; "
                + $"settleBudget={lifecycle.settleFrameBudget}; readyBarrierBudget={lifecycle.readyBarrierFrameBudget}.",
            LogLevel.Info);
        return lifecycle;
    }

    /// <summary>
    /// Whether this lifecycle still has a way to commit a standing settlement sheet.
    ///
    /// <para>
    /// The ONLY phase that commits one is <see cref="Phase.AwaitingModal"/> (`:424`), and that phase is reached from
    /// exactly one place: `WalkToBed()` returning true (`:404-405`). A night the engine took by its own 2:00 AM pass-out
    /// never walks to the bed - the engine moves the actor - so its lifecycle can sit in `AwaitingSave` or
    /// `AwaitingReadyBarrier` for ever with no route to the commit.
    /// </para>
    /// <para>
    /// MEASURED 2026-10-31: the clock read 2600 (02:00), the engine warped to FarmHouse and ran `NewDay`, the new day
    /// opened at 600, and `menu=ShippingMenu` then stood for the rest of the run. A lifecycle from the previous
    /// `advance_day` was still alive and NOT finished, so the day start's guard answered "someone owns this" and
    /// skipped - while that someone had no way left to act. Four earlier commits (`1b70f08e`, `541775c2`, `4357a95b`,
    /// `76c51da4`) all asked "has the lifecycle FINISHED", which is a question about its progress rather than about
    /// its capability, and the two come apart exactly here.
    /// </para>
    /// </summary>
    internal bool CanStillCommitSettlementMenu => !this.finished && this.phase == Phase.AwaitingModal;

    /// <summary>The native event edges this lifecycle consumes, forwarded by ModEntry.</summary>
    internal void ObserveSaved()
    {
        this.savedCount++;
    }

    internal void ObserveDayStarted()
    {
        this.dayStartedCount++;
    }

    /// <summary>
    /// True once THIS night's save has been observed. Deliberately derived by
    /// counting edges relative to the baseline captured when the night began, so
    /// the load-time Saved cannot satisfy it.
    /// </summary>
    private bool NightSavedObserved => HasFreshEdge(this.savedCount, this.savedBaseline, this.eventEdgeBaselineCaptured);

    /// <summary>
    /// True once THIS night's new day has actually begun. The date counter alone
    /// is not the day start (it advances mid-save on the master and syncs early on
    /// a client), and the load-time DayStarted is not this night's either.
    /// </summary>
    private bool NightDayStartedObserved =>
        HasFreshEdge(this.dayStartedCount, this.dayStartedBaseline, this.eventEdgeBaselineCaptured);

    /// <summary>
    /// A fresh native edge relative to the baseline captured when this night
    /// began. SMAPI raises DayStarted "including when the player loads a save"
    /// (and Saved on load too), so a sticky boolean is already true before the
    /// night is slept: the load-time edge would satisfy the day-start gate and the
    /// receipt would claim day_advanced while the real save had not even started.
    /// Measured live: the host's sticky flag was set by the initial load at
    /// 23:02:34, and day_advanced was minted at 23:02:49 while the real save began
    /// at 23:02:49 and the new day started at 23:02:51.
    /// </summary>
    internal static bool HasFreshEdge(int count, int baseline, bool baselineCaptured)
        => baselineCaptured && count > baseline;

    /// <summary>Returns true once the lifecycle reached a terminal state.</summary>
    internal bool Update()
    {
        if (this.finished)
            return true;

        if (this.clock() > this.deadline)
        {
            this.Finish("blocked", "lifecycle_deadline_exceeded", null);
            return true;
        }

        if (!Context.IsWorldReady || Game1.player is null)
            return false;

        this.ticks++;

        Phase phaseBefore = this.phase;
        bool terminal = this.Step();
        if (this.phase != phaseBefore && !this.finished)
            this.monitor.Log($"GameBuddy sleep lifecycle {phaseBefore} -> {this.phase} (topology={this.Topology()}).", LogLevel.Info);
        if (!terminal && this.ticks % 600 == 0 && !this.finished)
            // The three facts the day-start decision is made OF, published with the wait that is made from them.
            // Run g27 crossed the first night with every menu closed by the product and the world reporting day 6,
            // and the receipt was still missing - and there was no way to tell WHICH fact never arrived (the save,
            // its completion, or SMAPI's own DayStarted). `wait_frames` is included because exhausting it is a NAMED
            // outcome (`day_start_not_observed`), not a hang.
            this.monitor.Log(
                $"GameBuddy sleep lifecycle still in {this.phase} (topology={this.Topology()}). "
                + $"saving={this.savingObserved.ToString().ToLowerInvariant()};"
                + $"saved={this.NightSavedObserved.ToString().ToLowerInvariant()};"
                + $"day_started={this.NightDayStartedObserved.ToString().ToLowerInvariant()};"
                + $"delta={(Game1.Date?.TotalDays ?? 0) - this.dayBefore};"
                + $"wait_frames={this.dayStartWaitFrames}/{DayStartFrameBudget};"
                + $"is_saving={Game1.game1.IsSaving.ToString().ToLowerInvariant()}.",
                LogLevel.Info);
        return terminal;
    }

    private bool Step()
    {
        switch (this.phase)
        {
            case Phase.AwaitingEligibility:
                // Check the native pass-out hazard BEFORE the eligibility wait.
                // Pass-out can begin while the actor is still ineligible (for
                // example a menu is open, or the actor is not home yet). Without
                // this the lifecycle would block on a reason like "passed_out"
                // until the eligibility budget expired and then misreport a night
                // it should simply have observed.
                if (this.YieldToNativePassOut())
                    return false;
                if (!this.TryEnterEligibility(out string eligibilityReason))
                {
                    // A lifecycle that never becomes eligible is indistinguishable
                    // from one that never ran. Report why, bounded, on the game log.
                    this.eligibilityWaitFrames++;
                    if (eligibilityReason != this.lastEligibilityReason)
                    {
                        this.lastEligibilityReason = eligibilityReason;
                        this.monitor.Log($"GameBuddy sleep lifecycle waiting: {eligibilityReason}", LogLevel.Info);
                    }
                    else if (this.eligibilityWaitFrames % 600 == 0)
                    {
                        this.monitor.Log($"GameBuddy sleep lifecycle still waiting: {eligibilityReason}", LogLevel.Info);
                    }
                    // The status budget starts at eligibility, so a lifecycle that
                    // never becomes eligible has no deadline at all and would spin
                    // forever. Bound that separately and report the REAL reason:
                    // "we never slept because the actor was passed out / a menu
                    // was open" is not a generic timeout and must not be reported
                    // as one.
                    if (this.eligibilityWaitFrames >= EligibilityFrameBudget)
                    {
                        this.Finish(
                            "blocked",
                            $"never_eligible:{eligibilityReason}",
                            new Dictionary<string, object?>
                            {
                                ["topology"] = this.Topology(),
                                ["eligibilityReason"] = eligibilityReason,
                            });
                        return true;
                    }
                    return false;
                }
                this.trace.Add($"eligible={eligibilityReason};topology={this.Topology()}");
                // Start the bounded budget here: this is the first moment the
                // lifecycle owns a live, eligible actor.
                this.deadline = this.clock().AddSeconds(this.timeoutSeconds);
                this.monitor.Log($"GameBuddy sleep lifecycle eligible: {eligibilityReason}; topology={this.Topology()}.", LogLevel.Info);
                this.phase = Phase.WalkingToBed;
                return false;

            case Phase.WalkingToBed:
                // Pass-out is an AUTOMATIC native gate, not an action this
                // lifecycle may start or race. Game1.cs:6452 fires
                // `player.startToPassOut()` when `timeOfDay >= 2600 ||
                // player.stamina <= -15f`, and Farmer.performPassOut()
                // (Farmer.cs:5766-5782) answers by calling
                // `completelyStopAnimatingOrDoingAction()` + `animateOnce(293)`.
                // If THAT happened, continuing to drive PathFindController here
                // would fight the native animation for the same actor.
                if (this.YieldToNativePassOut())
                    return false;
                if (this.WalkToBed())
                    this.phase = Phase.AwaitingModal;
                return false;

            case Phase.AwaitingModal:
                // The Sleep touch action creates the yes/no DialogueBox in BOTH
                // topologies (GameLocation.cs:3763-3765). Only after it is
                // answered does startSleep() install the multiplayer
                // ReadyCheckDialog, so the no-question form does not exist.
                //
                // A ShippingMenu arriving here is not a question and not a surprise: the rollover pushes it BEFORE the
                // sleep prompt is raised, so a night that begins with yesterday's takings on screen waited forever. It
                // asks nothing - `okClicked` only starts the outro (ShippingMenu.cs:690-696) and the settlement itself
                // happened before the menu existed - so the lifecycle closes it the same way `dismiss_modal` does, and
                // for the same reason: leaving it standing makes the day-start budget expire and the night report
                // `blocked/day_start_not_observed`, which reads like a hang.
                //
                // A LevelUpMenu is deliberately NOT handled here: closing one grants a perk, and on a milestone that
                // grants whatever branch the closer happened to pick. That decision is the companion's, and a proxy
                // taking it was measured to be the wrong division of labour.
                if (Game1.activeClickableMenu is ShippingMenu uncommittedShipping)
                {
                    if (this.CommitShippingSummary(uncommittedShipping) == SettlementMenuOutcome.CommitUnavailable)
                        this.Finish("blocked", "shipping_summary_commit_unavailable", null);
                    return false;
                }
                if (Game1.activeClickableMenu is not DialogueBox)
                    return false;
                this.CaptureDayBaseline();
                this.trace.Add(
                    $"modal_observed;menu={Game1.activeClickableMenu.GetType().Name};dialogueUp={Game1.dialogueUp};"
                        + $"canMove={Game1.player.CanMove};hasMoved={Game1.player.hasMoved};"
                        + $"isInBed={Game1.player.isInBed.Value};day_before={this.dayBefore}");
                this.phase = Phase.AwaitingSettlement;
                return false;

            case Phase.AwaitingSettlement:
                return this.AnswerSleepPrompt();

            case Phase.AwaitingPassOutPipeline:
                return this.AwaitForPassOutPipeline();

            case Phase.AwaitingReadyBarrier:
                return this.WaitForReadyBarrier();

            case Phase.AwaitingSave:
                return this.ObserveSaveBoundary();

            case Phase.AwaitingDayStart:
                return this.EvaluateDayStart();
        }

        return false;
    }

    private string Topology()
    {
        if (!this.multiPlayer)
            return "single_player";
        if (Game1.IsServer)
            return "multiplayer_master";
        return Game1.IsMasterGame ? "multiplayer_master" : "multiplayer_client";
    }

    private bool TryEnterEligibility(out string reason)
    {
        reason = "ok";
        // Mirrors the native bed-interaction gate (GameLocation.cs:3698) and the
        // preconditions Game1.NewDay relies on (Game1.cs:10363-10388). The
        // multiplayer branch is a different machine, but these guards are shared:
        // both paths need a live, unpaused, mobile, non-passed-out actor with no
        // open modal.
        if (Game1.newDay) { reason = "already_new_day"; return false; }
        if (!Game1.shouldTimePass()) { reason = "time_paused"; return false; }
        if (Game1.player.passedOut) { reason = "passed_out"; return false; }
        if (Game1.activeClickableMenu is not null) { reason = "menu_open"; return false; }
        if (Game1.dialogueUp) { reason = "dialogue_up"; return false; }
        if (Game1.eventUp) { reason = "event_up"; return false; }
        // Cabin derives from FarmHouse, so this admits the AI Farmhand's own
        // cabin as well as the host's farmhouse.
        if (Game1.currentLocation is not FarmHouse) { reason = "not_home"; return false; }
        // A co-op night must not be started alone, and this MUST hold before the
        // multiplayer branch is chosen: `Game1.IsMultiplayer` is
        // `otherFarmers.Count > 0`, so a host that sleeps while its partner is
        // still connecting sees a single-player world, takes the single-player
        // native path, and advances the day by itself. Measured: the host slept
        // 7 seconds before the Farmhand reached readyToPlay.
        int online = Game1.getOnlineFarmers().Count;
        if (online < this.minimumOnlineFarmers)
        {
            reason = $"awaiting_online_farmers:{online}/{this.minimumOnlineFarmers}";
            return false;
        }
        this.multiPlayer = Game1.IsMultiplayer;
        return true;
    }

    /// <summary>
    /// Return true when the native pass-out path has taken the actor over.
    ///
    /// Pass-out is an AUTOMATIC native gate (Game1.cs:6452), so the lifecycle
    /// must yield rather than compete for the actor. Every signal here is a
    /// public native fact:
    ///  - <c>Farmer.passedOut</c>;
    ///  - <c>FarmerSprite.isPassingOut()</c>, which is what
    ///    <c>Farmer.performPassOut()</c> (Farmer.cs:5766-5782) installs via
    ///    <c>completelyStopAnimatingOrDoingAction()</c> + <c>animateOnce(293)</c>;
    ///  - the non-cancelable <see cref="ReadyCheckDialog"/> that
    ///    <c>Game1.PassOutNewDay()</c> (Game1.cs:10357-10360) installs in a
    ///    shared world.
    ///
    /// <c>CanMove</c> alone is deliberately NOT a signal: it is also false for
    /// benign reasons, and a false yield would misreport a healthy night.
    /// </summary>
    private bool YieldToNativePassOut()
    {
        bool passedOut = Game1.player.passedOut;
        bool spritePassingOut = Game1.player.FarmerSprite is { } sprite && sprite.isPassingOut();
        bool nonCancelableBarrier = Game1.activeClickableMenu is ReadyCheckDialog { } barrier
            && !barrier.isCancelable();
        if (!IsPassOutHazard(passedOut, spritePassingOut, nonCancelableBarrier))
            return false;

        if (this.yieldedToPassOut)
            return true;

        this.yieldedToPassOut = true;
        this.enteredVia = "native_pass_out";
        // The native path owns the actor from here. Stop driving it: the path
        // finder this lifecycle installed must not keep issuing moves against
        // the pass-out animation.
        if (this.installedController is not null && ReferenceEquals(Game1.player.controller, this.installedController))
            Game1.player.controller = null;
        this.CaptureDayBaseline();
        this.trace.Add(
            $"yielded_to_native_pass_out;passedOut={passedOut};spritePassingOut={spritePassingOut};"
                + $"nonCancelableBarrier={nonCancelableBarrier};day_before={this.dayBefore}");
        // The trace is in memory; this line is what survives in the SMAPI log, so it has to carry the same three
        // facts - otherwise an archived night cannot say whether the 2:00 AM pass-out owned the actor or the
        // animation had merely started.
        this.monitor.Log(
            FormatPassOutYieldLog(passedOut, spritePassingOut, nonCancelableBarrier),
            LogLevel.Info);
        this.phase = Phase.AwaitingPassOutPipeline;
        return true;
    }

    /// <summary>
    /// The archived wording of a pass-out yield, naming the three native facts that produced it.
    ///
    /// <c>yielded_to_native_pass_out</c> in <c>trace</c> carries the same names, but a trace never reaches the
    /// archived artifacts: only this line does. It used to be one generic sentence, so a reader of the run's SMAPI
    /// log could not tell the automatic 2:00 AM pass-out from any other yield. Built by a pure function rather than
    /// inline so the archived text itself is pinned without a live game.
    /// </summary>
    internal static string FormatPassOutYieldLog(bool passedOut, bool spritePassingOut, bool nonCancelableBarrier)
        => "GameBuddy sleep lifecycle yielded to the native pass-out path "
            + $"(passedOut={passedOut};spritePassingOut={spritePassingOut};nonCancelableBarrier={nonCancelableBarrier}); "
            + "the lifecycle will only observe from here.";

    /// <summary>
    /// The pass-out hazard predicate, separated from the live game so it can be
    /// pinned without a running instance.
    ///
    /// Every signal is a distinct native fact, and each is deliberately narrow:
    ///  - <paramref name="passedOut"/>: <c>Farmer.passedOut</c>, set by the native
    ///    pass-out pipeline (Game1.cs:10351) and by <c>NewDay</c> (Game1.cs:10380);
    ///  - <paramref name="spritePassingOut"/>: the <c>animateOnce(293)</c> frame
    ///    that <c>Farmer.performPassOut()</c> installs (Farmer.cs:5766-5782);
    ///  - <paramref name="nonCancelableBarrier"/>: the non-cancelable
    ///    <c>ReadyCheckDialog("sleep", allowCancel: false)</c> that
    ///    <c>Game1.PassOutNewDay()</c> installs in a shared world
    ///    (Game1.cs:10357-10360).
    ///
    /// <c>CanMove</c> is deliberately NOT part of this predicate. It is false for
    /// many benign reasons, and yielding on it would abandon a healthy night.
    /// </summary>
    internal static bool IsPassOutHazard(bool passedOut, bool spritePassingOut, bool nonCancelableBarrier)
        => passedOut || spritePassingOut || nonCancelableBarrier;

    /// <summary>
    /// Pure day-start decision, separated from the live game so it can be pinned.
    /// The date counter is NOT the day start: on the master it advances while the
    /// save is still in flight, on a client it syncs over the network. Claiming
    /// <c>day_advanced</c> before DayStarted would let the Agent act mid-save, so
    /// the counter alone must wait, and exhausting the wait must report
    /// <c>day_start_not_observed</c> instead of forging success.
    /// </summary>
    internal enum DayStartOutcome
    {
        Waiting,
        Confirmed,
        UnexpectedDelta,
        NotObserved,
    }

    internal static DayStartOutcome DecideDayStart(
        int delta,
        bool dayStartedObserved,
        int dayStartWaitFrames,
        int budget)
    {
        if (delta == 0)
            return DayStartOutcome.Waiting;
        if (delta != 1)
            return DayStartOutcome.UnexpectedDelta;
        if (dayStartedObserved)
            return DayStartOutcome.Confirmed;
        if (dayStartWaitFrames < budget)
            return DayStartOutcome.Waiting;
        return DayStartOutcome.NotObserved;
    }

    /// <summary>
    /// Observe what the native pass-out path does next without ever driving it.
    /// In a shared world it installs the ready barrier; in single player
    /// <c>Game1.PassOutNewDay()</c> (Game1.cs:10344-10347) calls
    /// <c>NewDay(0f)</c> itself, so the day rollover is simply observed.
    /// </summary>
    private bool AwaitForPassOutPipeline()
    {
        if (this.multiPlayer && Game1.activeClickableMenu is ReadyCheckDialog { } barrier)
        {
            this.readyCheckObserved = true;
            this.trace.Add(
                $"pass_out_ready_barrier_observed;cancelable={barrier.isCancelable()};"
                    + $"ready={this.ReadyCount()}/{this.RequiredCount()}");
            this.phase = Phase.AwaitingReadyBarrier;
            return false;
        }

        // Single player (and the tail of the shared-world path) reaches the day
        // fact without any modal of this lifecycle's making.
        if (Game1.Date.TotalDays != this.dayBefore)
        {
            this.trace.Add("pass_out_day_advanced");
            this.phase = Phase.AwaitingDayStart;
            return false;
        }

        if (this.ticks % 120 == 0 && this.trace.Count < 64)
            this.trace.Add(
                $"pass_out_pipeline_waiting;canMove={Game1.player.CanMove};passedOut={Game1.player.passedOut};"
                    + $"menu={(Game1.activeClickableMenu?.GetType().Name ?? "none")}");
        return false;
    }

    /// <summary>Capture the pre-advance day baseline exactly once.</summary>
    private void CaptureDayBaseline()
    {
        if (this.dayBaselineCaptured)
            return;
        this.dayBefore = Game1.Date.TotalDays;
        this.daysBefore = (int)Game1.stats.DaysPlayed;
        this.dayBaselineCaptured = true;
        // Anchor the event-edge counters at the same moment, so only edges that
        // fire after the night actually began can satisfy the day-start gate.
        this.savedBaseline = this.savedCount;
        this.dayStartedBaseline = this.dayStartedCount;
        this.eventEdgeBaselineCaptured = true;
    }

    /// <summary>
    /// Return true once the actor is standing on the bed tile, so the game
    /// itself raises the Sleep touch action.
    /// </summary>
    /// <summary>
    /// The walk-to-bed search budget. The game s own settler walk uses 10000
    /// (`PathFindController.cs:62`); the bed is a handful of tiles away, so this only has to be a
    /// bound on the game thread rather than a tuned number, and the trace records how many tiles the
    /// plan actually had so a refusal can never be read as an arrival.
    /// </summary>
    private const int BedWalkNodeBudget = 10000;

    private bool WalkToBed()
    {        if (Game1.player.currentLocation is not FarmHouse farmHouse)
            return false;
        Point bedSpot = farmHouse.GetPlayerBedSpot();
        var bedTile = new Vector2(bedSpot.X, bedSpot.Y);

        if (Game1.player.Tile == bedTile)
        {
            this.trace.Add($"arrival=already_on_bed_tile:{bedSpot.X},{bedSpot.Y};isInBed={Game1.player.isInBed.Value}");
            return true;
        }

        if (!this.arrivalDispatched)
        {
            // The native path finder is the same route the game's own villagers use; it is not input
            // injection.
            //
            // NOT the four-argument constructor: that one passes `PathFindController.isAtEndPoint` directly,
            // and it is the only form whose constructor can TELEPORT the actor instead of planning
            // (`PathFindController.cs:133-136` moves the player onto the end point when the location has no
            // farmers, and leaves `pathToEndPoint` null). With a predicate of our own that branch cannot be
            // taken, so the trace below always describes a real plan rather than a silent placement.
            var controller = new PathFindController(
                Game1.player,
                farmHouse,
                (node, target, _location, _character) => node.x == target.X && node.y == target.Y,
                Game1.player.FacingDirection,
                null,
                BedWalkNodeBudget,
                bedSpot);
            Game1.player.controller = controller;
            this.installedController = controller;
            this.arrivalDispatched = true;
            int plannedTiles = controller.pathToEndPoint?.Count ?? 0;
            this.trace.Add(
                $"pathfind_to_bed_tile:{bedSpot.X},{bedSpot.Y};planned_tiles={plannedTiles};"
                    + $"location_farmers={farmHouse.farmers.Count};from={Game1.player.Tile.X},{Game1.player.Tile.Y}");
            if (plannedTiles == 0)
                this.trace.Add($"bed_walk_unplanned;tile={Game1.player.Tile.X},{Game1.player.Tile.Y}");
            return false;
        }

        if (this.ticks % 30 == 0 && this.trace.Count < 64)
            this.trace.Add(
                $"en_route;tile={Game1.player.Tile.X},{Game1.player.Tile.Y};target={bedSpot.X},{bedSpot.Y};"
                    + $"controller={(Game1.player.controller?.GetType().Name ?? "none")}");
        return false;
    }

    /// <summary>
    /// Close the morning-after shipping summary through the engine's own commit path, once per menu instance.
    ///
    /// `ShippingMenu` overrides neither `exitThisMenu` nor `cleanupBeforeExit`, so a generic close is a pure cancel - and
    /// the save does not live on the close path. `okClicked` (ShippingMenu.cs:690-696) starts the outro, and the outro is
    /// what creates `SaveGameMenu`, which is the menu whose completion runs the save and raises `Saved`/`DayStarted`.
    ///
    /// The action `dismiss_modal` already does exactly this for the same menu, and the two must not diverge: this is a
    /// thin call into the same private method rather than a second implementation, because a lifecycle that closes the
    /// summary differently from the published action would make one of them the wrong answer to "what does dismissing
    /// a shipping summary do".
    ///
    /// The two classes genuinely cannot share ONE body today: `RequestLocalDismissModal` is an admission-bound method
    /// on `ExecutionManager` (it needs the request, the ledger and the bound actor, and it mints a receipt of its own),
    /// while this runs from a lifecycle that has none of the three, and the only genuinely shared part is the reflection
    /// reach into `okClicked`. Extracting that reach into a helper would require editing `dismiss_modal`'s file, which
    /// this change deliberately does not touch.
    /// </summary>
    private SettlementMenuOutcome CommitShippingSummary(ShippingMenu menu)
    {
        bool alreadyCommitted = ReferenceEquals(this.committedShippingSummary, menu);
        SettlementMenuOutcome decision = DecideSettlementMenuCommit(true, alreadyCommitted);
        if (decision != SettlementMenuOutcome.Committed)
            return decision;

        // Recorded BEFORE the seam runs. A seam that throws half-way has still left the engine's outro flags where the
        // dispatch put them, and `okClicked` restarts the fade (ShippingMenu.cs:690-696) - so the dispatch, not its
        // success, is what may happen only once.
        this.committedShippingSummary = menu;
        try
        {
            if (!this.commitShippingSummary(menu))
            {
                this.trace.Add("shipping_summary_commit_unavailable");
                return SettlementMenuOutcome.CommitUnavailable;
            }
        }
        catch (Exception error)
        {
            // `Finish` now reaches engine code on EVERY terminal, so an exception from the seam may not escape into the
            // game loop: the outro did not start, the menu is still standing, and the receipt has to say so.
            this.trace.Add($"shipping_summary_commit_threw;exception={error.GetType().Name}");
            return SettlementMenuOutcome.CommitFailed;
        }

        this.trace.Add("shipping_summary_committed");
        return SettlementMenuOutcome.Committed;
    }

    /// <summary>
    /// The installed engine's own commit seam on `ShippingMenu`: `okClicked`, or false when this game build no longer
    /// has it (so the caller refuses rather than falling back to a generic close, which would cancel the settlement).
    ///
    /// Read once per class, not per menu: it is a fact about the installed engine. Not a second closing implementation -
    /// it is the same private method `dismiss_modal` reaches for, and the reason both reach for it instead of calling
    /// `exitThisMenu` is the comment above.
    /// </summary>
    private static bool EngineShippingCommit(ShippingMenu menu)
    {
        if (ShippingCommitSeam is null)
            return false;
        ShippingCommitSeam.Invoke(menu, null);
        return true;
    }

    private static readonly MethodInfo? ShippingCommitSeam = typeof(ShippingMenu).GetMethod(
        "okClicked",
        BindingFlags.Instance | BindingFlags.NonPublic);

    /// <summary>
    /// Whether a standing menu is the morning-after settlement this lifecycle owns.
    ///
    /// Deliberately one type. `ShippingMenu` presents numbers and its own click action only starts the outro
    /// (ShippingMenu.cs:690-696), so committing it takes no decision. `LevelUpMenu` grants a perk when it closes and a
    /// `DialogueBox` carries a question, so neither is residue a terminal may settle.
    /// </summary>
    internal static bool IsRolloverSettlementMenu(IClickableMenu? activeMenu) => activeMenu is ShippingMenu;

    /// <summary>
    /// Commit a standing morning-after summary through the engine seam, or refuse a menu whose close would take a
    /// decision.
    ///
    /// The mechanism only. Whether any lifecycle could commit this menu, and the measurement that put the question
    /// there, belong to <see cref="SettleStandingSettlementMenuNoLifecycleCanCommit"/>.
    ///
    /// `okClicked` only starts the outro (ShippingMenu.cs:690-696) and settles nothing - the settlement happened
    /// before the menu existed - so this takes no decision and may be done on the companion's behalf. A `LevelUpMenu`
    /// grants a perk when it closes, which is why this refuses anything else.
    /// </summary>
    internal static SettlementMenuOutcome SettleStandingSettlementMenuWithoutLifecycle(IClickableMenu? standing)
    {
        if (!IsRolloverSettlementMenu(standing))
            return SettlementMenuOutcome.NotPresent;
        return EngineShippingCommit((ShippingMenu)standing!) ? SettlementMenuOutcome.Committed : SettlementMenuOutcome.CommitUnavailable;
    }

    /// <summary>
    /// A day that begins with the summary still standing, and no lifecycle to commit it, is the pass-out night.
    ///
    /// The lifecycle is the ordinary owner of this menu (`Phase.AwaitingModal`), but it exists only because
    /// `advance_day` started one - so a night the engine took by its own 2:00 AM pass-out has nobody to discharge
    /// the obligation. `shouldTimePass` then returns false while the menu is up (Game1.cs:9300-9303), which means
    /// the companion can neither act nor wait the blockage out. Measured 2026-10-28 (`round6`): the clock sat at
    /// 06:00 for 31 real minutes and the run died.
    ///
    /// Committed here rather than by the harness, because a harness that clicks it proves the harness: in a real
    /// session nobody is standing at the screen. This is the same engine seam the lifecycle and `dismiss_modal`
    /// reach for, on the one menu whose close takes no decision.
    ///
    /// Both facts arrive from the caller: `owner` is its handle, null on a night no `advance_day` started, and a
    /// finished lifecycle keeps reporting its last phase so the handle alone does not settle the question;
    /// `standing` is the menu it read. Neither is read here, so this decides ownership and nothing else.
    /// </summary>
    internal static void SettleStandingSettlementMenuNoLifecycleCanCommit(
        SleepAndAdvanceDayLifecycle? owner,
        IClickableMenu? standing)
    {
        // "No lifecycle can commit it" is a question about CAPABILITY, not about progress.
        //
        // This used to read `owner is not null && !owner.IsFinished` and return, i.e. it treated any unfinished
        // lifecycle as an owner. But the only phase that commits a settlement sheet is `AwaitingModal`, which is
        // reachable only through `WalkToBed()` - so a pass-out night's lifecycle, or a stale one left from an earlier
        // `advance_day`, holds the guard while having no route to the commit. The menu then stands for the rest of the
        // run with the clock frozen (measured 2026-10-31, and four prior attempts).
        //
        // A lifecycle that CAN still commit keeps its ownership, which is the property the earlier guard was protecting:
        // two `okClicked` dispatches on one menu restart the outro and freeze the settlement (ShippingMenu.cs:690-696).
        if (owner is not null && owner.CanStillCommitSettlementMenu)
            return;
        SettleStandingSettlementMenuWithoutLifecycle(standing);
    }

    /// <summary>
    /// The commit decision, separated from the live game so the whole table can be pinned without a running instance.
    ///
    /// The ORDER is the invariant, not the branch shape: a menu this lifecycle already committed must report that
    /// instead of committing again, because `okClicked` restarts the outro fade (ShippingMenu.cs:690-696) and a second
    /// dispatch while the first outro runs freezes the settlement instead of finishing it. That is the same reason
    /// `dismiss_modal` reports what it cleared rather than closing twice.
    /// </summary>
    internal static SettlementMenuOutcome DecideSettlementMenuCommit(bool settlementMenuStanding, bool alreadyCommitted)
    {
        if (!settlementMenuStanding)
            return SettlementMenuOutcome.NotPresent;
        return alreadyCommitted ? SettlementMenuOutcome.AlreadyCommitted : SettlementMenuOutcome.Committed;
    }

    /// <summary>The receipt vocabulary for <see cref="SettlementMenuOutcome"/>.</summary>
    internal static string DescribeSettlementMenuOutcome(SettlementMenuOutcome outcome) => outcome switch
    {
        SettlementMenuOutcome.Committed => "committed",
        SettlementMenuOutcome.AlreadyCommitted => "already_committed",
        SettlementMenuOutcome.CommitUnavailable => "commit_unavailable",
        SettlementMenuOutcome.CommitFailed => "commit_failed",
        _ => "none",
    };

    /// <summary>
    /// Discharge the one obligation that outlives the phase which raised it.
    ///
    /// The rollover pushes `ShippingMenu` onto `Game1.endOfNightMenus` (Game1.cs:9112-9160) and, until `okClicked`
    /// starts its outro, that menu holds the actor for every later request as well as for `advance_day`'s own
    /// eligibility gate (`menu_open`). `Phase.AwaitingModal` was the ONLY code that ever looked at it, so a night that
    /// settled before reaching that phase - or through a day-start route that never went through the modal at all -
    /// handed the actor back with the menu standing and nothing left to own it.
    ///
    /// That second route is the measured one (2026-10-26): `DayStarted` fires both when the active menu LEAVES a
    /// ShippingMenu/SaveGameMenu (Game1.cs:1686-1703) AND on the day-transition game mode settling (Game1.cs:4393-4395),
    /// so a night can confirm its new day while the settlement is still standing. Measured consequence: day 5 began at
    /// 06:00, the companion could not act, could not move, and could not start another night, because a modal outlived
    /// the process that owned it.
    ///
    /// Runs from the terminal BEFORE the receipt evidence is built, so the receipt states what happened instead of
    /// leaving a reader to infer it, and before the owning execution drops the lifecycle handle - after that drop
    /// nothing in the product looks at this menu again except the `dismiss_modal` action.
    ///
    /// Internal rather than private so the terminal's own obligation can be exercised headless against a seeded
    /// `Game1.activeClickableMenu`; it is not part of the execution surface.
    /// </summary>
    internal SettlementMenuOutcome SettleStandingSettlementMenu()
    {
        IClickableMenu? standing = Game1.activeClickableMenu;
        if (!IsRolloverSettlementMenu(standing))
            return SettlementMenuOutcome.NotPresent;
        // IsRolloverSettlementMenu admits exactly one type, so this cast cannot fail.
        return this.CommitShippingSummary((ShippingMenu)standing!);
    }
    private bool AnswerSleepPrompt()
    {
        if (Game1.activeClickableMenu is not DialogueBox dialogueBox)
        {
            if (this.answerDispatched)
            {
                // The game's own outro finished the modal between frames.
                this.trace.Add($"modal_settled_by_game;frames={this.settleFrames}");
            }
            else
            {
                // The modal resolved before we could answer (an event, or the
                // game itself finished it). Keep observing instead of failing.
                this.trace.Add("dialogue_gone_before_answer");
            }
            this.phase = this.multiPlayer ? Phase.AwaitingReadyBarrier : Phase.AwaitingSave;
            return false;
        }

        if (!this.answerDispatched)
        {
            Response? yes = dialogueBox.responses?.FirstOrDefault(
                    response => string.Equals(response.responseKey, "Yes", StringComparison.Ordinal))
                ?? Game1.questionChoices?.FirstOrDefault(
                    response => string.Equals(response.responseKey, "Yes", StringComparison.Ordinal));
            if (yes is null)
            {
                this.Finish("blocked", "yes_choice_missing", null);
                return true;
            }

            // The exact two public steps the native input paths use, in order.
            GameLocation location = Game1.currentLocation;
            bool answered = location.answerDialogue(yes);
            dialogueBox.beginOutro();
            this.answerDispatched = true;
            this.trace.Add($"answered={answered};answered_via=answerDialogue;outro=beginOutro");
            this.monitor.Log($"GameBuddy sleep lifecycle answered the native Sleep prompt; answered={answered}.", LogLevel.Info);
            return false;
        }

        // The game's own update loop performs the settle; this only counts frames
        // (one per call) and never forces it.
        this.settleFrames++;

        if (this.multiPlayer && Game1.activeClickableMenu is ReadyCheckDialog)
        {
            // The native multiplayer answer path already installed the barrier.
            // That IS this phase's settlement; the barrier has its own budget.
            this.trace.Add(
                $"ready_check_observed;frames={this.settleFrames};check={SleepReadyCheckId};"
                    + $"ready={this.ReadyCount()}/{this.RequiredCount()}");
            this.phase = Phase.AwaitingReadyBarrier;
            return false;
        }

        if (Game1.activeClickableMenu is null && !Game1.dialogueUp && Game1.player.CanMove)
        {
            this.trace.Add($"modal_settled;frames={this.settleFrames}");
            this.phase = this.multiPlayer ? Phase.AwaitingReadyBarrier : Phase.AwaitingSave;
            return false;
        }

        if (this.settleFrames < this.settleFrameBudget)
            return false;

        this.trace.Add($"modal_settlement_budget_exhausted;frames={this.settleFrames}");
        this.Finish("blocked", "modal_not_settled", null);
        return true;
    }

    /// <summary>
    /// Observe the native end-of-night save without ever triggering it. The save
    /// may already have completed while the outro settled (the day rollover is
    /// synchronous in single player), so this phase is bounded and never blocks
    /// the lifecycle: it reports exactly what it saw.
    /// </summary>
    private bool ObserveSaveBoundary()
    {
        if (Game1.game1.IsSaving)
        {
            if (!this.savingObserved)
                this.trace.Add("saving_observed");
            this.savingObserved = true;
            this.saveBoundaryFrames = 0;
            return false;
        }

        if (this.NightSavedObserved)
        {
            if (!this.savedTraceLogged)
            {
                this.trace.Add("saved_observed");
                this.savedTraceLogged = true;
            }
            this.phase = Phase.AwaitingDayStart;
            return false;
        }

        // No save is in flight and none was seen. Give the native pipeline a
        // bounded window, then continue: the day fact is the authority, and a
        // client observes the rollover over the network without saving at all.
        this.saveBoundaryFrames++;
        if (this.saveBoundaryFrames >= SaveBoundaryFrameBudget)
        {
            // The budget expiring is a FACT ABOUT THIS NIGHT, not an internal detail: the transition that follows is
            // taken without an observed save, and a receipt that does not say so reads as if one happened. Measured
            // 2026-10-17/18 (run g28): `AwaitingSave -> AwaitingDayStart` fired exactly 300 frames after the wait
            // began - the budget, not a save - while `is_saving=false` for the whole run, and the receipt could not
            // state that because the fact lived only in this in-memory trace.
            this.saveBoundaryNotObserved = true;
            this.trace.Add("save_boundary_not_observed");
            this.phase = Phase.AwaitingDayStart;
        }
        return false;
    }

    /// <summary>
    /// The multiplayer branch: the native ready barrier owns everything from
    /// here. This method never answers the dialog, never marks another player
    /// ready and never calls doSleep/NewDay. It only observes.
    /// </summary>
    private bool WaitForReadyBarrier()
    {
        // Once every required farmer is ready the dialog confirms itself and
        // native doSleep runs; the modal then leaves the menu stack.
        if (Game1.activeClickableMenu is not ReadyCheckDialog)
        {
            // Capture the counts while the check is still live: the
            // synchronizer resets its checks once the night is over, so a later
            // read would honestly report 0/0 and hide what was actually achieved.
            // Reaching this phase at all means the native multiplayer sleep path
        // installed its ready barrier; the flag must not depend on which of the
        // two native settlement routes got us here.
        this.readyCheckObserved = true;
        this.readyAtCompletion = this.ReadyCount();
            this.requiredAtCompletion = this.RequiredCount();
            this.trace.Add(
                $"ready_barrier_completed;frames={this.readyBarrierFrames};"
                    + $"ready={this.readyAtCompletion}/{this.requiredAtCompletion};isReady={Game1.netReady.IsReady(SleepReadyCheckId)}");
            this.phase = Phase.AwaitingDayStart;
            return false;
        }

        this.readyBarrierFrames++;
        if (this.readyBarrierFrames % 30 == 0 && this.trace.Count < 64)
            this.trace.Add($"ready_barrier_waiting;ready={this.ReadyCount()}/{this.RequiredCount()}");

        if (this.readyBarrierFrames < this.readyBarrierFrameBudget)
            return false;

        // Honest terminal state: the AI declared ready through the native path
        // and is still waiting. Reporting "blocked" would misattribute the cause;
        // the barrier is owned by the other players.
        int ready = this.ReadyCount();
        int required = this.RequiredCount();
        this.trace.Add($"ready_barrier_incomplete;ready={ready}/{required}");
        this.Finish(
            "waiting",
            "requires_other_player",
            new Dictionary<string, object?>
            {
                ["ready"] = ready,
                ["required"] = required,
                ["topology"] = this.Topology(),
            });
        return true;
    }

    private int ReadyCount() => Game1.netReady.GetNumberReady(SleepReadyCheckId);

    private int RequiredCount() => Game1.netReady.GetNumberRequired(SleepReadyCheckId);

    private bool EvaluateDayStart()
    {
        if (Game1.game1.IsSaving)
            this.savingObserved = true;

        int dayAfter = Game1.Date.TotalDays;
        int daysAfter = (int)Game1.stats.DaysPlayed;
        int delta = dayAfter - this.dayBefore;

        // A save can only be mid-flight on the master; on a client the day fact
        // arrives over the network. Either way the rollover must not be reported
        // while the save barrier is still open.
        if (Game1.game1.IsSaving)
        {
            this.savingObserved = true;
            return false;
        }

        switch (DecideDayStart(delta, this.NightDayStartedObserved, this.dayStartWaitFrames, DayStartFrameBudget))
        {
            case DayStartOutcome.Waiting:
                if (delta != 0)
                    this.dayStartWaitFrames++;
                if (this.dayStartWaitFrames % 120 == 0 && this.trace.Count < 64)
                    this.trace.Add(
                        $"awaiting_day_start;counter_advanced=true;frames={this.dayStartWaitFrames}");
                return false;

            case DayStartOutcome.UnexpectedDelta:
                // A +2 jump means a second rollover was triggered (e.g. an overnight
                // event that also calls NewDay). That is not one bounded lifecycle.
                this.Finish("blocked", $"unexpected_day_delta:{delta}", null);
                return true;

            case DayStartOutcome.Confirmed:
                this.trace.Add("day_started_observed");
                break;

            case DayStartOutcome.NotObserved:
                // The day counter moved but the new day never became playable within
                // the budget. Report honestly instead of forging day_advanced, so the
                // Agent cannot act mid-save off a counter that raced ahead of the
                // save boundary.
                this.Finish(
                    "blocked",
                    "day_start_not_observed",
                    new Dictionary<string, object?>
                    {
                        ["topology"] = this.Topology(),
                        ["dayAfter"] = dayAfter,
                        ["deltas"] = delta,
                        ["savingObserved"] = this.savingObserved,
                        ["savedObserved"] = this.NightSavedObserved,
                        ["readyCheckObserved"] = this.readyCheckObserved,
                    });
                return true;
        }

        var settlement = new Dictionary<string, object?>
        {
            ["enteredVia"] = this.enteredVia,
            ["topology"] = this.Topology(),
            ["dayBefore"] = this.dayBefore,
            ["dayAfter"] = dayAfter,
            ["daysPlayedBefore"] = this.daysBefore,
            ["daysPlayedAfter"] = daysAfter,
            ["savingObserved"] = this.savingObserved,
            ["savedObserved"] = this.NightSavedObserved,
            ["dayStartedObserved"] = this.NightDayStartedObserved,
            // The transition was taken WITHOUT an observed save, and the receipt says so rather than leaving a reader
            // to infer that a save happened (see ObserveSaveBoundary).
            ["saveBoundaryNotObserved"] = this.saveBoundaryNotObserved,
            ["readyCheckObserved"] = this.readyCheckObserved,
        };
        if (this.multiPlayer)
        {
            settlement["readyAtCompletion"] = this.readyAtCompletion;
            settlement["requiredAtCompletion"] = this.requiredAtCompletion;
        }
        this.Finish("passed", "day_advanced", settlement);
        return true;
    }

    /// <summary>
    /// Bounded, content-safe projection of the terminal for a bridge receipt.
    /// Deliberately a flat key=value evidence string, the shape every other
    /// action receipt uses, so no receipt consumer needs a lifecycle-specific
    /// parser.
    /// </summary>
    private string BuildReceiptEvidence(string state, string reasonCode, Dictionary<string, object?>? settlement)
    {
        var parts = new List<string>
        {
            $"state={state}",
            $"reason={reasonCode}",
            $"topology={this.Topology()}",
            $"entered_via={this.enteredVia}",
            $"saving_observed={this.savingObserved.ToString().ToLowerInvariant()}",
            $"saved_observed={this.NightSavedObserved.ToString().ToLowerInvariant()}",
            $"day_started_observed={this.NightDayStartedObserved.ToString().ToLowerInvariant()}",
            // A receipt that claims a day advanced without saying whether a save was ever observed lets a reader
            // assume one. Published unconditionally, because "false" here is the informative value.
            $"save_boundary_not_observed={this.saveBoundaryNotObserved.ToString().ToLowerInvariant()}",
            // What the night's last owner did with a settlement menu the engine still held when the night ended.
            // Published unconditionally: "none" is the ordinary case, and its absence would leave a reader unable to
            // tell an owned settlement from a receipt written before the menu was ever looked at.
            $"shipping_summary_settled={DescribeSettlementMenuOutcome(this.settlementMenuOutcome)}",
        };
        if (this.dayBaselineCaptured)
        {
            parts.Add($"day_before={this.dayBefore}");
            parts.Add($"days_before={this.daysBefore}");
            parts.Add($"day_after={Game1.Date.TotalDays}");
            parts.Add($"days_after={Game1.stats.DaysPlayed}");
        }
        if (this.multiPlayer)
        {
            parts.Add($"ready_check_observed={this.readyCheckObserved.ToString().ToLowerInvariant()}");
            parts.Add($"ready_at_completion={this.readyAtCompletion}");
            parts.Add($"required_at_completion={this.requiredAtCompletion}");
        }
        if (settlement is not null)
        {
            foreach (KeyValuePair<string, object?> entry in settlement)
                parts.Add($"{entry.Key}={entry.Value}");
        }
        return string.Join(';', parts);
    }

    /// <summary>
    /// Build the event chain from what this run actually observed.
    ///
    /// This must never be a topology-shaped template: a yielded pass-out run
    /// answers no dialogue and settles no modal of its own, so listing
    /// <c>answerDialogue(Yes)+beginOutro</c> or <c>modality_settled</c> there
    /// would report events that did not happen. Each entry is derived from the
    /// recorded trace instead.
    /// </summary>
    private object[] BuildEventChain()
    {
        var chain = new List<string>();
        // Only claim eligibility when this run actually became eligible: a
        // yielded pass-out can fire before that, and reporting "eligibility"
        // there would describe a gate that never opened.
        if (this.trace.Any(entry => entry.StartsWith("eligible=", StringComparison.Ordinal)))
            chain.Add("eligibility");
        if (this.enteredVia == "native_pass_out")
            chain.Add("native_pass_out_before_eligibility");
        if (this.trace.Any(entry => entry.StartsWith("pathfind_to_bed_tile", StringComparison.Ordinal)))
            chain.Add("pathfind_to_bed_tile");
        if (this.trace.Any(entry => entry.StartsWith("modal_observed", StringComparison.Ordinal)))
        {
            chain.Add("native_sleep_touch_action");
            chain.Add("game_owned_dialogue_box");
        }
        if (this.answerDispatched)
        {
            chain.Add("answerDialogue(Yes)+beginOutro");
            chain.Add("modality_settled");
        }
        if (this.enteredVia == "native_pass_out" && !chain.Contains("native_pass_out_before_eligibility"))
            chain.Add("native_pass_out_yielded");
        if (this.readyCheckObserved)
            chain.Add("native_ready_barrier");
        if (this.savingObserved)
            chain.Add("saving");
        if (this.NightSavedObserved)
            chain.Add("saved");
        if (this.NightDayStartedObserved)
            chain.Add("day_started");
        if (this.settlementMenuOutcome is SettlementMenuOutcome.Committed or SettlementMenuOutcome.AlreadyCommitted)
            chain.Add("shipping_summary_committed");
        return chain.ToArray();
    }

    private void Finish(string state, string reasonCode, Dictionary<string, object?>? settlement)
    {
        if (this.finished)
            return;
        this.finished = true;

        // The night's last owner is handing the actor back on this tick, and the owning execution drops the handle as
        // soon as this returns. Anything the rollover raised and this lifecycle still holds is settled HERE, before
        // the terminal is projected, so that dropping the handle ends an ownership that is complete rather than
        // abandoning a modal nothing else in the product will close.
        this.settlementMenuOutcome = this.SettleStandingSettlementMenu();

        var evidence = new Dictionary<string, object?>
        {
            ["schema"] = Schema,
            ["state"] = state,
            ["reasonCode"] = reasonCode,
            ["topology"] = this.Topology(),
            ["targetVersion"] = new Dictionary<string, object?> { ["game"] = Game1.version },
            ["settlement"] = settlement,
            ["settlementMenu"] = DescribeSettlementMenuOutcome(this.settlementMenuOutcome),
            ["trace"] = this.trace.ToArray(),
            ["eventChain"] = this.BuildEventChain(),
        };

        // The same facts feed the bridge receipt when an execution owns this
        // lifecycle. Never a second authority: this is the evidence projection of
        // the identical terminal, and the ledger mints the receipt.
        this.TerminalState = state;
        this.TerminalReasonCode = reasonCode;
        this.TerminalEvidence = BuildReceiptEvidence(state, reasonCode, settlement);

        try
        {
            // An execution-owned night has no file to write; its receipt carries
            // the same facts. Only the configured evidence lane writes a file.
            if (this.evidencePath.Length == 0)
            {
                this.monitor.Log(
                    $"GameBuddy sleep lifecycle finished: state={state}; reason={reasonCode}; evidence=receipt.",
                    LogLevel.Info);
                return;
            }
            string? directory = Path.GetDirectoryName(this.evidencePath);
            if (!string.IsNullOrWhiteSpace(directory))
                Directory.CreateDirectory(directory);
            File.WriteAllText(this.evidencePath, JsonSerializer.Serialize(evidence, EvidenceJsonOptions));
            this.monitor.Log(
                $"GameBuddy sleep lifecycle finished: state={state}; reason={reasonCode}; evidence='{this.evidencePath}'.",
                LogLevel.Info);
        }
        catch (Exception error)
        {
            this.monitor.Log($"GameBuddy sleep lifecycle could not write evidence: {error.GetType().Name}.", LogLevel.Error);
        }
    }
}

/// <summary>
/// Opt-in, evidence-only configuration for <see cref="SleepAndAdvanceDayLifecycle"/>.
/// It is never part of a user profile.
/// </summary>
public sealed class SleepAndAdvanceDayLifecycleConfig
{
    public bool Enable { get; init; }
    public string EvidencePath { get; init; } = string.Empty;
    public int TimeoutSeconds { get; init; } = 120;
    public int SettleFrameBudget { get; init; } = 240;

    /// <summary>
    /// Frames to wait for other players to reach the native ready barrier before
    /// reporting <c>requires_other_player</c>. Only used in multiplayer.
    /// </summary>
    public int ReadyBarrierFrameBudget { get; init; } = 3600;

    /// <summary>
    /// Farmers that must be online before a lifecycle may start. A co-op night
    /// must not be advanced alone: the host would otherwise see a single-player
    /// world while its partner is still connecting and roll the day over by
    /// itself. Default 1 keeps an honest single-player run working; a co-op driver
    /// declares 2.
    /// </summary>
    public int MinimumOnlineFarmers { get; init; } = 1;

    internal bool IsValid => this.Enable
        // The evidence file is optional: an execution-owned night is observable
        // through its receipt, so requiring a path would reject every such night.
        && (this.EvidencePath.Length == 0 || Path.IsPathFullyQualified(this.EvidencePath))
        && this.TimeoutSeconds is >= 10 and <= 3600
        && this.SettleFrameBudget is >= 1 and <= 600
        && this.ReadyBarrierFrameBudget is >= 1 and <= 36000
        && this.MinimumOnlineFarmers is >= 1 and <= 8;
}
