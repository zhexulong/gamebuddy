using StardewModdingAPI;
using StardewModdingAPI.Events;

namespace GameBuddy.Stardew;

/// <summary>
/// Phase 0A lifecycle-only SMAPI integration scaffold.
/// It creates no actor, bridge, Game Action, game-state mutation, or tick loop.
/// </summary>
public sealed class ModEntry : Mod
{
    public override void Entry(IModHelper helper)
    {
        helper.Events.GameLoop.GameLaunched += this.OnGameLaunched;
        helper.Events.GameLoop.ReturnedToTitle += this.OnReturnedToTitle;

        this.Monitor.Log("GameBuddy Phase 0A integration loaded; no game capabilities are enabled.", LogLevel.Info);
    }

    private void OnGameLaunched(object? sender, GameLaunchedEventArgs e)
    {
        this.Monitor.Log("GameBuddy health: SMAPI lifecycle hooks are available.", LogLevel.Trace);
    }

    private void OnReturnedToTitle(object? sender, ReturnedToTitleEventArgs e)
    {
        this.Monitor.Log("GameBuddy health: returned to title with no active companion state.", LogLevel.Trace);
    }
}
