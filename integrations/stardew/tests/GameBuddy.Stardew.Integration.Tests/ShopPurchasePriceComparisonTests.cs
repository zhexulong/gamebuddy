using FluentAssertions;
using StardewValley;
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
/// <para>
/// The number that comparison runs on is the price the shop CHARGES (<c>ItemStockInformation.Price</c>), never the
/// item's own sale value: measured 2026-11-12 against the real engine types, <c>salePrice(ignoreProfitMargins: true)</c>
/// returns 200 for an item whose Data/Objects price is 100, so an item and the row that sells it hold two different
/// prices. <c>ExecuteShopPurchase</c> cannot be driven in a plain xUnit process - it opens the real <c>ShopMenu</c> and
/// reads <c>ShopBuilder.GetShopStock</c>, both of which need a mounted world (<c>ShopMenuHeadlessProbe</c> records the
/// first, <c>SeedSupplyAddressSourceShapeTests</c> the second) - so the decision itself is driven through its own
/// producer, <c>ShopPurchaseCapacity</c>, with a real stock entry.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the arithmetic is driven through ShopPurchaseCapacity with real stock entries, and the one
// thing that cannot be driven here - WHICH price the purchase path hands it - is pinned from the source, because that
// method opens the real ShopMenu and reads GetShopStock, both of which need a mounted world.
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

    /// <summary>
    /// A purse that can pay the shop's price buys, even though it cannot pay the item's sale value.
    ///
    /// 50g against a row asking 20 is two units; the same 50g against the item's own value of 200 is none. The second
    /// number is what <c>offer.salePrice()</c> answered, so this is the refusal a real player met: goods, shop, price
    /// and purse all present and a purchase she could afford reported as `insufficient_money`.
    /// </summary>
    [Fact]
    public void ThePurseIsJudgedAtThePriceTheShopChargesAndNotAtTheItemsValue()
    {
        (long affordableAtCharge, int purchasableAtCharge) =
            ExecutionManager.ShopPurchaseCapacity(new ItemStockInformation(20, 5), currencyHeld: 50, requestedQuantity: 1);

        affordableAtCharge.Should().Be(2, "50g pays for two units of a 20g row");
        purchasableAtCharge.Should().Be(1);

        (long affordableAtValue, int purchasableAtValue) =
            ExecutionManager.ShopPurchaseCapacity(new ItemStockInformation(200, 5), currencyHeld: 50, requestedQuantity: 1);

        affordableAtValue.Should().Be(0, "200 is the item's value, not the shop's asking price");
        purchasableAtValue.Should().Be(0, "judging by the value refuses a purchase the purse can pay for");
    }

    /// <summary>
    /// The other direction: a row asking more than she holds is refused BEFORE the menu opens, and the refusal names
    /// what the shop asks, what she holds and the gap between them.
    ///
    /// The right-hand half is the number the old precondition compared instead - 50g against a 20-value item looked
    /// like two affordable units, so the request was admitted and the native charge then had nothing to take, which is
    /// how a purchase ended as `purchase_not_effective` after a wasted menu round.
    /// </summary>
    [Fact]
    public void ARowAboveThePurseIsRefusedWithBothSidesOfTheComparisonNamed()
    {
        (long affordable, int purchasable) =
            ExecutionManager.ShopPurchaseCapacity(new ItemStockInformation(500, 5), currencyHeld: 50, requestedQuantity: 1);

        affordable.Should().Be(0);
        purchasable.Should().Be(0);

        string evidence = ExecutionManager.ShopPurchaseAffordabilityEvidence("SeedShop", "(O)472", 500, 0, 50);
        evidence.Should().Contain("price=500", "the amount the shop asks");
        evidence.Should().Contain(";held=50", "the amount she holds");
        evidence.Should().Contain(";short=450", "the gap between them, so the next attempt can adapt");

        ExecutionManager.ShopPurchaseCapacity(new ItemStockInformation(20, 5), currencyHeld: 50, requestedQuantity: 1)
            .Purchasable.Should().Be(1, "20 is the item's value: the number that let this request through before");
    }

    /// <summary>
    /// The price the purchase path judges by is read from the stock entry it buys from - one fact, one spelling.
    ///
    /// This is the half no headless test can drive: <c>ExecuteShopPurchase</c> calls <c>ShopBuilder.GetShopStock</c> and
    /// opens the real <c>ShopMenu</c>, so the two numbers it could have used are checked where they are named. A
    /// <c>salePrice()</c> anywhere in this file is the defect itself - the item's value is not the shop's price - and
    /// the entry is what the receipt's <c>unit_price</c> must carry, because the live shop smoke compares
    /// <c>money_before - money_after</c> against <c>purchased * unit_price</c>.
    /// </summary>
    [Fact]
    public void ThePurchasePathJudgesHerPurseAtTheStockEntrysOwnPrice()
    {
        string code = ShopActionsCode();

        code.Should().Contain(
            "ItemStockInformation charged = stock[offer];",
            "the price must be read from the entry this purchase is made from, not from the item");
        code.Should().Contain(
            "int unitPrice = charged.Price;",
            "the receipt's unit_price is the number the menu charges, so the live purse comparison can hold");
        code.Should().Contain(
            "ShopPurchaseCapacity(charged, currencyHeld, quantity)",
            "the affordability decision is handed the entry itself, so no second price can enter it");
        code.Should().NotContain(
            "salePrice",
            "the item's sale value is not the shop's asking price; judging by it refused purchases the purse could pay "
            + "for and made unit_price a number the charge never moved");
    }

    /// <summary>The Mod's shop action source with line comments removed, so a pin tests code and not prose.</summary>
    private static string ShopActionsCode()
    {
        for (DirectoryInfo? directory = new(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            string candidate = Path.Combine(
                directory.FullName, "integrations", "stardew", "farmhandexecutioncontroller.shopactions.cs");
            if (File.Exists(candidate))
            {
                var builder = new System.Text.StringBuilder();
                foreach (string line in File.ReadAllText(candidate).Split('\n'))
                {
                    int comment = line.IndexOf("//", StringComparison.Ordinal);
                    builder.AppendLine(comment >= 0 ? line[..comment] : line);
                }
                return builder.ToString();
            }
        }

        throw new FileNotFoundException("could not locate farmhandexecutioncontroller.shopactions.cs");
    }
}
