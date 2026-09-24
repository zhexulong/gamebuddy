using GameBuddy.Stardew.Core.Models;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;

namespace GameBuddy.Stardew;

// Lane C: cook_recipe.
//
// Step 1 seam decision record. Anchors are the locked target-version decompiled
// source under
// ref/external/StardewValleyDecompiled/Stardew Valley/StardewValley{, .Menus,
// .Objects}; this record lives in the lane-owned partial because no Lane C
// decision-document path exists (same placement as the Lane D record).
//
// seam_decision=(a): backpack-only cooking.
//   (a) [ticked] only who.Items: the companion cooks from its own backpack, with
//       cookingRecipes validation and W-rule adjacency to a live cooking
//       station. The fridge / mini-fridge linkage is explicitly excluded.
//   (b) [rejected] fridge/mini-fridge: GameLocation.ActivateKitchen
//       (GameLocation.cs:7984) reaches the material containers only inside a
//       MultipleMutexRequest callback (:8001-8017) whose success path mounts
//       CraftingPage (:8013) and whose only release path is that menu's
//       exitFunction (request.ReleaseLocks). There is no menu-free request/
//       release of the fridge NetMutex, so a headless request would either leak
//       the lock or race the host player's fridge access (item duplication /
//       desync). Excluded per the plan's networked-container rule, not by
//       assumption.
//   (c) [rejected] seam-blocked: the backpack-only transaction is fully
//       expressible through public native data methods, so the action is not
//       blocked.
// step1_fridge=excluded (no safe MultipleMutexRequest acquisition/release
//   exists without the menu; NetworkMutex semantics belong to the formal
//   multiplayer topology gate, not this native-local slice).
//
// 1. Native seam (public data-layer transaction, no UI):
//    - CraftingRecipe.doesFarmerHaveIngredientsInInventory (CraftingRecipe.cs:159)
//      ingredient gate over the backpack when extraToCheck is empty;
//    - CraftingRecipe.createItem (CraftingRecipe.cs:196) output construction
//      (numberProducedPerCraft, and the QI_COOKING order tag);
//    - CraftingRecipe.consumeIngredients (CraftingRecipe.cs:216) consumption,
//      scanning Game1.player.Items first and only then the passed containers -
//      passing no containers therefore narrows it to the backpack;
//    - Farmer.cookedRecipe (Farmer.cs:2911) recipesCooked increment;
//    - Farmer.NotifyQuests(quest => quest.OnRecipeCrafted(recipe, crafted)) and
//      Game1.stats.checkForCookingAchievements - the vanilla recipe/quest/
//      achievement bookkeeping CraftingPage performs, which
//      fixtures/stardew/RUNBOOK.md requires an adapter to preserve;
//    - Farmer.addItemToInventory (Farmer.cs:4196) delivery.
//    The menu-only entry (GameLocation.checkAction "kitchen"/"Kitchen"
//    -> ActivateKitchen, GameLocation.cs:8730-8732 -> :7984) is never invoked:
//    ActivateKitchen has no side effect other than mounting the cooking menu.
//    target_version_note: the installed target 1.6.15.24356 (the assembly the
//    Mod compiles against) performs that bookkeeping at CraftingPage.cs:485 as
//    `NotifyQuests(quest => quest.OnRecipeCrafted(recipe, crafted))` and at
//    CraftingPage.cs:492 as cookedRecipe. The older `ref/external` 1.6 decompile
//    still shows the superseded `checkForQuestComplete(..., questType: 2)` line
//    (CraftingPage.cs:480 there) and its Farmer has no NotifyQuests at all, so
//    that file's quest-layer line numbers are indicative, not authority. This
//    record and body follow the installed target version; the integration test
//    pins the target-version members by reflection and the absence of the
//    superseded member so a rebaseline fails closed.
//
// 2. W-rule station derivation (no client-supplied coordinate):
//    the request carries only the recipe identity, so the station is derived
//    Mod-side from the live world within the vanilla interaction radius
//    (Utility.tileWithinRadiusOfPlayer(..., 1, who), GameLocation.cs:14043):
//    - a non-player tile whose Buildings "Action" property is exactly
//      "Kitchen"/"kitchen" - the vanilla kitchen-stove selector
//      (GameLocation.cs:8730-8732); or
//    - a tile holding the cookout kit (BC)278, the vanilla campfire cooking
//      trigger (Torch.checkForAction, Torch.cs:86-89).
//    No station in range -> rejected/cooking_station_not_adjacent. The kitchen
//    action tile is preferred when both are adjacent. The actor is oriented to
//    the resolved station (W-rule "face the target entity") before the
//    transaction. Vanilla entry parity: a carried object blocks the cookout kit
//    (GameLocation.cs:7569 requires who.ActiveObject == null before
//    obj.checkForAction) but not the kitchen action tile, which performAction
//    reaches independently of the carried item.
//
// 3. Rule gates (all Mod-side, game thread, fail closed):
//    - live data: the recipe must exist in CraftingRecipe.cookingRecipes. The
//      vanilla CraftingRecipe(name) constructor silently falls back to "Torch"
//      for an unknown name (CraftingRecipe.cs:93-105), so the table is checked
//      before the recipe object is built;
//    - learned: Game1.player.cookingRecipes.ContainsKey(recipe) - the same gate
//      CraftingPage uses to ghost an unlearned cooking recipe
//      (CraftingPage.cs:233);
//    - ingredients: the backpack ingredient gate above, evaluated before any
//      consumption, so no consumed-material path exists without a produced dish.
//    wire_identity=recipe_key_or_unique_space_alias: the Host/Mod opaque-arg
//    alphabet cannot carry the spaces of vanilla cooking keys ("Fried Egg"), so
//    the exact recipe key wins first, and otherwise the key with spaces replaced
//    by underscores is accepted only when it resolves to exactly one live
//    cooking recipe; zero matches is recipe_unknown and several is
//    recipe_identity_ambiguous. Both fail closed. (Lane B needs the same bridge
//    for craft_item keys.)
//
// 4. seasoning=included: CraftingPage.cs:431-448 gives a quality-0 cooked dish
//    Quality 2 and consumes one Qi Seasoning "917" when the extra ingredient is
//    available (DoesFarmerHaveAdditionalIngredientsInInventory
//    CraftingRecipe.cs:278 / ConsumeAdditionalIngredients :323 - both public
//    statics that scan player inventory first). With the fridge excluded the
//    seasoning source is narrowed to the backpack exactly like the ingredients.
//
// 5. Conservation (plan Global Constraint, source-corrected):
//    addItemToInventoryBool=false. Its success is
//    `remainder == null || remainder.Stack != item.Stack || item is SpecialItem`
//    (Farmer.cs:4317-4340), so a partial accept reports true and the remainder
//    evaporates. This body uses Farmer.addItemToInventory (Farmer.cs:4196) and
//    conveyor=Farmer.addItemToInventory+Game1.createItemDebris: a non-null
//    remainder is dropped through Game1.createItemDebris (Game1.cs:10245) at the
//    actor's standing position.
//    space_precheck=retained_but_non_aborting: the plan retains the
//    who.couldInventoryAcceptThisItem(crafted) space pre-check (Farmer.cs:4644)
//    immediately before consumption, but it must not refuse the cook. An
//    insufficient-space cook still happens in vanilla (the dish goes to the
//    menu's heldItem and Utility.CollectOrDrop drops it when the menu closes),
//    and the card's accepted conservation outcome for "backpack full and the
//    consumption frees no slot" is the dish landing on the ground, not a refusal.
//    The pre-check is therefore evidence only - it never decides the terminal,
//    because it cannot see the slots the consumption itself frees. (This is the
//    one deliberate difference from the sibling inventory_full adapters, which
//    refuse instead of producing a ground drop.)
//    disposition=inventory | dropped_on_ground | partially_dropped (always
//    present in the evidence, never a silent loss).
//
// 6. Receipt: dish_cooked on a delivery fully into the backpack, and
//    dish_cooked_dropped_on_ground on a fully dropped delivery (the plan's
//    "mark disposition: dropped_on_ground" outcome - the dish is produced,
//    counted and recoverable on the ground). A split delivery
//    (0 < delivered < crafted), where the card's "产物入包" postcondition is only
//    partially met, is PartiallySucceeded/dish_cooked_output_dropped. Every
//    other terminal is honest: recipe_unknown, recipe_not_learned,
//    recipe_identity_ambiguous, cooking_station_not_adjacent,
//    recipe_ingredients_unavailable, cooking_recipes_unavailable,
//    cook_recipe_postcondition_unavailable.
//
// 7. live evidence: pending_native_local_fixture (fixture scenario
//    native_cook_recipe_v1). Static review and unit tests are not live proof.
internal sealed partial class ExecutionManager
{
    /// <summary>
    /// Cook one learned cooking recipe from the companion's own backpack while it
    /// stands next to a live cooking station.
    ///
    /// The request carries only the opaque recipe identity, so the Mod derives
    /// and revalidates the station from the live world on the game thread, then
    /// runs the vanilla data transaction in the vanilla order:
    /// createItem -> space pre-check -> consumeIngredients (+ seasoning)
    /// -> quest/achievement/cooked-count bookkeeping -> addItemToInventory with a
    /// floor drop for any remainder. No menu path is invoked and the fridge is
    /// never touched.
    /// </summary>
    public LocalExecutionReceipt RequestLocalCookRecipe(string requestId, string expectedRecipeId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (!Context.IsWorldReady || Context.IsMultiplayer || !Game1.IsMasterGame || Game1.server is not null || Game1.player is null || Game1.getAllFarmers().Count() != 1 || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "native_local_player_required", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.activeItemPickup is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", null);

        Farmer player = Game1.player;
        GameLocation location = player.currentLocation;

        if (!TryResolveCookingRecipeId(expectedRecipeId, out string recipeId, out string recipeReason))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, recipeReason, $"recipe={expectedRecipeId}");
        if (!player.cookingRecipes.ContainsKey(recipeId))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "recipe_not_learned", $"recipe={recipeId}");

        if (!TryFindAdjacentCookingStation(location, player, out int stationX, out int stationY, out string stationKind))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "cooking_station_not_adjacent", $"recipe={recipeId};tile={(int)player.Tile.X},{(int)player.Tile.Y}");
        // Vanilla entry parity: the cookout kit is reached through
        // GameLocation.checkAction's `who.ActiveObject == null &&
        // obj.checkForAction(who)` branch (GameLocation.cs:7569), so a carried
        // object blocks that station. The kitchen Buildings-action tile is
        // reached through performAction independently of the carried item and
        // stays available with an empty or filled hand.
        if (string.Equals(stationKind, "cookout_kit", StringComparison.Ordinal) && player.ActiveObject is not null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", "active_object_held;station=cookout_kit");

        CraftingRecipe recipe = new(recipeId, isCookingRecipe: true);
        // Backpack-only ingredient gate: the null container list means no fridge /
        // mini-fridge material source is consulted (step1_fridge=excluded).
        if (!recipe.doesFarmerHaveIngredientsInInventory(null))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "recipe_ingredients_unavailable", $"recipe={recipeId};station={stationKind}@{stationX},{stationY}");

        Item crafted = recipe.createItem();
        // Retained, non-aborting space pre-check: reported as evidence to
        // corroborate the delivery surface, never used to refuse or to decide the
        // terminal (it cannot see the slots the consumption itself frees).
        bool spacePrechecked = player.couldInventoryAcceptThisItem(crafted);

        // Vanilla seasoning gate (CraftingPage.cs:431-448): a quality-0 cooked dish
        // becomes quality 2 and consumes one Qi Seasoning, backpack-only here.
        List<KeyValuePair<string, int>>? seasoning = null;
        if (crafted.Quality == 0)
        {
            List<KeyValuePair<string, int>> candidate = new() { new KeyValuePair<string, int>("917", 1) };
            if (CraftingRecipe.DoesFarmerHaveAdditionalIngredientsInInventory(candidate, null))
            {
                crafted.Quality = 2;
                seasoning = candidate;
            }
        }

        int craftedStack = crafted.Stack;
        int inventoryBefore = CountQualifiedItem(player, crafted.QualifiedItemId);
        int cookedBefore = player.recipesCooked.TryGetValue(crafted.ItemId, out int recipeCookedCount) ? recipeCookedCount : 0;
        bool menuBefore = Game1.activeClickableMenu is not null;
        player.FacingDirection = GetCardinalFacingDirectionToTile(player, stationX, stationY);

        recipe.consumeIngredients(null);
        if (seasoning is not null)
            CraftingRecipe.ConsumeAdditionalIngredients(seasoning, null);
        player.NotifyQuests(quest => quest.OnRecipeCrafted(recipe, crafted));
        player.cookedRecipe(crafted.ItemId);
        Game1.stats.checkForCookingAchievements();
        Item? remainder = player.addItemToInventory(crafted);
        if (remainder is not null && remainder.Stack > 0)
            Game1.createItemDebris(remainder, player.getStandingPosition(), player.FacingDirection);
        bool menuAfter = Game1.activeClickableMenu is not null;

        int inventoryAfter = CountQualifiedItem(player, crafted.QualifiedItemId);
        int cookedAfter = player.recipesCooked.TryGetValue(crafted.ItemId, out int cookedCountAfter) ? cookedCountAfter : 0;
        int dropped = remainder?.Stack ?? 0;
        int delivered = craftedStack - dropped;
        bool countIncremented = cookedAfter == cookedBefore + 1;
        bool deliveryObserved = inventoryAfter == inventoryBefore + delivered;
        string disposition = dropped == 0 ? "inventory" : delivered == 0 ? "dropped_on_ground" : "partially_dropped";
        ExecutionState state;
        string reasonCode;
        if (!countIncremented || !deliveryObserved || menuAfter)
        {
            state = ExecutionState.Uncertain;
            reasonCode = "cook_recipe_postcondition_unavailable";
        }
        else if (dropped == 0)
        {
            state = ExecutionState.Succeeded;
            reasonCode = "dish_cooked";
        }
        else if (delivered == 0)
        {
            state = ExecutionState.Succeeded;
            reasonCode = "dish_cooked_dropped_on_ground";
        }
        else
        {
            state = ExecutionState.PartiallySucceeded;
            reasonCode = "dish_cooked_output_dropped";
        }

        string evidence = $"location={location.NameOrUniqueName};recipe={recipeId};station={stationKind}@{stationX},{stationY};crafted={crafted.QualifiedItemId};crafted_stack={craftedStack};quality={crafted.Quality};seasoning_used={seasoning is not null};space_prechecked={spacePrechecked.ToString().ToLowerInvariant()};inventory_before={inventoryBefore};inventory_after={inventoryAfter};delivered={delivered};dropped={dropped};disposition={disposition};recipes_cooked_before={cookedBefore};recipes_cooked_after={cookedAfter};count_incremented={countIncremented.ToString().ToLowerInvariant()};native_menu_opened={(menuAfter && !menuBefore).ToString().ToLowerInvariant()};native_entry=CraftingRecipe.consumeIngredients,CraftingRecipe.ConsumeAdditionalIngredients,Farmer.NotifyQuests,Farmer.cookedRecipe,Game1.stats.checkForCookingAchievements,Farmer.addItemToInventory,Game1.createItemDebris";
        return this.RememberTerminal(requestId, executionId, state, reasonCode, evidence);
    }

    /// <summary>
    /// Resolve the wire recipe identity against the live cooking-recipe table.
    /// The exact key wins; otherwise the underscore alias of a key is accepted
    /// only when it maps to exactly one live cooking recipe, so an unknown or
    /// ambiguous identity fails closed instead of silently cooking another dish.
    /// </summary>
    private static bool TryResolveCookingRecipeId(string expectedRecipeId, out string recipeId, out string reasonCode)
    {
        if (CraftingRecipe.cookingRecipes is null)
        {
            recipeId = string.Empty;
            reasonCode = "cooking_recipes_unavailable";
            return false;
        }

        return TryResolveRecipeIdentity(CraftingRecipe.cookingRecipes.Keys, expectedRecipeId, out recipeId, out reasonCode);
    }

    /// <summary>
    /// The identity rule itself, over any live recipe-key set. Split out so the
    /// exact/alias/ambiguous/unknown semantics are provable without loading game
    /// content or mutating the static recipe table.
    /// </summary>
    internal static bool TryResolveRecipeIdentity(IEnumerable<string> liveRecipeKeys, string expectedRecipeId, out string recipeId, out string reasonCode)
    {
        recipeId = string.Empty;
        if (string.IsNullOrWhiteSpace(expectedRecipeId))
        {
            reasonCode = "recipe_unknown";
            return false;
        }
        if (liveRecipeKeys.Contains(expectedRecipeId, StringComparer.Ordinal))
        {
            recipeId = expectedRecipeId;
            reasonCode = "accepted";
            return true;
        }

        int matches = 0;
        foreach (string key in liveRecipeKeys)
        {
            if (!string.Equals(key.Replace(' ', '_'), expectedRecipeId, StringComparison.Ordinal))
                continue;
            matches++;
            recipeId = key;
        }
        if (matches == 1)
        {
            reasonCode = "accepted";
            return true;
        }
        recipeId = string.Empty;
        reasonCode = matches == 0 ? "recipe_unknown" : "recipe_identity_ambiguous";
        return false;
    }

    /// <summary>
    /// Derive the live cooking station adjacent to the actor (W-rule). Only the
    /// vanilla kitchen action tile (Buildings "Action" = Kitchen/kitchen) and the
    /// vanilla cookout kit (BC)278 count; the kitchen tile is preferred. No
    /// client-supplied coordinate is trusted.
    /// </summary>
    private static bool TryFindAdjacentCookingStation(GameLocation location, Farmer player, out int stationX, out int stationY, out string stationKind)
    {
        stationX = -1;
        stationY = -1;
        stationKind = string.Empty;
        int playerX = (int)player.Tile.X;
        int playerY = (int)player.Tile.Y;
        int cookoutKitX = -1;
        int cookoutKitY = -1;
        for (int deltaY = -1; deltaY <= 1; deltaY++)
        {
            for (int deltaX = -1; deltaX <= 1; deltaX++)
            {
                if (deltaX == 0 && deltaY == 0)
                    continue;
                int x = playerX + deltaX;
                int y = playerY + deltaY;
                string? action = location.doesTileHaveProperty(x, y, "Action", "Buildings");
                string actionToken = action is null ? string.Empty : action.Split(' ')[0];
                if (string.Equals(actionToken, "kitchen", StringComparison.Ordinal) || string.Equals(actionToken, "Kitchen", StringComparison.Ordinal))
                {
                    stationX = x;
                    stationY = y;
                    stationKind = "kitchen";
                    return true;
                }
                if (cookoutKitX < 0
                    && location.objects.TryGetValue(new Vector2(x, y), out StardewValley.Object? placed)
                    && placed.QualifiedItemId == "(BC)278")
                {
                    cookoutKitX = x;
                    cookoutKitY = y;
                }
            }
        }

        if (cookoutKitX >= 0)
        {
            stationX = cookoutKitX;
            stationY = cookoutKitY;
            stationKind = "cookout_kit";
            return true;
        }

        return false;
    }
}
