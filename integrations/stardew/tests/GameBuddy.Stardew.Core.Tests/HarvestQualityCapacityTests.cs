using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// Whether a pack can take the crop it is about to harvest, asked over every quality the roll can produce.
///
/// The harvest admission asked this with one PROVISIONAL item built by
/// <c>ItemRegistry.Create(id, 1)</c>, which is always normal quality, and
/// <c>Item.canStackWith</c> refuses a different quality (<c>Item.cs:738</c>). The native harvest rolls
/// quality from farming level and fertilizer (<c>Crop.cs:562-578</c>), so a pack holding a normal stack
/// with headroom was admitted for a roll that lands gold, and <c>Crop.harvest</c> answered by refusing
/// the add and showing the red "Inventory Full" message (<c>Crop.cs:623</c>, <c>:673-676</c>).
///
/// The predicate below is the native one (<c>Farmer.cs:4765</c>) read over a SET of qualities instead of
/// the single one the probe happened to construct: an empty slot takes anything, a stack takes only its
/// own item id at its own quality and only while it has room.
/// </summary>
public sealed class HarvestQualityCapacityTests
{
    private const string Parsnip = "(O)24";
    private const string Stone = "(O)390";

    private static InventorySlot Slot(string? id, int quality, int stack, int maximum = 999) =>
        new(id, quality, stack, maximum);

    [Fact]
    public void AnEmptySlotTakesEveryQualityTheRollCanProduce()
    {
        HarvestCapacityVerdict verdict = HarvestQualityCapacity.Evaluate(
            Parsnip,
            stack: 1,
            maxItems: 12,
            reachableQualities: HarvestQualityCapacity.ReachableQualities(0, 4),
            pack: new[] { Slot(null, 0, 0) });

        verdict.Admitted.Should().BeTrue();
        verdict.RefusedQualities.Should().BeEmpty();
    }

    [Fact]
    public void AFullPackWhoseOnlyParsnipStackHasHeadroomStillRefusesAGoldRoll()
    {
        // THE DEFECT. One parsnip stack at normal quality with room, every other slot full of a
        // different item: the quality-0 probe answered "acceptable" and the native gold roll then
        // failed, which the postcondition reported as Uncertain. Gold is reachable, so it is refused.
        InventorySlot[] pack =
        {
            Slot(Parsnip, quality: 0, stack: 1),
            Slot(Stone, quality: 0, stack: 999),
            Slot(Stone, quality: 0, stack: 999),
        };

        HarvestCapacityVerdict verdict = HarvestQualityCapacity.Evaluate(
            Parsnip,
            stack: 1,
            maxItems: 3,
            reachableQualities: HarvestQualityCapacity.ReachableQualities(0, 4),
            pack: pack);

        verdict.Admitted.Should().BeFalse("a gold or iridium roll has no stack that would take it");
        verdict.AdmittedQualities.Should().Equal(0);
        verdict.RefusedQualities.Should().Equal(1, 2, 4);
    }

    [Fact]
    public void AStackWithHeadroomAtEveryReachableQualityAdmitsTheHarvest()
    {
        // Four stacks of the same parsnip, one per quality, each with room: every outcome of the roll
        // has somewhere to go, so the native add cannot be refused.
        InventorySlot[] pack =
        {
            Slot(Parsnip, quality: 0, stack: 1),
            Slot(Parsnip, quality: 1, stack: 1),
            Slot(Parsnip, quality: 2, stack: 1),
            Slot(Parsnip, quality: 4, stack: 1),
        };

        HarvestCapacityVerdict verdict = HarvestQualityCapacity.Evaluate(
            Parsnip,
            stack: 1,
            maxItems: 4,
            reachableQualities: HarvestQualityCapacity.ReachableQualities(0, 4),
            pack: pack);

        verdict.Admitted.Should().BeTrue();
        verdict.RefusedQualities.Should().BeEmpty();
    }

    [Fact]
    public void AFullSameQualityStackIsNotHeadroom()
    {
        // A stack at the item's maximum is full even though its quality matches: `Items[i].Stack + stack
        // <= maximumStackSize()` is the native test (Farmer.cs:4765), not "the id matched".
        InventorySlot[] pack = { Slot(Parsnip, quality: 0, stack: 999, maximum: 999) };

        HarvestCapacityVerdict verdict = HarvestQualityCapacity.Evaluate(
            Parsnip,
            stack: 1,
            maxItems: 1,
            reachableQualities: HarvestQualityCapacity.ReachableQualities(0, 4),
            pack: pack);

        verdict.Admitted.Should().BeFalse();
        verdict.AdmittedQualities.Should().BeEmpty();
    }

    [Fact]
    public void SlotsPastMaxItemsDoNotCount()
    {
        // `for (int i = 0; i < maxItems.Value; i++)` (Farmer.cs:4763): an empty slot the actor cannot
        // actually use is not headroom.
        InventorySlot[] pack = { Slot(Stone, quality: 0, stack: 999), Slot(null, 0, 0) };

        HarvestCapacityVerdict verdict = HarvestQualityCapacity.Evaluate(
            Parsnip,
            stack: 1,
            maxItems: 1,
            reachableQualities: HarvestQualityCapacity.ReachableQualities(0, 4),
            pack: pack);

        verdict.Admitted.Should().BeFalse();
    }

    [Fact]
    public void AFertilizerCappedCropCannotRefuseAQualityItCannotRoll()
    {
        // `HarvestMaxQuality` clamps the roll (Crop.cs:578), so a crop capped at gold never produces
        // iridium and an iridium-only shortage must not refuse it.
        HarvestQualityCapacity.ReachableQualities(0, 2).Should().Equal(0, 1, 2);

        HarvestCapacityVerdict verdict = HarvestQualityCapacity.Evaluate(
            Parsnip,
            stack: 1,
            maxItems: 2,
            reachableQualities: HarvestQualityCapacity.ReachableQualities(0, 2),
            pack: new[] { Slot(null, 0, 0), Slot(Stone, quality: 0, stack: 999) });

        verdict.Admitted.Should().BeTrue();
    }

    [Fact]
    public void ReachableQualitiesUseTheEnginesOwnFourValuesAndNeverAThree()
    {
        // Object.Quality is 0 normal, 1 silver, 2 gold, 4 iridium: there is no quality 3, so a pack
        // holding a "3" could never be reached and must not appear in the reachable set.
        HarvestQualityCapacity.ReachableQualities(0, 4).Should().Equal(0, 1, 2, 4);
        HarvestQualityCapacity.ReachableQualities(0, 4).Should().NotContain(3);
    }

    [Fact]
    public void AMinimumQualityFloorRaisesTheLowestReachableQuality()
    {
        // `HarvestMinQuality` raises the floor of the same clamp (Crop.cs:578).
        HarvestQualityCapacity.ReachableQualities(2, 4).Should().Equal(2, 4);
    }
}
