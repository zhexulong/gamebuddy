using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Tools;
using StardewValley.Characters;

namespace GameBuddy.Stardew;

/// <summary>
/// Authoritative per-client execution ledger. It validates only this Mod's
/// native Game1.player and replays a request's current receipt on duplicates;
/// it never starts a second body process for the same request.
/// </summary>
internal sealed class ExecutionManager
{
    private const int DefaultDeadlineTicks = 60 * 20;
    private const int AnimalProductDiscoveryRadius = 1;
    private const int MaximumRememberedReceipts = 256;
    private readonly IMonitor monitor;
    private readonly Dictionary<string, LocalExecutionReceipt> receiptsByRequestId = new(StringComparer.Ordinal);
    private readonly Queue<string> receiptOrder = new();
    private readonly List<ExecutionTrace> trace = new();
    private readonly StardewBodyController controller;
    private readonly Action<LocalExecutionReceipt>? receiptPublished;
    private readonly IReadOnlyList<string> capabilities;
    private LocalMoveSpec? active;
    private LocalTravelSpec? activeTravel;
    private LocalPettingSpec? activePet;
    private LocalAnimalProductCollectionSpec? activeAnimalProduct;
    private LocalItemUseSpec? activeItemUse;
    private LocalItemPickupSpec? activeItemPickup;
    private long revision;
    private int tick;

    public ExecutionManager(IMonitor monitor, Action<LocalExecutionReceipt>? receiptPublished = null, IReadOnlySet<string>? enabledActions = null)
    {
        this.monitor = monitor;
        this.receiptPublished = receiptPublished;
        this.capabilities = CreateCapabilities(enabledActions);
        this.controller = new StardewBodyController(this.RecordControllerTransition);
    }

    public long Revision => this.revision;

    public IReadOnlyList<ExecutionTrace> Trace => this.trace;

    /// <summary>Returns the latest authoritative receipt for idempotent bridge replay.</summary>
    public bool TryGetReceipt(string requestId, out LocalExecutionReceipt receipt) => this.receiptsByRequestId.TryGetValue(requestId, out receipt!);

    public LocalExecutionReceipt RequestLocalMove(string requestId, Vector2 targetTile, long? requestedDeadlineMs = null, bool allowAdjacentArrival = false)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        if (!Context.IsWorldReady || Game1.player is null)
            return this.RememberTerminal(requestId, Guid.NewGuid().ToString("N"), ExecutionState.Rejected, "world_not_ready", null);

        if (!IsFiniteTile(targetTile) || targetTile.X != MathF.Floor(targetTile.X) || targetTile.Y != MathF.Floor(targetTile.Y)
            || targetTile.X < 0 || targetTile.Y < 0 || targetTile.X > 1000 || targetTile.Y > 1000)
            return this.RememberTerminal(requestId, Guid.NewGuid().ToString("N"), ExecutionState.Rejected, "invalid_target_tile", null);

        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        long deadlineMs = requestedDeadlineMs ?? nowMs + DefaultDeadlineTicks * 1000L / 60L;
        if (deadlineMs <= nowMs)
            return this.RememberTerminal(requestId, Guid.NewGuid().ToString("N"), ExecutionState.Rejected, "deadline_expired", null);
        if (deadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, Guid.NewGuid().ToString("N"), ExecutionState.Rejected, "invalid_deadline", null);

        // A newer accepted directive supersedes the earlier local directive.
        // The controller is still the sole body owner: it first records a
        // terminal receipt and halts before the new route may start.
        if (this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.activeItemPickup is not null)
            return this.RememberTerminal(requestId, Guid.NewGuid().ToString("N"), ExecutionState.Rejected, "body_owned", this.activeTravel?.ExecutionId ?? this.activePet?.ExecutionId ?? this.activeAnimalProduct?.ExecutionId ?? this.activeItemUse?.ExecutionId ?? this.activeItemPickup?.ExecutionId);
        if (this.active is not null)
            this.controller.Cancel("superseded_by_new_directive");
        if (this.active is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, Guid.NewGuid().ToString("N"), ExecutionState.Uncertain, "body_release_unavailable", null);

        string executionId = Guid.NewGuid().ToString("N");
        // The wall-clock deadline is authoritative: body ticks also check it,
        // so a lagging game tick can never extend a Host/player-bound request.
        int deadlineTicks = Math.Max(1, (int)Math.Ceiling((deadlineMs - nowMs) * 60d / 1000d));
        bool nativeWarpTarget = Game1.player.currentLocation.warps.Any(warp => !warp.npcOnly.Value && warp.X == (int)targetTile.X && warp.Y == (int)targetTile.Y);
        LocalMoveSpec specification = new(executionId, requestId, targetTile, allowAdjacentArrival || nativeWarpTarget, this.revision, this.tick + deadlineTicks, deadlineMs);
        // The controller emits its initial Running transition synchronously;
        // establish ownership first so its authoritative receipt is retained.
        this.active = specification;
        if (!this.controller.TryStart(specification, Game1.player, this.tick, out string reasonCode))
        {
            this.active = null;
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, reasonCode, null);
        }

        LocalExecutionReceipt accepted = new(executionId, requestId, ExecutionState.Accepted, "accepted", this.revision, $"route_revision={specification.RouteRevision};target={FormatTile(targetTile)}");
        this.Remember(accepted);
        this.AddTrace(accepted);
        return accepted;
    }

    /// <summary>
    /// Requests a native warp from a structured source warp in the current
    /// location. The request is accepted before the Warped event; only that
    /// event can produce the authoritative travel postcondition.
    /// </summary>
    public LocalExecutionReceipt RequestLocalTravel(string requestId, int sourceX, int sourceY, long requestedDeadlineMs)
    {
        return this.RequestLocalDoorTransition(requestId, sourceX, sourceY, requestedDeadlineMs, false);
    }

    public LocalExecutionReceipt RequestLocalEnterExit(string requestId, int sourceX, int sourceY, long requestedDeadlineMs)
    {
        return this.RequestLocalDoorTransition(requestId, sourceX, sourceY, requestedDeadlineMs, true);
    }

    private LocalExecutionReceipt RequestLocalDoorTransition(string requestId, int sourceX, int sourceY, long requestedDeadlineMs, bool isDoor)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", this.active?.ExecutionId ?? this.activeTravel?.ExecutionId ?? this.activeAnimalProduct?.ExecutionId ?? this.activeItemUse?.ExecutionId);

        StardewValley.GameLocation location = Game1.player.currentLocation;
        Microsoft.Xna.Framework.Point sourcePoint = new(sourceX, sourceY);
        StardewValley.Warp? warp = isDoor
            ? ResolveDoorWarp(location, sourcePoint)
            : location.warps.FirstOrDefault(candidate => candidate.X == sourceX && candidate.Y == sourceY && !candidate.npcOnly.Value);
        if (warp is null || warp.TargetName is null or "")
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, isDoor ? "door_not_available" : "warp_not_available", $"source={sourceX},{sourceY}");
        if (!Utility.tileWithinRadiusOfPlayer(sourceX, sourceY, 1, Game1.player))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, isDoor ? "door_out_of_range" : "warp_out_of_range", $"source={sourceX},{sourceY}");

        LocalTravelSpec specification = new(
            executionId,
            requestId,
            isDoor ? "enter_exit" : "travel",
            location.NameOrUniqueName,
            sourceX,
            sourceY,
            warp.TargetName,
            warp.TargetX,
            warp.TargetY,
            this.revision,
            requestedDeadlineMs);
        this.activeTravel = specification;
        LocalExecutionReceipt accepted = new(
            executionId,
            requestId,
            ExecutionState.Accepted,
            "accepted",
            this.revision,
            $"source={specification.SourceLocation}:{sourceX},{sourceY};target={specification.TargetLocation}:{specification.TargetX},{specification.TargetY}");
        this.Remember(accepted);
        this.AddTrace(accepted);
        Game1.player.warpFarmer(warp);
        return accepted;
    }

    public void CompleteTravelAfterWarp()
    {
        LocalTravelSpec? specification = this.activeTravel;
        if (specification is null || Game1.player is null || Game1.player.currentLocation is null)
            return;

        this.revision++;
        bool locationMatches = string.Equals(Game1.player.currentLocation.NameOrUniqueName, specification.TargetLocation, StringComparison.Ordinal);
        bool tileMatches = Game1.player.TilePoint.X == specification.TargetX && Game1.player.TilePoint.Y == specification.TargetY;
        ExecutionState state = locationMatches && tileMatches ? ExecutionState.Succeeded : ExecutionState.Uncertain;
        string reasonCode = locationMatches && tileMatches
            ? specification.Action == "enter_exit" ? "enter_exit_completed" : "travel_completed"
            : specification.Action == "enter_exit" ? "enter_exit_postcondition_mismatch" : "travel_postcondition_mismatch";
        LocalExecutionReceipt receipt = new(
            specification.ExecutionId,
            specification.RequestId,
            state,
            reasonCode,
            this.revision,
            $"expected={specification.TargetLocation}:{specification.TargetX},{specification.TargetY};actual={Game1.player.currentLocation.NameOrUniqueName}:{Game1.player.TilePoint.X},{Game1.player.TilePoint.Y}");
        this.activeTravel = null;
        this.Remember(receipt);
        this.AddTrace(receipt);
    }

    /// <summary>Published native forage pickup. The native location action owns inventory and object removal.</summary>
    public LocalExecutionReceipt RequestLocalPickupForage(string requestId, int targetX, int targetY, string expectedQualifiedItemId, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", this.active?.ExecutionId ?? this.activeTravel?.ExecutionId ?? this.activeAnimalProduct?.ExecutionId ?? this.activeItemUse?.ExecutionId);
        if (!Utility.tileWithinRadiusOfPlayer(targetX, targetY, 1, Game1.player))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={targetX},{targetY}");

        StardewValley.GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.objects.TryGetValue(tile, out StardewValley.Object? forage) || !forage.isForage())
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "forage_not_available", $"target={targetX},{targetY}");
        if (!string.Equals(forage.QualifiedItemId, expectedQualifiedItemId, StringComparison.Ordinal)
            || !string.Equals(BuildForageTargetId(location, targetX, targetY, forage), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "forage_target_changed", $"target={targetX},{targetY}");
        if (!Game1.player.couldInventoryAcceptThisItem(forage))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "inventory_full", $"target={targetX},{targetY}");

        int beforeCount = Game1.player.Items.Sum(item => item?.QualifiedItemId == expectedQualifiedItemId ? item.Stack : 0);
        LocalForagePickupSpec specification = new(executionId, requestId, location.NameOrUniqueName, targetX, targetY, expectedTargetId, expectedQualifiedItemId, this.revision, requestedDeadlineMs);
        bool actionHandled = location.checkAction(new xTile.Dimensions.Location(targetX, targetY), Game1.viewport, Game1.player);
        int afterCount = Game1.player.Items.Sum(item => item?.QualifiedItemId == expectedQualifiedItemId ? item.Stack : 0);
        bool removed = !location.objects.ContainsKey(tile);
        bool inventoryChanged = afterCount > beforeCount;
        ExecutionState state = actionHandled && removed && inventoryChanged ? ExecutionState.Succeeded : ExecutionState.Uncertain;
        string reasonCode = state == ExecutionState.Succeeded ? "forage_picked_up" : "forage_postcondition_unavailable";
        LocalExecutionReceipt receipt = new(executionId, requestId, state, reasonCode, this.revision,
            $"location={specification.Location};target={targetX},{targetY};item={expectedQualifiedItemId};removed={removed};inventory_before={beforeCount};inventory_after={afterCount}");
        this.Remember(receipt);
        this.AddTrace(receipt);
        return receipt;
    }

    /// <summary>
    /// Requests pickup through target-version Debris lifecycle. Ordinary debris
    /// has no click action: its own GameLocation update magnetizes it to an
    /// eligible nearby Farmer and calls Debris.collect. The bridge only waits
    /// for that native delivery; it never calls collect, removes chunks, or
    /// mutates inventory itself.
    /// </summary>
    public LocalExecutionReceipt RequestLocalPickupItem(string requestId, int targetX, int targetY, string expectedQualifiedItemId, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.activeItemPickup is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", this.active?.ExecutionId ?? this.activeTravel?.ExecutionId ?? this.activePet?.ExecutionId ?? this.activeAnimalProduct?.ExecutionId ?? this.activeItemUse?.ExecutionId ?? this.activeItemPickup?.ExecutionId);

        StardewValley.GameLocation location = Game1.player.currentLocation;
        (Debris Debris, int DebrisIndex, int ChunkIndex, Chunk Chunk, string TargetId, string QualifiedItemId, int Stack)? target = FindItemTarget(location, Game1.player, expectedTargetId, expectedQualifiedItemId, radius: 8);
        if (target is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_target_changed", $"target={targetX},{targetY}");
        Point liveTargetTile = GetChunkTile(target.Value.Chunk);
        if (liveTargetTile.X != targetX || liveTargetTile.Y != targetY)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_target_moved", $"expected={targetX},{targetY};actual={liveTargetTile.X},{liveTargetTile.Y}");
        if (!Game1.player.couldInventoryAcceptThisItem(target.Value.Debris.item ?? ItemRegistry.Create(expectedQualifiedItemId, target.Value.Stack)))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "inventory_full", $"target={expectedTargetId}");

        int beforeCount = CountQualifiedItem(Game1.player, expectedQualifiedItemId);
        int deadlineTicks = Math.Max(1, (int)Math.Ceiling((requestedDeadlineMs - nowMs) * 60d / 1000d));
        // The body controller drives this native approach. Debris.updateChunks
        // owns magnetic delivery and Debris.collect on following game updates;
        // the bridge never calls collect or touches chunks/inventory directly.
        LocalMoveSpec approach = new(executionId, requestId, new Vector2(liveTargetTile.X, liveTargetTile.Y), true, this.revision, this.tick + deadlineTicks, requestedDeadlineMs);
        this.activeItemPickup = new LocalItemPickupSpec(executionId, requestId, location.NameOrUniqueName, liveTargetTile.X, liveTargetTile.Y, expectedTargetId, expectedQualifiedItemId, target.Value.Stack, beforeCount, this.revision, requestedDeadlineMs);
        this.active = approach;
        if (!this.controller.TryStart(approach, Game1.player, this.tick, out string reasonCode))
        {
            this.active = null;
            this.activeItemPickup = null;
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, reasonCode, $"target={expectedTargetId};tile={targetX},{targetY}");
        }

        LocalExecutionReceipt accepted = new(executionId, requestId, ExecutionState.Accepted, "accepted", this.revision,
            $"location={location.NameOrUniqueName};target={expectedTargetId};tile={targetX},{targetY};item={expectedQualifiedItemId};stack={target.Value.Stack};inventory_before={beforeCount};native_auto_collect=true");
        this.Remember(accepted);
        this.AddTrace(accepted);
        return accepted;
    }

    public LocalExecutionReceipt RequestLocalWaterCrop(string requestId, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", this.active?.ExecutionId ?? this.activeTravel?.ExecutionId ?? this.activeAnimalProduct?.ExecutionId ?? this.activeItemUse?.ExecutionId);
        if (!IsCropTargetInRange(Game1.player, targetX, targetY))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={targetX},{targetY}");

        StardewValley.GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? feature)
            || feature is not StardewValley.TerrainFeatures.HoeDirt dirt
            || dirt.crop is null
            || !dirt.needsWatering()
            || dirt.isWatered())
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "crop_target_unavailable", $"target={targetX},{targetY}");
        if (!string.Equals(BuildCropTargetId(location, targetX, targetY, dirt.crop.netSeedIndex.Value, dirt.crop.indexOfHarvest.Value), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "crop_target_changed", $"target={targetX},{targetY}");
        if (Game1.player.CurrentTool is not WateringCan wateringCan)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "watering_can_not_equipped", null);
        if (wateringCan.WaterLeft <= 0 && !Game1.player.hasWateringCanEnchantment)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "watering_can_empty", null);

        LocalCropWateringSpec specification = new(executionId, requestId, location.NameOrUniqueName, targetX, targetY, expectedTargetId, dirt.crop.netSeedIndex.Value ?? dirt.crop.indexOfHarvest.Value ?? "unknown", this.revision, requestedDeadlineMs);
        bool beforeWatered = dirt.isWatered();
        int beforeWater = wateringCan.WaterLeft;
        wateringCan.DoFunction(location, targetX * 64 + 32, targetY * 64 + 32, 0, Game1.player);
        bool afterWatered = dirt.isWatered();
        bool waterConsumed = wateringCan.IsBottomless || wateringCan.WaterLeft < beforeWater || Game1.player.hasWateringCanEnchantment;
        ExecutionState state = !beforeWatered && afterWatered ? ExecutionState.Succeeded : ExecutionState.Uncertain;
        string reasonCode = state == ExecutionState.Succeeded ? "crop_watered" : "crop_water_postcondition_unavailable";
        LocalExecutionReceipt receipt = new(executionId, requestId, state, reasonCode, this.revision,
            $"location={specification.Location};target={expectedTargetId};tile={targetX},{targetY};before_watered={beforeWatered};after_watered={afterWatered};water_before={beforeWater};water_after={wateringCan.WaterLeft};water_consumed={waterConsumed}");
        this.Remember(receipt);
        this.AddTrace(receipt);
        return receipt;
    }

    /// <summary>Native crop harvest limited to ready, ordinary Grab crops.</summary>
    public LocalExecutionReceipt RequestLocalHarvestCrop(string requestId, int targetX, int targetY, string expectedQualifiedHarvestItemId, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", this.active?.ExecutionId ?? this.activeTravel?.ExecutionId ?? this.activePet?.ExecutionId ?? this.activeAnimalProduct?.ExecutionId ?? this.activeItemUse?.ExecutionId);
        if (!IsCropTargetInRange(Game1.player, targetX, targetY))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={targetX},{targetY}");

        StardewValley.GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? feature)
            || feature is not StardewValley.TerrainFeatures.HoeDirt dirt
            || dirt.crop is null
            || dirt.crop.forageCrop.Value
            || !dirt.readyForHarvest()
            || dirt.crop.GetHarvestMethod() != StardewValley.GameData.Crops.HarvestMethod.Grab
            || !string.Equals(BuildCropTargetId(location, targetX, targetY, dirt.crop.netSeedIndex.Value, dirt.crop.indexOfHarvest.Value), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "harvest_target_unavailable", $"target={targetX},{targetY}");

        StardewValley.Crop crop = dirt.crop;
        // HoeDirt.performUseAction promotes a Golden Scythe to a scythe
        // harvest even for a crop whose data says Grab. This narrow action
        // exposes only the ordinary native Grab path, so reject that override.
        if (Game1.player.CurrentTool is StardewValley.Tool selectedTool
            && selectedTool.isScythe()
            && string.Equals(selectedTool.ItemId, "66", StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "golden_scythe_grab_override", null);

        StardewValley.Item harvestItem;
        try
        {
            harvestItem = StardewValley.ItemRegistry.Create(crop.indexOfHarvest.Value, 1);
        }
        catch (Exception)
        {
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "harvest_item_unavailable", $"target={targetX},{targetY}");
        }
        if (!string.Equals(harvestItem.QualifiedItemId, expectedQualifiedHarvestItemId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "harvest_target_changed", $"target={targetX},{targetY}");
        if (!Game1.player.couldInventoryAcceptThisItem(harvestItem))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "inventory_full", $"item={expectedQualifiedHarvestItemId}");

        bool regrowsAfterHarvest = crop.RegrowsAfterHarvest();
        string cropId = crop.netSeedIndex.Value ?? crop.indexOfHarvest.Value ?? "unknown";
        int inventoryBefore = Game1.player.Items.Sum(item => item?.QualifiedItemId == expectedQualifiedHarvestItemId ? item.Stack : 0);
        int phaseBefore = crop.currentPhase.Value;
        int dayOfPhaseBefore = crop.dayOfCurrentPhase.Value;
        LocalCropHarvestingSpec specification = new(executionId, requestId, location.NameOrUniqueName, targetX, targetY, expectedTargetId, cropId, expectedQualifiedHarvestItemId, regrowsAfterHarvest, this.revision, requestedDeadlineMs);
        // HoeDirt.performUseAction is the target-version native grab-harvest
        // route. It dispatches Crop.harvest and, only when that native method
        // says the crop is non-regrowing, invokes native destroyCrop itself.
        // Do not reproduce either inventory or terrain mutation here.
        // This outer native wrapper returns true only when it destroyed a
        // non-regrowing crop. A successful regrow harvest deliberately falls
        // through to its pre-harvest readiness result (normally false), so its
        // receipt must rely on the separate inventory and phase postconditions.
        bool nativePathReturn = dirt.performUseAction(tile);

        int inventoryAfter = Game1.player.Items.Sum(item => item?.QualifiedItemId == expectedQualifiedHarvestItemId ? item.Stack : 0);
        bool inventoryGained = inventoryAfter > inventoryBefore;
        bool cropStillPresent = location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? afterFeature)
            && afterFeature is StardewValley.TerrainFeatures.HoeDirt afterDirt
            && afterDirt.crop is not null;
        StardewValley.Crop? cropAfter = cropStillPresent
            ? ((StardewValley.TerrainFeatures.HoeDirt)afterFeature!).crop
            : null;
        bool regrowAdvanced = regrowsAfterHarvest && cropAfter is not null
            && cropAfter.dayOfCurrentPhase.Value > dayOfPhaseBefore
            && cropAfter.currentPhase.Value >= phaseBefore;
        bool cropPostcondition = regrowsAfterHarvest ? cropStillPresent && regrowAdvanced : !cropStillPresent;
        bool nativeAccepted = inventoryGained && cropPostcondition && (regrowsAfterHarvest || nativePathReturn);
        ExecutionState state = nativeAccepted ? ExecutionState.Succeeded : ExecutionState.Uncertain;
        string reasonCode = state == ExecutionState.Succeeded ? "crop_harvested" : "crop_harvest_postcondition_unavailable";
        LocalExecutionReceipt receipt = new(executionId, requestId, state, reasonCode, this.revision,
            $"location={specification.Location};target={expectedTargetId};tile={targetX},{targetY};crop={cropId};item={expectedQualifiedHarvestItemId};native_path_return={nativePathReturn.ToString().ToLowerInvariant()};native_accepted={nativeAccepted.ToString().ToLowerInvariant()};regrows={regrowsAfterHarvest.ToString().ToLowerInvariant()};phase_before={phaseBefore};phase_after={cropAfter?.currentPhase.Value.ToString() ?? "none"};day_of_phase_before={dayOfPhaseBefore};day_of_phase_after={cropAfter?.dayOfCurrentPhase.Value.ToString() ?? "none"};regrow_advanced={regrowAdvanced.ToString().ToLowerInvariant()};inventory_before={inventoryBefore};inventory_after={inventoryAfter};inventory_gained={inventoryGained.ToString().ToLowerInvariant()};crop_present_after={cropStillPresent.ToString().ToLowerInvariant()}");
        this.Remember(receipt);
        this.AddTrace(receipt);
        return receipt;
    }

    public LocalExecutionReceipt RequestLocalPlantSeed(string requestId, int slot, int targetX, int targetY, string expectedQualifiedItemId, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", this.active?.ExecutionId ?? this.activeTravel?.ExecutionId ?? this.activeAnimalProduct?.ExecutionId ?? this.activeItemUse?.ExecutionId);
        if (!IsCropTargetInRange(Game1.player, targetX, targetY))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={targetX},{targetY}");
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.Items[slot] is not StardewValley.Object seed || seed.Category != StardewValley.Object.SeedsCategory)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "seed_not_owned_in_slot", $"slot={slot}");
        if (!string.Equals(seed.QualifiedItemId, expectedQualifiedItemId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "seed_slot_changed", $"slot={slot}");

        StardewValley.GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? feature)
            || feature is not StardewValley.TerrainFeatures.HoeDirt dirt
            || (location.objects.TryGetValue(tile, out StardewValley.Object? placed) && placed is StardewValley.Objects.IndoorPot)
            || dirt.crop is not null
            || !dirt.canPlantThisSeedHere(seed.ItemId, isFertilizer: false)
            || !string.Equals(BuildSeedTargetId(location, slot, targetX, targetY, seed.QualifiedItemId), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "seed_target_unavailable", $"target={targetX},{targetY}");

        int beforeCount = Game1.player.Items.Sum(item => item?.QualifiedItemId == expectedQualifiedItemId ? item.Stack : 0);
        int previousSlot = Game1.player.CurrentToolIndex;
        LocalSeedPlantingSpec specification = new(executionId, requestId, location.NameOrUniqueName, slot, targetX, targetY, expectedTargetId, expectedQualifiedItemId, this.revision, requestedDeadlineMs);
        bool placementHandled;
        try
        {
            Game1.player.CurrentToolIndex = slot;
            placementHandled = seed.placementAction(location, targetX * 64 + 32, targetY * 64 + 32, Game1.player);
            if (placementHandled)
                Game1.player.reduceActiveItemByOne();
        }
        finally
        {
            Game1.player.CurrentToolIndex = previousSlot;
        }

        StardewValley.TerrainFeatures.HoeDirt? plantedDirt = location.GetHoeDirtAtTile(tile);
        string? plantedCropId = plantedDirt?.crop?.netSeedIndex.Value ?? plantedDirt?.crop?.indexOfHarvest.Value;
        int afterCount = Game1.player.Items.Sum(item => item?.QualifiedItemId == expectedQualifiedItemId ? item.Stack : 0);
        bool cropCreated = plantedDirt?.crop is not null && !string.IsNullOrWhiteSpace(plantedCropId);
        bool inventoryDecremented = afterCount == beforeCount - 1;
        ExecutionState state = placementHandled && cropCreated && inventoryDecremented ? ExecutionState.Succeeded : ExecutionState.Uncertain;
        string reasonCode = state == ExecutionState.Succeeded ? "seed_planted" : "seed_plant_postcondition_unavailable";
        LocalExecutionReceipt receipt = new(executionId, requestId, state, reasonCode, this.revision,
            $"location={specification.Location};target={expectedTargetId};tile={targetX},{targetY};item={expectedQualifiedItemId};crop={plantedCropId ?? "none"};inventory_before={beforeCount};inventory_after={afterCount}");
        this.Remember(receipt);
        this.AddTrace(receipt);
        return receipt;
    }

    public LocalExecutionReceipt RequestLocalFertilizeTile(string requestId, int slot, int targetX, int targetY, string expectedQualifiedItemId, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", this.active?.ExecutionId ?? this.activeTravel?.ExecutionId ?? this.activeAnimalProduct?.ExecutionId ?? this.activeItemUse?.ExecutionId);
        if (!IsCropTargetInRange(Game1.player, targetX, targetY))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={targetX},{targetY}");
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.Items[slot] is not StardewValley.Object fertilizer || fertilizer.Category != StardewValley.Object.fertilizerCategory)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "fertilizer_not_owned_in_slot", $"slot={slot}");
        if (!string.Equals(fertilizer.QualifiedItemId, expectedQualifiedItemId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "fertilizer_slot_changed", $"slot={slot}");

        StardewValley.GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? feature)
            || feature is not StardewValley.TerrainFeatures.HoeDirt dirt
            || (location.objects.TryGetValue(tile, out StardewValley.Object? placed) && placed is StardewValley.Objects.IndoorPot)
            || !dirt.CanApplyFertilizer(fertilizer.QualifiedItemId)
            || !string.Equals(BuildFertilizerTargetId(location, slot, targetX, targetY, fertilizer.QualifiedItemId), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "fertilizer_target_unavailable", $"target={targetX},{targetY}");

        int beforeCount = Game1.player.Items.Sum(item => item?.QualifiedItemId == expectedQualifiedItemId ? item.Stack : 0);
        string? beforeFertilizer = dirt.fertilizer.Value;
        int previousSlot = Game1.player.CurrentToolIndex;
        LocalFertilizerApplicationSpec specification = new(executionId, requestId, location.NameOrUniqueName, slot, targetX, targetY, expectedTargetId, expectedQualifiedItemId, this.revision, requestedDeadlineMs);
        bool placementHandled;
        try
        {
            Game1.player.CurrentToolIndex = slot;
            placementHandled = fertilizer.placementAction(location, targetX * 64 + 32, targetY * 64 + 32, Game1.player);
            if (placementHandled)
                Game1.player.reduceActiveItemByOne();
        }
        finally
        {
            Game1.player.CurrentToolIndex = previousSlot;
        }

        StardewValley.TerrainFeatures.HoeDirt? appliedDirt = location.GetHoeDirtAtTile(tile);
        string? afterFertilizer = appliedDirt?.fertilizer.Value;
        int afterCount = Game1.player.Items.Sum(item => item?.QualifiedItemId == expectedQualifiedItemId ? item.Stack : 0);
        bool fertilizerApplied = string.Equals(afterFertilizer, expectedQualifiedItemId, StringComparison.Ordinal);
        bool inventoryDecremented = afterCount == beforeCount - 1;
        ExecutionState state = placementHandled && fertilizerApplied && inventoryDecremented ? ExecutionState.Succeeded : ExecutionState.Uncertain;
        string reasonCode = state == ExecutionState.Succeeded ? "fertilizer_applied" : "fertilizer_postcondition_unavailable";
        LocalExecutionReceipt receipt = new(executionId, requestId, state, reasonCode, this.revision,
            $"location={specification.Location};target={expectedTargetId};tile={targetX},{targetY};item={expectedQualifiedItemId};fertilizer_before={beforeFertilizer ?? "none"};fertilizer_after={afterFertilizer ?? "none"};inventory_before={beforeCount};inventory_after={afterCount}");
        this.Remember(receipt);
        this.AddTrace(receipt);
        return receipt;
    }

    public LocalExecutionReceipt RequestLocalClearDebris(string requestId, int slot, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", this.active?.ExecutionId ?? this.activeTravel?.ExecutionId ?? this.activeAnimalProduct?.ExecutionId ?? this.activeItemUse?.ExecutionId);
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.Items[slot] is not Tool tool)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "tool_not_owned_in_slot", $"slot={slot}");
        if (!Utility.tileWithinRadiusOfPlayer(targetX, targetY, 1, Game1.player))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={targetX},{targetY}");

        StardewValley.GameLocation location = Game1.player.currentLocation;
        StardewValley.TerrainFeatures.ResourceClump? clump = FindDebrisTarget(location, targetX, targetY, expectedTargetId, out int clumpIndex);
        if (clump is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "debris_target_changed", $"target={targetX},{targetY}");
        if (!IsValidDebrisTool(clump, tool, out string toolKind, out int requiredUpgrade))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "debris_tool_unavailable", $"target={targetX},{targetY};parent={clump.parentSheetIndex.Value}");

        int previousSlot = Game1.player.CurrentToolIndex;
        Game1.player.CurrentToolIndex = slot;
        try
        {
            if (Game1.player.CurrentTool is not Tool activeTool)
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "tool_not_equipped", $"slot={slot}");
            Vector2 hitTile = clump.Tile;
            activeTool.DoFunction(location, (int)hitTile.X * 64 + 32, (int)hitTile.Y * 64 + 32, 0, Game1.player);
            // Tool.endUsing normally advances this native swing identity after
            // the animation. This direct game-thread adapter advances it after
            // the one bounded native hit so a retry is a distinct swing.
            activeTool.swingTicker++;
        }
        finally
        {
            Game1.player.CurrentToolIndex = previousSlot;
        }

        StardewValley.TerrainFeatures.ResourceClump? remaining = FindDebrisTarget(location, targetX, targetY, expectedTargetId, out _);
        float healthAfter = remaining?.health.Value ?? 0f;
        bool cleared = remaining is null;
        LocalExecutionReceipt receipt = new(
            executionId,
            requestId,
            cleared ? ExecutionState.Succeeded : ExecutionState.PartiallySucceeded,
            cleared ? "debris_cleared" : "debris_hit",
            this.revision,
            $"location={location.NameOrUniqueName};target={expectedTargetId};tile={targetX},{targetY};parent={clump.parentSheetIndex.Value};tool={toolKind};required_upgrade={requiredUpgrade};health_before={clump.health.Value:0.##};health_after={healthAfter:0.##};clump_removed={cleared.ToString().ToLowerInvariant()}");
        this.Remember(receipt);
        this.AddTrace(receipt);
        return receipt;
    }

    private static StardewValley.TerrainFeatures.ResourceClump? FindDebrisTarget(StardewValley.GameLocation location, int targetX, int targetY, string expectedTargetId, out int clumpIndex)
    {
        clumpIndex = -1;
        for (int index = 0; index < location.resourceClumps.Count; index++)
        {
            StardewValley.TerrainFeatures.ResourceClump clump = location.resourceClumps[index];
            Point tile = new((int)clump.Tile.X, (int)clump.Tile.Y);
            string targetId = BuildDebrisTargetId(location, index, clump);
            if (tile.X == targetX && tile.Y == targetY && string.Equals(targetId, expectedTargetId, StringComparison.Ordinal)
                && Utility.tileWithinRadiusOfPlayer(targetX, targetY, 1, Game1.player))
            {
                clumpIndex = index;
                return clump;
            }
        }
        return null;
    }

    private static string BuildDebrisTargetId(StardewValley.GameLocation location, int index, StardewValley.TerrainFeatures.ResourceClump clump)
    {
        string raw = $"{location.NameOrUniqueName}:{index}:{(int)clump.Tile.X},{(int)clump.Tile.Y}:{clump.parentSheetIndex.Value}:{clump.width.Value}x{clump.height.Value}";
        return $"debris_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static bool IsValidDebrisTool(StardewValley.TerrainFeatures.ResourceClump clump, Tool tool, out string toolKind, out int requiredUpgrade)
    {
        toolKind = clump.parentSheetIndex.Value switch
        {
            600 or 602 => "axe",
            148 or 622 or 672 or 752 or 754 or 756 or 758 => "pickaxe",
            _ => "unsupported",
        };
        requiredUpgrade = clump.parentSheetIndex.Value switch
        {
            600 => 1,
            602 => 2,
            148 or 622 => 3,
            672 => 2,
            _ => 0,
        };
        return (toolKind == "axe" && tool is Axe && tool.UpgradeLevel >= requiredUpgrade)
            || (toolKind == "pickaxe" && tool is Pickaxe && tool.UpgradeLevel >= requiredUpgrade);
    }

    /// <summary>Published read-only machine inspection. It reads only the live machine object and never invokes the interaction menu or mutates machine state.</summary>
    public LocalExecutionReceipt RequestLocalInspectMachine(string requestId, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", this.active?.ExecutionId ?? this.activeTravel?.ExecutionId ?? this.activeAnimalProduct?.ExecutionId ?? this.activeItemUse?.ExecutionId);
        if (!IsMachineTargetInRange(Game1.player, targetX, targetY))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={targetX},{targetY}");

        StardewValley.GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.objects.TryGetValue(tile, out StardewValley.Object? machine)
            || machine.GetMachineData() is null
            || !string.Equals(BuildMachineTargetId(location, targetX, targetY, machine.QualifiedItemId), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "machine_target_changed", $"target={targetX},{targetY}");

        LocalMachineInspectionSpec specification = new(executionId, requestId, location.NameOrUniqueName, targetX, targetY, expectedTargetId, this.revision, requestedDeadlineMs);
        string? held = machine.heldObject.Value?.QualifiedItemId;
        string? input = machine.lastInputItem.Value?.QualifiedItemId;
        string evidence = $"location={specification.Location};target={expectedTargetId};tile={targetX},{targetY};machine={machine.QualifiedItemId};ready_for_harvest={machine.readyForHarvest.Value.ToString().ToLowerInvariant()};minutes_until_ready={machine.MinutesUntilReady};held={held ?? "none"};last_input={input ?? "none"}";
        LocalExecutionReceipt receipt = new(executionId, requestId, ExecutionState.Succeeded, "machine_inspected", this.revision, evidence);
        this.Remember(receipt);
        this.AddTrace(receipt);
        return receipt;
    }

    /// <summary>Experimental resource collection limited to a live mature Tree stump.</summary>
    public LocalExecutionReceipt RequestLocalCollectResource(string requestId, int slot, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", this.active?.ExecutionId ?? this.activeTravel?.ExecutionId ?? this.activeAnimalProduct?.ExecutionId ?? this.activeItemUse?.ExecutionId);
        if (!Utility.tileWithinRadiusOfPlayer(targetX, targetY, 1, Game1.player))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={targetX},{targetY}");
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.Items[slot] is not Axe axe)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "axe_not_owned_in_slot", $"slot={slot}");

        StardewValley.GameLocation location = Game1.player.currentLocation;
        Vector2 tile = new(targetX, targetY);
        if (!location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? feature)
            || feature is not StardewValley.TerrainFeatures.Tree tree
            || !tree.stump.Value
            || !string.Equals(BuildResourceTargetId(location, targetX, targetY, tree), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "resource_target_changed", $"target={targetX},{targetY}");

        float healthBefore = tree.health.Value;
        bool stumpBefore = tree.stump.Value;
        int resourceDebrisBefore = CountResourceDebris(location);
        LocalResourceCollectionSpec specification = new(executionId, requestId, location.NameOrUniqueName, slot, targetX, targetY, expectedTargetId, tree.treeType.Value, healthBefore, stumpBefore, this.revision, requestedDeadlineMs);
        int previousSlot = Game1.player.CurrentToolIndex;
        try
        {
            Game1.player.CurrentToolIndex = slot;
            if (Game1.player.CurrentTool is not Axe activeAxe)
                return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "axe_not_equipped", $"slot={slot}");
            activeAxe.DoFunction(location, targetX * 64 + 32, targetY * 64 + 32, 0, Game1.player);
        }
        finally
        {
            Game1.player.CurrentToolIndex = previousSlot;
        }

        bool treeRemoved = !location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? remaining)
            || remaining is not StardewValley.TerrainFeatures.Tree;
        int resourceDebrisAfter = CountResourceDebris(location);
        // Tree.performTreeFall creates RESOURCE chunks that have no parent-stump
        // or request identity. Their later Debris.collect lifecycle is separate
        // from this Axe hit, so a new debris count is not collection evidence.
        ExecutionState state = treeRemoved ? ExecutionState.Uncertain : ExecutionState.PartiallySucceeded;
        string reasonCode = treeRemoved ? "resource_drop_pending" : "resource_hit";
        float healthAfter = remaining is StardewValley.TerrainFeatures.Tree remainingTree ? remainingTree.health.Value : -100f;
        string evidence = $"location={specification.Location};target={expectedTargetId};tile={targetX},{targetY};tree_type={specification.TreeType};stump_before={specification.StumpBefore.ToString().ToLowerInvariant()};health_before={specification.HealthBefore:0.##};health_after={healthAfter:0.##};tree_removed={treeRemoved.ToString().ToLowerInvariant()};resource_debris_before={resourceDebrisBefore};resource_debris_after={resourceDebrisAfter};resource_collected=false;collection_identity=unavailable";
        LocalExecutionReceipt receipt = new(executionId, requestId, state, reasonCode, this.revision, evidence);
        this.Remember(receipt);
        this.AddTrace(receipt);
        return receipt;
    }

    private static int CountResourceDebris(StardewValley.GameLocation location)
    {
        return location.debris.Count(debris => debris.debrisType.Value == Debris.DebrisType.RESOURCE);
    }

    private static string BuildResourceTargetId(StardewValley.GameLocation location, int x, int y, StardewValley.TerrainFeatures.Tree tree)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:tree:{tree.treeType.Value}";
        return $"resource_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    /// <summary>Experimental native item consumption. The Farmer owns animation, stat/buff changes, and inventory decrement.</summary>
    public LocalExecutionReceipt RequestLocalUseItem(string requestId, int slot, string expectedQualifiedItemId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (!Context.IsWorldReady || Game1.player is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove || Game1.player.isEating)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", this.active?.ExecutionId ?? this.activeTravel?.ExecutionId ?? this.activePet?.ExecutionId ?? this.activeAnimalProduct?.ExecutionId ?? this.activeItemUse?.ExecutionId);
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.Items[slot] is not StardewValley.Object food)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_not_owned_in_slot", $"slot={slot}");
        if (!string.Equals(food.QualifiedItemId, expectedQualifiedItemId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_slot_changed", $"slot={slot}");
        bool isDrink = Game1.objectData.TryGetValue(food.ItemId, out var objectData) && objectData.IsDrink;
        if (food.QualifiedItemId == "(O)434" || (!isDrink && food.Edibility == -300))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "item_not_consumable", $"slot={slot};item={expectedQualifiedItemId}");

        int stackBefore = food.Stack;
        LocalItemUseSpec specification = new(executionId, requestId, slot, expectedQualifiedItemId, stackBefore, food.Edibility, isDrink, Game1.player.Stamina, Game1.player.health, this.revision, requestedDeadlineMs);
        int previousSlot = Game1.player.CurrentToolIndex;
        try
        {
            Game1.player.CurrentToolIndex = slot;
            Game1.player.mostRecentlyGrabbedItem = food;
            Game1.player.eatHeldObject();
        }
        finally
        {
            Game1.player.CurrentToolIndex = previousSlot;
        }

        StardewValley.Object? remaining = slot < Game1.player.Items.Count ? Game1.player.Items[slot] as StardewValley.Object : null;
        bool started = Game1.player.isEating;
        bool consumed = remaining is null || (string.Equals(remaining.QualifiedItemId, expectedQualifiedItemId, StringComparison.Ordinal) && remaining.Stack == stackBefore - 1);
        if (!started)
        {
            ExecutionState state = consumed ? ExecutionState.Uncertain : ExecutionState.Rejected;
            return this.RememberTerminal(requestId, executionId, state, consumed ? "item_use_started_without_animation" : "item_use_not_started", $"slot={slot};started=false;consumed={consumed.ToString().ToLowerInvariant()}");
        }

        this.activeItemUse = specification;
        LocalExecutionReceipt accepted = new(executionId, requestId, ExecutionState.Accepted, "accepted", this.revision,
            $"slot={slot};item={expectedQualifiedItemId};stack_before={stackBefore};edibility={food.Edibility};drink={isDrink.ToString().ToLowerInvariant()}");
        this.Remember(accepted);
        this.AddTrace(accepted);
        return accepted;
    }

    /// <summary>
    /// Experimental native feeding action, strictly limited to placing one owned Hay item into a live empty AnimalHouse Trough.
    /// This deliberately proves placement only: native AnimalHouse day update owns later animal fullness.
    /// </summary>
    public LocalExecutionReceipt RequestLocalFeedAnimal(string requestId, int slot, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;

        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (!Context.IsWorldReady || Game1.player?.currentLocation is not AnimalHouse location)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "animal_house_not_available", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", this.active?.ExecutionId ?? this.activeTravel?.ExecutionId ?? this.activePet?.ExecutionId ?? this.activeAnimalProduct?.ExecutionId ?? this.activeItemUse?.ExecutionId);
        if (!IsFeedTroughTargetInRange(Game1.player, targetX, targetY))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={targetX},{targetY}");
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.Items[slot] is not StardewValley.Object hay
            || !string.Equals(hay.QualifiedItemId, "(O)178", StringComparison.Ordinal) || hay.Stack < 1)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "hay_not_owned_in_slot", $"slot={slot}");

        Vector2 tile = new(targetX, targetY);
        if (location.doesTileHaveProperty(targetX, targetY, "Trough", "Back") is null || location.objects.ContainsKey(tile)
            || !string.Equals(BuildFeedTroughTargetId(location, slot, targetX, targetY, hay.Stack), expectedTargetId, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "feed_trough_target_changed", $"target={targetX},{targetY}");

        int hayBefore = CountQualifiedItem(Game1.player, "(O)178");
        int previousSlot = Game1.player.CurrentToolIndex;
        bool nativeHandled;
        try
        {
            Game1.player.CurrentToolIndex = slot;
            nativeHandled = location.checkAction(new xTile.Dimensions.Location(targetX, targetY), Game1.viewport, Game1.player);
        }
        finally
        {
            Game1.player.CurrentToolIndex = previousSlot;
        }
        int hayAfter = CountQualifiedItem(Game1.player, "(O)178");
        bool troughFilled = location.objects.TryGetValue(tile, out StardewValley.Object? placed)
            && string.Equals(placed.QualifiedItemId, "(O)178", StringComparison.Ordinal);
        bool hayConsumed = hayAfter == hayBefore - 1;
        bool succeeded = nativeHandled && troughFilled && hayConsumed;
        LocalExecutionReceipt receipt = new(executionId, requestId, succeeded ? ExecutionState.Succeeded : ExecutionState.Uncertain,
            succeeded ? "hay_placed_in_trough" : "feed_trough_postcondition_unavailable", this.revision,
            $"location={location.NameOrUniqueName};target={expectedTargetId};tile={targetX},{targetY};slot={slot};native_handled={nativeHandled.ToString().ToLowerInvariant()};trough_filled={troughFilled.ToString().ToLowerInvariant()};hay_before={hayBefore};hay_after={hayAfter};hay_consumed={hayConsumed.ToString().ToLowerInvariant()}");
        this.Remember(receipt);
        this.AddTrace(receipt);
        return receipt;
    }

    /// <summary>Experimental native animal-product collection. Only MilkPail/Shears can start their version-locked animation and completion lifecycle.</summary>
    public LocalExecutionReceipt RequestLocalCollectAnimalProduct(string requestId, int slot, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;

        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (!Context.IsWorldReady || Game1.player?.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", this.active?.ExecutionId ?? this.activeTravel?.ExecutionId ?? this.activePet?.ExecutionId ?? this.activeAnimalProduct?.ExecutionId ?? this.activeItemUse?.ExecutionId);
        if (slot < 0 || slot >= Game1.player.Items.Count || Game1.player.Items[slot] is not Tool tool || tool is not MilkPail and not Shears)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "animal_product_tool_not_owned", $"slot={slot}");
        if (!IsAnimalProductTargetInRange(Game1.player, targetX, targetY))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={targetX},{targetY}");

        StardewValley.GameLocation location = Game1.player.currentLocation;
        FarmAnimal? animal = location.animals.Values.FirstOrDefault(candidate => (int)candidate.Tile.X == targetX && (int)candidate.Tile.Y == targetY
            && string.Equals(BuildAnimalProductTargetId(location, slot, candidate, tool), expectedTargetId, StringComparison.Ordinal));
        if (animal is null || animal.currentProduce.Value is null || !animal.isAdult() || !animal.CanGetProduceWithTool(tool))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "animal_product_target_changed", $"target={targetX},{targetY}");
        int produceStack = animal.hasEatenAnimalCracker.Value ? 2 : 1;
        StardewValley.Object produce = ItemRegistry.Create<StardewValley.Object>("(O)" + animal.currentProduce.Value);
        if (!Game1.player.couldInventoryAcceptThisItem(produce.QualifiedItemId, produceStack))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "inventory_full", null);

        int inventoryBefore = CountQualifiedItem(Game1.player, produce.QualifiedItemId);
        int previousSlot = Game1.player.CurrentToolIndex;
        int previousFacingDirection = Game1.player.FacingDirection;
        string toolKind = tool is MilkPail ? "milk_pail" : "shears";
        LocalAnimalProductCollectionSpec specification = new(executionId, requestId, location.NameOrUniqueName, slot, targetX, targetY, expectedTargetId,
            animal.myID.Value, animal.type.Value, produce.QualifiedItemId, toolKind, produceStack, inventoryBefore, previousSlot, this.revision, requestedDeadlineMs);
        Game1.player.CurrentToolIndex = slot;
        // Follow the target-version input path, rather than calling Tool.beginUsing
        // directly: the Farmer-owned event schedules performBeginUsingTool, which
        // starts the tool animation and later invokes Farmer.useTool/Tool.DoFunction.
        // MilkPail/Shears select from GetToolLocation, so orient the Farmhand at the
        // already-revalidated exact animal before beginning that native lifecycle.
        Game1.player.FacingDirection = GetCardinalFacingDirectionToTile(Game1.player, targetX, targetY);
        Game1.player.lastClick = new Vector2(targetX * 64f + 32f, targetY * 64f + 32f);
        Game1.player.BeginUsingTool();
        FarmAnimal? boundAnimal = tool switch
        {
            Shears shears => shears.animal,
            MilkPail milkPail => milkPail.animal,
            _ => null,
        };
        Vector2 nativeToolLocation = Game1.player.GetToolLocation();
        if (!Game1.player.UsingTool || boundAnimal is null || boundAnimal.myID.Value != animal.myID.Value)
        {
            Game1.player.CurrentToolIndex = previousSlot;
            Game1.player.FacingDirection = previousFacingDirection;
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "animal_product_native_target_not_bound",
                $"tool={toolKind};expected_animal={animal.myID.Value};bound_animal={boundAnimal?.myID.Value.ToString() ?? "none"};tool_tile={(int)(nativeToolLocation.X / 64f)},{(int)(nativeToolLocation.Y / 64f)}");
        }
        this.activeAnimalProduct = specification;
        LocalExecutionReceipt accepted = new(executionId, requestId, ExecutionState.Accepted, "accepted", this.revision,
            $"location={specification.Location};target={expectedTargetId};animal={animal.myID.Value};bound_animal={boundAnimal.myID.Value};tool={toolKind};tool_tile={(int)(nativeToolLocation.X / 64f)},{(int)(nativeToolLocation.Y / 64f)};produce={produce.QualifiedItemId};produce_stack={produceStack}");
        this.Remember(accepted);
        this.AddTrace(accepted);
        return accepted;
    }

    /// <summary>Experimental native pet interaction. The native Pet.checkAction path owns daily petting and friendship mutation.</summary>
    public LocalExecutionReceipt RequestLocalPetAnimal(string requestId, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", this.active?.ExecutionId ?? this.activeTravel?.ExecutionId ?? this.activePet?.ExecutionId ?? this.activeAnimalProduct?.ExecutionId ?? this.activeItemUse?.ExecutionId);
        if (!Utility.tileWithinRadiusOfPlayer(targetX, targetY, 1, Game1.player))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={targetX},{targetY}");
        if (Game1.player.CurrentItem is not null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "hands_not_empty", null);

        StardewValley.GameLocation location = Game1.player.currentLocation;
        Pet? pet = location.characters.OfType<Pet>().FirstOrDefault(candidate =>
            (int)candidate.Tile.X == targetX && (int)candidate.Tile.Y == targetY
            && string.Equals(BuildPetTargetId(location, targetX, targetY, candidate), expectedTargetId, StringComparison.Ordinal)
            && (!candidate.lastPetDay.TryGetValue(Game1.player.UniqueMultiplayerID, out int lastDay) || lastDay != Game1.Date.TotalDays));
        if (pet is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "pet_target_changed", $"target={targetX},{targetY}");

        int friendshipBefore = pet.friendshipTowardFarmer.Value;
        LocalPettingSpec specification = new(executionId, requestId, location.NameOrUniqueName, targetX, targetY, expectedTargetId, pet.petId.Value.ToString("N"), friendshipBefore, Math.Min(1000, friendshipBefore + 12), Game1.Date.TotalDays, this.revision, requestedDeadlineMs);
        this.activePet = specification;
        bool handled = pet.checkAction(Game1.player, location);
        if (!handled)
        {
            this.activePet = null;
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "pet_action_not_handled", $"target={expectedTargetId}");
        }

        LocalExecutionReceipt accepted = new(executionId, requestId, ExecutionState.Accepted, "accepted", this.revision, $"target={expectedTargetId};pet_day={specification.PetDay};friendship_before={friendshipBefore};expected_friendship_after={specification.ExpectedFriendshipAfter}");
        this.Remember(accepted);
        this.AddTrace(accepted);
        return accepted;
    }

    /// <summary>Experimental read-only NPC relationship inspection. It never invokes NPC interaction or creates missing friendship records.</summary>
    public LocalExecutionReceipt RequestLocalInspectNpcRelationship(string requestId, int targetX, int targetY, string expectedTargetId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", this.active?.ExecutionId ?? this.activeTravel?.ExecutionId ?? this.activePet?.ExecutionId ?? this.activeAnimalProduct?.ExecutionId ?? this.activeItemUse?.ExecutionId);
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={targetX},{targetY}");

        StardewValley.GameLocation location = Game1.player.currentLocation;
        StardewValley.NPC? npc = location.characters
            .OfType<StardewValley.NPC>()
            .FirstOrDefault(candidate => candidate.IsVillager
                && (int)candidate.Tile.X == targetX
                && (int)candidate.Tile.Y == targetY
                && !string.IsNullOrWhiteSpace(candidate.Name)
                && string.Equals(BuildNpcRelationshipTargetId(location, targetX, targetY, candidate.Name), expectedTargetId, StringComparison.Ordinal));
        if (npc is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "npc_relationship_target_changed", $"target={targetX},{targetY}");
        if (!Game1.player.friendshipData.TryGetValue(npc.Name, out Friendship? friendship))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "friendship_fact_unavailable", $"npc={npc.Name}");

        LocalNpcRelationshipInspectionSpec specification = new(executionId, requestId, location.NameOrUniqueName, targetX, targetY, expectedTargetId, npc.Name, this.revision, requestedDeadlineMs);
        string evidence = $"location={specification.Location};target={expectedTargetId};tile={targetX},{targetY};npc={specification.NpcName};points={friendship.Points};status={friendship.Status};talked_to_today={friendship.TalkedToToday.ToString().ToLowerInvariant()};gifts_today={friendship.GiftsToday};gifts_this_week={friendship.GiftsThisWeek}";
        LocalExecutionReceipt receipt = new(executionId, requestId, ExecutionState.Succeeded, "npc_relationship_inspected", this.revision, evidence);
        this.Remember(receipt);
        this.AddTrace(receipt);
        return receipt;
    }

    public LocalExecutionReceipt RequestLocalTillSoil(string requestId, int targetX, int targetY, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", this.active?.ExecutionId ?? this.activeTravel?.ExecutionId ?? this.activePet?.ExecutionId ?? this.activeAnimalProduct?.ExecutionId ?? this.activeItemUse?.ExecutionId);
        if (!IsTileWithinChebyshevRadius(Game1.player, targetX, targetY, 1))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "target_out_of_range", $"target={targetX},{targetY}");

        Vector2 tile = new(targetX, targetY);
        StardewValley.GameLocation location = Game1.player.currentLocation;
        if (location.GetHoeDirtAtTile(tile) is not null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "soil_already_tilled", $"target={targetX},{targetY}");
        if (location.doesTileHaveProperty(targetX, targetY, "Diggable", "Back") is null || location.isWaterTile(targetX, targetY))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "soil_not_diggable", $"target={targetX},{targetY}");
        if (Game1.player.CurrentTool is not Hoe hoe)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "hoe_not_equipped", null);

        LocalSoilTillingSpec specification = new(executionId, requestId, location.NameOrUniqueName, targetX, targetY, this.revision, requestedDeadlineMs);
        string before = "none";
        hoe.DoFunction(location, targetX * 64 + 32, targetY * 64 + 32, 0, Game1.player);
        bool tilled = location.GetHoeDirtAtTile(tile) is not null;
        LocalExecutionReceipt receipt = new(executionId, requestId, tilled ? ExecutionState.Succeeded : ExecutionState.Uncertain, tilled ? "soil_tilled" : "soil_postcondition_unavailable", this.revision, $"location={specification.Location};target={targetX},{targetY};before={before};after={(tilled ? "HoeDirt" : "none")}");
        this.Remember(receipt);
        this.AddTrace(receipt);
        return receipt;
    }

    /// <summary>
    /// Development-only Phase 1 native-mechanic fixture. It changes only this
    /// Farmhand's selected Tool slot; it consumes no item, stamina, time, or
    /// world resource. The before/after tool state is the postcondition.
    /// </summary>
    public bool HasCapability(string action) => this.capabilities.Contains(action, StringComparer.Ordinal);

    public LocalExecutionReceipt RequestLocalEquipTool(string requestId, int slot)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        if (!Context.IsWorldReady || Game1.player is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", this.active?.ExecutionId ?? this.activeTravel?.ExecutionId ?? this.activeAnimalProduct?.ExecutionId ?? this.activeItemUse?.ExecutionId);
        if (slot < 0 || slot >= Game1.player.Items.Count)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_tool_slot", null);
        Tool? selectedTool = Game1.player.Items[slot] as Tool;
        if (selectedTool is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "tool_not_owned_in_slot", $"slot={slot}");

        string? expectedTool = DescribeTool(selectedTool);
        string? previousTool = DescribeTool(Game1.player.CurrentTool);
        Game1.player.CurrentToolIndex = slot;
        string? currentTool = DescribeTool(Game1.player.CurrentTool);
        if (!string.Equals(currentTool, expectedTool, StringComparison.Ordinal))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "tool_selection_postcondition_unavailable", $"before={previousTool ?? "none"};expected={expectedTool ?? "none"};actual={currentTool ?? "none"}");

        return this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "tool_selected", $"slot={slot};before={previousTool ?? "none"};expected={expectedTool};after={currentTool}");
    }

    public LocalExecutionReceipt Cancel(string requestId, string executionId, string reasonCode)
    {
        if ((this.active is not null && (this.active.RequestId != requestId || this.active.ExecutionId != executionId))
            || (this.activeTravel is not null && (this.activeTravel.RequestId != requestId || this.activeTravel.ExecutionId != executionId))
            || (this.activePet is not null && (this.activePet.RequestId != requestId || this.activePet.ExecutionId != executionId))
            || (this.activeAnimalProduct is not null && (this.activeAnimalProduct.RequestId != requestId || this.activeAnimalProduct.ExecutionId != executionId))
            || (this.activeItemUse is not null && (this.activeItemUse.RequestId != requestId || this.activeItemUse.ExecutionId != executionId))
            || (this.activeItemPickup is not null && (this.activeItemPickup.RequestId != requestId || this.activeItemPickup.ExecutionId != executionId)))
            return new(executionId, requestId, ExecutionState.Rejected, "execution_mismatch", this.revision, null);

        if (this.activeTravel is not null)
        {
            LocalTravelSpec travelSpec = this.activeTravel;
            this.activeTravel = null;
            this.revision++;
            LocalExecutionReceipt travelReceipt = new(travelSpec.ExecutionId, travelSpec.RequestId, ExecutionState.Cancelled, reasonCode, this.revision, $"source={travelSpec.SourceLocation}:{travelSpec.SourceX},{travelSpec.SourceY};target={travelSpec.TargetLocation}:{travelSpec.TargetX},{travelSpec.TargetY}");
            this.Remember(travelReceipt);
            this.AddTrace(travelReceipt);
            return travelReceipt;
        }

        if (this.activeAnimalProduct is not null)
        {
            LocalAnimalProductCollectionSpec animalProductSpec = this.activeAnimalProduct;
            if (animalProductSpec.DeferredTerminalState is not null
                && this.receiptsByRequestId.TryGetValue(animalProductSpec.RequestId, out LocalExecutionReceipt? deferredReceipt))
                return deferredReceipt;
            this.revision++;
            LocalExecutionReceipt animalProductReceipt = new(animalProductSpec.ExecutionId, animalProductSpec.RequestId, ExecutionState.Uncertain, "animal_product_cancelled_after_native_start", this.revision, $"target={animalProductSpec.TargetId};animal={animalProductSpec.AnimalId};native_animation_pending=true");
            this.Remember(animalProductReceipt);
            this.AddTrace(animalProductReceipt);
            this.activeAnimalProduct = animalProductSpec with { DeferredTerminalState = ExecutionState.Uncertain, DeferredTerminalReason = "animal_product_cancelled_after_native_start" };
            return animalProductReceipt;
        }

        if (this.activePet is not null)
        {
            LocalPettingSpec petSpec = this.activePet;
            this.activePet = null;
            this.revision++;
            LocalExecutionReceipt petReceipt = new(petSpec.ExecutionId, petSpec.RequestId, ExecutionState.Cancelled, reasonCode, this.revision, $"target={petSpec.TargetId};tile={petSpec.TargetX},{petSpec.TargetY}");
            this.Remember(petReceipt);
            this.AddTrace(petReceipt);
            return petReceipt;
        }

        if (this.activeItemPickup is not null)
        {
            LocalItemPickupSpec itemPickupSpec = this.activeItemPickup;
            if (this.active is not null || this.controller.HasActiveExecution)
            {
                // Preserve the pickup spec until the controller's synchronous
                // callback records the one authoritative cancellation receipt.
                this.controller.Cancel(reasonCode);
                return this.receiptsByRequestId.TryGetValue(itemPickupSpec.RequestId, out LocalExecutionReceipt? controllerReceipt)
                    ? controllerReceipt
                    : this.RememberTerminal(itemPickupSpec.RequestId, itemPickupSpec.ExecutionId, ExecutionState.Uncertain, "cancellation_receipt_missing", null);
            }

            this.activeItemPickup = null;
            this.revision++;
            LocalExecutionReceipt itemPickupReceipt = new(itemPickupSpec.ExecutionId, itemPickupSpec.RequestId, ExecutionState.Cancelled, reasonCode, this.revision,
                $"location={itemPickupSpec.Location};target={itemPickupSpec.TargetId};native_auto_collect_pending=true");
            this.Remember(itemPickupReceipt);
            this.AddTrace(itemPickupReceipt);
            return itemPickupReceipt;
        }

        if (this.activeItemUse is not null)
        {
            LocalItemUseSpec itemSpec = this.activeItemUse;
            if (itemSpec.DeferredTerminalState is not null
                && this.receiptsByRequestId.TryGetValue(itemSpec.RequestId, out LocalExecutionReceipt? deferredReceipt))
                return deferredReceipt;
            this.revision++;
            LocalExecutionReceipt itemReceipt = new(itemSpec.ExecutionId, itemSpec.RequestId, ExecutionState.Uncertain, "item_use_cancelled_after_native_start", this.revision, $"slot={itemSpec.Slot};item={itemSpec.QualifiedItemId};native_animation_pending=true");
            this.Remember(itemReceipt);
            this.AddTrace(itemReceipt);
            this.activeItemUse = itemSpec with { DeferredTerminalState = ExecutionState.Uncertain, DeferredTerminalReason = "item_use_cancelled_after_native_start" };
            return itemReceipt;
        }

        if (this.active is null)
        {
            if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? terminal) && terminal.ExecutionId == executionId)
                return terminal;
            return new(executionId, requestId, ExecutionState.Rejected, "no_matching_execution", this.revision, null);
        }

        LocalMoveSpec specification = this.active;
        this.controller.Cancel(reasonCode);
        return this.receiptsByRequestId.TryGetValue(specification.RequestId, out LocalExecutionReceipt? receipt)
            ? receipt
            : this.RememberTerminal(specification.RequestId, specification.ExecutionId, ExecutionState.Uncertain, "cancellation_receipt_missing", null);
    }

    public LocalExecutionReceipt CancelActiveForFixture(string reasonCode)
    {
        if (this.activeTravel is not null)
            return this.Cancel(this.activeTravel.RequestId, this.activeTravel.ExecutionId, reasonCode);
        if (this.activePet is not null)
            return this.Cancel(this.activePet.RequestId, this.activePet.ExecutionId, reasonCode);
        if (this.activeAnimalProduct is not null)
            return this.Cancel(this.activeAnimalProduct.RequestId, this.activeAnimalProduct.ExecutionId, reasonCode);
        if (this.activeItemUse is not null)
            return this.Cancel(this.activeItemUse.RequestId, this.activeItemUse.ExecutionId, reasonCode);
        if (this.activeItemPickup is not null)
            return this.Cancel(this.activeItemPickup.RequestId, this.activeItemPickup.ExecutionId, reasonCode);
        if (this.active is null)
            return new(string.Empty, string.Empty, ExecutionState.Cancelled, "no_active_execution", this.revision, null);
        return this.Cancel(this.active.RequestId, this.active.ExecutionId, reasonCode);
    }

    public void Update()
    {
        this.tick++;
        this.controller.Update(this.tick);
        if (this.activeTravel is not null && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() > this.activeTravel.DeadlineMs)
        {
            LocalTravelSpec specification = this.activeTravel;
            this.activeTravel = null;
            this.revision++;
            LocalExecutionReceipt receipt = new(specification.ExecutionId, specification.RequestId, ExecutionState.Expired, "travel_deadline_expired", this.revision, null);
            this.Remember(receipt);
            this.AddTrace(receipt);
        }
        if (this.activeItemPickup is not null)
        {
            LocalItemPickupSpec specification = this.activeItemPickup;
            long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            StardewValley.GameLocation? location = Game1.player.currentLocation;
            bool sameLocation = location is not null && string.Equals(location.NameOrUniqueName, specification.Location, StringComparison.Ordinal);
            // Do not terminally inspect a pickup while the approach is still
            // owned by the body controller. Debris may collect once adjacency
            // is reached, but the native route must first settle; then this
            // postcondition verifies the exact opaque chunk and inventory.
            bool approachSettled = this.active is null && !this.controller.HasActiveExecution;
            (Debris Debris, int DebrisIndex, int ChunkIndex, Chunk Chunk, string TargetId, string QualifiedItemId, int Stack)? target = sameLocation && location is not null
                ? FindItemTarget(location, Game1.player, specification.TargetId, specification.QualifiedItemId, radius: 8)
                : null;
            int inventoryAfter = CountQualifiedItem(Game1.player, specification.QualifiedItemId);
            bool inventoryGained = inventoryAfter >= specification.InventoryBefore + specification.Stack;
            bool targetGone = target is null;
            if (approachSettled && targetGone && inventoryGained)
            {
                this.activeItemPickup = null;
                this.revision++;
                LocalExecutionReceipt receipt = new(specification.ExecutionId, specification.RequestId, ExecutionState.Succeeded, "item_picked_up", this.revision,
                    $"location={specification.Location};target={specification.TargetId};tile={specification.TargetX},{specification.TargetY};item={specification.QualifiedItemId};stack={specification.Stack};native_auto_collect=true;chunk_removed=true;inventory_before={specification.InventoryBefore};inventory_after={inventoryAfter}");
                this.Remember(receipt);
                this.AddTrace(receipt);
            }
            else if ((!sameLocation || nowMs > specification.DeadlineMs) && approachSettled)
            {
                this.activeItemPickup = null;
                this.revision++;
                string reasonCode = !sameLocation ? "item_pickup_location_changed" : "item_pickup_postcondition_unavailable";
                LocalExecutionReceipt receipt = new(specification.ExecutionId, specification.RequestId, ExecutionState.Uncertain, reasonCode, this.revision,
                    $"location={specification.Location};target={specification.TargetId};tile={specification.TargetX},{specification.TargetY};item={specification.QualifiedItemId};target_gone={targetGone.ToString().ToLowerInvariant()};inventory_before={specification.InventoryBefore};inventory_after={inventoryAfter};inventory_gained={inventoryGained.ToString().ToLowerInvariant()}");
                this.Remember(receipt);
                this.AddTrace(receipt);
            }
        }
        if (this.activeItemUse is not null)
        {
            LocalItemUseSpec specification = this.activeItemUse;
            long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            StardewValley.Object? remaining = specification.Slot < Game1.player.Items.Count ? Game1.player.Items[specification.Slot] as StardewValley.Object : null;
            bool consumed = remaining is null || (string.Equals(remaining.QualifiedItemId, specification.QualifiedItemId, StringComparison.Ordinal) && remaining.Stack == specification.StackBefore - 1);
            bool animationComplete = !Game1.player.isEating;
            if (specification.DeferredTerminalState is not null)
            {
                if (animationComplete)
                    this.activeItemUse = null;
            }
            else if (animationComplete && consumed)
            {
                this.activeItemUse = null;
                this.revision++;
                LocalExecutionReceipt receipt = new(specification.ExecutionId, specification.RequestId, ExecutionState.Succeeded, "item_used", this.revision,
                    $"slot={specification.Slot};item={specification.QualifiedItemId};stack_before={specification.StackBefore};stack_after={remaining?.Stack ?? 0};edibility={specification.Edibility};drink={specification.IsDrink.ToString().ToLowerInvariant()};stamina_before={specification.StaminaBefore:0.##};stamina_after={Game1.player.Stamina:0.##};health_before={specification.HealthBefore};health_after={Game1.player.health};animation_complete=true");
                this.Remember(receipt);
                this.AddTrace(receipt);
            }
            else if (nowMs > specification.DeadlineMs)
            {
                this.revision++;
                LocalExecutionReceipt receipt = new(specification.ExecutionId, specification.RequestId, ExecutionState.Uncertain, "item_use_postcondition_unavailable", this.revision,
                    $"slot={specification.Slot};item={specification.QualifiedItemId};consumed={consumed.ToString().ToLowerInvariant()};animation_complete={animationComplete.ToString().ToLowerInvariant()}");
                this.Remember(receipt);
                this.AddTrace(receipt);
                if (animationComplete)
                    this.activeItemUse = null;
                else
                    this.activeItemUse = specification with { DeferredTerminalState = ExecutionState.Uncertain, DeferredTerminalReason = "item_use_postcondition_unavailable" };
            }
        }
        if (this.activeAnimalProduct is not null)
        {
            LocalAnimalProductCollectionSpec specification = this.activeAnimalProduct;
            FarmAnimal? animal = Game1.player.currentLocation?.animals.TryGetValue(specification.AnimalId, out FarmAnimal? candidate) == true ? candidate : null;
            bool animationComplete = !Game1.player.UsingTool;
            bool produceCleared = animal is not null && animal.currentProduce.Value is null;
            int inventoryAfter = CountQualifiedItem(Game1.player, specification.QualifiedProduceItemId);
            bool inventoryGained = inventoryAfter >= specification.InventoryBefore + specification.ProduceStack;
            long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (specification.DeferredTerminalState is not null)
            {
                if (animationComplete)
                {
                    Game1.player.CurrentToolIndex = specification.PreviousSlot;
                    this.activeAnimalProduct = null;
                }
            }
            else if (animationComplete && produceCleared && inventoryGained)
            {
                Game1.player.CurrentToolIndex = specification.PreviousSlot;
                this.activeAnimalProduct = null;
                this.revision++;
                LocalExecutionReceipt receipt = new(specification.ExecutionId, specification.RequestId, ExecutionState.Succeeded, "animal_product_collected", this.revision,
                    $"location={specification.Location};target={specification.TargetId};animal={specification.AnimalId};tool={specification.ToolKind};produce={specification.QualifiedProduceItemId};produce_stack={specification.ProduceStack};produce_cleared=true;inventory_before={specification.InventoryBefore};inventory_after={inventoryAfter};inventory_gained=true;animation_complete=true");
                this.Remember(receipt);
                this.AddTrace(receipt);
            }
            else if (nowMs > specification.DeadlineMs)
            {
                this.revision++;
                LocalExecutionReceipt receipt = new(specification.ExecutionId, specification.RequestId, ExecutionState.Uncertain, "animal_product_postcondition_unavailable", this.revision,
                    $"location={specification.Location};target={specification.TargetId};animal={specification.AnimalId};tool={specification.ToolKind};produce_cleared={produceCleared.ToString().ToLowerInvariant()};inventory_before={specification.InventoryBefore};inventory_after={inventoryAfter};inventory_gained={inventoryGained.ToString().ToLowerInvariant()};animation_complete={animationComplete.ToString().ToLowerInvariant()}");
                this.Remember(receipt);
                this.AddTrace(receipt);
                if (animationComplete)
                {
                    Game1.player.CurrentToolIndex = specification.PreviousSlot;
                    this.activeAnimalProduct = null;
                }
                else
                    this.activeAnimalProduct = specification with { DeferredTerminalState = ExecutionState.Uncertain, DeferredTerminalReason = "animal_product_postcondition_unavailable" };
            }
        }
        if (this.activePet is not null)
        {
            LocalPettingSpec specification = this.activePet;
            Pet? pet = Game1.player.currentLocation?.characters.OfType<Pet>().FirstOrDefault(candidate => candidate.petId.Value.ToString("N") == specification.PetIdentity);
            bool dayRecorded = pet is not null && pet.lastPetDay.TryGetValue(Game1.player.UniqueMultiplayerID, out int lastDay) && lastDay == specification.PetDay;
            bool friendshipApplied = pet is not null && pet.friendshipTowardFarmer.Value >= specification.ExpectedFriendshipAfter && pet.grantedFriendshipForPet.Value;
            long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (dayRecorded && friendshipApplied)
            {
                this.activePet = null;
                this.revision++;
                LocalExecutionReceipt receipt = new(specification.ExecutionId, specification.RequestId, ExecutionState.Succeeded, "pet_completed", this.revision,
                    $"location={specification.Location};target={specification.TargetId};tile={specification.TargetX},{specification.TargetY};pet_day={specification.PetDay};friendship_before={specification.FriendshipBefore};friendship_after={pet!.friendshipTowardFarmer.Value};day_recorded=true;friendship_callback=true");
                this.Remember(receipt);
                this.AddTrace(receipt);
            }
            else if (nowMs > specification.DeadlineMs)
            {
                this.activePet = null;
                this.revision++;
                LocalExecutionReceipt receipt = new(specification.ExecutionId, specification.RequestId, ExecutionState.Uncertain, "pet_postcondition_unavailable", this.revision,
                    $"location={specification.Location};target={specification.TargetId};day_recorded={dayRecorded.ToString().ToLowerInvariant()};friendship_applied={friendshipApplied.ToString().ToLowerInvariant()}");
                this.Remember(receipt);
                this.AddTrace(receipt);
            }
        }
    }

    public void InvalidateForLifecycle(string reasonCode)
    {
        if (this.active is not null)
            this.controller.Invalidate(reasonCode);
        if (this.activeTravel is not null)
        {
            LocalTravelSpec specification = this.activeTravel;
            this.activeTravel = null;
            this.revision++;
            LocalExecutionReceipt receipt = new(specification.ExecutionId, specification.RequestId, ExecutionState.Invalidated, reasonCode, this.revision, null);
            this.Remember(receipt);
            this.AddTrace(receipt);
        }
        if (this.activeAnimalProduct is not null)
        {
            LocalAnimalProductCollectionSpec specification = this.activeAnimalProduct;
            if (specification.DeferredTerminalState is null)
            {
                this.revision++;
                LocalExecutionReceipt receipt = new(specification.ExecutionId, specification.RequestId, ExecutionState.Invalidated, reasonCode, this.revision, "native_animation_pending=true");
                this.Remember(receipt);
                this.AddTrace(receipt);
                this.activeAnimalProduct = specification with { DeferredTerminalState = ExecutionState.Invalidated, DeferredTerminalReason = reasonCode };
            }
        }
        if (this.activePet is not null)
        {
            LocalPettingSpec specification = this.activePet;
            this.activePet = null;
            this.revision++;
            LocalExecutionReceipt receipt = new(specification.ExecutionId, specification.RequestId, ExecutionState.Invalidated, reasonCode, this.revision, null);
            this.Remember(receipt);
            this.AddTrace(receipt);
        }
        if (this.activeItemPickup is not null)
        {
            LocalItemPickupSpec specification = this.activeItemPickup;
            this.activeItemPickup = null;
            this.revision++;
            LocalExecutionReceipt receipt = new(specification.ExecutionId, specification.RequestId, ExecutionState.Invalidated, reasonCode, this.revision, "native_auto_collect_pending=true");
            this.Remember(receipt);
            this.AddTrace(receipt);
        }
        if (this.activeItemUse is not null)
        {
            LocalItemUseSpec specification = this.activeItemUse;
            if (specification.DeferredTerminalState is null)
            {
                this.revision++;
                LocalExecutionReceipt receipt = new(specification.ExecutionId, specification.RequestId, ExecutionState.Invalidated, reasonCode, this.revision, "native_animation_pending=true");
                this.Remember(receipt);
                this.AddTrace(receipt);
                this.activeItemUse = specification with { DeferredTerminalState = ExecutionState.Invalidated, DeferredTerminalReason = reasonCode };
            }
        }
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
            current_tool = DescribeTool(player.CurrentTool),
            inventory_slots = player.Items.Count,
            can_move = player.CanMove,
            menu_open = Game1.activeClickableMenu is not null,
            event_active = Game1.eventUp,
            capabilities = this.capabilities,
            active_execution = (object?)(this.active is not null
                ? new
                {
                    execution_id = this.active.ExecutionId,
                    request_id = this.active.RequestId,
                    action = "move_to_tile",
                    target_tile = new { x = this.active.TargetTile.X, y = this.active.TargetTile.Y },
                }
                : this.activeTravel is not null
                    ? new
                    {
                        execution_id = this.activeTravel.ExecutionId,
                        request_id = this.activeTravel.RequestId,
                        action = this.activeTravel.Action,
                        source = new { location = this.activeTravel.SourceLocation, x = this.activeTravel.SourceX, y = this.activeTravel.SourceY },
                        target = new { location = this.activeTravel.TargetLocation, x = this.activeTravel.TargetX, y = this.activeTravel.TargetY },
                    }
                    : this.activePet is not null
                        ? new { execution_id = this.activePet.ExecutionId, request_id = this.activePet.RequestId, action = "pet_animal", target = this.activePet.TargetId }
                        : this.activeAnimalProduct is not null
                            ? new { execution_id = this.activeAnimalProduct.ExecutionId, request_id = this.activeAnimalProduct.RequestId, action = "collect_animal_product", target = this.activeAnimalProduct.TargetId, slot = this.activeAnimalProduct.Slot }
                        : this.activeItemUse is not null
                            ? new { execution_id = this.activeItemUse.ExecutionId, request_id = this.activeItemUse.RequestId, action = "use_item", slot = this.activeItemUse.Slot, item = this.activeItemUse.QualifiedItemId }
                            : this.activeItemPickup is not null
                                ? new { execution_id = this.activeItemPickup.ExecutionId, request_id = this.activeItemPickup.RequestId, action = "pickup_item", target = this.activeItemPickup.TargetId, tile = new { x = this.activeItemPickup.TargetX, y = this.activeItemPickup.TargetY } }
                                : null),
        };
    }

    /// <summary>Explicit Phase 2 wire DTO; call only on the SMAPI game thread while a world is ready.</summary>
    public BridgeSnapshot CreateBridgeSnapshot(IReadOnlyList<string>? capabilities = null)
    {
        Farmer player = Game1.player;
        IReadOnlyList<string> advertisedCapabilities = capabilities ?? this.capabilities;
        LocalExecutionReceipt? activeReceipt = null;
        if (this.active is not null)
            this.receiptsByRequestId.TryGetValue(this.active.RequestId, out activeReceipt);
        else if (this.activeTravel is not null)
            this.receiptsByRequestId.TryGetValue(this.activeTravel.RequestId, out activeReceipt);
        else if (this.activePet is not null)
            this.receiptsByRequestId.TryGetValue(this.activePet.RequestId, out activeReceipt);
        else if (this.activeAnimalProduct is not null)
            this.receiptsByRequestId.TryGetValue(this.activeAnimalProduct.RequestId, out activeReceipt);
        else if (this.activeItemUse is not null)
            this.receiptsByRequestId.TryGetValue(this.activeItemUse.RequestId, out activeReceipt);
        else if (this.activeItemPickup is not null)
            this.receiptsByRequestId.TryGetValue(this.activeItemPickup.RequestId, out activeReceipt);
        BridgeActiveExecution? activeExecution = this.active is not null
            ? new(
                this.active.ExecutionId,
                this.active.RequestId,
                "move_to_tile",
                (activeReceipt?.State ?? ExecutionState.Accepted).ToWireValue(),
                activeReceipt?.ReasonCode ?? "accepted",
                new Dictionary<string, string> { ["target_tile"] = FormatTile(this.active.TargetTile), ["deadline_ms"] = this.active.DeadlineMs.ToString(System.Globalization.CultureInfo.InvariantCulture) })
            : this.activeTravel is not null
                ? new(
                    this.activeTravel.ExecutionId,
                    this.activeTravel.RequestId,
                    this.activeTravel.Action,
                    (activeReceipt?.State ?? ExecutionState.Accepted).ToWireValue(),
                    activeReceipt?.ReasonCode ?? "accepted",
                    new Dictionary<string, string> { ["source"] = $"{this.activeTravel.SourceLocation}:{this.activeTravel.SourceX},{this.activeTravel.SourceY}", ["target"] = $"{this.activeTravel.TargetLocation}:{this.activeTravel.TargetX},{this.activeTravel.TargetY}" })
                : this.activePet is not null
                    ? new(
                        this.activePet.ExecutionId,
                        this.activePet.RequestId,
                        "pet_animal",
                        (activeReceipt?.State ?? ExecutionState.Accepted).ToWireValue(),
                        activeReceipt?.ReasonCode ?? "accepted",
                        new Dictionary<string, string> { ["target"] = this.activePet.TargetId, ["tile"] = $"{this.activePet.TargetX},{this.activePet.TargetY}" })
                    : this.activeAnimalProduct is not null
                        ? new(
                            this.activeAnimalProduct.ExecutionId,
                            this.activeAnimalProduct.RequestId,
                            "collect_animal_product",
                            (activeReceipt?.State ?? ExecutionState.Accepted).ToWireValue(),
                            activeReceipt?.ReasonCode ?? "accepted",
                            new Dictionary<string, string> { ["target"] = this.activeAnimalProduct.TargetId, ["slot"] = this.activeAnimalProduct.Slot.ToString(), ["animal"] = this.activeAnimalProduct.AnimalId.ToString() })
                    : this.activeItemUse is not null
                        ? new(
                            this.activeItemUse.ExecutionId,
                            this.activeItemUse.RequestId,
                            "use_item",
                            (activeReceipt?.State ?? ExecutionState.Accepted).ToWireValue(),
                            activeReceipt?.ReasonCode ?? "accepted",
                            new Dictionary<string, string> { ["slot"] = this.activeItemUse.Slot.ToString(), ["item"] = this.activeItemUse.QualifiedItemId })
                        : this.activeItemPickup is not null
                            ? new(
                                this.activeItemPickup.ExecutionId,
                                this.activeItemPickup.RequestId,
                                "pickup_item",
                                (activeReceipt?.State ?? ExecutionState.Accepted).ToWireValue(),
                                activeReceipt?.ReasonCode ?? "accepted",
                                new Dictionary<string, string> { ["target"] = this.activeItemPickup.TargetId, ["tile"] = $"{this.activeItemPickup.TargetX},{this.activeItemPickup.TargetY}" })
                            : null;
        return new BridgeSnapshot(
            this.revision,
            player.currentLocation?.NameOrUniqueName ?? "unknown",
            new BridgeTile(player.Tile.X, player.Tile.Y),
            player.Stamina,
            player.health,
            DescribeTool(player.CurrentTool),
            player.Items.Count,
            player.CanMove && Game1.activeClickableMenu is null && !Game1.eventUp,
            advertisedCapabilities,
            activeExecution,
            player.currentLocation?.warps
                .Where(warp => !warp.npcOnly.Value
                    && !string.IsNullOrWhiteSpace(warp.TargetName)
                    && warp.X >= 0 && warp.Y >= 0 && warp.X <= 1000 && warp.Y <= 1000
                    && warp.TargetX >= 0 && warp.TargetY >= 0 && warp.TargetX <= 1000 && warp.TargetY <= 1000)
                .Select(warp => new BridgeWarp(warp.X, warp.Y, warp.TargetName, warp.TargetX, warp.TargetY))
                .ToArray(),
            advertisedCapabilities.Contains("enter_exit", StringComparer.Ordinal) ? DiscoverDoorTargets(player) : null,
            advertisedCapabilities.Contains("till_soil", StringComparer.Ordinal) ? DiscoverSoilTiles(player) : null,
            DiscoverToolSlots(player),
            advertisedCapabilities.Contains("pickup_forage", StringComparer.Ordinal) ? DiscoverForageTargets(player) : null,
            advertisedCapabilities.Contains("pickup_item", StringComparer.Ordinal) ? DiscoverItemTargets(player) : null,
            advertisedCapabilities.Contains("water_crop", StringComparer.Ordinal) ? DiscoverCropTargets(player) : null,
            advertisedCapabilities.Contains("harvest_crop", StringComparer.Ordinal) ? DiscoverHarvestTargets(player) : null,
            advertisedCapabilities.Contains("plant_seed", StringComparer.Ordinal) ? DiscoverSeedTargets(player) : null,
            advertisedCapabilities.Contains("fertilize_tile", StringComparer.Ordinal) ? DiscoverFertilizerTargets(player) : null,
            advertisedCapabilities.Contains("clear_debris", StringComparer.Ordinal) ? DiscoverDebrisTargets(player) : null,
            advertisedCapabilities.Contains("machine_inspect", StringComparer.Ordinal) ? DiscoverMachineTargets(player) : null,
            advertisedCapabilities.Contains("collect_resource", StringComparer.Ordinal) ? DiscoverResourceTargets(player) : null,
            advertisedCapabilities.Contains("npc_relationship", StringComparer.Ordinal) ? DiscoverNpcRelationshipTargets(player) : null,
            advertisedCapabilities.Contains("pet_animal", StringComparer.Ordinal) ? DiscoverPetTargets(player) : null,
            advertisedCapabilities.Contains("collect_animal_product", StringComparer.Ordinal) ? DiscoverAnimalProductTargets(player) : null,
            advertisedCapabilities.Contains("feed_animal", StringComparer.Ordinal) ? DiscoverFeedTroughTargets(player) : null,
            advertisedCapabilities.Contains("use_item", StringComparer.Ordinal) ? DiscoverFoodTargets(player) : null);
    }

    private static StardewValley.Warp? ResolveDoorWarp(StardewValley.GameLocation location, Microsoft.Xna.Framework.Point point)
    {
        StardewValley.Warp? warp = location.getWarpFromDoor(point, Game1.player);
        if (warp is not null)
            return warp;

        if (location is StardewValley.Locations.FarmHouse or StardewValley.Locations.Cabin)
        {
            return location.warps.FirstOrDefault(candidate => !candidate.npcOnly.Value
                && candidate.X == point.X && candidate.Y == point.Y
                && string.Equals(candidate.TargetName, "Farm", StringComparison.Ordinal));
        }

        return null;
    }

    private static IReadOnlyList<BridgeDoor> DiscoverDoorTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeDoor>();
        Dictionary<(int X, int Y), BridgeDoor> result = new();
        foreach ((Microsoft.Xna.Framework.Point point, string target) in location.doors.Pairs)
        {
            StardewValley.Warp? warp = location.getWarpFromDoor(point, player);
            if (warp is null || string.IsNullOrWhiteSpace(warp.TargetName)
                || point.X < 0 || point.Y < 0 || point.X > 1000 || point.Y > 1000
                || warp.TargetX < 0 || warp.TargetY < 0 || warp.TargetX > 1000 || warp.TargetY > 1000)
                continue;
            result[(point.X, point.Y)] = new BridgeDoor(point.X, point.Y, warp.TargetName, warp.TargetX, warp.TargetY);
        }
        foreach (StardewValley.Buildings.Building building in location.buildings)
        {
            if (!building.HasIndoors()) continue;
            Microsoft.Xna.Framework.Point point = building.getPointForHumanDoor();
            StardewValley.Warp? warp = ResolveDoorWarp(location, point);
            if (warp is null || string.IsNullOrWhiteSpace(warp.TargetName)
                || point.X < 0 || point.Y < 0 || point.X > 1000 || point.Y > 1000
                || warp.TargetX < 0 || warp.TargetY < 0 || warp.TargetX > 1000 || warp.TargetY > 1000)
                continue;
            result[(point.X, point.Y)] = new BridgeDoor(point.X, point.Y, warp.TargetName, warp.TargetX, warp.TargetY);
        }

        if (location is StardewValley.Locations.FarmHouse or StardewValley.Locations.Cabin)
        {
            foreach (StardewValley.Warp warp in location.warps.Where(candidate => !candidate.npcOnly.Value
                && string.Equals(candidate.TargetName, "Farm", StringComparison.Ordinal)))
            {
                if (warp.X < 0 || warp.Y < 0 || warp.X > 1000 || warp.Y > 1000
                    || warp.TargetX < 0 || warp.TargetY < 0 || warp.TargetX > 1000 || warp.TargetY > 1000)
                    continue;
                result[(warp.X, warp.Y)] = new BridgeDoor(warp.X, warp.Y, warp.TargetName, warp.TargetX, warp.TargetY);
            }
        }

        return result.Values.Take(64).ToArray();
    }

    private static IReadOnlyList<BridgeResourceTarget> DiscoverResourceTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeResourceTarget>();
        List<BridgeResourceTarget> result = new();
        foreach ((Vector2 tile, StardewValley.TerrainFeatures.TerrainFeature feature) in location.terrainFeatures.Pairs)
        {
            if (result.Count >= 64 || feature is not StardewValley.TerrainFeatures.Tree tree || !tree.stump.Value
                || !Utility.tileWithinRadiusOfPlayer((int)tile.X, (int)tile.Y, 1, player))
                continue;
            int usableSlot = -1;
            for (int slot = 0; slot < player.Items.Count; slot++)
            {
                if (player.Items[slot] is StardewValley.Tools.Axe)
                {
                    usableSlot = slot;
                    break;
                }
            }
            if (usableSlot < 0) continue;
            result.Add(new BridgeResourceTarget(
                BuildResourceTargetId(location, (int)tile.X, (int)tile.Y, tree),
                usableSlot,
                (int)tile.X,
                (int)tile.Y,
                tree.treeType.Value,
                tree.growthStage.Value,
                tree.stump.Value,
                tree.health.Value,
                "axe",
                0));
        }
        return result;
    }

    private static IReadOnlyList<BridgeNpcRelationshipTarget> DiscoverNpcRelationshipTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeNpcRelationshipTarget>();
        return location.characters
            .OfType<StardewValley.NPC>()
            .Where(npc => npc.IsVillager
                && !string.IsNullOrWhiteSpace(npc.Name)
                && IsTileWithinChebyshevRadius(player, (int)npc.Tile.X, (int)npc.Tile.Y, 1)
                && player.friendshipData.ContainsKey(npc.Name))
            .Take(64)
            .Select(npc =>
            {
                Friendship friendship = player.friendshipData[npc.Name];
                return new BridgeNpcRelationshipTarget(
                    BuildNpcRelationshipTargetId(location, (int)npc.Tile.X, (int)npc.Tile.Y, npc.Name),
                    (int)npc.Tile.X,
                    (int)npc.Tile.Y,
                    npc.Name,
                    friendship.Points,
                    friendship.Status.ToString(),
                    friendship.TalkedToToday,
                    friendship.GiftsToday,
                    friendship.GiftsThisWeek);
            })
            .ToArray();
    }

    private static string BuildNpcRelationshipTargetId(StardewValley.GameLocation location, int x, int y, string npcName)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:npc:{npcName}";
        return $"npc_relationship_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static string BuildPetTargetId(StardewValley.GameLocation location, int x, int y, Pet pet)
    {
        string raw = $"{location.NameOrUniqueName}:pet:{pet.petId.Value:N}";
        return $"pet_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static IReadOnlyList<BridgePetTarget> DiscoverPetTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgePetTarget>();
        return location.characters.OfType<Pet>()
            .Where(pet => Utility.tileWithinRadiusOfPlayer((int)pet.Tile.X, (int)pet.Tile.Y, 1, player))
            .Take(16)
            .Select(pet => new BridgePetTarget(
                BuildPetTargetId(location, (int)pet.Tile.X, (int)pet.Tile.Y, pet),
                (int)pet.Tile.X,
                (int)pet.Tile.Y,
                pet.petType.Value,
                pet.friendshipTowardFarmer.Value,
                pet.lastPetDay.TryGetValue(player.UniqueMultiplayerID, out int lastDay) && lastDay == Game1.Date.TotalDays))
            .Where(target => !target.PettedToday)
            .ToArray();
    }

    private static IReadOnlyList<BridgeMachineTarget> DiscoverMachineTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeMachineTarget>();
        return location.objects.Pairs
            .Where(pair => pair.Value.GetMachineData() is not null
                && IsMachineTargetInRange(player, (int)pair.Key.X, (int)pair.Key.Y))
            .Take(64)
            .Select(pair =>
            {
                StardewValley.Object machine = pair.Value;
                string? held = machine.heldObject.Value?.QualifiedItemId;
                string? input = machine.lastInputItem.Value?.QualifiedItemId;
                return new BridgeMachineTarget(
                    BuildMachineTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, machine.QualifiedItemId),
                    (int)pair.Key.X,
                    (int)pair.Key.Y,
                    machine.QualifiedItemId,
                    machine.readyForHarvest.Value,
                    machine.MinutesUntilReady,
                    held,
                    input);
            })
            .ToArray();
    }

    private static string BuildMachineTargetId(StardewValley.GameLocation location, int x, int y, string qualifiedItemId)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:{qualifiedItemId}";
        return $"machine_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static IReadOnlyList<BridgeDebrisTarget> DiscoverDebrisTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeDebrisTarget>();
        List<BridgeDebrisTarget> result = new();
        for (int index = 0; index < location.resourceClumps.Count && result.Count < 64; index++)
        {
            StardewValley.TerrainFeatures.ResourceClump clump = location.resourceClumps[index];
            int x = (int)clump.Tile.X;
            int y = (int)clump.Tile.Y;
            if (!Utility.tileWithinRadiusOfPlayer(x, y, 1, player)) continue;
            string toolKind = clump.parentSheetIndex.Value switch
            {
                600 or 602 => "axe",
                148 or 622 or 672 or 752 or 754 or 756 or 758 => "pickaxe",
                _ => "unsupported",
            };
            int requiredUpgrade = clump.parentSheetIndex.Value switch
            {
                600 => 1,
                602 => 2,
                148 or 622 => 3,
                672 => 2,
                _ => 0,
            };
            if (toolKind == "unsupported") continue;
            int usableSlot = -1;
            for (int slot = 0; slot < player.Items.Count; slot++)
            {
                if (player.Items[slot] is Tool candidate && IsValidDebrisTool(clump, candidate, out _, out _))
                {
                    usableSlot = slot;
                    break;
                }
            }
            if (usableSlot < 0) continue;
            result.Add(new BridgeDebrisTarget(BuildDebrisTargetId(location, index, clump), usableSlot, x, y, clump.parentSheetIndex.Value, toolKind, requiredUpgrade));
        }
        return result;
    }

    private static IReadOnlyList<BridgeToolSlot> DiscoverToolSlots(Farmer player)
    {
        return player.Items
            .Select((item, slot) => (item, slot))
            .Where(entry => entry.item is Tool)
            .Select(entry => new BridgeToolSlot(entry.slot, DescribeTool(entry.item as Tool) ?? "tool"))
            .ToArray();
    }

    private static string BuildFeedTroughTargetId(AnimalHouse location, int slot, int x, int y, int hayStack)
    {
        string raw = $"{location.NameOrUniqueName}:trough:{x},{y}:slot:{slot}:hay_stack:{hayStack}";
        return $"feed_trough_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private IReadOnlyList<BridgeFeedTroughTarget> DiscoverFeedTroughTargets(Farmer player)
    {
        if (player.currentLocation is not AnimalHouse location) return Array.Empty<BridgeFeedTroughTarget>();
        List<BridgeFeedTroughTarget> result = new();
        foreach ((StardewValley.Item? item, int slot) in player.Items.Select((item, slot) => (item, slot)))
        {
            if (item is not StardewValley.Object hay || !string.Equals(hay.QualifiedItemId, "(O)178", StringComparison.Ordinal) || hay.Stack < 1)
                continue;
            for (int x = Math.Max(0, player.TilePoint.X - 1); x <= player.TilePoint.X + 1 && result.Count < 32; x++)
            {
                for (int y = Math.Max(0, player.TilePoint.Y - 1); y <= player.TilePoint.Y + 1 && result.Count < 32; y++)
                {
                    Vector2 tile = new(x, y);
                    if (!IsFeedTroughTargetInRange(player, x, y) || location.doesTileHaveProperty(x, y, "Trough", "Back") is null || location.objects.ContainsKey(tile))
                        continue;
                    result.Add(new BridgeFeedTroughTarget(BuildFeedTroughTargetId(location, slot, x, y, hay.Stack), slot, x, y, hay.Stack));
                }
            }
        }
        return result;
    }

    private static string BuildAnimalProductTargetId(StardewValley.GameLocation location, int slot, FarmAnimal animal, Tool tool)
    {
        string raw = $"{location.NameOrUniqueName}:animal:{animal.myID.Value}:slot:{slot}:tool:{tool.QualifiedItemId}:produce:{animal.currentProduce.Value}";
        return $"animal_product_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private IReadOnlyList<BridgeAnimalProductTarget> DiscoverAnimalProductTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeAnimalProductTarget>();
        List<BridgeAnimalProductTarget> result = new();
        foreach ((StardewValley.Item? item, int slot) in player.Items.Select((item, slot) => (item, slot)))
        {
            if (item is not Tool tool || tool is not MilkPail and not Shears) continue;
            foreach (FarmAnimal animal in location.animals.Values)
            {
                if (result.Count >= 32) return result;
                int x = (int)animal.Tile.X;
                int y = (int)animal.Tile.Y;
                if (!IsAnimalProductTargetInRange(player, x, y) || animal.currentProduce.Value is null || !animal.isAdult() || !animal.CanGetProduceWithTool(tool)) continue;
                StardewValley.Object produce = ItemRegistry.Create<StardewValley.Object>("(O)" + animal.currentProduce.Value);
                int produceStack = animal.hasEatenAnimalCracker.Value ? 2 : 1;
                if (!player.couldInventoryAcceptThisItem(produce.QualifiedItemId, produceStack)) continue;
                result.Add(new BridgeAnimalProductTarget(BuildAnimalProductTargetId(location, slot, animal, tool), slot, x, y, animal.type.Value, produce.QualifiedItemId, tool is MilkPail ? "milk_pail" : "shears", produceStack));
            }
        }
        // Fixture-only diagnostic: a native AnimalHouse may synchronize its
        // occupant positions/produce after Farmhand arrival. Record the exact
        // live predicate facts if discovery still fail-closes; never mutate
        // inventory, animals, or action state here.
        if (result.Count == 0 && location.NameOrUniqueName.StartsWith("Barn", StringComparison.Ordinal))
        {
            string candidates = string.Join(",", location.animals.Values
                .Where(animal => animal.isAdult() && animal.currentProduce.Value is not null)
                .Select(animal =>
                {
                    int x = (int)animal.Tile.X;
                    int y = (int)animal.Tile.Y;
                    StardewValley.Object produce = ItemRegistry.Create<StardewValley.Object>("(O)" + animal.currentProduce.Value);
                    return $"{animal.type.Value}@{x},{y}:produce={produce.QualifiedItemId}:in_range={IsAnimalProductTargetInRange(player, x, y)}:shears={animal.CanGetProduceWithTool(new Shears())}:milk={animal.CanGetProduceWithTool(new MilkPail())}:inventory={player.couldInventoryAcceptThisItem(produce.QualifiedItemId, animal.hasEatenAnimalCracker.Value ? 2 : 1)}";
                }));
            this.monitor.Log($"GameBuddy animal-product discovery fail-closed: location={location.NameOrUniqueName}; player={(int)player.Tile.X},{(int)player.Tile.Y}; candidates={candidates}", LogLevel.Trace);
        }
        return result;
    }

    private static bool IsAnimalProductTargetInRange(Farmer player, int targetX, int targetY)
    {
        return IsTileWithinChebyshevRadius(player, targetX, targetY, AnimalProductDiscoveryRadius);
    }

    private static bool IsCropTargetInRange(Farmer player, int targetX, int targetY)
    {
        return IsTileWithinChebyshevRadius(player, targetX, targetY, 1);
    }

    private static bool IsMachineTargetInRange(Farmer player, int targetX, int targetY)
    {
        return IsTileWithinChebyshevRadius(player, targetX, targetY, 1);
    }

    private static bool IsTileWithinChebyshevRadius(Farmer player, int targetX, int targetY, int radius)
    {
        return Math.Abs(targetX - (int)player.Tile.X) <= radius
            && Math.Abs(targetY - (int)player.Tile.Y) <= radius;
    }

    private static bool IsFeedTroughTargetInRange(Farmer player, int targetX, int targetY)
    {
        return Math.Abs(targetX - (int)player.Tile.X) <= 1
            && Math.Abs(targetY - (int)player.Tile.Y) <= 1;
    }

    private static int GetCardinalFacingDirectionToTile(Farmer player, int targetX, int targetY)
    {
        int deltaX = targetX - (int)player.Tile.X;
        int deltaY = targetY - (int)player.Tile.Y;
        if (Math.Abs(deltaX) > Math.Abs(deltaY))
            return deltaX > 0 ? 1 : 3;
        if (deltaY != 0)
            return deltaY > 0 ? 2 : 0;
        // A live target can occupy the same rounded tile only if its position
        // changes between discovery and input. The binding guard still decides.
        return player.FacingDirection;
    }

    private static int CountQualifiedItem(Farmer player, string qualifiedItemId) => player.Items.OfType<StardewValley.Object>()
        .Where(item => string.Equals(item.QualifiedItemId, qualifiedItemId, StringComparison.Ordinal))
        .Sum(item => item.Stack);

    private static IReadOnlyList<BridgeFoodTarget> DiscoverFoodTargets(Farmer player)
    {
        List<BridgeFoodTarget> result = new();
        for (int slot = 0; slot < player.Items.Count && result.Count < 36; slot++)
        {
            if (player.Items[slot] is not StardewValley.Object food)
                continue;
            bool isDrink = Game1.objectData.TryGetValue(food.ItemId, out var objectData) && objectData.IsDrink;
            if (food.QualifiedItemId == "(O)434" || (!isDrink && food.Edibility == -300))
                continue;
            result.Add(new BridgeFoodTarget(slot, food.QualifiedItemId, food.Stack, food.Edibility, isDrink));
        }
        return result;
    }

    private static IReadOnlyList<BridgeForageTarget> DiscoverForageTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeForageTarget>();
        return location.objects.Pairs
            .Where(pair => pair.Value is not null && pair.Value.isForage() && Utility.tileWithinRadiusOfPlayer((int)pair.Key.X, (int)pair.Key.Y, 1, player))
            .Take(64)
            .Select(pair => new BridgeForageTarget(BuildForageTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, pair.Value), (int)pair.Key.X, (int)pair.Key.Y, pair.Value.QualifiedItemId, pair.Value.Stack))
            .ToArray();
    }

    private static string BuildForageTargetId(StardewValley.GameLocation location, int x, int y, StardewValley.Object forage)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:{forage.QualifiedItemId}:{forage.Stack}:{forage.IsSpawnedObject}";
        return $"forage_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static IReadOnlyList<BridgeItemTarget> DiscoverItemTargets(Farmer player)
    {
        const int discoveryRadius = 6;
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeItemTarget>();
        List<BridgeItemTarget> result = new();
        for (int debrisIndex = 0; debrisIndex < location.debris.Count && result.Count < 64; debrisIndex++)
        {
            Debris debris = location.debris[debrisIndex];
            string? qualifiedItemId = debris.item?.QualifiedItemId ?? debris.itemId.Value;
            if (string.IsNullOrWhiteSpace(qualifiedItemId) || debris.Chunks.Count == 0 || debris.debrisType.Value is not (Debris.DebrisType.OBJECT or Debris.DebrisType.RESOURCE))
                continue;
            int chunkIndex = 0;
            foreach (Chunk chunk in debris.Chunks)
            {
                Point tile = GetChunkTile(chunk);
                if (IsTileWithinChebyshevRadius(player, tile.X, tile.Y, discoveryRadius))
                {
                    string targetId = BuildItemTargetId(location, debrisIndex, chunkIndex, debris, qualifiedItemId);
                    result.Add(new BridgeItemTarget(targetId, tile.X, tile.Y, qualifiedItemId, Math.Max(1, debris.item?.Stack ?? 1)));
                    if (result.Count >= 64) break;
                }
                chunkIndex++;
            }
        }
        return result;
    }

    private static Point GetChunkTile(Chunk chunk) => new((int)((chunk.position.Value.X + 32f) / 64f), (int)((chunk.position.Value.Y + 32f) / 64f));

    private static string BuildItemTargetId(StardewValley.GameLocation location, int debrisIndex, int chunkIndex, Debris debris, string qualifiedItemId)
    {
        string raw = $"{location.NameOrUniqueName}:debris:{debrisIndex}:chunk:{chunkIndex}:item:{qualifiedItemId}:stack:{Math.Max(1, debris.item?.Stack ?? 1)}:type:{debris.debrisType.Value}:quality:{debris.itemQuality}:item_id:{debris.itemId.Value ?? ""}:dropped_by:{debris.DroppedByPlayerID.Value}:chunks:{debris.Chunks.Count}";
        return $"item_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static (Debris Debris, int DebrisIndex, int ChunkIndex, Chunk Chunk, string TargetId, string QualifiedItemId, int Stack)? FindItemTarget(StardewValley.GameLocation location, Farmer player, string expectedTargetId, string expectedQualifiedItemId, int radius)
    {
        for (int debrisIndex = 0; debrisIndex < location.debris.Count; debrisIndex++)
        {
            Debris debris = location.debris[debrisIndex];
            string? qualifiedItemId = debris.item?.QualifiedItemId ?? debris.itemId.Value;
            if (string.IsNullOrWhiteSpace(qualifiedItemId) || !string.Equals(qualifiedItemId, expectedQualifiedItemId, StringComparison.Ordinal) || debris.Chunks.Count == 0 || debris.debrisType.Value is not (Debris.DebrisType.OBJECT or Debris.DebrisType.RESOURCE))
                continue;
            int chunkIndex = 0;
            foreach (Chunk chunk in debris.Chunks)
            {
                Point tile = GetChunkTile(chunk);
                string targetId = BuildItemTargetId(location, debrisIndex, chunkIndex, debris, qualifiedItemId);
                if (targetId == expectedTargetId && IsTileWithinChebyshevRadius(player, tile.X, tile.Y, radius))
                    return (debris, debrisIndex, chunkIndex, chunk, targetId, qualifiedItemId, Math.Max(1, debris.item?.Stack ?? 1));
                chunkIndex++;
            }
        }
        return null;
    }

    private static IReadOnlyList<BridgeSeedTarget> DiscoverSeedTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeSeedTarget>();
        List<BridgeSeedTarget> result = new();
        foreach ((StardewValley.Item? item, int slot) in player.Items.Select((item, slot) => (item, slot)))
        {
            if (item is not StardewValley.Object seed || seed.Category != StardewValley.Object.SeedsCategory)
                continue;
            for (int x = Math.Max(0, player.TilePoint.X - 1); x <= player.TilePoint.X + 1 && result.Count < 64; x++)
            {
                for (int y = Math.Max(0, player.TilePoint.Y - 1); y <= player.TilePoint.Y + 1 && result.Count < 64; y++)
                {
                    Vector2 tile = new(x, y);
                    if (!IsCropTargetInRange(player, x, y)
                        || !location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? feature)
                        || feature is not StardewValley.TerrainFeatures.HoeDirt dirt
                        || (location.objects.TryGetValue(tile, out StardewValley.Object? placed) && placed is StardewValley.Objects.IndoorPot)
                        || dirt.crop is not null
                        || !dirt.canPlantThisSeedHere(seed.ItemId, isFertilizer: false))
                        continue;
                    result.Add(new BridgeSeedTarget(BuildSeedTargetId(location, slot, x, y, seed.QualifiedItemId), slot, x, y, seed.QualifiedItemId));
                }
            }
        }
        return result;
    }

    private static string BuildSeedTargetId(StardewValley.GameLocation location, int slot, int x, int y, string qualifiedItemId)
    {
        string raw = $"{location.NameOrUniqueName}:{slot}:{x},{y}:{qualifiedItemId}";
        return $"seed_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static IReadOnlyList<BridgeFertilizerTarget> DiscoverFertilizerTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeFertilizerTarget>();
        List<BridgeFertilizerTarget> result = new();
        foreach ((StardewValley.Item? item, int slot) in player.Items.Select((item, slot) => (item, slot)))
        {
            if (item is not StardewValley.Object fertilizer || fertilizer.Category != StardewValley.Object.fertilizerCategory)
                continue;
            for (int x = Math.Max(0, player.TilePoint.X - 1); x <= player.TilePoint.X + 1 && result.Count < 64; x++)
            {
                for (int y = Math.Max(0, player.TilePoint.Y - 1); y <= player.TilePoint.Y + 1 && result.Count < 64; y++)
                {
                    Vector2 tile = new(x, y);
                    if (!location.terrainFeatures.TryGetValue(tile, out StardewValley.TerrainFeatures.TerrainFeature? feature)
                        || feature is not StardewValley.TerrainFeatures.HoeDirt dirt
                        || (location.objects.TryGetValue(tile, out StardewValley.Object? placed) && placed is StardewValley.Objects.IndoorPot)
                        || !dirt.CanApplyFertilizer(fertilizer.QualifiedItemId))
                        continue;
                    result.Add(new BridgeFertilizerTarget(BuildFertilizerTargetId(location, slot, x, y, fertilizer.QualifiedItemId), slot, x, y, fertilizer.QualifiedItemId));
                }
            }
        }
        return result;
    }

    private static string BuildFertilizerTargetId(StardewValley.GameLocation location, int slot, int x, int y, string qualifiedItemId)
    {
        string raw = $"{location.NameOrUniqueName}:{slot}:{x},{y}:{qualifiedItemId}";
        return $"fertilizer_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static IReadOnlyList<BridgeHarvestTarget> DiscoverHarvestTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeHarvestTarget>();
        return location.terrainFeatures.Pairs
            .Where(pair => pair.Value is StardewValley.TerrainFeatures.HoeDirt dirt
                && dirt.crop is not null
                && !dirt.crop.forageCrop.Value
                && dirt.readyForHarvest()
                && dirt.crop.GetHarvestMethod() == StardewValley.GameData.Crops.HarvestMethod.Grab
                && !string.IsNullOrWhiteSpace(dirt.crop.indexOfHarvest.Value)
                && IsCropTargetInRange(player, (int)pair.Key.X, (int)pair.Key.Y))
            .Take(64)
            .Select(pair =>
            {
                StardewValley.TerrainFeatures.HoeDirt dirt = (StardewValley.TerrainFeatures.HoeDirt)pair.Value;
                StardewValley.Crop crop = dirt.crop!;
                string harvestId = crop.indexOfHarvest.Value;
                return new BridgeHarvestTarget(
                    BuildCropTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, crop.netSeedIndex.Value, harvestId),
                    (int)pair.Key.X,
                    (int)pair.Key.Y,
                    crop.netSeedIndex.Value ?? harvestId,
                    StardewValley.ItemRegistry.Create(harvestId, 1).QualifiedItemId,
                    crop.RegrowsAfterHarvest());
            })
            .ToArray();
    }

    private static IReadOnlyList<BridgeCropTarget> DiscoverCropTargets(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeCropTarget>();
        return location.terrainFeatures.Pairs
            .Where(pair => pair.Value is StardewValley.TerrainFeatures.HoeDirt { crop: not null } dirt
                && dirt.needsWatering()
                && !dirt.isWatered()
                && IsCropTargetInRange(player, (int)pair.Key.X, (int)pair.Key.Y))
            .Take(64)
            .Select(pair =>
            {
                StardewValley.TerrainFeatures.HoeDirt dirt = (StardewValley.TerrainFeatures.HoeDirt)pair.Value;
                string cropId = dirt.crop!.netSeedIndex.Value ?? dirt.crop.indexOfHarvest.Value ?? "unknown";
                return new BridgeCropTarget(BuildCropTargetId(location, (int)pair.Key.X, (int)pair.Key.Y, dirt.crop.netSeedIndex.Value, dirt.crop.indexOfHarvest.Value), (int)pair.Key.X, (int)pair.Key.Y, cropId);
            })
            .ToArray();
    }

    private static string BuildCropTargetId(StardewValley.GameLocation location, int x, int y, string? seedId, string? harvestId)
    {
        string raw = $"{location.NameOrUniqueName}:{x},{y}:{seedId ?? ""}:{harvestId ?? ""}";
        return $"crop_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    private static IReadOnlyList<BridgeSoilTile> DiscoverSoilTiles(Farmer player)
    {
        StardewValley.GameLocation? location = player.currentLocation;
        if (location is null) return Array.Empty<BridgeSoilTile>();
        List<BridgeSoilTile> result = new();
        for (int x = Math.Max(0, player.TilePoint.X - 1); x <= player.TilePoint.X + 1; x++)
        {
            for (int y = Math.Max(0, player.TilePoint.Y - 1); y <= player.TilePoint.Y + 1; y++)
            {
                Vector2 tile = new(x, y);
                if (location.GetHoeDirtAtTile(tile) is not null
                    || location.doesTileHaveProperty(x, y, "Diggable", "Back") is null
                    || location.isWaterTile(x, y)
                    || location.objects.ContainsKey(tile)
                    || !location.isTileLocationOpen(tile))
                    continue;
                result.Add(new BridgeSoilTile(x, y));
            }
        }
        return result;
    }

    private void RecordControllerTransition(ExecutionState state, string reasonCode, string? evidence)
    {
        if (this.active is null)
            return;

        LocalMoveSpec specification = this.active;
        if (this.activeItemPickup is { } pickup && pickup.ExecutionId == specification.ExecutionId)
        {
            // The body controller is only the first phase of pickup_item. Its
            // arrival is not the action terminal state: target-version
            // Debris.updateChunks must subsequently magnetize and collect the
            // same chunk, which Update verifies by identity and inventory.
            if (state is ExecutionState.Running or ExecutionState.MeaningfulProgress)
            {
                this.revision++;
                LocalExecutionReceipt progressReceipt = new(pickup.ExecutionId, pickup.RequestId, state, reasonCode, this.revision, evidence);
                this.Remember(progressReceipt);
                this.AddTrace(progressReceipt);
                return;
            }

            this.active = null;
            if (state == ExecutionState.Succeeded)
            {
                // The controller reached the bounded adjacent arrival. Keep
                // pickup ownership through the next native location update,
                // where Debris.updateChunks may perform magnetic collection.
                this.revision++;
                LocalExecutionReceipt approachReceipt = new(pickup.ExecutionId, pickup.RequestId, ExecutionState.Running, "item_pickup_approach_completed", this.revision, evidence);
                this.Remember(approachReceipt);
                this.AddTrace(approachReceipt);
                return;
            }

            this.activeItemPickup = null;
            this.revision++;
            LocalExecutionReceipt pickupReceipt = new(pickup.ExecutionId, pickup.RequestId, state, reasonCode, this.revision,
                $"location={pickup.Location};target={pickup.TargetId};tile={pickup.TargetX},{pickup.TargetY};native_auto_collect_pending=false;body_evidence={evidence ?? "none"}");
            this.Remember(pickupReceipt);
            this.AddTrace(pickupReceipt);
            return;
        }

        this.revision++;
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
        LocalMoveSpec? activeSpec = this.active;
        long routeRevision = activeSpec?.ExecutionId == receipt.ExecutionId
            ? activeSpec.RouteRevision
            : this.activeTravel?.ExecutionId == receipt.ExecutionId ? this.activeTravel.RouteRevision : receipt.Revision;
        Farmer player = Game1.player;
        ExecutionTrace entry = new(this.revision, DateTimeOffset.UtcNow.ToString("O"), receipt.ExecutionId, receipt.RequestId, routeRevision, receipt.State, receipt.ReasonCode,
            player.currentLocation?.NameOrUniqueName, player.Tile, receipt.Evidence);
        this.trace.Add(entry);
        if (this.trace.Count > MaximumRememberedReceipts)
            this.trace.RemoveAt(0);

        this.monitor.Log($"GameBuddy execution state={receipt.State} execution={receipt.ExecutionId} request={receipt.RequestId} reason={receipt.ReasonCode} evidence={receipt.Evidence ?? "none"}", LogLevel.Trace);
        this.receiptPublished?.Invoke(receipt);
    }

    private static IReadOnlyList<string> CreateCapabilities(IReadOnlySet<string>? enabledActions)
    {
        List<string> result = new() { "inspect_self", "cancel_active_execution" };
        if (enabledActions?.Contains("equip_tool") == true)
            result.Insert(0, "equip_tool");
        if (enabledActions?.Contains("move_to_tile") == true)
            result.Insert(0, "move_to_tile");
        if (enabledActions?.Contains("travel") == true)
            result.Insert(0, "travel");
        if (enabledActions?.Contains("enter_exit") == true)
            result.Insert(0, "enter_exit");
        if (enabledActions?.Contains("till_soil") == true)
            result.Insert(0, "till_soil");
        if (enabledActions?.Contains("pickup_forage") == true)
            result.Insert(0, "pickup_forage");
        if (enabledActions?.Contains("pickup_item") == true)
            result.Insert(0, "pickup_item");
        if (enabledActions?.Contains("water_crop") == true)
            result.Insert(0, "water_crop");
        if (enabledActions?.Contains("plant_seed") == true)
            result.Insert(0, "plant_seed");
        if (enabledActions?.Contains("fertilize_tile") == true)
            result.Insert(0, "fertilize_tile");
        if (enabledActions?.Contains("clear_debris") == true)
            result.Insert(0, "clear_debris");
        if (enabledActions?.Contains("machine_inspect") == true)
            result.Insert(0, "machine_inspect");
        if (enabledActions?.Contains("collect_resource") == true)
            result.Insert(0, "collect_resource");
        if (enabledActions?.Contains("npc_relationship") == true)
            result.Insert(0, "npc_relationship");
        if (enabledActions?.Contains("pet_animal") == true)
            result.Insert(0, "pet_animal");
        if (enabledActions?.Contains("collect_animal_product") == true)
            result.Insert(0, "collect_animal_product");
        if (enabledActions?.Contains("feed_animal") == true)
            result.Insert(0, "feed_animal");
        if (enabledActions?.Contains("use_item") == true)
            result.Insert(0, "use_item");
        if (enabledActions?.Contains("harvest_crop") == true)
            result.Insert(0, "harvest_crop");
        return result;
    }

    private static string? DescribeTool(Tool? tool) => tool is null ? null : tool.QualifiedItemId ?? tool.Name;

    private static bool IsFiniteTile(Vector2 tile) => float.IsFinite(tile.X) && float.IsFinite(tile.Y);

    private static string FormatTile(Vector2 tile) => $"{tile.X:0.##},{tile.Y:0.##}";
}
