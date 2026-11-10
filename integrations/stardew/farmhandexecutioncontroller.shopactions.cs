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
    /// <summary>The Host's published cap on <c>shopTargets</c> (host/src/protocol.ts), which the
    /// one snapshot contract enforces; exceeding it invalidates the WHOLE snapshot.</summary>
    private const int MaxShopTargets = 32;
    /// <summary>How many tile-opened shops one location may contribute.</summary>
    private const int MaxTileShopTargets = 8;

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
            // A malformed content pack must not take the whole snapshot down. "Could not be resolved" is stated by the
            // caller as a null answer, never as "closed".
            return null;
        }

        return SelectCurrentShopOwner(owners.ToArray(), ownerName);
    }

    /// <summary>
    /// The selection half of <see cref="ResolveCurrentShopOwner"/>, split out so the rule can be asserted on real
    /// <see cref="ShopOwnerData"/> rows without a world (the condition evaluation in
    /// <c>ShopBuilder.GetCurrentOwners</c> needs the game).
    /// </summary>
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

    /// <summary>
    /// One counter in the actor's current room: the identity discovery mints for it, the tile it is acted on from, and
    /// the engine's OPEN verdict.
    ///
    /// <para>
    /// Two readers share this ONE enumeration: discovery publishes the open counters (recording
    /// <c>shop_closed_today</c> for the others), and the purchase path resolves the caller's id against it - so a caller
    /// holding a stale id is answered with "this counter shuts today" in the game's own words, not with a distance it
    /// would then try to close.
    /// </para>
    /// <para>
    /// It carries no stock. Resolving the item queries behind a shop's stock is the expensive half (<c>seedSupplyTargets</c>
    /// caches it per day for exactly that reason), and a withheld counter is never published, so only
    /// <see cref="PublishShopCounter"/> pays for it.
    /// </para>
    /// </summary>
    private readonly record struct DiscoveredShopCounter(
        string TargetId,
        string ShopId,
        ShopData ShopData,
        string OwnerName,
        int CounterX,
        int CounterY,
        bool OpensNow,
        string? ClosedMessage);

    internal static string ShopTargetId(string shopId, string ownerName) =>
        $"shop_{Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(shopId + "\u0000" + ownerName))).ToLowerInvariant()[..16]}";

    /// <summary>The owner half of a refusal's evidence: a counter no NPC runs is spelled <c>none</c>, the same way
    /// every optional value is spelled here, because an empty <c>owner=</c> is a field the Host cannot reparse.</summary>
    internal static string ShopOwnerToken(string ownerName) => ownerName.Length == 0 ? "none" : ownerName;

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
    /// </summary>
    private static List<DiscoveredShopCounter> EnumerateShopCounters(GameLocation location)
    {
        List<DiscoveredShopCounter> counters = new();
        foreach ((string shopId, ShopData shopData) in DataLoader.Shops(Game1.content))
        {
            ShopOwnerData[] owners;
            try
            {
                owners = ShopBuilder.GetCurrentOwners(shopData).ToArray();
            }
            catch (Exception)
            {
                // A malformed content pack must not take the whole snapshot down; the shop
                // is simply not advertised.
                continue;
            }

            foreach (ShopOwnerData owner in owners)
            {
                // Only a named NPC is a physical owner standing in the room.
                if (owner.Type != ShopOwnerType.NamedNpc || string.IsNullOrWhiteSpace(owner.Name))
                    continue;

                NPC? npc = location.characters.FirstOrDefault(c =>
                    c is not null && string.Equals(c.Name, owner.Name, StringComparison.Ordinal));
                if (npc is null)
                    continue;

                // ONE resolution per counter: the verdict and the game's own closed text are both projected from the
                // entry that would RUN this counter, so "open now" and "why not" cannot be two readings.
                ShopOwnerData? resolvedOwner = ResolveCurrentShopOwner(shopData, owner.Name);
                counters.Add(new DiscoveredShopCounter(
                    ShopTargetId(shopId, owner.Name),
                    shopId,
                    shopData,
                    owner.Name,
                    npc.TilePoint.X,
                    npc.TilePoint.Y,
                    OpensNow(resolvedOwner),
                    resolvedOwner?.ClosedMessage));
            }
        }

        // A shop whose owner entry is NOT a named NPC standing in the room (AnyOrNone /
        // None, which is what the tile-opened stalls use) is reachable only through the
        // tile that opens it, so that is where it is discovered. The reachable set is the
        // tile set, not every non-NamedNpc owner entry: an owner entry nothing in the
        // world opens has no counter to walk up to and must not be advertised.
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
    /// </summary>
    private static BridgeShopTarget PublishShopCounter(DiscoveredShopCounter counter, GameLocation location, Farmer player)
    {
        ReadShopStock(counter.ShopId, counter.ShopData, out int stockCount, out List<string> stockItemIds, out _);
        return new BridgeShopTarget(
            counter.TargetId,
            counter.ShopId,
            counter.OwnerName,
            location.NameOrUniqueName,
            counter.CounterX,
            counter.CounterY,
            Utility.tileWithinRadiusOfPlayer(counter.CounterX, counter.CounterY, NativeInteractionRadius, player),
            stockCount,
            stockItemIds);
    }

    /// <summary>
    /// The counters this location has that the game would OPEN right now. Empty is the honest answer everywhere else.
    ///
    /// <para>
    /// The withheld ones are named in the family's exclusions rather than dropped, so an empty <c>shopTargets</c> never
    /// reads as "no shop in this room" when the truth is "the counter is here and shut".
    /// </para>
    /// </summary>
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

    /// <summary>
    /// What a shop can actually sell right now, so a caller does not have to guess an item
    /// id. Same call the purchase itself uses, so discovery and execution cannot disagree
    /// about what is on offer.
    ///
    /// <para>
    /// <c>priceByQualifiedItemId</c> is the COMPLETE stock with what the menu would charge for each entry
    /// (<c>ItemStockInformation.Price</c>, after the shop's and the entry's own modifiers). This method is the ONE
    /// reader of shop stock in this class: the shortage fact's supply half calls it too, rather than asking
    /// <c>ShopBuilder</c> a second time and risking two answers about one shop. <c>stockItemIds</c> stays the bounded
    /// list a target row publishes, so the two readers cannot drift about what is on offer.
    /// </para>
    /// </summary>
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
                // One target per shop: two tiles of the same stall would mint the same
                // target id twice and make the request ambiguous.
                if (!TryResolveTileShop(action, out string shopId)
                    || !shops.TryGetValue(shopId, out ShopData? shopData) || shopData is null
                    || !seen.Add(shopId))
                    continue;

                found++;
                yield return new DiscoveredShopCounter(
                    ShopTargetId(shopId, string.Empty),
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
                // Only the gate-free two-token form. The native case parses a direction, an
                // opening window and an owner area out of the remaining arguments and
                // returns without opening on each of them.
                if (tokens.Length != 2)
                    return false;
                shopId = tokens[1];
                return true;
            default:
                return false;
        }
    }

    /// <summary>
    /// The game's own "this shop is closed" text, read at refusal time rather than carried on
    /// the discovered target. Carrying it meant the snapshot had a nullable field the Mod's
    /// serializer omitted when null, which the Host's exact-key check then rejected — the
    /// message belongs in the refusal evidence, not in a snapshot contract.
    /// </summary>
    private static string? GameStateQueryClosedMessageFor(string shopId, string ownerName)
    {
        try
        {
            if (!DataLoader.Shops(Game1.content).TryGetValue(shopId, out ShopData? shopData) || shopData is null)
                return null;
            // The same resolution the discovery gate uses: one answer about which entry runs this counter.
            return ResolveCurrentShopOwner(shopData, ownerName)?.ClosedMessage;
        }
        catch (Exception)
        {
            // A refusal must not fail because the message could not be read.
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

    public LocalExecutionReceipt RequestLocalShopPurchase(BridgeExecutionRequest request, IExecutionLedger ledger)
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

        // One body at a time, like every other action.
        if (this.active is not null || this.activeTravel is not null || this.activePet is not null
            || this.activeAnimalProduct is not null || this.activeItemUse is not null
            || this.activeItemPickup is not null || this.activePedestalTaking is not null
            || this.activeToolApproach is not null
            || this.activeMountTransport is not null || this.activeBusRide is not null
            || this.activeDayAdvance is not null)
        {
            return this.RejectBodyOwned(request.RequestId, executionId);
        }

        // A menu is already up: this action would be driving the game's own UI, so it
        // cannot proceed without stepping on whatever opened it.
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

        // Re-resolve the target from live state: the client's opaque id is only matched against a set derived here,
        // never parsed. It is the SAME enumeration `shopTargets` publishes from, so a counter this action cannot open
        // today cannot be published by one check and refused by another.
        GameLocation? location = actor.currentLocation;
        if (location is null)
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Rejected, "world_not_ready", null);

        List<DiscoveredShopCounter> counters = EnumerateShopCounters(location);

        // ONE producer per refusal this action mints about a counter, so each reason has exactly one spelling and the
        // sites below cannot drift apart: a counter the actor cannot act on from where it stands, and a counter the game
        // says is shut today (in discovery's own token, with the game's own closed text).
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
            // A counter that is here but SHUT answers with the reason discovery withheld it (`shop_closed_today`, the
            // same token the family's exclusions use) and the game's own closed text. It used to answer
            // `shop_counter_out_of_reach` with a `closed_message=` appended - a distance for a shop that was not open.
            foreach (DiscoveredShopCounter candidate in counters)
            {
                if (candidate.OpensNow || !string.Equals(candidate.TargetId, targetId, StringComparison.Ordinal))
                    continue;
                return RefuseClosedCounter(candidate, candidate.ClosedMessage);
            }

            // Distinguish "the shop exists but its owner is not here / not eligible" from
            // "this is not a shop at all", because they need different Agent responses.
            string knownHere = string.Join(",", counters.Where(c => c.OpensNow).Select(c => c.ShopId).Distinct().Take(8));
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                "shop_target_unavailable",
                $"target={targetId};location={location.NameOrUniqueName};available_here={knownHere}");
        }

        // The deliberate scope boundary: walking is move_to_tile's job. What is measured here is the counter the engine
        // itself gates - a TILE - never the distance to the NPC running it (see `ShopCounterReachRefusal`).
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

        // The stock the game would actually offer right now.
        // Filled by the click loop below and reported in the receipt, so a swallowed click
        // is diagnosable from the evidence instead of requiring another live round.
        List<string> clickDiagnostics = new();
        List<string> dropDiagnostics = new();

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
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                "item_not_sold_here",
                $"shop={target.ShopId};item={expectedItemId};stock={stock.Count}");
        }

        int unitPrice = offer.salePrice();
        // A ShopMenu prices every entry in the currency its own ShopData declares: Utility.TryOpenShopMenu
        // builds the menu from that ShopData and Initialize stores shopData.Currency (ShopMenu.cs:304, :371),
        // and ShopMenu.getPlayerCurrencyAmount (ShopMenu.cs:881-891) is the native map from that value to the
        // player field the charge actually moves (0 money, 1 festivalScore, 2 clubCoins, 4 QiGems). Gating and
        // judging the purchase against actor.Money would refuse an affordable club-coin or Qi-gem trade and
        // then read the real one as having spent nothing.
        int shopCurrency = ShopCurrencyFor(target.ShopId);
        long currencyHeld = ShopMenu.getPlayerCurrencyAmount(actor, shopCurrency);
        long affordable = currencyHeld / Math.Max(1, unitPrice);
        int purchasable = (int)Math.Min(Math.Min(quantity, stock[offer].Stock), affordable);
        if (affordable < 1)
        {
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                "insufficient_money",
                ShopPurchaseAffordabilityEvidence(target.ShopId, expectedItemId, unitPrice, shopCurrency, currencyHeld));
        }
        if (purchasable < 1)
        {
            return this.RememberTerminal(
                request.RequestId,
                executionId,
                ExecutionState.Rejected,
                "out_of_stock",
                $"shop={target.ShopId};item={expectedItemId};stock={stock[offer].Stock}");
        }

        long currencyBefore = ShopMenu.getPlayerCurrencyAmount(actor, shopCurrency);
        int ownedBefore = actor.Items.Where(i => i is not null)
            .Where(i => string.Equals(i.QualifiedItemId, expectedItemId, StringComparison.Ordinal))
            .Sum(i => i.Stack);
        int stockBefore = stock[offer].Stock;

        // The transaction is the game's. TryOpenShopMenu builds the real ShopMenu from the
        // same content data; the purchase is then dispatched through the menu's own click
        // handler over its public forSaleButtons, so pricing, currency, stock decrement and
        // inventory insertion all run inside native code.
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
                // The location overload's closed-message path mounts the game's own
                // DialogueBox before returning false. Leaving it mounted would make every
                // later action reject as modal_open, so it is closed with the public step
                // the native input paths use and its text goes into the refusal instead.
                string nativeClosedMessage = Game1.activeClickableMenu is DialogueBox closedBox
                    ? string.Join(" | ", closedBox.dialogues)
                    : string.Empty;
                if (Game1.activeClickableMenu is DialogueBox)
                    ((DialogueBox)Game1.activeClickableMenu).closeDialogue();

                // TWO answers, and the engine's own call is what separates them: a counter that is shut today names
                // its closed text and is refused with the reason discovery withheld it; a counter whose owner entry
                // could not be resolved from this room is the reach refusal, because standing elsewhere is the fix.
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

            // Match by wire identity, NOT by object reference: GetShopStock builds its own
            // items, so the instance that was priced is never the instance the menu holds.
            // IndexOf would therefore always miss (measured live: shop_offer_not_purchasable).
            //
            // The result is a BUTTON index, not a sale index. The game resolves a clicked
            // button k as forSale[currentItemIndex + k] (ShopMenu.cs:1096-1102), so returning
            // the raw sale index happens to work only while the view is scrolled to the top.
            // Translating here keeps the coordinate and the item in agreement at any scroll.
            int FindOfferIndex(ShopMenu shop)
            {
                int saleIndex = shop.forSale.FindIndex(candidate => string.Equals(
                    candidate?.QualifiedItemId, expectedItemId, StringComparison.Ordinal));
                if (saleIndex < 0)
                    return -1;
                int buttonIndex = saleIndex - shop.currentItemIndex;
                // Scrolled past it: the native click handler cannot reach an off-screen row.
                return buttonIndex >= 0 && buttonIndex < shop.forSaleButtons.Count ? buttonIndex : -1;
            }

            int buttonIndex = FindOfferIndex(menu);
            if (buttonIndex < 0 || buttonIndex >= menu.forSaleButtons.Count)
            {
                return this.RememberTerminal(
                    request.RequestId,
                    executionId,
                    ExecutionState.Rejected,
                    "shop_offer_not_purchasable",
                    $"shop={target.ShopId};item={expectedItemId};button={buttonIndex};offers={menu.forSale.Count}");
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
                    break;

                int index = FindOfferIndex(menu);
                if (index < 0 || index >= menu.forSaleButtons.Count)
                    break;

                ClickableComponent button = menu.forSaleButtons[index];
                // Record the state the native handler will read, and what it did, instead of
                // guessing which gate refused. These are all public members.
                long currencyBeforeClick = ShopMenu.getPlayerCurrencyAmount(actor, shopCurrency);
                int stockBeforeClick = stock.TryGetValue(offer, out ItemStockInformation? s0) && s0 is not null ? s0.Stock : -1;
                int safetyBefore = menu.safetyTimer;
                bool heldNull = menu.heldItem is null;
                int clickX = button.bounds.Center.X;
                int clickY = button.bounds.Center.Y;
                bool addressedToButton = button.containsPoint(clickX, clickY);

                // The native click handler, at the native click coordinates.
                menu.receiveLeftClick(clickX, clickY, playSound: true);

                // The purchase leaves the item ON THE CURSOR, not in the inventory:
                // tryToPurchaseItem assigns heldItem = item.GetSalableInstance()
                // (ShopMenu.cs:1352) and only clears it for items with
                // actionWhenPurchased (:1369-1378). A real player then clicks an empty
                // inventory slot to put it away; a scripted purchase must do the same or
                // the money moves and the goods never arrive. Measured live: money 500->480
                // with owned_before = owned_after = 0, i.e. purchase_partial.
                //
                // receiveLeftClick routes coordinates inside the inventory to
                // inventory.leftClick (ShopMenu.cs:1094), which is the native drop.
                string heldBeforeDrop = menu.heldItem?.QualifiedItemId ?? "none";
                int emptySlotIndex = -1;
                string dropAt = "none";
                if (menu.heldItem is not null)
                {
                    List<ClickableComponent>? slots = menu.inventory?.inventory;
                    IList<Item>? actual = menu.inventory?.actualInventory;
                    if (slots is not null && actual is not null)
                    {
                        for (int slotIndex = 0; slotIndex < slots.Count && slotIndex < actual.Count; slotIndex++)
                        {
                            // Read the ITEM LIST, not ClickableComponent.item. The menu builds its
                            // slots as `new ClickableComponent(bounds, j.ToString())`
                            // (InventoryMenu.cs:103) — the string overload — and never assigns
                            // `.item`, so `slot.item` is ALWAYS null. Selecting on it picked slot 0
                            // every time; when slot 0 holds a tool, InventoryMenu.leftClick refuses
                            // (InventoryMenu.cs:318 `actualInventory[num] != null && !canStackWith`)
                            // and returns the held item unchanged. Measured live:
                            // `drops=1[drop0:empty_slot=0;at=412,544;held=(O)472->(O)472]`.
                            if (actual[slotIndex] is null && slots[slotIndex] is { bounds.Width: > 0 })
                            {
                                emptySlotIndex = slotIndex;
                                dropAt = $"{slots[slotIndex].bounds.Center.X},{slots[slotIndex].bounds.Center.Y}";
                                break;
                            }
                        }
                    }
                    if (emptySlotIndex >= 0)
                    {
                        // The native drop: ShopMenu.receiveLeftClick routes coordinates that
                        // land in the inventory to inventory.leftClick with the held item
                        // (ShopMenu.cs:1094), which is the game's own placement step.
                        menu.receiveLeftClick(
                            slots![emptySlotIndex].bounds.Center.X,
                            slots![emptySlotIndex].bounds.Center.Y,
                            playSound: true);
                    }
                }
                string heldAfterDrop = menu.heldItem?.QualifiedItemId ?? "none";
                dropDiagnostics.Add(
                    $"drop{bought}:empty_slot={emptySlotIndex}|at={dropAt}|held={heldBeforeDrop}->{heldAfterDrop}");

                long currencyAfterClick = ShopMenu.getPlayerCurrencyAmount(actor, shopCurrency);
                int stockAfterClick = stock.TryGetValue(offer, out ItemStockInformation? s1) && s1 is not null ? s1.Stock : -1;
                clickDiagnostics.Add(
                    $"click{bought}:button={index}|at={clickX},{clickY}|addressed={addressedToButton}|"
                    + $"safety_before={safetyBefore}|held_null={heldNull}|"
                    + $"currency={currencyBeforeClick}->{currencyAfterClick}|stock={stockBeforeClick}->{stockAfterClick}|"
                    + $"held_after={menu.heldItem?.QualifiedItemId ?? "none"}");
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
                // Reported as part of the receipt below via the leftover-menu fact.
            }
        }

        long currencyAfter = ShopMenu.getPlayerCurrencyAmount(actor, shopCurrency);
        int ownedAfter = actor.Items.Where(i => i is not null)
            .Where(i => string.Equals(i.QualifiedItemId, expectedItemId, StringComparison.Ordinal))
            .Sum(i => i.Stack);
        int gained = ownedAfter - ownedBefore;
        bool menuClosed = Game1.activeClickableMenu is not ShopMenu;

        string entryKind = tileOpened ? "tile_action" : "npc_owner";
        // The evidence has to be MACHINE-READABLE by the Host's exact-shape contract, which splits the whole detail
        // on `;` and requires every field to be a non-empty `key=value`. money_before/money_after are frozen key
        // NAMES that the Host's shop_purchase completion rule requires
        // (host/src/stardew-game-integration-adapter.ts:1995-2055, exactEvidence, money_after < money_before);
        // their values now carry the amount of the CURRENCY the native charge moved, so a club-coin or Qi-gem
        // purchase reports the decrease that rule looks for:
        //   * a tile-opened shop has NO owner, and writing `owner=` made the field empty, which the Host rejects -
        //     so an absent owner is spelled `none`, the same way other optional values are spelled here;
        //   * the two diagnostics below are lists, and their entries used to embed `;`, which split each entry into
        //     fields the Host cannot read (`drop0:empty_slot=0` is not a key). They now separate parts with `|` and
        //     entries with `||`, so the whole diagnostic stays ONE field.
        string ownerName = ShopOwnerToken(target.OwnerName);
        string evidence =
            $"shop={target.ShopId};owner={ownerName};entry={entryKind};item={expectedItemId};"
            + $"requested={quantity};purchased={purchasable};unit_price={unitPrice};"
            + $"money_before={currencyBefore};money_after={currencyAfter};"
            + $"owned_before={ownedBefore};owned_after={ownedAfter};gained={gained};"
            + $"stock_before={stockBefore};stock_after={(menu is not null && stock.TryGetValue(offer, out ItemStockInformation? after) && after is not null ? after.Stock : -1)};"
            + $"owner_tile={target.CounterX},{target.CounterY};menu_closed={menuClosed.ToString().ToLowerInvariant()};"
            + $"clicks={clickDiagnostics.Count}[{string.Join("||", clickDiagnostics)}];"
            + $"drops={dropDiagnostics.Count}[{string.Join("||", dropDiagnostics)}]";

        // Success is the world fact: the shop's own currency left the purse AND the item entered the inventory.
        // A receipt that spent nothing and gained nothing is not a purchase.
        if (currencyAfter < currencyBefore && gained > 0)
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Succeeded, "item_purchased", evidence, this.TryCreateLocalObservation(actor));

        if (currencyAfter < currencyBefore || gained > 0)
            return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Uncertain, "purchase_partial", evidence);

        return this.RememberTerminal(request.RequestId, executionId, ExecutionState.Failed, "purchase_not_effective", evidence);
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
    /// <summary>The Host's published cap on `seedSupplyTargets` (host/src/protocol.ts), which the snapshot contract
    /// enforces; exceeding it invalidates the WHOLE snapshot.</summary>
    private const int MaxSeedSupplyRows = 8;

    /// <summary>
    /// The stock scan behind `seedSupplyTargets`, cached per in-game day and per set of held seeds.
    ///
    /// `ReadShopStock` resolves every shop's item queries and touches the team's synchronized shop stock, so asking all
    /// of `Data/Shops` on every snapshot would put that cost on the game thread once per observation, for a fact that
    /// changes once a day. What is NOT cached is `OpenNow`: that is the engine's answer about the clock, it moves with
    /// the hour, and freezing it at 06:00 would be the one thing this fact exists to prevent.
    /// </summary>
    private static int seedSupplyScanDay = int.MinValue;
    private static string seedSupplyScanKey = string.Empty;
    private static IReadOnlyList<(string QualifiedItemId, string ShopId, int Price)> seedSupplyScan =
        Array.Empty<(string QualifiedItemId, string ShopId, int Price)>();

    /// <summary>
    /// Every (held seed, shop that stocks it) pair, as the game states it. Null only when the caller decided not to
    /// measure; an empty array is the measured answer "this actor holds no plantable seed".
    /// </summary>
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
            // An unreadable content table is "the shops could not be read", which the empty list states honestly: the
            // companion is told there is no known source, not that the seed does not exist.
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
                    // The condition could not be evaluated. That is NOT "closed": the row carries no answer and names
                    // the reason, so a companion cannot read a failed query as a shop she need not walk to.
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
            // A seed nobody stocks still gets a row: the absent shop half IS the answer ("no known source"), and it
            // must not be confused with no row at all (she holds no plantable seed) or with no family (nothing was
            // measured).
            if (!stockedSomewhere)
                rows.Add(SeedWithoutSupplyRow(seedId, displayName, heldCount));
        }
        omitted = Math.Max(0, rows.Count - MaxSeedSupplyRows);
        return rows.Count > MaxSeedSupplyRows ? rows.GetRange(0, MaxSeedSupplyRows) : rows;
    }

    /// <summary>
    /// Which shops stock which of the held seeds, with what the menu would charge, for the given day.
    ///
    /// One pass over `Data/Shops` through `ReadShopStock`, which is the reader the shop targets already use: a second
    /// `ShopBuilder` call site could disagree with it about what a shop offers, and then a fact would name a shop the
    /// purchase action would refuse.
    /// </summary>
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
            // The SAME rule `shopTargets` gates its rows on, applied to the eligible set this row was handed: the
            // engine's answer about whether the counter opens today (`OpensNow` over the entry that would run it), not a
            // second reading of the conditions alone. A supply row that said "open now" for the counter the shop family
            // just withheld is the two-spellings defect this fact exists to avoid.
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

    /// <summary>
    /// How many of this seed the actor holds, summed from the PUBLISHED stack rows for the slots that hold it.
    ///
    /// Null - never 0 - when those rows were not published, or do not cover every holding slot. A zero derived from an
    /// absence would answer "you have none" about a pack nobody read, which is the defect class this field must not
    /// join: the same shape as a null key and a default that reads as truth.
    /// </summary>
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

    /// <summary>
    /// The `Data/Shops` row's own declared price for this item, or null when no entry names it literally.
    ///
    /// Only a literal id can be matched: vanilla writes many entries as item QUERIES (`ALL_ITEMS`, the seasonal forms),
    /// and the id a query resolves to is not the row's <c>ItemId</c>. Null is that fact - "this row states no price for
    /// this item" - and it is never the charged price written a second time.
    /// </summary>
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
            // A lookup that threw is the same answer this field needs: no location could be read for this id. The
            // supply row names that rather than failing the whole snapshot.
            return null;
        }
    }

    /// <summary>
    /// The shop's address, of which EXACTLY ONE member is always set.
    ///
    /// <list type="number">
    /// <item><c>Destination</c> - this shop's counter is in the location the actor is standing in, because
    /// <paramref name="shopTargetsHere"/> (the list <c>DiscoverShopTargets</c> produced for THIS snapshot) holds a row
    /// for it. The destination carries that row's own <c>TargetId</c>, location and owner tile, so it and the
    /// <c>shopTargets</c> row `shop_purchase` resolves are the same fact. No id is minted here.</item>
    /// <item><c>Location</c> - the shop exists on a map but its counter is not in this one, so only the room can be
    /// named. This is the farm-at-06:00 case that started it: "SeedShop" is the answer to "where do I head", and it
    /// is deliberately not a destination, so it cannot read as a waypoint already within reach.</item>
    /// <item><c>Unknown</c> - neither could be read, and the reason is named (<c>shop_location_unreadable</c>) so an
    /// absent address is a stated fact instead of an empty field beside a real price.</item>
    /// </list>
    /// </summary>
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
                // The row publishes ONE owner entry and its hours, so the counter that owner stands at is the address
                // that entry describes. A tile-opened stall has no owner name to match and keeps the first row.
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

    /// <summary>
    /// The shop's own name as the game localizes it, or empty when the id names no map at all (a stall, the casino, a
    /// festival shop). Empty is that fact; the caller still has `shopId`.
    /// </summary>
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
