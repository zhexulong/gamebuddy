using FluentAssertions;
using GameBuddy.Stardew.Core.BodyPrograms;
using GameBuddy.Stardew.Core.Policy;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// GATE, not a test: no action that needs a free body may start while a modal holds the actor, and every hold names both
/// what holds her and what clears it.
///
/// <para>
/// WHY A GATE, AND WHAT IT REPLACES. A successor was admitted the moment its predecessor settled, and a predecessor
/// settles while the dialogue it raised is still open (`talk_to_npc` reports `Succeeded` with `player_can_move_after=false`).
/// The node then met the flat admission's named hold and died with it, so one dialogue box took out every remaining step
/// of a plan; the pump's own answer was to wait a cadence window and dispatch anyway. The population below is the
/// catalog's registration list, so an action registered tomorrow is covered by the same property, and every remedy a
/// hold names is asserted to be a PUBLISHED action rather than a word the reader has to interpret.
/// </para>
/// </summary>
public sealed class BodyProgramDispatchGateTests
{
    private readonly ITestOutputHelper output;

    public BodyProgramDispatchGateTests(ITestOutputHelper output)
    {
        this.output = output;
    }

    /// <summary>Every catalog action whose working precondition is NOT an open modal needs a free body.</summary>
    private static string[] BodyOwningActions() => FarmhandActionCatalog.Registrations
        .Select(registration => registration.ActionId)
        .Where(actionId => !FarmhandActionCatalog.IsModalResolving(actionId))
        .OrderBy(actionId => actionId, StringComparer.Ordinal)
        .ToArray();

    [Fact]
    public void EveryActionThatNeedsAFreeBody_IsHeldByAQuestionDialogue_AndTheHoldNamesTheActionThatAnswersIt()
    {
        string[] population = BodyOwningActions();
        population.Should().NotBeEmpty(
            "the family is declared by the catalog; an empty population means this gate read nothing and agrees with itself");

        var held = new List<string>();
        foreach (string actionId in population)
        {
            BodyProgramHold? hold = BodyProgramDispatchGate.HoldOf(
                actionId,
                cutsceneUp: false,
                modal: new BodyProgramModalFact(BodyProgramModalKind.Question, "DialogueBox"),
                actorCanMove: false);
            hold.Should().NotBeNull($"body_owning_action_admitted_inside_a_dialogue:{actionId}");
            hold!.Value.IsModal.Should().BeTrue(
                $"the START gate reads this flag to refuse the mint, so a hold that is not marked modal starts anyway:{actionId}");
            hold.Value.Evidence.Should().Be(
                "held_by=dialogue_box;answer_it=answer_dialogue",
                $"one_hold_one_spelling:{actionId} - the hold states the world, so it cannot answer differently per action");
            held.Add(actionId);
        }

        this.output.WriteLine($"examined {population.Length} body-owning actions: held {held.Count}");
        held.Should().HaveCount(population.Length);
    }

    [Fact]
    public void EveryModalResolvingMember_MayStartWhileItsPreconditionIsMounted()
    {
        // FALSIFIER for the gate above: if every action were held by every modal, the property would pass over a pump
        // that cannot run the one family that clears a modal. The exemption is the catalog's own declaration, not a
        // second list, so registering a fourth modal-resolving action moves both sides of this test at once.
        string[] population = FarmhandActionCatalog.ModalResolvingActionIds
            .OrderBy(actionId => actionId, StringComparer.Ordinal)
            .ToArray();
        population.Should().NotBeEmpty("the family is declared by the catalog; an empty population agrees with itself");

        foreach (string actionId in population)
            foreach (BodyProgramModalKind kind in MountedKinds())
                BodyProgramDispatchGate.HoldOf(
                        actionId,
                        cutsceneUp: false,
                        modal: new BodyProgramModalFact(kind, "SomeMenu"),
                        actorCanMove: false)
                    .Should().BeNull($"modal_resolving_member_held_by_its_own_precondition:{actionId}:{kind}");

        this.output.WriteLine($"examined {population.Length} modal-resolving members");
    }

    [Fact]
    public void EachModalKind_NamesTheRemedyThatClearsIt_AndThatRemedyIsAPublishedAction()
    {
        string actionId = BodyOwningActions().First();
        var rows = new List<(BodyProgramModalKind Kind, string Evidence)>();
        foreach (BodyProgramModalKind kind in MountedKinds())
        {
            BodyProgramHold? hold = BodyProgramDispatchGate.HoldOf(
                actionId,
                cutsceneUp: false,
                modal: new BodyProgramModalFact(kind, kind == BodyProgramModalKind.Shop ? "ShopMenu" : "SomeMenu"),
                actorCanMove: false);
            hold.Should().NotBeNull($"a {kind} modal holds {actionId}, whose action needs a free body");
            hold!.Value.IsModal.Should().BeTrue($"{kind} is cleared by an action, never by waiting");
            rows.Add((kind, hold.Value.Evidence));
        }

        foreach ((BodyProgramModalKind kind, string evidence) in rows)
            this.output.WriteLine($"{kind}: {evidence}");

        foreach ((BodyProgramModalKind kind, string evidence) in rows)
            foreach (string remedy in RemedyActions(evidence))
                FarmhandActionCatalog.Registrations.Should().Contain(
                    registration => registration.ActionId == remedy,
                    $"{kind} names action '{remedy}', and a remedy naming an action the catalog does not publish is a refusal the caller cannot act on");

        // One fact, one spelling: the question box and the shop counter are the two the compiler's inserted node meets,
        // and both hold the action they do not own with a DIFFERENT remedy - not a different code.
        rows.Single(row => row.Kind == BodyProgramModalKind.Question).Evidence
            .Should().Be("held_by=dialogue_box;answer_it=answer_dialogue");
        rows.Single(row => row.Kind == BodyProgramModalKind.PlainDialogue).Evidence
            .Should().Be("held_by=dialogue_box;dismiss_it=dismiss_modal");
        rows.Single(row => row.Kind == BodyProgramModalKind.Shop).Evidence
            .Should().Be("held_by=shop_menu;shop_purchase_opens_its_own=true");
    }

    [Fact]
    public void ACutsceneAndATransientLock_AreNotModalHolds()
    {
        string actionId = BodyOwningActions().First();

        BodyProgramDispatchGate.HoldOf(actionId, cutsceneUp: true, BodyProgramModalFact.None, actorCanMove: false)
            .Should().Be(new BodyProgramHold(BodyProgramModalKind.None, "held_by=cutscene_active;next_step=wait_for_event_to_end"),
                "a cutscene outranks a mounted modal and ends on its own, so the start gate must not treat it as a modal hold");

        BodyProgramDispatchGate.HoldOf(actionId, cutsceneUp: false, BodyProgramModalFact.None, actorCanMove: false)
            .Should().Be(new BodyProgramHold(BodyProgramModalKind.None, "held_by=transient_busy;next_step=wait_for_retry_window"),
                "a transient body lock clears inside the retry window, which is what the bounded deferral is for");

        BodyProgramDispatchGate.HoldOf(actionId, cutsceneUp: false, BodyProgramModalFact.None, actorCanMove: true)
            .Should().BeNull("a free body and an empty screen hold nothing");
    }

    /// <summary>Every kind a live menu can be, which is the population the two faces of this defect share.</summary>
    private static BodyProgramModalKind[] MountedKinds() => new[]
    {
        BodyProgramModalKind.Question,
        BodyProgramModalKind.PlainDialogue,
        BodyProgramModalKind.Shop,
        BodyProgramModalKind.OperationMenu,
        BodyProgramModalKind.Menu,
    };

    /// <summary>The action ids an evidence string names as its remedy, in whichever field it names them.</summary>
    private static IEnumerable<string> RemedyActions(string evidence)
    {
        foreach (string field in evidence.Split(';'))
        {
            int equals = field.IndexOf('=', StringComparison.Ordinal);
            if (equals < 0) continue;
            string key = field[..equals];
            string value = field[(equals + 1)..];
            if (key is "answer_it" or "dismiss_it") yield return value;
            // `shop_purchase_opens_its_own` states the remedy's own fact: the action id is its first two words.
            if (key == "shop_purchase_opens_its_own") yield return "shop_purchase";
        }
    }
}
