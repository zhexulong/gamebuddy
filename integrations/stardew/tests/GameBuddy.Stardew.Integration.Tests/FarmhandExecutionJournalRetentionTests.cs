using System;
using System.Collections.Generic;
using System.Linq;
using FluentAssertions;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// ONE SAVE'S JOURNAL IS A BOUNDED COLLECTION, SO IT HAS A DRAIN - AND IT DROPS ONLY WHAT A REPLAY COULD NOT NEED.
///
/// <para>
/// MEASURED `round99`: the app-global payload held 738 records / 1,168,796 B after one run, every admission and every
/// terminal rewrote all of it, and one write cost 8.27 ms. A collection that grows for the whole session and is rewritten
/// whole per action makes every action's cost the session's history, so the drain is not tidying - it is what bounds one
/// action's serialize/deserialize/validate work and what keeps the document away from the capacity ceiling that fails
/// closed. It runs where the payload grows (<c>TryRecordAdmission</c>) and stops at
/// <see cref="FarmhandExecutionJournal.RetainedRecords"/>.
/// </para>
///
/// <para>
/// WHAT MAY GO is two things and only two: a gesture's record (its action cannot change the world, and re-executing it is
/// the same visible outcome) and a settled <c>succeeded</c> receipt (it says the change happened, and a retry observes the
/// world that change produced). WHAT MAY NEVER GO is the population a recovery reads: an admission whose native effect
/// landed without a terminal write, an <c>uncertain</c> settlement, and a rejection a retry must be answered with rather
/// than dispatched again. The tests below assert both directions, because a drain that keeps everything and a drain that
/// keeps nothing are each one assertion away from looking correct.
/// </para>
/// </summary>
public sealed class FarmhandExecutionJournalRetentionTests
{
    private readonly ITestOutputHelper output;

    public FarmhandExecutionJournalRetentionTests(ITestOutputHelper output) => this.output = output;

    /// <summary>
    /// THE FILL-FASTER-THAN-DRAIN CASE: a session that admits as fast as it can still cannot grow the document past the
    /// ceiling, because the drain runs on the write that would grow it.
    /// </summary>
    [Fact]
    public void ASessionThatAppendsFasterThanTheDrainRunsStaysBounded()
    {
        var persistence = new CountingPersistence();
        var journal = new FarmhandExecutionJournal(persistence);
        BridgeScope scope = Scope();
        const int Admissions = 900;

        for (int index = 0; index < Admissions; index++)
        {
            FarmhandExecutionAdmission admission = Admission(scope, index);
            journal.TryRecordAdmission(admission).Code.Should().Be(
                FarmhandExecutionJournalResultCode.Succeeded,
                $"admission {index} must never be refused by a ceiling the drain is supposed to keep away");

            // Every one of them settles `succeeded`, the population the drain may drop.
            journal.TryPersistReceiptTransition(admission, Receipt(admission, ExecutionState.Succeeded)).Code.Should().Be(
                FarmhandExecutionJournalResultCode.Succeeded);

            persistence.Records.Should().BeLessThanOrEqualTo(
                FarmhandExecutionJournal.RetainedRecords + 1,
                $"one action may not grow the document past its retention ceiling (after admission {index})");
        }

        this.output.WriteLine(
            $"admitted {Admissions} went through one bounded document: {persistence.Records} records retained, "
            + $"{journal.LastDrainedRecords} dropped by the last drain, ceiling {FarmhandExecutionJournal.RetainedRecords}");

        persistence.Records.Should().Be(FarmhandExecutionJournal.RetainedRecords + 1, "the drain ran on every append that would exceed the ceiling");
    }

    /// <summary>
    /// THE OTHER DIRECTION: nothing a recovery reads is dropped, even when the document is full of things that could be.
    /// </summary>
    [Fact]
    public void TheDrainKeepsEveryRecordARecoveryCouldNeed()
    {
        var persistence = new CountingPersistence();
        BridgeScope scope = Scope();
        var journal = new FarmhandExecutionJournal(persistence);

        // Fill with droppable records, then record the three kinds that may never go, then force a drain.
        for (int index = 0; index < FarmhandExecutionJournal.RetainedRecords; index++)
        {
            FarmhandExecutionAdmission droppable = Admission(scope, index);
            journal.TryRecordAdmission(droppable).Code.Should().Be(FarmhandExecutionJournalResultCode.Succeeded);
            journal.TryPersistReceiptTransition(droppable, Receipt(droppable, ExecutionState.Succeeded)).Code
                .Should().Be(FarmhandExecutionJournalResultCode.Succeeded);
        }

        FarmhandExecutionAdmission pending = Admission(scope, 10_000);
        FarmhandExecutionAdmission uncertain = Admission(scope, 10_001);
        FarmhandExecutionAdmission rejected = Admission(scope, 10_002);
        journal.TryRecordAdmission(pending).Code.Should().Be(FarmhandExecutionJournalResultCode.Succeeded);
        journal.TryRecordAdmission(uncertain).Code.Should().Be(FarmhandExecutionJournalResultCode.Succeeded);
        journal.TryPersistReceiptTransition(uncertain, Receipt(uncertain, ExecutionState.Uncertain)).Code
            .Should().Be(FarmhandExecutionJournalResultCode.Succeeded);
        journal.TryRecordAdmission(rejected).Code.Should().Be(FarmhandExecutionJournalResultCode.Succeeded);
        journal.TryPersistReceiptTransition(rejected, Receipt(rejected, ExecutionState.Rejected)).Code
            .Should().Be(FarmhandExecutionJournalResultCode.Succeeded);

        // The drain runs on the next admission, and it has to make room by dropping only the settled `succeeded` rows.
        FarmhandExecutionAdmission trigger = Admission(scope, 20_000);
        journal.TryRecordAdmission(trigger).Code.Should().Be(FarmhandExecutionJournalResultCode.Succeeded);

        foreach ((string name, FarmhandExecutionAdmission kept) in new[]
        {
            ("an admission whose native effect landed with no terminal", pending),
            ("an uncertain settlement", uncertain),
            ("a rejection a retry must be answered with", rejected),
        })
        {
            journal.TryLoadAdmission(kept.Scope, kept.RequestId, kept.IdempotencyKey).Code.Should().Be(
                FarmhandExecutionJournalResultCode.Succeeded,
                $"{name} is what a recovery reads, so the drain may not drop it");
        }

        IReadOnlyList<FarmhandExecutionJournalRecord> records = persistence.State!.Records!;
        this.output.WriteLine(
            $"after the drain: {records.Count} records · kept pending/uncertain/rejected · "
            + $"dropped {journal.LastDrainedRecords} settled succeeded rows");
        records.Should().Contain(record => string.Equals(record.RequestId, pending.RequestId, StringComparison.Ordinal));
        records.Should().Contain(record => string.Equals(record.RequestId, uncertain.RequestId, StringComparison.Ordinal));
        records.Should().Contain(record => string.Equals(record.RequestId, rejected.RequestId, StringComparison.Ordinal));
        records.Should().NotContain(record => string.Equals(record.RequestId, Admission(scope, 0).RequestId, StringComparison.Ordinal));
    }

    /// <summary>
    /// THE CRASH WITH AN ELIGIBLE-BUT-UNDRAINED RECORD. A record the drain MAY drop is not a record the journal owes
    /// anyone: while it is still in the document it is still authority, and losing the process before a drain loses
    /// nothing that was written - which is the only reason a drain is safe to run on somebody else's write.
    /// </summary>
    [Fact]
    public void ARestartBeforeADrainKeepsEveryRecordThatWasWritten()
    {
        var persistence = new CountingPersistence();
        BridgeScope scope = Scope();
        var journal = new FarmhandExecutionJournal(persistence);

        // Below the ceiling, so nothing is eligible-but-undrained yet: `RetainedRecords - 1` settled rows stay put.
        const int Written = FarmhandExecutionJournal.RetainedRecords - 1;
        var written = new List<FarmhandExecutionAdmission>(Written);
        for (int index = 0; index < Written; index++)
        {
            FarmhandExecutionAdmission admission = Admission(scope, index);
            journal.TryRecordAdmission(admission).Code.Should().Be(FarmhandExecutionJournalResultCode.Succeeded);
            journal.TryPersistReceiptTransition(admission, Receipt(admission, ExecutionState.Succeeded)).Code
                .Should().Be(FarmhandExecutionJournalResultCode.Succeeded);
            written.Add(admission);
        }

        journal.LastDrainedRecords.Should().Be(0, "nothing was over the ceiling, so nothing was drained");
        persistence.Records.Should().Be(Written);

        // The process dies here. A fresh journal over the same document is what a restart sees.
        var reopened = new FarmhandExecutionJournal(persistence);
        foreach (FarmhandExecutionAdmission admission in written)
        {
            FarmhandExecutionJournalResult<FarmhandExecutionJournalRecord> loaded =
                reopened.TryLoadAdmission(admission.Scope, admission.RequestId, admission.IdempotencyKey);
            loaded.Code.Should().Be(
                FarmhandExecutionJournalResultCode.Succeeded,
                $"`{admission.RequestId}` was written and not drained, so a restart must still replay it");
            loaded.Record!.Receipt!.State.Should().Be(ExecutionState.Succeeded);
        }
    }

    // -------------------------------------------------------------------------
    // The cost the ceiling is FOR: what one world-changing action's durable write costs at the ceiling.
    // -------------------------------------------------------------------------

    /// <summary>
    /// THE NUMBER THE CEILING IS CHOSEN FROM. A world-changing action keeps its durable row, so it pays one whole-payload
    /// write per admission and one per terminal; this prints what that pair costs at the
    /// <see cref="FarmhandExecutionJournal.RetainedRecords"/> ceiling, beside the 8.27 ms one write cost at the
    /// 1.18 MB / 738-record payload `round99` left behind. Printed, not asserted: the clock is not the subject here, the
    /// payload size is, and the gesture budget lives in `InstantGestureGameThreadCostTests`.
    /// </summary>
    [Fact]
    public void AWorldChangingWriteAtTheCeilingIsMeasured()
    {
        string path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), $"gamebuddy-retention-{Guid.NewGuid():N}.json");
        try
        {
            var persistence = new SmapiFilePersistence(path);
            BridgeScope scope = Scope();
            var seeder = new FarmhandExecutionJournal(persistence);
            for (int index = 0; index < FarmhandExecutionJournal.RetainedRecords; index++)
            {
                FarmhandExecutionAdmission seed = Admission(scope, index);
                seeder.TryRecordAdmission(seed).Code.Should().Be(FarmhandExecutionJournalResultCode.Succeeded);
                seeder.TryPersistReceiptTransition(seed, Receipt(seed, ExecutionState.Succeeded)).Code
                    .Should().Be(FarmhandExecutionJournalResultCode.Succeeded);
            }

            long bytes = new System.IO.FileInfo(path).Length;
            var journal = new FarmhandExecutionJournal(persistence);
            var samples = new List<double>();
            for (int index = 0; index < 5; index++)
            {
                FarmhandExecutionAdmission admission = Admission(scope, 100_000 + index);
                long started = System.Diagnostics.Stopwatch.GetTimestamp();
                journal.TryRecordAdmission(admission).Code.Should().Be(FarmhandExecutionJournalResultCode.Succeeded);
                journal.TryPersistReceiptTransition(admission, Receipt(admission, ExecutionState.Succeeded)).Code
                    .Should().Be(FarmhandExecutionJournalResultCode.Succeeded);
                samples.Add((System.Diagnostics.Stopwatch.GetTimestamp() - started) * 1000d / System.Diagnostics.Stopwatch.Frequency);
            }

            samples.Sort();
            this.output.WriteLine(
                $"a world-changing action's two durable writes at the {FarmhandExecutionJournal.RetainedRecords}-record ceiling: "
                + $"p50 {samples[samples.Count / 2]:0.00} ms over {bytes} B (the payload `round99` left was 1,168,796 B at 8.27 ms per write)");
        }
        finally
        {
            if (System.IO.File.Exists(path))
                System.IO.File.Delete(path);
        }
    }

    // -------------------------------------------------------------------------
    // The document, and the rows the three populations are built from.
    // -------------------------------------------------------------------------

    private static BridgeScope Scope() => new(
        "gamebuddy",
        "save-retention",
        "world-retention",
        "345893664",
        "companion-retention");

    private static FarmhandExecutionAdmission Admission(BridgeScope scope, int index) => new(
        scope,
        $"req_retention_{index:D5}",
        $"idem_retention_{index:D5}",
        "navigate_to_destination",
        FarmhandCanonicalRequest.NavigationDestination("navigate_to_destination", "label", "Farm", null),
        ExpectedRevision: index,
        DeadlineMs: 1767225600000 + index,
        ExecutionId: $"6a9da5e0f1b2c3d4e5f60718293a4b{index % 10}{index:D2}");

    private static FarmhandExecutionReceipt Receipt(FarmhandExecutionAdmission admission, ExecutionState state) => new(
        admission.ExecutionId,
        admission.RequestId,
        admission.ActionId,
        state,
        state == ExecutionState.Succeeded ? "navigation_completed" : "probe_terminal",
        admission.ExpectedRevision + 1,
        "destination=label:Farm;arrived=true");

    /// <summary>The document SMAPI keeps for one save's key, held in memory and counted.</summary>
    private sealed class CountingPersistence : IModGlobalDataPersistence
    {
        private FarmhandExecutionJournalState? state;

        internal int Records => this.state?.Records?.Count ?? 0;

        internal FarmhandExecutionJournalState? State => this.state;

        public FarmhandExecutionJournalState? Read(string key) => this.state;

        public bool TryWrite(string key, FarmhandExecutionJournalState value)
        {
            this.state = value;
            return true;
        }
    }

    /// <summary>
    /// `IDataHelper.WriteGlobalData` / `ReadGlobalData` as SMAPI performs them: one JSON file per key, deserialized whole
    /// on every read and rewritten whole on every write, on the calling thread.
    /// </summary>
    private sealed class SmapiFilePersistence : IModGlobalDataPersistence
    {
        private static readonly System.Text.Json.JsonSerializerOptions Format = new() { WriteIndented = true };

        private readonly string path;

        internal SmapiFilePersistence(string path) => this.path = path;

        public FarmhandExecutionJournalState? Read(string key) =>
            System.IO.File.Exists(this.path)
                ? System.Text.Json.JsonSerializer.Deserialize<FarmhandExecutionJournalState>(
                    System.IO.File.ReadAllText(this.path), Format)
                : null;

        public bool TryWrite(string key, FarmhandExecutionJournalState state)
        {
            System.IO.File.WriteAllText(this.path, System.Text.Json.JsonSerializer.Serialize(state, Format));
            return true;
        }
    }
}
