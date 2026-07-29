using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;

namespace GameBuddy.Stardew;

/// <summary>
/// Embodiment entry point. All state belongs to the client that loaded this
/// Mod. The only actor it ever controls is this process' real Game1.player;
/// it never creates or inserts a Farmer into multiplayer collections.
/// </summary>
public sealed class ModEntry : Mod
{
    private ExecutionManager? executions;
    private ModConfig config = new();
    private BridgeSession? bridgeSession;

    public override void Entry(IModHelper helper)
    {
        this.config = helper.ReadConfig<ModConfig>();
        helper.Events.GameLoop.GameLaunched += this.OnGameLaunched;
        helper.Events.GameLoop.SaveLoaded += this.OnSaveLoaded;
        helper.Events.GameLoop.UpdateTicked += this.OnUpdateTicked;
        helper.Events.GameLoop.DayStarted += this.OnDayStarted;
        helper.Events.Player.Warped += this.OnWarped;
        helper.Events.GameLoop.Saving += this.OnSaving;
        helper.Events.GameLoop.ReturnedToTitle += this.OnReturnedToTitle;

        helper.ConsoleCommands.Add("gamebuddy_status", "Print the local native-player binding and authoritative snapshot.", this.StatusCommand);
        helper.ConsoleCommands.Add("gamebuddy_move_fixture", "Phase 1 local-only movement fixture: gamebuddy_move_fixture <tile-x> <tile-y> <request-id>.", this.MoveFixtureCommand);
        helper.ConsoleCommands.Add("gamebuddy_cancel", "Cancel the active local GameBuddy execution.", this.CancelCommand);

        this.Monitor.Log("GameBuddy embodiment loaded; no remote Farmer construction or host-side control is available.", LogLevel.Info);
    }

    private void OnGameLaunched(object? sender, GameLaunchedEventArgs e)
    {
        this.Monitor.Log("GameBuddy health: SMAPI lifecycle hooks are available.", LogLevel.Trace);
    }

    private void OnSaveLoaded(object? sender, SaveLoadedEventArgs e)
    {
        this.executions = new ExecutionManager(this.Monitor);
        this.bridgeSession = this.config.HasValidLocalBridgeConfiguration
            ? new BridgeSession(this.executions, new BridgeScope("stardew", this.config.SaveId, this.config.WorldId, this.config.PlayerId, this.config.CompanionId), this.config.BridgeToken)
            : null;
        if (this.config.EnableLocalBridge && this.bridgeSession is null)
            this.Monitor.Log("GameBuddy local bridge remains disabled: configuration must use opaque scope IDs and a 16+ character token.", LogLevel.Warn);
        Farmer localPlayer = Game1.player;
        this.Monitor.Log(
            $"GameBuddy bound only local Game1.player: farmhand_id={localPlayer.UniqueMultiplayerID}, multiplayer={Context.IsMultiplayer}, main_player={Context.IsMainPlayer}, location={localPlayer.currentLocation?.NameOrUniqueName ?? "unknown"}.",
            LogLevel.Info);
    }

    private void OnUpdateTicked(object? sender, UpdateTickedEventArgs e)
    {
        if (!Context.IsWorldReady)
            return;

        this.executions?.Update();
    }

    private void OnDayStarted(object? sender, DayStartedEventArgs e) => this.executions?.InvalidateForLifecycle("day_started");

    private void OnWarped(object? sender, WarpedEventArgs e)
    {
        if (Context.IsWorldReady && e.Player.UniqueMultiplayerID == Game1.player.UniqueMultiplayerID)
            this.executions?.InvalidateForLifecycle("warped");
    }

    private void OnSaving(object? sender, SavingEventArgs e) => this.executions?.InvalidateForLifecycle("saving");

    private void OnReturnedToTitle(object? sender, ReturnedToTitleEventArgs e)
    {
        this.executions?.InvalidateForLifecycle("returned_to_title");
        this.bridgeSession = null;
        this.executions = null;
        this.Monitor.Log("GameBuddy returned to title; local embodiment state cleared.", LogLevel.Trace);
    }

    private void StatusCommand(string command, string[] args)
    {
        if (!RequireWorld())
            return;

        this.Monitor.Log(System.Text.Json.JsonSerializer.Serialize(this.executions!.CreateSnapshot(), BridgeProtocol.JsonOptions), LogLevel.Info);
    }

    private void MoveFixtureCommand(string command, string[] args)
    {
        if (!RequireWorld())
            return;

        if (args.Length != 3 || !float.TryParse(args[0], out float x) || !float.TryParse(args[1], out float y) || !IsOpaqueRequestId(args[2]))
        {
            this.Monitor.Log("Usage: gamebuddy_move_fixture <tile-x> <tile-y> <request-id>; request-id must be 1-64 letters, digits, _ or -.", LogLevel.Warn);
            return;
        }

        LocalExecutionReceipt receipt = this.executions!.RequestLocalMove(args[2], new Vector2(x, y));
        this.Monitor.Log(System.Text.Json.JsonSerializer.Serialize(receipt), LogLevel.Info);
    }

    private void CancelCommand(string command, string[] args)
    {
        if (!RequireWorld())
            return;

        LocalExecutionReceipt receipt = this.executions!.Cancel("local_console_cancel");
        this.Monitor.Log(System.Text.Json.JsonSerializer.Serialize(receipt), LogLevel.Info);
    }

    private bool RequireWorld()
    {
        if (!Context.IsWorldReady || this.executions is null)
        {
            this.Monitor.Log("Load a world before using GameBuddy embodiment diagnostics.", LogLevel.Warn);
            return false;
        }

        return true;
    }

    private static bool IsOpaqueRequestId(string value) => value.Length is >= 1 and <= 64 && value.All(character => (character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character is '_' or '-');
}
