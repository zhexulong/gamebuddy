using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Serialization;
using System.Text.Json;
using FluentAssertions;
using GameBuddy.Stardew.Core.Diagnostics;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Core.Policy;
using GameBuddy.Stardew.Core.Protocol;
using Netcode;
using StardewValley;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// WHAT ONE INSTANT GESTURE COSTS THE GAME THREAD, AND WHERE THE TIME WENT.
///
/// <para>
/// MEASURED `round99`: <c>[game-thread-cost] action=express_emote;total_ms=70.19;floods=0;flood_ms=0.00;
/// handler_rest_ms=70.19</c>, and <c>face_direction</c> at 38.53 ms - for two actions that plan no walk, approach no
/// target and hold no tool. 4,670 ms of one run went into gestures, and `round98`'s p50 of 33.93 ms had DOUBLED by the
/// next run. A cost that doubles on its own is not a slow native call: it is a cost that grows with something the run
/// accumulates.
/// </para>
///
/// <para>
/// THE STACK UNDER THE NUMBER, now named by the meter. Every dispatched action passed <c>BridgeSession.TryExecute</c>,
/// whose candidate ingress (<c>ExecutionAdmission.TryAdmitCandidate</c>) wrote the whole durable journal before the
/// handler ran, and whose terminal (<c>ExecutionManager.AddTrace</c>) read the journal once and then rewrote it. The
/// journal is ONE SMAPI data file per save (<see cref="FarmhandExecutionJournal.KeyFor"/>) holding every record
/// of every save this Mod has played - <see cref="LiveJournalRecords"/> records / <see cref="LiveJournalBytes"/> bytes on
/// this machine after `round99` - and every operation reloaded, revalidated and rewrote the complete payload. Measured
/// through a real dispatch: <c>journal_read_ms=32.77;journal_write_ms=8.51;native_ms=0.00;observation_ms=0.09;
/// handler_rest_ms=0.27</c> of a 41.65 ms node, and 106.69 ms for the whole gesture once the admission's own read and
/// write are counted.
/// </para>
///
/// <para>
/// SO THE GESTURE PAYS THE SESSION'S HISTORY, TWICE. A balloon cannot change the world -
/// <c>FarmhandActionCatalog.ActionsThatChangeNothing</c> states why for each such action - and for those the funnel
/// already answers a row it could not write with <c>ignored=expression_changes_nothing</c>: the row buys replay
/// convenience and nothing else. It is therefore not written at all any more
/// (<c>BridgeSession.TryExecute</c>'s durable-admission predicate is `canonical shape AND ChangesTheWorld`), and what
/// remains of a gesture is its native call, its observation and its receipt. Measured after that change: whole-gesture
/// p50 <c>0.02 ms</c> against a budget of <see cref="InstantGestureGameThreadBudgetMs"/> ms.
/// </para>
///
/// <para>
/// THE INSTRUMENT IS A UNIT-LEVEL HARNESS, NOT A LIVE RUN: the game cannot be launched here, so this file drives the
/// REAL dispatch (<see cref="BridgeSession.TryExecute"/> → the router from
/// <see cref="ModEntry.CreateFarmhandActionRouter"/> → the real <c>express_emote</c> handler → the engine's own
/// <c>Farmer.doEmote</c>) against a journal seeded to the payload size the live run had, with the persistence modelling
/// SMAPI's own two operations (whole file read + deserialize, whole file serialize + write). The sub-spans themselves
/// also reach the next live run's log, since they are seams on <see cref="GameThreadCost"/> rather than a test fixture.
/// </para>
/// </summary>
public sealed class InstantGestureGameThreadCostTests
{
    /// <summary>
    /// The budget an INSTANT gesture may spend on the game thread, in milliseconds: a quarter of a 60 fps frame
    /// (<see cref="FrameMs"/>), which is the point below which a hitch cannot be attributed to the gesture.
    /// </summary>
    internal const double InstantGestureGameThreadBudgetMs = 4d;

    /// <summary>60 fps: one frame is 16.67 ms, and a quarter of it is the instant-gesture budget.</summary>
    internal const double FrameMs = 1000d / 60d;

    /// <summary>Records the live journal held after `round99`, counted from the file SMAPI wrote (738).</summary>
    internal const int LiveJournalRecords = 738;

    /// <summary>Bytes those records occupied on disk after `round99` (1,168,796 B), so the payload is the real one.</summary>
    internal const long LiveJournalBytes = 1_168_796;

    /// <summary>Timed dispatches per measurement; the MEDIAN is the reading, because one scheduler slice is not a cost.</summary>
    private const int Dispatches = 5;

    /// <summary>The bound body's multiplayer id: the scope names it and the actor carries it, so admission binds.</summary>
    private const long ActorId = 345893664;

    private const string Token = "instant_gesture_token_0123456789";

    private readonly ITestOutputHelper output;

    public InstantGestureGameThreadCostTests(ITestOutputHelper output) => this.output = output;

    /// <summary>
    /// THE GATE. A gesture must not spend a quarter of a frame on the Mod's own bookkeeping, whatever the session has
    /// accumulated. The first dispatch is a warm-up and is not measured: it pays the JIT for the emote path, which is not
    /// a cost the journal or the handler's design can remove.
    /// </summary>
    [Fact]
    public void AnInstantGestureStaysInsideItsGameThreadBudget()
    {
        Measurement measured = Measure("express_emote");

        this.output.WriteLine(
            $"express_emote · journal {measured.JournalRecords} records / {measured.JournalBytes} B"
            + $" · whole-gesture p50 {measured.MedianMs:0.00} ms of a {InstantGestureGameThreadBudgetMs:0.00} ms budget"
            + $" · frame {FrameMs:0.00} ms");
        this.output.WriteLine($"  spans: {measured.Line ?? "(no line: the node stayed under the report floor)"}");

        measured.MedianMs.Should().BeLessThan(
            InstantGestureGameThreadBudgetMs,
            because: $"an instant gesture may not spend a quarter of a frame on the Mod's own bookkeeping · "
                + $"measured {measured.MedianMs:0.00} ms over {Dispatches} dispatches at {measured.JournalBytes} B");

        if (measured.Line is null)
        {
            measured.MedianMs.Should().BeLessThan(
                FrameMs / 2,
                "the meter prints no line under its half-frame floor, so a silent node is a node under 8 ms");
            return;
        }

        Field(measured.Line, "approach_ms").Should().Be(
            0d,
            "a gesture approaches nothing: a non-zero approach on an emote means a walk was planned for a balloon");
        Field(measured.Line, "floods").Should().Be(0d, "a gesture plans no path, so no reachability flood may run for it");
        Seam(measured.Line, "journal_read").Should().BeNull(
            "a gesture must not read the session's journal back: that read was 32.77 ms of the 41.65 ms measured before this fix");
        Seam(measured.Line, "journal_write").Should().BeNull(
            "a gesture that cannot change the world must not rewrite the session's whole journal, which was 8.51 ms of it");
    }

    /// <summary>
    /// THE STRUCTURAL GATE, on the persistence boundary rather than on a log line. A gesture that cannot change the world
    /// keeps no durable execution row: the journal is neither read nor written for it, while an action that DOES change
    /// the world still writes both its admission and its terminal - so "zero" here cannot pass because the counter died.
    ///
    /// <para>
    /// THE POPULATION IS THE PRODUCT'S OWN TWO DECLARATIONS. The durable-admission predicate is `canonical argument shape
    /// (<see cref="FarmhandCanonicalRequest"/>) AND <see cref="FarmhandActionCatalog.ChangesTheWorld"/>`, so this gate
    /// reads <see cref="FarmhandActionCatalog.ActionsThatChangeNothing"/> intersected with the catalogue rows whose
    /// declared arguments have that shape - the same authority, not a list of gestures kept in a test.
    /// </para>
    ///
    /// <para>
    /// WHAT THIS GATE IS NOT ABOUT. It asserts the durable boundary and the answer, not each action's native execution:
    /// a headless <see cref="Farmer"/> cannot stand a walk (<c>face_direction</c> reads <c>isMoving()</c>), and whether a
    /// gesture lands belongs to <see cref="ExpressionOutcomeGateTests"/>. Every driven receipt is printed with its state,
    /// so nothing here hides an action that answered something else.
    /// </para>
    /// </summary>
    [Fact]
    public void AWorldlessGestureKeepsNoDurableRowAndIsStillAnswered()
    {
        BridgeScope populationScope = Scope();
        IReadOnlyList<string> worldless = WorldlessActions(populationScope);
        this.output.WriteLine($"worldless population checked: {string.Join(", ", worldless)}");
        worldless.Should().NotBeEmpty("a gate whose population is empty agrees with itself");

        foreach (string actionId in worldless)
        {
            var persistence = new CountingPersistence(SeededJournal(populationScope));
            var published = new List<LocalExecutionReceipt>();
            ExecutionManager executions = Manager(persistence, published);
            // The balloon the previous action armed has come down: the engine clears `isEmoting` when the animation ends,
            // and no tick loop runs in this harness to do it.
            SharedActor.isEmoting = false;
            var session = new BridgeSession(
                executions,
                ModEntry.CreateFarmhandActionRouter(executions),
                populationScope,
                Token,
                () => Publication(actionId));
            session.TryAuthenticate(1, Hello(populationScope), out _, out string authReason).Should().BeTrue(authReason);

            session.TryExecute(1, Execution(populationScope, 0, actionId), out BridgeEnvelope<BridgeReceipt>? response, out string reason)
                .Should().BeTrue($"{actionId}: {reason}");
            this.output.WriteLine($"  {actionId}: {response!.Payload.State}/{response.Payload.ReasonCode}");
            response.Payload.State.Should().BeOneOf(
                new[] { "succeeded", "rejected", "uncertain", "expired", "cancelled", "blocked", "failed" },
                $"`{actionId}` was answered with a terminal receipt · {response.Payload.ReasonCode}");

            persistence.Reads.Should().Be(0, $"`{actionId}` changes nothing, so nothing it does needs the journal read back");
            persistence.Writes.Should().Be(
                0,
                $"`{actionId}` changes nothing, so its receipt must not rewrite the session's whole journal");
            published.Should().ContainSingle($"`{actionId}` still reaches the fact stream");

            // AND IT IS STILL ANSWERED: the receipt is stored in the process ledger, so a retry of the same request is the
            // same execution rather than a second gesture. Re-executing it after a CRASH is the same visible outcome -
            // the balloon is the whole effect - which is why the missing row costs nothing a retry could need.
            session.TryExecute(1, Execution(populationScope, 0, actionId), out BridgeEnvelope<BridgeReceipt>? replay, out string replayReason)
                .Should().BeTrue($"{actionId}: {replayReason}");
            replayReason.Should().Be("idempotent_replay");
            replay!.Payload.ExecutionId.Should().Be(response.Payload.ExecutionId, "a retry answers the execution it already has");
        }

        // THE COUNTERWEIGHT: the same journal still writes an admission and a terminal for an action that changes the
        // world, so a live counter is what the zero above was read from.
        var worldChanging = new CountingPersistence(SeededJournal(populationScope));
        var journal = new FarmhandExecutionJournal(worldChanging);
        FarmhandExecutionAdmission admission = Admission(populationScope, LiveJournalRecords);
        journal.TryRecordAdmission(admission).Code.Should().Be(FarmhandExecutionJournalResultCode.Succeeded);
        journal.TryPersistReceiptTransition(admission, Receipt(admission)).Code.Should().Be(FarmhandExecutionJournalResultCode.Succeeded);
        worldChanging.Writes.Should().Be(2, "a world change keeps its admission and its terminal");
    }

    // -------------------------------------------------------------------------
    // The drive: the real ingress, the real router, the real handler, the real journal.
    // -------------------------------------------------------------------------

    /// <summary>
    /// One measurement: the journal seeded to the live payload, one warm-up dispatch, then <see cref="Dispatches"/>
    /// timed dispatches, with the meter's own line captured when one was printed.
    /// </summary>
    private Measurement Measure(string actionId)
    {
        string path = Path.Combine(Path.GetTempPath(), $"gamebuddy-instant-gesture-{Guid.NewGuid():N}.json");
        var lines = new List<string>();
        BridgeScope scope = Scope();
        try
        {
            var persistence = new SmapiGlobalDataPersistence(path);
            persistence.TryWrite(FarmhandExecutionJournal.KeyFor(scope), SeededJournal(scope));
            long bytes = new FileInfo(path).Length;

            var published = new List<LocalExecutionReceipt>();
            ExecutionManager executions = Manager(persistence, published);
            Farmer actor = Actor();
            var session = new BridgeSession(executions, ModEntry.CreateFarmhandActionRouter(executions), scope, Token, () => Publication(actionId));
            session.TryAuthenticate(1, Hello(scope), out _, out string authReason).Should().BeTrue(authReason);

            double Dispatch(int index)
            {
                // The balloon the previous gesture armed has come down by the time the next one is asked for: the engine
                // clears `isEmoting` when the animation ends (`Character.updateEmote`), and no tick loop runs here to do it.
                actor.isEmoting = false;
                long started = Stopwatch.GetTimestamp();
                bool dispatched = session.TryExecute(
                    1,
                    Execution(scope, index, actionId),
                    out BridgeEnvelope<BridgeReceipt>? response,
                    out string reason);
                double elapsed = ElapsedMs(started);
                dispatched.Should().BeTrue($"dispatch {index}: {reason}");
                response!.Payload.State.Should().Be(
                    "succeeded",
                    $"the gesture the engine armed is the one the receipt claims · {response.Payload.ReasonCode}");
                return elapsed;
            }

            Dispatch(0);

            GameThreadCost.Report = lines.Add;
            var samples = new List<double>();
            try
            {
                for (int index = 1; index <= Dispatches; index++)
                    samples.Add(Dispatch(index));
            }
            finally
            {
                GameThreadCost.Report = null;
            }

            string? line = lines.FirstOrDefault(row => row.Contains($"action={actionId};", StringComparison.Ordinal));
            return new Measurement(
                samples.OrderBy(ms => ms).ElementAt(samples.Count / 2),
                line,
                persistence.RecordCount ?? 0,
                bytes);
        }
        finally
        {
            if (File.Exists(path))
                File.Delete(path);
        }
    }

    /// <summary>
    /// The rows whose durable admission the product skips: a catalogue action declared worldless, whose declared arguments
    /// are a canonical shape. Derived from the two declarations the bridge itself reads.
    /// </summary>
    private static IReadOnlyList<string> WorldlessActions(BridgeScope scope) =>
        FarmhandActionCatalog.ActionsThatChangeNothing.Keys
            .Where(actionId => FarmhandActionCatalog.Registrations.Any(row => string.Equals(row.ActionId, actionId, StringComparison.Ordinal)))
            .Where(actionId => FarmhandCanonicalRequest.TryCreate(Execution(scope, 0, actionId).Payload, out _))
            .OrderBy(actionId => actionId, StringComparer.Ordinal)
            .ToArray();

    private static ExecutionManager Manager(IModGlobalDataPersistence persistence, List<LocalExecutionReceipt> published)
    {
        var manager = new ExecutionManager(
            new DummyMonitor(),
            () => Publication("express_emote"),
            receiptPublished: published.Add,
            executionJournal: new FarmhandExecutionJournal(persistence),
            executionScope: Scope());
        manager.SetTestActorResolver(() => SharedActor);
        return manager;
    }

    /// <summary>
    /// The one uninitialised <see cref="Farmer"/>: the expression path reads no NetField beyond the identity the scope
    /// comparison needs, and its native call is a field write.
    /// </summary>
    private static readonly Farmer SharedActor = CreateActor();

    private static Farmer Actor() => SharedActor;

    private static Farmer CreateActor()
    {
        var actor = (Farmer)FormatterServices.GetUninitializedObject(typeof(Farmer));
        typeof(Farmer)
            .GetField("uniqueMultiplayerID", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
            .SetValue(actor, new NetLong(ActorId));
        return actor;
    }

    private static FarmhandCapabilityPublication Publication(string actionId) =>
        FarmhandCapabilityPublication.Initial(new HashSet<string>(StringComparer.Ordinal) { actionId });

    private static string RequestId(int index) => $"req_instant_gesture_{index}";

    private static BridgeScope Scope() => new(
        "gamebuddy",
        "save-instant-gesture",
        "world-instant-gesture",
        ActorId.ToString(System.Globalization.CultureInfo.InvariantCulture),
        "companion-instant-gesture");

    private static BridgeEnvelope<BridgeHello> Hello(BridgeScope scope) =>
        new(BridgeProtocol.Version, "msg_hello", "corr_hello", DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), scope, "hello", new BridgeHello(Token));

    /// <summary>The request shape the catalogue declares for one action, with the first value of each enum argument.</summary>
    private static BridgeEnvelope<BridgeExecutionRequest> Execution(BridgeScope scope, int index, string actionId)
    {
        FarmhandActionRegistration registration = FarmhandActionCatalog.Registrations
            .Single(row => string.Equals(row.ActionId, actionId, StringComparison.Ordinal));
        IReadOnlyList<FarmhandActionArgument> declared = registration.Descriptor?.Arguments ?? Array.Empty<FarmhandActionArgument>();
        bool Declares(string name) => declared.Any(argument => string.Equals(argument.Name, name, StringComparison.Ordinal));

        var args = new BridgeExecutionArgs
        {
            Destination = Declares("destination") ? new BridgeNavigationDestinationSelector("label", "Farm", null) : null,
            Emote = Declares("emote") ? FarmhandActionCatalog.EmoteEnum[0] : null,
            Direction = Declares("direction") ? FarmhandActionCatalog.DirectionEnum[0] : null,
        };
        string requestId = RequestId(index);
        return new BridgeEnvelope<BridgeExecutionRequest>(
            BridgeProtocol.Version,
            $"msg_{requestId}",
            $"corr_{requestId}",
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            scope,
            "execution_request",
            new BridgeExecutionRequest(
                requestId,
                $"idem_{requestId}",
                actionId,
                args,
                ExpectedRevision: 0,
                DeadlineMs: DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 30_000));
    }

    /// <summary>
    /// The journal as the run leaves it: <see cref="LiveJournalRecords"/> settled records of the shape a settlement
    /// carries, so the payload this test rebuilds is the payload the live gesture rebuilt.
    /// </summary>
    private static FarmhandExecutionJournalState SeededJournal(BridgeScope scope)
    {
        var records = new List<FarmhandExecutionJournalRecord>(LiveJournalRecords);
        for (int index = 0; index < LiveJournalRecords; index++)
        {
            FarmhandExecutionAdmission admission = Admission(scope, index);
            records.Add(new FarmhandExecutionJournalRecord(
                admission.Scope,
                admission.RequestId,
                admission.IdempotencyKey,
                admission.ActionId,
                admission.Request,
                admission.ExpectedRevision,
                admission.DeadlineMs,
                admission.ExecutionId,
                FarmhandExecutionJournalRecordState.TerminalSettled,
                Receipt(admission)));
        }

        return new FarmhandExecutionJournalState(FarmhandExecutionJournal.SchemaVersion, records);
    }

    private static FarmhandExecutionAdmission Admission(BridgeScope scope, int index) => new(
        scope,
        $"req_seed_{index:D4}",
        $"idem_seed_{index:D4}",
        "cut_weeds",
        FarmhandCanonicalRequest.Tile("cut_weeds", index % 80, index % 60),
        ExpectedRevision: index,
        DeadlineMs: 1767225600000 + index,
        ExecutionId: $"6a9da5e0f1b2c3d4e5f60718293a4b{index % 10}{index:D2}");

    /// <summary>
    /// A settled receipt of the size a real settlement carries: the target, the tool, the postcondition it proved, the
    /// folded steps and the chore clause, and the observation the receipt is published with.
    /// </summary>
    private static FarmhandExecutionReceipt Receipt(FarmhandExecutionAdmission admission) => new(
        admission.ExecutionId,
        admission.RequestId,
        admission.ActionId,
        ExecutionState.Succeeded,
        "weeds_cut",
        admission.ExpectedRevision + 1,
        "target=40,9;tool=scythe;postcondition=weeds_cut=1;steps=3"
            + ";folded=accepted@route_revision=1,target=40,9|tool_approach_completed@tile=39,10|tool_swing_completed@tile=40,9"
            + ";chore=clear_the_weeds;held_ms=0",
        new BridgeLocalObservation("Farm", 40, 9, 2, "0610", PlayerNearby: false, Revision: (int)admission.ExpectedRevision + 1));

    // -------------------------------------------------------------------------
    // The persistence: SMAPI's own two global-data operations, measured and counted.
    // -------------------------------------------------------------------------

    /// <summary>
    /// <c>IDataHelper.WriteGlobalData</c> / <c>ReadGlobalData</c> as SMAPI performs them: ONE app-global JSON file per
    /// key, deserialized whole on every read and rewritten whole on every write, on the calling thread.
    /// </summary>
    private sealed class SmapiGlobalDataPersistence : IModGlobalDataPersistence
    {
        private static readonly JsonSerializerOptions Format = new() { WriteIndented = true };

        private readonly string path;

        internal SmapiGlobalDataPersistence(string path) => this.path = path;

        /// <summary>Records last written, so a reading can name the payload it measured.</summary>
        internal int? RecordCount { get; private set; }

        public FarmhandExecutionJournalState? Read(string key) =>
            File.Exists(this.path)
                ? JsonSerializer.Deserialize<FarmhandExecutionJournalState>(File.ReadAllText(this.path), Format)
                : null;

        public bool TryWrite(string key, FarmhandExecutionJournalState state)
        {
            File.WriteAllText(this.path, JsonSerializer.Serialize(state, Format));
            this.RecordCount = state.Records?.Count ?? 0;
            return true;
        }
    }

    /// <summary>The same payload held in memory, counting what the journal asks of it.</summary>
    private sealed class CountingPersistence : IModGlobalDataPersistence
    {
        private FarmhandExecutionJournalState? state;

        internal CountingPersistence(FarmhandExecutionJournalState seeded) => this.state = seeded;

        internal int Reads { get; private set; }

        internal int Writes { get; private set; }

        public FarmhandExecutionJournalState? Read(string key)
        {
            this.Reads++;
            return this.state;
        }

        public bool TryWrite(string key, FarmhandExecutionJournalState value)
        {
            this.Writes++;
            this.state = value;
            return true;
        }
    }

    private readonly record struct Measurement(double MedianMs, string? Line, int JournalRecords, long JournalBytes);

    private static double ElapsedMs(long started) =>
        (Stopwatch.GetTimestamp() - started) * 1000d / Stopwatch.Frequency;

    /// <summary>One numeric fixed field of the meter's line, read by the name the line spells.</summary>
    private static double Field(string line, string name)
    {
        string field = line.Split(';').Single(row => row.StartsWith($"{name}=", StringComparison.Ordinal));
        return double.Parse(field[(name.Length + 1)..], System.Globalization.CultureInfo.InvariantCulture);
    }

    /// <summary>
    /// A free seam the line prints only when it ran, so <c>null</c> is the fact "this node did not run this seam" rather
    /// than a zero that could also mean it ran for no measurable time.
    /// </summary>
    private static double? Seam(string line, string name)
    {
        string? field = line.Split(';').FirstOrDefault(row => row.StartsWith($"{name}_ms=", StringComparison.Ordinal));
        return field is null ? null : double.Parse(field[($"{name}_ms=".Length)..], System.Globalization.CultureInfo.InvariantCulture);
    }
}
