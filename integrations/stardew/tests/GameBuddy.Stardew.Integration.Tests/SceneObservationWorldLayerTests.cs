using FluentAssertions;
using GameBuddy.Stardew.Navigation;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The world-layer disposition table. observe_scene iterates the game's own
/// content collections (the <c>GameLocation</c> field axis), not an ad-hoc list:
/// every layer the engine keeps is either published as affordances or excluded
/// with a written reason. This pins the table so a layer cannot silently vanish
/// (the scanner would keep working while the Agent loses a whole class of facts)
/// and a published layer cannot lose its exclusion reason with no review.
/// </summary>
public sealed class SceneObservationWorldLayerTests
{
    [Fact]
    public void EveryLayer_IsEitherPublishedOrExcludedWithAReason()
    {
        foreach (SceneWorldLayer layer in Enum.GetValues<SceneWorldLayer>())
        {
            bool published = SceneWorldLayerWire.IsPublished(layer);
            string reason = SceneWorldLayerWire.ExclusionReason(layer);

            // A published layer needs no reason; an unpublished layer MUST have
            // one, and no layer may fall through to the "unknown" arm.
            if (published)
            {
                continue;
            }

            reason.Should().NotBe("unknown world layer", $"layer {layer} must name a real reason");
            reason.Should().NotBeNullOrWhiteSpace();
        }
    }

    [Fact]
    public void PublishedLayers_AreExactlyTheCollectionsTheScannerCovers()
    {
        // The scanner publishes: placed objects (Forage/Machine/Chest/…), NPCs,
        // farm animals, terrain features (Crop/Tree), resource clumps (Debris) and
        // map-exit warps. Doors and its item-debris are delivered by their own
        // snapshot channels, so they are excluded here by design.
        SceneWorldLayer[] published =
        {
            SceneWorldLayer.Objects,
            SceneWorldLayer.Characters,
            SceneWorldLayer.Animals,
            SceneWorldLayer.TerrainFeatures,
            SceneWorldLayer.ResourceClumps,
            SceneWorldLayer.Warps,
        };
        published.Should().OnlyContain(layer => SceneWorldLayerWire.IsPublished(layer));
    }

    [Fact]
    public void ExcludedLayers_CarryMachineReadableReasons()
    {
        // These are the layers the game keeps that the scanner deliberately does
        // not publish. Each must have a concrete written reason -- an exclusion
        // without a reason is the same silent gap as a missing layer.
        foreach (SceneWorldLayer layer in Enum.GetValues<SceneWorldLayer>())
        {
            if (SceneWorldLayerWire.IsPublished(layer))
                continue;

            string reason = SceneWorldLayerWire.ExclusionReason(layer);
            reason.Should().NotBeNullOrWhiteSpace();
            reason.Should().NotBe("unknown world layer");
            reason.Length.Should().BeGreaterThan(20, $"reason for {layer} should say WHY, not just name it");
        }
    }

    [Theory]
    [InlineData("Objects", true)]
    [InlineData("Characters", true)]
    [InlineData("Animals", true)]
    [InlineData("TerrainFeatures", true)]
    [InlineData("ResourceClumps", true)]
    [InlineData("Warps", true)]
    [InlineData("Doors", false)]
    [InlineData("Debris", false)]
    [InlineData("Buildings", false)]
    [InlineData("Furniture", false)]
    [InlineData("LargeTerrainFeatures", false)]
    [InlineData("OverlayObjects", false)]
    [InlineData("MapSeats", false)]
    [InlineData("Critters", false)]
    [InlineData("Projectiles", false)]
    [InlineData("TemporarySprites", false)]
    [InlineData("Lights", false)]
    [InlineData("NetObjects", false)]
    [InlineData("ActiveTerrainFeatures", false)]
    [InlineData("InteriorDoors", false)]
    [InlineData("LightGlowLayerCache", false)]
    [InlineData("PostFarmEventOvernightActions", false)]
    public void LayerDisposition_IsStable(string layerName, bool published)
    {
        SceneWorldLayer layer = Enum.Parse<SceneWorldLayer>(layerName);

        SceneWorldLayerWire.IsPublished(layer).Should().Be(published);
    }

    [Fact]
    public void ClearableResourceClump_AcceptsTheNativeSwitchFamily_IncludingGreenRain()
    {
        // The native performToolAction switch clears 600/602 (axe family),
        // 148/622/672/752/754/756/758 (pickaxe family) and, through its default
        // arm, any IsGreenRainBush() clump -- sheet 44 or 46. The old inline list
        // missed the green-rain branch; the predicate is the single authority now.
        foreach (int sheet in new[] { 600, 602, 148, 622, 672, 752, 754, 756, 758, 44, 46 })
        {
            SceneAffordanceKindWire.IsClearableResourceClump(Clump(sheet)).Should().BeTrue($"sheet {sheet}");
        }

        // A sheet the switch never clears is not advertised.
        SceneAffordanceKindWire.IsClearableResourceClump(Clump(601)).Should().BeFalse();
        SceneAffordanceKindWire.IsClearableResourceClump(Clump(100)).Should().BeFalse();
    }

    private static StardewValley.TerrainFeatures.ResourceClump Clump(int sheet)
    {
        // Constructing a real ResourceClump needs a location; use the sheet-only
        // constructor the game uses for content data (parentSheetIndex is the
        // first argument).
        var clump = new StardewValley.TerrainFeatures.ResourceClump(sheet, 1, 1, new Microsoft.Xna.Framework.Vector2(0, 0));
        return clump;
    }
}