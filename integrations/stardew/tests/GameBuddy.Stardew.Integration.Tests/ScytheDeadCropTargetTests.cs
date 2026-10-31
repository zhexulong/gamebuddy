using FluentAssertions;
using StardewValley.GameData.Crops;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Which crop tiles the scythe owns — the decision behind both the published <c>scytheCropTargets</c> radar and
/// <c>scythe_crop</c>'s own admission.
///
/// <para>
/// The engine gives a scythe two finishes and they are different terminals. <c>HoeDirt.performToolAction</c>
/// (HoeDirt.cs:713-731) harvests only when <c>GetHarvestMethod() == Scythe</c> AND <c>readyForHarvest()</c>, which
/// (HoeDirt.cs:465-476) requires <c>!crop.dead.Value</c>. The dead branch (HoeDirt.cs:732-735) fires on
/// <c>crop.dead.Value</c> alone — any crop, any harvest method, no readiness test.
/// </para>
/// <para>
/// A crop goes dead when the season turns over: <c>HoeDirt.dayUpdate</c> → <c>Crop.newDay</c>
/// (Crop.cs:835-839) calls <c>Kill()</c> for any outdoor crop that is out of season. Such a crop is not
/// <c>readyForHarvest()</c>, needs no water and blocks <c>plant_seed</c>, so without this branch it is invisible
/// to every radar AND unreachable by every action: a tile lost forever.
/// </para>
/// </summary>
public sealed class ScytheDeadCropTargetTests
{
    [Fact]
    public void ADeadCropIsAScytheTargetEvenThoughItCanNeverBeRipe()
    {
        // The defect, stated as the engine states it: dead and ready are mutually exclusive, so a radar filtered on
        // readiness can never see the one branch that exists precisely for dead crops.
        bool owned = ExecutionManager.ScytheCropTarget(
            hasCrop: true,
            forageCrop: false,
            readyForHarvest: false,
            harvestMethod: HarvestMethod.Grab,
            dead: true,
            out bool deadCrop);

        owned.Should().BeTrue("crop.dead is the scythe's own clear branch, independent of readiness and method");
        deadCrop.Should().BeTrue("the caller must know this tile can only be cleared, so it promises no harvest");
    }

    [Fact]
    public void ALivingReadyScytheMethodCropIsStillTheHarvestTarget()
    {
        bool owned = ExecutionManager.ScytheCropTarget(
            hasCrop: true,
            forageCrop: false,
            readyForHarvest: true,
            harvestMethod: HarvestMethod.Scythe,
            dead: false,
            out bool deadCrop);

        owned.Should().BeTrue();
        deadCrop.Should().BeFalse();
    }

    [Fact]
    public void ALivingReadyGrabCropStaysWithHarvestCrop()
    {
        // Ordinary Grab-method crops are harvest_crop's, exactly as before; the dead branch must not widen this.
        ExecutionManager.ScytheCropTarget(
            hasCrop: true,
            forageCrop: false,
            readyForHarvest: true,
            harvestMethod: HarvestMethod.Grab,
            dead: false,
            out _).Should().BeFalse();
    }

    [Fact]
    public void AForageCropStaysOutOfTheScythesHarvestBranch()
    {
        // forageCrop is excluded from the harvest branch because Crop.harvest would take its own path; but a DEAD
        // forage crop is still the scythe's to clear, because the clear branch is not the harvest branch.
        ExecutionManager.ScytheCropTarget(
            hasCrop: true,
            forageCrop: true,
            readyForHarvest: true,
            harvestMethod: HarvestMethod.Scythe,
            dead: false,
            out _).Should().BeFalse();

        ExecutionManager.ScytheCropTarget(
            hasCrop: true,
            forageCrop: true,
            readyForHarvest: false,
            harvestMethod: HarvestMethod.Scythe,
            dead: true,
            out bool deadCrop).Should().BeTrue();
        deadCrop.Should().BeTrue();
    }

    [Fact]
    public void AnEmptyHoeDirtIsNotAScytheTargetAtAll()
    {
        // No crop, no branch. An empty tile belongs to clear_hoedirt, not to the scythe.
        ExecutionManager.ScytheCropTarget(
            hasCrop: false,
            forageCrop: false,
            readyForHarvest: false,
            harvestMethod: HarvestMethod.Scythe,
            dead: false,
            out bool deadCrop).Should().BeFalse();
        deadCrop.Should().BeFalse();
    }
}
