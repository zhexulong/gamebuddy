using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// `look_up({ subject: "data", table: "CraftingRecipes" })` answers what a recipe COSTS, and the ingredient identity it
/// resolves is the SAME one `craftingRecipeTargets.missingIngredients` publishes.
///
/// <para>
/// WHY THE TABLE EXISTS. `craftingRecipeTargets`/`cookingRecipeTargets` say which recipes are learned and whether the
/// backpack can make one right now; the ingredients and their amounts live in `Data/CraftingRecipes` and reached the
/// Agent nowhere, so a companion holding an unmakeable recipe could not say what she was short of or what to buy for it.
/// This is the asking.
/// </para>
/// <para>
/// WHAT A HEADLESS RUN CAN PIN. Loading a recipe row needs the engine's own content caches (`Game1.content` behind
/// `DataLoader.CraftingRecipes`, and `Game1.player.craftingRecipes` inside the `CraftingRecipe` constructor), which this
/// suite does not have - the same split the animal table's tests document. So the pins here are the two facts that ARE
/// decidable without content: the tables are registered under the names the Agent asks for, and the ingredient-key
/// classification that decides between "an item id" and "the engine's own category number". That branch is not
/// decoration: `Data/CraftingRecipes` really does carry both kinds, because
/// `CraftingRecipe.ItemMatchesForCrafting` matches an item's `Category` before it compares any `QualifiedItemId`
/// (CraftingRecipe.cs:358-378), and it is the one place where an ingredient has no single item to name.
/// </para>
/// </summary>
[Trait("kind", "content-data")]
public sealed class ContentDataQueryRecipesTests
{
    [Fact]
    public void TheRecipeTablesAreRegisteredUnderTheNamesTheAgentAsksFor()
    {
        ContentDataQuery.Exposes("CraftingRecipes").Should().BeTrue(
            "a recipe's cost is a data answer, and this is the only channel that carries it");
        ContentDataQuery.Exposes("CookingRecipes").Should().BeTrue(
            "cook_recipe is a published action whose target family has the same gap");
        ContentDataQuery.Exposes("Recipes").Should().BeFalse(
            "the engine has no Data/Recipes table; crafting and cooking are two separate assets");
    }

    [Theory]
    [InlineData("388", false, 0)]
    [InlineData("(O)388", false, 0)]
    [InlineData("Seaweed", false, 0)]
    [InlineData("-5", true, -5)]
    [InlineData("-777", true, -777)]
    [InlineData("-", false, 0)]
    [InlineData("-egg", false, 0)]
    [InlineData("", false, 0)]
    public void AnIngredientKeyIsEitherAnItemOrTheEnginesOwnCategoryNumber(string ingredientKey, bool isCategory, int category)
    {
        ContentDataQuery.IsRecipeIngredientCategory(ingredientKey, out int measured).Should().Be(
            isCategory,
            $"`{ingredientKey}` is {category} in the engine's ingredient-key space, and only a negative integer is a category");

        measured.Should().Be(category, "the category a key names is published as the key itself, so it is read back unchanged");
    }
}
