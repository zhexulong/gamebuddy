using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;

namespace GameBuddy.Stardew;

/// <summary>Portfolio-only move ledger. It is deliberately independent from Farmhand execution/receipt types.</summary>
internal sealed class PortfolioExecutionManager
{
    private const int TargetRadius = 8;
    private readonly StardewBodyController body;
    private readonly Dictionary<string, PortfolioMoveReceipt> receipts = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Vector2> targets = new(StringComparer.Ordinal);
    private readonly PortfolioLocalPlayerBinding binding;
    private string? activeRequest;
    private int tick;

    internal PortfolioExecutionManager(PortfolioLocalPlayerBinding binding)
    {
        this.binding = binding;
        this.body = new StardewBodyController(this.OnTransition);
    }

    internal IReadOnlyList<PortfolioMoveTarget> ObserveTargets(long revision)
    {
        Farmer? player = Game1.player;
        if (!Context.IsWorldReady || player?.currentLocation is null) return Array.Empty<PortfolioMoveTarget>();
        var result = new List<PortfolioMoveTarget>();
        Vector2 origin = player.Tile;
        for (int y = -TargetRadius; y <= TargetRadius && result.Count < 32; y++)
        for (int x = -TargetRadius; x <= TargetRadius && result.Count < 32; x++)
        {
            Vector2 tile = origin + new Vector2(x, y);
            if ((x != 0 || y != 0) && tile.X >= 0 && tile.Y >= 0 && player.currentLocation.isTilePassable(new xTile.Dimensions.Location((int)tile.X, (int)tile.Y), Game1.viewport))
            {
                string id = $"move_{revision}_{(int)tile.X}_{(int)tile.Y}";
                this.targets[id] = tile;
                result.Add(new PortfolioMoveTarget(id, revision, player.currentLocation.NameOrUniqueName));
            }
        }
        return result;
    }

    internal PortfolioMoveReceipt Execute(PortfolioMoveRequest request, long revision)
    {
        if (this.receipts.TryGetValue(request.RequestId, out var replay)) return replay;
        if (!request.IsValid || request.Action != "move_to_tile" || !request.Scope.Equals(this.binding.ToScope())) return Remember(request.RequestId, "rejected", "invalid_or_unauthorized_request", null);
        if (request.ObservationRevision != revision || !this.targets.TryGetValue(request.TargetId, out var tile)) return Remember(request.RequestId, "rejected", "stale_observation_or_target", null);
        if (request.DeadlineMs <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() || request.DeadlineMs > DateTimeOffset.UtcNow.AddMinutes(1).ToUnixTimeMilliseconds()) return Remember(request.RequestId, "rejected", "deadline_invalid", null);
        if (this.activeRequest is not null || this.body.HasActiveExecution) return Remember(request.RequestId, "rejected", "body_owned", null);
        var spec = new LocalMoveSpec(Guid.NewGuid().ToString("N"), request.RequestId, tile, false, revision, this.tick + 1200, request.DeadlineMs);
        if (!this.body.TryStart(spec, Game1.player, this.tick, out string reason)) return Remember(request.RequestId, "rejected", reason, null);
        this.activeRequest = request.RequestId;
        return Remember(request.RequestId, "accepted", "accepted", null);
    }

    internal PortfolioMoveReceipt Cancel(PortfolioCancelRequest request)
    {
        if (!request.IsValid || !request.Scope.Equals(this.binding.ToScope())) return Remember(request.RequestId, "rejected", "invalid_cancel", null);
        if (this.activeRequest == request.RequestId) this.body.Cancel("cancelled_by_request");
        return this.receipts.TryGetValue(request.RequestId, out var receipt) ? receipt : Remember(request.RequestId, "rejected", "request_not_active", null);
    }
    internal void Invalidate(string reason) { this.body.Invalidate(reason); this.targets.Clear(); }
    internal void Update() { this.tick++; this.body.Update(this.tick); }
    private void OnTransition(ExecutionState state, string reason, string? evidence)
    {
        if (this.activeRequest is null || state is ExecutionState.Accepted or ExecutionState.Running or ExecutionState.MeaningfulProgress) return;
        string request = this.activeRequest; this.activeRequest = null;
        this.receipts[request] = new PortfolioMoveReceipt(request, state == ExecutionState.Succeeded ? "succeeded" : state.ToString().ToLowerInvariant(), reason, evidence);
    }
    private PortfolioMoveReceipt Remember(string id, string state, string reason, string? evidence) { var r = new PortfolioMoveReceipt(id, state, reason, evidence); this.receipts[id] = r; return r; }
}

internal sealed record PortfolioMoveTarget(string TargetId, long ObservationRevision, string Location);
internal sealed record PortfolioMoveRequest(string RequestId, string Action, PortfolioScope Scope, long ObservationRevision, string TargetId, long DeadlineMs)
{ internal bool IsValid => PortfolioBridgeProtocol.IsOpaqueId(RequestId) && PortfolioBridgeProtocol.IsOpaqueId(TargetId); }
internal sealed record PortfolioCancelRequest(string RequestId, PortfolioScope Scope)
{ internal bool IsValid => PortfolioBridgeProtocol.IsOpaqueId(RequestId); }
internal sealed record PortfolioMoveReceipt(string RequestId, string State, string ReasonCode, string? Evidence);
