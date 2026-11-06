namespace GameBuddy.Stardew.Core.Policy;

/// <summary>
/// The one declaration of which tiles a location transition may name as its SOURCE and which it may publish as its
/// DESTINATION.
///
/// <para>
/// The SOURCE floor is <c>-1</c> and not <c>0</c>, because that is the engine's own encoding for an edge exit: walking
/// off the west edge warps from <c>X = -1</c> and off the north edge from <c>Y = -1</c>, so the source tile lies
/// outside the grid by construction. <c>Town</c> declares three of its exits that way (<c>-1 53 BusStop</c>,
/// <c>79 -1 Mountain</c>, <c>-1 89 Forest</c>), and the snapshot publishes them because that is what
/// <c>location.warps</c> holds.
/// </para>
/// <para>
/// A DESTINATION is an ordinary map cell, so its floor is zero; so is a walk target, which is why the two predicates are
/// separate rather than one range used for both.
/// </para>
/// <para>
/// This fact used to have three spellings that disagreed: the snapshot publisher's inline filter admitted <c>-1</c>, the
/// navigation topology's <c>SourceCoordinateInRange</c> admitted <c>-1</c>, and the execution acceptance validator
/// required <c>0</c> for every coordinate on the wire. The result was a Mod that published an exit it refused to
/// execute - <c>travel</c>/<c>enter_exit</c> toward an edge exit answered <c>invalid_execution_request</c>, and
/// Town&lt;-&gt;Farm edge transitions were dead. Every consumer now reads this type.
/// </para>
/// </summary>
public static class FarmhandWarpCoordinateRange
{
    /// <summary>
    /// The largest legal tile index, source or destination. One bound for both, so a later reader cannot tighten one
    /// and leave the other.
    /// </summary>
    public const int MaximumCoordinate = 1000;

    /// <summary>Where a warp's SOURCE may be: on the map, or one tile outside it for an edge exit.</summary>
    public const int MinimumSourceCoordinate = -1;

    /// <summary>Where a warp's DESTINATION may be, and where any walk target must be: an ordinary map cell.</summary>
    public const int MinimumDestinationCoordinate = 0;

    /// <summary>Whether a warp with this source tile can be published from a location's own warp table.</summary>
    public static bool IsPublishableSource(int x, int y) =>
        x >= MinimumSourceCoordinate
        && y >= MinimumSourceCoordinate
        && x <= MaximumCoordinate
        && y <= MaximumCoordinate;

    /// <summary>Whether this arrival tile can be published as a warp's destination.</summary>
    public static bool IsPublishableDestination(int x, int y) =>
        x >= MinimumDestinationCoordinate
        && y >= MinimumDestinationCoordinate
        && x <= MaximumCoordinate
        && y <= MaximumCoordinate;
}
