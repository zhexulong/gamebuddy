namespace GameBuddy.Desktop;

/// <summary>
/// Desktop-owned Voice launch decision. Resolves whether the current generation
/// has an admitted Voice gateway artifact and the Host-owned preference admits
/// cloud TTS; when it does, it supplies the per-launch loopback port and token
/// that are injected into both the Voice child and the exact Host child so the
/// Host wire (connectOptionalVoiceSurface) can reach the Voice child. Any
/// unavailable input (no artifact, missing/invalid preference, revoked or
/// undecided consent) resolves to null, which the production composition turns
/// into pure-text Chat with no Voice environment injected. The coordinator
/// never starts a child itself: it only derives the launch facts the
/// composition binds into the supervisor.
/// </summary>
internal static class VoiceLaunchCoordinator
{
    internal const int MinPort = 1;
    internal const int MaxPort = 65_535;

    /// <summary>One per-launch Voice decision; port and token are always paired and the artifact is already admitted.</summary>
    internal sealed record VoiceLaunch(AdmittedVoiceGateway Gateway, int Port, string Token, string OutputDevice);

    /// <summary>
    /// Pure decision: admits the Voice artifact in the selected generation,
    /// reads the Host-owned preference file, and computes the per-launch
    /// port/token pair only when the artifact is present and consent is
    /// accepted. Any unavailable input (no artifact sidecar, missing or
    /// unreadable preference, revoked or undecided consent) resolves to null:
    /// Voice is an optional capability and its absence must leave the Host on
    /// pure-text Chat. The reader layer stays strictly fail-closed (a corrupt
    /// preference is never projected as accepted); this composition simply
    /// declines to enable Voice when admission cannot be proven.
    /// </summary>
    internal static VoiceLaunch? Resolve(
        string generationRoot,
        string expectedGeneration,
        string expectedInventoryDigest,
        string preferencePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(generationRoot);
        ArgumentException.ThrowIfNullOrWhiteSpace(expectedGeneration);
        ArgumentException.ThrowIfNullOrWhiteSpace(expectedInventoryDigest);
        ArgumentException.ThrowIfNullOrWhiteSpace(preferencePath);

        // Artifact admission is the physical gate: without a sidecar in the
        // generation there is nothing to launch even if consent were present.
        AdmittedVoiceGateway gateway;
        try
        {
            gateway = new InstalledVoiceGatewayAdmission().Admit(generationRoot, expectedGeneration, expectedInventoryDigest);
        }
        catch (GuardianLaunchUnavailableException)
        {
            return null;
        }

        // Consent must be provable: missing file (undecided), revoked, or a
        // corrupt file that the strict reader refuses all decline Voice.
        VoicePreference preference;
        try
        {
            preference = new VoicePreferenceFileReader(preferencePath).Read();
        }
        catch (InvalidVoicePreferenceException)
        {
            return null;
        }
        if (preference.Consent != VoiceCloudTtsConsent.Accepted)
            return null;

        var port = PickFreeLoopbackPort();
        return new VoiceLaunch(gateway, port, GenerateToken(), preference.SelectedOutputDevice);
    }

    /// <summary>Reserves a free loopback port and releases it for the Voice child to bind.</summary>
    internal static int PickFreeLoopbackPort()
    {
        var listener = new System.Net.Sockets.TcpListener(System.Net.IPAddress.Loopback, 0);
        try
        {
            listener.Start();
            var port = ((System.Net.IPEndPoint)listener.LocalEndpoint).Port;
            if (port is < MinPort or > MaxPort) throw new GuardianLaunchUnavailableException("voice_launch_unavailable");
            return port;
        }
        catch (GuardianLaunchUnavailableException) { throw; }
        catch (System.Net.Sockets.SocketException exception) { throw new GuardianLaunchUnavailableException("voice_launch_unavailable", exception); }
        finally { listener.Stop(); }
    }

    /// <summary>
    /// Generates a launch-only opaque token matching the frozen Host/child
    /// contract ([A-Za-z0-9_-]{16,256}); the caller holds it only for the child
    /// environment and never exposes it in logs or public state.
    /// </summary>
    internal static string GenerateToken()
    {
        var bytes = System.Security.Cryptography.RandomNumberGenerator.GetBytes(32);
        var base64 = Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        return base64.Length >= 16 ? base64 : base64 + new string('_', 16 - base64.Length);
    }
}