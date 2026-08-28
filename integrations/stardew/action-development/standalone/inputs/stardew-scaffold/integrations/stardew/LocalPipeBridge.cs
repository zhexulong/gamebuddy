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
    private const int MaximumQueuedMessages = 64;
    private const int MaximumInboundRequestsPerSecond = 32;
    private readonly string pipeName;
    private readonly CancellationTokenSource cancellation = new();
    private readonly ConcurrentQueue<PipeInbound> inbound = new();
    private readonly ConcurrentQueue<PipeOutbound> outbound = new();
    private readonly SemaphoreSlim outboundSignal = new(0);
    private readonly Task worker;
    private int inboundCount;
    private int outboundCount;
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
            completion.Resolve(false);
            return false;
        }
        if (Interlocked.Increment(ref this.outboundCount) > MaximumQueuedMessages)
        {
            Interlocked.Decrement(ref this.outboundCount);
            completion.Resolve(false);
            return false;
        }
        this.outbound.Enqueue(new PipeOutbound(generation, json, completion));
        try { this.outboundSignal.Release(); }
        catch (ObjectDisposedException)
        {
            Interlocked.Decrement(ref this.outboundCount);
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
                    Interlocked.CompareExchange(ref this.workerTerminal, new PipeWorkerTerminal(generation, kind), null);
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

    private async Task ReadLoopAsync(Stream stream, long generation, CancellationToken cancellationToken)
    {
        long windowStartMs = Environment.TickCount64;
        int requestsInWindow = 0;
        while (!cancellationToken.IsCancellationRequested)
        {
            string json = await ReadFrameAsync(stream, cancellationToken).ConfigureAwait(false);
            long nowMs = Environment.TickCount64;
            if (nowMs - windowStartMs >= 1_000)
            {
                windowStartMs = nowMs;
                requestsInWindow = 0;
            }
            if (++requestsInWindow > MaximumInboundRequestsPerSecond)
                throw new InvalidDataException("bridge_inbound_rate_limited");
            if (Interlocked.Increment(ref this.inboundCount) > MaximumQueuedMessages)
            {
                Interlocked.Decrement(ref this.inboundCount);
                throw new InvalidDataException("bridge_inbound_rate_limited");
            }
            this.inbound.Enqueue(new PipeInbound(generation, json));
        }
    }

    private async Task WriteLoopAsync(Stream stream, long generation, CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            await this.outboundSignal.WaitAsync(cancellationToken).ConfigureAwait(false);
            if (!this.outbound.TryDequeue(out PipeOutbound? message))
                continue;
            Interlocked.Decrement(ref this.outboundCount);
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
        while (this.outbound.TryDequeue(out PipeOutbound? message))
        {
            Interlocked.Decrement(ref this.outboundCount);
            if (message.Generation == generation)
                message.Completion?.Resolve(false);
            else
                retained.Add(message);
        }
        foreach (PipeOutbound message in retained)
            this.outbound.Enqueue(message);
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
        while (this.outbound.TryDequeue(out PipeOutbound? message))
        {
            Interlocked.Decrement(ref this.outboundCount);
            message.Completion?.Resolve(false);
        }
        this.outboundSignal.Release();
        try { this.worker.Wait(TimeSpan.FromSeconds(1)); } catch { }
        this.outboundSignal.Dispose();
        this.cancellation.Dispose();
    }
}

internal sealed record PipeInbound(long Generation, string Json);
internal sealed record PipeOutbound(long Generation, string Json, PipeOutboundCompletion? Completion = null);
internal sealed record PipeWorkerTerminal(long Generation, PipeWorkerTerminalKind Kind);
internal enum PipeWorkerTerminalKind { ReaderEnded, WriterEnded }

internal sealed class PipeOutboundCompletion
{
    private readonly TaskCompletionSource<bool> result = new(TaskCreationOptions.RunContinuationsAsynchronously);

    internal PipeOutboundCompletion(long generation) => this.Generation = generation;
    internal long Generation { get; }
    internal Task<bool> Result => this.result.Task;
    internal void Resolve(bool succeeded) => this.result.TrySetResult(succeeded);
}
