using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;
using StardewValley.Locations;
using xTile.Dimensions;

namespace GameBuddy.Stardew;

/// <summary>
/// One fixed, pre-binding Given for the independent M8 elevator action. It has
/// no bridge ingress and creates no action result. The target game generates
/// the floor-five elevator facility; this fixture only observes its current
/// Buildings tile before bridge binding can open.
/// </summary>
public sealed partial class ModEntry
{
    private PortfolioMineElevatorGivenFixtureState portfolioMineElevatorGivenFixtureState = PortfolioMineElevatorGivenFixtureState.NotArmed;
    private long portfolioMineElevatorGivenFixtureGeneration;
    private long portfolioMineElevatorGivenFixturePendingGeneration;
    private Farmer? portfolioMineElevatorGivenFixturePlayer;
    private GameLocation? portfolioMineElevatorGivenFixtureSourceLocation;
    private MineShaft? portfolioMineElevatorGivenFixtureTargetMine;
    private LocationRequest? portfolioMineElevatorGivenFixtureRequest;
    private LocationRequest.Callback? portfolioMineElevatorGivenFixtureRequestHandler;
    private bool portfolioMineElevatorGivenFixtureNativeWarpObserved;
    private bool portfolioMineElevatorGivenFixturePlayerWarpObserved;

    private bool TryPreparePortfolioMineElevatorGivenFixture()
    {
        PortfolioConfig? portfolio = this.config.Portfolio;
        PortfolioMineElevatorGivenFixtureConfig? fixture = portfolio?.MineElevatorGivenFixture;
        if (fixture is not { Enable: true })
        {
            if (this.portfolioMineElevatorGivenFixtureState == PortfolioMineElevatorGivenFixtureState.NotArmed)
                return true;
            return this.portfolioMineElevatorGivenFixtureState == PortfolioMineElevatorGivenFixtureState.Succeeded;
        }
        if (portfolio is null || !fixture.IsValid || !portfolio.IsMineElevatorActionSequence)
            return this.RejectPortfolioMineElevatorGivenFixture("action_profile_invalid");
        if (this.portfolioMineElevatorGivenFixtureState == PortfolioMineElevatorGivenFixtureState.Succeeded)
            return true;
        if (this.portfolioMineElevatorGivenFixtureState == PortfolioMineElevatorGivenFixtureState.Rejected)
            return false;
        if (this.portfolioMineElevatorGivenFixtureState == PortfolioMineElevatorGivenFixtureState.Pending)
            return this.TrySettlePortfolioMineElevatorGivenFixture();
        if (this.portfolioMineElevatorGivenFixtureState == PortfolioMineElevatorGivenFixtureState.AwaitingSafeTick)
            this.portfolioMineElevatorGivenFixtureState = PortfolioMineElevatorGivenFixtureState.NotArmed;

        if (this.portfolioBinding is not null || !Context.IsWorldReady || !Game1.hasLoadedGame
            || Context.IsMultiplayer || !Game1.IsMasterGame || Game1.player is not Farmer player
            || Game1.getAllFarmers().Count() != 1 || Game1.server is not null
            || player.UniqueMultiplayerID != Game1.MasterPlayer.UniqueMultiplayerID
            || Game1.currentLocation is not GameLocation sourceLocation || !ReferenceEquals(sourceLocation, player.currentLocation))
            return this.RejectPortfolioMineElevatorGivenFixture("topology_or_scope_invalid");
        if (Game1.locationRequest is not null)
            return this.RejectPortfolioMineElevatorGivenFixture("native_warp_already_pending");
        if (!this.IsPortfolioMineElevatorGivenFixtureSafe(player))
        {
            this.portfolioMineElevatorGivenFixtureState = PortfolioMineElevatorGivenFixtureState.AwaitingSafeTick;
            return false;
        }

        long generation = ++this.portfolioMineElevatorGivenFixtureGeneration;
        this.portfolioMineElevatorGivenFixturePendingGeneration = generation;
        this.portfolioMineElevatorGivenFixturePlayer = player;
        this.portfolioMineElevatorGivenFixtureSourceLocation = sourceLocation;
        this.portfolioMineElevatorGivenFixtureNativeWarpObserved = false;
        this.portfolioMineElevatorGivenFixturePlayerWarpObserved = false;
        this.portfolioMineElevatorGivenFixtureState = PortfolioMineElevatorGivenFixtureState.Pending;
        try
        {
            // Exact target-version floor-five arrival seam. No caller supplies
            // a destination, tile, facing, checkpoint, or player pose.
            Game1.warpFarmer("UndergroundMine5", 6, 6, 2);
            LocationRequest? request = Game1.locationRequest;
            if (request is null || !ReferenceEquals(Game1.locationRequest, request)
                || request.Name != "UndergroundMine5" || request.Location is not MineShaft mine || mine.mineLevel != 5)
                return this.RejectPortfolioMineElevatorGivenFixture("native_warp_request_invalid");

            LocationRequest.Callback handler = () => this.ObservePortfolioMineElevatorGivenNativeWarp(generation, request);
            this.portfolioMineElevatorGivenFixtureRequest = request;
            this.portfolioMineElevatorGivenFixtureRequestHandler = handler;
            this.portfolioMineElevatorGivenFixtureTargetMine = mine;
            request.OnWarp += handler;
            this.Monitor.Log("GameBuddy armed the fixed M8 Mine-elevator Given fixture; awaiting exact native and SMAPI warp completion before bridge binding.", LogLevel.Info);
            return false;
        }
        catch (Exception exception)
        {
            this.Monitor.Log($"GameBuddy rejected the M8 Mine-elevator Given fixture native warp: {exception.GetType().Name}.", LogLevel.Error);
            return this.RejectPortfolioMineElevatorGivenFixture("native_warp_exception");
        }
    }

    private void ObservePortfolioMineElevatorGivenNativeWarp(long generation, LocationRequest request)
    {
        if (this.portfolioMineElevatorGivenFixtureState != PortfolioMineElevatorGivenFixtureState.Pending
            || generation != this.portfolioMineElevatorGivenFixturePendingGeneration
            || !ReferenceEquals(request, this.portfolioMineElevatorGivenFixtureRequest)
            || !ReferenceEquals(Game1.locationRequest, request)
            || !ReferenceEquals(Game1.player, this.portfolioMineElevatorGivenFixturePlayer)
            || !ReferenceEquals(Game1.player?.currentLocation, request.Location)
            || request.Location is not MineShaft mine || !ReferenceEquals(mine, this.portfolioMineElevatorGivenFixtureTargetMine)
            || mine.mineLevel != 5 || this.portfolioMineElevatorGivenFixtureNativeWarpObserved)
        {
            this.RejectPortfolioMineElevatorGivenFixture("native_warp_correlation_invalid");
            return;
        }
        this.portfolioMineElevatorGivenFixtureNativeWarpObserved = true;
    }

    private void ObservePortfolioMineElevatorGivenWarped(WarpedEventArgs e)
    {
        if (this.portfolioMineElevatorGivenFixtureState != PortfolioMineElevatorGivenFixtureState.Pending)
            return;
        LocationRequest? request = this.portfolioMineElevatorGivenFixtureRequest;
        if (!this.portfolioMineElevatorGivenFixtureNativeWarpObserved
            || this.portfolioMineElevatorGivenFixturePlayerWarpObserved
            || request is null
            || !ReferenceEquals(e.Player, this.portfolioMineElevatorGivenFixturePlayer)
            || !ReferenceEquals(e.Player, Game1.player)
            || !ReferenceEquals(e.OldLocation, this.portfolioMineElevatorGivenFixtureSourceLocation)
            || !ReferenceEquals(e.NewLocation, request.Location)
            || !ReferenceEquals(e.NewLocation, this.portfolioMineElevatorGivenFixtureTargetMine)
            || !ReferenceEquals(e.Player.currentLocation, e.NewLocation)
            || e.NewLocation is not MineShaft mine || mine.mineLevel != 5)
        {
            this.RejectPortfolioMineElevatorGivenFixture("player_warp_correlation_invalid");
            return;
        }
        this.portfolioMineElevatorGivenFixturePlayerWarpObserved = true;
    }

    private bool TrySettlePortfolioMineElevatorGivenFixture()
    {
        if (this.portfolioMineElevatorGivenFixtureState != PortfolioMineElevatorGivenFixtureState.Pending
            || !this.portfolioMineElevatorGivenFixtureNativeWarpObserved
            || !this.portfolioMineElevatorGivenFixturePlayerWarpObserved)
            return false;
        if (Game1.player is not Farmer player || Game1.locationRequest is not null
            || !ReferenceEquals(player, this.portfolioMineElevatorGivenFixturePlayer)
            || !ReferenceEquals(Game1.currentLocation, player.currentLocation)
            || !ReferenceEquals(Game1.currentLocation, this.portfolioMineElevatorGivenFixtureTargetMine)
            || this.portfolioMineElevatorGivenFixtureTargetMine is not MineShaft mine
            || mine.NameOrUniqueName != "UndergroundMine5" || mine.mineLevel != 5
            || !this.IsPortfolioMineElevatorGivenFixtureSafe(player)
            // Floor five proves the native elevator facility is present; the
            // staged Given unlocks the distinct runtime-selected checkpoint.
            // The action adapter still owns fresh target-specific validation.
            || MineShaft.lowestLevelReached < 10)
            return this.RejectPortfolioMineElevatorGivenFixture("fresh_given_invalid");
        if (!this.HasPortfolioMineElevatorGivenFacility(mine))
            return this.RejectPortfolioMineElevatorGivenFixture("fixture_elevator_not_observed");

        this.DetachPortfolioMineElevatorGivenFixtureRequestHandler();
        this.portfolioMineElevatorGivenFixtureState = PortfolioMineElevatorGivenFixtureState.Succeeded;
        this.ClearPortfolioMineElevatorGivenFixturePendingFacts();
        this.Monitor.Log("GameBuddy completed the fixed M8 Mine-elevator Given fixture from fresh MineShaft facts; bridge binding may open.", LogLevel.Info);
        return true;
    }

    private bool HasPortfolioMineElevatorGivenFacility(MineShaft mine)
    {
        var layer = mine.map?.GetLayer("Buildings");
        if (layer is null)
            return false;
        for (int x = 0; x < layer.LayerWidth; x++)
        for (int y = 0; y < layer.LayerHeight; y++)
        {
            if (mine.getTileIndexAt(new Location(x, y), "Buildings") == 112)
                return true;
        }
        return false;
    }

    private bool IsPortfolioMineElevatorGivenFixtureSafe(Farmer player)
        => Game1.locationRequest is null && !Game1.eventUp && Game1.CurrentEvent is null && !Game1.dialogueUp
            && Game1.activeClickableMenu is null && player.CanMove;

    private bool RejectPortfolioMineElevatorGivenFixture(string reason)
    {
        this.DetachPortfolioMineElevatorGivenFixtureRequestHandler();
        this.ClearPortfolioMineElevatorGivenFixturePendingFacts();
        this.portfolioMineElevatorGivenFixtureState = PortfolioMineElevatorGivenFixtureState.Rejected;
        this.Monitor.Log($"GameBuddy rejected the fixed M8 Mine-elevator Given fixture: reason={reason}.", LogLevel.Error);
        return false;
    }

    private void ResetPortfolioMineElevatorGivenFixture(string lifecycleReason)
    {
        if (this.portfolioMineElevatorGivenFixtureState == PortfolioMineElevatorGivenFixtureState.NotArmed)
            return;
        this.DetachPortfolioMineElevatorGivenFixtureRequestHandler();
        this.ClearPortfolioMineElevatorGivenFixturePendingFacts();
        this.portfolioMineElevatorGivenFixtureGeneration++;
        this.portfolioMineElevatorGivenFixtureState = PortfolioMineElevatorGivenFixtureState.Rejected;
        this.Monitor.Log($"GameBuddy invalidated the fixed M8 Mine-elevator Given fixture: lifecycle={lifecycleReason}.", LogLevel.Error);
    }

    private void DetachPortfolioMineElevatorGivenFixtureRequestHandler()
    {
        if (this.portfolioMineElevatorGivenFixtureRequest is LocationRequest request
            && this.portfolioMineElevatorGivenFixtureRequestHandler is LocationRequest.Callback handler)
            request.OnWarp -= handler;
    }

    private void ClearPortfolioMineElevatorGivenFixturePendingFacts()
    {
        this.portfolioMineElevatorGivenFixturePendingGeneration = 0;
        this.portfolioMineElevatorGivenFixturePlayer = null;
        this.portfolioMineElevatorGivenFixtureSourceLocation = null;
        this.portfolioMineElevatorGivenFixtureTargetMine = null;
        this.portfolioMineElevatorGivenFixtureRequest = null;
        this.portfolioMineElevatorGivenFixtureRequestHandler = null;
        this.portfolioMineElevatorGivenFixtureNativeWarpObserved = false;
        this.portfolioMineElevatorGivenFixturePlayerWarpObserved = false;
    }

    private enum PortfolioMineElevatorGivenFixtureState
    {
        NotArmed,
        AwaitingSafeTick,
        Pending,
        Succeeded,
        Rejected,
    }
}
