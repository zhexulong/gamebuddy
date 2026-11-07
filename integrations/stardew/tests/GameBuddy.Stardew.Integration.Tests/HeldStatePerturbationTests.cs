using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Xunit;
using Xunit.Abstractions;
using static GameBuddy.Stardew.Integration.Tests.TargetFamilyCompletenessTests;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// THE HELD-STATE PERTURBATION PASS: every published action is run once holding something it did not ask for.
///
/// <para>
/// A live run looked healthy - 124 executions, 124 succeeded - while only 15 of the 104 published actions had ever
/// been attempted: the model had degenerated to cutting weeds and breaking rocks. "Actions are fine" had therefore
/// never been measured; it had been measured for the subset that cannot go wrong. This file asks the question the
/// happy path cannot: with the wrong thing in hand, does the handler still END IN AN ANSWER?
/// </para>
/// <para>
/// Exactly three endings are answers: (1) it selects what it needs and succeeds, (2) it refuses BY NAME, or (3) it
/// walks in first and then does one of the two. Silence is the failure: a handler that quietly requires empty hands
/// or a particular tool, returns a success the world does not corroborate, and leaves the caller to guess. The
/// counterexample this file was built from is <c>pet_animal</c>, whose blanket <c>hands_not_empty</c> refusal named a
/// precondition <c>Pet.checkAction</c> does not have (Pet.cs:619-664) - see
/// <see cref="PetAnimalWithAnOrdinaryItemInHandPetsBecauseTheNativeSeamDoes"/>.
/// </para>
/// <para>
/// THE POPULATION IS DERIVED, NEVER LISTED. It is the action catalog's executing actions intersected with the
/// discovery audit's own <c>TARGET_FIELD</c> table - the two authorities that already decide what a "published target
/// action" is. An action in neither <see cref="Declared"/> nor <see cref="NoHeldStateApplies"/> nor one of the
/// existing undriven authorities fails this file BY NAME, so a new action cannot arrive unmeasured.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: most cases here build a world and drive the real handler, but the discovery audit's TARGET_FIELD table is a JavaScript source file and reading its keys is a source-shape assertion - kept beside the behaviour it selects so the population and the run cannot drift apart.
public sealed class HeldStatePerturbationTests
{
    private readonly ITestOutputHelper output;

    public HeldStatePerturbationTests(ITestOutputHelper output) => this.output = output;

    /// <summary>The held state one action is perturbed with.</summary>
    internal enum HeldState
    {
        /// <summary>A stack of something no action asked for: `(O)72`, a diamond.</summary>
        UnrelatedItem,

        /// <summary>`(O)ButterflyPowder`, the one held item that makes `Pet.checkAction` open a dialogue (Pet.cs:642).</summary>
        ButterflyPowder,
    }

    /// <summary>What the perturbation must force, once the native seam's own behaviour is read.</summary>
    internal enum Ending
    {
        /// <summary>Ending 1: the action selects what it needs (or never needed anything) and succeeds.</summary>
        Succeeds,

        /// <summary>Ending 2: the action refuses by a reason code this file names.</summary>
        RefusesByName,
    }

    /// <summary>
    /// One declared perturbation, with the native reading that makes the expectation a fact rather than a preference.
    /// </summary>
    internal sealed record Perturbation(HeldState Held, Ending Expected, string? ReasonCode, string Why);

    /// <summary>
    /// Actions this file PERTURBS, each with the native branch that decides the ending.
    ///
    /// A declaration here is a claim about the game, so each one cites the seam it was read from. An action whose
    /// expectation the product does not meet is red, which is the whole point: `pet_animal`'s entry was written
    /// against `Pet.checkAction` and the handler failed it until the blanket `hands_not_empty` refusal was replaced
    /// by the two branches that seam actually has.
    /// </summary>
    internal static readonly IReadOnlyDictionary<string, Perturbation> Declared = new Dictionary<string, Perturbation>(StringComparer.Ordinal)
    {
        ["pet_animal"] = new(
            HeldState.UnrelatedItem,
            Ending.Succeeds,
            null,
            "`Pet.checkAction` refuses nothing: any held item other than a Hat or (O)ButterflyPowder falls straight " +
            "through to the petting body and returns true (Pet.cs:646-664). With a (O)72 in hand the cat is petted, so " +
            "a refusal here names a precondition the game does not have"),
        ["talk_to_npc"] = new(
            HeldState.UnrelatedItem,
            Ending.RefusesByName,
            "hands_not_empty",
            "with an object in hand native takes the gift path (NPC.cs:2760), which is `interact_npc_with_item`'s intent " +
            "and not this action's, so the refusal is the action's own precondition"),
    };

    /// <summary>
    /// Actions this file builds and drives, whose answer a held item provably cannot change.
    ///
    /// This is NOT a skip list: each entry names the reason the hand is not an input, and an action that is neither
    /// here nor in <see cref="Declared"/> nor covered by the existing undriven authorities fails by name.
    /// </summary>
    internal static readonly IReadOnlyDictionary<string, string> NoHeldStateApplies = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["chest_store"] = "the action reads a PACK SLOT it is told to store, never the selected slot, so the hand is not an input (`chest_store` succeeded `chest_stored` with a diamond in hand)",
        ["npc_relationship"] = "a read-only projection of a villager's friendship record; it takes no item and mutates nothing",
        ["pickup_item"] = "the action walks to a ground item and delivers it to the pack; the selected slot is where the game puts it, not where it reads from",
    };

    /// <summary>
    /// THE GATE: every published target action is declared, or its absence is answered by an authority that already
    /// says why it cannot be driven. A new action fails here by name rather than joining an unmeasured majority.
    /// </summary>
    [Fact]
    public void EveryPublishedTargetActionIsPerturbedOrAnsweredByAnAuthority()
    {
        IReadOnlyList<FarmhandActionRegistration> population = PublishedTargetActions();
        population.Should().NotBeEmpty("the catalog and the discovery audit must agree on at least one target action");

        var unaccounted = new List<string>();
        foreach (FarmhandActionRegistration registration in population)
        {
            if (Declared.ContainsKey(registration.ActionId)) continue;
            if (NoHeldStateApplies.ContainsKey(registration.ActionId)) continue;
            if (TargetFamilyRoundTripTests.UndrivenPairs.ContainsKey(registration.ActionId)) continue;
            if (registration.Descriptor?.TargetFamily is not { } family) continue;
            if (TargetFamilyRoundTripTests.Undriven.ContainsKey(family)) continue;
            unaccounted.Add($"{registration.ActionId} (family `{family}`)");
        }

        unaccounted.Should().BeEmpty(
            "every published target action must either declare the held state it is perturbed with or say why no held " +
            "state can change its answer; an action in neither list is one nobody measures, which is how 89 of 104 " +
            "actions went unexercised without anyone noticing: " + string.Join(", ", unaccounted));

        // Entries that name an action the catalog no longer publishes are the other half of the same ratchet: a
        // declaration left behind by a removed action looks like coverage and is not.
        var stale = Declared.Keys
            .Concat(NoHeldStateApplies.Keys)
            .Where(actionId => population.All(registration => !string.Equals(registration.ActionId, actionId, StringComparison.Ordinal)))
            .ToArray();
        stale.Should().BeEmpty("a perturbation declared for an action the catalog does not publish is a declaration of nothing: " + string.Join(", ", stale));
    }

    /// <summary>
    /// THE BEHAVIOURAL GATE: each declared perturbation is driven through the action's own handler, and the ending it
    /// produces must be the ending the native seam implies.
    ///
    /// <para>
    /// The pairs the headless world cannot build are PRINTED, never silently skipped, and the exercised count is a
    /// number on every run: `exercised N of M published target actions`.
    /// </para>
    /// </summary>
    [Fact]
    public void EveryDeclaredPerturbationEndsInAnAnswer()
    {
        IReadOnlyList<FarmhandActionRegistration> population = PublishedTargetActions();
        var wrongEnding = new List<string>();
        var harnessLimited = new List<string>();
        int exercised = 0;

        foreach ((string actionId, Perturbation perturbation) in Declared.OrderBy(pair => pair.Key, StringComparer.Ordinal))
        {
            FarmhandActionRegistration registration = population.Single(candidate => candidate.ActionId == actionId);
            string family = registration.Descriptor!.TargetFamily!;
            TargetRoundTripProbe.Outcome outcome;
            try
            {
                using var world = TargetFamilyWorld.Create();
                world.PopulateFor(family);
                outcome = TargetRoundTripProbe.Run(world, actionId, family, heldQualifiedItemId: ItemFor(perturbation.Held));
            }
            catch (Exception exception) when (exception is InvalidOperationException or NullReferenceException or Microsoft.Xna.Framework.Content.ContentLoadException)
            {
                // The headless world cannot build this family at all; the same fact `TargetFamilyRoundTripTests.Undriven`
                // already carries for it, observed rather than restated.
                harnessLimited.Add($"{actionId}/{family}: world could not be built ({exception.GetType().Name})");
                continue;
            }

            this.output.WriteLine(
                $"{actionId}/{family} held={perturbation.Held}: accepted={outcome.Accepted} rows={outcome.Rows} "
                + $"refusal={outcome.Refusal} codes=[{outcome.Detail}] harness={outcome.HarnessLimit}");

            if (outcome.HarnessLimit.Length > 0)
            {
                harnessLimited.Add($"{actionId}/{family}: {outcome.HarnessLimit} (codes: {outcome.Detail})");
                continue;
            }

            if (outcome.Rows == 0)
            {
                harnessLimited.Add($"{actionId}/{family}: published no rows for the populated world");
                continue;
            }

            exercised++;
            if (WrongEnding(actionId, perturbation, outcome) is { } wrong) wrongEnding.Add(wrong);
        }

        this.output.WriteLine($"exercised {exercised} of {population.Count} published target actions under a declared held state");
        foreach (string limit in harnessLimited) this.output.WriteLine($"  not exercised here: {limit}");
        foreach ((string actionId, string reason) in UndeclaredGaps(population))
            this.output.WriteLine($"  undeclared gap: {actionId}: {reason}");

        wrongEnding.Should().BeEmpty(
            "a held state the action did not ask for must end in success, or in the refusal the native seam makes true "
            + "- never in a success that ignores it: " + string.Join(" | ", wrongEnding));

        exercised.Should().BeGreaterThanOrEqualTo(
            Declared.Count,
            "every declared perturbation the world can build must actually run: a declaration that quietly stops "
            + "executing looks exactly like a passing one. Not exercised here: " + string.Join(" | ", harnessLimited));
    }

    /// <summary>
    /// THE CASE THIS FILE WAS BUILT FROM, at the cheapest possible place to prove it.
    ///
    /// <para>
    /// `pet_animal` used to answer a `(O)72` in hand with `hands_not_empty`. That code was a lie: `Pet.checkAction`
    /// (Pet.cs:619-664) reads the selected slot for exactly two branches - a `Hat` is moved onto the pet, and
    /// `(O)ButterflyPowder` opens a question dialogue - and then falls through to the petting body either way. So
    /// the action now refuses only those two, and the ordinary case goes through to the native seam.
    /// </para>
    /// <para>
    /// The three assertions below are one property in three readings: the ordinary item is NOT refused, and each of
    /// the two branches that really exists IS refused, by its own name. Reading the native branch first is what makes
    /// this a measurement rather than a restatement of today's code.
    /// </para>
    /// </summary>
    [Fact]
    public void PetAnimalWithAnOrdinaryItemInHandPetsBecauseTheNativeSeamDoes()
    {
        // The native seam first, on a world of its own: with a (O)72 in hand, Pet.checkAction pets and returns true.
        // This is the reading the handler's old refusal contradicted, taken here so the expectation is measured and
        // not asserted.
        using (var native = TargetFamilyWorld.Create())
        {
            StardewValley.Characters.Pet pet = native.PlacePet(x: 2, y: 3, "Dog");
            native.StandAt(2, 3);
            native.PutInPackSlot(1, "(O)72", 1);
            native.HoldPackSlot(1);
            int friendshipBefore = pet.friendshipTowardFarmer.Value;

            bool handled = pet.checkAction(native.Actor, native.Farm);

            handled.Should().BeTrue("with an ordinary item in hand `Pet.checkAction` falls through to the petting body and returns true (Pet.cs:646-664)");
            pet.friendshipTowardFarmer.Value.Should().BeGreaterThan(friendshipBefore, "the petting body it fell through to is the one that grants friendship");
        }

        // Now the handler. It must not refuse what the seam accepts.
        using var world = TargetFamilyWorld.Create();
        StardewValley.Characters.Pet target = world.PlacePet(x: 2, y: 3, "Dog");
        world.StandAt(2, 2);
        world.PutInPackSlot(1, "(O)72", 1);
        world.HoldPackSlot(1);
        world.Actor.CurrentItem.Should().NotBeNull("the perturbation must actually be in the actor's hand");

        LocalExecutionReceipt receipt = DrivePetAnimal(world, target);

        receipt.ReasonCode.Should().NotBe(
            "hands_not_empty",
            "that refusal named a precondition `Pet.checkAction` does not have, and cost the companion a turn to empty a hand the game never required it to empty");
        this.output.WriteLine($"pet_animal with (O)72 in hand: {receipt.State}/{receipt.ReasonCode} evidence={receipt.Evidence ?? "<none>"}");
    }

    /// <summary>
    /// The two held items `Pet.checkAction` really does act on, each refused by its own name so the caller can tell
    /// "my hat would be taken" from "a modal would open".
    /// </summary>
    [Fact]
    public void PetAnimalRefusesByTheTwoNativeBranchesThatReallyExist()
    {
        using (var world = TargetFamilyWorld.Create())
        {
            StardewValley.Characters.Pet pet = world.PlacePet(x: 2, y: 3, "Dog");
            world.StandAt(2, 2);
            world.HoldUnrequestedHat();

            LocalExecutionReceipt receipt = DrivePetAnimal(world, pet);

            receipt.State.Should().Be(ExecutionState.Rejected, "a hat in hand would be moved onto the pet (Pet.cs:621-641), an item the caller never named");
            receipt.ReasonCode.Should().Be("pet_held_hat_would_be_taken");
            receipt.Evidence.Should().Contain("hand_item=(H)1", "a refusal that does not say what is in the hand is the report the class is named for");
        }

        using (var world = TargetFamilyWorld.Create())
        {
            StardewValley.Characters.Pet pet = world.PlacePet(x: 2, y: 3, "Dog");
            world.StandAt(2, 2);
            world.HoldAnUnrequestedItem("(O)ButterflyPowder");

            LocalExecutionReceipt receipt = DrivePetAnimal(world, pet);

            receipt.State.Should().Be(ExecutionState.Rejected, "butterfly powder opens a question dialogue (Pet.cs:642-645), a modal this action would then own");
            receipt.ReasonCode.Should().Be("pet_held_butterfly_powder_opens_dialogue");
            receipt.Evidence.Should().Contain("hand_item=(O)ButterflyPowder");
        }
    }

    /// <summary>
    /// THE CLASSIFIER'S OWN FALSIFIER: the ending comparison must be able to report silence, or it is decoration.
    ///
    /// <para>
    /// The shape that has to be caught is the one the live run showed: a handler that returns a SUCCESS while the
    /// perturbation was never answered. `WrongEnding` is the function the behavioural gate uses, called here with a
    /// synthetic silent outcome - if it cannot name that outcome, the gate above proves nothing.
    /// </para>
    /// </summary>
    [Fact]
    public void AVerdictOfSilenceIsReportedRatherThanAbsorbed()
    {
        var quiet = new Perturbation(HeldState.UnrelatedItem, Ending.RefusesByName, "hands_not_empty", "synthetic");

        WrongEnding("pet_animal", quiet, new TargetRoundTripProbe.Outcome(true, 1, string.Empty, "<none>", Detail: "succeeded/accepted"))
            .Should().Contain("SILENCE", "a success where the declaration asked for a refusal is the defect this file exists for");

        WrongEnding("pet_animal", quiet, new TargetRoundTripProbe.Outcome(false, 1, "hands_not_empty", "<none>", Detail: "rejected/hands_not_empty"))
            .Should().BeNull("the declared ending is not a failure");

        WrongEnding("pet_animal", quiet, new TargetRoundTripProbe.Outcome(false, 1, "pet_target_gone", "<none>", Detail: "rejected/pet_target_gone"))
            .Should().Contain("expected `hands_not_empty`", "a DIFFERENT refusal is still an answer, but not the one the native seam implies");

        WrongEnding("pet_animal", new Perturbation(HeldState.UnrelatedItem, Ending.Succeeds, null, "synthetic"), new TargetRoundTripProbe.Outcome(false, 1, "hands_not_empty", "<none>", Detail: "rejected/hands_not_empty"))
            .Should().Contain("expected SUCCESS", "and the other direction too, so the comparison is not one-sided");
    }

    // ---- the verdict, in one place ----------------------------------------------------

    /// <summary>
    /// The one place the ending comparison is spelled, so the gate and its falsifier cannot disagree.
    /// Returns null when the outcome is the ending the perturbation implies.
    /// </summary>
    private static string? WrongEnding(string actionId, Perturbation perturbation, TargetRoundTripProbe.Outcome outcome)
    {
        if (perturbation.Expected == Ending.Succeeds)
        {
            return outcome.Accepted
                ? null
                : $"{actionId}: expected SUCCESS with a {perturbation.Held} held, got `{outcome.Refusal}` (codes: {outcome.Detail}) - {perturbation.Why}";
        }

        if (outcome.Accepted)
            return $"{actionId}: expected the named refusal `{perturbation.ReasonCode}` with a {perturbation.Held} held, got a SUCCESS (codes: {outcome.Detail}) - SILENCE: the perturbation was never answered";
        return string.Equals(outcome.Refusal, perturbation.ReasonCode, StringComparison.Ordinal)
            ? null
            : $"{actionId}: expected `{perturbation.ReasonCode}`, got `{outcome.Refusal}` (codes: {outcome.Detail}) - {perturbation.Why}";
    }

    // ---- population and helpers -------------------------------------------------

    /// <summary>
    /// The published target actions: the catalog's executing actions whose id the discovery audit's `TARGET_FIELD`
    /// publishes a snapshot family for.
    ///
    /// The audit's table is the second authority deliberately: the catalog alone would call `advance_day` a target
    /// action the audit has no discovery leg for, and the audit alone would name an id the Mod no longer executes.
    /// </summary>
    internal static IReadOnlyList<FarmhandActionRegistration> PublishedTargetActions()
    {
        IReadOnlySet<string> audited = DiscoveryAuditTargetFields();
        return FarmhandActionCatalog.Registrations
            .Where(registration => registration.Kind == FarmhandOperationKind.Execution)
            .Where(registration => audited.Contains(registration.ActionId))
            .ToArray();
    }

    /// <summary>
    /// The keys of `TARGET_FIELD` in the discovery audit, read from the table itself rather than restated: it is the
    /// one declaration of "this action addresses a published target", and a second list here is the two-spellings
    /// defect this repository keeps paying for.
    /// </summary>
    private static IReadOnlySet<string> DiscoveryAuditTargetFields()
    {
        string audit = File.ReadAllText(Path.Combine(
            TargetFamilyRoundTripTests.RepositoryRoot(), "tools", "audit-stardew-discovery-channels.mjs"));
        int start = audit.IndexOf("export const TARGET_FIELD = Object.freeze({", StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, "the discovery audit must declare TARGET_FIELD");
        int end = audit.IndexOf("});", start, StringComparison.Ordinal);
        end.Should().BeGreaterThan(start, "TARGET_FIELD must close with `});`");

        MatchCollection entries = Regex.Matches(audit[start..end], "^\\s{2}([a-z_]+):", RegexOptions.Multiline);
        var fields = new HashSet<string>(entries.Select(match => match.Groups[1].Value), StringComparer.Ordinal);
        fields.Should().NotBeEmpty("a TARGET_FIELD table with no rows selects no population at all");
        return fields;
    }

    /// <summary>The item id each declared held state puts in the actor's hand.</summary>
    private static string ItemFor(HeldState held) => held switch
    {
        HeldState.UnrelatedItem => "(O)72",
        HeldState.ButterflyPowder => "(O)ButterflyPowder",
        _ => throw new ArgumentOutOfRangeException(nameof(held)),
    };

    /// <summary>
    /// The published actions this file does not perturb, each with the authority that already explains it.
    ///
    /// Printed on every run so the gap is a named list rather than an absence, and resolved from the existing
    /// authorities instead of a fourth hand-written table.
    /// </summary>
    private static IEnumerable<(string ActionId, string Reason)> UndeclaredGaps(IReadOnlyList<FarmhandActionRegistration> population)
    {
        foreach (FarmhandActionRegistration registration in population
            .Where(registration => !Declared.ContainsKey(registration.ActionId))
            .OrderBy(registration => registration.ActionId, StringComparer.Ordinal))
        {
            string reason =
                NoHeldStateApplies.TryGetValue(registration.ActionId, out string? notApplicable) ? "no held state applies: " + notApplicable
                : TargetFamilyRoundTripTests.UndrivenPairs.TryGetValue(registration.ActionId, out string? pair) ? pair
                : registration.Descriptor?.TargetFamily is not { } family ? "the discovery audit names a snapshot field but the descriptor declares no TargetFamily, so no family could be built for it"
                : TargetFamilyRoundTripTests.Undriven.TryGetValue(family, out string? familyBlocker) ? $"family `{family}` cannot be built here: {familyBlocker}"
                : "NO AUTHORITY NAMES WHY THIS IS NOT PERTURBED";
            yield return (registration.ActionId, reason);
        }
    }

    /// <summary>One `pet_animal` request for a world's pet, through the handler the production router dispatches to.</summary>
    private static LocalExecutionReceipt DrivePetAnimal(TargetFamilyWorld world, StardewValley.Characters.Pet pet)
    {
        ExecutionManager executions = world.NewExecutionManager("pet_animal");
        var handler = new GameBuddy.Stardew.Handlers.MachineAndAnimalActionHandler(executions);
        return handler.Execute(
            new BridgeExecutionRequest(
                "req_held_state",
                "imp_held_state",
                "pet_animal",
                new BridgeExecutionArgs { X = (int)pet.Tile.X, Y = (int)pet.Tile.Y, ExpectedTargetId = world.PetTargetId(pet) },
                1,
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000),
            executions);
    }
}
