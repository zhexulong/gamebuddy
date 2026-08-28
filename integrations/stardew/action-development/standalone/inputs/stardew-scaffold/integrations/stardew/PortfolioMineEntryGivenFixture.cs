using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;

namespace GameBuddy.Stardew;

/// <summary>
/// Internal, bridge-before-binding setup for the independent enter_mine action.
/// It establishes only the target-version Mine-exterior Given; it is not a
/// public action and never creates a receipt or evidence.
/// </summary>
public sealed partial class ModEntry
{
    private PortfolioMineEntryGivenFixtureState portfolioMineEntryGivenFixtureState = PortfolioMineEntryGivenFixtureState.NotArmed;
    // Set only from the exact native Mine Player.Warped callback. A pending
    // fixture must never settle merely because some later state resembles it.
    private bool portfolioMineEntryGivenWarpObserved;

    private bool TryPreparePortfolioMineEntryGivenFixture()
    {
        PortfolioConfig? portfolio = this.config.Portfolio;
        PortfolioMineEntryGivenFixtureConfig? fixture = portfolio?.MineEntryGivenFixture;
        if (fixture is not { Enable: true })
        {
            this.portfolioMineEntryGivenFixtureState = PortfolioMineEntryGivenFixtureState.NotArmed;
            return true;
        }
        if (portfolio is null)
        {
            this.portfolioMineEntryGivenFixtureState = PortfolioMineEntryGivenFixtureState.Rejected;
            return false;
        }
        // The fixture establishes a bridge-before-binding Given exactly once.
        // Once binding has opened, action-owned fresh postconditions—not this
        // setup fixture—are the authority for native state transitions.
        if (this.portfolioMineEntryGivenFixtureState == PortfolioMineEntryGivenFixtureState.Succeeded)
            return true;
        if (this.portfolioMineEntryGivenFixtureState == PortfolioMineEntryGivenFixtureState.Pending)
            return this.TrySettlePortfolioMineEntryGivenFixture();
        if (this.portfolioMineEntryGivenFixtureState == PortfolioMineEntryGivenFixtureState.Rejected)
            return false;
        if (this.portfolioBinding is not null
            || !fixture.IsValid
            || !portfolio.IsMineEntryActionSequence
            || !StardewModdingAPI.Context.IsWorldReady
            || !Game1.hasLoadedGame
            || Game1.player is null
            || StardewModdingAPI.Context.IsMultiplayer
            || !Game1.IsMasterGame
            || Game1.getAllFarmers().Count() != 1
            || Game1.server is not null
            || Game1.player!.UniqueMultiplayerID != Game1.MasterPlayer.UniqueMultiplayerID)
        {
            this.portfolioMineEntryGivenFixtureState = PortfolioMineEntryGivenFixtureState.Rejected;
            this.Monitor.Log("GameBuddy rejected the Portfolio Mine-entry Given fixture because the target single-player native topology or action profile is invalid.", StardewModdingAPI.LogLevel.Error);
            return false;
        }

        Farmer player = Game1.player!;
        if (IsBlockingForCurrentProfile(player))
        {
            this.portfolioMineEntryGivenFixtureState = PortfolioMineEntryGivenFixtureState.Rejected;
            this.Monitor.Log("GameBuddy rejected the Portfolio Mine-entry Given fixture because a blocking native interaction is active.", StardewModdingAPI.LogLevel.Error);
            return false;
        }
        if (TryReadPortfolioMineEntryGiven(player))
        {
            this.portfolioMineEntryGivenFixtureState = PortfolioMineEntryGivenFixtureState.Succeeded;
            return true;
        }

        try
        {
            this.portfolioMineEntryGivenFixtureState = PortfolioMineEntryGivenFixtureState.Pending;
            this.portfolioMineEntryGivenWarpObserved = false;
            // This is a target-version setup edge, not a bridge request. The
            // destination establishes only the ordinary Mine exterior Given and
            // is never supplied by Host, runner, config, or player input.
            // Farmer.warpFarmer is deliberately inert while Event is active.
            // The exact skip_event profile may bind at that point, so use the
            // target-version Game1 setup seam and still require its later
            // Player.Warped lifecycle evidence before opening the bridge.
            Game1.warpFarmer("Mine", 23, 8, false);
            this.Monitor.Log("GameBuddy armed the internal Portfolio Mine-entry Given fixture; awaiting fresh native Player.Warped verification before bridge binding.", StardewModdingAPI.LogLevel.Info);
            return false;
        }
        catch (Exception exception)
        {
            this.portfolioMineEntryGivenFixtureState = PortfolioMineEntryGivenFixtureState.Rejected;
            this.Monitor.Log($"GameBuddy rejected the Portfolio Mine-entry Given fixture warp: {exception.GetType().Name}.", StardewModdingAPI.LogLevel.Error);
            return false;
        }
    }

    private void ObservePortfolioMineEntryGivenWarped(WarpedEventArgs e)
    {
        if (this.portfolioMineEntryGivenFixtureState != PortfolioMineEntryGivenFixtureState.Pending
            || e.Player != Game1.player)
            return;

        if (e.NewLocation is not null
            && e.Player?.currentLocation == e.NewLocation
            && String.Equals(e.NewLocation.NameOrUniqueName, "Mine", StringComparison.Ordinal))
        {
            this.portfolioMineEntryGivenWarpObserved = true;
            if (this.TrySettlePortfolioMineEntryGivenFixture())
                return;
        }

        this.portfolioMineEntryGivenFixtureState = PortfolioMineEntryGivenFixtureState.Rejected;
        string newLocation = e.NewLocation?.NameOrUniqueName ?? "null";
        string currentLocation = e.Player?.currentLocation?.NameOrUniqueName ?? "null";
        this.Monitor.Log(
            $"GameBuddy rejected the Portfolio Mine-entry Given fixture: new_location={newLocation}; current_location={currentLocation}.",
            StardewModdingAPI.LogLevel.Error);
    }

    private bool TrySettlePortfolioMineEntryGivenFixture()
    {
        if (!this.portfolioMineEntryGivenWarpObserved || Game1.player is not Farmer player)
            return false;
        if (IsBlockingForCurrentProfile(player) || !TryReadPortfolioMineEntryGiven(player))
        {
            this.portfolioMineEntryGivenFixtureState = PortfolioMineEntryGivenFixtureState.Rejected;
            this.Monitor.Log("GameBuddy rejected the Portfolio Mine-entry Given fixture because fresh post-warp native state is not admissible.", StardewModdingAPI.LogLevel.Error);
            return false;
        }
        this.portfolioMineEntryGivenFixtureState = PortfolioMineEntryGivenFixtureState.Succeeded;
        this.Monitor.Log("GameBuddy completed the internal Portfolio Mine-entry Given fixture from fresh native Player.Warped evidence; bridge binding may now open.", StardewModdingAPI.LogLevel.Info);
        return true;
    }

    private bool IsBlockingForCurrentProfile(Farmer player)
    {
        bool hasEvent = Game1.eventUp || Game1.CurrentEvent is not null;
        if (hasEvent)
        {
            // The exact ordered combo may bind while the native Event owns
            // the temporary non-actionable state. eventUp plus the same live
            // CurrentEvent is the ownership proof for any dialogue surface it
            // opened; skip_event is then the only operation allowed to resolve
            // it. Without that exact Event proof, every menu and dialogue
            // remains fail-closed.
            bool isSkipEventCombo = this.config.Portfolio?.IsMineEntryActionSequence == true
                && this.config.Portfolio.EnabledActions.Count == 2;
            return !isSkipEventCombo || !Game1.eventUp || Game1.CurrentEvent is null;
        }

        return Game1.dialogueUp || Game1.activeClickableMenu is not null || !player.CanMove;
    }

    private static bool TryReadPortfolioMineEntryGiven(Farmer player, GameLocation? location = null)
    {
        GameLocation current = location ?? player.currentLocation;
        return current is not null
            && current is not StardewValley.Locations.MineShaft
            && ReferenceEquals(current, player.currentLocation)
            && String.Equals(current.NameOrUniqueName, "Mine", StringComparison.Ordinal);
    }

    private enum PortfolioMineEntryGivenFixtureState
    {
        NotArmed,
        Pending,
        Succeeded,
        Rejected,
    }
}
