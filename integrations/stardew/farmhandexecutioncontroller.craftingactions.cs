using System.Globalization;
using System.Text;
using GameBuddy.Stardew.Core.Models;
using StardewModdingAPI;
using StardewValley;

namespace GameBuddy.Stardew;

// Lane B: craft_item. Loop-closure W0a froze this cross-lane signature and routed
// the action through MachineAndAnimalActionHandler; this partial owns the body.
//
// Step 1 seam decision (recorded here because Lane B's card owns no separate
// decision-record path; CraftItemActionTests pins this text and the anchors):
//
// seam_decision=backpack recipe transaction, no CraftingPage, no heldItem.
//   - learned gate: Game1.player.craftingRecipes.ContainsKey(name). The dictionary
//     value is the crafted count, so the key's presence is the learned fact
//     (CraftingPage.cs:112-118 builds its display list from exactly that key set).
//   - ingredient gate: CraftingRecipe.doesFarmerHaveIngredientsInInventory()
//     (CraftingRecipe.cs:159) over Game1.player.Items only, and
//     consumeIngredients(null) (CraftingRecipe.cs:216) is called with no additional
//     material containers, so no fridge/chest and therefore no
//     MultipleMutexRequest is ever touched by this action.
//   - product: CraftingRecipe.createItem() (CraftingRecipe.cs:196), native and pure.
//   - conservation: addItemToInventoryBool is BANNED here. Its success test is
//     `remainder == null || remainder.Stack != item.Stack || item is SpecialItem`
//     (Farmer.cs:4335), so a partial add returns true and the rest silently
//     vanishes. Instead: Item remainder = Game1.player.addItemToInventory(crafted)
//     (Farmer.cs:4196); a remainder goes to the ground through the native
//     Game1.createItemDebris(remainder, getStandingPosition(), FacingDirection)
//     (Game1.cs:10245) and the receipt reports disposition dropped_on_ground.
//   - count: Game1.player.craftingRecipes[name] += recipe.numberProducedPerCraft
//     (CraftingPage.cs:481-484).
//   - heldItem route excluded: CraftingPage.cs:449 parks the product on the page
//     field, which only returns to the player through the gamepad auto-add
//     (CraftingPage.cs:494-497) or emergencyShutDown -> Utility.CollectOrDrop, so
//     the product would leave this action's receipt governance.
//   - declared differences from the menu handler: CraftingPage also runs
//     checkForQuestComplete(..., questType: 2) (:480) and
//     checkForCraftingAchievements() (:492). Those are terminal settlement
//     callbacks outside this action's receipt, so craft_item performs neither; the
//     native count increment itself stays the stat source (Stats.cs:1018-1047
//     recomputes itemsCrafted from craftingRecipes).
//   - topology: the same native-local single-player gate as the sibling actions.
//     The product is created before ingredients are consumed, then the ingredients
//     are consumed, then the product enters the inventory, so no reachable path can
//     consume materials without a product in hand.
internal sealed partial class ExecutionManager
{
    /// <summary>
    /// One bounded native recipe transaction for a learned crafting recipe: the
    /// exact recipe's ingredients leave the backpack, the exact product enters it
    /// (or lands on the ground as native debris when it does not fit), and the
    /// crafted count increments. No menu, no dialogue, and no heldItem is used.
    /// </summary>
    public LocalExecutionReceipt RequestLocalCraftItem(string requestId, string expectedRecipeId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (!Context.IsWorldReady || Context.IsMultiplayer || !Game1.IsMasterGame || Game1.server is not null || Game1.player is null || Game1.getAllFarmers().Count() != 1 || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "native_local_player_required", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove || Game1.player.UsingTool || Game1.player.toolPower.Value != 0)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.activeItemPickup is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", null);

        Dictionary<string, string>? craftingTable = CraftingRecipe.craftingRecipes;
        // wire_identity=recipe_key_or_unique_space_alias: the Host/Mod opaque-arg
        // alphabet carries no spaces, but many vanilla crafting keys have them
        // ("Wood Fence"). Accept the exact key first, then the key with spaces
        // replaced by underscores only when it resolves to exactly one live
        // recipe; an ambiguous alias fails closed instead of crafting a
        // different item. Shared with cook_recipe so the rule cannot drift.
        if (craftingTable is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "craft_recipe_unknown", $"recipe={expectedRecipeId}");
        if (!TryResolveRecipeIdentity(craftingTable.Keys, expectedRecipeId, out string recipeId, out string recipeReason))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, recipeReason == "recipe_unknown" ? "craft_recipe_unknown" : recipeReason, $"recipe={expectedRecipeId}");
        if (!Game1.player.craftingRecipes.ContainsKey(recipeId))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "craft_recipe_not_learned", $"recipe={recipeId}");

        CraftingRecipe recipe = new(recipeId, isCookingRecipe: false);
        // The native constructor silently falls back to "Torch" for an unknown
        // key; never let that fallback produce an unattributable recipe.
        if (!string.Equals(recipe.name, recipeId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "craft_recipe_unknown", $"recipe={recipeId}");
        if (!recipe.doesFarmerHaveIngredientsInInventory())
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "craft_ingredients_missing", $"recipe={recipeId};ingredient_count={recipe.recipeList.Count}");

        Item crafted = recipe.createItem();
        if (crafted is null || crafted.Stack < 1 || string.IsNullOrWhiteSpace(crafted.QualifiedItemId))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "craft_output_unavailable", $"recipe={recipeId}");

        GameLocation location = Game1.player.currentLocation;
        int producedStack = crafted.Stack;
        int craftCountBefore = Game1.player.craftingRecipes[recipeId];
        int debrisBefore = CountCraftOutputDebris(location, crafted.QualifiedItemId);
        // Every ingredient measurement is taken from the live backpack with the
        // native CraftingRecipe.ItemMatchesForCrafting rule, so category numbers
        // and the wild-seed special rule count exactly as the native code does.
        Dictionary<string, int> ingredientsBefore = recipe.recipeList.Keys
            .ToDictionary(key => key, key => CountCraftingIngredient(Game1.player, key), StringComparer.Ordinal);
        // Recorded, never a gate: rejecting on a full inventory would make the
        // required ground-drop path unreachable, and consuming the ingredients may
        // free the very slot the product needs.
        bool inventoryAcceptingBefore = Game1.player.couldInventoryAcceptThisItem(crafted);
        Game1.player.GetItemReceiveBehavior(crafted, out bool needsInventorySpace, out _);
        bool menuBefore = Game1.activeClickableMenu is not null;

        recipe.consumeIngredients(null);
        // Measured after the native consumption and before the product is added.
        // A recipe may list its own product as an ingredient (the wild-seed
        // recipes do), and the product may also match an ingredient key through
        // the category/special rules; both make a post-add count ambiguous.
        Dictionary<string, int> ingredientsAfter = recipe.recipeList.Keys
            .ToDictionary(key => key, key => CountCraftingIngredient(Game1.player, key), StringComparer.Ordinal);
        int producedCountBeforeAdd = CountCraftingIngredient(Game1.player, crafted.QualifiedItemId);

        Item? remainder = Game1.player.addItemToInventory(crafted);
        int remainingStack = needsInventorySpace ? remainder?.Stack ?? 0 : 0;
        if (remainder is not null && needsInventorySpace)
            Game1.createItemDebris(remainder, Game1.player.getStandingPosition(), Game1.player.FacingDirection);
        if (Game1.player.craftingRecipes.ContainsKey(recipe.name))
            Game1.player.craftingRecipes[recipe.name] += recipe.numberProducedPerCraft;

        int craftCountAfter = Game1.player.craftingRecipes.TryGetValue(recipeId, out int craftedCountAfter) ? craftedCountAfter : 0;
        int producedCountAfterAdd = CountCraftingIngredient(Game1.player, crafted.QualifiedItemId);
        int inventoryGained = producedCountAfterAdd - producedCountBeforeAdd;
        int debrisAfter = CountCraftOutputDebris(location, crafted.QualifiedItemId);
        bool menuAfter = Game1.activeClickableMenu is not null;

        bool materialsConsumedExactly = ingredientsAfter.All(pair => pair.Value == ingredientsBefore[pair.Key] - recipe.recipeList[pair.Key]);
        // Independent expectations: Farmer.addItemToInventory reports what it left
        // out through its remainder, and the native receive behaviour says whether
        // the product was expected to occupy a backpack slot at all. Only then is
        // the measured backpack delta compared against them.
        bool inventoryPostcondition = needsInventorySpace
            ? inventoryGained == producedStack - remainingStack
            : inventoryGained == 0;
        bool countPostcondition = craftCountAfter == craftCountBefore + recipe.numberProducedPerCraft;
        bool droppedToGround = remainingStack == 0 || debrisAfter == debrisBefore + 1;
        string disposition = !needsInventorySpace
            ? "granted_without_inventory_space"
            : inventoryGained >= producedStack ? "added_to_inventory"
            : inventoryGained > 0 ? "partially_dropped_on_ground"
            : "dropped_on_ground";
        string evidence = string.Create(CultureInfo.InvariantCulture,
            $"location={location.NameOrUniqueName};recipe={recipeId};output={crafted.QualifiedItemId};produced_stack={producedStack};produced_per_craft={recipe.numberProducedPerCraft};disposition={disposition};inventory_gained_stack={inventoryGained};dropped_stack={remainingStack};inventory_accepting_before={inventoryAcceptingBefore.ToString().ToLowerInvariant()};materials_consumed_exactly={materialsConsumedExactly.ToString().ToLowerInvariant()};inventory_postcondition={inventoryPostcondition.ToString().ToLowerInvariant()};count_before={craftCountBefore};count_after={craftCountAfter};count_postcondition={countPostcondition.ToString().ToLowerInvariant()};ingredients={FormatIngredientDeltas(recipe, ingredientsBefore, ingredientsAfter)};dropped_debris={debrisAfter - debrisBefore};native_menu_opened={(menuAfter && !menuBefore).ToString().ToLowerInvariant()}");

        if (!materialsConsumedExactly || !inventoryPostcondition || !countPostcondition || !droppedToGround || menuAfter)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "crafted_item_postcondition_unavailable", evidence);
        if (remainingStack == 0)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "crafted_item_created", evidence);
        // The craft happened and the product exists (backpack and/or ground), but
        // part or all of it did not enter the backpack: never report a full success.
        return this.RememberTerminal(requestId, executionId, ExecutionState.PartiallySucceeded, "crafted_item_created", evidence);
    }

    /// <summary>Native ingredient matching parity for one recipe key (item id, category number, or wild-seed rule).</summary>
    private static int CountCraftingIngredient(Farmer player, string ingredientKey)
    {
        int total = 0;
        for (int slot = 0; slot < player.Items.Count; slot++)
        {
            Item? item = player.Items[slot];
            if (item is not null && CraftingRecipe.ItemMatchesForCrafting(item, ingredientKey))
                total += item.Stack;
        }
        return total;
    }

    private static int CountCraftOutputDebris(GameLocation location, string qualifiedItemId)
    {
        int count = 0;
        for (int index = 0; index < location.debris.Count; index++)
        {
            Debris debris = location.debris[index];
            if (debris.item is not null && string.Equals(debris.item.QualifiedItemId, qualifiedItemId, StringComparison.Ordinal))
                count++;
        }
        return count;
    }

    private static string FormatIngredientDeltas(CraftingRecipe recipe, IReadOnlyDictionary<string, int> before, IReadOnlyDictionary<string, int> after)
    {
        StringBuilder builder = new();
        foreach (string key in recipe.recipeList.Keys.OrderBy(key => key, StringComparer.Ordinal))
        {
            if (builder.Length > 0)
                builder.Append('|');
            builder.Append(key).Append(':').Append(before[key]).Append('>').Append(after[key]);
        }
        return builder.Length == 0 ? "none" : builder.ToString();
    }
}
