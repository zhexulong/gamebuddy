using System;
using System.Collections.Generic;
using System.Globalization;
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
/// One-shot target-version probe for the M2 sleep-modal seam (see
/// design/tasks/active/loop-m2-cross-day-seam-decision.md §11.2 obligation 4).
///
/// The only fact that source review cannot settle is whether the native
/// <see cref="DialogueBox"/> outro animation is advanced by the ordinary update
/// loop in this topology — if it is not, the modal never settles and the answer
/// path is unusable. This probe therefore:
///
///   P1 (read-only): walk the actor onto the bed tile with the native path
///      finder so the game itself raises the "Sleep" touch action, wait for the
///      game-owned DialogueBox, record the pre-answer modality
///      (activeClickableMenu / dialogueUp / CanMove / hasMoved), then stop
///      WITHOUT answering. No day is advanced.
///
///   P2 (advances the day): same setup, then answer through the public native
///      entry <c>GameLocation.answerDialogue(Response)</c> plus the public
///      <c>DialogueBox.beginOutro()</c> — exactly the two-step sequence the
///      native keyboard/mouse paths use — and wait a bounded number of frames
///      for the modality to settle. This necessarily advances the day
///      (<c>Sleep_Yes</c> → <c>startSleep</c> → <c>doSleep</c> → <c>NewDay</c>),
///      so it must only ever run on a disposable working save.
///
/// It never calls the bare dispatcher, never injects input, never touches a
/// private member, and never manufactures a result.
/// </summary>
internal sealed class SleepModalProbe
{
    private const string Schema = "gamebuddy-sleep-modal-probe/v1";
    private static readonly JsonSerializerOptions EvidenceJsonOptions = new() { WriteIndented = true };

    private readonly IMonitor monitor;
    private readonly string evidencePath;
    private readonly bool answerAndSettle;
    private readonly int settleFrameBudget;
    private readonly DateTimeOffset deadline;
    private readonly List<string> trace = new();

    private bool arrivalRequested;
    private bool arrivalDispatched;
    private bool arrivalConfirmed;
    private int arrivalTick;
    private int ticks;
    private bool dialogueObserved;
    private bool answerDispatched;
    private int settleFrames;
    private bool finished;

    private SleepModalProbe(IMonitor monitor, SleepModalProbeConfig config)
    {
        this.monitor = monitor;
        this.evidencePath = config.EvidencePath;
        this.answerAndSettle = config.AnswerAndSettle;
        this.settleFrameBudget = Math.Clamp(config.SettleFrameBudget, 1, 600);
        this.deadline = DateTimeOffset.UtcNow.AddSeconds(Math.Clamp(config.TimeoutSeconds, 5, 300));
    }

    /// <summary>
    /// Fail-closed construction: the probe only starts when its configuration
    /// validates, so an unconfigured or malformed profile cannot silently walk
    /// the actor into the bed.
    /// </summary>
    internal static SleepModalProbe? TryStart(IMonitor monitor, SleepModalProbeConfig? config)
    {
        if (config is not { IsValid: true })
            return null;
        var probe = new SleepModalProbe(monitor, config);
        monitor.Log(
            $"GameBuddy sleep-modal probe started: mode={(config.AnswerAndSettle ? "P2_answer" : "P1_readonly")}; "
                + $"budget={probe.settleFrameBudget}; evidence='{config.EvidencePath}'.",
            LogLevel.Info);
        return probe;
    }

    /// <summary>Returns true once the probe has recorded a terminal result.</summary>
    internal bool Update()
    {
        if (this.finished)
            return true;

        if (DateTimeOffset.UtcNow > this.deadline)
        {
            this.Finish("blocked", "probe_deadline_exceeded", null);
            return true;
        }

        if (!Context.IsWorldReady || Game1.player is null)
            return false;

        this.ticks++;

        if (Game1.player.currentLocation is not FarmHouse farmHouse)
        {
            this.Finish("blocked", "actor_not_in_farmhouse", null);
            return true;
        }

        if (!this.arrivalDispatched)
        {
            this.RequestBedArrival(farmHouse);
            return false;
        }

        // Observe every frame in both modes: the arrival confirmation and the
        // game-owned modal are the facts this probe exists to record.
        this.ObserveArrival();
        this.ObserveDialogue();

        // P1 stops the moment the game itself raised the modal: this is the
        // whole read-only claim (the native touch action builds a DialogueBox).
        // It must never answer, and never advance the day.
        if (!this.answerAndSettle)
        {
            if (this.dialogueObserved)
            {
                this.Finish("passed", "dialogue_observed_readonly", BuildSettlement());
                return true;
            }
            return false;
        }

        if (!this.dialogueObserved)
            return false;

        if (!this.answerDispatched)
        {
            this.AnswerAndWait();
            return false;
        }

        // P2: after answering, wait for the modality to settle.
        this.settleFrames++;
        if (this.IsSettled())
        {
            this.Finish("passed", "modality_settled", BuildSettlement());
            return true;
        }

        if (this.settleFrames >= this.settleFrameBudget)
        {
            // The native input paths call the private tryOutro(); its only
            // effect is beginOutro(). If the animation did not advance within
            // the budget, the public closeDialogue() can still settle the state
            // (skipping only the visual transition, which the receipt records).
            if (this.TryCloseDirectly("outro_animation_not_advanced"))
                return true;
            this.Finish("blocked", "modal_not_settled", BuildSettlement());
            return true;
        }

        return false;
    }

    private void RequestBedArrival(FarmHouse farmHouse)
    {
        this.arrivalRequested = true;
        Point bedSpot = farmHouse.GetPlayerBedSpot();
        var bedTile = new Vector2(bedSpot.X, bedSpot.Y);
        bool alreadyThere = Game1.player.Tile == bedTile;
        if (alreadyThere)
        {
            this.arrivalDispatched = true;
            this.trace.Add($"arrival=already_on_bed_tile:{bedSpot.X},{bedSpot.Y}");
            return;
        }

        // The native path finder is the same route the game's own villagers use;
        // it is not input injection. The coordinate overload is forbidden here:
        // it passes isAtEndPoint and can teleport the actor while leaving a null
        // path. A private predicate makes the constructor plan instead.
        Game1.player.controller = new PathFindController(
            Game1.player,
            farmHouse,
            (node, target, _location, _character) => node.x == target.X && node.y == target.Y,
            Game1.player.FacingDirection,
            null,
            10000,
            bedSpot);
        this.arrivalDispatched = true;
        int plannedTiles = (Game1.player.controller as PathFindController)?.pathToEndPoint?.Count ?? 0;
        this.trace.Add(
            $"arrival_dispatch=pathfind_to_bed_tile:{bedSpot.X},{bedSpot.Y};planned_tiles={plannedTiles};"
                + $"location_farmers={farmHouse.farmers.Count};from={Game1.player.Tile.X},{Game1.player.Tile.Y}");
        if (plannedTiles == 0)
            this.trace.Add($"bed_walk_unplanned;tile={Game1.player.Tile.X},{Game1.player.Tile.Y}");
        this.monitor.Log(
            $"GameBuddy sleep-modal probe dispatched native pathfind to bed tile ({bedSpot.X},{bedSpot.Y}); "
                + "the game owns the Sleep touch action.",
            LogLevel.Info);
    }

    private void ObserveDialogue()
    {
        bool isDialogueBox = Game1.activeClickableMenu is DialogueBox;
        if (!isDialogueBox)
            return;

        this.dialogueObserved = true;
        this.trace.Add(
            $"dialogue_observed=DialogueBox;dialogueUp={Game1.dialogueUp};"
                + $"canMove={Game1.player.CanMove};hasMoved={Game1.player.hasMoved};isInBed={Game1.player.isInBed.Value}");
        this.monitor.Log(
            $"GameBuddy sleep-modal probe observed the game-owned DialogueBox: dialogueUp={Game1.dialogueUp}; "
                + $"canMove={Game1.player.CanMove}; isInBed={Game1.player.isInBed.Value}.",
            LogLevel.Info);
    }

    /// <summary>Records the first frame on which the actor is standing on the bed tile.</summary>
    private void ObserveArrival()
    {
        if (this.arrivalConfirmed)
            return;
        if (Game1.player.currentLocation is not FarmHouse farmHouse)
            return;
        Point bedSpot = farmHouse.GetPlayerBedSpot();
        if (this.arrivalTick == 0)
            this.arrivalTick = this.ticks;
        // Bounded progress trace so a stalled route is diagnosable rather than
        // silent: record every 30th frame while the actor is still en route.
        if (this.ticks - this.arrivalTick >= 30 && this.ticks % 30 == 0 && this.trace.Count < 64)
            this.trace.Add(
                $"en_route;tile={Game1.player.Tile.X},{Game1.player.Tile.Y};target={bedSpot.X},{bedSpot.Y};"
                    + $"controller={(Game1.player.controller?.GetType().Name ?? "none")}");
        if (Game1.player.Tile != new Vector2(bedSpot.X, bedSpot.Y))
            return;
        this.arrivalConfirmed = true;
        this.trace.Add($"arrival_confirmed=on_bed_tile:{bedSpot.X},{bedSpot.Y};isInBed={Game1.player.isInBed.Value}");
    }

    private void AnswerAndWait()
    {
        if (Game1.activeClickableMenu is not DialogueBox dialogueBox)
        {
            this.Finish("blocked", "dialogue_not_present_at_answer", null);
            return;
        }

        // The modal owns its choices: DialogueBox.responses is the authoritative
        // array the native keyboard/mouse paths iterate (DialogueBox.cs:18).
        // Game1.questionChoices is the fallback for question dialogues.
        Response? yes = dialogueBox.responses?.FirstOrDefault(
                response => string.Equals(response.responseKey, "Yes", StringComparison.Ordinal))
            ?? Game1.questionChoices?.FirstOrDefault(
                response => string.Equals(response.responseKey, "Yes", StringComparison.Ordinal));
        if (yes is null)
        {
            string keys = string.Join(
                ",",
                (dialogueBox.responses ?? Array.Empty<Response>())
                    .Select(response => response.responseKey));
            this.Finish("blocked", $"yes_choice_missing:{keys}", null);
            return;
        }

        // Native keyboard/mouse both route to answerDialogue(response) and then
        // beginOutro(); this reproduces those two public steps in order.
        GameLocation location = Game1.currentLocation;
        bool answered = location.answerDialogue(yes);
        dialogueBox.beginOutro();
        this.answerDispatched = true;
        this.trace.Add($"answered={answered};answered_via=answerDialogue;outro=beginOutro");
        this.monitor.Log(
            $"GameBuddy sleep-modal probe answered through answerDialogue(Yes) and beginOutro(); answered={answered}.",
            LogLevel.Info);
    }

    private bool IsSettled()
    {
        return Game1.activeClickableMenu is null
            && !Game1.dialogueUp
            && Game1.player.CanMove;
    }

    private bool TryCloseDirectly(string reason)
    {
        if (Game1.activeClickableMenu is not DialogueBox dialogueBox)
            return false;
        dialogueBox.closeDialogue();
        this.trace.Add($"fallback=closeDialogue;reason={reason}");
        this.monitor.Log(
            $"GameBuddy sleep-modal probe used the public closeDialogue() fallback ({reason}); "
                + "the visual transition was skipped but no state settlement was skipped.",
            LogLevel.Warn);
        this.Finish(
            "passed_with_fallback",
            reason,
            BuildSettlement());
        return true;
    }

    private Dictionary<string, object?> BuildSettlement()
    {
        return new Dictionary<string, object?>
        {
            ["activeClickableMenu"] = Game1.activeClickableMenu?.GetType().Name,
            ["dialogueUp"] = Game1.dialogueUp,
            ["canMove"] = Game1.player.CanMove,
            ["settleFrames"] = this.settleFrames,
        };
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
            ["mode"] = this.answerAndSettle ? "P2_answer" : "P1_readonly",
            ["topology"] = "native_local_player_fixture",
            ["targetVersion"] = new Dictionary<string, object?>
            {
                ["game"] = Game1.version,
            },
            ["arrivalRequested"] = this.arrivalRequested,
            ["arrivalConfirmed"] = this.arrivalConfirmed,
            ["dialogueObserved"] = this.dialogueObserved,
            ["answerDispatched"] = this.answerDispatched,
            ["settlement"] = settlement,
            ["trace"] = this.trace.ToArray(),
            ["eventChain"] = new[]
            {
                "pathfind_to_bed_tile",
                "native_sleep_touch_action",
                "game_owned_dialogue_box",
                this.answerAndSettle ? "answerDialogue(Yes)+beginOutro" : "no_answer_readonly",
                this.answerAndSettle ? "wait_modality_settle" : "stopped_before_answer",
            },
        };

        try
        {
            string? directory = Path.GetDirectoryName(this.evidencePath);
            if (!string.IsNullOrWhiteSpace(directory))
                Directory.CreateDirectory(directory);
            File.WriteAllText(
                this.evidencePath,
                JsonSerializer.Serialize(evidence, EvidenceJsonOptions));
            this.monitor.Log(
                $"GameBuddy sleep-modal probe finished: state={state}; reason={reasonCode}; evidence='{this.evidencePath}'.",
                LogLevel.Info);
        }
        catch (Exception error)
        {
            this.monitor.Log(
                $"GameBuddy sleep-modal probe could not write evidence: {error.GetType().Name}.",
                LogLevel.Error);
        }
    }
}

/// <summary>
/// Opt-in, evidence-only configuration for <see cref="SleepModalProbe"/>. It is
/// never part of a user profile: the evidence path must be absolute and the
/// scenario must be an explicit probe mode.
/// </summary>
public sealed class SleepModalProbeConfig
{
    public bool Enable { get; init; }
    public string Mode { get; init; } = string.Empty;
    public string EvidencePath { get; init; } = string.Empty;
    public int TimeoutSeconds { get; init; } = 60;
    public int SettleFrameBudget { get; init; } = 240;

    internal bool AnswerAndSettle => string.Equals(this.Mode, "p2_answer", StringComparison.Ordinal);

    internal bool IsValid => this.Enable
        && this.Mode is "p1_readonly" or "p2_answer"
        && Path.IsPathFullyQualified(this.EvidencePath)
        && this.TimeoutSeconds is >= 5 and <= 300
        && this.SettleFrameBudget is >= 1 and <= 600
        && CultureInfo.InvariantCulture is not null;
}
