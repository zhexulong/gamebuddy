using System;
using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using StardewValley;
using StardewValley.GameData.Shops;
using StardewValley.Internal;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// `seedSupplyTargets`: the shortage fact's supply half, projected from the engine's own shop data.
///
/// <para>
/// WHY THIS EXISTS. Measured 2026-11-09: a sixty-tile patch day began with two seed stacks, four tiles were planted, and
/// the companion said "种子就这些了，想铺满二十格还得再买种" and stopped - having never considered that seed is sold in
/// town. The supply was published nowhere: `shopTargets` lists only shops whose owner stands in the CURRENT location
/// (empty on the farm at 06:00) and carries no price and no trading window. This suite pins the projection that fixes
/// that, and it pins it against the ENGINE'S OWN TYPES - <see cref="ShopData"/>, <see cref="ShopItemData"/>,
/// <see cref="ShopOwnerData"/>, <see cref="ShopBuilder"/> - so a renamed or removed engine field is a compile error
/// here instead of a silent drift a hand-written JSON row would keep passing.
/// </para>
/// <para>
/// The three-valued open answer is the part that must not collapse: <c>true</c> means the shop's own condition held
/// when it was asked, <c>false</c> means it was asked and did not, and <c>null</c> means it could not be asked - with a
/// reason. "Closed" without the condition would be a state the companion cannot learn from, and a failed query read as
/// "closed" would send her nowhere for a reason that was never true.
/// </para>
/// </summary>
[Trait("kind", "content-data")]
public sealed class SeedSupplyProjectionTests
{
    private const string ParsnipSeeds = "(O)472";
    private const string TradingWindow = "TIME 900 2100";

    private static ShopOwnerData Pierre(string? condition = TradingWindow) =>
        new() { Name = "Pierre", Condition = condition };

    private static ShopData SeedShop(params ShopOwnerData[] owners) => new()
    {
        Currency = 0,
        Owners = owners.Length == 0 ? new List<ShopOwnerData>() : owners.ToList(),
        Items = new List<ShopItemData>
        {
            new() { Id = "parsnip-seeds", ItemId = "472", Price = 20, AvailableStock = int.MaxValue },
        },
    };

    private static BridgeSeedSupplyTarget Row(
        ShopData shop,
        IReadOnlyList<ShopOwnerData>? eligibleOwners,
        int chargedPrice = 20,
        int? heldCount = 2,
        IReadOnlyList<BridgeShopTarget>? shopTargetsHere = null,
        StardewValley.GameLocation? owningLocation = null) =>
        ExecutionManager.SeedSupplyRow(
            ParsnipSeeds,
            "Parsnip Seeds",
            heldCount,
            "SeedShop",
            "Pierre's General Store",
            shop,
            chargedPrice,
            eligibleOwners,
            shopTargetsHere,
            owningLocation);

    [Fact]
    public void TheRowCarriesTheShopsOwnHoursQueryAndItsDeclaredPrice()
    {
        ShopData shop = SeedShop(Pierre());

        BridgeSeedSupplyTarget row = Row(shop, new[] { Pierre() });

        row.QualifiedItemId.Should().Be(ParsnipSeeds);
        row.OwnerName.Should().Be("Pierre");
        // The trading window is the shop row's own game-state query, verbatim: it is what makes "closed at 02:00"
        // explainable rather than a bare negative.
        row.HoursCondition.Should().Be(TradingWindow);
        row.DeclaredPrice.Should().Be(20, "the Data/Shops row declares it");
        row.Price.Should().Be(20);
        row.Currency.Should().Be(0, "0 is the menu's own word for money");
        row.HeldCount.Should().Be(2);
    }

    [Fact]
    public void TheChargedPriceAndTheDeclaredPriceAreBothPublishedWhenTheyDisagree()
    {
        ShopData shop = SeedShop(Pierre());

        // `ShopBuilder` applies the shop's and the entry's modifiers, so the menu can charge more than the row declares.
        BridgeSeedSupplyTarget row = Row(shop, new[] { Pierre() }, chargedPrice: 24);

        row.Price.Should().Be(24, "what the menu would actually charge");
        row.DeclaredPrice.Should().Be(20, "what the row says - two numbers that disagree today are a disagreement later");
    }

    [Fact]
    public void TheOpenAnswerIsTheEnginesEligibilityAndNeverGuesses()
    {
        ShopData shop = SeedShop(Pierre());

        Row(shop, new[] { Pierre() }).OpenNow.Should().Be(true);
        Row(shop, Array.Empty<ShopOwnerData>()).OpenNow.Should().Be(false);
        Row(shop, new[] { Pierre() }).OpenNowReason.Should().BeNull();

        // Not asked is NOT closed: the condition could not be evaluated.
        BridgeSeedSupplyTarget unreadable = Row(shop, null);
        unreadable.OpenNow.Should().BeNull("an unasked question is not a shut shop");
        unreadable.OpenNowReason.Should().Be("owner_condition_unreadable");
    }

    [Fact]
    public void AShopThatDeclaresNoOwnerEntryHasNoHoursToStateAndSaysWhyItCannotAnswer()
    {
        ShopData shop = SeedShop();

        BridgeSeedSupplyTarget row = Row(shop, Array.Empty<ShopOwnerData>());

        row.OwnerName.Should().BeEmpty();
        row.HoursCondition.Should().BeNull("there is no owner entry whose condition could be the window");
        row.OpenNow.Should().BeNull();
        row.OpenNowReason.Should().Be("no_owner_entry");
    }

    /// <summary>
    /// The open answer is the engine's own list, never a flag this Mod set.
    ///
    /// WHAT THIS SUITE CANNOT PROVE, and says so rather than passing quietly: the 12:00-open / 02:00-closed flip
    /// cannot be asserted in an ordinary xUnit process. <c>ShopBuilder.GetCurrentOwners</c> evaluates the owner
    /// condition through <c>GameStateQuery.CheckConditions</c>, whose context constructor reads
    /// <c>Game1.currentLocation</c> and throws <c>NullReferenceException</c> with no mounted world - measured here on
    /// 2026-11-09, the same limit `ShopMenuHeadlessProbe.cs:13-16` records for the ShopMenu constructor. What IS
    /// asserted instead is that the row carries the engine's answer unchanged (true / false / null-plus-reason), and the
    /// engine's clock behaviour itself is proven where a real world exists: `ModEntry.Fixtures.ShopPurchase.cs:41-105`
    /// moves the clock to 12:00 and requires `GetCurrentOwners` to be non-empty before a live purchase attaches.
    /// </summary>
    [Fact]
    public void AnOwnerEntryWithNoConditionDeclaresNoWindow()
    {
        ShopData shop = SeedShop(Pierre(condition: null));

        BridgeSeedSupplyTarget row = Row(shop, new[] { Pierre(condition: null) });

        row.HoursCondition.Should().BeNull("a null condition is 'always', not a window this Mod invented");
        row.OpenNow.Should().Be(true);
    }

    [Fact]
    public void ASpecificItemIsMatchedByItsUnqualifiedRowIdToo()
    {
        // Vanilla writes shop item ids unqualified (`472`) far more often than qualified (`(O)472`), and a reader that
        // only compared the qualified form would report "no declared price" for the shop that does declare one.
        ShopData shop = SeedShop(Pierre());

        Row(shop, new[] { Pierre() }).DeclaredPrice.Should().Be(20);
    }

    [Fact]
    public void ASeedNobodyStocksIsARowWithTheSeedAndNoShopHalf()
    {
        BridgeSeedSupplyTarget row = ExecutionManager.SeedWithoutSupplyRow("(O)745", "Strawberry Seeds", heldCount: 1);

        row.QualifiedItemId.Should().Be("(O)745");
        row.HeldCount.Should().Be(1);
        row.ShopId.Should().BeNull("no shop in Data/Shops stocks it: that absence IS the answer");
        row.Price.Should().BeNull();
        row.Currency.Should().BeNull();
        row.OpenNow.Should().BeNull();
        row.OpenNowReason.Should().BeNull();
        // The address half is still written, and it names the reason: a row nothing could be reached from must say so
        // rather than leaving an empty field beside the absent price. `ShopAddressabilityTests` owns the rest.
        row.ShopDestination.Should().BeNull();
        row.ShopLocation.Should().BeNull();
        row.ShopLocationUnknown.Should().Be("no_shop_stocks_this_seed");
    }

    [Fact]
    public void AnUncountedPackIsNotAZero()
    {
        // The count comes from the published stack rows. When those were not published the row says nothing about the
        // count, because a zero derived from an absence would tell her she has none of a seed nobody counted.
        ShopData shop = SeedShop(Pierre());

        Row(shop, new[] { Pierre() }, heldCount: null).HeldCount.Should().BeNull();
    }
}
