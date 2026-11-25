using System.Text.Json.Serialization;

namespace GameBuddy.Stardew.Core.Models;

/// <summary>
/// Payload of the <c>multiplayer_chat</c> world fact: one chat line ANOTHER PLAYER sent, as the companion's own client
/// received it.
///
/// <para>
/// THE PERCEPTION THAT WAS MISSING. A co-op companion stood next to a human who typed into the lobby and had no fact that
/// said a word had been spoken: the snapshot carries no chat family (<c>protocol/bridge-v1.schema.json</c>), and the
/// Mod's one chat ingress is a Harmony postfix on the HOST's <c>ChatBox.textBoxEnter</c> (<c>ModEntry.cs:508</c>) - the
/// typing path, which only ever fires on the machine whose player typed. A line spoken by the Host reaches her client
/// through the engine's network receive (<c>Multiplayer.receiveChatMessage</c>, Multiplayer.cs:1151), and nothing
/// published it.
/// </para>
///
/// <para>
/// WHY A FACT AND NOT A SNAPSHOT FIELD. Chat is an occurrence, not a state: it has a speaker, a moment and an
/// audience, and it is over. A snapshot field would have to answer "what is chat now" - the engine's own history is a
/// ten-line ring the box drops on its own clock, so the reading would be a window that closes between two observations,
/// and a line spoken while she was not looking would never be stated at all. The fact stream is what this Mod already
/// uses for the other things that HAPPEN to her rather than around her (<c>npc_dialogue_presented</c>,
/// <c>native_notice</c>, <c>modal_presented</c>), and a fact carries its own clock, tick, revision and dedupe identity so
/// a reader can order it against everything else it was told.
/// </para>
///
/// <para>
/// WHY NOT A SECOND <c>npc_dialogue_presented</c>. That fact is the engine's DIALOGUE BOX - pages, responses, the side
/// effects the box runs when a page advances. A lobby chat line is not a box, is not paged, and is not the companion's to
/// act on; publishing it under the dialogue kind would make every refusal that reads "a dialogue is up" true.
/// </para>
///
/// <para>
/// THE CLOCK IS THE FACT'S OWN. <see cref="BridgeWorldFact.GameTime"/> carries <c>Game1.timeOfDay</c> at receipt - the
/// same integer the snapshot publishes - so this payload does not spell it a second time; a reader renders it with the
/// one function that formats a clock. <see cref="Day"/> is here because <c>gameTime</c> cannot carry it: a line heard at
/// 01:50 belongs to the night the reader is standing in, and "0150" alone does not say which.
/// </para>
///
/// <para>
/// <see cref="TextTruncated"/> EXISTS BECAUSE A CHAT LINE IS GONE ONCE IT SCROLLS. The engine puts no length limit on what
/// a player types, and this wire refuses a payload past 8 KB, so the text is bounded at
/// <see cref="FarmhandActionCatalog.ChatMessageMaximumLength"/> - the same bound the <c>send_multiplayer_chat</c> action
/// argues. A bound that shortened the word without saying so would leave a reader quoting a sentence nobody said; the
/// flag says the text is the verbatim PREFIX rather than the whole line.
/// </para>
/// </summary>
public sealed record MultiplayerChatPayload(
    [property: JsonPropertyName("speaker")] string Speaker,
    [property: JsonPropertyName("text")] string Text,
    [property: JsonPropertyName("textTruncated")] bool TextTruncated,
    [property: JsonPropertyName("addressedToThisPlayer")] bool AddressedToThisPlayer,
    [property: JsonPropertyName("day")] int Day)
{
    /// <summary>The world-fact kind this payload belongs to.</summary>
    public const string Kind = "multiplayer_chat";

    /// <summary>
    /// The speaker's name when the engine's own <c>Farmer.Name</c> answered nothing - the word this wire already uses for
    /// a fact that could not be measured, rather than an empty string a reader would render as an anonymous voice.
    /// </summary>
    public const string SpeakerNotMeasured = "not_measured";
}
