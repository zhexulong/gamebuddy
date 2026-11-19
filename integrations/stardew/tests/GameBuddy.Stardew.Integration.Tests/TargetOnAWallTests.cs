using System;
using System.Collections.Generic;
using FluentAssertions;
using GameBuddy.Stardew.Core;
using Microsoft.Xna.Framework;
using StardewValley;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The gate <c>a_target_on_a_wall_is_an_addressability_answer:&lt;action&gt;</c>: a walk to a coordinate that is not a
/// PLACE is answered as an addressability fact, not as a route fact.
///
/// <para>
/// THE DEFECT, measured `round78`: four <c>move_to_tile</c> requests named Backwoods tiles whose own ground the map
/// refuses and whose four neighbours all read <c>buildings_tile:blocked</c>. No body could ever be there or beside one
/// of them, so no published target family could have named them - the model read the map and guessed coordinates. The
/// walk answered <c>no_native_path</c>, which says the road is closed about a cell that is not a place at all, and each
/// refusal cost a turn while the companion re-aimed at neighbours of a wall.
/// </para>
///
/// <para>
/// The two questions are different and have different answers, so they get different words: a route question is answered
/// by the flood (<c>target_enclosed</c>, <c>approaches</c>, the frontier), and an addressability question by the map
/// (<c>target_on_map</c>, <c>target_passable</c>, the four approaches). Population: the four shapes a walk target can
/// have - a walled cell, an off-map coordinate, free ground whose ring is walled, and ordinary ground - because a gate
/// that only tested the defect could be satisfied by refusing everything.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the four refusals are produced by driving the real controller in a headless world, while the judgement that classifies them is fed the pre-fix receipt by hand - a rule that cannot be made red on the defect it describes is decoration.
[Collection(HeadlessGameWorld.Collection)]
public sealed class TargetOnAWallTests
{
    private const string Gate = "a_target_on_a_wall_is_an_addressability_answer:move_to_tile";

    private readonly ITestOutputHelper output;

    public TargetOnAWallTests(ITestOutputHelper output) => this.output = output;

    [Fact]
    public void EveryShapeOfWalkTargetGetsTheAnswerItEarned()
    {
        var cases = new List<(string Shape, string Code, string? Evidence, string? Hint, bool TileIsAPlace)>
        {
            DriveMapWall(),
            DriveOffMap(),
            DriveFreeGroundWithAWalledRing(),
            DriveOrdinaryGround(),
        };

        foreach ((string shape, string code, string? evidence, string? hint, bool tileIsAPlace) in cases)
            this.output.WriteLine($"{Gate}:{shape} -> {code} | {evidence}");

        cases[0].Code.Should().Be(
            StardewBodyController.TargetNotAddressableReasonCode,
            "a Buildings cell whose four neighbours are Buildings cells is not a place, and no route answer can be true of it");
        Field(cases[0].Evidence!, "target_on_map").Should().Be("true", "the cell exists on the map - it is the GROUND that refuses");
        Field(cases[0].Evidence!, "target_passable").Should().Be("false");
        cases[0].Evidence!.Should().Contain("approaches=", "the four walls ARE the answer, so the receipt names them");
        cases[0].Hint.Should().NotBeNull();
        cases[0].Hint!.Should().StartWith(StardewBodyController.TargetNotAddressableReasonCode);

        cases[1].Code.Should().Be(StardewBodyController.TargetNotAddressableReasonCode);
        Field(cases[1].Evidence!, "target_on_map").Should().Be("false", "and the receipt says which half of the question failed");

        // The boundary: free GROUND whose ring is walled by entities is a route question, not an addressability one. A
        // predicate that answered `not a place` here would refuse walks the engine can make.
        cases[2].TileIsAPlace.Should().BeTrue("the tile itself admits a body, so it IS a place");
        cases[2].Code.Should().Be(
            StardewBodyController.NoNativePathReasonCode,
            "with a body-admitting tile the answer is about the route, and the flood gives it");
        cases[2].Code.Should().NotBe(StardewBodyController.TargetNotAddressableReasonCode);

        cases[3].Code.Should().Be("accepted", "ordinary ground is walked to, and no refusal is minted at all");

        IReadOnlyList<string> findings = Judge(cases);
        findings.Should().BeEmpty(
            "shapes examined {0} · not a place {1} · answered by the route {2}: {3}",
            cases.Count,
            cases.Count(entry => entry.Code == StardewBodyController.TargetNotAddressableReasonCode),
            cases.Count(entry => entry.Code == StardewBodyController.NoNativePathReasonCode),
            string.Join(" ", findings));
        this.output.WriteLine(
            $"shapes examined {cases.Count}"
            + $" · not a place {cases.Count(entry => entry.Code == StardewBodyController.TargetNotAddressableReasonCode)}"
            + $" · answered by the route {cases.Count(entry => entry.Code == StardewBodyController.NoNativePathReasonCode)}"
            + $" · walked {cases.Count(entry => entry.Code == "accepted")}");
    }

    /// <summary>
    /// THE FALSIFIER on the gate itself: the round78 receipt for one of those cells, as the walk minted it before this
    /// change - <c>no_native_path</c>, <c>native=not_attempted</c>, and a Buildings wall for `blocked_by`. One finding,
    /// named by the action.
    /// </summary>
    [Fact]
    public void ARouteAnswerAboutAWallIsReportedByName()
    {
        var injected = new List<(string Shape, string Code, string? Evidence, string? Hint, bool TileIsAPlace)>
        {
            ("map_wall_as_the_old_receipt_minted_it",
                StardewBodyController.NoNativePathReasonCode,
                (string?)"from=40,10;to=22,31;native=not_attempted;probe=cardinal_flood;route_exists_cardinal=false;component_tiles=18;target_enclosed=true;target_standable=false;target_walkable=false;blocked_by=buildings_tile:blocked@22,31",
                Hint: null,
                TileIsAPlace: false),
        };

        Judge(injected).Should().Equal($"{Gate}:map_wall_as_the_old_receipt_minted_it");
    }

    /// <summary>
    /// One rule, over the worlds the drives produced: a target nothing can be AT or BESIDE is answered by
    /// <see cref="StardewBodyController.TargetNotAddressableReasonCode"/>, and that code is never minted for a tile a body
    /// could occupy. <c>TileIsAPlace</c> is the ENGINE's own reading, taken in the drive from
    /// <c>isTileOnMap</c>/<c>isTilePassable</c> - the authority the product's predicate composes, so the two can
    /// disagree here instead of agreeing by construction.
    /// </summary>
    internal static IReadOnlyList<string> Judge(
        IReadOnlyList<(string Shape, string Code, string? Evidence, string? Hint, bool TileIsAPlace)> cases)
    {
        var findings = new List<string>();
        foreach ((string shape, string code, string? evidence, string? hint, bool tileIsAPlace) in cases)
        {
            bool answeredAsAPlace = code == StardewBodyController.TargetNotAddressableReasonCode;
            if (answeredAsAPlace == tileIsAPlace)
                findings.Add($"{Gate}:{shape}");
            else if (!tileIsAPlace && evidence is null)
                findings.Add($"{Gate}:{shape}");
            else if (answeredAsAPlace && hint is null)
                findings.Add($"{Gate}:{shape}");
        }

        return findings;
    }

    // -------------------------------------------------------------------------
    // The four worlds, each driven through the entry every walking action shares.
    // -------------------------------------------------------------------------

    /// <summary>The measured shape: a Buildings cell with Buildings neighbours.</summary>
    private static (string Shape, string Code, string? Evidence, string? Hint, bool TileIsAPlace) DriveMapWall()
    {
        using ClearStepMoveTests.CorridorHarness harness = ClearStepMoveTests.CorridorHarness.Create();
        harness.BuildCorridor();
        var target = (X: 9, Y: 6);
        WallMapTiles(harness, target, (target.X, target.Y - 1), (target.X + 1, target.Y), (target.X, target.Y + 1), (target.X - 1, target.Y));
        (string code, string? evidence, string? hint) = Refuse(harness, 2, 3, new Vector2(target.X, target.Y));
        return ("map_wall", code, evidence, hint, TileIsAPlace(harness.Location, target));
    }

    /// <summary>A coordinate the map does not contain at all - the other way a target is not a place.</summary>
    private static (string Shape, string Code, string? Evidence, string? Hint, bool TileIsAPlace) DriveOffMap()
    {
        using ClearStepMoveTests.CorridorHarness harness = ClearStepMoveTests.CorridorHarness.Create();
        harness.BuildCorridor();
        var target = (X: 40, Y: 3);
        (string code, string? evidence, string? hint) = Refuse(harness, 2, target.Y, new Vector2(target.X, target.Y));
        return ("off_map", code, evidence, hint, TileIsAPlace(harness.Location, target));
    }

    /// <summary>Free GROUND whose four neighbours are walled by entities: a place, and a route problem.</summary>
    private static (string Shape, string Code, string? Evidence, string? Hint, bool TileIsAPlace) DriveFreeGroundWithAWalledRing()
    {
        using ClearStepMoveTests.CorridorHarness harness = ClearStepMoveTests.CorridorHarness.Create();
        harness.BuildCorridor();
        var target = (X: 9, Y: 9);
        foreach ((int x, int y) in new[] { (target.X, target.Y - 1), (target.X + 1, target.Y), (target.X, target.Y + 1), (target.X - 1, target.Y) })
            harness.Location.resourceClumps.Add(new StardewValley.TerrainFeatures.ResourceClump(0, 1, 1, new Vector2(x, y)));
        (string code, string? evidence, string? hint) = Refuse(harness, 2, 3, new Vector2(target.X, target.Y));
        return ("free_ground_walled_ring", code, evidence, hint, TileIsAPlace(harness.Location, target));
    }

    /// <summary>Ordinary ground: the walk is accepted, so nothing here may be refused as "not a place".</summary>
    private static (string Shape, string Code, string? Evidence, string? Hint, bool TileIsAPlace) DriveOrdinaryGround()
    {
        using ClearStepMoveTests.CorridorHarness harness = ClearStepMoveTests.CorridorHarness.Create();
        harness.BuildCorridor();
        var target = (X: 9, Y: 3);
        (string code, string? evidence, string? hint) = Refuse(harness, 2, 3, new Vector2(target.X, target.Y));
        return ("ordinary_ground", code, evidence, hint, TileIsAPlace(harness.Location, target));
    }

    private static (string Code, string? Evidence, string? Hint) Refuse(
        ClearStepMoveTests.CorridorHarness harness,
        int fromX,
        int fromY,
        Vector2? target = null)
    {
        harness.Actor.position.Set(new Vector2(fromX * 64 + 8, fromY * 64));
        var specification = new LocalMoveSpec(
            "execution_01",
            "request_01",
            target ?? new Vector2(9f, 6f),
            AllowAdjacentArrival: false,
            1,
            10_000,
            long.MaxValue);
        bool started = new StardewBodyController((_, _, _) => { })
            .TryStart(specification, harness.Actor, tick: 1, out string reasonCode, out string? evidence, out string? hint);
        return (started ? "accepted" : reasonCode, evidence, hint);
    }

    /// <summary>
    /// The ENGINE's answer to "can a body be at or beside this tile", read directly from the two map calls the product's
    /// predicate composes - so the gate's population is decided by the engine and not by the predicate under test.
    /// </summary>
    private static bool TileIsAPlace(GameLocation location, (int X, int Y) tile)
    {
        if (!location.isTileOnMap(new Vector2(tile.X, tile.Y)))
            return false;
        if (location.isTilePassable(new Vector2(tile.X, tile.Y)))
            return true;
        foreach ((int x, int y) in new[] { (tile.X - 1, tile.Y), (tile.X + 1, tile.Y), (tile.X, tile.Y - 1), (tile.X, tile.Y + 1) })
        {
            if (location.isTileOnMap(new Vector2(x, y)) && location.isTilePassable(new Vector2(x, y)))
                return true;
        }

        return false;
    }

    /// <summary>
    /// Back AND Buildings tiles for each cell, the way <c>TillSoilHarness.Wall</c> and the water pocket build a wall: a
    /// Buildings tile with neither `Shadow` nor `Passable` refuses the step (`GameLocation.isTilePassable`), which is the
    /// condition the measured Backwoods cells were in.
    /// </summary>
    private static void WallMapTiles(ClearStepMoveTests.CorridorHarness harness, params (int X, int Y)[] tiles)
    {
        var map = harness.Location.map;
        var tileSize = new xTile.Dimensions.Size(64, 64);
        var sheet = new xTile.Tiles.TileSheet("target_wall", map, "Maps/spring_outdoorsTileSheet", tileSize, tileSize);
        map.AddTileSheet(sheet);
        xTile.Layers.Layer back = map.GetLayer("Back");
        xTile.Layers.Layer buildings = map.GetLayer("Buildings");
        foreach ((int x, int y) in tiles)
        {
            var backTile = new xTile.Tiles.StaticTile(back, sheet, xTile.Tiles.BlendMode.Alpha, 0);
            // The property `isTilePassable` reads on the Back layer (GameLocation.cs:2898-2911): the map declaring its own
            // ground impassable, which is what a Backwoods cell behind a building footprint reads as.
            backTile.Properties["Passable"] = "F";
            back.Tiles[x, y] = backTile;
            buildings.Tiles[x, y] = new xTile.Tiles.StaticTile(buildings, sheet, xTile.Tiles.BlendMode.Alpha, 0);
        }
    }

    /// <summary>One `k=v` field of a receipt's evidence, or null when the field is absent.</summary>
    private static string? Field(string evidence, string name)
    {
        foreach (string entry in evidence.Split(';'))
        {
            int equals = entry.IndexOf('=');
            if (equals > 0 && entry[..equals] == name)
                return entry[(equals + 1)..];
        }

        return null;
    }
}