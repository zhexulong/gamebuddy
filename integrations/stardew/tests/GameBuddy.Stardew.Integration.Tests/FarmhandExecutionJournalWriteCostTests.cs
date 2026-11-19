using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;
using FluentAssertions;
using GameBuddy.Stardew.Core.Models;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// What one receipt actually writes, measured through the real journal.
///
/// <para>
/// `SmapiGlobalDataPersistence` binds <see cref="FarmhandExecutionJournal"/> to <c>IDataHelper.WriteGlobalData</c>, which
/// writes ONE app-global file (<c>&lt;appdata&gt;/StardewValley/.smapi/mod-data/&lt;modid&gt;/&lt;key&gt;.json</c>) holding
/// the whole journal. So every admission and every receipt transition serializes and writes the complete payload - up to
/// <see cref="FarmhandExecutionJournal.MaximumRecords"/> records - and because that file is app-global the payload grows
/// with every action of every save this Mod has ever been played in.
/// </para>
///
/// <para>
/// This test is the measurement, not a gate on the numbers: it drives 512 actions through the journal's two writes, prints
/// the payload at the sizes that matter (one record, a 23-node plan, the 1024-record bound) and what one whole-payload
/// write costs, and asserts only the structural facts that must not be forgotten: an admission and a receipt transition
/// each write once, and that write carries the whole journal rather than the one record that changed. Timing is printed,
/// never asserted - the clock is not the subject.
/// </para>
/// </summary>
public sealed class FarmhandExecutionJournalWriteCostTests
{
    private const int MeasuredActions = 512;
    private const int PlanNodes = 23;

    private readonly ITestOutputHelper output;

    public FarmhandExecutionJournalWriteCostTests(ITestOutputHelper output) => this.output = output;

    [Fact]
    public void EveryReceiptRewriteIsTheWholeJournalMeasured()
    {
        var persistence = new MeasuringPersistence();
        var journal = new FarmhandExecutionJournal(persistence);
        int writesForFirstAction = 0;
        for (int index = 0; index < MeasuredActions; index++)
        {
            FarmhandExecutionAdmission admission = Admission(index);
            journal.TryRecordAdmission(admission).Code.Should().Be(FarmhandExecutionJournalResultCode.Succeeded);
            journal.TryPersistReceiptTransition(admission, Receipt(admission)).Code
                .Should().Be(FarmhandExecutionJournalResultCode.Succeeded);
            if (index == 0)
                writesForFirstAction = persistence.WriteCount;
            persistence.WriteCount.Should().Be((2 * index) + 2, "one admission write and one receipt write per action");
        }

        long oneRecord = persistence.PayloadBytes[1];
        long atPlanSize = persistence.PayloadBytes[2 * PlanNodes];
        long atBound = persistence.PayloadBytes[^1];
        long total = persistence.PayloadBytes.Skip(1).Sum();

        atBound.Should().BeGreaterThan(
            20 * oneRecord,
            because: $"a receipt transition rewrites every record the journal holds · last write {atBound} B vs one record {oneRecord} B");
        total.Should().BeGreaterThan(
            100 * atBound,
            because: "the writes grow with the journal, so one session's traffic is quadratic in the records it adds");

        (double SerializeMs, double WriteMs) cost = MeasureWrite(persistence.State!);

        string line =
            $"records {persistence.State!.Records!.Count} · writes {persistence.WriteCount} · "
            + $"payload 1 record {oneRecord} B · {PlanNodes} records {atPlanSize} B · {FarmhandExecutionJournal.MaximumRecords} records {atBound} B";
        this.output.WriteLine(line);
        this.output.WriteLine(
            $"  writes for the first action {writesForFirstAction} · one session ({MeasuredActions} actions) {total} B · "
            + $"median serialize {cost.SerializeMs:0.000} ms · median serialize+write {cost.WriteMs:0.000} ms");
        this.output.WriteLine(
            $"  one {PlanNodes}-node plan at the {FarmhandExecutionJournal.MaximumRecords}-record bound: "
            + $"{PlanNodes * 2} writes × {atBound} B = {PlanNodes * 2 * atBound} B");

        atBound.Should().BeGreaterThan(
            256 * 1024,
            because: $"at its own bound the journal is hundreds of kilobytes, not tens · {line}");
    }

    /// <summary>
    /// Serializes the state as the adapter hands it to SMAPI (the payload's own size), then serializes and writes it as one
    /// whole-payload file with a flush - the write <c>WriteGlobalData</c> performs.
    /// </summary>
    private static (double SerializeMs, double WriteMs) MeasureWrite(FarmhandExecutionJournalState state)
    {
        string path = Path.Combine(Path.GetTempPath(), $"gamebuddy-journal-cost-{Guid.NewGuid():N}.json");
        var serialize = new List<double>();
        var write = new List<double>();
        try
        {
            for (int sample = 0; sample < 10; sample++)
            {
                Stopwatch stopwatch = Stopwatch.StartNew();
                byte[] payload = JsonSerializer.SerializeToUtf8Bytes(state);
                stopwatch.Stop();
                serialize.Add(stopwatch.Elapsed.TotalMilliseconds);

                stopwatch.Restart();
                using (FileStream stream = new(path, FileMode.Create, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
                {
                    stream.Write(payload, 0, payload.Length);
                    stream.Flush(flushToDisk: true);
                }

                stopwatch.Stop();
                write.Add(stopwatch.Elapsed.TotalMilliseconds);
            }
        }
        finally
        {
            File.Delete(path);
        }

        return (Median(serialize), Median(write));
    }

    private static double Median(List<double> values)
    {
        values.Sort();
        return values[values.Count / 2];
    }

    private static FarmhandExecutionAdmission Admission(int index) => new(
        new BridgeScope("stardew", "345893664", "345893664", "12345678901234567", "companion_12345678901234567"),
        $"req_nav_{index:D4}",
        $"idem_nav_{index:D4}",
        "navigate_to_destination",
        FarmhandCanonicalRequest.NavigationDestination("navigate_to_destination", "label", "Farm", null),
        ExpectedRevision: index,
        DeadlineMs: 1767225600000 + index,
        ExecutionId: $"6a9da5e0f1b2c3d4e5f60718293a4b{index % 10}{index:D2}");

    /// <summary>
    /// A settlement of the shape the funnel mints: the destination identity, the arrival and postcondition it proved, the
    /// folded steps and the chore clause a terminal carries, and the observation the receipt is published with.
    /// </summary>
    private static FarmhandExecutionReceipt Receipt(FarmhandExecutionAdmission admission) => new(
        admission.ExecutionId,
        admission.RequestId,
        admission.ActionId,
        ExecutionState.Succeeded,
        "navigation_completed",
        admission.ExpectedRevision + 1,
        "destination=label:Farm;arrived=true;postcondition=true;steps=3;folded=accepted@route_revision=1,target=3,11|tool_approach_completed@tile=9,22;chore=walk_to_destination",
        new BridgeLocalObservation("Farm", 64, 15, 2, "0610", PlayerNearby: false, Revision: (int)admission.ExpectedRevision + 1));

    /// <summary>The journal's two file operations, measuring the payload each write carries.</summary>
    private sealed class MeasuringPersistence : IModGlobalDataPersistence
    {
        internal FarmhandExecutionJournalState? State { get; private set; }

        internal List<long> PayloadBytes { get; } = new() { 0 };

        internal int WriteCount => this.PayloadBytes.Count - 1;

        public FarmhandExecutionJournalState? Read(string key) => this.State;

        public bool TryWrite(string key, FarmhandExecutionJournalState value)
        {
            this.State = value;
            this.PayloadBytes.Add(JsonSerializer.SerializeToUtf8Bytes(value).LongLength);
            return true;
        }
    }
}
