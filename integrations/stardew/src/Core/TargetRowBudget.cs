using System;

namespace GameBuddy.Stardew.Core;

/// <summary>
/// How many rows one key of a cross-product target family may publish.
///
/// <para>
/// A family whose rows pair two independently-sized sets - a held stack against the tiles it could be planted on, a
/// container against the pack slots or chest items it could move - must publish some of each key or the family
/// answers a question it was not asked. The seed and sapling families budgeted rows per FAMILY, not per stack:
/// `DiscoverSeedTargets` and `DiscoverTreeSaplingTargets` walked inventory slots on the outside and tiles on the
/// inside under one `result.Count &lt; 64` guard, so the FIRST held stack consumed every row. Measured 2026-10-29
/// (`round7`): all 64 published rows came from one stack (slot 14 `(O)770` on 14 of 33 observations, slot 13
/// `(O)309` on 22 of 33). A companion carrying parsnips in slot 0 and cauliflowers in slot 1 had no published
/// cauliflower tile at all, so `plant_seed` had nothing to name - a capability hole rather than a payload problem.
/// The chest families had the same shape one level down: one pack slot for every container, one chest item for
/// every container.
/// </para>
/// <para>
/// The window is the family's row limit SHARED across its keys, so a longer array can never be published: a family
/// over the Host's declared `maxItems` is not trimmed there, the whole snapshot is refused. The floor of one is what
/// makes the guarantee unconditional - every qualifying key publishes at least its first row, however many there
/// are.
/// </para>
/// <para>
/// The per-key ceiling is the caller's, because it belongs to the key, not to the budget: a plantable stack is
/// bounded by what one plan can name, while a container is bounded by how many rows it can hold at all.
/// </para>
/// </summary>
public static class TargetRowBudget
{
    /// <summary>
    /// The Host's declared `maxItems` for the plantable and chest families (`SNAPSHOT_FAMILY_RULES`); exceeding it
    /// refuses the whole snapshot.
    /// </summary>
    public const int FamilyRowLimit = 64;

    /// <summary>
    /// `MAX_PLAN_NODES`: the most targets one plan can name, and so the most rows one plan can consume from one key.
    /// </summary>
    public const int PlanNodes = 16;

    /// <summary>
    /// Rows one key may publish when <paramref name="keys"/> keys qualify, never more than
    /// <paramref name="perKeyCeiling"/> and never more than a plan can name.
    ///
    /// Shrinks only past four keys (`64 / 4 == 16`), so the ordinary case keeps a full window per key while a family
    /// full of keys still PARSES instead of being refused. A key whose own ceiling is already smaller than its share
    /// (`perKeyCeiling`) keeps that ceiling.
    ///
    /// <para>
    /// THE PLAN CEILING IS NOT NEGOTIABLE BY THE CALLER. This method was generalised from
    /// `PerSlotRowLimit(int heldStacks) return Math.Clamp(FamilyRowLimit / heldStacks, 1, PerStackPlanNodes)`, and the
    /// generalisation replaced the fixed `PerStackPlanNodes` cap with the caller's `perKeyCeiling` - so the chest family,
    /// which passes 36 for a 36-slot backpack, would publish up to 36 pairs for ONE container. A plan can name at most
    /// `PlanNodes`, so rows past that are targets no caller can echo, and they cost the window every other container
    /// needed. Measured 2026-10-31: `PerKeyRowLimit(1, 36)` returned 36 where the pre-generalisation code returned 16.
    /// </para>
    /// </summary>
    public static int PerKeyRowLimit(int keys, int perKeyCeiling)
    {
        int ceiling = Math.Clamp(perKeyCeiling, 1, PlanNodes);
        if (keys <= 0) return ceiling;
        return Math.Clamp(FamilyRowLimit / keys, 1, ceiling);
    }
}
