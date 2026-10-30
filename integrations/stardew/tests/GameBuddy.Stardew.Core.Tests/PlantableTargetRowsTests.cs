using System.Linq;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// The guarantee that replaced the family-wide row counter in `DiscoverSeedTargets` / `DiscoverTreeSaplingTargets`.
///
/// The counter was `result.Count &lt; 64` on both loops of a slot-outer, tile-inner scan, so the first held stack spent
/// it: 169 candidate tiles against 64 rows meant every later stack published nothing, and a companion carrying two
/// crops could only name the first one's tiles. `plant_seed` then had no address for the second crop.
///
/// Two properties fix that, and each is asserted directly: EVERY qualifying stack publishes at least one row, and the
/// family total still fits the Host's `maxItems` (a longer array is not trimmed there - the whole snapshot is refused).
/// </summary>
public sealed class PlantableTargetRowsTests
{
    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(4)]
    [InlineData(5)]
    [InlineData(10)]
    [InlineData(36)]
    public void EveryHeldStackPublishesAtLeastOneRow(int heldStacks)
    {
        // The defect in one line: under the old counter the second stack got zero. A floor of one is what makes the
        // guarantee unconditional, and it is the reason the limit shrinks by stack count rather than staying at 16.
        PlantableTargetRows.PerSlotRowLimit(heldStacks).Should().BeGreaterThanOrEqualTo(1);
    }

    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    [InlineData(4)]
    [InlineData(5)]
    [InlineData(10)]
    [InlineData(36)]
    public void TheFamilyStillFitsTheHostsDeclaredRowLimit(int heldStacks)
    {
        // `SNAPSHOT_FAMILY_RULES` refuses `seedTargets`/`treeSaplingTargets` over 64 entries and the refusal is the
        // whole snapshot's, so a per-stack window may never multiply the family past the limit it was given.
        int total = heldStacks * PlantableTargetRows.PerSlotRowLimit(heldStacks);

        total.Should().BeLessThanOrEqualTo(PlantableTargetRows.FamilyRowLimit);
    }

    [Fact]
    public void FourOrFewerStacksEachGetAFullPlanWorth()
    {
        // `64 / 4 == 16`, so the ordinary farm - one or two crops in the backpack - keeps a whole `MAX_PLAN_NODES`
        // window per stack. Shrinking below that would take away rows a plan can genuinely name.
        foreach (int heldStacks in Enumerable.Range(1, 4))
            PlantableTargetRows.PerSlotRowLimit(heldStacks).Should().Be(PlantableTargetRows.PerStackPlanNodes);
    }

    [Fact]
    public void NoStackEverGetsMoreThanOnePlanCanName()
    {
        // A stack's window is one plan's worth because that is the only thing its rows are for: `MAX_PLAN_NODES` is 16,
        // so a seventeenth-nearest tile cannot be reached by a plan that also names the nearer ones. The Host already
        // publishes only the nearest sixteen per stack, so a wider window here would be spent on rows it discards.
        foreach (int heldStacks in Enumerable.Range(1, 36))
            PlantableTargetRows.PerSlotRowLimit(heldStacks).Should().BeLessThanOrEqualTo(PlantableTargetRows.PerStackPlanNodes);
    }

    [Fact]
    public void AnEmptyBackpackFallsBackToTheFullWindow()
    {
        // No qualifying stack means the caller publishes nothing anyway; the value must still be a sane window rather
        // than a division by zero or a zero window that would silently stop publishing once a seed is picked up.
        PlantableTargetRows.PerSlotRowLimit(0).Should().Be(PlantableTargetRows.PerStackPlanNodes);
    }
}
