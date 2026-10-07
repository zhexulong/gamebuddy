using System.Globalization;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Menus;
using StardewValley.GameData.Minecarts;
using StardewValley.Tools;
using StardewValley.Characters;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Models;
using GameBuddy.Stardew.Navigation;

namespace GameBuddy.Stardew;

// Native handler bodies remain action/family-owned. All parts share the one
// ExecutionManager game-thread ledger, receipt store, snapshot, and cancel state.
internal sealed partial class ExecutionManager
{
    public LocalExecutionReceipt RequestLocalMove(string requestId, Vector2 targetTile, long? requestedDeadlineMs = null, bool allowAdjacentArrival = false)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        // Scope-bound actor proof. Authorization precedes the world/location
        // readiness checks: a caller that is not the scope-bound actor is refused
        // for that reason rather than for where it happens to be standing.
        // This handler has no shared executionId; like its other rejections it
        // mints one here.
        if (!this.TryGetBoundActor(out Farmer? boundActor, out string scopeReason) || boundActor is null)
            return this.RememberTerminal(requestId, Guid.NewGuid().ToString("N"), ExecutionState.Rejected, scopeReason, null);

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
        bool adjacentArrival = allowAdjacentArrival || nativeWarpTarget;

        // 1. The named tile cannot be walked onto -- it holds the thing the caller
        //    wants to touch (a tree, a rock, a chest, a building) -- but a walkable
        //    neighbour is: approach that neighbour instead of refusing. Every other
        //    interaction in this Mod is a native action from an adjacent tile, so
        //    "walk to the object" now works the way the agent means it. The test is the
        //    PLANNER's own walkability, not a stricter object-occupancy reading: a
        //    cropped HoeDirt is legally walkable, and treating it as blocked both
        //    hijacked the request into a failed substitution and refused a move the
        //    planner would have made (the Mod's own probe contradicted the verdict with
        //    probe_says_reachable=true). The substitution is named in the receipt, never
        //    silent.
        Vector2 effectiveTarget = targetTile;
        bool approachSubstituted = false;
        if (!StardewBodyController.IsWalkableTile(Game1.player.currentLocation, Game1.player, targetTile))
        {
            Vector2? approach = SelectStandingApproachTile(
                targetTile,
                Game1.player.Tile,
                candidate => StardewBodyController.IsWalkableTile(Game1.player.currentLocation, Game1.player, candidate));
            if (approach is not null)
            {
                effectiveTarget = approach.Value;
                // Exact arrival on the substitute, NOT adjacency to it. The substitute is standable by
                // construction (that is the predicate it was chosen by) and exists precisely to bring
                // the actor within INTERACTION RANGE of the requested tile; allowing adjacency lets
                // the actor stop one tile farther out, which is where the range it was chosen for
                // ends. Live evidence: move_to_tile(3,12) reported target_reached with the actor two
                // tiles away, too far to act on the door it was asked to approach.
                adjacentArrival = false;
                approachSubstituted = true;
            }
        }

        // 2. Already inside the arrival contract for the EFFECTIVE destination: the
        //    actor stands on it, or (when adjacency is allowed) on one of its
        //    neighbours. The native planner has nothing to plan, so its
        //    pathToEndPoint comes back empty and this used to be reported as
        //    `no_native_path` -- a REACHABILITY verdict the Mod's own probe
        //    contradicts (target_enclosed=false means it found a traversable
        //    neighbour: the one the actor is standing on). A live ladder run spent
        //    10 of its 29 movement dispatches on that false verdict and told the
        //    player the farm was a maze. A satisfied arrival contract is success, and
        //    saying so moves no native state because nothing needs moving. The check
        //    is made AFTER substitution so the same rule covers the approached case.
        if (StardewBodyController.IsArrivalDelta(
            Math.Abs((int)Game1.player.Tile.X - (int)effectiveTarget.X),
            Math.Abs((int)Game1.player.Tile.Y - (int)effectiveTarget.Y),
            adjacentArrival))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Succeeded,
                "target_reached",
                approachSubstituted
                    ? $"already_at_target=true;tile={FormatTile(Game1.player.Tile)};target={FormatTile(effectiveTarget)};requested={FormatTile(targetTile)};adjacent_arrival=true"
                    : $"already_at_target=true;tile={FormatTile(Game1.player.Tile)};target={FormatTile(targetTile)}");

        LocalMoveSpec specification = new(executionId, requestId, effectiveTarget, adjacentArrival, this.revision, this.tick + deadlineTicks, deadlineMs);
        // The controller emits its initial Running transition synchronously;
        // establish ownership first so its authoritative receipt is retained.
        this.active = specification;
        if (!this.controller.TryStart(specification, Game1.player, this.tick, out string reasonCode, out string? startEvidence))
        {
            this.active = null;
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, reasonCode, startEvidence);
        }

        string acceptedEvidence = approachSubstituted
            ? $"route_revision={specification.RouteRevision};target={FormatTile(effectiveTarget)};requested={FormatTile(targetTile)};adjacent_arrival=true"
            : $"route_revision={specification.RouteRevision};target={FormatTile(effectiveTarget)}";
        LocalExecutionReceipt accepted = new(executionId, requestId, ExecutionState.Accepted, "accepted", this.revision, acceptedEvidence);
        this.Remember(accepted);
        this.AddTrace(accepted);
        return accepted;
    }

    /// <summary>
    /// The deterministic standable neighbour of a destination tile, as pure
    /// arithmetic over a standability predicate so its choice is directly
    /// testable (the same reason <c>AssessReachability</c> takes a predicate).
    ///
    /// The whole Chebyshev-1 ring is considered — cardinals first, then diagonals —
    /// because that is exactly the neighbourhood the rest of the Mod already treats as
    /// "adjacent": the arrival predicate (<see cref="IsArrivalDelta"/>) accepts the
    /// full ring when adjacency is allowed, and every interaction admission gates on
    /// <c>IsTileWithinChebyshevRadius(..., 1)</c>, whose own comment records that the
    /// native click path "stops on any Chebyshev-1 tile and the subsequent tool call
    /// re-enters". A cardinal-only search was stricter than both and cost real
    /// refusals on a densely cropped field, where only a diagonal tile was free.
    ///
    /// The nearest candidate to the actor wins; equidistant candidates keep the
    /// declared order, so the choice cannot drift between runs (a run-to-run diff must
    /// mean something).
    /// </summary>
    internal static Vector2? SelectStandingApproachTile(Vector2 targetTile, Vector2 actorTile, Func<Vector2, bool> isStandable)
    {
        Vector2[] candidates =
        {
            targetTile + new Vector2(-1f, 0f),
            targetTile + new Vector2(1f, 0f),
            targetTile + new Vector2(0f, -1f),
            targetTile + new Vector2(0f, 1f),
            targetTile + new Vector2(-1f, -1f),
            targetTile + new Vector2(1f, -1f),
            targetTile + new Vector2(-1f, 1f),
            targetTile + new Vector2(1f, 1f),
        };
        Vector2? best = null;
        float bestDistance = float.MaxValue;
        foreach (Vector2 candidate in candidates)
        {
            if (!isStandable(candidate))
                continue;
            float distance = Math.Abs(candidate.X - actorTile.X) + Math.Abs(candidate.Y - actorTile.Y);
            // Strict `<` only: equidistant candidates keep the declared candidate
            // order (left, right, up, down), so the choice is deterministic without a
            // second ordering rule to reason about.
            if (best is not null && distance >= bestDistance)
                continue;
            best = candidate;
            bestDistance = distance;
        }
        return best;
    }

    /// <summary>
    /// Requests one native minecart ride named by an exact published objective.
    /// Every fact is re-derived on the game thread from the live station tile and
    /// the game's own `Data/Minecarts`; the client-supplied ID is only a selector.
    /// The native ride is `GameLocation.MinecartWarp`, which ends in the same
    /// `Warped` event the ordinary warp path uses, so the ride keeps the single
    /// `activeTravel` ownership and the same one-shot release; only the terminal
    /// reason code is the ride's own (`minecart_ride_completed`).
    /// </summary>
    public LocalExecutionReceipt RequestLocalMinecartRide(
        string requestId, int sourceX, int sourceY, long requestedDeadlineMs, string expectedTargetId)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (!this.TryGetBoundActor(out Farmer? boundActor, out string scopeReason) || boundActor is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, scopeReason, null);

        if (!Context.IsWorldReady || Game1.player is null || Game1.player.currentLocation is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "world_not_ready", null);
        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_not_actionable", null);
        if (requestedDeadlineMs <= nowMs || requestedDeadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null || this.activeAnimalProduct is not null || this.activeItemUse is not null || this.controller.HasActiveExecution)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "body_owned", this.active?.ExecutionId ?? this.activeTravel?.ExecutionId ?? this.activeAnimalProduct?.ExecutionId ?? this.activeItemUse?.ExecutionId);

        StardewValley.GameLocation location = Game1.player.currentLocation;
        if (!Utility.tileWithinRadiusOfPlayer(sourceX, sourceY, 1, Game1.player))
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "minecart_station_out_of_range", $"source={sourceX},{sourceY}");

        MinecartRideResolution resolution = ResolveMinecartRide(location, sourceX, sourceY, expectedTargetId);
        if (!resolution.Accepted || resolution.Destination is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, resolution.ReasonCode, $"source={sourceX},{sourceY};target={expectedTargetId}");

        MinecartDestinationData destination = resolution.Destination;
        int pricePaid = RideMinecart(destination, resolution.NetworkId, Game1.player);
        if (pricePaid < 0)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "minecart_ticket_unaffordable", $"source={sourceX},{sourceY};target={expectedTargetId};price={destination.Price};money={Game1.player.Money}");

        LocalTravelSpec specification = new(
            executionId,
            requestId,
            "ride_minecart",
            location.NameOrUniqueName,
            sourceX,
            sourceY,
            destination.TargetLocation,
            destination.TargetTile.X,
            destination.TargetTile.Y,
            this.revision,
            requestedDeadlineMs,
            resolution.NetworkId,
            destination.Id);
        this.activeTravel = specification;
        LocalExecutionReceipt accepted = new(
            executionId,
            requestId,
            ExecutionState.Accepted,
            "accepted",
            this.revision,
            $"source={specification.SourceLocation}:{sourceX},{sourceY};target={specification.TargetLocation}:{specification.TargetX},{specification.TargetY};{FormatMinecartEvidence(resolution.NetworkId, destination)};ticket_price={pricePaid}");
        this.Remember(accepted);
        this.AddTrace(accepted);
        return accepted;
    }

    /// <summary>
    /// Requests a native warp from a structured source warp in the current
    /// location. Only the Warped event can produce the authoritative travel
    /// postcondition.
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
        // Scope-bound actor proof. Authorization precedes the world/location
        // readiness checks: a caller that is not the scope-bound actor is refused
        // for that reason rather than for where it happens to be standing.
        if (!this.TryGetBoundActor(out Farmer? boundActor, out string scopeReason) || boundActor is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, scopeReason, null);

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
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, isDoor ? "door_out_of_range" : "warp_out_of_range", $"source={sourceX},{sourceY};door={warp.X},{warp.Y};target={warp.TargetName}:{warp.TargetX},{warp.TargetY}");

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

        // enter_exit runs the game's own door entry instead of a bare warpFarmer.
        // `getWarpFromDoor` only RESOLVES a door into a Warp; every door gate
        // lives one level up, in the entry GameLocation.checkAction (:7888)
        // dispatches for a real player: GameLocation.performAction's Warp family
        // (LockedDoorWarp's festival / SeedShop-Wednesday / open-hours /
        // friendship tests at :10319, WarpCommunityCenter's ccDoorUnlock at
        // :9462, Warp_Sunroom_Door's Caroline hearts at :9113,
        // WarpGreenhouse's ccPantry test at :9416) and Building.doAction's
        // construction / demolish-lock / dismount rules (Building.cs:937-959).
        //
        // The game's own return value decides whether the entry handled this
        // tile: performAction returns true for every Warp-family case it owns and
        // false from its `default:` branch. That is what keeps a door the click
        // path does not own (WarpBoatTunnel has no performAction case) on the
        // resolver's warp instead of being misread as a locked gate. The chosen
        // entry is echoed into the receipt so an observer can tell a gated door
        // apart from the resolver fallback.
        string entry = "none";
        if (isDoor)
        {
            NativeDoorOutcome outcome = DispatchNativeDoor(location, sourcePoint, out string refusal, out entry);
            switch (outcome)
            {
                case NativeDoorOutcome.Refused:
                    return this.RememberTerminal(
                        requestId,
                        executionId,
                        ExecutionState.Rejected,
                        "door_gate_refused",
                        $"source={sourceX},{sourceY};gate=refused;entry={entry};dialogue={refusal}");

                case NativeDoorOutcome.NoEffect:
                    return this.RememberTerminal(
                        requestId,
                        executionId,
                        ExecutionState.Rejected,
                        "door_transition_not_started",
                        $"source={sourceX},{sourceY};gate=passed;entry={entry};transition=not_started");

                case NativeDoorOutcome.TransitionStarted:
                    break;

                case NativeDoorOutcome.NotNative:
                default:
                    // No native click entry owns this tile, so the resolved warp
                    // remains the authority (FarmHouse/Cabin exits).
                    this.activeTravel = specification;
                    LocalExecutionReceipt plainDoorAccepted = new(
                        executionId,
                        requestId,
                        ExecutionState.Accepted,
                        "accepted",
                        this.revision,
                        $"source={specification.SourceLocation}:{sourceX},{sourceY};target={specification.TargetLocation}:{specification.TargetX},{specification.TargetY};entry={entry}");
                    this.Remember(plainDoorAccepted);
                    this.AddTrace(plainDoorAccepted);
                    Game1.player.warpFarmer(warp);
                    return plainDoorAccepted;
            }
        }

        this.activeTravel = specification;
        LocalExecutionReceipt accepted = new(
            executionId,
            requestId,
            ExecutionState.Accepted,
            "accepted",
            this.revision,
            isDoor
                ? $"source={specification.SourceLocation}:{sourceX},{sourceY};target={specification.TargetLocation}:{specification.TargetX},{specification.TargetY};entry={entry}"
                : $"source={specification.SourceLocation}:{sourceX},{sourceY};target={specification.TargetLocation}:{specification.TargetX},{specification.TargetY}");
        this.Remember(accepted);
        this.AddTrace(accepted);
        // A native door entry already ran Game1.warpFarmer; only a plain record
        // (travel, or a door the click path does not own) warps here.
        if (!isDoor)
            Game1.player.warpFarmer(warp);
        return accepted;
    }

    /// <summary>What the game's own door entry did for one door tile.</summary>
    private enum NativeDoorOutcome
    {
        /// <summary>No native click entry owns this tile; the resolved warp stays authoritative.</summary>
        NotNative,

        /// <summary>The native gate refused: the game drew its locked-door DialogueBox and did not warp.</summary>
        Refused,

        /// <summary>The native entry started a warp.</summary>
        TransitionStarted,

        /// <summary>The native entry handled the tile but neither warped nor refused.</summary>
        NoEffect,
    }

    /// <summary>
    /// Runs the native player door entry for a door tile and reports what the
    /// game did, so enter_exit cannot bypass a native door gate.
    ///
    /// The dispatch order mirrors GameLocation.checkAction exactly: building
    /// human doors are tried first (:7647-7653) and only then the Buildings-layer
    /// Action property (:7868-7888). Each branch uses the game's own return value
    /// as the "the click path owns this tile" signal, which is what keeps a door
    /// the click path does not own (WarpBoatTunnel has no performAction case) on
    /// the resolver's warp instead of being misread as a locked gate.
    ///
    /// A refusal leaves the game's own DialogueBox mounted; it is closed with the
    /// public step the native input paths use (<see cref="DialogueBox.closeDialogue"/>),
    /// which also restores <c>Farmer.CanMove</c>. Leaving it mounted would make
    /// every later action reject as <c>player_not_actionable</c>, so the refusal
    /// is reported in the receipt instead of being handed to the player.
    /// </summary>
    private static NativeDoorOutcome DispatchNativeDoor(
        StardewValley.GameLocation location,
        Microsoft.Xna.Framework.Point source,
        out string refusal,
        out string entry)
    {
        refusal = string.Empty;
        entry = "none";
        bool handled = false;

        foreach (StardewValley.Buildings.Building building in location.buildings)
        {
            if (building.HasIndoors() && building.getPointForHumanDoor() == source)
            {
                entry = "building_do_action";
                handled = building.doAction(new Vector2(source.X, source.Y), Game1.player);
                break;
            }
        }

        // The admission predicate is updateDoors' own -- "the Action string
        // contains Warp" (GameLocation.cs:17601) -- and NOT membership of
        // location.doors. Those are different sets, and the difference is a door
        // gate that enter_exit could walk through: updateDoors builds the table
        // from the FOURTH token of the Action string (:17631-17638), so a
        // Warp-family Action with fewer than four tokens is considered and then
        // DISCARDED. WarpGreenhouse is exactly that shape -- one token, and a
        // `ccPantry` gate a real click runs before warping (:9415-9440) -- so
        // door-table membership sent the tile to the resolver's ungated warp.
        // Reading the Action unconditionally would be worse: it would also run
        // "Kitchen", animal-door and generic ActionTiles.
        string? warpAction = ReadBuildingsLayerAction(location, source);
        if (!handled && IsNativeWarpAction(warpAction))
        {
            entry = "perform_action";
            handled = location.performAction(warpAction!, Game1.player, new xTile.Dimensions.Location(source.X, source.Y));
        }

        if (Game1.isWarping)
            return NativeDoorOutcome.TransitionStarted;

        if (Game1.activeClickableMenu is DialogueBox dialogueBox)
        {
            refusal = string.Join(" | ", dialogueBox.dialogues);
            dialogueBox.closeDialogue();
            return NativeDoorOutcome.Refused;
        }

        // Nothing native owned this tile, so the resolver's warp stays
        // authoritative (FarmHouse/Cabin exits have no click entry).
        if (!handled)
            entry = "resolved_warp_fallback";
        return handled ? NativeDoorOutcome.NoEffect : NativeDoorOutcome.NotNative;
    }

    /// <summary>
    /// The Buildings-layer <c>Action</c> property of one tile, read exactly the way
    /// <c>GameLocation.updateDoors</c> reads it: the raw map layer's own tile
    /// property (GameLocation.cs:17600-17601). Deliberately not
    /// <c>doesTileHaveProperty</c>, which also answers for tiles a Building or a
    /// Furniture owns (:13153-13185) and would therefore admit a tile the door table
    /// never sees. An off-map tile answers null instead of throwing.
    /// </summary>
    internal static string? ReadBuildingsLayerAction(
        StardewValley.GameLocation location, Microsoft.Xna.Framework.Point source) =>
        ReadBuildingsLayerAction(location.map?.GetLayer("Buildings"), source.X, source.Y);

    /// <summary>The same read for a caller that already holds the Buildings layer (the
    /// tile scans hoist it once instead of re-resolving it per tile).</summary>
    internal static string? ReadBuildingsLayerAction(xTile.Layers.Layer? buildings, int x, int y)
    {
        if (buildings is null || x < 0 || y < 0 || x >= buildings.LayerWidth || y >= buildings.LayerHeight)
            return null;

        var tile = buildings.Tiles[x, y];
        if (tile is null || !tile.Properties.TryGetValue("Action", out var action))
            return null;
        return action.ToString();
    }

    /// <summary>
    /// Whether a Buildings-layer Action belongs to the warp family. This is
    /// <c>value.Contains("Warp")</c> -- the same test <c>GameLocation.updateDoors</c>
    /// applies to admit a tile (GameLocation.cs:17601) and the same one
    /// <c>getWarpFromDoor</c>'s default arm reapplies when resolving it (:2238). Every
    /// door the table does hold passes it, and the gates the Mod must not bypass
    /// (ccPantry, ccDoorUnlock, Caroline's hearts, locked-door hours) all live behind
    /// it, so it is the only safe admission predicate here.
    /// </summary>
    internal static bool IsNativeWarpAction(string? actionProperty) =>
        actionProperty is not null && actionProperty.Contains("Warp", StringComparison.Ordinal);

    public void CompleteTravelAfterWarp()
    {
        LocalTravelSpec? specification = this.activeTravel;
        if (specification is null || Game1.player is null || Game1.player.currentLocation is null)
            return;

        this.revision++;
        bool locationMatches = string.Equals(Game1.player.currentLocation.NameOrUniqueName, specification.TargetLocation, StringComparison.Ordinal);
        // mine entry: the native MineShaft layout repositions the farmer onto the
        // level's stairs (verified live at 10,4 vs the requested 6,6), so tile
        // equality is not a legal postcondition for enter_mine; reaching the
        // target level is.
        //
        // select_mine_elevator_floor shares that rule but has two target shapes:
        // floor 0 targets the mine entrance MAP (a plain location match), while every
        // other floor targets a generated level and lands somewhere the native layout
        // chooses, so only "reached that level" is a legal postcondition.
        bool tileMatches = specification.Action switch
        {
            "enter_mine" => Game1.player.currentLocation is StardewValley.Locations.MineShaft mine
                && mine.mineLevel == int.Parse(specification.TargetLocation.Substring("UndergroundMine".Length)),
            "select_mine_elevator_floor" => specification.TargetLocation == "Mine"
                ? locationMatches
                : Game1.player.currentLocation is StardewValley.Locations.MineShaft elevatorMine
                    && elevatorMine.mineLevel == int.Parse(specification.TargetLocation.Substring("UndergroundMine".Length)),
            // The obelisk's landing tile is NOT a legal postcondition: Route A's warpFarmer may
            // shift the actor to a passable neighbour of the requested tile, and Route B's landing
            // is chosen inside the game's own delayed callback (WarpTotemEntry, else the whichFarm
            // fallback). Only "the actor reached the destination location" can be asserted.
            "use_obelisk" => locationMatches,
            _ => Game1.player.TilePoint.X == specification.TargetX && Game1.player.TilePoint.Y == specification.TargetY,
        };
        ExecutionState state = locationMatches && tileMatches ? ExecutionState.Succeeded : ExecutionState.Uncertain;
        string reasonCode = locationMatches && tileMatches
            ? specification.Action == "enter_exit"
                ? "enter_exit_completed"
                : specification.Action == "ride_minecart"
                    ? "minecart_ride_completed"
                    : specification.Action == "enter_mine"
                        ? "mine_entered"
                        : specification.Action == "select_mine_elevator_floor"
                            ? "mine_elevator_floor_selected"
                            : specification.Action == "use_obelisk"
                                ? "obelisk_arrived"
                                : "travel_completed"
            : specification.Action == "enter_exit"
                ? "enter_exit_postcondition_mismatch"
                : specification.Action == "ride_minecart"
                    ? "minecart_ride_postcondition_mismatch"
                    : specification.Action == "enter_mine"
                        ? "mine_entry_postcondition_mismatch"
                        : specification.Action == "select_mine_elevator_floor"
                            ? "mine_elevator_floor_postcondition_mismatch"
                            : specification.Action == "use_obelisk"
                                ? "obelisk_postcondition_mismatch"
                                : "travel_postcondition_mismatch";
        // A minecart ride's native terminal is the same Warped postcondition, but
        // the expected/actual pair alone cannot say which objective was ridden.
        // The published identity is echoed so the receipt names the ride.
        string minecartEvidence = specification.MinecartNetworkId is null || specification.MinecartDestinationId is null
            ? string.Empty
            : $";network={specification.MinecartNetworkId};destination={specification.MinecartDestinationId}";
        LocalExecutionReceipt receipt = new(
            specification.ExecutionId,
            specification.RequestId,
            state,
            reasonCode,
            this.revision,
            $"expected={specification.TargetLocation}:{specification.TargetX},{specification.TargetY};actual={Game1.player.currentLocation.NameOrUniqueName}:{Game1.player.TilePoint.X},{Game1.player.TilePoint.Y}{(specification.Action is "enter_mine" or "select_mine_elevator_floor" && Game1.player.currentLocation is StardewValley.Locations.MineShaft shaft2 ? $";level={shaft2.mineLevel}" : string.Empty)}{(specification.Action == "ride_minecart" ? minecartEvidence : string.Empty)}");
        this.activeTravel = null;
        this.Remember(receipt);
        this.AddTrace(receipt);
        this.PublishIdleAfterRelease(specification.ExecutionId, specification.RequestId);
    }

    /// <summary>
    /// Requests the single Navigation execution. It creates exactly one receipt
    /// lineage through the coordinator lifecycle and performs the terminal CAS
    /// on this ledger. Local approach/native transition legs are coordinator-own
    /// internal steps; a possibly side-effected but uncorrelated transition is
    /// never retried. Without a wired Navigation runtime this ledger fails closed.
    /// </summary>
    public LocalExecutionReceipt RequestNavigate(string requestId, NavigationDestinationSelector selector, long deadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing))
            return existing;

        this.revision++;
        string executionId = this.NewExecutionId(requestId);
        this.navigationExecutionIds.Add(executionId);
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (deadlineMs <= nowMs || deadlineMs > nowMs + TimeSpan.FromMinutes(10).TotalMilliseconds)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "invalid_deadline", null);

        if (this.activeNavigate is not null
            || this.active is not null
            || this.activeTravel is not null
            || this.activePet is not null
            || this.activeAnimalProduct is not null
            || this.activeItemUse is not null
            || this.activeItemPickup is not null
            || this.controller.HasActiveExecution
            || this.activeNavigationCoordinator is not null)
        {
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                "body_owned",
                this.activeNavigate?.ExecutionId
                    ?? this.active?.ExecutionId
                    ?? this.activeTravel?.ExecutionId
                    ?? this.activePet?.ExecutionId
                    ?? this.activeAnimalProduct?.ExecutionId
                    ?? this.activeItemUse?.ExecutionId
                    ?? this.activeItemPickup?.ExecutionId
                    ?? this.controller.ActiveExecutionId);
        }

        NavigationRuntimeSnapshot? runtime = this.navigationRuntimeFactory?.Invoke();
        if (runtime is null)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "destination_access_indeterminate", "navigation_runtime_unavailable");

        AcceptedNavigationExecution coordinator;
        NavigationPlan plan;
        try
        {
            NavigationAdmission admission = AcceptedNavigationExecution.Admit(selector, runtime);
            if (!admission.IsAccepted)
            {
                return this.RememberTerminal(
                    requestId,
                    executionId,
                    ExecutionState.Rejected,
                    admission.Resolution.FailureReason ?? "destination_selector_invalid",
                    admission.Resolution.DisplayLabel ?? "destination");
            }

            coordinator = AcceptedNavigationExecution.ForAcceptedDestination(admission);
            string? canonicalIdentity = admission.Resolution.Binding?.CanonicalDestinationIdentity;
            string? shopClosingEvidence = this.RunNavigationShopPreflight(canonicalIdentity);
            if (shopClosingEvidence is not null)
            {
                return this.RememberTerminal(
                    requestId,
                    executionId,
                    ExecutionState.Blocked,
                    "destination_closed_hours",
                    shopClosingEvidence);
            }
            plan = coordinator.PlanNextRouteLeg();
        }
        catch
        {
            return this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "destination_access_indeterminate", "navigation_decision_unavailable");
        }

        if (plan.IsTerminal)
            return this.RememberTerminal(requestId, executionId, plan.Outcome.State, plan.Outcome.TerminalReasonCode, plan.Outcome.Evidence);

        NavigationTransitionLeg? nextLeg = plan.Outcome.NextLeg;
        if (nextLeg is null || nextLeg.IsDoor)
        {
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Blocked,
                "navigation_transition_family_not_materialized",
                "phase=approved;transition=door_native;commit=never_armed");
        }

        Vector2? approachTarget = this.SelectSafeApproachTarget(nextLeg);
        if (approachTarget is null)
        {
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "navigation_approach_unavailable", "phase=approved;approach=unavailable");
        }

        int deadlineTicks = Math.Max(1, (int)Math.Ceiling((deadlineMs - nowMs) * 60d / 1000d));
        string canonicalDestinationIdentity = plan.Resolution.Binding?.CanonicalDestinationIdentity ?? nextLeg.TargetLocation;
        LocalNavigateSpec navigation = new(
            executionId,
            requestId,
            selector,
            canonicalDestinationIdentity,
            plan.View.CurrentSourceLocation ?? "unknown",
            nextLeg,
            approachTarget.Value,
            deadlineMs,
            LocalNavigatePhase.Approaching);
        LocalMoveSpec approach = new(
            executionId,
            requestId,
            approachTarget.Value,
            AllowAdjacentArrival: true,
            this.revision,
            this.tick + deadlineTicks,
            deadlineMs);

        this.activeNavigationCoordinator = coordinator;
        this.activeNavigate = navigation;
        this.active = approach;
        if (!this.TryStartApproach(approach, out string reasonCode, out string? approachEvidence))
        {
            this.active = null;
            this.activeNavigate = null;
            this.activeNavigationCoordinator = null;
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, reasonCode ?? "approach_unavailable", approachEvidence ?? "phase=approaching;arm=failed");
        }

        LocalExecutionReceipt accepted = new(executionId, requestId, ExecutionState.Accepted, "accepted", this.revision, "navigation=accepted;phase=approaching");
        this.Remember(accepted);
        this.AddTrace(accepted);
        return accepted;
    }

    private static readonly Dictionary<string, int> DirectionMap = new(StringComparer.Ordinal)
    {
        ["up"] = 0,
        ["right"] = 1,
        ["down"] = 2,
        ["left"] = 3,
    };

    public LocalExecutionReceipt RequestLocalFaceDirection(BridgeExecutionRequest request, IExecutionLedger ledger)
    {
        if (ledger.TryGetExistingReceipt(request.RequestId, out LocalExecutionReceipt existing))
            return existing;

        string executionId = ledger is IDispatchExecutionLedger dispatchLedger
            && dispatchLedger.TryGetBoundExecutionId(request.RequestId, out string boundExecutionId)
            ? boundExecutionId
            : this.NewExecutionId(request.RequestId);

        this.revision++;

        if (request.Args.Direction is null || !DirectionMap.TryGetValue(request.Args.Direction, out int directionInt))
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, "invalid_direction", null);

        if (!this.TryGetBoundActor(out Farmer? actor, out string guardReason) || actor is null)
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, guardReason, null);

        try
        {
            if (actor.isMoving() || this.active is not null || this.activeNavigate is not null || this.controller.HasActiveExecution)
                return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, "actor_moving", null);

            actor.faceDirection(directionInt);
        }
        catch (Exception nativeException)
        {
            // A failed native dispatch must still produce the one durable
            // terminal receipt for this exact execution; it must never escape
            // while a durable admission is pending.
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Uncertain,
                "face_direction_native_exception",
                $"direction={request.Args.Direction};native_dispatched=false;native_exception={nativeException.GetType().Name}",
                this.TryCreateLocalObservation(actor));
        }

        BridgeLocalObservation? observation = this.TryCreateLocalObservation(actor);
        if (actor.FacingDirection == directionInt)
        {
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Succeeded,
                "actor_facing_matches",
                $"direction={request.Args.Direction}",
                observation);
        }

        return this.RememberTerminal(
            request.RequestId,
            executionId,
            ExecutionState.Failed,
            "postcondition_failed",
            $"expected={directionInt};actual={actor.FacingDirection}",
            observation);
    }
}
