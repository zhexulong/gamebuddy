using System.Text.RegularExpressions;
using FluentAssertions;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A GUARD ON A GAME-OWNED ID ACCEPTS EVERY VALUE THE ENGINE CAN PRODUCE, OR IT NAMES THE ENGINE STATE IT REFUSES.
///
/// <para>
/// The defect this gate exists for: `HostFarmhandProvisioner.HandleRequest` refused a Farmhand whose
/// <c>UniqueMultiplayerID</c> was not positive, and the engine's own allocation is a SIGNED random 64-bit value.
/// <c>Cabin.CreateFarmhand</c> draws it with <c>Utility.RandomLong()</c> and loops only until the id is unused
/// (`StardewValley.Locations/Cabin.cs:52-59`); that generator reads eight random bytes and returns
/// <c>BitConverter.ToInt64</c> (`StardewValley/Utility.cs:7735-7742`), so half of its draws are negative. Nothing
/// reassigns a Farmhand's id afterwards - the multiplayer server publishes the id the Cabin already holds, and the
/// joining client adopts it - so a negative id is final, not pending. A `&lt;= 0` guard therefore refuses, at random, a
/// Farmhand the engine itself just created: the player confirms the cabin, the world changes, and the Host answers
/// `rejected`, which the App reports as `409 stardew_manifest_handoff_uncertain`. The companion cannot enter the farm.
/// </para>
/// <para>
/// WHAT THIS PINS. The population is DERIVED from the Mod's own sources: every comparison between an identifier that
/// names a game-owned id and a numeric constant. The property is the one the engine's contract supports: the ONLY value
/// that is not an id is zero - the value the provisioning protocol's own <c>TryParseNativeId</c> already refuses - so
/// <c>== 0</c> and <c>!= 0</c> are derived from the engine, and any other constant on an id (`&lt; 0`, `&lt;= 0`,
/// <c>&gt; 0</c>) is a predicate narrower than the engine's contract, i.e. narrowed by hand. It prints
/// `guards examined N · derived from the engine D · narrowed by hand H`, and H&gt;0 fails naming the guard.
/// </para>
/// <para>
/// WHAT IT CANNOT SEE. Whether a NEW engine contract replaces "zero is the only unusable id": the gate encodes the
/// contract this tree is pinned to (game 1.6.15) and names it in every failure, so a version that changes it turns this
/// gate red on the guard that has to change with it. A sentinel that leaves the population - the `long?` that tracks a
/// created Farmhand - is out of reach by construction, which is why the fix moves the sentinel out of the id space
/// instead of teaching the gate about it.
/// </para>
/// </summary>
[Trait("kind", "source-shape")]
public sealed class GameOwnedIdGuardGateTests
{
    /// <summary>The Mod's own source root: the authority the population is derived from.</summary>
    private const string ModSourceRoot = "integrations/stardew";

    /// <summary>The directories under the Mod root that are not the Mod.</summary>
    private static readonly string[] NotTheMod = { "tests", "bin", "obj", "action-development" };

    /// <summary>
    /// A game-owned id: the Farmhand's multiplayer id, the Cabin's owner id, and every field that HOLDS one. The
    /// identifier half is what makes this population survive a rename of the variable that carries the id - the suffix
    /// is the fact, not the name of the local.
    /// </summary>
    private static readonly Regex GameOwnedId = new(
        @"[A-Za-z0-9_]*(?:armhandId|UniqueMultiplayerID|OwnerId)\b",
        RegexOptions.Compiled);

    /// <summary>An identifier compared against a numeric constant, which is the only shape this gate judges.</summary>
    private static readonly Regex Comparison = new(
        @"([A-Za-z0-9_.]*(?:armhandId|UniqueMultiplayerID|OwnerId)\b)\s*(<=|>=|==|!=|<|>)\s*(-?[0-9]+)\b",
        RegexOptions.Compiled);

    private readonly ITestOutputHelper output;

    public GameOwnedIdGuardGateTests(ITestOutputHelper output) => this.output = output;

    /// <summary>
    /// THE REAL TREE. No guard narrows the engine's id space by hand, and the population is printed with its counts so a
    /// reading of zero cannot agree with itself.
    /// </summary>
    [Fact]
    public void NoGuardNarrowsAGameOwnedIdByHand()
    {
        GateResult result = Evaluate(ModSources());

        this.output.WriteLine(
            $"guards examined {result.Examined.Count} · derived from the engine {result.Derived} · narrowed by hand {result.Narrowed.Count}");
        foreach (string site in result.Examined)
            this.output.WriteLine($"  {site}");

        result.Blocked.Should().BeNull("a reading with no id guards in it agrees with itself and is not a pass");
        result.Narrowed.Should().BeEmpty(
            "a guard on a game-owned id must accept every value the engine produces, or name the engine state it refuses"
                + $"{Environment.NewLine}{Environment.NewLine}"
                + string.Join(Environment.NewLine, result.Narrowed));
        result.Examined.Should().Contain(
            site => site.Contains("HostFarmhandProvisioner.cs", StringComparison.Ordinal)
                && site.Contains("UniqueMultiplayerID", StringComparison.Ordinal),
            "the binding's guard on the Farmhand's own id is the site this gate exists for and must be in the population");
    }

    /// <summary>
    /// THE FALSIFIER, TAKEN FROM THE SHAPE THAT SHIPPED: the Farmhand's id is required to be positive. `Cabin.CreateFarmhand`
    /// draws it with `Utility.RandomLong`, so this refuses a Farmhand the engine just created, and the finding must say so.
    /// </summary>
    [Fact]
    public void AGuardThatRejectsANegativeEngineId_IsReportedByName()
    {
        string[] shipped =
        {
            "        string expectedName = Utility.FilterDirtyWords(this.config.FarmhandName);",
            "        if (farmhand.UniqueMultiplayerID <= 0 || farmhand.Name != expectedName)",
            "        {",
            "            return new(\"rejected\", \"farmhand_profile_mismatch\");",
            "        }",
        };

        GateResult result = Evaluate(new[] { ("integrations/stardew/HostFarmhandProvisioner.cs", shipped) });

        result.Examined.Should().HaveCount(1);
        result.Derived.Should().Be(0);
        result.Narrowed.Should().ContainSingle()
            .Which.Should().StartWith("guard_rejects_a_state_the_engine_creates:")
            .And.Contain("integrations/stardew/HostFarmhandProvisioner.cs:2")
            .And.Contain("farmhand.UniqueMultiplayerID <= 0")
            .And.Contain("Cabin.CreateFarmhand")
            .And.Contain("Utility.RandomLong");
    }

    /// <summary>
    /// The other falsifier: a sentinel field that HOLDS a game id is judged the same way, because a sentinel outside the
    /// id space is exactly what the defect class is made of - here, a created Farmhand whose id is negative would never
    /// be rolled back.
    /// </summary>
    [Fact]
    public void ASentinelGuardOnAFieldThatHoldsAGameId_IsReported()
    {
        string[] shipped = { "        if (this.pendingCreatedCabin is null || this.pendingCreatedFarmhandId <= 0)", "        {", "            return;", "        }" };

        GateResult result = Evaluate(new[] { ("integrations/stardew/HostFarmhandProvisioner.cs", shipped) });

        result.Narrowed.Should().ContainSingle().Which.Should().Contain("pendingCreatedFarmhandId <= 0");
    }

    /// <summary>
    /// The repair, and the shape the gate must accept: the one value the protocol cannot name is zero.
    /// </summary>
    [Fact]
    public void AZeroOnlyGuard_IsDerivedFromTheEngine()
    {
        string[] repaired =
        {
            "        if (farmhand.UniqueMultiplayerID == 0)",
            "        {",
            "            return new(\"rejected\", \"farmhand_id_unassigned\");",
            "        }",
            "        if (farmhandId == 0)",
            "        {",
            "            throw new InvalidOperationException(\"fixture_farmhand_id_invalid\");",
            "        }",
        };

        GateResult result = Evaluate(new[] { ("integrations/stardew/HostFarmhandProvisioner.cs", repaired) });

        result.Examined.Should().HaveCount(2);
        result.Narrowed.Should().BeEmpty();
        result.Derived.Should().Be(2);
    }

    /// <summary>
    /// A comparison against another id - two ids that must be equal - is not a guard on the id space and must not be
    /// counted, or the population would report sites the gate has no opinion about.
    /// </summary>
    [Fact]
    public void AComparisonBetweenTwoIds_IsNotInThePopulation()
    {
        string[] equality = { "        if (cabin.OwnerId != farmhand.UniqueMultiplayerID)", "        if (this.pendingCreatedFarmhandId == farmhand.UniqueMultiplayerID)" };

        GateResult result = Evaluate(new[] { ("integrations/stardew/HostFarmhandProvisioner.cs", equality) });

        result.Examined.Should().BeEmpty();
        result.Blocked.Should().NotBeNull().And.Contain("zero");
    }

    [Fact]
    public void AZeroPopulation_IsBlockedRatherThanGreen()
    {
        string[] notAGuard = { "        if (Game1.locations.Count == 0)", "            return;", "        }" };

        GateResult result = Evaluate(new[] { ("integrations/stardew/HostFarmhandProvisioner.cs", notAGuard) });

        result.Examined.Should().BeEmpty();
        result.Blocked.Should().NotBeNull().And.Contain("zero");
    }

    // ---- the gate itself -----------------------------------------------------

    /// <summary>What one evaluation found: the population, how much of it comes from the engine, and the hand-narrowed set.</summary>
    internal sealed record GateResult(IReadOnlyList<string> Examined, int Derived, IReadOnlyList<string> Narrowed, string? Blocked);

    /// <summary>
    /// The gate over an arbitrary corpus, so a synthetic case can turn it red on purpose and the real sources are
    /// evaluated by the same walk. Comments are stripped first: this repository's prose names ids and constants beside
    /// the guards, and a gate that reads prose reports sites that are not there.
    /// </summary>
    internal static GateResult Evaluate(IReadOnlyList<(string File, string[] Lines)> sources)
    {
        var examined = new List<string>();
        var narrowed = new List<string>();
        int derived = 0;

        foreach ((string file, string[] raw) in sources)
        {
            IReadOnlyList<string> lines = DecompiledSource.Code(raw);
            for (int index = 0; index < lines.Count; index++)
            {
                Match match = Comparison.Match(lines[index]);
                if (!match.Success)
                    continue;

                string identifier = match.Groups[1].Value;
                string comparison = match.Groups[2].Value;
                string constant = match.Groups[3].Value;
                string site = $"{file}:{index + 1}:{match.Value}";
                examined.Add(site);

                // Zero is the ONE value the engine cannot produce as an id and the ONE value the provisioning protocol
                // already refuses (`FarmhandProvisioningProtocol.TryParseNativeId`). Equality against it is read off the
                // contract. Every other constant is a range this Mod invented.
                if (constant == "0" && comparison is "==" or "!=")
                {
                    derived++;
                    continue;
                }

                narrowed.Add(
                    $"guard_rejects_a_state_the_engine_creates:{site} compares `{identifier}` against `{constant}`, but the"
                        + " engine allocates that id with `Cabin.CreateFarmhand` -> `Utility.RandomLong`"
                        + " (`StardewValley.Locations/Cabin.cs:52-59`, `StardewValley/Utility.cs:7735-7742`), a signed 64-bit"
                        + " draw that is negative for half of all values and is never reassigned afterwards: the guard refuses a"
                        + " Farmhand the engine itself just created, after the player already confirmed the cabin");
            }
        }

        string? blocked = examined.Count == 0
            ? "zero game-owned id guards were found; the corpus this gate reads is empty, so it has measured nothing"
            : null;
        return new GateResult(examined, derived, narrowed, blocked);
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
