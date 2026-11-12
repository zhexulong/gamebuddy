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
        bool minigame = false)
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
            minigame);

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
}
