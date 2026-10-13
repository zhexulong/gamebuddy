using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using StardewValley;
using StardewValley.GameData.Museum;
using StardewValley.Locations;

namespace GameBuddy.Stardew;

// Collecting the museum's donation rewards, for the `claim_museum_reward` action.
//
// THE SEAM. There is no persistent container and no single native "claim" method: the museum reward menu
// is built from a COMPUTED list. Two public native members are the settlement, and they are exactly the
// two the game's own flow uses:
//
//   public List<Item> LibraryMuseum.getRewardsForPlayer(Farmer player)
//       // Locations/LibraryMuseum.cs:264 - enumerates the rewards the player may collect, and is what
//       // `OpenRewardMenu` (:358-361) hands to the ItemGrabMenu it opens.
//   public void LibraryMuseum.OnRewardCollected(Item item, Farmer who)
//       // Locations/LibraryMuseum.cs:385 - the game's own grab callback: `OpenRewardMenu` passes it as
//       // the ItemGrabMenu's `behaviorOnItemGrab` (:360), which ItemGrabMenu invokes the moment an item
//       // is picked up (ItemGrabMenu.cs:946/:814). It grants that reward's non-item effects and records
//       // the item as collected through `getRewardItemKey` (:234, :399-406).
//
// The ITEM half of the pickup is the menu's own deposit (`Farmer.addItemToInventoryBool`, the exact call
// ItemGrabMenu makes when the held reward is taken into the pack, :845/:990); the action makes the same
// call so a collected reward is not merely recorded but actually received. That call reports `false`
// rather than destroying an item that does not fit, so a failed deposit is a postcondition failure here,
// never a silent loss.
//
// QUERY = COLLECT, ONCE. This is the trap this seam has and the reason the body is shaped the way it is:
// `getRewardsForPlayer` is NOT a pure query. It clears `_itemToRewardsLookup` (:266) and calls
// `AddNonItemRewards` for every reward whose item it did not list (:292), i.e. asking what you are owed is
// itself part of being paid. It also is the ONLY thing that populates `_itemToRewardsLookup`, which
// `OnRewardCollected` looks up by the very item instances it returned (:391). So the body calls it EXACTLY
// ONCE per request, holds the returned instances, and never re-queries: a second call would both re-run
// every non-item reward action and overwrite the lookup the collected callbacks depend on.
//
// DISCOVERY has to be read-only, so it does NOT call `getRewardsForPlayer`. It re-derives the same set
// through the game's own read-only predicates and the identical key test:
//   * `GetDonatedByContextTag` (:482) - the donated-count-by-tag map, pure;
//   * `CanCollectReward` (:512) - the game's own "may this reward be collected" test, pure;
//   * `getRewardItemKey` (:234) plus `player.mailReceived`, which is the exact test
//     `AddRewardItemIfUncollected` (:325-333) applies, i.e. exactly the rewards `getRewardsForPlayer`
//     would RETURN.
// Nothing is written and nothing is synthesized, so the published target names exactly what a claim would
// collect.
//
// ARGUMENTS are exactly `{ expectedTargetId }`, all required (the wire has NO optional argument), and there
// is no coordinate: the reward set is computed state, not a tile. `expectedTargetId` binds the museum's
// location plus the sorted reward-data keys it would collect, so a request that has already been served is
// refused by name instead of silently collecting the NEXT reward set.
//
// REFUSALS, each naming its own live fact: the world has no museum location (`museum_reward_unavailable`),
// there is nothing to collect today (`museum_rewards_empty`), the published id no longer describes the live
// reward set (`museum_reward_target_moved`), the native call threw (`museum_reward_native_exception`), or
// the call ran without the observed collection (`museum_reward_not_observed`, `Uncertain`).
//
// POSTCONDITION is an OBSERVABLE WORLD CHANGE read back after the call: every reward the call returned is
// recorded as collected (`mailReceived`, or `hasOrWillReceiveMail` for the pending-mail case the game's own
// callback treats the same way), every one of them is now in the pack, and a FRESH read of the read-only
// collectable set is EMPTY. A call that recorded nothing is `Uncertain`, never a success; the receipt says
// which of those three reads failed.
//
// PHASE. One synchronous store with no await; admission is `General`, the same profile `claim_mail_attachment`
// and `accept_daily_quest` use.
internal sealed partial class ExecutionManager
{
    /// <summary>The museum's own location name. The reward set belongs to this one location in the world,
    /// so the target is resolved from it rather than from where the actor happens to stand: as
    /// `LibraryMuseum.getRewardsForPlayer` itself shows, collecting is not a spatial act.</summary>
    internal const string MuseumLocationName = "ArchaeologyHouse";

    /// <summary>
    /// Collect every museum reward the actor is entitled to right now, through the same two public native
    /// members the reward menu's own flow uses. Every refusal names the live fact it read.
    /// </summary>
    public LocalExecutionReceipt RequestLocalClaimMuseumReward(
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

        MuseumRewardTargetResolution resolution = ResolveMuseumRewardTarget(expectedTargetId);
        if (!resolution.Accepted)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, resolution.ReasonCode, resolution.Evidence);

        return this.ExecuteClaimMuseumReward(executionId, requestId, expectedTargetId);
    }

    /// <summary>
    /// The one execution body. It re-resolves the reward set against the live world (admission and the body
    /// are two separate game-thread reads), calls the native enumeration exactly once, and then re-reads
    /// the world for the postcondition. See the file header for why nothing may be queried twice.
    /// </summary>
    private LocalExecutionReceipt ExecuteClaimMuseumReward(string executionId, string requestId, string expectedTargetId)
    {
        MuseumRewardTargetResolution resolution = ResolveMuseumRewardTarget(expectedTargetId);
        if (!resolution.Accepted)
            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, resolution.ReasonCode, resolution.Evidence);

        LibraryMuseum museum = resolution.Museum!;
        Farmer player = Game1.player;
        int collectableBefore = resolution.CollectableCount;
        int mailBefore = player.mailReceived.Count;
        int unitsBefore = CountInventoryUnits(player);

        List<Item> rewards;
        try
        {
            // THE SEAM, first half. It both returns what may be collected (the items) and grants the
            // non-item rewards, and it is the only writer of the lookup the callbacks below need. Called
            // ONCE.
            rewards = museum.getRewardsForPlayer(player);
        }
        catch (Exception nativeException)
        {
            return this.RememberTerminal(
                requestId,
                executionId,
                ExecutionState.Uncertain,
                "museum_reward_native_exception",
                $"target={expectedTargetId};location={museum.NameOrUniqueName};"
                    + $"native_exception={nativeException.GetType().Name};native_call_ran_unknown=true");
        }

        int delivered = 0;
        int recorded = 0;
        foreach (Item item in rewards)
        {
            // THE SEAM, second half: the game's own grab callback. It records the item through
            // `getRewardItemKey` and grants that reward's non-item effects; it resolves the reward id from
            // `_itemToRewardsLookup`, which is why `item` must be the instance just returned.
            museum.OnRewardCollected(item, player);
            // The menu's own deposit (ItemGrabMenu.cs:845/:990). A deposit that does not fit reports false
            // rather than destroying the item, and is a postcondition failure below.
            if (player.addItemToInventoryBool(item))
                delivered++;
            string key = museum.getRewardItemKey(item);
            if (player.mailReceived.Contains(key) || player.hasOrWillReceiveMail(key))
                recorded++;
        }

        // A FRESH read of the read-only collectable set: the world change the claim is supposed to make is
        // that there is nothing left to collect.
        List<(string RewardKey, Item Item)> stillCollectable = ReadCollectableMuseumRewards(museum, player);
        int mailAfter = player.mailReceived.Count;
        int unitsAfter = CountInventoryUnits(player);
        bool collected = rewards.Count == collectableBefore
            && delivered == rewards.Count
            && recorded == rewards.Count
            && stillCollectable.Count == 0;

        string evidence =
            $"target={expectedTargetId};location={museum.NameOrUniqueName};"
            + $"rewards_before={collectableBefore.ToString(CultureInfo.InvariantCulture)};"
            + $"rewards_returned={rewards.Count.ToString(CultureInfo.InvariantCulture)};"
            + $"rewards_delivered={delivered.ToString(CultureInfo.InvariantCulture)};"
            + $"rewards_recorded={recorded.ToString(CultureInfo.InvariantCulture)};"
            + $"rewards_after={stillCollectable.Count.ToString(CultureInfo.InvariantCulture)};"
            + $"mail_flags_before={mailBefore.ToString(CultureInfo.InvariantCulture)};"
            + $"mail_flags_after={mailAfter.ToString(CultureInfo.InvariantCulture)};"
            + $"inventory_units_before={unitsBefore.ToString(CultureInfo.InvariantCulture)};"
            + $"inventory_units_after={unitsAfter.ToString(CultureInfo.InvariantCulture)};"
            + $"rewards_collected={collected.ToString().ToLowerInvariant()}";

        return collected
            ? this.RememberTerminal(requestId, executionId, ExecutionState.Succeeded, "museum_rewards_collected", evidence)
            : this.RememberTerminal(requestId, executionId, ExecutionState.Uncertain, "museum_reward_not_observed", evidence);
    }

    /// <summary>
    /// One resolved reward set, or the named reason the published target no longer matches the live world.
    /// </summary>
    internal sealed record MuseumRewardTargetResolution(
        bool Accepted,
        string ReasonCode,
        string Evidence,
        LibraryMuseum? Museum,
        int CollectableCount)
    {
        internal static MuseumRewardTargetResolution Reject(string reasonCode, string evidence) =>
            new(false, reasonCode, evidence, null, 0);
    }

    /// <summary>
    /// Re-derives the museum's reward set on the game thread. Every mismatch is a NAMED refusal, never a
    /// silent re-target: the world must own a museum, there must be something to collect, and the published
    /// id must still describe the live set.
    /// </summary>
    internal static MuseumRewardTargetResolution ResolveMuseumRewardTarget(string expectedTargetId)
    {
        Farmer player = Game1.player;
        if (Game1.getLocationFromName(MuseumLocationName) is not LibraryMuseum museum)
            return MuseumRewardTargetResolution.Reject(
                "museum_reward_unavailable",
                $"target={expectedTargetId};location={MuseumLocationName};museum=false");

        List<(string RewardKey, Item Item)> collectable = ReadCollectableMuseumRewards(museum, player);
        if (collectable.Count == 0)
            return MuseumRewardTargetResolution.Reject(
                "museum_rewards_empty",
                $"target={expectedTargetId};location={museum.NameOrUniqueName};collectable=0");

        string liveId = BuildMuseumRewardTargetId(museum.NameOrUniqueName, collectable.Select(entry => entry.RewardKey).ToArray());
        if (!string.Equals(liveId, expectedTargetId, StringComparison.Ordinal))
            return MuseumRewardTargetResolution.Reject(
                "museum_reward_target_moved",
                $"location={museum.NameOrUniqueName};published={expectedTargetId};live={liveId};"
                    + $"collectable={collectable.Count.ToString(CultureInfo.InvariantCulture)}");

        return new MuseumRewardTargetResolution(true, "accepted", string.Empty, museum, collectable.Count);
    }

    /// <summary>
    /// The rewards `getRewardsForPlayer` WOULD return, derived read-only from the game's own predicates.
    /// The item key test is the one `AddRewardItemIfUncollected` (LibraryMuseum.cs:325-333) applies, and no
    /// method here writes anything.
    /// </summary>
    internal static List<(string RewardKey, Item Item)> ReadCollectableMuseumRewards(LibraryMuseum museum, Farmer player)
    {
        Dictionary<string, MuseumRewards> data = DataLoader.MuseumRewards(Game1.content);
        Dictionary<string, int> counts = museum.GetDonatedByContextTag(data);
        List<(string RewardKey, Item Item)> result = new();
        foreach (KeyValuePair<string, MuseumRewards> entry in data)
        {
            // `getRewardsForPlayer` only ever LISTS item rewards; a reward with no item id is granted inside
            // the enumeration itself and is not part of what the actor sees or picks up.
            if (entry.Value.RewardItemId is null)
                continue;
            if (!museum.CanCollectReward(entry.Value, entry.Key, player, counts))
                continue;
            result.Add((entry.Key, CreateMuseumRewardItem(entry.Value)));
        }
        result.RemoveAll(entry => player.mailReceived.Contains(museum.getRewardItemKey(entry.Item)));
        return result;
    }

    /// <summary>
    /// The reward item exactly as `getRewardsForPlayer` builds it (LibraryMuseum.cs:281-283), so the
    /// collection key it hashes is the same key the seam will record.
    /// </summary>
    internal static Item CreateMuseumRewardItem(MuseumRewards reward)
    {
        Item item = ItemRegistry.Create(reward.RewardItemId, reward.RewardItemCount);
        item.IsRecipe = reward.RewardItemIsRecipe;
        item.specialItem = reward.RewardItemIsSpecial;
        return item;
    }

    /// <summary>
    /// Opaque, stable selector for the museum's current reward set: the location plus the sorted
    /// `Data/MuseumRewards` keys it would collect. The keys are hashed INTO the id and never published, so
    /// the projection names the set without carrying the data table.
    /// </summary>
    internal static string BuildMuseumRewardTargetId(string locationName, IReadOnlyList<string> rewardKeys)
    {
        List<string> sorted = new(rewardKeys);
        sorted.Sort(StringComparer.Ordinal);
        string raw = $"{locationName}:{string.Join(",", sorted)}";
        return $"museum_reward_{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(raw))).ToLowerInvariant()[..16]}";
    }

    /// <summary>
    /// The museum's current reward set as the actor may collect it right now, projected read-only. At most
    /// one entry: the museum is a location, not a set of places, and the target names the whole set at
    /// once. A museum with nothing to collect advertises nothing, because there is nothing to claim.
    /// </summary>
    internal static IReadOnlyList<BridgeMuseumRewardTarget> DiscoverMuseumRewardTargets(Farmer player)
    {
        if (Game1.getLocationFromName(MuseumLocationName) is not LibraryMuseum museum)
            return Array.Empty<BridgeMuseumRewardTarget>();
        List<(string RewardKey, Item Item)> collectable = ReadCollectableMuseumRewards(museum, player);
        if (collectable.Count == 0)
            return Array.Empty<BridgeMuseumRewardTarget>();
        return new[]
        {
            new BridgeMuseumRewardTarget(
                BuildMuseumRewardTargetId(museum.NameOrUniqueName, collectable.Select(entry => entry.RewardKey).ToArray()),
                museum.NameOrUniqueName,
                collectable.Count),
        };
    }
}
