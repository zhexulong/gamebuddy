using System;
using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using StardewValley;
using StardewValley.Menus;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// THE ENGINE'S BED PROMPT HAS ONE IDENTITY AND ONE OWNER.
///
/// Measured 2026-11-09 (`round41`, `.live-runs/game-ladder/2026-11-09T18-26-53-581Z-multiday_routine`): the dialogue
/// pager offered the prompt to the Agent, the Agent answered `Yes` at 21:00, the day crossed with no execution behind it,
/// and the still-pending `sleep` intent crossed a SECOND day 9 s later. Six `day_started` facts for three nights, the
/// run's own tally reading 2 crossings against the world's 6.
///
/// `day_started` itself was never duplicated: it has ONE publisher (`Sensory/StardewSalientEventHooks.cs:167`) already
/// keyed on `(saveId, TotalDays)` (`Sensory/ISalientEventFilter.cs:74`), and the six facts carried six distinct days.
/// The defect was two owners of "the day ended", which is what these pins make impossible to reintroduce silently.
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the identity is called for real, while the seams that read the live game (the lifecycle's
// eligibility gate and its walk, which dereference `Game1.player.currentLocation`) are pinned on the product source - the
// same split `DayBoundaryQuestionTests` uses for the day boundary.
public sealed class NativeSleepPromptTests
{
    [Theory]
    [InlineData(NativeSleepPrompt.QuestionKey, true)]
    [InlineData("sleep", false)]
    [InlineData("fork1", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void OnlyTheEnginesOwnQuestionKeyNamesTheBedPrompt(string? questionKey, bool expected)
    {
        // `GameLocation.cs:3765` raises it as `createQuestionDialogue(..., createYesNoResponses(), "Sleep", null)`, and
        // `answerDialogue` dispatches `Sleep_Yes` from exactly that field. The comparison is ORDINAL on purpose: unlike a
        // response key - a word on the player's screen, which `answer_dialogue` accepts case-insensitively - this is an
        // identifier the engine dispatches on.
        NativeSleepPrompt.IsQuestionKeySleep(questionKey).Should().Be(expected);
    }

    [Fact]
    public void AnInformationalBoxIsNeverTheBedPrompt()
    {
        // The location key outlives the box it was raised with, so the box's own state is half of the identity: an
        // informational dialogue is not a question anything answers.
        var box = (DialogueBox)FormatterServices.GetUninitializedObject(typeof(DialogueBox));
        box.isQuestion = false;
        Func<string?>? keyBefore = NativeSleepPrompt.QuestionKeyProvider;

        try
        {
            NativeSleepPrompt.QuestionKeyProvider = () => NativeSleepPrompt.QuestionKey;
            NativeSleepPrompt.IsStanding(box).Should().BeFalse();
            box.isQuestion = true;
            NativeSleepPrompt.IsStanding(box).Should().BeTrue();
        }
        finally
        {
            NativeSleepPrompt.QuestionKeyProvider = keyBefore;
        }
    }

    /// <summary>
    /// EVERY SEAM THAT COULD HAND THE BED PROMPT TO THE AGENT, AND THE ONE IDENTITY EACH ONE ASKS.
    ///
    /// This is the gate for the defect family rather than for the round41 instance: a fifth seam that could answer, close,
    /// present or be refused by that box has to be added here, and the failure names the seam that stopped asking. The
    /// list is hand-written because the seams live in four different components and no product declaration enumerates
    /// them - so adding one without adding it here is the one thing this pin cannot catch on its own.
    /// </summary>
    [Theory]
    [InlineData("integrations/stardew/Sensory/NpcDialoguePager.cs", "private void ObserveCore(")]
    [InlineData("integrations/stardew/SleepAndAdvanceDayLifecycle.cs", "private bool TryEnterEligibility(")]
    // The shared admission moved to its own type; the seam is its body, not the projector the action bodies call.
    [InlineData("integrations/stardew/ExecutionAdmission.cs", "internal AdmissionOutcome Admit(")]
    [InlineData("integrations/stardew/farmhandexecutioncontroller.modalactions.cs", "public LocalExecutionReceipt RequestLocalAnswerDialogue(")]
    public void EverySeamThatCouldTakeTheBedPromptAsksTheOneIdentity(string file, string signature)
    {
        string body = MethodBody(StripComments(ReadSource(file)), signature);

        body.Should().Contain(
            "NativeSleepPrompt.IsStanding(",
            $"{file} may meet the engine's bed prompt, and only the one identity may decide what it is");
    }

    [Fact]
    public void TheLifecycleAdmitsItsOwnStandingPromptAndSkipsTheWalkItAlreadyFinished()
    {
        // Without this the fix has no second half: refusing the Agent's `Yes` while the lifecycle still answers
        // `menu_open` for its own prompt leaves the night unstartable and the actor held by a box nobody may answer.
        string code = StripComments(ReadSource("integrations/stardew/SleepAndAdvanceDayLifecycle.cs"));

        string eligibility = MethodBody(code, "private bool TryEnterEligibility(out string reason)");
        eligibility.Should().Contain("bool ownSleepPrompt = NativeSleepPrompt.IsStanding(Game1.activeClickableMenu as DialogueBox);");
        eligibility.Should().Contain("if (Game1.activeClickableMenu is not null && !ownSleepPrompt) { reason = \"menu_open\"; return false; }");
        eligibility.Should().Contain("if (Game1.dialogueUp && !ownSleepPrompt) { reason = \"dialogue_up\"; return false; }");

        MethodBody(code, "private bool Step()")
            .Should().Contain("NativeSleepPrompt.IsStanding(Game1.activeClickableMenu as DialogueBox) || this.WalkToBed()");
    }

    [Fact]
    public void TheAnswerIsTheEnginesOwnAcceptKeyOnce()
    {
        // The key the engine offers is the property of the prompt's identity, not of the lifecycle: a second literal
        // "Yes" here would let the two answer different questions after the engine's vocabulary moves.
        string answer = MethodBody(
            StripComments(ReadSource("integrations/stardew/SleepAndAdvanceDayLifecycle.cs")),
            "private bool AnswerSleepPrompt()");

        answer.Should().Contain("NativeSleepPrompt.AcceptResponseKey");
        answer.Should().NotContain("\"Yes\"");
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
        string withoutBlocks = System.Text.RegularExpressions.Regex.Replace(
            source,
            @"/\*.*?\*/",
            string.Empty,
            System.Text.RegularExpressions.RegexOptions.Singleline);
        return System.Text.RegularExpressions.Regex.Replace(withoutBlocks, @"//.*?$", string.Empty, System.Text.RegularExpressions.RegexOptions.Multiline);
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
