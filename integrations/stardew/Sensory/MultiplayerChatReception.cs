using System;
using System.Text.Json;
using System.Threading;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using StardewModdingAPI;
using StardewValley;

namespace GameBuddy.Stardew.Sensory;

/// <summary>
/// ONE CHAT LINE ANOTHER PLAYER SENT, published as one <c>multiplayer_chat</c> world fact the moment the companion's own
/// client receives it.
///
/// <para>
/// WHY THE HOOK IS <c>Multiplayer.receiveChatMessage</c> AND NOT THE CHAT BOX. The engine's receive path is
/// <c>Multiplayer.processIncomingMessage</c> case 10 (<c>Multiplayer.cs:1649-1656</c>), which deserializes the recipient,
/// language and text and hands them to <c>receiveChatMessage</c> (<c>:1151</c>). THAT method is the reception: it applies
/// the word filter, decides lobby-vs-private and then forwards to <c>Game1.chatBox.receiveChatMessage</c> - INSIDE
/// <c>if (Game1.chatBox != null)</c> (<c>:1153</c>). Hooking the box, or reading it, would therefore be a second hook that
/// never fires on the one screen this matters on: the box is built by <c>Game1.loadForNewGame</c>
/// (<c>Game1.cs:3362</c>), which a client that JOINS a hosted world does not run, and this repository already records
/// that it is null there (<c>farmhandexecutioncontroller.chatactions.cs:19</c>). Observing <c>receiveChatMessage</c> itself
/// is upstream of that guard, so the fact exists whether or not her screen draws a chat box.
/// </para>
///
/// <para>
/// WHY NOT THE TYPING PATH. The Mod's other chat hook is a Harmony postfix on <c>ChatBox.textBoxEnter</c>
/// (<c>ModEntry.cs:508</c>), which fires on the machine whose player TYPED - the Host's. A line the Host types or a script
/// sends never visits another machine's text box, so nothing that player says is observed on her side. This channel is
/// the other direction of the same conversation, and it is the direction the Host cannot observe for her.
/// </para>
///
/// <para>
/// WHOSE LINES THESE ARE. The engine never delivers a client's own line back to it: the server relays a chat message
/// through <c>rebroadcastClientMessage</c> with <c>key != message.FarmerID</c> (<c>GameServer.cs:743-753</c>), and the
/// local echo a typing player sees is written straight to their own box. So every line published here was spoken by
/// someone else, which is why the payload names a speaker instead of an audience. The speaker's name is the engine's own
/// <c>Farmer.Name</c> off the message's <c>SourceFarmer</c> (<c>Multiplayer.cs:1654</c>) - the same object the box title
/// reads - and a name the engine answers nothing for is published as
/// <see cref="MultiplayerChatPayload.SpeakerNotMeasured"/> rather than as an empty string.
/// </para>
///
/// <para>
/// WHAT IT REFUSES. Nothing here mutates the world, the box or the message: the hook is a prefix, the line still reaches
/// whatever presentation the engine gives it, and a failed publication costs the fact and never the chat. Two things are
/// not facts: an EMPTY message (the engine's own box ignores one too, <c>ChatBox.cs:112-115</c>) publishes nothing, and a
/// line past <see cref="FarmhandActionCatalog.ChatMessageMaximumLength"/> is published as its verbatim prefix with
/// <c>textTruncated</c> set rather than silently shortened (a chat line is gone once it scrolls, so a silent cut would be
/// a word nobody could recover).
/// </para>
/// </summary>
internal static class MultiplayerChatReception
{
    /// <summary>
    /// The Mod-owned tiebreaker in the identity, for the same reason the modal observer carries one: <c>Game1.ticks</c> is
    /// unique per <c>Update</c> only while the game is not loading incrementally (<c>Game1.cs:3911-3914</c>), and two lines
    /// can arrive inside one tick.
    /// </summary>
    private static long sequence;

    /// <summary>
    /// Publish one received line on the authenticated bridge, or nothing when there is no session to publish on.
    ///
    /// <para>
    /// Called from the Harmony prefix on <c>Multiplayer.receiveChatMessage</c>, on the game thread, with the engine's own
    /// arguments: a null <paramref name="sourceFarmer"/> is a message the engine could not attribute
    /// (<c>IncomingMessage.SourceFarmer</c> answers <c>Game1.GetPlayer(farmerID) ?? Game1.MasterPlayer</c>, so a null means
    /// no world to resolve it against) and is published with the speaker unmeasured rather than dropped.
    /// </para>
    /// </summary>
    internal static bool PublishReceived(
        BridgeSession? session,
        Farmer? sourceFarmer,
        long recipientID,
        string? message,
        IMonitor? monitor)
    {
        if (string.IsNullOrEmpty(message))
            return false;

        string text = message;
        bool truncated = text.Length > FarmhandActionCatalog.ChatMessageMaximumLength;
        if (truncated)
            text = text[..FarmhandActionCatalog.ChatMessageMaximumLength];

        string speaker = string.IsNullOrWhiteSpace(sourceFarmer?.Name)
            ? MultiplayerChatPayload.SpeakerNotMeasured
            : sourceFarmer!.Name;
        var payload = new MultiplayerChatPayload(
            speaker,
            text,
            truncated,
            // The engine's own lobby-vs-private distinction, read before it collapses into a display colour: a recipient
            // of `Multiplayer.AllPlayers` is the whole lobby, anything else is a message to ONE player - and the server
            // only ever forwards such a message to its addressee (`GameServer.cs:726`), so on this client "not the lobby"
            // is "addressed to her".
            recipientID != Multiplayer.AllPlayers,
            Game1.Date?.TotalDays ?? 0);

        long tick = Game1.ticks;
        string eventId = $"multiplayer_chat_{tick}_{Interlocked.Increment(ref sequence)}";
        var fact = new BridgeWorldFact(
            eventId,
            eventId,
            MultiplayerChatPayload.Kind,
            tick,
            Game1.timeOfDay.ToString("D4"),
            session?.CurrentRevision ?? 0,
            JsonSerializer.Serialize(payload),
            eventId);

        if (session is not null && session.TryCreateWorldFactEvent(fact))
            return true;
        monitor?.Log($"GameBuddy multiplayer_chat was not deliverable: eventId={eventId};speaker={speaker}.", LogLevel.Trace);
        return false;
    }
}
