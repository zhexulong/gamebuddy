using System.Collections.Concurrent;
using System.IO.Pipes;
using System.Text;

namespace GameBuddy.Stardew;

/// <summary>
/// Portfolio-specific byte-framed local transport. It shares no session or
/// queue with the Farmhand bridge and never calls a Stardew API off-thread.
/// </summary>
internal sealed class PortfolioLocalPipeBridge : IDisposable
{
    private const int MaximumQueuedMessages = 64;
    private const int MaximumInboundRequestsPerSecond = 16;
    private readonly string pipeName;
    private readonly CancellationTokenSource cancellation = new();
    private readonly ConcurrentQueue<PortfolioPipeInbound> inbound = new();
    private readonly ConcurrentQueue<PortfolioPipeOutbound> outbound = new();
    private readonly SemaphoreSlim outboundSignal = new(0);
    private readonly Task worker;
    private int inboundCount;
    private int outboundCount;
    private int finalCloseRequested;
    private int disposed;
    private long nextGeneration;
    private long connectedGeneration;
    private long disconnectedGeneration;

    internal PortfolioLocalPipeBridge(string pipeName)
    {
        this.pipeName = pipeName;
        this.worker = Task.Run(this.RunAsync);
    }

    internal long CurrentGeneration => Interlocked.Read(ref this.connectedGeneration);

    internal bool TryConsumeDisconnect(out long generation)
    {
        generation = Interlocked.Exchange(ref this.disconnectedGeneration, 0);
        return generation > 0;
    }

    internal bool TryDequeueInbound(out PortfolioPipeInbound message)
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
        => this.TryEnqueue(generation, json, closeAfterWrite: false);

    /// <summary>
    /// Queues one final frame and stops accepting/reopening this bridge after
    /// that frame has been flushed. The continuation disposes the transport
    /// only after the writer has completed, so native lifecycle invalidation is
    /// observable by the Host instead of being cancelled before it is sent.
    /// </summary>
    internal bool TryEnqueueFinal(long generation, string json)
    {
        if (Interlocked.CompareExchange(ref this.finalCloseRequested, 1, 0) != 0)
            return false;
        if (!this.TryEnqueue(generation, json, closeAfterWrite: true))
        {
            Interlocked.Exchange(ref this.finalCloseRequested, 0);
            return false;
        }
        _ = this.DisposeWhenWorkerStopsAsync();
        return true;
    }

    private bool TryEnqueue(long generation, string json, bool closeAfterWrite)
    {
        if (generation == 0 || generation != Interlocked.Read(ref this.connectedGeneration)
            || Volatile.Read(ref this.disposed) != 0
            || this.cancellation.IsCancellationRequested
            || (!closeAfterWrite && Volatile.Read(ref this.finalCloseRequested) != 0)
            || Encoding.UTF8.GetByteCount(json) > PortfolioBridgeProtocol.MaximumMessageBytes)
            return false;
        if (Interlocked.Increment(ref this.outboundCount) > MaximumQueuedMessages)
        {
            Interlocked.Decrement(ref this.outboundCount);
            return false;
        }
        this.outbound.Enqueue(new PortfolioPipeOutbound(generation, json, closeAfterWrite));
        try
        {
            this.outboundSignal.Release();
        }
        catch (ObjectDisposedException)
        {
            Interlocked.Decrement(ref this.outboundCount);
            return false;
        }
        return true;
    }

    private async Task DisposeWhenWorkerStopsAsync()
    {
        try { await this.worker.ConfigureAwait(false); }
        catch { }
        this.Dispose();
    }

    private async Task RunAsync()
    {
        while (!this.cancellation.IsCancellationRequested)
        {
            long generation = Interlocked.Increment(ref this.nextGeneration);
            using NamedPipeServerStream pipe = new(this.pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            try
            {
                await pipe.WaitForConnectionAsync(this.cancellation.Token).ConfigureAwait(false);
                Interlocked.Exchange(ref this.connectedGeneration, generation);
                using CancellationTokenSource connectionCancellation = CancellationTokenSource.CreateLinkedTokenSource(this.cancellation.Token);
                Task reader = this.ReadLoopAsync(pipe, generation, connectionCancellation.Token);
                Task writer = this.WriteLoopAsync(pipe, generation, connectionCancellation.Token);
                await Task.WhenAny(reader, writer).ConfigureAwait(false);
                connectionCancellation.Cancel();
                try { await Task.WhenAll(reader, writer).ConfigureAwait(false); }
                catch (OperationCanceledException) { }
                catch (EndOfStreamException) { }
                catch (IOException) { }
                this.DiscardGeneration(generation);
                if (Volatile.Read(ref this.finalCloseRequested) != 0)
                    return;
            }
            catch (OperationCanceledException) when (this.cancellation.IsCancellationRequested)
            {
                return;
            }
            catch (Exception) when (!this.cancellation.IsCancellationRequested)
            {
                this.DiscardGeneration(generation);
                if (Volatile.Read(ref this.finalCloseRequested) != 0)
                    return;
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
                throw new InvalidDataException("portfolio_bridge_inbound_rate_limited");
            if (Interlocked.Increment(ref this.inboundCount) > MaximumQueuedMessages)
            {
                Interlocked.Decrement(ref this.inboundCount);
                throw new InvalidDataException("portfolio_bridge_inbound_rate_limited");
            }
            this.inbound.Enqueue(new PortfolioPipeInbound(generation, json));
        }
    }

    private async Task WriteLoopAsync(Stream stream, long generation, CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            await this.outboundSignal.WaitAsync(cancellationToken).ConfigureAwait(false);
            if (!this.outbound.TryDequeue(out PortfolioPipeOutbound? message))
                continue;
            Interlocked.Decrement(ref this.outboundCount);
            if (message.Generation != generation || generation != Interlocked.Read(ref this.connectedGeneration))
                continue;
            await WriteFrameAsync(stream, message.Json, cancellationToken).ConfigureAwait(false);
            if (message.CloseAfterWrite)
            {
                // Cancel only this connection. The RunAsync finally path will
                // discard the generation and stop because finalCloseRequested
                // is set; the global token is left for Dispose to own.
                return;
            }
        }
    }

    private void DiscardGeneration(long generation)
    {
        if (Interlocked.CompareExchange(ref this.connectedGeneration, 0, generation) == generation)
            Interlocked.Exchange(ref this.disconnectedGeneration, generation);
    }

    private static async Task<string> ReadFrameAsync(Stream stream, CancellationToken cancellationToken)
    {
        byte[] lengthBuffer = new byte[sizeof(int)];
        await ReadExactlyAsync(stream, lengthBuffer, cancellationToken).ConfigureAwait(false);
        int length = BitConverter.ToInt32(lengthBuffer, 0);
        if (length is <= 0 or > PortfolioBridgeProtocol.MaximumMessageBytes)
            throw new InvalidDataException("portfolio_bridge_frame_length_invalid");
        byte[] payload = new byte[length];
        await ReadExactlyAsync(stream, payload, cancellationToken).ConfigureAwait(false);
        return new UTF8Encoding(false, true).GetString(payload);
    }

    private static async Task WriteFrameAsync(Stream stream, string json, CancellationToken cancellationToken)
    {
        byte[] payload = Encoding.UTF8.GetBytes(json);
        if (payload.Length > PortfolioBridgeProtocol.MaximumMessageBytes)
            throw new InvalidDataException("portfolio_bridge_frame_too_large");
        await stream.WriteAsync(BitConverter.GetBytes(payload.Length), cancellationToken).ConfigureAwait(false);
        await stream.WriteAsync(payload, cancellationToken).ConfigureAwait(false);
        await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
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

    public void Dispose()
    {
        if (Interlocked.Exchange(ref this.disposed, 1) != 0)
            return;
        this.cancellation.Cancel();
        try { this.outboundSignal.Release(); } catch (ObjectDisposedException) { }
        try { this.worker.Wait(TimeSpan.FromSeconds(1)); } catch { }
        this.outboundSignal.Dispose();
        this.cancellation.Dispose();
    }
}

internal sealed record PortfolioPipeInbound(long Generation, string Json);
internal sealed record PortfolioPipeOutbound(long Generation, string Json, bool CloseAfterWrite);
