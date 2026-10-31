using System;
using System.Collections.Generic;
using System.Linq;

namespace GameBuddy.Stardew.Core;

/// <summary>One inventory slot as the native capacity predicate reads it (<c>Farmer.cs:4765</c>).</summary>
public readonly record struct InventorySlot(string? ItemId, int Quality, int Stack, int MaximumStack);

/// <summary>
/// The capacity answer for one harvest: which of the qualities the roll can produce have somewhere to go.
/// </summary>
public readonly record struct HarvestCapacityVerdict(
    bool Admitted,
    IReadOnlyList<int> AdmittedQualities,
    IReadOnlyList<int> RefusedQualities);

/// <summary>
/// Whether the pack can take the crop it is about to harvest, asked over EVERY quality the roll can
/// produce rather than over one provisional item.
///
/// The admission used <c>ItemRegistry.Create(id, 1)</c>, which yields normal quality, and
/// <c>Item.canStackWith</c> refuses a different quality (<c>Item.cs:738</c>: <c>quality.Value !=
/// item.quality.Value</c>). The native harvest rolls quality from farming level and fertilizer
/// (<c>Crop.cs:562-578</c>), so a pack whose only matching stack was normal-with-headroom was admitted
/// for a gold roll it could not take, and <c>Crop.harvest</c> then refused the add
/// (<c>Crop.cs:623</c>) and only showed the red "Inventory Full" message (<c>Crop.cs:673-676</c>).
///
/// A refused Grab harvest mutates nothing: <c>destroyCrop</c> is inside <c>if (crop.harvest(...))</c>
/// (<c>HoeDirt.cs:491-498</c>), and the Grab path creates no debris (<c>createItemDebris</c> at
/// <c>Crop.cs:619</c> belongs to the Scythe branch and at <c>:699</c> to the extra-yield loop that only
/// runs once the first item was accepted). The crop survives, so the honest report is "this harvest
/// cannot be accepted", decided before the native call rather than discovered after it.
/// </summary>
public static class HarvestQualityCapacity
{
    /// <summary>
    /// The quality values the engine can assign (<c>Object.Quality</c>: 0 normal, 1 silver, 2 gold,
    /// 4 iridium). There is no quality 3, so a pack holding one can never be reached by a roll.
    /// </summary>
    private static readonly int[] EngineQualities = { 0, 1, 2, 4 };

    /// <summary>
    /// Every quality the roll for this crop can actually land on.
    ///
    /// <c>Crop.cs:578</c> finishes the roll with <c>MathHelper.Clamp(num3, data.HarvestMinQuality,
    /// data.HarvestMaxQuality)</c> over exactly the values above, so the crop's own data caps the set: a
    /// crop capped at gold can never produce iridium, and refusing it for want of an iridium slot would
    /// be refusing a quality it cannot roll. Both bounds are inclusive and ordered low-to-high.
    ///
    /// The nullable overload is the one the crop data needs: an UNSET bound is not zero. <c>Crop.cs:578</c>
    /// clamps with <c>data?.HarvestMinQuality ?? 0</c> and <c>data?.HarvestMaxQuality ?? num3</c>, so an
    /// unset minimum means "no floor" and an unset maximum means "no cap" - reading an unset maximum as
    /// 0 would collapse the set to normal quality, which is the very defect this predicate exists for.
    /// </summary>
    public static IReadOnlyList<int> ReachableQualities(int? minQuality, int? maxQuality) =>
        ReachableQualities(minQuality ?? 0, maxQuality ?? EngineQualities[^1]);

    /// <summary>
    /// The same set from explicit bounds. Callers that already hold concrete numbers use this one; the
    /// nullable overload is only the crop-data translation.
    /// </summary>
    public static IReadOnlyList<int> ReachableQualities(int minQuality, int maxQuality)
    {
        if (maxQuality < minQuality) (minQuality, maxQuality) = (maxQuality, minQuality);
        return EngineQualities
            .Select(quality => Math.Clamp(quality, minQuality, maxQuality))
            .Distinct()
            .OrderBy(quality => quality)
            .ToArray();
    }

    /// <summary>
    /// Judges the harvest against the pack, per reachable quality.
    ///
    /// The slot test is the native one (<c>Farmer.cs:4765</c>): an EMPTY slot takes any quality, and an
    /// occupied slot takes this item only at its own quality and only while <c>Stack + stack</c> still
    /// fits <c>maximumStackSize()</c>. Slots past <paramref name="maxItems"/> are not headroom, because
    /// the native loop stops there (<c>Farmer.cs:4763</c>).
    /// </summary>
    public static HarvestCapacityVerdict Evaluate(
        string itemId,
        int stack,
        int maxItems,
        IReadOnlyList<int> reachableQualities,
        IReadOnlyList<InventorySlot> pack)
    {
        var admitted = new List<int>(reachableQualities.Count);
        var refused = new List<int>(reachableQualities.Count);
        foreach (int quality in reachableQualities)
            (Accepts(pack, itemId, stack, quality, maxItems) ? admitted : refused).Add(quality);

        return new HarvestCapacityVerdict(refused.Count == 0, admitted, refused);
    }

    private static bool Accepts(IReadOnlyList<InventorySlot> pack, string itemId, int stack, int quality, int maxItems)
    {
        int limit = Math.Min(maxItems, pack.Count);
        for (int slot = 0; slot < limit; slot++)
        {
            InventorySlot held = pack[slot];
            if (held.ItemId is null)
                return true;
            if (held.Quality == quality
                && string.Equals(held.ItemId, itemId, StringComparison.Ordinal)
                && held.Stack + stack <= held.MaximumStack)
                return true;
        }
        return false;
    }
}
