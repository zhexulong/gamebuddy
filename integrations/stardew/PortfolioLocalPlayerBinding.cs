using System.Security.Cryptography;
using System.Text;

namespace GameBuddy.Stardew;

/// <summary>
/// Immutable identity seam for the single-player native companion topology.
/// It is created from operator-owned configuration and validated against the
/// current native Game1 state on the game thread before every observation.
/// </summary>
internal sealed record PortfolioLocalPlayerBinding(
    string Topology,
    string SaveId,
    string WorldId,
    string LocalPlayerId,
    string CompanionId,
    string GameVersion,
    int GameBuildNumber,
    long BindingGeneration,
    long CreatedRevision,
    long CreatedTick,
    string BindingHash)
{
    internal bool IsValid => Topology == PortfolioBridgeProtocol.Topology
        && PortfolioBridgeProtocol.IsOpaqueId(SaveId)
        && PortfolioBridgeProtocol.IsOpaqueId(WorldId)
        && PortfolioBridgeProtocol.IsOpaqueId(LocalPlayerId)
        && PortfolioBridgeProtocol.IsOpaqueId(CompanionId)
        && GameVersion == PortfolioBridgeProtocol.TargetGameVersion
        && GameBuildNumber == PortfolioBridgeProtocol.TargetGameBuildNumber
        && BindingGeneration > 0
        && PortfolioBridgeProtocol.IsSha256(BindingHash);

    internal PortfolioScope ToScope() => new(
        PortfolioBridgeProtocol.IntegrationId,
        Topology,
        SaveId,
        WorldId,
        LocalPlayerId,
        CompanionId,
        BindingGeneration,
        BindingHash);

    internal static PortfolioLocalPlayerBinding Create(
        string saveId,
        string worldId,
        string localPlayerId,
        string companionId,
        string gameVersion,
        int gameBuildNumber,
        long generation,
        long revision,
        long tick) => new(
            PortfolioBridgeProtocol.Topology,
            saveId,
            worldId,
            localPlayerId,
            companionId,
            gameVersion,
            gameBuildNumber,
            generation,
            revision,
            tick,
            ComputeHash(saveId, worldId, localPlayerId, companionId, gameVersion, gameBuildNumber, generation));

    internal bool MatchesRuntimeVersion(string gameVersion, int gameBuildNumber) =>
        GameVersion == gameVersion && GameBuildNumber == gameBuildNumber;

    internal static bool IsPinnedRuntimeVersion(string gameVersion, int gameBuildNumber) =>
        gameVersion == PortfolioBridgeProtocol.TargetGameVersion
        && gameBuildNumber == PortfolioBridgeProtocol.TargetGameBuildNumber;

    private static string ComputeHash(string saveId, string worldId, string playerId, string companionId, string gameVersion, int gameBuildNumber, long generation)
    {
        string canonical = $"{PortfolioBridgeProtocol.Topology}\n{saveId}\n{worldId}\n{playerId}\n{companionId}\n{gameVersion}\n{gameBuildNumber}\n{generation}";
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant();
    }
}
