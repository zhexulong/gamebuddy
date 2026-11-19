using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace GameBuddy.Stardew.Core.Models;

/// <summary>
/// Payload of the <c>modal_presented</c> world fact: one menu the engine mounted on the companion's screen, described
/// in the engine's own terms.
///
/// <para>
/// WHY THIS IS A FACT AND NOT A SNAPSHOT FIELD. The companion called <c>stardew_observe</c> four times in the 44 minutes
/// of the last live run, so every modal the engine raised between those calls - the shipping settlement, a level-up, a
/// letter, a shop counter, the <c>GameMenu</c> - reached her only if she happened to ask. <c>actorDispositionKind</c> and
/// <c>actorDispositionDetail</c> carry the same information on the wire, but a snapshot is a READING she must request
/// while a mount is NEWS she must not be able to miss.
/// </para>
///
/// <para>
/// WHAT IT CARRIES, AND WHAT IT DOES NOT. <c>text</c> is the modal's OWN words as read at the mount
/// (<see cref="ModalPresentedPayload.TextOwner.Carried"/>), and <c>textFrom</c> says which of the three places they came
/// from. A dialogue box's words are read from <c>getCurrentString()</c> - the page the box is showing the tick it appears -
/// while the paged-through transcript and the side effects it runs stay with <c>npc_dialogue_presented</c>; the two are
/// readings at two times, exactly as `isQuestion` is, and the mount page is the one the companion can still react to.
/// </para>
///
/// <para>
/// <see cref="BlocksTimePass"/> is the engine's own <c>Game1.shouldTimePass()</c> inverted, read at the mount. It is
/// what makes a <c>BobberBar</c> (which the engine frees from that clause, <c>Game1.cs:9303</c>) different from the
/// <c>ShippingMenu</c> that held a FarmHouse for 31 minutes while the clock stood still.
/// </para>
/// </summary>
public sealed record ModalPresentedPayload(
    [property: JsonPropertyName("modalType")] string ModalType,
    [property: JsonPropertyName("isQuestion")] bool IsQuestion,
    [property: JsonPropertyName("responseKeys")] IReadOnlyList<string> ResponseKeys,
    [property: JsonPropertyName("blocksTimePass")] bool BlocksTimePass,
    [property: JsonPropertyName("text")] string? Text,
    [property: JsonPropertyName("textFrom")] string TextFrom)
{
    /// <summary>The world-fact kind this payload belongs to.</summary>
    public const string Kind = "modal_presented";

    /// <summary>
    /// The three answers to "where are this modal's words", declared once so a fact can never leave the question open.
    ///
    /// <para>
    /// MEASURED 2026-11-19 (`1795084536`-`1795084558`): the Marlon cutscene published six `modal_presented (DialogueBox,
    /// text: null)` facts and the words only ever appeared in the `npc_dialogue_presented` fact beside them - so "a box is
    /// open" arrived with nothing to say about what was in it, and a model reading the line could not tell whether the box
    /// was empty, unreadable, or simply the one kind whose prose lives elsewhere. `null` was all three at once.
    /// </para>
    /// <para>
    /// <see cref="Carried"/> is a fact that READ the words at the mount (`DialogueBox.getCurrentString`, a letter's own
    /// prose). <see cref="DialogueFact"/> is a box whose words belong to another fact, which this one names so the reader
    /// can go and get them. <see cref="Screen"/> is a menu whose content is what is drawn on it (items, statistics,
    /// options) and which therefore holds no prose at all - a true answer, and a different one from silence.
    /// </para>
    /// </summary>
    public static class TextOwner
    {
        /// <summary>This fact carries the words it just read.</summary>
        public const string Carried = "modal";

        /// <summary>The words belong to the fact named here, and this one points at it.</summary>
        public const string DialogueFact = "npc_dialogue_presented";

        /// <summary>The menu's content is the screen itself: it holds no prose for any fact to carry.</summary>
        public const string Screen = "screen";

        /// <summary>Every word a projection may publish, so a gate can check one declaration against the other.</summary>
        public static IReadOnlyList<string> All { get; } = System.Array.AsReadOnly(new[] { Carried, DialogueFact, Screen });
    }
}

/// <summary>
/// Payload of the <c>modal_dismissed</c> world fact: the menu that is no longer on the companion's screen.
///
/// <para>
/// The engine's type name is the whole content on purpose. An unmount that nobody publishes is how a stale snapshot
/// looks like a living menu - the last reading she had seen said a <c>ShippingMenu</c> owned the screen, and nothing
/// told her it had gone. Naming the type is what retires it.
/// </para>
/// </summary>
public sealed record ModalDismissedPayload(
    [property: JsonPropertyName("modalType")] string ModalType)
{
    /// <summary>The world-fact kind this payload belongs to.</summary>
    public const string Kind = "modal_dismissed";
}
