using System;

namespace GameBuddy.Stardew.Core;

/// <summary>
/// How many plantable rows one held inventory stack may publish.
///
/// <para>
/// The seed and sapling families budgeted rows per FAMILY, not per stack: `DiscoverSeedTargets` and
/// `DiscoverTreeSaplingTargets` walk inventory slots on the outside and tiles on the inside under one
/// `result.Count &lt; 64` guard. `TargetDiscoveryRadius` is 6, so the inner scan offers 169 tiles and the FIRST held
/// stack consumes every row: measured 2026-10-29 (`round7`), all 64 published rows came from one stack (slot 14
/// `(O)770` on 14 of 33 observations, slot 13 `(O)309` on 22 of 33). A companion carrying parsnips in slot 0 and
/// cauliflowers in slot 1 had no published cauliflower tile at all, so `plant_seed` had nothing to name - a
/// capability hole rather than a payload problem.
/// </para>
/// <para>
/// The window is one PLAN's worth, because that is the only thing a stack's rows are for: `MAX_PLAN_NODES` is 16
/// (`BodyProgramValidation.MaximumNodes`), so a plan names at most sixteen targets and a stack's seventeenth-nearest
/// tile cannot be reached by a plan that also names its nearer ones. Sixteen per stack is also what the Host already
/// publishes - `stardew-observation-budget.ts` keeps the nearest `MAX_PLAN_NODES` of each stack - so this does not
/// narrow what the model sees, it stops the Mod from spending its budget on rows the Host would discard.
/// </para>
/// <para>
/// The family total cannot grow, because <see cref="FamilyRowLimit"/> is the Host's own `maxItems` for
/// `seedTargets` and `treeSaplingTargets` (`SNAPSHOT_FAMILY_RULES`): a longer array is not trimmed, it fails
/// validation and the WHOLE snapshot is refused. So N is small enough that the stacks fit, and never more than one
/// plan can consume. Measured 6.8 KB per 64 seed rows on `round7`, so the family stays at roughly its present
/// worst case - that payload is redistributed across the held stacks instead of being spent on one.
/// </para>
/// </summary>
public static class PlantableTargetRows
{
    /// <summary>The Host's declared `maxItems` for both plantable families; exceeding it refuses the whole snapshot.</summary>
    public const int FamilyRowLimit = 64;

    /// <summary>`MAX_PLAN_NODES`: the most targets one plan can name, and so the most one stack can be asked for.</summary>
    public const int PerStackPlanNodes = 16;

    /// <summary>
    /// Rows one held stack may publish when <paramref name="heldStacks"/> stacks qualify.
    ///
    /// Shrinks only past four qualifying stacks (`64 / 4 == 16`), which keeps the ordinary farm on a full sixteen-tile
    /// window per crop while guaranteeing that a backpack full of different seeds still PARSES instead of publishing a
    /// family the Host refuses. The floor of one is what makes the guarantee unconditional: every qualifying stack
    /// publishes at least its nearest tile, however many stacks are held.
    /// </summary>
    public static int PerSlotRowLimit(int heldStacks)
    {
        if (heldStacks <= 0) return PerStackPlanNodes;
        return Math.Clamp(FamilyRowLimit / heldStacks, 1, PerStackPlanNodes);
    }
}
