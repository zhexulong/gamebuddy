using System.IO.Pipes;
using System.Text;
using System.Text.Json;

namespace GameBuddy.Desktop;

/// <summary>
/// The result of this launch's private presentation handoff: the one entry the
/// admitted Host child published, and the bounded reason when it published none.
/// <para>
/// The category is a fixed token. It never carries the entry, its origin, its
/// fragment or the one-time credential inside it, because every one of those is
/// the material this channel exists to keep out of logs, error text and files.
/// </para>
/// </summary>
internal readonly record struct DesktopPresentationHandoffOutcome(Uri? LaunchUrl, string Category)
{
    internal const string Accepted = "presentation_entry_accepted";
    internal const string Absent = "presentation_entry_absent";
    internal const string ClientRefused = "presentation_entry_client_refused";
    internal const string FrameRefused = "presentation_entry_frame_refused";
}

/// <summary>
/// The Desktop-owned private channel the admitted Host child publishes its one-time
/// presentation entry on.
/// <para>
/// The child already owns this fact - it composes the loopback surface and only then
/// has an entry URL to publish - but until now the only channel it had was Node's
/// IPC channel, and the production launcher does not create one: Node's IPC channel
/// exists only when Node itself created the child, so the installed launcher would
/// have to reimplement Node's private file-descriptor bootstrap to own it. The
/// product therefore owns its own transport: a named pipe the launcher creates
/// BEFORE it creates the child, named from the same one-shot bootstrap id the child
/// already receives in its bootstrap frame, so no bootstrap-wire field, argument,
/// environment variable or file had to be added for the child to find it.
/// </para>
/// <para>
/// The frame is read at most once, only after the connecting client has been proven
/// to be the exact admitted child process, and only one client is ever served. A
/// launch whose child never publishes simply has no presentation: this channel is
/// never allowed to fail or delay the Host session that is already running.
/// </para>
/// </summary>
internal sealed class DesktopPresentationHandoff : IAsyncDisposable
{
    internal const string PipeNamePrefix = "GameBuddy.DesktopPresentationHandoff.";
    internal const string FrameSchema = "gamebuddy-desktop-presentation-handoff/v1";
    private const int MaxFrameBytes = 2_048;
    private const int MaxEntryLength = 1_024;

    private readonly string bootstrapId;
    private readonly NamedPipeServerStream server;
    private int read;
    private int closed;

    private DesktopPresentationHandoff(string bootstrapId)
    {
        this.bootstrapId = bootstrapId;
        // CurrentUserOnly is the same client audience the authenticated broker already
        // requires: another user's process cannot open this endpoint at all, so the
        // process-identity check below is the second half of one boundary rather than
        // the only one.
        server = new NamedPipeServerStream(PipeName(bootstrapId), PipeDirection.In, 1,
            PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly | PipeOptions.FirstPipeInstance,
            MaxFrameBytes, MaxFrameBytes);
    }

    /// <summary>
    /// Creates the endpoint. It must be called before the child is created, so the
    /// child can connect the moment its composition is ready and never has to retry.
    /// </summary>
    internal static DesktopPresentationHandoff Create(string bootstrapId)
    {
        if (!IsHex(bootstrapId)) throw new GuardianLaunchUnavailableException("host_runtime_unavailable");
        return new DesktopPresentationHandoff(bootstrapId);
    }

    /// <summary>The exact private pipe name one bootstrap id owns.</summary>
    internal static string PipeName(string bootstrapId) => $"{PipeNamePrefix}{bootstrapId}";

    /// <summary>
    /// Reads the one frame this launch may carry. The connecting client must be the
    /// exact admitted child process, checked the way this product already checks every
    /// private child channel - the platform's own client-process id for this pipe
    /// instance, compared with the process id of the child this launcher created, in
    /// this launcher's own session - so there is one authority for "is this the child
    /// we admitted" and not a second, weaker one.
    /// <para>
    /// A client that is not that process is refused without reading anything, so a
    /// stranger cannot spend this launch's one handoff. A child that never connects is
    /// reported as absent when the bounded wait expires; neither case throws, and
    /// neither can end the Host session that is already serving.
    /// </para>
    /// </summary>
    internal async Task<DesktopPresentationHandoffOutcome> ReadEntryAsync(WindowsNative.SafeProcessHandle child, TimeSpan wait, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(child);
        if (wait <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(wait));
        cancellationToken.ThrowIfCancellationRequested();
        // One frame per endpoint: a second read is not a retry, it is a second belief
        // about one launch's entry.
        if (Interlocked.Exchange(ref read, 1) != 0) return new DesktopPresentationHandoffOutcome(null, DesktopPresentationHandoffOutcome.Absent);
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(wait);
        try
        {
            await server.WaitForConnectionAsync(deadline.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            // The child never connected. Nothing was published and nothing is wrong.
            return new DesktopPresentationHandoffOutcome(null, DesktopPresentationHandoffOutcome.Absent);
        }
        catch (Exception exception) when (exception is IOException or ObjectDisposedException or InvalidOperationException)
        {
            return new DesktopPresentationHandoffOutcome(null, DesktopPresentationHandoffOutcome.Absent);
        }
        if (!IsExactAdmittedChild(child))
            return new DesktopPresentationHandoffOutcome(null, DesktopPresentationHandoffOutcome.ClientRefused);
        var frame = await ReadOneFrameAsync(deadline.Token).ConfigureAwait(false);
        if (frame is null) return new DesktopPresentationHandoffOutcome(null, DesktopPresentationHandoffOutcome.FrameRefused);
        return TryReadFrame(frame, out var launchUrl)
            ? new DesktopPresentationHandoffOutcome(launchUrl, DesktopPresentationHandoffOutcome.Accepted)
            : new DesktopPresentationHandoffOutcome(null, DesktopPresentationHandoffOutcome.FrameRefused);
    }

    private bool IsExactAdmittedChild(WindowsNative.SafeProcessHandle child) =>
        WindowsNative.GetNamedPipeClientProcessId(server.SafePipeHandle, out var clientProcessId) &&
        clientProcessId == WindowsNative.GetProcessId(child) &&
        WindowsNative.ProcessIdToSessionId(clientProcessId, out var clientSession) &&
        WindowsNative.ProcessIdToSessionId(WindowsNative.GetCurrentProcessId(), out var currentSession) &&
        clientSession == currentSession;

    /// <summary>
    /// One LF-terminated document, read on a dedicated thread with the endpoint closed
    /// to cancel it - the same shape the one-shot bootstrap handshake uses, because a
    /// synchronous named-pipe read is only unblocked by closing the endpoint or by
    /// cancelling that exact thread. Capping the frame at the pipe's own buffer size
    /// means an endless writer is refused rather than buffered.
    /// </summary>
    private async Task<byte[]?> ReadOneFrameAsync(CancellationToken deadline)
    {
        using var cancellation = deadline.Register(static state => ((DesktopPresentationHandoff)state!).CloseEndpoint(), this);
        try
        {
            var frame = await Task.Factory.StartNew(() =>
            {
                using var stream = server;
                using var document = new MemoryStream();
                var buffer = new byte[256];
                while (true)
                {
                    var count = stream.Read(buffer, 0, buffer.Length);
                    if (count == 0) break;
                    document.Write(buffer, 0, count);
                    if (document.Length > MaxFrameBytes) return null;
                    if (Array.IndexOf(buffer, (byte)'\n', 0, count) >= 0) break;
                }
                return document.ToArray();
            }, CancellationToken.None, TaskCreationOptions.LongRunning, TaskScheduler.Default).ConfigureAwait(false);
            return frame;
        }
        catch (Exception exception) when (exception is IOException or ObjectDisposedException or InvalidOperationException or OperationCanceledException)
        {
            // The wait expired, or the child closed the endpoint without a frame.
            return null;
        }
    }

    private void CloseEndpoint()
    {
        try
        {
            server.Dispose();
        }
        catch (Exception exception) when (exception is IOException or ObjectDisposedException)
        {
        }
    }

    /// <summary>
    /// The one frame this channel may carry: the exact schema, the exact key order and
    /// exactly the admitted launch's own bootstrap id, with an entry that is a literal
    /// loopback origin and nothing else. A frame naming another bootstrap id, another
    /// host, another scheme or a character the shell could read as a path or as
    /// separate shell input is refused instead of published, because this channel's
    /// whole contract is that the entry it hands over stays loopback-only and stays
    /// one URL.
    /// </summary>
    private bool TryReadFrame(byte[] frame, out Uri? launchUrl)
    {
        launchUrl = null;
        if (frame.Length < 3 || frame.Length > MaxFrameBytes || frame[^1] != (byte)'\n' || Array.IndexOf(frame, (byte)'\n') != frame.Length - 1) return false;
        if (frame[0] == 0xEF && frame[1] == 0xBB && frame[2] == 0xBF) return false;
        if (Array.IndexOf(frame, (byte)'\r') >= 0 || Array.IndexOf(frame, (byte)0) >= 0) return false;
        string text;
        try
        {
            text = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true).GetString(frame, 0, frame.Length - 1);
        }
        catch (DecoderFallbackException)
        {
            return false;
        }
        JsonDocument document;
        try
        {
            document = JsonDocument.Parse(text);
        }
        catch (JsonException)
        {
            return false;
        }
        using (document)
        {
            var value = document.RootElement;
            if (value.ValueKind != JsonValueKind.Object) return false;
            var names = value.EnumerateObject().Select(property => property.Name).ToArray();
            if (names.Length != 4 || names[0] != "schema" || names[1] != "protocolVersion" || names[2] != "bootstrapId" || names[3] != "launchUrl") return false;
            if (value.GetProperty("schema").GetString() != FrameSchema || value.GetProperty("protocolVersion").GetInt32() != 1) return false;
            if (value.GetProperty("bootstrapId").GetString() != bootstrapId) return false;
            var entry = value.GetProperty("launchUrl").GetString();
            if (entry is null || entry.Length == 0 || entry.Length > MaxEntryLength) return false;
            if (!Uri.TryCreate(entry, UriKind.Absolute, out var parsed)) return false;
            if (parsed.Scheme != Uri.UriSchemeHttp || parsed.Host != "127.0.0.1" || parsed.Port is <= 0 or > 65_535 || parsed.UserInfo.Length != 0) return false;
            launchUrl = parsed;
            return true;
        }
    }

    private static bool IsHex(string value)
    {
        if (value.Length != 64) return false;
        foreach (var character in value)
            if (character is not (>= '0' and <= '9') and not (>= 'a' and <= 'f') and not (>= 'A' and <= 'F')) return false;
        return true;
    }

    public ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref closed, 1) == 0) CloseEndpoint();
        return ValueTask.CompletedTask;
    }
}
