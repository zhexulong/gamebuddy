using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Microsoft.Xna.Framework;
using Netcode;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Network;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// `a_warp_postcondition_names_where_the_engine_lands` - the arrival a warp postcondition asserts is the arrival the
/// engine actually produces, at every site that mints one.
///
/// <para>
/// MEASURED `round68`, twice: `travel` from `BusStop` was accepted with `target=Farm:79,17`, the engine landed her on
/// `(78,17)`, and the receipt said <c>travel_postcondition_mismatch</c> with
/// <c>expected=Farm:79,17;actual=Farm:78,17</c>. The Mismatch was the Mod's, not the engine's: `Game1.warpFarmer`
/// rewrites the tile the map asset declares before it moves the body (`Game1.cs:9864` - a `Farm` entry from `BusStop`
/// is replaced by the Farm map's own `BusStopEntry`), so `(79,17)` was never a place the engine promised to put anyone.
/// The same block covers `BusStop`'s and `IslandSouth`'s clamps (:9804, :9883), `FarmCave`/`Forest`/`Backwoods` entries
/// (:9818, :9843, :9873), `Trailer` and `Club` (:9892, :9933), a mount's offset (:10000) and the right-edge slide in
/// `performWarpFarmer` (:10009-10012) - which is why the fix is the postcondition's, for every warp, and not a table of
/// landing tiles.
/// </para>
///
/// <para>
/// The cases drive the REAL request path against a headless world (the shape
/// <c>EnterExitAdjacentExitRefusalTests.HeadlessWorld</c> established) and then hand the engine's landing back to the
/// production postcondition. The site is the action: <c>travel</c> and <c>enter_exit</c> both end in
/// <see cref="ExecutionManager.CompleteTravelAfterWarp"/> and both were tile-exact before this unit.
/// </para>
/// </summary>
[Collection(HeadlessGameWorld.Collection)]
public sealed class WarpArrivalPostconditionTests
{
    private const string MovementActionsFile = "integrations/stardew/farmhandexecutioncontroller.movementactions.cs";

    /// <summary>The declared tile is the map asset's; the engine lands elsewhere; the arrival is the arrival.</summary>
    [Theory]
    [InlineData("travel", "travel_completed")]
    [InlineData("enter_exit", "enter_exit_completed")]
    public void AWarpPostconditionNamesWhereTheEngineLands(string site, string completedCode)
    {
        using var world = World.Create();
        world.AddWarp(4, 5, "Farm", 79, 17);
        world.PlaceActorAt(4, 5);

        LocalExecutionReceipt accepted = world.Request(site, 4, 5);
        accepted.State.Should().Be(ExecutionState.Accepted, accepted.Evidence);

        // What `Game1.warpFarmer` does with a Farm entry from BusStop: the Farm map's own `BusStopEntry` (Game1.cs:9864).
        LocalExecutionReceipt settled = world.LandAndSettle("Farm", 78, 17);

        settled.State.Should().Be(ExecutionState.Succeeded, $"the engine's landing IS the arrival ({settled.Evidence})");
        settled.ReasonCode.Should().Be(completedCode, settled.Evidence);
        settled.Evidence.Should().Contain("expected=Farm:79,17", "the receipt still names the tile the map asset declared");
        settled.Evidence.Should().Contain("actual=Farm:78,17", "and the tile the engine actually landed her on");
    }

    /// <summary>
    /// The boundary the case above must not cross: the postcondition is not decorative. A warp that lands the body in
    /// ANOTHER location is not an arrival, and the receipt says so with the mismatch code and both facts.
    /// </summary>
    [Fact]
    public void AWarpThatLandsInAnotherLocationIsNotAnArrival()
    {
        using var world = World.Create();
        world.AddWarp(4, 5, "Farm", 79, 17);
        world.PlaceActorAt(4, 5);

        world.Request("travel", 4, 5).State.Should().Be(ExecutionState.Accepted);
        LocalExecutionReceipt settled = world.LandAndSettle("ProbeBusStop", 78, 17);

        settled.State.Should().Be(ExecutionState.Uncertain);
        settled.ReasonCode.Should().Be("travel_postcondition_mismatch");
        settled.Evidence.Should().Contain("expected=Farm:79,17");
        settled.Evidence.Should().Contain("actual=ProbeBusStop:78,17");
    }

    /// <summary>
    /// The gate over the population: no arm of the arrival postcondition may compare the farmer's tile with the warp's
    /// declared target, because no warp's declared target is a promise the engine keeps. The mine arms are exempt by
    /// construction - a mine level is the location's identity - so the gate reads the method the whole family runs
    /// through and fails on the shape, naming the offending line.
    /// </summary>
    [Fact]
    public void NoArrivalArmComparesTheFarmersTileWithTheDeclaredWarpTarget()
    {
        string[] findings = TileComparisons(MethodBody(ReadRepositoryFile(MovementActionsFile), "public void CompleteTravelAfterWarp("));

        findings.Should().BeEmpty(
            "a declared warp target is rewritten by Game1.warpFarmer before the body moves; a tile-exact arrival "
            + "postcondition refuses arrivals that are arrivals (round68, twice)");
    }

    /// <summary>The falsifier: the shape this gate exists to catch, fed to the same predicate.</summary>
    [Fact]
    public void TheGateIsRedOnTheArmItReplaced()
    {
        string[] before =
        {
            "bool tileMatches = specification.Action switch",
            "{",
            "    \"enter_mine\" => Game1.player.currentLocation is StardewValley.Locations.MineShaft mine",
            "        && mine.mineLevel == int.Parse(specification.TargetLocation.Substring(\"UndergroundMine\".Length)),",
            "    _ => Game1.player.TilePoint.X == specification.TargetX && Game1.player.TilePoint.Y == specification.TargetY,",
            "};",
        };

        TileComparisons(before).Should().ContainSingle()
            .Which.Should().Contain("Game1.player.TilePoint.X == specification.TargetX");
    }

    /// <summary>
    /// Every line of <paramref name="methodBody"/> that makes the farmer's landing tile a postcondition. Comments are
    /// stripped first, so a sentence ABOUT the comparison is never read as the comparison.
    /// </summary>
    private static string[] TileComparisons(IReadOnlyList<string> methodBody) =>
        methodBody
            .Select(DecompiledSource.WithoutComment)
            .Where(line => line.Contains("TilePoint.X == specification.TargetX", StringComparison.Ordinal)
                || line.Contains("TilePoint.Y == specification.TargetY", StringComparison.Ordinal))
            .ToArray();

    private static string[] MethodBody(string[] file, string declaration)
    {
        IReadOnlyList<string> body = DecompiledSource.MethodBody(file, declaration);
        body.Should().NotBeEmpty($"the arrival postcondition must still be declared as '{declaration}'");
        return body.ToArray();
    }

    private static string[] ReadRepositoryFile(string relativePath)
    {
        for (DirectoryInfo? directory = new(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            string candidate = Path.Combine(directory.FullName, relativePath);
            if (File.Exists(candidate))
                return File.ReadAllLines(candidate);
        }

        throw new FileNotFoundException($"{relativePath} is not reachable from {AppContext.BaseDirectory}");
    }

    /// <summary>
    /// A real headless world: one 16x16 <see cref="GameLocation"/>, a real <see cref="Farmer"/>, the Farm the engine
    /// warps into, and the <c>Game1</c> statics both the engine and <c>Context.IsWorldReady</c> dereference. One
    /// <see cref="ExecutionManager"/> owns the request and its settlement, because the travel it accepted is the slot
    /// the postcondition reads.
    /// </summary>
    private sealed class World : IDisposable
    {
        private static readonly FieldInfo WorldReadyPerScreen = typeof(Context)
            .GetProperty("IsWorldReady", BindingFlags.Public | BindingFlags.Static)!
            .GetGetMethod()!
            .Module.ResolveField(BitConverter.ToInt32(typeof(Context)
                .GetProperty("IsWorldReady", BindingFlags.Public | BindingFlags.Static)!
                .GetGetMethod()!.GetMethodBody()!.GetILAsByteArray()!, 1))!;

        private static readonly FieldInfo WarpingField = typeof(Game1)
            .GetField("_isWarping", BindingFlags.NonPublic | BindingFlags.Static)!;

        private static readonly FieldInfo ScreenFadeField = typeof(Game1)
            .GetField("screenFade", BindingFlags.NonPublic | BindingFlags.Static)!;

        private readonly Game1? gameBefore;
        private readonly Farmer? playerBefore;
        private readonly object? worldStateBefore;
        private readonly LocationRequest locationRequestBefore;
        private readonly bool warpingBefore;
        private readonly IList<GameLocation>? locationsBefore;
        private readonly byte multiplayerModeBefore;
        private readonly object? screenFadeBefore;

        private World()
        {
            this.gameBefore = Game1.game1;
            this.playerBefore = Game1.player;
            this.worldStateBefore = typeof(Game1)
                .GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!
                .GetValue(null);
            this.locationRequestBefore = Game1.locationRequest;
            this.warpingBefore = Game1.isWarping;
            this.locationsBefore = Game1.game1?._locations;
            this.multiplayerModeBefore = Game1.multiplayerMode;
            this.screenFadeBefore = ScreenFadeField.GetValue(null);
            this.Location = null!;
            this.Destination = null!;
            this.Executions = null!;
        }

        public GameLocation Location { get; private set; }

        public GameLocation Destination { get; private set; }

        private ExecutionManager Executions { get; set; }

        public static World Create()
        {
            var world = new World();

            Game1.game1 = (Game1)FormatterServices.GetUninitializedObject(typeof(Game1));
            var root = (NetRoot<NetWorldState>)FormatterServices.GetUninitializedObject(typeof(NetRoot<NetWorldState>));
            root.Value = new NetWorldState();
            typeof(Game1)
                .GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!
                .SetValue(null, root);

            var location = new GameLocation();
            var map = new xTile.Map();
            map.AddLayer(new xTile.Layers.Layer("Back", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            map.AddLayer(new xTile.Layers.Layer("Buildings", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            location.map = map;
            SetField(location, "name", new NetString("ProbeBusStop"));
            world.Location = location;

            // The destination the engine warps INTO. A CLIENT-mode game is simulated because `performWarpFarmer` calls
            // `hostSetup()` on the destination only while `IsMasterGame`, and a host's map loading needs real content.
            var destination = new GameLocation();
            var destinationMap = new xTile.Map();
            destinationMap.AddLayer(new xTile.Layers.Layer("Back", destinationMap, new xTile.Dimensions.Size(100, 100), new xTile.Dimensions.Size(64, 64)));
            destination.map = destinationMap;
            SetField(destination, "name", new NetString("Farm"));
            world.Destination = destination;
            Game1.game1!._locations = new List<GameLocation> { destination };
            Game1.multiplayerMode = 1;
            // `performWarpFarmer` ends in `Game1.fadeScreenToBlack()`, which is `screenFade.FadeScreenToBlack()`.
            ScreenFadeField.SetValue(null, new StardewValley.BellsAndWhistles.ScreenFade(() => false, () => { }));

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
            SetField(actor, "netItems", new NetRef<StardewValley.Inventories.Inventory> { Value = new StardewValley.Inventories.Inventory() });
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
            // `Farmer.Halt()` runs on the transition path and dereferences three members whose initializers never ran.
            SetField(actor, "movementDirections", new List<int>());
            SetField(actor, "isSitting", new NetBool(false));
            SetField(actor, "isEmoteAnimating", false);
            SetField(actor, "facingDirection", new StardewValley.Network.NetDirection(2));
            SetField(actor, "previousLocationName", string.Empty);
            actor.position.Set(new Vector2(4 * 64 + 8, 4 * 64));
            actor.currentLocation = location;
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, actor);
            HeadlessGameWorld.RequireBound(actor, location);

            WorldReadyPerScreen.GetValue(null)!.GetType()
                .GetMethod("SetValueForScreen", new[] { typeof(int), typeof(bool) })!
                .Invoke(WorldReadyPerScreen.GetValue(null), new object[] { Context.ScreenId, true });
            Context.IsWorldReady.Should().BeTrue("the headless world must satisfy the readiness gate the body checks");

            var publication = FarmhandCapabilityPublication.Initial(
                new HashSet<string>(StringComparer.Ordinal) { "travel", "enter_exit" });
            world.Executions = new ExecutionManager(new DummyMonitor(), () => publication, executionScope: null);
            return world;
        }

        /// <summary>A warp the way the map asset declares it: a source tile and a trip.</summary>
        public void AddWarp(int x, int y, string target, int targetX, int targetY) =>
            this.Location.warps.Add(new Warp(x, y, target, targetX, targetY, flipFarmer: false));

        public void PlaceActorAt(int x, int y) => Game1.player.position.Set(new Vector2(x * 64 + 8, y * 64));

        /// <summary>The real request path of the site under test.</summary>
        public LocalExecutionReceipt Request(string site, int sourceX, int sourceY)
        {
            this.requestId = $"req_{site}_{sourceX}_{sourceY}";
            long deadline = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000;
            return site switch
            {
                "travel" => this.Executions.RequestLocalTravel(this.requestId, sourceX, sourceY, deadline),
                "enter_exit" => this.Executions.RequestLocalEnterExit(this.requestId, sourceX, sourceY, deadline),
                _ => throw new ArgumentOutOfRangeException(nameof(site), site, "no such transition site"),
            };
        }

        /// <summary>
        /// The engine's landing, handed back to the production postcondition: the body arrives in
        /// <paramref name="locationName"/> on <paramref name="x"/>,<paramref name="y"/>, exactly as
        /// `performWarpFarmer` leaves it, and the Warped edge settles the travel that was accepted for it.
        /// </summary>
        public LocalExecutionReceipt LandAndSettle(string locationName, int x, int y)
        {
            Game1.player.currentLocation = string.Equals(locationName, "Farm", StringComparison.Ordinal)
                ? this.Destination
                : this.Location;
            Game1.player.position.Set(new Vector2(x * 64 + 8, y * 64));
            string landed = Game1.player.currentLocation.NameOrUniqueName;
            landed.Should().Be(locationName, "the fixture must land the body where the case says it does");

            this.Executions.CompleteTravelAfterWarp();
            this.Executions.TryGetReceipt(this.requestId!, out LocalExecutionReceipt receipt);
            return receipt;
        }

        /// <summary>The id of the one request this world accepted, so the settlement is read back the way a caller reads it.</summary>
        private string? requestId;

        public void Dispose()
        {
            WorldReadyPerScreen.GetValue(null)!.GetType().GetMethod("ResetAllScreens")!
                .Invoke(WorldReadyPerScreen.GetValue(null), null);
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!
                .SetValue(null, this.playerBefore);
            typeof(Game1)
                .GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!
                .SetValue(null, this.worldStateBefore);
            Game1.locationRequest = this.locationRequestBefore;
            WarpingField.SetValue(null, this.warpingBefore);
            Game1.multiplayerMode = this.multiplayerModeBefore;
            ScreenFadeField.SetValue(null, this.screenFadeBefore);
            if (Game1.game1 is not null && this.locationsBefore is not null)
                Game1.game1._locations = this.locationsBefore;
            Game1.game1 = this.gameBefore!;
        }

        private static void SetField(object target, string name, object value) =>
            target.GetType()
                .GetField(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(target, value);
    }
}
