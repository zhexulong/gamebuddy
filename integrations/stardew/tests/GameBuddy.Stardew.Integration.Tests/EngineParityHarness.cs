using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Which of an entry's inputs the harness actually visits.
///
/// <para>
/// `Exact` means the input space is FINITE and enumerated, so every member of it was compared. `Sampled` means the run
/// visited a declared subset - either because the space is not enumerable at all or because the engine member spends
/// randomness - and the entry must therefore name the seed contract that makes the subset reproducible. A `Sampled`
/// entry with no seed contract is a finding, not a mode: "we looked at some of it" is only honest when the reader can
/// reproduce the same "some".
/// </para>
/// </summary>
internal enum ParityMode
{
    Exact,
    Sampled,
}

/// <summary>One input the harness visited: what it was, what our derivation answered, what the engine answered.</summary>
internal sealed record ParityCase(string Input, string Ours, string Engine);

/// <summary>
/// What one entry produced: the cases it compared, or the reason it could not measure anything.
///
/// <para>
/// `NotMeasured` is not an empty result. An entry that declares an input space and then cannot visit it has proved
/// nothing, so the harness reports `engine_parity_not_measured` and fails; only an entry that was never expected to be
/// measurable (a tautology, a path the engine answers by measurement) is excluded, and that exclusion is declared in the
/// registry with its reason before the run.
/// </para>
/// </summary>
internal sealed record ParityOutcome
{
    internal ParityOutcome(IReadOnlyList<ParityCase> cases) => this.Cases = cases;

    internal IReadOnlyList<ParityCase> Cases { get; }

    internal string? NotMeasured { get; init; }

    internal static ParityOutcome Unmeasured(string reason) =>
        new(Array.Empty<ParityCase>()) { NotMeasured = reason };
}

/// <summary>
/// ONE ROW OF THE PARITY TABLE: an engine member, the derivation of ours that must agree with it, the input space, and
/// the predicate that decides agreement.
///
/// <para>
/// THE FIELDS ARE THE CONTRACT. `EngineMember` carries the decompiled file and line as well as the type and member,
/// because a citation without a location cannot be checked against a game update; `OurDerivation` names the function
/// under test rather than describing it, so the entry can be read as "this, against that"; `InputSpace` says HOW the
/// inputs were enumerated and from which engine declaration, because an input space someone chose by hand is a sample
/// wearing an exact test's clothes.
/// </para>
/// </summary>
internal sealed class ParityEntry
{
    internal ParityEntry(
        string engineMember,
        string ourDerivation,
        string inputSpace,
        string equality,
        Func<ParityOutcome> compare,
        ParityMode mode = ParityMode.Exact,
        string? seedContract = null)
    {
        this.EngineMember = engineMember;
        this.OurDerivation = ourDerivation;
        this.InputSpace = inputSpace;
        this.Equality = equality;
        this.Compare = compare;
        this.Mode = mode;
        this.SeedContract = seedContract ?? string.Empty;
    }

    /// <summary>`Type.Member (file:line)` - the engine's own declaration, and where a reader can check it.</summary>
    internal string EngineMember { get; }

    internal string OurDerivation { get; }

    internal string InputSpace { get; }

    internal string Equality { get; }

    internal ParityMode Mode { get; }

    internal string SeedContract { get; }

    internal Func<ParityOutcome> Compare { get; }
}

/// <summary>
/// A place our production sources hold a second spelling of an engine fact, found by the scan rather than written here.
///
/// <para>
/// `Key` is the declaration identity the registry answers for (`literal_table:file:line`, `hoisted_engine_argument:…`), so
/// an exemption is bound to the thing it exempts. An exemption keyed by position alone would follow the wrong line when
/// the file moved, which is the comparison-identity defect this repository has already paid for twice.
/// </para>
/// </summary>
internal sealed record ParityCandidate(string File, int Line, string Key, string Evidence);

/// <summary>What a run of the whole table found, in the shape a caller asserts on and a reader reads.</summary>
internal sealed class ParityReport
{
    internal ParityReport(
        IReadOnlyList<string> findings,
        IReadOnlyList<string> log,
        int entries,
        int compared,
        int sampled,
        int notMeasured,
        int disagreements,
        int exclusions,
        int candidates,
        int undeclared)
    {
        this.Findings = findings;
        this.Log = log;
        this.Entries = entries;
        this.Compared = compared;
        this.Sampled = sampled;
        this.NotMeasured = notMeasured;
        this.Disagreements = disagreements;
        this.Exclusions = exclusions;
        this.Candidates = candidates;
        this.Undeclared = undeclared;
    }

    internal IReadOnlyList<string> Findings { get; }

    internal IReadOnlyList<string> Log { get; }

    internal int Entries { get; }

    internal int Compared { get; }

    internal int Sampled { get; }

    internal int NotMeasured { get; }

    internal int Disagreements { get; }

    internal int Exclusions { get; }

    internal int Candidates { get; }

    internal int Undeclared { get; }

    /// <summary>
    /// The population line, printed before the verdict: a count of zero compared cases is a blocked reading, not a pass,
    /// and a reader has to be able to see which of the two they are looking at.
    /// </summary>
    internal string Population() => string.Create(
        CultureInfo.InvariantCulture,
        $"entries {this.Entries} · compared {this.Compared} · sampled {this.Sampled} · not_measured {this.NotMeasured} · disagreements {this.Disagreements} · excluded {this.Exclusions} · candidates {this.Candidates} · undeclared {this.Undeclared}");
}

/// <summary>
/// The engine-as-oracle runner: every entry compared, every candidate either declared or named.
///
/// <para>
/// WHY THIS EXISTS RATHER THAN A TEST PER FACT. Three places in this tree re-derive a value the engine already computes
/// (`Tool.tilesAffected`, `MeleeWeapon.DoDamage`, `SpawnFishData.GetChance`), and each was found because someone happened
/// to compare - twice by luck, once by a player-visible defect. The table makes comparison the default: adding a
/// derivation whose value the engine owns means adding a row, and a row that cannot be measured fails instead of passing
/// quietly.
/// </para>
///
/// <para>
/// THE THREE ZEROES ARE KEPT APART. `compared 0` is blocked and fails as `engine_parity_population_empty`. A candidate
/// the scan found and the registry did not answer for fails as `rederivation_undeclared:…`. A candidate the registry
/// declares unmeasurable is counted in `excluded` and must carry its reason in the log - never folded into `compared`.
/// </para>
/// </summary>
internal static class EngineParity
{
    internal const string PopulationEmpty = "engine_parity_population_empty";
    internal const string SampledWithoutSeed = "engine_parity_sampled_without_seed_contract";
    internal const string NotMeasuredCode = "engine_parity_not_measured";
    internal const string Disagrees = "engine_parity_disagrees";
    internal const string Undeclared = "rederivation_undeclared";

    internal static ParityReport Run(
        IReadOnlyList<ParityEntry> entries,
        IReadOnlyList<ParityCandidate> candidates,
        IReadOnlyDictionary<string, string> declarations)
    {
        var findings = new List<string>();
        var log = new List<string>();
        int compared = 0;
        int sampled = 0;
        int notMeasured = 0;
        int disagreements = 0;
        int exclusions = 0;

        foreach (ParityEntry entry in entries)
        {
            if (string.Equals(entry.Mode.ToString(), nameof(ParityMode.Sampled), StringComparison.Ordinal)
                && entry.SeedContract.Length == 0)
            {
                findings.Add($"{SampledWithoutSeed}:{entry.EngineMember}: a sampled entry must name the seed contract that reproduces its subset");
            }

            ParityOutcome outcome = entry.Compare();
            if (outcome.NotMeasured is { } reason)
            {
                notMeasured++;
                findings.Add($"{NotMeasuredCode}:{entry.EngineMember}:{reason}");
                log.Add($"entry {entry.EngineMember} · {entry.Mode} · NOT MEASURED: {reason}");
                continue;
            }

            int entryDisagreements = 0;
            foreach (ParityCase item in outcome.Cases)
            {
                compared++;
                if (entry.Mode == ParityMode.Sampled) sampled++;
                if (string.Equals(item.Ours, item.Engine, StringComparison.Ordinal)) continue;
                entryDisagreements++;
                disagreements++;
                findings.Add($"{Disagrees}:{entry.EngineMember}:{item.Input}:{item.Ours}:{item.Engine}");
            }

            log.Add(
                $"entry {entry.EngineMember} · ours {entry.OurDerivation} · {entry.Mode} · equality {entry.Equality} · input space {entry.InputSpace} · compared {outcome.Cases.Count.ToString(CultureInfo.InvariantCulture)} · disagreements {entryDisagreements.ToString(CultureInfo.InvariantCulture)}");
        }

        if (compared == 0 && notMeasured == 0)
            findings.Add($"{PopulationEmpty}: the table holds no compared case, so this run agrees with itself");

        var seen = new HashSet<string>(StringComparer.Ordinal);
        int undeclared = 0;
        foreach (ParityCandidate candidate in candidates)
        {
            if (!seen.Add(candidate.Key)) continue;
            if (declarations.TryGetValue(candidate.Key, out string? declaration) && declaration.Length > 0)
            {
                if (declaration.StartsWith("excluded:", StringComparison.Ordinal))
                {
                    exclusions++;
                    log.Add($"candidate {candidate.Key} · {declaration[(declaration.IndexOf(':', StringComparison.Ordinal) + 1)..]}");
                }

                continue;
            }

            undeclared++;
            findings.Add($"{Undeclared}:{candidate.File}:{candidate.Line.ToString(CultureInfo.InvariantCulture)}:{candidate.Key}:{candidate.Evidence}");
        }

        return new ParityReport(
            findings,
            log,
            entries.Count,
            compared,
            sampled,
            notMeasured,
            disagreements,
            exclusions,
            seen.Count,
            undeclared);
    }
}
