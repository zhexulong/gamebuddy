using System.Collections.Concurrent;
using System.IO.Pipes;
using System.Text;

namespace GameBuddy.Stardew;

/// <summary>
/// Opt-in Windows-local IPC. Each connection receives a monotonically increasing
/// generation; only that generation's bounded frames may reach the game thread
/// or receive a response. Pipe I/O never calls Stardew APIs.
/// </summary>
internal sealed class LocalPipeBridge : IDisposable
{
    internal const int MaximumQueuedMessages = 64;

    /// <summary>
    /// The shortest interval between two published refusal facts.
    ///
    /// A queue that refuses a burst of frames must not answer with a burst of log lines, and a refusal nobody names is
    /// the defect itself: the counts accumulate per frame type between windows, so the totals a reader adds up still
    /// reach the refused counter instead of being a sample of it.
    /// </summary>
    internal const long RefusedFrameFactIntervalMilliseconds = 1_000L;

    private long inboundFramesRead;
    private long inboundFramesEnqueued;
    private string? lastInboundFrameType;

    /// <summary>
    /// What the reader thread has actually seen, for the game thread's own heartbeat line.
    ///
    /// The last blocker of a live night was a request the Host sent and the Mod never dequeued, and neither side's log
    /// said which end dropped it: the Host only reports its own timer, and the reader had no visibility from the game
    /// thread. These counters are that visibility - `read` counts frames off the pipe, `enqueued` counts frames handed to
    /// the game thread, so a gap between them names which half to look at, and `lastType` says what the newest frame was.
    /// </summary>
    internal readonly record struct InboundFrameCounters(long Read, long Enqueued, string? LastType);
    internal InboundFrameCounters SnapshotInboundFrameCounters() =>
        new(Interlocked.Read(ref this.inboundFramesRead), Interlocked.Read(ref this.inboundFramesEnqueued), this.lastInboundFrameType);

    /// <summary>
    /// The outbound half of the same visibility: the frames this bridge ADMITTED into its bounded queue, the ones its
    /// writer took back off it, the ones it REFUSED, and the deepest the queue ever got.
    ///
    /// A refusal past the cap was the one loss with no trace anywhere: the caller got false, and no artifact could say
    /// that a terminal receipt had been dropped - so a Host waiting for that receipt waited for a state that would never
    /// arrive. <c>Generation</c> names the connection the reading describes, and the counters are monotonic for the
    /// bridge's whole life so a reconnect cannot zero the refusals of the generation that dropped them. <c>Peak</c> is
    /// what makes a refusal diagnosable: at the cap it is backpressure, below the cap the frame was refused for its
    /// generation, its size, or a disposal.
    /// </summary>
    internal readonly record struct OutboundFrameCounters(long Generation, long Admitted, long Drained, long Refused, int Peak);

    internal OutboundFrameCounters SnapshotOutboundFrameCounters() => new(
        Interlocked.Read(ref this.connectedGeneration),
        Interlocked.Read(ref this.outboundFramesAdmitted),
        Interlocked.Read(ref this.outboundFramesDrained),
        Interlocked.Read(ref this.outboundFramesRefused),
        Volatile.Read(ref this.outboundPeakCount));

    /// <summary>
    /// The next refusal to publish, at most one per <see cref="RefusedFrameFactIntervalMilliseconds"/>.
    ///
    /// Naming every refused frame would answer a flood with a flood, and naming none is the defect. So refusals
    /// accumulate by the frame's own type, and one is released per window - the largest, with the others keeping their
    /// counts for later windows, so the published totals still add up to <see cref="OutboundFrameCounters.Refused"/>.
    /// </summary>
    internal bool TryTakeRefusedFrameFact(long nowMs, out string kind, out long count)
    {
        kind = string.Empty;
        count = 0;
        if (nowMs - Interlocked.Read(ref this.lastRefusedFrameFactAtMs) < RefusedFrameFactIntervalMilliseconds)
            return false;
        lock (this.outboundGate)
        {
            string? selected = null;
            long selectedCount = 0;
            foreach (KeyValuePair<string, long> candidate in this.refusedFrameCounts)
            {
                if (candidate.Value <= selectedCount) continue;
                selected = candidate.Key;
                selectedCount = candidate.Value;
            }
            if (selected is null || !this.refusedFrameCounts.Remove(selected))
                return false;
            kind = selected;
            count = selectedCount;
            Interlocked.Exchange(ref this.lastRefusedFrameFactAtMs, nowMs);
            return true;
        }
    }

    /// <summary>
    /// Records one frame the bridge refused to queue. Every false return of <see cref="TryEnqueueOutbound"/> passes
    /// through here, which is what makes <see cref="OutboundFrameCounters.Refused"/> equal to the refusals its callers
    /// observed instead of a separately maintained tally of them.
    /// </summary>
    private void RecordRefusedOutboundFrame(string json)
    {
        Interlocked.Increment(ref this.outboundFramesRefused);
        string kind = FrameTypeOf(json) ?? "untyped";
        lock (this.outboundGate)
            this.refusedFrameCounts[kind] = this.refusedFrameCounts.TryGetValue(kind, out long seen) ? seen + 1 : 1;
    }
    private readonly string pipeName;
    private readonly CancellationTokenSource cancellation = new();
    private readonly ConcurrentQueue<PipeInbound> inbound = new();
    private readonly ConcurrentQueue<PipeOutbound> outbound = new();
    // The game main thread admits outbound frames while the bridge worker
    // discards a dead connection's frames and dequeues one frame per delivery.
    // All three mutate outboundCount as the admitted count, so one gate must
    // serialize them: without it the count and the queue length diverge and a
    // drain can retire a frame the game thread admitted after the drain began.
    private readonly object outboundGate = new();
    private readonly SemaphoreSlim outboundSignal = new(0);
    private readonly Task worker;
    private int inboundCount;
    private int outboundCount;
    private int outboundPeakCount;
    private long outboundFramesAdmitted;
    private long outboundFramesDrained;
    private long outboundFramesRefused;
    private long lastRefusedFrameFactAtMs;
    // Refusals no published fact has named yet, by frame type. Written by the admitting thread under outboundGate and
    // taken under it too, so an accumulated count and the fact that releases it can never disagree.
    private readonly Dictionary<string, long> refusedFrameCounts = new(StringComparer.Ordinal);
    private long activeGeneration;
    private long connectedGeneration;
    private PipeWorkerTerminal? workerTerminal;

    internal LocalPipeBridge(string pipeName)
    {
        this.pipeName = pipeName;
        this.worker = Task.Run(this.RunAsync);
    }

    internal long CurrentGeneration => Interlocked.Read(ref this.connectedGeneration);

    /// <summary>
    /// Consumes the first worker terminal fact recorded for a connection. The
    /// background worker does not inspect its exception or pipe identity.
    /// </summary>
    internal bool TryConsumeWorkerTerminal(out PipeWorkerTerminal terminal)
    {
        terminal = Interlocked.Exchange(ref this.workerTerminal, null)!;
        return terminal is not null;
    }

    internal bool TryDequeueInbound(out PipeInbound message)
    {
        while (this.inbound.TryDequeue(out message!))
        {
            Interlocked.Decrement(ref this.inboundCount);
            if (message.Generation == Interlocked.Read(ref this.connectedGeneration))
                return true;
        }
        message = default!;
        return false;
    }

    internal bool TryEnqueueOutbound(long generation, string json)
        => this.TryEnqueueOutbound(generation, json, out _);

    /// <summary>
    /// Queue a frame and expose whether that exact authenticated connection
    /// wrote it to the Windows pipe. Queue admission alone is not Host delivery.
    /// </summary>
    internal bool TryEnqueueOutbound(long generation, string json, out PipeOutboundCompletion completion)
    {
        completion = new PipeOutboundCompletion(generation);
        if (generation != Interlocked.Read(ref this.connectedGeneration) || this.cancellation.IsCancellationRequested
            || Encoding.UTF8.GetByteCount(json) > BridgeProtocol.MaximumMessageBytes)
        {
            this.RecordRefusedOutboundFrame(json);
            completion.Resolve(false);
            return false;
        }
        bool admitted;
        lock (this.outboundGate)
        {
            admitted = ++this.outboundCount <= MaximumQueuedMessages;
            if (admitted)
            {
                this.outbound.Enqueue(new PipeOutbound(generation, json, completion));
                if (this.outboundCount > this.outboundPeakCount) this.outboundPeakCount = this.outboundCount;
            }
            else
                this.outboundCount--;
        }
        if (!admitted)
        {
            this.RecordRefusedOutboundFrame(json);
            completion.Resolve(false);
            return false;
        }
        try
        {
            this.outboundSignal.Release();
            Interlocked.Increment(ref this.outboundFramesAdmitted);
        }
        catch (ObjectDisposedException)
        {
            lock (this.outboundGate) this.outboundCount--;
            this.RecordRefusedOutboundFrame(json);
            completion.Resolve(false);
            return false;
        }
        return true;
    }

    private async Task RunAsync()
    {
        while (!this.cancellation.IsCancellationRequested)
        {
            long generation = Interlocked.Increment(ref this.activeGeneration);
            // Reserve a bounded server output buffer. The frame limit is the
            // only buffer size permitted here; the asynchronous writer flushes
            // each unsolicited event before completing its delivery receipt.
            using NamedPipeServerStream pipe = new(this.pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly, 0, BridgeProtocol.MaximumMessageBytes);
            try
            {
                await pipe.WaitForConnectionAsync(this.cancellation.Token).ConfigureAwait(false);
                Interlocked.Exchange(ref this.connectedGeneration, generation);
                using CancellationTokenSource connectionCancellation = CancellationTokenSource.CreateLinkedTokenSource(this.cancellation.Token);
                Task reader = this.ReadLoopAsync(pipe, generation, connectionCancellation.Token);
                Task writer = this.WriteLoopAsync(pipe, generation, connectionCancellation.Token);
                // A pipe supports one concurrent reader and one concurrent
                // writer. Do not treat a temporarily idle receive loop as a
                // connection failure: its pending ReadAsync must coexist with
                // outbound player-control frames until the peer actually
                // closes/faults or this bridge is disposed.
                Task completed = await Task.WhenAny(reader, writer).ConfigureAwait(false);
                if (!this.cancellation.IsCancellationRequested)
                {
                    PipeWorkerTerminalKind kind = ReferenceEquals(completed, reader)
                        ? PipeWorkerTerminalKind.ReaderEnded
                        : PipeWorkerTerminalKind.WriterEnded;
                    // WHY the worker ended, not only which one.
                    //
                    // Measured 2026-10-25: a run's bridge closed at in-game 22:00, the game kept logging for minutes
                    // afterwards, and nothing anywhere said why the peer went away - the terminal record carried the
                    // kind and dropped the one thing that would answer it. `completed` already holds it: a fault has
                    // an exception, a cancelled task says so, and a clean finish is its own answer.
                    Interlocked.CompareExchange(
                        ref this.workerTerminal,
                        new PipeWorkerTerminal(generation, kind, DescribeWorkerTerminal(completed)),
                        null);
                }
                connectionCancellation.Cancel();
                try { await Task.WhenAll(reader, writer).ConfigureAwait(false); }
                catch (OperationCanceledException) { }
                catch (EndOfStreamException) { }
                catch (IOException) { }
                if (completed.IsFaulted && completed.Exception is not null)
                    throw completed.Exception;
                this.DiscardGeneration(generation);
            }
            catch (OperationCanceledException) when (this.cancellation.IsCancellationRequested)
            {
                return;
            }
            catch (Exception) when (this.cancellation.IsCancellationRequested is false)
            {
                this.DiscardGeneration(generation);
                try { await Task.Delay(250, this.cancellation.Token).ConfigureAwait(false); }
                catch (OperationCanceledException) { return; }
            }
        }
    }

    /// <summary>
    /// Why a worker task ended, in one word or one exception name. `Task.WhenAny` returns the task, and the task already
    /// holds the answer: a fault carries an exception, a cancellation says so, a clean finish is its own answer. The
    /// record used to drop all three and keep only which worker stopped, which left the 2026-10-25 disconnect with no
    /// stated cause anywhere in any artifact.
    /// </summary>
    private static string DescribeWorkerTerminal(Task task)
    {
        if (task.IsFaulted)
        {
            Exception? inner = task.Exception?.InnerException ?? task.Exception;
            return inner is null ? "faulted" : $"{inner.GetType().Name}:{inner.Message}";
        }
        if (task.IsCanceled) return "cancelled";
        return "completed";
    }

    private async Task ReadLoopAsync(Stream stream, long generation, CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            string json = await ReadFrameAsync(stream, cancellationToken).ConfigureAwait(false);
            // Read BEFORE the queue check below: a frame that is read but not enqueued is exactly the difference these
            // counters exist to make visible.
            Interlocked.Increment(ref this.inboundFramesRead);
            this.lastInboundFrameType = FrameTypeOf(json);
            // The ONLY inbound protection is the queue depth, and that is deliberate.
            //
            // There used to be a second one - a fixed 32-frames-per-second window - on a same-machine, same-user named
            // pipe whose real hazard is an unconsumed queue, not sustained traffic. It had no credit for the 171 seconds
            // of silence that preceded it, so a Host releasing a batched burst was indistinguishable from a flood, and
            // the consequence was not backpressure: it threw, killed the reader, and took the bridge down. Measured
            // 2026-10-25: 32 frames in the second before the close, against a limit of 32, with the game still running.
            //
            // A queue that reaches 64 still fails, by name, and that check is the one backed by what the game thread can
            // actually consume.
            if (Interlocked.Increment(ref this.inboundCount) > MaximumQueuedMessages)
            {
                Interlocked.Decrement(ref this.inboundCount);
                throw new InvalidDataException(
                    $"bridge_inbound_queue_full:queued={MaximumQueuedMessages}");
            }
            this.inbound.Enqueue(new PipeInbound(generation, json));
            Interlocked.Increment(ref this.inboundFramesEnqueued);
        }
    }

    /** The envelope's own `type`, read without materializing the document: the heartbeat only needs to name it. */
    private static string? FrameTypeOf(string json)
    {
        const string marker = "\"type\":";
        int at = json.IndexOf(marker, StringComparison.Ordinal);
        if (at < 0) return null;
        int start = json.IndexOf('"', at + marker.Length);
        if (start < 0) return null;
        int end = json.IndexOf('"', start + 1);
        return end < 0 ? null : json.Substring(start + 1, end - start - 1);
    }

    private async Task WriteLoopAsync(Stream stream, long generation, CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            await this.outboundSignal.WaitAsync(cancellationToken).ConfigureAwait(false);
            PipeOutbound? message;
            lock (this.outboundGate)
            {
                // The dequeue and its paired count decrement must take the gate
                // together, so the admitted count never describes a queue that
                // a concurrent admit or drain has already changed.
                if (!this.outbound.TryDequeue(out message))
                    continue;
                this.outboundCount--;
                Interlocked.Increment(ref this.outboundFramesDrained);
            }
            if (message.Generation != generation || generation != Interlocked.Read(ref this.connectedGeneration))
            {
                message.Completion?.Resolve(false);
                continue;
            }
            try
            {
                await WriteFrameAsync(stream, message.Json, cancellationToken).ConfigureAwait(false);
                message.Completion?.Resolve(generation == Interlocked.Read(ref this.connectedGeneration)
                    && !cancellationToken.IsCancellationRequested);
            }
            catch (Exception exception)
            {
                message.Completion?.Resolve(false);
                throw new IOException($"bridge_write_failed:{exception.GetType().Name}", exception);
            }
        }
    }

    private void DiscardGeneration(long generation)
    {
        // Mark the client absent before accepting another. Resolve every stale
        // completion false so a control reservation can be retried safely.
        Interlocked.CompareExchange(ref this.connectedGeneration, 0, generation);
        List<PipeOutbound> retained = new();
        List<PipeOutboundCompletion> discarded = new();
        lock (this.outboundGate)
        {
            // Take exactly the frames that were admitted when the drain began,
            // so a frame the game thread admits while this runs keeps its queue
            // position behind every retained frame instead of being retired by
            // this connection's drain. Only the discarded frames leave, so the
            // admitted count drops by exactly that many.
            int pending = this.outbound.Count;
            int discardedCount = 0;
            while (pending-- > 0 && this.outbound.TryDequeue(out PipeOutbound? message))
            {
                if (message.Generation == generation)
                {
                    discardedCount++;
                    if (message.Completion is not null)
                        discarded.Add(message.Completion);
                }
                else
                {
                    retained.Add(message);
                }
            }
            foreach (PipeOutbound message in retained)
                this.outbound.Enqueue(message);
            this.outboundCount -= discardedCount;
        }
        // Resolve outside the gate: a completion's continuation must never run
        // - and thereby admit or drain - while this thread holds the gate.
        foreach (PipeOutboundCompletion completion in discarded)
            completion.Resolve(false);
    }

    private static async Task<string> ReadFrameAsync(Stream stream, CancellationToken cancellationToken)
    {
        byte[] lengthBuffer = new byte[sizeof(int)];
        await ReadExactlyAsync(stream, lengthBuffer, cancellationToken).ConfigureAwait(false);
        int length = BitConverter.ToInt32(lengthBuffer, 0);
        if (length is <= 0 or > BridgeProtocol.MaximumMessageBytes)
            throw new InvalidDataException("bridge_frame_length_invalid");
        byte[] payload = new byte[length];
        await ReadExactlyAsync(stream, payload, cancellationToken).ConfigureAwait(false);
        return new UTF8Encoding(false, true).GetString(payload);
    }

    private static async Task WriteFrameAsync(Stream stream, string json, CancellationToken cancellationToken)
    {
        byte[] payload = Encoding.UTF8.GetBytes(json);
        if (payload.Length > BridgeProtocol.MaximumMessageBytes)
            throw new InvalidDataException("bridge_frame_too_large");
        await stream.WriteAsync(BitConverter.GetBytes(payload.Length), cancellationToken).ConfigureAwait(false);
        await stream.WriteAsync(payload, cancellationToken).ConfigureAwait(false);
        // FlushFileBuffers makes an unsolicited server frame visible to a Node
        // peer while it is idle. This runs only in the bridge writer worker;
        // the game thread observes its completion asynchronously and never
        // waits for Host scheduling. A completion is delivery evidence, not
        // Host validation or player-input admission.
        await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
    }

    private static async Task ReadExactlyAsync(Stream stream, byte[] buffer, CancellationToken cancellationToken)
    {
        int offset = 0;
        while (offset < buffer.Length)
        {
            int read = await stream.ReadAsync(buffer.AsMemory(offset), cancellationToken).ConfigureAwait(false);
            if (read == 0)
                throw new EndOfStreamException();
            offset += read;
        }
    }

    public void Dispose()
    {
        this.cancellation.Cancel();
        List<PipeOutboundCompletion> discarded = new();
        lock (this.outboundGate)
        {
            while (this.outbound.TryDequeue(out PipeOutbound? message))
            {
                this.outboundCount--;
                if (message.Completion is not null)
                    discarded.Add(message.Completion);
            }
        }
        foreach (PipeOutboundCompletion completion in discarded)
            completion.Resolve(false);
        this.outboundSignal.Release();
        try { this.worker.Wait(TimeSpan.FromSeconds(1)); } catch { }
        this.outboundSignal.Dispose();
        this.cancellation.Dispose();
    }
}

internal sealed record PipeInbound(long Generation, string Json);
internal sealed record PipeOutbound(long Generation, string Json, PipeOutboundCompletion? Completion = null);
internal sealed record PipeWorkerTerminal(long Generation, PipeWorkerTerminalKind Kind, string Reason = "unstated");
internal enum PipeWorkerTerminalKind { ReaderEnded, WriterEnded }

internal sealed class PipeOutboundCompletion
{
    private readonly TaskCompletionSource<bool> result = new(TaskCreationOptions.RunContinuationsAsynchronously);

    internal PipeOutboundCompletion(long generation) => this.Generation = generation;
    internal long Generation { get; }
    internal Task<bool> Result => this.result.Task;
    internal void Resolve(bool succeeded) => this.result.TrySetResult(succeeded);
}
