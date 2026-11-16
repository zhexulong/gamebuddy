namespace GameBuddy.Desktop;

/// <summary>
/// Desktop-owned assembly-input environment injected into the exact bundled
/// Host child. Values are the frozen gamebuddy-desktop-host-bootstrap/v1 wire
/// contract allowlists (host/src/bootstrap/wire/desktop-runtime-bootstrap.internal.ts);
/// the Host remains the authority that reads the deployment manifest content.
///
/// Nothing here decides which semantic authority mount the Host performs. The Host derives
/// that from its own records in the runtime root
/// (host/src/continuity-semantic-provisioning: `decideProductionAuthorityMountMode`), because
/// a value this launcher asserted could contradict the records it was derived from.
/// </summary>
internal sealed record HostBootstrapEnvironmentOptions
{
    internal const string ComposedReferenceGameSurface = "composed-reference-game";
    internal const string ChatOnlySurface = "chat-only";
    internal const string ManagementSurface = "management";

    internal string Surface { get; init; } = ComposedReferenceGameSurface;

    /// <summary>Optional tavern narrative gate nonce; omitted from the child environment when null.</summary>
    internal string? TavernNarrativeGateNonceSha256 { get; init; }

    /// <summary>Optional per-launch Voice loopback port delivered to the Host wire; must be paired with VoiceToken.</summary>
    internal int? VoicePort { get; init; }

    /// <summary>Optional per-launch Voice token delivered to the Host wire; must be paired with VoicePort.</summary>
    internal string? VoiceToken { get; init; }
}