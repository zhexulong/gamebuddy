using System.Globalization;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.Tools;
using StardewValley.Characters;
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
        string executionId = Guid.NewGuid().ToString("N");
        this.navigationExecutionIds.Add(executionId);
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (deadlineMs <= nowMs || deadlineMs > nowMs + TimeSpan.FromMinutes(1).TotalMilliseconds)
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
        if (!this.TryStartApproach(approach, out string reasonCode))
        {
            this.active = null;
            this.activeNavigate = null;
            this.activeNavigationCoordinator = null;
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, reasonCode ?? "approach_unavailable", "phase=approaching;arm=failed");
        }

        LocalExecutionReceipt accepted = new(executionId, requestId, ExecutionState.Accepted, "accepted", this.revision, "navigation=accepted;phase=approaching");
        this.Remember(accepted);
        this.AddTrace(accepted);
        return accepted;
    }

}
