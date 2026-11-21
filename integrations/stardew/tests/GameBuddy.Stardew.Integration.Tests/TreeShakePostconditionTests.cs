using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The pair a <c>shake_tree</c> receipt publishes, and which half of it the engine actually promises.
///
/// <para>
/// MEASURED `round85`: both of the run's <c>shake_tree</c> nodes (<c>plan_483</c> at Forest 57,20 and <c>plan_486</c> at
/// 53,21) settled <c>Uncertain</c>/<c>tree_shake_postcondition_unavailable</c> - so the program went
/// <c>recovery_required</c> - on evidence that read
/// <c>has_seed_before=true;has_seed_after=true;shaken_today=true</c>. The swing had happened. The action was asking for a
/// seed the engine gives only to a full-grown tree shaken by a farmer with foraging 1 or better in multiplayer
/// (<c>Tree.shake</c>, Tree.cs:647, :668, :709), and reporting the engine's own rule as an unproven postcondition.
/// </para>
///
/// <para>
/// The samples below are those two shapes plus the boundaries around them: a drop, a tree already shaken (the engine
/// declines), and a swing that changed neither flag. A postcondition is only worth publishing when the world can say no,
/// so each of those has an answer here.
/// </para>
/// </summary>
public sealed class TreeShakePostconditionTests
{
    [Fact]
    public void AShakeThatLeftTheSeedOnTheTreeIsStillACompletedShake()
    {
        // The live sample, verbatim: a seeded tree, shaken, seed still there because the engine's drop needs foraging 1.
        var measured = new TreeShakePostcondition(
            HasSeedBefore: true,
            HasSeedAfter: true,
            ShakenTodayBefore: false,
            ShakenTodayAfter: true);

        measured.Shaken.Should().BeTrue(
            "the engine's own flag flipped on an accepted call, and that is the only half of the pair a shake guarantees");
        measured.SeedDropped.Should().BeFalse("a seed the engine never promised is an observation, not a failure");
        measured.ReadPoint.Should().Be(PostconditionReadPoint.AfterTheSettle);
        measured.ActionId.Should().Be("shake_tree");
    }

    [Fact]
    public void AShakeThatDroppedTheSeedSaysSoBesideTheFlip()
    {
        var dropped = new TreeShakePostcondition(
            HasSeedBefore: true,
            HasSeedAfter: false,
            ShakenTodayBefore: false,
            ShakenTodayAfter: true);

        dropped.Shaken.Should().BeTrue();
        dropped.SeedDropped.Should().BeTrue("the seed left the tree, and a reader can see the swing paid");
    }

    [Fact]
    public void ATreeWhoseFlagTheEngineDidNotSetWasNotShaken()
    {
        // `Tree.shake`'s guard (:643) skips its whole body while `maxShake != 0`, so neither flag moves: the call was
        // declined and saying `shaken` here would be "nothing changed, therefore success".
        var declined = new TreeShakePostcondition(
            HasSeedBefore: true,
            HasSeedAfter: true,
            ShakenTodayBefore: false,
            ShakenTodayAfter: false);

        declined.Shaken.Should().BeFalse("an unchanged same-day flag is the engine NOT accepting the swing");
        declined.SeedDropped.Should().BeFalse();
    }

    [Fact]
    public void ATreeAlreadyShakenTodayIsNotShakenAgain()
    {
        // The flag is compared, not read once: a tree already carrying it did not flip because of this call.
        var already = new TreeShakePostcondition(
            HasSeedBefore: true,
            HasSeedAfter: true,
            ShakenTodayBefore: true,
            ShakenTodayAfter: true);

        already.Shaken.Should().BeFalse();
    }

    [Fact]
    public void TheSentenceSaysWhichStateMovedAndWhereItWasRead()
    {
        string sentence = new TreeShakePostcondition(
            HasSeedBefore: true,
            HasSeedAfter: true,
            ShakenTodayBefore: false,
            ShakenTodayAfter: true).Describe("shake_tree_019756059144479c", 57, 20);

        sentence.Should().Be(
            "target=shake_tree_019756059144479c;tile=57,20;"
            + "has_seed_before=true;has_seed_after=true;seed_dropped=false;"
            + "shaken_today_before=false;shaken_today=true;"
            + "settle=tree.shake;read=after_the_settle",
            "a pair that does not say when it read the world is the shape `PostconditionReadPoint` exists to refuse");
    }
}
