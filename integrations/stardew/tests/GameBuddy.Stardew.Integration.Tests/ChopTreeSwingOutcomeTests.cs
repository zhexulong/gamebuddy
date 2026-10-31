using System;
using System.Text.RegularExpressions;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// One axe swing has two legal outcomes, and neither of them is a particular health value.
///
/// <para>
/// The engine facts, read from the decompiled source rather than assumed: `Axe.DoFunction` swings ONCE (Axe.cs:63-97) and
/// `Tree.performToolAction` subtracts `upgradeLevel switch { 0 => 1f, 1 => 1.25f, ... }` (Tree.cs:1177-1200), so a basic
/// axe takes a mature tree from 10 to 9. On the swing that reaches `<= 0` the engine sets `stump = true; health = 5f;
/// falling = true` and returns FALSE (Tree.cs:1489-1497), which is why the stump stays for `chop_stump` to target.
/// </para>
/// <para>
/// The predicate that shipped was `after == 5f && stumpAfter`: the second outcome only, spelled with the engine's own
/// felled-stump constant, so it read as if one swing had taken five points and felled the tree. Every chop of a live tree
/// reported `tree_source_chop_postcondition_unavailable` and settled `Uncertain`. It came from a fixture that stubbed
/// `health = 1f` so a single swing would fell it.
/// </para>
/// </summary>
public sealed class ChopTreeSwingOutcomeTests
{
    [Fact]
    public void ASwingThatMerelyDamagesALivingTreeIsSuccess()
    {
        // COMMENTS ARE STRIPPED, and this test's first green attempt is why: the assertion below looks for `after == 5f`,
        // and the comment explaining WHY that predicate was wrong quotes it. A gate its own prose can fail is the same
        // defect as one its prose can satisfy - this repository has now paid for that mistake four times.
        string body = WithoutComments(MethodBody(Source(), "private LocalExecutionReceipt ExecuteChopTreeSource("));

        // Both outcomes must be represented, and the felled one must not be pinned to the engine's stump constant.
        body.Should().Contain("felled", "a swing that fells the tree is the obvious success");
        body.Should().Contain("damaged", "and a swing that only removes health is the ordinary one: a mature tree needs ten");
        body.Should().NotContain(
            "after == 5f",
            "5f is the health the engine ASSIGNS to a felled stump, not the result of one swing");
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
            @"private static IReadOnlyList<BridgeTreeChopSourceTarget> DiscoverTreeChopSourceTargets\(Farmer player\)[\s\S]*?\n    \}",
            RegexOptions.None,
            TimeSpan.FromSeconds(2));
        discovery.Success.Should().BeTrue("the discovery family must be findable");
        discovery.Value.Should().Contain(
            "tree.health.Value > 0f",
            "health is durability: a standing tree is one with health above zero");
        discovery.Value.Should().NotContain(
            "tree.health.Value == 1f",
            "a tree one swing from falling is not the population, it is a fixture");
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
