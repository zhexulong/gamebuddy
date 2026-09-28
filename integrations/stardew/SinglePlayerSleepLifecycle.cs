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
/// The M2 cross-day lifecycle capability (<c>single_player_sleep_and_advance_day</c>,
/// catalog coordinationContract <c>host_save</c>).
///
/// This is deliberately NOT a wire action: the Agent does not submit an execution
/// request and does not receive an action receipt. It is a bounded, typed
/// lifecycle that starts from a legal live sleep-eligible state, drives the
/// native sleep answer exactly the way the native keyboard/mouse paths do (the
/// two public steps settled by <see cref="SleepModalProbe"/>), and then observes
/// the native <c>Saving → Saved → DayStarted</c> pipeline. Every claim is read
/// from native facts; nothing is mirrored and no day is advanced by hand.
///
/// Single-player only. The shared-world ready barrier is a different mechanism
/// (ReadySynchronizer / ReadyCheckDialog) and is out of scope here.
/// </summary>
internal sealed class SinglePlayerSleepLifecycle
{
    private const string Schema = "gamebuddy-sleep-lifecycle/v1";
    private static readonly JsonSerializerOptions EvidenceJsonOptions = new() { WriteIndented = true };
    private const int OutroSettleFrameBudget = 240;

    private readonly IMonitor monitor;
    private readonly string evidencePath;
    private readonly int settleFrameBudget;
    private readonly Func<DateTimeOffset> clock;
    private readonly DateTimeOffset deadline;
    private readonly List<string> trace = new();

    private Phase phase = Phase.AwaitingEligibility;
    private bool arrivalDispatched;
    private bool answerDispatched;
    private int settleFrames;
    private int ticks;
    private int dayBefore;
    private int daysBefore;
    private bool savedObserved;
    private bool dayStartedObserved;
    private bool finished;

    private enum Phase
    {
        AwaitingEligibility,
        WalkingToBed,
        AwaitingModal,
        AwaitingSettlement,
        AwaitingSave,
        AwaitingDayStart,
    }

    private SinglePlayerSleepLifecycle(IMonitor monitor, SinglePlayerSleepLifecycleConfig config, Func<DateTimeOffset> clock)
    {
        this.monitor = monitor;
        this.evidencePath = config.EvidencePath;
        this.settleFrameBudget = Math.Clamp(config.SettleFrameBudget, 1, 600);
        this.clock = clock;
        this.deadline = clock().AddSeconds(Math.Clamp(config.TimeoutSeconds, 10, 600));
    }

    /// <summary>Fail-closed construction: an invalid config starts nothing.</summary>
    internal static SinglePlayerSleepLifecycle? TryStart(
        IMonitor monitor,
        SinglePlayerSleepLifecycleConfig? config,
        Func<DateTimeOffset>? clock = null)
    {
        if (config is not { IsValid: true })
            return null;
        var lifecycle = new SinglePlayerSleepLifecycle(monitor, config, clock ?? (() => DateTimeOffset.UtcNow));
        monitor.Log(
            $"GameBuddy sleep lifecycle started; evidence='{config.EvidencePath}'; budget={lifecycle.settleFrameBudget}.",
            LogLevel.Info);
        return lifecycle;
    }

    /// <summary>The native event edges this lifecycle consumes, forwarded by ModEntry.</summary>
    internal void ObserveSaved() => this.savedObserved = true;

    internal void ObserveDayStarted()
    {
        this.dayStartedObserved = true;
        if (this.phase is Phase.AwaitingDayStart or Phase.AwaitingSave)
            this.phase = Phase.AwaitingDayStart;
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

        switch (this.phase)
        {
            case Phase.AwaitingEligibility:
                if (!this.TryEnterEligibility(out string eligibilityReason))
                    return false;
                this.trace.Add($"eligible={eligibilityReason}");
                this.phase = Phase.WalkingToBed;
                return false;

            case Phase.WalkingToBed:
                if (this.WalkToBed())
                    this.phase = Phase.AwaitingModal;
                return false;

            case Phase.AwaitingModal:
                if (Game1.activeClickableMenu is DialogueBox)
                {
                    this.trace.Add(
                        $"modal_observed;dialogueUp={Game1.dialogueUp};canMove={Game1.player.CanMove};"
                            + $"hasMoved={Game1.player.hasMoved};isInBed={Game1.player.isInBed.Value}");
                    this.phase = Phase.AwaitingSettlement;
                }
                return false;

            case Phase.AwaitingSettlement:
                if (!this.answerDispatched)
                {
                    this.AnswerSleep();
                    return false;
                }
                this.settleFrames++;
                if (this.IsModalSettled())
                {
                    this.trace.Add($"modal_settled;frames={this.settleFrames}");
                    this.phase = Phase.AwaitingSave;
                    return false;
                }
                if (this.settleFrames >= this.settleFrameBudget)
                {
                    this.trace.Add($"modal_settlement_budget_exhausted;frames={this.settleFrames}");
                    this.Finish("blocked", "modal_not_settled", null);
                    return true;
                }
                return false;

            case Phase.AwaitingSave:
                // The native end-of-night pipeline runs Saving then Saved; the
                // lifecycle only observes it, it never triggers a save itself.
                if (!this.savedObserved && !Game1.game1.IsSaving)
                    return false;
                if (Game1.game1.IsSaving)
                    this.trace.Add("saving_observed");
                if (this.savedObserved)
                    this.trace.Add("saved_observed");
                this.phase = Phase.AwaitingDayStart;
                return false;

            case Phase.AwaitingDayStart:
                return this.EvaluateDayStart();
        }

        return false;
    }

    private bool TryEnterEligibility(out string reason)
    {
        reason = "ok";
        // Mirrors the native bed-interaction gate (GameLocation.cs:3763) and the
        // NewDay preconditions (Game1.cs:9926). Single-player only.
        if (Game1.IsMultiplayer) { reason = "multiplayer"; return false; }
        if (Game1.newDay) { reason = "already_new_day"; return false; }
        if (!Game1.shouldTimePass()) { reason = "time_paused"; return false; }
        if (Game1.player.passedOut) { reason = "passed_out"; return false; }
        if (Game1.activeClickableMenu is not null) { reason = "menu_open"; return false; }
        if (Game1.dialogueUp) { reason = "dialogue_up"; return false; }
        if (Game1.eventUp) { reason = "event_up"; return false; }
        if (Game1.currentLocation is not FarmHouse) { reason = "not_farmhouse"; return false; }
        return true;
    }

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

    private void AnswerSleep()
    {
        if (Game1.activeClickableMenu is not DialogueBox dialogueBox)
        {
            this.Finish("blocked", "dialogue_not_present_at_answer", null);
            return;
        }

        Response? yes = dialogueBox.responses?.FirstOrDefault(
                response => string.Equals(response.responseKey, "Yes", StringComparison.Ordinal))
            ?? Game1.questionChoices?.FirstOrDefault(
                response => string.Equals(response.responseKey, "Yes", StringComparison.Ordinal));
        if (yes is null)
        {
            this.Finish("blocked", "yes_choice_missing", null);
            return;
        }

        // Capture the pre-advance baseline BEFORE answering: in single player
        // the native answer path (answerDialogueAction("Sleep_Yes") → startSleep
        // → doSleep → Game1.NewDay) advances the day, so a baseline read after
        // the modal settles may already be the new day.
        this.dayBefore = Game1.Date.TotalDays;
        this.daysBefore = (int)Game1.stats.DaysPlayed;

        // The exact two public steps the native input paths use, in order.
        GameLocation location = Game1.currentLocation;
        bool answered = location.answerDialogue(yes);
        dialogueBox.beginOutro();
        this.answerDispatched = true;
        this.trace.Add($"answered={answered};answered_via=answerDialogue;outro=beginOutro;day_before={this.dayBefore}");
        this.monitor.Log($"GameBuddy sleep lifecycle answered the native Sleep prompt; answered={answered}.", LogLevel.Info);
    }

    private bool IsModalSettled() =>
        Game1.activeClickableMenu is null && !Game1.dialogueUp && Game1.player.CanMove;

    private bool EvaluateDayStart()
    {
        int dayAfter = Game1.Date.TotalDays;
        int daysAfter = (int)Game1.stats.DaysPlayed;
        int delta = dayAfter - this.dayBefore;

        if (Game1.game1.IsSaving)
            return false;

        if (delta == 0)
            return false;

        bool advanceObserved = this.dayStartedObserved || delta == 1;
        if (delta != 1)
        {
            // A +2 jump means a second rollover was triggered (e.g. an overnight
            // event that also calls NewDay). That is not one bounded lifecycle.
            this.Finish("blocked", $"unexpected_day_delta:{delta}", null);
            return true;
        }
        if (!advanceObserved)
        {
            this.Finish("blocked", "day_advanced_without_day_started", null);
            return true;
        }

        var settlement = new Dictionary<string, object?>
        {
            ["dayBefore"] = this.dayBefore,
            ["dayAfter"] = dayAfter,
            ["daysPlayedBefore"] = this.daysBefore,
            ["daysPlayedAfter"] = daysAfter,
            ["savingObserved"] = true,
            ["savedObserved"] = this.savedObserved,
            ["dayStartedObserved"] = this.dayStartedObserved,
        };
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
            ["topology"] = "native_local_player_fixture",
            ["targetVersion"] = new Dictionary<string, object?> { ["game"] = Game1.version },
            ["settlement"] = settlement,
            ["trace"] = this.trace.ToArray(),
            ["eventChain"] = new[]
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
/// Opt-in, evidence-only configuration for <see cref="SinglePlayerSleepLifecycle"/>.
/// It is never part of a user profile.
/// </summary>
public sealed class SinglePlayerSleepLifecycleConfig
{
    public bool Enable { get; init; }
    public string EvidencePath { get; init; } = string.Empty;
    public int TimeoutSeconds { get; init; } = 120;
    public int SettleFrameBudget { get; init; } = 240;

    internal bool IsValid => this.Enable
        && Path.IsPathFullyQualified(this.EvidencePath)
        && this.TimeoutSeconds is >= 10 and <= 600
        && this.SettleFrameBudget is >= 1 and <= 600;
}
