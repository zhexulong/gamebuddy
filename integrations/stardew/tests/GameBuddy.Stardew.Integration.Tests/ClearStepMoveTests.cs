using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using Microsoft.Xna.Framework;
using Netcode;
using StardewValley;
using StardewValley.Network;
using GameBuddy.Stardew.Core;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A `no_native_path` refusal now names the FIRST CLEAR that would open the route - and the refusal is where that
/// stays. This file pins the two halves of the decision the move action now makes on top of it:
///
/// <list type="bullet">
/// <item>the blocked route yields a WALK to <c>stand_at</c> where it used to yield only a refusal; and</item>
/// <item>arriving there never swings: a blocker that is still standing is refused BY NAME with the step attached,
/// because clearing costs a tool and stamina and "is this the rock the player wants?" is the caller's question.</item>
/// </list>
///
/// The world is literal: a 16x16 map walled on every row but y=3, an actor at the west end of that corridor and one
/// rock (resource clump 148, the boulder the native tool table prices as <c>rock</c>) blocking it. The actor's
/// walkable component is therefore the corridor up to the rock, which is the live shape the clearing evidence exists
/// for: the first rock is refused before any native movement.
/// </summary>
public sealed class ClearStepMoveTests
{
    private static readonly Vector2 Requested = new(9f, 3f);

    /// <summary>
    /// STEP 2, red half. Before this change the refusal was the terminal for this shape; now the same world yields
    /// the walk that would open it. Reverting the move-action branch makes this case fail because
    /// <see cref="CorridorHarness.PlanWalk"/> comes back null.
    /// </summary>
    [Fact]
    public void ABlockedRouteYieldsAWalkToTheStepInsteadOfOnlyARefusal()
    {
        using CorridorHarness harness = CorridorHarness.Create();
        harness.BuildCorridor();
        harness.PlaceRock(6, 3);

        (string reasonCode, string? _) = harness.Refuse(fromX: 2, fromY: 3);
        reasonCode.Should().Be("no_native_path", "no native route exists through one rock in a one-tile corridor");

        StardewBodyController.ClearApproachWalk? walk = harness.PlanWalk(fromX: 2, fromY: 3, out string? refusal);

        walk.Should().NotBeNull($"the refusal names a step, so the move action must be able to walk it - refusal: {refusal}");
        walk!.Walk.TargetTile.Should().Be(new Vector2(5f, 3f), "the step says stand_at=5,3 for the rock at 6,3");
        walk.BlockerTile.Should().Be((6, 3));
        walk.Evidence.Should().Contain("clear_step=rock@6,3",
            "the walk carries the SAME step text the refusal does, so the agent and the Mod cannot be told different things");
        walk.Evidence.Should().Contain("clear_step_walk=5,3");
        walk.Evidence.Should().Contain("requested=9,3",
            "the walk ends short of the requested tile, so the receipt has to name the request it serves");
    }

    /// <summary>
    /// The walk stops where a swing would reach from, and reaches the tile EXACTLY: an adjacent arrival would let the
    /// actor stop one tile short of the tile it was chosen to stand on.
    /// </summary>
    [Fact]
    public void TheWalkEndsExactlyOnTheApproachTile()
    {
        using CorridorHarness harness = CorridorHarness.Create();
        harness.BuildCorridor();
        harness.PlaceRock(6, 3);

        StardewBodyController.ClearApproachWalk walk = harness.RequireWalk(fromX: 2, fromY: 3);

        walk.Walk.AllowAdjacentArrival.Should().BeFalse(
            "stopping a tile short would arrive out of reach of the very blocker the walk exists for");
        walk.Walk.StagedApproach.Should().BeFalse("this is not a staged approach: the goal is exactly stand_at");
        walk.Walk.RequestedTile.Should().BeNull();
    }

    /// <summary>
    /// A zero-length walk is not a walk. When the actor already stands beside the blocker, the only act left is a
    /// swing - which is exactly the caller's decision - so the Mod must not report a move to the tile it is on.
    /// </summary>
    [Fact]
    public void StandingBesideTheBlocker_IsNotAZeroLengthWalk()
    {
        using CorridorHarness harness = CorridorHarness.Create();
        harness.BuildCorridor();
        harness.PlaceRock(6, 3);

        StardewBodyController.ClearApproachWalk? walk = harness.PlanWalk(fromX: 5, fromY: 3, out string? refusal);

        walk.Should().BeNull("the actor is already at stand_at, so there is nothing to walk");
        refusal.Should().Contain("already_in_reach=true");
        refusal.Should().Contain("clear_step=rock@6,3", "and the step is still named, because a swing is still the option");
    }

    /// <summary>
    /// STEP 3, the destructive half, pinned where it can fail. The arrival ruling has exactly two answers and neither
    /// of them acts: the walk reports that the blocker is still there, it does not clear it.
    /// </summary>
    [Fact]
    public void TheArrivalRefusesABlockerThatIsStillStanding()
    {
        StardewBodyController.AssessClearApproachArrival(
                (6, 3),
                new FirstClearStep(true, (6, 3), (5, 3), 1, "approach_found"))
            .Should().Be(StardewBodyController.ClearApproachArrival.BlockerStillPresent);
    }

    [Fact]
    public void TheArrivalContinuesWhenTheBlockerIsGone()
    {
        // A fresh plan that asks for nothing is the blocker being removed - by the player, by another companion, or
        // already gone when the walk started.
        StardewBodyController.AssessClearApproachArrival((6, 3), null)
            .Should().Be(StardewBodyController.ClearApproachArrival.BlockerGone);

        // A plan whose head is a DIFFERENT tile is also "gone" for this walk: one clear per request, so the next
        // step belongs to a fresh decision rather than to a chain this walk was never authorised to promise.
        StardewBodyController.AssessClearApproachArrival(
                (6, 3),
                new FirstClearStep(true, (7, 3), (6, 3), 2, "approach_found"))
            .Should().Be(StardewBodyController.ClearApproachArrival.BlockerGone);
    }

    [Fact]
    public void TheArrivalRefusalNamesTheBlockerRatherThanClaimingNoStepWasPossible()
    {
        // Two different receipts: `no_native_path` says no route exists, and `clear_step_blocked` says the route was
        // walked and one specific tile is in the way. Collapsing them would tell the caller nothing happened.
        StardewBodyController.ClearStepBlockedReasonCode.Should().Be("clear_step_blocked");
        StardewBodyController.NoNativePathReasonCode.Should().Be("no_native_path");
        StardewBodyController.ClearStepBlockedReasonCode.Should().NotBe(StardewBodyController.NoNativePathReasonCode);
        // And it is a legal wire code: the journal refuses a receipt whose reasonCode is outside the alphabet, which
        // would turn this refusal into a validation failure instead of a report.
        FarmhandExecutionJournal.IsValidReasonCode(StardewBodyController.ClearStepBlockedReasonCode).Should().BeTrue();
    }

    /// <summary>
    /// THE pin that keeps the walk non-destructive. The arrival re-plans and reports; it must never dispatch a
    /// clearing action. The controller names no clearing action and holds no reference to one, so a future edit that
    /// makes the walk swing has to break this type's boundary first.
    /// </summary>
    [Fact]
    public void TheWalkNeverCallsAClearingAction()
    {
        string source = File.ReadAllText(RepositorySourcePath(Path.Combine("integrations", "stardew", "StardewBodyController.cs")));
        foreach (string clearingAction in new[] { "clear_debris", "break_rock_source", "chop_stump", "cut_weeds", "cut_grass" })
        {
            source.Should().NotContain(clearingAction,
                $"{clearingAction} is destructive and belongs to the caller; clearing the way is never the walk's decision");
        }

        // The controller holds no tool and no action dispatcher: the two things a swing would need.
        source.Should().NotContain("RequestLocal");
        source.Should().NotContain("UseNativeTool");
        source.Should().NotContain(".CurrentTool.");

        // And the arrival has exactly two outcomes, both named in code where the decision is made.
        string arrival = MethodBody(source, "private void CompleteClearApproachArrival(");
        arrival.Should().Contain("ClearStepBlockedReasonCode");
        arrival.Should().Contain("AssessClearApproachArrival");

        // The two-answer enum is the whole rule, and it has no third "cleared" outcome the walk could act on.
        Enum.GetNames(typeof(StardewBodyController.ClearApproachArrival))
            .Should().BeEquivalentTo(new[] { "BlockerGone", "BlockerStillPresent" });
    }

    /// <summary>
    /// STEP 2, the placement pin. The decision lives in the move action's refusal branch - the same level as the
    /// other approach legs - and NOT in the reachability probe or the evidence formatter: those are predicates, and
    /// starting a walk from a predicate puts a mutation in a query.
    /// </summary>
    [Fact]
    public void TheDecisionLivesInTheMoveActionsRefusalBranch()
    {
        string moveSource = File.ReadAllText(RepositorySourcePath(
            Path.Combine("integrations", "stardew", "farmhandexecutioncontroller.movementactions.cs")));
        string moveBody = MethodBody(moveSource, "public LocalExecutionReceipt RequestLocalMove(");

        string condition = BranchCondition(moveBody, "TryStartClearApproach");
        condition.Should().Contain("StardewBodyController.NoNativePathReasonCode",
            "only a route the engine cannot walk earns a clearing step; any other refusal has its own countermeasure");
        condition.Should().NotContain("false", "a short-circuit falsifier would disable the branch while reading as if it were live");
        condition.Should().NotContain("|| true", "same: the branch must be able to be false");

        // The acceptance is minted INSIDE that branch, and it is an Accepted receipt for the SAME execution: the
        // request the caller made is served, with its goal moved to the step's standing tile for one leg.
        string branch = BranchBody(moveBody, "TryStartClearApproach");
        branch.Should().Contain("ExecutionState.Accepted");
        branch.Should().Contain("clear_step_approach=true");

        // The predicate that must NOT start a walk.
        string controllerSource = File.ReadAllText(RepositorySourcePath(Path.Combine("integrations", "stardew", "StardewBodyController.cs")));
        string describe = MethodBody(controllerSource, "private static string DescribeClearToReach(");
        string probe = MethodBody(controllerSource, "private static ReachabilityVerdict? AssessNativeReachability(");
        describe.Should().NotContain("TryStart");
        describe.Should().NotContain("InstallStagedStep");
        probe.Should().NotContain("TryStart");
        probe.Should().NotContain("InstallStagedStep");
    }

    /// <summary>
    /// The `if (...)` condition of the branch that contains <paramref name="call"/>, as source text. Read as a
    /// CONDITION rather than as a body, so a disjunct that makes it unreachable is visible here.
    /// </summary>
    private static string BranchCondition(string source, string call)
    {
        int callIndex = source.IndexOf(call, StringComparison.Ordinal);
        callIndex.Should().BeGreaterThanOrEqualTo(0, $"the branch calling {call} must exist");
        int open = source.LastIndexOf("if (", callIndex, StringComparison.Ordinal);
        open.Should().BeGreaterThanOrEqualTo(0, $"{call} must be guarded by an if");
        int depth = 0;
        for (int index = open + 4; index < source.Length; index++)
        {
            if (source[index] == '(') depth++;
            else if (source[index] == ')' && --depth == 0)
                return source[(open + 4)..index];
        }

        throw new InvalidOperationException($"unbalanced condition around {call}");
    }

    /// <summary>The `{ ... }` body of the branch that contains <paramref name="call"/>.</summary>
    private static string BranchBody(string source, string call)
    {
        int callIndex = source.IndexOf(call, StringComparison.Ordinal);
        callIndex.Should().BeGreaterThanOrEqualTo(0, $"the branch calling {call} must exist");
        int open = source.IndexOf('{', callIndex);
        open.Should().BeGreaterThanOrEqualTo(0, $"{call} must sit inside a branch body");
        int depth = 0;
        for (int index = open; index < source.Length; index++)
        {
            if (source[index] == '{') depth++;
            else if (source[index] == '}' && --depth == 0)
                return source[open..(index + 1)];
        }

        throw new InvalidOperationException($"unbalanced body around {call}");
    }

    private static string MethodBody(string source, string declaration)
    {
        int start = source.IndexOf(declaration, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, $"declaration not found: {declaration}");
        int open = source.IndexOf('{', start);
        int depth = 0;
        for (int index = open; index < source.Length; index++)
        {
            if (source[index] == '{') depth++;
            else if (source[index] == '}' && --depth == 0)
                return source.Substring(start, index - start + 1);
        }

        throw new InvalidOperationException($"unbalanced body: {declaration}");
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
    /// A real headless farm corner with one corridor: a 16x16 map, a real <see cref="GameLocation"/>, a real
    /// <see cref="Farmer"/> with a real bounding box, and the <c>Game1</c> statics the engine's reads dereference.
    /// </summary>
    private sealed class CorridorHarness : IDisposable
    {
        private readonly Game1? gameBefore;
        private readonly Farmer? playerBefore;
        private readonly object? worldStateBefore;

        private CorridorHarness()
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

        public static CorridorHarness Create()
        {
            var harness = new CorridorHarness();

            var root = (NetRoot<NetWorldState>)FormatterServices.GetUninitializedObject(typeof(NetRoot<NetWorldState>));
            root.Value = new NetWorldState();
            typeof(Game1)
                .GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!
                .SetValue(null, root);
            if (Game1.game1 is null)
                Game1.game1 = (Game1)FormatterServices.GetUninitializedObject(typeof(Game1));

            GameLocation location = new();
            var map = new xTile.Map();
            map.AddLayer(new xTile.Layers.Layer("Back", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            map.AddLayer(new xTile.Layers.Layer("Buildings", map, new xTile.Dimensions.Size(16, 16), new xTile.Dimensions.Size(64, 64)));
            location.map = map;
            location.IsFarm = true;
            SetField(location, "name", new NetString("ProbeFarm"));

            var sprite = (FarmerSprite)FormatterServices.GetUninitializedObject(typeof(FarmerSprite));
            SetField(sprite, "spriteWidth", new NetInt(16));
            SetField(sprite, "spriteHeight", new NetInt(32));
            SetField(sprite, "tempSpriteHeight", -1);

            var actor = (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));
            SetField(actor, "position", new NetPosition());
            SetField(actor, "currentLocationRef", new NetLocationRef());
            SetField(actor, "netMount", new NetRef<StardewValley.Characters.Horse>());
            SetField(actor, "sprite", new NetRef<AnimatedSprite> { Value = sprite });
            SetField(actor, "netStamina", new NetFloat(270f));
            SetField(actor, "usingTool", new NetBool(false));
            SetField(actor, "toolPower", new NetInt(0));
            // `TryStart` refuses a body it cannot move, and `Farmer.canMove` is a plain bool that defaults to false on
            // an uninitialized actor.
            typeof(Farmer).GetField("canMove", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(actor, true);
            // The clearing search asks the actor what it is holding and how skilled it is. `CurrentItem` reads
            // `temporaryItem` before the inventory, the skill levels are NetInts, and `MiningLevel` reads the buff
            // manager - so each of those is given its own honest empty value rather than left to dereference null.
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
            actor.position.Set(new Vector2(2 * 64 + 8, 3 * 64));
            actor.currentLocation = location;
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, actor);

            harness.Location = location;
            harness.Actor = actor;
            return harness;
        }

        /// <summary>
        /// WALLS the whole map except the corridor row y=3. A resource clump index the tool table does not price is the
        /// one occupant that blocks the planner and is not clearable, so the walls stay walls.
        /// </summary>
        public void BuildCorridor()
        {
            for (int x = 0; x < 16; x++)
            {
                for (int y = 0; y < 16; y++)
                {
                    if (y == 3)
                        continue;
                    this.Location.resourceClumps.Add(new StardewValley.TerrainFeatures.ResourceClump(0, 1, 1, new Vector2(x, y)));
                }
            }
        }

        /// <summary>The one boulder the native table prices as `rock`, on the corridor's only route.</summary>
        public void PlaceRock(int x, int y) =>
            this.Location.resourceClumps.Add(new StardewValley.TerrainFeatures.ResourceClump(148, 1, 1, new Vector2(x, y)));

        public (string ReasonCode, string? Evidence) Refuse(int fromX, int fromY)
        {
            this.Actor.position.Set(new Vector2(fromX * 64 + 8, fromY * 64));
            LocalMoveSpec specification = this.Specification();
            bool started = new StardewBodyController((_, _, _) => { })
                .TryStart(specification, this.Actor, tick: 1, out string reasonCode, out string? evidence);
            started.Should().BeFalse("a rock in the only corridor has no native route");
            return (reasonCode, evidence);
        }

        public StardewBodyController.ClearApproachWalk? PlanWalk(int fromX, int fromY, out string? refusal)
        {
            this.Actor.position.Set(new Vector2(fromX * 64 + 8, fromY * 64));
            return new StardewBodyController((_, _, _) => { })
                .PlanClearApproachWalk(this.Specification(), this.Actor, out refusal);
        }

        public StardewBodyController.ClearApproachWalk RequireWalk(int fromX, int fromY)
        {
            StardewBodyController.ClearApproachWalk? walk = this.PlanWalk(fromX, fromY, out string? refusal);
            walk.Should().NotBeNull($"the step must resolve to a walk - refusal: {refusal}");
            return walk!;
        }

        private LocalMoveSpec Specification() => new(
            "execution_01",
            "request_01",
            Requested,
            AllowAdjacentArrival: false,
            1,
            10_000,
            long.MaxValue);

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
