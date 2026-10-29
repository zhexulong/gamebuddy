using System;
using System.IO;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The facility family's four building call sites — <c>deposit_silo_hay</c>, <c>withdraw_silo_hay</c>,
/// <c>clear_fish_pond</c> and <c>toggle_animal_door</c> — all published a building's interaction tile as
/// <c>getPointForHumanDoor()</c> and all measured reach as Chebyshev-1 of the request's <c>x,y</c>.
///
/// That is right only for buildings that DECLARE a human door. Measured against this installation's own
/// <c>Data/Buildings</c>, loaded through the game's own <c>ContentManager</c>:
///
/// <code>
/// Silo       size=3x3 humanDoor=-1,-1
/// Fish Pond  size=5x5 humanDoor=-1,-1
/// Coop       size=6x3 humanDoor=1,2
/// Barn       size=7x4 humanDoor=1,3
/// </code>
///
/// So <c>getPointForHumanDoor()</c> on a Silo answers <c>(tileX - 1, tileY - 1)</c> — one tile diagonally
/// OUTSIDE the building. A reach test against that point admits an actor only in the silo's north-west
/// quadrant and refuses a companion standing at its south face as <c>silo_target_out_of_range</c>, naming a
/// distance rather than the missing door. The engine itself guards on <c>humanDoor.X &gt;= 0</c> before using
/// the field (<c>Building.cs:1088</c>), which is it admitting the field has a "no door" value.
///
/// These cases pin the wiring: every one of the four asks the CONTACT SHAPE of the resolved building rather
/// than a point derived from the request.
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the pins here assert on repository source text because the native seam they cover cannot load in a headless runner, while the rest of the class constructs and calls product code for real; keeping both in one file keeps each pin beside the behaviour it protects.
public sealed class BuildingContactWiringTests
{
    [Fact]
    public void EveryFamilyReachGateAsksTheBuildingsContactShape_NotAPointFromTheRequest()
    {
        // The building-shaped call sites, each named by the method that owns it. The family also has
        // point-target actions (clear_cask, dress_mannequin, set_sign_display) which legitimately measure
        // reach against the object's own tile - a cask is ON a tile, it is not a building - so the pin is
        // scoped to the methods that name a BUILDING.
        var buildingSites = new[]
        {
            ("farmhandexecutioncontroller.facilityactions.cs", "public LocalExecutionReceipt RequestLocalDepositSiloHay("),
            ("farmhandexecutioncontroller.facilityactions.cs", "private LocalExecutionReceipt ExecuteDepositSiloHay("),
            ("farmhandexecutioncontroller.silohaywithdrawactions.cs", "public LocalExecutionReceipt RequestLocalWithdrawSiloHay("),
            ("farmhandexecutioncontroller.silohaywithdrawactions.cs", "private LocalExecutionReceipt ExecuteWithdrawSiloHay("),
            ("farmhandexecutioncontroller.pondactions.cs", "public LocalExecutionReceipt RequestLocalClearFishPond("),
            ("farmhandexecutioncontroller.animaldooractions.cs", "public LocalExecutionReceipt RequestLocalToggleAnimalDoor("),
            ("farmhandexecutioncontroller.animaldooractions.cs", "private LocalExecutionReceipt ExecuteToggleAnimalDoor("),
        };

        foreach ((string handler, string declaration) in buildingSites)
        {
            string body = MethodBody(ReadRepositoryFile(Path.Combine("integrations", "stardew", handler)), declaration);

            body.Should().Contain("IsWithinBuildingContact(", $"{handler}:{declaration} must admit reach through the shared contact rule");
            // NEGATIVE: the old rule measured the ACTOR against the request's own x,y, which for a
            // door-less building is the collapsed (-1,-1) point. A branch that still did that would
            // reintroduce the north-west-quadrant-only refusal this wiring removes.
            body.Should().NotContain(
                "IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1)",
                $"{handler}:{declaration} must not measure reach against the published point");
            body.Should().NotContain(
                "IsTileWithinChebyshevRadius(Game1.player, (int)door.X, (int)door.Y, 1)",
                $"{handler}:{declaration} must not measure reach against the human-door point");
        }
    }

    [Fact]
    public void TheProjectionReadsTheDeclaredDoorFromBuildingData_SoNoDoorStaysDistinguishable()
    {
        string facility = ReadRepositoryFile(Path.Combine("integrations", "stardew", "farmhandexecutioncontroller.facilityactions.cs"));
        string projection = MethodBody(facility, "internal static BuildingContact BuildingContactOf(Building building)");

        // The three outcomes must be decided by what the DATA declares, not by whatever the deserialised
        // `humanDoor` field happens to hold: (-1,-1) is the engine's own "no door" value.
        projection.Should().Contain("building.GetData()?.HumanDoor");
        projection.Should().Contain("BuildingContact.WithHumanDoor(");
        projection.Should().Contain("BuildingContact.WithoutHumanDoor(");
        projection.Should().Contain("BuildingContact.Unreachable()");

        // The footprint comes from the same data the door does (`Building.cs:500-503`), so a building that
        // resized cannot keep a stale footprint.
        projection.Should().Contain("building.tilesWide.Value");
        projection.Should().Contain("building.tilesHigh.Value");
    }

    [Fact]
    public void ADoorLessBuildingIsReachedFromAnyFace_ADoorBuildingFromItsDoor()
    {
        // A silo as the data declares it: 3x3 at (20,20), no human door. Every face is contact; the
        // interior is not, because nobody stands inside a silo.
        BuildingContact silo = BuildingContact.WithoutHumanDoor(new FootprintRect(20, 20, 3, 3));
        silo.IsWithinContact(new TilePoint(20, 23)).Should().BeTrue("the south face");
        silo.IsWithinContact(new TilePoint(23, 21)).Should().BeTrue("the east face");
        silo.IsWithinContact(new TilePoint(21, 21)).Should().BeFalse("inside the silo");

        // The point the OLD rule used for this silo, and what the ring rule says about it. The collapsed
        // door point lands in the silo's north-WEST ring corner, which is exactly the defect: that one
        // quadrant was the whole of the admission, while the south face above was refused.
        var collapsedDoorPoint = new TilePoint(20 - 1, 20 - 1);
        silo.IsWithinContact(collapsedDoorPoint).Should().BeTrue("the collapsed point is the north-west ring corner");
        silo.IsWithinContact(new TilePoint(20, 24)).Should().BeFalse("but the ring does not reach past it either");

        // A coop declares a door, so it is touched from that door and not from its far corner.
        BuildingContact coop = BuildingContact.WithHumanDoor(new TilePoint(11, 12), new FootprintRect(10, 10, 6, 3));
        coop.IsWithinContact(new TilePoint(11, 12)).Should().BeTrue("standing on the door");
        coop.IsWithinContact(new TilePoint(10, 12)).Should().BeTrue("one tile west of it");
        coop.IsWithinContact(new TilePoint(15, 12)).Should().BeFalse("the far east corner is not the door");
    }

    [Fact]
    public void TheApproachTargetsAreTheFootprintForADoorLessBuilding_NotTheCollapsedPoint()
    {
        // What the walk selector is handed. A silo offers its occupied tiles, so the selector's own
        // neighbour rule can pick ANY face; handing it the collapsed (-1,-1) door point would offer a
        // tile outside the building and the selector would search from there.
        var footprint = new FootprintRect(20, 20, 3, 3);
        BuildingContact silo = BuildingContact.WithoutHumanDoor(footprint);
        silo.ContactTiles().Should().HaveCount(9, "a 3x3 footprint");
        silo.ContactTiles().Should().Contain(new TilePoint(20, 20));
        silo.ContactTiles().Should().Contain(new TilePoint(22, 22));
        silo.ContactTiles().Should().NotContain(new TilePoint(19, 19), "the collapsed door point is not a silo tile");

        BuildingContact coop = BuildingContact.WithHumanDoor(new TilePoint(11, 12), new FootprintRect(10, 10, 6, 3));
        coop.ContactTiles().Should().Equal(new[] { new TilePoint(11, 12) }, "a door is the whole answer");

        BuildingContact unreachable = BuildingContact.Unreachable();
        unreachable.ContactTiles().Should().BeEmpty("there is nothing to stand beside");
    }

    [Fact]
    public void AnEmptyFootprintIsRefusedByNameBeforeAnyWalkIsDispatched()
    {
        string facility = ReadRepositoryFile(Path.Combine("integrations", "stardew", "farmhandexecutioncontroller.facilityactions.cs"));
        string approach = MethodBody(facility, "private LocalExecutionReceipt TryBeginBuildingApproach(");

        // A building whose footprint is empty has no contact tiles, so the approach must refuse by a code
        // an agent can branch on rather than dispatch a walk to a tile it does not have.
        approach.Should().Contain("contactTiles.Length == 0");
        approach.Should().Contain("\"building_unreachable\"");
        int refusal = approach.IndexOf("\"building_unreachable\"", StringComparison.Ordinal);
        int dispatch = approach.IndexOf("TryBeginToolApproach(", StringComparison.Ordinal);
        refusal.Should().BeGreaterThanOrEqualTo(0);
        dispatch.Should().BeGreaterThan(refusal, "the refusal must precede the walk");
    }

    [Fact]
    public void TheOutOfRangeEvidenceNamesTheRelationshipThatWasTested()
    {
        string facility = ReadRepositoryFile(Path.Combine("integrations", "stardew", "farmhandexecutioncontroller.facilityactions.cs"));
        string describe = MethodBody(facility, "internal static string DescribeBuildingContact(Building building)");

        // A refusal that only names a distance sends a reader to the wrong layer: the missing fact is
        // WHICH relationship was tested, so the receipt says door or ring and its tiles.
        describe.Should().Contain("human_door=");
        describe.Should().Contain("ring=");
        describe.Should().Contain("\"unreachable\"");

        // And the three refusals that use it carry it.
        string withdraw = ReadRepositoryFile(Path.Combine("integrations", "stardew", "farmhandexecutioncontroller.silohaywithdrawactions.cs"));
        MethodBody(withdraw, "private LocalExecutionReceipt ExecuteWithdrawSiloHay(")
            .Should().Contain("contact={DescribeBuildingContact(silo!)}");

        string animalDoor = ReadRepositoryFile(Path.Combine("integrations", "stardew", "farmhandexecutioncontroller.animaldooractions.cs"));
        MethodBody(animalDoor, "private LocalExecutionReceipt ExecuteToggleAnimalDoor(")
            .Should().Contain("contact={DescribeBuildingContact(resolution.Building!)}");
    }

    // ---------------------------------------------------------------------------------

    /// <summary>Extract one member body by brace balance from its declaration.</summary>
    private static string MethodBody(string source, string declaration)
    {
        int start = source.IndexOf(declaration, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, $"{declaration} must exist");

        int depth = 0;
        bool started = false;
        for (int index = start; index < source.Length; index++)
        {
            char character = source[index];
            if (character == '{')
            {
                depth++;
                started = true;
            }
            else if (character == '}')
            {
                depth--;
                if (started && depth == 0) return source[start..(index + 1)];
            }
        }

        throw new InvalidOperationException($"unbalanced body for {declaration}");
    }

    /// <summary>Tests run from the project or its bin output; walk up to the repository root.</summary>
    private static string ReadRepositoryFile(string relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++, directory = directory.Parent)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (File.Exists(candidate)) return File.ReadAllText(candidate);
            }
        }

        throw new FileNotFoundException($"repository path not found: {relative}");
    }
}
