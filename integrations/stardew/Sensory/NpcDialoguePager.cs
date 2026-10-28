using System.Collections.Generic;
using System.Text.Json;
using GameBuddy.Stardew.Core.Models;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Menus;

namespace GameBuddy.Stardew.Sensory;

/// <summary>
/// Drives the game's OWN dialogue pager to exhaustion and reports the whole
/// dialogue as one typed <c>npc_dialogue_presented</c> world fact.
///
/// Why the Mod pages instead of only reading the box: each <c>DialogueLine</c>
/// carries a public <c>Action SideEffects</c> (DialogueLine.cs:12), and the
/// native pager advancing a page is the only thing that runs them. Merely
/// reading the page stack would report text the player never reached and would
/// skip the item grants, friendship and quest flags the reached lines own.
///
/// Why it hard-stops on a question: the native click path answers a question
/// from <c>selectedResponse</c> (DialogueBox.cs:371-404); a Mod click on a
/// question page therefore does not flip a page at all, it chooses an answer
/// nobody chose. A question belongs to the Agent through <c>answer_dialogue</c>,
/// which is the same line <c>dismiss_modal</c> draws
/// (farmhandexecutioncontroller.modalactions.cs:82).
///
/// Everything this reader touches is public on <see cref="DialogueBox"/>:
/// <c>dialogues</c> (:12), <c>characterDialoguesBrokenUp</c> (:16),
/// <c>responses</c> (:18), <c>characterIndexInDialogue</c> (:58),
/// <c>safetyTimer</c> (:60), <c>isQuestion</c> (:81), <c>transitioning</c>
/// (:73), <c>transitioningBigger</c> (:75), <c>dialogueFinished</c> (:79),
/// <c>characterDialogue</c> (:14) and <c>getCurrentString()</c> (:712); it
/// advances only through the public click entry
/// <c>receiveLeftClick(int, int, bool)</c> (:355). It writes no field of the
/// box and calls no other native mutator, so driving the pager stays the single
/// permitted world mutation.
/// </summary>
internal sealed class NpcDialoguePager
{
    /// <summary>
    /// Label for a box the game opened without a character - an object dialogue
    /// or a plain string box both have <c>characterDialogue == null</c>.
    /// </summary>
    internal const string NarratorSpeaker = "narrator";

    private readonly IMonitor? monitor;
    private readonly List<string> pages = new();

    /// <summary>
    /// A Mod-owned counter, added to the key so two dialogues can never share an identity. The key used to be
    /// the game tick alone, which is unique per <c>Update</c> (`Game1.cs:3914`) EXCEPT while
    /// <c>ShouldLoadIncrementally</c> - the increment is inside that condition, so two ticks can report the same
    /// value and two dialogues would collapse into one fact.
    /// </summary>
    private static long dialogueSequence;

    /// <summary>Distinct failures already reported, so a per-tick fault cannot flood the log.</summary>
    private readonly HashSet<string> reportedFailures = new(StringComparer.Ordinal);

    private DialogueBox? trackedBox;
    private long dialogueStartTick;
    private bool capturedCurrentPage;
    private bool emitted;

    internal NpcDialoguePager(IMonitor? monitor = null)
    {
        this.monitor = monitor;
    }

    /// <summary>
    /// One game tick of the dialogue stream. Called on the AI Farmhand's game
    /// thread with the bridge session that would carry the fact; a null or
    /// non-publishable session leaves the box entirely to the player.
    /// </summary>
    internal void Observe(BridgeSession? session)
    {
        DialogueBox? box = Game1.activeClickableMenu as DialogueBox;
        // NO MENU AND NO DIALOGUE IN FLIGHT IS THE ORDINARY STATE. `activeClickableMenu` is null on every tick
        // that no modal is up - startup and world load, walking around, and any non-dialogue menu as well - so
        // there is nothing to page and nothing to report. It returns BEFORE the try below because that try is
        // for a BROKEN box, not for the absence of one: this state used to fall through to `trackedBox!`
        // (`ReferenceEquals(null, null)` skipped the branch that returns for a null box), so every session opened
        // with a NullReferenceException swallowed into a "skipped a box" warning for a state the game is in most
        // of the time. The read cannot throw: `Game1.activeClickableMenu` is a plain static field accessor.
        if (box is null && this.trackedBox is null)
            return;

        try
        {
            this.ObserveCore(session, box);
        }
        catch (Exception error)
        {
            // The game-loop boundary. A per-tick event handler that throws takes the bridge with it (observed
            // live as `bridge_response_timeout`), so this reports once per distinct failure and then keeps
            // ticking - the dialogue is skipped, not the session.
            string key = error.GetType().Name + ":" + error.Message;
            if (this.reportedFailures.Add(key))
            {
                // Name the state that was present when ObserveCore threw, so a NRE in the pager's own path is
                // diagnosable instead of looking like "the game is broken".
                string state =
                    $"tracked={(this.trackedBox is null ? "null" : "box")};emitted={this.emitted.ToString().ToLowerInvariant()};"
                    + $"pages={this.pages.Count};captured={this.capturedCurrentPage.ToString().ToLowerInvariant()}";
                this.monitor?.Log($"GameBuddy dialogue pager skipped a box: {key} [{state}]", LogLevel.Warn);
            }
            this.Reset();
        }
    }

    private void ObserveCore(BridgeSession? session, DialogueBox? box)
    {
        if (!ReferenceEquals(box, this.trackedBox))
        {
            // Whatever we were paging is over: exhausted, answered, replaced by
            // the next dialogue, or simply gone. A box that disappears mid-run
            // is not an error - report what it did present and start over.
            if (this.trackedBox is not null)
                this.Report(session, this.trackedBox);
            this.Reset();
            if (box is null)
                return;
            // Taking over a dialogue is a real world mutation (the native click
            // runs the lines' side effects), so it happens only when the fact it
            // produces can actually leave on the authenticated bridge. Without
            // that, the box is a player's dialogue and is left alone.
            if (session is null || !session.CanPublishWorldFact)
                return;

            this.trackedBox = box;
            this.dialogueStartTick = Game1.ticks;
        }

        DialogueBox tracked = this.trackedBox!;
        if (this.emitted)
            // Already reported. Hold the reference (so the same box is never
            // re-tracked and reported under a second identity) but never touch
            // it again.
            return;
        // CAPTURE FIRST, AND READ THE TEXT BEFORE DECIDING. Reading a page is safe at any moment
        // (`getCurrentString()` returns the whole page) while CLICKING is not, and the text is what distinguishes
        // the two transitions a live run showed: the PAGE CHANGE arrived with different text (16 -> 38 characters
        // right after the advance), and the CLOSING transition kept presenting the page we had already captured.
        string? currentPage = CurrentTextOrNull(tracked);
        // An EMPTY or unreadable page counts as nothing new - it is not content, so it must not block the closing
        // transition from being recognised (a first draft compared text alone, and the empty page after the last
        // one read as "something new", so the report never happened).
        bool presentsSomethingNew = !string.IsNullOrEmpty(currentPage)
            && (this.pages.Count == 0 || !string.Equals(this.pages[^1], currentPage, StringComparison.Ordinal));
        if (tracked.transitioning)
        {
            // No click during any transition: the native click discards one (DialogueBox.cs:357-360). A slide-IN
            // (`transitioningBigger`, the pair a fresh box opens with) is not an end at all. A transition that
            // presents nothing new IS the end - there is nothing left to show, which is how this pager recognises
            // the closing transition without trusting the `transitioning && !transitioningBigger` heuristic: the
            // tick log refuted that heuristic, because the page advance produces the very same pair.
            if (presentsSomethingNew)
                this.CapturePage(tracked);
            else if (!tracked.transitioningBigger && this.pages.Count > 0)
                this.Report(session, tracked);
            return;
        }
        this.CapturePage(tracked);
        if (tracked.dialogueFinished)
        {
            this.Report(session, tracked);
            return;
        }
        if (tracked.isQuestion)
        {
            // HARD STOP: never click a question; the Agent answers it. Report once the page is readable, which the
            // capture above already established - waiting for the typewriter index was an invented precondition (a
            // live run kept `idx` at 0 through a whole dialogue while the text was fully readable).
            if (this.pages.Count > 0)
                this.Report(session, tracked);
            return;
        }

        if (CanAdvance(tracked))
        {
            // Drive the page forward through the SAME native entry the player uses. A live run showed this call can
            // itself throw (the pager then reported a skipped box and never emitted a fact), so it is guarded like
            // the read: an un-drivable box must not take the tick down, and the failure is diagnosed rather than
            // guessed - which page state was present when the click threw.
            try
            {
                tracked.receiveLeftClick(0, 0);
            }
            catch (Exception clickError)
            {
                string key = "receiveLeftClick:" + clickError.GetType().Name;
                if (this.reportedFailures.Add(key))
                    this.monitor?.Log(
                        "GameBuddy dialogue pager could not drive a page: " + key
                            + ";characterDialogue_null=" + (tracked.characterDialogue is null).ToString().ToLowerInvariant()
                            + ";page_count=" + (tracked.dialogues?.Count ?? -1)
                            + ";index=" + tracked.characterIndexInDialogue
                            + ";box_text_length=" + (tracked.getCurrentString()?.Length ?? -1),
                        LogLevel.Warn);
                this.Reset();
                return;
            }
            this.capturedCurrentPage = false;
        }
    }

    /// <summary>
    /// The speaker label: the character's stable internal name (the identity the
    /// rest of the Mod resolves NPCs by), or <see cref="NarratorSpeaker"/> for a
    /// box the game opened with no character behind it.
    /// </summary>
    internal static string SpeakerOf(DialogueBox box) =>
        box.characterDialogue?.speaker?.Name ?? NarratorSpeaker;

    /// <summary>Drops any in-flight box, e.g. when the world or bridge tears down.</summary>
    internal void Reset()
    {
        this.trackedBox = null;
        this.dialogueStartTick = 0;
        this.capturedCurrentPage = false;
        this.emitted = false;
        this.pages.Clear();
    }

    /// <summary>
    /// The native click would ADVANCE the page: the box's post-page safety window has elapsed, the box is not
    /// mid-transition, and the page is not a question.
    ///
    /// It does NOT require the typewriter to have finished. A live run settled that: `characterIndexInDialogue`
    /// stayed 0 for the whole dialogue while `safetyTimer` drained normally, so a predicate that waited for the
    /// index to reach the end of the page never fired and the pager never clicked at all - it reported page one and
    /// stopped. The native click handles an unfinished page ITSELF (its first branch fast-forwards the typewriter:
    /// DialogueBox.cs:361-364), which is exactly what a player's first click does, so waiting for it here was an
    /// invented precondition rather than a native one.
    ///
    /// The safety window stays: it is the box's own, re-armed to <c>DialogueBox.safetyDelay</c> (750, :34) after
    /// every advance (:462) and decremented by the game's own <c>update</c> (:771-774), so the pacing remains the
    /// game's rather than a Mod-invented delay - and it is what the native click enforces too (:367-370).
    /// </summary>
    internal static bool CanAdvance(DialogueBox box) =>
        !box.isQuestion
        && !box.transitioning
        && box.safetyTimer <= 0;


    /// <summary>
    /// The box's current page, or null when the game cannot produce one.
    /// `getCurrentString()` is NOT total: it trims
    /// `characterDialogue.getCurrentDialogue()` (DialogueBox.cs:716) and a
    /// dialogue line's `Text` can be null, and it reads
    /// `characterDialogue.speaker.getName()` (:719) where the speaker can be null.
    /// A live run threw a NullReferenceException out of it EVERY TICK, which
    /// silenced the bridge (`bridge_response_timeout`) - so this read is allowed
    /// to fail here instead of escaping into the game loop.
    /// </summary>
    internal static string? CurrentTextOrNull(DialogueBox box)
    {
        try
        {
            return box.getCurrentString();
        }
        catch
        {
            return null;
        }
    }

    private void CapturePage(DialogueBox box)
    {
        if (this.capturedCurrentPage)
            return;
        this.capturedCurrentPage = true;
        string? page = CurrentTextOrNull(box);
        if (string.IsNullOrEmpty(page))
            return;
        // A capture equal to the previous one is NOT a new page. Native paging takes two clicks per page (the
        // first finishes the typewriter, the second advances), so the tick after the first click still shows the
        // same page; counting it would report the same page twice and turn "one page" into a false "two".
        if (this.pages.Count > 0 && string.Equals(this.pages[^1], page, StringComparison.Ordinal))
            return;
        this.pages.Add(page);
    }

    /// <summary>
    /// Emits the one fact for the box, at most once per tracked dialogue.
    /// <c>eventId</c>, <c>sourceEventId</c> and <c>deduplicationKey</c> are all
    /// the same Mod-minted opaque identity - the tick the dialogue first appeared
    /// plus a Mod-owned sequence - so a re-send inside the consumer's pending
    /// window collapses instead of presenting the dialogue again. (The window is
    /// what the Host dedupes within; this key does not pretend to be durable.)
    /// </summary>
    private void Report(BridgeSession? session, DialogueBox box)
    {
        if (this.emitted)
            return;
        this.emitted = true;

        bool isQuestion = box.isQuestion;
        if (!isQuestion && this.pages.Count == 0)
            // Nothing was ever presented (someone else consumed the box before
            // its first readable page). An empty dialogue is not a fact.
            return;

        var choices = new List<NpcDialogueChoice>();
        if (isQuestion && box.responses is not null)
        {
            foreach (Response response in box.responses)
                choices.Add(new NpcDialogueChoice(response.responseKey, response.responseText));
        }

        // OUR CAPTURES FIRST. They are the pages this pager actually saw presented, in order and deduped. The
        // native `characterDialoguesBrokenUp` is only the CURRENT page's remainder (a live run showed it holding one
        // entry while the pager had captured two), so preferring it TRUNCATED a correct two-page dialogue to one -
        // it is a last resort for a box the pager never got to capture at all.
        string[] pages = this.pages.Count > 0
            ? this.pages.ToArray()
            : box.characterDialoguesBrokenUp is { } stack && stack.Count > 0
                ? ((Func<string[]>)(() => { string[] remaining = stack.ToArray(); Array.Reverse(remaining); return remaining; }))()
                : this.pages.ToArray();

        if (this.monitor is not null)
            this.monitor.Log(
                "GameBuddy pager report: "
                    + $"our_pages={this.pages.Count};box_dialogues={(box.dialogues?.Count.ToString() ?? "null")};"
                    + $"box_broken_up={(box.characterDialoguesBrokenUp?.Count.ToString() ?? "null")};"
                    + $"chosen={pages.Length};speaker={SpeakerOf(box)};question={box.isQuestion.ToString().ToLowerInvariant()}",
                LogLevel.Trace);

        string payloadJson = JsonSerializer.Serialize(
            new NpcDialoguePresentedPayload(SpeakerOf(box), pages, isQuestion, choices.ToArray()));

        long sequence = System.Threading.Interlocked.Increment(ref dialogueSequence);
        string eventId = $"npc_dialogue_{this.dialogueStartTick}_{sequence}";
        var fact = new BridgeWorldFact(
            eventId,
            eventId,
            NpcDialoguePresentedPayload.Kind,
            Game1.ticks,
            Game1.timeOfDay.ToString("D4"),
            session?.CurrentRevision ?? 0,
            payloadJson,
            eventId);

        if (session is null || !session.TryCreateWorldFactEvent(fact))
            this.monitor?.Log($"GameBuddy npc_dialogue_presented was not deliverable: eventId={eventId}.", LogLevel.Trace);
    }
}
