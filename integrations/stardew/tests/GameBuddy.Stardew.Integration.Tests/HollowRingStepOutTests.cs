using System;
using System.IO;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The Hollow Ring: a tool swing's target tile must never be the tile the actor is standing on.
///
/// <para>
/// <c>UseNativeToolOnTile</c> names the target tile's pixel centre directly
/// (<c>tool.DoFunction(location, tileX*64+32, tileY*64+32, 1, who)</c>, farmhandexecutioncontroller.cs:3950)
/// and every tool handler gates execution on the native Chebyshev-1 radius. Distance ZERO satisfies that
/// gate, so an actor standing ON the target used to swing at its own feet: the Hoe re-tills the tile the
/// actor occupies, the Axe counts the tile in front of the facing, and the receipt reports a swing the
/// animation does not show. Design §3.1.1 names the rule - 「工具挥击的**目标格**不得等于**身体格**」-
/// and says the correction is a NATIVE position change, not an internal fix: it runs under the same body
/// ownership as any movement and is recorded as <c>stepped_out_from</c> / <c>stepped_out_to</c>.
/// </para>
///
/// <para>
/// The correction reuses the existing approach leg rather than adding a second movement mechanism. The
/// request-time condition that already sends an out-of-range swing walking gains one clause - the body
/// tile - so an actor underfoot walks to a ring tile and swings from there, through
/// <c>controller.TryStart</c> and the one <c>activeToolApproach</c> ownership slot.
/// </para>
///
/// <para>
/// Two things must never happen instead: stepping onto an occupied tile (the old
/// <c>SelectStandingApproachTile</c> defect that made actors walk onto rocks), and stepping onto a
/// <c>TouchAction Warp</c> buffer tile (design §3.1.1's three-way warp rule - legal to cross, legal as an
/// <c>enter_exit</c> target, forbidden to STOP on). Both are excluded by the one predicate that already
/// chooses every approach tile, so there is one spelling of "may I stop here".
/// </para>
///
/// <para>
/// These cases pin the contract at the layer that owns it. A real farm, a real Hoe and a real native swing
/// belong to the L1 fixtures; what can be decided without a world - the ring arithmetic, the gate
/// ordering, the evidence keys - is decided here. The multi-tile footprint reading ("the actor stands on
/// ANY occupied tile") is deliberately NOT implemented in this slice and is pinned as absent below.
/// </para>
/// </summary>
public sealed class HollowRingStepOutTests
{
    private const string MovementActions = "integrations/stardew/farmhandexecutioncontroller.movementactions.cs";
    private const string ResourceToolActions = "integrations/stardew/farmhandexecutioncontroller.resourcetoolactions.cs";
    private const string BodyController = "integrations/stardew/StardewBodyController.cs";

    /// <summary>The one clause each in-range gate gains. Spelled once here, so the eight sites cannot drift.</summary>
    private const string HollowRingClause = "IsToolTargetUnderActor(Game1.player, targetX, targetY)";

    /// <summary>
    /// The single-tile tool families. Each swings a tool at exactly one named tile, so each has to answer
    /// the hollow-ring question before it acts. (Multi-tile footprints such as <c>clear_debris</c> are the
    /// deferred half and are not listed.)
    /// </summary>
    private static readonly (string Action, string Request)[] SingleTileToolFamilies =
    {
        ("chop_tree_source", "public LocalExecutionReceipt RequestLocalChopTreeSource("),
        ("break_rock_source", "public LocalExecutionReceipt RequestLocalBreakRockSource("),
        ("dig_artifact_spot", "public LocalExecutionReceipt RequestLocalDigArtifactSpot("),
        ("clear_hoedirt", "public LocalExecutionReceipt RequestLocalClearHoeDirt("),
        ("till_soil", "public LocalExecutionReceipt RequestLocalTillSoil("),
        ("chop_stump", "public LocalExecutionReceipt RequestLocalChopStump("),
        ("cut_weeds", "public LocalExecutionReceipt RequestLocalCutWeeds("),
        ("cut_grass", "public LocalExecutionReceipt RequestLocalCutGrass("),
    };

    // ---- the gate: no single-tile tool family may swing from the target tile ----------------

    [Fact]
    public void EverySingleTileToolFamilyAsksTheHollowRingBeforeItActs()
    {
        string source = Read(ResourceToolActions);

        foreach ((string action, string request) in SingleTileToolFamilies)
        {
            string body = MethodBody(source, request);

            // The body tile joins the reach gate the file already has: both facts answer "is a swing from
            // here going to land on the target", and a swing is what comes next, so neither can be added
            // downstream of this branch.
            int reach = body.IndexOf("IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1)", StringComparison.Ordinal);
            int underfoot = body.IndexOf(HollowRingClause, StringComparison.Ordinal);
            int approach = body.IndexOf("TryBeginToolApproach(", StringComparison.Ordinal);

            reach.Should().BeGreaterThanOrEqualTo(0, $"{action} keeps the native Chebyshev-1 reach gate");
            underfoot.Should().BeGreaterThanOrEqualTo(0, $"{action} must decide the hollow ring before it swings");
            approach.Should().BeGreaterThanOrEqualTo(0, $"{action} approaches instead of refusing");
            underfoot.Should().BeLessThan(approach, $"{action} must decide where to stand before committing the walk");
            reach.Should().BeLessThan(approach, $"{action} keeps reach on the same side of the branch");
        }
    }

    [Fact]
    public void TheHollowRingRuleIsTheBodyTileAndNothingElse()
    {
        // Two tile coordinates, no world. Keeping it this small is the point: a predicate that also asked
        // something else - a reach test, a target identity - would answer "not underfoot" for the one case
        // it exists for, and the swing would land on the actor's own feet again.
        string rule = ExpressionBody(Read(MovementActions), "internal static bool IsToolTargetUnderActor(");

        rule.Should().Contain("player.Tile.X == targetX", "the body's tile is the tile the tool must not target");
        rule.Should().Contain("player.Tile.Y == targetY", "both axes, or an actor on the same row would qualify");
        rule.Should().NotContain("Chebyshev", "reach is a separate fact with its own refusal");
        rule.Should().NotContain("TerrainFeature", "what the target IS belongs to the action, not to this question");
    }

    [Fact]
    public void TheCompletionGateWouldRatherRefuseThanSwingFromTheTargetTile()
    {
        // The request gate decides to walk; the completion pass decides whether the walk resolved the
        // problem. A step-out that did not move - a blocked ring, a superseded walk, an actor pushed back
        // by a passing NPC - leaves the actor on the target, where the radius test ALONE still says "in
        // reach, swing". So the same body-tile fact is asked at the one place the native call happens.
        string completion = MethodBody(Read(ResourceToolActions), "private void CompleteToolApproach(");

        int range = completion.IndexOf(
            "IsTileWithinChebyshevRadius(Game1.player, specification.TargetX, specification.TargetY, 1)",
            StringComparison.Ordinal);
        int underfoot = completion.IndexOf(
            "IsToolTargetUnderActor(Game1.player, specification.TargetX, specification.TargetY)",
            StringComparison.Ordinal);
        int execute = completion.IndexOf("specification.Execute(", StringComparison.Ordinal);

        range.Should().BeGreaterThanOrEqualTo(0, "the post-approach range re-check keeps its native radius");
        underfoot.Should().BeGreaterThanOrEqualTo(0, "a walk that left the actor on the target must refuse");
        underfoot.Should().BeLessThan(execute, "the hollow-ring check must precede the native step");

        completion.Should().Contain("\"hollow_ring_step_out_failed\"",
            "the refusal names the failed step-out instead of reusing the distance vocabulary");
        completion.Should().Contain("step_out=failed",
            "the evidence says the step-out did not take, so a reader is not left guessing");
    }

    // ---- the correction is a native position change, recorded as such -----------------------

    [Fact]
    public void TheStepOutIsTheSharedApproachLegNotAnInternalCorrection()
    {
        string body = MethodBody(Read(ResourceToolActions), "(int X, int Y) anchor,");

        // It is a WALK: the same selector, the same body controller, the same ownership slot as every
        // other approach. A correction that nudged the actor into a new position without the controller
        // would be a teleport, and would also bypass the STOP epoch that the controller owns.
        body.Should().Contain("SelectToolApproachTile(");
        body.Should().Contain("this.controller.TryStart(approach, Game1.player",
            "the step-out is dispatched through the one body owner, never written into the position");
        body.Should().Contain("this.activeToolApproach = new LocalApproachSpec(",
            "the step-out holds body ownership exactly like any other approach");

        // And it is ADVERTISED: the accepted receipt names both ends of the move, or a reader cannot tell
        // a step-out from a walk that happened to begin beside the target.
        string steppedOut = SliceBetween(body, "string steppedOut =", "LocalExecutionReceipt accepted = new(");
        steppedOut.Should().Contain("actorOnTarget", "only a hollow-ring correction is reported as one");
        steppedOut.Should().Contain("stepped_out_from=");
        steppedOut.Should().Contain("stepped_out_to=");
        SliceBetween(body, "LocalExecutionReceipt accepted = new(", "this.Remember(accepted);")
            .Should().Contain("{steppedOut}", "the accepted receipt carries those facts to the wire");
    }

    [Fact]
    public void TheStepOutIsOnlyClaimedWhenTheActorStoodOnTheTarget()
    {
        // An approach from three tiles away is not a step-out and must not report one: the two are
        // different facts about the same walk, and a receipt that conflated them would make every ordinary
        // approach look like a hollow-ring correction.
        string body = MethodBody(Read(ResourceToolActions), "(int X, int Y) anchor,");

        int condition = body.IndexOf("bool actorOnTarget =", StringComparison.Ordinal);
        condition.Should().BeGreaterThanOrEqualTo(0, "the step-out is conditional on standing on the target");

        string conditionText = SliceBetween(body, "bool actorOnTarget =", ";");
        conditionText.Should().Contain("footprint.Count == 1",
            "this slice implements the single-tile rule; the multi-tile reading is deferred");
        conditionText.Should().Contain("== footprint[0]",
            "the actor stands on the target exactly when it stands on the only occupied tile");
    }

    [Fact]
    public void TheMultiTileFootprintIsNotSteppedOutInThisSlice()
    {
        // Deliberately deferred and said out loud rather than left to be inferred: a 2x2 clump needs "the
        // actor stands on ANY occupied tile", which is the footprint-wide reading with its own acceptance.
        // If someone implements it, this test goes red and the deferral is retired on purpose.
        string body = MethodBody(Read(ResourceToolActions), "(int X, int Y) anchor,");

        body.Should().Contain("bool actorOnTarget = footprint.Count == 1 && actor == footprint[0]",
            "the deferred multi-tile reading must stay visibly unimplemented, not silently half-done");
    }

    // ---- the step-out tile: a ring tile, never occupied, never a warp buffer ----------------

    [Fact]
    public void TheStepOutTileIsARingTileAndNeverTheTargetItself()
    {
        // The arithmetic the correction rests on, asked of the real selector. Standing on the target,
        // every cardinal neighbour is equally near and the declared order decides - so one world state
        // yields one destination, and a run-to-run diff means the world changed.
        (int X, int Y) target = (5, 5);
        System.Collections.Generic.HashSet<(int X, int Y)> open = new() { (4, 5), (5, 4) };

        ExecutionManager.SelectToolApproachTile(target, target, open.Contains, _ => true)
            .Should().Be((4, 5), "the declared candidate order decides");

        // Even when the predicate is generous enough to admit the target, the answer is a neighbour: an
        // "approach" that lands on the target IS the hollow ring it exists to break.
        ExecutionManager.SelectToolApproachTile(target, target, _ => true, _ => true)
            .Should().NotBe(target, "standing on the target is not stepping out of it");

        ExecutionManager.SelectToolApproachTile(target, target, _ => false, _ => true)
            .Should().BeNull("with no ring tile the honest answer is null, not the target");
    }

    [Fact]
    public void AWarpBufferIsNotAStepOutTile()
    {
        // Design §3.1.1 splits warp tiles three ways: crossing them is legal, targeting one with
        // `enter_exit` is legal, STOPPING on one is not. A step-out stops, so the candidate predicate must
        // exclude them - and it must feed the SAME predicate the approach selector already consumes, or
        // the two disagree about which tiles are available.
        string body = MethodBody(Read(ResourceToolActions), "(int X, int Y) anchor,");

        int standable = body.IndexOf("StardewBodyController.IsStandableTile(", StringComparison.Ordinal);
        int warp = body.IndexOf("IsWarpBufferTile(location,", StringComparison.Ordinal);
        int select = body.IndexOf("SelectToolApproachTile(", StringComparison.Ordinal);

        standable.Should().BeGreaterThanOrEqualTo(0, "occupancy is the standability the engine owns");
        warp.Should().BeGreaterThanOrEqualTo(0, "a warp tile is a buffer the actor may not stop on");
        warp.Should().BeLessThan(select, "the exclusion must be inside the predicate the selector consumes");

        string rule = ExpressionBody(Read(MovementActions), "internal static bool IsWarpBufferTile(");
        rule.Should().Contain("warps", "the location's own warp table answers 'does this tile warp'");
        rule.Should().Contain("npcOnly", "an NPC-only warp does not move the companion, so it is not a buffer");
    }

    [Fact]
    public void WarpTilesStayCrossableEverywhereElse()
    {
        // The falsifier for an over-correction: making warp tiles unstandable outright would break
        // `enter_exit` and every doorway. The exclusion belongs to the predicates that choose a tile to
        // STOP on, and to nothing else - one definition, and every caller is a stop.
        MethodBody(Read(MovementActions), "private LocalExecutionReceipt RequestLocalDoorTransition(")
            .Should().NotContain("IsWarpBufferTile",
                "enter_exit targets a warp tile by definition; filtering it here would seal the companion indoors");

        MethodBody(Read(BodyController), "internal static bool IsWalkableTile(")
            .Should().NotContain("Warp", "the traversal reading must stay clear of the warp table");

        int references = CountOccurrences(Read(MovementActions), "IsWarpBufferTile(")
            + CountOccurrences(Read(ResourceToolActions), "IsWarpBufferTile(");
        references.Should().Be(3,
            "one definition plus the two STOP paths (the approach's stop candidate and the move substitution). "
            + "A further call would be a second opinion about which tiles the world may route through");
    }

    // ---- nowhere to step out: a named refusal, never a forced move -------------------------

    [Fact]
    public void AHollowRingWithNowhereToStepOutRefusesWithItsOwnName()
    {
        // Acceptance (b): every ring tile is occupied, or one of them is a warp buffer. The answer is a
        // refusal that names the HOLLOW RING - not a teleport, and not the ordinary
        // `no_reachable_approach`, which would leave the agent thinking the target is unreachable when it
        // is in fact underfoot.
        string body = MethodBody(Read(ResourceToolActions), "(int X, int Y) anchor,");
        const string code = "hollow_ring_no_step_out";

        body.Should().Contain($"\"{code}\"", "the refusal states that the ring, not the target, is the problem");
        body.Should().Contain("step_out=none", "the evidence says the step-out did not happen rather than omitting it");
        body.IndexOf(code, StringComparison.Ordinal)
            .Should().BeLessThan(body.IndexOf("this.controller.TryStart(", StringComparison.Ordinal),
                "nothing may be dispatched when there is nowhere to stand");

        // The refusal is reached exactly when the actor is underfoot: an unreachable target that the actor
        // is NOT standing on keeps its existing name.
        body.Should().Contain("actorOnTarget", "the hollow-ring refusal is conditional on the hollow ring");
        body.Should().Contain("DescribeNoReachableApproach(", "the ordinary unreachable case keeps its own refusal");
    }

    [Fact]
    public void TheHollowRingRefusalSurvivesTheValidatorThatWillJudgeIt()
    {
        // Emitted into a receipt, so it must survive the journal's own validator and the wire schema.
        // Asserted against the REAL validator and the REAL schema file rather than a second copy of the
        // pattern: a future tightening has to fail here instead of silently faulting the bridge.
        foreach (string code in new[] { "hollow_ring_no_step_out", "hollow_ring_step_out_failed" })
        {
            FarmhandExecutionJournal.IsValidReasonCode(code)
                .Should().BeTrue($"{code} is journaled as a receipt reasonCode");
            System.Text.RegularExpressions.Regex.IsMatch(code, "^[a-z0-9_:-]{1,128}$")
                .Should().BeTrue($"{code} is published to the Host as a receipt reasonCode");
        }

        File.ReadAllText(RepositorySourcePath(Path.Combine("protocol", "bridge-v1.schema.json")))
            .Should().Contain("^[a-z0-9_:-]{1,128}$", "the schema declares the wire's reasonCode alphabet");
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

    /// <summary>
    /// An expression-bodied member from its declaration to its terminating semicolon. The two predicates this file
    /// pins are single expressions on purpose - `MethodBody` would find the `{ target }` of a lambda parameter
    /// instead of a body and assert against a fragment.
    /// </summary>
    private static string ExpressionBody(string source, string signature)
    {
        int index = source.IndexOf(signature, StringComparison.Ordinal);
        index.Should().BeGreaterThanOrEqualTo(0, $"{signature} must exist");
        int terminator = source.IndexOf(';', index + signature.Length);
        terminator.Should().BeGreaterThan(index, $"{signature} must be an expression-bodied member");
        return source[index..(terminator + 1)];
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
        throw new FileNotFoundException($"repository path not found: {relative}");
    }
}
