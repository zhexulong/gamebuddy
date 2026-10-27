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

    private static string Source() => File.ReadAllText(RepositoryFile());

    private static string RepositoryFile()
    {
        DirectoryInfo? directory = new(System.AppContext.BaseDirectory);
        while (directory is not null && !Directory.Exists(Path.Combine(directory.FullName, "integrations")))
            directory = directory.Parent;
        directory.Should().NotBeNull("the test must run inside the repository");
        return Path.Combine(directory!.FullName, Relative);
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
}
