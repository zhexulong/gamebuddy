using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Microsoft.Xna.Framework;
using Netcode;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Network;
using StardewValley.Tools;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A `till_soil` refusal must name the world it is about, and the two refusals this file covers were measured failing to.
///
/// <para>
/// LIVE, 2026-11-09: the companion said 东头再往东那几格根本下不了锄，地是死硬的 ("you cannot hoe those tiles east of the east
/// end at all - the ground is dead hard") and 我挪来挪去总差一格 ("I kept moving around and was always one tile short").
/// The same session's refusal counts were `soil_not_diggable` x1, `target_out_of_range` x3, `no_reachable_approach:74:22`
/// x1. The three `target_out_of_range` were not about distance: that code is emitted at exactly one site in
/// `RequestLocalTillSoil`, and that site fires when the far tile is NOT diggable - a dead tile answered with `distance=`
/// is the reason she kept re-aiming at ground that can never be farmed.
/// </para>
///
/// <para>
/// So two facts have to reach the caller, and each has one owner:
/// <list type="bullet">
/// <item>WHY a tile cannot be hoed is a closed set derived from the one predicate that refuses (water, the map's own
/// `Diggable` property, or an occupant the engine can name), so the message cannot drift from the check;</item>
/// <item>WHERE the action wants the actor to stand comes from the approach leg's own selector - the tile it walks to is
/// the tile the receipt publishes, never a second selection that could disagree with it.</item>
/// </list>
/// </para>
///
/// <para>
/// SCOPE, stated because it is easy to over-read: the ACCEPTED half (a farmable tile out of range answers with a
/// `stand_at` adjacent to the target) cannot be driven in this runner. `StardewBodyController.TryStart` reaches
/// `new PathFindController(...)`, whose first act is `isPlayerPresent()` over `FarmerCollection.Any()`, and an empty
/// hand-built `GameLocation` makes that throw. That half is L1/live-only; what is pinned here is the selector's answer
/// (a real tile, Chebyshev-1 from the target) and the single publication that renders it.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the refusal paths are driven through the real handler against a fixture world, while the
// accepting half and the "one predicate, two readers" invariant are pinned on source text for the reason in SCOPE above.
public sealed class TillSoilRefusalNamingTests
{
    private const string ResourceToolActions = "integrations/stardew/farmhandexecutioncontroller.resourcetoolactions.cs";

    // ---- why a tile cannot be hoed: one member of a closed set ------------------------------

    [Fact]
    public void ATileWithoutTheMapsDiggableProperty_SaysSoRatherThanNamingADistance()
    {
        using TillSoilHarness harness = TillSoilHarness.Create();
        harness.PlaceActorAt(12, 10);
        harness.SetNotDiggable(13, 10);

        LocalExecutionReceipt receipt = harness.RequestTill(13, 10);

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be(
            "soil_not_diggable:not_map_diggable",
            "the vanilla rule is what refuses this tile, and it is the honest answer to 'this ground is dead'");
        receipt.Evidence.Should().Contain("target=13,10");
        receipt.Evidence.Should().NotContain("distance=", "a tile that can never be farmed is dead at any distance");
    }

    [Fact]
    public void AWaterTile_SaysWater()
    {
        using TillSoilHarness harness = TillSoilHarness.Create();
        harness.PlaceActorAt(12, 10);
        harness.SetDiggable(13, 10);
        harness.SetWater(13, 10);

        LocalExecutionReceipt receipt = harness.RequestTill(13, 10);

        receipt.ReasonCode.Should().Be("soil_not_diggable:water", "the tile is water; no amount of walking changes that");
    }

    [Fact]
    public void AFarmableTileWithSomethingOnIt_NamesTheOccupantInTheEnginesOwnWords()
    {
        using TillSoilHarness harness = TillSoilHarness.Create();
        harness.PlaceActorAt(12, 10);
        harness.SetDiggable(13, 10);
        harness.PlaceObject(13, 10, new StardewValley.Objects.Chest());

        LocalExecutionReceipt receipt = harness.RequestTill(13, 10);

        receipt.ReasonCode.Should().Be(
            "soil_not_diggable:occupied:chest",
            "the word is the engine's own type name, lowercased into the reasonCode alphabet, so a caller knows what to move");
    }

    [Fact]
    public void ADeadTileAcrossTheFarm_KeepsItsOwnReasonRatherThanADistance()
    {
        // The measured defect itself: three live refusals about ground that can never be farmed arrived as
        // `target_out_of_range` with a `distance=` attached, which is the one fact that cannot help.
        using TillSoilHarness harness = TillSoilHarness.Create();
        harness.PlaceActorAt(2, 2);
        harness.SetNotDiggable(10, 10);

        LocalExecutionReceipt receipt = harness.RequestTill(10, 10);

        receipt.ReasonCode.Should().Be("soil_not_diggable:not_map_diggable");
        receipt.Evidence.Should().Contain("target=10,10");
        receipt.Evidence.Should().NotContain("distance=", "the tile is dead nine tiles away and dead beside her");
    }

    [Fact]
    public void ADiggableTileWithNothingOnIt_IsNotRefusedForItsSoil()
    {
        // The falsifier for the closed set: a tile that IS farmable must answer null. Asked of the predicate directly
        // because the accepting path needs a native walk (see SCOPE).
        using TillSoilHarness harness = TillSoilHarness.Create();
        harness.SetDiggable(13, 10);

        ExecutionManager.DescribeSoilRefusal(harness.Location, 13, 10)
            .Should().BeNull("farmable ground is not a refusal");
    }

    [Fact]
    public void ADiggableTileUnderWater_IsWaterEvenThoughTheMapCallsItFarmable()
    {
        // The precedence the set is ordered by: water and the map's property are what the tile IS, so a map that
        // claims `Diggable` for a water tile answers `water` rather than sending a hoe at a pond.
        using TillSoilHarness harness = TillSoilHarness.Create();
        harness.SetDiggable(13, 10);
        harness.SetWater(13, 10);

        ExecutionManager.DescribeSoilRefusal(harness.Location, 13, 10).Should().Be("water");
    }

    [Fact]
    public void ATilledTileIsNotAnOccupant()
    {
        // `HoeDirt` lives in the same collection as trees and grass, and it has its own answer (`soil_already_tilled`)
        // one gate earlier. Naming it an occupant would call the one state the hoe exists for "blocked".
        using TillSoilHarness harness = TillSoilHarness.Create();
        harness.SetDiggable(13, 10);
        harness.PlaceHoeDirt(13, 10);

        ExecutionManager.DescribeSoilRefusal(harness.Location, 13, 10)
            .Should().BeNull("a tilled tile is the hoe's own result, not an obstacle on it");
    }

    [Fact]
    public void EverySoilRefusalSurvivesTheValidatorThatWillJudgeIt()
    {
        // Emitted into a receipt, so each member has to survive the journal's own validator and the wire's alphabet.
        using TillSoilHarness harness = TillSoilHarness.Create();
        harness.SetDiggable(13, 10);
        harness.SetWater(13, 10);
        harness.SetDiggable(14, 10);
        harness.PlaceObject(14, 10, new StardewValley.Objects.Chest());
        harness.SetNotDiggable(15, 10);

        foreach (int x in new[] { 13, 14, 15 })
        {
            string? reason = ExecutionManager.DescribeSoilRefusal(harness.Location, x, 10);
            reason.Should().NotBeNull($"tile {x},10 is not farmable and must name why");
            string code = $"soil_not_diggable:{reason}";
            FarmhandExecutionJournal.IsValidReasonCode(code)
                .Should().BeTrue($"{code} is journaled as a receipt reasonCode");
            System.Text.RegularExpressions.Regex.IsMatch(code, "^[a-z0-9_:-]{1,128}$")
                .Should().BeTrue($"{code} is published to the Host as a receipt reasonCode");
        }
    }

    // ---- one predicate, two readers ---------------------------------------------------------

    [Fact]
    public void BothSitesAskTheOnePredicateAndNothingElseDecidesTheWording()
    {
        // The drift this shape exists to prevent: a third condition added to the check and not to the message. The
        // population is the request path's own two soil questions, and the message has exactly one spelling.
        string source = Read(ResourceToolActions);

        MethodBody(source, "public LocalExecutionReceipt RequestLocalTillSoil(")
            .Should().Contain("DescribeSoilRefusal(", "the request path asks the one predicate");
        MethodBody(source, "private LocalExecutionReceipt ExecuteTillSoil(")
            .Should().Contain("DescribeSoilRefusal(", "and the execution body asks the same one");

        Count(ReadMod(), "IsDiggableSoilTile")
            .Should().Be(0, "the boolean the two sites used to ask has no answer to 'why', so it must not survive beside it");
        Count(ReadMod(), "\"soil_not_diggable:")
            .Should().Be(1, "the prefix has one spelling, in the one helper both sites call");
    }

    // ---- where the action wants the actor to stand -------------------------------------------

    [Fact]
    public void AFarmableTileWithNowhereToStand_SaysThereIsNowhereToStand()
    {
        using TillSoilHarness harness = TillSoilHarness.Create();
        harness.PlaceActorAt(2, 2);
        harness.SetDiggable(10, 10);
        harness.Wall(10, 10);

        LocalExecutionReceipt receipt = harness.RequestTill(10, 10);

        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be(
            "no_standing_tile:none",
            "the tile is farmable, so the refusal is about the ground the actor must occupy - and every neighbour is walled");
        receipt.Evidence.Should().Contain("target=10,10");
        receipt.Evidence.Should().Contain("actor=2,2", "a reader needs to know where the search started");
        receipt.Evidence.Should().Contain("standable_tiles=0", "the count is the same enumeration the answer came from");
        receipt.Evidence.Should().Contain(
            "blocked_by=range:standability",
            "not `reach:8`: the distance was never the reason this placement has no approach");
    }

    [Fact]
    public void TheStandingTileTheSelectorPicksIsAdjacentToTheTarget()
    {
        // The accepting half as far as this runner can go (see SCOPE): the tile the leg publishes as `stand_at` is the
        // selector's answer, and that answer is Chebyshev-1 from the target by construction - the radius the native
        // click path gates `checkAction` on (Game1.cs:11509, tileWithinRadiusOfPlayer(grabTile, 1)).
        (int X, int Y)? chosen = ExecutionManager.SelectToolApproachTile((10, 10), (2, 2), _ => true, _ => true);

        chosen.Should().NotBeNull("there is open ground beside the target, so the actor is walked there");
        Math.Max(Math.Abs(chosen!.Value.X - 10), Math.Abs(chosen.Value.Y - 10))
            .Should().Be(1, "the tool can only reach a Chebyshev-1 tile, so the published stand_at must be one");
    }

    [Fact]
    public void TheAcceptedReceiptPublishesTheLegsOwnStandingTileAsStandAt()
    {
        // One publication, from the tile the leg itself chose (`goal`), so a coordinate she is told to stand on is the
        // coordinate the walk was dispatched to. A second selection would be a second answer.
        string body = MethodBody(Read(ResourceToolActions), "(int X, int Y) anchor,");

        int select = body.IndexOf("(int X, int Y)? standingTile = SelectToolApproachTile(", StringComparison.Ordinal);
        int goal = body.IndexOf("(int X, int Y) goal = standingTile.Value;", StringComparison.Ordinal);
        int accepted = body.IndexOf("LocalExecutionReceipt accepted = new(", StringComparison.Ordinal);
        select.Should().BeGreaterThanOrEqualTo(0, "the standing tile is chosen once");
        goal.Should().BeGreaterThan(select, "and the walk's goal IS that choice");
        accepted.Should().BeGreaterThan(goal);

        string publication = body[accepted..(body.IndexOf("this.Remember(accepted);", accepted, StringComparison.Ordinal))];
        publication.Should().Contain("stand_at={goal.X},{goal.Y}", "the receipt names the tile the walk was dispatched to");
        publication.Should().NotContain("standing={", "one fact, one spelling");
        Count(body, "SelectToolApproachTile(")
            .Should().Be(1, "a second selection in this body could publish a tile the walk does not use");
    }

    // -------------------------------------------------------------------------

    private static string Read(string relative) => File.ReadAllText(RepositoryFile(relative));

    private static string ReadMod() => string.Join(
        "\n",
        Directory.GetFiles(RepositoryFile("integrations/stardew"), "*.cs", SearchOption.AllDirectories)
            .Where(file => !file.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                && !file.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}", StringComparison.Ordinal)
                && !file.Contains($"{Path.DirectorySeparatorChar}tests{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
            .OrderBy(file => file, StringComparer.Ordinal)
            .Select(File.ReadAllText));

    private static int Count(string haystack, string needle)
    {
        int count = 0;
        int index = -1;
        while ((index = haystack.IndexOf(needle, index + 1, StringComparison.Ordinal)) >= 0)
            count++;
        return count;
    }

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

    private static string RepositoryFile(string relative)
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "AGENTS.md")))
            directory = directory.Parent;
        directory.Should().NotBeNull("the test must run inside the repository");
        return Path.Combine(directory!.FullName, relative);
    }

    /// <summary>
    /// A real headless world: a 20x20 <see cref="GameLocation"/> with the three layers the engine's tile reads ask
    /// for, a real <see cref="Farmer"/> holding a hoe, and the <c>Game1</c> statics both the engine and
    /// <c>Context.IsWorldReady</c> dereference.
    ///
    /// <para>
    /// The economy of this fixture is deliberately the real one: `Diggable` is the map's own Back tile property,
    /// water is the engine's own <c>WaterTiles</c> table, and a wall is a Buildings-layer tile with no `Passable`
    /// property - so every answer the handler gives is read from the same places a live farm is.
    /// </para>
    /// </summary>
    /// <summary>
    /// A real <see cref="GameLocation"/> with the Back layer the engine's tile reads need, a real <see cref="Farmer"/>
    /// standing at a known tile, real HoeDirt terrain features and real placed objects.
    ///
    /// <para>
    /// Internal rather than private because the rectangle query's cases drive the SAME world: two harnesses that build
    /// "a diggable farm tile" two ways is how the tillable predicate and the tile that answers it drift apart.
    /// </para>
    /// </summary>
    internal sealed class TillSoilHarness : IDisposable
    {
        private const int Width = 20;
        private const int Height = 20;

        private static readonly FieldInfo WorldReadyPerScreen = typeof(Context)
            .GetProperty("IsWorldReady", BindingFlags.Public | BindingFlags.Static)!
            .GetGetMethod()!
            .Module.ResolveField(BitConverter.ToInt32(typeof(Context)
                .GetProperty("IsWorldReady", BindingFlags.Public | BindingFlags.Static)!
                .GetGetMethod()!.GetMethodBody()!.GetILAsByteArray()!, 1))!;

        private readonly Game1? gameBefore;
        private readonly Farmer? playerBefore;
        private readonly object? worldStateBefore;
        private ExecutionManager executions;
        private xTile.Layers.Layer back = null!;
        private xTile.Layers.Layer buildings = null!;
        private xTile.Tiles.TileSheet sheet = null!;

        internal GameLocation Location = null!;

        private TillSoilHarness()
        {
            this.gameBefore = Game1.game1;
            this.playerBefore = Game1.player;
            this.worldStateBefore = typeof(Game1)
                .GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!
                .GetValue(null);
            this.executions = null!;
            this.ResetManager();
        }

        internal static TillSoilHarness Create()
        {
            var harness = new TillSoilHarness();
            if (Game1.game1 is null)
                Game1.game1 = (Game1)FormatterServices.GetUninitializedObject(typeof(Game1));
            var root = (NetRoot<NetWorldState>)FormatterServices.GetUninitializedObject(typeof(NetRoot<NetWorldState>));
            root.Value = new NetWorldState();
            typeof(Game1).GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!.SetValue(null, root);
            // `Object.isPassable` asks `IsFloorPathItem` (Object.cs:6075/:6082), which builds its lookup from
            // `Game1.floorPathData` (Flooring.cs:130) - a cache `Game1` fills at startup from `Data/FloorsAndPaths`. An
            // uninitialized `Game1` leaves it null, so ONE placed object made every collision read throw, and the
            // rectangle query reads collision on every tile it answers. Empty is the honest value: this world declares
            // no flooring, so no object is a floor path.
            Game1.floorPathData ??= new Dictionary<string, StardewValley.GameData.FloorsAndPaths.FloorPathData>(System.StringComparer.Ordinal);

            var map = new xTile.Map();
            var size = new xTile.Dimensions.Size(Width, Height);
            var tileSize = new xTile.Dimensions.Size(64, 64);
            map.AddLayer(new xTile.Layers.Layer("Back", map, size, tileSize));
            map.AddLayer(new xTile.Layers.Layer("Buildings", map, size, tileSize));
            map.AddLayer(new xTile.Layers.Layer("Front", map, size, tileSize));
            var sheet = new xTile.Tiles.TileSheet("spring", map, "Maps/spring_outdoorsTileSheet", tileSize, tileSize);
            map.AddTileSheet(sheet);
            var location = new GameLocation();
            location.map = map;
            location.IsFarm = true;
            SetField(location, "name", new NetString("ProbeTillSoil"));
            harness.Location = location;
            harness.back = map.GetLayer("Back");
            harness.buildings = map.GetLayer("Buildings");
            harness.sheet = sheet;

            var sprite = (FarmerSprite)FormatterServices.GetUninitializedObject(typeof(FarmerSprite));
            SetField(sprite, "spriteWidth", new NetInt(16));
            SetField(sprite, "spriteHeight", new NetInt(32));
            SetField(sprite, "tempSpriteHeight", -1);

            var actor = (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));
            SetField(actor, "position", new NetPosition());
            SetField(actor, "currentLocationRef", new NetLocationRef());
            SetField(actor, "netMount", new NetRef<StardewValley.Characters.Horse>());
            SetField(actor, "sprite", new NetRef<AnimatedSprite> { Value = sprite });
            SetField(actor, "uniqueMultiplayerID", new NetLong(1001));
            SetField(actor, "netStamina", new NetFloat(270f));
            SetField(actor, "usingTool", new NetBool(false));
            SetField(actor, "toolPower", new NetInt(0));
            typeof(Farmer).GetField("canMove", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(actor, true);
            SetField(actor, "temporaryItem", new NetRef<Item>());
            SetField(actor, "currentToolIndex", new NetInt(0));
            var inventory = new StardewValley.Inventories.Inventory();
            inventory.Add(SeededHoe());
            SetField(actor, "netItems", new NetRef<StardewValley.Inventories.Inventory> { Value = inventory });
            SetField(actor, "miningLevel", new NetInt(0));
            SetField(actor, "foragingLevel", new NetInt(0));
            SetField(actor, "farmingLevel", new NetInt(0));
            var buffs = new StardewValley.Buffs.BuffManager();
            typeof(StardewValley.Buffs.BuffManager)
                .GetField("CombinedEffects", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(buffs, new StardewValley.Buffs.BuffEffects());
            buffs.Dirty = false;
            SetField(actor, "buffs", buffs);
            SetField(actor, "mailReceived", new NetStringHashSet());
            actor.position.Set(new Vector2(12 * 64 + 8, 10 * 64));
            actor.currentLocation = location;
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, actor);

            WorldReadyPerScreen.GetValue(null)!.GetType()
                .GetMethod("SetValueForScreen", new[] { typeof(int), typeof(bool) })!
                .Invoke(WorldReadyPerScreen.GetValue(null), new object[] { Context.ScreenId, true });
            Context.IsWorldReady.Should().BeTrue("the headless world must satisfy the readiness gate the handler checks");

            return harness;
        }

        internal void PlaceActorAt(int x, int y) => Game1.player.position.Set(new Vector2(x * 64 + 8, y * 64));

        /// <summary>A Back-layer tile carrying the engine's own <c>Diggable</c> property.</summary>
        internal void SetDiggable(int x, int y)
        {
            xTile.Tiles.Tile tile = this.NewTile();
            tile.Properties["Diggable"] = "T";
            this.back.Tiles[x, y] = tile;
        }

        /// <summary>The same tile without the property: ground the Hoe refuses.</summary>
        internal void SetNotDiggable(int x, int y) => this.back.Tiles[x, y] = this.NewTile();

        /// <summary>
        /// The engine's own water reading: `GameLocation.isWaterTile` answers from the map's <c>Water</c> property,
        /// which is where a farm map declares a pond and what `loadMap` fills the water table from.
        /// </summary>
        internal void SetWater(int x, int y)
        {
            xTile.Tiles.Tile tile = this.back.Tiles[x, y] ?? this.NewTile();
            tile.Properties["Water"] = "T";
            this.back.Tiles[x, y] = tile;
            this.Location.isWaterTile(x, y).Should().BeTrue("the fixture must be the world the handler reads");
        }

        internal void PlaceObject(int x, int y, StardewValley.Object placed) =>
            this.Location.objects[new Vector2(x, y)] = placed;

        internal void PlaceHoeDirt(int x, int y)
        {
            var dirt = new StardewValley.TerrainFeatures.HoeDirt();
            SetField(dirt, "state", new NetInt(0));
            this.Location.terrainFeatures[new Vector2(x, y)] = dirt;
        }

        /// <summary>Walls the eight neighbours of a tile with the Buildings layer, which is what a wall is.</summary>
        internal void Wall(int x, int y)
        {
            for (int dx = -1; dx <= 1; dx++)
                for (int dy = -1; dy <= 1; dy++)
                {
                    if (dx == 0 && dy == 0) continue;
                    this.buildings.Tiles[x + dx, y + dy] =
                        new xTile.Tiles.StaticTile(this.buildings, this.sheet, xTile.Tiles.BlendMode.Alpha, 0);
                }
        }

        internal void ResetManager()
        {
            var publication = FarmhandCapabilityPublication.Initial(
                new HashSet<string>(StringComparer.Ordinal) { "till_soil" });
            this.executions = new ExecutionManager(new DummyMonitor(), () => publication, executionScope: null);
        }

        internal LocalExecutionReceipt RequestTill(int x, int y) =>
            this.executions.RequestLocalTillSoil(
                $"req_till_{x}_{y}",
                x,
                y,
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000);

        private xTile.Tiles.Tile NewTile() =>
            new xTile.Tiles.StaticTile(this.back, this.sheet, xTile.Tiles.BlendMode.Alpha, 0);

        /// <summary>
        /// The hoe the pack carries: an uninitialized <see cref="Hoe"/> with the two fields the resolver reads, built
        /// the way `DeclaredToolSelectionTests` builds one, because a real one loads item data the headless runner has not.
        /// </summary>
        private static Tool SeededHoe()
        {
            var hoe = (Hoe)FormatterServices.GetUninitializedObject(typeof(Hoe));
            typeof(Item).GetField("_qualifiedItemId", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
                .SetValue(hoe, "(T)Hoe");
            typeof(Tool).GetField("upgradeLevel", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
                .SetValue(hoe, new NetInt(0));
            return hoe;
        }

        private static void SetField(object target, string name, object value) =>
            target.GetType()
                .GetField(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(target, value);

        public void Dispose()
        {
            WorldReadyPerScreen.GetValue(null)!.GetType().GetMethod("ResetAllScreens")!
                .Invoke(WorldReadyPerScreen.GetValue(null), null);
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, this.playerBefore);
            typeof(Game1).GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!
                .SetValue(null, this.worldStateBefore);
            Game1.game1 = this.gameBefore!;
        }
    }
}
