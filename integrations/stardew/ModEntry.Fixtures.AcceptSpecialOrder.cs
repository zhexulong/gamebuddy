using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using StardewModdingAPI;
using StardewValley;
using StardewValley.SpecialOrders;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    /// <summary>
    /// accept_special_order pre-attachment Given: the player team is offering exactly one special order
    /// that no board has been used for and that is not already active.
    ///
    /// Only that declared Given is established. The acceptance itself - the board's own
    /// `acceptedSpecialOrderTypes` marker and the `FarmerTeam.AddSpecialOrder` creation write - belongs to
    /// production, and this fixture emits no receipt and never calls the action.
    ///
    /// WHY THE OFFER IS SET HERE RATHER THAN FOUND: the action TAKES the offer, so the starting state has to
    /// be known. The fixture first asks the game for its own offer pool through the game's own generator
    /// (<c>SpecialOrder.UpdateAvailableSpecialOrders</c>, SpecialOrder.cs:442 - the same call the board's
    /// constructor makes at SpecialOrdersBoard.cs:41 and the day rollover makes at Game1.cs:8259). Only when
    /// that chain yields nothing for a board this save can reach does it fall back to the game's own order
    /// factory (<c>SpecialOrder.GetSpecialOrder</c>, :524) over the ids <c>Data/SpecialOrders</c> itself
    /// declares, so the Given is still an order the game could produce rather than one invented here.
    ///
    /// The Given is asserted THROUGH THE PRODUCT'S OWN resolver
    /// (<c>ExecutionManager.ResolveSpecialOrderTarget</c>) - the exact predicate a request is admitted
    /// through - so the fixture and the product cannot disagree, and an unacceptable state fails here with a
    /// named error instead of surfacing later as a product refusal that looks like a bug.
    /// </summary>
    private void InitializeNativeLocalAcceptSpecialOrderFixture(Farmer player)
    {
        // The board's own pool generator, called the way the board itself calls it.
        SpecialOrder.UpdateAvailableSpecialOrders("", forceRefresh: true);
        if (player.team.availableSpecialOrders.Count == 0)
            SpecialOrder.UpdateAvailableSpecialOrders("Qi", forceRefresh: true);

        SpecialOrder? chosen = player.team.availableSpecialOrders.FirstOrDefault()
            ?? BuildNativeLocalAcceptSpecialOrderFallbackOrder();

        if (chosen is null)
            throw new InvalidOperationException(
                $"fixture_native_local_accept_special_order_no_offer:day={Game1.Date.TotalDays.ToString(CultureInfo.InvariantCulture)};boards=0");

        // Reduce the pool to exactly ONE offer: the runner resolves a single published target, so a pool
        // that happened to hold two would make the run ambiguous rather than wrong.
        player.team.availableSpecialOrders.Clear();
        player.team.availableSpecialOrders.Add(chosen);

        // The other half of the Given the product reads: this order's board has NOT been used, and no order
        // with this key is already active, so a fresh run is not refused by its own leftover state.
        player.team.acceptedSpecialOrderTypes.Clear();
        foreach (SpecialOrder stale in player.team.specialOrders
                     .Where(candidate => string.Equals(candidate.questKey.Value, chosen.questKey.Value, StringComparison.Ordinal))
                     .ToArray())
            player.team.specialOrders.Remove(stale);

        // The Given, asserted through the product's own resolver.
        string targetId = ExecutionManager.BuildSpecialOrderTargetId(chosen);
        ExecutionManager.SpecialOrderTargetResolution resolution = ExecutionManager.ResolveSpecialOrderTarget(targetId);
        if (!resolution.Accepted)
            throw new InvalidOperationException(
                $"fixture_native_local_accept_special_order_not_acceptable:quest_key={chosen.questKey.Value};"
                    + $"board_type={(chosen.orderType.Value.Length == 0 ? "none" : chosen.orderType.Value)};"
                    + $"reason={resolution.ReasonCode};detail={resolution.Evidence}");

        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log(
            "GameBuddy native-local-player fixture precondition: action=accept_special_order"
                + $";location={player.currentLocation?.NameOrUniqueName ?? "unknown"}"
                + $";quest_key={chosen.questKey.Value}"
                + $";board_type={(chosen.orderType.Value.Length == 0 ? "none" : chosen.orderType.Value)}"
                + $";generation_seed={chosen.generationSeed.Value.ToString(CultureInfo.InvariantCulture)}"
                + $";available={player.team.availableSpecialOrders.Count.ToString(CultureInfo.InvariantCulture)}"
                + $";day={Game1.Date.TotalDays.ToString(CultureInfo.InvariantCulture)}",
            LogLevel.Info);
    }

    /// <summary>
    /// The game's own order factory over the ids <c>Data/SpecialOrders</c> declares, used only when the
    /// generator chain offers nothing for a board this save can reach. The seed is the one the pool
    /// generator itself uses (SpecialOrder.cs:475), so the constructed order is one the game would have
    /// built rather than an arbitrary shape.
    /// </summary>
    private static SpecialOrder? BuildNativeLocalAcceptSpecialOrderFallbackOrder()
    {
        int seed = Utility.CreateRandom(Game1.uniqueIDForThisGame, Game1.stats.DaysPlayed * 1.3).Next();
        foreach (KeyValuePair<string, StardewValley.GameData.SpecialOrders.SpecialOrderData> entry in DataLoader.SpecialOrders(Game1.content))
        {
            if (!string.IsNullOrWhiteSpace(entry.Value.OrderType) && !string.Equals(entry.Value.OrderType.Trim(), "Qi", StringComparison.Ordinal))
                continue;
            SpecialOrder? order = SpecialOrder.GetSpecialOrder(entry.Key, seed);
            if (order is not null)
                return order;
        }
        return null;
    }
}
