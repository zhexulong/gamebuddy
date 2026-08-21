using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;
using StardewValley.Locations;
using xTile.Dimensions;

namespace GameBuddy.Stardew;

/// <summary>
/// One fixed, pre-binding Given for the independent M8 ladder action. It has no
/// bridge ingress and cannot create an action result. After its fixed native
/// floor-two arrival, it requests one normal ladder through the target game's
/// native MineShaft seam using a fixture-selected clear tile.
/// </summary>
public sealed partial class ModEntry
{
    private PortfolioMineLadderGivenFixtureState portfolioMineLadderGivenFixtureState = PortfolioMineLadderGivenFixtureState.NotArmed;
    private long portfolioMineLadderGivenFixtureGeneration;
    private long portfolioMineLadderGivenFixturePendingGeneration;
    private Farmer? portfolioMineLadderGivenFixturePlayer;
    private GameLocation? portfolioMineLadderGivenFixtureSourceLocation;
    private MineShaft? portfolioMineLadderGivenFixtureTargetMine;
    private LocationRequest? portfolioMineLadderGivenFixtureRequest;
    private LocationRequest.Callback? portfolioMineLadderGivenFixtureRequestHandler;
    private bool portfolioMineLadderGivenFixtureNativeWarpObserved;
    private bool portfolioMineLadderGivenFixturePlayerWarpObserved;
    private bool portfolioMineLadderGivenFixtureLadderCreationIssued;
    private Point? portfolioMineLadderGivenFixtureLadderCreationPoint;

    private bool TryPreparePortfolioMineLadderGivenFixture()
    {
        PortfolioConfig? portfolio = this.config.Portfolio;
        PortfolioMineLadderGivenFixtureConfig? fixture = portfolio?.MineLadderGivenFixture;
        if (fixture is not { Enable: true })
        {
            if (this.portfolioMineLadderGivenFixtureState == PortfolioMineLadderGivenFixtureState.NotArmed)
                return true;
            return this.portfolioMineLadderGivenFixtureState == PortfolioMineLadderGivenFixtureState.Succeeded;
        }
        if (portfolio is null || !fixture.IsValid || !portfolio.IsMineLadderActionSequence)
            return this.RejectPortfolioMineLadderGivenFixture("action_profile_invalid");
        if (this.portfolioMineLadderGivenFixtureState == PortfolioMineLadderGivenFixtureState.Succeeded)
            return true;
        if (this.portfolioMineLadderGivenFixtureState == PortfolioMineLadderGivenFixtureState.Rejected)
            return false;
        if (this.portfolioMineLadderGivenFixtureState == PortfolioMineLadderGivenFixtureState.Pending)
            return this.TrySettlePortfolioMineLadderGivenFixture();
        if (this.portfolioMineLadderGivenFixtureState == PortfolioMineLadderGivenFixtureState.AwaitingSafeTick)
        {
            // A safe deferral precedes any native edge. Once the world reaches
            // safe state, this is the sole transition into the one-shot arm.
            this.portfolioMineLadderGivenFixtureState = PortfolioMineLadderGivenFixtureState.NotArmed;
        }

        if (this.portfolioBinding is not null || !StardewModdingAPI.Context.IsWorldReady || !Game1.hasLoadedGame
            || StardewModdingAPI.Context.IsMultiplayer || !Game1.IsMasterGame || Game1.player is not Farmer player
            || Game1.getAllFarmers().Count() != 1 || Game1.server is not null
            || player.UniqueMultiplayerID != Game1.MasterPlayer.UniqueMultiplayerID
            || Game1.currentLocation is not GameLocation sourceLocation || !ReferenceEquals(sourceLocation, player.currentLocation))
            return this.RejectPortfolioMineLadderGivenFixture("topology_or_scope_invalid");

        if (Game1.locationRequest is not null)
            return this.RejectPortfolioMineLadderGivenFixture("native_warp_already_pending");
        if (!this.IsPortfolioMineLadderGivenFixtureSafe(player))
        {
            // Before arm, transient target loading may settle; no native edge
            // has been issued, so this remains a non-authorizing safe wait.
            this.portfolioMineLadderGivenFixtureState = PortfolioMineLadderGivenFixtureState.AwaitingSafeTick;
            return false;
        }

        long generation = ++this.portfolioMineLadderGivenFixtureGeneration;
        this.portfolioMineLadderGivenFixturePendingGeneration = generation;
        this.portfolioMineLadderGivenFixturePlayer = player;
        this.portfolioMineLadderGivenFixtureSourceLocation = sourceLocation;
        this.portfolioMineLadderGivenFixtureNativeWarpObserved = false;
        this.portfolioMineLadderGivenFixturePlayerWarpObserved = false;
        this.portfolioMineLadderGivenFixtureState = PortfolioMineLadderGivenFixtureState.Pending;
        try
        {
            // Exact target-version floor-two arrival seam. No caller supplies
            // the destination, tile, or facing values.
            Game1.warpFarmer("UndergroundMine2", 6, 6, 2);
            LocationRequest? request = Game1.locationRequest;
            if (request is null || !ReferenceEquals(Game1.locationRequest, request)
                || request.Name != "UndergroundMine2" || request.Location is not MineShaft mine || mine.mineLevel != 2)
                return this.RejectPortfolioMineLadderGivenFixture("native_warp_request_invalid");

            LocationRequest.Callback handler = () => this.ObservePortfolioMineLadderGivenNativeWarp(generation, request);
            this.portfolioMineLadderGivenFixtureRequest = request;
            this.portfolioMineLadderGivenFixtureRequestHandler = handler;
            this.portfolioMineLadderGivenFixtureTargetMine = mine;
            request.OnWarp += handler;
            this.Monitor.Log("GameBuddy armed the fixed M8 Mine-ladder Given fixture; awaiting exact native and SMAPI warp completion before bridge binding.", LogLevel.Info);
            return false;
        }
        catch (Exception exception)
        {
            this.Monitor.Log($"GameBuddy rejected the M8 Mine-ladder Given fixture native warp: {exception.GetType().Name}.", LogLevel.Error);
            return this.RejectPortfolioMineLadderGivenFixture("native_warp_exception");
        }
    }

    private void ObservePortfolioMineLadderGivenNativeWarp(long generation, LocationRequest request)
    {
        if (this.portfolioMineLadderGivenFixtureState != PortfolioMineLadderGivenFixtureState.Pending
            || generation != this.portfolioMineLadderGivenFixturePendingGeneration
            || !ReferenceEquals(request, this.portfolioMineLadderGivenFixtureRequest)
            || !ReferenceEquals(Game1.locationRequest, request)
            || !ReferenceEquals(Game1.player, this.portfolioMineLadderGivenFixturePlayer)
            || !ReferenceEquals(Game1.player?.currentLocation, request.Location)
            || request.Location is not MineShaft mine || !ReferenceEquals(mine, this.portfolioMineLadderGivenFixtureTargetMine)
            || mine.mineLevel != 2 || this.portfolioMineLadderGivenFixtureNativeWarpObserved)
        {
            this.RejectPortfolioMineLadderGivenFixture("native_warp_correlation_invalid");
            return;
        }
        this.portfolioMineLadderGivenFixtureNativeWarpObserved = true;
    }

    private void ObservePortfolioMineLadderGivenWarped(WarpedEventArgs e)
    {
        if (this.portfolioMineLadderGivenFixtureState != PortfolioMineLadderGivenFixtureState.Pending)
            return;
        LocationRequest? request = this.portfolioMineLadderGivenFixtureRequest;
        if (!this.portfolioMineLadderGivenFixtureNativeWarpObserved
            || this.portfolioMineLadderGivenFixturePlayerWarpObserved
            || request is null
            || !ReferenceEquals(e.Player, this.portfolioMineLadderGivenFixturePlayer)
            || !ReferenceEquals(e.Player, Game1.player)
            || !ReferenceEquals(e.OldLocation, this.portfolioMineLadderGivenFixtureSourceLocation)
            || !ReferenceEquals(e.NewLocation, request.Location)
            || !ReferenceEquals(e.NewLocation, this.portfolioMineLadderGivenFixtureTargetMine)
            || !ReferenceEquals(e.Player.currentLocation, e.NewLocation)
            || e.NewLocation is not MineShaft mine || mine.mineLevel != 2)
        {
            this.RejectPortfolioMineLadderGivenFixture("player_warp_correlation_invalid");
            return;
        }
        this.portfolioMineLadderGivenFixturePlayerWarpObserved = true;
    }

    private bool TrySettlePortfolioMineLadderGivenFixture()
    {
        if (this.portfolioMineLadderGivenFixtureState != PortfolioMineLadderGivenFixtureState.Pending
            || !this.portfolioMineLadderGivenFixtureNativeWarpObserved
            || !this.portfolioMineLadderGivenFixturePlayerWarpObserved)
            return false;
        if (Game1.player is not Farmer player || Game1.locationRequest is not null
            || !ReferenceEquals(player, this.portfolioMineLadderGivenFixturePlayer)
            || !ReferenceEquals(Game1.currentLocation, player.currentLocation)
            || !ReferenceEquals(Game1.currentLocation, this.portfolioMineLadderGivenFixtureTargetMine)
            || this.portfolioMineLadderGivenFixtureTargetMine is not MineShaft mine
            || mine.NameOrUniqueName != "UndergroundMine2" || mine.mineLevel != 2
            || !this.IsPortfolioMineLadderGivenFixtureSafe(player)
            || MineShaft.lowestLevelReached != 2)
        {
            return this.RejectPortfolioMineLadderGivenFixture("fresh_given_invalid");
        }
        if (!this.portfolioMineLadderGivenFixtureLadderCreationIssued)
        {
            if (!this.TryCreatePortfolioMineLadderGivenFacility(mine))
                return false;
            this.portfolioMineLadderGivenFixtureLadderCreationIssued = true;
            return false;
        }
        if (Game1.player is not Farmer freshPlayer || Game1.locationRequest is not null
            || !ReferenceEquals(freshPlayer, this.portfolioMineLadderGivenFixturePlayer)
            || !ReferenceEquals(Game1.currentLocation, freshPlayer.currentLocation)
            || !ReferenceEquals(Game1.currentLocation, this.portfolioMineLadderGivenFixtureTargetMine)
            || this.portfolioMineLadderGivenFixtureTargetMine is not MineShaft freshMine
            || freshMine.NameOrUniqueName != "UndergroundMine2" || freshMine.mineLevel != 2
            || !this.IsPortfolioMineLadderGivenFixtureSafe(freshPlayer)
            || MineShaft.lowestLevelReached != 2
            || this.portfolioMineLadderGivenFixtureLadderCreationPoint is not Point point
            || freshMine.getTileIndexAt(new Location(point.X, point.Y), "Buildings") != 173)
            return this.RejectPortfolioMineLadderGivenFixture("fixture_ladder_not_observed");

        this.DetachPortfolioMineLadderGivenFixtureRequestHandler();
        this.portfolioMineLadderGivenFixtureState = PortfolioMineLadderGivenFixtureState.Succeeded;
        this.ClearPortfolioMineLadderGivenFixturePendingFacts();
        this.Monitor.Log("GameBuddy completed the fixed M8 Mine-ladder Given fixture from fresh generated MineShaft facts; bridge binding may open.", LogLevel.Info);
        return true;
    }

    private bool TryCreatePortfolioMineLadderGivenFacility(MineShaft mine)
    {
        var layer = mine.map?.GetLayer("Buildings");
        if (layer is null)
            return this.RejectPortfolioMineLadderGivenFixture("fixture_ladder_tile_unavailable");
        for (int x = 0; x < layer.LayerWidth; x++)
        for (int y = 0; y < layer.LayerHeight; y++)
        {
            if (!mine.isTileClearForMineObjects(x, y))
                continue;
            try
            {
                // This is an approved validation-only Given seam. The target
                // game publishes and materializes its normal tile-173 ladder;
                // no caller supplies its target or action request.
                this.portfolioMineLadderGivenFixtureLadderCreationPoint = new Point(x, y);
                mine.createLadderDown(x, y);
                return true;
            }
            catch (Exception exception)
            {
                this.Monitor.Log($"GameBuddy rejected the M8 Mine-ladder Given fixture native ladder creation: {exception.GetType().Name}.", LogLevel.Error);
                return this.RejectPortfolioMineLadderGivenFixture("fixture_ladder_creation_exception");
            }
        }
        return this.RejectPortfolioMineLadderGivenFixture("fixture_ladder_tile_unavailable");
    }

    private bool IsPortfolioMineLadderGivenFixtureSafe(Farmer player)
        => Game1.locationRequest is null && !Game1.eventUp && Game1.CurrentEvent is null && !Game1.dialogueUp
            && Game1.activeClickableMenu is null && player.CanMove;

    private bool RejectPortfolioMineLadderGivenFixture(string reason)
    {
        this.DetachPortfolioMineLadderGivenFixtureRequestHandler();
        this.ClearPortfolioMineLadderGivenFixturePendingFacts();
        this.portfolioMineLadderGivenFixtureState = PortfolioMineLadderGivenFixtureState.Rejected;
        this.Monitor.Log($"GameBuddy rejected the fixed M8 Mine-ladder Given fixture: reason={reason}.", LogLevel.Error);
        return false;
    }

    private void ResetPortfolioMineLadderGivenFixture(string lifecycleReason)
    {
        if (this.portfolioMineLadderGivenFixtureState == PortfolioMineLadderGivenFixtureState.NotArmed)
            return;
        this.DetachPortfolioMineLadderGivenFixtureRequestHandler();
        this.ClearPortfolioMineLadderGivenFixturePendingFacts();
        this.portfolioMineLadderGivenFixtureGeneration++;
        this.portfolioMineLadderGivenFixtureState = PortfolioMineLadderGivenFixtureState.Rejected;
        this.Monitor.Log($"GameBuddy invalidated the fixed M8 Mine-ladder Given fixture: lifecycle={lifecycleReason}.", LogLevel.Error);
    }

    private void DetachPortfolioMineLadderGivenFixtureRequestHandler()
    {
        if (this.portfolioMineLadderGivenFixtureRequest is LocationRequest request
            && this.portfolioMineLadderGivenFixtureRequestHandler is LocationRequest.Callback handler)
            request.OnWarp -= handler;
    }

    private void ClearPortfolioMineLadderGivenFixturePendingFacts()
    {
        this.portfolioMineLadderGivenFixturePendingGeneration = 0;
        this.portfolioMineLadderGivenFixturePlayer = null;
        this.portfolioMineLadderGivenFixtureSourceLocation = null;
        this.portfolioMineLadderGivenFixtureTargetMine = null;
        this.portfolioMineLadderGivenFixtureRequest = null;
        this.portfolioMineLadderGivenFixtureRequestHandler = null;
        this.portfolioMineLadderGivenFixtureNativeWarpObserved = false;
        this.portfolioMineLadderGivenFixturePlayerWarpObserved = false;
        this.portfolioMineLadderGivenFixtureLadderCreationIssued = false;
        this.portfolioMineLadderGivenFixtureLadderCreationPoint = null;
    }

    private enum PortfolioMineLadderGivenFixtureState
    {
        NotArmed,
        AwaitingSafeTick,
        Pending,
        Succeeded,
        Rejected,
    }
}
