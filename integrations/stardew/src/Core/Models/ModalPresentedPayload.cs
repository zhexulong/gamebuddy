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
/// WHAT IT DOES NOT CARRY: a dialogue box's words. Those belong to <c>npc_dialogue_presented</c>
/// (<see cref="NpcDialoguePresentedPayload"/>), which publishes every page the game's own pager actually showed;
/// repeating them here would be the second copy of one piece of prose. What this fact adds for a dialogue is the MOUNT -
/// that something is on her screen, whether it is waiting on an answer, and which keys it offers - which is knowable the
/// tick the box appears, while the words are only knowable once the box has been driven to a readable page.
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
    [property: JsonPropertyName("text")] string? Text)
{
    /// <summary>The world-fact kind this payload belongs to.</summary>
    public const string Kind = "modal_presented";
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
