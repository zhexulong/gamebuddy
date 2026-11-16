using System;
using System.Collections.Generic;
using System.Globalization;
using FluentAssertions;
using StardewValley.GameData;
using StardewValley.GameData.Locations;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// What the engine's fifth argument DOES to a row's chance, measured on real <see cref="SpawnFishData"/> rows through the
/// real <c>GetChance</c>.
///
/// <para>
/// WHY THIS FILE EXISTS. `TargetBaitRowComparisonSourceShapeTests` proves the call site passes the engine's per-row
/// comparison; it cannot prove that the comparison matters, because it reads text. This file measures the difference:
/// <c>GetChance</c> spends <c>isTargetedWithBait</c> on one row only - <c>num = num * SpecificBaitMultiplier +
/// SpecificBaitBuff</c>, <c>SpawnFishData.cs</c> - so a value computed once for the whole table is wrong in both
/// directions, and wrong by exactly that row's own declared boost.
/// </para>
///
/// <para>
/// THE ROWS ARE FIXTURES, THE ARITHMETIC IS THE SHIPPED ONE. `Data/Locations` cannot be loaded in this process (no
/// content manager), so the three rows are constructed with the same shape the data has - an item id, a chance and two
/// rows that declare their own specific-bait boost. Every expectation below is derived from the row's own
/// <c>SpecificBaitMultiplier</c>/<c>SpecificBaitBuff</c> rather than written as a number, so a data change moves the table
/// and not the assertion.
/// </para>
/// </summary>
public sealed class TargetBaitRowChanceTests
{
    private const string Salmon = "(O)128";
    private const string Catfish = "(O)132";
    private const string Legend = "(O)163";

    private readonly ITestOutputHelper output;

    public TargetBaitRowChanceTests(ITestOutputHelper output) => this.output = output;

    /// <summary>
    /// WITH a specific bait naming one species, the engine boosts that row and nothing else. The row's boost is real:
    /// its chance moves, and it moves by the row's own multiplier and flat buff.
    /// </summary>
    [Fact]
    public void ASpecificBaitBoostsOnlyTheRowItNames()
    {
        bool applied = false;
        var rows = Rows();

        foreach (SpawnFishData row in rows)
        {
            bool isTargeted = row.ItemId == Salmon;
            float actual = Chance(row, isTargeted, ref applied);
            float expected = isTargeted
                ? (row.Chance * row.SpecificBaitMultiplier) + row.SpecificBaitBuff
                : row.Chance;

            actual.Should().Be(
                expected,
                $"`{row.ItemId}` is {(isTargeted ? "the species the bait names, so its own boost applies" : "not the named species, so its chance is its own Chance")}");
            if (isTargeted) actual.Should().BeGreaterThan(row.Chance, "naming the species must raise its chance");
            else actual.Should().Be(row.Chance, "an unnamed row must keep its own chance");
        }

        applied.Should().BeFalse("none of these rows declares ChanceModifiers, so the caller's modifier delegate is never reached");

        output.WriteLine(Table("specific bait names " + Salmon, rows, row => row.ItemId == Salmon));
    }

    /// <summary>
    /// WITHOUT a specific bait the engine passes false for every row, and every row keeps its own chance. This is the
    /// case the shipped expression got wrong in the loudest way: it passed true to all of them.
    /// </summary>
    [Fact]
    public void NoSpecificBaitBoostsNoRow()
    {
        bool applied = false;
        var rows = Rows();
        string? named = null;

        foreach (SpawnFishData row in rows)
        {
            bool isTargeted = row.ItemId == named;
            float actual = Chance(row, isTargeted, ref applied);

            isTargeted.Should().BeFalse("no species is named, so no row can be its target");
            actual.Should().Be(row.Chance, $"`{row.ItemId}` must keep its own chance when no bait names it");
        }

        output.WriteLine(Table("no specific bait", rows, row => row.ItemId == named));
    }

    /// <summary>
    /// THE BEFORE/AFTER TABLE. The deleted expression
    /// <c>magicBait == false &amp;&amp; string.Equals(TargetBaitSpecies(player), string.Empty, ...)</c> is recomputed here
    /// only to state which way each case moved: with a bait it understated the named row (its boost was dropped), without
    /// one it inflated every row (each row's boost was applied). Those two directions are the defect; the numbers are
    /// read from the same rows as the assertions above.
    /// </summary>
    [Fact]
    public void TheShippedOnceOutsideValueMovedBothCasesTheWrongWay()
    {
        bool applied = false;
        var rows = Rows();
        string? none = null;
        SpawnFishData salmon = rows[0];
        SpawnFishData catfish = rows[1];

        // Case A: a specific bait names salmon, no magic bait. The shipped expression answered
        // `false && ...` = false for EVERY row, so the named row lost the boost the engine gives it.
        bool shippedWithBait = false && TargetSpeciesWhenBaitNames(Salmon) == string.Empty;
        float shippedNamed = Chance(salmon, shippedWithBait, ref applied);
        float engineNamed = Chance(salmon, salmon.ItemId == Salmon, ref applied);
        shippedNamed.Should().Be(salmon.Chance, "the shipped value passed false to the row the bait names");
        engineNamed.Should().BeGreaterThan(shippedNamed, "the fix raises the named row's chance");

        // Case B: no specific bait at all. The shipped expression answered `true && "" == ""` = TRUE for every row, so
        // every row received a boost no bait gave it.
        bool shippedWithoutBait = true && TargetSpeciesWhenBaitNames(null) == string.Empty;
        float shippedUnnamed = Chance(catfish, shippedWithoutBait, ref applied);
        float engineUnnamed = Chance(catfish, catfish.ItemId == none, ref applied);
        shippedWithoutBait.Should().BeTrue("the shipped value was true exactly when no species was named");
        shippedUnnamed.Should().BeGreaterThan(engineUnnamed, "the fix stops boosting rows no bait names");
        engineUnnamed.Should().Be(catfish.Chance);

        output.WriteLine($"before (shipped): {salmon.ItemId} {F(shippedNamed)} | {catfish.ItemId} {F(shippedUnnamed)}");
        output.WriteLine($"after  (engine) : {salmon.ItemId} {F(engineNamed)} | {catfish.ItemId} {F(engineUnnamed)}");
    }

    /// <summary>
    /// A magic bait names no species, so the shipped <c>magicBait == false &amp;&amp;</c> guard changed nothing: both the
    /// old and the new value pass false everywhere. Pinned so the guard's removal cannot be read as a behaviour change on
    /// this path.
    /// </summary>
    [Fact]
    public void AMagicBaitBoostsNoRowUnderEitherValue()
    {
        bool applied = false;
        string? named = null;

        foreach (SpawnFishData row in Rows())
        {
            bool shipped = false && TargetSpeciesWhenBaitNames(null) == string.Empty;
            float before = Chance(row, shipped, ref applied);
            float after = Chance(row, row.ItemId == named, ref applied);

            before.Should().Be(after, "a magic bait names no species, so both values are false for every row");
            after.Should().Be(row.Chance);
        }
    }

    /// <summary>
    /// The engine's own arithmetic, called exactly as the reader calls it: no curiosity lure, no daily luck, no luck level,
    /// no modifiers - so the only term under test is the fifth argument.
    /// </summary>
    private static float Chance(SpawnFishData row, bool isTargetedWithBait, ref bool applied)
    {
        bool called = false;
        float chance = row.GetChance(
            hasCuriosityLure: false,
            dailyLuck: 0.0,
            luckLevel: 0,
            applyModifiers: (value, _, _) =>
            {
                called = true;
                return value;
            },
            isTargetedWithBait);
        applied |= called;
        return chance;
    }

    /// <summary>The three fixture rows. The third declares its own boost, so the table proves the boost is the ROW's.</summary>
    private static SpawnFishData[] Rows() => new[]
    {
        new SpawnFishData { ItemId = Salmon, Chance = 0.1f },
        new SpawnFishData { ItemId = Catfish, Chance = 0.05f },
        new SpawnFishData { ItemId = Legend, Chance = 0.02f, SpecificBaitMultiplier = 2f, SpecificBaitBuff = 0.05f },
    };

    /// <summary>
    /// What <c>TargetBaitSpecies</c> answers in the shipped reader: the qualified id of the species a specific bait names,
    /// or the empty string. Only the DELETED expression's arithmetic is reproduced here.
    /// </summary>
    private static string TargetSpeciesWhenBaitNames(string? species) => species ?? string.Empty;

    private string Table(string label, SpawnFishData[] rows, Func<SpawnFishData, bool> targeted)
    {
        output.WriteLine($"{label}:");
        bool applied = false;
        foreach (SpawnFishData row in rows)
            output.WriteLine(
                $"  {row.ItemId} chance {F(row.Chance)} | targeted {targeted(row)} -> {F(Chance(row, targeted(row), ref applied))}"
                + $" | x{row.SpecificBaitMultiplier.ToString(CultureInfo.InvariantCulture)} +{F(row.SpecificBaitBuff)}");
        return $"  (modifier delegate applied: {applied})";
    }

    private static string F(float value) => value.ToString("0.####", CultureInfo.InvariantCulture);
}
