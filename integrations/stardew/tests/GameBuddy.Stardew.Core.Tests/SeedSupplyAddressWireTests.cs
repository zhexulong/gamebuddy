using System.Text.Json;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Protocol;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// The wire spelling of the `seedSupplyTargets` address half: the exact three keys and the rule that exactly one of them
/// is written.
///
/// <para>
/// The Host validates this family with an exact-key set (`host/src/protocol-target-facts.ts`
/// <c>isSeedSupplyTargetFact</c>), so a key spelled differently here - or a member written as an explicit <c>null</c>
/// where the Host reads ABSENT as "not measured" - rejects the WHOLE snapshot. Measured twice already on other families
/// (`sceneTarget`, `cropTargets`), which is why the spelling is asserted at the serializer rather than described in a
/// comment: <c>BridgeProtocol.JsonOptions</c> is camelCase and omits nulls, and both halves are checked below.
/// </para>
/// </summary>
public sealed class SeedSupplyAddressWireTests
{
    private const string ParsnipSeeds = "(O)472";

    private static JsonElement Json(BridgeSeedSupplyTarget row)
    {
        using JsonDocument document = JsonDocument.Parse(JsonSerializer.Serialize(row, BridgeProtocol.JsonOptions));
        return document.RootElement.Clone();
    }

    [Fact]
    public void AWaypointIsWrittenUnderShopDestinationWithItsOwnFourKeys()
    {
        BridgeSeedSupplyTarget row = new(
            ParsnipSeeds, "Parsnip Seeds", 2, "SeedShop", "Pierre's General Store", "Pierre", "TIME 900 2100", 20, 20, 0,
            true, null,
            ShopDestination: new BridgeSeedSupplyDestination("SeedShop", "shop_0123456789abcdef", new BridgeTile(4, 8), "Pierre"),
            ShopLocation: null,
            ShopLocationUnknown: null);

        JsonElement json = Json(row);

        json.TryGetProperty("shopDestination", out JsonElement destination).Should().BeTrue(
            "the Host's key set is exact; `shopDestination` is the spelling it will be taught to accept");
        destination.TryGetProperty("location", out _).Should().BeTrue();
        destination.TryGetProperty("targetId", out JsonElement targetId).Should().BeTrue();
        targetId.GetString().Should().Be("shop_0123456789abcdef");
        destination.TryGetProperty("tile", out JsonElement tile).Should().BeTrue();
        tile.GetProperty("x").GetDouble().Should().Be(4);
        tile.GetProperty("y").GetDouble().Should().Be(8);
        destination.TryGetProperty("label", out JsonElement label).Should().BeTrue();
        label.GetString().Should().Be("Pierre");

        json.TryGetProperty("shopLocation", out _).Should().BeFalse("a waypoint is not a bare location");
        json.TryGetProperty("shopLocationUnknown", out _).Should().BeFalse();
    }

    [Fact]
    public void ALocationOnlyRowAndAReasonOnlyRowAreWrittenUnderTheirOwnKeys()
    {
        BridgeSeedSupplyTarget located = new(
            ParsnipSeeds, "Parsnip Seeds", 2, "SeedShop", "Pierre's General Store", "Pierre", null, 20, 20, 0, null, null,
            ShopDestination: null,
            ShopLocation: "SeedShop",
            ShopLocationUnknown: null);
        BridgeSeedSupplyTarget unreadable = new(
            ParsnipSeeds, "Parsnip Seeds", 2, null, null, null, null, null, null, null, null, null,
            ShopDestination: null,
            ShopLocation: null,
            ShopLocationUnknown: "no_shop_stocks_this_seed");

        JsonElement locatedJson = Json(located);
        locatedJson.GetProperty("shopLocation").GetString().Should().Be("SeedShop");
        locatedJson.TryGetProperty("shopDestination", out _).Should().BeFalse();
        locatedJson.TryGetProperty("shopLocationUnknown", out _).Should().BeFalse();

        JsonElement unreadableJson = Json(unreadable);
        unreadableJson.GetProperty("shopLocationUnknown").GetString().Should().Be("no_shop_stocks_this_seed");
        unreadableJson.TryGetProperty("shopLocation", out _).Should().BeFalse(
            "a null member is OMITTED, never written as `null`: the Host reads absent as not measured");
        unreadableJson.TryGetProperty("shopDestination", out _).Should().BeFalse();
    }
}
