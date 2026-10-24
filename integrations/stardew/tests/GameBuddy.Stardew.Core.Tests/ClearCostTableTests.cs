using System.Collections.Generic;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// The clear-cost table, in one place.
///
/// The numbers are the engine's own stamina charge plus a fixed allowance, because stamina alone does
/// not separate the cases: a scythe swing and a swing at a crop both cost nothing, so every free clear
/// would tie with every other and the search could not order them. The allowance makes the comparison
/// meaningful - "is walking around this worth less than dealing with it" - without inventing a second
/// currency.
///
/// Stamina (decompiled sources, power = 1 at base upgrade, level 0):
///   Pickaxe.cs  2 * (power + 1) - MiningLevel * 0.1      = 4
///   Axe.cs      2 * power       - ForagingLevel * 0.1    = 2
///   Hoe.cs      2 * power       - FarmingLevel * 0.1     = 2
///   Scythe      no charge                                 = 0
/// and a tool with the efficient enchantment charges nothing at all.
/// </summary>
public sealed class ClearCostTableTests
{
    [Theory]
    [InlineData("rock", 9)]
    [InlineData("stump", 7)]
    [InlineData("weed", 5)]
    [InlineData("grass", 5)]
    [InlineData("crop", 5)]
    public void TheCostIsTheEngineStaminaPlusTheAllowance(string kind, int expected)
    {
        ClearCostTable.Cost(kind, toolPower: 1, skillLevel: 0, efficient: false).Should().Be(expected);
    }

    [Fact]
    public void AnEfficientToolChargesOnlyTheAllowance()
    {
        // Efficient enchantment: `if (!isEfficient.Value) who.Stamina -= ...` is skipped entirely.
        ClearCostTable.Cost("rock", toolPower: 1, skillLevel: 0, efficient: true).Should().Be(5);
    }

    [Fact]
    public void AHigherToolPowerCostsMoreStaminaBecauseTheEngineFormulaSaysSo()
    {
        // 2 * (power + 1): power 2 charges 6, not 4. Counter-intuitive but that is the engine.
        ClearCostTable.Cost("rock", toolPower: 2, skillLevel: 0, efficient: false).Should().Be(11);
    }

    [Fact]
    public void ASkillLevelReducesTheCharge()
    {
        // MiningLevel 10 on a base pickaxe: 4 - 1.0 = 3, rounded up to 3 plus the allowance.
        ClearCostTable.Cost("rock", toolPower: 1, skillLevel: 10, efficient: false).Should().Be(8);
    }

    [Fact]
    public void SomethingThatCannotBeClearedHasNoCostAtAll()
    {
        // Water, buildings, the map edge: not in the table, and the search must treat them as walls.
        ClearCostTable.Cost("building", toolPower: 1, skillLevel: 0, efficient: false).Should().BeNull();
        ClearCostTable.Cost("water", toolPower: 1, skillLevel: 0, efficient: false).Should().BeNull();
    }

    [Fact]
    public void TheTableIsTheOneAuthorityForEveryKindTheModCanClear()
    {
        ClearCostTable.Kinds.Should().BeEquivalentTo(new[] { "rock", "stump", "weed", "grass", "crop" });
    }
}
