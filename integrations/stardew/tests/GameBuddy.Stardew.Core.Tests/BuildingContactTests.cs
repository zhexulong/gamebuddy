using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// The engine answers "where do you touch this building" in three different shapes, and code that picks
/// one shape for all buildings fails silently on the others:
///
/// - `Building.getPointForHumanDoor()` returns `tileX + humanDoor.X, tileY + humanDoor.Y`
///   (`Building.cs:1925-1928`), reading a field deserialised from building data (`Building.cs:502-503`);
/// - `isActionableTile` guards with `humanDoor.X &gt;= 0` before using that field (`Building.cs:1088`) -
///   the engine admitting there IS a "no door" value;
/// - the animal-door branch uses a RECTANGLE, not a point (`getRectForAnimalDoor`).
///
/// So a silo or a fish pond, whose data declares no human door, would have its interaction point collapse
/// onto the building's own origin tile - and every interaction from where an actor actually stands would be
/// refused as "out of range", naming the distance instead of the missing door.
///
/// These cases pin the three outcomes apart, and pin the ring rule that multi-tile buildings need.
/// </summary>
public sealed class BuildingContactTests
{
    [Fact]
    public void ABuildingWithADoorIsTouchedFromItsOwnOrAnAdjacentTile()
    {
        // A coop at (10,10), 4x3, with a human door at its origin + (1,3) = (11,13).
        var contact = BuildingContact.WithHumanDoor(new Point(11, 13), new FootprintRect(10, 10, 4, 3));

        contact.Kind.Should().Be(BuildingContactKind.HumanDoor);
        contact.HumanDoor.Should().Be(new Point(11, 13));

        contact.IsWithinContact(new Point(11, 13)).Should().BeTrue("standing on the door");
        contact.IsWithinContact(new Point(11, 14)).Should().BeTrue("one tile below it");
        contact.IsWithinContact(new Point(12, 12)).Should().BeTrue("diagonally adjacent");
        contact.IsWithinContact(new Point(11, 15)).Should().BeFalse("two tiles away");
    }

    [Fact]
    public void AHumanDoorContactOffersTheRingAroundTheDoorNotTheBuilding()
    {
        var contact = BuildingContact.WithHumanDoor(new Point(11, 13), new FootprintRect(10, 10, 4, 3));

        System.Collections.Generic.IReadOnlyList<Point> tiles = contact.InteractionTiles();

        tiles.Should().HaveCount(8, "the eight neighbours of the door");
        tiles.Should().Contain(new Point(11, 14));
        // Orthogonals come first so a caller that walks the list in order prefers a straight approach.
        tiles[0].Should().Be(new Point(11, 12));
    }

    [Fact]
    public void ABuildingWithNoHumanDoorIsTouchedFromItsRingNotFromAPoint()
    {
        // A silo: 3x3 at (20,20), no human door. The old code would have used the human-door point, which
        // for an absent door collapses onto the building's own origin - a tile nobody can stand on.
        var contact = BuildingContact.WithoutHumanDoor(new FootprintRect(20, 20, 3, 3));

        contact.Kind.Should().Be(BuildingContactKind.Ring);
        contact.HumanDoor.Should().BeNull("there is no door to name");

        // Every face is contact, which is the whole point: a companion at the south face is not "far away".
        contact.IsWithinContact(new Point(20, 23)).Should().BeTrue("south face");
        contact.IsWithinContact(new Point(23, 20)).Should().BeTrue("east face");
        contact.IsWithinContact(new Point(23, 23)).Should().BeTrue("south-east corner of the ring");
        // A 3x3 footprint at (20,20) covers x 20..22 and y 20..22, so (22,22) is INSIDE it - not a standing tile.
        contact.IsWithinContact(new Point(22, 22)).Should().BeFalse("inside the silo is not a standing tile");
        contact.IsWithinContact(new Point(20, 21)).Should().BeFalse("inside the silo is not a standing tile");
        contact.IsWithinContact(new Point(20, 24)).Should().BeFalse("one tile past the ring");
    }

    [Fact]
    public void TheRingIsTheDilatedRectangleAndExcludesTheFootprint()
    {
        var footprint = new FootprintRect(20, 20, 3, 3);

        footprint.IsWithinRing(new Point(20, 23)).Should().BeTrue();
        footprint.IsWithinRing(new Point(19, 19)).Should().BeTrue("diagonal corner of the ring");
        footprint.IsWithinRing(new Point(21, 21)).Should().BeFalse("inside the footprint");
        footprint.IsWithinRing(new Point(20, 24)).Should().BeFalse("outside the ring");
    }

    [Fact]
    public void TheRingTilesAreDeterministicAndOrthogonalsComeFirst()
    {
        var footprint = new FootprintRect(20, 20, 3, 3);

        System.Collections.Generic.IReadOnlyList<Point> first = footprint.RingTiles();
        System.Collections.Generic.IReadOnlyList<Point> second = footprint.RingTiles();

        first.Should().Equal(second, "an identical world must produce an identical candidate list");

        // A 3x3 footprint has a 5x5 dilated rectangle minus its 9 interior tiles = 16 ring tiles.
        first.Should().HaveCount(16);

        // The first four are the four sides' leading tiles, in lowest-y then lowest-x order.
        first[0].Should().Be(new Point(20, 19), "north face, lowest x");
        first.Should().ContainInOrder(new Point(20, 19), new Point(21, 19), new Point(22, 19));
    }

    [Fact]
    public void ASevenByFourBarnIsTouchedFromItsDoorwayNotFromItsTopLeftCorner()
    {
        // The reviewer's finding: a 7x4 barn's approach used only the top-left corner, so standing at the
        // door reported out_of_range. With the door named, the door's ring is the approach set.
        var contact = BuildingContact.WithHumanDoor(new Point(13, 10), new FootprintRect(10, 10, 7, 4));

        contact.IsWithinContact(new Point(13, 10)).Should().BeTrue("standing in the doorway");
        // The top-left corner (10,10) is NOT what a companion at the door occupies.
        contact.IsWithinContact(new Point(10, 13)).Should().BeFalse("the far south-west corner is not the door");
    }

    [Fact]
    public void AnUnreachableBuildingOffersNoTilesAndContactsNothing()
    {
        var contact = BuildingContact.Unreachable();

        contact.Kind.Should().Be(BuildingContactKind.Unreachable);
        contact.InteractionTiles().Should().BeEmpty("a caller must refuse by name, not pick a tile");
        contact.IsWithinContact(new Point(0, 0)).Should().BeFalse();
    }

    [Fact]
    public void AnEmptyFootprintIsNeverInContact()
    {
        // A zero-size footprint cannot be touched from anywhere; treating it as "always in contact" is how
        // a zero-rect bug becomes a silent success.
        var empty = new FootprintRect(5, 5, 0, 0);

        empty.IsEmpty.Should().BeTrue();
        empty.IsWithinRing(new Point(4, 4)).Should().BeFalse();
        empty.RingTiles().Should().BeEmpty();
    }
}
