using System;
using System.Text.RegularExpressions;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// One request swings the axe until the tree is felled, and the receipt says how many swings that took.
///
/// <para>
/// The engine facts, read from the decompiled source rather than assumed: `Axe.DoFunction` swings ONCE (Axe.cs:63-97) and
/// `Tree.performToolAction` subtracts `upgradeLevel switch { 0 => 1f, 1 => 1.25f, ... }` (Tree.cs:1177-1200), so a basic
/// axe takes a mature tree from 10 to 9. On the swing that reaches `<= 0` the engine sets `stump = true; health = 5f;
/// falling = true` and returns FALSE (Tree.cs:1489-1497), which is why the stump stays for `chop_stump` to target.
/// </para>
/// <para>
/// A single-swing `chop_tree` therefore cost one plan node per hit: a mature tree needed ten dispatches, ten engine
/// round trips and ten model decisions, and an auditor's run measured exactly that shape. `break_resource_clump`
/// already carried the right one - a bounded loop inside one request, `swings` on the receipt, and a postcondition
/// read back from the location - so this action takes the same shape and leaves `chop_stump` where it is: a felled
/// tree's stump is a different terminal state and the run used both.
/// </para>
/// </summary>
[Trait("kind", "source-shape")]
public sealed class ChopTreeSwingOutcomeSourceShapeTests
{
    [Fact]
    public void OneRequestSwingsUntilTheTreeIsFelled()
    {
        // COMMENTS ARE STRIPPED, and this test's first green attempt is why: the assertions below look for strings the
        // comments explain, and a gate its own prose can satisfy is the same defect as one its prose can fail.
        string body = WithoutComments(MethodBody(Source(), "private LocalExecutionReceipt ExecuteChopTreeSource("));

        // The loop's bound is derived from the tree's own health, and its terminal is the engine's felled marker -
        // not a health value the fixture happened to start on.
        body.Should().Contain("while (swingCount < swingCap)", "one request keeps swinging until the tree falls");
        body.Should().Contain("tree.stump.Value", "the felled marker is the terminal state the loop watches");
        body.Should().Contain("swingCap", "the loop is bounded by the work this tree actually needs");
        body.Should().NotContain(
            "after == 5f",
            "5f is the health the engine ASSIGNS to a felled stump, not the result of one swing");
    }

    [Fact]
    public void TheReceiptCarriesTheSwingCountAndTheHealthPair()
    {
        // The model should not have to observe again to learn what the chop did. `break_resource_clump` already reports
        // `health_before`/`health_after`/`swings` in one receipt; this action reports the same three facts, and the Host
        // validator accepts exactly this key set.
        string body = WithoutComments(MethodBody(Source(), "private LocalExecutionReceipt ExecuteChopTreeSource("));

        body.Should().Contain("health_before={before", "the receipt names the tree's health before the swings");
        body.Should().Contain("health_after={healthAfterText}", "and the health it was left at");
        body.Should().Contain("swings={swingCount", "and how many swings the felling took, so no second observe is needed");
    }

    [Fact]
    public void AStopNamesWhatEndedTheSwingsAndReportsAPartialResultAsUncertain()
    {
        string body = WithoutComments(MethodBody(Source(), "private LocalExecutionReceipt ExecuteChopTreeSource("));

        body.Should().Contain("tree_changed_during_swings", "a tree replaced mid-loop is not the tree that was asked for");
        body.Should().Contain("tool_no_longer_satisfies", "and a tool that stopped damaging the source must say so");
        body.Should().Contain("stamina_exhausted_after_", "a stamina stop names the swing it happened on");
        body.Should().Contain("ExecutionState.Uncertain", "a stop after some swings is never reported as complete");
    }

    private static string WithoutComments(string source) =>
        Regex.Replace(Regex.Replace(source, @"/\*[\s\S]*?\*/", string.Empty), @"(^|[^:])//.*$", "$1", RegexOptions.Multiline);

    [Fact]
    public void DiscoveryFindsALivingTreeNotOnlyAFelledOne()
    {
        // `== 1f` here meant "a tree one swing from falling", which is why the whole world's living trees were invisible to
        // the radar while `observe_scene` still advertised them as choppable.
        string controller = File.ReadAllText(
            Path.Combine(RepositoryRoot(), "integrations", "stardew", "farmhandexecutioncontroller.cs"));
        // Anchor on the DECLARATION line, not the first mention: the name also appears at the call site (2243), and a
        // regex that matched there would read the wrong 4000 characters. This test's first draft did exactly that and
        // reported "the discovery family must be findable" for a function that was findable all along.
        Match discovery = Regex.Match(
            controller,
            @"private static IReadOnlyList<BridgeTreeChopSourceTarget> DiscoverTreeChopSourceTargets\([^)]*\)[\s\S]*?\n    \}",
            RegexOptions.None,
            TimeSpan.FromSeconds(2));
        discovery.Success.Should().BeTrue("the discovery family must be findable");
        discovery.Value.Should().NotContain(
            "tree.health.Value == 1f",
            "a tree one swing from falling is not the population, it is a fixture");
        // The standing-tree test moved into the ONE predicate that also names the reason a tree is not a source, so the
        // filter and the reason cannot disagree. The pin follows it: health is durability, and `> 0f` is the engine's
        // own still-standing answer (Tree.cs:587), read here as its negation.
        Match exclusion = Regex.Match(
            controller,
            @"(?:private|internal) static string\? TreeChopSourceExclusion\([^)]*\)[\s\S]*?\n    \}",
            RegexOptions.None,
            TimeSpan.FromSeconds(2));
        exclusion.Success.Should().BeTrue("the chop-source predicate and its reason must be one decision");
        exclusion.Value.Should().Contain(
            "tree.health.Value <= 0f",
            "health is durability: a standing tree is one with health above zero");
    }

    [Fact]
    public void TheExecutionPrecheckAcceptsAnyStandingTree()
    {
        string actions = File.ReadAllText(
            Path.Combine(
                RepositoryRoot(),
                "integrations",
                "stardew",
                "farmhandexecutioncontroller.resourcetoolactions.cs"));

        actions.Should().NotContain(
            "tree.health.Value != 1f",
            "the precheck must refuse a tree that is GONE, not one that is merely healthy");
        actions.Should().Contain(
            "tree.health.Value <= 0f",
            "zero or below is the engine's own test for a tree that is no longer standing");
    }

    private static string Source() =>
        File.ReadAllText(
            Path.Combine(
                RepositoryRoot(),
                "integrations",
                "stardew",
                "farmhandexecutioncontroller.resourcetoolactions.cs"));

    private static string RepositoryRoot()
    {
        string? directory = AppContext.BaseDirectory;
        while (directory is not null && !Directory.Exists(Path.Combine(directory, "integrations")))
            directory = Path.GetDirectoryName(directory);
        return directory ?? throw new InvalidOperationException("repository_root_not_found");
    }

    private static string MethodBody(string source, string declaration)
    {
        int at = source.IndexOf(declaration, StringComparison.Ordinal);
        at.Should().BeGreaterThanOrEqualTo(0, $"`{declaration}` must exist");
        int depth = 0;
        bool started = false;
        for (int i = source.IndexOf('{', at); i < source.Length; i++)
        {
            if (source[i] == '{')
            {
                depth++;
                started = true;
            }
            else if (source[i] == '}')
            {
                depth--;
                if (started && depth == 0) return source[at..(i + 1)];
            }
        }
        throw new InvalidOperationException($"unbalanced body for {declaration}");
    }
}
