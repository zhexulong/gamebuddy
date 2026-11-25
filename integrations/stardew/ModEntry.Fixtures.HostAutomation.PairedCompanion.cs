using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;

namespace GameBuddy.Stardew;

/// <summary>
/// <c>native_paired_companion_v1</c>'s HOST half: the world one ripe crop and one container holding one item, the tile
/// the companion must stand on, and the refusal of everything that cannot be resolved.
///
/// <para>
/// WHY THE HOST CANNOT PLACE HER, stated here because this is the file that would otherwise try. A Farmhand joining a
/// LAN world is put where HER OWN client derives she is: <c>Client.setUpGame</c> -&gt;
/// <c>BedFurniture.ApplyWakeUpPosition(Game1.player)</c> (Client.cs:208), and <c>NetWorldState.ResetFarmhandState</c>
/// sets <c>currentLocation = homeOfFarmer; Position = bedSpot*64</c> (NetWorldState.cs:756-775). And the one engine call
/// a fixture uses to move a farmer, <c>Farmer.warpFarmer</c>, warps <c>Game1.player</c> of the CALLING process -
/// <c>Farmer.cs:5753</c> -&gt; <c>Game1.warpFarmer</c> -&gt; <c>performWarpFarmer</c>, which assigns
/// <c>Game1.locationRequest</c>/<c>xLocationAfterWarp</c> for the local player (Game1.cs:10019-10032). Called here with
/// the bound farmhand as the receiver it would warp the HOST PLAYER onto her tile - corrupting the very body
/// <see cref="HostPlayerScriptChannel"/> drives in S1, S2 and S3 - and leave her in her Cabin. The server has no
/// counterpart either: <c>GameServer.warpFarmer</c> is reachable only from an incoming client message 5
/// (GameServer.cs:673-715), i.e. a farmer warping itself.
/// </para>
///
/// <para>
/// SO THE WORLD IS THE HOST'S AND THE BODY IS HERS. This file builds the world with the SAME builder the native-local
/// lane uses (<see cref="BuildNativeLocalPairedCompanionWorld"/>), publishes the tile she must stand on - with a
/// generation that binds her report to THIS publication - into the fixture's own record stream
/// (<see cref="HostPlayerScriptChannel"/>'s <c>RecordsPath</c>), and then verifies the report she writes back from her
/// own process (<see cref="TryVerifyNativePairedCompanionPlacement"/>). The record stream is the same channel that
/// already carries the Host player's steps; nothing here is a second wire, a second config field or a second file.
/// </para>
///
/// <para>
/// WHAT EACH OF HER STARTING POSITIONS MUST BE, AND HOW IT IS GUARANTEED:
/// <list type="bullet">
/// <item>ON THE FARM, because <c>otherFarmers</c> is bounded by HER MAP (<c>FarmhandTargetDiscovery.DiscoverOtherFarmers</c>)
/// and the Host player is walked onto the Farm by S1's script - so the map is what makes him visible to her at all.
/// Guaranteed by the published tile being a Farm tile and by her report naming the tile she actually reached.</item>
/// <item>OUTSIDE THE OLD SIX-TILE WINDOW: at least <c>PairedCompanionSeparationMinimumTiles</c> and at most
/// <c>PairedCompanionSeparationMaximumTiles</c> tiles (Chebyshev) from the crop, which is what makes S1 a reading of her
/// attention rather than of where the world put her. That is exactly why the crop is NOT in her own
/// <c>harvestTargets</c> any more - and why both anchors travel in the placement record, so the harness's walking
/// destination is the tile this process built instead of a row she would have to be standing beside to publish.
/// Guaranteed by the tile being chosen under that window, and published with the window it was chosen in.</item>
/// <item>NO FURTHER THAN <c>ExecutionManager.TargetDiscoveryRadius</c> FROM THE CONTAINER, so her OWN observation carries
/// S2's subject too and the next slice needs no second launch. The container is the subject that moves with her, because
/// hers is the only observation it has to appear in.</item>
/// <item>A TILE SHE CAN STAND ON, asked of the production predicate (<c>StardewBodyController.IsStandableTile</c>) and
/// re-asked in her own process before she moves.</item>
/// </list>
/// The two distances are NOT re-derived here: <see cref="NativeLocalPairedCompanionWorld"/> is returned by the builder
/// that chose them, so the published tile, the published anchors and the tile her client stands on cannot be three
/// searches.
/// </para>
/// </summary>
public sealed partial class ModEntry
{
    /// <summary>
    /// The placement this Host published and has not yet seen reported: the generation that binds the two sides, the
    /// world it was published against, and the stream both records travel on.
    /// </summary>
    private sealed record NativePairedCompanionPlacement(
        long FarmhandId,
        string FarmName,
        string Generation,
        Vector2 Crop,
        Vector2 Chest,
        Vector2 Standing,
        int Radius,
        string RecordsPath);

    private NativePairedCompanionPlacement? nativePairedCompanionPlacement;

    /// <summary>
    /// The Host half of <c>native_paired_companion_v1</c>: build the world, resolve the actor whose body will be seen in
    /// it, and publish the one tile she must stand on. Refuses by name rather than arming half a world, because a Host
    /// that published nothing is a slice that would spend its budget looking for a subject that was never placed.
    /// </summary>
    private void InitializeNativePairedCompanionFixture(StardewValley.Farm farm)
    {
        Farmer farmhand;
        try
        {
            farmhand = this.ResolveHostAutomationFarmhand(farm);
        }
        catch (InvalidOperationException)
        {
            // The bound farmhand IS the world's subject: without her there is nothing to publish a tile for.
            RefuseNativePairedCompanionPlacement("paired_companion_farmhand_unavailable", "the bound farmhand's Farmer and the Cabin it owns could not be resolved on this Host");
            return;
        }

        string recordsPath = this.config.HostAutomation?.HostPlayerScript?.RecordsPath ?? string.Empty;
        if (!Path.IsPathFullyQualified(recordsPath))
        {
            RefuseNativePairedCompanionPlacement("paired_companion_records_unavailable", "the fixture's record stream is not armed, so the tile could not be handed to her process");
            return;
        }

        Vector2 arrival;
        try
        {
            arrival = ResolveHostAutomationFarmArrival(farmhand, farm, "paired_companion");
        }
        catch (InvalidOperationException exception)
        {
            RefuseNativePairedCompanionPlacement(exception.Message, "the Cabin's own warp into the Farm could not be resolved");
            return;
        }

        NativeLocalPairedCompanionWorld world = this.BuildNativeLocalPairedCompanionWorld(farmhand, farm, arrival);
        string generation = Guid.NewGuid().ToString("N");
        if (!FixtureRecordStream.TryAppendRecord(
                recordsPath,
                FixtureRecordStream.PlacementRecordDocument(
                    "published",
                    "paired_companion_placement_published",
                    farm.NameOrUniqueName,
                    world.Standing,
                    world.Standing,
                    generation,
                    world.Anchors)))
        {
            RefuseNativePairedCompanionPlacement("paired_companion_records_unavailable", "the placement publication could not be written to the fixture's record stream");
            return;
        }

        this.nativePairedCompanionPlacement = new NativePairedCompanionPlacement(
            farmhand.UniqueMultiplayerID,
            farm.NameOrUniqueName,
            generation,
            world.Anchors.Crop.Tile,
            world.Anchors.Chest.Tile,
            world.Standing,
            world.Radius,
            recordsPath);
        this.hostAutomationFixtureInitialized = true;
        this.Monitor.Log(
            "GameBuddy HostAutomation initialized the paired companion world before attachment: "
                + $"farmhand={farmhand.UniqueMultiplayerID};generation={generation};"
                + $"crop={(int)world.Anchors.Crop.Tile.X},{(int)world.Anchors.Crop.Tile.Y};"
                + $"chest={(int)world.Anchors.Chest.Tile.X},{(int)world.Anchors.Chest.Tile.Y};chest_id={world.Anchors.Chest.Address};"
                + $"standing={(int)world.Standing.X},{(int)world.Standing.Y};radius={world.Radius};"
                + $"separation={world.Anchors.SeparationMinimum}..{world.Anchors.SeparationMaximum};"
                + $"records={recordsPath};"
                + "this process places the WORLD and publishes the tile and both anchors; her own process places her body "
                + "and reports it; production alone harvests, contends and takes.",
            LogLevel.Info);
    }

    /// <summary>
    /// Re-reads the record stream for the report the companion's own process writes back
    /// (<c>action=placement,state=placed</c> with this publication's generation).
    ///
    /// <para>
    /// TWO OUTCOMES ARE THE HOST'S TO NAME, and the third is not. A report naming a tile other than the one published is
    /// <c>paired_companion_farmhand_not_placed:&lt;x&gt;,&lt;y&gt;</c> with HER tile in the code - the world is built and
    /// she is somewhere else, which is a placement defect and not a missing measurement. A report she refused
    /// (<c>action=placement,state=rejected</c>) is carried through under her own code, so the reason her process could
    /// not stand there is not re-invented here. NO report at all is not decided here: that is S1's gate
    /// (<c>paired_companion_placement_unconfirmed</c> in the paired runner), which is the side that has a budget to spend
    /// waiting - a second timeout here would be a second authority for one absent fact.
    /// </para>
    /// </summary>
    private void TryVerifyNativePairedCompanionPlacement()
    {
        if (this.nativePairedCompanionPlacement is not { } placement || !Context.IsWorldReady)
            return;
        IReadOnlyList<FixtureRecordStream.PlacementRecord> records =
            FixtureRecordStream.ReadPlacementRecords(placement.RecordsPath);
        FixtureRecordStream.PlacementRecord? rejected = records.LastOrDefault(record =>
            string.Equals(record.Generation, placement.Generation, StringComparison.Ordinal)
            && string.Equals(record.State, "rejected", StringComparison.Ordinal));
        if (rejected is not null)
        {
            this.nativePairedCompanionPlacement = null;
            this.hostAutomationTerminal = true;
            this.Monitor.Log(
                $"GameBuddy HostAutomation paired companion placement was refused by her own process: {rejected.ReasonCode};"
                    + $"fulfilled_tile={(int)rejected.Tile.X},{(int)rejected.Tile.Y};"
                    + $"published_tile={(int)placement.Standing.X},{(int)placement.Standing.Y};generation={placement.Generation}.",
                LogLevel.Error);
            return;
        }
        FixtureRecordStream.PlacementRecord? placed = records.LastOrDefault(record =>
            string.Equals(record.Generation, placement.Generation, StringComparison.Ordinal)
            && string.Equals(record.State, "placed", StringComparison.Ordinal));
        if (placed is null)
            return;
        this.nativePairedCompanionPlacement = null;
        if (ChebyshevTileDistance(placed.Tile, placement.Standing) > 1f)
        {
            this.hostAutomationTerminal = true;
            this.Monitor.Log(
                $"GameBuddy HostAutomation paired companion refused the placement: paired_companion_farmhand_not_placed:{(int)placed.Tile.X},{(int)placed.Tile.Y};"
                    + $"published_tile={(int)placement.Standing.X},{(int)placement.Standing.Y};"
                    + $"crop={(int)placement.Crop.X},{(int)placement.Crop.Y};chest={(int)placement.Chest.X},{(int)placement.Chest.Y};"
                    + $"radius={placement.Radius};generation={placement.Generation}.",
                LogLevel.Error);
            return;
        }
        this.Monitor.Log(
            "GameBuddy HostAutomation paired companion placement confirmed by her own process: "
                + $"farmhand={placement.FarmhandId};tile={(int)placed.Tile.X},{(int)placed.Tile.Y};"
                + $"published_tile={(int)placement.Standing.X},{(int)placement.Standing.Y};generation={placement.Generation};"
                + "the report is hers, written by the process whose body moved.",
            LogLevel.Info);
    }

    /// <summary>
    /// The Host's own refusal for this scenario, and its record: it ends the fixture (a world that could not be armed
    /// must not attach as if it had), and it says the SAME code on the stream S1 reads, so the slice reports the Host's
    /// reason instead of waiting out its budget and reporting a timeout.
    /// </summary>
    private void RefuseNativePairedCompanionPlacement(string reasonCode, string detail)
    {
        this.hostAutomationTerminal = true;
        string recordsPath = this.config.HostAutomation?.HostPlayerScript?.RecordsPath ?? string.Empty;
        if (Path.IsPathFullyQualified(recordsPath))
        {
            FixtureRecordStream.TryAppendRecord(
                recordsPath,
                FixtureRecordStream.PlacementRecordDocument(
                    "rejected",
                    reasonCode,
                    Game1.currentLocation?.NameOrUniqueName ?? string.Empty,
                    Vector2.Zero,
                    Vector2.Zero,
                    string.Empty));
        }
        this.Monitor.Log(
            $"GameBuddy HostAutomation paired companion fixture blocked: {reasonCode};{detail}; no placement was published.",
            LogLevel.Error);
    }
}
