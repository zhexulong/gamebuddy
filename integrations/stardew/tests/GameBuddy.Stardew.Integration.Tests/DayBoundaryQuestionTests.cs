using System;
using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using StardewValley;
using StardewValley.Menus;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A QUESTION STILL ON SCREEN WHEN A NEW DAY BEGINS BELONGS TO THE DAY THAT ENDED.
///
/// Measured 2026-11-06 (`round38`, `.live-runs/game-ladder/2026-11-06T18-41-39-799Z-multiday_routine`): the native
/// sleep prompt (`Strings\Locations:FarmHouse_Bed_GoToSleep`, raised at `GameLocation.cs:3765`) outlived the night it
/// asked about and was still standing at 06:00. It was re-published to the Agent as a fresh `npc_dialogue_presented`
/// question, and each `Yes` ended the day that had just begun - three `day_started` facts in 8.7 s with the farm
/// untouched. The same box also refused the next `advance_day` (`actor_held_by_modal;modal_type=DialogueBox`).
///
/// The decision is a table because the boundary must never confuse the two states it can tell apart: a question
/// something asked AFTER this day began (not ours to touch) and one the previous day left standing (nobody can still
/// mean it).
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the native close (`DialogueBox.closeDialogue`, DialogueBox.cs:192) dereferences
// `Game1.player` and the game's dialogue queues, which a headless runner does not have, so the effect is pinned on the
// source text while the decision itself is called for real.
public sealed class DayBoundaryQuestionTests
{
    private static readonly Type Lifecycle = typeof(GameBuddy.Stardew.ModEntry).Assembly
        .GetType("GameBuddy.Stardew.SleepAndAdvanceDayLifecycle", throwOnError: true)!;

    [Theory]
    [InlineData(true, 6, 7, true)]
    [InlineData(true, 6, 6, false)]
    [InlineData(true, 7, 6, false)]
    [InlineData(false, 6, 7, false)]
    public void AQuestionIsLeftFromAnEndedDayOnlyWhenItWasRaisedOnOne(
        bool isQuestion,
        int raisedOnDay,
        int currentDay,
        bool expected)
    {
        DialogueBox box = CreateBox(isQuestion);

        Call("IsQuestionLeftFromAnEndedDay", box, raisedOnDay, currentDay).Should().Be(expected);
    }

    [Fact]
    public void ABoxThatIsNotAQuestionIsNeverTheBoundarysBusiness()
    {
        DialogueBox info = CreateBox(isQuestion: false);

        // Answering, dismissing or closing an informational box is the pager's and the actions' business, not the
        // day boundary's. If this case reached `closeDialogue()` it would throw here: the runner has no
        // `Game1.activeClickableMenu` for the box's own `Equals` guard to compare against.
        Call("DismissQuestionLeftFromAnEndedDay", info, 6, 7)!.ToString().Should().Be("NotAQuestion");
    }

    [Fact]
    public void AQuestionAskedAfterTheDayBeganIsLeftAlone()
    {
        DialogueBox question = CreateBox(isQuestion: true);

        // The strict comparison is the guard: `raisedOnDay >= currentDay` returns BEFORE the close, which is the only
        // reason this call can run headless at all (a reached `closeDialogue()` dereferences `Game1.player`).
        Call("DismissQuestionLeftFromAnEndedDay", question, 7, 7)!.ToString().Should().Be("AskedByThisDay");
    }

    [Fact]
    public void TheBoundaryClosesTheBoxAndNeverAnswersIt()
    {
        // The close is `DialogueBox.closeDialogue()` - the box's own pure cancel: exit the menu, clear
        // `questionChoices`, restore `CanMove`, run no answer handler. Answering is what starts a night: the game's
        // `Sleep_Yes` handler is the only thing that crosses a day, and nobody chose it at 06:00.
        string code = StripComments(ReadSource("integrations/stardew/SleepAndAdvanceDayLifecycle.cs"));
        string dismiss = MethodBody(code, "internal static StandingQuestionOutcome DismissQuestionLeftFromAnEndedDay(");

        dismiss.Should().Contain("standing.closeDialogue()");
        dismiss.Should().NotContain("answerDialogue", "a boundary that answers the question is the defect, not the fix");
        dismiss.Should().NotContain("Sleep_Yes");
        dismiss.Should().NotContain("newDay", "nothing at the boundary may start a night");
    }

    [Fact]
    public void TheDayStartedHandlerRunsTheBoundaryWithTheDayTheBoxAppeared()
    {
        // Reachability is part of the fix: a decision nothing calls is indistinguishable from a passing one. The
        // arrival day comes from the pager, which is the only thing that watched the box appear - a live read of the
        // current day would answer "today" for every standing question and never dismiss anything.
        string entry = ReadSource("integrations/stardew/ModEntry.cs");
        string onDayStarted = MethodBody(entry, "private void OnDayStarted(");
        onDayStarted.Should().Contain("DismissQuestionTheEndedDayLeftStanding();");

        string dismiss = MethodBody(entry, "private void DismissQuestionTheEndedDayLeftStanding()");
        dismiss.Should().Contain("pager.StandingBox,");
        dismiss.Should().Contain("pager.StandingBoxDay,");
        dismiss.Should().Contain("pager.CurrentDay");
    }

    // ---- fixtures --------------------------------------------------------------

    private static DialogueBox CreateBox(bool isQuestion)
    {
        DialogueBox box = (DialogueBox)FormatterServices.GetUninitializedObject(typeof(DialogueBox));
        box.dialogues = new System.Collections.Generic.List<string> { "Do you want to go to sleep?" };
        box.responses = isQuestion ? new[] { new Response("Yes", "Yes"), new Response("No", "No") } : Array.Empty<Response>();
        box.characterDialoguesBrokenUp = new System.Collections.Generic.Stack<string>();
        box.transitioning = false;
        box.transitioningBigger = true;
        box.safetyTimer = 0;
        box.characterIndexInDialogue = 1000;
        box.isQuestion = isQuestion;
        return box;
    }

    private static object? Call(string method, DialogueBox box, int raisedOnDay, int currentDay)
    {
        MethodInfo? target = Lifecycle.GetMethod(
            method,
            BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public);
        target.Should().NotBeNull();
        return target!.Invoke(null, new object[] { box, raisedOnDay, currentDay });
    }

    private static string ReadSource(string relative)
    {
        var directory = new System.IO.DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !System.IO.Directory.Exists(System.IO.Path.Combine(directory.FullName, "integrations")))
            directory = directory.Parent;
        directory.Should().NotBeNull("the test must run inside the repository");
        return System.IO.File.ReadAllText(System.IO.Path.Combine(directory!.FullName, relative));
    }

    private static string StripComments(string source)
    {
        var withoutBlocks = System.Text.RegularExpressions.Regex.Replace(
            source, @"/\*.*?\*/", string.Empty, System.Text.RegularExpressions.RegexOptions.Singleline);
        return System.Text.RegularExpressions.Regex.Replace(withoutBlocks, @"//.*?$", string.Empty,
            System.Text.RegularExpressions.RegexOptions.Multiline);
    }

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

        throw new InvalidOperationException($"{signature} has unbalanced braces");
    }
}
