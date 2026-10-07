using Microsoft.Win32.SafeHandles;

namespace GameBuddy.Desktop;

/// <summary>
/// Keeps the bounded stderr a launched child wrote about its own refusal.
///
/// The capture is observational only. It owns the read end of the child's stderr
/// pipe, drains it for as long as the child lives (draining is not optional: a reader
/// that stops consuming fills the pipe and parks the child on its next write, so a
/// half-hearted capture would change the very launch it is observing), and retains
/// only the first few kilobytes. Nothing here runs on the success path: a launch that
/// succeeds never asks for an excerpt, and when the child ends - by exiting, or by the
/// launcher's own failure teardown - the drain reaches its end, the endpoint is closed
/// and the capture is finished.
/// </summary>
internal sealed class ChildStderrCapture
{
    /// <summary>
    /// Enough to see a refusal naming a missing artefact or a rejected manifest, and
    /// far too little for a child's whole output. Bytes past this are still drained
    /// and then dropped.
    /// </summary>
    private const int MaximumRetainedBytes = 4096;

    /// <summary>
    /// How long the drain is given to end by itself before it is settled the same way
    /// the handshake settles its blocked workers.
    /// </summary>
    private static readonly TimeSpan DrainSettlement = TimeSpan.FromSeconds(2);

    private readonly SafeFileHandle reader;
    private readonly BoundedBuffer buffer = new(MaximumRetainedBytes);
    private readonly CancellationTokenSource extraction = new();
    private Task? drain;
    private int taken;
    private int released;

    private ChildStderrCapture(SafeFileHandle reader) => this.reader = reader;

    /// <summary>
    /// Starts draining the child's own stderr endpoint. The caller hands over the
    /// endpoint and does not keep it.
    /// </summary>
    internal static ChildStderrCapture Begin(SafeFileHandle reader)
    {
        ArgumentNullException.ThrowIfNull(reader);
        var capture = new ChildStderrCapture(reader);
        capture.drain = HostBootstrapPipeIo.DrainUntilEndAsync(reader, capture.buffer.Append, capture.extraction.Token);
        // Releasing the endpoint the moment the drain reaches its end keeps the
        // capture's own cost tied to the child's lifetime rather than to the process.
        _ = capture.drain.ContinueWith(static (_, state) => ((ChildStderrCapture)state!).ReleaseEndpoint(), capture, CancellationToken.None, TaskContinuationOptions.ExecuteSynchronously, TaskScheduler.Default);
        return capture;
    }

    /// <summary>
    /// The bounded, redacted excerpt, and the end of the capture. Returns an empty
    /// string when the capture retained nothing - which is a statement about the
    /// capture, not about the child. It runs at most once.
    /// </summary>
    internal async Task<string> ExcerptAsync()
    {
        if (Interlocked.Exchange(ref taken, 1) != 0) return string.Empty;
        var drain = this.drain;
        if (drain is not null && !drain.IsCompleted)
        {
            try { await drain.WaitAsync(DrainSettlement).ConfigureAwait(false); }
            catch (TimeoutException)
            {
                // The child is still alive and still holds its stderr open - a failure
                // during the handshake does not require it to have exited. Settling the
                // drain through the same cancellation the blocked handshake workers use
                // releases the worker's thread instead of leaking it into a live child.
            }
        }
        try { extraction.Cancel(); } catch (ObjectDisposedException) { }
        if (drain is not null)
        {
            try { await drain.ConfigureAwait(false); }
            catch (Exception exception) when (exception is OperationCanceledException or IOException or ObjectDisposedException) { }
        }
        var bytes = buffer.Snapshot();
        ReleaseEndpoint();
        return ChildStderrExcerpt.Render(bytes);
    }

    /// <summary>
    /// Closes the captured endpoint once and only once. Called by the drain's own
    /// completion and, when an excerpt is taken early, by the take itself; the guard
    /// makes the two orders equivalent.
    /// </summary>
    private void ReleaseEndpoint()
    {
        if (Interlocked.Exchange(ref released, 1) != 0) return;
        reader.Dispose();
        try { extraction.Dispose(); } catch (ObjectDisposedException) { }
    }

    /// <summary>What the drain writes into: the first bytes, and nothing after them.</summary>
    private sealed class BoundedBuffer(int capacity)
    {
        private readonly object gate = new();
        private readonly byte[] retained = new byte[capacity];
        private int length;

        internal void Append(byte[] source, int count)
        {
            lock (gate)
            {
                var remaining = capacity - length;
                if (remaining <= 0) return;
                var copied = Math.Min(remaining, count);
                Buffer.BlockCopy(source, 0, retained, length, copied);
                length += copied;
            }
        }

        internal byte[] Snapshot()
        {
            lock (gate) return retained[..length];
        }
    }
}
