using System;
using System.Reflection;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using StardewValley;

namespace GameBuddy.Stardew;

/// <summary>
/// send_multiplayer_chat: the companion says ONE line to the whole lobby through the
/// game's own chat egress, <c>Multiplayer.sendChatMessage(language, message, recipientID)</c>
/// (Multiplayer.cs:1127) addressed to <c>Multiplayer.AllPlayers</c>. That method owns the
/// branch (a client relays through <c>Game1.client.sendMessage</c> at :1131, a server fans
/// out at :1143) and owns the receiving client's word filter (:1156), so none of the three
/// is reproduced here.
///
/// The terminal proves the SEND and nothing more: the call reached the game without
/// throwing. It never claims that anyone received the line, and it deliberately does not
/// read <c>Game1.chatBox</c>, which is null on a client (:1153).
///
/// The action has no body, no geometry and no target: it takes exactly <c>{ text }</c>, it
/// moves nobody, opens no menu and touches no inventory or friendship.
/// </summary>
internal sealed partial class ExecutionManager
{
    /// <summary>
    /// The one chat-line bound, owned by the Core catalog because the WIRE validator reads it too: an argument the
    /// wire accepts but the handler refuses would be a registered capability that cannot be invoked. This name is an
    /// alias so callers on either side read the same number.
    /// </summary>
    internal const int ChatMessageMaximumLength = FarmhandActionCatalog.ChatMessageMaximumLength;

    /// <summary>
    /// Minimum interval between two accepted sends, owned by this Mod: the native path has
    /// no bound of its own, so without one a model can flood the lobby.
    /// </summary>
    internal const long ChatMessageMinimumIntervalMs = 2_000;

    /// <summary>
    /// Unix ms of the last send this ledger allowed. Mod-owned state, armed by the ATTEMPT
    /// (before the native call) so an uncertain send still holds the interval instead of
    /// letting an immediate retry post the line twice. 0 means never.
    /// </summary>
    private long lastChatSendUnixMs;

    /// <summary>
    /// Sends one line to the whole lobby through the game's own egress. Refusals, by name:
    /// <c>chat_multiplayer_only</c> when there is no lobby, <c>chat_message_invalid</c> for
    /// empty/blank or over-long text, <c>chat_rate_limited</c> inside the minimum interval
    /// (with <c>retry_after_ms</c>), and <c>chat_egress_unavailable</c> when the game's own
    /// static egress cannot be resolved.
    /// </summary>
    public LocalExecutionReceipt RequestLocalSendMultiplayerChat(string requestId, string text, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is LocalExecutionReceipt rejection) return rejection;

        // The engine's own topology decides whether there is a lobby to speak to and which
        // side of it this Mod is on. `Game1.IsMultiplayer` is NOT that gate: it is
        // `otherFarmers.Count > 0` (Game1.cs:1799), so a host whose partner has not
        // connected yet reads as single player.
        string? role = Game1.IsClient ? "client" : Game1.IsServer ? "server" : null;
        if (role is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "chat_multiplayer_only",
                $"role=none;multiplayer_mode={Game1.multiplayerMode}");

        if (string.IsNullOrWhiteSpace(text) || text.Length > ChatMessageMaximumLength)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "chat_message_invalid",
                $"length={text.Length};maximum_length={ChatMessageMaximumLength}");

        long retryAfterMs = this.lastChatSendUnixMs + ChatMessageMinimumIntervalMs - nowMs;
        if (retryAfterMs > 0)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "chat_rate_limited",
                $"retry_after_ms={retryAfterMs};minimum_interval_ms={ChatMessageMinimumIntervalMs}");

        if (!TryResolveMultiplayerEgress(out Multiplayer? multiplayer))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "chat_egress_unavailable",
                "field=Game1.multiplayer");

        this.lastChatSendUnixMs = nowMs;
        try
        {
            multiplayer!.sendChatMessage(LocalizedContentManager.CurrentLanguageCode, text, Multiplayer.AllPlayers);
        }
        catch (Exception nativeException)
        {
            // The line may or may not have left the process, so this is Uncertain - never a
            // success (nobody can claim the send happened) and never a retryable refusal.
            return this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "chat_message_native_exception",
                $"length={text.Length};role={role};native_exception={nativeException.GetType().Name}");
        }

        return this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "chat_message_sent",
            $"recipient=all_players;length={text.Length};role={role};sent=true");
    }

    /// <summary>
    /// The game's own static <c>Multiplayer</c> instance, resolved through the exact field
    /// identity the existing native-chat egress already pins (ModEntry.cs:2336): the field is
    /// not public from a Mod assembly, so it is reflected, and any drift in its name, type or
    /// staticness fails closed rather than binding a different member.
    /// </summary>
    private static bool TryResolveMultiplayerEgress(out Multiplayer? multiplayer)
    {
        FieldInfo? field = typeof(Game1).GetField("multiplayer", BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public);
        multiplayer = NativeChatPresentationPolicy.IsExactMultiplayerField(field) ? field!.GetValue(null) as Multiplayer : null;
        return multiplayer is not null;
    }
}
