using System.IO.Pipes;
using System.Text;
using GameBuddy.Stardew;

/// <summary>
/// Focused Farmhand-only contract for the ordinary LocalPipeBridge outbound
/// completion, run without any external peer or Host. Queue admission is not
/// delivery: a queued frame's exact PipeOutboundCompletion stays unresolved at
/// admission and later resolves exactly once to the actual write outcome of
/// that exact generation-bound frame. A stale pre-connect frame, a frame that
/// cannot be flushed when its connection disconnects, and a frame still queued
/// when the bridge is disposed all resolve false; only a frame flushed to the
/// live connection resolves true. No Stardew game, Host receiver, schema, or
/// Portfolio transport is involved.
///
/// The same admission-is-not-delivery contract is pinned for terminal receipt
/// publication: ModEntry.TerminalReceiptDeliveryTracker keeps an admitted
/// terminal receipt pending until its exact completion settles, settles to
/// Flushed only on a real flush, and demotes write-failed or window-expired
/// completions to unconfirmed diagnostics instead of claiming delivery. Mod
/// IsUnconfirmedTerminal is pinned to the wire/Host terminal vocabulary.
/// </summary>
internal static class FarmhandLocalPipeBridgeDeliveryTests
{
    private const int BoundedNoFrameWindowMilliseconds = 300;
    private const int BoundedDeliveryWindowMilliseconds = 5_000;

    // Authoritative Host terminal/progress receipt classifications, mirrored
    // from host/src/execution-correlation-ledger.ts, gameplay-task-subagent.ts
    // and stardew-integration-launcher.ts (terminal) and host/src/receipt-replay.ts
    // (progress). Mod IsUnconfirmedTerminal must partition the wire vocabulary
    // on exactly the same sides.
    private static readonly string[] HostTerminalWireStates =
    {
        "blocked", "invalidated", "succeeded", "partially_succeeded", "failed",
        "cancelled", "expired", "rejected", "uncertain",
    };
    private static readonly string[] HostProgressWireStates =
    {
        "accepted", "running", "meaningful_progress",
    };

    internal static void Run()
    {
        RunAdmissionIsNotDeliveryAndExactStaleResolution();
        RunDisconnectResolvesPendingCompletionFalse();
        RunDisposeResolvesPendingCompletionFalseAndRejectsAdmission();
        RunUnconfirmedTerminalClassificationMatchesWireAndHostTerminalStates();
        RunTerminalReceiptDeliveryTrackerFlushedConfirmsExactlyOnce();
        RunTerminalReceiptDeliveryTrackerDisconnectSettlesWriteFailed();
        RunTerminalReceiptDeliveryTrackerWindowSettlesFlushUnconfirmed();
        RunTerminalReceiptDeliveryTrackerBoundedQueues();
    }

    /// <summary>
    /// A frame admitted before any connection (generation 0 equals the
    /// not-yet-connected generation) is queue admission only: its exact
    /// completion resolves false when the connected write loop rejects the
    /// stale generation, the frame never reaches the peer, and the successor
    /// current-generation frame resolves true exactly once after the peer
    /// consumes it.
    /// </summary>
    private static void RunAdmissionIsNotDeliveryAndExactStaleResolution()
    {
        string pipeName = "gamebuddy_farmhand_delivery_" + Guid.NewGuid().ToString("N");
        using LocalPipeBridge bridge = new(pipeName);
        NamedPipeClientStream? client = null;
        try
        {
            Require(bridge.CurrentGeneration == 0, "a fresh Farmhand bridge must not be connected.");

            Require(bridge.TryEnqueueOutbound(0, "stale-pre-connect", out PipeOutboundCompletion staleCompletion),
                "admission before a connection must accept the queue entry.");
            Require(!staleCompletion.Result.IsCompleted,
                "admission alone must not resolve the exact completion.");
            Require(staleCompletion.Generation == 0,
                "the exact completion must stay bound to its frame generation.");

            client = ConnectClient(pipeName);
            long generationA = WaitForGeneration(bridge);
            Require(generationA == 1, "the first Farmhand connection must receive generation 1.");

            Require(WaitForCompletion(staleCompletion, out bool staleSucceeded, BoundedDeliveryWindowMilliseconds) && !staleSucceeded,
                "the stale pre-connect frame must resolve false when the connected write loop rejects its generation.");
            staleCompletion.Resolve(true);
            Require(WaitForCompletion(staleCompletion, out staleSucceeded, BoundedDeliveryWindowMilliseconds) && !staleSucceeded,
                "the exact completion must resolve false exactly once; a later resolve must not flip it.");
            Require(!TryReadFrame(client, BoundedNoFrameWindowMilliseconds, out _),
                "the stale pre-connect frame must never reach the connected peer.");

            Require(bridge.TryEnqueueOutbound(generationA, "terminal-frame-1", out PipeOutboundCompletion deliveredCompletion),
                "a current-generation frame must be admitted at its connected generation.");
            Require(deliveredCompletion.Generation == generationA,
                "the delivered completion must be bound to the current generation.");
            byte[] delivered = ReadFrame(client, BoundedDeliveryWindowMilliseconds,
                "the current-generation frame must arrive within the bounded window.");
            Require(delivered.Length == Encoding.UTF8.GetByteCount("terminal-frame-1"),
                "the current-generation frame must preserve its exact length.");
            Require(Encoding.UTF8.GetString(delivered) == "terminal-frame-1",
                "the peer must read exactly the current-generation frame.");
            Require(WaitForCompletion(deliveredCompletion, out bool deliveredSucceeded, BoundedDeliveryWindowMilliseconds) && deliveredSucceeded,
                "a flushed current-generation frame must resolve its exact completion true.");
            deliveredCompletion.Resolve(false);
            Require(WaitForCompletion(deliveredCompletion, out deliveredSucceeded, BoundedDeliveryWindowMilliseconds) && deliveredSucceeded,
                "the exact completion must resolve true exactly once; a later resolve must not flip it.");
            Require(!TryReadFrame(client, BoundedNoFrameWindowMilliseconds, out _),
                "no frame beyond the single delivered frame may reach the peer.");
        }
        finally
        {
            client?.Dispose();
        }
    }

    /// <summary>
    /// While the peer never reads, a full-buffer frame occupies the byte-mode
    /// pipe and the writer, so the second equal-size frame can never be
    /// flushed and stays pending (queued or blocked mid-write) when the
    /// connection dies. That exact completion must resolve false; the bridge
    /// records one worker terminal fact for the exact disconnecting
    /// generation, the strict G+1 successor sees no stale frame, and a stale
    /// generation cannot be admitted again.
    /// </summary>
    private static void RunDisconnectResolvesPendingCompletionFalse()
    {
        string pipeName = "gamebuddy_farmhand_disconnect_" + Guid.NewGuid().ToString("N");
        using LocalPipeBridge bridge = new(pipeName);
        NamedPipeClientStream? clientA = null;
        NamedPipeClientStream? clientB = null;
        try
        {
            clientA = ConnectClient(pipeName);
            long generationA = WaitForGeneration(bridge);
            Require(generationA == 1, "the disconnect-phase connection must be generation 1.");

            string fullFrame = new('x', BridgeProtocol.MaximumMessageBytes);
            Require(bridge.TryEnqueueOutbound(generationA, fullFrame, out PipeOutboundCompletion occupiedCompletion),
                "the buffer-occupying frame must be admitted.");
            Require(bridge.TryEnqueueOutbound(generationA, fullFrame, out PipeOutboundCompletion pendingCompletion),
                "the asserted frame must be admitted behind the buffer-occupying frame.");
            Require(!pendingCompletion.Result.IsCompleted,
                "a frame that cannot be flushed must stay unresolved at admission.");
            Require(pendingCompletion.Generation == generationA,
                "the pending completion must be bound to the disconnecting generation.");

            clientA.Dispose();
            clientA = null;

            Require(WaitForCompletion(pendingCompletion, out bool pendingSucceeded, BoundedDeliveryWindowMilliseconds) && !pendingSucceeded,
                "the never-flushed frame must resolve false when its connection disconnects; no silent delivery.");
            Require(WaitForSettled(bridge, BoundedDeliveryWindowMilliseconds),
                "the bridge must settle to no current generation after the disconnect.");
            Require(bridge.TryConsumeWorkerTerminal(out PipeWorkerTerminal? terminal)
                && terminal is not null && terminal.Generation == generationA
                && terminal.Kind is PipeWorkerTerminalKind.ReaderEnded or PipeWorkerTerminalKind.WriterEnded,
                "the bridge must record exactly one worker terminal fact for the disconnecting generation.");
            Require(!bridge.TryConsumeWorkerTerminal(out _),
                "the worker terminal fact must be consumed exactly once.");

            clientB = ConnectClient(pipeName);
            long generationB = WaitForGeneration(bridge);
            Require(generationB == generationA + 1, "the successor connection must be the strict generation G+1.");
            Require(!TryReadFrame(clientB, BoundedNoFrameWindowMilliseconds, out _),
                "the disconnected generation's frames must not be readable on the G+1 connection.");

            Require(!bridge.TryEnqueueOutbound(generationA, "stale-after-disconnect", out PipeOutboundCompletion staleRejected),
                "admission for the disconnected generation must be rejected after the successor connects.");
            Require(WaitForCompletion(staleRejected, out bool staleRejectedSucceeded, BoundedDeliveryWindowMilliseconds) && !staleRejectedSucceeded,
                "the rejected stale completion must resolve false.");
        }
        finally
        {
            clientA?.Dispose();
            clientB?.Dispose();
        }
    }

    /// <summary>
    /// A frame admitted before any connection sits in the outbound queue when
    /// the bridge is disposed. Dispose must resolve that exact completion
    /// false (queue drain resolves each admitted frame to its actual write
    /// outcome), and every later admission must be rejected with a resolved
    /// false completion.
    /// </summary>
    private static void RunDisposeResolvesPendingCompletionFalseAndRejectsAdmission()
    {
        string pipeName = "gamebuddy_farmhand_dispose_" + Guid.NewGuid().ToString("N");
        LocalPipeBridge bridge = new(pipeName);
        try
        {
            Require(bridge.TryEnqueueOutbound(0, "pre-dispose-frame", out PipeOutboundCompletion pendingCompletion),
                "admission before a connection must accept the queue entry.");
            Require(!pendingCompletion.Result.IsCompleted,
                "admission alone must not resolve the exact completion.");

            bridge.Dispose();

            Require(WaitForCompletion(pendingCompletion, out bool disposedSucceeded, BoundedDeliveryWindowMilliseconds) && !disposedSucceeded,
                "dispose must resolve the queued completion false; no silent successful delivery.");
            Require(!bridge.TryEnqueueOutbound(0, "post-dispose-frame", out PipeOutboundCompletion rejectedCompletion),
                "admission after dispose must be rejected.");
            Require(WaitForCompletion(rejectedCompletion, out bool rejectedSucceeded, BoundedDeliveryWindowMilliseconds) && !rejectedSucceeded,
                "the rejected completion must resolve false.");
            Require(!bridge.TryEnqueueOutbound(0, "post-dispose-frame"),
                "every post-dispose admission must be rejected.");
        }
        finally
        {
            // Dispose is the subject of this phase and is already exercised;
            // a second dispose would release/dispose the bridge semaphore
            // again, so the bridge is intentionally not touched here.
        }
    }

    private static void RunTerminalReceiptDeliveryTrackerBoundedQueues()
    {
        ModEntry.TerminalReceiptDeliveryTracker tracker = new();
        long nowMs = Environment.TickCount64;
        for (int index = 0; index < 16; index++)
        {
            Require(tracker.TryTrack($"pending_{index}", ExecutionState.Rejected, 1, new PipeOutboundCompletion(1), nowMs),
                "sixteen admitted terminal receipts must fit the bounded pending queue.");
            Require(tracker.Observe(nowMs) == ModEntry.TerminalReceiptDeliveryTracker.ObserveOutcome.Pending,
                "unresolved admissions must not settle early.");
        }
        Require(!tracker.TryTrack("pending_16", ExecutionState.Rejected, 1, new PipeOutboundCompletion(1), nowMs),
            "a seventeenth pending admission must be refused fail-closed.");

        for (int index = 0; index < 16; index++)
        {
            Require(tracker.RetainUnconfirmed($"unconfirmed_{index}", ExecutionState.Blocked, 1, nowMs),
                "sixteen unconfirmed diagnostics must be retained without eviction.");
        }
        Require(!tracker.RetainUnconfirmed("unconfirmed_16", ExecutionState.Blocked, 1, nowMs),
            "a seventeenth unconfirmed record must evict the oldest and report the overflow.");
    }

    /// <summary>
    /// A terminal receipt whose exact completion stays unresolved past the
    /// bounded confirmation window is not delivery: the tracker settles it to
    /// FlushUnconfirmed and demotes it out of the pending queue, so the caller
    /// records an unconfirmed diagnostic instead of claiming delivery.
    /// </summary>
    private static void RunTerminalReceiptDeliveryTrackerWindowSettlesFlushUnconfirmed()
    {
        ModEntry.TerminalReceiptDeliveryTracker tracker = new();
        long nowMs = Environment.TickCount64;
        PipeOutboundCompletion stuck = new(1);
        Require(tracker.TryTrack("uncertain_request", ExecutionState.Uncertain, 1, stuck, nowMs),
            "an unresolved terminal receipt must be tracked pending.");
        Require(tracker.Observe(nowMs) == ModEntry.TerminalReceiptDeliveryTracker.ObserveOutcome.Pending,
            "an unresolved head must stay Pending inside its confirmation window.");
        Require(tracker.Observe(nowMs + 2_001) == ModEntry.TerminalReceiptDeliveryTracker.ObserveOutcome.FlushUnconfirmed,
            "past the bounded confirmation window an unresolved head must settle to FlushUnconfirmed.");
        Require(tracker.Observe(nowMs + 2_001) == ModEntry.TerminalReceiptDeliveryTracker.ObserveOutcome.Pending,
            "after the FlushUnconfirmed demotion the tracker must be idle again.");
        stuck.Resolve(true);
        Require(tracker.Observe(nowMs + 2_001) == ModEntry.TerminalReceiptDeliveryTracker.ObserveOutcome.Pending,
            "a late resolve must not resurrect a demoted receipt into the pending queue.");
    }

    /// <summary>
    /// A terminal receipt admitted behind a full pipe buffer is still pending
    /// at admission; when its connection disconnects before the writer can
    /// flush it, the exact completion resolves false and the tracker settles
    /// the receipt to WriteFailed (delivery was not confirmed) and demotes it
    /// out of the pending queue so it can never be claimed delivered.
    /// </summary>
    private static void RunTerminalReceiptDeliveryTrackerDisconnectSettlesWriteFailed()
    {
        string pipeName = "gamebuddy_farmhand_tracker_write_failed_" + Guid.NewGuid().ToString("N");
        using LocalPipeBridge bridge = new(pipeName);
        NamedPipeClientStream? client = null;
        try
        {
            client = ConnectClient(pipeName);
            long generation = WaitForGeneration(bridge);
            Require(generation == 1, "the tracker write-failed connection must be generation 1.");

            string fullFrame = new('x', BridgeProtocol.MaximumMessageBytes);
            Require(bridge.TryEnqueueOutbound(generation, fullFrame, out _),
                "the buffer-occupying frame must be admitted.");
            ModEntry.TerminalReceiptDeliveryTracker tracker = new();
            Require(bridge.TryEnqueueOutbound(generation, fullFrame, out PipeOutboundCompletion pendingCompletion),
                "the failed-to-flush terminal frame must be admitted behind the occupying frame.");
            Require(tracker.TryTrack("blocked_request", ExecutionState.Blocked, generation, pendingCompletion, Environment.TickCount64),
                "the never-flushed terminal receipt must be tracked pending.");
            Require(!pendingCompletion.Result.IsCompleted,
                "the never-flushed terminal frame must stay unresolved at admission.");
            Require(tracker.Observe(Environment.TickCount64) == ModEntry.TerminalReceiptDeliveryTracker.ObserveOutcome.Pending,
                "an unresolved admission must stay Pending inside its confirmation window.");

            client.Dispose();
            client = null;

            Require(WaitForCompletion(pendingCompletion, out bool pendingSucceeded, BoundedDeliveryWindowMilliseconds) && !pendingSucceeded,
                "the never-flushed frame must resolve false when its connection disconnects.");
            Require(tracker.Observe(Environment.TickCount64) == ModEntry.TerminalReceiptDeliveryTracker.ObserveOutcome.WriteFailed,
                "the resolved-false completion must settle the tracked receipt to WriteFailed, never Flushed.");
            Require(tracker.Observe(Environment.TickCount64) == ModEntry.TerminalReceiptDeliveryTracker.ObserveOutcome.Pending,
                "after the WriteFailed demotion the tracker must be idle again.");
        }
        finally
        {
            client?.Dispose();
        }
    }

    /// <summary>
    /// An admitted terminal receipt is not delivery: the tracker keeps its
    /// exact completion pending until the bridge writer flushes the frame to
    /// the live peer, and only that exact true flush settles the outcome to
    /// Flushed. A settled tracker stays idle afterwards.
    /// </summary>
    private static void RunTerminalReceiptDeliveryTrackerFlushedConfirmsExactlyOnce()
    {
        string pipeName = "gamebuddy_farmhand_tracker_flushed_" + Guid.NewGuid().ToString("N");
        using LocalPipeBridge bridge = new(pipeName);
        NamedPipeClientStream? client = null;
        try
        {
            client = ConnectClient(pipeName);
            long generation = WaitForGeneration(bridge);
            Require(generation == 1, "the tracker flushed-phase connection must be generation 1.");

            ModEntry.TerminalReceiptDeliveryTracker tracker = new();
            Require(bridge.TryEnqueueOutbound(generation, "tracked-terminal", out PipeOutboundCompletion completion),
                "the terminal frame must be admitted to the authenticated connection.");
            Require(tracker.TryTrack("tracked_request", ExecutionState.Succeeded, generation, completion, Environment.TickCount64),
                "an admitted terminal receipt must be tracked pending its exact completion.");
            Require(Encoding.UTF8.GetString(ReadFrame(client, BoundedDeliveryWindowMilliseconds,
                "the tracked terminal frame must reach the live peer within the bounded window.")) == "tracked-terminal",
                "the peer must read exactly the tracked terminal frame.");
            Require(WaitForCompletion(completion, out bool flushedSucceeded, BoundedDeliveryWindowMilliseconds) && flushedSucceeded,
                "the flushed frame must resolve its exact completion true.");
            Require(tracker.Observe(Environment.TickCount64) == ModEntry.TerminalReceiptDeliveryTracker.ObserveOutcome.Flushed,
                "the resolved-true completion must settle the tracked receipt to Flushed exactly once.");
            Require(tracker.Observe(Environment.TickCount64) == ModEntry.TerminalReceiptDeliveryTracker.ObserveOutcome.Pending,
                "a settled tracker must return Pending for its empty queue.");
        }
        finally
        {
            client?.Dispose();
        }
    }

    /// <summary>
    /// Mod IsUnconfirmedTerminal must partition the Mod execution-state
    /// vocabulary on exactly the same sides as the wire/Host terminal-receipt
    /// classification: blocked, invalidated, succeeded, partially_succeeded,
    /// failed, cancelled, expired, rejected and uncertain are terminal;
    /// accepted, running and meaningful_progress are progress states.
    /// </summary>
    private static void RunUnconfirmedTerminalClassificationMatchesWireAndHostTerminalStates()
    {
        Require(((ExecutionState[])Enum.GetValues(typeof(ExecutionState))).Length == 12,
            "the classification partition must cover the exact Mod execution-state vocabulary.");
        foreach (ExecutionState state in new[]
        {
            ExecutionState.Succeeded, ExecutionState.PartiallySucceeded, ExecutionState.Failed,
            ExecutionState.Cancelled, ExecutionState.Invalidated, ExecutionState.Expired,
            ExecutionState.Rejected, ExecutionState.Blocked, ExecutionState.Uncertain,
        })
        {
            string wire = state.ToWireValue();
            Require(HostTerminalWireStates.Contains(wire, StringComparer.Ordinal),
                $"a Mod-unconfirmed-terminal state must map to a Host-terminal wire state: {wire}");
            Require(!HostProgressWireStates.Contains(wire, StringComparer.Ordinal),
                $"a Mod-unconfirmed-terminal state must not map to a Host-progress wire state: {wire}");
            Require(ModEntry.IsUnconfirmedTerminal(state),
                $"a Host-terminal wire state must be Mod-unconfirmed-terminal: {wire}");
        }
        foreach (ExecutionState state in new[]
        {
            ExecutionState.Accepted, ExecutionState.Running, ExecutionState.MeaningfulProgress,
        })
        {
            string wire = state.ToWireValue();
            Require(HostProgressWireStates.Contains(wire, StringComparer.Ordinal),
                $"a Mod progress state must map to a Host-progress wire state: {wire}");
            Require(!HostTerminalWireStates.Contains(wire, StringComparer.Ordinal),
                $"a Mod progress state must not map to a Host-terminal wire state: {wire}");
            Require(!ModEntry.IsUnconfirmedTerminal(state),
                $"a Host-progress wire state must not be Mod-unconfirmed-terminal: {wire}");
        }
    }

    private static NamedPipeClientStream ConnectClient(string pipeName)
    {
        NamedPipeClientStream client = new(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        try { client.Connect(BoundedDeliveryWindowMilliseconds); }
        catch { client.Dispose(); throw; }
        return client;
    }

    private static long WaitForGeneration(LocalPipeBridge bridge)
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

    private static bool WaitForSettled(LocalPipeBridge bridge, int timeoutMs)
    {
        long deadline = Environment.TickCount64 + timeoutMs;
        while (bridge.CurrentGeneration != 0 && Environment.TickCount64 < deadline)
            Thread.Sleep(10);
        return bridge.CurrentGeneration == 0;
    }

    private static bool WaitForCompletion(PipeOutboundCompletion completion, out bool succeeded, int timeoutMs)
    {
        long deadline = Environment.TickCount64 + timeoutMs;
        while (!completion.Result.IsCompleted && Environment.TickCount64 < deadline)
            Thread.Sleep(10);
        if (!completion.Result.IsCompleted)
        {
            succeeded = false;
            return false;
        }
        succeeded = completion.Result.GetAwaiter().GetResult();
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
        // has settled; otherwise the no-frame probe could race a later frame.
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
}