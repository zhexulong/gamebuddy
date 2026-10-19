using FluentAssertions;
using GameBuddy.Stardew;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The engine's own profession-pair rule, pinned once for both sides that depend on it.
///
/// Why this exists as a test of its own: `respond_level_up` writes the id a `branch_a`/`branch_b` choice names, and the
/// observation projection shows the companion the two candidates. If those two derivations ever disagreed, the companion
/// would choose from one pair and the action would write the other - a permanent, synced save write taken from a card it
/// was not shown. They share <c>LevelUpProfessionPair</c>, and this pins the rule itself:
/// <c>LevelUpMenu.cs:421-437</c>, level 5 offering <c>skill*6 + 0/1</c> and level 10 continuing the level-5 choice with
/// <c>+2/+3</c> when it was the left card and <c>+4/+5</c> otherwise.
/// </summary>
public sealed class LevelUpProfessionPairTests
{
    [Theory]
    [InlineData(0, 5, false, 0, 1)]
    [InlineData(4, 5, false, 24, 25)]
    [InlineData(0, 10, true, 2, 3)]
    [InlineData(4, 10, true, 26, 27)]
    [InlineData(4, 10, false, 28, 29)]
    public void ThePairIsTheEngineOwn(
        int skill,
        int level,
        bool levelFiveBranchChosen,
        int left,
        int right)
    {
        (int Left, int Right) pair = global::GameBuddy.Stardew.ExecutionManager.LevelUpProfessionPair(
            skill,
            level,
            levelFiveBranchChosen);

        pair.Left.Should().Be(left);
        pair.Right.Should().Be(right);
    }

    [Fact]
    public void TheTwoCandidatesAreNeverTheSameCard()
    {
        // A pair that collapsed would let `branch_a` and `branch_b` write the same profession, which is the one outcome
        // a "the companion chose" claim must not be able to produce.
        foreach (int skill in new[] { 0, 1, 2, 3, 4 })
        {
            foreach (bool chosen in new[] { true, false })
            {
                (int left, int right) = global::GameBuddy.Stardew.ExecutionManager.LevelUpProfessionPair(skill, 5, chosen);
                left.Should().NotBe(right);
                (left, right) = global::GameBuddy.Stardew.ExecutionManager.LevelUpProfessionPair(skill, 10, chosen);
                left.Should().NotBe(right);
            }
        }
    }
}
