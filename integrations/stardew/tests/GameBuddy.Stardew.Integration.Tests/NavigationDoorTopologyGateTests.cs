using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using GameBuddy.Stardew.Navigation;
using Microsoft.Xna.Framework;
using Netcode;
using StardewValley;
using StardewValley.Network;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// `a_place_the_game_lets_you_enter_is_not_a_leaf:&lt;location&gt;` - a location another location can only reach through a DOOR
/// is a destination, not a dead end.
///
/// <para>
/// MEASURED `plan_339/n01`: `navigate_to_destination` answered <c>destination_unreachable</c> with
/// <c>destination=木匠的商店;topology=unreachable</c> 46 ms after submit, so no movement was ever armed. The graph was built
/// from `Game1.locations` nodes and `location.warps` edges only, and a door is not a row in `warps`: it is the door table
/// `updateDoors` builds, a building's human door, or a fixed-point door. Dropping those edges made every interior a leaf -
/// the carpenter's, Pierre's, the community centre - and the planner's BFS then drained its queue with nothing to say but
/// "unreachable". That sentence was a statement about the graph, never about a tile.
/// </para>
///
/// <para>
/// The POPULATION is derived, not listed: every location whose own members declare a transition is a node, and every
/// location named as a transition's TARGET is a place the game lets you enter. The property is that each of those has an
/// inbound edge in the topology the planner walks. A location entered by an ACTION rather than a transition (`UndergroundMine17`
/// through a ladder) is not in that population and is not counted as a leaf, which is why the rule is "named as a target"
/// rather than "every node".
/// </para>
///
/// <para>
/// The falsifier, run by hand on this file's first revision: restoring the `edge.Family != WorldEdgeFamily.Warp` filter in
/// `Game1NavigationWorldSource.TryProjectTopologyLegs` reddens this gate and names `ScienceHouse` and `SeedShop`.
/// </para>
/// </summary>
[Collection(HeadlessGameWorld.Collection)]
public sealed class NavigationDoorTopologyGateTests
{
    private const string WorldSourceRelativePath = "integrations/stardew/navigation/game1navigationworldsource.cs";
    private const string ControllerRelativePath = "integrations/stardew/farmhandexecutioncontroller.cs";
    private const string MovementActionsRelativePath = "integrations/stardew/farmhandexecutioncontroller.movementactions.cs";

    private readonly ITestOutputHelper output;

    public NavigationDoorTopologyGateTests(ITestOutputHelper output) => this.output = output;

    [Fact]
    public void APlaceTheGameLetsYouEnterIsNotALeaf()
    {
        using GateWorld world = GateWorld.Create();

        var sources = new List<NavigationOrdinaryWarpLegs>();
        foreach (GameLocation location in world.Locations)
        {
            sources.Add(new NavigationOrdinaryWarpLegs(
                location.NameOrUniqueName,
                Game1NavigationWorldSource.ProjectTopologyLegs(location)));
        }

        // The live source keeps only legs whose target is a loaded location (the graph may not name a node it does not
        // hold); the fixture applies the same rule so the population is the graph's own node set.
        string[] nodes = sources.Select(source => source.SourceId).ToArray();
        sources = sources
            .Select(source => new NavigationOrdinaryWarpLegs(
                source.SourceId,
                source.OutgoingOrdinaryLegs.Where(leg => nodes.Contains(leg.TargetLocation, StringComparer.Ordinal)).ToArray()))
            .ToList();

        string[] enterable = world.Locations
            .SelectMany(location => Game1NavigationWorldSource.DeclaredTransitionTargets(location))
            .Distinct(StringComparer.Ordinal)
            .Where(identity => nodes.Contains(identity, StringComparer.Ordinal))
            .OrderBy(identity => identity, StringComparer.Ordinal)
            .ToArray();
        string[] withWayIn = enterable
            .Where(identity => sources.Any(source => !string.Equals(source.SourceId, identity, StringComparison.Ordinal)
                && source.OutgoingOrdinaryLegs.Any(leg => string.Equals(leg.TargetLocation, identity, StringComparison.Ordinal))))
            .ToArray();
        string[] leaves = enterable.Except(withWayIn, StringComparer.Ordinal).ToArray();

        this.output.WriteLine(
            $"locations examined {world.Locations.Count} · with-a-way-in {withWayIn.Length} · leaves {leaves.Length}");
        this.output.WriteLine($"with-a-way-in: {string.Join(", ", withWayIn)}");

        world.Locations.Count.Should().BeGreaterThan(0, "a gate whose population is empty agrees with itself");
        enterable.Should().NotBeEmpty("the fixture's transitions must name places to enter");
        leaves.Should().BeEmpty(
            $"a place the game lets you enter is not a leaf: {string.Join(", ", leaves)} have no inbound edge in the graph");

        // And the symptom itself: the companion standing on the Farm must be given a leg, twice over - the way to Town,
        // and then the DOOR into the shop. This is `plan_339` in five nodes.
        NavigationOrdinaryWarpTopology farmView = new("Farm", sources);
        NavigationOrdinaryWarpTopology townView = new("Town", sources);
        NavigationRoutePlanner planner = new();

        NavigationRoutePlanResult first = planner.Plan(farmView, "Farm", Binding("ScienceHouse"));
        first.Kind.Should().Be(NavigationRoutePlanKind.NextEdge, first.ReasonCode);
        first.NextLeg!.TargetLocation.Should().Be("Town");

        NavigationRoutePlanResult second = planner.Plan(townView, "Town", Binding("ScienceHouse"));
        second.Kind.Should().Be(NavigationRoutePlanKind.NextEdge, second.ReasonCode);
        second.NextLeg!.TargetLocation.Should().Be("ScienceHouse");
        second.NextLeg.IsDoor.Should().BeTrue("the way in is the carpenter's door, so it is entered as a door");
        second.NextLeg.SourceX.Should().Be(12);
        second.NextLeg.SourceY.Should().Be(14);
        second.NextLeg.TargetX.Should().Be(4);
        second.NextLeg.TargetY.Should().Be(18);
    }

    /// <summary>
    /// The graph's edge enumeration asks the three tables the game itself reads to move a player through a door, and the
    /// topology projection keeps each leg's family. A projection that filters a family out is exactly the defect above, so
    /// this pin is the falsifier's text form: it names each table and forbids the family filter.
    /// </summary>
    [Fact]
    public void TheEdgeEnumerationReadsTheGamesOwnThreeTablesAndKeepsEveryFamily()
    {
        string source = ReadRepositoryFile(WorldSourceRelativePath);

        source.Should().Contain("location.doors.Pairs", "the door table `updateDoors` builds is an edge table");
        source.Should().Contain("building.getPointForHumanDoor()", "a shed's or barn's entrance is its building's human door");
        source.Should().Contain("location.warps", "the warp list is an edge table");
        source.Should().Contain("ResolveDoorWarp(location, point)", "a door's target tile is the game's resolver answer");

        string projection = MethodBody(source, "ProjectTopologyLegs");
        projection.Should().NotContain("WorldEdgeFamily.Warp", "a family filter here is what made every interior a leaf");
        projection.Should().Contain("edge.IsDoor", "a door leg must reach the walker as a door, not flattened into a warp");
    }

    /// <summary>
    /// `a_door_leg_bypasses_the_games_own_entry:&lt;lock&gt;` - a navigation that walks through a door runs the game's own door
    /// entry, the same dispatch `enter_exit` runs, so `LockedDoorWarp` (festival, SeedShop Wednesday, open hours, friendship),
    /// `WarpCommunityCenter` (`ccDoorUnlock`), `Warp_Sunroom_Door` (Caroline's hearts), `WarpGreenhouse` (`ccPantry`) and
    /// `Building.doAction` (construction, demolish lock) all still refuse. A bare `warpFarmer` on a door leg skips every one.
    ///
    /// <para>
    /// WHY A SOURCE PIN: the native door seam cannot load in a headless runner - its own gate says so
    /// (<c>EnterExitDoorGateTests</c>) - so the shape that decides the crossing is asserted where it is written.
    /// </para>
    /// </summary>
    [Fact]
    public void ADoorLegIsCrossedThroughTheGamesOwnEntryAndTheOldRefusalIsGone()
    {
        string controller = ReadRepositoryFile(ControllerRelativePath);
        string movement = ReadRepositoryFile(MovementActionsRelativePath);

        string commit = MethodBody(controller, "CommitNavigationLeg");
        commit.Should().Contain("CrossDoorNativeEntry(", "a door leg is not crossed by the warp act");
        commit.Should().Contain("navigation.Leg.IsDoor", "the family is what chooses the act");

        string doorCrossing = MethodBody(controller, "CrossDoorNativeEntry");
        doorCrossing.Should().Contain("DispatchNativeDoor(", "the game's own entry owns the door's gates");
        doorCrossing.Should().Contain("\"door_gate_refused\"");
        doorCrossing.Should().Contain("\"door_transition_not_started\"");
        doorCrossing.Should().Contain("CommitApproachWarp(warp)", "only a tile the click path does not own falls back to the warp");

        string resolve = MethodBody(controller, "ResolveApproachWarp");
        resolve.Should().Contain("ResolveDoorWarp(", "a door is resolved by the game's resolver, not by scanning warps");

        // The refusal itself, retired: nothing may answer `navigation_transition_family_not_materialized` again, because
        // that answer is what made the carpenter's shop unreachable. Comments are stripped so a sentence ABOUT the retired
        // code is not read as the code.
        WithoutComments(controller).Should().NotContain("navigation_transition_family_not_materialized");
        WithoutComments(movement).Should().NotContain("navigation_transition_family_not_materialized");
        controller.Should().NotContain("nextLeg.IsDoor ||", "a door leg is materialized, not refused");
    }

    private static string WithoutComments(string source) =>
        string.Join('\n', source.Split('\n').Select(DecompiledSource.WithoutComment));

    private static NavigationDestinationBinding Binding(string identity) =>
        new("stardew", identity, "generation_01", 1);

    /// <summary>The body of one method DECLARATION, from its declaration to the closing brace at that declaration's indent.
    /// A call to the same name is not a declaration, so a line carrying a modifier is required.</summary>
    private static string MethodBody(string source, string name)
    {
        int start = -1;
        foreach (string line in source.Split('\n'))
        {
            if (!line.Contains(name + "(", StringComparison.Ordinal))
                continue;
            if (!line.Contains("private ", StringComparison.Ordinal)
                && !line.Contains("internal ", StringComparison.Ordinal)
                && !line.Contains("public ", StringComparison.Ordinal))
                continue;
            start = source.IndexOf(line, start + 1, StringComparison.Ordinal);
            break;
        }

        start.Should().BeGreaterThanOrEqualTo(0, $"{name} must be declared in the file");
        int open = source.IndexOf('{', start);
        open.Should().BeGreaterThan(start, $"{name} must have a body");
        int depth = 0;
        for (int index = open; index < source.Length; index++)
        {
            if (source[index] == '{') depth++;
            else if (source[index] == '}')
            {
                depth--;
                if (depth == 0)
                    return source.Substring(open, index - open + 1);
            }
        }

        throw new InvalidOperationException($"{name} has no closing brace");
    }

    private static string ReadRepositoryFile(string relativePath)
    {
        for (DirectoryInfo? directory = new(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            string candidate = Path.Combine(directory.FullName, relativePath);
            if (File.Exists(candidate))
                return File.ReadAllText(candidate);
        }

        throw new FileNotFoundException($"{relativePath} is not reachable from {AppContext.BaseDirectory}");
    }

    /// <summary>
    /// A headless world shaped like the game's own: a map location with an edge warp, a town whose drawn door leads into two
    /// interiors, two interiors whose only transition is their own exit, and one location entered by an ACTION (a mine
    /// level) so the gate's population is proved not to be "every node".
    /// </summary>
    private sealed class GateWorld : IDisposable
    {
        private readonly Dictionary<string, object?> statics;

        private GateWorld() => this.statics = HeadlessGameWorld.CaptureStatics();

        internal IReadOnlyList<GameLocation> Locations { get; private set; } = Array.Empty<GameLocation>();

        internal static GateWorld Create()
        {
            var world = new GateWorld();

            Game1.game1 = (Game1)FormatterServices.GetUninitializedObject(typeof(Game1));
            var root = (NetRoot<NetWorldState>)FormatterServices.GetUninitializedObject(typeof(NetRoot<NetWorldState>));
            root.Value = new NetWorldState();
            typeof(Game1).GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!.SetValue(null, root);

            var farm = Location("Farm");
            farm.warps.Add(new Warp(79, 17, "Town", 60, 60, flipFarmer: false));

            var town = Location("Town");
            town.warps.Add(new Warp(-1, 53, "BusStop", 60, 60, flipFarmer: false));
            Door(town, 12, 14, 4, 18, "ScienceHouse");
            Door(town, 9, 12, 4, 18, "SeedShop");

            var scienceHouse = Location("ScienceHouse");
            scienceHouse.warps.Add(new Warp(4, 32, "Town", 60, 60, flipFarmer: false));

            var seedShop = Location("SeedShop");
            seedShop.warps.Add(new Warp(4, 32, "Town", 60, 60, flipFarmer: false));

            var mine = Location("UndergroundMine17");
            mine.warps.Add(new Warp(2, 2, "UndergroundMine16", 8, 8, flipFarmer: false));

            world.Locations = new[] { farm, town, scienceHouse, seedShop, mine };

            var actor = (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));
            SetField(actor, "position", new NetPosition());
            SetField(actor, "currentLocationRef", new NetLocationRef());
            SetField(actor, "netItems", new NetRef<StardewValley.Inventories.Inventory> { Value = new StardewValley.Inventories.Inventory() });
            actor.position.Set(new Vector2(64 * 64 + 8, 15 * 64));
            actor.currentLocation = farm;
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, actor);
            HeadlessGameWorld.RequireBound(actor, farm);

            return world;
        }

        /// <summary>A drawn door: the Buildings-layer `Action` is what `updateDoors` and the resolver both read.</summary>
        private static void Door(GameLocation location, int sourceX, int sourceY, int targetX, int targetY, string target)
        {
            string action = $"Warp {targetX} {targetY} {target}";
            xTile.Layers.Layer buildings = location.map!.GetLayer("Buildings");
            if (buildings.Tiles[sourceX, sourceY] is null)
            {
                var sheet = new xTile.Tiles.TileSheet(location.map, "gate", new xTile.Dimensions.Size(64, 64), new xTile.Dimensions.Size(1, 1));
                location.map.AddTileSheet(sheet);
                buildings.Tiles[sourceX, sourceY] = new xTile.Tiles.StaticTile(
                    buildings, sheet, xTile.Tiles.BlendMode.Alpha, 0);
            }
            buildings.Tiles[sourceX, sourceY].Properties["Action"] = action;
            location.doors.Add(new Point(sourceX, sourceY), new NetString(target));
        }

        private static GameLocation Location(string name)
        {
            var location = new GameLocation();
            var map = new xTile.Map();
            map.AddLayer(new xTile.Layers.Layer("Back", map, new xTile.Dimensions.Size(80, 80), new xTile.Dimensions.Size(64, 64)));
            map.AddLayer(new xTile.Layers.Layer("Buildings", map, new xTile.Dimensions.Size(80, 80), new xTile.Dimensions.Size(64, 64)));
            location.map = map;
            SetField(location, "name", new NetString(name));
            return location;
        }

        private static void SetField(object target, string name, object value) =>
            target.GetType()
                .GetField(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(target, value);

        public void Dispose() => HeadlessGameWorld.RestoreStatics(this.statics);
    }
}
