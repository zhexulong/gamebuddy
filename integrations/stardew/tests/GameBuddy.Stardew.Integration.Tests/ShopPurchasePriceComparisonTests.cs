using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// shop_purchase's affordability refusal has to state BOTH sides of the comparison it made: the price, in the
/// currency the shop's own menu charges, and the amount of that currency the actor holds.
///
/// <para>
/// Measured round42 (live): <c>shop_purchase</c> rejected <c>insufficient_money</c> eight times on
/// <c>shop=SeedShop;item=(O)474;price=80;currency=money;available=20</c> - eight of the twenty-one planned
/// nodes - with the goods, the price, the currency and the "available" amount all present and the balance never
/// named as a balance, because <c>available=</c> beside <c>price=</c> reads as stock. The companion could not
/// tell whether she was 5g or 5000g short, so it re-planned the same purchase instead of adapting. The sibling
/// fixed the round before (<c>shop_counter_out_of_reach</c>, which now names <c>owner_tile</c>,
/// <c>actor_tile</c> and <c>radius=</c>) is the same family: one side of a comparison is half a refusal.
/// </para>
/// <para>
/// These cases drive the Mod's own renderer with real numbers, so they fail on the emitted string rather than
/// on the source that happens to build it.
/// </para>
/// </summary>
public sealed class ShopPurchasePriceComparisonTests
{
    /// <summary>The refusal round42 could not act on, as the Mod now renders it.</summary>
    [Fact]
    public void TheUnreadableRefusalNowNamesTheBalanceAndTheGap()
    {
        string evidence = ExecutionManager.ShopPurchaseAffordabilityEvidence("SeedShop", "(O)474", 80, 0, 20);

        evidence.Should().Be("shop=SeedShop;item=(O)474;price=80;currency=money;available=20;held=20;short=60");

        // The tokens the refusal already carried are unchanged, byte for byte: this is an addition.
        evidence.Should().StartWith(
            "shop=SeedShop;item=(O)474;price=80;currency=money;available=20",
            "the prefix is what the previous round emitted, and an added token must not re-spell it");
    }

    /// <summary>
    /// `short=` states a real gap only. `price=80` against `held=80` is exactly affordable, and a free charge
    /// with an empty purse has no gap to name, so `short=0` never appears - it would report an absence as a
    /// quantity and invite the reader to treat "0 short" as "cannot buy".
    /// </summary>
    [Theory]
    [InlineData(80, 80)]
    [InlineData(80, 5000)]
    [InlineData(0, 0)]
    public void NoGapIsStatedWhenThereIsNoGap(int unitPrice, long currencyHeld)
    {
        ExecutionManager.PriceShortfallToken(unitPrice, currencyHeld).Should().BeEmpty();

        string evidence = ExecutionManager.ShopPurchaseAffordabilityEvidence(
            "SeedShop", "(O)474", unitPrice, 0, currencyHeld);
        evidence.Should().NotContain("short=");
        evidence.Should().NotContain("held=;", "the balance is stated on every refusal, shortfall or not");
        evidence.Should().Contain($";held={currencyHeld}");
    }

    [Theory]
    [InlineData(80, 20, ";short=60")]
    [InlineData(500, 120, ";short=380")]
    [InlineData(80, 0, ";short=80")]
    public void TheGapIsThePriceMinusWhatSheHolds(int price, long held, string expected)
    {
        ExecutionManager.PriceShortfallToken(price, held).Should().Be(expected);
    }

    /// <summary>
    /// A shop that prices in its own currency reports that currency's balance: naming the purse here is what
    /// refused an affordable club-coin trade before the currency work, and a gold figure beside a club-coin
    /// price would name the comparison's other side in the wrong unit.
    /// </summary>
    [Fact]
    public void AClubCoinShopNamesItsOwnCurrencyBalance()
    {
        ExecutionManager.ShopPurchaseAffordabilityEvidence("Casino", "(O)749", 100, 2, 3)
            .Should().Be("shop=Casino;item=(O)749;price=100;currency=club_coins;available=3;held=3;short=97");
    }
}
