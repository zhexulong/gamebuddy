using FluentAssertions;
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
        bool toolCharged = false) =>
        new(
            EventUp: eventUp,
            MenuType: menuType,
            DialogueUp: dialogueUp,
            TimeOfDay: timeOfDay,
            Stamina: stamina,
            FreezePaused: freezePaused,
            Eating: eating,
            UsingTool: usingTool,
            ToolCharged: toolCharged);

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

        string informational = WorldModel.DescribeBodyHold(disposition, facts, canMove: false, modalIsQuestion: false);
        informational.Should().Contain("modal_type=DialogueBox");
        informational.Should().Contain("is_question=false");
        informational.Should().Contain("can_move=false");

        string question = WorldModel.DescribeBodyHold(disposition, facts, canMove: false, modalIsQuestion: true);
        question.Should().Contain("is_question=true");

        // Unknown must read as unknown rather than as "not a question", which would tell the Agent to dismiss
        // a dialogue that is waiting for an answer.
        string unknown = WorldModel.DescribeBodyHold(disposition, facts, canMove: false);
        unknown.Should().Contain("is_question=unknown");
    }

    [Fact]
    public void TheTransientEvidenceNamesTheLockAndTheRealRetryWindow()
    {
        ActorWorldFacts facts = Facts(usingTool: true);
        ActorDisposition disposition = WorldModel.Classify(facts);
        disposition.Kind.Should().Be(ActorDispositionKind.Transient);
        disposition.TransientKind.Should().Be("toolAnimation");

        string evidence = WorldModel.DescribeBodyHold(disposition, facts, canMove: true);
        evidence.Should().Contain("transient_kind=toolAnimation");
        // The number the Agent is told to wait must be the number the body loop waits (WIA 4.4, <=2000ms), or
        // "retry after 2000 ms" would walk straight back into a live lock.
        evidence.Should().Contain("retry_window_ms=2000");
        evidence.Should().Contain("can_move=true");

        WorldModel.TransientRetryWindowMs.Should().Be(2000, "WIA 4.4 fixes the transient window at <=2000 ms");
    }

    [Fact]
    public void AMovementLockTheFactsCannotNameIsStillNamedHonestly()
    {
        // The one hold the facts cannot narrow down: the disposition says Transient but no eating/tool/freeze
        // fact produced it, so something else native (a knockback, a warp transition) took CanMove away. It
        // must read as a transient with an honest label, not as one of the holds it is not.
        ActorDisposition movementLock = WorldModel.Classify(Facts()) with { Kind = ActorDispositionKind.Transient };
        movementLock.TransientKind.Should().BeNull();

        string evidence = WorldModel.DescribeBodyHold(movementLock, Facts(), canMove: false);
        evidence.Should().Contain("transient_kind=movement_lock");
        evidence.Should().Contain("can_move=false");
        WorldModel.HoldReasonCode(movementLock.Kind).Should().Be("transient_busy");
    }

    [Fact]
    public void ThePassOutEvidenceCarriesTheTwoFactsThatProducedIt()
    {
        ActorWorldFacts facts = Facts(timeOfDay: 2600, stamina: -16f);
        ActorDisposition disposition = WorldModel.Classify(facts);
        disposition.Kind.Should().Be(ActorDispositionKind.PassOut);

        string evidence = WorldModel.DescribeBodyHold(disposition, facts, canMove: false);
        // Stamina is written with the invariant culture so a locale with a decimal comma cannot produce an
        // evidence string the Host's parsers split wrongly.
        evidence.Should().Contain("stamina=-16");
        evidence.Should().Contain("time_of_day=2600");
    }
}
