using System;
using System.IO;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// shop_purchase must price the affordability gate and the success judgement in the currency the
/// shop's own menu charges, not in money. A ShopMenu prices every entry in the currency its
/// ShopData declares: <c>Utility.TryOpenShopMenu</c> builds the menu from that ShopData
/// (Utility.cs:4217/4320) and <c>ShopMenu.Initialize</c> stores <c>shopData.Currency</c>
/// (ShopMenu.cs:304, :371), and <c>ShopMenu.getPlayerCurrencyAmount</c> (ShopMenu.cs:881-891) is the
/// native map from that value to the player field the charge actually moves (0 money,
/// 1 festivalScore, 2 clubCoins, 4 QiGems).
///
/// The defect this pins out: the handler hardcoded <c>actor.Money</c> for BOTH the gate and the
/// success-vs-partial judgement, so a shop priced in club coins (the Casino stall) or Qi gems (the
/// Qi gem stall) was refused while affordable, and a real purchase was judged against a purse the
/// native charge never moves. The receipt's <c>money_before</c>/<c>money_after</c> keys are a frozen
/// Host completion shape (host/src/stardew-game-integration-adapter.ts:1914-1949 requires exactly
/// those key names and <c>money_after &lt; money_before</c>), so the values now carry the currency
/// amount under the unchanged keys.
/// </summary>
public sealed class ShopPurchaseCurrencyTests
{
    private const string HandlerFile = "farmhandexecutioncontroller.shopactions.cs";

    [Fact]
    public void Handler_ReadsTheShopsOwnCurrency_NotHardcodedMoney()
    {
        string code = StripLineComments(ReadHandlerSource());
        string request = MethodBody(code, "public LocalExecutionReceipt RequestLocalShopPurchase(");

        // The defect, exactly: the gate divided the purse and the judgement compared the purse.
        request.Should().NotContain(
            "long affordable = actor.Money / Math.Max(1, unitPrice);",
            "the affordability gate must divide the shop's own currency, not hardcoded money");
        request.Should().NotContain(
            "moneyAfter < moneyBefore",
            "the success-vs-partial judgement must compare the shop's own currency, not the purse");
        request.Should().NotContain(
            "actor.Money",
            "no purse read may remain on the purchase path; the currency field is the only amount the native charge moves");

        // The fix: the gate and the judgement read the shop's currency through the SAME native reader
        // the purchase uses.
        request.Should().Contain("int shopCurrency = ShopCurrencyFor(target.ShopId);");
        request.Should().Contain("long currencyHeld = ShopMenu.getPlayerCurrencyAmount(actor, shopCurrency);");
        request.Should().Contain("long affordable = currencyHeld / Math.Max(1, unitPrice);");
        request.Should().Contain("long currencyBefore = ShopMenu.getPlayerCurrencyAmount(actor, shopCurrency);");
        request.Should().Contain("long currencyAfter = ShopMenu.getPlayerCurrencyAmount(actor, shopCurrency);");
        request.Should().Contain("currencyAfter < currencyBefore && gained > 0");
        request.Should().Contain("currencyAfter < currencyBefore || gained > 0");

        // The refusal names the currency it could not afford.
        request.Should().Contain("currency={ShopCurrencyName(shopCurrency)}");
        request.Should().NotContain("money={actor.Money}");
    }

    [Fact]
    public void CurrencyResolver_ReadsTheShopDataCurrency_AndTheNamerMatchesTheNativeMap()
    {
        string code = StripLineComments(ReadHandlerSource());

        string resolver = MethodBody(code, "private static int ShopCurrencyFor(");
        resolver.Should().Contain("DataLoader.Shops(Game1.content)");
        resolver.Should().Contain("out ShopData? shopData");
        resolver.Should().Contain("shopData.Currency");

        string namer = MethodBody(code, "private static string ShopCurrencyName(");
        namer.Should().Contain("1 => \"star_tokens\"");
        namer.Should().Contain("2 => \"club_coins\"");
        namer.Should().Contain("4 => \"qi_gems\"");
        namer.Should().Contain("_ => \"money\"");
    }

    /// <summary>
    /// Drift anchor for the native facts the fix rests on: the menu's currency is the shop data's own
    /// Currency (the string-owner overload builds the ShopData constructor, which passes
    /// <c>shopData.Currency</c> to Initialize), and the value-to-field map is
    /// <c>ShopMenu.getPlayerCurrencyAmount</c>. A game-version change shows up here as a red test
    /// rather than a silent mispricing.
    /// </summary>
    [Fact]
    public void DriftAnchor_TheNativeShopMenuCurrencyMap()
    {
        string[] shopMenu = File.ReadAllLines(RepositoryPath(
            "ref", "external", "StardewValleyDecompiled", "Stardew Valley", "StardewValley.Menus", "ShopMenu.cs"));

        shopMenu[304 - 1].Should().Contain("Initialize(shopData.Currency, onPurchase, onSell, playOpenSound);");
        shopMenu[371 - 1].Should().Contain("this.currency = currency;");

        shopMenu[885 - 1].Should().Contain("0 => who.Money,");
        shopMenu[886 - 1].Should().Contain("1 => who.festivalScore,");
        shopMenu[887 - 1].Should().Contain("2 => who.clubCoins,");
        shopMenu[888 - 1].Should().Contain("4 => who.QiGems,");

        string[] utility = File.ReadAllLines(RepositoryPath(
            "ref", "external", "StardewValleyDecompiled", "Stardew Valley", "StardewValley", "Utility.cs"));
        utility[4217 - 1].Should().Contain("new ShopMenu(shopId, value, ownerData, owner, null, null, playOpenSound);");
    }

    /// <summary>Extract one member body by brace balance from its declaration.</summary>
    private static string MethodBody(string source, string declaration)
    {
        int start = source.IndexOf(declaration, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, $"{declaration} must exist");

        int depth = 0;
        bool started = false;
        for (int index = start; index < source.Length; index++)
        {
            char character = source[index];
            if (character == '{')
            {
                depth++;
                started = true;
            }
            else if (character == '}')
            {
                depth--;
                if (started && depth == 0)
                    return source[start..(index + 1)];
            }
        }

        throw new InvalidOperationException($"unbalanced body for {declaration}");
    }

    /// <summary>Drop <c>//</c>/<c>///</c> comments so the pins test code, not prose.</summary>
    private static string StripLineComments(string source)
    {
        var builder = new System.Text.StringBuilder(source.Length);
        foreach (string line in source.Split('\n'))
        {
            int comment = line.IndexOf("//", StringComparison.Ordinal);
            builder.AppendLine(comment >= 0 ? line[..comment] : line);
        }
        return builder.ToString();
    }

    private static string ReadHandlerSource() =>
        ReadRepositoryFile(Path.Combine("integrations", "stardew", HandlerFile));

    /// <summary>Tests run from the project or its bin output; walk up to the repository root.</summary>
    private static string ReadRepositoryFile(string relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++, directory = directory.Parent)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (File.Exists(candidate))
                    return File.ReadAllText(candidate);
            }
        }

        throw new FileNotFoundException($"repository path not found: {relative}");
    }

    private static string RepositoryPath(params string[] parts)
    {
        string relative = Path.Combine(parts);
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++, directory = directory.Parent)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (File.Exists(candidate))
                    return candidate;
            }
        }

        throw new FileNotFoundException($"repository path not found: {relative}");
    }
}
