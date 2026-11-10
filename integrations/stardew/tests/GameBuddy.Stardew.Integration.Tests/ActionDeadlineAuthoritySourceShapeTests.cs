using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// One number, two sides: the deadline a sender puts on a dispatch must be one the Mod accepts.
///
/// <para>
/// Measured 2026-10-17 on a real multi-day run: the companion dispatched its own <c>advance_day</c> three times
/// and every one came back <c>invalid_deadline</c>. The Host sized the deadline from the action's OWN published
/// watchdog (600 s for the cross-day lifecycle, because a night waits on the other players, the save and the day
/// start), while <c>BridgeSession.IsFreshExecutionRequest</c> still bounded everything but navigation to one minute.
/// Measured again 2026-11-10 from the other side: <c>fish_here</c> publishes 60 s and its live runner wrote 120 s,
/// so the first live slice of that action was refused before it ran.
/// </para>
/// <para>
/// The window therefore lives in ONE declaration (<see cref="GameBuddy.Stardew.Core.Policy.FarmhandActionDeadlineAdmission"/>),
/// the session reads it rather than computing its own, and the senders are held against its export by
/// <c>tools/check-action-deadline-agreement.mjs</c>. What is left to pin here is that nothing bypasses it.
/// </para>
/// </summary>
[Trait("kind", "source-shape")]
public sealed class ActionDeadlineAuthoritySourceShapeTests
{
    private const string RepositoryRelativeRoot = "../../../../../../../";

    private static string ReadSource(string relativePath) =>
        File.ReadAllText(Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, RepositoryRelativeRoot, relativePath)));

    private static string ReadBridgeSession() => ReadSource(Path.Combine("integrations", "stardew", "BridgeSession.cs"));

    [Fact]
    public void TheSessionBoundsADeadlineByTheOneDeclaredWindow()
    {
        string deadlineCheck = DeadlineCheckSource();
        deadlineCheck.Should().Contain(
            "FarmhandActionDeadlineAdmission.WindowMs(request.Action)",
            "the session reads the admitted window instead of computing one of its own");
        deadlineCheck.Should().NotContain("WatchdogMs", "a second lookup here is the second spelling the agreement gate exists to remove");
        deadlineCheck.Should().NotContain("FromMinutes(", "the fallback is the declaration's, not a literal in the session");
        deadlineCheck.Should().NotContain("request.Action ==", "the deadline does not branch on a hard-coded action id");
    }

    /// <summary>The deadline validation method, from its signature to the end of its body.</summary>
    private static string DeadlineCheckSource()
    {
        string source = ReadBridgeSession();
        int start = source.IndexOf("private bool IsFreshExecutionRequest(", StringComparison.Ordinal);
        start.Should().BeGreaterThan(0, "the deadline validation must exist");
        int end = source.IndexOf("\n    }\n", start, StringComparison.Ordinal);
        end.Should().BeGreaterThan(start);
        return source[start..end];
    }

    [Fact]
    public void TheTwoSidesAgreeOnTheLifecycleWatchdog()
    {
        // The Host clamps a published watchdog to its own maximum dispatch deadline, and the Mod publishes the
        // lifecycle watchdog as ten minutes; the two constants have to be compatible or the clamp would silently
        // shorten a night's allowance.
        string definitions = ReadSource(Path.Combine("integrations", "stardew", "src", "Core", "Policy", "FarmhandActionDefinitions.cs"));
        definitions.Should().Contain("public const long LifecycleWatchdogMs = 600_000;");
        definitions.Should().Contain("public const long OrdinaryActionCeilingMs = 60_000;");
        string hostTools = ReadSource(Path.Combine("host", "src", "game-tools.ts"));
        hostTools.Should().Contain("const MAX_DISPATCH_DEADLINE_MS = 600_000;");
        hostTools.Should().Contain("const DEFAULT_DISPATCH_DEADLINE_MS = 30_000;");
        // The Host's fallback for an action that publishes no watchdog stays INSIDE the window the Mod admits for
        // one: it is the dispatch deadline's default, and a default above the ordinary ceiling would be refused.
        hostTools.Should().Contain("Math.min(publishedWatchdogMs, MAX_DISPATCH_DEADLINE_MS)");
    }
}
