using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using FluentAssertions;
using Microsoft.Xna.Framework;
using StardewValley;
using StardewValley.GameData.Buildings;
using GameBuddy.Stardew.Core;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// THE ASSUMPTION UNDER THE WALKWAY RULE, gated row by row. <see cref="FieldLayout.NonFieldKind"/> keeps
/// <c>door.Y + 1 .. door.Y + WalkwayDepth</c> as a walkway - the rows BELOW the human door - which is the ground an actor
/// crosses to reach the door only if the door opens onto the SOUTH face of the building. Every vanilla building's door
/// does; a door on another face would have this rule farm the ground in front of it and leave the real approach as field.
///
/// <para>
/// WHAT THE ENGINE CAN ANSWER, and therefore what this gate is built on. There is no facing anywhere:
/// <c>Building.humanDoor</c> (from <c>BuildingData.HumanDoor</c>, <c>Building.LoadFromBuildingData</c>) is an OFFSET
/// inside the footprint, and neither the instance nor the row carries a side, a direction or a rotation. What the engine
/// does instead is treat the row one tile south of that offset as the approach, in every entry path it owns:
/// <c>Building.updateInteriorWarps</c> targets <c>humanDoor.Y + tileY + 1</c>, <c>Farm.mainFarmhouseEntry</c> is
/// <c>humanDoor.Y + tileY + 1</c>, <c>GameLocation</c>'s door warps build the same tile, and
/// <c>GreenhouseBuilding</c> draws its entrance from <c>humanDoor.Y + 1</c>. So "south" is the engine's own rule for a
/// door it can be walked through, and the two facts a row can state about it are: the door lies inside the footprint, and
/// it does not sit on the footprint's TOP edge - a door there has no ground to the south that is not the building itself.
/// </para>
///
/// <para>
/// THE BOTTOM ROW IS NOT THE SAME FACT AS THE SOUTH FACE, which is why this gate does not assert "the door is on the
/// footprint's bottom row": measured on the installed table, two rows are south doors whose footprint continues BELOW
/// them - <c>Cabin</c> (<c>door=2,1</c> in <c>5x3</c>) and <c>Farmhouse</c> (<c>door=5,2</c> in <c>9x5</c>) - because a
/// house's front porch is part of its footprint, and rows below the door are then inside the footprint, which the rule
/// asks first. Those two are printed rather than failed; a row whose door is on the top edge, outside the footprint, or
/// over an empty footprint is failed by name.
/// </para>
///
/// <para>
/// THE POPULATION IS THE TABLE'S, NOT A LIST: every row of the installed <c>Data/Buildings</c>, loaded through the
/// engine's own <c>DataLoader.Buildings</c>, so a row that is added, removed or re-doored changes the examined set
/// without anyone editing this file. A row that declares no human door (<c>-1,-1</c>, the engine's own "no door" value,
/// <c>Building.isActionableTile</c>) is examined and counted as doorless. WHAT IT CANNOT COVER: a modded building's row
/// is added to <c>Game1.buildingData</c> at runtime, so it is not in the installed table this gate reads - the walkway
/// rule states that limitation beside itself.
/// </para>
/// </summary>
[Collection(HeadlessGameWorld.Collection)]
public sealed class FixtureWalkwaySouthDoorGateTests
{
    /// <summary>
    /// The failure word, in one place: the building, the door the row declared, and the footprint that door is an offset
    /// into. It names the building rather than a distance so the next reader knows which row of <c>Data/Buildings</c> to
    /// open.
    /// </summary>
    internal const string SouthDoorRefusal = "fixture_walkway_assumes_a_south_door";

    /// <summary>The MSBuild property the test project hands this gate, so it opens the installation the build used.</summary>
    private const string GamePathMetadataKey = "StardewGamePath";

    private readonly ITestOutputHelper output;

    public FixtureWalkwaySouthDoorGateTests(ITestOutputHelper output) => this.output = output;

    /// <summary>
    /// THE RULE MUST NOT FARM THE DOORWAY. For every row that declares a door, the tile one row south of it - the tile the
    /// engine itself enters the building from - is asked of <see cref="FieldLayout"/> built from that row's own
    /// footprint and door, and an answer of field ground is the walkway rule failing at the one thing it exists for. The
    /// rule is the product's, not a copy of it: the assertion drives <see cref="FieldLayout.Of"/> and reads
    /// <see cref="FieldLayout.IsFieldGround"/>.
    /// </summary>
    [Fact]
    public void TheWalkwayRuleNeverFarmsTheRowTheEngineEntersTheDoorFrom()
    {
        Dictionary<string, BuildingData> rows = InstalledBuildingRows();
        rows.Should().NotBeEmpty("a table with no rows would agree with itself about every building it never read");

        List<string> doorless = new();
        List<string> enteredFromAWalkway = new();
        List<string> offenders = new();
        foreach (KeyValuePair<string, BuildingData> row in rows.OrderBy(entry => entry.Key, StringComparer.Ordinal))
        {
            Point door = row.Value.HumanDoor;
            if (door == new Point(-1, -1))
            {
                doorless.Add(row.Key);
                continue;
            }

            int height = row.Value.Size.Y;
            FieldLayout layout = FieldLayout.Of(
                new[] { new FootprintRect(0, 0, row.Value.Size.X, height) },
                new[] { new TilePoint(door.X, door.Y) });
            if (layout.IsFieldGround(door.X, door.Y + 1))
            {
                offenders.Add(RowFailure(row.Key, door, row.Value.Size));
                continue;
            }

            enteredFromAWalkway.Add(row.Key);
        }

        this.output.WriteLine(
            $"{SouthDoorRefusal}: examined {rows.Count} buildings from the installed Data/Buildings"
            + $" · entered-from-a-row-the-rule-keeps {enteredFromAWalkway.Count}"
            + $" · no-human-door {doorless.Count}"
            + $" · doorway-farmed {offenders.Count}");

        offenders.Should().BeEmpty(
            "the row one tile south of a door is the tile the engine enters the building from (Building.updateInteriorWarps, "
            + "Farm.mainFarmhouseEntry, GameLocation's door warps), so the layout must never call it field: "
            + string.Join(" | ", offenders));
        enteredFromAWalkway.Should().NotBeEmpty(
            "a gate that examined no doorway would be green about nothing; doorless rows examined: "
            + string.Join(",", doorless));
    }

    /// <summary>
    /// THE TWO SHAPES A ROW MUST HAVE FOR "THE ROWS SOUTH OF THE DOOR" TO MEAN ANYTHING: the door lies INSIDE the
    /// footprint the rule reads (<see cref="FieldLayout.Of"/> drops an empty footprint, which would turn a building's own
    /// tiles into field), and it does not sit on the footprint's TOP edge - a door there is entered from a row that is
    /// part of the building, so the approach could not be walked from outside.
    ///
    /// <para>
    /// The doors that are <c>Data/Buildings</c>-legal south doors without being on the footprint's bottom row are PRINTED,
    /// not failed: a house's front porch is inside its footprint (measured: <c>Cabin</c> and <c>Farmhouse</c>), and rows
    /// below such a door are the building's own ground, which the rule asks before it asks about walkways.
    /// </para>
    /// </summary>
    [Fact]
    public void EveryDeclaredHumanDoorIsInsideItsFootprintAndClearOfTheTopEdge()
    {
        Dictionary<string, BuildingData> rows = InstalledBuildingRows();
        rows.Should().NotBeEmpty("a table with no rows would agree with itself about every building it never read");

        List<string> doorless = new();
        List<string> onTheBottomRow = new();
        List<string> porchBelowTheDoor = new();
        List<string> offenders = new();
        foreach (KeyValuePair<string, BuildingData> row in rows.OrderBy(entry => entry.Key, StringComparer.Ordinal))
        {
            Point door = row.Value.HumanDoor;
            Point size = row.Value.Size;
            if (door == new Point(-1, -1))
            {
                doorless.Add(row.Key);
                continue;
            }

            bool insideTheFootprint = size.X > 0 && size.Y > 0 && door.X >= 0 && door.X < size.X && door.Y >= 0 && door.Y < size.Y;
            bool onTheTopEdge = size.Y > 1 && door.Y == 0;
            if (!insideTheFootprint || onTheTopEdge)
            {
                offenders.Add(RowFailure(row.Key, door, size));
                continue;
            }

            if (door.Y == size.Y - 1)
                onTheBottomRow.Add(row.Key);
            else
                porchBelowTheDoor.Add($"{row.Key}(door={door.X},{door.Y},footprint=0,0..{size.X - 1},{size.Y - 1})");
        }

        this.output.WriteLine(
            $"{SouthDoorRefusal}: examined {rows.Count} buildings from the installed Data/Buildings"
            + $" · door-on-the-bottom-row {onTheBottomRow.Count}"
            + $" · south-door-with-porch-rows-below {porchBelowTheDoor.Count} [{string.Join(" ", porchBelowTheDoor)}]"
            + $" · no-human-door {doorless.Count}"
            + $" · not-inside-the-footprint-or-on-its-top-edge {offenders.Count}");

        offenders.Should().BeEmpty(
            "a door outside its footprint, or on its top edge, is a row this rule's \"rows south of the door\" cannot "
            + $"serve: {string.Join(" | ", offenders)}");
        (onTheBottomRow.Count + porchBelowTheDoor.Count).Should().BeGreaterThan(
            0,
            "a gate that examined no door would be green about nothing; doorless rows examined: "
            + string.Join(",", doorless));
    }

    /// <summary>One line per offending row, in the shape the walkway rule's documentation names.</summary>
    private static string RowFailure(string building, Point door, Point size) =>
        $"{SouthDoorRefusal}:{building}:door={door.X},{door.Y}:footprint=0,0..{size.X - 1},{size.Y - 1}";

    /// <summary>
    /// EVERY ROW OF THE INSTALLED <c>Data/Buildings</c>, read the way the product reads it - the engine's own
    /// <see cref="DataLoader.Buildings"/> through a <see cref="LocalizedContentManager"/> over the installation's
    /// <c>Content</c> directory - so no row is transcribed here and a second copy of the table cannot disagree with the
    /// game this build targets.
    ///
    /// <para>
    /// A process that cannot open the installation is NOT MEASURED, and says so by name rather than passing: the rows are
    /// the population, so a gate that could not read them has not examined anything.
    /// </para>
    /// </summary>
    private static Dictionary<string, BuildingData> InstalledBuildingRows()
    {
        string gameRoot = DeclaredGamePath();
        string contentRoot = Path.Combine(gameRoot, "Content");
        Directory.Exists(contentRoot).Should().BeTrue(
            $"not_measured: the installation this project built against ({gameRoot}) has no Content directory, so no "
            + "Data/Buildings row could be read");

        using var content = new LocalizedContentManager(new NoServices(), contentRoot);
        return DataLoader.Buildings(content);
    }

    /// <summary>
    /// The installation the build resolved (<c>GamePath</c> in the test project), carried into the assembly as metadata
    /// so this gate opens that exact directory instead of a second literal that drifts.
    /// </summary>
    private static string DeclaredGamePath()
    {
        string? declared = typeof(FixtureWalkwaySouthDoorGateTests).Assembly
            .GetCustomAttributes<AssemblyMetadataAttribute>()
            .FirstOrDefault(attribute => string.Equals(attribute.Key, GamePathMetadataKey, StringComparison.Ordinal))
            ?.Value;
        declared.Should().NotBeNullOrWhiteSpace(
            $"the test project must declare {GamePathMetadataKey} metadata - the gate reads the installed Data/Buildings "
            + "rows and cannot invent a path to them");
        return declared!;
    }

    /// <summary>
    /// The content manager's service provider. <c>Data/Buildings</c> is a data asset, so nothing here serves a graphics
    /// device; the engine's own loader reads the table through this shape.
    /// </summary>
    private sealed class NoServices : IServiceProvider
    {
        public object? GetService(Type serviceType) => null;
    }
}
