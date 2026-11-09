using System;
using StardewValley;
using StardewValley.Menus;

namespace GameBuddy.Stardew;

/// <summary>
/// THE ONE IDENTITY OF THE ENGINE'S OWN BED PROMPT, AND THE ONE OWNER OF THE DAY IT ENDS.
///
/// <para>
/// `GameLocation.cs:3763-3765` raises it as the `Sleep` touch action:
/// `createQuestionDialogue(LoadString("Strings\Locations:FarmHouse_Bed_GoToSleep"), createYesNoResponses(), "Sleep", null)`.
/// The dialog key is the engine's own identity for that question - `answerDialogue` dispatches `Sleep_Yes` from exactly
/// this field (`GameLocation.cs:12692`) - so it is the only thing this class compares. The page text is localized, and
/// the keys the box offers are `Yes`/`No` on every question in the game, so neither is an identity and a list of them
/// would be a second spelling of the same fact.
/// </para>
///
/// <para>
/// WHY THERE IS ONE OWNER AT ALL. Answering `Yes` runs `Sleep_Yes` -> `startSleep` -> `NewDay`: the answer IS a calendar
/// crossing. `advance_day` (`SleepAndAdvanceDayLifecycle`) is the action that crosses a night WITH a receipt, so every
/// other route to that box is a second owner of the same day ending. Measured 2026-11-09 (`round41`): the dialogue pager
/// offered the prompt to the Agent, the Agent answered `Yes` at 21:00, the day crossed with no execution behind it, and
/// the still-pending `sleep` intent crossed a SECOND day 9 s later - six `day_started` facts for three nights, the run's
/// own tally reading 2 crossings against the world's 6.
/// </para>
/// </summary>
internal static class NativeSleepPrompt
{
    /// <summary>The dialog key `GameLocation.cs:3765` raises the bed prompt with, and the prefix of the engine's own answer dispatch (`Sleep_Yes`).</summary>
    internal const string QuestionKey = "Sleep";

    /// <summary>The affirmative key <c>createYesNoResponses()</c> offers (`GameLocation.cs:4422`).</summary>
    internal const string AcceptResponseKey = "Yes";

    /// <summary>
    /// Test seam for the live question-key read, the pattern <see cref="WorldModel"/> already uses for
    /// <c>ModalActionOwnedCheck</c>: production leaves it null and the game is read.
    /// </summary>
    internal static Func<string?>? QuestionKeyProvider { get; set; }

    /// <summary>Whether this native dialog key is the bed prompt's.</summary>
    internal static bool IsQuestionKeySleep(string? questionKey) =>
        string.Equals(questionKey, QuestionKey, StringComparison.Ordinal);

    /// <summary>
    /// Whether the question standing on screen IS the engine's bed prompt.
    ///
    /// The question is the box's own (`isQuestion`), because the same location key can outlive an informational box,
    /// and an informational box is not a question anything answers.
    /// </summary>
    internal static bool IsStanding(DialogueBox? box) =>
        box is { isQuestion: true } && IsQuestionKeySleep(CurrentQuestionKey());

    private static string? CurrentQuestionKey()
    {
        if (QuestionKeyProvider is not null)
            return QuestionKeyProvider();
        try
        {
            return Game1.currentLocation?.lastQuestionKey;
        }
        catch (Exception)
        {
            // A plain field read on the live location, which is absent before a save is loaded. "Not the prompt" is the
            // honest answer there, and it must not take the game loop down.
            return null;
        }
    }
}
