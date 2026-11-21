using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Navigation;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// What `destination_locked` is allowed to say.
///
/// <para>
/// The refusal used to carry `destination=&lt;label&gt;;actionable=false` and nothing else, so a cutscene, an open menu,
/// a faint and a tool swing all read as the same word. Measured from a live run's settlement digests: a companion that
/// wanted to leave the farm for town was refused twice as `destination_locked` and stayed on the farm for two in-game
/// days, because the only response the evidence left open was the same request again.
/// </para>
/// <para>
/// The holder is not re-derived here. <see cref="WorldModel"/> already owns the closed set of holding dispositions
/// (<see cref="WorldModel.HoldReasonCode"/>) and the evidence each one needs (<see cref="WorldModel.DescribeHeldBody"/>);
/// the navigation refusal publishes that same answer as `held_by=` beside the code it already had.
/// </para>
/// </summary>
public sealed class NavigationHoldEvidenceTests
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
    public void ACutsceneHold_NamesTheCutsceneAndWhatEndsItsDialogueBox()
    {
        ActorWorldFacts facts = Facts(eventUp: true, menuType: "DialogueBox", dialogueUp: true);

        string hold = WorldModel.DescribeHeldBody(facts, canMove: false, modalIsQuestion: false).Evidence;

        hold.Should().Contain("held_by=cutscene_active");
        hold.Should().Contain("dialogue_box=true");
        hold.Should().Contain(
            "admissible_actions=dismiss_modal;",
            "an informational cutscene box is closed by the native close; `answer_dialogue` refuses that same box by "
            + "name, so naming it here is what made the caller try an action that could not run");

        NavigationOutcome outcome = Decide(hold);
        outcome.TerminalReasonCode.Should().Be("destination_locked");
        outcome.Evidence.Should().Contain(hold);
        outcome.Evidence.Should().StartWith("destination=Desert;actionable=false;held_by=cutscene_active");
    }

    [Fact]
    public void ACutsceneWithNothingOnScreen_SaysWaitedIsAllThatIsLeft()
    {
        string hold = WorldModel.DescribeHeldBody(Facts(eventUp: true), canMove: false).Evidence;

        hold.Should().Contain("held_by=cutscene_active");
        hold.Should().Contain("admissible_actions=none");
        hold.Should().Contain(
            "next_step=wait_for_event_to_advance",
            "with no box on screen there is no action at all, and the refusal has to say so or the caller retries");
    }

    [Fact]
    public void AMountedMenuHold_NamesTheMenuAndTheFamilyThatClosesIt()
    {
        string hold = WorldModel.DescribeHeldBody(Facts(menuType: "GameMenu"), canMove: false).Evidence;

        hold.Should().Contain("held_by=actor_held_by_modal");
        hold.Should().Contain("modal_type=GameMenu");
        hold.Should().Contain("admissible_actions=");
        hold.Should().Contain("dismiss_modal", "an open menu is cleared by the modal-resolving family, named from the catalog");

        NavigationOutcome outcome = Decide(hold);
        outcome.TerminalReasonCode.Should().Be("destination_locked");
        outcome.Evidence.Should().Contain("held_by=actor_held_by_modal");
    }

    [Fact]
    public void AFlagWithNothingRunningIsANamedDeadEndRatherThanAShrugThatLoops()
    {
        // No event, no menu, no faint, no animation, no countdown: the closed vocabulary has no name for this, and the
        // one engine field that reported the hold is `Farmer.CanMove`. round83 read this shape twice as
        // `unknown_holder:CanMove;...;next_step=observe_again` and then did exactly that for seven minutes.
        string hold = WorldModel.DescribeHeldBody(Facts(), canMove: false).Evidence;

        hold.Should().Contain("held_by=stalled_with_no_holder:CanMove");
        hold.Should().Contain("can_move=false");
        hold.Should().Contain("admissible_actions=none");
        hold.Should().Contain(
            $"next_step={WorldModel.ReportTheStalledBodyStep}",
            "nothing in this Mod ends a hold the facts cannot name, so the one step left ends the attempt");
        hold.Should().NotContain("observe_again", "the read that produced the refusal is not a forward action");

        NavigationOutcome outcome = Decide(hold);
        outcome.TerminalReasonCode.Should().Be("destination_locked");
        outcome.Evidence.Should().Contain("held_by=stalled_with_no_holder:CanMove");
    }

    /// <summary>
    /// The one native countdown that writes `CanMove = false` while declaring no hold of its own is read rather than
    /// guessed: `Farmer.noMovementPause` (Farmer.cs:7586-7593), which `express_emote` raises for 200 ms.
    /// </summary>
    [Fact]
    public void ANativeBodyPauseNamesTheCountdownAndTheWindowThatClearsIt()
    {
        string hold = WorldModel.DescribeHeldBody(Facts(), canMove: false, bodyPauseRemainingMs: 200).Evidence;

        hold.Should().Contain("held_by=body_pause:noMovementPause");
        hold.Should().Contain("body_pause_remaining_ms=200");
        hold.Should().Contain("admissible_actions=none");
        hold.Should().Contain($"next_step={WorldModel.WaitForRetryWindowStep}");

        NavigationOutcome outcome = Decide(hold);
        outcome.TerminalReasonCode.Should().Be("destination_locked");
        outcome.Evidence.Should().Contain("held_by=body_pause:noMovementPause");
    }

    /// <summary>
    /// The countdown is a live probe and not a disposition fact: `noMovementPause` is only ever consulted when the flag
    /// is actually down, so a farmer who can move is never reported as paused.
    /// </summary>
    [Fact]
    public void ABodyPauseDoesNotHoldAnActorWhoCanMove()
    {
        string hold = WorldModel.DescribeHeldBody(Facts(), canMove: true, bodyPauseRemainingMs: 200).Evidence;

        hold.Should().NotContain("held_by=body_pause", "a pause that has elapsed while the flag is up is not a hold");
    }

    /// <summary>
    /// Every hold this unit can name keeps the code and the terminal state callers already handle: what changed is the
    /// evidence beside them, and nothing else.
    /// </summary>
    [Theory]
    [InlineData(true, null, true)]
    [InlineData(true, null, false)]
    [InlineData(false, "GameMenu", false)]
    [InlineData(false, null, false)]
    public void EveryHoldKeepsTheCodeAndTheTerminalState(bool eventUp, string? menuType, bool dialogueUp)
    {
        ActorWorldFacts facts = Facts(eventUp: eventUp, menuType: menuType, dialogueUp: dialogueUp);
        string hold = WorldModel.DescribeHeldBody(facts, canMove: false).Evidence;

        NavigationOutcome outcome = Decide(hold);

        outcome.State.Should().Be(ExecutionState.Rejected);
        outcome.TerminalReasonCode.Should().Be("destination_locked");
        outcome.NextLeg.Should().BeNull();
        outcome.Evidence.Should().Contain("actionable=false");
        outcome.Evidence.Should().Contain("held_by=");
    }

    /// <summary>
    /// A body taken by its own animation says so, and says how long it lasts: the navigation refusal's countermeasure
    /// (`next_step=wait_for_retry_window`) is the one thing the caller can act on, and it must not be a retry.
    /// </summary>
    [Fact]
    public void ASingleAnimationHoldSaysToWaitForTheWindowRatherThanToRetry()
    {
        string hold = WorldModel.DescribeHeldBody(Facts(selfAnimation: true), canMove: false).Evidence;

        hold.Should().Contain("held_by=transient_busy");
        hold.Should().Contain("transient_kind=selfAnimation");
        hold.Should().Contain($"retry_window_ms={WorldModel.TransientRetryWindowMs}");
        hold.Should().Contain("admissible_actions=none");
        hold.Should().Contain("next_step=wait_for_retry_window");

        NavigationOutcome outcome = Decide(hold);
        outcome.TerminalReasonCode.Should().Be("destination_locked");
        outcome.Evidence.Should().Contain("held_by=transient_busy");
    }

    /// <summary>
    /// A body taken by a location transition says so, and says how long it lasts: the caller's one option is to wait the
    /// engine's own fade out, not to re-issue the request.
    /// </summary>
    [Fact]
    public void AWarpHoldSaysToWaitForTheWindowRatherThanToRetry()
    {
        string hold = WorldModel.DescribeHeldBody(Facts(warping: true), canMove: false).Evidence;

        hold.Should().Contain("held_by=transient_busy");
        hold.Should().Contain("transient_kind=warping");
        hold.Should().Contain($"retry_window_ms={WorldModel.TransientRetryWindowMs}");
        hold.Should().Contain("admissible_actions=none");
        hold.Should().Contain("next_step=wait_for_retry_window");

        NavigationOutcome outcome = Decide(hold);
        outcome.TerminalReasonCode.Should().Be("destination_locked");
        outcome.Evidence.Should().Contain("held_by=transient_busy");
    }

    /// <summary>An actionable player is not locked: the new branch must not swallow the walk it guards.</summary>
    [Fact]
    public void AnActionablePlayerIsNotRefusedAsLocked()
    {
        NavigationOutcome? outcome = NavigationOutcomeDecider.DecideTerminalBeforeRouting(
            Resolution(),
            View(null));

        outcome.Should().BeNull();
    }

    private static NavigationDestinationResolution Resolution()
    {
        NavigationDestinationBinding binding = new("stardew", "Desert", "generation_01", 1);
        return new NavigationDestinationResolution(binding, binding, "Desert", null);
    }

    private static NavigationOutcome Decide(string hold) =>
        NavigationOutcomeDecider.DecideTerminalBeforeRouting(Resolution(), View(hold))!;

    private static NavigationWorldView View(string? hold) => new(
        HasLivePlayer: true,
        PlayerHold: hold,
        CurrentSourceLocation: "BusStop",
        SourceX: 4,
        SourceY: 4,
        AtDestination: false,
        OrdinaryLegs: new[] { new NavigationTransitionLeg("Desert", 4, 4, 8, 8, IsDoor: false) },
        BoundaryExcludesDestination: false,
        DestinationTemporarilyUnavailable: false,
        TransitionAmbiguousOrUnknown: false,
        UncorrelatedTransition: false);
}
