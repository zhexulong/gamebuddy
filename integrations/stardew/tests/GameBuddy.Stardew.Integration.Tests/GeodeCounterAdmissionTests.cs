using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using Microsoft.Xna.Framework;
using Netcode;
using StardewValley;
using StardewValley.Network;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// WHERE THE GEODE MENU MAY BE OPENED FROM, asked of the engine's own counter seam instead of a distance.
///
/// <para>
/// The counter is a TILE whose Buildings action is <c>Blacksmith</c>. Clicking it runs
/// <c>case "Blacksmith": if (who.TilePoint.Y &gt; tileLocation.Y) return blacksmith(tileLocation);</c>
/// (GameLocation.cs:9873-9878); <c>blacksmith()</c> finds Clint by NAME in the room's character list
/// (:10950-10955 - it compares no tile; the comparison at :10956-10959 discards its own result), offers
/// the <c>Process</c> response when the pack holds a geode (:10992-11009), and that answer runs
/// <c>case "Blacksmith_Process": Game1.activeClickableMenu = new GeodeMenu();</c> (:12345-12346). The one
/// distance in the chain is the one <c>Game1</c> applies to the CLICKED TILE before
/// <c>GameLocation.checkAction</c> (<c>Utility.tileWithinRadiusOfPlayer(grabTile, 1, player)</c>,
/// Game1.cs:11509).
/// </para>
/// <para>
/// <c>GeodeCounterInteractionRadius = 2</c> was neither of those: a Chebyshev radius measured against
/// CLINT's tile, with no engine member behind it - the same defect <c>shop_purchase</c> paid for in
/// round 42, which refused a player the game would have served and read as a world fact.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the admission pins drive the product's own predicate against a real Farmer and a real
// `GameLocation` map, while the last pin reads the handler's source, because the menu it opens needs the live game
// thread and cannot be constructed headless; keeping both here keeps each pin beside the behaviour it protects.
public sealed class GeodeCounterAdmissionTests
{
    private const string ImplementationRelativePath = "integrations/stardew/farmhandexecutioncontroller.geodeactions.cs";

    /// <summary>The counter tile the probe's map carries.</summary>
    private const int CounterX = 8;
    private const int CounterY = 9;

    /// <summary>The probe location's own name, so a refusal's tokens can be asserted exactly.</summary>
    private const string LocationName = "GeodeProbe";

    /// <summary>
    /// THE ENGINE'S ADMITTED SET, tile by tile. The counter case runs only for an actor standing BELOW the
    /// tile (<c>who.TilePoint.Y &gt; tileLocation.Y</c>, GameLocation.cs:9874) and only inside the native click
    /// radius of it (Game1.cs:11509), so exactly the three tiles of the row below it are admitted - and the
    /// published admission must be that, at every boundary.
    /// </summary>
    [Fact]
    public void TheCounterIsAdmittedFromExactlyTheTilesTheEngineOpensItFrom()
    {
        using GeodeCounterWorld world = GeodeCounterWorld.Create();
        world.PutClintAt(CounterX, CounterY - 1);

        (int X, int Y, bool Admitted)[] cases =
        {
            (CounterX - 1, CounterY + 1, true),
            (CounterX, CounterY + 1, true),
            (CounterX + 1, CounterY + 1, true),
            (CounterX - 2, CounterY + 1, false),
            (CounterX + 2, CounterY + 1, false),
            (CounterX, CounterY + 2, false),
            (CounterX - 1, CounterY - 1, false),
            (CounterX, CounterY, false),
            (CounterX, CounterY - 1, false),
        };

        foreach ((int x, int y, bool admitted) in cases)
        {
            world.StandOn(x, y);
            bool engine =
                y > CounterY && Utility.tileWithinRadiusOfPlayer(CounterX, CounterY, 1, world.Actor);
            engine.Should().Be(admitted, "the engine's own two conditions are the rule being reported, at {0},{1}", x, y);

            ExecutionManager
                .TryLocateGeodeCounter(world.Actor, world.Location, out RefusalLayerToken blocked, out string evidence)
                .Should()
                .Be(engine, $"the counter's admission must BE the engine's answer at {x},{y}: {evidence}");
            blocked.Refused.Should().Be(!engine, "an admitted counter carries no refusal layer");
        }
    }

    /// <summary>
    /// THE MEASURED SHAPE, and the reason the old constant could not stay. The engine looks Clint up by name in
    /// the room and never compares his tile, so his distance from the actor decides nothing: a blacksmith standing
    /// far from his own counter changes no admission. The deleted radius refused every tile more than two tiles
    /// from the OWNER, which is why a player who could open the menu in the game was refused as if the world had.
    /// </summary>
    [Fact]
    public void ClintFarFromTheCounterAdmitsIt_BecauseHisTileIsNotTheGates()
    {
        using GeodeCounterWorld world = GeodeCounterWorld.Create();
        world.PutClintAt(2, 14);
        world.StandOn(CounterX, CounterY + 1);

        Math.Max(Math.Abs(CounterX - 2), Math.Abs(CounterY + 1 - 14)).Should().BeGreaterThan(
            2,
            "the deleted radius refused every tile more than two tiles from the owner's tile");

        ExecutionManager
            .TryLocateGeodeCounter(world.Actor, world.Location, out _, out string evidence)
            .Should()
            .BeTrue($"the engine would offer this counter from here: {evidence}");
    }

    /// <summary>
    /// A refusal states WHICH TILE the caller must reach and WHICH of the engine's two conditions failed. A generic
    /// distance would leave the companion re-aiming; the counter tile is the approach target an action can name.
    /// </summary>
    [Fact]
    public void ARefusalNamesTheCounterTileAndTheEngineConditionThatFailed()
    {
        using GeodeCounterWorld world = GeodeCounterWorld.Create();
        world.PutClintAt(CounterX, CounterY - 1);

        // Above the counter: below-counter is the condition that fails, not the radius.
        world.StandOn(CounterX, CounterY - 1);
        ExecutionManager
            .TryLocateGeodeCounter(world.Actor, world.Location, out RefusalLayerToken above, out string aboveEvidence)
            .Should()
            .BeFalse();
        above.Layer.Should().Be(RefusalLayerKind.Range);
        above.Detail.Should().Be($"counter@{CounterX},{CounterY}", "the caller is told which tile to approach");
        aboveEvidence.Should().Contain("actor_below_counter=false;within_range_of_request=true");

        // Two tiles below: below the counter, outside the native radius on it.
        world.StandOn(CounterX, CounterY + 2);
        ExecutionManager
            .TryLocateGeodeCounter(world.Actor, world.Location, out RefusalLayerToken far, out string farEvidence)
            .Should()
            .BeFalse();
        far.Detail.Should().Be($"counter@{CounterX},{CounterY}");
        farEvidence.Should().Contain("actor_below_counter=true;within_range_of_request=false");
        farEvidence.Should().Contain("radius=1", "the number printed is the engine's own (Game1.cs:11509)");
        farEvidence.Should().NotContain("owner_tile=", "the counter is what must be reached, never the blacksmith's tile");
    }

    /// <summary>
    /// A counter that is not here refuses by name. Without a tile carrying the action the engine never reaches
    /// <c>blacksmith()</c>, so no "Process Geodes" response exists in this room at all (GameLocation.cs:9873-9878).
    /// </summary>
    [Fact]
    public void ARoomWithoutTheCounterActionRefusesByName()
    {
        using GeodeCounterWorld world = GeodeCounterWorld.Create(counterTile: false);

        ExecutionManager
            .TryLocateGeodeCounter(world.Actor, world.Location, out RefusalLayerToken blocked, out string evidence)
            .Should()
            .BeFalse();
        blocked.Layer.Should().Be(RefusalLayerKind.Range);
        blocked.Detail.Should().Be($"absent@{LocationName}");
        evidence.Should().Be("counter_action=Blacksmith;counter_tiles=0");

        // No location at all is the same answer, and says which one it was about.
        ExecutionManager
            .TryLocateGeodeCounter(world.Actor, null, out RefusalLayerToken nowhere, out string nowhereEvidence)
            .Should()
            .BeFalse();
        nowhere.Detail.Should().Be("absent@none");
        nowhereEvidence.Should().Be("counter_action=Blacksmith;counter_tiles=0");
    }

    /// <summary>
    /// The counter is here and the blacksmith is not: the engine's own loop finds nobody to offer the question, so
    /// no menu can open and the refusal names the character rather than a distance.
    /// </summary>
    [Fact]
    public void ACounterWithNoBlacksmithInTheRoomRefusesByName()
    {
        using GeodeCounterWorld world = GeodeCounterWorld.Create();
        world.StandOn(CounterX, CounterY + 1);

        ExecutionManager
            .TryLocateGeodeCounter(world.Actor, world.Location, out RefusalLayerToken blocked, out string evidence)
            .Should()
            .BeFalse("`blacksmith()` finds nobody to offer the question, so the menu cannot be reached");
        blocked.Layer.Should().Be(RefusalLayerKind.Character);
        blocked.Detail.Should().Be("Clint@absent");
        evidence.Should().Contain("owner_present=false");
        evidence.Should().Contain($"counter_tiles={CounterX},{CounterY}");
    }

    /// <summary>
    /// The defect itself, pinned: the handler holds no interaction radius of its own, measures the counter TILE,
    /// and opens the menu through the engine's own counter case rather than a constructor of its own.
    /// </summary>
    [Fact]
    public void TheHandlerHoldsNoRadiusOfItsOwn_AndOpensThroughTheEnginesCounterCase()
    {
        string code = StripLineComments(File.ReadAllText(RepositorySourcePath(ImplementationRelativePath)));

        code.Should().NotContain(
            "GeodeCounterInteractionRadius",
            "a radius with no engine member behind it is the defect the engine's counter admission replaced");
        code.Should().NotContain("owner_tile=", "the blacksmith's tile decides nothing about opening his counter");
        code.Should().Contain("IsWithinRangeOfRequest(", "the reach is the engine's own call, on the counter tile");
        code.Should().Contain("GeodeCounterTileAction", "the counter is the map's own `Action: Blacksmith` tile");
        code.Should().Contain(
            "answerDialogueAction(\"Blacksmith_Process\"",
            "the menu is constructed by the engine's counter case (GameLocation.cs:12345-12346), not here");
    }

    /// <summary>Drops line comments, because the pins are about what the handler DOES.</summary>
    private static string StripLineComments(string source)
    {
        string[] lines = source.Split('\n');
        for (int index = 0; index < lines.Length; index++)
        {
            int comment = lines[index].IndexOf("//", StringComparison.Ordinal);
            if (comment >= 0)
                lines[index] = lines[index][..comment];
        }

        return string.Join('\n', lines);
    }

    private static string RepositorySourcePath(string relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (File.Exists(candidate))
                    return candidate;
                directory = directory.Parent;
            }
        }

        throw new FileNotFoundException($"repository source not found: {relative}");
    }

    /// <summary>
    /// A headless blacksmith: a real <see cref="GameLocation"/> whose map carries the counter's own
    /// <c>Action: Blacksmith</c> property, plus a real <see cref="Farmer"/> placed on whole tiles. Nothing else is
    /// seeded, because the admission reads nothing else - not the pack, not the map beyond that one property.
    /// </summary>
    private sealed class GeodeCounterWorld : IDisposable
    {
        private const int MapWidth = 16;
        private const int MapHeight = 16;

        private readonly Game1? gameBefore;
        private readonly Farmer? playerBefore;
        private readonly object? worldStateBefore;

        private GeodeCounterWorld(
            GameLocation location,
            Farmer actor,
            Game1? gameBefore,
            Farmer? playerBefore,
            object? worldStateBefore)
        {
            this.Location = location;
            this.Actor = actor;
            this.gameBefore = gameBefore;
            this.playerBefore = playerBefore;
            this.worldStateBefore = worldStateBefore;
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, actor);
        }

        internal GameLocation Location { get; }

        internal Farmer Actor { get; }

        internal static GeodeCounterWorld Create(bool counterTile = true)
        {
            // The three statics this world replaces are captured BEFORE they are replaced, so `Dispose` restores the
            // state the suite was in rather than the probe's own.
            Game1? gameBefore = Game1.game1;
            Farmer? playerBefore = Game1.player;
            object? worldStateBefore = typeof(Game1)
                .GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!
                .GetValue(null);

            // `Character.Tile` reads a position, and `NetPosition.Get` asks `Game1.HostPaused`, which reads the
            // world-state root's `paused` flag; an uninitialized `Game1` and a real root are the shape the rest of
            // this suite's headless worlds use for exactly those reads.
            if (gameBefore is null)
                Game1.game1 = Uninitialized<Game1>();
            var worldState = (NetRoot<NetWorldState>)FormatterServices.GetUninitializedObject(typeof(NetRoot<NetWorldState>));
            worldState.Value = new NetWorldState();
            typeof(Game1).GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!.SetValue(null, worldState);

            var location = new GameLocation();
            SetInstanceField(location, "name", new NetString(LocationName));
            location.map = Map(counterTile);

            Farmer actor = Uninitialized<Farmer>();
            SetInstanceField(actor, "position", new NetPosition());
            SetInstanceField(actor, "currentLocationRef", new NetLocationRef());
            // `Character.Tile` reaches the standing pixel through the sprite's size and the mount ref, so both are
            // plain NetFields a real farmer always carries.
            SetInstanceField(actor, "netMount", new NetRef<StardewValley.Characters.Horse>());
            var sprite = Uninitialized<FarmerSprite>();
            SetInstanceField(sprite, "spriteWidth", new NetInt(16));
            SetInstanceField(sprite, "spriteHeight", new NetInt(32));
            SetInstanceField(sprite, "tempSpriteHeight", -1);
            SetInstanceField(actor, "sprite", new NetRef<AnimatedSprite> { Value = sprite });

            var world = new GeodeCounterWorld(location, actor, gameBefore, playerBefore, worldStateBefore);
            world.StandOn(0, 0);
            return world;
        }

        /// <summary>Puts the blacksmith in the room at the tile the game keeps him on: behind the counter.</summary>
        internal void PutClintAt(int x, int y)
        {
            NPC clint = Uninitialized<NPC>();
            SetInstanceField(clint, "name", new NetString(ExecutionManager.GeodeCounterOwnerName));
            SetInstanceField(clint, "position", new NetPosition());
            this.Location.characters.Add(clint);
            clint.Position = new Vector2(x * 64f, y * 64f);
        }

        /// <summary>Puts the body on <paramref name="x"/>,<paramref name="y"/>: tile centre in X, tile top in Y.</summary>
        internal void StandOn(int x, int y) => this.Actor.position.Set(new Vector2(x * 64 + 8, y * 64));

        public void Dispose()
        {
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, this.playerBefore);
            typeof(Game1)
                .GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!
                .SetValue(null, this.worldStateBefore);
            Game1.game1 = this.gameBefore!;
        }

        /// <summary>
        /// A map with the three layers a Stardew location holds, and - when asked for - the engine's own counter
        /// property on its Buildings layer, built the way a real map holds it: a `StaticTile` on a tilesheet bound
        /// to the map, with the property on the tile.
        /// </summary>
        private static xTile.Map Map(bool counterTile)
        {
            var map = new xTile.Map();
            foreach (string layer in new[] { "Back", "Buildings", "Front" })
            {
                map.AddLayer(new xTile.Layers.Layer(
                    layer, map, new xTile.Dimensions.Size(MapWidth, MapHeight), new xTile.Dimensions.Size(64, 64)));
            }

            if (!counterTile)
                return map;

            var sheet = new xTile.Tiles.TileSheet(
                "probe", map, "Maps/probe", new xTile.Dimensions.Size(64, 64), new xTile.Dimensions.Size(16, 16));
            map.AddTileSheet(sheet);
            xTile.Layers.Layer buildings = map.GetLayer("Buildings");
            buildings.Tiles[CounterX, CounterY] = new xTile.Tiles.StaticTile(
                buildings, sheet, xTile.Tiles.BlendMode.Alpha, 0);
            buildings.Tiles[CounterX, CounterY].Properties["Action"] = ExecutionManager.GeodeCounterTileAction;
            return map;
        }

        private static T Uninitialized<T>() where T : class =>
            (T)FormatterServices.GetUninitializedObject(typeof(T));

        private static void SetInstanceField(object target, string name, object value)
        {
            for (Type? type = target.GetType(); type is not null; type = type.BaseType)
            {
                FieldInfo? field = type.GetField(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
                if (field is null)
                    continue;
                field.SetValue(target, value);
                return;
            }

            throw new InvalidOperationException($"probe_field_missing:{target.GetType().Name}.{name}");
        }
    }
}
