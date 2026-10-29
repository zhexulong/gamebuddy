using System;
using System.IO;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// DEFECT-01: `answer_dialogue` must dispatch a question to the native API the target version's
/// DialogueBox itself routes it to. The native box (DialogueBox.cs:381-404) answers a question by
/// THREE paths, and only one of them is the location:
///   * characterDialogue == null &amp;&amp; !(eventUp &amp;&amp; afterQuestion == null)
///       -> Game1.currentLocation.answerDialogue(responses[selectedResponse])  (:392)
///   * characterDialogue != null
///       -> characterDialogue.chooseResponse(responses[selectedResponse])      (:401)
///   * eventUp &amp;&amp; afterQuestion == null
///       -> Game1.currentLocation.currentEvent.answerDialogue(lastQuestionKey, selectedResponse) (:387)
///
/// The handler used to send EVERY question to `Game1.currentLocation.answerDialogue`. An NPC
/// face-to-face question - the common case - is owned by the speaker's own Dialogue, so the location
/// path refuses it and the request was reported as `answer_dialogue_not_accepted`.
///
/// These are source probes, like the sibling modal pins: the NPC and event branches need a live
/// player and speaker a headless probe process cannot build, so the live settlement belongs to the
/// native-local modal chain gate.
/// </summary>
[Trait("kind", "source-shape")]
public sealed class AnswerDialogueNpcQuestionDispatchSourceShapeTests
{
    private const string HandlerFile = "farmhandexecutioncontroller.modalactions.cs";

    /// <summary>The exact unconditional call the defect leaves in the body; the fix must delete it.</summary>
    private const string UnconditionalLocationAnswer =
        "answered = Game1.currentLocation.answerDialogue(new Response(responseKey, responseKey));";

    [Fact]
    public void Answer_RoutesAnNpcQuestionToTheCharactersOwnDialogue_NotTheLocation()
    {
        string body = AnswerBody();

        body.Should().Contain(
            "dialogue.characterDialogue.chooseResponse(answer);",
            "an NPC face-to-face question is natively answered on the speaker's dialogue (DialogueBox.cs:401), not on the location");
        body.Should().Contain(
            "Game1.eventUp && Game1.currentLocation.afterQuestion is null",
            "the cutscene question is a third native path (DialogueBox.cs:387) and must be told apart from the location one");
        body.Should().NotContain(
            UnconditionalLocationAnswer,
            "the defect: every question was sent to the location, which refuses the NPC question with answer_dialogue_not_accepted");
    }

    [Fact]
    public void Answer_StillAnswersAPlainLocationQuestion_OnTheLocation()
    {
        string body = AnswerBody();

        body.Should().Contain(
            "answered = Game1.currentLocation.answerDialogue(answer);",
            "a plain location question still settles through the location, as the native box does (DialogueBox.cs:392)");
    }

    [Fact]
    public void Answer_KeepsEveryRefusalTerminal()
    {
        string body = AnswerBody();

        body.Should().Contain("\"response_key_not_offered\"");
        body.Should().Contain("\"answer_dialogue_not_accepted\"");
        body.Should().Contain("\"answer_dialogue_native_exception\"");
        // There is deliberately NO `postcondition_failed` terminal here any more: the box's own
        // outro has no independent synchronous read (`beginOutro()` sets only `transitioning` and
        // `transitioningBigger`), so the old check could never fire. See the body's comment.
        body.Should().NotContain("\"postcondition_failed\"");
    }

    private static string AnswerBody() =>
        MethodBody(
            StripLineComments(ReadHandlerSource()),
            "public LocalExecutionReceipt RequestLocalAnswerDialogue(");

    private static string ReadHandlerSource() =>
        ReadRepositoryFile(Path.Combine("integrations", "stardew", HandlerFile));

    /// <summary>Drop <c>//</c>/<c>///</c> comments so the pins test code, not prose.</summary>
    private static string StripLineComments(string source)
    {
        var builder = new System.Text.StringBuilder(source.Length);
        foreach (string line in source.Split('\n'))
        {
            int comment = line.IndexOf("//", StringComparison.Ordinal);
            builder.AppendLine(comment >= 0 ? line[..comment] : line);
        }
        return builder.ToString();
    }

    /// <summary>Extract one member body by brace balance from its declaration.</summary>
    private static string MethodBody(string source, string declaration)
    {
        int start = source.IndexOf(declaration, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, $"{declaration} must exist");

        int depth = 0;
        bool started = false;
        for (int index = start; index < source.Length; index++)
        {
            char character = source[index];
            if (character == '{')
            {
                depth++;
                started = true;
            }
            else if (character == '}')
            {
                depth--;
                if (started && depth == 0)
                    return source[start..(index + 1)];
            }
        }

        throw new InvalidOperationException($"unbalanced body for {declaration}");
    }

    /// <summary>Tests run from the project or its bin output; walk up to the repository root.</summary>
    private static string ReadRepositoryFile(string relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++, directory = directory.Parent)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (File.Exists(candidate))
                    return File.ReadAllText(candidate);
            }
        }

        throw new FileNotFoundException($"repository path not found: {relative}");
    }
}
