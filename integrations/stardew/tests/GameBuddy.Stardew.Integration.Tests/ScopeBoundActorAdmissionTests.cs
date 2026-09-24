using System.Reflection;
using System.Runtime.Serialization;
using FluentAssertions;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Handlers;
using Netcode;
using StardewValley;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Pins the admission contract that replaced the single-player fixture guard.
///
/// The retired guard (<c>Context.IsMultiplayer || !Game1.IsMasterGame || ...</c>)
/// structurally refused the AI Farmhand client: <c>Game1.IsMasterGame</c> is false
/// on a farmhand client, so every one of these actions returned
/// <c>native_local_player_required</c> in the topology the companion is meant to run in.
///
/// Admission is now proven from the scope-bound actor: a resolver-supplied actor whose
/// <c>UniqueMultiplayerID</c> matches <c>executionScope.PlayerId</c> is admitted; a
/// mismatched identity fails closed with <c>execution_scope_mismatch</c>; an absent
/// actor fails closed with <c>world_not_ready</c>.
///
/// The first case is the discriminating one. It proves the request passed the scope
/// check and went on to game-state validation (<c>player_not_actionable</c>), which the
/// retired guard could never reach in a shared world.
/// </summary>
public sealed class ScopeBoundActorAdmissionTests
{
    private const string ScopePlayerId = "1001";

    [Theory]
    [InlineData("chop_tree_source")]
    [InlineData("chest_store")]
    [InlineData("craft_item")]
    public void MatchingActorIdentity_IsAdmitted_AndRejectedOnlyByGameState(string action)
        => Run(action, actorId: long.Parse(ScopePlayerId))
            .Should().Be("player_not_actionable",
                "a scope-matching actor must clear admission and advance to game-state validation");

    [Theory]
    [InlineData("chop_tree_source")]
    [InlineData("chest_store")]
    [InlineData("craft_item")]
    public void MismatchedActorIdentity_FailsClosed(string action)
        => Run(action, actorId: 2002L)
            .Should().Be("execution_scope_mismatch",
                "an actor outside the execution scope must never act");

    [Theory]
    [InlineData("chop_tree_source")]
    [InlineData("chest_store")]
    [InlineData("craft_item")]
    public void AbsentActor_FailsClosed(string action)
        => Run(action, actorId: null)
            .Should().Be("world_not_ready",
                "admission never proceeds without a resolved actor");

    [Fact]
    public void Admission_DoesNotConsultTheRetiredSinglePlayerTopologyGuard()
    {
        string controller = File.ReadAllText(RepositoryRelative("integrations/stardew", "farmhandexecutioncontroller.craftingactions.cs"))
            + File.ReadAllText(RepositoryRelative("integrations/stardew", "farmhandexecutioncontroller.machinesanimalsitemsactions.cs"))
            + File.ReadAllText(RepositoryRelative("integrations/stardew", "farmhandexecutioncontroller.resourcetoolactions.cs"));

        controller.Should().NotContain("native_local_player_required",
            "the retired single-player guard must not reappear in any action admission path");
        controller.Should().NotContain("!Game1.IsMasterGame",
            "Game1.IsMasterGame is false on the AI Farmhand client, so it cannot gate companion admission");
    }

    private static string Run(string action, long? actorId)
    {
        bool eventUpBefore = Game1.eventUp;
        try
        {
            // Keep the game state inert so the only variable under test is admission.
            Game1.eventUp = true;
            ExecutionManager executions = Create(actorId);
            IFarmhandActionHandler handler = action == "chop_tree_source"
                ? new ResourceToolActionHandler(executions)
                : new MachineAndAnimalActionHandler(executions);
            long deadline = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000;
            LocalExecutionReceipt receipt = handler.Execute(
                new BridgeExecutionRequest($"probe_{action}", $"probe_{action}", action, Args(action), 1, deadline),
                executions);
            return receipt.ReasonCode;
        }
        finally
        {
            Game1.eventUp = eventUpBefore;
        }
    }

    private static ExecutionManager Create(long? actorId)
    {
        var scope = new BridgeScope("stardew", "save_probe", "world_probe", ScopePlayerId, "companion_probe");
        var publication = FarmhandCapabilityPublication.Initial(
            new HashSet<string>(StringComparer.Ordinal) { "chop_tree_source", "chest_store", "craft_item" });
        var executions = new ExecutionManager(
            new DummyMonitor(),
            () => publication,
            executionJournal: new FarmhandExecutionJournal(new ProbePersistence()),
            executionScope: scope);

        Farmer? actor = null;
        if (actorId is not null)
        {
            actor = (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));
            typeof(Farmer)
                .GetField("uniqueMultiplayerID", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(actor, new NetLong(actorId.Value));
        }

        executions.SetTestActorResolver(() => actor);
        return executions;
    }

    private static BridgeExecutionArgs Args(string action) => action switch
    {
        "chop_tree_source" => new BridgeExecutionArgs { X = 5, Y = 5, Slot = 0, ExpectedTargetId = "target_1" },
        "chest_store" => new BridgeExecutionArgs { X = 5, Y = 5, Slot = 2, ExpectedQualifiedItemId = "(O)24", ExpectedTargetId = "chest_target_1" },
        _ => new BridgeExecutionArgs { ExpectedTargetId = "Torch" },
    };

    /// <summary>Tests run from either the project or the bin output directory; walk up until the source file is found.</summary>
    private static string RepositoryRelative(params string[] parts)
    {
        string relative = Path.Combine(parts);
        string[] starts = { AppContext.BaseDirectory, Environment.CurrentDirectory };
        foreach (string start in starts)
        {
            DirectoryInfo? dir = new(start);
            for (int depth = 0; dir is not null && depth < 12; depth++, dir = dir.Parent)
            {
                string candidate = Path.Combine(dir.FullName, relative);
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
        }

        throw new FileNotFoundException($"repository file not found: {relative}");
    }

    private sealed class ProbePersistence : IModGlobalDataPersistence
    {
        private FarmhandExecutionJournalState? state;
        public FarmhandExecutionJournalState? Read(string key) => this.state;
        public bool TryWrite(string key, FarmhandExecutionJournalState value)
        {
            this.state = value;
            return true;
        }
    }
}
