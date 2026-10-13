using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using StardewValley;
using StardewValley.SpecialOrders;

namespace GameBuddy.Stardew;

// Accepting one of the special orders a board is offering, for the `accept_special_order` action.
//
// THE SEAM. The board's accept write is inline in `SpecialOrdersBoard.receiveLeftClick`
// (Menus/SpecialOrdersBoard.cs:122-148): `acceptedSpecialOrderTypes.Add(GetOrderType())` at :130/:142,
// then `AddSpecialOrder(questKey, generationSeed)` at :132/:144. The CREATION half of that write has a
// public, menu-free face:
//
//     public void FarmerTeam.AddSpecialOrder(string id, int? generationSeed = null, bool forceRepeatable = false)
//         // FarmerTeam.cs:681
//
// which builds the order with `SpecialOrder.GetSpecialOrder(id, generationSeed)` (:687) and appends it to
// the team's live order list (:701, `specialOrders.Add(specialOrder)`). Its callers are Event.cs:1506,
// TriggerActionManager.cs:162 and DebugCommands.cs:2928 - none of them a menu. It is the settlement
// because it is the exact creation step the board's own Accept branch performs, through the same public
// method, and it owns the creation of the `SpecialOrder` (the data lookup, the seed, the randomized
// elements) so nothing about the order's construction is re-implemented here.
//
// We never open the board, never call `receiveLeftClick`, and never synthesize a click. The board is only
// where a player READS the offer; naming the order is what this action does.
//
// WHAT WE DO ABOUT `acceptedSpecialOrderTypes`. The board writes that marker too, and this action
// reproduces it, for three concrete reasons rather than by imitation:
//   * it is DURABLE - `FarmerTeam.acceptedSpecialOrderTypes` (:99) is serialized by SaveGame
//     (SaveGame.cs:391/:926);
//   * it is the game's own record of "this board has been used", and it is what hides the board's Accept
//     buttons (`SpecialOrdersBoard.UpdateButtons`, :94-98) and what gates the town board's own action
//     tile (`Town.cs:1091`, `!team.acceptedSpecialOrderTypes.Contains("")`) and the Desert Festival's
//     board (DesertFestival.cs:903). `AddSpecialOrder` alone does not set it, so omitting it would leave
//     the world saying "you have not accepted from this board" while an order is active - half an accept;
//   * its key is DERIVABLE from the resolved target without opening any board, because a board only ever
//     shows orders of its own type (`GetAvailableSpecialOrder(index, GetOrderType())` filters on
//     `orderType.Value == type`, :704-718), so the marker key IS the resolved order's own `orderType`.
// The marker is therefore also a named refusal precondition (`special_order_board_already_used`): a second
// accept from a board the game itself has already used is refused rather than performed, because the
// board's own accept branch is unreachable once the marker is set.
//
// ARGUMENTS are exactly `{ expectedTargetId }`, all required (the wire has NO optional argument), and
// there is no coordinate: the offer is the player team's own state (`FarmerTeam.availableSpecialOrders`,
// :96), not a tile. `expectedTargetId` is the opaque id `DiscoverSpecialOrderTargets` publishes; it binds
// the day, the order's `questKey`, its `orderType` and its `generationSeed`, so a request names the offer
// it read rather than a raw `SpecialOrder`, and a request from another day (or against a refreshed pool)
// is refused by name instead of silently accepting a different order.
//
// REFUSALS, each naming its own live fact: the id no longer names a live available order
// (`special_order_target_moved`), the board's pool is empty (`special_order_unavailable`), an order with
// that key is already active (`special_order_already_active`), the board the order belongs to has already
// been used (`special_order_board_already_used`), the order's data id resolves to nothing
// (`special_order_unavailable`), or the order was completed and its data is not repeatable
// (`special_order_not_acceptable`). The last three mirror the three SILENT early-returns inside
// `AddSpecialOrder` (:683-700) one for one: the seam is `void` and refuses by doing nothing, so turning
// each of its no-ops into a named refusal is what stops a call that changed nothing from reporting a
// success.
//
// POSTCONDITION is an OBSERVABLE WORLD CHANGE read back after the writes: the team's order list grew by
// exactly one and now contains an order with that `questKey` whose `questState` is `InProgress`, and the
// board-type marker is set. A body that ran but whose fresh postcondition cannot be read is `Uncertain`,
// never a success.
//
// PHASE. One synchronous store with no await, so once the first field is written the body is past any
// cancel point; admission is `General`, the same profile `accept_daily_quest` and `clear_fish_pond` use,
// because the seam drives no tool lifecycle and starts no swing.
internal sealed partial class ExecutionManager
{
    /// <summary>
    /// Accept one special order the player team is currently offering, through the same public writes the
    /// board's own Accept branch performs. Every refusal names the live fact it read.
    /// </summary>
    public LocalExecutionReceipt RequestLocalAcceptSpecialOrder(
        string requestId,
        string expectedTargetId,
        long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;

        SpecialOrderTargetResolution resolution = ResolveSpecialOrderTarget(expectedTargetId);
        if (!resolution.Accepted)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, resolution.ReasonCode, resolution.Evidence);

        return this.ExecuteAcceptSpecialOrder(executionId, requestId, expectedTargetId);
    }

    /// <summary>
    /// The one execution body. It re-resolves the offer and re-reads the preconditions against the live
    /// world, because admission and the body are two separate game-thread reads.
    /// </summary>
    private LocalExecutionReceipt ExecuteAcceptSpecialOrder(string executionId, string requestId, string expectedTargetId)
    {
        SpecialOrderTargetResolution resolution = ResolveSpecialOrderTarget(expectedTargetId);
        if (!resolution.Accepted)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, resolution.ReasonCode, resolution.Evidence);

        SpecialOrder order = resolution.Order!;
        FarmerTeam team = Game1.player.team;
        string orderType = order.orderType.Value;
        // The town board's own type is the empty string (`Data/SpecialOrders` OrderType "", which
        // `GetSpecialOrder` trims). Evidence values may not be empty, so it is reported as the literal
        // `none`, the same encoding the fish-pond receipt uses for its own absent nouns.
        string reportedType = orderType.Length == 0 ? "none" : orderType;
        bool markerBefore = team.acceptedSpecialOrderTypes.Contains(orderType);
        int ordersBefore = team.specialOrders.Count;

        // THE WRITE HALF of SpecialOrdersBoard.cs:130-133, on the public native members it writes. The
        // marker is reproduced deliberately (see the file header); `AddSpecialOrder` is the public
        // creation step the board's own branch calls.
        team.acceptedSpecialOrderTypes.Add(orderType);
        team.AddSpecialOrder(order.questKey.Value, order.generationSeed.Value);

        int ordersAfter = team.specialOrders.Count;
        SpecialOrder? added = team.specialOrders.FirstOrDefault(candidate => string.Equals(candidate.questKey.Value, order.questKey.Value, StringComparison.Ordinal));
        bool presentAfter = added is not null;
        bool inProgressAfter = added is not null && added.questState.Value == SpecialOrderStatus.InProgress;
        bool markerAfter = team.acceptedSpecialOrderTypes.Contains(orderType);
        bool accepted = presentAfter && inProgressAfter && ordersAfter == ordersBefore + 1 && markerAfter;

        string evidence =
            $"special_order_id={expectedTargetId};board_type={reportedType};quest_key={order.questKey.Value};"
            + $"generation_seed={order.generationSeed.Value.ToString(CultureInfo.InvariantCulture)};"
            + $"board_marker_before={markerBefore.ToString().ToLowerInvariant()};"
            + $"board_marker_after={markerAfter.ToString().ToLowerInvariant()};"
            + $"orders_before={ordersBefore.ToString(CultureInfo.InvariantCulture)};"
            + $"orders_after={ordersAfter.ToString(CultureInfo.InvariantCulture)};"
            + $"order_present_after={presentAfter.ToString().ToLowerInvariant()};"
            + $"order_in_progress_after={inProgressAfter.ToString().ToLowerInvariant()}";

        return accepted
            ? this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "special_order_accepted", evidence)
            : this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "special_order_not_observed", evidence);
    }

    /// <summary>
    /// One resolved offer, or the named reason the published target no longer matches the live world.
    /// </summary>
    internal sealed record SpecialOrderTargetResolution(
        bool Accepted,
        string ReasonCode,
        string Evidence,
        SpecialOrder? Order)
    {
        internal static SpecialOrderTargetResolution Reject(string reasonCode, string evidence) =>
            new(false, reasonCode, evidence, null);
    }

    /// <summary>
    /// Re-derives the offered order on the game thread. Every mismatch is a NAMED refusal, never a silent
    /// re-target, and the last checks mirror the three silent early-returns in `AddSpecialOrder`
    /// (FarmerTeam.cs:683-700) so the seam cannot no-op behind a green receipt.
    /// </summary>
    internal static SpecialOrderTargetResolution ResolveSpecialOrderTarget(string expectedTargetId)
    {
        FarmerTeam team = Game1.player.team;
        if (team.availableSpecialOrders.Count == 0)
            return SpecialOrderTargetResolution.Reject(
                "special_order_unavailable",
                $"published={expectedTargetId};day={Game1.Date.TotalDays.ToString(CultureInfo.InvariantCulture)};available=0");

        SpecialOrder? matched = team.availableSpecialOrders.FirstOrDefault(
            candidate => string.Equals(BuildSpecialOrderTargetId(candidate), expectedTargetId, StringComparison.Ordinal));
        if (matched is null)
            return SpecialOrderTargetResolution.Reject(
                "special_order_target_moved",
                $"published={expectedTargetId};day={Game1.Date.TotalDays.ToString(CultureInfo.InvariantCulture)};"
                    + $"available={team.availableSpecialOrders.Count.ToString(CultureInfo.InvariantCulture)};"
                    + $"candidates={DescribeAvailableSpecialOrders(team)}");

        string questKey = matched.questKey.Value;
        string orderType = matched.orderType.Value;
        string reportedType = orderType.Length == 0 ? "none" : orderType;
        string identity =
            $"quest_key={questKey};board_type={reportedType};"
            + $"generation_seed={matched.generationSeed.Value.ToString(CultureInfo.InvariantCulture)};published={expectedTargetId}";

        // AddSpecialOrder's own first guard (:683-686): an order with this key is already active.
        if (team.specialOrders.Any(candidate => string.Equals(candidate.questKey.Value, questKey, StringComparison.Ordinal)))
            return SpecialOrderTargetResolution.Reject("special_order_already_active", $"{identity};active=true");

        // The board's own accept branch is unreachable once the board's type is marked
        // (SpecialOrdersBoard.UpdateButtons :94-98), so accepting another order for it would perform a
        // world change the board itself cannot perform.
        if (team.acceptedSpecialOrderTypes.Contains(orderType))
            return SpecialOrderTargetResolution.Reject("special_order_board_already_used", $"{identity};board_marker=true");

        // AddSpecialOrder's own second guard (:687-692): the data id must resolve to an order at all.
        SpecialOrder? rebuilt = SpecialOrder.GetSpecialOrder(questKey, matched.generationSeed.Value);
        if (rebuilt is null)
            return SpecialOrderTargetResolution.Reject("special_order_unavailable", $"{identity};data_missing=true");

        // AddSpecialOrder's own third guard (:693-700): a completed order is only re-acceptable when its
        // own data declares it repeatable.
        if (team.completedSpecialOrders.Contains(questKey))
        {
            StardewValley.GameData.SpecialOrders.SpecialOrderData? data = rebuilt.GetData();
            if (data is null || !data.Repeatable)
                return SpecialOrderTargetResolution.Reject("special_order_not_acceptable", $"{identity};completed=true;repeatable=false");
        }

        return new SpecialOrderTargetResolution(true, "accepted", string.Empty, matched);
    }

    /// <summary>
    /// Opaque, stable selector for one offered order: the day, the order's own data key, its board type
    /// and the seed the pool generation chose for it. The day is part of the name on purpose - the pool is
    /// regenerated at day rollover (Game1.cs:8259), and the seed is drawn from the day, so a request from a
    /// previous run can never silently name today's offer.
    /// </summary>
    internal static string BuildSpecialOrderTargetId(SpecialOrder order) =>
        BuildSpecialOrderTargetId(order.questKey.Value, order.orderType.Value, order.generationSeed.Value);

    internal static string BuildSpecialOrderTargetId(string questKey, string orderType, int generationSeed)
    {
        string raw = string.Create(
            CultureInfo.InvariantCulture,
            $"{Game1.Date.TotalDays}:{questKey}:{orderType}:{generationSeed}");
        return $"special_order_{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    /// <summary>
    /// The offers the actor can accept right now, projected read-only: each live available order whose
    /// board has not been used, that is not already active, and whose data id still resolves. Nothing is
    /// synthesized - the published set is exactly the set the action's own precondition accepts, so a
    /// published target is one a request will take.
    /// </summary>
    internal static IReadOnlyList<BridgeSpecialOrderTarget> DiscoverSpecialOrderTargets()
    {
        FarmerTeam team = Game1.player.team;
        List<BridgeSpecialOrderTarget> result = new();
        foreach (SpecialOrder order in team.availableSpecialOrders)
        {
            string orderType = order.orderType.Value;
            if (team.acceptedSpecialOrderTypes.Contains(orderType))
                continue;
            if (team.specialOrders.Any(candidate => string.Equals(candidate.questKey.Value, order.questKey.Value, StringComparison.Ordinal)))
                continue;
            if (SpecialOrder.GetSpecialOrder(order.questKey.Value, order.generationSeed.Value) is null)
                continue;
            result.Add(new BridgeSpecialOrderTarget(
                BuildSpecialOrderTargetId(order),
                order.questKey.Value,
                order.orderType.Value,
                order.generationSeed.Value));
            if (result.Count >= 4)
                break;
        }
        return result;
    }

    /// <summary>
    /// The order keys the team currently holds, projected read-only so a caller can see the accept change
    /// the published fact without any other authority. Bounded; the keys are `Data/SpecialOrders` ids.
    /// </summary>
    internal static IReadOnlyList<string> DiscoverActiveSpecialOrderKeys()
    {
        List<string> keys = new();
        foreach (SpecialOrder order in Game1.player.team.specialOrders)
        {
            keys.Add(order.questKey.Value);
            if (keys.Count >= 8)
                break;
        }
        return keys;
    }

    /// <summary>
    /// The live candidates, bounded and joined with `|`, for a refusal that has to say WHAT the id no
    /// longer names. Order keys are `Data/SpecialOrders` ids, so they carry no evidence separator.
    /// </summary>
    private static string DescribeAvailableSpecialOrders(FarmerTeam team)
    {
        List<string> keys = new();
        foreach (SpecialOrder order in team.availableSpecialOrders)
        {
            keys.Add(order.questKey.Value);
            if (keys.Count >= 4)
                break;
        }
        return keys.Count == 0 ? "none" : string.Join("|", keys);
    }
}
