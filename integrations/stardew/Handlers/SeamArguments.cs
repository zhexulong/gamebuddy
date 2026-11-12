using GameBuddy.Stardew.Core.Models;

namespace GameBuddy.Stardew.Handlers;

/// <summary>
/// One inbound request's optional arguments, as the seams take them.
///
/// Every argument is optional on the wire and every seam asks for a concrete value, so "what an absent argument means"
/// is ONE fact, and it is answered here once. It was respelled at each dispatch arm instead - <c>(int)(request.Args.X ?? 0)</c>,
/// <c>request.Args.ExpectedTargetId ?? string.Empty</c>, <c>request.Args.Charge ?? 0</c> - so an action that came to need a
/// different default had no single place to say so, and seventeen arms across three families carried the same four
/// projections as their own text.
///
/// Each call evaluates exactly the expression its arms carried before. The resource/tool family states the same four
/// facts in <c>ResourceToolCall</c>, the view its own arms name their arguments through; that view is one commit behind
/// this one because folding it in moves two windows a recorded duplication baseline pins.
/// </summary>
internal static class SeamArguments
{
    /// <summary>The tile column: the wire carries a float, every seam takes the truncated column.</summary>
    internal static int TargetX(this BridgeExecutionRequest request) => (int)(request.Args.X ?? 0);

    /// <summary>The tile row: the wire carries a float, every seam takes the truncated row.</summary>
    internal static int TargetY(this BridgeExecutionRequest request) => (int)(request.Args.Y ?? 0);

    /// <summary>The opaque id of the target the caller believes it is acting on, empty when it names none.</summary>
    internal static string TargetId(this BridgeExecutionRequest request) => request.Args.ExpectedTargetId ?? string.Empty;

    /// <summary>How far the actor charges its tool before one native use, or the vanilla tap when it names none.</summary>
    internal static int Charge(this BridgeExecutionRequest request) => request.Args.Charge ?? 0;
}
