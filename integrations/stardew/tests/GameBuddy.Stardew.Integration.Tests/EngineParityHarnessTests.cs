using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using FluentAssertions;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The gate over <see cref="EngineParityRegistry"/>: every derivation of ours that the engine also computes, compared with
/// the engine, in one run.
///
/// <para>
/// THE THREE QUESTIONS THIS FILE ANSWERS, AND HOW. (1) Does the table run and print its population? The first test prints
/// <c>entries · compared · sampled · not_measured · disagreements · excluded · candidates · undeclared</c> before the
/// verdict, so "nothing disagreed" can never be mistaken for "nothing was compared". (2) Does it catch the defect we
/// already know about? The injection test drives the chance entry against two scratch copies of the SHIPPED reader - one
/// with the flag computed once outside the row loop, one with the engine's per-row comparison - and asserts the exact
/// disagreement codes and both numbers, then that the product file is byte-identical. (3) Does it catch what we have not
/// found? That answer is whatever the scan and the four entries produce in the first test: a disagreement names itself, and
/// a candidate nobody declared names its file and line.
/// </para>
///
/// <para>
/// WHY A SCRATCH COPY AND NOT THE PRODUCT FILE. The reader is being repaired in another lane while this runs, so the
/// injection must not touch it: both directions are built from the bytes on disk into <c>.tmp/engine-parity-injection</c>,
/// and the file's bytes are asserted unchanged at the end. The entry is the same entry - only the path under it moves.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the injection tests read the shipped reader's text to build two scratch copies of it, while the other tests drive real engine members (GetChance, tilesAffected, the direction tables) and real product tables, so this one file legitimately holds both a text-derived fixture and engine behaviour.
public sealed class EngineParityHarnessTests
{
    private readonly ITestOutputHelper output;

    public EngineParityHarnessTests(ITestOutputHelper output) => this.output = output;

    /// <summary>
    /// THE GATE. Every registered entry against the engine, plus every candidate the scan found, in one run.
    ///
    /// A finding here is any of: a compared case that disagreed (the engine is the oracle), an entry that could not
    /// measure its declared input space, a sampled entry that named no seed contract, a scan finding nobody declared, or a
    /// run that compared nothing at all.
    /// </summary>
    [Fact]
    public void EveryRegisteredDerivationAgreesWithTheEngine()
    {
        ParityReport report = EngineParityRegistry.Run();

        this.Print(report);

        report.Entries.Should().BeGreaterThan(0, "the table is the deliverable, and an empty one agrees with itself");
        report.Compared.Should().BeGreaterThan(0, $"{EngineParity.PopulationEmpty}: a run that compared nothing is blocked, not green");
        report.Candidates.Should().BeGreaterThan(0, "the candidate scan must find the tables this tree holds, or it is looking at nothing");
        report.Findings.Should().BeEmpty("each finding is a disagreement, an unmeasured entry, or an undeclared candidate, and names itself");
    }

    /// <summary>
    /// UNIT 2: the harness catches today's defect, and the SAME entry passes once the argument is the engine's.
    ///
    /// <para>
    /// The two numbers are the point. With no specific bait the shipped flag is TRUE for every row, so a row that declares
    /// its own specific-bait boost is handed a boost no bait gave it: ours is the larger number. With a specific bait
    /// naming a species the shipped flag is FALSE for every row, so the named row LOSES its own boost: ours is the smaller
    /// number. Both directions come from one expression, which is why a fixture of unboosted rows would have missed it.
    /// </para>
    /// </summary>
    [Fact]
    public void TheHarnessRedsOnTheFlagComputedOnceAndGreensOnTheRowComparison()
    {
        string reader = Path.Combine(
            EngineParityCandidateScan.RepositoryRoot(),
            EngineParityRegistry.ReaderPath.Replace('/', Path.DirectorySeparatorChar));
        byte[] before = File.ReadAllBytes(reader);
        string shipped = File.ReadAllText(reader);

        string directory = Path.Combine(EngineParityCandidateScan.RepositoryRoot(), ".tmp", "engine-parity-injection");
        Directory.CreateDirectory(directory);
        try
        {
            // The shipped shape: the flag computed once, outside the row loop, from "no species is named".
            string onceSource = ReplaceFifthArgument(shipped, "usingTargetBait")
                + Environment.NewLine
                + "// scratch only: the declaration the shipped expression had, written where the decoder reads it."
                + Environment.NewLine
                + "bool usingTargetBait = magicBait == false && string.Equals(TargetBaitSpecies(player), string.Empty, StringComparison.Ordinal);"
                + Environment.NewLine;
            string oncePath = Path.Combine(directory, "FishingCatchableQuery.once-outside.cs");
            File.WriteAllText(oncePath, onceSource);

            // The engine's shape: this row IS the species the bait names.
            string rowComparisonPath = Path.Combine(directory, "FishingCatchableQuery.row-comparison.cs");
            File.WriteAllText(rowComparisonPath, ReplaceFifthArgument(shipped, "row.ItemId == targetedSpecies"));

            ParityReport red = EngineParity.Run(
                new[] { EngineParityRegistry.ChanceForEveryRow(oncePath) },
                Array.Empty<ParityCandidate>(),
                new Dictionary<string, string>(StringComparer.Ordinal));
            ParityReport green = EngineParity.Run(
                new[] { EngineParityRegistry.ChanceForEveryRow(rowComparisonPath) },
                Array.Empty<ParityCandidate>(),
                new Dictionary<string, string>(StringComparer.Ordinal));

            this.output.WriteLine("shipped shape: " + red.Population());
            foreach (string finding in red.Findings) this.output.WriteLine("  " + finding);
            this.output.WriteLine("engine's shape: " + green.Population());
            foreach (string finding in green.Findings) this.output.WriteLine("  " + finding);

            red.Compared.Should().Be(6, "two rows times three bait states, and every one of them is visited");
            red.Disagreements.Should().Be(
                3,
                "both rows disagree without a bait and the named row disagrees with one, because each of those rows declares a boost");

            // (b) no specific bait: ours boosts a row no bait names, so ours is LARGER than the engine's.
            string unnamed = red.Findings.Single(finding => finding.Contains("(O)163@no_bait", StringComparison.Ordinal));
            unnamed.Should().Contain("engine_parity_disagrees:", "the finding is the code, the input, and both numbers");
            (float ours, float engine) = Numbers(unnamed);
            ours.Should().BeGreaterThan(engine, $"no bait names this row, so the engine must not boost it: {unnamed}");

            // (a) a specific bait naming a species: ours drops the named row's own boost, so ours is SMALLER.
            string named = red.Findings.Single(finding =>
                finding.Contains("specific_bait_(O)128", StringComparison.Ordinal)
                && finding.Contains("(O)128@", StringComparison.Ordinal));
            (float namedOurs, float namedEngine) = Numbers(named);
            namedOurs.Should().BeLessThan(
                namedEngine,
                $"the bait names this row, so the engine boosts it and the shipped flag did not: {named}");

            this.output.WriteLine($"no bait: ours {F(ours)} vs engine {F(engine)}; named row: ours {F(namedOurs)} vs engine {F(namedEngine)}");

            green.Compared.Should().Be(6);
            green.Disagreements.Should().Be(0, "with the engine's own per-row comparison the two sides are the same number");
            green.Findings.Should().BeEmpty("a green entry is the revert proof for the red one");
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }

        File.ReadAllBytes(reader).Should().Equal(before, "the product source is read, never written: the injection lives in .tmp/");
    }

    /// <summary>
    /// A falsifier for the `not_measured` rule: an argument shape the harness does not understand fails the run instead of
    /// quietly comparing nothing. Synthetic on purpose - the shape has to be one the product does not have today.
    /// </summary>
    [Fact]
    public void AnArgumentShapeTheHarnessCannotReadFailsTheRun()
    {
        string directory = Path.Combine(EngineParityCandidateScan.RepositoryRoot(), ".tmp", "engine-parity-injection");
        Directory.CreateDirectory(directory);
        string path = Path.Combine(directory, "FishingCatchableQuery.unreadable.cs");
        try
        {
            File.WriteAllText(
                path,
                "class Probe { void M() { float c = row.GetChance(a, b, d, e, someFlagWeCannotRead); } }");

            ParityReport report = EngineParity.Run(
                new[] { EngineParityRegistry.ChanceForEveryRow(path) },
                Array.Empty<ParityCandidate>(),
                new Dictionary<string, string>(StringComparer.Ordinal));

            this.Print(report);
            report.NotMeasured.Should().Be(1);
            report.Findings.Should().Contain(finding => finding.Contains("engine_parity_not_measured:", StringComparison.Ordinal));
            report.Findings.Should().Contain(finding => finding.Contains("unrecognised_fifth_argument:", StringComparison.Ordinal));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    /// <summary>
    /// A falsifier for the sampling rule: a `sampled` entry without a seed contract is a finding, because "we looked at
    /// some of it" is only honest when the same "some" can be produced again.
    /// </summary>
    [Fact]
    public void ASampledEntryWithNoSeedContractFailsTheRun()
    {
        var sampled = new ParityEntry(
            "Synthetic.Engine.Member (Synthetic.cs:1)",
            "a synthetic derivation",
            "a synthetic input space",
            "exact",
            () => new ParityOutcome(new[] { new ParityCase("one", "1", "1") }),
            ParityMode.Sampled);

        ParityReport report = EngineParity.Run(
            new[] { sampled },
            Array.Empty<ParityCandidate>(),
            new Dictionary<string, string>(StringComparer.Ordinal));

        this.Print(report);
        report.Sampled.Should().Be(1);
        report.Findings.Should().Contain(finding =>
            finding.StartsWith(EngineParity.SampledWithoutSeed, StringComparison.Ordinal));
    }

    /// <summary>
    /// A falsifier for the declaration rule: a candidate the registry does not answer for is named by file and line, so a
    /// new table cannot arrive undeclared and pass as measured.
    /// </summary>
    [Fact]
    public void ATableNobodyDeclaredIsNamedByTheRun()
    {
        var undeclared = new ParityCandidate(
            "integrations/stardew/src/Core/SomeTable.cs",
            42,
            "literal_table:integrations/stardew/src/Core/SomeTable.cs:AChargeLadder",
            "int[] AChargeLadder");

        ParityReport report = EngineParity.Run(
            Array.Empty<ParityEntry>(),
            new[] { undeclared },
            new Dictionary<string, string>(StringComparer.Ordinal));

        this.Print(report);
        report.Undeclared.Should().Be(1);
        report.Findings.Should().Contain(
            "rederivation_undeclared:integrations/stardew/src/Core/SomeTable.cs:42:literal_table:integrations/stardew/src/Core/SomeTable.cs:AChargeLadder:int[] AChargeLadder");
    }

    /// <summary>A falsifier for the population rule: an empty table must fail, not agree with itself.</summary>
    [Fact]
    public void AnEmptyTableFailsTheRun()
    {
        ParityReport report = EngineParity.Run(
            Array.Empty<ParityEntry>(),
            Array.Empty<ParityCandidate>(),
            new Dictionary<string, string>(StringComparer.Ordinal));

        this.Print(report);
        report.Findings.Should().Contain(finding => finding.StartsWith(EngineParity.PopulationEmpty, StringComparison.Ordinal));
    }

    // ---- helpers ---------------------------------------------------------------------------------------------

    private void Print(ParityReport report)
    {
        this.output.WriteLine(report.Population());
        foreach (string line in report.Log) this.output.WriteLine("  " + line);
        foreach (string finding in report.Findings.Where(finding => !finding.Contains("Verdict", StringComparison.Ordinal)))
            this.output.WriteLine("  FINDING " + finding);
    }

    /// <summary>The two numbers at the end of a disagreement code, which is where the harness puts them.</summary>
    private static (float Ours, float Engine) Numbers(string finding)
    {
        Match match = Regex.Match(finding, @":(?<ours>-?\d+(?:\.\d+)?):(?<engine>-?\d+(?:\.\d+)?)$", RegexOptions.CultureInvariant);
        match.Success.Should().BeTrue($"a disagreement carries both values at its end: {finding}");
        return (
            float.Parse(match.Groups["ours"].Value, CultureInfo.InvariantCulture),
            float.Parse(match.Groups["engine"].Value, CultureInfo.InvariantCulture));
    }

    /// <summary>
    /// The same fifth argument, replaced: the property the injection test actually needs. The scan runs over the source
    /// with its comments blanked OUT and at the SAME length, so the offsets found there are the offsets of the real text.
    /// </summary>
    private static string ReplaceFifthArgument(string source, string replacement)
    {
        string scanned = EngineParityCandidateScan.StripComments(source);
        int call = scanned.IndexOf("GetChance(", StringComparison.Ordinal);
        call.Should().BeGreaterThanOrEqualTo(0, "the shipped reader must still call GetChance");

        int depth = 0;
        int fifthStart = -1;
        int argument = 0;
        int start = call + "GetChance(".Length;
        for (int index = start; index < scanned.Length; index++)
        {
            char character = scanned[index];
            if (character == '(')
            {
                depth++;
            }
            else if (character == ')' && depth == 0)
            {
                fifthStart = fifthStart < 0 ? start : fifthStart;
                return string.Concat(source.AsSpan(0, fifthStart), replacement, source.AsSpan(index));
            }
            else if (character == ')')
            {
                depth--;
            }
            else if (character == ',' && depth == 0)
            {
                if (++argument == 4) fifthStart = index + 1;
                start = index + 1;
            }
        }

        throw new InvalidOperationException("the GetChance call has no closing parenthesis");
    }

    private static string F(float value) => value.ToString("0.####", CultureInfo.InvariantCulture);
}
