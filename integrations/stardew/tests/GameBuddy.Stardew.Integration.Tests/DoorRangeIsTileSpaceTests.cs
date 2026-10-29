using System;
using System.IO;
using System.Reflection;
using FluentAssertions;
using Microsoft.Xna.Framework;
using Netcode;
using StardewValley;
using StardewValley.Network;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Fixture 1's premise, asked of the real engine: does a body standing 20px off a door tile's centre make
/// <c>enter_exit</c> refuse <c>door_out_of_range</c>?
///
/// <para>
/// The spec (§3.1.1 item 3, §4.2 Fixture 1) says the answer is yes and that the cure is a 60 Hz secondary-axis
/// centring force in the door micro-step. The refusal is real - it was measured on 2026-10-25 - but this file
/// establishes WHICH predicate produced it, because the two possible causes need opposite fixes:
/// </para>
/// <list type="number">
/// <item>a PIXEL-space range gate, which an off-centre shoulder could fail; or</item>
/// <item>a TILE-space range gate, which pixel offset cannot affect at all, so the refusal can only mean the
/// actor was standing on the wrong TILE and the fix belongs to the approach walk that put it there.</item>
/// </list>
///
/// <para>
/// The gate in <c>RequestLocalDoorTransition</c> is
/// <c>Utility.tileWithinRadiusOfPlayer(sourceX, sourceY, 1, Game1.player)</c>, and the target version's body of
/// that function (<c>Utility.cs:4100-4109</c>) reads <c>f.Tile</c> and compares it to the requested tile with
/// <c>&lt;=</c> on both axes. <c>f.Tile</c> is <c>StandingPixel / 64</c> (<c>Character.cs:361-373</c>), an integer
/// division, so it is constant across the whole 64px span of a tile. No pixel value reaches the comparison.
/// </para>
///
/// <para>
/// The assertions below therefore exercise the real function on a real <c>Farmer</c> with the real 48x32
/// bounding box, at the offset Fixture 1 names, and pin where the refusal's boundary actually is. They also
/// establish the ONE place a 20px offset does change behaviour - the warp triptych in
/// <see cref="Farmer.MovePositionImpl"/>, which tests the body's BOUNDING BOX corners, not its tile - so the
/// difference is recorded rather than glossed.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the pins here assert on repository source text because the native seam they cover cannot load in a headless runner, while the rest of the class constructs and calls product code for real; keeping both in one file keeps each pin beside the behaviour it protects.
public sealed class DoorRangeIsTileSpaceTests
{
    private const string DecompiledUtility = "ref/external/StardewValleyDecompiled/Stardew Valley/StardewValley/Utility.cs";
    private const string DecompiledGameLocation = "ref/external/StardewValleyDecompiled/Stardew Valley/StardewValley/GameLocation.cs";
    private const string DecompiledBuilding = "ref/external/StardewValleyDecompiled/Stardew Valley/StardewValley.Buildings/Building.cs";
    private const string MovementActions = "integrations/stardew/farmhandexecutioncontroller.movementactions.cs";

    private const int DoorX = 3;
    private const int DoorY = 11;

    /// <summary>Fixture 1's number: standing 20px left of the door tile's own centre.</summary>
    private const int OffAxisPixels = 20;

    [Fact]
    public void ATwentyPixelOffsetFromTheTileCentreDoesNotRefuseTheDoorRange()
    {
        // The premise, asserted on the engine's own function. The actor is on the door's tile with its
        // standing pixel 20px off that tile's centre on BOTH axes - the "half-tile shoulder against the door
        // jamb" Fixture 1 describes.
        using DoorHarness harness = DoorHarness.Create();
        harness.StandOnTileOffsetBy(DoorX, DoorY, -OffAxisPixels, -OffAxisPixels);

        harness.Actor.Tile.Should().Be(new Vector2(DoorX, DoorY),
            "a 20px offset is well inside the 64px tile, so the body still occupies the door's tile");
        harness.Actor.StandingPixel.X.Should().Be(DoorX * 64 + 32 - OffAxisPixels,
            "the standing pixel really is 20px off the tile's centre - the fixture's Given, measured");
        harness.Actor.StandingPixel.Y.Should().Be(DoorY * 64 + 32 - OffAxisPixels);

        Utility.tileWithinRadiusOfPlayer(DoorX, DoorY, 1, harness.Actor)
            .Should().BeTrue("the range gate reads TILE coordinates, so an off-centre body is still in range");
    }

    [Fact]
    public void TheRangeGateIsTileSpaceAndItsBoundaryIsOneTileOfSeparation()
    {
        // What the gate actually measures, swept: every standing-pixel offset within the tile passes, and
        // so does every offset within one tile of separation. The refusal boundary is a whole tile away.
        using DoorHarness harness = DoorHarness.Create();

        foreach (int offset in new[] { -20, -8, 0, 8, 20 })
        {
            harness.StandOnTileOffsetBy(DoorX, DoorY, offset, offset);
            Utility.tileWithinRadiusOfPlayer(DoorX, DoorY, 1, harness.Actor)
                .Should().BeTrue($"a body standing {offset}px off the tile centre is on the door's tile");
        }

        // One tile away is inside the radius. The 20px question does not arise here: separation is whole tiles.
        harness.StandOnTileOffsetBy(DoorX - 1, DoorY, 0, 0);
        Utility.tileWithinRadiusOfPlayer(DoorX, DoorY, 1, harness.Actor)
            .Should().BeTrue("the native click path requires Chebyshev-1, and the Mod keeps that same radius");

        // Two tiles away is the refusal, and it is a TILE fact - where `door_out_of_range` comes from.
        harness.StandOnTileOffsetBy(DoorX - 2, DoorY, 0, 0);
        Utility.tileWithinRadiusOfPlayer(DoorX, DoorY, 1, harness.Actor)
            .Should().BeFalse("`door_out_of_range` is the wrong-TILE refusal, not a wrong-pixel one");
    }

    [Fact]
    public void TheDoorEntryDispatchReadsNoPixelPosition()
    {
        // The other half of the claim: even if the range gate passed, maybe a DOOR SUBTYPE then failed on
        // alignment. Each native entry the Mod dispatches is asked on its own decompiled body, at the line its
        // own gate lives on, so a future narrowing of the defect has to start from a fact.
        string[] gameLocation = File.ReadAllLines(RepositorySourcePath(DecompiledGameLocation));
        string[] building = File.ReadAllLines(RepositorySourcePath(DecompiledBuilding));

        // checkAction builds its rectangle from the TILE and hands the same Location to performAction.
        gameLocation[7639 - 1].Should().Contain("public virtual bool checkAction(Location tileLocation, xTile.Dimensions.Rectangle viewport, Farmer who)");
        gameLocation[7642 - 1].Should().Contain("new Microsoft.Xna.Framework.Rectangle(tileLocation.X * 64, tileLocation.Y * 64, 64, 64)");
        gameLocation[7888 - 1].Should().Contain("return performAction(value4, who, tileLocation);");
        // Building human doors answer a tile coordinate. The `who` is only consulted for mount, demolish-lock
        // and the OnUseHumanDoor hook - never for where inside the tile the farmer stands.
        building[931 - 1].Should().Contain("public virtual bool doAction(Vector2 tileLocation, Farmer who)");
        building[948 - 1].Should().Contain("tileLocation.X == (float)(humanDoor.X + tileX.Value)");
        // The Warp family's own performAction arm warps on the action's arguments alone.
        gameLocation[9477 - 1].Should().Contain("ArgUtility.TryGetPoint(action, 1, out var value10");
        gameLocation[9488 - 1].Should().Contain("Game1.warpFarmer(value11, value10.X, value10.Y, flip: false);");

        // And the gate the Mod applies before dispatching any of them is the tile-space one.
        string transition = MethodBody(Read(MovementActions), "private LocalExecutionReceipt RequestLocalDoorTransition(");
        transition.Should().Contain("Utility.tileWithinRadiusOfPlayer(sourceX, sourceY, 1, Game1.player)");
        transition.Should().NotContain("StandingPixel", "no pixel reading is involved in the door refusal");
        transition.Should().NotContain("Position.X", "and neither is the raw position");
    }

    [Fact]
    public void TheDriftAnchorForTheRangeGateHolds()
    {
        // The premise itself, cited: if the game ever changes this function to read pixels, the analysis above
        // stops being true and this assertion is where that shows up.
        string[] utility = File.ReadAllLines(RepositorySourcePath(DecompiledUtility));

        utility[4100 - 1].Should().Contain("public static bool tileWithinRadiusOfPlayer(int xTile, int yTile, int tileRadius, Farmer f)");
        utility[4103 - 1].Should().Contain("Vector2 tile = f.Tile;");
        utility[4104 - 1].Should().Contain("if (Math.Abs((float)point.X - tile.X) <= (float)tileRadius)");
        utility[4106 - 1].Should().Contain("return Math.Abs((float)point.Y - tile.Y) <= (float)tileRadius;");
        // `Tile` is the integer-tile division of the standing pixel, which is why offset cannot matter.
        string[] character = File.ReadAllLines(RepositorySourcePath(
            "ref/external/StardewValleyDecompiled/Stardew Valley/StardewValley/Character.cs"));
        character[361 - 1].Should().Contain("public Vector2 Tile");
        character[368 - 1].Should().Contain("cachedTile = new Vector2(standingPixel.X / 64, standingPixel.Y / 64);");
    }

    [Fact]
    public void ABoxCornerOverTheWarpTileIsWhereTheTwentyPixelOffsetDoesMatter()
    {
        // The one place the offset is load-bearing, established so the falsified premise is not over-read: the
        // warp triptych tests the body's BOUNDING BOX corners (`GameLocation.cs:2125`), and `Farmer`'s box is
        // 48px wide inside a 64px tile (`Farmer.cs:5933-5941`). A body shifted 20px left therefore reaches into
        // the tile beside it, which is the "heel caught the exit blanket" hazard Fixture 5 names - a
        // PASS-THROUGH fact, and the three-way rule's allowed case.
        using DoorHarness harness = DoorHarness.Create();
        harness.AddWarp(DoorX - 1, DoorY, "Farm", 64, 15);

        // 20px left: the box spans into the tile to the west, so the engine's corner test finds the warp there.
        harness.StandOnTileOffsetBy(DoorX, DoorY, -OffAxisPixels, 0);
        harness.Actor.Tile.Should().Be(new Vector2(DoorX, DoorY));
        Rectangle shiftedBox = harness.Actor.GetBoundingBox();
        (shiftedBox.Left / 64).Should().Be(DoorX - 1, "the 48px box reaches 20px west, into the neighbouring tile");
        harness.Location.isCollidingWithWarp(shiftedBox, harness.Actor)
            .Should().NotBeNull("walking there would warp the farmer - the blanket is touched by the box, not the tile");

        // 20px RIGHT: the box no longer reaches west, and the same warp is not touched.
        harness.StandOnTileOffsetBy(DoorX, DoorY, OffAxisPixels, 0);
        Rectangle rightBox = harness.Actor.GetBoundingBox();
        (rightBox.Left / 64).Should().Be(DoorX, "shifted the other way, the box stays inside its own tile on the west side");
        harness.Location.isCollidingWithWarp(rightBox, harness.Actor)
            .Should().BeNull("the same warp tile is out of reach of the box in this direction");
    }

    // -------------------------------------------------------------------------

    private static string Read(string relative) => File.ReadAllText(RepositorySourcePath(relative));

    private static string MethodBody(string source, string signature)
    {
        int index = source.IndexOf(signature, StringComparison.Ordinal);
        index.Should().BeGreaterThanOrEqualTo(0, $"{signature} must exist");
        int opening = source.IndexOf('{', index + signature.Length);
        opening.Should().BeGreaterThanOrEqualTo(0, $"{signature} must have a body");
        int depth = 0;
        for (int cursor = opening; cursor < source.Length; cursor++)
        {
            if (source[cursor] == '{') depth++;
            else if (source[cursor] == '}' && --depth == 0) return source[opening..(cursor + 1)];
        }

        throw new InvalidOperationException($"unbalanced body for {signature}");
    }

    private static string RepositorySourcePath(string relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++, directory = directory.Parent)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (File.Exists(candidate)) return candidate;
            }
        }

        throw new FileNotFoundException($"repository source not found: {relative}");
    }

    /// <summary>
    /// A real <see cref="GameLocation"/> with the two layers the engine's collision test reads, a real
    /// <c>Farmer</c> carrying its 48x32 bounding box, and a warp table the engine's own corner test can find.
    /// The actor's position is set through <c>position.Set</c>, exactly as a warp would place it.
    /// </summary>
    private sealed class DoorHarness : IDisposable
    {
        private readonly Game1? gameBefore;
        private readonly Farmer? playerBefore;
        private readonly object? worldStateBefore;

        private DoorHarness()
        {
            this.gameBefore = Game1.game1;
            this.playerBefore = Game1.player;
            this.worldStateBefore = typeof(Game1)
                .GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!
                .GetValue(null);
            this.Location = null!;
            this.Actor = null!;
        }

        public GameLocation Location { get; private set; }

        public Farmer Actor { get; private set; }

        public static DoorHarness Create()
        {
            var harness = new DoorHarness();

            var root = (NetRoot<NetWorldState>)System.Runtime.Serialization.FormatterServices
                .GetUninitializedObject(typeof(NetRoot<NetWorldState>));
            root.Value = new NetWorldState();
            typeof(Game1)
                .GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!
                .SetValue(null, root);
            if (Game1.game1 is null)
                Game1.game1 = (Game1)System.Runtime.Serialization.FormatterServices.GetUninitializedObject(typeof(Game1));

            GameLocation location = new();
            var map = new xTile.Map();
            map.AddLayer(new xTile.Layers.Layer("Back", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            map.AddLayer(new xTile.Layers.Layer("Buildings", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            location.map = map;
            SetField(location, "name", new NetString("ProbeFarmHouse"));

            var sprite = (FarmerSprite)System.Runtime.Serialization.FormatterServices
                .GetUninitializedObject(typeof(FarmerSprite));
            SetField(sprite, "spriteWidth", new NetInt(16));
            SetField(sprite, "spriteHeight", new NetInt(32));
            SetField(sprite, "tempSpriteHeight", -1);

            var actor = (Farmer)System.Runtime.Serialization.FormatterServices.GetUninitializedObject(typeof(Farmer));
            SetField(actor, "position", new NetPosition());
            SetField(actor, "currentLocationRef", new NetLocationRef());
            SetField(actor, "netMount", new NetRef<StardewValley.Characters.Horse>());
            SetField(actor, "sprite", new NetRef<AnimatedSprite> { Value = sprite });
            actor.position.Set(new Vector2(DoorX * 64 + 8, DoorY * 64));
            actor.currentLocation = location;
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, actor);

            harness.Location = location;
            harness.Actor = actor;
            return harness;
        }

        /// <summary>
        /// Places the body on <paramref name="tileX"/>,<paramref name="tileY"/> with its standing pixel displaced
        /// from that tile's centre by the given pixels, which is the geometry Fixture 1 names.
        ///
        /// <c>StandingPixel</c> is the centre of the bounding box (<c>Character.cs:346-357</c>) and the box is
        /// <c>position + (8, 0, 48, 32)</c> (<c>Farmer.cs:5933-5941</c>), so the engine-centred position carries
        /// the offset unchanged: offset 0 puts the standing pixel exactly on <c>tile * 64 + 32</c>.
        /// </summary>
        public void StandOnTileOffsetBy(int tileX, int tileY, int offsetX, int offsetY) =>
            this.Actor.position.Set(new Vector2(
                tileX * 64 + offsetX,
                tileY * 64 + 16 + offsetY));

        public void AddWarp(int x, int y, string target, int targetX, int targetY) =>
            this.Location.warps.Add(new Warp(x, y, target, targetX, targetY, flipFarmer: false));

        private static void SetField(object target, string name, object value) =>
            target.GetType()
                .GetField(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(target, value);

        public void Dispose()
        {
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, this.playerBefore);
            typeof(Game1)
                .GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!
                .SetValue(null, this.worldStateBefore);
            Game1.game1 = this.gameBefore!;
        }
    }
}
