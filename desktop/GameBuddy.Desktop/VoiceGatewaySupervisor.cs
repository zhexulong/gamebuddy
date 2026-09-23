using System.Diagnostics;
using System.Globalization;
using System.Text.RegularExpressions;

namespace GameBuddy.Desktop;

internal sealed record VoiceGatewayLaunchPlan(string NodePath, string EntryPath, int Port, string Token, bool CloudTtsAdmitted, string? Persona, string OutputDevice)
{
    /// <summary>
    /// The gateway reads its per-launch port, token and output endpoint
    /// exclusively from the environment; the child gets only the frozen minimal
    /// variables below. The endpoint is the player's stored selection
    /// (`waveout:N`) or `default` for the Windows default multimedia output.
    /// </summary>
    internal IReadOnlyDictionary<string, string> Environment => BuildEnvironment(Port, Token, CloudTtsAdmitted, OutputDevice);
    internal string Arguments => $"{Quote(EntryPath)}" + (Persona is null ? string.Empty : $" --persona {Quote(Persona)}");

    // The token is launch-only and never appears in any string representation.
    public override string ToString() => $"VoiceGatewayLaunchPlan(NodePath={NodePath}, EntryPath={EntryPath}, Port={Port}, CloudTtsAdmitted={CloudTtsAdmitted}, Persona={Persona}, OutputDevice={OutputDevice})";

    private static IReadOnlyDictionary<string, string> BuildEnvironment(int port, string token, bool cloudTtsAdmitted, string outputDevice)
    {
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["SystemRoot"] = RequiredEnvironment("SystemRoot"),
            ["TEMP"] = RequiredEnvironment("TEMP"),
            ["TMP"] = RequiredEnvironment("TMP"),
            ["LOCALAPPDATA"] = RequiredEnvironment("LOCALAPPDATA"),
            ["GAMEBUDDY_VOICE_PORT"] = port.ToString(CultureInfo.InvariantCulture),
            ["GAMEBUDDY_VOICE_TOKEN"] = token,
            ["GAMEBUDDY_WINDOWS_OUTPUT_DEVICE"] = outputDevice,
        };
        if (cloudTtsAdmitted) values.Add("GAMEBUDDY_VOICE_CLOUD_TTS_ADMISSION", "desktop-consent-v1");
        return values;
    }

    private static string RequiredEnvironment(string name)
    {
        var value = System.Environment.GetEnvironmentVariable(name);
        if (string.IsNullOrWhiteSpace(value) || value.Contains('\0')) throw new InvalidOperationException($"Missing required environment variable: {name}");
        return value;
    }

    private static string Quote(string value) => "\"" + value.Replace("\"", "\\\"") + "\"";
}

/// <summary>
/// Starts the admitted bundled Node on the admitted Voice gateway entry. The
/// node binary is always the admitted absolute path; the child environment is
/// cleared so nothing is ever resolved from the parent process or a search path.
/// </summary>
internal sealed class VoiceGatewaySupervisor : IAsyncDisposable
{
    private static readonly Regex GatewayTokenRegex = new("^[A-Za-z0-9_-]{16,256}$", RegexOptions.CultureInvariant);

    private Process? process;
    private int closed;

    // The endpoint is either the frozen `waveout:N` selection or `default`
    // (Windows current default). Nothing else is ever forwarded to the child.
    internal static readonly System.Text.RegularExpressions.Regex OutputDeviceRegex =
        new("^(default|waveout:[0-9]{1,4})$", System.Text.RegularExpressions.RegexOptions.CultureInvariant);

    internal static VoiceGatewayLaunchPlan BuildLaunchPlan(string nodePath, AdmittedVoiceGateway gateway, int port, string token, bool cloudTtsAdmitted, string? persona = null, string outputDevice = "default")
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(nodePath);
        ArgumentNullException.ThrowIfNull(gateway);
        ArgumentException.ThrowIfNullOrWhiteSpace(token);
        if (!Path.IsPathFullyQualified(nodePath) || !File.Exists(nodePath)) throw new ArgumentException("Node runtime must be an admitted existing absolute file.", nameof(nodePath));
        if (!Path.IsPathFullyQualified(gateway.EntryPath) || !File.Exists(gateway.EntryPath)) throw new ArgumentException("Gateway entry must be an admitted existing absolute file.", nameof(gateway));
        if (port is < 1 or > 65535) throw new ArgumentOutOfRangeException(nameof(port));
        // The gateway entry itself rejects any other token shape with exit code 2.
        if (!GatewayTokenRegex.IsMatch(token)) throw new ArgumentException("Gateway token must be 16-256 opaque characters of [A-Za-z0-9_-].", nameof(token));
        if (persona?.Contains('\0') == true) throw new ArgumentException("Invalid persona.", nameof(persona));
        if (!OutputDeviceRegex.IsMatch(outputDevice)) throw new ArgumentException("Output device must be `default` or `waveout:N`.", nameof(outputDevice));
        return new VoiceGatewayLaunchPlan(nodePath, gateway.EntryPath, port, token, cloudTtsAdmitted, persona, outputDevice);
    }

    internal Task<VoiceGatewayLease> StartAsync(VoiceGatewayLaunchPlan plan, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(plan);
        cancellationToken.ThrowIfCancellationRequested();
        if (Volatile.Read(ref closed) != 0) throw new ObjectDisposedException(nameof(VoiceGatewaySupervisor));
        if (Volatile.Read(ref process) is not null) throw new InvalidOperationException("Voice gateway is already started; a supervisor starts exactly one child and never restarts it.");
        var start = new ProcessStartInfo { FileName = plan.NodePath, Arguments = plan.Arguments, UseShellExecute = false, CreateNoWindow = true };
        start.Environment.Clear();
        foreach (var pair in plan.Environment) start.Environment[pair.Key] = pair.Value;
        var child = new Process { StartInfo = start };
        try
        {
            if (!child.Start()) throw new InvalidOperationException("Voice gateway failed to start.");
        }
        catch
        {
            child.Dispose();
            throw;
        }
        Interlocked.Exchange(ref process, child);
        return Task.FromResult(new VoiceGatewayLease(this));
    }

    internal Task WaitForExitAsync(CancellationToken cancellationToken = default)
    {
        var child = Volatile.Read(ref process);
        if (child is null) throw new InvalidOperationException("Voice gateway has not been started.");
        return child.WaitForExitAsync(cancellationToken);
    }

    /// <summary>Stops the exact child and its process tree once; later closes return immediately.</summary>
    internal async ValueTask CloseAsync(CancellationToken cancellationToken)
    {
        if (Interlocked.Exchange(ref closed, 1) != 0) return;
        var child = Interlocked.Exchange(ref process, null);
        if (child is null) return;
        if (!child.HasExited)
        {
            try { child.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
            try { await child.WaitForExitAsync(cancellationToken).ConfigureAwait(false); } catch (OperationCanceledException) { }
        }
        child.Dispose();
    }

    public ValueTask DisposeAsync() => CloseAsync(CancellationToken.None);
}

/// <summary>Observes the exact gateway child owned by the supervisor; closing the lease closes the child.</summary>
internal sealed class VoiceGatewayLease : IAsyncDisposable
{
    private readonly VoiceGatewaySupervisor supervisor;
    internal VoiceGatewayLease(VoiceGatewaySupervisor supervisor) => this.supervisor = supervisor;
    internal Task WaitForExitAsync(CancellationToken cancellationToken = default) => supervisor.WaitForExitAsync(cancellationToken);
    public ValueTask DisposeAsync() => supervisor.DisposeAsync();
}