using System;
using System.Collections.Generic;
using System.Linq;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Menus;
using StardewValley.Objects;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    /// <summary>The game's own context tag for the recipe table's FIRST ingredient (the cloth).</summary>
    private const string TailoringFixtureClothTag = "item_cloth";

    /// <summary>How many of each ingredient the fixture grants, so one act leaves the slots usable.</summary>
    private const int TailoringFixtureStack = 3;

    /// <summary>Bound on each registry scan, so a content set with no usable pair fails loudly rather than hanging.</summary>
    private const int TailoringFixtureScanBudget = 512;

    /// <summary>
    /// The tailoring lane's pre-attachment Given (scenario <c>native_tailoring_v1</c>): the
    /// actor's own backpack holds one cloth, one reagent the game's OWN recipe table pairs with
    /// that cloth, one dyeable garment and one colour-bearing dye item. Nothing else is
    /// established — no world tile is touched and the actor is not moved, because both actions are
    /// backpack transactions.
    ///
    /// The Given is DERIVED from the game rather than hardcoded, and asserted through the PRODUCT's
    /// OWN predicate so the two cannot disagree:
    ///   * the cloth is the first registered object whose own context tags carry
    ///     <c>item_cloth</c>, the tag <c>Data/TailoringRecipes</c> uses for the first slot;
    ///   * the reagent is the first registered object the product's own
    ///     <c>ExecutionManager.ClassifyTailoringPair</c> (i.e. <c>TailoringMenu.GetRecipeForItems</c>)
    ///     accepts beside that cloth as a RECIPE pair;
    ///   * the garment is the first shirt/pants whose own <c>dyeable</c> flag is true, and the dye
    ///     item is the first registered object the same predicate classifies as a DYE pair beside
    ///     it (which is exactly <c>TailoringMenu.GetDyeColor(item) != null</c>).
    /// A content set that cannot supply any of those fails HERE, with a named error that says where
    /// the fixture looked and what rejected the candidates, instead of surfacing later as a product
    /// refusal with no Given behind it.
    ///
    /// Each ingredient is granted with stack 3 on purpose: one act consumes exactly one, so BOTH
    /// named slots still hold the same item afterwards and the live run can resubmit the same
    /// request with a wrong target id and be refused for THAT reason rather than for an emptied
    /// slot.
    /// </summary>
    private void InstallNativeLocalTailoringFixture(Farmer player, GameLocation farm)
    {
        if (player is null)
            throw new InvalidOperationException("fixture_native_local_tailoring_player_missing");

        // The fixture's own view of the recipe table: the SAME loader the product's menu uses
        // (`DataLoader.TailoringRecipes`, TailoringMenu.cs:133), reached through the game's own
        // construction, so the Given is derived from the content the action will read.
        TailoringMenu menu = new();

        IReadOnlyList<string> objectIds = ItemRegistry.GetObjectTypeDefinition().GetAllIds()
            .OrderBy(id => id, StringComparer.Ordinal)
            .ToArray();

        StardewValley.Object? cloth = null;
        int clothScanned = 0;
        foreach (string id in objectIds)
        {
            if (clothScanned++ >= TailoringFixtureScanBudget) break;
            if (ItemRegistry.Create<StardewValley.Object>(id) is not StardewValley.Object candidate) continue;
            if (!candidate.HasContextTag(TailoringFixtureClothTag)) continue;
            if (candidate.maximumStackSize() < TailoringFixtureStack) continue;
            cloth = candidate;
            break;
        }
        if (cloth is null)
            throw new InvalidOperationException($"fixture_native_local_tailoring_cloth_missing:source=ItemRegistry.(O).GetAllIds();tag={TailoringFixtureClothTag};scanned={clothScanned};stack_required={TailoringFixtureStack}");

        StardewValley.Object? reagent = null;
        int reagentScanned = 0;
        foreach (string id in objectIds)
        {
            if (reagentScanned++ >= TailoringFixtureScanBudget) break;
            if (ItemRegistry.Create<StardewValley.Object>(id) is not StardewValley.Object candidate) continue;
            if (candidate.QualifiedItemId == cloth.QualifiedItemId) continue;
            if (candidate.maximumStackSize() < TailoringFixtureStack) continue;
            if (!string.Equals(ExecutionManager.ClassifyTailoringPair(menu, cloth, candidate, out _), ExecutionManager.TailoringRecipeKind, StringComparison.Ordinal))
                continue;
            reagent = candidate;
            break;
        }
        if (reagent is null)
            throw new InvalidOperationException($"fixture_native_local_tailoring_reagent_missing:left={cloth.QualifiedItemId};source=ItemRegistry.(O).GetAllIds();predicate=ExecutionManager.ClassifyTailoringPair;scanned={reagentScanned}");

        Clothing? garment = null;
        int garmentScanned = 0;
        foreach (string typeId in new[] { "(S)", "(P)" })
        {
            foreach (string id in (ItemRegistry.GetTypeDefinition(typeId)?.GetAllIds() ?? Array.Empty<string>()).OrderBy(value => value, StringComparer.Ordinal))
            {
                if (garmentScanned++ >= TailoringFixtureScanBudget) break;
                if (garment is not null) break;
                if (ItemRegistry.Create(id) is Clothing candidate && candidate.dyeable.Value)
                    garment = candidate;
            }
            if (garment is not null) break;
        }
        if (garment is null)
            throw new InvalidOperationException($"fixture_native_local_tailoring_garment_missing:source=ItemRegistry.(S)+(P).GetAllIds();predicate=Clothing.dyeable;scanned={garmentScanned}");

        StardewValley.Object? dye = null;
        int dyeScanned = 0;
        foreach (string id in objectIds)
        {
            if (dyeScanned++ >= TailoringFixtureScanBudget) break;
            if (ItemRegistry.Create<StardewValley.Object>(id) is not StardewValley.Object candidate) continue;
            if (candidate.QualifiedItemId == cloth.QualifiedItemId || candidate.QualifiedItemId == reagent.QualifiedItemId) continue;
            if (candidate.maximumStackSize() < TailoringFixtureStack) continue;
            if (!string.Equals(ExecutionManager.ClassifyTailoringPair(menu, garment, candidate, out _), ExecutionManager.TailoringDyeKind, StringComparison.Ordinal))
                continue;
            dye = candidate;
            break;
        }
        if (dye is null)
            throw new InvalidOperationException($"fixture_native_local_tailoring_dye_missing:garment={garment.QualifiedItemId};source=ItemRegistry.(O).GetAllIds();predicate=TailoringMenu.GetDyeColor;scanned={dyeScanned}");

        // The four Givens, each granted one at a time so an inventory failure names WHICH item could
        // not be placed rather than reporting an anonymous "the fixture failed". Any stack the save
        // already carried under the same id is cleared first: the native add MERGES into an existing
        // stack, and a merged grant would leave the fixture reading back an instance that is no
        // longer in the pack, which is not the Given it declared.
        foreach (string staleId in new[] { cloth.QualifiedItemId, reagent.QualifiedItemId, garment.QualifiedItemId, dye.QualifiedItemId })
        {
            foreach (Item stale in player.Items.Where(item => item is not null && item.QualifiedItemId == staleId).ToArray())
                player.removeItemFromInventory(stale);
        }
        cloth.Stack = TailoringFixtureStack;
        if (player.addItemToInventory(cloth) is not null)
            throw new InvalidOperationException($"fixture_native_local_tailoring_cloth_inventory_full:item={cloth.QualifiedItemId}");
        reagent.Stack = TailoringFixtureStack;
        if (player.addItemToInventory(reagent) is not null)
            throw new InvalidOperationException($"fixture_native_local_tailoring_reagent_inventory_full:item={reagent.QualifiedItemId}");
        if (player.addItemToInventory(garment) is not null)
            throw new InvalidOperationException($"fixture_native_local_tailoring_garment_inventory_full:item={garment.QualifiedItemId}");
        dye.Stack = TailoringFixtureStack;
        if (player.addItemToInventory(dye) is not null)
            throw new InvalidOperationException($"fixture_native_local_tailoring_dye_inventory_full:item={dye.QualifiedItemId}");

        // Read the Given back the same way the product reads a request's slots, and re-run the
        // product's own classifier over the items as they now sit in the pack: a fixture that
        // silently placed something else cannot arm.
        if (!ExecutionManager.TryReadTailoringSlot(player, player.Items.IndexOf(cloth), out Item heldCloth) || !ReferenceEquals(heldCloth, cloth))
            throw new InvalidOperationException($"fixture_native_local_tailoring_cloth_missing_after_add:item={cloth.QualifiedItemId}");
        if (!ExecutionManager.TryReadTailoringSlot(player, player.Items.IndexOf(reagent), out Item heldReagent) || !ReferenceEquals(heldReagent, reagent))
            throw new InvalidOperationException($"fixture_native_local_tailoring_reagent_missing_after_add:item={reagent.QualifiedItemId}");
        if (!ExecutionManager.TryReadTailoringSlot(player, player.Items.IndexOf(garment), out Item heldGarment) || !ReferenceEquals(heldGarment, garment))
            throw new InvalidOperationException($"fixture_native_local_tailoring_garment_missing_after_add:item={garment.QualifiedItemId}");
        if (!ExecutionManager.TryReadTailoringSlot(player, player.Items.IndexOf(dye), out Item heldDye) || !ReferenceEquals(heldDye, dye))
            throw new InvalidOperationException($"fixture_native_local_tailoring_dye_missing_after_add:item={dye.QualifiedItemId}");
        if (!string.Equals(ExecutionManager.ClassifyTailoringPair(menu, heldCloth, heldReagent, out _), ExecutionManager.TailoringRecipeKind, StringComparison.Ordinal)
            || !string.Equals(ExecutionManager.ClassifyTailoringPair(menu, heldGarment, heldDye, out _), ExecutionManager.TailoringDyeKind, StringComparison.Ordinal))
            throw new InvalidOperationException($"fixture_native_local_tailoring_given_not_actionable:cloth={heldCloth.QualifiedItemId};reagent={heldReagent.QualifiedItemId};garment={heldGarment.QualifiedItemId};dye={heldDye.QualifiedItemId}");

        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log(
            "GameBuddy native-local-player initialized tailoring precondition before bridge attachment: "
                + $"location={farm?.NameOrUniqueName ?? "unknown"};"
                + $"cloth={heldCloth.QualifiedItemId}@{player.Items.IndexOf(cloth)}x{heldCloth.Stack};"
                + $"reagent={heldReagent.QualifiedItemId}@{player.Items.IndexOf(reagent)}x{heldReagent.Stack};"
                + $"garment={heldGarment.QualifiedItemId}@{player.Items.IndexOf(garment)}x{heldGarment.Stack};"
                + $"dye={heldDye.QualifiedItemId}@{player.Items.IndexOf(dye)}x{heldDye.Stack};"
                + "production alone drives the sewing machine and emits the receipt.",
            LogLevel.Info);
    }
}
