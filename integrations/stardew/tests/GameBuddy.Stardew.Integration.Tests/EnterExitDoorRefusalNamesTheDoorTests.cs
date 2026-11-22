using System.Reflection;
using FluentAssertions;
using Netcode;
using StardewValley;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A door refusal must say WHICH door it is about, and in WHAT state - because "there is no door of this map on that
/// tile" and "there is one and the game has shut it" are different sentences, and `round91` read neither.
///
/// <para>
/// Measured `round91`: eight door refusals in one window. <c>door_not_available ... you=7,18;nearest=28,15;distance=21</c>
/// named the exits it had enumerated and not the map they were exits OF, so nothing in the line could say whether the
/// tile the companion asked for was doorless or locked; and a door the clock shuts answered
/// <c>door_gate_refused ... dialogue=…</c> with the game's own localized sentence and no hour a reader could act on.
/// </para>
///
/// <para>
/// These cases drive the production formatter against a real <see cref="GameLocation"/> - the engine's own
/// <c>Buildings</c> layer <c>Action</c> property, which is the table both <c>updateDoors</c> and the door path read - so
/// the hours asserted here are read out of the world the game would read them from, not restated in C#.
/// </para>
/// </summary>
[Collection(HeadlessGameWorld.Collection)]
public sealed class EnterExitDoorRefusalNamesTheDoorTests
{
    /// <summary>
    /// The `LockedDoorWarp` window, in the engine's own token order
    /// (`LockedDoorWarp &lt;x&gt; &lt;y&gt; &lt;location&gt; &lt;openTime&gt; &lt;closeTime&gt;`, GameLocation.cs:9539).
    /// </summary>
    private const string SeedShopWednesdayLock = "LockedDoorWarp 9 12 SeedShop 900 1900";

    /// <summary>The other half of the same answer: the door is HERE, and it is not the clock that shuts it.</summary>
    [Fact]
    public void ADoorThisMapDeclaresIsNotReportedAsAbsent()
    {
        GameLocation town = Location("Town");
        SetDoorAction(town, 9, 12, "WarpGreenhouse");

        ExecutionManager.DescribeDoorAtTile(town, 9, 12).Should().Be(
            "map=Town;door_tile=9,12;door_at_tile=declared",
            "a one-token Warp-family Action is a door `updateDoors` admits, and the refusal must not report the tile as doorless");
    }

    /// <summary>
    /// THE HOUR. A door the clock shuts says when it opens and when it shuts again, in the world's own numbers, beside the
    /// clock the reader is holding - and the verdict stays the game's own dialogue, so the window printed here can never
    /// contradict the sentence the game said.
    /// </summary>
    [Fact]
    public void ADoorTheClockShutsNamesTheHoursItOpens()
    {
        GameLocation town = Location("Town");
        SetDoorAction(town, 9, 12, SeedShopWednesdayLock);

        ExecutionManager.DescribeDoorAtTile(town, 9, 12).Should().Be(
            $"map=Town;door_tile=9,12;door_at_tile=locked_by_hours;opens_at=900;closes_at=1900;now={Game1.timeOfDay}",
            "`wait for that to clear` was the whole answer to a door that opens at a stated hour");
    }

    /// <summary>The negative half: the same map, a tile it declares nothing on.</summary>
    [Fact]
    public void ATileNoTableOfThisMapNamesIsNotADoorHere()
    {
        GameLocation town = Location("Town");
        SetDoorAction(town, 9, 12, SeedShopWednesdayLock);

        ExecutionManager.DescribeDoorAtTile(town, 40, 12).Should().Be(
            "map=Town;door_tile=40,12;door_at_tile=absent",
            "the doors of `map` were enumerated and this tile is not one of them - a different sentence from a locked door");

        ExecutionManager.DescribeDoorAtTile(town, 40, 40).Should().Be(
            "map=Town;door_tile=40,40;door_at_tile=absent",
            "a tile off the map is one this map declares no door on, and the read must answer rather than throw");
    }

    /// <summary>No world at all says so, rather than borrowing the name of one it never read.</summary>
    [Fact]
    public void AMapThatIsNotLoadedSaysUnknownRatherThanGuessing()
    {
        ExecutionManager.DescribeDoorAtTile(null, 9, 12).Should().Be(
            "map=unknown;door_tile=9,12;door_at_tile=unknown");
    }

    private static GameLocation Location(string name)
    {
        var location = new GameLocation();
        var map = new xTile.Map();
        map.AddLayer(new xTile.Layers.Layer("Back", map, new xTile.Dimensions.Size(80, 80), new xTile.Dimensions.Size(64, 64)));
        map.AddLayer(new xTile.Layers.Layer("Buildings", map, new xTile.Dimensions.Size(80, 80), new xTile.Dimensions.Size(64, 64)));
        location.map = map;
        typeof(GameLocation)
            .GetField("name", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(location, new NetString(name));
        return location;
    }

    /// <summary>
    /// One drawn door: the `Buildings` layer's `Action` property, which is what `updateDoors` admits
    /// (GameLocation.cs:17601) and what `getWarpFromDoor` resolves (:2207).
    /// </summary>
    private static void SetDoorAction(GameLocation location, int x, int y, string action)
    {
        xTile.Layers.Layer buildings = location.map!.GetLayer("Buildings");
        if (buildings.Tiles[x, y] is null)
        {
            var sheet = new xTile.Tiles.TileSheet(location.map, "door", new xTile.Dimensions.Size(64, 64), new xTile.Dimensions.Size(1, 1));
            location.map.AddTileSheet(sheet);
            buildings.Tiles[x, y] = new xTile.Tiles.StaticTile(buildings, sheet, xTile.Tiles.BlendMode.Alpha, 0);
        }

        buildings.Tiles[x, y].Properties["Action"] = action;
    }
}
