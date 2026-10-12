using System;
using System.IO;
using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// accept_daily_quest contract pins.
///
/// SEAM DECISION. The accept write is NOT owned by a reusable game method: it lives inline in the
/// ACCEPT branch of the bulletin board's <c>receiveLeftClick</c> (Menus/Billboard.cs:363-374), whose
/// only in-game caller is that same member. That branch is a literal sequence of native state writes
/// with no game-logic fork and no confirmation state, so the action reproduces the WRITE HALF on the
/// public members it writes - <c>Quest.dailyQuest/dayQuestAccepted/accepted/canBeCancelled/daysLeft</c>,
/// <c>Farmer.questLog</c> and <c>Farmer.acceptedDailyQuest</c> - through the game's own public
/// <c>Quest.accept()</c> (Quests/Quest.cs:475) for the accepted flag. It never opens the board, never
/// calls <c>receiveLeftClick</c> and never simulates a click.
///
/// WHAT THIS FILE PINS: the write-half calls, the ABSENCE of every menu/input path, the one-execution-body
/// shape, the absence of an approach leg (the offer is native world state, not a tile), the argument
/// single, and the honest terminal when the world does not change. The live gate - the offer, the
/// quest-log write and the stale negative - belongs to the native-local fixture runner.
/// </summary>
public sealed class AcceptDailyQuestActionTests
{
    private const string HandlerFile = "farmhandexecutioncontroller.questactions.cs";

    private static readonly string[] AcceptDailyQuestReasonCodes =
    {
        "daily_quest_accepted",
        "daily_quest_postcondition_unavailable",
        "daily_quest_unavailable",
        "daily_quest_target_moved",
        "daily_quest_already_accepted",
        "daily_quest_not_acceptable",
    };

    [Fact]
    public void Handler_PerformsTheNativeWriteHalf_AndNeverDrivesTheBoard()
    {
        string source = ReadHandlerSource();
        string code = StripLineComments(source);
        string executed = MethodBody(source, "private LocalExecutionReceipt ExecuteAcceptDailyQuest(");

        foreach (string reasonCode in AcceptDailyQuestReasonCodes)
            code.Should().Contain($"\"{reasonCode}\"", $"the action must be able to report {reasonCode}");

        // The board's own durable write half, on the public members it writes.
        executed.Should().Contain("quest.dailyQuest.Value = true");
        executed.Should().Contain("quest.dayQuestAccepted.Value = Game1.Date.TotalDays");
        // The accepted flag goes through the game's own public settlement rather than a copied write.
        executed.Should().Contain("quest.accept();");
        executed.Should().Contain("quest.canBeCancelled.Value = true");
        executed.Should().Contain("quest.daysLeft.Value = 2");
        executed.Should().Contain("Game1.player.questLog.Add(quest)");
        executed.Should().Contain("Game1.player.acceptedDailyQuest.Set(newValue: true)");

        // NEGATIVE: none of the menu path, the input path or the click flow may appear in CODE (the
        // header names what it does not call, so scanning the raw file would flag prose). The
        // presentation half of the branch is deliberately NOT reproduced either.
        code.Should().NotContain("receiveLeftClick");
        code.Should().NotContain("Billboard");
        code.Should().NotContain("performHoverAction");
        code.Should().NotContain("exitThisMenu");
        code.Should().NotContain("UpdateDailyQuestButton");
        code.Should().NotContain("playSound");
        code.Should().NotContain("checkAction(");
        code.Should().NotContain("doAction");

        // No coordinate, no approach, no tool: the offer is native world state, not a world tile.
        code.Should().NotContain("IsTileWithinChebyshevRadius");
        code.Should().NotContain("TryBeginToolApproach");
        code.Should().NotContain("args.Slot");
        code.Should().NotContain("CurrentToolIndex");
        code.Should().NotContain("beginUsing");
    }

    [Fact]
    public void Handler_HasOneExecutionBody_ReachedFromTheRequestPath()
    {
        string source = ReadHandlerSource();
        string request = MethodBody(source, "public LocalExecutionReceipt RequestLocalAcceptDailyQuest(");

        // One thin request path (admission, target, then the shared body) and ONE execution body, so a
        // retry cannot run a second copy of the contract.
        request.Should().Contain("this.AdmitExecution(");
        request.Should().Contain("AdmissionActionabilityProfile.General");
        request.Should().Contain("return this.ExecuteAcceptDailyQuest(executionId, requestId, expectedTargetId);");
        request.Should().NotContain("questLog");
    }

    [Fact]
    public void Handler_ReadsThePostconditionOffTheWorld_AndIsUncertainWhenNothingChanged()
    {
        string source = ReadHandlerSource();
        string executed = MethodBody(source, "private LocalExecutionReceipt ExecuteAcceptDailyQuest(");

        // The decision is the WORLD after the writes, never "we called the function": the quest is in
        // the log exactly once and both accepted flags are set.
        executed.Should().Contain("CountQuestLogEntries(Game1.player, quest)");
        executed.Should().Contain("logAfter == 1 && quest.accepted.Value && Game1.player.acceptedDailyQuest.Value");
        executed.Should().Contain("ExecutionState.Uncertain");
        executed.Should().Contain("\"daily_quest_postcondition_unavailable\"");
        executed.Should().Contain("quest_log_after");
        executed.Should().Contain("accepted_daily_after");
    }

    [Fact]
    public void Handler_RefusesBeforeTheSeam_ForEveryOfferFact()
    {
        string source = ReadHandlerSource();
        string resolve = MethodBody(source, "private static DailyQuestTargetResolution ResolveDailyQuestTarget(");

        // Each refusal is decided from a LIVE read, the stale-target case is an equality check against
        // the id discovery published rather than a re-target, and the last gate is the game's OWN
        // acceptability predicate - the same one the board's Accept button reads.
        resolve.Should().Contain("daily_quest_unavailable");
        resolve.Should().Contain("daily_quest_target_moved");
        resolve.Should().Contain("daily_quest_already_accepted");
        resolve.Should().Contain("daily_quest_not_acceptable");
        resolve.Should().Contain("string.Equals(liveId, expectedTargetId, StringComparison.Ordinal)");
        resolve.Should().Contain("Game1.CanAcceptDailyQuest()");
        resolve.Should().Contain("Game1.questOfTheDay");
    }

    [Fact]
    public void Action_IsRegisteredAsAnExperimentalExecutionWithTheSingleArgument()
    {
        string definitions = ReadRepositoryFile(Path.Combine("integrations", "stardew", "src", "Core", "Policy", "FarmhandActionDefinitions.cs"));
        definitions.Should().Contain("\"accept_daily_quest\"");
        definitions.Should().Contain("\"daily_quest_accepted\"", "the descriptor's terminal must be the code the handler mints");
        definitions.Should().Contain("Quest.accept", "the descriptor's seam field must name the public settlement");

        int at = definitions.IndexOf("\"accept_daily_quest\"", StringComparison.Ordinal);
        string entry = definitions[at..Math.Min(definitions.Length, at + 700)];
        entry.Should().Contain("\"expectedTargetId\"");
        entry.Should().Contain("FarmhandActionLifecycle.Experimental", "an action with no live gate must not claim otherwise");

        string protocol = ReadRepositoryFile(Path.Combine("integrations", "stardew", "src", "Core", "Protocol", "BridgeProtocol.cs"));
        protocol.Should().Contain("\"accept_daily_quest\" => new[] { \"expectedTargetId\" }",
            "the wire argument-name list is what the parser reads before any handler sees the request");

        string router = ReadRepositoryFile(Path.Combine("integrations", "stardew", "Handlers", "WorldLifecycleActionHandler.cs"));
        router.Should().Contain("\"accept_daily_quest\" => this.executions.RequestLocalAcceptDailyQuest(");
    }

    [Fact]
    public void Registration_LifecycleMatchesTheCatalogAndTheHandlerGroup()
    {
        var registration = FarmhandActionCatalog.Registrations
            .FirstOrDefault(candidate => candidate.ActionId == "accept_daily_quest");

        registration.Should().NotBeNull();
        registration!.Lifecycle.Should().Be(FarmhandActionLifecycle.Experimental);
        registration.HandlerGroup.Should().Be(FarmhandActionHandlerGroup.WorldLifecycle);
        registration.Descriptor!.Arguments.Should().ContainSingle()
            .Which.Name.Should().Be("expectedTargetId");
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

    /// <summary>Drop <c>//</c>/<c>///</c> comments so negative pins test code, not prose.</summary>
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

    private static string ReadHandlerSource() =>
        ReadRepositoryFile(Path.Combine("integrations", "stardew", HandlerFile));

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
