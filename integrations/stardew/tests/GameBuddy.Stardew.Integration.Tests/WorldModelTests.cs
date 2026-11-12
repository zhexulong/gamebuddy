using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The WorldModel disposition contract (world-interruption-arbitration.md
/// §1.2 / §4.1 / §4.6): one goal-agnostic per-tick projection over the facts
/// that currently HOLD the actor, computed by the pure ruling
/// <see cref="WorldModel.Classify"/>.
///
/// The split matters: reading the facts off a live Farmer is the thin adapter
/// (<see cref="WorldModel.ReadFacts"/>, pinned by source probes), while the
/// ruling ORDER — the part that must never drift — is exercised here as a pure
/// function. A headless xUnit process has no initialized XNA/SMAPI Game1, so
/// constructing a real Farmer/GameLocation in a test is not a truthful fixture;
/// the pure seam is.
///
/// Priority (native reasons in WorldModel.Classify):
/// Event &gt; Modal &gt; PassOut &gt; Transient &gt; Idle.
/// </summary>
public sealed class WorldModelTests
{
    private static ActorWorldFacts Facts(
        bool eventUp = false,
        string? menuType = null,
        bool dialogueUp = false,
        int timeOfDay = 600,
        float stamina = 270f,
        bool freezePaused = false,
        bool eating = false,
        bool usingTool = false,
        bool toolCharged = false,
        bool selfAnimation = false,
        bool warping = false,
        bool dayTransition = false,
        bool controlsFrozen = false,
        bool minigame = false,
        bool screenFade = false)
        => new(
            eventUp,
            menuType,
            dialogueUp,
            timeOfDay,
            stamina,
            freezePaused,
            eating,
            usingTool,
            toolCharged,
            selfAnimation,
            warping,
            dayTransition,
            controlsFrozen,
            minigame,
            screenFade);

    private static ActorDispositionKind Kind(in ActorWorldFacts facts) => WorldModel.Classify(facts).Kind;

    // ---- PassOut -----------------------------------------------------------

    [Fact]
    public void PassOut_WhenStaminaBelowTheGameFloor()
    {
        ActorDisposition disposition = WorldModel.Classify(Facts(stamina: -20f));

        disposition.Kind.Should().Be(ActorDispositionKind.PassOut);
        disposition.ModalType.Should().BeNull();
        disposition.ModalActionOwned.Should().BeFalse();
        disposition.TransientKind.Should().BeNull();
    }

    [Fact]
    public void PassOut_AtExactlyMinusFifteenStamina_IsTheBoundary()
    {
        // Farmer.Stamina clamps at -16 (decompiled Farmer.cs), so -15 is the
        // engine's "about to faint" line that Game1.cs:6452 acts on.
        Kind(Facts(stamina: -15f)).Should().Be(ActorDispositionKind.PassOut);
        Kind(Facts(stamina: -14.9f)).Should().Be(ActorDispositionKind.Idle);
    }

    [Fact]
    public void PassOut_WhenClockReachesDayEnd()
    {
        Kind(Facts(timeOfDay: 2600)).Should().Be(ActorDispositionKind.PassOut);
        Kind(Facts(timeOfDay: 2590)).Should().Be(ActorDispositionKind.Idle);
    }

    [Fact]
    public void Event_OutranksPassOut_BecauseTheEngineCannotFaintMidCutscene()
    {
        // Native startToPassOut requires `!eventUp` (Game1.cs:6458): reporting
        // pass_out inside a cutscene would invent a world fact the engine does
        // not produce.
        Kind(Facts(eventUp: true, stamina: -20f)).Should().Be(ActorDispositionKind.Event);
        Kind(Facts(eventUp: true, timeOfDay: 2600)).Should().Be(ActorDispositionKind.Event);
    }

    [Fact]
    public void PassOut_OutranksTransient_BecauseTheFaintArmsItsOwnFreeze()
    {
        // startToPassOut arms freezePause=7000 (Game1.cs:6462); if the faint were
        // classified as a transient freeze, the terminal would hide behind its
        // own animation for seven seconds.
        Kind(Facts(stamina: -20f, freezePaused: true)).Should().Be(ActorDispositionKind.PassOut);
    }

    // ---- Event -------------------------------------------------------------

    [Fact]
    public void Event_WhenCutsceneIsUp()
    {
        Kind(Facts(eventUp: true)).Should().Be(ActorDispositionKind.Event);
    }

    [Fact]
    public void Event_WinsOverModal()
    {
        Kind(Facts(eventUp: true, menuType: "DialogueBox")).Should().Be(ActorDispositionKind.Event);
    }

    // ---- Modal -------------------------------------------------------------

    [Fact]
    public void Modal_ReportsTheMenuTypeWithWorldOwnedOwnerByDefault()
    {
        ActorDisposition disposition = WorldModel.Classify(Facts(menuType: "DialogueBox"));

        disposition.Kind.Should().Be(ActorDispositionKind.Modal);
        disposition.ModalType.Should().Be("DialogueBox");
        disposition.ModalActionOwned.Should().BeFalse("no owner lease is registered, so the modal is world-owned");
    }

    [Fact]
    public void Modal_ReportsActionOwned_WhenTheOwnerFenceSaysSo()
    {
        WorldModel.ModalActionOwnedCheck = () => true;
        try
        {
            WorldModel.Classify(Facts(menuType: "DialogueBox")).ModalActionOwned.Should().BeTrue();
        }
        finally
        {
            WorldModel.ModalActionOwnedCheck = null;
        }
    }

    [Fact]
    public void Modal_OutranksPassOut_BecauseAMenuBlocksTheFaint()
    {
        // Native startToPassOut also requires `player.canMove`, and an open menu
        // sets CanMove=false: the engine does not pass out behind a modal.
        Kind(Facts(menuType: "ReadyCheckDialog", stamina: -20f)).Should().Be(ActorDispositionKind.Modal);
    }

    [Fact]
    public void Modal_WhenDialogueOutlivesItsMenu()
    {
        // A dialogue can briefly survive its menu (page turns / SMAPI
        // micro-timing); it is still modal (mirrors
        // machinesanimalsitemsactions.cs:730).
        ActorDisposition disposition = WorldModel.Classify(Facts(dialogueUp: true));
        disposition.Kind.Should().Be(ActorDispositionKind.Modal);
        disposition.ModalType.Should().Be("DialogueBox");
    }

    [Fact]
    public void Modal_OutranksTransient()
    {
        Kind(Facts(menuType: "GameMenu", freezePaused: true)).Should().Be(ActorDispositionKind.Modal);
    }

    // ---- Transient ---------------------------------------------------------

    [Fact]
    public void Transient_FreezePause()
    {
        ActorDisposition disposition = WorldModel.Classify(Facts(freezePaused: true));
        disposition.Kind.Should().Be(ActorDispositionKind.Transient);
        disposition.TransientKind.Should().Be("freezePause");
    }

    [Fact]
    public void Transient_Eating()
    {
        WorldModel.Classify(Facts(eating: true)).TransientKind.Should().Be("eating");
    }

    [Theory]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public void Transient_ToolInUse_And_ChargedTool_AreBothToolAnimation(bool usingTool, bool toolCharged)
    {
        WorldModel.Classify(Facts(usingTool: usingTool, toolCharged: toolCharged))
            .TransientKind.Should().Be("toolAnimation");
    }

    [Fact]
    public void Transient_SelfAnimation()
    {
        // The engine's single-animation pause (FarmerSprite.PauseForSingleAnimation): six native sites take the body
        // for 400-2000 ms through it and leave no other declared fact up.
        ActorDisposition disposition = WorldModel.Classify(Facts(selfAnimation: true));

        disposition.Kind.Should().Be(ActorDispositionKind.Transient);
        disposition.TransientKind.Should().Be("selfAnimation");
        disposition.ModalType.Should().BeNull();
        disposition.ModalActionOwned.Should().BeFalse();
    }

    [Fact]
    public void Transient_Warping()
    {
        // The engine's location transition (Game1.isWarping): two native sites take the body for the fade's ~580 ms and
        // leave no other declared fact up.
        ActorDisposition disposition = WorldModel.Classify(Facts(warping: true));

        disposition.Kind.Should().Be(ActorDispositionKind.Transient);
        disposition.TransientKind.Should().Be("warping");
        disposition.ModalType.Should().BeNull();
        disposition.ModalActionOwned.Should().BeFalse();
    }

    [Fact]
    public void Transient_WarpingOutranksTheAnimationTheWarpItselfClears()
    {
        // The warp's completion clears `PauseForSingleAnimation` BEFORE it clears `_isWarping` (Game1.cs:6269, :6271), so
        // the warp is the outer state: naming the animation there would report the inner lock for a body the warp holds.
        WorldModel.Classify(Facts(warping: true, selfAnimation: true)).TransientKind.Should().Be("warping");
    }

    // ---- Idle --------------------------------------------------------------

    [Fact]
    public void Idle_IsTheDefaultForACleanWorld()
    {
        Kind(Facts()).Should().Be(ActorDispositionKind.Idle);
    }

    [Fact]
    public void Idle_CarriesNoPayload()
    {
        WorldModel.Classify(Facts()).Should().Be(ActorDisposition.Idle);
    }

    // ---- the four facts that close the residual, and where each one ranks -------

    [Fact]
    public void Transient_ScreenFade()
    {
        // The engine's global fade is the other half of its control-input gate (Game1.cs:4286) and clears itself inside
        // the retry window - the caller's own `fadeSpeed` per frame (ScreenFade.cs:149), ~380-830 ms.
        ActorDisposition disposition = WorldModel.Classify(Facts(screenFade: true));

        disposition.Kind.Should().Be(ActorDispositionKind.Transient);
        disposition.TransientKind.Should().Be("screenFade");
        disposition.ModalType.Should().BeNull();
        disposition.ModalActionOwned.Should().BeFalse();
    }

    [Fact]
    public void Event_Minigame_DayTransition_And_ControlsFrozen()
    {
        // Three holds that no tool can shorten and that no transient window describes: a mounted minigame (11 100 ms on
        // the fishing results screen, FishingGame.cs:169), the whole overnight sequence, and the bus ride's control
        // freeze (`forceWarpTimer = 8000`, BusStop.cs:150, plus the drive). They publish the cutscene kind because the
        // countermeasure is its countermeasure - no action can run, nothing to call, wait for the engine to end it - and
        // the evidence names which cause it is (TheSceneHoldNamesItsDriver).
        Kind(Facts(minigame: true)).Should().Be(ActorDispositionKind.Event);
        Kind(Facts(dayTransition: true)).Should().Be(ActorDispositionKind.Event);
        Kind(Facts(controlsFrozen: true)).Should().Be(ActorDispositionKind.Event);
    }

    [Fact]
    public void TheSceneHoldNamesItsDriver()
    {
        // One kind, four engine causes, and the evidence has to say WHICH: `event_up=true` about a bus ride is a fact
        // that is not true, and a reader cannot tell "cutscene" from "bus ride" from it.
        (ActorWorldFacts Facts, string Driver, bool EventUp)[] causes =
        {
            (Facts(eventUp: true), "cutscene", true),
            (Facts(minigame: true), "minigame", false),
            (Facts(dayTransition: true), "day_transition", false),
            (Facts(controlsFrozen: true), "controls_frozen", false),
        };

        foreach ((ActorWorldFacts facts, string driver, bool eventUp) in causes)
        {
            ActorDisposition disposition = WorldModel.Classify(facts);
            disposition.Kind.Should().Be(ActorDispositionKind.Event, $"{driver} must be the Event kind for this table to mean anything");
            string evidence = WorldModel.DescribeBodyHold(disposition, facts, canMove: false);
            evidence.Should().Contain($"driver={driver}");
            evidence.Should().Contain($"event_up={(eventUp ? "true" : "false")}");
            WorldModel.HoldReasonCode(disposition.Kind).Should().Be(
                "cutscene_active",
                "the CODE is still the imprecise one every Event hold publishes: HoldReasonCode is a function of the kind");
        }
    }

    [Fact]
    public void AMountedMinigameOutranksTheMenuTheEngineChecksAfterIt()
    {
        // The engine's own hold list asks about the minigame first (Farmer.cs:7936, before activeClickableMenu at :7940).
        Kind(Facts(minigame: true, menuType: "GameMenu")).Should().Be(ActorDispositionKind.Event);
    }

    [Fact]
    public void AFarmEventLosesToTheMenuItOpens()
    {
        // The birth event's own box and its NAMING MENU are the one thing a caller can act on (BirthingEvent.cs:92).
        Kind(Facts(dayTransition: true, menuType: "NamingMenu")).Should().Be(ActorDispositionKind.Modal);
    }

    [Fact]
    public void AControlFreezeLosesToTheMenuThatIsStillActionable()
    {
        Kind(Facts(controlsFrozen: true, menuType: "GameMenu")).Should().Be(ActorDispositionKind.Modal);
    }

    [Fact]
    public void TheDayTransitionOutranksTheControlFreezeItClearsFirst()
    {
        // The overnight coroutine clears the freeze (Game1.cs:8582) before it mounts the farm event (:8604), so the
        // transition is the outer of the two.
        ActorWorldFacts both = Facts(dayTransition: true, controlsFrozen: true);

        WorldModel.Classify(both).Kind.Should().Be(ActorDispositionKind.Event);
        WorldModel.DescribeBodyHold(WorldModel.Classify(both), both, canMove: false).Should().Contain("driver=day_transition");
    }

    [Fact]
    public void ACutsceneOutranksTheMinigameItContains()
    {
        // An event can start a minigame (Event.cs:12861), and the cutscene is the outer scene of the two.
        ActorWorldFacts both = Facts(eventUp: true, minigame: true);

        WorldModel.Classify(both).Kind.Should().Be(ActorDispositionKind.Event);
        WorldModel.DescribeBodyHold(WorldModel.Classify(both), both, canMove: false).Should().Contain("driver=cutscene");
    }

    [Fact]
    public void TheControlFreezeOutranksTheWarpInsideIt()
    {
        // A bus ride warps at the end of the drive: the freeze is the whole ride, the warp is ~580 ms of it.
        ActorWorldFacts both = Facts(controlsFrozen: true, warping: true);

        WorldModel.Classify(both).Kind.Should().Be(ActorDispositionKind.Event);
        WorldModel.DescribeBodyHold(WorldModel.Classify(both), both, canMove: false).Should().Contain("driver=controls_frozen");
    }
}
