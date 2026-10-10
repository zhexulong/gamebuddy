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
        if (tracked.transitioning && tracked.transitioningBigger)
            // Still sliding in. The box is not readable and a click would be
            // discarded (DialogueBox.cs:357-360).
            return;
        if (IsOutro(tracked) || tracked.dialogueFinished)
        {
            this.Report(session, tracked);
            return;
        }
        if (tracked.isQuestion)
        {
            // HARD STOP. Report the question once its text has finished typing,
            // so the Agent answers what the player can actually read.
            this.CapturePage(tracked);
            if (IsTextSettled(tracked))
                this.Report(session, tracked);
            return;
        }

        this.CapturePage(tracked);
        if (CanAdvance(tracked))
        {
            tracked.receiveLeftClick(0, 0);
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
    /// The native click would ADVANCE the page rather than only settle typing:
    /// the text has reached the box's own end-of-page index, the box's
    /// post-page safety window has elapsed, and the page is not a question.
    ///
    /// "End of page" is the NATIVE boundary, not a finished typewriter: the
    /// native click itself treats `characterIndexInDialogue` at
    /// `getCurrentString().Length - 1` as settled (DialogueBox.cs:361-364) and
    /// the game's `update` only reaches `Length` one step later (:843), so the
    /// last character may still be undrawn when the page flips. That is the
    /// boundary the player's own click uses, and the REPORTED text is complete
    /// either way because `getCurrentString()` returns the whole string.
    ///
    /// The safety window is the box's <c>safetyTimer</c>, re-armed to
    /// <c>DialogueBox.safetyDelay</c> (750, :34) after every advance
    /// (DialogueBox.cs:462) and decremented by the game's own <c>update</c>
    /// (:771-774), so pacing stays native instead of a Mod-invented delay. The
    /// same window is what the native click itself enforces (:367-370).
    /// </summary>
    internal static bool CanAdvance(DialogueBox box) =>
        !box.isQuestion
        && !box.transitioning
        && box.safetyTimer <= 0
        && IsTextSettled(box);

    /// <summary>
    /// The native typing index has reached the end of the current page. The
    /// native click settles typing before it flips the page
    /// (DialogueBox.cs:361-364), so a page still typing is not presented yet and
    /// must not be clicked again.
    /// </summary>
    internal static bool IsTextSettled(DialogueBox box) =>
        box.characterIndexInDialogue >= box.getCurrentString().Length - 1;

    /// <summary>
    /// The box is playing its reverse transition. <c>beginOutro</c>
    /// (DialogueBox.cs:256-261) is the only writer of <c>transitioning = true</c>
    /// together with <c>transitioningBigger = false</c>, so the pair is the
    /// native "the dialogue is over" signal; the opening transition of a fresh
    /// box is the opposite pair (:73-75).
    /// </summary>
    internal static bool IsOutro(DialogueBox box) => box.transitioning && !box.transitioningBigger;

    private void CapturePage(DialogueBox box)
    {
        if (this.capturedCurrentPage)
            return;
        this.capturedCurrentPage = true;
        string page = box.getCurrentString();
        if (page.Length > 0)
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

        string payloadJson = JsonSerializer.Serialize(
            new NpcDialoguePresentedPayload(SpeakerOf(box), this.pages.ToArray(), isQuestion, choices.ToArray()));

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
