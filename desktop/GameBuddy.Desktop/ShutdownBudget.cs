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
/// <para>
/// That number is the SUM of the child's own step ceilings, so it bounds those steps and nothing else.
/// The quit also has to cover the delivery of the orchestrating EOF that starts them, the child's exit
/// once its last step is done, and this launcher noticing that exit - all outside the declaration by
/// construction. So a budget carries one margin beside it (<see cref="MarginMs"/>) and
/// <see cref="LimitMs"/> is the two together. They are separate fields because they are two different
/// facts: the declaration is the child's and the teardown record still compares the player's wait
/// against it, while the margin is this launcher's own answer to what that declaration cannot cover.
/// </para>
/// </summary>
internal sealed class ShutdownBudget
{
    private readonly Stopwatch elapsed = Stopwatch.StartNew();
    private readonly long declaredMs;
    private readonly long marginMs;

    internal ShutdownBudget(long declaredMs, long marginMs = 0)
    {
        this.declaredMs = Math.Max(0, declaredMs);
        this.marginMs = Math.Max(0, marginMs);
    }

    /// <summary>The child's own declaration: the sum of its step ceilings, as it published it.</summary>
    internal long DeclaredMs => declaredMs;

    /// <summary>
    /// What this quit may spend past the declaration, for the part of the exit the declaration cannot
    /// bound. The close path supplies it from a number the child publishes itself
    /// (<see cref="RuntimeSupervisorLease.CloseAsync"/>), so this class keeps no constant of its own.
    /// </summary>
    internal long MarginMs => marginMs;

    /// <summary>The whole quit's limit: the child's declaration plus the margin above.</summary>
    internal long LimitMs => declaredMs + marginMs;

    /// <summary>
    /// What is left of the quit's limit, never negative: 0 means the quit has no further wait to give,
    /// and is the value a wait should pass through when it must not add time of its own.
    /// </summary>
    internal long RemainingMs => Math.Max(0, LimitMs - elapsed.ElapsedMilliseconds);

    /// <summary>What this quit has spent so far, which is the wait the player experiences.</summary>
    internal long ConsumedMs => elapsed.ElapsedMilliseconds;

    /// <summary>
    /// A wait's own ceiling, in the form <see cref="WindowsNative.WaitForSingleObject"/> takes, that can
    /// never extend the budget: a Guardian may need its containment ceiling, and it may not spend more
    /// than the quit has left.
    /// </summary>
    internal uint Take(long ceilingMs) => (uint)Math.Clamp(Math.Min(ceilingMs, RemainingMs), 0, int.MaxValue);
}
