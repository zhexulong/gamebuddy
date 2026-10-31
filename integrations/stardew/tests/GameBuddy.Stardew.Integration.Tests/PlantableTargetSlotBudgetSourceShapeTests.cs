using System;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A held stack is a SLOT, and the plantable families were budgeting rows per FAMILY instead.
///
/// `DiscoverSeedTargets` / `DiscoverTreeSaplingTargets` iterate inventory slots on the outside and tiles on the
/// inside, with one `result.Count &lt; 64` guard on both loops. `TargetDiscoveryRadius` is 6, so one slot alone can
/// fill 169 candidate tiles and the first held stack consumes the whole budget: measured 2026-10-29 (`round7`), all
/// 64 published rows were ONE stack (slot 14 `(O)770` on 14 of 33 observations, slot 13 `(O)309` on 22 of 33). A
/// companion carrying parsnips in slot 0 and cauliflowers in slot 1 could not name a single cauliflower tile, so
/// `plant_seed` had no address for the second crop - a capability hole, not a payload problem.
///
/// SCOPE, stated plainly: both discovery functions are `private static`, and their tile predicate is
/// `HoeDirt.canPlantThisSeedHere` / `CanPlantWildTreeSeedAt`, which resolve `Data/Crops` and `Data/WildTrees` - content
/// tables a headless runner has not loaded, so a two-seed-slot fixture cannot be built without inventing crop data
/// (the sapling harness in `SaplingApproachWiringTests` supplies those two tables EMPTY for exactly that reason, which
/// is honest for a tree and useless for a seed). What is pinned here is the budget itself: a per-slot window, and no
/// family-wide counter a later slot can find already spent.
/// </summary>
[Trait("kind", "source-shape")]
public sealed class PlantableTargetSlotBudgetSourceShapeTests
{
    [Theory]
    [InlineData("private static IReadOnlyList<BridgeSeedTarget> DiscoverSeedTargets(")]
    [InlineData("private static IReadOnlyList<BridgeTreeSaplingTarget> DiscoverTreeSaplingTargets(")]
    public void EachHeldStackGetsItsOwnWindowRatherThanAPlaceInAFamilyBudget(string signature)
    {
        string source = Source();
        // The DEFINITION, not a call site: the signature is the only anchor that cannot land in a lambda body.
        int definition = source.IndexOf(signature, StringComparison.Ordinal);
        definition.Should().BeGreaterThan(-1, $"{signature} must be defined");
        // COMMENTS STRIPPED before anything is read. The prose above these functions quotes the defect (`result.Count
        // < 64`) to explain it, so an assertion matching raw text passes or fails on prose instead of on behaviour.
        string body = StripComments(BracedBody(source, definition));

        body.Should().NotContain("result.Count < 64",
            "one family-wide counter is spent by the first held stack, so every later held stack publishes nothing");
        body.Should().Contain("TargetRowBudget.PerKeyRowLimit(",
            "each key gets a window from the family's row limit, allocated per key");
        body.Should().Contain("NearestFirstByChebyshev(",
            "a stack's window must hold its NEAREST tiles, so the stack is ordered before its own window trims it");
        body.Should().Contain(".Take(rowLimit)", "the window is applied per stack, after that stack is ordered");
    }

    /// <summary>The body with whole-line and trailing `//` comments removed, so nothing here reads prose.</summary>
    private static string StripComments(string body) => string.Join(
        "\n",
        body.Split('\n')
            .Select(line =>
            {
                int comment = line.IndexOf("//", StringComparison.Ordinal);
                return comment < 0 ? line : line[..comment];
            }));

    /// <summary>The text from the next `{` after <paramref name="from"/> through its matching `}`.</summary>
    private static string BracedBody(string source, int from)
    {
        int brace = source.IndexOf('{', from);
        brace.Should().BeGreaterThan(from, "a method body must follow its signature");
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

        throw new InvalidOperationException("unbalanced braces");
    }

    private static string Source() => System.IO.File.ReadAllText(RepositoryFile());

    private static string RepositoryFile()
    {
        var directory = new System.IO.DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !System.IO.Directory.Exists(System.IO.Path.Combine(directory.FullName, "integrations")))
            directory = directory.Parent;
        directory.Should().NotBeNull("the test must run inside the repository");
        return System.IO.Path.Combine(directory!.FullName, "integrations/stardew/farmhandexecutioncontroller.cs");
    }
}
