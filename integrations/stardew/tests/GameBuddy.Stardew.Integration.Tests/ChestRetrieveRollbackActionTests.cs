using System;
using System.IO;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// chest_retrieve rollback pin. The body removes the exact target from the chest and hands it
/// to the native player inventory through <c>Farmer.addItemToInventory</c>, which returns the
/// unaccepted remainder (null when the whole stack entered, the leftover Item otherwise -
/// Farmer.cs). The pre-fix body graded the attempt on <c>leftover is null</c> and then let a
/// non-null leftover fall out of scope with no chest write and no ground drop, so an item the
/// player inventory could not fully absorb was irreversibly destroyed.
///
/// WHAT THIS FILE PINS: the unaccepted remainder goes back to the SAME chest it came from
/// (<c>Chest.addItem(Item)</c>, Chest.cs:867 - returns null on full accept, the leftover Item
/// otherwise), the receipt states whether that rollback happened, and the success judgement is
/// unchanged (still requires <c>leftover is null</c>), so a rolled-back attempt stays Uncertain
/// and never claims a handoff it did not make.
///
/// A source probe, like the sibling native-seam pins: the put/take transaction cannot be
/// produced headless, because the chest and player inventory live behind a live Game1. The
/// native-local chain gate owns the live claim.
/// </summary>
public sealed class ChestRetrieveRollbackActionTests
{
    private const string HandlerFile = "farmhandexecutioncontroller.containeractions.cs";

    /// <summary>
    /// The defect, precisely: between <c>addItemToInventory</c> and the success judgement there
    /// was no chest write at all. The remainder must be handed back to the same chest before the
    /// receipt is graded, guarded by a non-null stack-positive leftover.
    /// </summary>
    [Fact]
    public void Retrieve_ReturnsTheUnacceptedLeftoverToTheSameChest_RatherThanDroppingIt()
    {
        string source = ReadHandlerSource();
        string executed = StripLineComments(MethodBody(source, "private LocalExecutionReceipt ExecuteChestRetrieve("));

        int leftoverAt = executed.IndexOf("Item? leftover = Game1.player.addItemToInventory(target);", StringComparison.Ordinal);
        int retrievedAt = executed.IndexOf("bool retrieved = ", StringComparison.Ordinal);
        leftoverAt.Should().BeGreaterThanOrEqualTo(0, "the retrieve body hands the target to the native player inventory");
        retrievedAt.Should().BeGreaterThan(leftoverAt, "the success judgement runs after the handoff");

        string betweenHandoffAndJudgement = executed[leftoverAt..retrievedAt];
        betweenHandoffAndJudgement.Should().Contain(
            "if (leftover is not null && leftover.Stack > 0)",
            "only a real unaccepted remainder is rolled back");
        betweenHandoffAndJudgement.Should().Contain(
            "chest.addItem(leftover)",
            "the leftover must go back to the same chest instead of being silently discarded");
    }

    /// <summary>
    /// The receipt must be able to name the rollback, so a reader can tell "the item is back in the
    /// chest" apart from "the item is gone" without inferring it from the Uncertain terminal alone.
    /// </summary>
    [Fact]
    public void Retrieve_Receipt_ReportsWhetherTheLeftoverWasReturned()
    {
        string source = ReadHandlerSource();
        string executed = StripLineComments(MethodBody(source, "private LocalExecutionReceipt ExecuteChestRetrieve("));

        executed.Should().Contain(
            "leftover_returned=",
            "the rollback is a world effect of this execution and belongs in the evidence");
    }

    /// <summary>
    /// The fix must not loosen the handoff: a rolled-back attempt still has a non-null leftover, so
    /// the success gate keeps requiring <c>leftover is null</c> and the terminal stays Uncertain.
    /// </summary>
    [Fact]
    public void Retrieve_SuccessJudgement_StillRequiresTheWholeStackInTheInventory()
    {
        string source = ReadHandlerSource();
        string executed = StripLineComments(MethodBody(source, "private LocalExecutionReceipt ExecuteChestRetrieve("));

        executed.Should().Contain(
            "bool retrieved = leftover is null &&",
            "a partial handoff is never a success");
        executed.Should().Contain("ExecutionState.Uncertain");
        executed.Should().Contain("\"chest_retrieve_postcondition_unavailable\"");
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

    private static string ReadHandlerSource() => ReadRepositoryFile(Path.Combine("integrations", "stardew", HandlerFile));

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
