using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading;
using GameBuddy.Stardew.Core.Models;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Menus;

namespace GameBuddy.Stardew.Sensory;

/// <summary>
/// ONE OBSERVER OF EVERY MODAL THE ENGINE MOUNTS, published as one <c>modal_presented</c> fact on the mount and one
/// <c>modal_dismissed</c> fact on the unmount.
///
/// <para>
/// WHY ONE OBSERVER AND NOT A WALK IN EVERY HANDLER. <c>activeClickableMenu</c> is the engine's single slot for "a menu
/// owns this screen" (<c>Game1.cs:9303</c> is one of its readers), so the whole population of menus - the settlement
/// sheet, a level-up, a letter, a shop, the <c>GameMenu</c> - is reachable through one read. A reader per handler would
/// cover only the menus some handler already knows about, which is the same gap it was meant to close: the companion
/// called <c>stardew_observe</c> four times in 44 minutes of the last live run, so a modal she did not ask about was a
/// modal she never learned about.
/// </para>
///
/// <para>
/// WHY THE IDENTITY IS THE ENGINE'S OWN TYPE. <c>GetType().Name</c> is what the refusal evidence, the Body Program
/// modal fact (<see cref="WorldModel.MountedModal"/>) and <see cref="NpcDialoguePager"/>'s hedges already spell, and it
/// is the only spelling that cannot fall behind the game: a hand-written table of menu names goes quiet the day the
/// engine adds one, and <c>ModalTransitionFactCoverageTests</c> derives the population from the decompiled tree so a new
/// subtype fails loudly instead.
/// </para>
///
/// <para>
/// WHICH ONE OWNS A DIALOGUE. <c>npc_dialogue_presented</c> owns a dialogue's TRANSCRIPT, because it pages the box to
/// exhaustion and reports the pages the game really showed, and it is the fact that runs the lines' own side effects. This
/// observer publishes the MOUNT plus the page the box is holding at that tick (<c>getCurrentString()</c>): a box can page
/// into a question and its first page is not its last, so the mount reading and the pager's transcript are two readings at
/// two times, and only the first one is available while the companion still has time to react to it. A box that holds no
/// readable page yet says so (`textFrom: npc_dialogue_presented`) instead of publishing a null with no owner.
/// </para>
///
/// <para>
/// THE BOUND. <c>Observe</c> runs once per tick, after the engine's own update, so churn inside one frame is invisible
/// and a menu the engine re-mounts within that frame is one fact. A menu that stands for half an hour changes nothing
/// (the reference is unchanged, so nothing is published), and a menu that leaves publishes exactly one dismissal.
/// </para>
/// </summary>
internal sealed class ModalTransitionObserver
{
    /// <summary>
    /// Transport bound on one text excerpt, in characters. A letter is the one modal whose whole content is prose, and
    /// this is the length of a short one: past it the excerpt is a pointer to the letter, not the letter.
    /// </summary>
    internal const int MaximumTextChars = 240;

    /// <summary>
    /// A Mod-owned counter added to the tick, because <c>Game1.ticks</c> is unique per <c>Update</c> only while the game
    /// is not loading incrementally (<c>Game1.cs:3911-3914</c>); the dialogue pager carries the same counter for the
    /// same reason.
    /// </summary>
    private static long mountSequence;

    private readonly IMonitor? monitor;
    private readonly Func<bool> timePasses;

    /// <summary>The menu this observer has already reported, or null when the slot was empty at the last tick.</summary>
    private IClickableMenu? mounted;

    internal ModalTransitionObserver(IMonitor? monitor = null, Func<bool>? timePasses = null)
    {
        this.monitor = monitor;
        this.timePasses = timePasses ?? (static () => Game1.shouldTimePass());
    }

    /// <summary>
    /// One game tick of the modal stream, on the AI Farmhand's game thread. A null or non-publishable session costs the
    /// facts, never the world: nothing here mutates the menu, so there is no state to hold back for it.
    /// </summary>
    internal void Observe(BridgeSession? session)
    {
        IClickableMenu? menu = Game1.activeClickableMenu;
        if (ReferenceEquals(menu, this.mounted))
            return;

        IClickableMenu? closed = this.mounted;
        this.mounted = menu;
        // Order matters for the reader, not for the engine: the menu that has gone is named before the one that
        // replaced it, so a batch that carries both reads as one transition rather than as an unmounted menu.
        if (closed is not null)
            this.PublishDismissed(session, closed);
        if (menu is not null)
            this.PublishPresented(session, menu);
    }

    /// <summary>
    /// One mounted menu, described in the engine's terms. Pure: the menu is the only thing it reads, and the engine's
    /// time-pass verdict arrives as an argument, so a caller without a game can still describe any menu subtype.
    /// </summary>
    internal static ModalPresentedPayload Describe(IClickableMenu menu, bool blocksTimePass)
    {
        DialogueBox? box = menu as DialogueBox;
        DialogueBox? question = box is { isQuestion: true } asked ? asked : null;
        string? text = TextOf(menu);
        return new ModalPresentedPayload(
            menu.GetType().Name,
            question is not null,
            question is null ? Array.Empty<string>() : ResponseKeys(question),
            blocksTimePass,
            text,
            TextOwnerOf(menu, text));
    }

    /// <summary>
    /// Where this menu's words are, as one of <see cref="ModalPresentedPayload.TextOwner"/>'s three answers - so a
    /// `modal_presented` line never means "empty", "unreadable" and "owned elsewhere" at the same time.
    /// </summary>
    private static string TextOwnerOf(IClickableMenu menu, string? text) => text is not null
        ? ModalPresentedPayload.TextOwner.Carried
        : menu is DialogueBox
            ? ModalPresentedPayload.TextOwner.DialogueFact
            : ModalPresentedPayload.TextOwner.Screen;

    /// <summary>
    /// The keys a question is offering, in the order the game shows them - the same tokens
    /// <c>answer_dialogue</c> accepts back (<c>Response.responseKey</c>, Response.cs:7-9).
    /// </summary>
    private static string[] ResponseKeys(DialogueBox box)
    {
        if (box.responses is null || box.responses.Length == 0)
            return Array.Empty<string>();

        var keys = new string[box.responses.Length];
        for (int index = 0; index < box.responses.Length; index += 1)
            keys[index] = box.responses[index].responseKey;
        return keys;
    }

    /// <summary>
    /// The menu's own words, as the box holds them at this tick.
    ///
    /// <para>
    /// A letter is the case that started this: <c>LetterViewerMenu.mailMessage</c> holds the text the game would draw,
    /// <c>stardew_observe</c> publishes no menu text at all, and the words are gone the moment the letter is closed.
    /// </para>
    /// <para>
    /// A DIALOGUE BOX IS THE OTHER, and it is the one the Marlon cutscene measured: six `modal_presented (DialogueBox,
    /// text: null)` facts while the words only existed in a later `npc_dialogue_presented`. <c>getCurrentString()</c> is
    /// the box's own answer to "what am I showing" (`DialogueBox.cs:712`): a pure read, the page the box is on at the
    /// mount, including the speaker prefix the engine adds when portraits are off. The paged-through transcript stays the
    /// dialogue fact's, because only the pager reaches the pages the game really showed and the side effects they run.
    /// </para>
    /// <para>
    /// A <c>ConfirmationDialog</c>'s message is <c>protected</c> rather than public, so it is not reachable without
    /// reflection; every other menu's content is items or statistics rather than a string, so it is named by
    /// <see cref="ModalPresentedPayload.ModalType"/> and its words are declared as <c>screen</c>.
    /// </para>
    /// </summary>
    private static string? TextOf(IClickableMenu menu) => menu switch
    {
        LetterViewerMenu letter => Bounded(letter.mailMessage),
        DialogueBox box => Bounded(CurrentPageOf(box)),
        _ => null,
    };

    /// <summary>
    /// The page a box is showing, or null when the box cannot answer. <c>getCurrentString()</c> reads
    /// <c>dialogues</c> and <c>characterDialoguesBrokenUp</c> with no null guard (`DialogueBox.cs:712-728`), and a box
    /// the engine has mounted but not yet filled - or the half-built box a headless probe stands up - answers with a
    /// throw. The mount fact keeps its union either way: a box that cannot say what it holds is the `npc_dialogue_presented`
    /// pointer, not a lost tick.
    /// </summary>
    private static string? CurrentPageOf(DialogueBox box)
    {
        try
        {
            return box.getCurrentString();
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static string? Bounded(string? page)
    {
        string trimmed = page?.Trim() ?? string.Empty;
        if (trimmed.Length == 0)
            return null;
        return trimmed.Length <= MaximumTextChars ? trimmed : trimmed[..MaximumTextChars];
    }

    private static string? Bounded(List<string>? pages)
    {
        if (pages is null || pages.Count == 0)
            return null;
        string joined = string.Join(" ", pages).Trim();
        if (joined.Length == 0)
            return null;
        return joined.Length <= MaximumTextChars ? joined : joined[..MaximumTextChars];
    }

    private void PublishPresented(BridgeSession? session, IClickableMenu menu)
    {
        ModalPresentedPayload payload = Describe(menu, !this.timePasses());
        // Declared order, not the ordinal order `WireJson.Canonical` gives a frame's members - the same latitude as the
        // dismissed payload on the next method, and for the same stated reason: the frame carries this text as an opaque
        // string and every reader parses it (`WireJson` states the boundary).
        this.Publish(session, ModalPresentedPayload.Kind, "shown", JsonSerializer.Serialize(payload), payload.ModalType);
    }

    private void PublishDismissed(BridgeSession? session, IClickableMenu menu)
    {
        var payload = new ModalDismissedPayload(menu.GetType().Name);
        this.Publish(session, ModalDismissedPayload.Kind, "gone", JsonSerializer.Serialize(payload), payload.ModalType);
    }

    /// <summary>
    /// Emits one fact for one transition. <c>eventId</c>, <c>sourceEventId</c> and <c>deduplicationKey</c> are the same
    /// Mod-minted opaque identity - the tick the transition was seen plus a Mod-owned sequence - so a re-send inside the
    /// consumer's pending window collapses instead of reporting the transition twice.
    /// </summary>
    private void Publish(BridgeSession? session, string kind, string transition, string payloadJson, string modalType)
    {
        long tick = Game1.ticks;
        string eventId = $"modal_{transition}_{tick}_{Interlocked.Increment(ref mountSequence)}";
        var fact = new BridgeWorldFact(
            eventId,
            eventId,
            kind,
            tick,
            Game1.timeOfDay.ToString("D4"),
            session?.CurrentRevision ?? 0,
            payloadJson,
            eventId);

        if (session is null || !session.TryCreateWorldFactEvent(fact))
            this.monitor?.Log($"GameBuddy {kind} was not deliverable: eventId={eventId};modal_type={modalType}.", LogLevel.Trace);
    }
}
