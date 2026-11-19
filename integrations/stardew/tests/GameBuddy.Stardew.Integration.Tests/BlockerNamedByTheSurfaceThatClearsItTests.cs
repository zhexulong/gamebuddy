using System;
using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Policy;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The gate <c>a_blocker_is_named_by_the_surface_that_clears_it:&lt;occupant&gt;</c>: every word the discovery publishes for
/// something standing on a tile is, IN THE REFUSAL'S OWN WORDS, either removed by a published action or named as
/// unclearable WITH the reason - and the family a clearing id would come from is one the blocker read can ask.
///
/// <para>
/// WHY THE VOCABULARY GATE WAS NOT ENOUGH. `ClearingVocabularyCoverageTests` already proves every published kind is either
/// cleared by a declaration or declared unclearable with a reason. Measured `round77`, that was true and the run still had
/// nothing to act on: the refusal read <c>clears_with=no_published_action_clears:bush</c> - the declaration's answer with
/// its reason thrown away - and <c>blocker_target=blocker_not_published</c> about a weed that had BOTH a published action
/// (<c>cut_weeds</c>) and a published row. A declaration that answers a caller is only an answer if the surface that
/// speaks to the caller carries it, so the population here is the surface's own strings.
/// </para>
///
/// <para>
/// POPULATION, and nothing in it is a hand-written list: every occupant kind the vocabulary declares
/// (<see cref="TileOccupantKind.Published"/>, which is what the classifier and the rectangle row publish - and which
/// `ClearingVocabularyCoverageTests` already holds the classifier to), crossed with the catalogue's own <c>Clears</c>
/// declarations and with <see cref="TileOccupantKind.UnclearableCodes"/>. The property is that each occupant lands in
/// EXACTLY ONE of two arms, and that the arm it lands in is the one the surface says out loud:
/// <list type="bullet">
/// <item>cleared: the refusal names the clearing action, and the family a target id would come from is one
/// <see cref="ExecutionManager.BlockerTargetFamilies"/> can ask;</item>
/// <item>unclearable: the refusal names the occupant AND the declared reason token, and says there is no target to
/// address.</item>
/// </list>
/// It prints <c>occupants examined O · clearable-by-a-declared-action C · named-unclearable U</c>, because "0 findings"
/// means nothing without the population it was read over.
/// </para>
/// </summary>
public sealed class BlockerNamedByTheSurfaceThatClearsItTests
{
    private readonly ITestOutputHelper output;

    public BlockerNamedByTheSurfaceThatClearsItTests(ITestOutputHelper output) => this.output = output;

    /// <summary>
    /// The gate, over the live catalogue and the live vocabulary.
    ///
    /// The reading below is the measure the whole unit exists for: a bush that blocks a route (nothing clears it, and the
    /// engine keeps it standing) and a weed whose tile the frame had no row for (the action exists, the family exists, the
    /// row was outside its window). Both were `blocker_not_published` / a bare `no_published_action_clears` before this.
    /// </summary>
    [Fact]
    public void EveryOccupantTheDiscoveryPublishesIsNamedByTheSurfaceThatAnswersForIt()
    {
        Census census = Judge(
            TileOccupantKind.Published,
            FarmhandActionCatalog.Registrations,
            TileOccupantKind.Unclearable,
            TileOccupantKind.UnclearableCodes,
            ExecutionManager.BlockerTargetFamilies);

        census.Findings.Should().BeEmpty(
            "occupants examined {0} · clearable-by-a-declared-action {1} · named-unclearable {2}: {3}",
            census.Examined,
            census.Clearable,
            census.NamedUnclearable,
            string.Join(" ", census.Findings));

        census.Examined.Should().Be(TileOccupantKind.Published.Count, "the population is the vocabulary, not a subset of it");
        (census.Clearable + census.NamedUnclearable).Should().Be(
            census.Examined,
            "every occupant is in exactly one arm - a kind in neither is the defect this gate exists for");
        census.Clearable.Should().BeGreaterThan(0, "a run that only measured unclearable kinds would agree with itself");
        census.NamedUnclearable.Should().BeGreaterThan(0, "and one that only measured cleared kinds would too");

        this.output.WriteLine(
            $"occupants examined {census.Examined} · clearable-by-a-declared-action {census.Clearable} · named-unclearable {census.NamedUnclearable}");
    }

    /// <summary>
    /// THE FALSIFIER, on the defect the gate exists for: an occupant the surface answers BOTH ways - a published clearer
    /// AND a declared reason - is one word with two meanings, and is reported by name.
    /// </summary>
    [Fact]
    public void AnOccupantClearedAndDeclaredUnclearableIsReportedByName()
    {
        Census census = Judge(
            new[] { TileOccupantKind.Weed },
            FarmhandActionCatalog.Registrations,
            new[] { (TileOccupantKind.Weed, "a reason that contradicts the declaration") },
            new[] { (TileOccupantKind.Weed, "engine_keeps_it_standing") },
            ExecutionManager.BlockerTargetFamilies);

        census.Findings.Should().Equal($"a_blocker_is_named_by_the_surface_that_clears_it:{TileOccupantKind.Weed}");
    }

    /// <summary>
    /// THE FALSIFIER on real history: the live catalogue with ONE clearing action removed, which is the shape a
    /// declaration leaves behind when it is deleted without the vocabulary being told. The weed - a word the world
    /// publishes on every farm - has no clearer and no declared reason, and the gate names it and nothing else.
    /// </summary>
    [Fact]
    public void AClearingActionThatDisappearsIsRedOnTheOccupantItAnsweredFor()
    {
        FarmhandActionRegistration[] surfaceWithoutCutWeeds = FarmhandActionCatalog.Registrations
            .Where(registration => registration.ActionId != "cut_weeds")
            .ToArray();

        Census census = Judge(
            TileOccupantKind.Published,
            surfaceWithoutCutWeeds,
            TileOccupantKind.Unclearable,
            TileOccupantKind.UnclearableCodes,
            ExecutionManager.BlockerTargetFamilies);

        census.Findings.Should().ContainSingle(
                "no other declaration clears a weed, so exactly one occupant lost its answer")
            .Which.Should().Be($"a_blocker_is_named_by_the_surface_that_clears_it:{TileOccupantKind.Weed}");
    }

    /// <summary>
    /// THE FALSIFIER on the surface's own words: a clearing action whose family the blocker read cannot ask is a clearer
    /// the refusal offers with no way to address it - the `worldObjectTargets` hole, injected.
    /// </summary>
    [Fact]
    public void AClearingActionWhoseFamilyCannotBeAskedIsReportedByName()
    {
        Census census = Judge(
            new[] { TileOccupantKind.Twig },
            FarmhandActionCatalog.Registrations,
            Array.Empty<(string, string)>(),
            Array.Empty<(string, string)>(),
            Array.Empty<string>());

        census.Findings.Should().Equal($"a_blocker_is_named_by_the_surface_that_clears_it:{TileOccupantKind.Twig}");
    }

    /// <summary>
    /// Zero population is a BLOCKED reading and never a pass: a run that read no occupant has not measured a surface.
    /// </summary>
    [Fact]
    public void NoOccupantsIsRefusedByName()
    {
        Census census = Judge(
            Array.Empty<string>(),
            FarmhandActionCatalog.Registrations,
            TileOccupantKind.Unclearable,
            TileOccupantKind.UnclearableCodes,
            ExecutionManager.BlockerTargetFamilies);

        census.Examined.Should().Be(0);
        census.Findings.Should().Equal("a_blocker_is_named_by_the_surface_that_clears_it:unmeasured");
    }

    /// <summary>What one run of the gate found, over the population it was read on.</summary>
    internal readonly record struct Census(int Examined, int Clearable, int NamedUnclearable, IReadOnlyList<string> Findings);

    /// <summary>
    /// The judgement itself, fed its four populations - so the honest ones and the injected ones are judged by ONE
    /// function, and a guard that cannot be made red on purpose is decoration.
    /// </summary>
    internal static Census Judge(
        IReadOnlyList<string> occupants,
        IReadOnlyList<FarmhandActionRegistration> surface,
        IReadOnlyList<(string Kind, string Reason)> unclearable,
        IReadOnlyList<(string Kind, string Code)> codes,
        IReadOnlyCollection<string> blockerFamilies)
    {
        var findings = new List<string>();
        if (occupants.Count == 0)
        {
            findings.Add("a_blocker_is_named_by_the_surface_that_clears_it:unmeasured");
            return new Census(0, 0, 0, findings);
        }

        var reasons = unclearable.ToDictionary(entry => entry.Kind, entry => entry.Reason, StringComparer.Ordinal);
        var codesByKind = codes.ToDictionary(entry => entry.Kind, entry => entry.Code, StringComparer.Ordinal);
        int clearable = 0;
        int named = 0;

        foreach (string occupant in occupants)
        {
            IReadOnlyList<FarmhandClearingOffer> clearers = ClearingActionSurface.ClearersOf(occupant, surface);
            // THE SURFACE'S OWN WORDS, in both shapes it publishes them: the receipt's evidence (which carries the target)
            // and the settled node's hint (which does not). A reason that reaches only one of them reaches the model after
            // settlement never.
            string evidence = ClearingEvidence.DescribeBlocker(
                occupant,
                (0, 0),
                targetId: null,
                clearers: clearers,
                staminaCharge: null,
                detourFacts: null);
            string hint = ClearingEvidence.DescribeBlockerBrief(occupant, (0, 0), clearers);

            if (clearers.Count > 0)
                clearable += 1;
            else
                named += 1;

            if (clearers.Count > 0)
            {
                if (reasons.ContainsKey(occupant)
                    || !evidence.Contains($"clears_with={clearers[0].ActionId}", StringComparison.Ordinal)
                    || !hint.Contains($"clears_with={clearers[0].ActionId}", StringComparison.Ordinal)
                    || clearers.Any(clearer => !blockerFamilies.Contains(clearer.TargetFamily, StringComparer.Ordinal))
                    || !evidence.Contains(
                        $"blocker_target={ClearingEvidence.TargetUnpublished}:{clearers[0].TargetFamily}",
                        StringComparison.Ordinal))
                {
                    findings.Add($"a_blocker_is_named_by_the_surface_that_clears_it:{occupant}");
                }

                continue;
            }

            // The unclearable arm: the word has to carry the occupant AND the declared reason, and it has to say there is
            // no target to address rather than leave the field out or deny one exists.
            if (!reasons.TryGetValue(occupant, out string? reason)
                || string.IsNullOrWhiteSpace(reason)
                || !codesByKind.TryGetValue(occupant, out string? code)
                || string.IsNullOrWhiteSpace(code)
                || !evidence.Contains($"clears_with={ClearingEvidence.NoPublishedActionClears}:{occupant}:{code}", StringComparison.Ordinal)
                || !hint.Contains($"clears_with={ClearingEvidence.NoPublishedActionClears}:{occupant}:{code}", StringComparison.Ordinal)
                || !evidence.Contains($"blocker_target={ClearingEvidence.NoClearingAction}", StringComparison.Ordinal))
            {
                findings.Add($"a_blocker_is_named_by_the_surface_that_clears_it:{occupant}");
            }
        }

        return new Census(occupants.Count, clearable, named, findings);
    }
}
