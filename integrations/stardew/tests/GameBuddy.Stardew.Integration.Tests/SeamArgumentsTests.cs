using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Handlers;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// What an absent wire argument means, asserted against the one place that answers it.
///
/// A dispatch arm hands its execution seam a concrete value for an argument the wire makes optional, so the default is
/// one fact with one statement (<see cref="SeamArguments"/>). An arm that carried its own projection could disagree with
/// its neighbours about the same absent argument and neither arm would look wrong.
/// </summary>
public sealed class SeamArgumentsTests
{
    private static BridgeExecutionRequest Request(BridgeExecutionArgs args) =>
        new("req_seam_arguments", "idemp_seam_arguments", "water_crop", args, 1, 5000);

    [Fact]
    public void AbsentArguments_TakeTheSeamDefaults()
    {
        BridgeExecutionRequest request = Request(new BridgeExecutionArgs());

        request.TargetX().Should().Be(0);
        request.TargetY().Should().Be(0);
        request.TargetId().Should().BeEmpty();
        request.Charge().Should().Be(0);
    }

    [Fact]
    public void PresentArguments_AreCarriedUnchanged()
    {
        BridgeExecutionRequest request = Request(new BridgeExecutionArgs
        {
            X = 42,
            Y = 7,
            ExpectedTargetId = "hoe_dirt_0123456789abcdef",
            Charge = 2,
        });

        request.TargetX().Should().Be(42);
        request.TargetY().Should().Be(7);
        request.TargetId().Should().Be("hoe_dirt_0123456789abcdef");
        request.Charge().Should().Be(2);
    }

    /// <summary>
    /// The truncation is the one the arms performed with a cast: toward zero, not down. A tile west or north of the
    /// origin carries a negative coordinate, and flooring it would hand the seam a target one tile further away.
    /// </summary>
    [Theory]
    [InlineData(3.75f, 3)]
    [InlineData(-1.75f, -1)]
    [InlineData(-0.5f, 0)]
    [InlineData(0f, 0)]
    public void AFractionalTile_TruncatesTowardZero(float wire, int expected)
    {
        BridgeExecutionRequest request = Request(new BridgeExecutionArgs { X = wire, Y = wire });

        request.TargetX().Should().Be(expected);
        request.TargetY().Should().Be(expected);
    }
}
