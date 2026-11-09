using FluentAssertions;
using GameBuddy.Stardew.Core;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// The one rule that decides whether a mine descent is a step the published surface can answer.
///
/// <para>
/// The surface has no combat action, so a floor that spawns hostiles asks for a capability that does not exist. What
/// this pins is that the monster-free set is the ENGINE's rule rather than a convenient list: level 1, and the elevator
/// floors the mine is laid out around, up to the elevator ceiling. The cases a hand-written list would get wrong are
/// here by name - the `% 5` floors, where the engine zeroes only items and gems, and the floors above 120, where the
/// shaft is the Skull Cavern and the every-tenth rule stops applying.
/// </para>
/// </summary>
public sealed class MineFloorCapabilityTests
{
    [Fact]
    public void TheMonsterFreeFloorsAreLevelOneAndTheElevatorFloorsUpToTheCeiling()
    {
        MineFloorCapability.MonsterFreeFloors.Should().Equal(
            new[] { 1, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120 },
            "the engine zeroes the spawn chance on level 1 and every tenth level, and the elevator ceiling bounds it");
    }

    [Theory]
    // The engine's own monster-free floors.
    [InlineData(1, true)]
    [InlineData(10, true)]
    [InlineData(60, true)]
    [InlineData(120, true)]
    // Floor 0 is the mine ENTRANCE map, which is not a generated floor at all.
    [InlineData(0, false)]
    // Every other floor in the mines rolls a non-zero spawn chance.
    [InlineData(2, false)]
    [InlineData(9, false)]
    // Every fifth floor zeroes the ITEM and gem chances and leaves the monsters (MineShaft.cs:1239-1247).
    [InlineData(15, false)]
    [InlineData(105, false)]
    // Past the elevator ceiling the shaft is the Skull Cavern, where the every-tenth rule stops applying.
    [InlineData(130, false)]
    [InlineData(200, false)]
    public void IsMonsterFreeReadsTheEngineRule(int floor, bool expected)
    {
        MineFloorCapability.IsMonsterFree(floor).Should().Be(expected, "the engine's own spawn rule decides it");
    }

    [Fact]
    public void TheRefusalNamesTheFloorAndTheMissingCapability()
    {
        MineFloorCapability.RefusalReasonCode.Should().Be(
            "mine_floor_requires_unpublished_capability:combat",
            "the caller branches on this code, so its spelling is the contract");

        string evidence = MineFloorCapability.DescribeRefusal(37);

        evidence.Should().StartWith("mine_floor_requires_unpublished_capability:combat");
        evidence.Should().Contain("floor=37", "which floor was asked for");
        evidence.Should().Contain("monster_free_levels=1,10,20,", "and which floors this surface CAN answer");
    }
}
