using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// Nothing in the Mod gated on stamina before this. `WorldModel.Classify` reports `PassOut` at or below -15,
/// which is the state AFTER the faint - correct as a disposition, useless as a precondition. The engine does not
/// refuse a swing for lack of stamina; it lets stamina run negative and faints the actor, which halves next
/// day's stamina. For a companion running a multi-day routine that is the end of the routine, not a local loss.
///
/// These cases pin the guard's boundary, including the two shapes that are easy to get wrong: an actor already
/// at the floor (refuse before touching the world) and a clear that lands EXACTLY on the floor (which is not
/// affording it - it is surviving it once).
/// </summary>
public sealed class ClearStaminaGuardTests
{
    [Fact]
    public void ACheapClearOnAFullActorIsAllowed()
    {
        ClearStaminaVerdict verdict = ClearStaminaGuard.Check(currentStamina: 270f, expectedClearCost: 2f);

        verdict.Allowed.Should().BeTrue();
        verdict.ReasonCode.Should().Be("stamina_available");
    }

    [Fact]
    public void AFreeClearIsStillRefusedWhenTheActorIsAlreadyAtTheFloor()
    {
        // Even a zero-cost clear touches the world, and the actor would be at the floor either way. Refuse first.
        ClearStaminaVerdict verdict = ClearStaminaGuard.Check(
            currentStamina: ClearStaminaGuard.MinimumStaminaAfterClear,
            expectedClearCost: 0f);

        verdict.Allowed.Should().BeFalse();
        verdict.ReasonCode.Should().Be("insufficient_stamina");
    }

    [Fact]
    public void AClearThatLandsExactlyOnTheFloorIsRefused()
    {
        // 7 - 2 = 5, exactly the floor. That is "survived it once", not "afforded it": there is nothing left to
        // walk home, open a door or reach a bed with.
        ClearStaminaVerdict verdict = ClearStaminaGuard.Check(
            currentStamina: ClearStaminaGuard.MinimumStaminaAfterClear + 2f,
            expectedClearCost: 2f);

        verdict.Allowed.Should().BeFalse("landing exactly on the floor is not a margin");
        verdict.ReasonCode.Should().Be("insufficient_stamina");
    }

    [Fact]
    public void OnePointAboveTheFloorIsAllowed()
    {
        ClearStaminaVerdict verdict = ClearStaminaGuard.Check(
            currentStamina: ClearStaminaGuard.MinimumStaminaAfterClear + 2.5f,
            expectedClearCost: 2f);

        verdict.Allowed.Should().BeTrue();
    }

    [Fact]
    public void TheRefusalCarriesTheNumbersThatDecidedIt()
    {
        // stamina 4 is already at or below the floor, so the FIRST branch answers and the expected cost is not part
        // of the decision - that is the honest evidence: "you cannot afford ANY clear right now", not "this one
        // costs 6 and you have 4".
        ClearStaminaVerdict alreadyAtFloor = ClearStaminaGuard.Check(currentStamina: 4f, expectedClearCost: 6f);

        alreadyAtFloor.Allowed.Should().BeFalse();
        alreadyAtFloor.Evidence.Should().Contain("stamina=4");
        alreadyAtFloor.Evidence.Should().Contain("required_after=5");
        alreadyAtFloor.Evidence.Should().Contain("expected_cost=0", "nothing is affordable, so no cost was considered");

        // Above the floor but short of the margin: THIS is the branch where the price matters.
        ClearStaminaVerdict shortOfMargin = ClearStaminaGuard.Check(currentStamina: 6f, expectedClearCost: 3f);

        shortOfMargin.Allowed.Should().BeFalse();
        shortOfMargin.Evidence.Should().Contain("stamina=6");
        shortOfMargin.Evidence.Should().Contain("expected_cost=3");
        shortOfMargin.Evidence.Should().Contain("required_after=5");
    }

    [Fact]
    public void TheGuardSitsWellAboveTheEnginePassOutFloor()
    {
        // The product line is not the engine's faint line. `WorldModel.PassOutStaminaFloor` is -15 (Game1.cs:6452)
        // and that is where the actor has ALREADY fainted, so a guard pinned there would authorise exactly the clear
        // that causes the faint. Core cannot reference the Mod project that holds that constant, so the fact is
        // pinned here as a number with its source, and the two are read together by anyone editing either.
        ClearStaminaGuard.MinimumStaminaAfterClear.Should().BeGreaterThan(0f);
        ClearStaminaGuard.MinimumStaminaAfterClear.Should().BeGreaterThan(-15f, "the floor is where the faint already happened");
    }
}
