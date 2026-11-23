using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
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
        targets.Should().NotBeEmpty("an empty family would make every assertion below agree with itself");
        targets.Select(target => target.BagHay).Should().OnlyContain(
            stack => stack == GivenHayStack,
            "the target id binds the stack the request will be judged against");
        targets.Select(target => target.TargetId).Should().OnlyHaveUniqueItems(
            "two troughs must not publish one identity");
    }

    /// <summary>
    /// `round92` day 2's shape, replayed: three empty troughs beside a pack stack of five Hay. What the row states is the
    /// TROUGH's fact by membership and the ACTOR's by name, and these are the two readings that say so.
    ///
    /// <para>
    /// Measured 2026-11-22 (run `.live-runs/game-ladder/2026-11-22T09-12-45-412Z-multiday_routine`, `tend_the_animals`): the
    /// observation carried three rows `<c>hayStack: 5</c>` at (6,3), (7,3), (8,3) while the pack held `(O)178` x5 in slot 9.
    /// Her thinking read the number as the troughs' ("料槽三个都有 5 干草（已够）… 槽里 hayStack 5 表示已有") and the day
    /// neither fed nor collected. The number was the BAG's, and only the field's name said otherwise.
    /// </para>
    ///
    /// <para>
    /// The first reading moves only the pack: the count follows the pack, so it is the pack's fact. The second fills one
    /// trough and the row for that tile DISAPPEARS - the trough's own hay is not a count this family publishes at all, which
    /// is why no row of it can claim a trough is full.
    /// </para>
    /// </summary>
    [Fact]
    public void TheRowsCountFollowsThePackAndAFilledTroughIsAbsentRatherThanCounted()
    {
        using TroughWorld world = TroughWorld.Create();

        world.PutInPackSlot(9, GivenHayItemId, GivenHayStack);
        IReadOnlyList<BridgeFeedTroughTarget> measured = world.Troughs();
        measured.Should().HaveCount(
            TroughWorld.TroughTiles.Length,
            "the four empty troughs of the house are the rows this world publishes");
        measured.Select(target => target.BagHay).Should().OnlyContain(
            hay => hay == GivenHayStack,
            "the only count on the row is the pack stack the request spends from, not anything the trough holds");

        world.PutInPackSlot(9, GivenHayItemId, 3);
        IReadOnlyList<BridgeFeedTroughTarget> afterThePackShrank = world.Troughs();
        afterThePackShrank.Select(target => target.BagHay).Should().OnlyContain(
            hay => hay == 3,
            "nothing but the pack changed, so a count that did not follow it would be a fact about something else");

        (int X, int Y) filled = TroughWorld.TroughTiles[0];
        world.PutInTrough(filled);
        IReadOnlyList<BridgeFeedTroughTarget> afterOneTroughWasFilled = world.Troughs();
        afterOneTroughWasFilled.Select(target => (target.X, target.Y)).Should().BeEquivalentTo(
            TroughWorld.TroughTiles.Where(tile => tile != filled),
            "a trough that holds hay is absent from the family rather than published with a count: the family's own fact "
                + "about a trough is that it is EMPTY");
    }

    /// <summary>
    /// The row's own field set, in the spelling the companion READS, so the count's name is part of what is checked.
    ///
    /// <para>
    /// No compiler can express "this number is the actor's, not the trough's": both are an `int` on the same row. So the
    /// assertion is taken from the SHIPPED frame writer (`BridgeProtocol.TrySerialize`) rather than from a list of names
    /// here - an attribute or a policy that put `hayStack` back on the wire has to fail this. `round92` day 2 (2026-11-22)
    /// is why the spelling is not cosmetic: three empty troughs published `hayStack: 5` each from the pack, she read it as
    /// five hay in each trough and skipped feeding the day.
    /// </para>
    /// </summary>
    [Fact]
    public void TheOnlyCountOnTheTroughRowIsNamedForTheBagThatHoldsIt()
    {
        var row = new BridgeFeedTroughTarget("feed_trough_0123456789abcdef", Slot: 9, X: 6, Y: 3, BagHay: 5);

        BridgeProtocol.TrySerialize(row, out string json, out string reasonCode).Should().BeTrue(reasonCode);
        using System.Text.Json.JsonDocument document = System.Text.Json.JsonDocument.Parse(json);
        string[] wireNames = document.RootElement.EnumerateObject().Select(property => property.Name).ToArray();

        wireNames.Should().BeEquivalentTo(
            new[] { "targetId", "slot", "x", "y", "bagHay" },
            "a row of `feedTroughTargets` is published only for a trough that holds NOTHING, so the one count it carries "
                + "is the actor's Hay stack in `slot`; named `hayStack`, three empty troughs each read as holding five hay "
                + "and the day's feeding was skipped");
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
            MethodInfo discovery = DiscoveryMembers.Method("DiscoverFeedTroughTargets");
            return (IReadOnlyList<BridgeFeedTroughTarget>)discovery.Invoke(DiscoveryMembers.Target(discovery, this.Executions), new object[] { this.Actor })!;
        }

        internal void PutInPackSlot(int slot, string qualifiedItemId, int stack)
        {
            while (this.Actor.Items.Count <= slot) this.Actor.Items.Add(null!);
            // `new Object()` runs its own field initializers, so `Item.Id`/`Item.Stack`/`Object.bigCraftable` all exist
            // without loading item data; the qualified id composes from `Object.TypeDefinitionId` and the item id, which
            // is exactly the pair the discovery compares.
            this.Actor.Items[slot] = Hay(qualifiedItemId, stack);
        }

        /// <summary>Fill one trough tile with the item the house accepts, which is the world `round92` day 2 did not have.</summary>
        internal void PutInTrough((int X, int Y) tile) =>
            this.House.objects.Add(new Microsoft.Xna.Framework.Vector2(tile.X, tile.Y), Hay(GivenHayItemId, 1));

        private static StardewValley.Object Hay(string qualifiedItemId, int stack)
        {
            var hay = new StardewValley.Object();
            typeof(Item).GetProperty("ItemId", BindingFlags.Instance | BindingFlags.Public)!.SetValue(hay, qualifiedItemId[3..]);
            hay.Stack = stack;
            return hay;
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
