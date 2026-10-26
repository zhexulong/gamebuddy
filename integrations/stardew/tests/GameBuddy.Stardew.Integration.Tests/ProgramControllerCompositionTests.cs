using System;
using FluentAssertions;
using GameBuddy.Stardew.Core.BodyPrograms;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// Which journal-open statuses get a controller.
///
/// This is not a wiring detail. `FarmhandBodyProgramController.Update()` is the only loop that can run the
/// aged-out abandonment that clears a `RecoveryRequired` authority, so excluding `RecoveryRequired` from this set
/// removes the sole writer able to heal the state it is refusing to work in.
///
/// Measured 2026-10-26: a single expired `move_to_tile` dispatch settled node n04 of
/// `plan_285_35ecf38667989229` to RecoveryRequired. From then on every `stardew_plan_work` submission answered
/// `{"accepted":false,"submitted":"quarantined"}` — 37 of them — the journal still held `abandoned` event count
/// zero thirteen minutes later, and the companion could not walk to its bed:
///
///     天黑了。我在这儿坐着，起不了身——连回屋躺下这一步都发不出去。
///
/// The statuses that stay out are the ones with no write to make: a journal that cannot be read, and a write that
/// already failed. Composing a controller for those would promise a mutation the store just refused.
/// </summary>
public sealed class ProgramControllerCompositionTests
{
    [Theory]
    [InlineData(BodyProgramJournalOpenStatus.Empty)]
    [InlineData(BodyProgramJournalOpenStatus.Opened)]
    [InlineData(BodyProgramJournalOpenStatus.RecoveryRequired)]
    public void AStatusWithWorkToDoGetsAController(BodyProgramJournalOpenStatus status)
    {
        ModEntry.ShouldComposeBodyProgramController(status).Should().BeTrue(
            $"{status} is a state the controller can still move out of");
    }

    [Theory]
    [InlineData(BodyProgramJournalOpenStatus.Corrupt)]
    [InlineData(BodyProgramJournalOpenStatus.PersistenceReadFailed)]
    [InlineData(BodyProgramJournalOpenStatus.PersistenceWriteFailed)]
    public void AStatusWithNoWriteToMakeGetsNoController(BodyProgramJournalOpenStatus status)
    {
        ModEntry.ShouldComposeBodyProgramController(status).Should().BeFalse(
            $"{status} leaves nothing the controller could write");
    }

    [Fact]
    public void EveryStatusIsClassified()
    {
        // Derived from the enum, so adding a status without deciding whether it gets a controller fails here rather
        // than defaulting into whichever branch the switch happened to have.
        foreach (BodyProgramJournalOpenStatus status in Enum.GetValues<BodyProgramJournalOpenStatus>())
        {
            bool composed = ModEntry.ShouldComposeBodyProgramController(status);
            bool withWorkToDo = status is BodyProgramJournalOpenStatus.Empty
                or BodyProgramJournalOpenStatus.Opened
                or BodyProgramJournalOpenStatus.RecoveryRequired;
            composed.Should().Be(withWorkToDo, $"every status needs a decided answer; {status} had none");
        }
    }
}
