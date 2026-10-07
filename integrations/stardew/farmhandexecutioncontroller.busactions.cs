using System;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Abstractions;
using StardewValley;
using StardewValley.Locations;

namespace GameBuddy.Stardew;

/// <summary>
/// Bus transport (design: typed domain action over the native interaction seam).
///
/// The bus is NOT like the minecart: there is no reusable UI-free warp seam.
/// The fare, the driver check, the control freeze and the eight-second cutscene
/// are inlined in <c>BusStop.answerDialogue("Bus_Yes")</c>, so copying "check
/// conditions, deduct money, warpFarmer" would produce a bus that behaves
/// differently from the game's. Instead this action drives the native path:
///
/// <list type="number">
/// <item>verify the native facts itself (ticket machine adjacency, <c>ccVault</c>,
/// driver on duty, fare) so refusals carry named reasons instead of a dialogue;</item>
/// <item>call the native ticket-machine interaction (<c>BusStop.checkAction</c>)
/// to raise the game's own "buy a ticket" question;</item>
/// <item>answer it through the native dispatcher
/// (<c>GameLocation.answerDialogue(Response("Yes"))</c>) — the game deducts the
/// fare, freezes controls, walks the actor to the door and runs the cutscene;</item>
/// <item>wait for the arrival the world produces on its own and mint ONE terminal
/// receipt (<c>bus_arrived</c>) with the fare and the location pair.</item>
/// </list>
///
/// The action is therefore instantaneous at admission but long-lived: the receipt
/// arrives when <c>currentLocation</c> becomes the destination, and a deadline
/// bounds the wait. Everything between stays observable through the snapshot
/// revision, and any lifecycle invalidation terminates it honestly.
/// </summary>
internal sealed partial class ExecutionManager : IExecutionLedger, IDispatchExecutionLedger
{
    private const string BusStopLocationName = "BusStop";
    /// <summary>BusStop.checkAction's ticket-machine tile index (Buildings layer).</summary>
    private const int BusTicketMachineTileIndex = 1057;
    private const string BusDriverName = "Pam";
    private const int BusDriverTileX = 21;
    private const int BusDriverTileY = 10;
    private const string BusDestinationLocation = "Desert";

    private sealed record LocalBusRideSpec(
        string ExecutionId,
        string RequestId,
        string OriginLocation,
        int MoneyBefore,
        int TicketPrice,
        long DeadlineMs);

    private LocalBusRideSpec? activeBusRide;

    public LocalExecutionReceipt RequestLocalRideBus(BridgeExecutionRequest request, IExecutionLedger ledger)
    {
        if (ledger.TryGetExistingReceipt(request.RequestId, out LocalExecutionReceipt existing))
            return existing;

        string executionId = ledger is IDispatchExecutionLedger dispatchLedger
            && dispatchLedger.TryGetBoundExecutionId(request.RequestId, out string boundExecutionId)
            ? boundExecutionId
            : this.NewExecutionId(request.RequestId);

        if (!this.TryGetBoundActor(out Farmer? actor, out string guardReason) || actor is null)
            // The guard reason NAMES the failure (no bound actor / wrong scope / world not ready). This body used
            // to discard it with `out _` and report player_not_actionable for every identity failure, which is
            // the failure-mode collapse the review flagged.
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, guardReason, null);

        GameLocation? location = actor.currentLocation;
        if (location is null || !string.Equals(location.NameOrUniqueName, BusStopLocationName, StringComparison.Ordinal))
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                "bus_stop_not_current_location",
                $"expected={BusStopLocationName};actual={location?.NameOrUniqueName ?? "none"}");

        if (activeBusRide is not null)
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, "bus_ride_already_in_progress", null);

        if (!TryFindTicketMachine(location, out int ticketX, out int ticketY))
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, "bus_ticket_machine_unavailable", null);

        if (!IsAdjacentToActor(actor, ticketX, ticketY))
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                "bus_ticket_machine_out_of_reach",
                $"target={ticketX},{ticketY};tile={(int)actor.Tile.X},{(int)actor.Tile.Y}");

        // The native facts, read (not re-implemented) so a refusal is named.
        if (!Game1.MasterPlayer.mailReceived.Contains("ccVault"))
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, "vault_not_completed", null);

        if (!Game1.netWorldState.Value.canDriveYourselfToday.Value && !IsDriverOnDuty(location))
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, "no_driver", null);

        BusStop? busStop = location as BusStop;
        int ticketPrice = busStop?.TicketPrice ?? 500;
        if (actor.Money < ticketPrice)
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                "insufficient_money",
                $"required={ticketPrice};money={actor.Money}");

        int moneyBefore = actor.Money;
        string origin = location.NameOrUniqueName;
        long deadlineMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + 60_000;

        // Native interaction: raise the game's own ticket question, then let the
        // native dispatcher answer it. Neither call is re-implemented here, so the
        // fare, the freeze, the walk to the door and the cutscene all stay the
        // game's own behaviour.
        bool questioned;
        try
        {
            questioned = location.checkAction(new xTile.Dimensions.Location(ticketX, ticketY), Game1.viewport, actor);
        }
        catch (Exception nativeException)
        {
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Uncertain,
                "bus_ticket_machine_native_exception",
                $"target={ticketX},{ticketY};native_exception={nativeException.GetType().Name}");
        }

        if (!questioned)
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Uncertain,
                "bus_ticket_question_not_raised",
                $"target={ticketX},{ticketY}");

        if (Game1.activeClickableMenu is not StardewValley.Menus.DialogueBox { isQuestion: true })
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Uncertain,
                "bus_ticket_question_not_presented",
                $"target={ticketX},{ticketY}");

        bool answered;
        try
        {
            answered = location.answerDialogue(new Response("Yes", "Yes"));
        }
        catch (Exception nativeException)
        {
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Uncertain,
                "bus_ticket_answer_native_exception",
                $"native_exception={nativeException.GetType().Name}");
        }

        if (!answered)
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Uncertain,
                "bus_ticket_answer_not_consumed",
                $"money_before={moneyBefore}");

        this.activeBusRide = new LocalBusRideSpec(executionId, request.RequestId, origin, moneyBefore, ticketPrice, deadlineMs);
        this.revision++;
        LocalExecutionReceipt acceptedReceipt = new(
            executionId,
            request.RequestId,
            ExecutionState.Running,
            "bus_departure_started",
            this.revision,
            $"origin={origin};destination={BusDestinationLocation};fare={ticketPrice};money_before={moneyBefore}");
        this.Remember(acceptedReceipt);
        this.AddTrace(acceptedReceipt);
        return acceptedReceipt;
    }

    /// <summary>
    /// Called once per tick by the manager's Update. The world owns the departure
    /// (native cutscene + warp); this only observes the arrival it produced.
    /// </summary>
    public void UpdateBusRide()
    {
        if (this.activeBusRide is not { } ride)
            return;

        Farmer? actor = Game1.player;
        string arrival = actor?.currentLocation?.NameOrUniqueName ?? string.Empty;
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        if (string.Equals(arrival, BusDestinationLocation, StringComparison.Ordinal))
        {
            this.activeBusRide = null;
            this.revision++;
            LocalExecutionReceipt receipt = new(
                ride.ExecutionId,
                ride.RequestId,
                ExecutionState.Succeeded,
                "bus_arrived",
                this.revision,
                $"origin={ride.OriginLocation};destination={arrival};fare={ride.TicketPrice};money_before={ride.MoneyBefore};money_after={actor?.Money ?? ride.MoneyBefore}");
            this.Remember(receipt);
            this.AddTrace(receipt);
            this.PublishIdleAfterRelease(ride.ExecutionId, ride.RequestId);
            return;
        }

        if (nowMs > ride.DeadlineMs)
        {
            this.activeBusRide = null;
            this.revision++;
            LocalExecutionReceipt receipt = new(
                ride.ExecutionId,
                ride.RequestId,
                ExecutionState.Uncertain,
                "bus_arrival_unconfirmed",
                this.revision,
                $"origin={ride.OriginLocation};expected={BusDestinationLocation};observed={arrival};fare={ride.TicketPrice};money_before={ride.MoneyBefore}");
            this.Remember(receipt);
            this.AddTrace(receipt);
            this.PublishIdleAfterRelease(ride.ExecutionId, ride.RequestId);
        }
    }

    /// <summary>
    /// Lifecycle invalidation while a departure is in flight. The native cutscene
    /// may already have committed the warp, so this is only ever an uncertain
    /// terminal with the facts that were true when it started.
    /// </summary>
    public void InvalidateBusRide(string reasonCode)
    {
        if (this.activeBusRide is not { } ride)
            return;
        this.activeBusRide = null;
        this.revision++;
        LocalExecutionReceipt receipt = new(
            ride.ExecutionId,
            ride.RequestId,
            ExecutionState.Uncertain,
            "bus_departure_invalidated",
            this.revision,
            $"origin={ride.OriginLocation};expected={BusDestinationLocation};reason={reasonCode};fare={ride.TicketPrice};money_before={ride.MoneyBefore}");
        this.Remember(receipt);
        this.AddTrace(receipt);
        this.PublishIdleAfterRelease(ride.ExecutionId, ride.RequestId);
    }

    private static bool TryFindTicketMachine(GameLocation location, out int tileX, out int tileY)
    {
        tileX = 0;
        tileY = 0;
        xTile.Layers.Layer? buildings = location.map?.GetLayer("Buildings");
        xTile.Layers.Layer? back = location.map?.GetLayer("Back");
        if (buildings is null || back is null)
            return false;
        for (int y = 0; y < buildings.LayerHeight; y++)
        {
            for (int x = 0; x < buildings.LayerWidth; x++)
            {
                if (buildings.Tiles[x, y]?.TileIndex == BusTicketMachineTileIndex)
                {
                    tileX = x;
                    tileY = y;
                    return true;
                }
            }
        }
        return false;
    }

    /// <summary>
    /// Chebyshev-1 reach, the same interaction radius the native cursor sprite uses.
    /// Pure over the two tiles so the ring is testable without a live Farmer.
    /// </summary>
    internal static bool IsAdjacentTile(int actorTileX, int actorTileY, int tileX, int tileY) =>
        Math.Abs(actorTileX - tileX) <= 1 && Math.Abs(actorTileY - tileY) <= 1;

    private static bool IsAdjacentToActor(Farmer actor, int tileX, int tileY) =>
        IsAdjacentTile((int)actor.Tile.X, (int)actor.Tile.Y, tileX, tileY);

    private static bool IsDriverOnDuty(GameLocation location)
    {
        foreach (NPC character in location.characters)
        {
            if (character is null || !string.Equals(character.Name, BusDriverName, StringComparison.Ordinal))
                continue;
            return character.TilePoint.X == BusDriverTileX && character.TilePoint.Y == BusDriverTileY;
        }
        return false;
    }
}