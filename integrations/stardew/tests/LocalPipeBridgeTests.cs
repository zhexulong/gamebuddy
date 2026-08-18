using System.IO.Pipes;
using System.Text;

namespace GameBuddy.Stardew;

/// <summary>
/// Frozen P1 transport characterization of the serial OS pipe teardown/purge
/// boundary of PortfolioLocalPipeBridge. A queued G frame paused after
/// dequeue and exact generation validation but before WriteFrameAsync is
/// invalidated on G disconnect: its completion resolves false, no G frame can
/// reach the successor G+1 connection, and after the old worker fully settles
/// a freshly enqueued G+1 frame is delivered once with a true completion.
/// The bridge holds one NamedPipeServerStream and waits for both reader and
/// writer before DiscardGeneration, so this proves only the serial
/// teardown/purge boundary, not a concurrent G/G+1 race. It is not Host
/// receipt consumption, coordinator terminal delivery, action execution,
/// live closure, or capability-generation withdrawal.
/// </summary>
internal static class LocalPipeBridgeTests
{
    private const int BoundedNoFrameWindowMilliseconds = 300;
    private const int BoundedDeliveryWindowMilliseconds = 5_000;

    internal static void Run()
    {
        string pipeName = "gamebuddy_local_pipe_contract_" + Guid.NewGuid().ToString("N");
        using PreWriteGate gate = new();
        using PortfolioLocalPipeBridge bridge = new(pipeName, gate.ObserveAsync);
        NamedPipeClientStream? clientA = null;
        NamedPipeClientStream? clientB = null;
        try
        {
            clientA = ConnectClient(pipeName);
            long generationA = WaitForGeneration(bridge);

            Require(bridge.TryEnqueueOutbound(generationA, "stale-g-frame", out PortfolioPipeOutboundCompletion staleCompletion),
                "a queued G frame must be admitted at the connected G generation.");
            Require(gate.Reached.Wait(BoundedDeliveryWindowMilliseconds),
                "the writer must reach the pre-write gate after dequeue and generation validation.");
            Require(gate.ObservedGeneration == generationA,
                "the pre-write gate must observe exactly the dequeued G generation.");

            clientA.Dispose();
            clientA = null;

            Require(WaitForCompletion(staleCompletion, out bool staleSucceeded, BoundedDeliveryWindowMilliseconds) && !staleSucceeded,
                "the G frame completion must resolve false exactly once when its connection disconnects at the pre-write gate.");
            Require(WaitForSettled(bridge, BoundedDeliveryWindowMilliseconds),
                "the bridge must settle to no current generation after the old worker fully stops.");
            Require(bridge.TryConsumeDisconnect(out PortfolioPipeDisconnect? disconnect)
                && disconnect is not null && disconnect.Generation == generationA && disconnect.ReasonCode == "pipe_disconnected",
                "the bridge must record exactly one disconnect fact for G.");
            Require(!bridge.TryConsumeDisconnect(out _),
                "the disconnect fact must be consumed exactly once.");

            clientB = ConnectClient(pipeName);
            long generationB = WaitForGeneration(bridge);
            Require(generationB == generationA + 1,
                "after serial teardown the successor connection must be the strict G+1 generation.");
            Require(!TryReadFrame(clientB, BoundedNoFrameWindowMilliseconds, out _),
                "the stale G frame must not be readable on the G+1 connection (bounded cancellation window, no sleep race).");

            Require(bridge.TryEnqueueOutbound(generationB, "g-plus-one-frame", out PortfolioPipeOutboundCompletion deliveredCompletion),
                "a queued G+1 frame must be admitted at the G+1 generation.");
            gate.Release();
            byte[] delivered = ReadFrame(clientB, BoundedDeliveryWindowMilliseconds,
                "the G+1 frame must arrive within the bounded delivery window.");
            Require(delivered.Length == Encoding.UTF8.GetByteCount("g-plus-one-frame"),
                "the G+1 frame must preserve its exact bounded length.");
            Require(Encoding.UTF8.GetString(delivered) == "g-plus-one-frame",
                "the G+1 peer must read exactly the G+1 frame, not any stale G frame.");
            Require(WaitForCompletion(deliveredCompletion, out bool deliveredSucceeded, BoundedDeliveryWindowMilliseconds) && deliveredSucceeded,
                "the G+1 frame completion must resolve true after the successor peer consumes the frame.");
        }
        finally
        {
            // Cleanup must never leak a blocked gate or client: release the
            // gate and close both clients before the bridge is disposed.
            gate.Release();
            clientA?.Dispose();
            clientB?.Dispose();
        }
    }

    private static NamedPipeClientStream ConnectClient(string pipeName)
    {
        NamedPipeClientStream client = new(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        try { client.Connect(BoundedDeliveryWindowMilliseconds); }
        catch { client.Dispose(); throw; }
        return client;
    }

    private static long WaitForGeneration(PortfolioLocalPipeBridge bridge)
    {
        long deadline = Environment.TickCount64 + BoundedDeliveryWindowMilliseconds;
        while (Environment.TickCount64 < deadline)
        {
            long generation = bridge.CurrentGeneration;
            if (generation != 0) return generation;
            Thread.Sleep(10);
        }
        throw new InvalidOperationException("named-pipe generation did not connect within the bounded window.");
    }

    private static bool WaitForSettled(PortfolioLocalPipeBridge bridge, int timeoutMs)
    {
        long deadline = Environment.TickCount64 + timeoutMs;
        while (bridge.CurrentGeneration != 0 && Environment.TickCount64 < deadline)
            Thread.Sleep(10);
        return bridge.CurrentGeneration == 0;
    }

    private static bool WaitForCompletion(PortfolioPipeOutboundCompletion completion, out bool succeeded, int timeoutMs)
    {
        long deadline = Environment.TickCount64 + timeoutMs;
        while (!completion.IsCompleted && Environment.TickCount64 < deadline)
            Thread.Sleep(10);
        if (!completion.IsCompleted)
        {
            succeeded = false;
            return false;
        }
        succeeded = completion.Succeeded;
        return true;
    }

    private static bool TryReadFrame(NamedPipeClientStream client, int timeoutMs, out byte[] payload)
    {
        using CancellationTokenSource cancellation = new();
        Task<byte[]> read = ReadFrameAsync(client, cancellation.Token);
        if (read.Wait(timeoutMs))
        {
            payload = read.GetAwaiter().GetResult();
            return true;
        }

        // Do not issue another read on this stream until this cancelled read
        // has settled; otherwise the no-frame probe could race G+1 delivery.
        cancellation.Cancel();
        try { read.GetAwaiter().GetResult(); }
        catch (OperationCanceledException) { }
        payload = Array.Empty<byte>();
        return false;
    }

    private static byte[] ReadFrame(NamedPipeClientStream client, int timeoutMs, string failureMessage)
    {
        using CancellationTokenSource cancellation = new(timeoutMs);
        Task<byte[]> read = ReadFrameAsync(client, cancellation.Token);
        try { read.Wait(cancellation.Token); }
        catch (OperationCanceledException) { throw new InvalidOperationException(failureMessage); }
        return read.GetAwaiter().GetResult();
    }

    private static async Task<byte[]> ReadFrameAsync(NamedPipeClientStream client, CancellationToken cancellationToken)
    {
        byte[] lengthBuffer = new byte[sizeof(int)];
        await ReadExactlyAsync(client, lengthBuffer, cancellationToken).ConfigureAwait(false);
        int length = BitConverter.ToInt32(lengthBuffer, 0);
        Require(length > 0, "a bridge frame must carry a positive payload length.");
        byte[] payload = new byte[length];
        await ReadExactlyAsync(client, payload, cancellationToken).ConfigureAwait(false);
        return payload;
    }

    private static async Task ReadExactlyAsync(Stream stream, byte[] buffer, CancellationToken cancellationToken)
    {
        int offset = 0;
        while (offset < buffer.Length)
        {
            int read = await stream.ReadAsync(buffer.AsMemory(offset), cancellationToken).ConfigureAwait(false);
            if (read == 0)
                throw new EndOfStreamException("named-pipe peer closed before a complete frame.");
            offset += read;
        }
    }

    private static void Require(bool value, string message)
    {
        if (!value) throw new InvalidOperationException(message);
    }

    /// <summary>
    /// Test-only pre-write gate installed through the bridge's internal
    /// observer seam. It records the observed generation, signals the test
    /// once the writer reached the pre-write point, and then blocks until the
    /// test releases it or the connection cancellation token fires.
    /// </summary>
    private sealed class PreWriteGate : IDisposable
    {
        private readonly TaskCompletionSource reached = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource release = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private long observedGeneration;

        internal Task Reached => this.reached.Task;

        internal long ObservedGeneration => Interlocked.Read(ref this.observedGeneration);

        internal void Release() => this.release.TrySetResult();

        internal async Task ObserveAsync(long generation, CancellationToken cancellationToken)
        {
            Interlocked.Exchange(ref this.observedGeneration, generation);
            this.reached.TrySetResult();
            TaskCompletionSource cancelled = new(TaskCreationOptions.RunContinuationsAsynchronously);
            using (cancellationToken.Register(static state => ((TaskCompletionSource)state!).TrySetResult(), cancelled))
            {
                await Task.WhenAny(this.release.Task, cancelled.Task).ConfigureAwait(false);
            }
            cancellationToken.ThrowIfCancellationRequested();
        }

        public void Dispose() => this.release.TrySetResult();
    }
}
