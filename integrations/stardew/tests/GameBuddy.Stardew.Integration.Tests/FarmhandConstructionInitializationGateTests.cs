using System.Text.RegularExpressions;
using FluentAssertions;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A FARMHAND THIS MOD BUILDS IS HANDED TO THE ENGINE'S OWN INITIALIZATION, NOT TO A LIST OF FIELDS.
///
/// <para>
/// The defect this gate exists for: the Mod created the cabin's Farmhand with <c>Cabin.CreateFarmhand()</c> and then
/// wrote a hand-rolled profile onto it. <c>Cabin.CreateFarmhand</c> builds a bare <c>Farmer</c> and registers it in the
/// world state (<c>StardewValley.Locations/Cabin.cs:46-66</c>), and a bare <c>Farmer</c> is not an initialised player: the engine
/// runs <c>SaveGame.loadDataToFarmer</c> over EVERY Farmhand in a save on every load (<c>StardewValley/SaveGame.cs:867-870</c>, the
/// method at <c>StardewValley/SaveGame.cs:1325</c>) and that is what builds the renderer, applies the appearance through the Farmer's
/// own setters, pads the toolbox, converts clothing overrides and parks the player beside the bed. A runtime-created
/// Farmhand was the only Farmer in the game that had never been through it, and the world-drive stopped on
/// <c>farmhand_not_initialized</c>.
/// </para>
/// <para>
/// WHAT THIS PINS, AND WHY IT IS A GATE RATHER THAN A TEST. The population is DERIVED by scanning the Mod's own sources
/// for every place it constructs a Farmhand - <c>new Farmer(...)</c> or <c>CreateFarmhand()</c> - so a site added
/// tomorrow is examined without anyone remembering to add it here. The property is that an engine initialization call
/// follows the construction: in the same method, or in a method that method calls (the seam this repository uses so the
/// same initializer serves a created Farmhand and an existing one). A site that only writes fields is the shape that
/// shipped, and the failure names it.
/// </para>
/// <para>
/// WHAT IT CANNOT SEE. That <c>SaveGame.loadDataToFarmer</c> is the engine's only Farmer initialization, or what it
/// writes, is not re-derived here: the gate pins that our constructions go through it. Its body is the engine's, read
/// from the shipped assembly (<c>StardewValley/SaveGame.cs:1325-1368</c>). Nor can any headless test drive the
/// initialization it requires: that method builds a <c>FarmerRenderer</c> out of <c>Game1.content</c>, which a
/// process with no loaded content does not have. So the positive end-to-end binding path is <c>live: not measured</c>
/// here, and <c>HostFarmhandProvisioningInitializationTests</c> drives the halves a headless world can: the profile
/// seam the engine's customization writes, and the refusal when the initialization cannot run.
/// </para>
/// </summary>
[Trait("kind", "source-shape")]
public sealed class FarmhandConstructionInitializationGateTests
{
    /// <summary>
    /// The Mod's own source root: the authority the population is derived from. A directory scan rather than a list,
    /// because a list can only catch what its author remembered.
    /// </summary>
    private const string ModSourceRoot = "integrations/stardew";

    /// <summary>The directories under the Mod root that are not the Mod: test sources, build output, and the dev harness.</summary>
    private static readonly string[] NotTheMod = { "tests", "bin", "obj", "action-development" };

    /// <summary>
    /// A construction of a Farmhand: the engine's own factory on a cabin, or a Farmer built by hand. Kept to these two
    /// shapes because they are the two ways this Mod can bring a Farmhand into a save; a change that arrives by
    /// deserializing a save is the engine's work and not a construction this gate may claim.
    /// </summary>
    private static readonly Regex Construction = new(
        @"(?:\.\s*CreateFarmhand\s*\(\s*\)\s*;)|(?:\bnew\s+Farmer\s*\()",
        RegexOptions.Compiled);

    /// <summary>
    /// THE ENGINE'S INITIALIZATION CALL: <c>SaveGame.loadDataToFarmer</c>, the method the engine itself runs over every
    /// Farmhand in the save on every load. The gate names it once, here.
    /// </summary>
    private static readonly Regex EngineInitialization = new(@"\bSaveGame\s*\.\s*loadDataToFarmer\s*\(", RegexOptions.Compiled);

    /// <summary>An invocation of something in the same file, so the initializer can sit one hop away from the seam.</summary>
    private static readonly Regex Invocation = new(@"([A-Za-z_][A-Za-z0-9_]*)\s*\(", RegexOptions.Compiled);

    private static readonly string[] Declarations = { "public ", "private ", "protected ", "internal " };

    private readonly ITestOutputHelper output;

    public FarmhandConstructionInitializationGateTests(ITestOutputHelper output) => this.output = output;

    /// <summary>
    /// THE REAL TREE. Every Farmhand construction in the Mod is followed by the engine's own initialization, and the
    /// population is printed with its counts so a reading of zero cannot agree with itself.
    /// </summary>
    [Fact]
    public void EveryFarmhandTheModConstructs_GoesThroughTheEnginesInitialization()
    {
        GateResult result = Evaluate(ModSources());

        this.output.WriteLine(
            $"constructions examined {result.Examined.Count} · engine-initialized {result.EngineInitialized} · bare {result.Bare.Count}");
        foreach (string site in result.Examined)
            this.output.WriteLine($"  {site}");

        result.Blocked.Should().BeNull("a reading with no constructions in it agrees with itself and is not a pass");
        result.Bare.Should().BeEmpty(
            "a Farmhand this Mod constructs must be handed to the engine's own initialization"
                + $"{Environment.NewLine}{Environment.NewLine}"
                + string.Join(Environment.NewLine, result.Bare));
        result.Examined.Should().Contain(
            site => site.Contains("HostFarmhandProvisioner.cs", StringComparison.Ordinal)
                && site.Contains("PrepareTargetFarmhand", StringComparison.Ordinal),
            "the cabin's Farmhand is the construction this gate exists for and must be in the population");
    }

    /// <summary>
    /// THE FALSIFIER, TAKEN FROM THE SHAPE THAT SHIPPED: a cabin's Farmhand is created and then given a hand-rolled
    /// profile - name, display name, favourite thing, `isCustomized`, clothing - and the engine's initialization is never
    /// called. That is the tree this gate was written red against, and it must stay red.
    /// </summary>
    [Fact]
    public void AFarmhandConstructedAndGivenAHandRolledProfile_IsReportedByName()
    {
        string[] shipped =
        {
            "    private TargetFarmhand PrepareTargetFarmhand(Cabin cabin, string expectedFarmhandId)",
            "    {",
            "        cabin.CreateFarmhand();",
            "        Farmer? farmhand = cabin.owner;",
            "        this.InitializeFarmhandProfile(farmhand);",
            "        return new TargetFarmhand(farmhand, true, string.Empty);",
            "    }",
            "",
            "    private void InitializeFarmhandProfile(Farmer farmhand)",
            "    {",
            "        farmhand.Name = Utility.FilterDirtyWords(this.config.FarmhandName);",
            "        farmhand.displayName = farmhand.Name;",
            "        farmhand.isCustomized.Value = true;",
            "        farmhand.ConvertClothingOverrideToClothesItems();",
            "    }",
            "}",
        };

        GateResult result = Evaluate(new[] { ("integrations/stardew/HostFarmhandProvisioner.cs", shipped) });

        result.Examined.Should().HaveCount(1);
        result.EngineInitialized.Should().Be(0);
        result.Bare.Should().ContainSingle()
            .Which.Should().StartWith("farmhand_created_without_the_engines_initialization:")
            .And.Contain("integrations/stardew/HostFarmhandProvisioner.cs:3")
            .And.Contain("PrepareTargetFarmhand");
    }

    /// <summary>
    /// The other falsifier: the repair. The construction calls a seam in the same file, and the seam is the method that
    /// calls the engine's initialization. The gate must accept that shape, or it would forbid the fix it asks for.
    /// </summary>
    [Fact]
    public void AConstructionWhoseSeamCallsTheEnginesInitialization_IsAccepted()
    {
        string[] repaired =
        {
            "    private TargetFarmhand PrepareTargetFarmhand(Cabin cabin, string expectedFarmhandId)",
            "    {",
            "        cabin.CreateFarmhand();",
            "        Farmer? farmhand = cabin.owner;",
            "        this.InitializeFarmhandProfile(farmhand);",
            "        return new TargetFarmhand(farmhand, true, string.Empty);",
            "    }",
            "",
            "    private void InitializeFarmhandProfile(Farmer farmhand)",
            "    {",
            "        SaveGame.loadDataToFarmer(farmhand);",
            "        farmhand.isCustomized.Value = true;",
            "    }",
            "}",
        };

        GateResult result = Evaluate(new[] { ("integrations/stardew/HostFarmhandProvisioner.cs", repaired) });

        result.Examined.Should().HaveCount(1);
        result.Bare.Should().BeEmpty();
        result.EngineInitialized.Should().Be(1);
    }

    /// <summary>
    /// A construction whose enclosing method only TALKS about the engine's initialization - the prose that used to name
    /// <c>Cabin.CreateFarmhand()</c> in a log message and a doc comment - is still bare. A gate that reads prose reports
    /// a site that does not exist, and a gate that accepts prose accepts the defect.
    /// </summary>
    [Fact]
    public void AConstructionWhoseOnlyMentionOfTheInitializationIsProse_IsStillReported()
    {
        string[] prose =
        {
            "    private void PrepareTargetFarmhand(Cabin cabin)",
            "    {",
            "        cabin.CreateFarmhand();",
            "        // SaveGame.loadDataToFarmer would be the engine's own initialization here.",
            "        this.monitor.Log($\"GameBuddy failed to create a native Farmhand through Cabin.CreateFarmhand(): {exception}\");",
            "    }",
            "}",
        };

        GateResult result = Evaluate(new[] { ("integrations/stardew/HostFarmhandProvisioner.cs", prose) });

        result.Examined.Should().HaveCount(1, "the log line names the factory but does not call it");
        result.Bare.Should().ContainSingle();
    }

    [Fact]
    public void AZeroPopulation_IsBlockedRatherThanGreen()
    {
        GateResult result = Evaluate(new[]
        {
            ("integrations/stardew/HostFarmhandProvisioner.cs", new[] { "    private void Nothing(Cabin cabin)", "    {", "    }", "}" }),
        });

        result.Examined.Should().BeEmpty();
        result.Blocked.Should().NotBeNull().And.Contain("zero");
        result.Bare.Should().BeEmpty();
    }

    // ---- the gate itself -----------------------------------------------------

    /// <summary>What one evaluation found: the population it read, what is engine-initialized, and the bare sites.</summary>
    internal sealed record GateResult(IReadOnlyList<string> Examined, int EngineInitialized, IReadOnlyList<string> Bare, string? Blocked);

    /// <summary>
    /// The gate over an arbitrary corpus, so a synthetic case can turn it red on purpose and the real sources are
    /// evaluated by the same walk. Comments are stripped first: the Mod's prose NAMES <c>Cabin.CreateFarmhand()</c> in
    /// the log line beside the call, and a gate that reads prose reports sites that are not there.
    /// </summary>
    internal static GateResult Evaluate(IReadOnlyList<(string File, string[] Lines)> sources)
    {
        var examined = new List<string>();
        var bare = new List<string>();
        int engineInitialized = 0;

        foreach ((string file, string[] raw) in sources)
        {
            IReadOnlyList<string> lines = DecompiledSource.Code(raw);
            Dictionary<string, IReadOnlyList<string>> methods = Methods(lines);
            for (int index = 0; index < lines.Count; index++)
            {
                if (!Construction.IsMatch(lines[index]))
                    continue;

                (int start, int end) = Method(lines, index);
                string methodName = start < 0 ? "<outside any method>" : DecompiledSource.MethodName(lines[start]);
                string site = $"{file}:{index + 1}:{methodName}";
                examined.Add(site);

                if (start < 0)
                {
                    bare.Add($"farmhand_created_without_the_engines_initialization:{site} is outside any method this gate can read");
                    continue;
                }

                var body = new List<string>();
                for (int line = start; line <= end; line++)
                    body.Add(lines[line]);

                if (body.Any(line => EngineInitialization.IsMatch(line)))
                {
                    engineInitialized++;
                    continue;
                }

                // One hop: the seam this repository uses, so the same initializer serves a created Farmhand and an
                // existing one. The hop is printed with the site, so the next reader can see what was followed.
                string? via = body
                    .Where((line, offset) => start + offset > index && Invocation.IsMatch(line))
                    .SelectMany(line => Invocation.Matches(line).Select(match => match.Groups[1].Value))
                    .FirstOrDefault(name => methods.TryGetValue(name, out IReadOnlyList<string>? callee)
                        && callee.Any(line => EngineInitialization.IsMatch(line)));
                if (via is not null)
                {
                    engineInitialized++;
                    continue;
                }

                bare.Add(
                    $"farmhand_created_without_the_engines_initialization:{site} constructs a Farmhand and nothing in the method,"
                        + " nor in a method it calls, hands it to the engine's own initialization (`SaveGame.loadDataToFarmer`)");
            }
        }

        string? blocked = examined.Count == 0
            ? "zero Farmhand constructions were found; the corpus this gate reads is empty, so it has measured nothing"
            : null;
        return new GateResult(examined, engineInitialized, bare, blocked);
    }

    /// <summary>The Mod's own sources: every <c>.cs</c> under the Mod root minus the test, harness and build directories.</summary>
    private static IReadOnlyList<(string File, string[] Lines)> ModSources()
    {
        string root = RepositoryRoot();
        string mod = Path.Combine(root, ModSourceRoot);
        return Directory
            .EnumerateFiles(mod, "*.cs", SearchOption.AllDirectories)
            .Select(path => Path.GetRelativePath(root, path).Replace('\\', '/'))
            .Where(relative => !NotTheMod.Any(excluded => relative.Split('/').Contains(excluded)))
            .OrderBy(relative => relative, StringComparer.Ordinal)
            .Select(relative => (relative, File.ReadAllLines(Path.Combine(root, relative))))
            .ToArray();
    }

    /// <summary>
    /// One declaration per method, one brace per block: the same walk the other source-shape gates use, so two gates
    /// cannot disagree about which method contains a line.
    /// </summary>
    private static Dictionary<string, IReadOnlyList<string>> Methods(IReadOnlyList<string> lines)
    {
        var methods = new Dictionary<string, IReadOnlyList<string>>(StringComparer.Ordinal);
        for (int index = 0; index < lines.Count; index++)
        {
            (int start, int end) = Declared(lines, index);
            if (start < 0)
                continue;
            var body = new List<string>();
            for (int line = start; line <= end; line++)
                body.Add(lines[line]);
            methods.TryAdd(DecompiledSource.MethodName(lines[start]), body);
        }
        return methods;
    }

    /// <summary>The bounds of the method that encloses <paramref name="index"/>, or <c>(-1, -1)</c> at file level.</summary>
    private static (int Start, int End) Method(IReadOnlyList<string> lines, int index)
    {
        for (int candidate = index; candidate >= 0; candidate--)
        {
            (int start, int end) = Declared(lines, candidate);
            if (start >= 0 && end >= index)
                return (start, end);
        }
        return (-1, -1);
    }

    /// <summary>
    /// The method declared at <paramref name="index"/>: a one-line declaration ending in <c>)</c> that opens a brace
    /// block. <c>(-1, -1)</c> when the line is not a declaration.
    /// </summary>
    private static (int Start, int End) Declared(IReadOnlyList<string> lines, int index)
    {
        string text = lines[index].Trim();
        if (!text.EndsWith(")", StringComparison.Ordinal))
            return (-1, -1);
        if (!Declarations.Any(prefix => text.StartsWith(prefix, StringComparison.Ordinal)))
            return (-1, -1);

        int depth = 0;
        bool opened = false;
        for (int line = index; line < lines.Count; line++)
        {
            foreach (char character in lines[line])
            {
                if (character == '{')
                {
                    depth++;
                    opened = true;
                }
                else if (character == '}')
                {
                    depth--;
                }
            }

            if (opened && depth == 0)
                return opened && depth == 0 ? (index, line) : (-1, -1);
        }

        return (-1, -1);
    }

    private static string RepositoryRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null && !File.Exists(Path.Combine(directory.FullName, "AGENTS.md")))
            directory = directory.Parent;
        if (directory is null)
            throw new InvalidOperationException("repository root not found");
        return directory.FullName;
    }
}
