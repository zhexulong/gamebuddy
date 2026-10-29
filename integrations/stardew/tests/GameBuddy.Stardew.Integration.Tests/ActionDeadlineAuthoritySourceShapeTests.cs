using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// One number, two sides: the deadline the Host puts on a dispatch must be one the Mod accepts.
///
/// Measured 2026-10-17 on a real multi-day run: the companion dispatched its own <c>advance_day</c> three times
/// and every one came back <c>invalid_deadline</c>. The Host sized the deadline from the action's OWN published
/// watchdog (600 s for the cross-day lifecycle, because a night waits on the other players, the save and the day
/// start), while <c>BridgeSession.IsFreshExecutionRequest</c> still bounded everything but navigation to one
/// minute - so the action designed to be waited on for ten minutes could never be accepted at all.
///
/// This pins the single authority: the session accepts a deadline up to the requested action's published
/// watchdog, and falls back to the ordinary bound only when an action publishes none.
/// </summary>
[Trait("kind", "source-shape")]
public sealed class ActionDeadlineAuthoritySourceShapeTests
{
    private const string RepositoryRelativeRoot = "../../../../../../../";

    private static string ReadSource(string relativePath) =>
        File.ReadAllText(Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, RepositoryRelativeRoot, relativePath)));

    private static string ReadBridgeSession() => ReadSource(Path.Combine("integrations", "stardew", "BridgeSession.cs"));

    [Fact]
    public void TheSessionBoundsADeadlineByTheActionsOwnPublishedWatchdog()
    {
        string source = ReadBridgeSession();
        // The bound comes from the registration the request names, which is the same catalog the Host reads.
        source.Should().Contain("FarmhandActionCatalog.Registrations");
        source.Should().Contain("?.Descriptor?.WatchdogMs");
    }

    [Fact]
    public void TheHardCodedPerActionSplitIsGone()
    {
        // The split is what made the lifecycle action unreachable: ten minutes for one action, one minute for
        // everything else, regardless of what each action published. Its removal is the fix, so its return would
        // be the regression - and the check is scoped to the deadline validation, because the action id legitimately
        // appears elsewhere (dispatch identity, durable admission, receipts).
        string deadlineCheck = DeadlineCheckSource();
        deadlineCheck.Should().NotContain("request.Action ==", "the deadline no longer branches on a hard-coded action id");
        deadlineCheck.Should().NotContain("FromMinutes(10)", "the ten-minute ceiling now comes from the navigation action's own published watchdog");
        deadlineCheck.Should().Contain("Descriptor?.WatchdogMs");
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
    public void AnActionWithNoPublishedWatchdogIsStillBounded()
    {
        // Fail closed, not open: an action the catalog does not carry must not get an unbounded wait.
        string source = ReadBridgeSession();
        source.Should().Contain("publishedWatchdogMs is > 0 ? publishedWatchdogMs.Value : (long)TimeSpan.FromMinutes(1).TotalMilliseconds");
        source.Should().Contain("publishedWatchdogMs is > 0");
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
        // The Mod's ordinary ceiling and the Host's default fallback are the same order of magnitude: a
        // disagreement there would show up as a rejection the moment an unpublished action is dispatched.
        hostTools.Should().Contain("Math.min(publishedWatchdogMs, MAX_DISPATCH_DEADLINE_MS)");
    }
}
