using StardewModdingAPI;
using StardewValley;

namespace GameBuddy.Stardew;

/// <summary>
/// Owns native LAN hosting for exactly as long as the GameBuddy-launched
/// companion session is the current session.
///
/// The engine hosts by itself. <c>Multiplayer.updatePendingConnections()</c>
/// (<c>Multiplayer.cs:1777-1794</c>) starts the native server when this game is
/// already in the engine's own server mode (<c>Game1.multiplayerMode == 2</c>)
/// and the LAN option is on (<c>Game1.options.enableServer</c>). That method is
/// reached from <c>Game1.Update</c> on every loading frame (<c>Game1.cs:3891</c>,
/// gameMode 6, through <c>UpdateLoading</c>) and on every playing frame
/// (<c>Game1.cs:3895</c>, gameMode 3, through <c>UpdateEarly</c>), and
/// <c>UpdateEarly</c> additionally completes the host handshake for a loaded
/// hosted world (<c>Multiplayer.cs:1808-1811</c>). So this type never starts or
/// stops a server: it makes sure those two engine facts are true before the
/// engine reaches its own check, on every tick, and puts the player's own values
/// back when the session is over.
///
/// Consequences the Mod deliberately does not change: a hosted session binds the
/// engine's own LAN server across all interfaces with discovery enabled
/// (<c>Netcode/LidgrenServer.cs:104-113</c>). That is what lets the native
/// Farmhand join over the LAN, and it also makes this session visible on the
/// local network.
/// </summary>
internal sealed class CompanionSessionHosting
{
    /// <summary>The engine's own server mode for a LAN host (<c>Game1.multiplayerServer</c>).</summary>
    internal const byte ServerMultiplayerMode = 2;

    private readonly IMonitor monitor;
    private bool hosting;
    private bool playerOwnsTheOption;
    private bool previousEnableServer;
    private byte previousMultiplayerMode;
    private Options? appliedOptions;

    internal CompanionSessionHosting(IMonitor monitor)
    {
        this.monitor = monitor;
    }

    /// <summary>
    /// Reconcile the engine's live hosting state with this session's ownership.
    /// Idempotent: it writes only when the engine does not already have the
    /// values this session needs, and it records the player's own values exactly
    /// once, on the first call.
    /// </summary>
    internal void Observe()
    {
        Options? options = Game1.options;
        if (options is null)
            return;
        if (!this.hosting)
        {
            // Session start. What the engine holds right now is the player's own
            // value, and that is what has to come back when the session ends.
            this.hosting = true;
            this.previousEnableServer = options.enableServer;
            this.previousMultiplayerMode = Game1.multiplayerMode;
            this.ApplyHosting(options);
            this.monitor.Log("GameBuddy enabled the native LAN host option for this GameBuddy-launched companion session; the player's own value is put back when the session ends.", LogLevel.Info);
            return;
        }
        if (this.playerOwnsTheOption)
            return;
        if (!ReferenceEquals(options, this.appliedOptions))
        {
            // The engine replaces Game1.options while it loads a world
            // (SaveGame.cs:1142) and again when it resets to the title screen. A
            // new instance is the engine's own replacement, not the player
            // changing the setting, so hosting follows the new instance and is
            // re-applied to it.
            this.ApplyHosting(options);
            this.monitor.Log("GameBuddy re-applied the native LAN host option to the options object the engine loaded.", LogLevel.Info);
            return;
        }
        if (options.enableServer != true)
        {
            // The player turned the option off themselves. It is theirs again
            // from here on: the Mod neither re-asserts it while the session runs
            // nor puts its own value back when the session ends.
            this.playerOwnsTheOption = true;
            this.monitor.Log("GameBuddy left the native LAN host option to the player after they changed it themselves.", LogLevel.Info);
            return;
        }
        if (Game1.multiplayerMode != ServerMultiplayerMode)
        {
            this.ApplyHosting(options);
            this.monitor.Log("GameBuddy kept native LAN server mode on while this GameBuddy-launched companion session runs.", LogLevel.Info);
        }
    }

    /// <summary>
    /// Session end (the world was unloaded back to the title screen). Puts the
    /// player's own values back unless the player took the option over
    /// themselves, in which case what the player set is left exactly as it is.
    /// Idempotent: a second call does nothing, and a session that never hosted
    /// writes nothing at all.
    /// </summary>
    internal void End()
    {
        if (!this.hosting)
            return;
        Options? options = Game1.options;
        bool restoreThePlayer = !this.playerOwnsTheOption;
        this.hosting = false;
        this.appliedOptions = null;
        if (!restoreThePlayer)
        {
            this.monitor.Log("GameBuddy ended its companion session and left the native LAN host option as the player set it.", LogLevel.Info);
            return;
        }
        if (options is not null)
            options.enableServer = this.previousEnableServer;
        Game1.multiplayerMode = this.previousMultiplayerMode;
        this.monitor.Log("GameBuddy restored the player's own native LAN host option after its companion session ended.", LogLevel.Info);
    }

    private void ApplyHosting(Options options)
    {
        this.appliedOptions = options;
        options.enableServer = true;
        Game1.multiplayerMode = ServerMultiplayerMode;
    }
}
