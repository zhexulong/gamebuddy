using System;
using System.Collections.Generic;
using System.Linq;
using GameBuddy.Stardew.Core;
using GameBuddy.Stardew.Core.Abstractions;
using GameBuddy.Stardew.Core.Policy;
using StardewValley;
using StardewValley.GameData.Shops;
using StardewValley.Internal;
using StardewValley.Menus;

namespace GameBuddy.Stardew;

/// <summary>
/// shop_purchase: buy from a counter the GAME would open for this actor.
///
/// Scope, deliberately narrow (owner decision): this action does not walk. Walking is
/// <c>move_to_tile</c>'s job, exactly as it is for every other action. What this action owes is an
/// admission decision that is the engine's own, and a receipt about the TRANSACTION - so a walk failure
/// is never reported as a trade failure.
///
/// Authority: every fact comes from the game, INCLUDING the entry it opens through.
///
/// <list type="bullet">
/// <item>Which shops exist and what they sell: <c>DataLoader.Shops</c> / <c>ShopBuilder.GetShopStock</c>.</item>
/// <item>Whether an owner entry is currently eligible: <c>ShopBuilder.GetCurrentOwners</c>, which is where
/// <c>ShopOwnerData.Condition</c> (a game-state query) is evaluated. The Mod does not model opening hours; it asks
/// the game.</item>
/// <item>Why a shop is closed: <c>ShopOwnerData.ClosedMessage</c>, the game's own text.</item>
/// <item>How far a counter can be acted on from: <c>Utility.tileWithinRadiusOfPlayer(tile, 1, player)</c>, the gate
/// <c>Game1</c> applies to the TILE before it calls <c>GameLocation.checkAction</c> (Game1.cs:11509, :11637). That is
/// a radius around a TILE - never around an NPC: no native shop path measures the distance to the owner, and an
/// NPC-run counter is resolved by searching the room's whole character list (Utility.cs:4243-4268), not by distance.
/// Measured round42: this action refused <c>shop_counter_out_of_reach</c> at actor (5,19) against Pierre on (4,17) -
/// two tiles, one radius, no native gate - and the world would have sold her the seed.</item>
/// <item>A counter an NPC runs is opened with the engine's own location overload,
/// <c>Utility.TryOpenShopMenu(shopId, location, ownerArea, maxOwnerY, forceOpen)</c> (Utility.cs:4230-4324): the call
/// the engine's own counter cases make (FishShop GameLocation.cs:10756, Sandy :10776, Saloon :10836, Desert
/// Desert.cs:71). It resolves the eligible entries, looks for one of those NPCs among the room's characters
/// (:4243-4268), draws <c>ClosedMessage</c> and refuses when that entry is shut (:4305-4317), and opens nothing when
/// no entry can run the counter (:4318-4323). Every part of that decision stays the engine's; the Mod reports its
/// answer instead of pre-judging it with a distance of its own.</item>
/// <item>The transaction: <c>Utility.TryOpenShopMenu</c> builds the game's own <c>ShopMenu</c>, and the purchase is
/// dispatched through <c>ShopMenu.receiveLeftClick</c> over the menu's public <c>forSaleButtons</c>. The Mod does not
/// re-implement <c>tryToPurchaseItem</c> (it is private and its logic is the game's).</item>
/// </list>
///
/// Discovery reports targets for the CURRENT location only, because the counter's presence is what makes a shop
/// usable - so the Agent can tell "this shop is not on the map I am on" from "this shop is here but closed", which
/// are different problems with different fixes. A shop whose native counter is a TILE rather than an NPC (the
/// tile-opened stalls) is discovered from that tile for the same reason: the tile IS the counter, it is where the
/// actor has to stand, and it is the tile whose action opens the menu.
/// </summary>
internal sealed partial class ExecutionManager : IExecutionLedger, IDispatchExecutionLedger
{
    private const int MaxShopTargets = 32;
    private const int MaxTileShopTargets = 8;

    /// <summary>The most counters one refusal spells before it says how many it did not print.</summary>
    private const int MaxSpelledCounters = 3;

    /// <summary>
    /// The one counter whose purchase is a TOOL UPGRADE: `Tool.actionWhenPurchased` upgrades only for this shop id
    /// (Tool.cs:875), and the entry it charges for is discarded rather than carried (ShopMenu.cs:1369-1378).
    /// </summary>
    private const string ShopUpgradeCounter = "ClintUpgrade";

    /// <summary>
    /// The owner entry that would RUN this shop's counter right now, resolved the way
    /// <c>Utility.TryOpenShopMenu</c> resolves it: from <c>ShopBuilder.GetCurrentOwners</c> (the entries whose
    /// <c>Condition</c> matches today), by <paramref name="ownerName"/> with the engine's own <c>IsValid</c> and
    /// NamedNpc-first ordering (<c>Utility.cs:4212-4214</c>), or - for a counter with no NPC - the first
    /// <c>AnyOrNone</c>/<c>None</c> entry (<c>Utility.cs:4271</c>). Null when no entry matches, which is the engine's
    /// "nobody here can run it" too.
    ///
    /// <para>
    /// This is the ONE resolution: discovery, the purchase's own re-read and the seed-supply fact all ask it, so a row
    /// the snapshot publishes and a counter the action opens cannot be two different counters.
    /// </para>
    /// </summary>
    internal static ShopOwnerData? ResolveCurrentShopOwner(ShopData? shopData, string ownerName)
    {
        IEnumerable<ShopOwnerData> owners;
        try
        {
            owners = shopData is null
                ? Array.Empty<ShopOwnerData>()
                : ShopBuilder.GetCurrentOwners(shopData);
        }
        catch (Exception)
        {
            return null;
        }

        return SelectCurrentShopOwner(owners.ToArray(), ownerName);
    }

    internal static ShopOwnerData? SelectCurrentShopOwner(IReadOnlyList<ShopOwnerData> currentOwners, string ownerName)
    {
        if (currentOwners is null || currentOwners.Count == 0)
            return null;

        if (string.IsNullOrEmpty(ownerName))
        {
            return currentOwners.FirstOrDefault(entry => entry is not null
                && (entry.Type == ShopOwnerType.AnyOrNone || entry.Type == ShopOwnerType.None));
        }

        return currentOwners
            .Where(entry => entry is not null)
            .OrderByDescending(entry => entry.Type == ShopOwnerType.NamedNpc)
            .FirstOrDefault(entry => entry.IsValid(ownerName));
    }

    /// <summary>
    /// The verdict half: the engine opens a counter unless the entry that would run it carries a
    /// <c>ClosedMessage</c>, which it draws instead (<c>Utility.cs:4305-4317</c>).
    /// </summary>
    internal static bool OpensNow(ShopOwnerData? resolvedOwner) => resolvedOwner is { ClosedMessage: null };

    internal readonly record struct DiscoveredShopCounter(
        string TargetId,
        string ShopId,
        ShopData ShopData,
        string OwnerName,
        int CounterX,
        int CounterY,
        bool OpensNow,
        string? ClosedMessage);

    /// <summary>
    /// The selector a passive-festival stall tile carries, and the shop-id family that selector builds.
    ///
    /// <para>
    /// `DesertFestival.performAction` (`case "DesertVendor"`, :741-757) reads the NPC standing ONE TILE ABOVE the
    /// clicked tile and opens `"DesertFestival_" + character.Name` through the string overload, so for those stalls
    /// the TILE names the shop and the occupant names the owner together. `Data/Shops` carries a `DesertFestival_`
    /// entry for every villager, so an owner NAME alone cannot tell a stall from a villager who happens to be in the
    /// room - which is the defect `round84` measured.
    /// </para>
    /// </summary>
    private const string DesertVendorAction = "DesertVendor";

    /// <summary>The shop-id family <see cref="DesertVendorAction"/> builds: `"DesertFestival_" + vendor.Name`.</summary>
    private const string DesertVendorShopPrefix = "DesertFestival_";

    internal static string ShopTargetId(string shopId, string ownerName, int counterX, int counterY) =>
        $"shop_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(shopId + "\u0000" + ownerName + "\u0000" + counterX + "," + counterY))).ToLowerInvariant()[..16]}";

    /// <summary>The owner half of a refusal's evidence: a counter no NPC runs is spelled <c>none</c>, the same way
    /// every optional value is spelled here, because an empty <c>owner=</c> is a field the Host cannot reparse.</summary>
    internal static string ShopOwnerToken(string ownerName) => ownerName.Length == 0 ? "none" : ownerName;

    /// <summary>
    /// One counter as a caller can pass it BACK: the opaque id `shop_purchase` takes, and the tile to act on it from.
    ///
    /// <para>
    /// Both halves are needed and neither is a second identity: the id alone is opaque (nothing in `shop_<16 hex>` says
    /// which shop or which owner), and the tile alone names no counter. They are the published row's own two facts, so a
    /// refusal that spells them says what it is talking about without minting anything.
    /// </para>
    /// </summary>
    internal static string ShopCounterToken(DiscoveredShopCounter counter) =>
        $"{counter.TargetId}@{counter.CounterX},{counter.CounterY}";

    /// <summary>
    /// The counters in <paramref name="counters"/> that spell, at most <see cref="MaxSpelledCounters"/> of them, with the
    /// count of those withheld beside it - one producer, because two refusals now list counters and a list that stops at
    /// three without saying so reads as a complete list of three.
    /// </summary>
    private static string SpellCounters(IReadOnlyList<DiscoveredShopCounter> counters)
    {
        if (counters.Count == 0)
            return "none";
        string spelled = string.Join(",", counters.Take(MaxSpelledCounters).Select(ShopCounterToken));
        return counters.Count > MaxSpelledCounters
            ? $"{spelled}(+{counters.Count - MaxSpelledCounters})"
            : spelled;
    }

    /// <summary>
    /// Whether the value handed to <c>expectedTargetId</c> names a SHOP rather than a counter - asked of the world's own
    /// shop table, because the argument is opaque and its spelling says nothing.
    ///
    /// <para>
    /// THE TWO ARE DIFFERENT THINGS. <see cref="ShopTargetId"/> mints one opaque id per COUNTER (a shop id and an owner
    /// name, hashed), and `Data/Shops` keys the SHOP itself: `SeedShop` is not a counter in anybody's room, it is the
    /// shop whose counter `SeedShop`/`Pierre` is. Measured round81: two of three `shop_purchase` attempts passed
    /// `target=SeedShop` while the actor stood IN SeedShop, and both were answered `shop_target_unavailable` - a word
    /// that names no kind, so nothing in the receipt said "that is a shop, not the counter you meant".
    /// </para>
    /// </summary>
    internal static bool NamesAKnownShop(string targetId, IReadOnlyDictionary<string, ShopData> shops) =>
        shops.ContainsKey(targetId);

    /// <summary>The code a shop id handed to the counter argument is refused under. The KIND is in the code as well as in
    /// the evidence, so a caller that reads only <c>reasonCode</c> still learns what it passed, and a caller that reads the
    /// evidence learns what it could have passed instead.</summary>
    internal static string ShopIdAsCounterRefusalCode(string shopId) =>
        $"shop_target_is_a_shop_id_not_a_counter:{shopId}";

    /// <summary>The world's own shop table, or an empty one when the content cannot be read. What it feeds is a refusal's
    /// WORDING and never a gate, so an unreadable table makes the refusal quieter rather than louder - the counter scan
    /// in front of it still answers, and `shop_target_unavailable` is still true when nothing can be classed.</summary>
    private static IReadOnlyDictionary<string, ShopData> KnownShops()
    {
        try
        {
            return DataLoader.Shops(Game1.content);
        }
        catch (Exception)
        {
            return new Dictionary<string, ShopData>(StringComparer.Ordinal);
        }
    }

    /// <summary>
    /// What a <c>ShopId</c> handed to the counter argument is refused with, and the counters here that would run it.
    ///
    /// <para>
    /// `<c>kind=shop_id</c>` is the whole point of the refusal: the argument's contract is a COUNTER, and a shop id does
    /// not say which counter (a shop can have several owners standing in one room, and only one of them may be open
    /// today) - so resolving one here would be a second identity for a counter discovery already published one for. The
    /// caller is given the ids it COULD have meant instead, in the same `targetId@x,y` shape, beside the shop ids this
    /// room does have (`available_here`) - the token the other refusal already carried.
    /// </para>
    /// </summary>
    internal static string ShopIdTargetRefusalEvidence(
        string targetId,
        string location,
        IReadOnlyList<DiscoveredShopCounter> counters,
        string availableHere)
    {
        DiscoveredShopCounter[] runIt = counters
            .Where(counter => string.Equals(counter.ShopId, targetId, StringComparison.Ordinal))
            .ToArray();
        return $"target={targetId};kind=shop_id;location={location};counters={SpellCounters(runIt)};"
            + $"available_here={availableHere}";
    }

    /// <summary>
    /// The one spelling of "which counter, which body, which radius" - the three tokens a caller computes an approach
    /// from. Two refusals state a counter cannot be reached from here (a TILE outside the engine's radius, and a counter
    /// no eligible owner can run in this room), and they must not spell that comparison two ways.
    /// </summary>
    internal static string ShopCounterReachEvidence(string ownerName, int counterX, int counterY, int actorX, int actorY) =>
        $"owner={ShopOwnerToken(ownerName)};owner_tile={counterX},{counterY};"
        + $"actor_tile={actorX},{actorY};radius={NativeInteractionRadius}";

    /// <summary>
    /// The refusal a counter's REACH produces, or null when the actor may act on it from where it stands.
    ///
    /// <para>
    /// A counter that is a TILE action is reachable at the radius the engine itself applies to that tile before it calls
    /// <c>GameLocation.checkAction</c> (<c>Game1.cs:11509</c> and <c>:11637</c> both gate on
    /// <c>Utility.tileWithinRadiusOfPlayer(tile, 1, player)</c>). The number is the engine's and the tile measured is
    /// the tile a caller would otherwise have to click, which is why this refusal names THAT tile.
    /// </para>
    /// <para>
    /// A counter an NPC runs has no such gate anywhere in the engine: <c>Utility.TryOpenShopMenu(shopId, location, ...)</c>
    /// resolves the owner entries, searches the room's characters for one of those NPCs and opens the menu
    /// (<c>Utility.cs:4243-4324</c>). Measured round42: this action refused <c>shop_counter_out_of_reach</c> at actor
    /// (5,19) against Pierre on (4,17) - a distance no native call takes - while the engine would have opened his counter
    /// from where she stood. So an NPC counter answers null here, and the engine's own call above is the whole verdict.
    /// </para>
    /// </summary>
    internal static string? ShopCounterReachRefusal(
        bool counterIsTileAction,
        string ownerName,
        int counterX,
        int counterY,
        Farmer actor)
    {
        if (!counterIsTileAction || actor is null)
            return null;
        if (IsWithinRangeOfRequest((counterX, counterY), actor))
            return null;
        return ShopCounterReachEvidence(ownerName, counterX, counterY, actor.TilePoint.X, actor.TilePoint.Y);
    }

    /// <summary>
    /// The refusal for a counter the game says is shut today, in the SAME words discovery withholds it with
    /// (<see cref="DiscoveryExclusionReasons.ShopClosedToday"/>), with the game's own closed text beside it.
    /// </summary>
    internal static string ShopClosedNowRefusal(string shopId, string ownerName, int counterX, int counterY, int actorX, int actorY, string? closedMessage) =>
        $"shop={shopId};owner={ShopOwnerToken(ownerName)};owner_tile={counterX},{counterY};actor_tile={actorX},{actorY}"
        + (string.IsNullOrEmpty(closedMessage) ? string.Empty : $";closed_message={closedMessage}");

    /// <summary>
    /// Every shop counter in the actor's current location, WITH the engine's open verdict, so that publishing and
    /// refusing read one enumeration instead of two scans that could disagree.
    ///
    /// <para>
    /// A named-owner counter is here when that NPC is in the room's character list - the same list
    /// <c>Utility.TryOpenShopMenu</c> searches (<c>Utility.cs:4236-4240</c>) - and it opens when the entry that would run
    /// it carries no <c>ClosedMessage</c> (<c>Utility.cs:4305-4317</c>). A tile counter is here when its Action tile opens
    /// that shop, and it answers OPEN by construction: the two forms this action dispatches for those tiles (the fixed
    /// selectors' string overload, and <c>OpenShop</c> with <c>forceOpen</c>) both open with a <c>ClosedMessage</c> entry -
    /// the string overload ignores the field, and <c>forceOpen</c> skips such entries (<c>Utility.cs:4247-4250</c>).
    /// </para>
    /// <para>
    /// A ROOM THAT SELLS THROUGH STALLS DOES NOT SELL THROUGH NAMES. The Desert Festival declares a
    /// <c>DesertVendor</c> tile per stall and a <c>Data/Shops</code> entry named after EVERY villager, so the owner-name
    /// rule above reported a counter for each villager present, at that villager's standing tile, for a shop whose
    /// counter is the stall. `round84`: two purchases were refused `item_not_sold_here` against `DesertFestival_Leah`
    /// and `DesertFestival_Pierre` before the counter that actually sold the item was found. The stall family is
    /// therefore read from the room's OWN tiles (see <see cref="DiscoverVendorStallTargets"/>), and the name rule
    /// skips it: the identity of those counters is the stall - the tile whose click names both the shop and the vendor -
    /// not an owner name several shops share.
    /// </para>
    /// </summary>
    private static List<DiscoveredShopCounter> EnumerateShopCounters(GameLocation location)
    {
        List<DiscoveredShopCounter> counters = new();
        bool roomSellsThroughVendorStalls = false;
        counters.AddRange(DiscoverVendorStallTargets(location, out roomSellsThroughVendorStalls));
        foreach ((string shopId, ShopData shopData) in DataLoader.Shops(Game1.content))
        {
            if (roomSellsThroughVendorStalls && shopId.StartsWith(DesertVendorShopPrefix, StringComparison.Ordinal))
                continue;

            ShopOwnerData[] owners;
            try
            {
                owners = ShopBuilder.GetCurrentOwners(shopData).ToArray();
            }
            catch (Exception)
            {
                continue;
            }

            foreach (ShopOwnerData owner in owners)
            {
                if (owner.Type != ShopOwnerType.NamedNpc || string.IsNullOrWhiteSpace(owner.Name))
                    continue;

                NPC? npc = location.characters.FirstOrDefault(c =>
                    c is not null && string.Equals(c.Name, owner.Name, StringComparison.Ordinal));
                if (npc is null)
                    continue;

                ShopOwnerData? resolvedOwner = ResolveCurrentShopOwner(shopData, owner.Name);
                counters.Add(new DiscoveredShopCounter(
                    ShopTargetId(shopId, owner.Name, npc.TilePoint.X, npc.TilePoint.Y),
                    shopId,
                    shopData,
                    owner.Name,
                    npc.TilePoint.X,
                    npc.TilePoint.Y,
                    OpensNow(resolvedOwner),
                    resolvedOwner?.ClosedMessage));
            }
        }

        counters.AddRange(DiscoverTileShopTargets(location));
        return counters;
    }

    /// <summary>
    /// The row <c>shopTargets</c> publishes for one counter, with what the game would sell right now.
    ///
    /// <para>
    /// <c>OwnerInReach</c> is the engine's radius fact about this row's TILE (<c>Game1.cs:11509</c>), published so a
    /// caller can see how far it has to walk. It is an admission gate for a TILE counter and nothing else: an NPC-run
    /// counter is opened by the engine from anywhere in the room (see <see cref="ShopCounterReachRefusal"/>), so no
    /// refusal may be derived from it there.
    /// </para>
    /// <para>
    /// <c>StockPrices</c> is read out of the SAME <c>ReadShopStock</c> pass and the SAME dictionary the seed-supply family
    /// prices with, keyed by the ids <c>ReadShopStock</c> already selected - so every published id has a price, the two
    /// lists cannot drift, and no price here is a second measurement of the number the seed family carries.
    /// </para>
    /// </summary>
    private static BridgeShopTarget PublishShopCounter(DiscoveredShopCounter counter, GameLocation location, Farmer player)
    {
        ReadShopStock(
            counter.ShopId,
            counter.ShopData,
            out int stockCount,
            out List<string> stockItemIds,
            out Dictionary<string, int> priceByQualifiedItemId);
        List<BridgeShopStockPrice> stockPrices = new();
        foreach (string qualifiedItemId in stockItemIds)
        {
            if (priceByQualifiedItemId.TryGetValue(qualifiedItemId, out int unitPrice))
                stockPrices.Add(new BridgeShopStockPrice(qualifiedItemId, unitPrice));
        }
        return new BridgeShopTarget(
            counter.TargetId,
            counter.ShopId,
            counter.OwnerName,
            location.NameOrUniqueName,
            counter.CounterX,
            counter.CounterY,
            Utility.tileWithinRadiusOfPlayer(counter.CounterX, counter.CounterY, NativeInteractionRadius, player),
            stockCount,
            stockItemIds,
            stockPrices);
    }

    private IReadOnlyList<BridgeShopTarget> DiscoverShopTargets(Farmer player, DiscoveryExclusionRecorder? exclusions)
    {
        GameLocation? location = player.currentLocation;
        if (location is null)
            return Array.Empty<BridgeShopTarget>();

        List<BridgeShopTarget> targets = new();
        foreach (DiscoveredShopCounter counter in EnumerateShopCounters(location))
        {
            if (!counter.OpensNow)
            {
                if (exclusions is not null)
                    exclusions.Record("shopTargets", DiscoveryExclusionReasons.ShopClosedToday);
                continue;
            }
            targets.Add(PublishShopCounter(counter, location, player));
        }

        return targets.Take(MaxShopTargets).ToArray();
    }

    private static void ReadShopStock(
        string shopId,
        ShopData shopData,
        out int stockCount,
        out List<string> stockItemIds,
        out Dictionary<string, int> priceByQualifiedItemId)
    {
        stockCount = 0;
        stockItemIds = new List<string>();
        priceByQualifiedItemId = new Dictionary<string, int>(StringComparer.Ordinal);
        try
        {
            Dictionary<ISalable, ItemStockInformation>? here = ShopBuilder.GetShopStock(shopId, shopData);
            if (here is null)
                return;
            stockCount = here.Count;
            foreach (KeyValuePair<ISalable, ItemStockInformation> entry in here)
            {
                string qualifiedItemId = entry.Key.QualifiedItemId;
                if (string.IsNullOrEmpty(qualifiedItemId))
                    continue;
                // First entry wins: two rows can resolve to the same item id, and the menu sells the first of them at
                // that price. Overwriting would publish the last row's number as if it were the only one.
                //
                // This is the price the menu CHARGES, published verbatim. It must not be clamped, floored or
                // re-derived here, because `ShopBuilder.GetBasePrice` already applied the engine's own rule to the
                // declared number before this dictionary existed: a negative declared price is replaced with the
                // item's `salePrice(ignoreProfitMargins: true)` (ShopBuilder.cs:221-237 - the substitution at
                // :224-227, the single `(int)` cast at :236), and `GetShopStock` stores that result (:58, :94, :102).
                // `0` keeps the meaning `ItemStockInformation.Price` documents - no gold price.
                //
                // A negative can only survive to this line from the substitution itself (a modded negative
                // `Data/Objects` price read with `ignoreProfitMargins`, Object.cs:7246-7251) or from a price modifier
                // that moved the number below zero, and in both cases the menu charges that negative
                // (`ItemStockInformation.Price * stockToBuy`, ShopMenu.cs:1337) while its row hides the price
                // (:1920). Falling back to a sale price here would publish a number the menu does NOT charge, which
                // is the defect a guard in this place looks like it fixes.
                priceByQualifiedItemId.TryAdd(qualifiedItemId, entry.Value.Price);
                if (stockItemIds.Count < 16)
                    stockItemIds.Add(qualifiedItemId);
            }
        }
        catch (Exception)
        {
            stockCount = 0;
            stockItemIds.Clear();
            priceByQualifiedItemId.Clear();
        }
    }

    /// <summary>
    /// The passive-festival stalls this ROOM declares: one <c>DesertVendor</c> Action tile per stall, whose shop id is
    /// <see cref="DesertVendorShopPrefix"/> + the name of the NPC standing one tile above it.
    ///
    /// <para>
    /// THE STALL IS THE COUNTER, so the tile is what this returns and the shop id is what the tile BUILDS - the same
    /// concatenation `DesertFestival.performAction` performs (:751). The identity has three candidates and this is why
    /// it is this one: the shop id alone names a `Data/Shops` row that exists for every villager in the season, the
    /// owner name alone is shared by the stall and the same villager's shop elsewhere, and only the tile says which
    /// stall a body can stand at. A stall with no vendor behind it is not a counter (nothing would open), which is why
    /// it yields nothing; a stall on a day the festival is shut is published CLOSED, so discovery withholds it with the
    /// same exclusion every shut counter gets (`DesertFestival.performAction`:744 refuses it natively).
    /// </para>
    /// </summary>
    /// <param name="roomDeclaresStalls">Whether this room has any <see cref="DesertVendorAction"/> tile at all - the fact
    /// that says "this room sells through stalls", which is what stops the owner-name rule from inventing a counter per
    /// villager name.</param>
    private static List<DiscoveredShopCounter> DiscoverVendorStallTargets(GameLocation location, out bool roomDeclaresStalls)
    {
        roomDeclaresStalls = false;
        List<DiscoveredShopCounter> counters = new();
        xTile.Layers.Layer? buildings = location.map?.GetLayer("Buildings");
        if (buildings is null)
            return counters;

        Dictionary<string, ShopData> shops;
        try
        {
            shops = DataLoader.Shops(Game1.content);
        }
        catch (Exception)
        {
            return counters;
        }

        bool festivalOpen = Utility.IsPassiveFestivalOpen("DesertFestival");
        for (int y = 0; y < buildings.LayerHeight && counters.Count < MaxTileShopTargets; y++)
        {
            for (int x = 0; x < buildings.LayerWidth && counters.Count < MaxTileShopTargets; x++)
            {
                var tile = buildings.Tiles[x, y];
                if (tile is null || !tile.Properties.TryGetValue("Action", out var actionValue))
                    continue;
                if (!string.Equals(
                        ArgUtility.SplitBySpace(actionValue.ToString()).FirstOrDefault(),
                        DesertVendorAction,
                        StringComparison.Ordinal))
                    continue;
                roomDeclaresStalls = true;
                // The engine's own occupant rule: the vendor is the character on the tile ABOVE the stall's action tile
                // (`new Rectangle(tile_location.X, tile_location.Y - 1, 1, 1)`, DesertFestival.cs:748-751).
                NPC? vendor = location.characters.FirstOrDefault(
                    character => character is not null && character.TilePoint.X == x && character.TilePoint.Y == y - 1);
                if (vendor is null)
                    continue;
                string shopId = DesertVendorShopPrefix + vendor.Name;
                if (!shops.TryGetValue(shopId, out ShopData? shopData) || shopData is null)
                    continue;
                ShopOwnerData? resolvedOwner = ResolveCurrentShopOwner(shopData, vendor.Name);
                counters.Add(new DiscoveredShopCounter(
                    ShopTargetId(shopId, vendor.Name, x, y),
                    shopId,
                    shopData,
                    vendor.Name,
                    x,
                    y,
                    festivalOpen && OpensNow(resolvedOwner),
                    festivalOpen ? resolvedOwner?.ClosedMessage : null));
            }
        }

        return counters;
    }

    /// <summary>
    /// Shops opened by a Buildings-layer Action tile instead of by an NPC in the room. Their execution seam is exactly
    /// the one this action already dispatches (<c>Utility.TryOpenShopMenu</c>), but their owner entry is not a named NPC
    /// in the room, so the owner scan above can never see them.
    ///
    /// The tile IS the counter: <c>ownerTileX/Y</c> is the tile the actor has to stand within the native click radius of
    /// (Game1.cs:11509), and <c>ownerName</c> is empty because no NPC owns the stall. That empty name is not a missing
    /// fact -- every one of these native cases opens the shop with a null owner, which the game documents as "no NPC
    /// portrait/dialogue" (Utility.cs:4174).
    /// </summary>
    private static IEnumerable<DiscoveredShopCounter> DiscoverTileShopTargets(GameLocation location)
    {
        xTile.Layers.Layer? buildings = location.map?.GetLayer("Buildings");
        if (buildings is null)
            yield break;

        Dictionary<string, ShopData> shops;
        try
        {
            shops = DataLoader.Shops(Game1.content);
        }
        catch (Exception)
        {
            yield break;
        }

        HashSet<string> seen = new(StringComparer.Ordinal);
        int found = 0;
        for (int y = 0; y < buildings.LayerHeight && found < MaxTileShopTargets; y++)
        {
            for (int x = 0; x < buildings.LayerWidth && found < MaxTileShopTargets; x++)
            {
                var tile = buildings.Tiles[x, y];
                if (tile is null || !tile.Properties.TryGetValue("Action", out var actionValue))
                    continue;
                string action = actionValue.ToString();
                if (!TryResolveTileShop(action, out string shopId)
                    || !shops.TryGetValue(shopId, out ShopData? shopData) || shopData is null
                    || !seen.Add(shopId))
                    continue;

                found++;
                yield return new DiscoveredShopCounter(
                    ShopTargetId(shopId, string.Empty, x, y),
                    shopId,
                    shopData,
                    string.Empty,
                    x,
                    y,
                    OpensNow: true,
                    ClosedMessage: null);
            }
        }
    }

    /// <summary>
    /// The shop a Buildings-layer Action tile opens, resolved through the selectors whose
    /// native case dispatches the SAME <c>Utility.TryOpenShopMenu(shopId, null, ...)</c>
    /// overload this action dispatches (GameLocation.performAction). A selector that opens
    /// no shop at all is left out rather than forced:
    ///
    /// <list type="bullet">
    /// <item><c>ColaMachine</c> (GameLocation.cs:9231) buys one Joja Cola inside its own
    /// answer handler -- no shop menu is ever built.</item>
    /// <item><c>QiCoins</c> (:9932) and <c>ClubSeller</c> (:9946) are question dialogues
    /// whose answers exchange money for club coins or an item; neither opens a shop.</item>
    /// <item><c>IceCreamStand</c> (:9234) and every <c>OpenShop</c> form carrying a
    /// direction, an opening window or an owner area (:9061-9110) run the LOCATION overload with
    /// those gates, which this action does not reproduce -- opening anyway would be a gate
    /// bypass of the same kind backlog item "enter_exit could pass through a native door gate"
    /// is. The GATE-FREE two-token <c>OpenShop &lt;shopId&gt;</c> IS included, and the handler
    /// dispatches it through that same location overload (no owner area, forceOpen), so even
    /// its closed-message refusal stays native.</item>
    /// </list>
    ///
    /// <c>Bookseller</c> (:8727) is the one included selector with a gate of its own; the
    /// handler re-reads that gate and refuses rather than opening a shop a real click would
    /// not have opened.
    /// </summary>
    internal static bool TryResolveTileShop(string? action, out string shopId)
    {
        shopId = string.Empty;
        if (string.IsNullOrWhiteSpace(action))
            return false;

        string[] tokens = ArgUtility.SplitBySpace(action);
        switch (tokens[0])
        {
            case "JojaShop":
                shopId = "Joja";
                return true;
            case "ClubShop":
                shopId = "Casino";
                return true;
            case "QiGemShop":
                shopId = "QiGemShop";
                return true;
            case "Bookseller":
                shopId = "Bookseller";
                return true;
            case "OpenShop":
                if (tokens.Length != 2)
                    return false;
                shopId = tokens[1];
                return true;
            default:
                return false;
        }
    }

    private static string? GameStateQueryClosedMessageFor(string shopId, string ownerName)
    {
        try
        {
            if (!DataLoader.Shops(Game1.content).TryGetValue(shopId, out ShopData? shopData) || shopData is null)
                return null;
            return ResolveCurrentShopOwner(shopData, ownerName)?.ClosedMessage;
        }
        catch (Exception)
        {
        }
        return null;
    }

    /// <summary>
    /// The currency the shop's menu prices in, read from the same shop data the menu is built from:
    /// <c>Utility.TryOpenShopMenu</c> constructs the <c>ShopMenu</c> from <c>DataLoader.Shops</c> and
    /// <c>ShopMenu.Initialize</c> stores <c>shopData.Currency</c> (ShopMenu.cs:304, :371). Reading it before
    /// the menu opens lets the affordability gate use the field the native charge will move.
    /// </summary>
    private static int ShopCurrencyFor(string shopId)
    {
        return DataLoader.Shops(Game1.content).TryGetValue(shopId, out ShopData? shopData) && shopData is not null
            ? shopData.Currency
            : 0;
    }

    /// <summary>
    /// A name for the currency a <c>ShopMenu</c> charges in, for the refusal evidence. The values are the
    /// fields <c>ShopMenu.getPlayerCurrencyAmount</c> reads (ShopMenu.cs:881-891): money, star tokens
    /// (festivalScore), club coins / Qi coins (clubCoins), and Qi gems.
    /// </summary>
    private static string ShopCurrencyName(int currency)
    {
        return currency switch
        {
            1 => "star_tokens",
            2 => "club_coins",
            4 => "qi_gems",
            _ => "money",
        };
    }

    /// <summary>
    /// The shortfall a price refusal appends when the price is out of reach, and nothing when it is not.
    ///
    /// <para>
    /// Stated only for a real gap: `price=80` against `held=80` is exactly affordable, so `short=0` would
    /// report an absence as a quantity, and a `price=0` charge has no gap to name. One producer, so every
    /// refusal that names a price spells the gap the same way.
    /// </para>
    /// </summary>
    internal static string PriceShortfallToken(int price, long held)
    {
        long shortfall = price - held;
        return shortfall > 0 ? $";short={shortfall}" : string.Empty;
    }

    /// <summary>
    /// The affordability refusal's evidence, rendered from the values the purchase path already resolved.
    ///
    /// <para>
    /// `available=` is the token this refusal has always carried and stays byte-identical; `held=` names the
    /// same amount as the balance of the currency the price is in. Both exist because the old sentence could
    /// not be acted on: `price=80;currency=money;available=20` states the price and hides the other side of
    /// the comparison, and `available=` beside `price=` reads as stock - round42 spent eight `shop_purchase`
    /// attempts re-asking for goods the purse could not pay for.
    /// </para>
    /// <para>
    /// Currency 0 is the purse, so `held` equals <c>Game1.player.Money</c> only in that case
    /// (ShopMenu.cs:885 maps 0 to who.Money); otherwise it is the amount of the currency the price is in.
    /// That is the engine's own mapping, not a second read.
    /// </para>
    /// </summary>
    internal static string ShopPurchaseAffordabilityEvidence(
        string shopId,
        string itemId,
        int unitPrice,
        int shopCurrency,
        long currencyHeld)
    {
        return $"shop={shopId};item={itemId};price={unitPrice};currency={ShopCurrencyName(shopCurrency)};available={currencyHeld}"
            + $";held={currencyHeld}"
            + PriceShortfallToken(unitPrice, currencyHeld);
    }

    /// <summary>
    /// How many purchases this actor can actually complete - the purse, the stock, what was asked for, and the pack.
    ///
    /// <para>
    /// ONE producer, because four refusal branches read it: <c>Affordable &lt; 1</c> is <c>insufficient_money</c>, a
    /// stock below one is <c>out_of_stock</c>, and <c>Purchasable &lt; 1</c> beside a full pack is
    /// <c>inventory_cannot_accept</c>. A second copy of "held divided by price" is how one refusal ends up naming a
    /// number the other branch never used. The price arrives as the stock ENTRY rather than as a bare integer: the entry
    /// is the object the menu charges (<c>ShopMenu.cs:1337</c>), so a caller cannot hand this function the item's sale
    /// value by mistake.
    /// </para>
    /// <para>
    /// THE PACK IS A TERM, and it is the one that was missing. Measured 2026-11-14 at HEAD: a purchase whose goods no
    /// slot could take moved the money first (the engine charges inside <c>tryToPurchaseItem</c>, ShopMenu.cs:1364),
    /// left the stack on the cursor (:1352), and then the handler's own close DELETED it - <c>Game1.exitActiveMenu()</c>
    /// is <c>activeClickableMenu = null</c> (Game1.cs:6128-6131), and the <c>ShopMenu</c> holding the cursor goes with
    /// it. The player's own path never does that: the menu refuses to close while it holds goods
    /// (<c>ShopMenu.readyToClose</c> answers false, ShopMenu.cs:1255-1262), and the close its menu key DOES perform
    /// hands the stack to <c>Utility.CollectOrDrop</c> (<c>ShopMenu.receiveKeyPress</c>, :965-978), which puts it in the
    /// pack or on the ground (<c>Utility.cs:2092-2112</c>) and never destroys it. So the player cannot pay for goods
    /// that evaporate, and this count makes the same answer at admission: <paramref name="packPurchases"/> below one is
    /// refused BEFORE the click, with the purse untouched.
    /// </para>
    /// <para>
    /// <c>Math.Max(1, ...)</c> is not a price: a row that trades an item instead of gold carries <c>Price = 0</c>
    /// (the engine writes it, ShopBuilder.cs:226) and is answered before that division, because what it asks for is the
    /// item and not gold - so it is affordable whatever the purse holds, empty included. The division keeps the guard
    /// anyway: `ShopPurchaseCurrencySourceShapeTests` reads that exact expression to prove this count divides the shop's
    /// own currency rather than the purse. The trade itself is enforced by the engine's own purchase, not by this count.
    /// </para>
    /// </summary>
    internal static (long Affordable, int Purchasable) ShopPurchaseCapacity(
        ItemStockInformation charged,
        long currencyHeld,
        int requestedQuantity,
        int packPurchases)
    {
        long affordable = charged.Price <= 0
            ? requestedQuantity
            : currencyHeld / Math.Max(1, charged.Price);
        int purchasable = (int)Math.Min(Math.Min(requestedQuantity, charged.Stock), affordable);
        return (affordable, Math.Min(purchasable, packPurchases));
    }

    /// <summary>
    /// How many of these purchases the pack can take, in CLICKS, through the engine's own arithmetic.
    ///
    /// <para>
    /// <c>Utility.GetNumberOfItemThatCanBeAddedToThisInventoryList</c> is the engine's count of what a list can still
    /// absorb (Utility.cs:6283-6302): the remaining room of every stack the goods merge into, plus one full stack per
    /// empty slot - the same <c>getRemainingStackSpace</c> / <c>maximumStackSize</c> pair the pack's own placement reads
    /// (<c>Farmer.addItemToInventory</c>, Farmer.cs:4291-4325). Dividing by the units ONE click buys
    /// (<c>ShopMenu.cs:1340</c>: <c>stack = stockToBuy * item.Stack</c>, with one unit asked per click here) turns that
    /// room into clicks, which is the unit the click loop counts in.
    /// </para>
    /// <para>
    /// <paramref name="consumedByThePurchase"/> is <c>int.MaxValue</c> from the caller's own reading of the engine's
    /// purchase hook - see <see cref="ShopPurchaseConsumesTheEntry"/> - because an entry the hook consumes never reaches
    /// the cursor and the pack owes it no room.
    /// </para>
    /// </summary>
    internal static int ShopPackPurchases(
        IList<Item> pack,
        int packSlots,
        Item goods,
        int unitsPerPurchase,
        bool consumedByThePurchase)
    {
        if (consumedByThePurchase)
            return int.MaxValue;
        int units = Utility.GetNumberOfItemThatCanBeAddedToThisInventoryList(goods, pack, packSlots);
        return units / Math.Max(1, unitsPerPurchase);
    }

    /// <summary>
    /// Whether the engine's own purchase hook CONSUMES this entry instead of handing it to the cursor, so the pack owes
    /// it no room.
    ///
    /// <para>
    /// The hook is <c>ISalable.actionWhenPurchased(ShopId)</c>, which <c>ShopMenu.tryToPurchaseItem</c> calls at
    /// <c>ShopMenu.cs:1369</c>: when it answers true the menu discards the stack it charged for (:1369-1378), so only a
    /// false answer leaves goods a slot must take. The answers read here are the engine's own: <c>Object</c> answers
    /// <c>isRecipe.Value</c> (Object.cs:7112-7116), and <c>Tool</c> upgrades only from the <c>ClintUpgrade</c> counter and
    /// only for the tool <c>ShopBuilder.GetToolUpgradeData</c> names (Tool.cs:875-895) - the SAME call the handler already
    /// makes to read the tool the upgrade takes, so this count and the purchase cannot disagree about what an upgrade
    /// is.
    /// </para>
    /// <para>
    /// WHAT IT DOES NOT CLAIM: a few shop wrappers implement the same hook (a pet licence, a house renovation, a
    /// purchasable key item, the movie concession). For those a full pack answers <c>inventory_cannot_accept</c> where
    /// the engine would have consumed the entry. That is the only safe direction - nothing is spent and nothing is
    /// created - and it is stated here rather than hidden behind an item list that would drift.
    /// </para>
    /// </summary>
    internal static bool ShopPurchaseConsumesTheEntry(ISalable offer, string shopId, string? requiredToolId)
    {
        if (offer.IsRecipe)
            return true;
        return requiredToolId is not null && string.Equals(shopId, ShopUpgradeCounter, StringComparison.Ordinal);
    }

    /// <summary>
    /// The row inside <c>forSaleButtons</c> that holds <paramref name="saleIndex"/>, once the menu's own cursor has been
    /// moved onto the page that shows it; -1 with <paramref name="refusal"/> naming why no row can hold it.
    ///
    /// <para>
    /// A ROW, not a sale index, because the native click handler resolves the button under the pointer as
    /// <c>forSale[currentItemIndex + k]</c> (<c>ShopMenu.cs:1096-1102</c>): the number it accepts is an offset from
    /// the page on screen, so the same sale has a different one at every scroll position. Measured 2026-11-13: the
    /// translation without the scroll refused EVERY purchase past the fourth with <c>button=-1</c> - a number that is
    /// not an item, not a page and not a reason - because the menu draws four rows at a time and nothing ever moved
    /// the cursor to the page an off-screen sale sits on.
    /// </para>
    /// </summary>
    internal static int ShopSaleRowInView(ShopMenu shop, int saleIndex, out string? refusal)
    {
        int rows = shop.forSaleButtons.Count;
        if (rows > 0 && saleIndex >= 0 && saleIndex < shop.forSale.Count)
        {
            // The engine's own pager, not a coordinate: receiveScrollWheelAction(-1) is downArrowPressed()
            // (ShopMenu.cs:933-951), the same cursor move the down arrow's click makes, and the engine clamps the
            // cursor into [0, forSale.Count - 4] every time it handles a click (ShopMenu.cs:1021). Driving that cursor
            // is what makes every entry reachable; the click then lands on a row that really holds the sale.
            int lastPage = Math.Max(0, shop.forSale.Count - rows);
            int target = Math.Clamp(saleIndex, 0, lastPage);
            for (int step = 0; step <= shop.forSale.Count && shop.currentItemIndex != target; step++)
                shop.receiveScrollWheelAction(shop.currentItemIndex < target ? -1 : 1);

            int row = saleIndex - shop.currentItemIndex;
            if (row >= 0 && row < rows)
            {
                refusal = null;
                return row;
            }
        }

        refusal = ShopPageRefusal(saleIndex, shop.forSale.Count, rows);
        return -1;
    }

    /// <summary>
    /// The refusal a sale the menu's pager could not reach is answered with: which sale, out of how many pages the
    /// menu draws. Naming both is what a bare <c>button=-1</c> never did - it stated an index that is not an item, not
    /// a page and not a reason, so round42's refusal could only be read as "the shop has no such thing".
    /// </summary>
    internal static string ShopPageRefusal(int saleIndex, int saleCount, int visibleRows)
    {
        int rows = Math.Max(1, visibleRows);
        return $"shop_item_beyond_last_page:{saleIndex}:{(saleCount + rows - 1) / rows}";
    }

    /// <summary>
    /// The inventory slot that can take <paramref name="held"/> when a purchase leaves it on the cursor.
    ///
    /// <para>
    /// The engine's own placement is <c>InventoryMenu.leftClick</c> at the slot's centre, which hands the stack to
    /// <c>Utility.addItemToInventory</c> (<c>InventoryMenu.cs:318-344</c>): that call MERGES into a stack it can add to
    /// and only otherwise takes an empty slot (<c>Utility.cs:6397-6411</c>), so which slot this answers decides whether
    /// a stackable purchase is merged or left unplaceable.
    /// </para>
    /// </summary>
    internal static int ShopDropSlot(IList<Item> slots, Item? held)
    {
        if (held is null)
            return -1;

        // A stack it merges into comes FIRST, and the one with the most room wins: Utility.addItemToInventory takes the
        // whole stack or leaves the remainder on the cursor (Utility.cs:6397-6411), so a nearly-full stack chosen over
        // an emptier one would strand what did not fit. An empty slot is the fallback, never the first answer: an
        // inventory with room left but a partial stack of the same goods must still grow that stack.
        int mergeSlot = -1;
        int mergeRoom = 0;
        int emptySlot = -1;
        for (int slot = 0; slot < slots.Count; slot++)
        {
            Item? occupying = slots[slot];
            if (occupying is null)
            {
                if (emptySlot < 0)
                    emptySlot = slot;
                continue;
            }

            int room = occupying.getRemainingStackSpace();
            if (room > mergeRoom && occupying.canStackWith(held))
            {
                mergeRoom = room;
                mergeSlot = slot;
            }
        }

        return mergeSlot >= 0 ? mergeSlot : emptySlot;
    }

    /// <summary>
    /// The refusal a stack the inventory could not take is answered with. The item is named because the caller cannot
    /// act on "the purchase failed": it has to know WHICH goods are stranded - the purse already paid for them.
    /// </summary>
    internal static string ShopInventoryRefusal(Item held) => $"inventory_cannot_accept:{held.QualifiedItemId}";

    /// <summary>
    /// Whether THIS counter's own stock rows carry an item - asked of the same <c>ShopBuilder.GetShopStock</c> call the
    /// published `shopTargets` row's `stockItemIds` are built from. Null when the stock could not be read at all, which
    /// is a different answer from "its rows do not carry it".
    /// </summary>
    internal static bool? ShopStockCarries(string shopId, ShopData shopData, string qualifiedItemId)
    {
        try
        {
            Dictionary<ISalable, ItemStockInformation>? stock = ShopBuilder.GetShopStock(shopId, shopData);
            if (stock is null)
                return null;
            return stock.Keys.Any(offer => string.Equals(offer.QualifiedItemId, qualifiedItemId, StringComparison.Ordinal));
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// <summary>
    /// The evidence a counter that does not carry the item is refused with, saying WHICH absence this is.
    ///
    /// <para>
    /// THE DEFECT. Measured round81: `shop=DesertFestival_Gus;item=(O)474;stock=5` - a festival stall that held five stock
    /// rows and not this one - and the same word, in the same shape, would have been answered by a counter that stocks
    /// nothing at all. `stock=` and the code alone cannot separate "this counter does not sell it" from "nothing in this
    /// room sells it", and the second of those is what a caller has to act on: leave.
    /// </para>
    /// <para>
    /// So the receipt names the counter it read (`counter=`, the passable id - not only the shop, which has one counter
    /// per owner here), and <c>sold_here_by=</c> the counters IN THIS ROOM whose own rows do carry the item, with
    /// <c>counters_read=</c> saying how many were actually readable. `none` therefore means "no counter here positively
    /// carries it", never "no shop in the game does": `available_here` in the sibling refusals names SHOPS, and a shop
    /// being here says nothing about whether its rows carry an item - which is why it could not have answered this, and
    /// why the list that does (`shopTargets`' own `stockItemIds`) is spelled here instead.
    /// </para>
    /// </summary>
    internal static string ShopItemNotSoldEvidence(
        string shopId,
        DiscoveredShopCounter counter,
        string itemId,
        int stock,
        string soldHereBy,
        int countersRead) =>
        $"shop={shopId};counter={ShopCounterToken(counter)};item={itemId};stock={stock};"
        + $"sold_here_by={soldHereBy};counters_read={countersRead}";

    /// <summary>The counters beside <paramref name="asked"/> whose own stock carries <paramref name="qualifiedItemId"/>, and
    /// how many of them could be read - the two halves of <see cref="ShopItemNotSoldEvidence"/>'s `sold_here_by` answer.
    /// </summary>
    private static (string SoldBy, int Read) CountersCarryingItem(
        IReadOnlyList<DiscoveredShopCounter> counters,
        DiscoveredShopCounter asked,
        string qualifiedItemId)
    {
        List<DiscoveredShopCounter> carrying = new();
        int read = 0;
        foreach (DiscoveredShopCounter counter in counters)
        {
            if (string.Equals(counter.TargetId, asked.TargetId, StringComparison.Ordinal))
                continue;
            if (ShopStockCarries(counter.ShopId, counter.ShopData, qualifiedItemId) is not bool carries)
                continue;
            read++;
            if (carries)
                carrying.Add(counter);
        }

        return (SpellCounters(carrying), read);
    }

    /// <summary>
    /// The evidence a purchase the pack cannot hold is refused with, stated BEFORE the purse pays.
    ///
    /// <para>
    /// `room=` is the pack's own reading (<see cref="ShopPackPurchases"/>), `held=/unit_price=/currency=` are the money
    /// the charge would have taken - so the caller can see the purse was not the reason - and
    /// `money_before`/`money_after` and `owned_before`/`owned_after` are stated EQUAL because nothing was bought: both
    /// sides are the counts read at admission, so this is the receipt the purchase invariant is read on
    /// (tools/check-stardew-shop-purchase-pays-for-goods.mjs) and no fact here is written as a literal.
    /// </para>
    /// </summary>
    internal static string ShopPackRefusalEvidence(
        string shopId,
        string itemId,
        int requested,
        int unitPrice,
        int shopCurrency,
        long held,
        int stock,
        int room,
        int owned)
    {
        return $"shop={shopId};item={itemId};requested={requested};purchased=0;unit_price={unitPrice};"
            + $"currency={ShopCurrencyName(shopCurrency)};held={held};money_before={held};money_after={held};"
            + $"owned_before={owned};owned_after={owned};gained=0;stock={ShopStockToken(stock)};room={room}";
    }

    /// <summary>
    /// The refusal a purchase the engine itself refused is answered with, and the reason it refused.
    ///
    /// <para>
    /// The engine's confirm path is <c>ShopMenu.receiveLeftClick</c> - the same handler a player's click runs - so what
    /// it does with an entry is the engine's business: money, stock limits, stacking, and
    /// <c>ISalable.actionWhenPurchased</c> (a tool upgrade, a recipe, a recovered item) all happen inside
    /// <c>ShopMenu.tryToPurchaseItem</c> (<c>ShopMenu.cs:1319-1397</c>). None of them is done here, so a purchase that
    /// does not happen has to be answered with the engine's own reason rather than with a claim about the trade.
    /// </para>
    /// </summary>
    internal static string ShopPurchaseRefusal(string engineReason) => $"shop_purchase_refused:{engineReason}";

    public LocalExecutionReceipt RequestLocalShopPurchase(BridgeExecutionRequest request, IExecutionLedger ledger)
    {
        if (ledger.TryGetExistingReceipt(request.RequestId, out LocalExecutionReceipt existing))
            return existing;

        string executionId = ledger is IDispatchExecutionLedger dispatchLedger
            && dispatchLedger.TryGetBoundExecutionId(request.RequestId, out string boundExecutionId)
            ? boundExecutionId
            : this.ledger.NewExecutionId(request.RequestId);

        if (!this.TryGetBoundActor(out Farmer? actor, out string guardReason) || actor is null)
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, guardReason, null);

        if (this.active is not null || this.activeTravel is not null || this.activePet is not null
            || this.activeAnimalProduct is not null || this.activeItemUse is not null
            || this.activeItemPickup is not null || this.activePedestalTaking is not null
            || this.activeToolApproach is not null
            || this.activeMountTransport is not null || this.activeBusRide is not null
            || this.activeDayAdvance is not null)
        {
            return this.RejectBodyOwned(request.RequestId, executionId);
        }

        if (Game1.activeClickableMenu is not null || Game1.dialogueUp)
        {
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                "modal_open",
                $"modal={Game1.activeClickableMenu?.GetType().Name ?? "dialogue"}");
        }

        string? targetId = request.Args.ExpectedTargetId;
        if (string.IsNullOrWhiteSpace(targetId))
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, "missing_expected_target_id", null);

        if (string.IsNullOrWhiteSpace(request.Args.ExpectedQualifiedItemId))
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, "missing_expected_item", null);
        string expectedItemId = request.Args.ExpectedQualifiedItemId!;

        int quantity = request.Args.Quantity ?? 1;
        if (quantity < 1)
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, "invalid_quantity", $"quantity={quantity}");

        GameLocation? location = actor.currentLocation;
        if (location is null)
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, "world_not_ready", null);

        List<DiscoveredShopCounter> counters = EnumerateShopCounters(location);

        LocalExecutionReceipt RefuseUnreachableCounter(string evidence) =>
            this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, "shop_counter_out_of_reach", evidence);

        LocalExecutionReceipt RefuseClosedCounter(DiscoveredShopCounter counter, string? closedMessage) =>
            this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                DiscoveryExclusionReasons.ShopClosedToday,
                ShopClosedNowRefusal(
                    counter.ShopId,
                    counter.OwnerName,
                    counter.CounterX,
                    counter.CounterY,
                    actor.TilePoint.X,
                    actor.TilePoint.Y,
                    closedMessage));

        DiscoveredShopCounter? chosen = null;
        foreach (DiscoveredShopCounter candidate in counters)
        {
            if (candidate.OpensNow && string.Equals(candidate.TargetId, targetId, StringComparison.Ordinal))
            {
                chosen = candidate;
                break;
            }
        }

        if (chosen is not DiscoveredShopCounter target)
        {
            foreach (DiscoveredShopCounter candidate in counters)
            {
                if (candidate.OpensNow || !string.Equals(candidate.TargetId, targetId, StringComparison.Ordinal))
                    continue;
                return RefuseClosedCounter(candidate, candidate.ClosedMessage);
            }

            string knownHere = string.Join(",", counters.Where(c => c.OpensNow).Select(c => c.ShopId).Distinct().Take(8));

            // THE ARGUMENT'S CONTRACT IS A COUNTER, AND A SHOP ID IS NOT ONE. Measured round81: two of three attempts
            // passed `target=SeedShop` while the actor stood IN SeedShop, and both answered `shop_target_unavailable` -
            // a word that named no kind, so the receipt could not say the value was a shop rather than a counter that had
            // gone away. Classifying it costs one read of the world's own shop table and names what it could mean.
            if (NamesAKnownShop(targetId, KnownShops()))
            {
                return this.RememberTerminal(
                    request.RequestId,
                    executionId,
                    ExecutionState.Rejected,
                    ShopIdAsCounterRefusalCode(targetId),
                    ShopIdTargetRefusalEvidence(targetId, location.NameOrUniqueName, counters, knownHere));
            }

            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                "shop_target_unavailable",
                $"target={targetId};location={location.NameOrUniqueName};available_here={knownHere}");
        }

        bool tileOpened = target.OwnerName.Length == 0;
        string? reachRefusal = ShopCounterReachRefusal(
            tileOpened, target.OwnerName, target.CounterX, target.CounterY, actor);
        if (reachRefusal is not null)
            return RefuseUnreachableCounter(reachRefusal);

        // A tile-opened shop's counter is the tile. The counter's own Action, re-read on the
        // game thread, decides which native call this target's case makes: the fixed
        // selectors all dispatch the STRING overload with a null owner (listed in
        // TryResolveTileShop), while `OpenShop` without arguments dispatches the LOCATION
        // overload with no owner area and forceOpen -- and only that form reproduces the
        // case's own closed-message refusal (Utility.cs:4305-4317). Opening a gated stall
        // anyway would be a gate bypass.
        string? counterAction = tileOpened
            ? ReadBuildingsLayerAction(location, new Microsoft.Xna.Framework.Point(target.CounterX, target.CounterY))
            : null;
        bool counterIsOpenShop = counterAction is not null
            && string.Equals(
                ArgUtility.SplitBySpace(counterAction).FirstOrDefault(),
                "OpenShop",
                StringComparison.Ordinal);

        if (tileOpened && string.Equals(target.ShopId, "Bookseller", StringComparison.Ordinal))
        {
            // Bookseller is the only advertised tile selector whose native case has a gate
            // of its own (GameLocation.cs:8727-8744): it opens only on the season's
            // bookseller days, and otherwise asks a Buy/Trade/Leave question instead. This
            // seam reproduces neither, so it refuses rather than opening a shop a real
            // click would not have opened.
            if (!Utility.getDaysOfBooksellerThisSeason().Contains(Game1.dayOfMonth))
                return this.RememberTerminal(
                    request.RequestId,
                    executionId,
                    ExecutionState.Rejected,
                    "shop_tile_gate_refused",
                    $"shop={target.ShopId};counter={target.CounterX},{target.CounterY};day={Game1.dayOfMonth};gate=bookseller_day");
            if (Game1.player.mailReceived.Contains("read_a_book"))
                return this.RememberTerminal(
                    request.RequestId,
                    executionId,
                    ExecutionState.Rejected,
                    "shop_tile_requires_dialogue",
                    $"shop={target.ShopId};counter={target.CounterX},{target.CounterY};gate=bookseller_choice");
        }

        List<string> clickDiagnostics = new();
        List<string> dropDiagnostics = new();
        string? purchaseRefusal = null;

        Dictionary<ISalable, ItemStockInformation> stock;
        try
        {
            stock = ShopBuilder.GetShopStock(target.ShopId) ?? new Dictionary<ISalable, ItemStockInformation>();
        }
        catch (Exception stockException)
        {
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Uncertain,
                "shop_stock_unreadable",
                $"shop={target.ShopId};native_exception={stockException.GetType().Name}");
        }

        ISalable? offer = stock.Keys.FirstOrDefault(item =>
            string.Equals(item.QualifiedItemId, expectedItemId, StringComparison.Ordinal));
        if (offer is null)
        {
            (string soldHereBy, int countersRead) = CountersCarryingItem(counters, target, expectedItemId);
            string notSoldEvidence = ShopItemNotSoldEvidence(target.ShopId, target, expectedItemId, stock.Count, soldHereBy, countersRead);
            // WHICH ABSENCE THIS IS, in the code and not only in the evidence (`round84`: two purchases were refused
            // `item_not_sold_here` at counters whose neighbour DID carry the item, so the refusal named "nobody here
            // sells it" about a room that sold it). `sold_here_by=` names the counter that does; the code says whether
            // this counter's rows are the only answer or another counter in this room is the address.
            if (soldHereBy.Length == 0)
                return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, "item_not_sold_here", notSoldEvidence);
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, "item_sold_by_another_counter", notSoldEvidence);
        }

        // The price the menu charges, read from the SAME stock entry this purchase is made from. ShopMenu
        // multiplies `ItemStockInformation.Price` by the units it charges (ShopMenu.cs:1337), and
        // `ShopBuilder.GetBasePrice` produced that number from the shop's own row (ShopBuilder.cs:221-237); the
        // `seedSupplyTargets` row publishes the same field through `ReadShopStock`, so a price she is told and a
        // price she is judged by are one fact.
        //
        // `offer.salePrice()` is NOT that number. It is the item's own value - what selling it would fetch - and
        // for a seed it differs from the shop's asking price: measured 2026-11-12, an item whose Data/Objects price
        // is 100 has `salePrice(ignoreProfitMargins: true)` 200, while a Data/Shops row may charge 20 for it. Judging
        // the purse by the value refused a purchase the purse could pay for (`insufficient_money` at 50g against a
        // 20g seed), and it made the receipt's `unit_price` a number the charge never moved.
        ItemStockInformation charged = stock[offer];
        int unitPrice = charged.Price;
        // A ShopMenu prices every entry in the currency its own ShopData declares: Utility.TryOpenShopMenu
        // builds the menu from that ShopData and Initialize stores shopData.Currency (ShopMenu.cs:304, :371),
        // and ShopMenu.getPlayerCurrencyAmount (ShopMenu.cs:881-891) is the native map from that value to the
        // player field the charge actually moves (0 money, 1 festivalScore, 2 clubCoins, 4 QiGems). Gating and
        // judging the purchase against actor.Money would refuse an affordable club-coin or Qi-gem trade and
        // then read the real one as having spent nothing.
        int shopCurrency = ShopCurrencyFor(target.ShopId);
        long currencyHeld = ShopMenu.getPlayerCurrencyAmount(actor, shopCurrency);
        int ownedBefore = actor.Items.Where(i => i is not null)
            .Where(i => string.Equals(i.QualifiedItemId, expectedItemId, StringComparison.Ordinal))
            .Sum(i => i.Stack);

        // Which pack item this entry consumes, read BEFORE the click: `GetToolUpgradeData` filters on the required tool
        // still being in the pack (ShopBuilder.cs:171), so after `Tool.actionWhenPurchased` removed it (:882-888) the
        // same call answers a different row. The rule is the engine's own (:879-888 only removes what
        // `GetToolUpgradeData` names), not a second one; a shop entry that is not a tool upgrade has no required item and
        // the three facts below stay zero. Read HERE rather than after admission because the pack gate below is asked
        // the same question the hook answers: whether these goods ever reach the pack.
        Tool? upgradeEntry = offer as Tool;
        string? requiredToolId = upgradeEntry is null
            ? null
            : ShopBuilder.GetToolUpgradeData(upgradeEntry.GetToolData(), actor)?.RequireToolId;
        string requiredToolQualifiedId = requiredToolId is null
            ? string.Empty
            : actor.Items.GetById(requiredToolId).FirstOrDefault()?.QualifiedItemId ?? string.Empty;
        int requiredToolBefore = requiredToolId is null ? 0 : actor.Items.CountId(requiredToolId);

        Item? goods = offer.GetSalableInstance() as Item;
        int packPurchases = goods is null
            ? int.MaxValue
            : ShopPackPurchases(
                actor.Items,
                actor.maxItems.Value,
                goods,
                Math.Max(1, offer.Stack),
                ShopPurchaseConsumesTheEntry(offer, target.ShopId, requiredToolId));
        (long affordable, int purchasable) = ShopPurchaseCapacity(charged, currencyHeld, quantity, packPurchases);
        if (affordable < 1)
        {
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                "insufficient_money",
                ShopPurchaseAffordabilityEvidence(target.ShopId, expectedItemId, unitPrice, shopCurrency, currencyHeld));
        }
        if (charged.Stock < 1)
        {
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                "out_of_stock",
                $"shop={target.ShopId};item={expectedItemId};stock={ShopStockToken(charged.Stock)}");
        }
        if (packPurchases < 1 && goods is not null)
        {
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                ShopInventoryRefusal(goods),
                ShopPackRefusalEvidence(
                    target.ShopId,
                    expectedItemId,
                    quantity,
                    unitPrice,
                    shopCurrency,
                    currencyHeld,
                    charged.Stock,
                    packPurchases,
                    ownedBefore));
        }

        long currencyBefore = ShopMenu.getPlayerCurrencyAmount(actor, shopCurrency);
        int stockBefore = stock[offer].Stock;

        ShopMenu? menu = null;
        try
        {
            // The engine's own entry, per counter form:
            //
            //   * an NPC-run counter goes through the FREE-ROAMING location overload - the call the engine's own
            //     counter cases make (SandyHouse GameLocation.cs:10776, Saloon :10836, Desert Desert.cs:71). It resolves
            //     the eligible owner entries, searches the room's characters for one of those NPCs (Utility.cs:4243-4268),
            //     draws `ClosedMessage` and refuses instead of opening when that entry is shut (:4305-4317), and opens
            //     nothing when no entry can run the counter (:4318-4323). Measured round42: opening with the STRING
            //     overload would have bypassed every one of those checks - that overload's own documentation says it opens
            //     "regardless of whether they're present" (Utility.cs:4172).
            //   * a tile-opened shop needs no owner name: the game documents a null owner as "open the shop with no NPC
            //     portrait/dialogue" (Utility.cs:4174) and each fixed selector's native case calls it that way. The
            //     suppression states the game's own contract, and naming the argument also selects the string overload.
            bool shopOpened = tileOpened
                ? counterIsOpenShop
                    ? Utility.TryOpenShopMenu(target.ShopId, location, ownerArea: null, maxOwnerY: null, forceOpen: true)
                    : Utility.TryOpenShopMenu(shopId: target.ShopId, ownerName: null!)
                : Utility.TryOpenShopMenu(target.ShopId, location, ownerArea: null, maxOwnerY: null, forceOpen: false);
            if (!shopOpened)
            {
                string nativeClosedMessage = Game1.activeClickableMenu is DialogueBox closedBox
                    ? string.Join(" | ", closedBox.dialogues)
                    : string.Empty;
                if (Game1.activeClickableMenu is DialogueBox)
                    ((DialogueBox)Game1.activeClickableMenu).closeDialogue();

                string? closedMessage = string.IsNullOrEmpty(nativeClosedMessage)
                    ? GameStateQueryClosedMessageFor(target.ShopId, target.OwnerName)
                    : nativeClosedMessage;
                if (!string.IsNullOrEmpty(closedMessage))
                    return RefuseClosedCounter(target, closedMessage);

                return RefuseUnreachableCounter(
                    ShopCounterReachEvidence(
                            target.OwnerName, target.CounterX, target.CounterY, actor.TilePoint.X, actor.TilePoint.Y)
                        + ";native=no_current_owner");
            }

            if (Game1.activeClickableMenu is not ShopMenu opened)
            {
                return this.RememberTerminal(
                    request.RequestId,
                    executionId,
                    ExecutionState.Uncertain,
                    "shop_menu_unavailable",
                    $"shop={target.ShopId};menu={Game1.activeClickableMenu?.GetType().Name ?? "none"}");
            }
            menu = opened;

            int SaleIndexOf(ShopMenu shop) => shop.forSale.FindIndex(candidate => string.Equals(
                candidate?.QualifiedItemId, expectedItemId, StringComparison.Ordinal));

            int saleIndex = SaleIndexOf(menu);
            if (saleIndex < 0)
            {
                return this.RememberTerminal(
                    request.RequestId,
                    executionId,
                    ExecutionState.Rejected,
                    $"shop_item_absent_from_sale:{expectedItemId}",
                    $"shop={target.ShopId};item={expectedItemId};offers={menu.forSale.Count}");
            }

            int row = ShopSaleRowInView(menu, saleIndex, out string? pageRefusal);
            if (row < 0)
            {
                return this.RememberTerminal(
                    request.RequestId,
                    executionId,
                    ExecutionState.Rejected,
                    pageRefusal!,
                    $"shop={target.ShopId};item={expectedItemId};offers={menu.forSale.Count};"
                    + $"rows={menu.forSaleButtons.Count};cursor={menu.currentItemIndex}");
            }

            // One native click per unit; the game decrements stock and moves money itself.
            // The menu's own anti-misclick delay must not swallow a programmatic click.
            //
            // ShopMenu.receiveLeftClick only reaches its purchase branch when
            // `safetyTimer <= 0` (ShopMenu.cs:1022); the field STARTS at 250
            // (ShopMenu.cs:264) and is decremented by the menu's own update
            // (ShopMenu.cs:1751). A click issued in the same frame the menu opened is
            // therefore silently ignored — measured live: money unchanged and inventory
            // unchanged (purchase_not_effective) despite a perfectly valid offer.
            //
            // 250 ms guards against a human double-tapping the mouse. Waiting it out would
            // only make a scripted purchase slower without changing any outcome, so the
            // guard is cleared explicitly instead of simulated. It is a UI flap counter,
            // not world state: no game fact depends on it.
            menu.safetyTimer = 0;

            for (int bought = 0; bought < purchasable; bought++)
            {
                if (Game1.activeClickableMenu is not ShopMenu stillOpen || !ReferenceEquals(stillOpen, menu))
                {
                    purchaseRefusal = ShopPurchaseRefusal("menu_closed");
                    break;
                }

                int saleRow = SaleIndexOf(menu);
                if (saleRow < 0)
                {
                    purchaseRefusal = $"shop_item_absent_from_sale:{expectedItemId}";
                    break;
                }

                saleRow = ShopSaleRowInView(menu, saleRow, out string? loopPageRefusal);
                if (saleRow < 0)
                {
                    purchaseRefusal = loopPageRefusal;
                    break;
                }

                ClickableComponent button = menu.forSaleButtons[saleRow];
                long currencyBeforeClick = ShopMenu.getPlayerCurrencyAmount(actor, shopCurrency);
                int? stockBeforeClick = stock.TryGetValue(offer, out ItemStockInformation? s0) && s0 is not null ? s0.Stock : null;
                int safetyBefore = menu.safetyTimer;
                bool heldNull = menu.heldItem is null;
                int clickX = button.bounds.Center.X;
                int clickY = button.bounds.Center.Y;
                bool addressedToButton = button.containsPoint(clickX, clickY);

                // The engine's own confirm path: ShopMenu.receiveLeftClick is the handler a player's click runs, and
                // its purchase branch does the money, the stock limit, the stacking and `actionWhenPurchased`
                // (ShopMenu.cs:1096-1140, 1319-1421). Nothing about the trade is computed here.
                menu.receiveLeftClick(clickX, clickY, playSound: true);

                long currencyAfterClick = ShopMenu.getPlayerCurrencyAmount(actor, shopCurrency);
                int? stockAfterClick = stock.TryGetValue(offer, out ItemStockInformation? s1) && s1 is not null ? s1.Stock : null;
                clickDiagnostics.Add(
                    $"click{bought}:row={saleRow}|cursor={menu.currentItemIndex}|at={clickX},{clickY}|addressed={addressedToButton}|"
                    + $"safety_before={safetyBefore}|held_null={heldNull}|"
                    + $"currency={currencyBeforeClick}->{currencyAfterClick}|"
                    + $"stock={ShopStockToken(stockBeforeClick)}->{ShopStockToken(stockAfterClick)}|"
                    + $"held_after={menu.heldItem?.QualifiedItemId ?? "none"}");

                if (currencyAfterClick == currencyBeforeClick)
                {
                    // The engine's purchase charged nothing. Two shapes produce that, and they need different answers:
                    // an item already on the cursor reaches only the `held_item.canStackWith(item)` branch
                    // (ShopMenu.cs:1431), which silently does nothing when the two do not stack; with an empty cursor
                    // the click never entered the branch at all.
                    purchaseRefusal = ShopPurchaseRefusal(heldNull ? "native_click_refused" : "held_item_occupied");
                    break;
                }

                // The purchase leaves the goods ON THE CURSOR, not in the inventory: tryToPurchaseItem assigns
                // heldItem = item.GetSalableInstance() (ShopMenu.cs:1352) and only clears it for items whose
                // actionWhenPurchased consumed them (:1369-1378). A real player then clicks an inventory slot to put
                // them away, so this does the same: receiveLeftClick routes coordinates inside the inventory to
                // inventory.leftClick (ShopMenu.cs:1094), the game's own placement step.
                Item? held = menu.heldItem as Item;
                string heldBeforeDrop = held?.QualifiedItemId ?? "none";
                int dropSlot = -1;
                string dropAt = "none";
                if (held is not null)
                {
                    // The ITEM LIST is what decides, not ClickableComponent.item: the menu builds its slots as
                    // `new ClickableComponent(bounds, j.ToString())` (InventoryMenu.cs:103) and never assigns `.item`,
                    // so selecting on that field picked slot 0 every time.
                    List<ClickableComponent>? slots = menu.inventory?.inventory;
                    IList<Item>? actual = menu.inventory?.actualInventory;
                    if (slots is not null && actual is not null)
                    {
                        dropSlot = ShopDropSlot(actual, held);
                        if (dropSlot >= 0 && (dropSlot >= slots.Count || slots[dropSlot].bounds.Width <= 0))
                            dropSlot = -1;
                    }

                    if (dropSlot >= 0)
                    {
                        dropAt = $"{slots![dropSlot].bounds.Center.X},{slots[dropSlot].bounds.Center.Y}";
                        menu.receiveLeftClick(
                            slots[dropSlot].bounds.Center.X,
                            slots[dropSlot].bounds.Center.Y,
                            playSound: true);
                    }
                }
                string heldAfterDrop = menu.heldItem?.QualifiedItemId ?? "none";
                dropDiagnostics.Add(
                    $"drop{bought}:slot={dropSlot}|at={dropAt}|held={heldBeforeDrop}->{heldAfterDrop}");

                if (menu.heldItem is Item stranded)
                {
                    purchaseRefusal = ShopInventoryRefusal(stranded);
                    break;
                }
            }
        }
        catch (Exception nativeException)
        {
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Uncertain,
                "shop_purchase_native_exception",
                $"shop={target.ShopId};item={expectedItemId};native_exception={nativeException.GetType().Name}");
        }

        // Close whatever is still open, using the native step (Game1.exitActiveMenu is what
        // ShopMenu's own exit path calls), so the body is free for the next action.
        if (Game1.activeClickableMenu is ShopMenu)
        {
            try
            {
                Game1.exitActiveMenu();
            }
            catch (Exception)
            {
            }
        }

        long currencyAfter = ShopMenu.getPlayerCurrencyAmount(actor, shopCurrency);
        int ownedAfter = actor.Items.Where(i => i is not null)
            .Where(i => string.Equals(i.QualifiedItemId, expectedItemId, StringComparison.Ordinal))
            .Sum(i => i.Stack);
        int gained = ownedAfter - ownedBefore;
        // The upgrade the engine ran also MOUNTS ITS OWN NOTICE and freezes the actor: `Tool.actionWhenPurchased` calls
        // Game1.exitActiveMenu then Game1.DrawDialogue(Clint, ...) (Tool.cs:892-893), and DrawDialogue pushes a
        // DialogueBox onto activeClickableMenu and sets player.CanMove = false (Game1.cs:9614-9625). The body is only
        // free once that box is closed - `menu_closed` alone would not say so, because it tests for a ShopMenu. Closed
        // here with the same public step the closed-message path above uses.
        Tool? upgradedTool = actor.toolBeingUpgraded?.Value;
        int daysLeftForToolUpgrade = actor.daysLeftForToolUpgrade?.Value ?? 0;
        int requiredToolAfter = requiredToolId is null ? 0 : actor.Items.CountId(requiredToolId);
        string purchaseDialogue = "none";
        if (upgradedTool is not null && Game1.activeClickableMenu is DialogueBox upgradeNotice)
        {
            purchaseDialogue = "closed";
            upgradeNotice.closeDialogue();
        }
        bool menuClosed = Game1.activeClickableMenu is not ShopMenu;

        string evidence = ShopPurchaseReceipt(new ShopPurchaseReceiptFacts(
            ShopId: target.ShopId,
            OwnerName: target.OwnerName,
            TileOpened: tileOpened,
            ItemId: expectedItemId,
            Requested: quantity,
            Purchased: purchasable,
            UnitPrice: unitPrice,
            CurrencyBefore: currencyBefore,
            CurrencyAfter: currencyAfter,
            OwnedBefore: ownedBefore,
            OwnedAfter: ownedAfter,
            StockBefore: stockBefore,
            StockAfter: stock.TryGetValue(offer, out ItemStockInformation? stockAfterReading) && stockAfterReading is not null
                ? stockAfterReading.Stock
                : null,
            CounterX: target.CounterX,
            CounterY: target.CounterY,
            MenuClosed: menuClosed,
            Clicks: clickDiagnostics,
            Drops: dropDiagnostics,
            UpgradedToolId: upgradedTool?.QualifiedItemId,
            DaysLeftForToolUpgrade: daysLeftForToolUpgrade,
            RequiredToolQualifiedId: requiredToolQualifiedId,
            RequiredToolBefore: requiredToolBefore,
            RequiredToolAfter: requiredToolAfter,
            PurchaseDialogue: purchaseDialogue));

        ShopPurchaseOutcome outcome = ShopPurchaseOutcomeFor(
            currencyBefore,
            currencyAfter,
            gained,
            purchaseRefusal,
            expectedItemId,
            upgradedTool?.QualifiedItemId,
            daysLeftForToolUpgrade,
            requiredToolId,
            requiredToolBefore,
            requiredToolAfter);
        return this.RememberTerminal(
            request.RequestId,
            executionId,
            outcome.State,
            outcome.ReasonCode,
            evidence,
            outcome.State == ExecutionState.Succeeded ? this.TryCreateLocalObservation(actor) : null);
    }
}

/// <summary>
/// `seedSupplyTargets`: where the seeds this actor HOLDS are sold, what the menu would charge, and whether the shop's
/// own hours query says it is open right now.
///
/// <para>
/// Measured 2026-11-09: a day whose task was a three-wide strip twenty long, two seed stacks in the pack, four tiles
/// planted, and then "种子就这些了，想铺满二十格还得再买种" - and asked afterwards, the companion had never considered
/// buying seed. The shortage was discoverable and the supply was not. `shopTargets` publishes only shops whose owner
/// stands in the CURRENT location, so on the farm at 06:00 it published nothing at all, and no field anywhere carried a
/// price or a trading window. This family is that missing half, published so the shortage and its source arrive
/// together instead of the companion having to think of a shop that nothing had mentioned.
/// </para>
/// <para>
/// The population is the inventory `plant_seed` already publishes from - an <c>Object</c> in the engine's seeds
/// category - so no list of seed ids lives here, and a seed she does not hold is not a row. The world's shop set is
/// <c>Data/Shops</c> read through <c>ReadShopStock</c>, the same reader the shop targets use, so "no shop sells it" is a
/// measurement rather than a guess.
/// </para>
/// </summary>
internal sealed partial class ExecutionManager
{
    private const int MaxSeedSupplyRows = 8;

    private static int seedSupplyScanDay = int.MinValue;
    private static string seedSupplyScanKey = string.Empty;
    private static IReadOnlyList<(string QualifiedItemId, string ShopId, int Price)> seedSupplyScan =
        Array.Empty<(string QualifiedItemId, string ShopId, int Price)>();

    private IReadOnlyList<BridgeSeedSupplyTarget> DiscoverSeedSupplyTargets(
        Farmer player,
        IReadOnlyList<BridgeInventoryItemFact>? inventoryItemFacts,
        IReadOnlyList<BridgeShopTarget>? shopTargetsHere,
        out int omitted)
    {
        omitted = 0;
        List<string> seedIds = new();
        Dictionary<string, List<int>> slotsBySeed = new(StringComparer.Ordinal);
        foreach ((StardewValley.Item? item, int slot) in player.Items.Select((item, slot) => (item, slot)))
        {
            if (item is not StardewValley.Object held
                || held.Category != StardewValley.Object.SeedsCategory
                || string.IsNullOrEmpty(held.QualifiedItemId))
                continue;
            if (!slotsBySeed.TryGetValue(held.QualifiedItemId, out List<int>? slots))
            {
                slots = new List<int>();
                slotsBySeed[held.QualifiedItemId] = slots;
                seedIds.Add(held.QualifiedItemId);
            }
            slots.Add(slot);
        }
        if (seedIds.Count == 0)
            return Array.Empty<BridgeSeedSupplyTarget>();

        string scanKey = string.Join(",", seedIds);
        int day = Game1.Date?.TotalDays ?? -1;
        if (seedSupplyScanDay != day || !string.Equals(seedSupplyScanKey, scanKey, StringComparison.Ordinal))
        {
            seedSupplyScan = ScanSeedSupply(seedIds);
            seedSupplyScanDay = day;
            seedSupplyScanKey = scanKey;
        }

        Dictionary<string, ShopData> shops;
        try
        {
            shops = DataLoader.Shops(Game1.content);
        }
        catch (Exception)
        {
            return Array.Empty<BridgeSeedSupplyTarget>();
        }

        List<BridgeSeedSupplyTarget> rows = new();
        foreach (string seedId in seedIds)
        {
            int? heldCount = HeldSeedCount(inventoryItemFacts, seedId, slotsBySeed[seedId]);
            string displayName = RequireDisplayName(seedId);
            bool stockedSomewhere = false;
            foreach ((string QualifiedItemId, string ShopId, int Price) entry in seedSupplyScan)
            {
                if (!string.Equals(entry.QualifiedItemId, seedId, StringComparison.Ordinal))
                    continue;
                if (!shops.TryGetValue(entry.ShopId, out ShopData? shopData) || shopData is null)
                    continue;
                stockedSomewhere = true;
                IReadOnlyList<ShopOwnerData>? eligibleOwners;
                try
                {
                    eligibleOwners = ShopBuilder.GetCurrentOwners(shopData).ToArray();
                }
                catch (Exception)
                {
                    eligibleOwners = null;
                }
                rows.Add(SeedSupplyRow(
                    seedId,
                    displayName,
                    heldCount,
                    entry.ShopId,
                    ShopDisplayName(entry.ShopId),
                    shopData,
                    entry.Price,
                    eligibleOwners,
                    shopTargetsHere,
                    ShopOwningLocation(entry.ShopId)));
            }
            if (!stockedSomewhere)
                rows.Add(SeedWithoutSupplyRow(seedId, displayName, heldCount));
        }
        omitted = Math.Max(0, rows.Count - MaxSeedSupplyRows);
        return rows.Count > MaxSeedSupplyRows ? rows.GetRange(0, MaxSeedSupplyRows) : rows;
    }

    private static IReadOnlyList<(string QualifiedItemId, string ShopId, int Price)> ScanSeedSupply(
        IReadOnlyList<string> seedIds)
    {
        List<(string QualifiedItemId, string ShopId, int Price)> found = new();
        Dictionary<string, ShopData> shops;
        try
        {
            shops = DataLoader.Shops(Game1.content);
        }
        catch (Exception)
        {
            return found;
        }
        foreach ((string shopId, ShopData shopData) in shops)
        {
            if (shopData is null)
                continue;
            ReadShopStock(shopId, shopData, out _, out _, out Dictionary<string, int> priceByQualifiedItemId);
            foreach (string seedId in seedIds)
            {
                if (priceByQualifiedItemId.TryGetValue(seedId, out int price))
                    found.Add((seedId, shopId, price));
            }
        }
        return found;
    }

    /// <summary>
    /// One row for a seed the actor holds and NO shop in `Data/Shops` stocks: the seed and its count, and no shop half.
    ///
    /// The address half states WHY it carries no address rather than leaving all three fields absent: a row nothing
    /// could be reached from must say whether the shop is elsewhere or does not exist, because <c>price</c> and
    /// <c>openNow</c> are absent here too and an absent address beside them would read as "not measured".
    /// </summary>
    internal static BridgeSeedSupplyTarget SeedWithoutSupplyRow(string qualifiedItemId, string displayName, int? heldCount) =>
        new(qualifiedItemId, displayName, heldCount, null, null, null, null, null, null, null, null, null,
            ShopLocationUnknown: "no_shop_stocks_this_seed");

    /// <summary>
    /// One supply row, projected from the shop's OWN data: the declared owner and its hours query, the price the menu
    /// charges, the row's declared price, the engine's open-now answer, and where in the world that shop is.
    ///
    /// <c>openNow</c> is three-valued on purpose. <c>null</c> means the question could not be asked - the shop declares
    /// no owner entry (<c>no_owner_entry</c>) or its condition could not be evaluated
    /// (<c>owner_condition_unreadable</c>) - and a reader must not see that as "closed".
    ///
    /// <paramref name="shopTargetsHere"/> is the shop-target list `CreateBridgeSnapshot` published for this location
    /// (the family `shop_purchase` addresses), and <paramref name="owningLocation"/> is the <c>GameLocation</c> this
    /// shop id names. Both are READ, never re-derived, so the address half of this row and the `shopTargets` row it
    /// names are one fact with one producer.
    /// </summary>
    internal static BridgeSeedSupplyTarget SeedSupplyRow(
        string qualifiedItemId,
        string displayName,
        int? heldCount,
        string shopId,
        string shopDisplayName,
        ShopData shopData,
        int price,
        IReadOnlyList<ShopOwnerData>? eligibleOwners,
        IReadOnlyList<BridgeShopTarget>? shopTargetsHere,
        GameLocation? owningLocation)
    {
        List<ShopOwnerData> owners = shopData.Owners ?? new List<ShopOwnerData>();
        ShopOwnerData? owner = owners.FirstOrDefault(
                candidate => candidate is not null
                    && candidate.Type == ShopOwnerType.NamedNpc
                    && !string.IsNullOrWhiteSpace(candidate.Name))
            ?? owners.FirstOrDefault(candidate => candidate is not null);
        string ownerName = owner?.Name ?? string.Empty;
        string? hoursCondition = string.IsNullOrWhiteSpace(owner?.Condition) ? null : owner!.Condition;
        bool? openNow;
        string? openNowReason;
        if (owner is null)
        {
            openNow = null;
            openNowReason = "no_owner_entry";
        }
        else if (eligibleOwners is null)
        {
            openNow = null;
            openNowReason = "owner_condition_unreadable";
        }
        else
        {
            openNow = OpensNow(SelectCurrentShopOwner(eligibleOwners, ownerName));
            openNowReason = null;
        }
        (BridgeSeedSupplyDestination? Destination, string? Location, string? Unknown) address = ResolveShopAddress(
            shopId, ownerName, shopDisplayName, shopTargetsHere, owningLocation);
        return new BridgeSeedSupplyTarget(
            qualifiedItemId,
            displayName,
            heldCount,
            shopId,
            shopDisplayName,
            ownerName,
            hoursCondition,
            price,
            DeclaredSeedPrice(shopData, qualifiedItemId),
            shopData.Currency,
            openNow,
            openNowReason,
            address.Destination,
            address.Location,
            address.Unknown);
    }

    private static int? HeldSeedCount(
        IReadOnlyList<BridgeInventoryItemFact>? inventoryItemFacts,
        string qualifiedItemId,
        List<int> slots)
    {
        if (inventoryItemFacts is null)
            return null;
        int total = 0;
        int covered = 0;
        foreach (BridgeInventoryItemFact fact in inventoryItemFacts)
        {
            if (!slots.Contains(fact.Slot)
                || !string.Equals(fact.QualifiedItemId, qualifiedItemId, StringComparison.Ordinal))
                continue;
            total += fact.Stack;
            covered += 1;
        }
        return covered == slots.Count ? total : null;
    }

    private static int? DeclaredSeedPrice(ShopData shopData, string qualifiedItemId)
    {
        string unqualified = qualifiedItemId.StartsWith("(O)", StringComparison.Ordinal)
            ? qualifiedItemId[3..]
            : qualifiedItemId;
        foreach (ShopItemData entry in shopData.Items ?? new List<ShopItemData>())
        {
            if (entry is null || string.IsNullOrEmpty(entry.ItemId))
                continue;
            if (!string.Equals(entry.ItemId, qualifiedItemId, StringComparison.Ordinal)
                && !string.Equals(entry.ItemId, unqualified, StringComparison.Ordinal))
                continue;
            return entry.Price < 0f ? null : (int)entry.Price;
        }
        return null;
    }

    /// <summary>
    /// The `GameLocation` a `Data/Shops` id names - the room the shop's counter stands in - or null when the id names
    /// no map at all (a stall, the casino, a festival shop).
    ///
    /// ONE reader, because TWO facts are projected from it: the shop's displayed name and the location half of the
    /// supply row's address. `Game1.getLocationFromName` is the engine's own lookup, and a shop id is a map name
    /// precisely because the shop's counter lives in that map.
    /// </summary>
    private static GameLocation? ShopOwningLocation(string shopId)
    {
        try
        {
            return Game1.getLocationFromName(shopId);
        }
        catch (Exception)
        {
            return null;
        }
    }

    private static (BridgeSeedSupplyDestination? Destination, string? Location, string? Unknown) ResolveShopAddress(
        string shopId,
        string ownerName,
        string shopDisplayName,
        IReadOnlyList<BridgeShopTarget>? shopTargetsHere,
        GameLocation? owningLocation)
    {
        BridgeShopTarget? counter = null;
        if (shopTargetsHere is not null)
        {
            foreach (BridgeShopTarget candidate in shopTargetsHere)
            {
                if (!string.Equals(candidate.ShopId, shopId, StringComparison.Ordinal))
                    continue;
                if (string.Equals(candidate.OwnerName, ownerName, StringComparison.Ordinal))
                {
                    counter = candidate;
                    break;
                }
                counter ??= candidate;
            }
        }
        if (counter is not null)
        {
            string label = ownerName.Length > 0
                ? ownerName
                : shopDisplayName.Length > 0 ? shopDisplayName : shopId;
            return (
                new BridgeSeedSupplyDestination(
                    counter.Location,
                    counter.TargetId,
                    new BridgeTile(counter.OwnerTileX, counter.OwnerTileY),
                    label),
                null,
                null);
        }
        return owningLocation is not null
            ? (null, owningLocation.NameOrUniqueName, null)
            : (null, null, "shop_location_unreadable");
    }

    private static string ShopDisplayName(string shopId)
    {
        GameLocation? location = ShopOwningLocation(shopId);
        if (location is null)
            return string.Empty;
        try
        {
            return location.DisplayName;
        }
        catch (Exception)
        {
            return string.Empty;
        }
    }
}
