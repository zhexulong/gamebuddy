using System.Reflection;
using System.Runtime.Serialization;
using System.Text.RegularExpressions;
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
///
/// Coverage is not sampled: the parameterised set is compared against the set derived
/// from the Mod source (<see cref="CoveredActionSet_EqualsTheSourceDerivedGuardedActionSet"/>),
/// so a guard added to, removed from, or re-dispatched within these partials fails here.
/// </summary>
public sealed class ScopeBoundActorAdmissionTests
{
    private const string ScopePlayerId = "1001";

    /// <summary>
    /// The controller partials whose shared-world admission guard commit
    /// <c>98fe750</c> replaced with the scope-bound actor proof; together they hold
    /// every <c>TryGetBoundActor</c> admission site that commit migrated. Movement and
    /// Expression keep their own raw-actor guards (different reason codes, no
    /// <c>player_not_actionable</c> stage) and are deliberately outside this probe.
    /// </summary>
    private static readonly string[] MigratedControllerPartials =
    {
        "farmhandexecutioncontroller.containeractions.cs",
        "farmhandexecutioncontroller.cookingactions.cs",
        "farmhandexecutioncontroller.crabpotactions.cs",
        "farmhandexecutioncontroller.craftingactions.cs",
        "farmhandexecutioncontroller.farmingconstructionactions.cs",
        "farmhandexecutioncontroller.machinesanimalsitemsactions.cs",
        "farmhandexecutioncontroller.resourcetoolactions.cs",
    };

    [Theory]
    [InlineData("chest_store")]
    [InlineData("chest_retrieve")]
    [InlineData("cook_recipe")]
    [InlineData("collect_crab_pot_output")]
    [InlineData("craft_item")]
    [InlineData("refill_watering_can")]
    [InlineData("plant_sapling")]
    [InlineData("scythe_crop")]
    [InlineData("machine_load")]
    [InlineData("machine_collect_output")]
    [InlineData("chop_tree_source")]
    [InlineData("break_rock_source")]
    [InlineData("dig_artifact_spot")]
    [InlineData("clear_hoedirt")]
    [InlineData("chop_stump")]
    [InlineData("cut_weeds")]
    public void MatchingActorIdentity_IsAdmitted_AndRejectedOnlyByGameState(string action)
        => Run(action, actorId: long.Parse(ScopePlayerId))
            .Should().Be("player_not_actionable",
                "a scope-matching actor must clear admission and advance to game-state validation");

    [Theory]
    [InlineData("chest_store")]
    [InlineData("chest_retrieve")]
    [InlineData("cook_recipe")]
    [InlineData("collect_crab_pot_output")]
    [InlineData("craft_item")]
    [InlineData("refill_watering_can")]
    [InlineData("plant_sapling")]
    [InlineData("scythe_crop")]
    [InlineData("machine_load")]
    [InlineData("machine_collect_output")]
    [InlineData("chop_tree_source")]
    [InlineData("break_rock_source")]
    [InlineData("dig_artifact_spot")]
    [InlineData("clear_hoedirt")]
    [InlineData("chop_stump")]
    [InlineData("cut_weeds")]
    public void MismatchedActorIdentity_FailsClosed(string action)
        => Run(action, actorId: 2002L)
            .Should().Be("execution_scope_mismatch",
                "an actor outside the execution scope must never act");

    [Theory]
    [InlineData("chest_store")]
    [InlineData("chest_retrieve")]
    [InlineData("cook_recipe")]
    [InlineData("collect_crab_pot_output")]
    [InlineData("craft_item")]
    [InlineData("refill_watering_can")]
    [InlineData("plant_sapling")]
    [InlineData("scythe_crop")]
    [InlineData("machine_load")]
    [InlineData("machine_collect_output")]
    [InlineData("chop_tree_source")]
    [InlineData("break_rock_source")]
    [InlineData("dig_artifact_spot")]
    [InlineData("clear_hoedirt")]
    [InlineData("chop_stump")]
    [InlineData("cut_weeds")]
    public void AbsentActor_FailsClosed(string action)
        => Run(action, actorId: null)
            .Should().Be("world_not_ready",
                "admission never proceeds without a resolved actor");

    [Fact]
    public void Admission_DoesNotConsultTheRetiredSinglePlayerTopologyGuard()
    {
        MigratedControllerPartials.Should().HaveCount(7,
            "the retired-token scan must keep covering all seven controller partials whose guards 98fe750 migrated");

        foreach (string partial in MigratedControllerPartials)
        {
            string controller = File.ReadAllText(ControllerRelative(partial));

            controller.Should().NotContain("native_local_player_required",
                $"{partial} must not resurrect the retired single-player guard in any action admission path");
            controller.Should().NotContain("!Game1.IsMasterGame",
                $"Game1.IsMasterGame is false on the AI Farmhand client, so {partial} cannot gate companion admission on it");
        }
    }

    /// <summary>
    /// The parameterised actions are exactly the actions whose handler dispatch
    /// reaches a <c>RequestLocal*</c> body that calls <c>TryGetBoundActor</c>. Both
    /// sides are derived from source (and from the theory attributes themselves), so a
    /// new guard, a removed guard, or a re-dispatched action cannot pass unnoticed.
    /// </summary>
    [Fact]
    public void CoveredActionSet_EqualsTheSourceDerivedGuardedActionSet()
    {
        IReadOnlySet<string> expected = GuardedDispatchedActions();
        string rendered = string.Join(", ", expected.OrderBy(id => id, StringComparer.Ordinal));

        expected.Should().NotBeEmpty("the Mod source must still hold scope-bound admission sites");

        foreach (string theory in new[]
                 {
                     nameof(MatchingActorIdentity_IsAdmitted_AndRejectedOnlyByGameState),
                     nameof(MismatchedActorIdentity_FailsClosed),
                     nameof(AbsentActor_FailsClosed),
                 })
        {
            TheoryInlineDataActions(theory).Should().BeEquivalentTo(expected,
                $"{theory} must parameterise every action whose handler dispatch reaches a guarded RequestLocal* body (derived set: {rendered})");
        }
    }

    private static string Run(string action, long? actorId)
    {
        bool eventUpBefore = Game1.eventUp;
        try
        {
            // Keep the game state inert so the only variable under test is admission.
            Game1.eventUp = true;
            ExecutionManager executions = Create(action, actorId);
            IFarmhandActionHandler handler = CreateHandler(executions, action);
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

    /// <summary>
    /// Selects the handler from the registration catalog's dispatch group — the same
    /// group ModEntry composes the production router from — instead of a second,
    /// hand-maintained action-to-handler table.
    /// </summary>
    private static IFarmhandActionHandler CreateHandler(ExecutionManager executions, string action)
    {
        FarmhandActionHandlerGroup? group = FarmhandActionCatalog.Registrations
            .Single(registration => registration.ActionId == action)
            .HandlerGroup;

        return group switch
        {
            FarmhandActionHandlerGroup.Farming => new FarmingActionHandler(executions),
            FarmhandActionHandlerGroup.MachinesAndAnimals => new MachineAndAnimalActionHandler(executions),
            FarmhandActionHandlerGroup.ResourceTools => new ResourceToolActionHandler(executions),
            _ => throw new InvalidOperationException(
                $"{action} is not dispatched through a handler group covered by this admission probe (group: {group?.ToString() ?? "none"})."),
        };
    }

    private static ExecutionManager Create(string action, long? actorId)
    {
        var scope = new BridgeScope("stardew", "save_probe", "world_probe", ScopePlayerId, "companion_probe");
        var publication = FarmhandCapabilityPublication.Initial(
            new HashSet<string>(StringComparer.Ordinal) { action });
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

    /// <summary>
    /// One entry per action, in the exact argument shape its handler dispatch passes
    /// to the <c>RequestLocal*</c> body. There is no catch-all: an action added to a
    /// theory without its dispatch shape fails loudly instead of probing a guess.
    /// </summary>
    private static BridgeExecutionArgs Args(string action) => action switch
    {
        // farmhandexecutioncontroller.containeractions.cs: slot, x, y, expectedQualifiedItemId, expectedTargetId.
        "chest_store" => new BridgeExecutionArgs { X = 5, Y = 5, Slot = 2, ExpectedQualifiedItemId = "(O)24", ExpectedTargetId = "chest_target_1" },
        "chest_retrieve" => new BridgeExecutionArgs { X = 5, Y = 5, Slot = 2, ExpectedQualifiedItemId = "(O)24", ExpectedTargetId = "chest_target_1" },
        // recipe-only: expectedTargetId.
        "cook_recipe" => new BridgeExecutionArgs { ExpectedTargetId = "Fried_Egg" },
        "craft_item" => new BridgeExecutionArgs { ExpectedTargetId = "Torch" },
        // x, y, expectedTargetId.
        "collect_crab_pot_output" => new BridgeExecutionArgs { X = 12, Y = 9, ExpectedTargetId = "collect_crab_pot_0123456789abcdef" },
        "machine_collect_output" => new BridgeExecutionArgs { X = 5, Y = 5, ExpectedTargetId = "machine_target_1" },
        // slot, x, y, expectedTargetId.
        "refill_watering_can" => new BridgeExecutionArgs { X = 5, Y = 5, Slot = 0, ExpectedTargetId = "refill_target_1" },
        "scythe_crop" => new BridgeExecutionArgs { X = 5, Y = 5, Slot = 0, ExpectedTargetId = "scythe_target_1" },
        "chop_tree_source" => new BridgeExecutionArgs { X = 5, Y = 5, Slot = 0, ExpectedTargetId = "target_1" },
        "break_rock_source" => new BridgeExecutionArgs { X = 5, Y = 5, Slot = 0, ExpectedTargetId = "rock_target_1" },
        "dig_artifact_spot" => new BridgeExecutionArgs { X = 5, Y = 5, Slot = 0, ExpectedTargetId = "artifact_target_1" },
        "clear_hoedirt" => new BridgeExecutionArgs { X = 5, Y = 5, Slot = 0, ExpectedTargetId = "hoedirt_target_1" },
        "chop_stump" => new BridgeExecutionArgs { X = 5, Y = 5, Slot = 0, ExpectedTargetId = "stump_target_1" },
        "cut_weeds" => new BridgeExecutionArgs { X = 5, Y = 5, Slot = 0, ExpectedTargetId = "weed_target_1" },
        // slot, x, y, expectedQualifiedItemId, expectedTargetId.
        "plant_sapling" => new BridgeExecutionArgs { X = 5, Y = 5, Slot = 2, ExpectedQualifiedItemId = "(O)309", ExpectedTargetId = "sapling_target_1" },
        "machine_load" => new BridgeExecutionArgs { X = 5, Y = 5, Slot = 0, ExpectedQualifiedItemId = "(O)433", ExpectedTargetId = "machine_target_1" },
        _ => throw new ArgumentOutOfRangeException(nameof(action), action, "no dispatch argument shape is recorded for this action"),
    };

    /// <summary>
    /// Actions whose handler dispatch reaches a <c>RequestLocal*</c> method declared in
    /// one of the migrated partials with a <c>TryGetBoundActor</c> call in its body.
    /// </summary>
    private static IReadOnlySet<string> GuardedDispatchedActions()
    {
        HashSet<string> guardedMethods = new(StringComparer.Ordinal);
        foreach (string partial in MigratedControllerPartials)
        {
            foreach ((string method, string body) in DeclaredRequestMethods(File.ReadAllText(ControllerRelative(partial))))
            {
                // Two admissible forms during convergence. A body is guarded when it
                // still carries the inline scope-bound actor proof, or when it delegates
                // the whole mechanical admission to the shared AdmitExecution helper
                // (which performs that same proof). Without the second form the
                // derivation would report a converged family as unguarded and the
                // completeness assertion below would silently shrink.
                if (body.Contains("TryGetBoundActor(", StringComparison.Ordinal)
                    || body.Contains("AdmitExecution(", StringComparison.Ordinal))
                    guardedMethods.Add(method);
            }
        }

        HashSet<string> actions = new(StringComparer.Ordinal);
        foreach (string handlerFile in Directory.GetFiles(HandlersDirectoryRelative(), "*.cs"))
        {
            foreach (Match dispatch in DispatchEntry.Matches(File.ReadAllText(handlerFile)))
            {
                if (guardedMethods.Contains(dispatch.Groups[2].Value))
                    actions.Add(dispatch.Groups[1].Value);
            }
        }

        return actions;
    }

    /// <summary>Splits a controller partial into its indent-4 members and keeps the ones declaring a <c>RequestLocal*</c> method.</summary>
    private static IEnumerable<(string Method, string Body)> DeclaredRequestMethods(string source)
    {
        MatchCollection memberStarts = MemberStart.Matches(source);
        for (int index = 0; index < memberStarts.Count; index++)
        {
            int start = memberStarts[index].Index;
            int end = index + 1 < memberStarts.Count ? memberStarts[index + 1].Index : source.Length;
            string member = source[start..end];
            Match name = RequestMethodName.Match(member);
            if (name.Success)
                yield return (name.Groups[1].Value, member);
        }
    }

    /// <summary>The <c>[InlineData]</c> action ids carried by one theory method.</summary>
    private static IReadOnlySet<string> TheoryInlineDataActions(string theory)
    {
        MethodInfo? method = typeof(ScopeBoundActorAdmissionTests).GetMethod(theory);
        method.Should().NotBeNull($"the admission theory {theory} must exist");

        return method!.GetCustomAttributesData()
            .Where(attribute => attribute.AttributeType == typeof(InlineDataAttribute))
            .Select(attribute => InlineDataAction(attribute))
            .ToHashSet(StringComparer.Ordinal);
    }

    /// <summary><c>InlineData</c> is <c>params object[]</c>, so the action id arrives inside the single array argument.</summary>
    private static string InlineDataAction(CustomAttributeData attribute)
    {
        object? value = attribute.ConstructorArguments[0].Value;
        return value is IReadOnlyCollection<CustomAttributeTypedArgument> array
            ? (string)array.Single().Value!
            : (string)value!;
    }

    private static string ControllerRelative(string fileName) => RepositoryRelative("integrations/stardew", fileName);

    private static string HandlersDirectoryRelative() => SearchUpward(Path.Combine("integrations/stardew", "Handlers"), Directory.Exists);

    /// <summary>Tests run from either the project or the bin output directory; walk up until the source file is found.</summary>
    private static string RepositoryRelative(params string[] parts) => SearchUpward(Path.Combine(parts), File.Exists);

    private static string SearchUpward(string relative, Func<string, bool> exists)
    {
        string[] starts = { AppContext.BaseDirectory, Environment.CurrentDirectory };
        foreach (string start in starts)
        {
            DirectoryInfo? dir = new(start);
            for (int depth = 0; dir is not null && depth < 12; depth++, dir = dir.Parent)
            {
                string candidate = Path.Combine(dir.FullName, relative);
                if (exists(candidate))
                {
                    return candidate;
                }
            }
        }

        throw new FileNotFoundException($"repository path not found: {relative}");
    }

    /// <summary>C# member declaration at class-body indentation.</summary>
    private static readonly Regex MemberStart = new(
        @"(?m)^    (?:public|private|internal|protected)\s",
        RegexOptions.CultureInvariant);

    private static readonly Regex RequestMethodName = new(
        @"\b(RequestLocal\w+)\s*\(",
        RegexOptions.CultureInvariant);

    /// <summary>Handler dispatch entry: <c>"action_id" =&gt; this.executions.RequestLocalBody(</c>.</summary>
    private static readonly Regex DispatchEntry = new(
        @"""([a-z0-9_]+)""\s*=>\s*this\.executions\.(RequestLocal\w+)",
        RegexOptions.CultureInvariant);

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
