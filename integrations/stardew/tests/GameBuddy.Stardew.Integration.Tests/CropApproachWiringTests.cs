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
public sealed class CropApproachWiringTests
{
    private const string Relative = "integrations/stardew/farmhandexecutioncontroller.farmingconstructionactions.cs";
    private const string Machines = "integrations/stardew/farmhandexecutioncontroller.machinesanimalsitemsactions.cs";

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

    [Theory]
    [InlineData("water_crop", "IsCropTargetInRange")]
    [InlineData("plant_seed", "IsCropTargetInRange")]
    [InlineData("fertilize_tile", "IsCropTargetInRange")]
    [InlineData("scythe_crop", "IsScytheTargetInRange")]
    public void AnOutOfRangeCropActionWalksInInsteadOfRefusing(string actionId, string rangePredicate)
    {
        string request = MethodBody(Source(), $"public LocalExecutionReceipt RequestLocal{ActionMethodName(actionId)}(");

        int gate = request.IndexOf($"if (!{rangePredicate}(Game1.player, targetX, targetY))", System.StringComparison.Ordinal);
        gate.Should().BeGreaterThan(0, $"{actionId} still gates on its native radius");

        // The false branch must be an approach, not a refusal. Read the ~20 lines after the gate only:
        // the success branch further down names the action and would satisfy a whole-body search.
        int gateEnd = request.IndexOf('}', gate);
        string falseBranch = request.Substring(gate, gateEnd - gate);

        falseBranch.Should().Contain("TryBeginToolApproach",
            $"{actionId} must walk in when the native radius is not met, like harvest_crop in this same file");
        falseBranch.Should().NotContain("target_out_of_range",
            $"{actionId} must not refuse a target it can simply walk to");
    }

    [Fact]
    public void TheSuccessPathStillCallsTheSameExecuteBodyThatTheApproachArrivesAt()
    {
        // One body, two entry points. If the in-range path and the arrival callback named different
        // methods, the two paths could drift and only one would keep its postcondition.
        string request = MethodBody(Source(), "public LocalExecutionReceipt RequestLocalWaterCrop(");

        request.Should().Contain("this.ExecuteWaterCrop(executionId, requestId,");
        request.Should().Contain("this.ExecuteWaterCrop(arrivalExecutionId, arrivalRequestId,");
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

    private static string MethodBody(string source, string signature)
    {
        int start = source.IndexOf(signature, System.StringComparison.Ordinal);
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

        throw new System.InvalidOperationException($"{signature} has unbalanced braces");
    }

    [Theory]
    [InlineData("inspect_npc_relationship", "InspectNpcRelationship")]
    [InlineData("interact_npc_with_item", "InteractNpcWithItem")]
    public void AnOutOfRangeNpcActionWalksInInsteadOfRefusing(string actionId, string bodyName)
    {
        // The villager actions gate on the NPC's LIVE tile rather than a request tile, so the predicate
        // reads `(int)npc.Tile.X` and the generic case above cannot match it. The rule is the same: out of
        // range means walk in. A refusal here is a race the caller cannot win by retrying, because the
        // villager keeps walking.
        string request = MethodBody(System.IO.File.ReadAllText(RepositoryFile(Machines)),
            $"public LocalExecutionReceipt RequestLocal{bodyName}(");

        int gate = request.IndexOf("if (!IsTileWithinChebyshevRadius(Game1.player, (int)npc.Tile.X, (int)npc.Tile.Y, 1))", System.StringComparison.Ordinal);
        gate.Should().BeGreaterThan(0, $"{actionId} still gates on the villager's live tile");

        int gateEnd = request.IndexOf('}', gate);
        string falseBranch = request.Substring(gate, gateEnd - gate);

        falseBranch.Should().Contain("TryBeginToolApproach",
            $"{actionId} must walk in when the villager is out of reach");
        falseBranch.Should().NotContain("target_out_of_range",
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
            executed.Should().Contain("BuildNpcRelationshipTargetId(location, candidate.Name)",
                $"{body} must re-resolve the villager by name-binding, not by tile");
            executed.Should().Contain(refusal, $"{body} must name the moved-out-of-reach refusal");
        }
    }
}