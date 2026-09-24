using System.Reflection;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Routing;
using GameBuddy.Stardew.Handlers;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Lane C: cook_recipe contract pins and the Step-1 seam decision.
///
/// The full decision record lives in the lane-owned partial header
/// (farmhandexecutioncontroller.cookingactions.cs). Its load-bearing facts:
///  - seam_decision=(a): backpack-only cooking (who.Items). The fridge /
///    mini-fridge linkage is explicitly excluded because
///    GameLocation.ActivateKitchen (GameLocation.cs:7984) reaches the material
///    containers only inside a MultipleMutexRequest callback (:8001) whose
///    success path mounts CraftingPage (:8013) and whose only release is that
///    menu's exitFunction; there is no menu-free request/release of the fridge
///    NetMutex, so a headless request would leak the lock or race the host
///    player's fridge access;
///  - the station is derived Mod-side from the live world within the vanilla
///    interaction radius (GameLocation.cs:14043) from either the Buildings
///    "Action" Kitchen tile (GameLocation.cs:8730-8732) or the cookout kit
///    (BC)278 (Torch.cs:86-89); the menu-only ActivateKitchen is never invoked;
///  - the rule gates are the live CraftingRecipe.cookingRecipes table plus
///    Game1.player.cookingRecipes (learned), both fail-closed, because the
///    vanilla CraftingRecipe constructor silently falls back to "Torch" for an
///    unknown name;
///  - conservation uses Farmer.addItemToInventory (Farmer.cs:4196) with a
///    Game1.createItemDebris (Game1.cs:10245) drop for any remainder;
///    addItemToInventoryBool is never used because its success
///    (Farmer.cs:4317-4340) is true on a partial accept;
///  - success reasonCode is dish_cooked, a partial delivery is
///    dish_cooked_output_dropped (PartiallySucceeded), and the live gate stays
///    the declared native-local fixture native_cook_recipe_v1.
///
/// Like its sibling lane tests, the deterministic assertions run without a
/// Game1 harness (the world-not-ready path); the full native cooking
/// transaction belongs to the native-local live gate per
/// fixtures/stardew/RUNBOOK.md.
/// </summary>
public sealed class CookRecipeActionTests
{
    private readonly ITestOutputHelper output;

    public CookRecipeActionTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    [Fact]
    public void Catalog_CookRecipe_RegisteredAsExperimentalCraftingCookingWithRecipeTarget()
    {
        FarmhandActionRegistration? reg = FarmhandActionCatalog.Registrations
            .FirstOrDefault(r => r.ActionId == "cook_recipe");

        reg.Should().NotBeNull();
        reg!.FamilyId.Should().Be("crafting_cooking");
        reg.Lifecycle.Should().Be(FarmhandActionLifecycle.Experimental);
        reg.Kind.Should().Be(FarmhandOperationKind.Execution);
        reg.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.MachinesAndAnimals);
        reg.Descriptor.Should().NotBeNull();
        reg.Descriptor!.Arguments.Select(a => a.Name).Should().BeEquivalentTo(new[] { "expectedTargetId" });
        reg.Descriptor.Effect.Should().Be("write");
    }

    /// <summary>
    /// The wire recipe identity rule over a synthetic key set: the exact key wins,
    /// a unique underscore alias resolves, and unknown or ambiguous identities fail
    /// closed. This is the only part of the identity rule that is provable without
    /// game content.
    /// </summary>
    [Fact]
    public void RecipeIdentityResolution_ExactUniqueAliasUnknownAndAmbiguous()
    {
        string[] keys = { "Fried Egg", "Baked Fish", "Egg Salad", "Fried Eggi" };

        ExecutionManager.TryResolveRecipeIdentity(keys, "Fried Egg", out string exact, out string exactReason)
            .Should().BeTrue();
        exact.Should().Be("Fried Egg");
        exactReason.Should().Be("accepted");

        ExecutionManager.TryResolveRecipeIdentity(keys, "Baked_Fish", out string alias, out string aliasReason)
            .Should().BeTrue();
        alias.Should().Be("Baked Fish");
        aliasReason.Should().Be("accepted");

        ExecutionManager.TryResolveRecipeIdentity(keys, "Pizza", out _, out string unknownReason)
            .Should().BeFalse();
        unknownReason.Should().Be("recipe_unknown");

        // Two distinct space-containing keys can share one underscore alias
        // ("A B C" and "A B_C" both alias to "A_B_C"); a key that has no space
        // always equals its own alias, so it would have been the exact match above.
        ExecutionManager.TryResolveRecipeIdentity(new[] { "A B C", "A B_C" }, "A_B_C", out _, out string ambiguousReason)
            .Should().BeFalse();
        ambiguousReason.Should().Be("recipe_identity_ambiguous");

        ExecutionManager.TryResolveRecipeIdentity(keys, "   ", out _, out string blankReason)
            .Should().BeFalse();
        blankReason.Should().Be("recipe_unknown");
    }

    [Fact]
    public void Router_CookRecipe_WhenWorldNotReady_Rejects()
    {
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "cook_recipe" });
        var executions = new ExecutionManager(new DummyMonitor(), () => publication);
        var handler = new MachineAndAnimalActionHandler(executions);

        var request = new BridgeExecutionRequest(
            "req_cook_recipe_1", "idemp_cook_recipe_1", "cook_recipe",
            new BridgeExecutionArgs { ExpectedTargetId = "Fried_Egg" },
            1, 5000);
        var receipt = handler.Execute(request, executions);

        receipt.Should().NotBeNull();
        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("native_local_player_required");
    }

    [Fact]
    public void Router_CookRecipe_SameRequestId_ReplaysTheStoredReceipt()
    {
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "cook_recipe" });
        var executions = new ExecutionManager(new DummyMonitor(), () => publication);
        var handler = new MachineAndAnimalActionHandler(executions);

        var request = new BridgeExecutionRequest(
            "req_cook_recipe_replay", "idemp_cook_recipe_replay", "cook_recipe",
            new BridgeExecutionArgs { ExpectedTargetId = "Fried_Egg" },
            1, 5000);
        var first = handler.Execute(request, executions);
        var second = handler.Execute(request, executions);

        second.ExecutionId.Should().Be(first.ExecutionId);
        second.ReasonCode.Should().Be(first.ReasonCode);
        second.Revision.Should().Be(first.Revision);
    }

    [Theory]
    [InlineData("dish_cooked")]
    [InlineData("dish_cooked_dropped_on_ground")]
    [InlineData("dish_cooked_output_dropped")]
    [InlineData("cook_recipe_postcondition_unavailable")]
    [InlineData("recipe_not_learned")]
    [InlineData("recipe_unknown")]
    [InlineData("recipe_identity_ambiguous")]
    [InlineData("recipe_ingredients_unavailable")]
    [InlineData("cooking_station_not_adjacent")]
    [InlineData("cooking_recipes_unavailable")]
    [InlineData("native_local_player_required")]
    [InlineData("player_not_actionable")]
    [InlineData("invalid_deadline")]
    [InlineData("body_owned")]
    public void ReasonCodes_MatchReceiptSchemaPattern(string reasonCode)
    {
        // Mirrors protocol/bridge-v1.schema.json #/$defs/reasonCode.
        System.Text.RegularExpressions.Regex.IsMatch(reasonCode, "^[a-z0-9_:-]{1,128}$").Should().BeTrue($"reasonCode '{reasonCode}' must satisfy the bridge schema pattern");
    }

    /// <summary>
    /// Target-version drift tripwire. The installed target 1.6.15.24356 (the
    /// assembly the Mod compiles against) performs the cooking quest
    /// bookkeeping through Farmer.NotifyQuests(quest => quest.OnRecipeCrafted(...));
    /// the older ref/external 1.6 decompile still shows the superseded
    /// Farmer.checkForQuestComplete(..., questType: 2) line and has no
    /// NotifyQuests. If the target version is rebaselined, this pin fails closed
    /// and the seam record must be re-derived before the action is accepted.
    /// </summary>
    [Fact]
    public void DriftAnchors_CookingQuestBookkeeping_MatchesInstalledTargetVersion()
    {
        Type farmer = typeof(StardewValley.Farmer);
        farmer.GetMethod("cookedRecipe", BindingFlags.Public | BindingFlags.Instance, new[] { typeof(string) })
            .Should().NotBeNull("Farmer.cookedRecipe(string) is the recipesCooked increment this body calls");
        farmer.GetMethod("NotifyQuests")
            .Should().NotBeNull("the target version routes cooking quest progress through NotifyQuests/OnRecipeCrafted");
        farmer.GetMethod("checkForQuestComplete")
            .Should().BeNull("the superseded quest-progress member must not reappear without re-deriving the seam record");

        Type quest = typeof(StardewValley.Quests.Quest);
        quest.GetMethod("OnRecipeCrafted")
            .Should().NotBeNull("OnRecipeCrafted is the per-quest cooking hook the target version invokes");

        Type recipe = typeof(StardewValley.CraftingRecipe);
        recipe.GetMethod("doesFarmerHaveIngredientsInInventory")
            .Should().NotBeNull("the backpack ingredient gate is CraftingRecipe.doesFarmerHaveIngredientsInInventory");
        recipe.GetMethod("consumeIngredients")
            .Should().NotBeNull("consumption is CraftingRecipe.consumeIngredients");
        recipe.GetMethod("createItem")
            .Should().NotBeNull("output construction is CraftingRecipe.createItem");
        recipe.GetMethod("DoesFarmerHaveAdditionalIngredientsInInventory", BindingFlags.Public | BindingFlags.Static)
            .Should().NotBeNull("the seasoning gate is CraftingRecipe.DoesFarmerHaveAdditionalIngredientsInInventory");
        recipe.GetMethod("ConsumeAdditionalIngredients", BindingFlags.Public | BindingFlags.Static)
            .Should().NotBeNull("the seasoning consumption is CraftingRecipe.ConsumeAdditionalIngredients");

        // The fridge material containers are only reachable through the menu-only
        // MultipleMutexRequest callback, which is exactly why seam decision (a)
        // excludes them. Pin that the menu-only entry still exists in the target
        // version so a rebaseline re-opens the decision instead of silently
        // changing what "no fridge" means.
        typeof(StardewValley.GameLocation).GetMethod("ActivateKitchen", BindingFlags.Public | BindingFlags.Instance)
            .Should().NotBeNull("ActivateKitchen is the menu-only kitchen entry the excluded fridge linkage lives behind");

        this.output.WriteLine(
            $"target_version_pins=Farmer.cookedRecipe,Farmer.NotifyQuests,Quest.OnRecipeCrafted,{recipe.Name}.doesFarmerHaveIngredientsInInventory,{recipe.Name}.consumeIngredients,{recipe.Name}.createItem,{recipe.Name}.DoesFarmerHaveAdditionalIngredientsInInventory,{recipe.Name}.ConsumeAdditionalIngredients,{typeof(StardewValley.GameLocation).FullName}.ActivateKitchen;superseded_absent=Farmer.checkForQuestComplete");
    }

    /// <summary>
    /// Pins the recorded seam decision so a target-version rebaseline must
    /// re-derive it. This is a static-record assertion, not live evidence.
    /// </summary>
    [Fact]
    public void StaticReview_RecordsCookRecipeSeamDecision()
    {
        this.output.WriteLine(
            "seam_decision=(a);fridge=excluded(no_menu_free_MultipleMutexRequest_release);" +
            "station=Buildings_Action_Kitchen_tile_or_cookout_kit_(BC)278_within_radius_1;" +
            "menu_entry_never_invoked=GameLocation.ActivateKitchen(GameLocation.cs:7984);" +
            "catalog_fallback_guard=CraftingRecipe.cookingRecipes_contains_key;" +
            "learned_gate=Game1.player.cookingRecipes;" +
            "conservation=Farmer.addItemToInventory+Game1.createItemDebris(addItemToInventoryBool_never_used)+space_precheck_retained_non_aborting;" +
            "seasoning=included_backpack_only;wire_recipe_identity=exact_key_or_unique_underscore_alias;" +
            "success_reason_code=dish_cooked;dropped_reason_code=dish_cooked_dropped_on_ground;partial_reason_code=dish_cooked_output_dropped;" +
            "live_evidence=pending_native_local_fixture(native_cook_recipe_v1)");
    }
}
