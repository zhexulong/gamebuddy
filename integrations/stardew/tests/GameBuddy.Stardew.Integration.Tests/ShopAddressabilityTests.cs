using System;
using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using StardewValley;
using StardewValley.GameData.Shops;
using Xunit;
using static GameBuddy.Stardew.Integration.Tests.TargetFamilyCompletenessTests;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// `seedSupplyTargets`' ADDRESS half: where the shop that sells her seed actually IS.
///
/// <para>
/// Measured 2026-11-09 (round40): `plant_seed` landed two tiles because the world gave her two seeds, `shop_purchase`
/// was called zero times, and the shortage fact DID reach her - it named `shopId=SeedShop`, the owner, the price and the
/// trading window - but nothing named a place to walk to. `shopTargets` publishes only shops whose owner stands in the
/// CURRENT location, so on the farm at 06:00 it is empty, and "go and buy seed" had no first step. `shopId` is the
/// shop's identity in `Data/Shops`; it is not a position in the world.
/// </para>
/// <para>
/// The rule this suite pins: the MOD states the world fact and the Host only reads it. The waypoint is therefore
/// SELECTED from the row `DiscoverShopTargets` already published - the same `TargetId` `shop_purchase` takes - and never
/// minted here, so the two families cannot disagree about which counter is where. When the counter is elsewhere, the row
/// names the location instead, and when neither can be read it names the reason: a price and an open-now answer with an
/// empty address beside them would read as a shop she can walk to.
/// </para>
/// </summary>
public sealed class ShopAddressabilityTests
{
    private const string ParsnipSeeds = "(O)472";

    private static ShopOwnerData Pierre() => new() { Name = "Pierre", Condition = "TIME 900 2100" };

    private static ShopData SeedShopData() => new()
    {
        Currency = 0,
        Owners = new List<ShopOwnerData> { Pierre() },
        Items = new List<ShopItemData>
        {
            new() { Id = "parsnip-seeds", ItemId = "472", Price = 20, AvailableStock = int.MaxValue },
        },
    };

    private static BridgeSeedSupplyTarget Row(
        GameLocation? owningLocation,
        IReadOnlyList<BridgeShopTarget>? shopTargetsHere = null) =>
        ExecutionManager.SeedSupplyRow(
            ParsnipSeeds,
            "Parsnip Seeds",
            heldCount: 2,
            shopId: "SeedShop",
            shopDisplayName: "Pierre's General Store",
            SeedShopData(),
            price: 20,
            eligibleOwners: new[] { Pierre() },
            shopTargetsHere,
            owningLocation);

    /// <summary>
    /// The counter is in the room she is standing in, so the row carries the PUBLISHED shop row: the same identity, the
    /// same tile and the same location `shopTargets` published. This is the single-authority assertion - the destination
    /// is not a second measurement of the shop, it IS the row, selected out of the list one discovery produced.
    /// </summary>
    [Fact]
    public void TheWaypointIsThePublishedShopTargetRowItself()
    {
        using var world = TargetFamilyWorld.Create();
        BridgeShopTarget published = new(
            ExecutionManager.ShopTargetId("SeedShop", "Pierre"),
            "SeedShop",
            "Pierre",
            world.Farm.NameOrUniqueName,
            4,
            8,
            true,
            12,
            new[] { ParsnipSeeds });

        BridgeSeedSupplyTarget row = Row(world.Farm, new[] { published });

        row.ShopDestination.Should().NotBeNull("the counter is in this room, so the row can name where to walk");
        row.ShopDestination!.TargetId.Should().Be(
            published.TargetId,
            "the destination IS the published shop row; a second identity would agree today and disagree with "
            + "`shop_purchase` tomorrow");
        row.ShopDestination.Location.Should().Be(published.Location);
        row.ShopDestination.Tile.Should().Be(new BridgeTile(published.OwnerTileX, published.OwnerTileY));
        row.ShopDestination.Label.Should().Be("Pierre", "the label names the counter she walks up to");
        row.ShopLocation.Should().BeNull("a waypoint is strictly more than the room it is in");
        row.ShopLocationUnknown.Should().BeNull();
    }

    /// <summary>
    /// Another shop's counter in this room is not THIS shop's waypoint: the row falls back to the location the shop id
    /// names, which is the room to head for and explicitly not a destination.
    /// </summary>
    [Fact]
    public void AnotherShopsCounterIsNotThisShopsWaypoint()
    {
        using var world = TargetFamilyWorld.Create();
        BridgeShopTarget robin = new(
            ExecutionManager.ShopTargetId("Carpenter", "Robin"),
            "Carpenter",
            "Robin",
            world.Farm.NameOrUniqueName,
            9,
            4,
            true,
            3,
            Array.Empty<string>());

        BridgeSeedSupplyTarget row = Row(world.Farm, new[] { robin });

        row.ShopDestination.Should().BeNull("walking to Robin does not buy seed");
        row.ShopLocation.Should().Be(
            world.Farm.NameOrUniqueName,
            "the location comes from the GameLocation the shop id names, read through NameOrUniqueName - the same read "
            + "`shopTargets` publishes its own location with");
        row.ShopLocationUnknown.Should().BeNull();
    }

    /// <summary>
    /// Neither a counter nor a readable location: the row NAMES why. An absent address beside a real price is the defect
    /// this half exists to remove, so the absence is a stated fact rather than an empty field.
    /// </summary>
    [Fact]
    public void AnUnreadableLocationIsNamedRatherThanPublishedAsEmpty()
    {
        BridgeSeedSupplyTarget row = Row(owningLocation: null);

        row.Price.Should().Be(20, "the offer is still known; only the address is not");
        row.ShopDestination.Should().BeNull();
        row.ShopLocation.Should().BeNull("an empty location string would read as a place with no name");
        row.ShopLocationUnknown.Should().Be("shop_location_unreadable");
    }

    /// <summary>
    /// A shop can publish more than one counter in the same room (two eligible owner entries), and the row names ONE of
    /// them: its hours entry. The destination is that owner's counter, so the waypoint she walks to is the counter the
    /// published trading window belongs to - not merely the first row this shop happened to produce.
    /// </summary>
    [Fact]
    public void TheDestinationIsTheCounterOfTheOwnerTheRowNames()
    {
        using var world = TargetFamilyWorld.Create();
        BridgeShopTarget first = new(
            ExecutionManager.ShopTargetId("SeedShop", "Claude"),
            "SeedShop",
            "Claude",
            world.Farm.NameOrUniqueName,
            2,
            3,
            true,
            4,
            Array.Empty<string>());
        BridgeShopTarget pierres = new(
            ExecutionManager.ShopTargetId("SeedShop", "Pierre"),
            "SeedShop",
            "Pierre",
            world.Farm.NameOrUniqueName,
            4,
            8,
            true,
            12,
            new[] { ParsnipSeeds });

        BridgeSeedSupplyTarget row = Row(world.Farm, new[] { first, pierres });

        row.OwnerName.Should().Be("Pierre", "the row publishes the owner whose hours query it carries");
        row.ShopDestination!.TargetId.Should().Be(
            pierres.TargetId,
            "the counter that owner stands at is the address that entry describes, not the first counter of the shop");
        row.ShopDestination.Tile.Should().Be(new BridgeTile(pierres.OwnerTileX, pierres.OwnerTileY));
    }

    /// <summary>
    /// Every row states EXACTLY ONE of the three. A row with two would leave the reader choosing; a row with none would
    /// leave a price and an open-now answer looking reachable. The population is every shape this projection produces,
    /// including the row for a seed no shop stocks.
    /// </summary>
    [Fact]
    public void ExactlyOneAddressMemberIsWrittenOnEveryRow()
    {
        using var world = TargetFamilyWorld.Create();
        BridgeShopTarget published = new(
            ExecutionManager.ShopTargetId("SeedShop", "Pierre"),
            "SeedShop",
            "Pierre",
            world.Farm.NameOrUniqueName,
            4,
            8,
            true,
            12,
            new[] { ParsnipSeeds });

        BridgeSeedSupplyTarget[] rows =
        {
            ExecutionManager.SeedWithoutSupplyRow(ParsnipSeeds, "Parsnip Seeds", heldCount: 1),
            Row(world.Farm, new[] { published }),
            Row(world.Farm),
            Row(owningLocation: null),
        };

        foreach (BridgeSeedSupplyTarget row in rows)
        {
            int written = (row.ShopDestination is not null ? 1 : 0)
                + (row.ShopLocation is not null ? 1 : 0)
                + (row.ShopLocationUnknown is not null ? 1 : 0);
            written.Should().Be(
                1,
                $"{row.QualifiedItemId} must state exactly one of a waypoint, a location, or the reason it has neither");
        }

        rows.Select(row => row.ShopLocationUnknown)
            .Should()
            .Equal(
                new string?[] { "no_shop_stocks_this_seed", null, null, "shop_location_unreadable" },
                "a seed nobody sells and a shop whose room could not be read are different problems");
    }
}
