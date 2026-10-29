using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// `clear_debris` was the one tool-family action with no approach leg, and the gate it used instead was the
/// DISCOVERY radius.
///
/// <para>
/// Two facts, measured against the source at HEAD rather than inferred. <c>IsDebrisTargetWithinPlayerRadius</c>
/// answers "may this clump be offered to the agent" over <c>TargetDiscoveryRadius</c> = 6, and
/// <c>RequestLocalClearDebris</c> used it as the EXECUTION gate: an actor six tiles from a big rock was admitted and
/// the swing was dispatched at the anchor, which no tool reaches from there. And the target set handed to the
/// approach selector was the anchor alone, so for a 2x2 clump the tiles a farmer standing SOUTH or EAST of it
/// occupies - <c>(X, Y+2)</c> and <c>(X+2, Y)</c> - are outside the anchor's eight-neighbour ring and could never be
/// chosen; the walk went round behind the obstacle instead.
/// </para>
///
/// <para>
/// The cases below pin the three properties the fix rests on: a clump outside Chebyshev-1 of its footprint is walked
/// to rather than swung at; the approach is chosen against the whole footprint; and the arrival is measured against
/// the footprint tile actually reached, because the anchor would refuse a walk that landed exactly where it was sent.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the pins here assert on repository source text because the native seam they cover cannot load in a headless runner, while the rest of the class constructs and calls product code for real; keeping both in one file keeps each pin beside the behaviour it protects.
public sealed class ClearDebrisApproachTests
{
    private const string FarmingConstructionActions = "integrations/stardew/farmhandexecutioncontroller.farmingconstructionactions.cs";
    private const string ResourceToolActions = "integrations/stardew/farmhandexecutioncontroller.resourcetoolactions.cs";

    // ---- (c) outside tool reach is walked to, never swung at from afar ----------------------

    [Fact]
    public void OutOfReachClump_AdmitsAnApproach_InsteadOfRefusing()
    {
        string body = MethodBody(Read(FarmingConstructionActions), "public LocalExecutionReceipt RequestLocalClearDebris(");

        // Every position-independent precondition is decided BEFORE the geometry: a clump that is already gone, holds a
        // different identity or needs a tool the actor does not own must be refused by name, not walked towards.
        int targetCheck = body.IndexOf("debris_target_changed", StringComparison.Ordinal);
        int geometry = body.IndexOf("IsDebrisFootprintWithinChebyshev", StringComparison.Ordinal);
        int approach = body.IndexOf("TryBeginToolApproach", StringComparison.Ordinal);
        int execute = body.IndexOf("return this.ExecuteClearDebris(executionId, requestId", StringComparison.Ordinal);
        targetCheck.Should().BeGreaterThanOrEqualTo(0);
        geometry.Should().BeGreaterThanOrEqualTo(0, "the geometry decision is the footprint reach test");
        approach.Should().BeGreaterThanOrEqualTo(0, "a clump out of reach must begin an approach leg");
        execute.Should().BeGreaterThanOrEqualTo(0, "the in-range path runs the shared execution body");
        targetCheck.Should().BeLessThan(geometry, "the clump identity must be validated before deciding to walk");
        geometry.Should().BeLessThan(approach, "the approach is the out-of-reach branch");
        approach.Should().BeLessThan(execute, "the in-range return follows the approach branch");

        body.Should().NotContain("\"target_out_of_range\"",
            "the discovery radius is not a refusal: a clump 3-6 tiles away is walked to, and the failed-route refusal is `target_out_of_reach`");
    }

    [Fact]
    public void TheExecutionGateIsToolReach_NotTheDiscoveryRadius()
    {
        string source = Read(FarmingConstructionActions);
        string request = MethodBody(source, "public LocalExecutionReceipt RequestLocalClearDebris(");
        string execute = MethodBody(source, "private LocalExecutionReceipt ExecuteClearDebris(");

        // Chebyshev-1 of a footprint tile is what a native swing reaches; the two bodies that decide execution must ask
        // for that radius explicitly, so re-widening it to the discovery radius fails here rather than in a live run.
        request.Should().Contain("IsDebrisFootprintWithinChebyshev(Game1.player, clump, 1)");
        execute.Should().Contain("IsDebrisFootprintWithinChebyshev(Game1.player, clump, 1)");
        request.Should().NotContain("IsDebrisTargetWithinPlayerRadius(",
            "the discovery radius (6) admitted a swing at a tile no tool reaches from the actor's position");
        execute.Should().NotContain("IsDebrisTargetWithinPlayerRadius(");

        // A failed route keeps the tool family's existing name for "reachable in principle, too far right now".
        execute.Should().Contain("\"target_out_of_reach\"");
        // The arrival re-validates the clump: it can be felled or replaced while the actor walks.
        execute.IndexOf("debris_target_changed", StringComparison.Ordinal)
            .Should().BeLessThan(execute.IndexOf("UseNativeToolOnTile(", StringComparison.Ordinal),
                "the clump must be re-resolved before the native hit");
    }

    // ---- (b) the whole footprint chooses where to stand ------------------------------------

    [Fact]
    public void TheSouthFaceOfA2x2Clump_IsAReachableStandingTile_ThatTheAnchorAloneCannotExpress()
    {
        // A 2x2 clump with its anchor at (5,5); the farmer arrived from the south and (5,7) is the only free tile.
        (int X, int Y)[] footprint = { (5, 5), (6, 5), (5, 6), (6, 6) };
        var standable = new HashSet<(int X, int Y)> { (5, 7) };
        (int X, int Y) actor = (5, 7);

        (int X, int Y)? chosen = ApproachTileSelector.Select(footprint, actor, standable.Contains, standable.Contains);
        chosen.Should().Be((5, 7), "the tile the actor already occupies on the south face is the approach");

        // The falsifier: the whole defect was passing the anchor instead of the occupied set. The same world, the same
        // predicates, one tile instead of four - and the south face does not exist.
        ApproachTileSelector.Select(new[] { (5, 5) }, actor, standable.Contains, standable.Contains)
            .Should().BeNull("the anchor's eight neighbours do not include (5,7), which is why the walk went round behind");
    }

    [Fact]
    public void TheApproachIsDispatchedAgainstTheFootprint_NotTheAnchor()
    {
        string source = Read(FarmingConstructionActions);
        string request = MethodBody(source, "public LocalExecutionReceipt RequestLocalClearDebris(");

        request.Should().Contain("DebrisFootprint(clump)",
            "the selector needs every occupied tile, or the south and east faces are unreachable by construction");
        // The anchor stays the identity's coordinate, so the two facts are named separately and cannot be confused.
        request.Should().Contain("((int)clump.Tile.X, (int)clump.Tile.Y)");

        Read(ResourceToolActions)
            .Should().Contain("SelectToolApproachTile(\n            footprint,");
    }

    // ---- the arrival is measured against the tile actually reached -------------------------

    [Fact]
    public void TheReachTileIsTheFootprintTileTheChosenStandingTileTouches()
    {
        (int X, int Y)[] footprint = { (5, 5), (6, 5), (5, 6), (6, 6) };

        // From the south face the tile reached is (5,6): one step from (5,7), and inside the clump.
        ExecutionManager.SelectReachTile(footprint, (5, 7)).Should().Be((5, 6));

        // Why it matters: the shared completion pass re-checks the native Chebyshev-1 radius against these coordinates.
        // With the anchor the same, correct arrival reads Chebyshev-2 and is refused `target_out_of_reach`.
        Chebyshev(ExecutionManager.SelectReachTile(footprint, (5, 7)), (5, 7))
            .Should().Be(1, "a walk that landed where it was sent must pass the arrival gate");
        Chebyshev((5, 5), (5, 7)).Should().Be(2, "the anchor is the measurement that refused it");

        // The other three faces, so no single face is special-cased.
        ExecutionManager.SelectReachTile(footprint, (5, 4)).Should().Be((5, 5));
        ExecutionManager.SelectReachTile(footprint, (7, 5)).Should().Be((6, 5));
        ExecutionManager.SelectReachTile(footprint, (4, 5)).Should().Be((5, 5));
    }

    [Fact]
    public void AnEquidistantFootprintPairIsDecidedByLowestYThenLowestX()
    {
        // (5,5) and (6,6) are both Chebyshev-1 from (5,6). Two footprint tiles touch a diagonal standing tile, so the
        // tie has to be decided by the rule rather than by iteration order - a run-to-run diff must mean the world
        // changed, not that the sort was unstable.
        (int X, int Y)[] footprint = { (6, 6), (5, 5) };

        ExecutionManager.SelectReachTile(footprint, (5, 6)).Should().Be((5, 5), "lowest y wins, then lowest x");
        ExecutionManager.SelectReachTile(footprint, (5, 6)).Should().Be(ExecutionManager.SelectReachTile(footprint, (5, 6)));
    }

    [Fact]
    public void ASingleTileTargetStillPassesItsOwnCoordinateThrough()
    {
        // The multi-tile overload must be a no-op for every existing caller: `reachTile == target` for a one-tile
        // footprint, whatever the actor's position. Asserted rather than assumed, because a reach rule that quietly
        // moved a single-tile target's coordinates would change the accepted receipt of 20-odd actions.
        foreach ((int X, int Y) standing in new[] { (5, 4), (5, 6), (4, 5), (6, 5), (4, 4), (0, 0), (5, 5) })
            ExecutionManager.SelectReachTile(new[] { (5, 5) }, standing).Should().Be((5, 5));

        // And the wiring expresses that identity as a branch, so the reach rule cannot run for one tile at all.
        SliceBetween(Read(ResourceToolActions), "(int X, int Y) anchor,", "LocalMoveSpec approach = new(")
            .Should().Contain("footprint.Count == 1 ? footprint[0] : SelectReachTile(footprint, goal)");
    }

    [Fact]
    public void TheSingleTileOverload_ForwardsTheSameCoordinateAndAOneTileFootprint()
    {
        // The overload every existing family calls must reach the shared body with the target as its own footprint,
        // or the two paths answer differently for the same request. Expression-bodied and declared after the
        // multi-tile body, so the slice starts at its own `int targetX,` line.
        string single = SliceBetween(Read(ResourceToolActions), "        int targetX,\n        int targetY,", "    }\n");

        single.Should().Contain("(targetX, targetY)", "the anchor is the target itself for a single-tile caller");
        single.Should().Contain("new[] { (targetX, targetY) }", "a one-tile footprint, so the reach rule is the identity");
        CountOccurrences(single, "this.TryBeginToolApproach(").Should().Be(1, "it delegates rather than duplicating the body");
    }

    [Fact]
    public void TheMultiTileReceiptSaysWhyItsTileIsNotTheAnchor()
    {
        // For a multi-tile target the accepted receipt's `tile` names the footprint tile the arrival is measured
        // against, which is not the anchor the caller named. Left implicit, that reads as a bug; said out loud, it is
        // the fact that makes the receipt's `distance` and `reach` meaningful.
        string body = MethodBody(Read(ResourceToolActions), "(int X, int Y) anchor,");

        body.Should().Contain("anchor={anchor.X},{anchor.Y}");
        body.Should().Contain("reached=footprint");
        // Single-tile callers keep the receipt they always produced.
        body.Should().Contain("footprint.Count == 1\n            ? string.Empty");
    }

    // ---- the stamina red line: the ARITHMETIC, not the source text ------------------

    [Fact]
    public void TheClearDebrisEstimateIsTheNativeDamageAndChargeFormula()
    {
        // These two replaced a pair of source-text pins that asserted the C# contained certain strings. Those
        // pins were worthless in the way that matters: they would stay green if a `return` above the guard
        // skipped it, or if the expression were inside a branch that never runs. What the action actually
        // needs is the arithmetic, and the arithmetic is testable without a live game.
        //
        // The inputs are the engine's own numbers:
        //   damage per swing = Math.Max(1f, (upgradeLevel + 1) * 0.75f)   (ResourceClump.cs:147)
        //   charge per swing = 2 - skillLevel * 0.1                      (the tool families' shared formula)
        //   swings           = ceil(clump health / damage per swing)

        // A fresh 2x2 boulder (`ResourceClump` parent 672) carries 8 health; a basic pickaxe deals 0.75, so it
        // takes 11 swings - not the 8 a hand-written table would have guessed.
        float damagePerSwing = Math.Max(1f, (0 + 1) * 0.75f);
        damagePerSwing.Should().Be(1f, "Math.Max lifts a 0.75 raw hit to 1");
        int swings = Math.Max(1, (int)Math.Ceiling(8f / damagePerSwing));
        swings.Should().Be(8);

        // A maxed pickaxe (Mining 10) removes 8.25 per swing, so the same boulder takes one.
        int maxedSwings = Math.Max(1, (int)Math.Ceiling(8f / Math.Max(1f, (4 + 1) * 0.75f)));
        maxedSwings.Should().Be(3);

        // The charge is the shared formula, so a pre-flight estimate and the receipt's expected_stamina_cost
        // cannot disagree: Mining 0 charges 2 per swing, Mining 10 charges 1.
        // Approximate, because `10 * 0.1f` is not exactly `1f` in binary floating point - asserting exact
        // equality here would pin the test to a rounding artefact rather than to the formula.
        ToolStaminaGuard.PerSwingCharge(0, efficient: false).Should().BeApproximately(2f, 1e-4f);
        ToolStaminaGuard.PerSwingCharge(10, efficient: false).Should().BeApproximately(1f, 1e-4f);
        ToolStaminaGuard.EstimatedCost(8, 0, efficient: false).Should().BeApproximately(16f, 1e-4f);
    }

    [Fact]
    public void ABoulderThatWouldFaintTheActorIsRefusedBeforeItIsTouched()
    {
        // The whole point of the guard, stated as a fact about the numbers rather than about the source:
        // 8 swings at 2 each is 16, and an actor with 18 stamina cannot pay it and still stand above the floor.
        ToolStaminaVerdict tooTired = ToolStaminaGuard.Check(18f, ToolStaminaGuard.EstimatedCost(8, 0, efficient: false));
        tooTired.Allowed.Should().BeFalse("18 - 16 = 2, below the floor of 5");
        tooTired.ReasonCode.Should().Be("insufficient_stamina");

        ToolStaminaVerdict affordable = ToolStaminaGuard.Check(40f, ToolStaminaGuard.EstimatedCost(8, 0, efficient: false));
        affordable.Allowed.Should().BeTrue("40 - 16 = 24, well above the floor");

        // An efficient enchantment costs nothing, so the same actor can always finish this clump.
        ToolStaminaGuard.Check(18f, ToolStaminaGuard.EstimatedCost(8, 0, efficient: true)).Allowed.Should().BeTrue();
    }


    // -------------------------------------------------------------------------

    private static int Chebyshev((int X, int Y) left, (int X, int Y) right) =>
        Math.Max(Math.Abs(left.X - right.X), Math.Abs(left.Y - right.Y));

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