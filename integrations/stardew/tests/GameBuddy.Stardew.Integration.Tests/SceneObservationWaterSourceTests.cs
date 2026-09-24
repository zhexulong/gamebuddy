using FluentAssertions;
using GameBuddy.Stardew.Navigation;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Lane A.2: WaterSource affordance kind contract pins.
///
/// The wire value for SceneAffordanceKind.WaterSource must be exactly
/// "water_source" and the ref prefix "w", matching the Host schema
/// (OBSERVE_SCENE_KINDS). The scene producer binds the affordance to the
/// standable neighbor tile, never the water tile.
///
/// Structural assertions run without a Game1 harness; the live water-edge
/// projection belongs to the native-local fixture lane per
/// fixtures/stardew/RUNBOOK.md.
/// </summary>
public sealed class SceneObservationWaterSourceTests
{
    [Fact]
    public void SceneAffordanceKindWire_WaterSource_IsDefinedWithExactWireValueAndRefPrefix()
    {
        SceneAffordanceKindWire.IsDefined(SceneAffordanceKind.WaterSource).Should().BeTrue();
        SceneAffordanceKindWire.ToWireValue(SceneAffordanceKind.WaterSource).Should().Be("water_source");
    }

    [Fact]
    public void SceneAffordanceSource_WaterSource_ProducesValidBoundWithActionHint()
    {
        var source = new SceneAffordanceSource(
            SceneAffordanceKind.WaterSource,
            "Water",
            "water_source:15,20",
            "Farm",
            14,
            20,
            "refill_watering_can");

        source.IsValid.Should().BeTrue();
        source.Kind.Should().Be(SceneAffordanceKind.WaterSource);
        source.ActionHint.Should().Be("refill_watering_can");
        // The tile carried by the source is the standable neighbor, not the water.
        source.TileX.Should().Be(14);
        source.TileY.Should().Be(20);
        source.OpaqueEntityIdentity.Should().StartWith("water_source:");
    }

    /// <summary>
    /// Regression: the world-object classifier must not collapse unsupported
    /// objects into a default kind. The previous inline fallback labelled weeds,
    /// stones, artifact spots and fences as `chest`, which the wire validator
    /// could not catch because `chest` is a legal kind.
    /// </summary>
    [Theory]
    [InlineData(true, false, false, "Forage")]
    [InlineData(false, true, false, "Machine")]
    [InlineData(false, false, true, "Chest")]
    [InlineData(true, true, false, "Forage")]
    public void ClassifyWorldObject_MapsSupportedObjectsToTheirExactKind(
        bool isForage,
        bool hasMachineData,
        bool isChest,
        string expected)
    {
        SceneAffordanceKindWire.ClassifyWorldObject(isForage, hasMachineData, isChest)
            .Should().Be(Enum.Parse<SceneAffordanceKind>(expected));
    }

    [Fact]
    public void ClassifyWorldObject_UnsupportedObject_IsNullRatherThanDefaultingToChest()
    {
        // A weed / stone / artifact spot / fence: forage=false, no machine data,
        // not a chest. It must NOT be published as `chest`.
        SceneAffordanceKindWire.ClassifyWorldObject(isForage: false, hasMachineData: false, isChest: false)
            .Should().BeNull();
    }
}