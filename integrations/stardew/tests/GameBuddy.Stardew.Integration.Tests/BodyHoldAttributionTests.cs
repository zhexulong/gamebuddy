using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The named-hold decision table. One anonymous code (`player_not_actionable`) used to cover a mounted menu,
/// a cutscene, a faint, an eating animation and a tool swing, so an Agent that was refused had no fact to
/// choose a countermeasure from and its only visible option was to re-issue the same request.
///
/// These tests pin the closed set: every disposition kind a held body can produce maps to its own code, and
/// the evidence carries the facts the countermeasure needs. The inputs of
/// <see cref="WorldModel.Classify"/> are themselves a closed set, which is why this table can be exhaustive
/// over the MOD's holds - it is not, and does not claim to be, a proof that the game has no other way to take
/// <c>CanMove</c> away (that is a fact about the game's source, pinned only by the probes).
/// </summary>
public sealed class BodyHoldAttributionTests
{
    private static ActorWorldFacts Facts(
        bool eventUp = false,
        string? menuType = null,
        bool dialogueUp = false,
        int timeOfDay = 1200,
        float stamina = 200f,
        bool freezePaused = false,
        bool eating = false,
        bool usingTool = false,
        bool toolCharged = false,
        bool selfAnimation = false,
        bool warping = false,
        bool dayTransition = false,
        bool controlsFrozen = false,
        bool minigame = false,
        bool screenFade = false) =>
        new(
            EventUp: eventUp,
            MenuType: menuType,
            DialogueUp: dialogueUp,
            TimeOfDay: timeOfDay,
            Stamina: stamina,
            FreezePaused: freezePaused,
            Eating: eating,
            UsingTool: usingTool,
            ToolCharged: toolCharged,
            SelfAnimation: selfAnimation,
            Warping: warping,
            DayTransition: dayTransition,
            ControlsFrozen: controlsFrozen,
            Minigame: minigame,
            ScreenFade: screenFade);

    [Fact]
    public void EveryHoldingKindHasItsOwnCode()
    {
        // Exhaustive over the enum on purpose: a new variant that nobody taught this table about must fail
        // here rather than publish a fallback the Agent cannot distinguish.
        List<string> codes = Enum.GetValues<ActorDispositionKind>()
            .Select(WorldModel.HoldReasonCode)
            .ToList();

        codes.Should().OnlyHaveUniqueItems(
            "five holds with one code is the defect this replaced: the Agent cannot choose a countermeasure "
            + "when every hold looks the same");
        WorldModel.HoldReasonCode(ActorDispositionKind.Modal).Should().Be("actor_held_by_modal");
        WorldModel.HoldReasonCode(ActorDispositionKind.Event).Should().Be("cutscene_active");
        WorldModel.HoldReasonCode(ActorDispositionKind.PassOut).Should().Be("actor_passed_out");
        WorldModel.HoldReasonCode(ActorDispositionKind.Transient).Should().Be("transient_busy");
        // Idle is not a hold: a gate only asks for a code once it has decided the body is held, so the Idle
        // entry exists to keep the switch total and must never be reachable from a refusal.
        WorldModel.HoldReasonCode(ActorDispositionKind.Idle).Should().Be("player_not_actionable");
    }

    [Theory]
    [InlineData(true, "cutscene_active")]
    [InlineData(false, null)]
    public void ACutsceneOutranksTheMountedMenu(bool eventUp, string? expectedCode)
    {
        // Precedence, through the authority: Event > Modal. The gate must therefore name the cutscene, because
        // that is the hold no tool can clear.
        ActorWorldFacts facts = Facts(eventUp: eventUp, menuType: "menu", dialogueUp: true);
        ActorDisposition disposition = WorldModel.Classify(facts);
        if (expectedCode is null)
        {
            disposition.Kind.Should().Be(ActorDispositionKind.Modal);
            return;
        }
        disposition.Kind.Should().Be(ActorDispositionKind.Event);
        WorldModel.HoldReasonCode(disposition.Kind).Should().Be(expectedCode);
    }

    [Fact]
    public void TheModalEvidenceCarriesWhatDecidesDismissVersusAnswer()
    {
        ActorWorldFacts facts = Facts(dialogueUp: true);
        ActorDisposition disposition = WorldModel.Classify(facts);
        disposition.Kind.Should().Be(ActorDispositionKind.Modal);
        disposition.ModalType.Should().Be("DialogueBox");

        string informational = WorldModel.DescribeHeldBody(disposition, facts, canMove: false, hold: BodyHoldFact.Free, modalIsQuestion: false).Evidence;
        informational.Should().Contain("modal_type=DialogueBox");
        informational.Should().Contain("is_question=false");
        informational.Should().Contain("can_move=false");

        string question = WorldModel.DescribeHeldBody(disposition, facts, canMove: false, hold: BodyHoldFact.Free, modalIsQuestion: true).Evidence;
        question.Should().Contain("is_question=true");

        // Unknown must read as unknown rather than as "not a question", which would tell the Agent to dismiss
        // a dialogue that is waiting for an answer.
        string unknown = WorldModel.DescribeHeldBody(disposition, facts, canMove: false, hold: BodyHoldFact.Free).Evidence;
        unknown.Should().Contain("is_question=unknown");
    }

    /// <summary>
    /// A cutscene's evidence names what the Agent can do about it, which is the whole difference between a hold and a
    /// dead end. Measured from a live run's transcript: four retries over twenty minutes read only that the body was
    /// held, while the two actions that end a cutscene's own dialogue box were the two the gate refused.
    ///
    /// The FACTS (a box is on screen; is it asking something) decide which action applies, and they are published next
    /// to the hold rather than inferred by the reader. With nothing on screen there is no action at all, and the
    /// evidence says so: `admissible_actions=none` plus the one step that is left.
    /// </summary>
    [Fact]
    public void TheCutsceneEvidenceNamesWhatTheAgentCanDoAboutIt()
    {
        ActorWorldFacts withBox = Facts(eventUp: true, menuType: "DialogueBox", dialogueUp: true);
        ActorDisposition cutscene = WorldModel.Classify(withBox);
        cutscene.Kind.Should().Be(ActorDispositionKind.Event);

        string informational = WorldModel.DescribeHeldBody(cutscene, withBox, canMove: false, hold: BodyHoldFact.Free, modalIsQuestion: false).Evidence;
        informational.Should().Contain("event_up=true");
        informational.Should().Contain("dialogue_box=true");
        informational.Should().Contain("is_question=false");
        // The admissible set is the catalog's own event-acting family FILTERED by the question flag, so the evidence
        // cannot name an action the handler would refuse: a close for an informational box, an answer for a question.
        informational.Should().Contain("admissible_actions=dismiss_modal;");

        string question = WorldModel.DescribeHeldBody(cutscene, withBox, canMove: false, hold: BodyHoldFact.Free, modalIsQuestion: true).Evidence;
        question.Should().Contain("is_question=true");
        question.Should().Contain("admissible_actions=answer_dialogue;");

        ActorWorldFacts withoutBox = Facts(eventUp: true);
        string bare = WorldModel.DescribeHeldBody(WorldModel.Classify(withoutBox), withoutBox, canMove: false, hold: BodyHoldFact.Free).Evidence;
        bare.Should().Contain("dialogue_box=false");
        bare.Should().Contain("admissible_actions=none");
        bare.Should().Contain(
            "next_step=wait_for_event_to_advance",
            "with nothing on screen, waiting is the only option and the hold has to say so or the Agent retries");
    }

    /// <summary>
    /// `dialogue_box` answers the ONE question the event-acting family asks: can `answer_dialogue` reach a box - the
    /// handler's own read (`Game1.activeClickableMenu is DialogueBox`), not "some modal is mounted".
    ///
    /// <para>
    /// It was answered by `menuType is not null || dialogueUp`, so a cutscene with a `ShopMenu`, a `LetterViewerMenu` or
    /// any other menu on screen published `dialogue_box=true` and `admissible_actions=answer_dialogue,dismiss_modal`
    /// beside it, and the handlers then refused both of the actions the evidence had just named. A fact published as a
    /// precondition has to BE the handler's read, or the admission and the handler disagree about one word.
    /// </para>
    /// </summary>
    [Fact]
    public void TheCutsceneBoxIsTheBoxAnswerDialogueNeeds_NotAnyMountedModal()
    {
        ActorWorldFacts menuOnScreen = Facts(eventUp: true, menuType: "ShopMenu");
        string heldByAMenu = WorldModel.DescribeHeldBody(
            WorldModel.Classify(menuOnScreen), menuOnScreen, canMove: false, hold: BodyHoldFact.Free, modalIsQuestion: null).Evidence;
        heldByAMenu.Should().Contain("dialogue_box=false", "a ShopMenu is not a box answer_dialogue can answer");
        heldByAMenu.Should().Contain("admissible_actions=none;next_step=wait_for_event_to_advance");

        // An event's own NPC box, with NO farmer-level dialogue: `Game1.dialogueUp` is the flag the farmer's talk sets,
        // and an event's line reaches the screen through `Event.Speak` -> `Game1.drawDialogue` -> a DialogueBox on
        // `Game1.activeClickableMenu` (`Game1.cs:9539-9545`), which is the object both handlers read.
        ActorWorldFacts eventBox = Facts(eventUp: true, menuType: "DialogueBox", dialogueUp: false);
        string question = WorldModel.DescribeHeldBody(
            WorldModel.Classify(eventBox), eventBox, canMove: false, hold: BodyHoldFact.Free, modalIsQuestion: true).Evidence;
        question.Should().Contain("dialogue_box=true");
        question.Should().Contain(
            "admissible_actions=answer_dialogue;can_move=false",
            "a question box is answered, and dismiss_modal refuses the same box by name");

        string informational = WorldModel.DescribeHeldBody(
            WorldModel.Classify(eventBox), eventBox, canMove: false, hold: BodyHoldFact.Free, modalIsQuestion: false).Evidence;
        informational.Should().Contain("dialogue_box=true");
        informational.Should().Contain(
            "admissible_actions=dismiss_modal;can_move=false",
            "an informational box is closed by the native close, and answer_dialogue refuses it by name");

        string unread = WorldModel.DescribeHeldBody(WorldModel.Classify(eventBox), eventBox, canMove: false, hold: BodyHoldFact.Free).Evidence;
        unread.Should().Contain("is_question=unknown");
        unread.Should().Contain(
            "admissible_actions=answer_dialogue,dismiss_modal;can_move=false",
            "an unreadable question flag must not hide the only two actions there are");
    }

    /// <summary>
    /// The split above is tied to the catalog rather than remembered here: the family member this file treats as the one
    /// that ANSWERS is the one whose own registration requires a `responseKey` argument, and the other member closes.
    ///
    /// A renamed or re-registered id must fail HERE, by action id, instead of quietly publishing an admissible action
    /// the handler would refuse - which is the whole defect this episode is about.
    /// </summary>
    [Fact]
    public void TheCutsceneAdmissibleSplit_IsDerivedFromTheCatalog()
    {
        string[] answering = FarmhandActionCatalog.EventActingActionIds
            .Where(actionId => FarmhandActionCatalog.Registrations
                .Single(registration => registration.ActionId == actionId)
                .Descriptor!.Arguments.Any(argument => argument.Name == "responseKey"))
            .ToArray();

        answering.Should().BeEquivalentTo(
            new[] { WorldModel.DialogueAnswerActionId },
            "the event-acting member whose own registration requires a response key is the one that answers a question");
        FarmhandActionCatalog.EventActingActionIds.Should().HaveCount(
            2,
            "the family is one question to answer and one informational box to close; a third member needs a decision here");
    }

    [Fact]
    public void TheTransientEvidenceNamesTheLockAndTheRealRetryWindow()
    {
        ActorWorldFacts facts = Facts(usingTool: true);
        ActorDisposition disposition = WorldModel.Classify(facts);
        disposition.Kind.Should().Be(ActorDispositionKind.Transient);
        disposition.TransientKind.Should().Be("toolAnimation");

        string evidence = WorldModel.DescribeHeldBody(disposition, facts, canMove: true, hold: BodyHoldFact.Free).Evidence;
        evidence.Should().Contain("transient_kind=toolAnimation");
        // The number the Agent is told to wait must be the number the body loop waits (WIA 4.4, <=2000ms), or
        // "retry after 2000 ms" would walk straight back into a live lock.
        evidence.Should().Contain("retry_window_ms=2000");
        evidence.Should().Contain("can_move=true");

        WorldModel.TransientRetryWindowMs.Should().Be(2000, "WIA 4.4 fixes the transient window at <=2000 ms");
    }

    /// <summary>
    /// MEASURED `round86`: `move_to_tile` was refused sixteen times with
    /// <c>transient_kind=movement_lock;retry_window_ms=2000;can_move=false</c> while the game clock stood at day 7 16:40
    /// for four minutes, and the caller re-sent on the window the sentence had promised. MEASURED `round88`: five minutes
    /// of the same stopped clock reported 29 times as <c>held_by=stalled_with_no_holder:CanMove</c>, because nothing
    /// declared the write.
    ///
    /// <para>
    /// The shape is `Classify` saying Idle while `CanMove` is false. What the sentence says is now the DECLARED hold
    /// (<see cref="BodyHold"/>): a bounded hold publishes what is left of its own window and the wait that earns; past
    /// that window it publishes the overrun, because waiting again would promise a window that is gone; an open-ended
    /// hold says it does not know when it ends; and a body the authority never saw is named as the defect it is, with no
    /// <c>admissible_actions=none</c> - the absence is honest, an invented holder is not.
    /// </para>
    /// </summary>
    [Fact]
    public void ACanMoveHoldPublishesTheDeclaredHolderAndNoGuessAtOne()
    {
        ActorWorldFacts facts = Facts();
        ActorDisposition movementLock = WorldModel.Classify(facts);
        movementLock.Kind.Should().Be(ActorDispositionKind.Idle, "the `!CanMove` tail is what makes this a hold");
        movementLock.TransientKind.Should().BeNull();

        // No declared hold: a named dead end, no window claimed, and no claim that nothing at all is admissible.
        (string stalledCode, string stalled) = WorldModel.DescribeHeldBody(movementLock, facts, canMove: false, hold: BodyHoldFact.Free);
        stalledCode.Should().Be("transient_busy", "the code round86's refusals carried; the HOLDER was what was missing");
        stalled.Should().Contain($"held_by={WorldModel.StalledHolderPrefix}{WorldModel.UnnamedHolderEngineFact}");
        stalled.Should().Contain($"defect={WorldModel.HoldWithoutOwnerDefect}");
        stalled.Should().NotContain("admissible_actions=none", "that field claims a measurement nothing here made");
        stalled.Should().Contain($"next_step={WorldModel.ReportTheStalledBodyStep}");
        stalled.Should().NotContain("retry_window_ms", "no timer is running, so no window may be promised");
        stalled.Should().NotContain("movement_lock");

        // A declared timer with a window still to run: waiting is honest and what is left of it is published.
        BodyHoldFact emote = new(BodyHoldState.Held, BodyHold.EmoteHolder, BodyHold.NativeTimerReason, BodyHold.NowMs() + BodyHold.EmoteMs);
        (string pauseCode, string pause) = WorldModel.DescribeHeldBody(movementLock, facts, canMove: false, hold: emote);
        pauseCode.Should().Be("transient_busy");
        pause.Should().Contain($"held_by={BodyHold.EmoteHolder}");
        pause.Should().Contain("hold_remaining_ms=");
        pause.Should().Contain($"next_step={WorldModel.WaitForRetryWindowStep}");
        pause.Should().NotContain("movement_lock");
    }

    /// <summary>
    /// The two shapes a DECLARED hold can turn into, both of which must still offer a way forward: a bounded window that
    /// passed with the flag still down, and an open-ended hold that declared it does not know when it ends.
    /// </summary>
    [Fact]
    public void AnOverrunOrOpenEndedHoldStillNamesAForwardStep()
    {
        ActorDisposition idle = WorldModel.Classify(Facts());

        BodyHoldFact overrun = new(BodyHoldState.Held, BodyHold.EmoteHolder, BodyHold.NativeTimerReason, BodyHold.NowMs() - 1_000);
        string expired = WorldModel.DescribeHeldBody(idle, Facts(), canMove: false, hold: overrun).Evidence;
        expired.Should().Contain($"held_by={BodyHold.EmoteHolder}");
        expired.Should().Contain("hold_overrun_ms=");
        expired.Should().NotContain("hold_remaining_ms", "nothing is left of a window that has passed");
        expired.Should().Contain($"next_step={WorldModel.ReportTheStalledBodyStep}");
        WorldModel.NextStepEndsTheHold(WorldModel.ReportTheStalledBodyStep).Should().BeTrue();

        BodyHoldFact openEnded = new(BodyHoldState.HeldOpen, BodyHold.HolderForSite("Farmer.animateOnce"), BodyHold.UndeclaredWriterReason, null);
        string open = WorldModel.DescribeHeldBody(idle, Facts(), canMove: false, hold: openEnded).Evidence;
        open.Should().Contain($"held_by={BodyHold.HolderForSite("Farmer.animateOnce")}");
        open.Should().Contain("ends_at=none");
        open.Should().Contain("admissible_actions=none");
        open.Should().Contain($"next_step={WorldModel.ReportTheStalledBodyStep}");
    }

    [Fact]
    public void ASingleAnimationIsNamedAsItsOwnTransientWithTheRealRetryWindow()
    {
        // The six sites that take the body by one animation hold it for 400-2000 ms and leave no other declared fact
        // up, so before this fact the only thing a refusal could say was the anonymous `movement_lock`. What the caller
        // gets now is the word for what holds the body and the window the engine actually frees it in.
        ActorWorldFacts facts = Facts(selfAnimation: true);
        ActorDisposition disposition = WorldModel.Classify(facts);
        disposition.Kind.Should().Be(ActorDispositionKind.Transient);
        disposition.TransientKind.Should().Be("selfAnimation");

        string evidence = WorldModel.DescribeHeldBody(disposition, facts, canMove: false, hold: BodyHoldFact.Free).Evidence;
        evidence.Should().Contain("transient_kind=selfAnimation");
        evidence.Should().Contain($"retry_window_ms={WorldModel.TransientRetryWindowMs}");
        evidence.Should().Contain("can_move=false");
        WorldModel.HoldReasonCode(disposition.Kind).Should().Be("transient_busy");
    }

    [Fact]
    public void AWarpIsNamedAsItsOwnTransientWithTheRealRetryWindow()
    {
        // The two sites that take the body for a location transition hold it for the fade's ~580 ms (ScreenFade.cs:38,
        // :70) and leave no other declared fact up, so before this fact a refusal could only say `movement_lock`.
        ActorWorldFacts facts = Facts(warping: true);
        ActorDisposition disposition = WorldModel.Classify(facts);
        disposition.Kind.Should().Be(ActorDispositionKind.Transient);
        disposition.TransientKind.Should().Be("warping");

        string evidence = WorldModel.DescribeHeldBody(disposition, facts, canMove: false, hold: BodyHoldFact.Free).Evidence;
        evidence.Should().Contain("transient_kind=warping");
        evidence.Should().Contain($"retry_window_ms={WorldModel.TransientRetryWindowMs}");
        evidence.Should().Contain("can_move=false");
        WorldModel.HoldReasonCode(disposition.Kind).Should().Be("transient_busy");
    }

    [Fact]
    public void AToolSwingIsNamedAsAToolSwingRatherThanAsAnAnimation()
    {
        // A swing raises the same flag (FarmerSprite.animateOnce), and `toolAnimation` is the more specific word for
        // it - the engine's own guard lists `UsingTool` before the flag for the same reason (Farmer.cs:7948, :7964).
        WorldModel.Classify(Facts(usingTool: true, selfAnimation: true)).TransientKind.Should().Be("toolAnimation");
    }

    [Fact]
    public void ThePassOutEvidenceCarriesTheTwoFactsThatProducedIt()
    {
        ActorWorldFacts facts = Facts(timeOfDay: 2600, stamina: -16f);
        ActorDisposition disposition = WorldModel.Classify(facts);
        disposition.Kind.Should().Be(ActorDispositionKind.PassOut);

        string evidence = WorldModel.DescribeHeldBody(disposition, facts, canMove: false, hold: BodyHoldFact.Free).Evidence;
        // Stamina is written with the invariant culture so a locale with a decimal comma cannot produce an
        // evidence string the Host's parsers split wrongly.
        evidence.Should().Contain("stamina=-16");
        evidence.Should().Contain("time_of_day=2600");
    }
}
