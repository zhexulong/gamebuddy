using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Runtime.Serialization;
using System.Text.RegularExpressions;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using Microsoft.Xna.Framework;
using Netcode;
using StardewValley;
using StardewValley.Network;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A rock is durability, not a one-shot flag.
///
/// <para>
/// `Pickaxe.DoFunction` subtracts `Math.Max(1, upgradeLevel + 1) + additionalPower` from `MinutesUntilReady`
/// (Pickaxe.cs:139-140) and returns early while the remainder is still positive (Pickaxe.cs:142-146). There is no
/// upgrade floor for a breakable stone: the `UpgradeLevel &lt; 2` refusal sits in the sibling `Name.Contains("Boulder")`
/// arm (Pickaxe.cs:180-190), which `Object.IsBreakableStone()` — `Category == -999 &amp;&amp; Name == "Stone"`
/// (Object.cs:6082) — cannot select. A basic pickaxe therefore takes any stone down by exactly one point per swing.
/// </para>
/// <para>
/// The predicate that shipped asked `MinutesUntilReady == 1`, i.e. "one swing finishes it", and both discovery and
/// admission asked it. Every mine node is 2-16 (MineShaft.cs:1733-1798, :4351-4460), so the whole mining half of the
/// game was invisible to `rockSourceTargets` and refused by `break_rock_source` with `rock_target_changed`. It is the
/// same defect the tree path carried as `tree.health.Value == 1f` and repaired in 1786682c: a durability compared to
/// the value that means "one swing left" instead of to the engine's own "is there anything left to hit".
/// </para>
/// </summary>
public sealed class RockSourceSwingOutcomeTests
{
    /// <summary>
    /// A rock the engine calls breakable, at a real durability. Built through the native predicate's own inputs
    /// (`Category`, `Name`, `MinutesUntilReady`) rather than a stub, so the test asks the shipped
    /// `Object.IsBreakableStone()` and not a copy of it.
    /// </summary>
    private const int MineNodeDurability = 3;

    [Fact]
    public void DiscoveryPublishesAMultiHitMineNodeAtItsRealDurability()
    {
        using var world = RockWorld.Create();
        world.PlaceBreakableStone(x: 2, y: 2, durability: MineNodeDurability);
        world.StandAt(1, 2);

        BridgeRockSourceTarget rock = world.Rocks().Should().ContainSingle().Subject;

        rock.X.Should().Be(2);
        rock.Y.Should().Be(2);
        // The durability is the fact the Agent needs in order to know how many swings remain; a constant 1 here was
        // the one-swing assumption leaking into the wire.
        rock.Health.Should().Be(MineNodeDurability, "a mine node publishes its real durability");
    }

    [Fact]
    public void DiscoveryStillExcludesWhatTheNativeCategoryExcludes()
    {
        using var world = RockWorld.Create();
        // A twig, a boulder and an ordinary placed object: none is `Category == -999 && Name == "Stone"`.
        world.PlaceObject(x: 2, y: 2, name: "Twig", category: -999, durability: 1);
        world.PlaceObject(x: 3, y: 2, name: "Boulder", category: -999, durability: 1);
        world.PlaceObject(x: 4, y: 2, name: "Chest", category: -9, durability: 1);
        world.StandAt(2, 1);

        world.Rocks().Should().BeEmpty("the native category is `Name == \"Stone\"`, not `Category == -999`");
    }

    /// <summary>
    /// One swing on a durability-3 rock takes it to 2, and that IS this action's success: it spent one dispatch, the
    /// plan decides whether to swing again. The tree path settled the same question the same way (1786682c).
    /// </summary>
    [Fact]
    public void ASwingThatOnlyDamagesARockIsSuccess()
    {
        RockSourceSwing.MadeProgress(durabilityBefore: 3, durabilityAfter: 2)
            .Should().BeTrue("one dispatch is one swing, so removing a point is progress");
        RockSourceSwing.MadeProgress(durabilityBefore: 3, durabilityAfter: null)
            .Should().BeTrue("a swing that removes the rock is the same success with less left to do");
        RockSourceSwing.MadeProgress(durabilityBefore: 1, durabilityAfter: null)
            .Should().BeTrue("the one-hit stone stays legal");
    }

    [Fact]
    public void ASwingThatLeavesTheRockUnchangedIsNotProgress()
    {
        RockSourceSwing.MadeProgress(durabilityBefore: 3, durabilityAfter: 3)
            .Should().BeFalse("an unchanged rock means the swing did not land on the source");
        RockSourceSwing.MadeProgress(durabilityBefore: 3, durabilityAfter: 4)
            .Should().BeFalse("durability only ever decreases natively, so a rise did not happen");
    }

    /// <summary>
    /// The invariant the old docblock spelled and this change must keep: discovery and admission ask the SAME
    /// predicate, so the scanner can never advertise a rock the action then refuses.
    ///
    /// Behaviour alone cannot prove it — both sides would have to be driven through a live swing. What can be
    /// proved is that there is exactly ONE definition and that every side names it: the two admission sites in the
    /// resource-tool partial, the radar, and the scene scanner.
    /// </summary>
    [Fact]
    public void DiscoveryAndAdmissionAskTheSamePredicate()
    {
        string controller = Read("farmhandexecutioncontroller.cs");
        string tools = Read("farmhandexecutioncontroller.resourcetoolactions.cs");
        string scanner = Read("ModEntry.cs");

        DiscoveryBody(controller).Should().Contain("NativeItemPredicates.IsBreakableStone(",
            "the radar and the action must not disagree about which rocks exist");

        // Two revalidations: the pre-approach one and the execution body's own, which must both admit the target the
        // radar published.
        CountOccurrences(tools, "!NativeItemPredicates.IsBreakableStone(rock)")
            .Should().Be(2, "both break_rock_source revalidations ask the same predicate");

        // The whole CALL, closing parens included: a prefix would still match a `&& item.MinutesUntilReady == 1`
        // appended after it, which is the exact regression this pins.
        scanner.Should().Contain("isBreakableStone: NativeItemPredicates.IsBreakableStone(item));",
            "observe_scene's `stone` affordance must advertise exactly what the action can settle");

        // And no second spelling may survive: a `MinutesUntilReady == 1` conjunction anywhere on this path is the
        // one-swing assumption coming back.
        foreach ((string file, string text) in new[]
                 {
                     ("farmhandexecutioncontroller.cs", controller),
                     ("farmhandexecutioncontroller.resourcetoolactions.cs", tools),
                     ("ModEntry.cs", scanner),
                 })
        {
            text.Should().NotContain("IsOneHitBreakableStone", $"{file} must not resurrect the one-swing predicate");
        }
    }

    /// <summary>
    /// The handler must DECIDE the terminal with the shared progress rule, not with "is the rock gone". The two
    /// spellings diverge on exactly the case this change is about, so a revert to `removed ? Succeeded : Uncertain`
    /// has to fail here rather than quietly restore it.
    /// </summary>
    [Fact]
    public void TheHandlerScoresOneSwingWithTheSharedProgressRule()
    {
        // Comments are stripped: this assertion's own prose quotes the expression it forbids, and a gate its own
        // explanation can fail is the same defect as one its prose can satisfy.
        string body = WithoutComments(ExecutionBody(Read("farmhandexecutioncontroller.resourcetoolactions.cs")));

        body.Should().Contain("RockSourceSwing.MadeProgress(before, after)",
            "the swing's terminal must come from the one rule that knows damage is progress");
        body.Should().NotContain("removed ? ExecutionState.Succeeded : ExecutionState.Uncertain",
            "removal-only success is the one-swing assumption restated in the handler");
    }

    private static string WithoutComments(string source) =>
        Regex.Replace(Regex.Replace(source, @"/\*[\s\S]*?\*/", string.Empty), @"(^|[^:])//.*$", "$1", RegexOptions.Multiline);

    private static string ExecutionBody(string tools)
    {
        const string declaration =
            "private LocalExecutionReceipt ExecuteBreakRockSource(string executionId, string requestId, int slot, int targetX, int targetY, string expectedTargetId)";
        int at = tools.IndexOf(declaration, StringComparison.Ordinal);
        at.Should().BeGreaterThanOrEqualTo(0, "the rock execution body must be findable by its declaration");
        int depth = 0;
        bool started = false;
        for (int i = tools.IndexOf('{', at); i < tools.Length; i++)
        {
            if (tools[i] == '{') { depth++; started = true; }
            else if (tools[i] == '}')
            {
                depth--;
                if (started && depth == 0) return tools[at..(i + 1)];
            }
        }
        throw new InvalidOperationException("unbalanced ExecuteBreakRockSource body");
    }

    private static string DiscoveryBody(string controller)
    {
        const string declaration = "private static IReadOnlyList<BridgeRockSourceTarget> DiscoverRockSourceTargets(Farmer player)";
        int at = controller.IndexOf(declaration, StringComparison.Ordinal);
        at.Should().BeGreaterThanOrEqualTo(0, "the rock radar must be findable by its declaration");
        int depth = 0;
        bool started = false;
        for (int i = controller.IndexOf('{', at); i < controller.Length; i++)
        {
            if (controller[i] == '{') { depth++; started = true; }
            else if (controller[i] == '}')
            {
                depth--;
                if (started && depth == 0) return controller[at..(i + 1)];
            }
        }
        throw new InvalidOperationException("unbalanced DiscoverRockSourceTargets body");
    }

    private static int CountOccurrences(string text, string needle)
    {
        int count = 0;
        for (int at = text.IndexOf(needle, StringComparison.Ordinal); at >= 0; at = text.IndexOf(needle, at + needle.Length, StringComparison.Ordinal))
            count++;
        return count;
    }

    private static string Read(string file) =>
        File.ReadAllText(Path.Combine(RepositoryRoot(), "integrations", "stardew", file));

    private static string RepositoryRoot()
    {
        string? directory = AppContext.BaseDirectory;
        while (directory is not null && !Directory.Exists(Path.Combine(directory, "integrations")))
            directory = Path.GetDirectoryName(directory);
        return directory ?? throw new InvalidOperationException("repository_root_not_found");
    }

    /// <summary>
    /// A headless farm with a real farmer and real `Object`s in the location's object layer, following
    /// <c>TargetFamilyCompletenessTests.TargetFamilyWorld</c>: an uninitialized `Game1`, a real map, and a `Farmer`
    /// whose NetFields are supplied because a process without a save never ran their initializers. Nothing here
    /// re-implements the projection — the test calls the shipped discovery through reflection.
    /// </summary>
    private sealed class RockWorld : IDisposable
    {
        private const long ActorId = 1001;

        private readonly Game1? gameBefore;
        private readonly Farmer? playerBefore;
        private readonly object? worldStateBefore;

        private RockWorld()
        {
            this.gameBefore = Game1.game1;
            this.playerBefore = Game1.player;
            this.worldStateBefore = typeof(Game1).GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!.GetValue(null);
        }

        internal GameLocation Farm { get; private set; } = null!;

        internal Farmer Actor { get; private set; } = null!;

        internal static RockWorld Create()
        {
            var world = new RockWorld();

            if (Game1.game1 is null)
                Game1.game1 = (Game1)FormatterServices.GetUninitializedObject(typeof(Game1));
            var root = (NetRoot<NetWorldState>)FormatterServices.GetUninitializedObject(typeof(NetRoot<NetWorldState>));
            root.Value = new NetWorldState();
            typeof(Game1).GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!.SetValue(null, root);

            var farm = new GameLocation();
            var map = new xTile.Map();
            map.AddLayer(new xTile.Layers.Layer("Back", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            farm.map = map;
            farm.IsFarm = true;
            SetInstanceField(farm, "name", new NetString("ProbeFarm"));
            world.Farm = farm;

            var sprite = (FarmerSprite)FormatterServices.GetUninitializedObject(typeof(FarmerSprite));
            SetInstanceField(sprite, "spriteWidth", new NetInt(16));
            SetInstanceField(sprite, "spriteHeight", new NetInt(32));
            SetInstanceField(sprite, "tempSpriteHeight", -1);

            var actor = (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));
            SetInstanceField(actor, "position", new NetPosition());
            SetInstanceField(actor, "currentLocationRef", new NetLocationRef());
            SetInstanceField(actor, "netMount", new NetRef<StardewValley.Characters.Horse>());
            SetInstanceField(actor, "sprite", new NetRef<AnimatedSprite> { Value = sprite });
            SetInstanceField(actor, "uniqueMultiplayerID", new NetLong(ActorId));
            SetInstanceField(actor, "netStamina", new NetFloat(270f));
            SetInstanceField(actor, "temporaryItem", new NetRef<Item>());
            SetInstanceField(actor, "cursorSlotItem", new NetRef<Item>());
            SetInstanceField(actor, "currentToolIndex", new NetInt(0));
            SetInstanceField(actor, "netItemStowed", new NetBool(false));
            SetInstanceField(actor, "netItems", new NetRef<StardewValley.Inventories.Inventory> { Value = new StardewValley.Inventories.Inventory() });
            SetInstanceField(actor, "maxItems", new NetInt(36));
            actor.position.Set(new Vector2(1 * 64 + 8, 2 * 64));
            actor.currentLocation = farm;
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, actor);
            world.Actor = actor;

            return world;
        }

        internal void StandAt(int tileX, int tileY) => this.Actor.position.Set(new Vector2(tileX * 64 + 8, tileY * 64));

        internal void PlaceBreakableStone(int x, int y, int durability) =>
            this.PlaceObject(x, y, name: "Stone", category: -999, durability: durability);

        internal void PlaceObject(int x, int y, string name, int category, int durability)
        {
            var item = new StardewValley.Object
            {
                Name = name,
                Category = category,
                MinutesUntilReady = durability,
            };
            this.Farm.objects[new Vector2(x, y)] = item;
        }

        internal IReadOnlyList<BridgeRockSourceTarget> Rocks()
        {
            MethodInfo discovery = typeof(ExecutionManager).GetMethod(
                "DiscoverRockSourceTargets",
                BindingFlags.NonPublic | BindingFlags.Static)!;
            return (IReadOnlyList<BridgeRockSourceTarget>)discovery.Invoke(null, new object?[] { this.Actor })!;
        }

        private static void SetInstanceField(object target, string name, object value) =>
            target.GetType()
                .GetField(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(target, value);

        public void Dispose()
        {
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, this.playerBefore);
            typeof(Game1).GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!.SetValue(null, this.worldStateBefore);
            Game1.game1 = this.gameBefore!;
        }
    }
}
