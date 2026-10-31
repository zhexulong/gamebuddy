using System.Linq;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// The guarantee that replaced the family-wide row counter in `DiscoverSeedTargets` / `DiscoverTreeSaplingTargets`,
/// and the one the chest families now use for their containers.
///
/// The counter was `result.Count &lt; 64` on both loops of a slot-outer, tile-inner scan, so the first held stack spent
/// it: 169 candidate tiles against 64 rows meant every later stack published nothing, and a companion carrying two
/// crops could only name the first one's tiles. `plant_seed` then had no address for the second crop.
///
/// Two properties fix that, and each is asserted directly: EVERY qualifying key publishes at least one row, and the
/// family total still fits the Host's `maxItems` (a longer array is not trimmed there - the whole snapshot is refused).
/// </summary>
public sealed class TargetRowBudgetTests
{
    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(4)]
    [InlineData(5)]
    [InlineData(10)]
    [InlineData(36)]
    public void EveryKeyPublishesAtLeastOneRow(int keys)
    {
        // The defect in one line: under the old counter the second stack got zero. A floor of one is what makes the
        // guarantee unconditional, and it is the reason the limit shrinks by key count rather than staying at 16.
        foreach (int ceiling in new[] { TargetRowBudget.PlanNodes, 36 })
            TargetRowBudget.PerKeyRowLimit(keys, ceiling).Should().BeGreaterThanOrEqualTo(1);
    }

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(4)]
    [InlineData(5)]
    [InlineData(10)]
    [InlineData(36)]
    public void TheFamilyStillFitsTheHostsDeclaredRowLimit(int keys)
    {
        // `SNAPSHOT_FAMILY_RULES` refuses these families over 64 entries and the refusal is the whole snapshot's, so a
        // per-key window may never multiply the family past the limit it was given.
        foreach (int ceiling in new[] { TargetRowBudget.PlanNodes, 36 })
        {
            int total = keys * TargetRowBudget.PerKeyRowLimit(keys, ceiling);
            total.Should().BeLessThanOrEqualTo(TargetRowBudget.FamilyRowLimit);
        }
    }

    [Fact]
    public void FourOrFewerKeysEachGetAFullShare()
    {
        // `64 / 4 == 16`, so the ordinary farm - one or two crops in the backpack, one or two chests in reach - keeps a
        // whole window per key. Shrinking below that would take away rows a caller can genuinely name.
        foreach (int keys in Enumerable.Range(1, 4))
        {
            TargetRowBudget.PerKeyRowLimit(keys, TargetRowBudget.PlanNodes).Should().Be(TargetRowBudget.PlanNodes);
            TargetRowBudget.PerKeyRowLimit(keys, 36).Should().Be(TargetRowBudget.PlanNodes);
        }
    }

    [Fact]
    public void AKeyWhoseOwnCeilingIsSmallerKeepsIt()
    {
        // A plantable stack's ceiling is what one plan can name, so a single held stack publishes a plan's worth rather
        // than its whole share of 64.
        TargetRowBudget.PerKeyRowLimit(1, TargetRowBudget.PlanNodes).Should().Be(TargetRowBudget.PlanNodes);
        // A container's ceiling is how many rows it can hold at all, so a lone chest publishes whole, and a wider
        // ceiling is still never allowed to exceed the family limit.
        TargetRowBudget.PerKeyRowLimit(1, 36).Should().Be(36);
        TargetRowBudget.PerKeyRowLimit(1, 1000).Should().Be(TargetRowBudget.FamilyRowLimit);
    }

    [Fact]
    public void AnEmptyFamilyFallsBackToTheCeiling()
    {
        // No qualifying key means the caller publishes nothing anyway; the value must still be a sane window rather
        // than a division by zero or a zero window that would silently stop publishing once a key appears.
        TargetRowBudget.PerKeyRowLimit(0, TargetRowBudget.PlanNodes).Should().Be(TargetRowBudget.PlanNodes);
        TargetRowBudget.PerKeyRowLimit(0, 36).Should().Be(36);
    }
}
