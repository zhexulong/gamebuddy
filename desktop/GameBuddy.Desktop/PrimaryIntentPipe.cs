using System.IO.Pipes;
using System.Text;
using System.Text.Json;

namespace GameBuddy.Desktop;

/// <summary>
/// The complete set of intents a secondary invocation may deliver to the primary instance.
/// It is deliberately narrower than the tray's own vocabulary: a second process launched by
/// the player may ask for the presentation to be opened or focused, and may ask for nothing
/// else - not a profile, root, continuity, provider, Game installation, task, bridge or
/// bootstrap frame - because those are the primary instance's to own and nobody else's to
/// supply.
/// </summary>
internal enum PrimaryIntent
{
    Open,
    Focus,
}

/// <summary>
/// The bounded one-frame channel between a secondary invocation and the primary instance.
/// <para>
/// It carries one intent and no payload at all: the frame's exact key set is the whole
/// contract, so a second process cannot smuggle an option, a path or a credential through
/// this channel by adding a field. The primary instance accepts only same-user clients
/// (the platform's own current-user-only pipe option), and a frame that is not exactly this
/// shape is refused without dispatching anything.
/// </para>
/// </summary>
internal sealed class PrimaryIntentPipe : IAsyncDisposable
{
    internal const string PipeName = "GameBuddy.Desktop.PrimaryIntent.v1";
    internal const string FrameSchema = "gamebuddy-desktop-primary-intent/v1";
    private const int MaxFrameBytes = 512;
    private static readonly TimeSpan ClientConnectTimeout = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan FrameReadTimeout = TimeSpan.FromSeconds(5);

    private readonly NamedPipeServerStream server;
    private readonly Action<PrimaryIntent> onIntent;
    private readonly CancellationTokenSource stopping = new();
    private Task? loop;

    private PrimaryIntentPipe(Action<PrimaryIntent> onIntent)
    {
        this.onIntent = onIntent;
        server = new NamedPipeServerStream(PipeName, PipeDirection.In, 1,
            PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly | PipeOptions.FirstPipeInstance,
            MaxFrameBytes, MaxFrameBytes);
    }

    /// <summary>
    /// Serves secondary intents until this instance closes. It is only ever started by the
    /// primary instance: a secondary invocation does not open the endpoint at all.
    /// </summary>
    internal static PrimaryIntentPipe Start(Action<PrimaryIntent> onIntent, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(onIntent);
        var pipe = new PrimaryIntentPipe(onIntent);
        pipe.loop = Task.Run(() => pipe.ServeAsync(cancellationToken), CancellationToken.None);
        return pipe;
    }

    /// <summary>
    /// Delivers one bounded intent. A missing primary instance is not an error here: it is
    /// reported to the caller as "not delivered", and the caller decides what to tell the
    /// player rather than this channel inventing a launch.
    /// </summary>
    internal static async Task<bool> RequestAsync(PrimaryIntent intent, TimeSpan timeout, CancellationToken cancellationToken)
    {
        if (timeout <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(timeout));
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(timeout);
        try
        {
            using var client = new NamedPipeClientStream(".", PipeName, PipeDirection.Out, PipeOptions.Asynchronous);
            await client.ConnectAsync(deadline.Token).ConfigureAwait(false);
            await client.WriteAsync(ComposeFrame(intent), deadline.Token).ConfigureAwait(false);
            await client.FlushAsync(deadline.Token).ConfigureAwait(false);
            return true;
        }
        catch (Exception exception) when (exception is IOException or TimeoutException or OperationCanceledException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    private async Task ServeAsync(CancellationToken cancellationToken)
    {
        using var stoppingToken = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, stopping.Token);
        var token = stoppingToken.Token;
        while (!token.IsCancellationRequested)
        {
            try
            {
                await server.WaitForConnectionAsync(token).ConfigureAwait(false);
            }
            catch (Exception exception) when (exception is OperationCanceledException or IOException or ObjectDisposedException)
            {
                return;
            }
            try
            {
                var frame = await ReadOneFrameAsync(token).ConfigureAwait(false);
                if (frame is not null && TryReadFrame(frame, out var intent)) onIntent(intent);
            }
            catch (Exception exception) when (exception is IOException or OperationCanceledException or ObjectDisposedException)
            {
                // A client that disconnects mid-frame, or a read that outlived its bound,
                // dispatches nothing. The endpoint stays available for the next invocation.
            }
            try
            {
                if (server.IsConnected) server.Disconnect();
            }
            catch (Exception exception) when (exception is IOException or InvalidOperationException or ObjectDisposedException)
            {
            }
        }
    }

    private async Task<byte[]?> ReadOneFrameAsync(CancellationToken cancellationToken)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        deadline.CancelAfter(FrameReadTimeout);
        var buffer = new byte[MaxFrameBytes + 1];
        var length = 0;
        while (length < buffer.Length)
        {
            var count = await server.ReadAsync(buffer.AsMemory(length, buffer.Length - length), deadline.Token).ConfigureAwait(false);
            if (count == 0) break;
            length += count;
            if (Array.IndexOf(buffer, (byte)'\n', 0, length) >= 0) break;
        }
        return length == 0 ? null : buffer[..length];
    }

    /// <summary>
    /// The exact frame: four keys in this order, one of exactly two intents, one LF. Every
    /// other shape - another schema, another version, another intent, an extra field, a
    /// partial document - is refused before anything is dispatched.
    /// </summary>
    private static bool TryReadFrame(byte[] frame, out PrimaryIntent intent)
    {
        intent = PrimaryIntent.Open;
        if (frame.Length < 3 || frame[^1] != (byte)'\n' || Array.IndexOf(frame, (byte)'\n') != frame.Length - 1) return false;
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
        try
        {
            using var document = JsonDocument.Parse(text);
            var value = document.RootElement;
            if (value.ValueKind != JsonValueKind.Object) return false;
            var names = value.EnumerateObject().Select(property => property.Name).ToArray();
            if (names.Length != 3 || names[0] != "schema" || names[1] != "protocolVersion" || names[2] != "intent") return false;
            if (value.GetProperty("schema").GetString() != FrameSchema || value.GetProperty("protocolVersion").GetInt32() != 1) return false;
            switch (value.GetProperty("intent").GetString())
            {
                case "open":
                    intent = PrimaryIntent.Open;
                    return true;
                case "focus":
                    intent = PrimaryIntent.Focus;
                    return true;
                default:
                    return false;
            }
        }
        catch (JsonException)
        {
            return false;
        }
    }

    private static byte[] ComposeFrame(PrimaryIntent intent) =>
        Encoding.UTF8.GetBytes($"{{\"schema\":\"{FrameSchema}\",\"protocolVersion\":1,\"intent\":\"{(intent == PrimaryIntent.Open ? "open" : "focus")}\"}}\n");

    /// <summary>A secondary invocation's own bounded wait for the primary instance.</summary>
    internal static TimeSpan SecondaryWait => ClientConnectTimeout;

    public async ValueTask DisposeAsync()
    {
        stopping.Cancel();
        try
        {
            server.Dispose();
        }
        catch (Exception exception) when (exception is IOException or ObjectDisposedException)
        {
        }
        if (loop is not null) await loop.ConfigureAwait(false);
        stopping.Dispose();
    }
}
