using System;
using FluentAssertions;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// The declared body hold as a state machine: <c>free</c> / <c>held(holder, endsAt)</c> / <c>held-open(holder)</c>.
///
/// <para>
/// WHY A STATE MACHINE AND NOT A LOG. MEASURED `round88`: the game clock stood still for five minutes while 29 receipts
/// said <c>held_by=stalled_with_no_holder:CanMove</c>, because nothing declared who wrote the flag. The three states are
/// the three answers that stop being an absence, and the transitions between them are the whole contract:
/// <see cref="BodyHold.TryHold"/> enters one, <see cref="BodyHold.Release"/> leaves it, and the three declarations it
/// REFUSES are the states this Mod cannot represent - above all `held-open` with nobody in it.
/// </para>
///
/// <para>
/// Every assertion here is on the authority itself, so the same table is what the receipts read: the sentence builder
/// (<see cref="WorldModel.DescribeHeldBody(in ActorWorldFacts, bool, BodyHoldFact, bool?)"/>) takes the fact these tests
/// produce rather than looking it up, which is what lets a shape be examined without a game.
/// </para>
/// </summary>
[Collection(BodyHoldLedgerGates.Name)]
public sealed class BodyHoldTests : IDisposable
{
    private readonly BodyHoldFact andNothingBefore = BodyHold.DescribeBodyHold();

    public BodyHoldTests() => BodyHold.Reset();

    public void Dispose() => BodyHold.Reset();

    private const string HolderA = "body_pause:emote";
    private const string HolderB = BodyHold.NativeWriterHolderPrefix + "Farmer.animateOnce";

    [Fact]
    public void AFreeBodyHasNoHolderAndNoWindow()
    {
        // The starting state, spelled rather than left as an absence: `default(BodyHoldFact)` is the same value, so a
        // caller that forgot to pass the ledger reads as free and the sentence then names the defect.
        BodyHold.DescribeBodyHold().Should().Be(BodyHoldFact.Free);
        BodyHold.DescribeBodyHold().Holder.Should().BeNull();
        BodyHold.DescribeBodyHold().RemainingMs(BodyHold.NowMs()).Should().BeNull();
        andNothingBefore.IsFree.Should().BeTrue("the suite starts from a body nothing has taken");
    }

    [Fact]
    public void TryHoldDeclaresABoundedHoldWithItsOwnWindow()
    {
        long endsAt = BodyHold.NowMs() + BodyHold.EmoteMs;

        BodyHold.TryHold(HolderA, BodyHold.NativeTimerReason, endsAt).Should().BeTrue();

        BodyHoldFact hold = BodyHold.DescribeBodyHold();
        hold.State.Should().Be(BodyHoldState.Held);
        hold.Holder.Should().Be(HolderA);
        hold.Reason.Should().Be(BodyHold.NativeTimerReason);
        hold.EndsAtMs.Should().Be(endsAt);
        hold.RemainingMs(BodyHold.NowMs()).Should().BeInRange(1, BodyHold.EmoteMs);
    }

    [Fact]
    public void TryHoldWithNoDeadlineDeclaresAnOpenEndedHoldThatNamesItsHolder()
    {
        // The legal `held-open`: it does not know when it ends, and it says who holds it anyway. This is the state a
        // fourth native site reaches, and the reason it is not the same thing as the absence.
        BodyHold.TryHold(HolderB, BodyHold.UndeclaredWriterReason, endsAtMs: null).Should().BeTrue();

        BodyHoldFact hold = BodyHold.DescribeBodyHold();
        hold.State.Should().Be(BodyHoldState.HeldOpen);
        hold.Holder.Should().Be(HolderB);
        hold.EndsAtMs.Should().BeNull();
        hold.RemainingMs(BodyHold.NowMs()).Should().BeNull("an open-ended hold promises no window");
    }

    [Fact]
    public void AHoldWithNoOwnerCannotExist()
    {
        // The one state this Mod cannot represent. It is refused HERE, loudly, instead of being created and published as
        // `held-open` with nobody in it - which is the shape a receipt could not act on.
        BodyHold.TryHold(string.Empty, BodyHold.NativeTimerReason, BodyHold.NowMs() + 200).Should().BeFalse();
        BodyHold.TryHold("   ", BodyHold.NativeTimerReason, endsAtMs: null).Should().BeFalse();
        BodyHold.TryHold(HolderA, string.Empty, endsAtMs: null).Should().BeFalse("a hold owes a reason as well as a holder");

        BodyHold.DescribeBodyHold().Should().Be(BodyHoldFact.Free);
        BodyHold.Counts.Refused.Should().Be(3);
        BodyHold.Counts.Declared.Should().Be(0);
    }

    [Fact]
    public void AWindowThatHasAlreadyEndedIsNotAHold()
    {
        BodyHold.TryHold(HolderA, BodyHold.NativeTimerReason, BodyHold.NowMs() - 1).Should().BeFalse();
        BodyHold.DescribeBodyHold().Should().Be(BodyHoldFact.Free);
    }

    [Fact]
    public void ReleasingAHoldEndsItAndNothingElse()
    {
        BodyHold.TryHold(HolderA, BodyHold.NativeTimerReason, BodyHold.NowMs() + 200).Should().BeTrue();

        BodyHold.Release(HolderB).Should().BeFalse("a site that never took the body cannot free it");
        BodyHold.DescribeBodyHold().Holder.Should().Be(HolderA);

        BodyHold.Release(HolderA).Should().BeTrue();
        BodyHold.DescribeBodyHold().Should().Be(BodyHoldFact.Free);
        BodyHold.Release(HolderA).Should().BeFalse("releasing a hold that is gone ends nothing");
    }

    [Fact]
    public void ASecondHolderCannotTakeABodyThatIsAlreadyDeclared()
    {
        // The incumbent keeps the body: the ledger answers with the holder it already has rather than with whoever wrote
        // last, because a write inside someone else's hold is that hold still running.
        BodyHold.TryHold(HolderA, BodyHold.NativeTimerReason, BodyHold.NowMs() + 200).Should().BeTrue();

        BodyHold.TryHold(HolderB, BodyHold.UndeclaredWriterReason, endsAtMs: null).Should().BeFalse();

        BodyHold.DescribeBodyHold().Holder.Should().Be(HolderA);
        BodyHold.Counts.Refused.Should().Be(1);
    }

    [Fact]
    public void TheSameHolderRedefiningItsOwnHoldRefreshesTheWindow()
    {
        long first = BodyHold.NowMs() + 200;
        long second = first + 1_000;
        BodyHold.TryHold(HolderA, BodyHold.NativeTimerReason, first).Should().BeTrue();
        BodyHold.TryHold(HolderA, BodyHold.NativeTimerReason, second).Should().BeTrue();

        BodyHold.DescribeBodyHold().EndsAtMs.Should().Be(second);
        BodyHold.Counts.Declared.Should().Be(2);
        BodyHold.Counts.Refused.Should().Be(0);
    }

    [Fact]
    public void TheCountsPublishWhatTheProbeSaw()
    {
        // A probe that observes nothing and a body nothing ever takes are the same silence, so the counts are part of the
        // authority rather than a log line: `EngineLoopProbe` wrote `frames=0` for a whole run and nothing could tell why.
        BodyHold.TryHold(HolderA, BodyHold.NativeTimerReason, BodyHold.NowMs() + 200);
        BodyHold.NoteWriteObserved(attributedToDeclaredHold: true);
        BodyHold.NoteWriteObserved(attributedToDeclaredHold: true);
        BodyHold.NoteWriteObserved(attributedToDeclaredHold: false);
        BodyHold.Release(HolderB);

        BodyHold.Counts.Should().Be(new BodyHoldCounts(Declared: 1, Attributed: 2, Undeclared: 1, Refused: 1));
    }

    [Fact]
    public void ANativeWritersHolderWordIsTheSitePrefixedForTheVocabulary()
    {
        // The word a fourth site arrives under: the frame that wrote the flag, prefixed so it cannot collide with a holder
        // this Mod declares itself (`body_pause:*`).
        BodyHold.HolderForSite("Farmer.animateOnce").Should().Be("native:Farmer.animateOnce");
        BodyHold.HolderForSite("Farmer.animateOnce").Should().StartWith(BodyHold.NativeWriterHolderPrefix);
    }
}
