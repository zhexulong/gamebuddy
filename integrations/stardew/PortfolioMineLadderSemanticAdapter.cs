using System.Security.Cryptography;
using System.Text;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;
using StardewValley.Locations;
using StardewValley.Pathfinding;

namespace GameBuddy.Stardew;

/// <summary>
/// Target-version semantic edge for the bounded M8 mine-ladder action. All
/// facts and the native call are owned by the game thread; the bridge supplies
/// only the immutable execution authority tuple.
/// </summary>
internal sealed class PortfolioMineLadderSemanticAdapter : IPortfolioMineLadderSemanticAdapter, IPortfolioMineLadderPendingOwner
{
    private readonly PortfolioConfig config;
    private readonly Func<bool> isBindingCurrent;
    private readonly Func<long> nextRevision;
    private readonly Func<PortfolioMineLadderTransitionStartedObservation, bool> observeTransitionStarted;
    private readonly Func<PortfolioMineLadderPostconditionObservation, PortfolioMineLadderActionReceipt> observePostcondition;
    private readonly Func<string, string, string, string, long, PortfolioScope, PortfolioMineLadderActionReceipt> fail;
    private readonly Func<string, bool> armNativeTransition;
    private PendingExecution? pending;

    internal PortfolioMineLadderSemanticAdapter(
        PortfolioConfig config,
        Func<bool> isBindingCurrent,
        Func<long> nextRevision,
        Func<PortfolioMineLadderTransitionStartedObservation, bool> observeTransitionStarted,
        Func<PortfolioMineLadderPostconditionObservation, PortfolioMineLadderActionReceipt> observePostcondition,
        Func<string, string, string, string, long, PortfolioScope, PortfolioMineLadderActionReceipt> fail,
        Func<string, bool> armNativeTransition)
    {
        this.config = config;
        this.isBindingCurrent = isBindingCurrent;
        this.nextRevision = nextRevision;
        this.observeTransitionStarted = observeTransitionStarted;
        this.observePostcondition = observePostcondition;
        this.fail = fail;
        this.armNativeTransition = armNativeTransition;
    }

    internal PortfolioMineLadderFreshObservation CreateFreshObservation(
        PortfolioMineLadderActionRequest request,
        PortfolioScope scope,
        long revision)
    {
        bool playerAvailable = Game1.player is not null
            && Game1.player.UniqueMultiplayerID.ToString() == scope.LocalPlayerId;
        bool worldReady = Context.IsWorldReady && Game1.hasLoadedGame;
        bool singlePlayer = !Context.IsMultiplayer && Game1.IsMasterGame
            && Game1.getAllFarmers().Count() == 1
            && Game1.player is not null
            && Game1.player.UniqueMultiplayerID == Game1.MasterPlayer.UniqueMultiplayerID;
        bool policyAllowed = this.config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.MineLadderAction);
        int currentFloor = 0;
        int lowestMineLevel = 0;
        bool mineEntryObserved = false;
        bool ladderInteractionAvailable = false;
        if (worldReady && singlePlayer && Game1.player is not null
            && Game1.player.currentLocation is MineShaft mine)
        {
            mineEntryObserved = true;
            currentFloor = mine.mineLevel;
            lowestMineLevel = MineShaft.lowestLevelReached;
            ladderInteractionAvailable = TryFindLadderApproach(Game1.player, mine, out _);
        }
        // Native materialization uses Math.Min(lowestLevelReached, 120), so
        // progress above 120 still materializes the 120 checkpoint.
        int targetFloor = currentFloor + 1;
        bool checkpointValid = PortfolioMineLadderProjection.IsSelectableCheckpoint(targetFloor);
        // Probe reports literal current progress. It is informational only: the
        // first native N→N+1 descent is admitted independently below.
        bool targetUnlocked = mineEntryObserved && lowestMineLevel >= targetFloor;
        // The selected checkpoint is the native semantic target. Stardew has no
        // opaque ladder object or ID; this value is only a deterministic,
        // non-secret correlation capability bound to the complete fresh facts.
        string opaqueCorrelationId = BuildOpaqueCorrelationId(
            request.RequestId, request.TraceId, scope, revision, targetFloor,
            currentFloor, lowestMineLevel);
        // Do not claim ownership of a target during observation. Begin may reject
        // this request before the semantic boundary, and such a request must not
        // replace a pending target owned by another execution.
        return new PortfolioMineLadderFreshObservation(
            request.RequestId, request.TraceId, revision, scope,
            Fresh: true,
            PlayerAvailable: playerAvailable && singlePlayer,
            WorldReady: worldReady,
            PolicyAllowed: policyAllowed,
            MineEntryObserved: mineEntryObserved,
            CurrentFloor: currentFloor,
            LowestMineLevel: lowestMineLevel,
            UnlockedLevelObserved: mineEntryObserved && checkpointValid,
            TargetUnlocked: targetUnlocked,
            LadderInteractionAvailable: ladderInteractionAvailable,
            OpaqueLadderTarget: opaqueCorrelationId,
            TargetFloor: targetFloor);
    }

    internal bool TryReadTerminalFreshFloor(PortfolioMineLadderFreshFloorRequest request, PortfolioScope scope,
        int targetFloor, long currentRevision, out PortfolioMineLadderFreshFloor? floor)
    {
        floor = null;
        if (request is null || !request.IsValid || !request.Scope.Equals(scope)
            || DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= request.DeadlineMs
            || !this.TryReadLiveFacts(scope, targetFloor, allowSelectedFloor: true,
                requireLadderInteraction: false, out int currentFloor, out int lowestMineLevel)
            || currentFloor != targetFloor
            || currentRevision <= request.ExpectedRevision)
            return false;
        floor = new PortfolioMineLadderFreshFloor(request.RequestId, request.TraceId, request.ExecutionId,
            scope, currentRevision, Fresh: true, currentFloor, lowestMineLevel);
        return true;
    }

    public bool IsAvailable => this.config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.MineLadderAction)
        && Context.IsWorldReady && Game1.hasLoadedGame && this.isBindingCurrent();

    public bool RequestMineLadder(
        PortfolioMineLadderAdapterContext context,
        out PortfolioMineLadderAdapterResult? result)
    {
        result = null;
        PendingExecution? existing = this.pending;
        if (existing is not null && !Matches(existing, context))
            return false;
        if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= context.DeadlineMs
            || !this.TryReadLiveFacts(context.Scope, context.TargetFloor, allowSelectedFloor: false,
                requireLadderInteraction: false, out _, out _))
        {
            result = NativeOperationFailed(context);
            return true;
        }

        Farmer player = Game1.player!;
        if (player.currentLocation is not MineShaft oldMine
            || !TryFindLadderApproach(player, oldMine, out LadderApproach approach))
        {
            result = NativeOperationFailed(context);
            return true;
        }
        PendingExecution candidate = existing ?? new PendingExecution(
            context.RequestId, context.TraceId, context.Scope, context.OpaqueLadderTarget,
            context.TargetFloor, context.ExpectedRevision, context.DeadlineMs,
            context.CancellationToken,
            player, oldMine, oldMine.Name, oldMine.mineLevel, -1, EdgeGeneration: 0) { ExecutionId = context.ExecutionId };
        candidate = candidate with { ExecutionId = context.ExecutionId };

        this.pending = candidate;
        // The action owns its approach. It is deliberately not a public movement
        // request and its target is derived from the fresh MineShaft map.
        if (!IsAccessibleLadderInteraction(player, oldMine))
        {
            if (!player.CanMove || Game1.activeClickableMenu is not null || Game1.eventUp
                || player.controller is not null || approach.Controller is null)
            {
                this.DiscardPending(context.ExecutionId);
                result = NativeOperationFailed(context);
                return true;
            }
            PathFindController controller = approach.Controller;
            player.controller = controller;
            candidate = candidate with
            {
                ApproachController = controller,
                ApproachTile = approach.StandingTile,
                LadderTile = approach.LadderTile,
                ApproachFacing = approach.Facing,
                ApproachStartedTick = Game1.ticks
            };
            this.pending = candidate;
            result = new PortfolioMineLadderAdapterResult(
                context.RequestId, context.TraceId, context.ExecutionId, context.Scope,
                context.ExpectedRevision, context.OpaqueLadderTarget, context.TargetFloor,
                TransitionArmed: false) { ApproachPending = true };
            return true;
        }

        if (!this.TryIssueNativeTransition(candidate, context, out bool edgeIssued))
        {
            this.DiscardPending(context.ExecutionId);
            if (!edgeIssued)
            {
                result = new PortfolioMineLadderAdapterResult(
                    context.RequestId, context.TraceId, context.ExecutionId, context.Scope,
                    context.ExpectedRevision, context.OpaqueLadderTarget, context.TargetFloor,
                    TransitionArmed: false) { NativeOperationFailed = true };
                return true;
            }
            return false;
        }
        result = new PortfolioMineLadderAdapterResult(
            context.RequestId, context.TraceId, context.ExecutionId, context.Scope,
            context.ExpectedRevision, context.OpaqueLadderTarget, context.TargetFloor,
            TransitionArmed: true);
        return true;
    }

    private static PortfolioMineLadderAdapterResult NativeOperationFailed(PortfolioMineLadderAdapterContext context)
        => new(
            context.RequestId, context.TraceId, context.ExecutionId, context.Scope,
            context.ExpectedRevision, context.OpaqueLadderTarget, context.TargetFloor,
            TransitionArmed: false)
        {
            NativeOperationFailed = true
        };

    private void ObserveNativeRequestWarp(PendingExecution candidate, LocationRequest request, LocationRequest.Callback handler)
    {
        PendingExecution? current = this.pending;
        if (current is null || !ReferenceEquals(current, candidate)
            || !Matches(current, new PortfolioMineLadderAdapterContext(
                candidate.RequestId, candidate.TraceId, candidate.ExecutionId, candidate.CancellationToken,
                candidate.Scope, candidate.OpaqueTarget, candidate.TargetFloor,
                candidate.ExpectedRevision, candidate.DeadlineMs))
            || current.NativeRequestCompleted || !ReferenceEquals(current.NativeRequest, request))
            return;

        bool retainedForWarped = false;
        try
        {
            if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= current.DeadlineMs
                || !this.isBindingCurrent()
                || Game1.player is null
                || !ReferenceEquals(Game1.locationRequest, request)
                || !MatchesExpectedRequest(request, current.TargetFloor)
                || request.Location is not MineShaft target
                || !ReferenceEquals(Game1.player.currentLocation, target))
            {
                TryFail(current);
                return;
            }

            current = current with { NativeRequestCompleted = true, TransitionRevision = this.nextRevision() };
            this.pending = current;
            PortfolioMineLadderTransitionStartedObservation transition = new(
                current.RequestId, current.TraceId, current.ExecutionId, current.TransitionRevision, current.Scope,
                Fresh: true, PlayerAvailable: true, WorldReady: true, PolicyAllowed: true,
                MineEntryObserved: true, NativeLadderTransitionObserved: true,
                current.OpaqueTarget, current.TargetFloor);
            bool observed;
            try
            {
                observed = this.observeTransitionStarted(transition);
            }
            catch
            {
                TryFail(current);
                return;
            }
            if (!observed)
            {
                TryFail(current);
                return;
            }
            retainedForWarped = true;
        }
        finally
        {
            // Detach only after the coordinator has observed the transition (or
            // terminalized its rejection), while the exact correlation is still
            // available to that callback.
            request.OnWarp -= handler;
            if (retainedForWarped && this.pending is PendingExecution retained
                && retained.ExecutionId == current.ExecutionId)
                this.pending = retained with { NativeRequestHandler = null };
            else if (!retainedForWarped)
                DiscardPending(current.ExecutionId);
        }
    }

    /// <summary>Bounded game-thread watchdog for approach and native transition.</summary>
    internal void Watchdog(long nowMs)
    {
        PendingExecution? candidate = this.pending;
        if (candidate is null)
            return;
        if (nowMs >= candidate.DeadlineMs)
        {
            TryFail(candidate);
            DiscardPending(candidate.ExecutionId);
            return;
        }
        if (candidate.ApproachController is not PathFindController controller)
            return;
        Farmer player = candidate.Player;
        if (ReferenceEquals(player.controller, controller))
            return;
        // Only the action-owned controller may complete this approach. A
        // replacement controller is an external lifecycle change, not arrival;
        // never dispatch the native ladder transition from that state.
        if (player.controller is not null)
        {
            TryFail(candidate);
            DiscardPending(candidate.ExecutionId);
            return;
        }
        bool arrived = Vector2.DistanceSquared(player.Tile,
            new Vector2(candidate.ApproachTile.X, candidate.ApproachTile.Y)) <= 0.04f;
        if (!arrived || player.currentLocation is not MineShaft mine
            || !ReferenceEquals(mine, candidate.OldMine)
            || !IsAccessibleLadderInteraction(player, mine))
        {
            TryFail(candidate);
            DiscardPending(candidate.ExecutionId);
            return;
        }
        player.Halt();
        player.controller = null;
        PendingExecution settled = candidate with { ApproachController = null };
        this.pending = settled;
        PortfolioMineLadderAdapterContext context = new(
            settled.RequestId, settled.TraceId, settled.ExecutionId, settled.CancellationToken,
            settled.Scope, settled.OpaqueTarget, settled.TargetFloor,
            settled.ExpectedRevision, settled.DeadlineMs);
        if (!this.TryIssueNativeTransition(settled, context, out bool edgeIssued))
        {
            if (edgeIssued)
                TryFail(settled);
            else
                _ = this.fail(settled.RequestId, settled.TraceId, settled.ExecutionId,
                    "native_operation_failed", this.nextRevision(), settled.Scope);
            DiscardPending(settled.ExecutionId);
        }
    }

    /// <summary>Consumes only the later SMAPI Player.Warped event.</summary>
    internal void ObserveWarped(WarpedEventArgs args)
    {
        PendingExecution? candidate = this.pending;
        if (candidate is null)
            return;
        if (!candidate.NativeRequestCompleted)
            return;

        // Unrelated or early Warped events are not watchdog signals. Only the
        // later event correlated to this exact native edge may advance or fail it.
        if (!MatchesWarp(candidate, args))
            return;

        try
        {
            if (!this.TryReadLiveFacts(candidate.Scope, candidate.TargetFloor, allowSelectedFloor: true,
                    requireLadderInteraction: false, out int actualFloor, out int lowestMineLevel)
                || actualFloor != candidate.TargetFloor
                || lowestMineLevel < candidate.TargetFloor
                || DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= candidate.DeadlineMs)
            {
                TryFail(candidate);
                return;
            }

            PortfolioMineLadderPostconditionObservation postcondition = new(
                candidate.RequestId, candidate.TraceId, candidate.ExecutionId, this.nextRevision(), candidate.Scope,
                Fresh: true, PlayerAvailable: true, WorldReady: true, PolicyAllowed: true,
                MineEntryObserved: true, ActualCurrentFloor: actualFloor,
                LowestMineLevel: lowestMineLevel, LowestMineLevelObserved: true,
                candidate.OpaqueTarget, candidate.TargetFloor);
            try
            {
                _ = this.observePostcondition(postcondition);
            }
            catch
            {
                TryFail(candidate);
            }
        }
        finally
        {
            DiscardPending(candidate.ExecutionId);
        }
    }

    private bool TryReadLiveFacts(PortfolioScope scope, int targetFloor, bool allowSelectedFloor,
        bool requireLadderInteraction, out int currentFloor, out int lowestMineLevel)
    {
        currentFloor = 0;
        lowestMineLevel = 0;
        // Re-evaluate the action policy in this game-thread admission immediately
        // before the native effect. An authorization observed during probe or
        // request parsing is not authority to enter the mine after revocation.
        if (!this.config.IsPortfolioActionAuthorized(PortfolioBridgeProtocol.MineLadderAction)
            || !this.isBindingCurrent() || !Context.IsWorldReady || !Game1.hasLoadedGame
            || Context.IsMultiplayer || !Game1.IsMasterGame
            || Game1.getAllFarmers().Count() != 1 || Game1.player is null
            || Game1.player.UniqueMultiplayerID != Game1.MasterPlayer.UniqueMultiplayerID
            || Game1.player.UniqueMultiplayerID.ToString() != scope.LocalPlayerId
            || Game1.player.currentLocation is not MineShaft mine
            || !TryFindLadderApproach(Game1.player, mine, out _)
            || (requireLadderInteraction && !IsAccessibleLadderInteraction(Game1.player, mine)))
            return false;

        currentFloor = mine.mineLevel;
        lowestMineLevel = MineShaft.lowestLevelReached;
        if (!PortfolioMineLadderProjection.IsSelectableCheckpoint(targetFloor)
            || currentFloor < 0 || currentFloor > PortfolioBridgeProtocol.MineLadderMaximumFloor
            || lowestMineLevel < currentFloor)
            return false;

        // Before enterMine, the only admissible target is the next floor. After
        // the native transition, the caller additionally binds the observed
        // current floor to targetFloor; this path proves progress reached it.
        return allowSelectedFloor
            ? lowestMineLevel >= targetFloor
            : targetFloor == currentFloor + 1;
    }

    // Exact public-state projection of MineShaft.checkAction case 173.
    private static bool IsAccessibleLadderInteraction(Farmer player, MineShaft mine)
    {
        var tile = player.GetGrabTile();
        var location = new xTile.Dimensions.Location((int)tile.X, (int)tile.Y);
        return PortfolioMineLadderProjection.IsAccessibleLadderInteraction(
            player.IsLocalPlayer,
            Utility.tileWithinRadiusOfPlayer((int)tile.X, (int)tile.Y, 1, player),
            mine.mineLevel,
            mine.getTileIndexAt(location, "Buildings"));
    }

    private static bool TryFindLadderApproach(Farmer player, MineShaft mine, out LadderApproach approach)
    {
        approach = default;
        if (mine.map?.Layers is null || mine.map.Layers.Count == 0)
            return false;
        var layer = mine.map.GetLayer("Buildings");
        if (layer is null)
            return false;
        for (int x = 0; x < layer.LayerWidth; x++)
        for (int y = 0; y < layer.LayerHeight; y++)
        {
            var ladderTile = new xTile.Dimensions.Location(x, y);
            if (mine.getTileIndexAt(ladderTile, "Buildings") != 173)
                continue;
            (int X, int Y, int Facing)[] candidates =
            {
                (x - 1, y, Game1.right), (x + 1, y, Game1.left),
                (x, y - 1, Game1.down), (x, y + 1, Game1.up),
            };
            foreach ((int candidateX, int candidateY, int facing) in candidates)
            {
                if (candidateX < 0 || candidateY < 0
                    || candidateX >= layer.LayerWidth || candidateY >= layer.LayerHeight)
                    continue;
                Vector2 standingTile = new(candidateX, candidateY);
                bool alreadyAtStandingTile = Vector2.DistanceSquared(player.Tile, standingTile) <= 0.04f;
                if (alreadyAtStandingTile && player.FacingDirection == facing)
                {
                    approach = new LadderApproach(null, new Point(x, y), new Point(candidateX, candidateY), facing);
                    return true;
                }
                PathFindController controller;
                try
                {
                    controller = new PathFindController(player, mine,
                        new Point(candidateX, candidateY), facing, null, 10000);
                }
                catch
                {
                    continue;
                }
                if (alreadyAtStandingTile || controller.pathToEndPoint is { Count: > 0 })
                {
                    approach = new LadderApproach(controller, new Point(x, y), new Point(candidateX, candidateY), facing);
                    return true;
                }
            }
        }
        return false;
    }

    private bool TryIssueNativeTransition(PendingExecution candidate, PortfolioMineLadderAdapterContext context, out bool edgeIssued)
    {
        edgeIssued = false;
        if (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() >= context.DeadlineMs
            || !this.TryReadLiveFacts(context.Scope, context.TargetFloor, allowSelectedFloor: false,
                requireLadderInteraction: true, out _, out _))
            return false;
        LocationRequest? previousRequest = Game1.locationRequest;
        PendingExecution beforeArm = candidate with { NativeCallInProgress = true };
        this.pending = beforeArm;
        if (!this.armNativeTransition(candidate.ExecutionId))
            return false;
        // ArmNativeTransition may synchronously re-enter cancellation or
        // invalidation. Never reconstruct pending state after that callback:
        // only the exact still-owned, un-cancelled execution may cross the
        // native call boundary. Once arm succeeded, any failed re-check is
        // uncertain because the coordinator has reserved the native edge.
        edgeIssued = true;
        PendingExecution? armedBeforeNative = this.pending;
        if (armedBeforeNative is null
            || !Matches(armedBeforeNative, context)
            || armedBeforeNative.ExecutionId != candidate.ExecutionId
            || !armedBeforeNative.NativeCallInProgress
            || armedBeforeNative.EdgeIssued
            || !this.isBindingCurrent())
            return false;
        candidate = armedBeforeNative with
        {
            EdgeGeneration = armedBeforeNative.EdgeGeneration + 1,
            EdgeIssuedTick = Game1.ticks
        };
        this.pending = candidate;
        try
        {
            Game1.enterMine(context.TargetFloor);
            candidate.OldMine.playSound("stairsdown");
        }
        catch
        {
            return false;
        }
        PendingExecution? armed = this.pending;
        LocationRequest? request = Game1.locationRequest;
        if (armed is null || !Matches(armed, context)
            || armed.EdgeGeneration != candidate.EdgeGeneration
            || armed.EdgeIssuedTick > Game1.ticks
            || request is null || ReferenceEquals(request, previousRequest)
            || !MatchesExpectedRequest(request, context.TargetFloor))
            return false;
        PendingExecution pending = armed with { NativeCallInProgress = false, NativeRequest = request };
        LocationRequest.Callback? handler = null;
        handler = () => this.ObserveNativeRequestWarp(pending, request, handler!);
        pending = pending with { NativeRequestHandler = handler };
        this.pending = pending;
        request.OnWarp += handler;
        return true;
    }

    private void TryFail(PendingExecution candidate)
    {
        try
        {
            string reasonCode = candidate.EdgeIssued
                ? "native_operation_uncertain"
                : "native_operation_failed";
            _ = this.fail(candidate.RequestId, candidate.TraceId, candidate.ExecutionId,
                reasonCode, this.nextRevision(), candidate.Scope);
        }
        catch
        {
            // The caller still detaches the exact handler and clears the
            // correlation state when terminalization itself throws.
        }
    }

    internal void DiscardPendingForInvalidation()
    {
        PendingExecution? candidate = this.pending;
        if (candidate is null)
            return;
        if (candidate.NativeRequest is LocationRequest request && candidate.NativeRequestHandler is LocationRequest.Callback handler)
            request.OnWarp -= handler;
        if (candidate.ApproachController is PathFindController approachController
            && ReferenceEquals(candidate.Player.controller, approachController))
        {
            candidate.Player.Halt();
            candidate.Player.controller = null;
        }
        this.pending = null;
    }

    public void DiscardPending(string executionId)
    {
        PendingExecution? candidate = this.pending;
        if (candidate is null || candidate.ExecutionId != executionId)
            return;
        if (candidate.NativeRequest is LocationRequest request && candidate.NativeRequestHandler is LocationRequest.Callback handler)
            request.OnWarp -= handler;
        if (candidate.ApproachController is PathFindController approachController
            && ReferenceEquals(candidate.Player.controller, approachController))
        {
            candidate.Player.Halt();
            candidate.Player.controller = null;
        }
        this.pending = null;
    }

    private static bool MatchesExpectedRequest(LocationRequest request, int targetFloor)
        => request.Name == MineShaft.GetLevelName(targetFloor)
            && request.Location is MineShaft target
            && target.mineLevel == targetFloor;

    private static bool Matches(PendingExecution candidate, PortfolioMineLadderAdapterContext context) =>
        candidate.RequestId == context.RequestId
        && candidate.TraceId == context.TraceId
        && candidate.Scope.Equals(context.Scope)
        && candidate.OpaqueTarget == context.OpaqueLadderTarget
        && candidate.TargetFloor == context.TargetFloor
        && candidate.ExpectedRevision == context.ExpectedRevision
        && candidate.DeadlineMs == context.DeadlineMs
        && candidate.CancellationToken == context.CancellationToken;

    private static bool MatchesWarp(PendingExecution candidate, WarpedEventArgs args) =>
        candidate.EdgeIssued
        && args.Player == candidate.Player
        && candidate.OldMine is not null
        && candidate.OldMineName == candidate.OldMine.Name
        && candidate.OldMineFloor == candidate.OldMine.mineLevel
        && args.OldLocation == candidate.OldMine
        && args.NewLocation == candidate.NativeRequest?.Location
        && args.NewLocation is MineShaft mine
        && mine.mineLevel == candidate.TargetFloor
        && args.Player.currentLocation == args.NewLocation
        && candidate.EdgeIssuedTick <= Game1.ticks;

    private static string BuildOpaqueCorrelationId(
        string requestId,
        string traceId,
        PortfolioScope scope,
        long revision,
        int targetFloor,
        int currentFloor,
        int lowestMineLevel)
    {
        string canonicalFacts = string.Join("\n", new[]
        {
            "requestId=" + requestId,
            "traceId=" + traceId,
            "scope.integrationId=" + scope.IntegrationId,
            "scope.topology=" + scope.Topology,
            "scope.saveId=" + scope.SaveId,
            "scope.worldId=" + scope.WorldId,
            "scope.localPlayerId=" + scope.LocalPlayerId,
            "scope.companionId=" + scope.CompanionId,
            "scope.bindingGeneration=" + scope.BindingGeneration,
            "scope.bindingHash=" + scope.BindingHash,
            "revision=" + revision,
            "targetFloor=" + targetFloor,
            "currentFloor=" + currentFloor,
            "lowestMineLevel=" + lowestMineLevel
        });
        return "mine_ladder_correlation_"
            + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonicalFacts))).ToLowerInvariant();
    }

    private sealed record PendingExecution(
        string RequestId,
        string TraceId,
        PortfolioScope Scope,
        string OpaqueTarget,
        int TargetFloor,
        long ExpectedRevision,
        long DeadlineMs,
        string CancellationToken,
        Farmer Player,
        MineShaft OldMine,
        string OldMineName,
        int OldMineFloor,
        int EdgeIssuedTick,
        long EdgeGeneration)
    {
        internal string ExecutionId { get; init; } = string.Empty;
        internal long TransitionRevision { get; init; }
        internal bool NativeCallInProgress { get; init; }
        internal LocationRequest? NativeRequest { get; init; }
        internal LocationRequest.Callback? NativeRequestHandler { get; init; }
        internal bool NativeRequestCompleted { get; init; }
        internal PathFindController? ApproachController { get; init; }
        internal Point ApproachTile { get; init; }
        internal Point LadderTile { get; init; }
        internal int ApproachFacing { get; init; }
        internal int ApproachStartedTick { get; init; }
        internal bool EdgeIssued => EdgeGeneration > 0;
    }

    private readonly record struct LadderApproach(
        PathFindController? Controller,
        Point LadderTile,
        Point StandingTile,
        int Facing);
}
