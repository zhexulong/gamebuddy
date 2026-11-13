using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Three crop actions refused from outside the native interaction radius instead of walking in.
///
/// `water_crop`, `plant_seed` and `fertilize_tile` all gate on `IsCropTargetInRange`, which is
/// Chebyshev 1 (`farmhandexecutioncontroller.cs:3686-3689`). On the false branch they returned
/// `target_out_of_range` - so a companion standing two tiles from its own crop was told the tile was
/// unavailable, with only `target=x,y` as evidence, and the Agent had nothing to learn from it.
///
/// `harvest_crop` in the SAME file already had the right shape: out of range means walk in, then act.
/// These pins read the source because the difference is a routing decision, not a runtime outcome - a
/// live run is not needed to answer "does the out-of-range branch refuse or approach".
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the pins here assert on repository source text because the native seam they cover cannot load in a headless runner, while the rest of the class constructs and calls product code for real; keeping both in one file keeps each pin beside the behaviour it protects.
public sealed class CropApproachWiringTests
{
    private const string Relative = "integrations/stardew/farmhandexecutioncontroller.farmingconstructionactions.cs";
    private const string Machines = "integrations/stardew/farmhandexecutioncontroller.machinesanimalsitemsactions.cs";
    private const string Controller = "integrations/stardew/farmhandexecutioncontroller.cs";

    [Theory]
    [InlineData(Machines, "machine_inspect", "IsMachineTargetInRange", "InspectMachine")]
    [InlineData(Machines, "feed_animal", "IsFeedTroughTargetInRange", "FeedAnimal")]
    public void AnOutOfRangeMachineOrAnimalActionWalksInInsteadOfRefusing(string file, string actionId, string rangePredicate, string bodyName)
    {
        string request = MethodBody(System.IO.File.ReadAllText(RepositoryFile(file)), $"public LocalExecutionReceipt RequestLocal{bodyName}(");

        int gate = request.IndexOf($"if (!{rangePredicate}(Game1.player, targetX, targetY))", System.StringComparison.Ordinal);
        gate.Should().BeGreaterThan(0, $"{actionId} still gates on its native radius");

        int gateEnd = request.IndexOf('}', gate);
        string falseBranch = request.Substring(gate, gateEnd - gate);

        falseBranch.Should().Contain("TryBeginToolApproach",
            $"{actionId} must walk in when the native radius is not met");
        falseBranch.Should().NotContain("target_out_of_range",
            $"{actionId} must not refuse a target it can simply walk to");
    }

    /// <summary>
    /// The crop requests answer through the tile-target seam now, so the routing decision is the seam's: the action
    /// names the range predicate its native call needs, and the seam walks in when that predicate answers false. The pin
    /// stays per action, because a request half naming another action's predicate would advertise a reach it does not have.
    /// </summary>
    [Theory]
    [InlineData("water_crop", "IsCropTargetInRange")]
    [InlineData("plant_seed", "IsCropTargetInRange")]
    [InlineData("fertilize_tile", "IsCropTargetInRange")]
    [InlineData("harvest_crop", "IsCropTargetInRange")]
    public void ACropRequestNamesTheRangePredicateItsNativeCallNeeds(string actionId, string rangePredicate)
    {
        string request = MethodBody(Source(), $"public LocalExecutionReceipt RequestLocal{ActionMethodName(actionId)}(");

        request.Should().Contain($"inReach: {rangePredicate},", $"{actionId} must hand the seam the radius its native call needs");
        request.Should().NotContain("TryBeginToolApproach", $"{actionId}'s walk belongs to the seam");
        request.Should().NotContain("target_out_of_range", $"{actionId} must not refuse a target it can simply walk to");
    }

    /// <summary>
    /// The seam turns "out of reach" into a walk for every action that hands it a predicate: the false branch begins the
    /// approach leg, and no branch of it refuses for being far away.
    /// </summary>
    [Fact]
    public void AnOutOfRangeTileTargetWalksInInsteadOfRefusing()
    {
        string seam = MethodBody(
            System.IO.File.ReadAllText(RepositoryFile("integrations/stardew/farmhandexecutioncontroller.tiletargetrequest.cs")),
            "private LocalExecutionReceipt RequestLocalTileTarget(");

        int reach = seam.IndexOf("if (!(inReach ?? IsTileWithinNativeReach)(Game1.player, answer.X, answer.Y))", System.StringComparison.Ordinal);
        reach.Should().BeGreaterThan(0, "the seam tests the action's own reach predicate, or the native radius when it names none");

        int branchEnd = seam.IndexOf(';', reach);
        string falseBranch = seam[reach..branchEnd];

        falseBranch.Should().Contain("TryBeginToolApproach", "an out-of-range target is walked to, not refused");
        falseBranch.Should().NotContain("target_out_of_range", "a target the actor can walk to is not unavailable");
        falseBranch.Should().NotContain("ExecutionState.Rejected", "the false branch dispatches a walk; it does not end the request");
    }

    /// <summary>
    /// `scythe_crop` is the one crop request that still answers synchronously: its tool preflight, its reach test and its
    /// walk fit in a body without a target resolver, so the seam has nothing of its own to keep. The rule is the same.
    /// </summary>
    [Fact]
    public void AnOutOfRangeScytheTargetWalksInInsteadOfRefusing()
    {
        string request = MethodBody(Source(), "public LocalExecutionReceipt RequestLocalScytheCrop(");

        int gate = request.IndexOf("if (!IsScytheTargetInRange(Game1.player, targetX, targetY))", System.StringComparison.Ordinal);
        gate.Should().BeGreaterThan(0, "scythe_crop still gates on its native radius");

        int gateEnd = request.IndexOf('}', gate);
        string falseBranch = request.Substring(gate, gateEnd - gate);

        falseBranch.Should().Contain("TryBeginToolApproach", "scythe_crop must walk in when the native radius is not met");
        falseBranch.Should().NotContain("target_out_of_range", "scythe_crop must not refuse a target it can simply walk to");
    }

    [Fact]
    public void TheSuccessPathStillCallsTheSameExecuteBodyThatTheApproachArrivesAt()
    {
        // One body, two entry points. The seam hands the SAME `execute` delegate to the approach leg and to the in-range
        // branch, so the two paths cannot drift into different postconditions.
        string request = MethodBody(Source(), "public LocalExecutionReceipt RequestLocalWaterCrop(");

        request.Split("this.ExecuteWaterCrop(").Length.Should().Be(
            2,
            "water_crop's body is handed to the seam once, inside its `execute` delegate");

        string seam = MethodBody(
            System.IO.File.ReadAllText(RepositoryFile("integrations/stardew/farmhandexecutioncontroller.tiletargetrequest.cs")),
            "private LocalExecutionReceipt RequestLocalTileTarget(");
        seam.Should().Contain("expectedTargetId, execute, nowMs, requestedDeadlineMs)", "the approach leg finishes in that delegate");
        seam.Should().Contain("return execute(executionId, requestId);", "the in-reach path runs that same delegate");
    }

    /// <summary>`water_crop` -> `WaterCrop`, `plant_seed` -> `PlantSeed`.</summary>
    private static string ActionMethodName(string actionId) =>
        string.Concat(actionId.Split('_').Select(part => char.ToUpperInvariant(part[0]) + part.Substring(1)));

    private static string Source() => System.IO.File.ReadAllText(RepositoryFile(Relative));

    private static string RepositoryFile(string relative)
    {
        DirectoryInfo? directory = new(System.AppContext.BaseDirectory);
        while (directory is not null && !Directory.Exists(Path.Combine(directory.FullName, "integrations")))
            directory = directory.Parent;
        directory.Should().NotBeNull("the test must run inside the repository");
        return Path.Combine(directory!.FullName, relative);
    }

    /// <summary>
    /// One member's body from its declaration. The parameter list is skipped by its own parentheses, because a member
    /// whose body is an EXPRESSION - the shape the request halves take when they only hand the seam their facts - has no
    /// brace of its own and its lambdas do; reading from the first `{` would return a lambda's block instead.
    /// </summary>
    private static string MethodBody(string source, string signature)
    {
        int start = source.IndexOf(signature, System.StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, $"{signature} must exist");
        int open = source.IndexOf('(', start);
        int depth = 0;
        int afterParameters = open;
        for (int index = open; index < source.Length; index += 1)
        {
            if (source[index] == '(') depth += 1;
            else if (source[index] == ')' && --depth == 0)
            {
                afterParameters = index + 1;
                break;
            }
        }

        int cursor = afterParameters;
        while (source[cursor] is ' ' or '\n' or '\r' or '\t') cursor += 1;
        if (source[cursor] == '{')
        {
            int braces = 0;
            for (int index = cursor; index < source.Length; index += 1)
            {
                if (source[index] == '{') braces += 1;
                else if (source[index] == '}' && --braces == 0) return source.Substring(cursor, index - cursor + 1);
            }

            throw new System.InvalidOperationException($"{signature} has unbalanced braces");
        }

        int parentheses = 0;
        int nested = 0;
        for (int index = cursor; index < source.Length; index += 1)
        {
            switch (source[index])
            {
                case '(': parentheses += 1; break;
                case ')': parentheses -= 1; break;
                case '{': nested += 1; break;
                case '}': nested -= 1; break;
                case ';' when parentheses == 0 && nested == 0: return source.Substring(cursor, index - cursor + 1);
            }
        }

        throw new System.InvalidOperationException($"{signature} has an unterminated expression body");
    }

    [Theory]
    [InlineData("inspect_npc_relationship", "InspectNpcRelationship")]
    [InlineData("interact_npc_with_item", "InteractNpcWithItem")]
    public void AnOutOfRangeNpcActionWalksInInsteadOfRefusing(string actionId, string bodyName)
    {
        // The villager actions resolve the NPC by its IDENTITY and answer the tile it stands on NOW, because a villager
        // walks while the actor walks; the seam then measures reach against that live tile and, outside the native
        // radius, dispatches the walk. Before the seam both facts lived inline in each request half; what this pin keeps
        // is that the resolution happens at all and that nothing refuses a villager for being far away.
        string request = MethodBody(System.IO.File.ReadAllText(RepositoryFile(Machines)),
            $"public LocalExecutionReceipt RequestLocal{bodyName}(");

        request.Should().Contain("FindVillagerByTargetId(location, expectedTargetId)",
            $"{actionId} resolves the villager by name-binding, not by the tile a snapshot published");
        request.Should().Contain("TileTargetGate.Resolved((int)npc.Tile.X, (int)npc.Tile.Y)",
            $"{actionId} answers the tile the villager stands on now, so the walk is aimed where it is");
        request.Should().Contain("this.RequestLocalTileTarget(", $"{actionId} hands the walk to the seam");
        request.Should().NotContain("TryBeginToolApproach", $"{actionId}'s walk belongs to the seam now");
        request.Should().NotContain("target_out_of_range",
            $"{actionId} must not refuse a villager it can simply walk to");
    }

    [Fact]
    public void TheNpcArrivalPathReResolvesTheVillagerRatherThanReusingTheWalkStartObject()
    {
        // A villager moves while the actor walks. Reusing the NPC captured before the walk would aim the
        // gift at where they WERE - the failure the moving-target rule exists for. Both execution bodies
        // therefore re-resolve by name-binding, and refuse by name when the villager has left.
        string source = System.IO.File.ReadAllText(RepositoryFile(Machines));
        foreach ((string body, string refusal) in new[]
        {
            ("private LocalExecutionReceipt ExecuteInspectNpcRelationship(", "npc_relationship_out_of_reach_after_approach"),
            ("private LocalExecutionReceipt ExecuteInteractNpcWithItem(", "npc_interaction_out_of_reach_after_approach"),
        })
        {
            string executed = MethodBody(source, body);
            executed.Should().Contain("FindVillagerByTargetId(location, expectedTargetId)",
                $"{body} must re-resolve the villager by name-binding, not by tile");
            executed.Should().Contain(refusal, $"{body} must name the moved-out-of-reach refusal");
        }

        // ...and the lookup both bodies share is the name-binding one, so neither can drift back to the walk-start tile.
        string resolver = MethodBody(
            System.IO.File.ReadAllText(RepositoryFile(Controller)),
            "private static StardewValley.NPC? FindVillagerByTargetId(");
        resolver.Should().Contain("BuildNpcRelationshipTargetId(location, candidate.Name)");
    }
}