using System.Text.Json.Serialization;

namespace GameBuddy.Stardew.Core.Models;

/// <summary>
/// One selectable answer the game is currently offering on a question dialogue,
/// in the native <c>Response</c> shape (<c>responseKey</c> + <c>responseText</c>,
/// Response.cs:7-9). <see cref="Key"/> is the exact token an
/// <c>answer_dialogue</c> request must carry back.
/// </summary>
public sealed record NpcDialogueChoice(
    [property: JsonPropertyName("key")] string Key,
    [property: JsonPropertyName("text")] string Text);

/// <summary>
/// Payload of the <c>npc_dialogue_presented</c> world fact: the whole text of
/// one native dialogue box (every page, in the order the game showed them) plus,
/// when the box stopped on a question, the answers it is offering.
///
/// The Mod owns this fact because the pages only exist inside the native
/// <c>DialogueBox</c>: the box is driven to exhaustion by the game's own pager,
/// so the fact describes text the game actually presented rather than text the
/// Mod reconstructed.
/// </summary>
public sealed record NpcDialoguePresentedPayload(
    [property: JsonPropertyName("speaker")] string Speaker,
    [property: JsonPropertyName("pages")] IReadOnlyList<string> Pages,
    [property: JsonPropertyName("isQuestion")] bool IsQuestion,
    [property: JsonPropertyName("choices")] IReadOnlyList<NpcDialogueChoice> Choices)
{
    /// <summary>The world-fact kind this payload belongs to.</summary>
    public const string Kind = "npc_dialogue_presented";
}
