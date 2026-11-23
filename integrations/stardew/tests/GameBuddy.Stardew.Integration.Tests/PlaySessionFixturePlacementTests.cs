using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using Microsoft.Xna.Framework;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The play-session fixture's placement rules. A live receipt measured what happens without them: the actor started
/// in the Farm's corner between the farmhouse wall and the map edge, `component_tiles=2`, and targets a few tiles
/// away were unreachable for reasons the world never showed. The rules are pinned here because their effect shows up
/// only in a live session.
/// </summary>
public sealed class PlaySessionFixturePlacementTests
{
    private static List<Point> Grid(int width, int height) =>
        Enumerable.Range(0, width)
            .SelectMany(x => Enumerable.Range(0, height).Select(y => new Point(x, y)))
            .ToList();

    [Fact]
    public void CandidatesAreNearestTheStartFirst()
    {
        // This is the property that puts the props beside the actor instead of in the map's origin corner.
        Point start = new(20, 20);
        List<Point> ordered = PlaySessionFixturePlacement.PlaceableCandidates(Grid(40, 40), start).ToList();

        ordered.Should().NotBeEmpty();
        List<int> distances = ordered
            .Select(tile => System.Math.Max(System.Math.Abs(tile.X - start.X), System.Math.Abs(tile.Y - start.Y)))
            .ToList();
        distances.Should().BeInAscendingOrder("placement must walk outward from the start");
        distances[0].Should().Be(1, "the nearest placeable tiles are the DIAGONALS beside the actor: the four cardinal tiles are the excluded ring");
        List<Point> nearest = ordered.Where(tile => System.Math.Max(System.Math.Abs(tile.X - start.X), System.Math.Abs(tile.Y - start.Y)) == 1).ToList();
        nearest.Should().BeEquivalentTo(
            new[] { new Point(19, 19), new Point(19, 21), new Point(21, 19), new Point(21, 21) },
            "the cardinal exits stay free");
        ordered.Should().NotContain(tile => PlaySessionFixturePlacement.IsInStartRing(tile, start));
    }

    [Fact]
    public void TheActorsOwnRingIsNeverAPlacement()
    {
        // The exact way the old layout fenced the companion in: a prop on one of the four cardinal tiles beside it.
        Point start = new(5, 5);
        Point[] ring =
        {
            new(5, 5), new(4, 5), new(6, 5), new(5, 4), new(5, 6),
        };
        foreach (Point tile in ring)
        {
            PlaySessionFixturePlacement.IsInStartRing(tile, start).Should().BeTrue($"({tile.X},{tile.Y}) is the start or beside it");
            PlaySessionFixturePlacement.PlaceableCandidates(Grid(20, 20), start).Should().NotContain(tile);
        }
        PlaySessionFixturePlacement.IsInStartRing(new Point(4, 6), start).Should().BeFalse("that tile is a diagonal, not the ring");
    }

    [Fact]
    public void PlacementIsDeterministic()
    {
        // Two runs of the same fixture must produce the same world, or a session diff cannot be attributed.
        Point start = new(7, 3);
        PlaySessionFixturePlacement.PlaceableCandidates(Grid(30, 30), start)
            .Should()
            .Equal(PlaySessionFixturePlacement.PlaceableCandidates(Grid(30, 30), start));
    }

    [Fact]
    public void AStartInTheOpenKeepsFourExitsPlaceable()
    {
        // The fixture chooses a start whose four cardinal neighbours are passable and free; the ring exclusion is
        // what keeps them that way, so the actor is never boxed in by its own world.
        Point start = new(12, 12);
        List<Point> ordered = PlaySessionFixturePlacement.PlaceableCandidates(Grid(24, 24), start).ToList();
        Point[] exits = { new(11, 12), new(13, 12), new(12, 11), new(12, 13) };
        exits.Should().OnlyContain(exit => !ordered.Contains(exit));
    }

    /// <summary>
    /// THE BUDGET'S DENOMINATOR. The props are laid on what is LEFT of the walkable piece once the start's own ring and
    /// every tile a standing building owns are taken out, so the number the budget divides is the number of tiles a prop
    /// can actually land on. Measuring the piece as the actor first sees it asked for props the world had already
    /// promised elsewhere.
    /// </summary>
    [Fact]
    public void TheBudgetIsAskedOfTheGroundThePropsMayUseAndNotOfTheWholePiece()
    {
        Point start = new(5, 5);
        List<Point> piece = Grid(10, 10);
        HashSet<Point> held = new() { new Point(1, 1), new Point(2, 2), new Point(5, 5) };

        int free = PlaySessionFixturePlacement.FreeTilesForProps(piece.ToHashSet(), start, held);

        // 100 tiles, less the start and its four cardinal neighbours, less the two held tiles outside that ring. The third
        // held tile IS the start, so it is counted once rather than twice.
        free.Should().Be(100 - 5 - 2);
        free.Should().BeLessThan(piece.Count, "the reservations are real ground the props cannot use");
        // CROSS-CHECK: the budget's denominator is what the placement search can actually offer, or the two rules are
        // about two different maps.
        PlaySessionFixturePlacement.PlaceableCandidates(piece, start, held).Count().Should().Be(free);
    }

    [Fact]
    public void AnUnmeasuredPieceIsNotZero()
    {
        // The flood can give up (`ReachableTiles` returns null), and "not measured" must not become "measured nothing":
        // a zero here would refuse a world nobody looked at, while the placement guards still refuse a prop nothing can
        // walk to. The convention is shared with `WalkableComponentSize`.
        PlaySessionFixturePlacement.FreeTilesForProps(null, new Point(3, 3)).Should().Be(int.MaxValue);
        GameBuddy.Stardew.Core.PropCapacity.For(PlaySessionFixturePlacement.FreeTilesForProps(null, new Point(3, 3)))
            .Should()
            .Be(GameBuddy.Stardew.Core.PropCapacity.Ceiling);
    }

    [Fact]
    public void TheStartRingCostsFiveTilesAndNotANeighbourhood()
    {
        // The ring is the fixture's own reservation and nothing else: it is not a neighbourhood, so the diagonals beside
        // the actor stay prop ground and the count says so.
        Point start = new(3, 3);
        HashSet<Point> piece = Grid(7, 7).ToHashSet();

        PlaySessionFixturePlacement.FreeTilesForProps(piece, start).Should().Be(49 - 5);
    }

    /// <summary>The tiles a 7x4 barn stands on when its top-left corner is at this origin.</summary>
    private static List<Vector2> BarnFootprint(Point origin)
    {
        List<Vector2> footprint = new();
        for (int offsetX = 0; offsetX < 7; offsetX++)
            for (int offsetY = 0; offsetY < 4; offsetY++)
                footprint.Add(new Vector2(origin.X + offsetX, origin.Y + offsetY));
        return footprint;
    }

    [Fact]
    public void TheDoorRingIsTheFourTilesBesideTheDoorAndNeverTheDoorItself()
    {
        // The ring is one fact with two readers - the animal Given's `no_approach` probe and the prop rule that keeps
        // the ring clear - so it lives in one place. The door tile itself is a building tile nobody stands on.
        Point door = new(4, 2);
        PlaySessionFixturePlacement.DoorApproachTiles(door)
            .Should()
            .BeEquivalentTo(
                new[] { new Point(4, 3), new Point(3, 2), new Point(5, 2), new Point(4, 1) },
                "an actor stands BESIDE a door, never on it");
    }

    [Fact]
    public void NoPropMayTakeTheAnimalHousesGroundOrItsDoorRing()
    {
        // The house is sited BEFORE the props because it needs a 7x4 footprint of clean ground, and the props are
        // placed nearest the start first - which is where the house was sited. Without this rule the next prop takes a
        // tile the house is reached from, and the arm-time porch assertion then refuses a world whose every part was
        // placed lawfully. Measured 2026-11-22: two free footprints on the whole farm, one `no_approach`, one refused
        // because the building's own tile sat across the road home.
        Point origin = new(8, 9);
        Point door = new(12, 12);
        Point start = new(5, 5);
        List<Vector2> footprint = BarnFootprint(origin);
        List<Point> footprintTiles = footprint.Select(tile => new Point((int)tile.X, (int)tile.Y)).ToList();
        HashSet<Point> held = PlaySessionFixturePlacement.TilesHeldByBuilding(footprint, door, Array.Empty<Point>());

        // The footprint entire, plus the ring - the tiles the ring shares with the footprint are the same tiles.
        held.Should().Contain(footprintTiles, "the barn's own ground is not placeable");
        held.Should().Contain(new Point(12, 13), "and neither is the one ring tile outside its footprint");
        held.Should().BeSubsetOf(footprintTiles.Concat(PlaySessionFixturePlacement.DoorApproachTiles(door)));

        List<Point> ordered = PlaySessionFixturePlacement.PlaceableCandidates(Grid(20, 20), start, held).ToList();
        ordered.Should().NotBeEmpty("the rule must not refuse the world");
        ordered.Should().NotIntersectWith(held, "a prop on the house or on its door ring spends the road to the animals");
        // The tiles beside the house stay placeable: the exclusion is the building's own ground and ring, not a
        // neighbourhood. Without the held list the very ring tiles ARE candidates, which is what makes this a rule.
        ordered.Should().Contain(new Point(7, 8));
        ordered.Should().Contain(new Point(13, 13));
        PlaySessionFixturePlacement.PlaceableCandidates(Grid(20, 20), start)
            .Should()
            .Contain(PlaySessionFixturePlacement.DoorApproachTiles(door), "the ring is free ground until the house owns it");
    }

    /// <summary>
    /// A piece as the world draws it: '#' is walkable ground, anything else is a wall.
    ///
    /// A SHAPE rather than a rectangle, because a rectangle has no pocket in it and a pocket is the one thing the
    /// measured farm had: the props chained north of the start and a later placement cut the chain off.
    /// </summary>
    private static HashSet<Point> Piece(params string[] rows)
    {
        HashSet<Point> tiles = new();
        for (int y = 0; y < rows.Length; y++)
        {
            for (int x = 0; x < rows[y].Length; x++)
            {
                if (rows[y][x] == '#')
                    tiles.Add(new Point(x, y));
            }
        }

        return tiles;
    }

    /// <summary>
    /// THE MEASURED FARM, as a piece. A pocket in the top-left corner, a one-tile corridor down from it, and the body of
    /// the field on the right - with the actor standing in the corridor, so the pocket really is the NEAREST ground the
    /// world has. That is the whole reason the day's last forage prop ended up in it (2026-11-23: `forage@8,35`).
    /// </summary>
    private static readonly string[] MeasuredFarm =
    {
        "##............",
        "##............",
        ".##...........",
        "..#.....######",
        "..#.....######",
        "..############",
        "........######",
        "........######",
        "........######",
        "........######",
    };

    private static Point MeasuredFarmStart => new(2, 3);

    [Fact]
    public void AClearanceIsMeasuredInStepsFromThePiecesEdgeAndCoversTheWholePiece()
    {
        // The number is what "open ground" means, so it is measured rather than assumed: a pocket's floor is one step
        // from its own wall, while the body of a field is several steps from everything.
        HashSet<Point> piece = Piece(MeasuredFarm);
        IReadOnlyDictionary<Point, int> clearance = PlaySessionFixturePlacement.ClearanceFromPieceEdge(piece);

        clearance.Keys.Should().BeEquivalentTo(
            piece,
            "a tile with no entry would read as the LEAST open ground and sort last, which is the one answer a defect here must not look like");
        clearance.Values.Should().OnlyContain(steps => steps >= 1, "every tile of a finite piece is some steps from its edge");
        clearance[new Point(0, 0)].Should().Be(1, "the pocket's corner has two walls beside it");
        clearance[new Point(2, 4)].Should().Be(1, "the corridor is one tile wide");
        // The field's body is farther from a wall than anything in the pocket: that difference IS the rule.
        clearance.Values.Max().Should().BeGreaterThan(2);
        Point deepest = clearance.First(pair => pair.Value == clearance.Values.Max()).Key;
        System.Math.Abs(deepest.X - 2).Should().BeGreaterThan(2, "the openest ground is in the field, not in the corridor or the pocket");
    }

    [Fact]
    public void AnUnmeasuredPieceKeepsTheNearestFirstOrder()
    {
        // The flood can give up, and "not measured" must not become "every tile is a pocket": with nothing to read, the
        // reserved order is EXACTLY the near-first order, so a reservation can never refuse a world nobody looked at.
        HashSet<Point> piece = Piece(MeasuredFarm);
        Point start = MeasuredFarmStart;

        IReadOnlyDictionary<Point, int> nothing = PlaySessionFixturePlacement.ClearanceFromPieceEdge(null);

        nothing.Should().BeEmpty("the flood gave up, which is not the same as measuring a wall");
        PlaySessionFixturePlacement.ReservedCandidates(piece, start, nothing)
            .Should()
            .Equal(PlaySessionFixturePlacement.PlaceableCandidates(piece, start));
    }

    [Fact]
    public void AReservedPropIsOfferedTheOpenGroundBeforeThePocketBesideTheActor()
    {
        // THE MEASURED DEFECT AND THE RULE THAT ANSWERS IT, in one world. Nearest-first walks UP the corridor into the
        // pocket, because the pocket is the nearest ground there is; that is how the day's last forage prop came to be
        // somewhere a later placement could cut off. A reserved member is offered the open ground first instead, and
        // only then the tiles beside it.
        HashSet<Point> piece = Piece(MeasuredFarm);
        Point start = MeasuredFarmStart;
        IReadOnlyDictionary<Point, int> clearance = PlaySessionFixturePlacement.ClearanceFromPieceEdge(piece);

        List<Point> sweep = PlaySessionFixturePlacement.PlaceableCandidates(piece, start).ToList();
        List<Point> reserved = PlaySessionFixturePlacement.ReservedCandidates(piece, start, clearance).ToList();
        Point pocketFloor = new(1, 1);

        clearance[pocketFloor].Should().Be(1, "the pocket's floor is one step from its own wall");
        // THE RULE, as the one assertion that names it: whatever else changes, the FIRST tile a reservation is offered is
        // among the openest the piece holds - so a family's standing member is never the floor of a pocket.
        clearance[reserved[0]].Should().Be(
            clearance.Values.Max(),
            "a reserved prop is offered the openest ground first, or the reservation has not changed what the sweep does");
        Point openGround = reserved[0];
        sweep.IndexOf(pocketFloor).Should().BeLessThan(
            sweep.IndexOf(openGround),
            "nearest-first reaches the pocket long before the open field - the pocket IS the nearest ground there is, which is how the day's last forage prop got into one");

        // THE PROPERTY, over the whole sequence rather than over the two tiles above: openness never increases as the
        // order proceeds, so no later candidate is more open than an earlier one.
        reserved.Select(tile => clearance[tile]).Should().BeInDescendingOrder();
        // ...and among tiles that are equally open, the actor's side comes first: a reserved prop still lands beside it.
        for (int index = 1; index < reserved.Count; index++)
        {
            if (clearance[reserved[index]] != clearance[reserved[index - 1]])
                continue;
            Distance(MeasuredFarmStart, reserved[index]).Should().BeGreaterThanOrEqualTo(
                Distance(MeasuredFarmStart, reserved[index - 1]),
                $"({reserved[index].X},{reserved[index].Y}) is as open as the tile before it but farther from the actor");
        }

        // Two runs of the same fixture must produce the same world, or a session diff cannot be attributed.
        PlaySessionFixturePlacement.ReservedCandidates(piece, start, clearance)
            .Should()
            .Equal(reserved);
    }

    /// <summary>The Chebyshev distance the placement orders by: one step is one tile, diagonals included.</summary>
    private static int Distance(Point from, Point to) =>
        System.Math.Max(System.Math.Abs(to.X - from.X), System.Math.Abs(to.Y - from.Y));

    /// <summary>
    /// THE MEASURED `round94` ROOM (2026-11-23, twice), as the receipt published it: the bed spot at `10,9` is an
    /// alcove whose four approaches are `north:location_constraint@10,8`, `east:buildings_tile@11,9`,
    /// `south:location_constraint@10,10` and `west:object:(M)MannequinMale@9,9` - one way in, and the mannequin stood on
    /// it. The corridor west is the walk the receipts came from (`from=3,11`).
    /// </summary>
    private static readonly string[] MeasuredBedroom =
    {
        "............",
        "............",
        "............",
        "............",
        "............",
        "............",
        "............",
        "............",
        "............",
        "###########.",
        "............",
        "............",
    };

    /// <summary>
    /// The same bedroom with its corridor two tiles wide: the round94 alcove, in a room that CAN hold an object. The
    /// pair is what separates "this placement is wrong" from "this room can hold nothing", which are two different
    /// answers for the fixture to give.
    /// </summary>
    private static readonly string[] TwoWideBedroom =
    {
        "............",
        "............",
        "............",
        "............",
        "............",
        "............",
        "............",
        "............",
        "............",
        "###########.",
        "##########..",
        "............",
    };

    /// <summary>
    /// THE RED PROOF, on the room and the tile that actually failed: a mannequin at `9,9` - the spawn tile, which was
    /// also the only approach to the bed - must be refused by the room rule, and the refusal must NAME the bed at
    /// `10,9` as the tile it cut off.
    ///
    /// <para>
    /// Measured `round94` (2026-11-23), twice: the heartbeat read `location=FarmHouse;tile=9,9`, the Given's own log
    /// said `display=mannequin@9,9;actor=9,9`, and the walk to the bed answered `no_native_path` with
    /// `approaches=north:location_constraint@10,8,east:buildings_tile@11,9,south:location_constraint@10,10,"
    /// + "west:object:(M)MannequinMale@9,9`. She never slept and passed out at 02:00 three nights running. The old
    /// placement asked the warps and only the warps, so a door-only answer passed while the bed was sealed.
    /// </para>
    ///
    /// <para>
    /// The actor is placed WEST along the corridor rather than on `9,9`, because a body that stands where the object
    /// stands is a different rule (`PlaySessionFixturePlacement.IsInStartRing` refuses that tile before the flood is
    /// asked), and mixing the two rules would let one of them hide the other.
    /// </para>
    /// </summary>
    [Fact]
    public void AnObjectOnTheOnlyApproachToTheBedCutsTheRoomAndNamesTheBed()
    {
        HashSet<Point> room = Piece(MeasuredBedroom);
        Point actor = new(3, 9);
        Point bedSpot = new(10, 9);
        Point door = new(0, 9);
        Point[] needed = { bedSpot, door };

        IReadOnlyList<Point> severed = PlaySessionFixturePlacement.TilesSeveredByPlacing(room.Contains, actor, new Point(9, 9), needed);

        severed.Should().BeEquivalentTo(new[] { bedSpot });
        severed.Should().Contain(
            new Point(10, 9),
            "the tile the placement cut off is the bed the night walks to, and the refusal has to name it");

        // The same question about the same tile, with the BED out of the room's needs: it is then lawful. That is what
        // makes the first answer about the bed rather than about the corridor the mannequin happened to stand in.
        PlaySessionFixturePlacement.TilesSeveredByPlacing(room.Contains, actor, new Point(9, 9), new[] { door })
            .Should()
            .BeEmpty("with the bed out of the question the same placement is lawful, which is what makes the answer about the bed");

        // AND THIS ROOM IS THE ZERO THE FIXTURE MUST REFUSE BY NAME: one tile wide, so every tile the actor's ring
        // leaves is a bridge, and nothing may stand anywhere.
        List<Point> candidates = PlaySessionFixturePlacement.RoomCandidates(room, actor, room.Contains).ToList();
        candidates.Should().NotBeEmpty("the room offers ground; the rule is what refuses it");
        candidates.Should().OnlyContain(
            tile => PlaySessionFixturePlacement.TilesSeveredByPlacing(room.Contains, actor, tile, needed).Count > 0,
            "a one-tile-wide corridor has no lawful ground at all, which is `fixture_object_severs_the_room`'s case");
    }

    /// <summary>
    /// A ROOM THAT CAN HOLD THE OBJECT, with the round94 alcove in it: the corner is offered first, and the corner IS
    /// the bed's only approach - so the flood refuses the tile the ordering preferred and the placement moves on to
    /// ground nothing crosses.
    ///
    /// <para>
    /// This is the answer to "say whether the room has more than one corner that qualifies": on this room exactly ONE
    /// dead end exists and it is the bed's alcove. A corner preference alone would therefore place at `9,9` - the very
    /// tile that starved her - which is why the exit count is a preference and the flood is the rule.
    /// </para>
    /// </summary>
    [Fact]
    public void TheCornerIsOfferedFirstAndTheFloodRefusesItWhenItIsTheBedsOnlyApproach()
    {
        HashSet<Point> room = Piece(TwoWideBedroom);
        Point actor = new(0, 9);
        Point bedSpot = new(10, 9);
        Point door = new(0, 10);
        Point[] needed = { bedSpot, door };

        List<Point> candidates = PlaySessionFixturePlacement.RoomCandidates(room, actor, room.Contains).ToList();

        // (a) THE ORDERING IS THE CORNER: the alcove is the room's one dead end (one way out) and is offered first.
        candidates[0].Should().Be(bedSpot, "the openest-is-safest order starts with the tile a path cannot cross");
        PlaySessionFixturePlacement.WalkableExitCount(candidates[0], room.Contains).Should().Be(1, "the alcove has one way in");
        candidates.Count(tile => PlaySessionFixturePlacement.WalkableExitCount(tile, room.Contains) == 1)
            .Should()
            .Be(1, "this room offers exactly one corner, and it is the bed's own alcove - so the corner rule alone would not save her");
        candidates
            .Should()
            .Equal(PlaySessionFixturePlacement.RoomCandidates(room, actor, room.Contains), "two runs must produce the same world");

        // (b) NO OBJECT ON THE ACTOR'S OWN TILE OR BESIDE IT: rule one, the one the display search never asked.
        candidates.Should().NotContain(tile => PlaySessionFixturePlacement.IsInStartRing(tile, actor));
        candidates.Should().NotContain(actor, "the mannequin that starved her stood on the spawn tile itself");

        // (c) THE FLOOD IS THE RULE: the preferred corner severs the bed, `9,9` severs the bed, and the bed itself
        // severs the bed - while ground nothing crosses does not.
        PlaySessionFixturePlacement.TilesSeveredByPlacing(room.Contains, actor, bedSpot, needed)
            .Should()
            .BeEquivalentTo(new[] { bedSpot }, "an object ON the tile the night walks to is the same severed room");
        PlaySessionFixturePlacement.TilesSeveredByPlacing(room.Contains, actor, new Point(9, 9), needed)
            .Should()
            .BeEquivalentTo(new[] { bedSpot }, "`9,9` is the measured tile that failed, and it cuts the bed at `10,9`");
        Point lawful = candidates.First(tile => PlaySessionFixturePlacement.TilesSeveredByPlacing(room.Contains, actor, tile, needed).Count == 0);
        lawful.Should().NotBe(bedSpot);
        lawful.Should().NotBe(new Point(9, 9));
        PlaySessionFixturePlacement.WalkableExitCount(lawful, room.Contains)
            .Should()
            .BeGreaterThan(1, "the room's only dead end is unusable, so the lawful tile is a corridor tile the flood proved");
    }

    /// <summary>
    /// A FLOOD THAT GAVE UP MEASURED NOTHING, which is neither "nothing was cut" nor a room with a wall in it: it is a
    /// named refusal. The budget is the receipt probe's own 8000, so a room large enough to exceed it must refuse rather
    /// than pass a placement nobody judged.
    /// </summary>
    [Fact]
    public void AnUnmeasuredRoomRefusesRatherThanPassingThePlacement()
    {
        HashSet<Point> room = Piece(Enumerable.Repeat(new string('#', 100), 100).ToArray());
        room.Should().HaveCount(10000, "the room has to exceed the probe's budget for this case to exist at all");

        System.Action act = () => PlaySessionFixturePlacement.TilesSeveredByPlacing(
            room.Contains,
            new Point(0, 0),
            new Point(1, 0),
            new[] { new Point(99, 99) });

        act.Should()
            .Throw<System.InvalidOperationException>()
            .WithMessage("play_session_room_reachability_unmeasured*");
    }
}
