using StardewModdingAPI;
using StardewValley;
using StardewValley.Menus;

namespace GameBuddy.Stardew;

/// <summary>
/// Formal Player Host native world creation (Loop 4 path B').
///
/// The private bootstrap composer stages <c>WorldCreation</c> into the Player
/// Host profile's config.json. At the main menu this drives the game's own
/// new-game entry exactly once and then observes the physical slot basename the
/// game assigned, so the Host can consume it as an opaque world binding ref.
///
/// It is a production path, deliberately decoupled from the fixture bootstrap:
/// unlike <see cref="NativeLocalPlayerFixtureConfig"/> it is never gated by a
/// fixture save name, never produces fixture evidence, and never rewrites the
/// staged config. It reuses only the native setup sequence
/// (<c>resetPlayer</c> / <c>SetSaveName</c> / the player identity fields) that
/// the fixture bootstrap established.
/// </summary>
internal sealed class WorldCreationBootstrap
{
    private readonly WorldCreationConfig config;
    private readonly IMonitor monitor;
    private bool creationRequested;
    private bool terminal;

    internal WorldCreationBootstrap(WorldCreationConfig config, IMonitor monitor)
    {
        this.config = config;
        this.monitor = monitor;
    }

    /// <summary>
    /// True while the Mod may still drive the one native creation. Once a world
    /// has been created and observed, or an attempt has failed closed, it stays
    /// false for the rest of the process.
    /// </summary>
    internal bool IsArmed => !this.terminal && this.ObservedSaveSlot.Length == 0;

    /// <summary>
    /// Physical slot basename the game assigned to the created world. Empty
    /// until <see cref="TryComplete"/> observed it. It is a basename only: it
    /// never contains an absolute path, a PID or a token.
    /// </summary>
    internal string ObservedSaveSlot { get; private set; } = string.Empty;

    /// <summary>
    /// Main-menu tick. Requests exactly one native new-game creation when the
    /// title menu is live, no world exists yet, and the requested save name is
    /// still free. Idempotent: a second call after a successful request is a
    /// no-op, and an already-existing save is refused instead of overwritten.
    /// </summary>
    internal void TryCreate()
    {
        if (!this.IsArmed || this.creationRequested)
            return;
        if (Context.IsWorldReady || Game1.hasLoadedGame)
        {
            this.FailClosed("a world was already loaded before native creation began");
            return;
        }
        if (Game1.activeClickableMenu is not TitleMenu titleMenu)
            return;
        string requestedSaveName = this.config.FarmName;
        string requestedFilteredName = FilterSaveName(requestedSaveName);
        if (requestedFilteredName.Length == 0)
        {
            this.FailClosed("the configured farm name has no native save identity");
            return;
        }
        // An already-existing save must never be silently reported as created,
        // and it must never be overwritten by a second world. This is also the
        // guard that keeps a fresh process (which re-reads the same staged
        // request) from creating a duplicate after the first world exists.
        if (SaveGame.IsNewGameSaveNameCollision(requestedSaveName))
        {
            this.FailClosed($"the requested native save name '{requestedFilteredName}' already exists");
            return;
        }
        try
        {
            Game1.resetPlayer();
            Game1.SetSaveName(requestedSaveName);
            Game1.player.Name = this.config.PlayerName;
            Game1.player.farmName.Value = requestedSaveName;
            Game1.player.favoriteThing.Value = this.config.FavoriteThing;
            if (!string.Equals(Game1.GetSaveGameName(set_value: false), requestedSaveName, StringComparison.Ordinal))
                throw new InvalidOperationException("world_creation_native_save_name_resolution_failed");
            // createdNewCharacter() switches into native loading before SMAPI
            // raises SaveLoaded. Record the request first so that expected
            // intermediate state is never mistaken for a second attempt.
            this.creationRequested = true;
            titleMenu.createdNewCharacter(skipIntro: true);
            this.monitor.Log("GameBuddy requested formal Player Host native world creation; waiting for native SaveLoaded.", LogLevel.Info);
        }
        catch (Exception exception)
        {
            this.FailClosed($"native world creation failed: {exception.GetType().Name}");
        }
    }

    /// <summary>
    /// SaveLoaded completion. Records the observed physical slot basename only
    /// when the loaded world matches the requested identity. Returns true once
    /// the created world has been observed.
    /// </summary>
    internal bool TryComplete()
    {
        if (this.ObservedSaveSlot.Length != 0)
            return true;
        if (!this.creationRequested)
            return false;
        if (!Context.IsWorldReady || !Game1.hasLoadedGame || Game1.player is null || Context.IsMultiplayer || !Game1.IsMasterGame)
        {
            this.FailClosed("the created world is not a single-player master local player");
            return false;
        }
        string requestedFilteredName = FilterSaveName(this.config.FarmName);
        string observedLogicalName = FilterSaveName(Game1.GetSaveGameName(set_value: false));
        if (!string.Equals(observedLogicalName, requestedFilteredName, StringComparison.Ordinal))
        {
            this.FailClosed("the observed native save identity differs from the requested world identity");
            return false;
        }
        // Same observed-slot shape the fixture bootstrap records and validates:
        // the filtered native save identity plus the game's own unique ID.
        this.ObservedSaveSlot = $"{requestedFilteredName}_{Game1.uniqueIDForThisGame}";
        this.monitor.Log($"GameBuddy observed the created Player Host world slot '{this.ObservedSaveSlot}'.", LogLevel.Info);
        return true;
    }

    /// <summary>
    /// ReturnedToTitle. Native creation is single-shot for the life of the
    /// process: once the game has been asked to create a world, returning to the
    /// title screen must never create a second one. A fresh process re-reads the
    /// staged request and is stopped by the native save-name collision guard.
    /// </summary>
    internal void OnReturnedToTitle()
    {
        if (!this.creationRequested)
            return;
        this.monitor.Log("GameBuddy kept formal Player Host world creation single-shot after returning to the title screen.", LogLevel.Info);
    }

    /// <summary>
    /// The native save identity the game derives from the configured farm name.
    /// It mirrors the fixture bootstrap's own filter so the observed slot stays
    /// inside the Host's opaque binding-ref alphabet (letters, digits, '_').
    /// </summary>
    private static string FilterSaveName(string value) =>
        new(value.Where(char.IsLetterOrDigit).ToArray());

    private void FailClosed(string reason)
    {
        if (this.terminal)
            return;
        this.terminal = true;
        this.monitor.Log($"GameBuddy formal Player Host world creation failed closed: {reason}.", LogLevel.Error);
    }
}
