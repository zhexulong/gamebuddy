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
/// (<see cref="WorldModel.HoldReasonCode"/>) and the evidence each one needs (<see cref="WorldModel.DescribeBodyHold"/>);
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
        bool warping = false) =>
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
            Warping: warping);

    [Fact]
    public void ACutsceneHold_NamesTheCutsceneAndWhatEndsItsDialogueBox()
    {
        ActorWorldFacts facts = Facts(eventUp: true, menuType: "DialogueBox", dialogueUp: true);

        string hold = WorldModel.DescribeNavigationHold(facts, canMove: false, modalIsQuestion: false);

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
        string hold = WorldModel.DescribeNavigationHold(Facts(eventUp: true), canMove: false);

        hold.Should().Contain("held_by=cutscene_active");
        hold.Should().Contain("admissible_actions=none");
        hold.Should().Contain(
            "next_step=wait_for_event_to_advance",
            "with no box on screen there is no action at all, and the refusal has to say so or the caller retries");
    }

    [Fact]
    public void AMountedMenuHold_NamesTheMenuAndTheFamilyThatClosesIt()
    {
        string hold = WorldModel.DescribeNavigationHold(Facts(menuType: "GameMenu"), canMove: false);

        hold.Should().Contain("held_by=actor_held_by_modal");
        hold.Should().Contain("modal_type=GameMenu");
        hold.Should().Contain("admissible_actions=");
        hold.Should().Contain("dismiss_modal", "an open menu is cleared by the modal-resolving family, named from the catalog");

        NavigationOutcome outcome = Decide(hold);
        outcome.TerminalReasonCode.Should().Be("destination_locked");
        outcome.Evidence.Should().Contain("held_by=actor_held_by_modal");
    }

    [Fact]
    public void AHoldTheVocabularyCannotName_NamesTheEngineFactRatherThanSayingNothing()
    {
        // No event, no menu, no faint, no animation: the closed vocabulary has no name for this, and the one engine
        // field that reported the hold is `Farmer.CanMove`.
        string hold = WorldModel.DescribeNavigationHold(Facts(), canMove: false);

        hold.Should().Contain("held_by=unknown_holder:CanMove");
        hold.Should().Contain("can_move=false");
        hold.Should().Contain("admissible_actions=none");
        hold.Should().Contain("next_step=");

        NavigationOutcome outcome = Decide(hold);
        outcome.TerminalReasonCode.Should().Be("destination_locked");
        outcome.Evidence.Should().Contain("held_by=unknown_holder:CanMove");
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
        string hold = WorldModel.DescribeNavigationHold(facts, canMove: false);

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
        string hold = WorldModel.DescribeNavigationHold(Facts(selfAnimation: true), canMove: false);

        hold.Should().Contain("held_by=transient_busy");
        hold.Should().Contain("transient_kind=selfAnimation");
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
