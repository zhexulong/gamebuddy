// Tests for the first-binding gate in `HostFarmhandProvisioner.HandleRequest`.
//
// Scope, stated honestly: the gate's inputs come from a live `Farmer` (its
// `UniqueMultiplayerID`, its `isCustomized` net field, its two names) and from
// `Utility.FilterDirtyWords`, which needs content loaded, so the gate itself
// cannot be driven here. `FirstBindingRejection` is the one function that
// decides it, taking those facts as plain values; these tests hold that
// decision to the repository's existing meaning of a Farmhand id.
using FluentAssertions;
using GameBuddy.Stardew;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

public sealed class HostFarmhandProvisionerFirstBindingTests
{
    private const string ExpectedName = "琥珀";

    [Fact]
    public void NegativeSnowflakeId_IsAnIdentityAndTheBindingIsAccepted()
    {
        // SMAPI's `UniqueMultiplayerID` is a 64-bit snowflake: the sign bit is part
        // of the value, and the engine hands out negative ones (this is the id the
        // Mod's own SMAPI log recorded at the moment it refused the binding).
        const long snowflake = -1469028398930894610L;

        HostFarmhandProvisioner.FirstBindingRejection(snowflake, true, ExpectedName, ExpectedName, ExpectedName, string.Empty)
            .Should().BeNull();
    }

    [Fact]
    public void ZeroId_IsTheOnlyIdThatMeansNoIdentityYet()
    {
        HostFarmhandProvisioner.FirstBindingRejection(0, true, ExpectedName, ExpectedName, ExpectedName, string.Empty)
            .Should().Be("farmhand_not_initialized");
    }

    [Theory]
    [InlineData("琥珀 ", "琥珀")]
    [InlineData("琥珀", "琥珀 ")]
    [InlineData("", "琥珀")]
    public void CustomizedFarmhandWithTheWrongName_IsStillRefused(string observedName, string observedDisplayName)
    {
        // Both names are checked: the native CharacterCustomization screen keys off
        // `Name`, and the join UI shows `displayName`. A mismatch in either is the
        // uninitialized slot this gate exists to refuse.
        HostFarmhandProvisioner.FirstBindingRejection(-1, true, observedName, observedDisplayName, ExpectedName, string.Empty)
            .Should().Be("farmhand_not_initialized");
    }

    [Fact]
    public void UncustomizedFarmhand_IsStillRefused()
    {
        HostFarmhandProvisioner.FirstBindingRejection(-1469028398930894610L, false, ExpectedName, ExpectedName, ExpectedName, string.Empty)
            .Should().Be("farmhand_not_initialized");
    }

    [Fact]
    public void ExpectedFarmhandId_IsComparedAsAnEqualitySoASignIsNotASentinel()
    {
        const long snowflake = -1469028398930894610L;

        HostFarmhandProvisioner.FirstBindingRejection(snowflake, true, ExpectedName, ExpectedName, ExpectedName, snowflake.ToString())
            .Should().BeNull();
        HostFarmhandProvisioner.FirstBindingRejection(-1928590176183130079L, true, ExpectedName, ExpectedName, ExpectedName, snowflake.ToString())
            .Should().Be("expected_farmhand_mismatch");
        HostFarmhandProvisioner.FirstBindingRejection(snowflake, true, ExpectedName, ExpectedName, ExpectedName, "1469028398930894610")
            .Should().Be("expected_farmhand_mismatch");
    }
}
