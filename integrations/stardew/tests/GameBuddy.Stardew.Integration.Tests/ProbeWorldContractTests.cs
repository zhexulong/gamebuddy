using System;
using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using Xunit;
using Xunit.Abstractions;
using static GameBuddy.Stardew.Integration.Tests.TargetFamilyCompletenessTests;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The contract a probe world must satisfy before its failures may be reported as the ENGINE's, and the gate that stops a
/// recorded reason from blaming the harness.
///
/// <para>
/// Five one-line omissions in the probe farmer were reported as "the engine cannot do this" for a week, and two of them
/// are quoted in the reasons this file re-checks ("needs the item type-definition registry"; "ends in
/// Farmer.checkForExhaustion, which reads Game1.content"). The contract is the missing statement of what a complete world
/// owes; the gate is the part that keeps a reason honest after today.
/// </para>
/// </summary>
public sealed class ProbeWorldContractTests
{
    private readonly ITestOutputHelper output;

    public ProbeWorldContractTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    /// <summary>
    /// Every claim, measured against a world built the way the round-trip probe builds one.
    ///
    /// One world per claim rather than one shared world: two claims mutate the world on purpose (the swing consumes
    /// stamina and the crop placement writes a terrain feature), and a shared world would measure the second claim
    /// against the first claim's side effect.
    /// </summary>
    [Fact]
    public void EveryContractClaimHoldsOnAFreshProbeWorld()
    {
        ProbeWorldContract.Claims.Should().NotBeEmpty("not_measured: a contract with no claims guarantees nothing");

        var broken = new List<string>();
        foreach (ProbeWorldContract.Claim claim in ProbeWorldContract.Claims)
        {
            using var world = TargetFamilyWorld.Create();
            string measured = claim.Measure(world);
            output.WriteLine($"{claim.EngineValue} <- {claim.AssignedBy}: {(measured.Length == 0 ? "holds" : measured)}");
            if (measured.Length > 0)
                broken.Add($"{claim.EngineValue}: {measured}. Without it {claim.BreaksWithout}");
        }

        broken.Should().BeEmpty(
            "a `Undriven` reason may only stand for a fact the constructed world does not violate; each claim below is a "
            + "value the GAME assigns and `FormatterServices.GetUninitializedObject` skips: " + string.Join(" | ", broken));
    }

    /// <summary>
    /// Every ENGINE field a recorded reason names is either a claim the contract asserts or an exemption that says who
    /// produces it instead - and neither register may outlive what it was written for.
    ///
    /// This is the derivation requirement made mechanical: the population comes from the reasons, so a reason written next
    /// week that blames `Game1.somethingElse` fails by name instead of quietly widening the fiction.
    /// </summary>
    [Fact]
    public void EveryEngineFieldARecordedReasonNamesIsUnderTheContract()
    {
        IReadOnlyList<KeyValuePair<string, string>> reasons = Reasons();
        reasons.Should().NotBeEmpty("not_measured: no recorded reason was examined");

        var fields = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        var unknown = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach ((string family, string reason) in reasons)
        {
            foreach (ProbeWorldContract.EngineMember member in ProbeWorldContract.EngineFieldsNamedBy(reason))
                Add(fields, member.Spelling, family);
            foreach (ProbeWorldContract.EngineMember member in ProbeWorldContract.UnknownEngineMembersNamedBy(reason))
                Add(unknown, member.Spelling, family);
        }

        var classified = new HashSet<string>(
            ProbeWorldContract.Claims.SelectMany(claim => claim.Spellings.Append(claim.EngineValue))
                .Concat(ProbeWorldContract.Exemptions.Select(exemption => exemption.EngineValue)),
            StringComparer.Ordinal);

        string[] unclassified = fields.Keys
            .Where(field => !classified.Contains(field))
            .OrderBy(field => field, StringComparer.Ordinal)
            .ToArray();

        string[] unregistered = unknown.Keys
            .Where(spelling => !ProbeWorldContract.StaleSpellings.ContainsKey(spelling))
            .OrderBy(spelling => spelling, StringComparer.Ordinal)
            .ToArray();

        // THE EXEMPTIONS EXPIRE. An entry whose value no reason names any more is a licence nobody is using: leaving it
        // there would let the same field be "outside the contract" for a reason that no longer exists.
        string[] expired = ProbeWorldContract.Exemptions.Select(exemption => exemption.EngineValue)
            .Concat(ProbeWorldContract.StaleSpellings.Keys)
            .Where(spelling => !fields.ContainsKey(spelling) && !unknown.ContainsKey(spelling))
            .OrderBy(spelling => spelling, StringComparer.Ordinal)
            .ToArray();

        int guaranteed = ProbeWorldContract.Claims.Count(claim => claim.Spellings.Any(fields.ContainsKey));
        output.WriteLine(
            $"probe world contract: {ProbeWorldContract.Claims.Count} claims, "
            + $"{ProbeWorldContract.Exemptions.Count} exemptions, {ProbeWorldContract.StaleSpellings.Count} stale spellings; "
            + $"{reasons.Count} reasons examined, {fields.Count} engine fields named ({guaranteed} guaranteed by a claim, "
            + $"{fields.Count - guaranteed} exempt), {unknown.Count} stale spellings named "
            + $"[{string.Join(", ", unknown.Keys.OrderBy(spelling => spelling, StringComparer.Ordinal))}]");

        unclassified.Should().BeEmpty(
            "a reason that names an engine field the contract says nothing about is blaming a value nobody has decided the "
            + "world owes: add a Claim with the evidence, or an Exemption with the class that owns it. Families: "
            + Describe(fields, unclassified));

        unregistered.Should().BeEmpty(
            $"a spelling that names no member of this game version is registered in StaleSpellings so the population stays "
            + $"total: {Describe(unknown, unregistered)}");

        expired.Should().BeEmpty(
            "an exemption or stale spelling no recorded reason uses has outlived the complaint it was written for: "
            + string.Join(", ", expired));
    }

    /// <summary>
    /// THE GATE. No recorded reason may blame a value the contract guarantees.
    ///
    /// <para>
    /// Both halves are required and each alone was satisfied by this suite's own history: the reason must NAME a
    /// guaranteed value AND the clause around it must call it absent. `worldObjectTargets` names
    /// `MovePlacedFurnitureActionTests.FurnitureWorld` and blames a missing registry; `mailboxTargets` names
    /// `Game1.player.mailbox` and blames a missing map tile. Neither is an invalidated reason, and a matcher that could
    /// not tell them apart would have to be muted on the first day.
    /// </para>
    /// </summary>
    [Fact]
    public void NoRecordedReasonBlamesAValueTheContractGuarantees()
    {
        IReadOnlyList<KeyValuePair<string, string>> reasons = Reasons();
        reasons.Should().NotBeEmpty(
            "not_measured: no recorded reason was examined, so this gate has not looked at anything and may not pass");

        var invalidated = new List<string>();
        int standing = 0;
        foreach ((string family, string reason) in reasons)
        {
            string? blamed = ProbeWorldContract.InvalidatedBy(reason);
            if (blamed is null)
            {
                standing++;
                continue;
            }

            ProbeWorldContract.Claim claim = ProbeWorldContract.Claims.Single(candidate => candidate.EngineValue == blamed);
            invalidated.Add($"{family} blames `{blamed}`, which the probe world GUARANTEES ({claim.AssignedBy}): \"{reason}\"");
        }

        output.WriteLine(
            $"probe world contract: {reasons.Count} reasons examined "
            + $"({TargetFamilyRoundTripTests.Undriven.Count} undriven families + "
            + $"{TargetFamilyRoundTripTests.UndrivenPairs.Count} undriven pairs), "
            + $"{invalidated.Count} invalidated, {standing} standing");

        invalidated.Should().BeEmpty(
            "a reason that blames a value the world guarantees has recorded the HARNESS as an engine limit: re-measure it "
            + "or rewrite it to the surface it really reaches: " + string.Join(" | ", invalidated));
    }

    /// <summary>
    /// The gate's own red case, stated as behaviour rather than left to a recorded measurement: the matcher must recognise
    /// the exact shape the four recorded probe-farmer causes had, and must NOT fire on the two shapes that only look like
    /// it. A matcher nobody has seen fire is indistinguishable from one that cannot.
    /// </summary>
    [Fact]
    public void TheContractRefusesAReasonThatBlamesAValueItGuarantees()
    {
        ProbeWorldContract.InvalidatedBy(
                "the probe farmer's maxStamina was zero, so the first swing clamped Stamina to 0 and Farmer.checkForExhaustion "
                + "read Game1.content")
            .Should()
            .Be("Farmer.maxStamina", "this is the recorded shape of the defect, and the gate must name the value it blames");

        ProbeWorldContract.InvalidatedBy(
                "a map Action tile `Mailbox` plus Game1.player.mailbox; the harness map declares no Action tiles")
            .Should()
            .BeNull("NAMING a guaranteed value is not blaming it: the missing fact in that reason is the map tile");

        ProbeWorldContract.InvalidatedBy(
                "a currentLocation of type Farm holding a (O)710 stack; TargetFamilyWorld builds a plain GameLocation")
            .Should()
            .BeNull("`player.currentLocation` is a different fact from the `Game1.currentLocation` static the contract owns");
    }

    private static void Add(Dictionary<string, List<string>> population, string spelling, string family)
    {
        if (!population.TryGetValue(spelling, out List<string>? families))
            population[spelling] = families = new List<string>();
        if (!families.Contains(family)) families.Add(family);
    }

    private static string Describe(Dictionary<string, List<string>> population, IEnumerable<string> spellings) =>
        string.Join(", ", spellings.Select(spelling => $"{spelling} ({string.Join("/", population[spelling])})"));

    /// <summary>Every recorded reason, keyed by the family or action it is recorded against.</summary>
    private static IReadOnlyList<KeyValuePair<string, string>> Reasons() =>
        TargetFamilyRoundTripTests.Undriven
            .Concat(TargetFamilyRoundTripTests.UndrivenPairs)
            .OrderBy(entry => entry.Key, StringComparer.Ordinal)
            .ToArray();
}
