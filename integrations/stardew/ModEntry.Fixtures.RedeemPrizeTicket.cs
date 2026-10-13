using System;
using System.Globalization;
using StardewModdingAPI;
using StardewValley;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    /// <summary>
    /// How many consecutive prize-track levels the Given search may try. The track is a pure function
    /// of (actor identity, level), so a level whose prize the pack cannot take is a fact about the
    /// SAVE, not about the action - the search exists to find a level that IS redeemable, never to
    /// weaken the precondition. Bounded so an unredeemable world fails loudly instead of looping.
    /// </summary>
    private const int RedeemPrizeTicketFixtureLevelSearchLimit = 32;

    /// <summary>
    /// redeem_prize_ticket pre-attachment Given: the actor holds ONE prize ticket and the machine's
    /// prize track stands on a level whose prize the pack does not already hold and can accept.
    ///
    /// Only those facts are established. The exchange itself - the prize the track derives, the native
    /// delivery, the ticket reduction and the `ticketPrizesClaimed` increment - belongs to production,
    /// and this fixture emits no receipt and never calls the action.
    ///
    /// WHY THE LEVEL IS SET HERE RATHER THAN FOUND: the track head is
    /// `getPrizeItem((int)Game1.stats.Get("ticketPrizesClaimed"))`, so the level is part of the
    /// starting state the action reads. The level is chosen by walking forward from the save's own
    /// value until the derivation is admissible, and the chosen state is asserted THROUGH THE
    /// PRODUCT'S OWN PREDICATE (`ExecutionManager.TryDescribePrizeRedemption`, the same one the
    /// handler reads) - so the fixture and the product cannot disagree, and an unredeemable state
    /// fails here with a named error that says which levels were tried and what rejected them, instead
    /// of surfacing later as a product refusal that looks like a bug.
    ///
    /// The prize must ALSO be absent from the pack, which is the one fact only the fixture can
    /// establish: "the prize entered the pack" is a readable world change only if the pack did not
    /// already hold that stack.
    /// </summary>
    private void InitializeNativeLocalRedeemPrizeTicketFixture(Farmer player)
    {
        player.Items.ReduceId(ExecutionManager.PrizeTicketItemId, int.MaxValue);
        int cleared = player.Items.CountId(ExecutionManager.PrizeTicketItemId);
        if (cleared != 0)
            throw new InvalidOperationException(
                $"fixture_native_local_redeem_prize_ticket_clear_failed:tickets={cleared.ToString(CultureInfo.InvariantCulture)}");

        if (player.addItemToInventory(ItemRegistry.Create(ExecutionManager.PrizeTicketItemId, 1)) is not null)
            throw new InvalidOperationException(
                "fixture_native_local_redeem_prize_ticket_ticket_not_granted:"
                    + $"inventory_full={player.isInventoryFull().ToString().ToLowerInvariant()};"
                    + $"slots={player.Items.Count.ToString(CultureInfo.InvariantCulture)}");

        int currentLevel = (int)Game1.stats.Get(ExecutionManager.TicketPrizesClaimedStatKey);
        string rejected = "none";
        string lastPrizeItemId = "none";
        string lastLevel = currentLevel.ToString(CultureInfo.InvariantCulture);
        int prizeLevel = currentLevel;
        string prizeItemId = string.Empty;
        int prizeStack = 0;
        bool ready = false;
        for (int offset = 0; offset < RedeemPrizeTicketFixtureLevelSearchLimit && !ready; offset++)
        {
            int candidate = currentLevel + offset;
            Game1.stats.Set(ExecutionManager.TicketPrizesClaimedStatKey, (uint)candidate);
            lastLevel = candidate.ToString(CultureInfo.InvariantCulture);
            if (!ExecutionManager.TryDescribePrizeRedemption(player, out _, out Item? prize, out _, out string refusal))
            {
                rejected = refusal;
                lastPrizeItemId = "none";
                continue;
            }

            lastPrizeItemId = prize!.QualifiedItemId;
            if (player.Items.CountId(lastPrizeItemId) != 0)
            {
                rejected = "prize_already_held";
                continue;
            }

            prizeLevel = candidate;
            prizeItemId = lastPrizeItemId;
            prizeStack = prize.Stack;
            ready = true;
        }

        if (!ready)
            throw new InvalidOperationException(
                "fixture_native_local_redeem_prize_ticket_not_redeemable:"
                    + $"levels_tried={RedeemPrizeTicketFixtureLevelSearchLimit.ToString(CultureInfo.InvariantCulture)};"
                    + $"first_level={currentLevel.ToString(CultureInfo.InvariantCulture)};last_level={lastLevel};"
                    + $"last_prize_item_id={lastPrizeItemId};rejected={rejected}");

        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log(
            "GameBuddy native-local-player fixture precondition: action=redeem_prize_ticket"
                + $";prize_level={prizeLevel.ToString(CultureInfo.InvariantCulture)}"
                + $";prize_item_id={prizeItemId}"
                + $";prize_stack={prizeStack.ToString(CultureInfo.InvariantCulture)}"
                + $";ticket_item_id={ExecutionManager.PrizeTicketItemId}"
                + $";tickets={player.Items.CountId(ExecutionManager.PrizeTicketItemId).ToString(CultureInfo.InvariantCulture)}",
            LogLevel.Info);
    }
}
