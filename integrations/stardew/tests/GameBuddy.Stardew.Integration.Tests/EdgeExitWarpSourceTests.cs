using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using StardewValley;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The source coordinate of an edge exit, asked of the ENGINE rather than of a comment: the map's own warp table is
/// <c>IList&lt;Warp&gt;</c>, and an edge exit is a <see cref="Warp"/> whose source column (or row) is <c>-1</c> - one tile
/// outside the grid - because the boundary IS the trigger (`-1 53 BusStop 20 12` in Town's map asset).
///
/// <para>
/// This is the premise the whole transition contract rests on, and it is pinned on the engine type that carries it: if a
/// future engine version clamped or rejected an off-map source, this fails here instead of surfacing as a model that
/// cannot leave Town. The Mod publishes, admits and resolves exactly this object, so the range the producer and the
/// admission validator share must accept it.
/// </para>
/// </summary>
public sealed class EdgeExitWarpSourceTests
{
    [Fact]
    public void TheEngineCarriesAnEdgeExitsSourceAsMinusOne()
    {
        var westExit = new Warp(-1, 53, "BusStop", 20, 12, flipFarmer: false);
        var northExit = new Warp(79, -1, "Mountain", 44, 6, flipFarmer: false);

        westExit.X.Should().Be(-1, "the west edge's source column is the boundary, not an in-map tile");
        northExit.Y.Should().Be(-1, "and the north edge's source row likewise");
        // The DESTINATION is an ordinary map cell on both, which is why the two ranges are declared separately.
        FarmhandWarpCoordinateRange.IsPublishableSource(westExit.X, westExit.Y)
            .Should().BeTrue("the snapshot publishes this warp, so its source is inside the published range");
        FarmhandWarpCoordinateRange.IsPublishableDestination(westExit.TargetX, westExit.TargetY)
            .Should().BeTrue("and it arrives on a tile a body can occupy");
        FarmhandWarpCoordinateRange.IsPublishableDestination(westExit.X, westExit.Y)
            .Should().BeFalse("the same coordinate is NOT a legal destination or walk target");
    }
}
