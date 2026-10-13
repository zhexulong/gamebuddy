using System;
using System.Globalization;
using StardewValley;
using StardewValley.Menus;

namespace GameBuddy.Stardew;

// Redeeming one prize ticket for the `redeem_prize_ticket` action.
//
// THE SEAM, read line by line rather than assumed. The exchange is NOT owned by a reusable game
// method and it is NOT in the click handler: `PrizeTicketMenu.receiveLeftClick`
// (Menus/PrizeTicketMenu.cs:151-160) only arms UI state (`gettingReward = true`, `getRewardTimer = 0`,
// a delayed sound) and the exchange itself is the timed branch inside `PrizeTicketMenu.update`
// (Menus/PrizeTicketMenu.cs:180-190), which fires 2000ms later:
//
//     if (!Game1.player.addItemToInventoryBool(currentPrizeTrack[0]))
//         Game1.createItemDebris(currentPrizeTrack[0], Game1.player.getStandingPosition(), 1, Game1.player.currentLocation);
//     Game1.player.Items.ReduceId("PrizeTicket", 1);      // Inventory.cs:250, `int ReduceId(string, int)`
//     Game1.stats.Increment("ticketPrizesClaimed");       // Stats.cs:896, `uint Increment(string, uint)`
//     currentPrizeTrack.RemoveAt(0); ...                  // UI track state only
//
// So there is no single settlement to call, and this action does NOT drive the menu, its click
// handler, its timers or its track list: it reproduces the exchange's PUBLIC CALL SEQUENCE on the
// public faces the native branch itself uses. That is the B1b form the design record already ruled
// on (`design/domains/stardew/menu-bound-and-ui-boundary.md` §2.1 `PrizeMachine` row and §2.1.2:
// the choice is re-derivable from public state, and the three writes are all public API), and it is
// the same shape `accept_daily_quest` shipped with for the same reason.
//
// THE CHOICE, from public state only. The menu's track head is
// `currentPrizeTrack[0] = getPrizeItem((int)Game1.stats.Get("ticketPrizesClaimed"))`
// (Menus/PrizeTicketMenu.cs:40), so the prize is re-derived here from those two public faces:
// `public static Item PrizeTicketMenu.getPrizeItem(int prizeLevel)` (:66) and the level
// `(int)Game1.stats.Get("ticketPrizesClaimed")` (Stats.cs:840, the same `ticketPrizesClaimed` stat
// `PrizeTicketMenu.update` increments at :185 and `GameLocation.PrizeMachine` reads for the machine).
// `getPrizeItem` seeds its own `Utility.CreateRandom(Game1.uniqueIDForThisGame,
// Game1.player.UniqueMultiplayerID)` per call, so the same level derives the same item for the same
// actor - which is why this is a re-derivation and not a guess. The menu's private track list is
// never read.
//
// ARGUMENTS: none, and that is the frozen contract rather than an omission. The protocol has no
// optional arguments and never has; there is no target a caller could name here. The subject is the
// actor's own ticket stack and the machine's own track position, both native state published by no
// projection, so a client-supplied `expectedPrizeLevel` would add a value the caller cannot have read
// and the Mod would have to re-derive anyway. The `{x,y,expectedTargetId}` facility shape does not
// apply either: the exchange writes no world tile and no world object, which is why
// `dismount_transport`/`advance_day`/`ride_bus` are the precedents this action follows.
//
// REFUSALS, each naming its own live fact: no prize ticket in the pack
// (`prize_ticket_unavailable`), and the pack unable to take the prize the game's own
// `Farmer.couldInventoryAcceptThisItem` refuses (`prize_inventory_full`). Both are read BEFORE any
// write, so a refused request moves nothing - including the ticket. The native branch's fallback for a
// full pack is to drop the prize on the ground (`createItemDebris`, :182); this action refuses by name
// instead of silently switching its postcondition to a ground drop, because the declared postcondition
// is the prize in the PACK.
//
// POSTCONDITION is an OBSERVABLE WORLD CHANGE read back after the writes, BOTH halves of it: the
// ticket stack fell by exactly one (`Inventory.CountId`, :177) AND the pack holds exactly the delivered
// prize stack more than it did. One half alone would be duplication or destruction: a receipt that
// reported only the ticket drop could not tell a redemption from a loss, and one that reported only the
// prize could not tell a redemption from a gift. The stat (`ticketPrizesClaimed`) is the third,
// corroborating read. A body that ran but whose fresh postcondition cannot be read is `Uncertain`,
// never a success.
//
// PHASE. One synchronous store with no await, so there is no cancel window inside it: admission is
// `General` - the seam drives no tool lifecycle and starts no swing, the same profile
// `accept_daily_quest` and `clear_fish_pond` admit against.
internal sealed partial class ExecutionManager
{
    /// <summary>The wire identity of the item the exchange consumes, exactly as the menu writes it.</summary>
    internal const string PrizeTicketItemId = "(O)PrizeTicket";

    /// <summary>
    /// The stat that names the prize track's head level, read and incremented exactly as
    /// `PrizeTicketMenu.update` does.
    /// </summary>
    internal const string TicketPrizesClaimedStatKey = "ticketPrizesClaimed";

    /// <summary>
    /// Redeem one prize ticket through the same public call sequence the machine's own reward branch
    /// performs. Every refusal names the live fact it read, and nothing is consumed before the prize
    /// has actually been delivered.
    /// </summary>
    public LocalExecutionReceipt RequestLocalRedeemPrizeTicket(string requestId, long requestedDeadlineMs)
    {
        if (this.receiptsByRequestId.TryGetValue(requestId, out LocalExecutionReceipt? existing)) return existing;
        this.revision++;
        string executionId = Guid.NewGuid().ToString("N");
        long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (this.AdmitExecution(requestId, executionId, requestedDeadlineMs, nowMs, AdmissionActionabilityProfile.General) is LocalExecutionReceipt admissionRejection)
            return admissionRejection;

        return this.ExecuteRedeemPrizeTicket(executionId, requestId);
    }

    /// <summary>
    /// The one execution body. It re-reads the preconditions against the live world rather than
    /// trusting the admission read, because admission and the body are two separate game-thread reads.
    /// </summary>
    private LocalExecutionReceipt ExecuteRedeemPrizeTicket(string executionId, string requestId)
    {
        Farmer player = Game1.player;
        if (!TryDescribePrizeRedemption(player, out int prizeLevel, out Item? prize, out int ticketsBefore, out string refusal))
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Rejected,
                refusal,
                $"ticket_item_id={PrizeTicketItemId};tickets={ticketsBefore.ToString(CultureInfo.InvariantCulture)};"
                    + $"prize_level={prizeLevel.ToString(CultureInfo.InvariantCulture)}");

        string prizeItemId = prize!.QualifiedItemId;
        int prizeStack = prize.Stack;
        int prizeHeldBefore = player.Items.CountId(prizeItemId);
        int prizesClaimedBefore = prizeLevel;

        // THE CALL SEQUENCE of Menus/PrizeTicketMenu.cs:180-185, in its own order: the prize first,
        // and the ticket and the stat only once the prize has actually been delivered. The delivery
        // verdict is reported rather than assumed, and a false verdict consumes nothing.
        bool delivered = player.addItemToInventoryBool(prize);
        if (delivered)
        {
            player.Items.ReduceId(PrizeTicketItemId, 1);
            Game1.stats.Increment(TicketPrizesClaimedStatKey);
        }

        int ticketsAfter = player.Items.CountId(PrizeTicketItemId);
        int prizeHeldAfter = player.Items.CountId(prizeItemId);
        int prizesClaimedAfter = (int)Game1.stats.Get(TicketPrizesClaimedStatKey);

        string evidence =
            $"prize_level={prizeLevel.ToString(CultureInfo.InvariantCulture)};prize_item_id={prizeItemId};"
            + $"prize_stack={prizeStack.ToString(CultureInfo.InvariantCulture)};"
            + $"prize_held_before={prizeHeldBefore.ToString(CultureInfo.InvariantCulture)};"
            + $"prize_held_after={prizeHeldAfter.ToString(CultureInfo.InvariantCulture)};"
            + $"ticket_item_id={PrizeTicketItemId};"
            + $"tickets_before={ticketsBefore.ToString(CultureInfo.InvariantCulture)};"
            + $"tickets_after={ticketsAfter.ToString(CultureInfo.InvariantCulture)};"
            + $"prizes_claimed_before={prizesClaimedBefore.ToString(CultureInfo.InvariantCulture)};"
            + $"prizes_claimed_after={prizesClaimedAfter.ToString(CultureInfo.InvariantCulture)};"
            + $"prize_delivered={delivered.ToString().ToLowerInvariant()}";

        // The postcondition is the LIVE PACK and the LIVE STAT read after the call, both halves of it.
        bool postcondition = delivered
            && ticketsAfter == ticketsBefore - 1
            && prizesClaimedAfter == prizesClaimedBefore + 1
            && prizeHeldAfter - prizeHeldBefore == prizeStack;

        return postcondition
            ? this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "prize_ticket_redeemed", evidence)
            : this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "redeem_prize_ticket_postcondition_unavailable", evidence);
    }

    /// <summary>
    /// The one place that answers "can this actor redeem a prize ticket right now, and for what?", shared
    /// by the handler, the refused-request evidence and the fixture's Given so the product and its
    /// declared precondition can never disagree.
    ///
    /// The prize is derived from the game's own public faces: the level from
    /// <c>Game1.stats</c>'s <c>ticketPrizesClaimed</c> and the item from
    /// <c>PrizeTicketMenu.getPrizeItem</c>, which is also what the machine's own track head holds. The
    /// pack's capacity is the game's own <c>Farmer.couldInventoryAcceptThisItem</c> predicate - the
    /// question the prize-ticket dispenser itself asks before handing a ticket over
    /// (GameLocation.cs:9009) - so "the whole prize stack fits" is decided by the game, not by us.
    /// </summary>
    internal static bool TryDescribePrizeRedemption(
        Farmer player,
        out int prizeLevel,
        out Item? prize,
        out int tickets,
        out string refusal)
    {
        prizeLevel = 0;
        prize = null;
        tickets = 0;
        refusal = string.Empty;
        if (player is null)
        {
            refusal = "prize_machine_unavailable";
            return false;
        }

        tickets = player.Items.CountId(PrizeTicketItemId);
        prizeLevel = (int)Game1.stats.Get(TicketPrizesClaimedStatKey);
        prize = PrizeTicketMenu.getPrizeItem(prizeLevel);
        if (tickets <= 0)
        {
            refusal = "prize_ticket_unavailable";
            return false;
        }

        if (prize is null)
        {
            refusal = "prize_unavailable";
            return false;
        }

        if (!player.couldInventoryAcceptThisItem(prize))
        {
            refusal = "prize_inventory_full";
            return false;
        }

        return true;
    }
}
