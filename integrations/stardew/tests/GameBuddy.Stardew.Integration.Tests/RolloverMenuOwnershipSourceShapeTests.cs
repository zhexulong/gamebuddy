using System;
using System.Linq;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// Who closes the morning-after shipping summary.
///
/// The night lifecycle waits for a `DialogueBox` at `Phase.AwaitingModal` - the yes/no sleep prompt the engine raises
/// in every topology. But the rollover pushes `ShippingMenu` BEFORE that prompt, so a night that begins with
/// yesterday's takings on screen waited forever: the phase saw "not a DialogueBox", returned, and the day-start budget
/// expired into `blocked/day_start_not_observed`, which reads like a hang.
///
/// The multi-day harness worked around it by dismissing the menu from outside, while the companion was blocked inside
/// `advance_day`. That is the harness proving a capability the product did not have: in a real session nobody would be
/// there to click it.
///
/// The distinction these cases pin is the one that decides where the fix belongs:
///
///   ShippingMenu  presents numbers; `okClicked` starts the outro and settles nothing. Closing it takes no decision,
///                 so the lifecycle may do it exactly as the published `dismiss_modal` action does.
///   LevelUpMenu   GRANTS a perk when it closes, and on a milestone it grants whichever branch was picked. Closing it
///                 takes a permanent decision, so the lifecycle must NOT take it.
/// </summary>
public sealed class RolloverMenuOwnershipSourceShapeTests
{
    [Fact]
    public void TheLifecycleCommitsTheShippingSummaryItself()
    {
        // Both behaviours have to exist in the same file: the lifecycle closes the summary, and does NOT close the
        // level-up menu. Asserting them together is what stops a future edit from "fixing" one into the other.
        string source = ReadLifecycleSource();
        source.Should().Contain("is ShippingMenu uncommittedShipping", "the lifecycle must recognise the summary it raises");
        source.Should().Contain("CommitShippingSummary", "and close it through the engine's commit path");
    }

    [Fact]
    public void TheCommitGoesThroughOkClickedNotAGenericClose()
    {
        // A generic close on ShippingMenu is a pure cancel, and the save lives on the outro that `okClicked` starts -
        // measured: every archived multi-day log had `saveGameMenu=[]` and the night burned its save budget.
        string source = ReadLifecycleSource();
        source.Should().Contain("\"okClicked\"");
        source.Should().NotContain("shippingMenu.exitThisMenu", "a generic close would skip the save entirely");
    }

    [Fact]
    public void TheLevelUpMenuIsNeverClosedByTheLifecycle()
    {
        string source = ReadLifecycleSource();
        source.Should().NotContain("is LevelUpMenu", "closing a level-up menu grants a perk; that decision is the companion's");
        source.Should().NotContain("respond_level_up", "the lifecycle must not answer a level-up on the companion's behalf");
    }

    [Fact]
    public void TheHarnessNoLongerDismissesTheSummaryItself()
    {
        // The workaround is what made this defect invisible: a run reporting "the companion crossed the night" while the
        // harness clicked the menu proves the harness, not the product. The constant stays - it is how the loop
        // RECOGNISES the summary - but nothing may call a dismissal on its behalf.
        string loop = ReadRepoFile("tools/lib/multiday-loop.mjs");
        loop.Should().NotContain("kind: \"dismiss\"", "the loop must not own a dismissal path");
        loop.Should().NotContain("settleHeldMenu", "nor keep the machinery that performed it");
        loop.Should().Contain("DISMISSIBLE_ROLLOVER_MENUS.includes(menuType)) return Object.freeze({ kind: \"wait\"", "it still has to recognise the summary in order to wait on it");
    }

    private static string ReadLifecycleSource() =>
        ReadRepoFile("integrations/stardew/SleepAndAdvanceDayLifecycle.cs");

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
