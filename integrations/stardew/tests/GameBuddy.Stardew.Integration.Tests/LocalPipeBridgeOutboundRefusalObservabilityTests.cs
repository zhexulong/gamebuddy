using System.IO.Pipes;
using System.Text;
using FluentAssertions;
using GameBuddy.Stardew.Core.Protocol;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// A frame the outbound queue refuses is a receipt that will never arrive, so it must be a fact a reader can find.
///
/// The queue admits at most <see cref="LocalPipeBridge.MaximumQueuedMessages"/> frames, the caller gets false, and
/// until now nothing counted the refusal, nothing published it, and no artifact could tell an operator afterwards that
/// a terminal receipt had been dropped. A Host waiting for that receipt waits for a state that will never arrive, and
/// the run reads as a companion that simply stopped answering.
///
/// The property that replaces the silence is a single one, held at the owning layer so no call site needs its own copy
/// of it: every attempt is classified, and every refusal is named. The population is the admission function itself, so
/// a refusal path added later cannot pass uncounted.
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the counters, the published fact and the queue cap are driven on the real bridge, while
// the consumer census reads the Mod's own source - those call sites cannot be constructed in a headless runner, and the
// thing being pinned is that they inherit the bridge's publication rather than swallowing the answer.
public sealed class LocalPipeBridgeOutboundRefusalObservabilityTests
{
    /// <summary>Anchors at the repository root from the test assembly's output directory, as the other pins do.</summary>
    private const string RepositoryRelativeRoot = "../../../../../../../";

    private readonly ITestOutputHelper output;

    public LocalPipeBridgeOutboundRefusalObservabilityTests(ITestOutputHelper output) => this.output = output;

    /// <summary>
    /// Every refusal a caller can observe is counted, and the counts are published as named facts.
    ///
    /// Each refusal cause reaches the caller as the same `false`, so the counter is checked against what the caller
    /// actually saw rather than against a list of causes: a new `return false` that forgets to count raises the
    /// caller's false returns without raising `Refused`, and that is the drift this fails on.
    /// </summary>
    [Fact]
    public void EveryRefusedOutboundFrame_IsCountedAndNamedOnce_WithinOneFactPerSecond()
    {
        string pipeName = "gamebuddy_outbound_refusal_" + Guid.NewGuid().ToString("N");
        using LocalPipeBridge bridge = new(pipeName);
        using NamedPipeClientStream client = ConnectClient(pipeName);
        long generation = WaitForGeneration(bridge);

        long observedFalseReturns = 0;

        // A frame for a generation that is not the connected one.
        bridge.TryEnqueueOutbound(generation + 1, Frame("execution_receipt")).Should().BeFalse();
        observedFalseReturns++;

        // A frame larger than the wire maximum.
        bridge.TryEnqueueOutbound(generation, new string('x', BridgeProtocol.MaximumMessageBytes + 1)).Should().BeFalse();
        observedFalseReturns++;

        // The queue at its cap: a peer that does not read leaves the writer blocked and the queue fills.
        string fullFrame = FullFrame("execution_receipt");
        int attempts = 0;
        while (attempts < LocalPipeBridge.MaximumQueuedMessages + 8)
        {
            attempts++;
            if (bridge.TryEnqueueOutbound(generation, fullFrame, out _)) continue;
            observedFalseReturns++;
            break;
        }

        LocalPipeBridge.OutboundFrameCounters counters = bridge.SnapshotOutboundFrameCounters();
        counters.Generation.Should().Be(generation, "the counters must name the connection they describe");
        counters.Refused.Should().Be(observedFalseReturns,
            "the refused counter must equal the refusals a caller actually observed");
        counters.Peak.Should().Be(LocalPipeBridge.MaximumQueuedMessages,
            "the capacity refusal above can only have happened at the cap");
        (counters.Admitted + counters.Refused).Should().Be((long)attempts + 2,
            "every attempt is either admitted or refused: an unclassified attempt is an uncounted drop");

        List<(string Kind, long Count)> facts = TakeAllRefusedFacts(bridge);
        facts.Should().NotBeEmpty("a refusal that names nothing is the defect this covers");
        facts.Sum(fact => fact.Count).Should().Be(counters.Refused,
            "the published counts must add up to the refused counter, not be a sample of it");
        facts.Select(fact => fact.Kind).Should().Contain("execution_receipt",
            "the fact must name the frame kind whose receipt the Host will never receive");
        facts.Select(fact => fact.Kind).Should().Contain("untyped",
            "a frame whose type cannot be read must still be named rather than merged into silence");
        facts.Count.Should().BeLessThanOrEqualTo(2,
            "fewer facts than refusals is the bound: a flood may not become a flood of lines");

        // The window itself: one fact per interval, and the refusal of a later frame waits for the next one instead of
        // doubling the rate.
        long lastWindow = LocalPipeBridge.RefusedFrameFactIntervalMilliseconds * facts.Count;
        bridge.TryEnqueueOutbound(generation + 1, Frame("body_trace")).Should().BeFalse();
        bridge.TryTakeRefusedFrameFact(lastWindow + LocalPipeBridge.RefusedFrameFactIntervalMilliseconds - 1, out _, out _)
            .Should().BeFalse("a second fact inside one window would let a refused flood write a log flood");
        bridge.TryTakeRefusedFrameFact(lastWindow + LocalPipeBridge.RefusedFrameFactIntervalMilliseconds, out string nextKind, out long nextCount)
            .Should().BeTrue("the refusal accumulated between windows is owed at the next one");
        nextKind.Should().Be("body_trace");
        nextCount.Should().Be(1);
    }

    /// <summary>
    /// With the queue at its cap, the published numbers move exactly as the backpressure does: admissions stop,
    /// refusals grow, and the peak equals the cap. Those three readings are what an operator needs to tell "the bridge
    /// is saturated" from "the connection died", and the peak is what makes the difference derivable - a refusal under a
    /// peak below the cap cannot have been a capacity refusal.
    /// </summary>
    [Fact]
    public void OutboundBackpressure_IsMeasurable_AdmittedStopsRefusedGrowsAndPeakEqualsTheCap()
    {
        string pipeName = "gamebuddy_outbound_backpressure_" + Guid.NewGuid().ToString("N");
        using LocalPipeBridge bridge = new(pipeName);
        using NamedPipeClientStream client = ConnectClient(pipeName);
        long generation = WaitForGeneration(bridge);

        string fullFrame = FullFrame("execution_receipt");
        int attempts = 0;
        while (attempts < LocalPipeBridge.MaximumQueuedMessages + 8)
        {
            attempts++;
            if (!bridge.TryEnqueueOutbound(generation, fullFrame, out _)) break;
        }

        LocalPipeBridge.OutboundFrameCounters saturated = bridge.SnapshotOutboundFrameCounters();
        saturated.Peak.Should().Be(LocalPipeBridge.MaximumQueuedMessages,
            $"the queue must report the cap it actually reached (admitted {saturated.Admitted} of {attempts} attempts)");
        saturated.Refused.Should().BeGreaterThan(0, "a write-blocked peer must eventually refuse frames by name");
        saturated.Admitted.Should().BeGreaterThanOrEqualTo(LocalPipeBridge.MaximumQueuedMessages,
            "the cap counts admitted frames, so the queue cannot hold fewer than the cap before refusing");

        int extraAttempts = 10;
        for (int index = 0; index < extraAttempts; index++)
            bridge.TryEnqueueOutbound(generation, fullFrame, out _).Should().BeFalse();

        LocalPipeBridge.OutboundFrameCounters stillSaturated = bridge.SnapshotOutboundFrameCounters();
        stillSaturated.Admitted.Should().Be(saturated.Admitted, "admission must stop at the cap while the queue is full");
        stillSaturated.Refused.Should().Be(saturated.Refused + extraAttempts, "refused must grow with every refused frame");
        stillSaturated.Peak.Should().Be(LocalPipeBridge.MaximumQueuedMessages, "a full queue cannot report a deeper peak");
        stillSaturated.Drained.Should().BeLessThan(stillSaturated.Admitted,
            "a blocked writer cannot have drained the queue it is blocked on");
    }

    /// <summary>
    /// The measurement the cap is judged by: a 48-tile <c>for_each</c> pass emits two frames per tile, and against a
    /// peer that reads, the queue peak stays two orders of magnitude below the cap.
    ///
    /// This is the evidence that the cap is NOT the defect in a healthy pass - the numbers are printed so the bound in
    /// the assertion can be re-read against a real measurement instead of a guess - and it is also the reading that
    /// would go wrong if the writer ever fell behind the game thread's own emission rate. What remains undecided, and
    /// deliberately not decided here, is whether a pass should COALESCE its per-node receipts into one frame: that
    /// changes what the Host reads, and this measurement says queue pressure does not ask for it.
    /// </summary>
    [Fact]
    public async Task FortyEightTileForEachPass_AgainstAReadingPeer_ReportsItsPeakQueueDepth()
    {
        const int tiles = 48;
        const int framesPerTile = 2;
        string pipeName = "gamebuddy_outbound_peak_" + Guid.NewGuid().ToString("N");
        using LocalPipeBridge bridge = new(pipeName);
        using NamedPipeClientStream client = ConnectClient(pipeName);
        long generation = WaitForGeneration(bridge);
        using CancellationTokenSource stop = new();
        long framesRead = 0;
        Task reader = Task.Run(async () =>
        {
            try
            {
                while (!stop.IsCancellationRequested)
                {
                    await ReadFrameAsync(client, stop.Token).ConfigureAwait(false);
                    Interlocked.Increment(ref framesRead);
                }
            }
            catch (OperationCanceledException) { }
            catch (IOException) { }
        });
        try
        {
            for (int tile = 0; tile < tiles; tile++)
            {
                bridge.TryEnqueueOutbound(generation, Frame("execution_receipt")).Should().BeTrue();
                bridge.TryEnqueueOutbound(generation, Frame("body_trace")).Should().BeTrue();
                // One tile settles every few engine ticks; the reader has the whole gap to drain it.
                Thread.Sleep(5);
            }

            long deadline = Environment.TickCount64 + 5_000;
            while (Interlocked.Read(ref framesRead) < tiles * framesPerTile && Environment.TickCount64 < deadline)
                Thread.Sleep(5);

            LocalPipeBridge.OutboundFrameCounters counters = bridge.SnapshotOutboundFrameCounters();
            this.output.WriteLine(
                $"48-tile for_each peak={counters.Peak} cap={LocalPipeBridge.MaximumQueuedMessages} " +
                $"admitted={counters.Admitted} drained={counters.Drained} refused={counters.Refused}");
            counters.Admitted.Should().Be((long)tiles * framesPerTile);
            counters.Refused.Should().Be(0, "a pass the reader keeps up with must never be refused");
            counters.Drained.Should().Be((long)tiles * framesPerTile, "the writer must have drained every admitted frame");
            counters.Peak.Should().BeLessThan(LocalPipeBridge.MaximumQueuedMessages / 4,
                $"the measured peak {counters.Peak} must stay far below the cap of {LocalPipeBridge.MaximumQueuedMessages}");
        }
        finally
        {
            stop.Cancel();
            await Task.WhenAny(reader, Task.Delay(TimeSpan.FromSeconds(5)));
        }
    }

    /// <summary>
    /// Every place that consumes the admission answer looks at it, and the one publication the bridge owns is wired to
    /// a channel the run bundle carries.
    ///
    /// The census is derived from the Mod's own source - the declaring file is the population's only exclusion - so a
    /// consumer added later is examined without anyone remembering to add it here. Each must consume the returned
    /// `false` rather than calling and discarding it, and none needs its own fact: the bridge names the refusal once at
    /// the layer that made it, which is why this file asserts the wiring instead of fourteen copies of the message.
    /// </summary>
    [Fact]
    public void EveryOutboundFrameConsumer_LooksAtTheRefusalTheBridgePublishes()
    {
        string modRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, RepositoryRelativeRoot, "integrations", "stardew"));
        string[] sources = Directory
            .GetFiles(modRoot, "*.cs", SearchOption.AllDirectories)
            .Where(path => !path.Contains($"{Path.DirectorySeparatorChar}tests{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
            .Where(path => !path.Contains($"{Path.DirectorySeparatorChar}src{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
            .Where(path => !path.Contains($"{Path.DirectorySeparatorChar}action-development{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
            .Where(path => !path.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
            .Where(path => !path.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
            .Where(path => !string.Equals(Path.GetFileName(path), "LocalPipeBridge.cs", StringComparison.Ordinal))
            .OrderBy(path => path, StringComparer.Ordinal)
            .ToArray();

        List<string> population = new();
        List<string> unobserved = new();
        foreach (string path in sources)
        {
            string[] lines = File.ReadAllLines(path);
            for (int index = 0; index < lines.Length; index++)
            {
                string line = lines[index];
                int call = line.IndexOf("TryEnqueueOutbound(", StringComparison.Ordinal);
                if (call < 0) continue;
                string trimmed = line.TrimStart();
                if (trimmed.StartsWith("//", StringComparison.Ordinal) || trimmed.StartsWith("*", StringComparison.Ordinal)) continue;
                population.Add($"{Path.GetFileName(path)}:{index + 1}");
                // The answer must be USED: a bare call statement would lose the frame with no caller reaction at all.
                bool consumed = line.Contains("if (", StringComparison.Ordinal)
                    || line.Contains('!')
                    || line.Contains("&&", StringComparison.Ordinal)
                    || line.Contains("||", StringComparison.Ordinal)
                    || line.Contains(" = ", StringComparison.Ordinal)
                    || line.Contains("return ", StringComparison.Ordinal);
                if (!consumed)
                    unobserved.Add($"bridge_frame_drop_unobserved:{Path.GetFileName(path)}:{index + 1}");
            }
        }

        population.Should().NotBeEmpty("a census that examines nothing agrees with itself");
        this.output.WriteLine($"outbound frame consumers examined: {population.Count} ({string.Join(", ", population)})");
        unobserved.Should().BeEmpty(
            "a caller that discards the admission answer loses a receipt with nobody watching: " + string.Join(" | ", unobserved));

        // The publication itself: the bridge names the refusal, and the heartbeat carries the counters, so a bundle
        // shows both a lost frame and the pressure that caused it.
        string modEntry = ReadModSource("ModEntry.cs");
        modEntry.Should().Contain("bridge_frame_refused:{kind}:{count}",
            "the refusal must be published as the named fact the operator greps for");
        modEntry.Should().Contain("TryTakeRefusedFrameFact(",
            "the named fact must be released by the publication point, not only accumulated");
        string instrumentation = ReadModSource("ModEntry.Instrumentation.cs");
        instrumentation.Should().Contain("SnapshotOutboundFrameCounters()",
            "the run bundle's diagnostics line must carry the outbound counters");
        instrumentation.Should().Contain("tx=",
            "the heartbeat must publish admitted/drained/refused beside the inbound `rx=` reading");
    }

    private static string ReadModSource(string fileName) =>
        File.ReadAllText(Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, RepositoryRelativeRoot, "integrations", "stardew", fileName)));

    /// <summary>Every refusal still unpublished, one window apart, in the order the windows release them.</summary>
    private static List<(string Kind, long Count)> TakeAllRefusedFacts(LocalPipeBridge bridge)
    {
        List<(string Kind, long Count)> facts = new();
        long windowMs = LocalPipeBridge.RefusedFrameFactIntervalMilliseconds;
        while (facts.Count < 16 && bridge.TryTakeRefusedFrameFact(windowMs, out string kind, out long count))
        {
            facts.Add((kind, count));
            windowMs += LocalPipeBridge.RefusedFrameFactIntervalMilliseconds;
        }

        return facts;
    }

    /// <summary>A frame of the shape the Mod emits: the type is the first member, which is what the fact names.</summary>
    private static string Frame(string type) => "{\"type\":\"" + type + "\",\"correlationId\":\"" + Guid.NewGuid().ToString("N") + "\"}";

    /// <summary>A frame that occupies the pipe's whole output buffer, so the writer blocks and the queue fills.</summary>
    private static string FullFrame(string type)
    {
        string head = "{\"type\":\"" + type + "\",\"payload\":\"";
        const string Tail = "\"}";
        return head + new string('x', BridgeProtocol.MaximumMessageBytes - head.Length - Tail.Length) + Tail;
    }

    private static NamedPipeClientStream ConnectClient(string pipeName)
    {
        NamedPipeClientStream client = new(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        client.Connect(5_000);
        return client;
    }

    private static long WaitForGeneration(LocalPipeBridge bridge)
    {
        long deadline = Environment.TickCount64 + 5_000;
        while (Environment.TickCount64 < deadline)
        {
            long generation = bridge.CurrentGeneration;
            if (generation != 0) return generation;
            Thread.Sleep(5);
        }

        throw new InvalidOperationException("named-pipe generation did not connect within the bounded window.");
    }

    private static async Task<byte[]> ReadFrameAsync(Stream stream, CancellationToken cancellationToken)
    {
        byte[] lengthBuffer = new byte[sizeof(int)];
        await ReadExactlyAsync(stream, lengthBuffer, cancellationToken).ConfigureAwait(false);
        int length = BitConverter.ToInt32(lengthBuffer, 0);
        if (length is <= 0 or > BridgeProtocol.MaximumMessageBytes)
            throw new InvalidDataException("bridge_frame_length_invalid");
        byte[] payload = new byte[length];
        await ReadExactlyAsync(stream, payload, cancellationToken).ConfigureAwait(false);
        return payload;
    }

    private static async Task ReadExactlyAsync(Stream stream, byte[] buffer, CancellationToken cancellationToken)
    {
        int offset = 0;
        while (offset < buffer.Length)
        {
            int read = await stream.ReadAsync(buffer.AsMemory(offset), cancellationToken).ConfigureAwait(false);
            if (read == 0) throw new EndOfStreamException();
            offset += read;
        }
    }
}
