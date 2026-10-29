using System;
using System.Reflection;
using FluentAssertions;
using StardewValley.Menus;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Who settles the morning-after summary when no night lifecycle exists at all.
///
/// `541775c2` made the lifecycle the owner of `ShippingMenu`, and `4357a95b` made its terminal discharge the obligation
/// before letting go. Both are right, and both assume a lifecycle EXISTS. It exists only because `advance_day` started
/// one, so a night the engine took by its own 2:00 AM pass-out has no owner at all.
///
/// Measured 2026-10-28 (`round6`): the companion said goodnight at 22:00 without dispatching `advance_day`, the engine
/// passed it out at 02:00, day 6 began, and the summary was standing with nothing running that could commit it.
/// `shouldTimePass` returns false while any `activeClickableMenu` is non-null (Game1.cs:9300-9303), so the clock froze
/// at 06:00 for 31 real minutes of a 2,747 s run and every later action was refused for a reason the companion could
/// not see or fix.
///
/// These cases pin the GUARD, not the dispatch: the helper is called from `OnDayStarted` when no lifecycle is live,
/// and what a test can verify without a running game is that it refuses every menu whose close would take a decision.
/// </summary>
public sealed class SettlementWithoutLifecycleTests
{
    // Internal to the Mod assembly, which a referenced assembly cannot reach by name.
    private static readonly Type Lifecycle = typeof(GameBuddy.Stardew.ModEntry).Assembly
        .GetType("GameBuddy.Stardew.SleepAndAdvanceDayLifecycle", throwOnError: true)!;

    [Fact]
    public void NoMenuStandingIsReportedAsNotPresentRatherThanAsACommit()
    {
        // A receipt saying "committed" about a menu that was never there would be the same class of lie as the
        // projection that said `Actionable: true` under a modal.
        object outcome = Settle(null);

        outcome.ToString().Should().Be("NotPresent");
    }

    [Fact]
    public void AMenuThatWouldTakeADecisionIsNeverClosedOnTheCompanionsBehalf()
    {
        // The whole reason this helper is allowed to exist is that `okClicked` on a ShippingMenu only starts the
        // outro and settles nothing (ShippingMenu.cs:690-696) - the settlement happened before the menu existed.
        // A `DialogueBox` carries a question and a `LevelUpMenu` grants a perk; closing either would take a decision
        // that is the companion's. Anything that is not the summary must come back untouched.
        //
        // A stub rather than a real `DialogueBox`: its constructor dereferences `Game1.options` (DialogueBox.cs:62),
        // which a headless test has no reason to stand up - and the question here is only whether this helper refuses
        // a type it does not own, which the stub answers without a running game.
        object outcome = Settle(new MenuStub());

        outcome.ToString().Should().Be("NotPresent");
    }

    [Fact]
    public void TheDayStartSettlesAStandingSummaryOnlyWhenNoLifecycleOwnsIt()
    {
        // The dispatcher must be behind a "nobody owns this" guard. Without it, a normal night - lifecycle live, its
        // own `Phase.AwaitingModal` about to commit the same menu - would get a SECOND `okClicked`, and a second
        // dispatch while the first outro runs freezes the settlement rather than finishing it.
        string body = MethodBody(ReadModEntrySource(), "private void OnDayStarted(");

        body.Should().Contain("SettleStandingSettlementMenuWithoutLifecycle", "the day start is where an unowned summary is met");
        body.Should().Contain("IsFinished", "and it must not act while a lifecycle still owns the rollover menus");
    }

    private static object Settle(IClickableMenu? standing) =>
        Lifecycle.GetMethod("SettleStandingSettlementMenuWithoutLifecycle", BindingFlags.Static | BindingFlags.NonPublic)!
            .Invoke(null, new object?[] { standing })!;

    private sealed class MenuStub : IClickableMenu
    {
        public MenuStub()
            : base(0, 0, 100, 100)
        {
        }
    }

    private static string ReadModEntrySource() => ReadRepoFile("integrations/stardew/ModEntry.cs");

    private static string MethodBody(string source, string signature)
    {
        int start = source.IndexOf(signature, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, $"{signature} must exist");
        int brace = source.IndexOf('{', start);
        int depth = 0;
        for (int index = brace; index < source.Length; index += 1)
        {
            if (source[index] == '{') depth += 1;
            else if (source[index] == '}')
            {
                depth -= 1;
                if (depth == 0) return source.Substring(brace, index - brace + 1);
            }
        }
        throw new InvalidOperationException($"unbalanced_body:{signature}");
    }

    private static string ReadRepoFile(string relative)
    {
        string directory = AppContext.BaseDirectory;
        for (int depth = 0; depth < 10 && directory is not null; depth += 1)
        {
            string candidate = System.IO.Path.Combine(directory, relative);
            if (System.IO.File.Exists(candidate)) return System.IO.File.ReadAllText(candidate);
            directory = System.IO.Path.GetDirectoryName(directory) ?? string.Empty;
            if (directory.Length == 0) break;
        }
        throw new InvalidOperationException($"source_not_found:{relative}");
    }
}
