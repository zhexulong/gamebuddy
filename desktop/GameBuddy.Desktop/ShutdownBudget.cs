using System.Diagnostics;

namespace GameBuddy.Desktop;

/// <summary>
/// The one number a quit may spend making processes go away, and the record of what it spent.
///
/// A quit waits for two processes, and they were two waits with two budgets while only one of them was
/// measured. Closing the authenticated broker is the arm: it gives the Host child its controller EOF
/// and gives the native Guardian the control EOF that makes it contain the roles it created. The
/// Guardian's exit was awaited with a ceiling of this launcher's own BEFORE the child's wait began, so
/// the player sat through two waits counted separately, and the number this launcher recorded for the
/// child's teardown excluded the Guardian's entirely - it could not describe the quit it belonged to.
///
/// A budget starts at the arm and every wait draws on it: <see cref="RemainingMs"/> is what is left, so
/// the child's wait can only spend what the Guardian's did not, and <see cref="ConsumedMs"/> is what
/// the player waited - the number the teardown record carries.
///
/// The declared number is the child's own <c>drainDeadlineMs</c>, taken from the acknowledgement it
/// published. There is no second copy of it anywhere: a budget is spent, never extended.
/// </summary>
internal sealed class ShutdownBudget
{
    private readonly Stopwatch elapsed = Stopwatch.StartNew();
    private readonly long declaredMs;

    internal ShutdownBudget(long declaredMs) => this.declaredMs = Math.Max(0, declaredMs);

    /// <summary>The declared number this quit may spend in total.</summary>
    internal long DeclaredMs => declaredMs;

    /// <summary>
    /// What is left of the declared number, never negative: 0 means the quit has no further wait to
    /// give, and is the value a wait should pass through when it must not add time of its own.
    /// </summary>
    internal long RemainingMs => Math.Max(0, declaredMs - elapsed.ElapsedMilliseconds);

    /// <summary>What this quit has spent so far, which is the wait the player experiences.</summary>
    internal long ConsumedMs => elapsed.ElapsedMilliseconds;

    /// <summary>
    /// A wait's own ceiling, in the form <see cref="WindowsNative.WaitForSingleObject"/> takes, that can
    /// never extend the budget: a Guardian may need its containment ceiling, and it may not spend more
    /// than the quit has left.
    /// </summary>
    internal uint Take(long ceilingMs) => (uint)Math.Clamp(Math.Min(ceilingMs, RemainingMs), 0, int.MaxValue);
}
