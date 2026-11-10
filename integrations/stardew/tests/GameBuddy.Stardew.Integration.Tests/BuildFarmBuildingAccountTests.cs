using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The account a build receipt publishes, read as arithmetic rather than as source text: `money_delta`
/// and `materials_delta` are the difference of the two readings beside them, so one renderer can say
/// what a build actually spent AND show the zero a refusal owes.
///
/// <para>
/// <c>DescribeBuildFarmBuildingAccount</c> is a pure function of four numbers, so this is the real
/// reading rather than a pin on the file - the live before/after numbers need a wallet and a pack, which
/// is the native-local gate's half. What it refuses is the shape the receipt used to have: a delta
/// written as literal text, which reads as "nothing was spent" on the one path whose purpose was to
/// spend, and cannot be told from a refusal by a caller looking at the receipt.
/// </para>
///
/// <para>
/// It lives outside <c>BuildFarmBuildingPreconditionOrderTests</c> because it drives the Mod assembly,
/// and that file is compiled into the game-free suite (<c>GameBuddy.Stardew.NoGame.Tests</c>), whose
/// whole contract is that it needs <c>GameBuddy.Stardew.Core</c> and nothing else.
/// </para>
/// </summary>
public sealed class BuildFarmBuildingAccountTests
{
    [Fact]
    public void APaidBuildReportsTheGoldAndTheMaterialsItSpent()
    {
        // A 200g commission whose recipe consumes 20 of one material.
        string account = ExecutionManager.DescribeBuildFarmBuildingAccount(
            moneyBefore: 500, moneyAfter: 300, materialsBefore: 40, materialsAfter: 20);

        account.Should().Be(
            "money_before=500;money_after=300;money_delta=-200;materials_before=40;materials_after=20;materials_delta=-20",
            "the deltas name what the build took - the price and the recipe - so the receipt reads as a purchase");
    }

    [Fact]
    public void ARefusedBuildReportsTheZeroTwoEqualReadingsProduce()
    {
        // The refusal path: nothing of this action's spends between the two readings, so both pairs are
        // equal and the delta they produce is zero.
        string account = ExecutionManager.DescribeBuildFarmBuildingAccount(
            moneyBefore: 500, moneyAfter: 500, materialsBefore: 40, materialsAfter: 40);

        account.Should().Be(
            "money_before=500;money_after=500;money_delta=0;materials_before=40;materials_after=40;materials_delta=0",
            "a zero derived from the pair is the only kind a caller can trust on a path that does spend");
    }

    [Fact]
    public void TheDeltaIsThePairAndNotTheOtherWayRound()
    {
        // Ordering: a reading that fell must produce a negative delta. Swapping the subtraction would
        // report a payment as an income and still read as a plausible number.
        ExecutionManager.DescribeBuildFarmBuildingAccount(moneyBefore: 100, moneyAfter: 1, materialsBefore: 5, materialsAfter: 0)
            .Should().Contain("money_delta=-99").And.Contain("materials_delta=-5");
    }
}
