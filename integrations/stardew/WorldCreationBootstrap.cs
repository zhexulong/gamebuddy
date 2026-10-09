using StardewModdingAPI;
using StardewValley;
using StardewValley.Menus;

namespace GameBuddy.Stardew;

/// <summary>
/// Formal Player Host native world entry (Loop 4 path B').
///
/// The private bootstrap composer stages <c>WorldCreation</c> into the Player
/// Host profile's config.json. At the main menu this resolves that request into
/// exactly one native entry and then observes the physical slot basename the
/// game assigned, so the Host can consume it as an opaque world binding ref:
///
/// * the request's own world does not exist yet → drive the game's own new-game
///   entry once (<c>TitleMenu.createdNewCharacter</c>), exactly as before;
/// * the request's own world already exists → enter that exact save through the
///   native load path the save list itself uses (<c>SaveGame.Load</c> followed by
///   <c>Game1.exitActiveMenu</c>, <c>LoadGameMenu.SaveFileSlot.Activate</c>);
/// * anything else (a save that is not identity-equal to this request, more than
///   one candidate, or an unreadable save list) → fail closed.
///
/// It never creates a second world, never overwrites a save, and never adopts a
/// save it cannot identify as this request's own (see
/// <see cref="WorldCreationDecision"/> for that rule).
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
    private readonly Func<IReadOnlyList<WorldSaveIdentity>?> readExistingWorlds;
    private readonly Action<string> requestNativeWorldEntry;
    private bool nativeEntryRequested;
    private bool creationRequested;
    private bool terminal;

    internal WorldCreationBootstrap(
        WorldCreationConfig config,
        IMonitor monitor,
        Func<IReadOnlyList<WorldSaveIdentity>?>? readExistingWorlds = null,
        Action<string>? requestNativeWorldEntry = null)
    {
        this.config = config;
        this.monitor = monitor;
        // The two native edges are injectable so the decision and the state
        // machine above them stay testable: enumerating the player's real save
        // folder and performing a native save load both need the live game, and
        // neither is driven from a unit test.
        this.readExistingWorlds = readExistingWorlds ?? WorldSaveIndex.ReadAll;
        this.requestNativeWorldEntry = requestNativeWorldEntry ?? RequestNativeWorldEntry;
    }

    /// <summary>
    /// True while the Mod may still drive the one native entry. Once a world has
    /// been entered and observed, or an attempt has failed closed, it stays
    /// false for the rest of the process.
    /// </summary>
    internal bool IsArmed => !this.terminal && this.ObservedSaveSlot.Length == 0;

    /// <summary>
    /// Physical slot basename the game assigned to the world this request owns.
    /// Empty until <see cref="TryComplete"/> observed it. It is a basename only:
    /// it never contains an absolute path, a PID or a token.
    /// </summary>
    internal string ObservedSaveSlot { get; private set; } = string.Empty;

    /// <summary>
    /// The exact physical slot the Mod asked the native load to enter. Empty
    /// while the Mod has not asked for an existing world (it asked for a new
    /// game instead, or it has not asked for anything yet).
    /// </summary>
    internal string RequestedEntrySlot { get; private set; } = string.Empty;

    /// <summary>
    /// Main-menu tick. Resolves the staged request into exactly one native entry
    /// (create, or enter the save this request already created) once the title
    /// menu is live and no world exists yet. Idempotent: a second call after a
    /// successful request is a no-op, and a request that cannot be answered
    /// unambiguously fails closed without creating or loading anything.
    /// </summary>
    internal void TryCreate()
    {
        if (!this.IsArmed || this.nativeEntryRequested)
            return;
        if (Context.IsWorldReady || Game1.hasLoadedGame)
        {
            this.FailClosed("a world was already loaded before native entry began");
            return;
        }
        if (WorldCreationDecision.FilterSaveName(this.config.FarmName).Length == 0)
        {
            this.FailClosed("the configured farm name has no native save identity");
            return;
        }
        if (Game1.activeClickableMenu is not TitleMenu titleMenu)
            return;
        // The decision is made once, on the first tick that the title screen
        // owns the screen — the same boundary the native save list itself is
        // driven from. It reads the saves folder once and has no side effect.
        WorldCreationPlan plan = WorldCreationDecision.Decide(this.config, this.readExistingWorlds());
        if (plan.Outcome == WorldCreationOutcome.Refuse)
        {
            this.FailClosed(plan.Reason);
            return;
        }
        if (plan.Outcome == WorldCreationOutcome.EnterExistingWorld)
        {
            this.EnterExistingWorld(plan.SlotName);
            return;
        }
        this.CreateNewWorld(titleMenu);
    }

    /// <summary>
    /// SaveLoaded completion. Records the observed physical slot basename only
    /// when the loaded world matches the requested identity — and, when this
    /// process entered an existing save, only when it is the exact save that was
    /// entered. Returns true once the world this request owns has been observed.
    /// </summary>
    internal bool TryComplete()
    {
        if (this.ObservedSaveSlot.Length != 0)
            return true;
        if (!this.nativeEntryRequested)
            return false;
        // Game1.IsMasterGame is the engine's own "this process is the main/host
        // player" fact: true for a single-player world and for the host of a
        // hosted one, false for a farmhand that joined someone else's world.
        // Context.IsMultiplayer is deliberately not consulted here: a GameBuddy
        // session hosts its own LAN server, so being multiplayer is expected
        // rather than a sign that this is a world this process did not produce.
        if (!Context.IsWorldReady || !Game1.hasLoadedGame || Game1.player is null || !Game1.IsMasterGame)
        {
            this.FailClosed("the loaded world is not this process's own master world");
            return false;
        }
        string requestedFilteredName = WorldCreationDecision.FilterSaveName(this.config.FarmName);
        string observedLogicalName = WorldCreationDecision.FilterSaveName(Game1.GetSaveGameName(set_value: false));
        if (!string.Equals(observedLogicalName, requestedFilteredName, StringComparison.Ordinal))
        {
            this.FailClosed("the observed native save identity differs from the requested world identity");
            return false;
        }
        // Same observed-slot shape the fixture bootstrap records and validates:
        // the filtered native save identity plus the game's own unique ID.
        string observedSaveSlot = $"{requestedFilteredName}_{Game1.uniqueIDForThisGame}";
        if (this.RequestedEntrySlot.Length != 0
            && !string.Equals(observedSaveSlot, this.RequestedEntrySlot, StringComparison.Ordinal))
        {
            this.FailClosed("the world that finished loading is not the exact save this request entered");
            return false;
        }
        this.ObservedSaveSlot = observedSaveSlot;
        this.monitor.Log($"GameBuddy observed the created Player Host world slot '{this.ObservedSaveSlot}'.", LogLevel.Info);
        return true;
    }

    /// <summary>
    /// ReturnedToTitle. Native entry is single-shot for the life of the process:
    /// once the game has been asked to create or enter a world, returning to the
    /// title screen must never drive a second one. A fresh process re-reads the
    /// staged request and is answered by
    /// <see cref="WorldCreationDecision"/> instead of creating a duplicate.
    /// </summary>
    internal void OnReturnedToTitle()
    {
        if (!this.nativeEntryRequested)
            return;
        string entry = this.creationRequested ? "creation" : $"entry of '{this.RequestedEntrySlot}'";
        this.monitor.Log($"GameBuddy kept formal Player Host world {entry} single-shot after returning to the title screen.", LogLevel.Info);
    }

    /// <summary>
    /// Drive the game's own new-game entry. The game's own collision guard is
    /// re-checked here as the creation authority: a duplicate world must remain
    /// impossible even if a save appeared after the decision above.
    /// </summary>
    private void CreateNewWorld(TitleMenu titleMenu)
    {
        string requestedSaveName = this.config.FarmName;
        if (SaveGame.IsNewGameSaveNameCollision(requestedSaveName))
        {
            this.FailClosed($"the requested native save name '{WorldCreationDecision.FilterSaveName(requestedSaveName)}' already exists");
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
            this.nativeEntryRequested = true;
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
    /// Enter the exact save this request already created, through the native
    /// load path the game's own save list uses. Nothing is written to the save:
    /// the slot is only read by the game, exactly as it would be if the player
    /// had clicked that slot on the load screen.
    /// </summary>
    private void EnterExistingWorld(string slotName)
    {
        try
        {
            // SaveGame.Load switches the game into native loading before SMAPI
            // raises SaveLoaded. Record the request first so that expected
            // intermediate state is never mistaken for a second attempt.
            this.nativeEntryRequested = true;
            this.RequestedEntrySlot = slotName;
            this.requestNativeWorldEntry(slotName);
            this.monitor.Log($"GameBuddy entered the Player Host world this request already created ('{slotName}'); waiting for native SaveLoaded.", LogLevel.Info);
        }
        catch (Exception exception)
        {
            this.FailClosed($"native world entry failed: {exception.GetType().Name}");
        }
    }

    /// <summary>
    /// The native load entry itself, matching the native save-list activation
    /// boundary: request the load, then clear the title menu instead of
    /// synthesizing input.
    /// </summary>
    private static void RequestNativeWorldEntry(string slotName)
    {
        SaveGame.Load(slotName);
        Game1.exitActiveMenu();
    }

    private void FailClosed(string reason)
    {
        if (this.terminal)
            return;
        this.terminal = true;
        this.monitor.Log($"GameBuddy formal Player Host world request failed closed: {reason}.", LogLevel.Error);
    }
}
