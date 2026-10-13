using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewValley;
using StardewValley.GameData.Museum;
using StardewValley.Locations;

namespace GameBuddy.Stardew;

public sealed partial class ModEntry
{
    /// <summary>
    /// claim_museum_reward pre-attachment Given: the museum owes the actor at least one item reward, and the
    /// actor has collected none of them yet.
    ///
    /// Only that declared Given is established. The collection itself - the native
    /// <c>LibraryMuseum.getRewardsForPlayer</c> enumeration (which grants the non-item rewards as it
    /// computes) and the <c>LibraryMuseum.OnRewardCollected</c> grab callback - belongs to production, and
    /// this fixture emits no receipt and never calls the action.
    ///
    /// WHY THE DONATIONS ARE SET HERE RATHER THAN FOUND: the action COLLECTS the rewards, so the starting
    /// state has to be one that HAS rewards to collect. A save carries whatever donations it happens to
    /// have, so the fixture donates every item the GAME ITSELF calls donatable
    /// (<c>LibraryMuseum.IsItemSuitableForDonation</c>, LibraryMuseum.cs:113 - the same predicate the
    /// museum's own donation menu admits with), which satisfies every reward requirement however that
    /// requirement is expressed: the per-context-tag counts and the "all artifacts" form alike, computed by
    /// the game's own <c>GetDonatedByContextTag</c> (:482). Nothing about the reward table is reproduced
    /// here.
    ///
    /// The Given is then asserted THROUGH THE PRODUCT'S OWN predicate
    /// (<c>ExecutionManager.ReadCollectableMuseumRewards</c> plus
    /// <c>ExecutionManager.ResolveMuseumRewardTarget</c>, the exact resolver a request is admitted
    /// through), so the fixture and the product cannot disagree.
    /// </summary>
    private void InitializeNativeLocalClaimMuseumRewardFixture(Farmer player)
    {
        LibraryMuseum museum = Game1.getLocationFromName(ExecutionManager.MuseumLocationName) as LibraryMuseum
            ?? throw new InvalidOperationException("fixture_native_local_claim_museum_reward_museum_missing");

        Dictionary<string, MuseumRewards> data = DataLoader.MuseumRewards(Game1.content);
        if (data.Count == 0)
            throw new InvalidOperationException("fixture_native_local_claim_museum_reward_reward_data_missing");

        // The Given's first half: a museum that has received enough donations to owe rewards. The pieces are
        // laid out inside the museum's own donation bounds (getMuseumDonationBounds, :550) and stored in the
        // unqualified form the game itself stores (MuseumMenu.cs:217 writes `item3.ItemId`).
        Game1.netWorldState.Value.MuseumPieces.Clear();
        Rectangle bounds = museum.getMuseumDonationBounds();
        if (bounds.Width <= 0 || bounds.Height <= 0)
            throw new InvalidOperationException("fixture_native_local_claim_museum_reward_donation_bounds_invalid");

        int capacity = bounds.Width * bounds.Height;
        int placed = 0;
        foreach (string rawId in ItemRegistry.RequireTypeDefinition("(O)").GetAllIds())
        {
            if (placed >= capacity)
                break;
            if (!LibraryMuseum.IsItemSuitableForDonation("(O)" + rawId, checkDonatedItems: false))
                continue;
            Game1.netWorldState.Value.MuseumPieces[new Vector2(bounds.X + placed % bounds.Width, bounds.Y + placed / bounds.Width)] = rawId;
            placed++;
        }
        if (placed == 0)
            throw new InvalidOperationException("fixture_native_local_claim_museum_reward_no_donatable_items");

        // The Given's second half: nothing has been collected yet - neither a reward's own completion flag
        // nor any reward item's collection marker - so a fresh run is not refused by its own leftovers.
        foreach (KeyValuePair<string, MuseumRewards> entry in data)
        {
            player.mailReceived.Remove(entry.Key);
            if (entry.Value.RewardItemId is null)
                continue;
            player.mailReceived.Remove(museum.getRewardItemKey(ExecutionManager.CreateMuseumRewardItem(entry.Value)));
        }

        List<(string RewardKey, Item Item)> collectable = ExecutionManager.ReadCollectableMuseumRewards(museum, player);
        if (collectable.Count == 0)
            throw new InvalidOperationException(
                $"fixture_native_local_claim_museum_reward_no_collectable_reward:donated={placed.ToString(CultureInfo.InvariantCulture)};"
                    + $"rewards={data.Count.ToString(CultureInfo.InvariantCulture)}");

        string targetId = ExecutionManager.BuildMuseumRewardTargetId(
            museum.NameOrUniqueName,
            collectable.Select(entry => entry.RewardKey).ToArray());
        ExecutionManager.MuseumRewardTargetResolution resolution = ExecutionManager.ResolveMuseumRewardTarget(targetId);
        if (!resolution.Accepted)
            throw new InvalidOperationException(
                $"fixture_native_local_claim_museum_reward_not_acceptable:donated={placed.ToString(CultureInfo.InvariantCulture)};"
                    + $"reason={resolution.ReasonCode};detail={resolution.Evidence}");

        this.nativeLocalPlayerFixtureInitialized = true;
        this.Monitor.Log(
            "GameBuddy native-local-player fixture precondition: action=claim_museum_reward"
                + $";location={museum.NameOrUniqueName}"
                + $";donated={placed.ToString(CultureInfo.InvariantCulture)}"
                + $";collectable={collectable.Count.ToString(CultureInfo.InvariantCulture)}"
                + $";target={targetId}"
                + $";actor_location={player.currentLocation?.NameOrUniqueName ?? "unknown"}",
            LogLevel.Info);
    }
}
