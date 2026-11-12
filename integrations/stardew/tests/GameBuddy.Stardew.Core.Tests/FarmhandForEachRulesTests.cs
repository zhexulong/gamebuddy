using System;
using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// The `for_each` loop authority: one loop semantic over any collection of live world rows, with a predicate and a
/// dispatch.
///
/// WHY THE AREA IS NOT PRIVILEGED. The measured defect was a 3x20 "clear and plant" task that ran for 54 plan batches and
/// produced `till_soil` on 22 distinct tiles inside a 10x8 box, `plant_seed` on 13 tiles inside 18x5, and no `water_crop`
/// at all - because every plan node named one published target and published targets are bounded to Chebyshev 6. A
/// rectangle is one way to ask for many rows; "every dry crop on the farm" and "every tree with health left" are others,
/// and they are the shapes a caller reaches for when the thing it wants is not a rectangle. So the source is a SOURCE,
/// and the predicate and the dispatch are the same for all of them.
///
/// WHY POSITION GUARDS EXIST AT ALL. Trellis crops (green bean, hops, grape) grow into impassable tiles, so a real farm
/// leaves a walkable column between trellis columns and plants a filler crop between trellis rows - hops with coffee is a
/// standard summer layout. Those decisions depend on POSITION, not on what the tile contains, so a dispatch keyed on the
/// row's kind alone gives every empty tillable tile the same action and the same seed. The intercropped test below is the
/// case such a table cannot express, asserted per tile with nothing coalesced.
/// </summary>
public sealed class FarmhandForEachRulesTests
{
    private static FarmhandForEachPredicate Field(string field, FarmhandForEachComparison comparison, params string[] values) =>
        new(field, comparison, values.Select(FarmhandForEachValue.Of).ToArray());

    private static FarmhandForEachPredicate Number(string field, FarmhandForEachComparison comparison, double value) =>
        new(field, comparison, new[] { FarmhandForEachValue.Of(value) });

    private static FarmhandForEachPredicate Stride(string axis, int every, int offset) =>
        new(null, FarmhandForEachComparison.In, Array.Empty<FarmhandForEachValue>())
        {
            Axis = axis,
            Stride = new FarmhandForEachStride(every, offset),
        };

    private static Dictionary<string, FarmhandForEachValue> Row(string kind, params (string Name, FarmhandForEachValue Value)[] extra)
    {
        var fields = new Dictionary<string, FarmhandForEachValue>(StringComparer.Ordinal) { ["kind"] = FarmhandForEachValue.Of(kind) };
        foreach ((string name, FarmhandForEachValue value) in extra) fields[name] = value;
        return fields;
    }

    private static FarmhandForEachSource Rect(int x, int y, int w, int h) =>
        new(FarmhandForEachSource.AreaKind, x, y, w, h);

    /// <summary>Every tile of a rectangle, written as the rectangle and not as a second copy of the walk's order.</summary>
    private static IEnumerable<(int X, int Y)> EveryTile(int x, int y, int w, int h) =>
        from row in Enumerable.Range(0, h)
        from column in Enumerable.Range(0, w)
        select (x + column, y + row);

    /// <summary>Every position inside a source, in the same shape: the indices a predicate tests, not the order it sees.</summary>
    private static IEnumerable<(int LocalColumn, int LocalRow)> EveryLocalIndex(int w, int h) =>
        from row in Enumerable.Range(0, h)
        from column in Enumerable.Range(0, w)
        select (column, row);

    /// <summary>Distance walked between consecutive tiles, in the map's own grid.</summary>
    private static int Walked(IReadOnlyList<(int X, int Y, int LocalColumn, int LocalRow)> rows) =>
        rows.Zip(rows.Skip(1), (from, to) => Math.Abs(to.X - from.X) + Math.Abs(to.Y - from.Y)).Sum();

    [Fact]
    public void TheSameRuleSetHasTheSameMeaningOverAOneByOneAreaAndOverAFamily()
    {
        var predicate = Field("kind", FarmhandForEachComparison.In, "weed");
        var effect = new FarmhandForEachEffect(new FarmhandForEachStep("cut_weeds"));
        var overArea = new FarmhandForEachLoop(Rect(60, 18, 1, 1), new[] { predicate }, effect);
        var overFamily = new FarmhandForEachLoop(
            new FarmhandForEachSource(FarmhandForEachSource.FamilyKind, Family: "weedTargets"),
            new[] { predicate },
            effect);

        overArea.IsValid.Should().BeTrue();
        overFamily.IsValid.Should().BeTrue();

        FarmhandForEachRowDecision fromArea = FarmhandForEachRules.Decide(overArea, 60, 18, 0, 0, Row("weed"));
        FarmhandForEachRowDecision fromFamily = FarmhandForEachRules.Decide(overFamily, 60, 18, 0, 0, Row("weed"));

        fromArea.Outcome.Should().Be(FarmhandForEachRowOutcome.Dispatched);
        fromFamily.Outcome.Should().Be(fromArea.Outcome);
        fromFamily.Effect!.Steps[0].Action.Should().Be(fromArea.Effect!.Steps[0].Action, "the source chooses the rows, never the dispatch");
        fromArea.X.Should().Be(60);
        fromFamily.X.Should().Be(60);
    }

    /// <summary>
    /// A family source with a FIELD predicate: the caller never enumerates ids, and the loop never learns them either.
    /// </summary>
    [Fact]
    public void AFamilySourceSelectsByFieldAndTheCallerNamesNoTarget()
    {
        var loop = new FarmhandForEachLoop(
            new FarmhandForEachSource(FarmhandForEachSource.FamilyKind, Family: "cropTargets"),
            new[] { Field("readyForHarvest", FarmhandForEachComparison.Eq, "true") },
            new FarmhandForEachEffect(new FarmhandForEachStep("harvest_crop")));
        loop.IsValid.Should().BeTrue();

        var ready = new Dictionary<string, FarmhandForEachValue>(StringComparer.Ordinal)
        {
            ["kind"] = FarmhandForEachValue.Of("crop"),
            ["readyForHarvest"] = FarmhandForEachValue.Of("true"),
        };
        var growing = new Dictionary<string, FarmhandForEachValue>(StringComparer.Ordinal)
        {
            ["kind"] = FarmhandForEachValue.Of("crop"),
            ["readyForHarvest"] = FarmhandForEachValue.Of("false"),
        };

        FarmhandForEachRules.Decide(loop, 12, 4, 0, 0, ready).Outcome.Should().Be(FarmhandForEachRowOutcome.Dispatched);
        FarmhandForEachRules.Decide(loop, 13, 4, 1, 0, growing).Outcome.Should().Be(FarmhandForEachRowOutcome.NotMatched);
    }

    /// <summary>
    /// THE INTERCROPPED CASE, per tile, nothing coalesced: hops on columns 0,3,6..., coffee on 1,4,7..., path on 2,5,8...
    /// </summary>
    [Fact]
    public void AnInterleavedTwoSeedPatternDecidesPerTileAndAPathIsCountedAsLeftAlone()
    {
        var hops = new FarmhandForEachLoop(Rect(60, 18, 20, 3), new[] { Stride(FarmhandForEachPredicate.ColOperator, 3, 0) }, new FarmhandForEachEffect(new FarmhandForEachStep("plant_seed", new Dictionary<string, string> { ["seed"] = "hops" })));
        var coffee = new FarmhandForEachLoop(Rect(60, 18, 20, 3), new[] { Stride(FarmhandForEachPredicate.ColOperator, 3, 1) }, new FarmhandForEachEffect(new FarmhandForEachStep("plant_seed", new Dictionary<string, string> { ["seed"] = "coffee" })));
        var path = new FarmhandForEachLoop(Rect(60, 18, 20, 3), new[] { Stride(FarmhandForEachPredicate.ColOperator, 3, 2) }, null);

        var rows = FarmhandForEachRules.AreaRows(hops.Source).ToArray();
        rows.Should().HaveCount(60, "20 columns by 3 rows is one intent and the measured patch");

        // The first row, tile by tile, as the three loops together decide it: one winner per tile, by position only.
        var firstRow = rows
            .Where(row => row.LocalRow == 0)
            .OrderBy(row => row.LocalColumn)
            .Select(row =>
            {
                foreach (FarmhandForEachLoop loop in new[] { hops, coffee, path })
                {
                    FarmhandForEachRowDecision decision = FarmhandForEachRules.Decide(loop, row.X, row.Y, row.LocalColumn, row.LocalRow, Row("empty_tillable"));
                    if (decision.Outcome == FarmhandForEachRowOutcome.Dispatched) return decision.Effect!.Steps[0].Arguments!["seed"];
                    if (decision.Outcome == FarmhandForEachRowOutcome.LeftAlone) return "path";
                }
                return "unmatched";
            })
            .ToArray();

        firstRow.Should().Equal(
            "hops", "coffee", "path", "hops", "coffee", "path", "hops", "coffee", "path", "hops",
            "coffee", "path", "hops", "coffee", "path", "hops", "coffee", "path", "hops", "coffee");
        firstRow.Should().NotContain("unmatched", "every column of the patch is a deliberate decision");
    }

    /// <summary>`do: null` is a deliberate path; a row no predicate claimed is a different outcome and is reported.</summary>
    [Fact]
    public void LeftAloneAndNotMatchedAreDifferentOutcomesAndAMissedRowNamesItsKindAndTile()
    {
        var path = new FarmhandForEachLoop(Rect(60, 18, 3, 1), new[] { Stride(FarmhandForEachPredicate.ColOperator, 3, 2) }, null);

        FarmhandForEachRules.Decide(path, 62, 18, 2, 0, Row("empty_tillable")).Outcome.Should().Be(FarmhandForEachRowOutcome.LeftAlone);
        FarmhandForEachRules.Decide(path, 60, 18, 0, 0, Row("empty_tillable")).Outcome.Should().Be(FarmhandForEachRowOutcome.NotMatched);
        FarmhandForEachRules.NoRuleMatchedReasonCode("rock", 61, 18).Should().Be("no_rule_matched:rock@61,18");
    }

    /// <summary>
    /// THE WALK AND NOT THE ANSWER: a rectangle is swept in snake order, so every row starts on the column the previous
    /// one ended on.
    ///
    /// <para>
    /// A typewriter sweep crosses the whole row width again at every break, and that distance produces nothing: the
    /// measured harvest node spent 2,235 ms of its 2,232 ms walking, so a per-break constant is paid on every pass. The
    /// order is the rectangle's WALK: each row keeps its own columns, so a position guard and a row identity read the
    /// same two numbers they always did, and only the moment a tile is visited moves.
    /// </para>
    /// </summary>
    [Theory]
    [InlineData(1, 1)]
    [InlineData(3, 2)]
    [InlineData(3, 20)]
    [InlineData(20, 3)]
    public void AreaRowsSweepsARectangleInSnakeOrder(int width, int height)
    {
        var rows = FarmhandForEachRules.AreaRows(Rect(5, 7, width, height)).ToArray();

        rows.Should().HaveCount(width * height, "a rectangle addresses each of its tiles once");
        rows.Select(row => (row.X, row.Y)).Should().BeEquivalentTo(
            EveryTile(5, 7, width, height),
            "the walk is a reordering of the rectangle, never a different set of tiles");
        rows.Select(row => (row.LocalColumn, row.LocalRow)).Should().BeEquivalentTo(
            EveryLocalIndex(width, height),
            "a row's position inside the source is what a position guard tests, and it is unchanged");
        for (int localRow = 0; localRow < height; localRow++)
        {
            int[] columns = rows.Where(row => row.LocalRow == localRow).Select(row => row.LocalColumn).ToArray();
            // EVEN ROWS RUN LEFT TO RIGHT AND ODD ROWS RUN BACK, which is the whole of the change: the columns of a row
            // are the same set either way, and only their order differs.
            int[] expected = localRow % 2 == 0
                ? Enumerable.Range(0, width).ToArray()
                : Enumerable.Range(0, width).Reverse().ToArray();
            columns.Should().Equal(expected, "row {0} is walked {1}", localRow, localRow % 2 == 0 ? "forwards" : "back");
        }
        var walk = rows.Select(row => (row.LocalRow, row.LocalColumn)).ToArray();
        for (int localRow = 1; localRow < height; localRow++)
        {
            int endedOn = walk.Last(position => position.LocalRow == localRow - 1).LocalColumn;
            int startsOn = walk.First(position => position.LocalRow == localRow).LocalColumn;
            startsOn.Should().Be(endedOn, "row {0} starts on the column row {1} ended on, so the break costs one step", localRow, localRow - 1);
        }
    }

    /// <summary>
    /// THE MEASURE THE ORDER EXISTS FOR, on the measured patch: distance walked between consecutive tiles, snake against
    /// the typewriter sweep it replaces.
    ///
    /// <para>
    /// Both numbers are asserted so the saving is a reading rather than a claim, and the third assertion is what keeps it
    /// honest: the difference is exactly one column width per row break, so nothing was dropped to buy the distance.
    /// </para>
    /// </summary>
    [Fact]
    public void ASnakeSweepSavesOneColumnWidthAtEveryRowBreak()
    {
        const int width = 3;
        const int height = 20;
        var rows = FarmhandForEachRules.AreaRows(Rect(0, 0, width, height)).ToArray();

        int snake = Walked(rows);
        // A typewriter sweep walks a row's columns once per row and then crosses the same width back to column 0.
        int typewriter = height * (width - 1) + (height - 1) * width;

        snake.Should().Be(59, "20 rows of 2 steps, then 19 breaks of 1: the break is spent going DOWN and never back");
        typewriter.Should().Be(97, "the same 40 steps inside the rows, then 19 breaks of 3 across the full width");
        snake.Should().Be(
            typewriter - (width - 1) * (height - 1),
            "the distance saved is one column per break and no tile is skipped to save it");
    }

    /// <summary>The bound is 64 rows per intent, and over it the answer carries the count rather than a shorter table.</summary>
    [Fact]
    public void ASourceIsBoundedAtSixtyFourRowsPerIntent()
    {
        Rect(0, 0, 20, 3).IsValid.Should().BeTrue("a 3x20 row is 60 rows and is the measured patch");
        Rect(0, 0, 8, 8).IsValid.Should().BeTrue("8x8 is exactly the bound");
        Rect(0, 0, 20, 20).IsValid.Should().BeFalse("400 rows is over the bound");
        Rect(0, 0, 0, 3).IsValid.Should().BeFalse("an empty extent addresses no row");
        new FarmhandForEachSource("nonsense").IsValid.Should().BeFalse();
        new FarmhandForEachSource(FarmhandForEachSource.QueryKind, Subject: "crops", Only: "dry").IsValid.Should().BeTrue();
    }

    /// <summary>A stride that can never claim an index is refused: a dead guard looks exactly like a forgotten row.</summary>
    [Fact]
    public void AStrideThatCanNeverClaimAnIndexIsInvalid()
    {
        new FarmhandForEachStride(3, 3).IsValid.Should().BeFalse();
        new FarmhandForEachStride(0, 0).IsValid.Should().BeFalse();
        Stride(FarmhandForEachPredicate.ColOperator, 3, 1).IsValid.Should().BeTrue();
        new FarmhandForEachPredicate(null, FarmhandForEachComparison.In, Array.Empty<FarmhandForEachValue>()).IsValid
            .Should().BeFalse("a predicate with neither a field nor an axis claims nothing");
    }

    /// <summary>An ordered comparison over a non-numeric field fails closed instead of ordering text.</summary>
    [Fact]
    public void AnOrderedComparisonOverANonNumericFieldDoesNotMatch()
    {
        var loop = new FarmhandForEachLoop(
            new FarmhandForEachSource(FarmhandForEachSource.FamilyKind, Family: "treeChopSourceTargets"),
            new[] { Number("health", FarmhandForEachComparison.Gt, 0) },
            new FarmhandForEachEffect(new FarmhandForEachStep("chop_tree")));

        var fields = new Dictionary<string, FarmhandForEachValue>(StringComparer.Ordinal)
        {
            ["kind"] = FarmhandForEachValue.Of("tree"),
            ["health"] = FarmhandForEachValue.Of("healthy"),
        };

        FarmhandForEachRules.Decide(loop, 3, 4, 0, 0, fields).Outcome.Should().Be(FarmhandForEachRowOutcome.NotMatched);
    }

    /// <summary>`by_kind` is a reference to the Mod's own table, never a second mapping the caller restates.</summary>
    [Fact]
    public void ByKindIsATokenRatherThanAMappingTheCallerSupplies()
    {
        FarmhandForEachStep.ByKindAction.Should().Be("by_kind");
        new FarmhandForEachStep(FarmhandForEachStep.ByKindAction).IsValid.Should().BeTrue();
        new FarmhandForEachStep(string.Empty).IsValid.Should().BeFalse();
    }

    /// <summary>
    /// A CHAIN IS BOUNDED, AND BOTH ENDS OF THE BOUND ARE SAID OUT LOUD. `do` of no steps claims nothing (that is
    /// `do: null`), and a chain past the bound is refused rather than truncated - a row that silently lost its fourth step
    /// would report the tile as worked.
    /// </summary>
    [Fact]
    public void AChainOfStepsIsBoundedAtBothEnds()
    {
        FarmhandForEachStep till = new("till_soil");
        FarmhandForEachStep water = new("water_crop");
        FarmhandForEachStep harvest = new("harvest_crop");
        FarmhandForEachStep sow = new("plant_seed");
        FarmhandForEachStep mulch = new("place_mulch");

        new FarmhandForEachEffect(till).IsValid.Should().BeTrue("the single form is the chain of length one");
        new FarmhandForEachEffect(till, harvest, water, sow).IsValid.Should().BeTrue("the clear-till-water-sow chain fits the bound");
        new FarmhandForEachEffect().IsValid.Should().BeFalse("an empty chain claims nothing; `do: null` is the spelling for that");
        new FarmhandForEachEffect(till, harvest, water, sow, mulch).IsValid.Should().BeFalse("a chain past the bound is refused, not truncated");
    }
}
