namespace GameBuddy.Stardew;

/// <summary>
/// Narrow Host-human-to-bound-Farmhand chat ingress message. It is carried only by SMAPI
/// ModMessage and becomes a bridge fact only after the receiving Farmhand has
/// revalidated the live native scope and its authenticated bridge generation.
/// </summary>
internal static class PlayerControlProtocol
{
    internal const string MessageType = "gamebuddy.player_control.v1";
    internal const string PlayerInput = "player_input";
    internal const string StopAll = "stop_all";
    internal const int MaximumTextLength = 4_000;

    internal static bool IsValid(PlayerControlModMessage? message, out string reasonCode)
    {
        if (message is null
            || !BridgeProtocol.IsOpaqueId(message.MessageId)
            || !BridgeProtocol.IsOpaqueId(message.IssuerPlayerId)
            || message.Scope is null
            || !message.Scope.IsValid
            || message.Scope.IntegrationId != "stardew"
            || !BridgeProtocol.IsOpaqueId(message.ControlId)
            || !BridgeProtocol.IsOpaqueId(message.SourceEventId)
            || message.Locale is null
            || !IsLocale(message.Locale))
        {
            reasonCode = "player_control_invalid";
            return false;
        }
        if (message.Kind == PlayerInput)
        {
            if (string.IsNullOrWhiteSpace(message.Text) || message.Text.Length > MaximumTextLength)
            {
                reasonCode = "player_control_invalid";
                return false;
            }
        }
        else if (message.Kind == StopAll)
        {
            if (message.Text is not null)
            {
                reasonCode = "player_control_invalid";
                return false;
            }
        }
        else
        {
            reasonCode = "player_control_unknown";
            return false;
        }
        reasonCode = "accepted";
        return true;
    }

    private static bool IsLocale(string value) => value.Length is >= 2 and <= 64
        && System.Text.RegularExpressions.Regex.IsMatch(value, "^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,16}){0,3}$");
}

internal sealed record PlayerControlModMessage(
    string MessageId,
    string IssuerPlayerId,
    BridgeScope Scope,
    string Kind,
    string ControlId,
    string SourceEventId,
    string? Text,
    string Locale);

/// <summary>
/// Exact replay rejection for the authenticated Farmhand bridge session. Control
/// messages are sparse and originate only from the bound Host player; eviction
/// would allow an old STOP or player input to regain authority later in the session.
/// </summary>
internal sealed class PlayerControlReplayGuard
{
    private readonly HashSet<string> consumed = new(StringComparer.Ordinal);

    /// <summary>
    /// Atomically consumes one command identity for this authenticated bridge
    /// session. A pipe write can be interrupted after queue admission without
    /// yielding a reliable end-to-end acknowledgement; fail closed rather than
    /// allowing an old authenticated STOP/player-input to gain authority again.
    /// The player can issue a new native command, which mints a new identity.
    /// </summary>
    internal bool TryConsume(string messageId)
    {
        lock (this)
            return this.consumed.Add(messageId);
    }

    internal bool Contains(string messageId)
    {
        lock (this)
            return this.consumed.Contains(messageId);
    }
}
