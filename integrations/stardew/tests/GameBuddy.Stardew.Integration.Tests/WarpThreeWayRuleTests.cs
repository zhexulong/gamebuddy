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
/// The warp three-way rule, design §3.1.1 (「室内出口传送毯禁区规则」) and §4.2 Fixture 5.
///
/// <para>
/// A tile the location's warp table holds is not simply forbidden. The spec splits it three ways and says
/// why the split exists: a blanket ban would contradict §3.2.1's 「谓词绝对同源」 (one shared predicate with
/// the native planner) and would cut every doorway out of the map, because the native
/// <c>PathFindController</c> crosses these tiles and its own door/warp branches handle them
/// (<c>PathFindController.cs:320</c> then <c>:341</c>/<c>:349</c>). The four facts:
/// </para>
/// <list type="bullet">
/// <item>a FINAL standing tile: forbidden - <c>Farmer.MovePositionImpl</c> calls
/// <c>isCollidingWithWarp</c> on the body's next rectangle every step (<c>Farmer.cs:8586</c>), so a body that
/// reaches one is warped mid-step instead of arriving;</item>
/// <item>a STEP-OUT buffer candidate: forbidden, for the same reason - the heel back would be the step;</item>
/// <item>a PASS-THROUGH tile: allowed, decided by the native predicates;</item>
/// <item>an <c>enter_exit</c> TARGET: allowed, and the only way out of an interior.</item>
/// </list>
///
/// <para>
/// Both halves are pinned in this one file on purpose. A ban pinned alone is satisfiable by an
/// over-correction that makes warp tiles impassable; a permission pinned alone is satisfiable by the
/// under-correction that lets a step-out teleport the companion. Neither assertion can stand for the other.
/// </para>
///
/// <para>
/// The ban and the permission are read from the real engine on a real <see cref="GameLocation"/> with a real
/// <see cref="Warp"/> and a real <c>Farmer</c> bounding box, so the numbers here are the engine's own. Which
/// predicate each half is wired to is pinned as source, because the wiring is what a wrong implementation
/// gets wrong.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the pins here assert on repository source text because the native seam they cover cannot load in a headless runner, while the rest of the class constructs and calls product code for real; keeping both in one file keeps each pin beside the behaviour it protects.
public sealed class WarpThreeWayRuleTests
{
    private const string MovementActions = "integrations/stardew/farmhandexecutioncontroller.movementactions.cs";
    private const string ResourceToolActions = "integrations/stardew/farmhandexecutioncontroller.resourcetoolactions.cs";
    private const string BodyController = "integrations/stardew/StardewBodyController.cs";

    // ---- the fact the other three are decided against ---------------------------------------

    [Fact]
    public void TheLocationsOwnWarpTableAnswersWhetherATileWarpsTheBody()
    {
        using WarpHarness harness = WarpHarness.Create();

        harness.AddWarp(4, 5, "Farm", 64, 15, npcOnly: false);

        ExecutionManager.IsWarpBufferTile(harness.Location, (4, 5))
            .Should().BeTrue("the location's warp table holds this tile, so a body reaching it is warped mid-step");

        ExecutionManager.IsWarpBufferTile(harness.Location, (9, 9))
            .Should().BeFalse("a tile with no warp entry is an ordinary tile");

        // An NPC-only warp does not move the companion, so it is not a buffer. If this answered true the
        // companion would refuse to stand on tiles that are, for it, ordinary ground.
        harness.AddWarp(6, 5, "Farm", 64, 15, npcOnly: true);
        ExecutionManager.IsWarpBufferTile(harness.Location, (6, 5))
            .Should().BeFalse("an NPC-only warp does not move the farmer standing on it");
    }

    // ---- half 1: PASS-THROUGH is allowed, and that is what a one-way ban breaks ---------------
    [Fact]
    public void AWarpTileStaysCrossableForTheWalkAndForTheStandabilityTheEngineOwns()
    {
        // The falsifier for the over-correction the spec warns about. `IsWalkableTile` is the traversal
        // reading, and it must NOT consult the warp table: the native planner steps onto these tiles
        // (`PathFindController.cs:222` asks `isCollidingPosition(..., pathfinding: true)`, which never reads
        // `location.warps`). An A* that read warp tiles as impassable would cut every doorway off the map and
        // would also strand `enter_exit`, whose own approach tile is beside one of these.
        using WarpHarness harness = WarpHarness.Create();
        harness.AddWarp(4, 5, "Farm", 64, 15, npcOnly: false);
        Vector2 warpTile = new(4f, 5f);

        StardewBodyController.IsWalkableTile(harness.Location, harness.Actor, warpTile)
            .Should().BeTrue("the native planner crosses warp tiles; refusing them here would wall off every doorway");

        // The engine-level standability is the same answer for the same reason: standing among these tiles is
        // the engine's business, and the engine's own occupant test does not consider the warp table.
        StardewBodyController.IsStandableTile(harness.Location, harness.Actor, warpTile)
            .Should().BeTrue("nothing in the engine's occupant reading knows about warps");

        // The ban therefore exists in exactly ONE place, one level up: the predicate that chooses where to STOP.
        // If the ban ever moved down into either reading above, this pin would still hold while the map's
        // doorways silently closed - which is why the ban and the permission are asserted apart.
        MethodBody(Read(BodyController), "internal static bool IsWalkableTile(")
            .Should().NotContain("Warp", "the traversal reading must not consult the warp table");
        MethodBody(Read(BodyController), "internal static bool IsStandableTile(")
            .Should().NotContain("Warp", "and neither may the engine-level standability it composes");
        MethodBody(Read(ResourceToolActions), "(int X, int Y) anchor,")
            .Should().Contain("&& !IsWarpBufferTile(location, tile)",
                "the ban lives in the approach's own standability, applied after the engine's reading");
    }

    // ---- half 2: forbidden as a STEP-OUT / stop candidate ------------------------------------

    [Fact]
    public void AStepOutBesideAFarmhouseEntranceNeverChoosesTheWarpTile()
    {
        // Fixture 5, the standing half: an interaction micro-adjustment next to the interior exit must not
        // put the body's heel on the exit blanket. The two primitives are EXECUTED against the real engine; the
        // composition of them is the production closure's own two clauses, which cannot be reached from here
        // because it closes over `Game1.player` - so the composition is pinned as source below instead, and the
        // pin names both halves. Executing the primitives and pinning their conjunction is the whole available
        // check; a predicate invented only in this file would prove nothing about the shipped one.
        using WarpHarness harness = WarpHarness.Create();
        (int X, int Y) actor = ((int)harness.Actor.Tile.X, (int)harness.Actor.Tile.Y);
        (int X, int Y) entrance = (actor.X - 1, actor.Y);

        harness.AddWarp(entrance.X, entrance.Y, "Farm", 64, 15, npcOnly: false);

        Func<(int X, int Y), bool> stopCandidate = tile =>
            StardewBodyController.IsStandableTile(harness.Location, harness.Actor, new Vector2(tile.X, tile.Y))
            && !ExecutionManager.IsWarpBufferTile(harness.Location, tile);

        stopCandidate(entrance).Should().BeFalse(
            "the warp tile is a standing candidate the rule removes");

        // The actor stands ON the target, so this is the hollow-ring step-out: every ring tile is a candidate.
        // The declared order tries (X-1, Y) first - the warp tile - so a selector that admitted it would return
        // it, and the companion would be teleported out of the house instead of stepping half a tile.
        (int X, int Y)? chosen = ExecutionManager.SelectToolApproachTile(
            (actor.X, actor.Y), actor, stopCandidate, _ => true);

        chosen.Should().NotBeNull("the other ring tiles are free, so a step-out exists");
        chosen.Should().NotBe(entrance, "a step-out that lands on the exit blanket teleports the companion");
        chosen.Should().Be((actor.X + 1, actor.Y), "the next declared candidate wins once the warp tile is excluded");

        // And the conjunction above IS the production closure: same two calls, same order, joined by `&&`.
        string approach = MethodBody(Read(ResourceToolActions), "(int X, int Y) anchor,");
        approach.Should().Contain(
                "StardewBodyController.IsStandableTile(location, Game1.player, new Vector2(tile.X, tile.Y))\n            && !IsWarpBufferTile(location, tile);",
            "the stop-candidate the selector consumes is exactly these two clauses, in this order");
    }

    [Fact]
    public void AMoveToAWarpTileStopsBesideItRatherThanOnIt()
    {
        // The same rule on the other path that can end a walk on a tile: `move_to_tile`'s NAMED destination.
        // Its resolution is an adjacent arrival, so a warp destination is approached and not stood on. The named
        // destination stays a legal walk target (that is the cross-map intent); only the substitute is filtered.
        string move = MethodBody(Read(MovementActions), "public LocalExecutionReceipt RequestLocalMove(");

        SliceBetween(move, "bool nativeWarpTarget =", ";")
            .Should().Contain("warps.Any(warp => !warp.npcOnly.Value",
                "the warp destination is read from the location's own table, as the engine will");
        SliceBetween(move, "bool adjacentArrival =", ";")
            .Should().Contain("nativeWarpTarget",
                "a warp destination is met from a neighbouring tile, so nothing stops on the blanket");
    }

    /// <summary>
    /// The OTHER path that can end a walk on a tile: the move_to_tile substitution.
    ///
    /// <para>
    /// <c>move_to_tile</c> substitutes a standable neighbour when the named tile cannot be walked onto. That
    /// neighbour becomes the FINAL standing tile, so it is a stop candidate like any other - but its predicate is
    /// <c>IsWalkableTile</c>, the traversal reading, which by design admits warp tiles (that is the pass-through
    /// half above). The two facts therefore meet here: the substitution's candidate set is the one place where
    /// "the planner may cross this" and "the body may stop here" are different questions, and a walk that ends on
    /// the exit blanket warps the companion out of the house instead of stopping beside it.
    /// </para>
    /// <para>
    /// The two halves must be checked together, which is why both are in one case: the traversal reading admits
    /// the warp tile (correct), and the stop rule then removes it from the candidate set (also correct). Pinning
    /// only the second half would be satisfiable by making warp tiles unwalkable, which is the over-correction
    /// the pass-through case above exists to catch.
    /// </para>
    /// </summary>
    [Fact]
    public void AMoveSubstitutionNeverStopsOnAWarpTile()
    {
        using WarpHarness harness = WarpHarness.Create();
        harness.Location.resourceClumps.Add(
            new StardewValley.TerrainFeatures.ResourceClump(148, 2, 2, new Vector2(9f, 9f)));
        harness.AddWarp(8, 8, "Farm", 64, 15, npcOnly: false);

        // The substitution's traversal half, executed: the planner DOES cross the warp tile. That is the
        // pass-through half above, not a defect - and it is exactly why "walkable" cannot be the whole stop rule.
        StardewBodyController.IsWalkableTile(harness.Location, harness.Actor, new Vector2(8f, 8f))
            .Should().BeTrue("crossing is legal");

        // The stop rule, executed on the same tile. These two answers disagreeing about one tile is the rule
        // working, not a contradiction.
        ExecutionManager.IsWarpBufferTile(harness.Location, (8, 8))
            .Should().BeTrue("a body that ENDS its walk here is warped out of the house");

        // The production stop-candidate composition, spelled in the test because the shipped closure closes over
        // `Game1.player` and cannot be extracted. The source pin below holds it to these two clauses.
        Func<Vector2, bool> stopCandidate = candidate =>
            StardewBodyController.IsWalkableTile(harness.Location, harness.Actor, candidate)
            && !ExecutionManager.IsWarpBufferTile(harness.Location, ((int)candidate.X, (int)candidate.Y));

        Vector2? chosen = ExecutionManager.SelectStandingApproachTile(
            new Vector2(9f, 9f), harness.Actor.Tile, stopCandidate, _ => true);

        chosen.Should().NotBeNull("the ring has free tiles, so an approach exists");
        chosen.Should().NotBe(new Vector2(8f, 8f),
            "a substitution that stops on the exit blanket warps the companion out of the house");

        // And the shipped closure IS that composition: both clauses, on the candidate, inside the substitution.
        string move = MethodBody(Read(MovementActions), "public LocalExecutionReceipt RequestLocalMove(");
        string substitution = SliceBetween(move, "Vector2? approach = SelectStandingApproachTile(", "if (approach is not null)");
        substitution.Should().Contain("IsWalkableTile(Game1.player.currentLocation, Game1.player, candidate)",
            "the substitution keeps the planner's own traversal reading");
        substitution.Should().Contain("&& !IsWarpBufferTile(Game1.player.currentLocation, ((int)candidate.X, (int)candidate.Y))",
            "joined to the one stop rule, on the CANDIDATE - not on the named destination");

        // The named destination is deliberately untouched: a warp tile AS the destination is a cross-map intent
        // and stays a legal walk target. Only the tile the walk ENDS on is filtered.
        SliceBetween(move, "bool nativeWarpTarget =", ";")
            .Should().Contain("warps.Any(warp => !warp.npcOnly.Value",
                "a warp destination is still read from the location's own table");
    }

    // ---- half 3: allowed as an enter_exit target ---------------------------------------------

    [Fact]
    public void EnterExitStillResolvesAndTargetsAWarpTile()
    {
        // Fixture 5, the permission half - the one an over-correction breaks. The interior exit is a warp
        // tile, so the transition must still resolve it. Both resolution sources the production path reads are
        // exercised on the real location: the native door resolver, and the location's own warp table, which
        // is the source the farmhouse/cabin exit (and `travel`) depends on.
        using WarpHarness harness = WarpHarness.Create();
        harness.AddWarp(3, 11, "Farm", 64, 15, npcOnly: false);

        Warp? fromTable = harness.Location.warps.FirstOrDefault(
            candidate => !candidate.npcOnly.Value && candidate.X == 3 && candidate.Y == 11);

        fromTable.Should().NotBeNull("the exit blanket is in the location's warp table");
        fromTable!.TargetName.Should().Be("Farm", "and it carries the transition the door resolves to");

        ExecutionManager.IsWarpBufferTile(harness.Location, (3, 11))
            .Should().BeTrue("it is simultaneously a buffer - the ban and the permission are about one tile");

        // And the transition path itself must not consult the ban. This is the assertion the falsifier breaks:
        // a warp exclusion added to the door/travel branch would refuse the only way out of an interior.
        string transition = MethodBody(Read(MovementActions), "private LocalExecutionReceipt RequestLocalDoorTransition(");
        transition.Should().NotContain("IsWarpBufferTile",
            "enter_exit targets a warp tile by definition; excluding it here would seal the companion indoors");
        transition.Should().Contain("location.warps.FirstOrDefault(",
            "the travel branch resolves the transition from the warp table that holds the exit tile");
    }

    // ---- the four facts are the same tile, so they cannot drift apart -------------------------

    [Fact]
    public void TheBanIsTheOnlyWarpReadingOnTheStopPath()
    {
        // One spelling of "may I stop here". A second call site would be a second opinion about which tiles the
        // world may route through, which is the §3.2.1 predicate-divergence the spec refuses. A stop-candidate
        // predicate added later must read this same definition rather than restate the warp test.
        int references = CountOccurrences(Read(MovementActions), "IsWarpBufferTile(")
            + CountOccurrences(Read(ResourceToolActions), "IsWarpBufferTile(");

        references.Should().Be(3,
            "one definition plus two STOP paths: the approach's stop candidate and the move substitution's candidate "
            + "(both answer 'may the body END here'; neither is the traversal reading)");
    }

    // -------------------------------------------------------------------------

    private static string Read(string relative) => File.ReadAllText(RepositorySourcePath(relative));

    /// <summary>The source from <paramref name="start"/> up to (excluding) the next <paramref name="end"/>.</summary>
    private static string SliceBetween(string source, string start, string end)
    {
        int from = source.IndexOf(start, StringComparison.Ordinal);
        from.Should().BeGreaterThanOrEqualTo(0, $"{start} must exist");
        int to = source.IndexOf(end, from + start.Length, StringComparison.Ordinal);
        to.Should().BeGreaterThan(from, $"{end} must follow {start}");
        return source[from..to];
    }

    /// <summary>
    /// The source of one method, from its opening brace to its matching close.
    /// </summary>
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

    private static int CountOccurrences(string haystack, string needle)
    {
        int count = 0;
        int index = -1;
        while ((index = haystack.IndexOf(needle, index + 1, StringComparison.Ordinal)) >= 0) count++;
        return count;
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
    /// A real interior-sized <see cref="GameLocation"/> with the two layers the engine's collision test reads,
    /// a real <c>Farmer</c> with its 48x32 bounding box, and — the addition this file needs — a live warp table
    /// the rule is asked about.
    ///
    /// <para>
    /// The <c>Game1</c> statics are seeded and restored because both readings dereference them: the collision
    /// test reads <c>Game1.viewport</c> and <c>Game1.player</c>, and <c>Farmer.GetBoundingBox</c> reads
    /// <c>netMount</c>. The assembly runs without parallelization (AssemblyInfo.cs), so restoring on dispose is
    /// sufficient.
    /// </para>
    /// </summary>
    private sealed class WarpHarness : IDisposable
    {
        private readonly Game1? gameBefore;
        private readonly Farmer? playerBefore;
        private readonly object? worldStateBefore;

        private WarpHarness()
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

        public static WarpHarness Create()
        {
            var harness = new WarpHarness();

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
            // The engine's own placement from `performWarpFarmer` (Game1.cs:10063) for a 32px-tall sprite:
            // the bounding box then centres on the tile, so `StandingPixel` reads tile * 64 + 32 on both axes.
            actor.position.Set(new Vector2(5 * 64, 5 * 64 + 16));
            actor.currentLocation = location;
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, actor);

            harness.Location = location;
            harness.Actor = actor;
            return harness;
        }

        /// <summary>Adds a warp the way the map's own <c>Warps</c> property does: a source tile and a trip.</summary>
        public void AddWarp(int x, int y, string target, int targetX, int targetY, bool npcOnly) =>
            this.Location.warps.Add(new Warp(x, y, target, targetX, targetY, flipFarmer: false, npcOnly: npcOnly));

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
