using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;

namespace GameBuddy.Stardew;

/// <summary>
/// Authoritative per-client execution ledger. It validates only this Mod's
/// native Game1.player and replays a request's current receipt on duplicates;
/// it never starts a second body process for the same request.
/// </summary>
internal sealed class ExecutionManager
{
    private const int DefaultDeadlineTicks = 60 * 20;
    private const int MaximumRememberedReceipts = 256;
    private readonly IMonitor monitor;
    private readonly Dictionary<string, LocalExecutionReceipt> receiptsByRequestId = new(StringComparer.Ordinal);
    private readonly Queue<string> receiptOrder = new();
    private readonly List<ExecutionTrace> trace = new();
    private readonly StardewBodyController controller;
    private LocalMoveSpec? active;
    private long revision;
    private int tick;

    public ExecutionManager(IMonitor monitor)
    {
        this.monitor = monitor;
        this.controller = new StardewBodyController(this.RecordControllerTransition);
    }

    public long Revision => this.revision;

    public IReadOnlyList<ExecutionTrace> Trace => this.trace;

    public LocalExecutionReceipt RequestLocalMove(string requestId, Vector2 targetTile)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        if (!Context.IsWorldReady || Game1.player is null)
            return this.RememberTerminal(requestId, string.Empty, ExecutionState.Rejected, "world_not_ready", null);

        if (!IsFiniteTile(targetTile) || targetTile.X < 0 || targetTile.Y < 0 || targetTile.X > 1000 || targetTile.Y > 1000)
            return this.RememberTerminal(requestId, string.Empty, ExecutionState.Rejected, "invalid_target_tile", null);

        if (this.active is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, string.Empty, ExecutionState.Rejected, "body_owned", this.active?.ExecutionId);

        string executionId = Guid.NewGuid().ToString("N");
        LocalMoveSpec specification = new(executionId, requestId, targetTile, this.revision, this.tick + DefaultDeadlineTicks);
        // The controller emits its initial Running transition synchronously;
        // establish ownership first so its authoritative receipt is retained.
        this.active = specification;
        if (!this.controller.TryStart(specification, Game1.player, this.tick, out string reasonCode))
        {
            this.active = null;
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, reasonCode, null);
        }

        LocalExecutionReceipt accepted = new(executionId, requestId, ExecutionState.Accepted, "accepted", this.revision, $"target={FormatTile(targetTile)}");
        this.Remember(accepted);
        this.AddTrace(accepted);
        return accepted;
    }

    public LocalExecutionReceipt Cancel(string reasonCode)
    {
        if (this.active is null)
        {
            this.revision++;
            return new(string.Empty, string.Empty, ExecutionState.Cancelled, "no_active_execution", this.revision, null);
        }

        LocalMoveSpec specification = this.active;
        this.controller.Cancel(reasonCode);
        return this.receiptsByRequestId.TryGetValue(specification.RequestId, out LocalExecutionReceipt? receipt)
            ? receipt
            : this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Uncertain, "cancellation_receipt_missing", null);
    }

    public void Update()
    {
        this.tick++;
        this.controller.Update(this.revision, this.tick);
    }

    public void InvalidateForLifecycle(string reasonCode)
    {
        if (this.active is not null)
            this.controller.Invalidate(reasonCode);
    }

    public object CreateSnapshot()
    {
        Farmer player = Game1.player;
        return new
        {
            schema_version = BridgeProtocol.Version,
            revision = this.revision,
            is_local_player = true,
            is_multiplayer = Context.IsMultiplayer,
            is_main_player = Context.IsMainPlayer,
            farmhand_id = player.UniqueMultiplayerID.ToString(),
            location = player.currentLocation?.NameOrUniqueName,
            tile = new { x = player.Tile.X, y = player.Tile.Y },
            stamina = player.Stamina,
            health = player.health,
            can_move = player.CanMove,
            menu_open = Game1.activeClickableMenu is not null,
            event_active = Game1.eventUp,
            capabilities = new[] { "move_to_tile", "inspect_self" },
            active_execution = this.active is null ? null : new
            {
                execution_id = this.active.ExecutionId,
                request_id = this.active.RequestId,
                action = "move_to_tile",
                target_tile = new { x = this.active.TargetTile.X, y = this.active.TargetTile.Y },
            },
        };
    }

    /// <summary>Explicit Phase 2 wire DTO; call only on the SMAPI game thread while a world is ready.</summary>
    public BridgeSnapshot CreateBridgeSnapshot()
    {
        Farmer player = Game1.player;
        BridgeActiveExecution? activeExecution = this.active is null ? null : new(
            this.active.ExecutionId,
            this.active.RequestId,
            "move_to_tile",
            ExecutionState.Running.ToWireValue(),
            "controller_owned",
            new Dictionary<string, string> { ["target_tile"] = FormatTile(this.active.TargetTile) });
        return new BridgeSnapshot(
            this.revision,
            player.currentLocation?.NameOrUniqueName ?? "unknown",
            player.Tile.X,
            player.Tile.Y,
            player.Stamina,
            player.health,
            player.CanMove && Game1.activeClickableMenu is null && !Game1.eventUp,
            new[] { "move_to_tile", "inspect_self" },
            activeExecution);
    }

    private void RecordControllerTransition(ExecutionState state, string reasonCode, string? evidence)
    {
        if (this.active is null)
            return;

        this.revision++;
        LocalMoveSpec specification = this.active;
        LocalExecutionReceipt receipt = new(specification.ExecutionId, specification.RequestId, state, reasonCode, this.revision, evidence);
        this.Remember(receipt);
        this.AddTrace(receipt);

        if (state is ExecutionState.Succeeded or ExecutionState.Failed or ExecutionState.Cancelled or ExecutionState.Invalidated or ExecutionState.Expired or ExecutionState.Uncertain)
            this.active = null;
    }

    private LocalExecutionReceipt RememberTerminal(string requestId, string executionId, ExecutionState state, string reasonCode, string? evidence)
    {
        LocalExecutionReceipt receipt = new(executionId, requestId, state, reasonCode, this.revision, evidence);
        this.Remember(receipt);
        this.AddTrace(receipt);
        return receipt;
    }

    private void Remember(LocalExecutionReceipt receipt)
    {
        if (!this.receiptsByRequestId.ContainsKey(receipt.RequestId))
        {
            this.receiptOrder.Enqueue(receipt.RequestId);
            if (this.receiptOrder.Count > MaximumRememberedReceipts)
            {
                string evictedRequestId = this.receiptOrder.Dequeue();
                this.receiptsByRequestId.Remove(evictedRequestId);
            }
        }

        this.receiptsByRequestId[receipt.RequestId] = receipt;
    }

    private void AddTrace(LocalExecutionReceipt receipt)
    {
        ExecutionTrace entry = new(this.revision, DateTimeOffset.UtcNow.ToString("O"), receipt.ExecutionId, receipt.RequestId, receipt.State, receipt.ReasonCode, receipt.Evidence);
        this.trace.Add(entry);
        if (this.trace.Count > MaximumRememberedReceipts)
            this.trace.RemoveAt(0);

        this.monitor.Log($"GameBuddy execution state={receipt.State} execution={receipt.ExecutionId} request={receipt.RequestId} reason={receipt.ReasonCode} evidence={receipt.Evidence ?? "none"}", LogLevel.Trace);
    }

    private static bool IsFiniteTile(Vector2 tile) => float.IsFinite(tile.X) && float.IsFinite(tile.Y);

    private static string FormatTile(Vector2 tile) => $"{tile.X:0.##},{tile.Y:0.##}";
}
