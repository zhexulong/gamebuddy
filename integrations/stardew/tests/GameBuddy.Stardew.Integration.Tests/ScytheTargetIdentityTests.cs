using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Runtime.Serialization;
using System.Text.RegularExpressions;
using FluentAssertions;
using Microsoft.Xna.Framework;
using Netcode;
using StardewValley;
using StardewValley.Network;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A target id names the target; the counter a scythe spends is state, and state belongs to the precondition.
///
/// <para>
/// THE DEFECT THIS FILE EXISTS FOR. `weedTargets` and `grassTargets` published an id that hashed the object's own
/// remaining durability - `weed.MinutesUntilReady` and `grass.numberOfWeeds.Value` - and those are the two values the
/// scythe exists to spend. The product says so itself in three places: `ExecuteCutWeeds` documents "a common weed (O)313
/// carries 2 health and the basic scythe (W)47 deals exactly 1 damage per native swing"
/// (`farmhandexecutioncontroller.resourcetoolactions.cs:1561-1567`); `ExecuteCutGrass` documents "a grass tuft usually
/// holds 4 weeds; each native swing deducts 1 (basic scythe (W)47), 2 ((W)53) or 4 ((W)66)"
/// (`:1271-1276`); and `MeleeSweepOccupancy` records both counters on either side of one real `MeleeWeapon.DoDamage`
/// call precisely because "a weed at 2 that took 1 damage is still `weed`"
/// (`farmhandexecutioncontroller.cs:6088-6090`, `:6194-6199`).
/// </para>
/// <para>
/// SO THE SECOND HIT IS REFUSED. Both `RequestLocalCutWeeds`/`ExecuteCutWeeds` and
/// `RequestLocalCutGrass`/`ExecuteCutGrass` re-derive the id and refuse `weed_target_changed` / `grass_target_changed` on
/// a mismatch (`resourcetoolactions.cs:1182`, `:1225`, `:1265`, `:1556`). Any `expectedTargetId` read from an
/// observation taken before the object lost one point - by a `sweep_scythe` whose arc reached it and left it standing, or
/// by the player's own scythe - is therefore refused on the target it names. `rockSourceTargets` and
/// `treeChopSourceTargets` carry the identical repair and its reasoning (`farmhandexecutioncontroller.cs:3597-3602`,
/// `:3022-3032`); these two families were left behind.
/// </para>
/// <para>
/// THE STATE STAYS VISIBLE. Both rows already publish the counter as a FIELD (`BridgeWeedTarget.Health`,
/// `BridgeGrassTarget.NumberOfWeeds`), exactly as `BridgeRockSourceTarget.Health` does, so nothing is lost by taking it
/// out of the hash: it is published where a reader can compare it, and it is read where it belongs - by the swing loop
/// that records it before and after each hit.
/// </para>
/// </summary>
public sealed class ScytheTargetIdentityTests
{
    /// <summary>
    /// The one builder this change does not repair, and what would unblock it.
    ///
    /// <para>
    /// An exemption is a CLAIM THAT EXPIRES, so the gate asserts it is still needed: the day `BuildCaskTargetId` stops
    /// hashing the counter, the entry matches no offender and the gate goes red asking for it to be deleted. That is the
    /// difference between a declared exception and an exception nobody can ever close.
    /// </para>
    /// </summary>
    private static readonly (string Builder, string Field, string Why)[] DeclaredNotFixed =
    {
        (
            "BuildCaskTargetId",
            "MinutesUntilReady",
            "`BridgeCaskTarget` publishes no field for the value, so removing it from the hash would make it unobservable "
                + "- the repair needs a wire field on the row, which is outside this change"),
    };

    /// <summary>
    /// A weed that has lost one point of health is the same weed.
    ///
    /// The value is the engine's own arithmetic on a common weed (`(O)313`): it stands at 2, each basic-scythe swing
    /// takes 1 (`resourcetoolactions.cs:1561-1567`), and it is removed only when the native action reports the cut - so 1
    /// is still the weed the caller named.
    /// </summary>
    [Fact]
    public void AWeedThatLostOnePointOfHealthIsTheSameWeed()
    {
        using var world = ScytheWorld.Create();
        StardewValley.Object weed = world.PlaceWeed(x: 10, y: 10, health: 2);

        string observed = ExecutionManager.BuildWeedTargetId(world.Farm, 10, 10, weed);

        weed.MinutesUntilReady = 1;
        ExecutionManager.BuildWeedTargetId(world.Farm, 10, 10, weed)
            .Should().Be(
                observed,
                "a weed that has been hit once is the SAME weed: hashing the remaining health refused the second swing "
                    + "with `weed_target_changed` on a weed the first swing left standing");
    }

    /// <summary>
    /// The same case on the grass tuft, whose counter the scythe also decrements per swing (`:1271-1276`). The whole
    /// sequence is walked, not just the first step, because a tuft stands at every count above zero.
    /// </summary>
    [Fact]
    public void ATuftThatLostOneWeedIsTheSameTuft()
    {
        using var world = ScytheWorld.Create();
        StardewValley.TerrainFeatures.Grass tuft = world.PlaceGrass(x: 4, y: 5, grassType: 1, weeds: 4);

        string observed = ExecutionManager.BuildGrassTargetId(world.Farm, 4, 5, tuft);

        for (int weeds = 3; weeds >= 1; weeds--)
        {
            tuft.numberOfWeeds.Value = weeds;
            ExecutionManager.BuildGrassTargetId(world.Farm, 4, 5, tuft)
                .Should().Be(
                    observed,
                    "a tuft at {0} weed(s) is the tuft the caller named at 4: the count is what `cut_grass` spends, "
                        + "and hashing it refused every swing after the first",
                    weeds);
        }
    }

    /// <summary>
    /// The id still binds what makes the target THAT target: the species, the tile, the location. Without this the repair
    /// above would be satisfiable by hashing the tile alone, and a different plant standing there would answer to the
    /// caller's id.
    /// </summary>
    [Fact]
    public void TheIdStillBindsTheSpeciesTheTileAndTheLocation()
    {
        using var world = ScytheWorld.Create();
        StardewValley.TerrainFeatures.Grass blue = world.PlaceGrass(x: 4, y: 5, grassType: 1, weeds: 4);
        string blueId = ExecutionManager.BuildGrassTargetId(world.Farm, 4, 5, blue);

        StardewValley.TerrainFeatures.Grass other = world.PlaceGrass(x: 4, y: 5, grassType: 6, weeds: 4);
        ExecutionManager.BuildGrassTargetId(world.Farm, 4, 5, other)
            .Should().NotBe(blueId, "a different grass type standing on the tile is not the tuft the caller asked for");

        StardewValley.TerrainFeatures.Grass neighbour = world.PlaceGrass(x: 5, y: 5, grassType: 1, weeds: 4);
        ExecutionManager.BuildGrassTargetId(world.Farm, 5, 5, neighbour)
            .Should().NotBe(blueId, "a tuft on the next tile is a different tuft");
        ExecutionManager.BuildGrassTargetId(world.OtherFarm, 4, 5, blue)
            .Should().NotBe(blueId, "the same tile in another location is another tuft");

        StardewValley.Object weed = world.PlaceWeed(x: 10, y: 10, health: 2);
        string weedId = ExecutionManager.BuildWeedTargetId(world.Farm, 10, 10, weed);
        ExecutionManager.BuildWeedTargetId(world.Farm, 11, 10, world.PlaceWeed(x: 11, y: 10, health: 2))
            .Should().NotBe(weedId, "a weed on the next tile is a different weed");
        ExecutionManager.BuildWeedTargetId(world.OtherFarm, 10, 10, weed)
            .Should().NotBe(weedId, "the same tile in another location is another weed");
    }

    /// <summary>
    /// THE GATE, over the whole id layer rather than these two families: every target id builder in the Mod's source is
    /// scanned for a field a tool swing decrements.
    ///
    /// <para>
    /// THE POPULATION IS THE SOURCE TREE, not a list: every `Build*TargetId` definition found under
    /// `integrations/stardew/` is examined, so a builder added tomorrow is covered without an edit here. The forbidden
    /// fields are the three counters the engine decrements in place on the object being hit - `health` (a tree's
    /// durability, `Tree.performToolAction`), `MinutesUntilReady` (a rock's remaining hits and a weed's health) and
    /// `numberOfWeeds` (a tuft's count) - and each carries the reason it is state rather than identity.
    /// </para>
    /// <para>
    /// IT FIRES ON REAL HISTORY. Commit `611cbdb3` shipped
    /// <c>raw = $"{location.NameOrUniqueName}:{x},{y}:{rock.QualifiedItemId}:{rock.MinutesUntilReady}"</c>, which is the
    /// `rock_target_changed` incident the current builder's remarks record
    /// (`farmhandexecutioncontroller.cs:3597-3602`). The same scan over that revision's file names
    /// `BuildRockSourceTargetId` and `MinutesUntilReady`.
    /// </para>
    /// </summary>
    [Fact]
    public void NoTargetIdHashesTheDurabilityItsOwnActionSpends()
    {
        var offenders = new List<(string Builder, string Field, string Where)>();
        int examined = 0;

        foreach (string path in TargetIdentitySource.Files())
            foreach (TargetIdentitySource.Builder builder in TargetIdentitySource.Builders(System.IO.File.ReadAllText(path)))
            {
                examined += 1;
                foreach ((string field, string reason) in TargetIdentitySource.DurabilityFields)
                    if (builder.Body.Contains(field, StringComparison.Ordinal))
                        offenders.Add((builder.Name, field, $"{System.IO.Path.GetFileName(path)}: {builder.Name} hashes `{field}` - {reason}"));
            }

        examined.Should().BeGreaterThan(
            20,
            "the population is every `Build*TargetId` definition in the source tree; a smaller number means the scan "
                + "stopped reading and would pass by examining nothing");

        var unexempt = offenders
            .Where(offender => !DeclaredNotFixed.Any(exempt => exempt.Builder == offender.Builder && exempt.Field == offender.Field))
            .Select(offender => offender.Where)
            .ToList();
        unexempt.Should().BeEmpty(
            "a target id names the target and a counter is what the action spends: {0}",
            string.Join("; ", unexempt));

        // THE EXEMPTIONS EXPIRE. An entry that no longer matches an offender is a stale claim: the builder was fixed and
        // the entry has to go, or the next reader believes the defect is still there.
        var stale = DeclaredNotFixed
            .Where(exempt => !offenders.Any(offender => offender.Builder == exempt.Builder && offender.Field == exempt.Field))
            .Select(exempt => $"{exempt.Builder} no longer hashes `{exempt.Field}` - delete this exemption")
            .ToList();
        stale.Should().BeEmpty("{0}", string.Join("; ", stale));
    }

    /// <summary>
    /// A headless farm holding one weed and one tuft, following <c>TreeChopSourceIdentityTests.TreeWorld</c>: an
    /// uninitialized `Game1`, the `netWorldState` root the engine's NetFields read, a map so `GameLocation` has its
    /// layers, and `Game1.random` for the constructors that draw from it.
    /// </summary>
    private sealed class ScytheWorld : IDisposable
    {
        private readonly Game1? gameBefore;
        private readonly object? worldStateBefore;
        private readonly Random? randomBefore;

        private ScytheWorld()
        {
            this.gameBefore = Game1.game1;
            this.worldStateBefore = typeof(Game1).GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!.GetValue(null);
            this.randomBefore = Game1.random;
        }

        internal GameLocation Farm { get; private set; } = null!;

        internal GameLocation OtherFarm { get; private set; } = null!;

        internal static ScytheWorld Create()
        {
            var world = new ScytheWorld();

            if (Game1.game1 is null)
                Game1.game1 = (Game1)FormatterServices.GetUninitializedObject(typeof(Game1));
            var root = (NetRoot<NetWorldState>)FormatterServices.GetUninitializedObject(typeof(NetRoot<NetWorldState>));
            root.Value = new NetWorldState();
            typeof(Game1).GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!.SetValue(null, root);
            Game1.random ??= new Random(1);

            world.Farm = Location("ProbeFarm");
            world.OtherFarm = Location("ProbeGreenhouse");
            return world;
        }

        /// <summary>
        /// A common weed (`(O)313`) at the health the engine gives it: `MinutesUntilReady` is the weed's remaining health
        /// and the scythe's weeds branch decrements it (`Object.cs:1150-1179`).
        ///
        /// Built the way the rest of this suite builds one - the parameterless constructor plus the qualified-id field -
        /// because `new Object("(O)313", 1)` resolves through `ItemRegistry`, which a headless runner has not loaded.
        /// </summary>
        internal StardewValley.Object PlaceWeed(int x, int y, int health)
        {
            var weed = new StardewValley.Object
            {
                Name = "Weeds",
                Category = -999,
                ItemId = "313",
                MinutesUntilReady = health,
            };
            typeof(Item).GetField("_qualifiedItemId", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public)!
                .SetValue(weed, "(O)313");
            this.Farm.objects[new Vector2(x, y)] = weed;
            return weed;
        }

        internal StardewValley.TerrainFeatures.Grass PlaceGrass(int x, int y, int grassType, int weeds)
        {
            var grass = new StardewValley.TerrainFeatures.Grass(grassType, weeds);
            this.Farm.terrainFeatures[new Vector2(x, y)] = grass;
            return grass;
        }

        private static GameLocation Location(string name)
        {
            var location = new GameLocation();
            var map = new xTile.Map();
            map.AddLayer(new xTile.Layers.Layer("Back", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            location.map = map;
            typeof(GameLocation).GetField("name", BindingFlags.Public | BindingFlags.Instance)!
                .SetValue(location, new NetString(name));
            return location;
        }

        public void Dispose()
        {
            typeof(Game1).GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!.SetValue(null, this.worldStateBefore);
            typeof(Game1).GetField("random", BindingFlags.Public | BindingFlags.Static)!.SetValue(null, this.randomBefore);
            Game1.game1 = this.gameBefore!;
        }
    }
}

/// <summary>
/// The id layer as the gate sees it: every file that can define a target id, and every builder in one file's text.
///
/// Kept beside the gate rather than inside it so the scan can be pointed at a REVISION's file
/// (<c>git show &lt;rev&gt;:&lt;path&gt;</c>) without a second copy of the rule - the historical replay and the live gate are
/// the same code.
/// </summary>
internal static class TargetIdentitySource
{
    /// <summary>
    /// The counters a tool swing decrements on the object it hit, and why each is state rather than identity.
    /// </summary>
    internal static readonly (string Field, string Reason)[] DurabilityFields =
    {
        ("health", "a tree's durability, which `Tree.performToolAction` subtracts the axe's damage from in place"),
        ("MinutesUntilReady", "a rock's remaining hits and a weed's health, both decremented by the swing that spends them"),
        ("numberOfWeeds", "a tuft's count, which every scythe swing reduces by 1, 2 or 4"),
    };

    /// <summary>One `Build*TargetId` definition: its name and the text of its body.</summary>
    internal readonly record struct Builder(string Name, string Body);

    /// <summary>
    /// Every source file under `integrations/stardew/` that can define a builder - the Mod's own root files, where all of
    /// them live, discovered by scanning rather than by a list that would go stale.
    /// </summary>
    internal static IEnumerable<string> Files()
    {
        var directory = new System.IO.DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !System.IO.Directory.Exists(System.IO.Path.Combine(directory.FullName, "integrations")))
            directory = directory.Parent;
        directory.Should().NotBeNull("the test must run inside the repository");
        string stardew = System.IO.Path.Combine(directory!.FullName, "integrations/stardew");
        return System.IO.Directory
            .GetFiles(stardew, "*.cs", System.IO.SearchOption.TopDirectoryOnly)
            .OrderBy(path => path, StringComparer.Ordinal);
    }

    /// <summary>
    /// Every `string Build*TargetId(` definition in one file's text, with its body. Brace-bodied and expression-bodied
    /// builders both, because the id layer uses both.
    /// </summary>
    internal static IEnumerable<Builder> Builders(string source)
    {
        foreach (Match definition in Regex.Matches(source, @"\bstring (Build\w*TargetId)\s*\("))
        {
            int open = definition.Index + definition.Length - 1;
            int close = MatchingParen(source, open);
            if (close < 0) continue;
            string body = BodyAfter(source, close + 1);
            if (body.Length == 0) continue;
            yield return new Builder(definition.Groups[1].Value, body);
        }
    }

    private static int MatchingParen(string source, int open)
    {
        int depth = 0;
        for (int index = open; index < source.Length; index += 1)
        {
            if (source[index] == '(') depth += 1;
            else if (source[index] == ')')
            {
                depth -= 1;
                if (depth == 0) return index;
            }
        }

        return -1;
    }

    /// <summary>The text from just after a signature's `)` to the end of its body, `{...}` or `=> ...;`.</summary>
    private static string BodyAfter(string source, int from)
    {
        int index = from;
        while (index < source.Length && char.IsWhiteSpace(source[index])) index += 1;
        if (index >= source.Length) return string.Empty;
        if (source[index] == '{')
        {
            int depth = 0;
            for (int scan = index; scan < source.Length; scan += 1)
            {
                if (source[scan] == '{') depth += 1;
                else if (source[scan] == '}')
                {
                    depth -= 1;
                    if (depth == 0) return source[index..(scan + 1)];
                }
            }

            return string.Empty;
        }

        int semicolon = source.IndexOf(';', index);
        return semicolon < 0 ? string.Empty : source[index..(semicolon + 1)];
    }
}
