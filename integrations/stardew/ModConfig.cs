namespace GameBuddy.Stardew;

/// <summary>Local-only pipe is opt-in and authenticated; no defaults expose a bridge.</summary>
public sealed class ModConfig
{
    public bool EnableLocalBridge { get; init; }
    public string PipeName { get; init; } = "gamebuddy-stardew";
    public string BridgeToken { get; init; } = string.Empty;
    public string SaveId { get; init; } = string.Empty;
    public string WorldId { get; init; } = string.Empty;
    public string PlayerId { get; init; } = string.Empty;
    public string CompanionId { get; init; } = string.Empty;

    internal bool HasValidLocalBridgeConfiguration => EnableLocalBridge
        && BridgeProtocol.IsOpaqueId(PipeName)
        && BridgeToken.Length is >= 16 and <= 256
        && new BridgeScope("stardew", SaveId, WorldId, PlayerId, CompanionId).IsValid;
}
