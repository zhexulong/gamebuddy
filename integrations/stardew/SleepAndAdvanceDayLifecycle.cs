using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
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

    private readonly int minimumOnlineFarmers;

    private readonly IMonitor monitor;
    private readonly string evidencePath;
    private readonly int settleFrameBudget;
    private readonly int readyBarrierFrameBudget;
    private readonly Func<DateTimeOffset> clock;
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
    private int ticks;
    private int dayBefore;
    private int daysBefore;
    private bool dayBaselineCaptured;
    private bool multiPlayer;
    private bool savedObserved;
    private bool savingObserved;
    private bool dayStartedObserved;
    private bool readyCheckObserved;
    private int readyAtCompletion;
    private int requiredAtCompletion;
    private bool finished;

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
        Func<DateTimeOffset> clock)
    {
        this.monitor = monitor;
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
    internal static SleepAndAdvanceDayLifecycle? TryStart(
        IMonitor monitor,
        SleepAndAdvanceDayLifecycleConfig? config,
        Func<DateTimeOffset>? clock = null)
    {
        if (config is not { IsValid: true })
            return null;
        var lifecycle = new SleepAndAdvanceDayLifecycle(monitor, config, clock ?? (() => DateTimeOffset.UtcNow));
        monitor.Log(
            $"GameBuddy sleep lifecycle started; evidence='{config.EvidencePath}'; "
                + $"settleBudget={lifecycle.settleFrameBudget}; readyBarrierBudget={lifecycle.readyBarrierFrameBudget}.",
            LogLevel.Info);
        return lifecycle;
    }

    /// <summary>The native event edges this lifecycle consumes, forwarded by ModEntry.</summary>
    internal void ObserveSaved()
    {
        this.savedObserved = true;
    }

    internal void ObserveDayStarted()
    {
        this.dayStartedObserved = true;
    }

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
            this.monitor.Log($"GameBuddy sleep lifecycle still in {this.phase} (topology={this.Topology()}).", LogLevel.Info);
        return terminal;
    }

    private bool Step()
    {
        switch (this.phase)
        {
            case Phase.AwaitingEligibility:
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
        this.monitor.Log(
            "GameBuddy sleep lifecycle yielded to the native pass-out path; the lifecycle will only observe from here.",
            LogLevel.Info);
        this.phase = Phase.AwaitingPassOutPipeline;
        return true;
    }

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
    }

    /// <summary>
    /// Return true once the actor is standing on the bed tile, so the game
    /// itself raises the Sleep touch action.
    /// </summary>
    private bool WalkToBed()
    {
        if (Game1.player.currentLocation is not FarmHouse farmHouse)
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
            // The native path finder is the same route the game's own villagers
            // use; it is not input injection.
            var controller = new PathFindController(Game1.player, farmHouse, bedSpot, Game1.player.FacingDirection);
            Game1.player.controller = controller;
            this.installedController = controller;
            this.arrivalDispatched = true;
            this.trace.Add($"pathfind_to_bed_tile:{bedSpot.X},{bedSpot.Y}");
            return false;
        }

        if (this.ticks % 30 == 0 && this.trace.Count < 64)
            this.trace.Add(
                $"en_route;tile={Game1.player.Tile.X},{Game1.player.Tile.Y};target={bedSpot.X},{bedSpot.Y};"
                    + $"controller={(Game1.player.controller?.GetType().Name ?? "none")}");
        return false;
    }

    /// <summary>
    /// Answer the game-owned Sleep question exactly the way the native
    /// keyboard/mouse paths do, then wait for the outro to settle.
    ///
    /// The question itself exists in EVERY topology (GameLocation.cs:3763-3765).
    /// In multiplayer the native answer path immediately replaces it with the
    /// ReadyCheckDialog, so the ready barrier is observed next rather than here.
    /// </summary>
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

        if (this.savedObserved)
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
        // arrives over the network. Neither is required to finish, but both are
        // reported.
        if (Game1.game1.IsSaving)
            return false;

        if (delta == 0)
            return false;

        if (delta != 1)
        {
            // A +2 jump means a second rollover was triggered (e.g. an overnight
            // event that also calls NewDay). That is not one bounded lifecycle.
            this.Finish("blocked", $"unexpected_day_delta:{delta}", null);
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
            ["savedObserved"] = this.savedObserved,
            ["dayStartedObserved"] = this.dayStartedObserved,
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

    private void Finish(string state, string reasonCode, Dictionary<string, object?>? settlement)
    {
        if (this.finished)
            return;
        this.finished = true;

        var evidence = new Dictionary<string, object?>
        {
            ["schema"] = Schema,
            ["state"] = state,
            ["reasonCode"] = reasonCode,
            ["topology"] = this.Topology(),
            ["targetVersion"] = new Dictionary<string, object?> { ["game"] = Game1.version },
            ["settlement"] = settlement,
            ["trace"] = this.trace.ToArray(),
            ["eventChain"] = this.multiPlayer
                ? new object[]
                {
                    "eligibility",
                    "pathfind_to_bed_tile",
                    "native_sleep_touch_action",
                    "game_owned_ready_check_dialog",
                    "native_ready_barrier",
                    "saving",
                    "saved",
                    "day_started",
                }
                : new object[]
                {
                    "eligibility",
                    "pathfind_to_bed_tile",
                    "native_sleep_touch_action",
                    "game_owned_dialogue_box",
                    "answerDialogue(Yes)+beginOutro",
                    "modality_settled",
                    "saving",
                    "saved",
                    "day_started",
                },
        };

        try
        {
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
        && Path.IsPathFullyQualified(this.EvidencePath)
        && this.TimeoutSeconds is >= 10 and <= 3600
        && this.SettleFrameBudget is >= 1 and <= 600
        && this.ReadyBarrierFrameBudget is >= 1 and <= 36000
        && this.MinimumOnlineFarmers is >= 1 and <= 8;
}
