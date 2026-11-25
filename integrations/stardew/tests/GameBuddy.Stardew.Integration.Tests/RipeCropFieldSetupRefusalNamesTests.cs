using System.Text.RegularExpressions;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// THE RIPE-CROP SETUP IS ONE HELPER AND FIVE NAMES. Every Given that needs a ripe crop shares
/// <c>GrowRipeCropFieldOnTheFarm</c> - the target-version till/sow/grow commands plus the cleanup that takes back the
/// paving the spread laid - and the refusal it throws is the CALLER's, because each arm-time line has to say which
/// scenario's Given went missing.
///
/// <para>
/// THE DEFECT THIS PINS is the shape the fold could take while still looking finished: a helper that hardcodes one of
/// the five codes, so five distinct fixture failures arrive as one reading nobody can attribute, or a call site that
/// keeps the seed and drops the name and inherits a neighbour's.
/// </para>
///
/// <para>
/// <c>// source-invariant:</c> the refusal a fixture throws is a string literal handed to the one shared helper as its
/// last argument. The throw sits inside a branch on the engine's own <c>parseDebugInput</c>, so no IL-visible fact says
/// which literal belongs to which fixture and the call site is the only reading that can.
/// <c>// source-expiry:</c> none - the property is per call site and must hold for every initializer a future row
/// registers, not for these five only.
/// </para>
/// </summary>
public sealed class RipeCropFieldSetupRefusalNamesTests
{
    private const string RepositoryRelativeRoot = "../../../../../../../";
    private const string SetupDeclaration = "private void GrowRipeCropFieldOnTheFarm(";

    private static readonly Regex SetupCalls = new(@"this\.GrowRipeCropFieldOnTheFarm\((?<args>[^()]*)\)", RegexOptions.Compiled);

    private static IReadOnlyList<string> FixtureSourcePaths() =>
        Directory.GetFiles(
                Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, RepositoryRelativeRoot, "integrations", "stardew")),
                "ModEntry.Fixtures*.cs")
            .OrderBy(path => path, StringComparer.Ordinal)
            .ToArray();

    private static string ReadFixtureSource() => string.Join("\n", FixtureSourcePaths().Select(File.ReadAllText));

    /// <summary>One method's body, by brace balance: the declarations this reads are unique across the partials.</summary>
    private static string Body(string source, string declaration)
    {
        int start = source.IndexOf(declaration, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, $"{declaration}... is one of the fixture partials' own declarations");
        int open = source.IndexOf('{', start);
        int depth = 0;
        for (int i = open; i < source.Length; i++)
        {
            if (source[i] == '{')
                depth++;
            else if (source[i] == '}')
            {
                depth--;
                if (depth == 0)
                    return source[start..(i + 1)];
            }
        }
        throw new InvalidOperationException($"unbalanced body: {declaration}");
    }

    /// <summary>The setup facts one call declares, read off the call rather than off a formatting-sensitive line.</summary>
    private static (string SeedItemId, int GrowthDays, string RefusalCode) SetupOf(string body)
    {
        MatchCollection calls = SetupCalls.Matches(body);
        calls.Should().ContainSingle("each fixture establishes its ripe crop exactly once");
        string[] arguments = calls[0].Groups["args"].Value
            .Split(',')
            .Select(argument => argument.Trim())
            .ToArray();
        arguments.Should().HaveCount(4, "the call names the farm, the seed, the growth window and its own refusal");
        arguments[0].Should().Be("farm", "the only world a fixture grows a crop in is the one the Given declares");
        arguments[1].Should().MatchRegex(@"^""\d+""$", "the seed is the unqualified item id the debug command takes");
        int.TryParse(arguments[2], out int growthDays)
            .Should().BeTrue($"`{arguments[2]}` has to be the engine's own growth window in days");
        arguments[3].Should().MatchRegex(@"^""fixture_\w+""$", "a refusal is a fixture code, not prose");
        return (arguments[1].Trim('"'), growthDays, arguments[3].Trim('"'));
    }

    [Fact]
    public void EveryCallToTheSharedSetupIsHandedANameNoOtherCallUses()
    {
        string source = ReadFixtureSource();
        var setups = SetupCalls.Matches(source).Select(match => match.Groups["args"].Value).ToList();
        setups.Should().HaveCountGreaterThanOrEqualTo(5, "the fold this pins was made across five fixtures");
        var codes = setups.Select(arguments => arguments.Split(',').Select(argument => argument.Trim()).Last()).ToList();
        codes.Should().OnlyHaveUniqueItems(
            "two fixtures under one setup code is the fold reported as five and observed as one - a reader who sees it in "
                + "a launch log cannot tell which Given was missing");
    }

    [Theory]
    [InlineData("private void InitializeNativeLocalHarvestCropFixture(", "472", 6,
        "fixture_native_local_harvest_crop_setup_unavailable")]
    [InlineData("private void InitializeNativeLocalPairedCompanionFixture(", "472", 6,
        "fixture_native_paired_companion_setup_unavailable")]
    [InlineData("private void InitializeNativeLocalHarvestCropInventoryFullRecoveryFixture(", "472", 6,
        "fixture_native_local_harvest_full_bag_setup_unavailable")]
    [InlineData("private void InitializeNativeLocalJodiHarvestDeliverFixture(", "474", 12,
        "fixture_native_local_jodi_harvest_setup_unavailable")]
    [InlineData("private void InitializeNativeLocalStrawberryCovenantFixture(", "745", 8,
        "fixture_native_local_strawberry_covenant_setup_unavailable")]
    public void EachFixtureKeepsTheSeedAndTheRefusalNameItsGivenDeclares(
        string declaration,
        string seedItemId,
        int growthDays,
        string refusalCode)
    {
        SetupOf(Body(ReadFixtureSource(), declaration)).Should().Be(
            (seedItemId, growthDays, refusalCode),
            "the shared helper has to be handed THIS fixture's seed, growth window and name: a neighbour's cauliflower "
                + "window or a neighbour's code would make the arm-time line answer for a Given that is not this one");
    }

    [Fact]
    public void TheSetupHelperThrowsTheNameItWasHanded()
    {
        string helper = Body(ReadFixtureSource(), SetupDeclaration);

        helper.Should().Contain(
            "throw new InvalidOperationException(setupRefusalCode);",
            "the helper's whole attribution is the code it receives");
        helper.Should().NotContain(
            "\"fixture_",
            "a name written inside the helper would replace five attributions with one, which is the folding defect this "
                + "test exists for");

        string[] recipe =
        [
            "parseDebugInput(\"RemoveDirt\"",
            "parseDebugInput(\"SpreadDirt\"",
            "parseDebugInput($\"SpreadSeeds {seedItemId}\"",
            "parseDebugInput($\"GrowCrops {growthDays}\"",
            "FixtureGround.ClearPavedDirt(farm)",
        ];
        int cursor = 0;
        foreach (string step in recipe)
        {
            int at = helper.IndexOf(step, cursor, StringComparison.Ordinal);
            at.Should().BeGreaterThanOrEqualTo(
                cursor,
                $"`{step}` has to follow the step before it: the dirt is cleared before it is spread, the seed before it is "
                    + "grown, and the paving after the spread that laid it");
            cursor = at + step.Length;
        }
    }
}
