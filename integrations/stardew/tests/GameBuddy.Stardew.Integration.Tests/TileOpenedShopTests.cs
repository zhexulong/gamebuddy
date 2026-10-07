using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// `shop_purchase` opens the tile-opened shops. The action's execution seam is
/// `Utility.TryOpenShopMenu`, and the tile cases that dispatch the SAME overload
/// (`TryOpenShopMenu(shopId, null, playOpenSound: true)`, the "no NPC portrait/dialogue"
/// form the game documents at Utility.cs:4174) are the ones advertised here. The
/// selectors whose native case opens NO shop, or opens one through the location overload
/// with gates this seam does not reproduce, are deliberately left out — an honest "not
/// reachable this way" rather than a forced include that would bypass a gate.
/// </summary>
public sealed class TileOpenedShopTests
{
    private const string ImplementationRelativePath = "integrations/stardew/farmhandexecutioncontroller.shopactions.cs";
    private const string DecompiledGameLocationRelativePath = "ref/external/StardewValleyDecompiled/Stardew Valley/StardewValley/GameLocation.cs";
    private const string DecompiledUtilityRelativePath = "ref/external/StardewValleyDecompiled/Stardew Valley/StardewValley/Utility.cs";

    [Theory]
    [InlineData("JojaShop", "Joja")]
    [InlineData("ClubShop", "Casino")]
    [InlineData("QiGemShop", "QiGemShop")]
    [InlineData("Bookseller", "Bookseller")]
    [InlineData("OpenShop SeedShop", "SeedShop")]
    public void TileShopSelectors_ResolveToTheShopTheirNativeCaseOpens(string action, string expectedShopId)
    {
        ExecutionManager.TryResolveTileShop(action, out string shopId).Should().BeTrue();
        shopId.Should().Be(expectedShopId);
    }

    /// <summary>
    /// ⛔ The negative half, one row per reason a selector is NOT included: no shop at all
    /// (ColaMachine, QiCoins, ClubSeller), the location overload with an owner area
    /// (IceCreamStand), a gated OpenShop form, and plain non-shop ActionTiles.
    /// </summary>
    [Theory]
    [InlineData("ColaMachine")]
    [InlineData("QiCoins")]
    [InlineData("ClubSeller")]
    [InlineData("IceCreamStand")]
    [InlineData("ClubSlots")]
    [InlineData("OpenShop")]
    [InlineData("OpenShop SeedShop down")]
    [InlineData("OpenShop SeedShop down 900 1900")]
    [InlineData("OpenShop SeedShop down 900 1900 4 17 1 1")]
    [InlineData("Kitchen")]
    [InlineData("BooksellerTrade")]
    [InlineData("")]
    [InlineData(null)]
    public void SelectorsThatReachNoShopThroughThisSeam_AreLeftOut(string? action)
    {
        ExecutionManager.TryResolveTileShop(action, out string shopId).Should().BeFalse();
        shopId.Should().BeEmpty();
    }

    /// <summary>
    /// A tile-opened shop's target must not collide with the NPC-owner target of the same
    /// shop, or the opaque id would name two different counters at once.
    /// </summary>
    [Fact]
    public void TileShopTargetId_IsDistinctFromTheNpcOwnerTargetOfTheSameShop()
    {
        ExecutionManager.ShopTargetId("SeedShop", string.Empty)
            .Should().NotBe(ExecutionManager.ShopTargetId("SeedShop", "Pierre"));
        ExecutionManager.ShopTargetId("Joja", string.Empty)
            .Should().NotBe(ExecutionManager.ShopTargetId("Joja", "Morris"));
    }

    /// <summary>
    /// The production wiring: discovery publishes the tile counters, the handler opens them
    /// with the null-owner form the native cases use, and the two new refusal codes keep
    /// Bookseller's own gate a refusal instead of a bypass.
    /// </summary>
    [Fact]
    public void DiscoveryAndHandler_WireTheTileCountersWithoutWideningTheSnapshotContract()
    {
        string? path = TryFindRepoFile(ImplementationRelativePath);
        path.Should().NotBeNull($"the shop_purchase body must exist at {ImplementationRelativePath}");
        string text = File.ReadAllText(path!);

        text.Should().Contain("DiscoverTileShopTargets(location, player)");
        text.Should().Contain("ShopTargetId(shopId, string.Empty)");
        // Fixed selectors: the exact native string-overload call with a null owner.
        text.Should().Contain("Utility.TryOpenShopMenu(shopId: target.ShopId, ownerName: null!)");
        // The gate-free OpenShop form: the exact native location-overload call, so its own
        // closed-message refusal is preserved, and the DialogueBox it mounts is closed.
        text.Should().Contain("Utility.TryOpenShopMenu(target.ShopId, location, ownerArea: null, maxOwnerY: null, forceOpen: true)");
        text.Should().Contain("((DialogueBox)Game1.activeClickableMenu).closeDialogue();");
        text.Should().Contain("\"shop_tile_gate_refused\"");
        text.Should().Contain("\"shop_tile_requires_dialogue\"");
        // The published 32-entry cap on shopTargets is a closed contract: exceeding it
        // invalidates the whole snapshot, so the cap is part of the change.
        text.Should().Contain("targets.Take(MaxShopTargets)");
    }

    /// <summary>Drift anchor for each included selector and for the two excluded shapes,
    /// so a game-version change shows up as a red test rather than a silent drift.</summary>
    [Fact]
    public void DriftAnchor_TileSelectorsAndTheirNativeCalls()
    {
        string? gameLocationPath = TryFindRepoFile(DecompiledGameLocationRelativePath);
        gameLocationPath.Should().NotBeNull();
        string[] gameLocation = File.ReadAllLines(gameLocationPath!);

        gameLocation[9228 - 1].Should().Contain("case \"JojaShop\":");
        gameLocation[9229 - 1].Should().Contain("Utility.TryOpenShopMenu(\"Joja\", null, playOpenSound: true);");
        gameLocation[9909 - 1].Should().Contain("case \"ClubShop\":");
        gameLocation[9910 - 1].Should().Contain("Utility.TryOpenShopMenu(\"Casino\", null, playOpenSound: true);");
        gameLocation[8992 - 1].Should().Contain("case \"QiGemShop\":");
        gameLocation[8993 - 1].Should().Contain("Utility.TryOpenShopMenu(\"QiGemShop\", null, playOpenSound: true);");
        gameLocation[8727 - 1].Should().Contain("case \"Bookseller\":");
        gameLocation[8741 - 1].Should().Contain("Utility.TryOpenShopMenu(\"Bookseller\", null, playOpenSound: true);");
        gameLocation[8728 - 1].Should().Contain("Utility.getDaysOfBooksellerThisSeason().Contains(Game1.dayOfMonth)");
        gameLocation[8730 - 1].Should().Contain("Game1.player.mailReceived.Contains(\"read_a_book\")");

        // The excluded shapes, each for the reason the test above records.
        gameLocation[9232 - 1].Should().Contain("createQuestionDialogue(");
        gameLocation[9932 - 1].Should().Contain("case \"QiCoins\":");
        gameLocation[9946 - 1].Should().Contain("case \"ClubSeller\":");
        gameLocation[9237 - 1].Should().Contain("Utility.TryOpenShopMenu(\"IceCreamStand\", this, value34);");
        gameLocation[9061 - 1].Should().Contain("case \"OpenShop\":");
        gameLocation[9063 - 1].Should().Contain("string direction");
        gameLocation[9103 - 1].Should().Contain("(value24 >= 0 && Game1.timeOfDay < value24)");
        gameLocation[9110 - 1].Should().Contain("return Utility.TryOpenShopMenu(shopId, this, ownerArea, null, forceOpen);");
    }

    /// <summary>
    /// Drift anchor for the two overloads this item has to keep apart: the string form's own
    /// "no owner" branch (the fixed selectors' native call) and the location form's
    /// closed-message refusal (the OpenShop form's native call).
    /// </summary>
    [Fact]
    public void DriftAnchor_BothTryOpenShopMenuOverloadsAndTheirNullOwnerBranch()
    {
        string? utilityPath = TryFindRepoFile(DecompiledUtilityRelativePath);
        utilityPath.Should().NotBeNull();
        string[] utility = File.ReadAllLines(utilityPath!);

        utility[4177 - 1].Should().Contain("public static bool TryOpenShopMenu(string shopId, string ownerName, bool playOpenSound = true)");
        utility[4205 - 1].Should().Contain("if (ownerName == null)");
        utility[4208 - 1].Should().Contain("p.Type == ShopOwnerType.AnyOrNone || p.Type == ShopOwnerType.None");
        utility[4230 - 1].Should().Contain("bool forceOpen = false, bool playOpenSound = true, Action<string> showClosedMessage = null)");
        utility[4305 - 1].Should().Contain("if (shopOwnerData != null && shopOwnerData.ClosedMessage != null)");
        utility[4314 - 1].Should().Contain("Game1.drawObjectDialogue(text);");
        utility[4318 - 1].Should().Contain("if (shopOwnerData != null || forceOpen)");
    }

    private static string? TryFindRepoFile(string relativePath)
    {
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
}
