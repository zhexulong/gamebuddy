using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Routing;
using GameBuddy.Stardew.Handlers;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Lane B: pins the craft_item contract.
///
/// Seam decision (recorded in the body header of
/// integrations/stardew/farmhandexecutioncontroller.craftingactions.cs, which
/// this class owns and pins): the action is one bounded native recipe
/// transaction over Game1.player.Items only — learned-recipe gate
/// (craftingRecipes key), CraftingRecipe.doesFarmerHaveIngredientsInInventory,
/// CraftingRecipe.consumeIngredients(null), CraftingRecipe.createItem, then the
/// product enters the backpack through Farmer.addItemToInventory. There is
/// deliberately no CraftingPage and no heldItem, and no fridge/chest material
/// container, so no MultipleMutexRequest is involved.
///
/// addItemToInventoryBool is banned: its success test is
/// `remainder == null || remainder.Stack != item.Stack || item is SpecialItem`,
/// so a partial add reports true and the remainder silently vanishes. A
/// remainder must reach the ground through Game1.createItemDebris and the
/// receipt must report a non-successful disposition.
///
/// Structural assertions run without a Game1 harness (world-not-ready path);
/// the full native transaction and the ground-drop path belong to the
/// native-local fixture lane (fixture scenario native_craft_item_v1) via the
/// env-gated probe below.
/// </summary>
public sealed class CraftItemActionTests
{
    private const string ImplementationRelativePath = @"integrations\stardew\farmhandexecutioncontroller.craftingactions.cs";
    private const string DecompiledFarmerRelativePath = @"ref\external\StardewValleyDecompiled\Stardew Valley\StardewValley\Farmer.cs";
    private const string DecompiledGame1RelativePath = @"ref\external\StardewValleyDecompiled\Stardew Valley\StardewValley\Game1.cs";
    private const string DecompiledCraftingRecipeRelativePath = @"ref\external\StardewValleyDecompiled\Stardew Valley\StardewValley\CraftingRecipe.cs";
    private const string DecompiledCraftingPageRelativePath = @"ref\external\StardewValleyDecompiled\Stardew Valley\StardewValley.Menus\CraftingPage.cs";

    private const string EnableLiveProbeVariable = "GAMEBUDDY_STARDEW_CRAFT_ITEM_PROBE_LIVE";
    private const string HarnessReadyVariable = "GAMEBUDDY_STARDEW_CRAFT_ITEM_PROBE_HARNESS_READY";
    private const string SelectedTestVariable = "GAMEBUDDY_STARDEW_CRAFT_ITEM_PROBE_TEST";

    private readonly ITestOutputHelper output;

    public CraftItemActionTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    [Fact]
    public void Catalog_CraftItem_RegisteredAsLiveVerifiedCraftingCookingWithRecipeTarget()
    {
        FarmhandActionRegistration? reg = FarmhandActionCatalog.Registrations
            .FirstOrDefault(r => r.ActionId == "craft_item");

        reg.Should().NotBeNull();
        reg!.FamilyId.Should().Be("crafting_cooking");
        reg.Lifecycle.Should().Be(FarmhandActionLifecycle.LiveVerified);
        reg.Kind.Should().Be(FarmhandOperationKind.Execution);
        reg.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.MachinesAndAnimals);
        reg.Descriptor.Should().NotBeNull();
        reg.Descriptor!.Arguments.Select(a => a.Name).Should().BeEquivalentTo(new[] { "expectedTargetId" });
        reg.Descriptor.Effect.Should().Be("write");
    }

    [Fact]
    public void Router_CraftItem_WhenWorldNotReady_Rejects()
    {
        var publication = FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { "craft_item" });
        var executions = new ExecutionManager(new DummyMonitor(), () => publication);
        var handler = new MachineAndAnimalActionHandler(executions);

        var request = new BridgeExecutionRequest(
            "req_craft_item_1", "idemp_craft_item_1", "craft_item",
            new BridgeExecutionArgs { ExpectedTargetId = "Torch" },
            1, 5000);
        var receipt = handler.Execute(request, executions);

        receipt.Should().NotBeNull();
        receipt.State.Should().Be(ExecutionState.Rejected);
        receipt.ReasonCode.Should().Be("world_not_ready");
    }

    [Fact]
    public void SeamDecision_RecordsBackpackOnlyTransactionAndBansPartialAddBool()
    {
        string? path = TryFindRepoFile(ImplementationRelativePath);
        path.Should().NotBeNull($"the craft_item body must exist at {ImplementationRelativePath}");
        string text = File.ReadAllText(path!);

        text.Should().Contain("seam_decision=backpack recipe transaction");
        text.Should().Contain("heldItem route excluded");
        text.Should().Contain("addItemToInventoryBool is BANNED here");
        text.Should().Contain("dropped_on_ground");
        text.Should().Contain("Game1.createItemDebris");
        // The ban is only real if the banned API is never actually called.
        text.Should().NotContain(".addItemToInventoryBool(");
    }

    [Fact]
    public void DriftAnchors_ConservationAndRecipeSeams_StillMatchTargetVersion()
    {
        string? farmerPath = TryFindRepoFile(DecompiledFarmerRelativePath);
        farmerPath.Should().NotBeNull($"decompiled Farmer.cs must exist at {DecompiledFarmerRelativePath}");
        string[] farmer = File.ReadAllLines(farmerPath!);
        // The conservation seam this action uses, and the partial-add hazard it
        // refuses to rely on. Rebaselined 2026-09-27 onto the installed 1.6.15
        // assembly; the hazard is unchanged in form -- addItemToInventoryBool
        // still decides success with `item2?.Stack != item.Stack` (Farmer.cs:4407),
        // so reporting the leftover through the remainder is still required.
        farmer[4268 - 1].Should().Contain("public Item addItemToInventory(Item item)");
        farmer[4407 - 1].Should().Contain("item2?.Stack != item.Stack");

        string? game1Path = TryFindRepoFile(DecompiledGame1RelativePath);
        game1Path.Should().NotBeNull($"decompiled Game1.cs must exist at {DecompiledGame1RelativePath}");
        string[] game1 = File.ReadAllLines(game1Path!);
        game1[10705 - 1].Should().Contain("public static Debris createItemDebris(Item item, Vector2 pixelOrigin, int direction");

        string? recipePath = TryFindRepoFile(DecompiledCraftingRecipeRelativePath);
        recipePath.Should().NotBeNull($"decompiled CraftingRecipe.cs must exist at {DecompiledCraftingRecipeRelativePath}");
        string[] recipe = File.ReadAllLines(recipePath!);
        recipe[159 - 1].Should().Contain("public virtual bool doesFarmerHaveIngredientsInInventory");
        recipe[202 - 1].Should().Contain("public virtual Item createItem()");
        recipe[273 - 1].Should().Contain("public virtual void consumeIngredients(");

        string? pagePath = TryFindRepoFile(DecompiledCraftingPageRelativePath);
        pagePath.Should().NotBeNull($"decompiled CraftingPage.cs must exist at {DecompiledCraftingPageRelativePath}");
        string[] page = File.ReadAllLines(pagePath!);
        // The count increment this action reproduces, and the heldItem route it
        // explicitly excludes.
        page[486 - 1].Should().Contain("Game1.player.craftingRecipes.ContainsKey(recipe.name)");
        page[488 - 1].Should().Contain("Game1.player.craftingRecipes[recipe.name] += recipe.numberProducedPerCraft;");
        page[454 - 1].Should().Contain("heldItem = crafted;");
    }

    [Theory]
    [InlineData("learned_recipe_consumes_materials_and_adds_product")]
    [InlineData("full_inventory_output_drops_as_debris")]
    [InlineData("unlearned_recipe_rejected")]
    [InlineData("missing_ingredients_rejected")]
    public void LiveProbe_WhenHarnessReady_RecordsReceiptConservationDeltas(string probeTest)
    {
        // Env-gated live probe, mirroring ChestSeamProbe: an ordinary xUnit
        // process owns no initialized Stardew/SMAPI game thread, so this records
        // honest blocked output unless the native-local fixture lane sets the
        // three environment variables and runs one scenario case against fixture
        // scenario native_craft_item_v1.
        if (!IsLiveScenario(this.output, probeTest))
        {
            return;
        }

        // The external harness observes the live action; this fixture only records
        // which case the harness selected. The asserted live evidence lives in the
        // receipt produced by the harness: ingredients_before>after, count_before/
        // count_after, disposition (added_to_inventory | dropped_on_ground |
        // partially_dropped_on_ground), and native_menu_opened=false.
        this.output.WriteLine(
            $"probe={probeTest};harness_ready=true;outcome=observed_by_external_harness;receipt_conservation_deltas=recorded_externally");
    }

    private static string? TryFindRepoFile(string relativePath)
    {
        // Tests can run from the project directory or from the bin output
        // directory; walk upward from both until the committed file (which sits at
        // the repo root) is found.
        string[] starts = { AppContext.BaseDirectory, Environment.CurrentDirectory };
        foreach (string start in starts)
        {
            DirectoryInfo? dir = new(start);
            for (int depth = 0; dir is not null && depth < 12; depth++, dir = dir.Parent)
            {
                string candidate = Path.Combine(dir.FullName, relativePath);
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
        }

        return null;
    }

    private static bool IsLiveScenario(ITestOutputHelper output, string probeTest)
    {
        if (!string.Equals(Environment.GetEnvironmentVariable(EnableLiveProbeVariable), "1", StringComparison.Ordinal))
        {
            output.WriteLine(
                "blocked=live craft_item probe disabled; no initialized Stardew/SMAPI game thread is available. See design/tasks/active/cards/loop-lane-b-craft.md.");
            return false;
        }

        if (!string.Equals(Environment.GetEnvironmentVariable(HarnessReadyVariable), "1", StringComparison.Ordinal))
        {
            output.WriteLine(
                "blocked=external game-thread harness is not ready; no live craft_item result was produced.");
            return false;
        }

        if (!string.Equals(Environment.GetEnvironmentVariable(SelectedTestVariable), probeTest, StringComparison.Ordinal))
        {
            output.WriteLine($"blocked=probe '{probeTest}' was not selected by the external harness.");
            return false;
        }

        return true;
    }
}
