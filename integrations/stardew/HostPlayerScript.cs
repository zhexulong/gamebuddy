using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Objects;
using StardewValley.Pathfinding;

namespace GameBuddy.Stardew;

/// <summary>One instruction the fixture gives the Host player, in the closed set this channel can perform.</summary>
internal enum HostPlayerScriptStepKind
{
    /// <summary>Walk to a tile (or to any tile beside it) on a named map.</summary>
    WalkToTile,

    /// <summary>Raise one emote balloon from the engine's closed emote set.</summary>
    Emote,

    /// <summary>Take one item out of a published container through the native chest data path.</summary>
    ChestTake,

    /// <summary>Say one line into the lobby's own chat egress.</summary>
    Say,
}

/// <summary>
/// One parsed instruction. <see cref="Seq"/> is the step's place in the document and the whole of its identity: the
/// channel's cursor is a position, so one position performed twice is the same step performed twice. <see cref="Argument"/>
/// is the emote name, the chat line, or a container's published id followed by the item it is expected to hold
/// (<c>targetRef|expectedQualifiedItemId</c>), so a step carries exactly one payload and no step has two spellings of its
/// own. A value record on purpose: "the same step" is one comparison, which is what lets an adopted step be re-checked
/// against the document that grew behind it.
/// </summary>
internal sealed record HostPlayerScriptStep(
    int Seq,
    string StepId,
    HostPlayerScriptStepKind Kind,
    string Location,
    int X,
    int Y,
    bool Nearby,
    string Argument);

/// <summary>
/// One read of the armed document: the steps it holds in <c>seq</c> order, and whether the fixture has finished
/// appending. A sealed document ends the channel once its last step settles; an open one whose steps have all settled is
/// a wait for the next slice's steps.
/// </summary>
internal sealed record HostPlayerScriptDocument(IReadOnlyList<HostPlayerScriptStep> Steps, bool Sealed);

/// <summary>
/// THE HOST PLAYER'S SCRIPT CHANNEL: the fixture telling the Host player what to do, and nothing more.
///
/// <para>
/// WHY THIS IS NOT A SECOND BRIDGE. The Mod builds a <c>LocalPipeBridge</c> only on the AI-Farmhand instance
/// (<c>ModEntry.cs</c> returns early when <c>hostRoleConfigured</c>) and that one bridge admits a single consumer, so on
/// the Player Host topology the Host player has no wire at all. This channel adds no socket, no frame, no consumer and
/// no request/response: it is the same kind of act the cross-day lifecycle already performs on the same body. A file
/// arms what the Host player should do (<c>ScriptPath</c>), the game thread performs it on <c>Game1.player</c> through
/// the engine's own native entries, and a file reports what happened (<c>RecordsPath</c>). Nothing here mints a product
/// receipt, admits an execution, or pretends the Host player is an agent: a record is a fixture observation, and every
/// action a companion dispatches still travels the one wire.
/// </para>
///
/// <para>
/// WHY FILES AND NOT A DIRECT CALL. The harness that wants the Host player to move runs in the AI-client process. The
/// only channels between the two processes are files and the bridge, and the bridge is the companion's. The arm is
/// modelled on <see cref="SleepAndAdvanceDayLifecycle"/> for the same reason: an opt-in absolute path in the Mod's
/// config, read and written on the game thread, never a user profile.
/// </para>
///
/// <para>
/// WHAT S2 PROVED IMPOSSIBLE, AND WHAT REPLACED IT. This channel first read ONE file once and finished forever, which
/// made the second slice of a paired run unmeasurable: S2 wrote its <c>[walk, chest]</c> onto the same path where S1's
/// <c>[walk, emote, say]</c> had already been adopted, nothing read it again, and the slice reported
/// <c>not_measured: one_side_never_dispatched</c> about a fixture that had in fact been armed. So the document is a
/// SEQUENCE the fixture appends to: every step carries its own 1-based <c>seq</c>, the channel keeps a cursor over the
/// steps it has adopted, and a step is new exactly when its <c>seq</c> is past that cursor - never because "the file
/// changed". <c>sealed</c> is the fixture saying it will append no more, and it is the only quiet way this channel ends:
/// an OPEN document whose steps have all settled is a wait for the next slice.
/// </para>
///
/// <para>
/// A STEP IS PERFORMED EXACTLY ONCE, and the cursor is the whole of it - the same invariant that keeps a night from
/// being crossed twice. Adoption is append-only and CHECKED: the steps already adopted must still be the document's own
/// first steps, so a document that dropped one, renumbered one or rewrote one under the cursor is refused by name rather
/// than re-performed. The Mod arms one channel per session and never re-arms it after it finishes, because a fresh
/// channel reads from step one.
/// </para>
///
/// <para>
/// WHAT IT REFUSES TO DO. Every step settled is a NAMED outcome, and a step that cannot be performed stops the script
/// rather than being skipped: a run whose "the player walked over and waved" fact silently did not happen would judge
/// the companion against a cue that was never given. The channel also pre-satisfies nothing - it never moves the
/// companion, never harvests, and never opens a container on her behalf.
/// </para>
///
/// <para>
/// WHERE EACH STEP BECOMES A FACT THE COMPANION CAN READ - a step is not a cue until something publishes it, so each verb
/// names the publisher on her side rather than the thing this process did:
/// <list type="bullet">
/// <item><c>walk_to_tile</c> becomes <c>otherFarmers[].location</c>/<c>x</c>/<c>y</c>: <c>DiscoverOtherFarmers</c> reads
/// <c>Game1.otherFarmers</c> on HER client, bounded to her own map and the family's discovery radius, so a player across
/// the farm is published as one <c>otherFarmersOmitted</c> rather than as nobody.</item>
/// <item><c>emote</c> becomes <c>otherFarmers[].doing = "emoting"</c>, because
/// <c>FarmhandTargetDiscovery.DescribeOtherFarmerDoing</c> reads <c>isEmoting</c> - and that field exists on her copy of
/// the Host's Farmer only if the balloon travelled the network. <see cref="PerformEmote"/> therefore raises it through
/// the engine's player-emote entry, not the local animation arm.</item>
/// <item><c>say</c> becomes the lobby's own chat line, and her client's reception of it is the Mod's <c>multiplayer_chat</c>
/// world fact (<see cref="MultiplayerChatReception"/>): the line is published from
/// <c>Multiplayer.receiveChatMessage</c> on HER machine, where another player's words actually arrive, and the prompt
/// renders it as a fact naming the speaker and the words.</item>
/// <item><c>chest_take</c> becomes the container's own state: the row she reads afterwards is the chest's contents, and
/// the step takes the same <c>Chest.GetMutex()</c> lock the product's container actions take, so the two farmers contend
/// rather than race.</item>
/// </list>
/// </para>
/// </summary>
internal sealed class HostPlayerScriptChannel
{
    internal const string Schema = "gamebuddy-host-player-script/v2";

    /// <summary>
    /// Frames between re-reads of the document. The channel is pumped once per tick and the fixture appends a handful of
    /// steps per slice, so a read on every frame would be sixty reads a second of a file that changed once.
    /// </summary>
    private const int ReloadIntervalFrames = 15;

    /// <summary>The four actions a script may name; a fifth is a different protocol, not a step this file guesses at.</summary>
    private const string WalkStep = "walk_to_tile";
    private const string EmoteStep = "emote";
    private const string ChestStep = "chest_take";
    private const string SayStep = "say";

    /// <summary>
    /// The walk's node budget. The cross-day bed search spends the engine settler walk's own 10000
    /// (<c>PathFindController.cs:62</c>); a farm errand is the same order of search, so the same bound is spent here
    /// rather than a second tuned number.
    /// </summary>
    private const int WalkNodeBudget = 10000;

    private readonly IMonitor monitor;
    private readonly string scriptPath;
    private readonly string recordsPath;
    private readonly TimeSpan stepBudget;
    private readonly List<HostPlayerScriptStep> steps = new();

    private bool finished;
    private bool sealedDocument;
    private string? lastWaitReason;
    private string? stopReason;

    /// <summary>
    /// The next step to perform, and the number of steps settled. It advances only in <see cref="Settle"/>, so a step is
    /// performed exactly once however often the document is re-read.
    /// </summary>
    private int stepIndex;

    /// <summary>Starts at the interval so the first tick reads the document instead of waiting for one.</summary>
    private int framesSinceReload = ReloadIntervalFrames;

    /// <summary>When the current step's budget runs out; null while no step is current, which is a wait for more steps.</summary>
    private DateTimeOffset? stepDeadline;

    /// <summary>
    /// The steps this channel adopted, in the order it performs them. Read by the adoption test, which asserts that a
    /// second read of the same document adopts nothing and that a document rewritten under the cursor is refused.
    /// </summary>
    internal IReadOnlyList<HostPlayerScriptStep> LoadedSteps => this.steps;

    /// <summary>
    /// Why this channel stopped, or null while it is running. The records file is the trace a run is judged from, but a
    /// refused step on a world that cannot write one - the headless adoption test, where there is no calendar to stamp a
    /// record with - still has to be answerable by name rather than by silence.
    /// </summary>
    internal string? StopReason => this.stopReason;

    /// <summary>The plan installed on this tick's map; cleared when the map changes under it (a warp leg).</summary>
    private PathFindController? controller;
    private string? controllerLocation;
    private int candidateIndex;
    private Vector2[] candidates = Array.Empty<Vector2>();

    internal HostPlayerScriptChannel(IMonitor monitor, HostPlayerScriptConfig config)
    {
        this.monitor = monitor;
        this.scriptPath = config.ScriptPath;
        this.recordsPath = config.RecordsPath;
        this.stepBudget = TimeSpan.FromSeconds(Math.Clamp(config.TimeoutSeconds, 10, 3600));
    }

    /// <summary>Start when the config asks for it; an invalid one starts nothing (the Mod refuses the profile instead).</summary>
    internal static HostPlayerScriptChannel? TryStart(IMonitor monitor, HostPlayerScriptConfig? config)
    {
        if (config is not { Enable: true, IsValid: true })
            return null;
        return new HostPlayerScriptChannel(monitor, config);
    }

    /// <summary>
    /// One frame of the channel: adopt what the fixture has appended, then advance the current step. True once the
    /// document is sealed and drained, or the channel stopped on a named refusal: the caller may drop the handle.
    /// </summary>
    internal bool Update()
    {
        if (this.finished)
            return true;
        if (!Context.IsWorldReady || Game1.player is null)
            return false;
        try
        {
            if (this.framesSinceReload++ >= ReloadIntervalFrames)
            {
                this.framesSinceReload = 0;
                if (!this.TryAdoptNewSteps())
                    return this.finished;
            }
            if (this.stepIndex >= this.steps.Count)
            {
                // An OPEN document with nothing left to perform is S2 not having written its steps yet, so it is a
                // wait; a sealed one is the fixture saying it is done, which is where this channel ends quietly.
                if (this.sealedDocument)
                    this.Complete();
                return this.finished;
            }
            HostPlayerScriptStep step = this.steps[this.stepIndex];
            this.stepDeadline ??= DateTimeOffset.UtcNow.Add(this.stepBudget);
            if (DateTimeOffset.UtcNow > this.stepDeadline.Value)
            {
                this.Stop("script_deadline_exceeded", $"seq={step.Seq};steps_settled={this.stepIndex}/{this.steps.Count}");
                return true;
            }
            this.StepThrough(step);
            return this.finished;
        }
        catch (Exception error)
        {
            this.Stop("script_failed", $"exception={error.GetType().Name}");
            return true;
        }
    }

    /// <summary>
    /// Read the document and adopt the steps it holds beyond the ones already adopted. A missing file is not a failure
    /// yet - the harness writes it after the world is live and appends per slice - but an unreadable, unsequenced or
    /// behind-the-cursor document is terminal and named: a document that cannot be trusted must not look like one that
    /// has not been written.
    ///
    /// <para>
    /// APPEND-ONLY IS THE CONTRACT, and it is checked rather than assumed. The steps already adopted must still be the
    /// document's own first steps - <see cref="HostPlayerScriptStep"/> is a value record, so "the same step" is one
    /// comparison - and only what follows them is new. A document that dropped a step, renumbered one, or rewrote one
    /// under the cursor would make "which steps have I performed" unanswerable, and the cursor alone would then happily
    /// perform a step whose payload changed beneath it; so it stops the script by name instead.
    /// </para>
    ///
    /// <para>
    /// Internal rather than private so both rules can be pinned headlessly, where there is no world and no game thread;
    /// <see cref="Update"/> is what decides WHEN to call it.
    /// </para>
    /// </summary>
    internal bool TryAdoptNewSteps()
    {
        if (this.sealedDocument)
            return true;
        if (!File.Exists(this.scriptPath))
            return true;
        string text;
        try
        {
            text = File.ReadAllText(this.scriptPath);
        }
        catch (Exception error)
        {
            this.Stop("script_unreadable", $"exception={error.GetType().Name}");
            return false;
        }
        if (!TryParseScript(text, out HostPlayerScriptDocument document, out string reasonCode, out string detail))
        {
            this.Stop(reasonCode, detail);
            return false;
        }
        if (document.Steps.Count < this.steps.Count)
        {
            this.Stop("script_rewritten_behind_the_cursor", $"adopted={this.steps.Count};document={document.Steps.Count}");
            return false;
        }
        for (int index = 0; index < this.steps.Count; index++)
        {
            if (!Equals(this.steps[index], document.Steps[index]))
            {
                this.Stop("script_step_rewritten", $"seq={this.steps[index].Seq};step={this.steps[index].StepId}");
                return false;
            }
        }
        int added = document.Steps.Count - this.steps.Count;
        if (added > 0)
        {
            int firstAdded = document.Steps[this.steps.Count].Seq;
            this.steps.AddRange(document.Steps.Skip(this.steps.Count));
            this.monitor.Log(
                $"GameBuddy HostPlayerScript adopted seq {firstAdded}..{document.Steps[document.Steps.Count - 1].Seq} "
                    + $"({added} new, {this.steps.Count} in the document) from '{this.scriptPath}'; records='{this.recordsPath}'.",
                LogLevel.Info);
        }
        if (document.Sealed)
            this.sealedDocument = true;
        return true;
    }

    /// <summary>End the channel on the document's own word: every step settled and the fixture will append no more.</summary>
    private void Complete()
    {
        this.WriteRecord(null, "script", "succeeded", "script_complete");
        this.finished = true;
    }

    /// <summary>
    /// The script's own protocol: one schema, one closed set of four actions, one position per step, and a named reason
    /// for anything else.
    ///
    /// <para>
    /// Pure and separate from the file read so the cross-process contract - the harness writes this text, this Mod
    /// performs it - can be pinned without a running game. The schema is checked, not assumed: a harness that wrote a
    /// different protocol must be refused by name rather than half-executed, and an action this file cannot perform must
    /// stop the script instead of being skipped.
    /// </para>
    /// </summary>
    internal static bool TryParseScript(
        string text,
        out HostPlayerScriptDocument document,
        out string reasonCode,
        out string detail)
    {
        document = new HostPlayerScriptDocument(Array.Empty<HostPlayerScriptStep>(), false);
        reasonCode = string.Empty;
        detail = string.Empty;
        JsonDocument parsed;
        try
        {
            parsed = JsonDocument.Parse(text);
        }
        catch (JsonException error)
        {
            reasonCode = "script_unreadable";
            detail = $"exception={error.GetType().Name}";
            return false;
        }

        using (parsed)
        {
            if (parsed.RootElement.ValueKind != JsonValueKind.Object
                || !parsed.RootElement.TryGetProperty("schema", out JsonElement schema)
                || !string.Equals(schema.GetString(), Schema, StringComparison.Ordinal))
            {
                reasonCode = "script_schema_unknown";
                detail = $"expected={Schema}";
                return false;
            }

            if (!parsed.RootElement.TryGetProperty("steps", out JsonElement list) || list.ValueKind != JsonValueKind.Array)
            {
                reasonCode = "script_steps_missing";
                detail = "field=steps";
                return false;
            }

            // ABSENT IS OPEN. A writer that never sealed is a writer that may still append, which waits rather than ends
            // the channel; a `sealed` of any other kind is a writer bug and is refused instead of read as false.
            bool sealedDocument = false;
            if (parsed.RootElement.TryGetProperty("sealed", out JsonElement sealedElement))
            {
                if (sealedElement.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                {
                    reasonCode = "script_sealed_invalid";
                    detail = "field=sealed";
                    return false;
                }
                sealedDocument = sealedElement.ValueKind == JsonValueKind.True;
            }

            var steps = new List<HostPlayerScriptStep>();
            foreach (JsonElement entry in list.EnumerateArray())
            {
                if (!TryReadSequence(entry, steps.Count + 1, out string sequenceDetail))
                {
                    reasonCode = "script_step_not_sequenced";
                    detail = sequenceDetail;
                    return false;
                }
                if (!TryParseStep(entry, steps.Count + 1, out HostPlayerScriptStep? step, out string stepReason))
                {
                    reasonCode = "script_step_invalid";
                    detail = stepReason;
                    return false;
                }
                steps.Add(step!);
            }

            document = new HostPlayerScriptDocument(steps, sealedDocument);
            return true;
        }
    }

    /// <summary>
    /// A step's position, which is the whole of its identity. Required, whole, and exactly this step's place in the
    /// document: the channel's cursor advances by position, so a duplicate (2, 2) would make one position performable
    /// twice and a gap (1, 3) would leave a number nothing can settle. The detail names the step and the number a reader
    /// must write, the way a bad coordinate does.
    /// </summary>
    private static bool TryReadSequence(JsonElement entry, int expected, out string detail)
    {
        string stepId = StringOf(entry, "stepId") ?? "unnamed";
        detail = $"step={stepId};field=seq;expected={expected}";
        if (entry.ValueKind != JsonValueKind.Object
            || !entry.TryGetProperty("seq", out JsonElement seq)
            || seq.ValueKind != JsonValueKind.Number
            || !seq.TryGetInt32(out int value))
            return false;
        if (value != expected)
        {
            detail = $"step={stepId};field=seq;expected={expected};actual={value}";
            return false;
        }
        detail = string.Empty;
        return true;
    }

    private static bool TryParseStep(JsonElement entry, int seq, out HostPlayerScriptStep? step, out string reason)
    {
        step = null;
        reason = "step_not_an_object";
        if (entry.ValueKind != JsonValueKind.Object)
            return false;
        string stepId = StringOf(entry, "stepId") ?? "unnamed";
        string action = StringOf(entry, "action") ?? string.Empty;
        switch (action)
        {
            case WalkStep:
                if (!TryReadTile(entry, "x", out int x))
                {
                    reason = $"step={stepId};field=x";
                    return false;
                }
                if (!TryReadTile(entry, "y", out int y))
                {
                    reason = $"step={stepId};field=y";
                    return false;
                }
                step = new HostPlayerScriptStep(
                    seq,
                    stepId,
                    HostPlayerScriptStepKind.WalkToTile,
                    StringOf(entry, "location") ?? string.Empty,
                    x,
                    y,
                    BoolOf(entry, "nearby"),
                    string.Empty);
                reason = string.Empty;
                return true;
            case EmoteStep:
                step = new HostPlayerScriptStep(seq, stepId, HostPlayerScriptStepKind.Emote, string.Empty, 0, 0, false, StringOf(entry, "emote") ?? string.Empty);
                reason = string.Empty;
                return true;
            case SayStep:
                step = new HostPlayerScriptStep(seq, stepId, HostPlayerScriptStepKind.Say, string.Empty, 0, 0, false, StringOf(entry, "text") ?? string.Empty);
                reason = string.Empty;
                return true;
            case ChestStep:
                step = new HostPlayerScriptStep(
                    seq,
                    stepId,
                    HostPlayerScriptStepKind.ChestTake,
                    string.Empty,
                    0,
                    0,
                    false,
                    $"{StringOf(entry, "targetRef") ?? string.Empty}|{StringOf(entry, "expectedQualifiedItemId") ?? string.Empty}");
                reason = string.Empty;
                return true;
            default:
                reason = $"step={stepId};action={action}";
                return false;
        }
    }

    private static string? StringOf(JsonElement entry, string name) =>
        entry.TryGetProperty(name, out JsonElement value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    /// <summary>
    /// A tile coordinate as the harness writes it: a JSON number, only a whole one, and never negative - the engine's
    /// map coordinates start at (0,0), so a negative tile is a script error rather than a place to walk to, and the step
    /// is refused by the field a reader must fix instead of being walked at. Read through the same field name the
    /// snapshot publishes, so a script and an observation spell a tile the same way.
    /// </summary>
    private static bool TryReadTile(JsonElement entry, string name, out int value)
    {
        value = 0;
        return entry.TryGetProperty(name, out JsonElement element)
            && element.ValueKind == JsonValueKind.Number
            && element.TryGetInt32(out value)
            && value >= 0;
    }

    private static bool BoolOf(JsonElement entry, string name) =>
        entry.TryGetProperty(name, out JsonElement value) && value.ValueKind == JsonValueKind.True;

    /// <summary>One frame of work on the current step. A step that is not settled by this frame stays current.</summary>
    private void StepThrough(HostPlayerScriptStep step)
    {
        string? refusal = step.Kind switch
        {
            HostPlayerScriptStepKind.WalkToTile => this.AdvanceWalk(step),
            HostPlayerScriptStepKind.Emote => this.PerformEmote(step),
            HostPlayerScriptStepKind.Say => this.PerformSay(step),
            HostPlayerScriptStepKind.ChestTake => this.PerformChestTake(step),
            _ => "script_step_unavailable",
        };
        if (refusal is not null)
            this.Stop($"script_stopped_by:{step.StepId}", $"reason={refusal}");
    }

    /// <summary>
    /// Walk to the step's tile: through the map's own warp when the target map is another one, then onto the tile.
    ///
    /// <para>
    /// NO TELEPORT. The controller is built with an <c>isAtEnd</c> predicate of this file's own rather than the engine's
    /// static one, which is what keeps <c>PathFindController</c>'s constructor off its "no other farmer present"
    /// placement branch (<c>PathFindController.cs:133-136</c>) - the same reason the cross-day bed walk does it. The
    /// only map change this can cause is the engine's own warp collision (<c>Farmer.cs:8586-8597</c>), which a real
    /// player triggers by walking onto a warp tile.
    /// </para>
    ///
    /// <para>
    /// <paramref name="step"/>'s <c>Nearby</c> is the one substitution allowed: a crop or a chest occupies the tile a
    /// person wants to stand beside, so the step asks for a tile NEXT TO the named one and the four orthogonal
    /// neighbours are tried in a fixed order. The reached tile is what gets recorded, so a judgement reads where the
    /// player actually stood rather than where she was asked to go.
    /// </para>
    ///
    /// <para>
    /// A BODY THAT CANNOT MOVE YET IS A WAIT, NOT A REFUSAL. A menu, an event or a fade clears itself, and the same
    /// reasoning the cross-day eligibility gate uses applies here: the wait is bounded by this STEP's budget, and that
    /// budget is what reports <c>script_deadline_exceeded</c> if it never clears. What a wait cannot clear - no
    /// route to the map, no route to the tile - is refused by name instead.
    /// </para>
    /// </summary>
    private string? AdvanceWalk(HostPlayerScriptStep step)
    {
        GameLocation? location = Game1.player.currentLocation;
        if (location is null)
            return "walk_no_location";
        if (this.WaitForADrivableBody() is { } waitReason)
        {
            this.NoteWait(waitReason);
            return null;
        }
        this.lastWaitReason = null;

        if (!LocationMatches(location, step.Location))
        {
            Warp? door = location.warps.FirstOrDefault(candidate =>
                !candidate.npcOnly.Value && string.Equals(candidate.TargetName, step.Location, StringComparison.Ordinal));
            if (door is null)
                return $"walk_no_route_to_location:{location.NameOrUniqueName}->{step.Location}";
            // Standing on the warp tile: the engine's own collision check performs the transition, and nothing here may
            // call warpFarmer on the player's behalf.
            if (Game1.player.TilePoint.X == door.X && Game1.player.TilePoint.Y == door.Y)
                return null;
            return this.ContinuePlan(location, new[] { new Vector2(door.X, door.Y) }, $"walk_no_route_to_door:{door.X},{door.Y}");
        }

        if (this.candidates.Length == 0)
            this.candidates = step.Nearby ? NeighbourThenTile(step.X, step.Y) : new[] { new Vector2(step.X, step.Y) };
        if (this.candidates.Any(tile => Game1.player.Tile == tile))
        {
            this.Settle(step, "walked_to_tile");
            return null;
        }
        return this.ContinuePlan(location, this.candidates, $"walk_no_route_to_tile:{step.X},{step.Y}");
    }

    private string? WaitForADrivableBody()
    {
        if (Game1.eventUp)
            return "player_in_event";
        if (Game1.activeClickableMenu is not null)
            return "player_in_menu";
        return Game1.player.CanMove ? null : "player_cannot_move";
    }

    private void NoteWait(string reason)
    {
        if (string.Equals(this.lastWaitReason, reason, StringComparison.Ordinal))
            return;
        this.lastWaitReason = reason;
        this.monitor.Log($"GameBuddy HostPlayerScript waiting to walk: {reason}.", LogLevel.Info);
    }

    /// <summary>
    /// Keep the installed plan, or plan to the next candidate when the previous one finished somewhere else.
    /// The plan belongs to ONE map: a plan whose map has changed under it ended at a warp and is not a failed route.
    /// </summary>
    private string? ContinuePlan(GameLocation location, Vector2[] candidates, string exhaustedReason)
    {
        if (this.controller is not null)
        {
            if (!string.Equals(this.controllerLocation, location.NameOrUniqueName, StringComparison.Ordinal))
            {
                this.controller = null;
                this.controllerLocation = null;
                return null;
            }
            if (ReferenceEquals(Game1.player.controller, this.controller))
                return null;
            this.controller = null;
            this.candidateIndex++;
        }
        while (this.candidateIndex < candidates.Length)
        {
            string? refusal = this.TryPlan(location, candidates[this.candidateIndex]);
            if (refusal is null)
                return null;
            this.candidateIndex++;
        }
        return exhaustedReason;
    }

    /// <summary>Install one native path plan, or answer why it could not be planned.</summary>
    private string? TryPlan(GameLocation location, Vector2 tile)
    {
        var plan = new PathFindController(
            Game1.player,
            location,
            (node, target, _location, _character) => node.x == target.X && node.y == target.Y,
            Game1.player.FacingDirection,
            null,
            WalkNodeBudget,
            new Point((int)tile.X, (int)tile.Y));
        if ((plan.pathToEndPoint?.Count ?? 0) == 0)
            return $"walk_unplannable:{(int)tile.X},{(int)tile.Y}";
        Game1.player.controller = plan;
        this.controller = plan;
        this.controllerLocation = location.NameOrUniqueName;
        return null;
    }

    private static Vector2[] NeighbourThenTile(int x, int y) => new[]
    {
        new Vector2(x, y + 1),
        new Vector2(x + 1, y),
        new Vector2(x - 1, y),
        new Vector2(x, y - 1),
        new Vector2(x, y),
    };

    /// <summary>
    /// Raise one balloon through the engine's PLAYER-emote entry, <c>Farmer.netDoEmote</c> - the call the engine's own
    /// <c>/emote</c> command makes (<c>ChatCommands.cs:176</c>) - so the gesture is a fact another player's client holds.
    ///
    /// <para>
    /// WHY NOT <c>Farmer.doEmote(int)</c>, WHICH THE <c>express_emote</c> ACTION DISPATCHES. That arm is the local
    /// animation: <c>Character.isEmoting</c> and <c>currentEmote</c> are plain fields, not NetFields
    /// (<c>Character.cs:145</c>/<c>:167</c>), so nothing a balloon raised with it does is sent to anyone. The observation
    /// publishes what the companion can see of the HOST player (<c>FarmhandTargetDiscovery.DescribeOtherFarmerDoing</c>
    /// reads <c>farmer.isEmoting</c>), and on her client that field belongs to HER copy of the Host's Farmer - armed only
    /// when the networked event arrives: <c>Farmer.netDoEmote</c> fires <c>doEmoteEvent</c>, whose handler is
    /// <c>Farmer.performPlayerEmote</c> (<c>Farmer.cs:2232</c>). A fixture waving with the unnetworked arm waves at
    /// nobody.
    /// </para>
    /// <para>
    /// The WORD is the product's own closed set (<see cref="ExecutionManager.EmoteMap"/>, the vocabulary
    /// <c>express_emote</c> accepts) and its icon is the ENGINE's answer for that word: a word this build's catalogue
    /// still lists but the installed engine's table no longer carries an icon for is refused by name rather than fired
    /// into nothing.
    /// </para>
    /// </summary>
    private string? PerformEmote(HostPlayerScriptStep step)
    {
        if (!ExecutionManager.EmoteMap.ContainsKey(step.Argument))
            return $"invalid_emote:{step.Argument}";
        if (EngineEmoteIcon(step.Argument) is not { } emoteIndex)
            return $"emote_not_in_the_engines_table:{step.Argument}";
        if (Game1.eventUp)
            return "emote_deferred_by_event";
        if (Game1.player.IsEmoting)
            return "emote_busy";
        Game1.player.netDoEmote(step.Argument);
        if (!Game1.player.IsEmoting || Game1.player.CurrentEmote != emoteIndex)
            return "emote_not_started";
        this.Settle(step, "emote_started");
        return null;
    }

    /// <summary>
    /// The engine's own icon index for an emote word, or null when <c>Farmer.EMOTES</c> answers nothing playable for it
    /// (an absent word, or one with no icon - a frame-only gesture arms no balloon and so publishes no <c>emoting</c>).
    /// The neutral answer is the engine's table rather than a second copy of it: <see cref="ExecutionManager.EmoteMap"/>
    /// owns which WORDS exist, this owns what the installed engine does with one.
    /// </summary>
    private static int? EngineEmoteIcon(string emoteWord) => Farmer.EMOTES
        .Where(type => string.Equals(type.emoteString, emoteWord, StringComparison.Ordinal) && type.emoteIconIndex >= 0)
        .Select(type => type.emoteIconIndex)
        .Cast<int?>()
        .FirstOrDefault();

    /// <summary>The lobby's own chat egress: the same call the published <c>send_multiplayer_chat</c> action makes.</summary>
    private string? PerformSay(HostPlayerScriptStep step)
    {
        if (string.IsNullOrWhiteSpace(step.Argument) || step.Argument.Length > ExecutionManager.ChatMessageMaximumLength)
            return "chat_message_invalid";
        if (!ExecutionManager.TryResolveMultiplayerEgress(out Multiplayer? multiplayer))
            return "chat_multiplayer_only";
        try
        {
            multiplayer!.sendChatMessage(LocalizedContentManager.CurrentLanguageCode, step.Argument, Multiplayer.AllPlayers);
        }
        catch (Exception error)
        {
            return $"chat_message_native_exception:{error.GetType().Name}";
        }
        this.Settle(step, "chat_sent");
        return null;
    }

    /// <summary>
    /// Take one item out of a published container, through the native chest take sequence and the container's own
    /// cross-player lock.
    ///
    /// <para>
    /// THE LOCK IS THE POINT OF THIS STEP. A placed chest is a world object two farmers can reach at once, and the
    /// product's own container actions take <c>Chest.GetMutex()</c> before they write. A scripted take that skipped it
    /// would not contend; it would race, and a slice about two independent farmers contending for one row would then be
    /// measuring the fixture's own unlocked write. The contention reading, the grant and the resolution are the same
    /// helpers the container actions use, called here rather than re-implemented.
    /// </para>
    /// </summary>
    private string? PerformChestTake(HostPlayerScriptStep step)
    {
        string[] parts = step.Argument.Split('|');
        if (parts.Length != 2 || parts[0].Length == 0 || parts[1].Length == 0)
            return "chest_step_invalid";
        GameLocation? location = Game1.player.currentLocation;
        if (location is null)
            return "chest_no_location";
        ExecutionManager.StorageContainerResolution resolved = ExecutionManager.ResolveStorageContainerById(location, parts[0]);
        if (!resolved.Resolved)
            return resolved.RefusalReasonCode ?? "chest_target_changed";
        if (ChebyshevDistance((int)Game1.player.Tile.X, (int)Game1.player.Tile.Y, resolved.X, resolved.Y) > 1)
            return $"container_out_of_reach:{resolved.X},{resolved.Y}";
        Chest chest = resolved.Chest!;
        if (ExecutionManager.ReadContainerContentionRefusal(chest) is { } contention)
            return contention;
        if (ExecutionManager.TakeContainerLock(chest, location) is { } lockRefusal)
            return lockRefusal;
        try
        {
            string wanted = ItemRegistry.QualifyItemId(parts[1]);
            Item? target = chest
                .GetItemsForPlayer()
                .FirstOrDefault(item => item is not null && item.Stack > 0
                    && string.Equals(ItemRegistry.QualifyItemId(item.QualifiedItemId), wanted, StringComparison.Ordinal));
            if (target is null)
                return "chest_empty";
            if (!Game1.player.couldInventoryAcceptThisItem(target))
                return "inventory_full";
            int before = CountItem(Game1.player, wanted);
            int stack = target.Stack;
            chest.GetItemsForPlayer().Remove(target);
            chest.clearNulls();
            Item? leftover = Game1.player.addItemToInventory(target);
            bool returned = false;
            if (leftover is not null && leftover.Stack > 0)
            {
                chest.addItem(leftover);
                returned = true;
            }
            if (returned || CountItem(Game1.player, wanted) != before + stack)
                return "chest_take_unverified";
            this.Settle(step, "chest_taken");
            return null;
        }
        finally
        {
            chest.GetMutex().ReleaseLock();
        }
    }

    private static int CountItem(Farmer farmer, string qualifiedItemId) =>
        farmer.Items
            .Where(item => item is not null && string.Equals(ItemRegistry.QualifyItemId(item.QualifiedItemId), qualifiedItemId, StringComparison.Ordinal))
            .Sum(item => item.Stack);

    private static int ChebyshevDistance(int x, int y, int otherX, int otherY) =>
        Math.Max(Math.Abs(x - otherX), Math.Abs(y - otherY));

    private static bool LocationMatches(GameLocation location, string expected) =>
        string.Equals(location.NameOrUniqueName, expected, StringComparison.Ordinal)
        || string.Equals(location.Name, expected, StringComparison.Ordinal);

    private static string ActionOf(HostPlayerScriptStep step) => step.Kind switch
    {
        HostPlayerScriptStepKind.WalkToTile => WalkStep,
        HostPlayerScriptStepKind.Emote => EmoteStep,
        HostPlayerScriptStepKind.ChestTake => ChestStep,
        HostPlayerScriptStepKind.Say => SayStep,
        _ => "unknown",
    };

    /// <summary>Close the current step as done and advance. The world's own clock and the achieved tile travel with it.</summary>
    private void Settle(HostPlayerScriptStep step, string reasonCode)
    {
        this.WriteRecord(step, ActionOf(step), "succeeded", reasonCode);
        this.stepIndex++;
        this.stepDeadline = null;
        this.controller = null;
        this.controllerLocation = null;
        this.candidateIndex = 0;
        this.candidates = Array.Empty<Vector2>();
    }

    /// <summary>
    /// End the channel on a named refusal. The record carries the step the refusal belongs to whenever one is current:
    /// a slice must be able to read its OWN step's refusal (and its <c>seq</c>) rather than an anonymous stop that could
    /// belong to any step in a document shared by four slices.
    /// </summary>
    private void Stop(string reasonCode, string detail)
    {
        this.stopReason = reasonCode;
        HostPlayerScriptStep? current = this.stepIndex < this.steps.Count ? this.steps[this.stepIndex] : null;
        this.WriteRecord(current, "script", "rejected", reasonCode, detail);
        this.finished = true;
    }

    /// <summary>
    /// One record per settled step, in the flat shape a bridge receipt already has (<c>state</c>/<c>reasonCode</c>) so a
    /// judgement can read both sides of a slice the same way. <c>seq</c> is the step's position in the document, which is
    /// what makes a record attributable to the slice that appended it; a channel-level record carries none. The clock is
    /// the world's own <c>Game1.timeOfDay</c> - the same integer the snapshot publishes - and the tile is where the player
    /// actually stood when the step settled.
    /// </summary>
    private void WriteRecord(HostPlayerScriptStep? step, string action, string state, string reasonCode, string? detail = null)
    {
        try
        {
            GameLocation? location = Game1.player?.currentLocation;
            var record = new Dictionary<string, object?>
            {
                ["schema"] = Schema,
                ["seq"] = step?.Seq,
                ["stepId"] = step?.StepId,
                ["action"] = action,
                ["state"] = state,
                ["reasonCode"] = reasonCode,
                ["dayOfMonth"] = Game1.Date?.TotalDays ?? 0,
                ["timeOfDay"] = Game1.timeOfDay,
                ["location"] = location?.NameOrUniqueName,
                ["x"] = Game1.player is null ? 0 : (int)Game1.player.Tile.X,
                ["y"] = Game1.player is null ? 0 : (int)Game1.player.Tile.Y,
                ["requestedX"] = step is { Kind: HostPlayerScriptStepKind.WalkToTile } ? step.X : null,
                ["requestedY"] = step is { Kind: HostPlayerScriptStepKind.WalkToTile } ? step.Y : null,
                ["detail"] = detail,
                ["atUnixMs"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            };
            string? directory = Path.GetDirectoryName(this.recordsPath);
            if (!string.IsNullOrWhiteSpace(directory))
                Directory.CreateDirectory(directory);
            File.AppendAllText(this.recordsPath, JsonSerializer.Serialize(record) + Environment.NewLine);
        }
        catch (Exception error)
        {
            // The records file IS the instrument, so a record that cannot be built or written ends the script rather than
            // leaving it running unobservable. `Game1.Date` is inside this bound because the calendar itself is an
            // observation of a loaded save (`NpcDialoguePager.CurrentWorldDay` makes the same answer for the same
            // reason).
            this.monitor.Log($"GameBuddy HostPlayerScript could not write a record: {error.GetType().Name}.", LogLevel.Error);
            this.finished = true;
        }
        this.monitor.Log(
            $"GameBuddy HostPlayerScript {action} seq={step?.Seq.ToString() ?? "-"} step={step?.StepId ?? "-"} {state}: {reasonCode}.",
            LogLevel.Info);
    }
}

/// <summary>
/// Opt-in, fixture-only configuration for <see cref="HostPlayerScriptChannel"/>. It is never part of a user profile: the
/// Player Host is a real human in production, and only a measured harness tells its player where to stand.
/// </summary>
public sealed class HostPlayerScriptConfig
{
    public bool Enable { get; init; }

    /// <summary>Absolute path the harness writes the document to. The channel polls it and performs each step once.</summary>
    public string ScriptPath { get; init; } = string.Empty;

    /// <summary>Absolute path the channel appends one record per settled step to.</summary>
    public string RecordsPath { get; init; } = string.Empty;

    /// <summary>
    /// How long ONE step may stay current before it stops on <c>script_deadline_exceeded</c>. The document spans a whole
    /// paired run - one slice's steps, then the next slice's - so a budget for "the whole script" would expire between
    /// slices and report a slice that was never given a chance. The wall clock of the run belongs to the harness; this
    /// bound is only the wait a body that cannot move yet is allowed.
    /// </summary>
    public int TimeoutSeconds { get; init; } = 180;

    internal bool IsValid => this.Enable
        && Path.IsPathFullyQualified(this.ScriptPath)
        && Path.IsPathFullyQualified(this.RecordsPath)
        && this.TimeoutSeconds is >= 10 and <= 3600;
}
