using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;

namespace GameBuddy.Stardew;

/// <summary>
/// <c>native_paired_companion_v1</c>'s CLIENT half: the companion's own process stands her on the tile the Host
/// published, and reports the tile she reached.
///
/// <para>
/// WHY THIS HALF LIVES IN HER PROCESS. Her body is hers: a Farmhand joining a LAN world is placed by its OWN client
/// (<c>Client.setUpGame</c> -&gt; <c>BedFurniture.ApplyWakeUpPosition</c>, Client.cs:208) and
/// <c>NetWorldState.ResetFarmhandState</c> puts her in her Cabin (NetWorldState.cs:756-775), while the only warp a
/// fixture has - <c>Farmer.warpFarmer</c> - warps <c>Game1.player</c> of the process that calls it (Farmer.cs:5753 -&gt;
/// Game1.cs:10019-10032). In THIS process `Game1.player` IS the companion, so the same call is the right one; called from
/// the Host it would move the Host player. That is the whole of why the paired world has a half in each process.
/// </para>
///
/// <para>
/// WHAT IT READS AND WHAT IT WRITES. Both directions travel the fixture's existing record stream
/// (<see cref="HostPlayerScriptChannel"/>'s <c>RecordsPath</c>), which is the only channel between the two processes
/// besides the bridge - and the bridge is the companion's own single consumer, so a fixture fact must not travel it. The
/// publication is <c>action=placement,state=published</c> with a generation; her report is the same action with
/// <c>state=placed</c> (or <c>state=rejected</c> plus this process's own code), the tile she is standing on and the
/// generation it answers. A report is an ACT, not an assumption: S1 refuses to start without one.
/// </para>
///
/// <para>
/// IT DOES NOT JUDGE ITS OWN PLACEMENT. The tile she reached is reported as read; whether that is the tile the world was
/// built around is the Host's verification (<see cref="TryVerifyNativePairedCompanionPlacement"/>), which has the crop,
/// the container and the radius in one place. A process that compared its own tile against its own intent would be the
/// only witness of its own success.
/// </para>
/// </summary>
public sealed partial class ModEntry
{
    /// <summary>Where this process is in its own placement, so the warp is requested once and reported once.</summary>
    private enum NativePairedCompanionPlacementPhase
    {
        /// <summary>Nothing published on the stream yet, or this process is not the companion.</summary>
        Idle,

        /// <summary>The published tile was accepted here and the engine's own warp has been requested.</summary>
        Requested,

        /// <summary>She is on the published map and the report is on the stream.</summary>
        Placed,

        /// <summary>This process refused to stand there, and the refusal is on the stream.</summary>
        Rejected,
    }

    private NativePairedCompanionPlacementPhase nativePairedCompanionPlacementPhase;
    private string nativePairedCompanionPlacementGeneration = string.Empty;
    private string nativePairedCompanionPlacementFarm = string.Empty;
    private Vector2 nativePairedCompanionPlacementTile;

    /// <summary>
    /// One tick of her half: find the newest publication, stand on it through the engine's own warp, then report the
    /// tile she is on once the warp has landed.
    ///
    /// <para>
    /// A no-op on the Host (<c>Game1.IsMasterGame</c>), on a process with no record stream armed, and on any run that
    /// never published a placement - so the single-player lane, where the same world is built and its actor warped
    /// directly, is untouched.
    /// </para>
    /// </summary>
    internal void TryPlaceNativePairedCompanionFixture()
    {
        if (Game1.IsMasterGame)
            return;
        if (this.nativePairedCompanionPlacementPhase is NativePairedCompanionPlacementPhase.Placed or NativePairedCompanionPlacementPhase.Rejected)
            return;
        HostPlayerScriptConfig? stream = this.config.HostAutomation?.HostPlayerScript;
        if (stream is not { Enable: true } || !Path.IsPathFullyQualified(stream.RecordsPath))
            return;
        if (!Context.IsWorldReady || Game1.player is not Farmer companion)
            return;

        if (this.nativePairedCompanionPlacementPhase == NativePairedCompanionPlacementPhase.Idle)
        {
            FixtureRecordStream.PlacementRecord? published = FixtureRecordStream
                .ReadPlacementRecords(stream.RecordsPath)
                .LastOrDefault(record => string.Equals(record.State, "published", StringComparison.Ordinal));
            if (published is null || published.Generation.Length == 0)
                return;
            if (Game1.getLocationFromName(published.Location) is not StardewValley.Farm farm)
            {
                RefuseNativePairedCompanionStanding(
                    stream.RecordsPath,
                    published,
                    $"paired_companion_placement_location_missing:{published.Location}");
                return;
            }
            if (!StardewBodyController.IsStandableTile(farm, companion, published.Tile))
            {
                RefuseNativePairedCompanionStanding(
                    stream.RecordsPath,
                    published,
                    $"paired_companion_placement_tile_not_standable:{(int)published.Tile.X},{(int)published.Tile.Y}");
                return;
            }
            this.nativePairedCompanionPlacementGeneration = published.Generation;
            this.nativePairedCompanionPlacementFarm = farm.NameOrUniqueName;
            this.nativePairedCompanionPlacementTile = published.Tile;
            this.nativePairedCompanionPlacementPhase = NativePairedCompanionPlacementPhase.Requested;
            companion.warpFarmer(new StardewValley.Warp(
                0, 0, farm.NameOrUniqueName, (int)published.Tile.X, (int)published.Tile.Y, false));
            this.Monitor.Log(
                "GameBuddy paired companion requested its own placement from the Host's publication: "
                    + $"generation={published.Generation};location={farm.NameOrUniqueName};"
                    + $"from={(int)companion.Tile.X},{(int)companion.Tile.Y};to={(int)published.Tile.X},{(int)published.Tile.Y};"
                    + "the engine's own warp completes it on a later frame, so the report waits for the arrival.",
                LogLevel.Info);
            return;
        }

        // Requested: the warp is the engine's, and it lands on a later frame. The report is written from where she
        // actually is, and only once she is on the published map.
        if (!string.Equals(companion.currentLocation?.NameOrUniqueName, this.nativePairedCompanionPlacementFarm, StringComparison.Ordinal))
            return;
        var report = FixtureRecordStream.PlacementRecordDocument(
            "placed",
            "paired_companion_placement_reported",
            this.nativePairedCompanionPlacementFarm,
            companion.Tile,
            this.nativePairedCompanionPlacementTile,
            this.nativePairedCompanionPlacementGeneration);
        if (!FixtureRecordStream.TryAppendRecord(stream.RecordsPath, report))
        {
            // The stream is the instrument: an unwritten report is retried on the next tick rather than claimed in the
            // log, because the Host and S1 both read the record and neither reads this log.
            return;
        }
        this.nativePairedCompanionPlacementPhase = NativePairedCompanionPlacementPhase.Placed;
        this.Monitor.Log(
            "GameBuddy paired companion reported its own placement: "
                + $"placed@{(int)companion.Tile.X},{(int)companion.Tile.Y};"
                + $"requested={(int)this.nativePairedCompanionPlacementTile.X},{(int)this.nativePairedCompanionPlacementTile.Y};"
                + $"location={this.nativePairedCompanionPlacementFarm};generation={this.nativePairedCompanionPlacementGeneration};"
                + "the Host verifies the report against the world it built.",
            LogLevel.Info);
    }

    /// <summary>
    /// This process refusing to stand on the published tile, named and on the stream: the Host carries the code through
    /// and S1 stops on it, so a tile she cannot stand on is never read as a companion who failed to show up.
    /// </summary>
    private void RefuseNativePairedCompanionStanding(
        string recordsPath,
        FixtureRecordStream.PlacementRecord published,
        string reasonCode)
    {
        this.nativePairedCompanionPlacementPhase = NativePairedCompanionPlacementPhase.Rejected;
        FixtureRecordStream.TryAppendRecord(
            recordsPath,
            FixtureRecordStream.PlacementRecordDocument(
                "rejected",
                reasonCode,
                published.Location,
                Game1.player?.Tile ?? Vector2.Zero,
                published.Tile,
                published.Generation));
        this.Monitor.Log(
            $"GameBuddy paired companion refused the published placement: {reasonCode};"
                + $"published={(int)published.Tile.X},{(int)published.Tile.Y};location={published.Location};"
                + $"generation={published.Generation}.",
            LogLevel.Error);
    }
}
