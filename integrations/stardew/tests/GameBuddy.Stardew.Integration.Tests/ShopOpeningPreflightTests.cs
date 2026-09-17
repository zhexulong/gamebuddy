using FluentAssertions;
using GameBuddy.Stardew.Navigation;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

public sealed class ShopOpeningPreflightTests
{
    private static readonly IReadOnlySet<string> ShopKeys = new HashSet<string>(StringComparer.Ordinal)
    {
        "SeedShop", "Saloon", "Blacksmith", "AnimalShop", "Carpenter", "FishShop", "JojaMart", "AdventureGuild",
    };

    [Fact]
    public void Evaluate_ShopDestinationOnFestivalDay_ReturnsClosingEvidence()
    {
        string? evidence = ShopOpeningPreflight.Evaluate("location:SeedShop", festivalToday: true, ShopKeys);
        evidence.Should().NotBeNull();
        evidence.Should().Be("destination=SeedShop;festival=true");
    }

    [Fact]
    public void Evaluate_ShopDestinationOnNormalDay_PassesThrough()
    {
        ShopOpeningPreflight.Evaluate("location:Saloon", festivalToday: false, ShopKeys).Should().BeNull();
    }

    [Fact]
    public void Evaluate_NonShopDestinationOnFestivalDay_PassesThrough()
    {
        // Backwoods / mines / outdoor areas are not store-class: no pre-flight.
        ShopOpeningPreflight.Evaluate("location:Backwoods", festivalToday: true, ShopKeys).Should().BeNull();
        ShopOpeningPreflight.Evaluate("location:Mine", festivalToday: true, ShopKeys).Should().BeNull();
    }

    [Fact]
    public void Evaluate_NonLocationIdentity_PassesThrough()
    {
        ShopOpeningPreflight.Evaluate("Undermine", festivalToday: true, ShopKeys).Should().BeNull();
        ShopOpeningPreflight.Evaluate(null, festivalToday: true, ShopKeys).Should().BeNull();
        ShopOpeningPreflight.Evaluate(string.Empty, festivalToday: true, ShopKeys).Should().BeNull();
    }

    [Fact]
    public void Evaluate_UnknownShopKeyOrEmptySet_PassesThrough()
    {
        ShopOpeningPreflight.Evaluate("location:SomeCustomShop", festivalToday: true, ShopKeys).Should().BeNull();
        ShopOpeningPreflight.Evaluate("location:SeedShop", festivalToday: true, new HashSet<string>(StringComparer.Ordinal)).Should().BeNull();
    }

    [Fact]
    public void ExtractLocationName_LocalizedAndInvalidShapes()
    {
        ShopOpeningPreflight.ExtractLocationName("location:SeedShop").Should().Be("SeedShop");
        ShopOpeningPreflight.ExtractLocationName("location:Mountain").Should().Be("Mountain");
        ShopOpeningPreflight.ExtractLocationName("Undermine").Should().BeNull();
        ShopOpeningPreflight.ExtractLocationName("location:").Should().BeNull();
        ShopOpeningPreflight.ExtractLocationName(new string('a', 200)).Should().BeNull();
    }
}