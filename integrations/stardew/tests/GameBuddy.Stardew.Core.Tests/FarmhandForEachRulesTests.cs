using System;
using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// The `for_each` loop authority: one loop semantic over the live rows of one rectangle, with a predicate and a dispatch.
///
/// WHY THE LOOP FORM EXISTS. The measured defect was a 3x20 "clear and plant" task that ran for 54 plan batches and
/// produced `till_soil` on 22 distinct tiles inside a 10x8 box, `plant_seed` on 13 tiles inside 18x5, and no `water_crop`
/// at all - because every plan node named one published target and published targets are bounded to Chebyshev 6. One
/// loop over one rectangle is how a caller asks for a patch rather than for the tiles it happens to see; WHICH of those
/// rows are its business is the predicate's question, so "every dry crop in this patch" is a field test on the same rows
/// rather than a second source.
///
/// WHY THE FILTER IS LOAD-BEARING. A rectangle is a region, not an intent: over the 20 loop passes that reported their
/// rows, 898 rows were decided and 700 of them (78.0%) were `not_matched` - tiles the rectangle held and the caller
/// excluded. So the two spellings the corpus writes (`occupant` in 30 of 38 loop calls, `field`+`in` in 7) are what makes a
/// loop usable, and the ORDER of a `Where` list is a CONJUNCTION: the intercropped-and-empty test below is the case a
/// dispatch keyed on the row's kind alone cannot express, asserted per tile with nothing coalesced.
/// </summary>
public sealed class FarmhandForEachRulesTests
{
    private static FarmhandForEachPredicate Field(string field, params string[] values) =>
        new(field, values.Select(FarmhandForEachValue.Of).ToArray());

    private static FarmhandForEachPredicate Number(string field, params double[] values) =>
        new(field, values.Select(FarmhandForEachValue.Of).ToArray());

    private static Dictionary<string, FarmhandForEachValue> Row(string kind, params (string Name, FarmhandForEachValue Value)[] extra)
    {
        var fields = new Dictionary<string, FarmhandForEachValue>(StringComparer.Ordinal) { ["kind"] = FarmhandForEachValue.Of(kind) };
        foreach ((string name, FarmhandForEachValue value) in extra) fields[name] = value;
        return fields;
    }

    /// <summary>A row as the live world reports it: what stands there, and the kind its classifier names.</summary>
    private static Dictionary<string, FarmhandForEachValue> Occupied(string occupant, string kind = "ground") =>
        Row(kind, (FarmhandForEachHealing.OccupantField, FarmhandForEachValue.Of(occupant)));

    private static FarmhandForEachSource Rect(int x, int y, int w, int h) =>
        new(x, y, w, h);

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

    /// <summary>A field predicate selects rows inside the source, and the caller names no target id to do it.</summary>
    [Fact]
    public void ASourceSelectsByFieldAndTheCallerNamesNoTarget()
    {
        var loop = new FarmhandForEachLoop(
            Rect(12, 4, 2, 1),
            new[] { Field("readyForHarvest", "true") },
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
    /// THE CONJUNCTION, per tile, nothing coalesced: ONE row has to be BOTH empty and tillable.
    ///
    /// <para>
    /// This is the pair the corpus writes twice (`[{ occupant: "none" }, { field: "tillable", in: [true] }]`) and it only
    /// means anything as AND: a tilled tile is not empty, a grass tile is not tillable, and a `till_soil` pass that read
    /// either half would turn the grass into dirt. The four tiles below are the four combinations, and the assertion is
    /// that exactly ONE of them is claimed.
    /// </para>
    /// </summary>
    [Fact]
    public void TheEmptyAndTillableConjunctionClaimsOnlyTheRowThatIsBoth()
    {
        var loop = new FarmhandForEachLoop(
            Rect(60, 18, 4, 1),
            new[]
            {
                new FarmhandForEachPredicate(FarmhandForEachHealing.OccupantField, new[] { FarmhandForEachValue.Of("none") }),
                new FarmhandForEachPredicate("tillable", new[] { FarmhandForEachValue.Of(true) }),
            },
            new FarmhandForEachEffect(new FarmhandForEachStep("till_soil")));

        // The four tiles of the row, one per combination of the two tests.
        var both = Occupied("none", "ground");
        both["tillable"] = FarmhandForEachValue.Of(true);
        var emptyButNotTillable = Occupied("none", "grass");
        emptyButNotTillable["tillable"] = FarmhandForEachValue.Of(false);
        var tillableButOccupied = Occupied("weed", "weed");
        tillableButOccupied["tillable"] = FarmhandForEachValue.Of(true);
        var neither = Occupied("stone", "rock");
        neither["tillable"] = FarmhandForEachValue.Of(false);

        FarmhandForEachRules.Decide(loop, 60, 18, 0, 0, both).Outcome.Should().Be(FarmhandForEachRowOutcome.Dispatched);
        FarmhandForEachRules.Decide(loop, 61, 18, 1, 0, emptyButNotTillable).Outcome.Should().Be(FarmhandForEachRowOutcome.NotMatched);
        FarmhandForEachRules.Decide(loop, 62, 18, 2, 0, tillableButOccupied).Outcome.Should().Be(FarmhandForEachRowOutcome.NotMatched);
        FarmhandForEachRules.Decide(loop, 63, 18, 3, 0, neither).Outcome.Should().Be(FarmhandForEachRowOutcome.NotMatched);
    }

    /// <summary>`do: null` is a deliberate path; a row no predicate claimed is a different outcome and is reported.</summary>
    [Fact]
    public void LeftAloneAndNotMatchedAreDifferentOutcomesAndAMissedRowNamesItsKindAndTile()
    {
        var path = new FarmhandForEachLoop(
            Rect(60, 18, 3, 1),
            new[] { new FarmhandForEachPredicate(FarmhandForEachHealing.OccupantField, new[] { FarmhandForEachValue.Of("none") }) },
            null);

        FarmhandForEachRules.Decide(path, 61, 18, 1, 0, Occupied("none")).Outcome.Should().Be(FarmhandForEachRowOutcome.LeftAlone);
        FarmhandForEachRules.Decide(path, 60, 18, 0, 0, Occupied("weed", "weed")).Outcome.Should().Be(FarmhandForEachRowOutcome.NotMatched);
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
            "a row's position inside the source is what its dispatch identity is minted from, and it is unchanged");
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
        FarmhandForEachSource.Kinds.Should().ContainSingle(
            "one source is what the row enumerator walks; a second kind here would be a source a caller could write and nothing could expand, which is the drift the Host's `PLAN_FOR_EACH_SOURCES` is asserted equal to this array for");
    }

    /// <summary>A predicate that names no field, no values or too many values claims nothing and is refused.</summary>
    [Fact]
    public void APredicateThatClaimsNothingIsInvalid()
    {
        new FarmhandForEachPredicate("kind", Array.Empty<FarmhandForEachValue>()).IsValid
            .Should().BeFalse("an empty membership list claims no row");
        new FarmhandForEachPredicate("kind", Enumerable.Range(0, FarmhandForEachPredicate.MaximumValues + 1).Select(index => FarmhandForEachValue.Of((double)index)).ToArray())
            .IsValid.Should().BeFalse("a list past the bound is refused rather than read as eight and a shrug");
        new FarmhandForEachPredicate(string.Empty, new[] { FarmhandForEachValue.Of("weed") }).IsValid
            .Should().BeFalse("a predicate with no field names nothing to test");
        Field("kind", "weed").IsValid.Should().BeTrue();
    }

    /// <summary>A value of another type does not match: the membership test compares typed values, not their words.</summary>
    [Fact]
    public void AMembershipTestDoesNotMatchAValueOfAnotherType()
    {
        var loop = new FarmhandForEachLoop(
            Rect(3, 4, 1, 1),
            new[] { Number("health", 3) },
            new FarmhandForEachEffect(new FarmhandForEachStep("chop_tree")));

        var numeric = new Dictionary<string, FarmhandForEachValue>(StringComparer.Ordinal)
        {
            ["kind"] = FarmhandForEachValue.Of("tree"),
            ["health"] = FarmhandForEachValue.Of(3.0),
        };
        var textual = new Dictionary<string, FarmhandForEachValue>(StringComparer.Ordinal)
        {
            ["kind"] = FarmhandForEachValue.Of("tree"),
            ["health"] = FarmhandForEachValue.Of("3"),
        };

        FarmhandForEachRules.Decide(loop, 3, 4, 0, 0, numeric).Outcome.Should().Be(FarmhandForEachRowOutcome.Dispatched);
        FarmhandForEachRules.Decide(loop, 3, 4, 0, 0, textual).Outcome.Should().Be(FarmhandForEachRowOutcome.NotMatched);
    }

    /// <summary>A row that does not carry the field at all is not matched, rather than matching on an absent value.</summary>
    [Fact]
    public void ARowWithoutTheFieldIsNotMatched()
    {
        var loop = new FarmhandForEachLoop(
            Rect(3, 4, 1, 1),
            new[] { Field("tillable", "true") },
            new FarmhandForEachEffect(new FarmhandForEachStep("till_soil")));

        FarmhandForEachRules.Decide(loop, 3, 4, 0, 0, Row("ground")).Outcome.Should().Be(FarmhandForEachRowOutcome.NotMatched);
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
