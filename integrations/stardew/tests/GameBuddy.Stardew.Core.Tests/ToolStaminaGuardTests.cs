using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Core.Tests;

/// <summary>
/// A tool loop that spends stamina it does not have faints the actor, and a faint halves next day's
/// stamina. For a companion running a multi-day routine that is not a local defeat, it is the end of the
/// routine - which is why the check has to run BEFORE the first swing rather than being noticed afterwards.
///
/// Two shapes use the same floor. A known workload (a clump of known health) can name its exact cost; a
/// bounded swing LOOP cannot, because it stops when the target falls and the caller only knows its cap.
/// For the loop the caller supplies the worst case it is willing to spend, which is the cap itself - so the
/// same predicate answers both, and neither can drift from the other.
/// </summary>
public sealed class ToolStaminaGuardTests
{
    [Fact]
    public void ACheapWorkloadOnAFullActorIsAllowed()
    {
        ToolStaminaVerdict verdict = ToolStaminaGuard.Check(currentStamina: 270f, expectedCost: 2f);

        verdict.Allowed.Should().BeTrue();
        verdict.ReasonCode.Should().Be("stamina_available");
    }

    [Fact]
    public void AFreeWorkloadIsStillRefusedWhenTheActorIsAlreadyAtTheFloor()
    {
        // Even a zero-cost swing touches the world, and the actor would be at the floor either way.
        ToolStaminaVerdict verdict = ToolStaminaGuard.Check(
            currentStamina: ToolStaminaGuard.MinimumStaminaAfterWorkload,
            expectedCost: 0f);

        verdict.Allowed.Should().BeFalse();
        verdict.ReasonCode.Should().Be("insufficient_stamina");
    }

    [Fact]
    public void AWorkloadThatLandsExactlyOnTheFloorIsRefused()
    {
        // 7 - 2 = 5, exactly the floor. That is "survived it once", not "afforded it": nothing is left to
        // walk home, open a door or reach a bed with.
        ToolStaminaVerdict verdict = ToolStaminaGuard.Check(
            currentStamina: ToolStaminaGuard.MinimumStaminaAfterWorkload + 2f,
            expectedCost: 2f);

        verdict.Allowed.Should().BeFalse("landing exactly on the floor is not a margin");
        verdict.ReasonCode.Should().Be("insufficient_stamina");
    }

    [Fact]
    public void OnePointAboveTheFloorIsAllowed()
    {
        ToolStaminaVerdict verdict = ToolStaminaGuard.Check(
            currentStamina: ToolStaminaGuard.MinimumStaminaAfterWorkload + 2.5f,
            expectedCost: 2f);

        verdict.Allowed.Should().BeTrue();
    }

    [Fact]
    public void TheRefusalCarriesTheNumbersThatDecidedIt()
    {
        // Already at or below the floor: nothing is affordable, so no cost was considered - and the evidence
        // says exactly that rather than pretending a price was weighed.
        ToolStaminaVerdict alreadyAtFloor = ToolStaminaGuard.Check(currentStamina: 4f, expectedCost: 6f);

        alreadyAtFloor.Allowed.Should().BeFalse();
        alreadyAtFloor.Evidence.Should().Contain("stamina=4");
        alreadyAtFloor.Evidence.Should().Contain("required_after=5");
        alreadyAtFloor.Evidence.Should().Contain("expected_cost=0", "nothing is affordable, so no cost was considered");

        // Above the floor but short of the margin: THIS is the branch where the price matters.
        ToolStaminaVerdict shortOfMargin = ToolStaminaGuard.Check(currentStamina: 6f, expectedCost: 3f);

        shortOfMargin.Allowed.Should().BeFalse();
        shortOfMargin.Evidence.Should().Contain("stamina=6");
        shortOfMargin.Evidence.Should().Contain("expected_cost=3");
        shortOfMargin.Evidence.Should().Contain("required_after=5");
    }

    [Fact]
    public void TheGuardSitsWellAboveTheEnginePassOutFloor()
    {
        // The product line is not the engine's faint line. `WorldModel.PassOutStaminaFloor` is -15 (Game1.cs:6452)
        // and that is where the actor has ALREADY fainted, so a guard pinned there would authorise exactly the
        // workload that causes the faint. Core cannot reference the Mod project that holds that constant, so the
        // fact is pinned here as a number with its source.
        ToolStaminaGuard.MinimumStaminaAfterWorkload.Should().BeGreaterThan(0f);
        ToolStaminaGuard.MinimumStaminaAfterWorkload.Should().BeGreaterThan(-15f, "the floor is where the faint already happened");
    }

    [Fact]
    public void AWorstCaseLoopBudgetIsPricedLikeAnyOtherWorkload()
    {
        // The loop shape: a stump carries 5 health, a basic axe deals 1 per swing, the cap is 12. The caller
        // cannot know it will take 5 swings, so it pre-flights the cap - the most it is willing to spend.
        float perSwing = ToolStaminaGuard.PerSwingCharge(skillLevel: 0, efficient: false);
        perSwing.Should().Be(2f);

        ToolStaminaVerdict affordable = ToolStaminaGuard.Check(270f, perSwing * 12);
        affordable.Allowed.Should().BeTrue();

        // An actor with 20 stamina cannot survive a 24-point worst case even though it might survive the
        // five swings it would actually need. Refusing is the honest answer: the caller cannot promise the
        // shorter path, because the loop stops when the target falls, not when the budget says to.
        ToolStaminaVerdict notAffordable = ToolStaminaGuard.Check(20f, perSwing * 12);
        notAffordable.Allowed.Should().BeFalse();
        notAffordable.Evidence.Should().Contain("expected_cost=24");
    }

    [Theory]
    [InlineData(0, false, 2f)]
    [InlineData(10, false, 1f)]
    [InlineData(0, true, 0f)]
    [InlineData(20, false, 0f)]
    public void ThePerSwingChargeIsTheEngineFormula(int skillLevel, bool efficient, float expected)
    {
        // `2 - skillLevel * 0.1`, zero for the efficient enchantment, floored at zero because the engine never
        // charges a negative amount. One function so the pre-flight estimate and the receipt's
        // `expected_stamina_cost` cannot drift - they name the same formula.
        ToolStaminaGuard.PerSwingCharge(skillLevel, efficient).Should().Be(expected);
    }
}
