using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Netcode;
using StardewValley;
using StardewValley.Network;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The composition the play-session world depends on: an animal house with troughs PLUS a stack of Hay in the pack
/// leaves `feedTroughTargets` non-empty, and the SAME world without the Hay leaves it empty.
///
/// <para>
/// Measured 2026-11-09: the coop Given gave the world a house and one animal, and `feed_animal` still had no target in
/// every multi-day run because `DiscoverFeedTroughTargets` publishes a trough only for a pack stack of `(O)178`. The
/// two readings below are taken from the same world, so "the hay is what changed the answer" is a fact about this run
/// rather than about two runs that happened to differ.
/// </para>
///
/// <para>
/// The trough tiles are placed by this test, not copied from the shipped map: the map's own `Trough` rows are a
/// measurement of `Maps/Coop` (Back layer, `x=6..9, y=3`), and a copy of them here would be a second spelling that
/// agrees today and drifts tomorrow. What this test protects is the MECHANISM - a Hay-carrying actor standing inside an
/// <see cref="AnimalHouse"/> whose trough tile carries the engine's own `Trough` property - and the item is built from
/// the Given's own constant rather than from a literal repeated here.
/// </para>
/// </summary>
public sealed class FeedTroughTargetCompositionTests
{
    /// <summary>The item id the play-session hay Given installs.</summary>
    private static readonly string GivenHayItemId = (string)typeof(ModEntry)
        .GetField("PlaySessionHayQualifiedItemId", BindingFlags.NonPublic | BindingFlags.Static)!
        .GetRawConstantValue()!;

    /// <summary>The stack size the play-session hay Given installs.</summary>
    private static readonly int GivenHayStack = (int)typeof(ModEntry)
        .GetField("PlaySessionHayStack", BindingFlags.NonPublic | BindingFlags.Static)!
        .GetRawConstantValue()!;

    [Fact]
    public void GivenHayInThePack_IsWhatMakesTheAnimalHousesTroughsTargets()
    {
        using TroughWorld world = TroughWorld.Create();

        world.Troughs().Should().BeEmpty(
            "the discovery requires an owned hay stack, which is the whole reason the play-session world needed the Given");

        world.PutInPackSlot(0, GivenHayItemId, GivenHayStack);
        IReadOnlyList<BridgeFeedTroughTarget> targets = world.Troughs();

        targets.Select(target => (target.X, target.Y)).Should().BeEquivalentTo(
            TroughWorld.TroughTiles,
            "every trough tile of the house is inside the discovery radius of that house's own entry tile");
        targets.Select(target => target.HayStack).Should().OnlyContain(
            stack => stack == GivenHayStack,
            "the target id binds the stack the request will be judged against");
        targets.Select(target => target.TargetId).Should().OnlyHaveUniqueItems(
            "two troughs must not publish one identity");
    }

    /// <summary>
    /// A headless animal house: a real <see cref="AnimalHouse"/> whose map carries the engine's `Trough` tile property,
    /// and a real <see cref="Farmer"/> standing inside it. Nothing else is seeded, because
    /// <c>DiscoverFeedTroughTargets</c> reads nothing else.
    /// </summary>
    private sealed class TroughWorld : IDisposable
    {
        internal static readonly (int X, int Y)[] TroughTiles = { (6, 3), (7, 3), (8, 3), (9, 3) };

        /// <summary>Where the actor stands inside the house: the coop's own entry tile row, three tiles below the troughs.</summary>
        private const int ActorTileX = 6;
        private const int ActorTileY = 6;

        private readonly Farmer? playerBefore;
        private readonly Game1? gameBefore;
        private readonly object? worldStateBefore;

        /// <summary>
        /// Captures the process-wide statics BEFORE the world is built. The capture cannot live in a constructor that
        /// takes the finished world: <see cref="Create"/> installs the <c>Game1</c> singleton and the world-state root
        /// on its way to those arguments, so a snapshot taken afterwards would record this fixture's own writes as the
        /// values to restore - and leave them installed for every later class (measured 2026-11-10: a later fixture
        /// resolved its farmer's <c>currentLocation</c> by name into the stale location this one left behind).
        /// </summary>
        private TroughWorld()
        {
            this.playerBefore = Game1.player;
            this.gameBefore = Game1.game1;
            this.worldStateBefore = typeof(Game1)
                .GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!
                .GetValue(null);
        }

        internal AnimalHouse House { get; private set; } = null!;
        internal Farmer Actor { get; private set; } = null!;
        internal ExecutionManager Executions { get; private set; } = null!;

        internal static TroughWorld Create()
        {
            var world = new TroughWorld();
            // `Character.currentLocation`'s setter runs `NetLocationRef.Set`, which asks `Game1.currentLocation` whether
            // the location is the one being viewed. An uninitialized `Game1` is the shape the rest of this suite's
            // headless worlds use for exactly that read.
            if (Game1.game1 is null) Game1.game1 = Uninitialized<Game1>();
            // `NetPosition.Get` asks `Game1.HostPaused`, which reads the world state root's `paused` flag; a null root
            // is not "not paused", it is a NullReferenceException from inside the engine's own position read.
            var worldState = (NetRoot<NetWorldState>)FormatterServices.GetUninitializedObject(typeof(NetRoot<NetWorldState>));
            worldState.Value = new NetWorldState();
            typeof(Game1).GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!.SetValue(null, worldState);
            var house = new AnimalHouse();
            SetInstanceField(house, "name", new NetString("TroughProbe"));
            house.map = TroughMap();
            // No animal here on purpose: `DiscoverFeedTroughTargets` reads the actor's pack and the location's trough
            // tiles, not the house's occupancy, so an animal would be a second fact this test cannot make true without
            // game content. `feed_animal` is the trough half of `tend_the_animals`; the animal half is what the coop
            // Given's own log reports.

            Farmer actor = Uninitialized<Farmer>();
            SetInstanceField(actor, "position", new NetPosition());
            SetInstanceField(actor, "currentLocationRef", new NetLocationRef());
            // `Character.Tile` is the standing pixel, and `Farmer.GetBoundingBox` reads the mount and the sprite size on
            // the way there. Both are plain NetFields a real farmer always carries.
            SetInstanceField(actor, "netMount", new NetRef<StardewValley.Characters.Horse>());
            var sprite = Uninitialized<FarmerSprite>();
            SetInstanceField(sprite, "spriteWidth", new NetInt(16));
            SetInstanceField(sprite, "spriteHeight", new NetInt(32));
            SetInstanceField(sprite, "tempSpriteHeight", -1);
            SetInstanceField(actor, "sprite", new NetRef<AnimatedSprite> { Value = sprite });
            SetInstanceField(actor, "netItems", new NetRef<StardewValley.Inventories.Inventory>
            {
                Value = new StardewValley.Inventories.Inventory(),
            });
            actor.position.Set(new Microsoft.Xna.Framework.Vector2(ActorTileX * 64 + 8, ActorTileY * 64));
            actor.currentLocation = house;

            var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "feed_animal" });
            world.House = house;
            world.Actor = actor;
            world.Executions = new ExecutionManager(new DummyMonitor(), () => publication);
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, actor);
            return world;
        }

        internal IReadOnlyList<BridgeFeedTroughTarget> Troughs()
        {
            MethodInfo discovery = typeof(ExecutionManager).GetMethod(
                "DiscoverFeedTroughTargets",
                BindingFlags.Instance | BindingFlags.NonPublic)!;
            return (IReadOnlyList<BridgeFeedTroughTarget>)discovery.Invoke(this.Executions, new object[] { this.Actor })!;
        }

        internal void PutInPackSlot(int slot, string qualifiedItemId, int stack)
        {
            while (this.Actor.Items.Count <= slot) this.Actor.Items.Add(null!);
            // `new Object()` runs its own field initializers, so `Item.Id`/`Item.Stack`/`Object.bigCraftable` all exist
            // without loading item data; the qualified id composes from `Object.TypeDefinitionId` and the item id, which
            // is exactly the pair the discovery compares.
            var hay = new StardewValley.Object();
            typeof(Item).GetProperty("ItemId", BindingFlags.Instance | BindingFlags.Public)!.SetValue(hay, qualifiedItemId[3..]);
            hay.Stack = stack;
            this.Actor.Items[slot] = hay;
        }

        public void Dispose()
        {
            Game1.game1 = this.gameBefore;
            typeof(Game1).GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!.SetValue(null, this.worldStateBefore);
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, this.playerBefore);
        }

        /// <summary>
        /// A 12x12 map whose Back layer carries four tiles with the engine's own `Trough` property, built the way a real
        /// map holds them: a `StaticTile` on a tilesheet bound to the map, with the property on the tile.
        /// </summary>
        private static xTile.Map TroughMap()
        {
            var map = new xTile.Map();
            foreach (string layer in new[] { "Back", "Buildings", "Front" })
                map.AddLayer(new xTile.Layers.Layer(layer, map, new xTile.Dimensions.Size(12, 12), new xTile.Dimensions.Size(64, 64)));
            var sheet = new xTile.Tiles.TileSheet(
                "probe", map, "Maps/probe", new xTile.Dimensions.Size(64, 64), new xTile.Dimensions.Size(16, 16));
            map.AddTileSheet(sheet);
            xTile.Layers.Layer back = map.GetLayer("Back");
            foreach ((int x, int y) in TroughTiles)
            {
                back.Tiles[x, y] = new xTile.Tiles.StaticTile(back, sheet, xTile.Tiles.BlendMode.Alpha, 0);
                back.Tiles[x, y].Properties["Trough"] = "T";
            }
            return map;
        }

        private static T Uninitialized<T>() where T : class =>
            (T)FormatterServices.GetUninitializedObject(typeof(T));

        private static void SetInstanceField(object target, string name, object value)
        {
            for (Type? type = target.GetType(); type is not null; type = type.BaseType)
            {
                FieldInfo? field = type.GetField(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
                if (field is null) continue;
                field.SetValue(target, value);
                return;
            }
            throw new InvalidOperationException($"probe_field_missing:{target.GetType().Name}.{name}");
        }
    }
}
