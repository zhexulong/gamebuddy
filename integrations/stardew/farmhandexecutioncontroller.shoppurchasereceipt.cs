using System;
using System.Collections.Generic;
using System.Globalization;
using GameBuddy.Stardew.Core.Models;
using StardewValley.Menus;

namespace GameBuddy.Stardew;

/// <summary>
/// The RECEIPT seam of `shop_purchase`: the disposition of one purchase, and the detail text that states it.
///
/// <para>
/// IT IS ITS OWN PART BECAUSE THE ACTION'S FILE REACHED THE FILE CEILING. `farmhandexecutioncontroller.shopactions.cs`
/// grew past the 2,000-line ceiling for a `.cs` file (2,145 with this seam in it) and every commit that staged it was
/// refused (`file_over_ceiling`), so the seam moved here rather than the ceiling moving. What is here has no native
/// call in it: the trade happens in the handler, and this half only reads the facts the trade produced and writes the
/// one text the Host reads. It is a small file against the same 2,000-line ceiling, and it carries no baseline entry.
/// </para>
/// </summary>
internal sealed partial class ExecutionManager
{
    /// <summary>
    /// The disposition of one purchase, from the facts the transaction produced — the ONE place that decides it, so the
    /// state the caller reads and the terminal it reads cannot be two judgements.
    ///
    /// <para>
    /// A TOOL UPGRADE is a purchase whose goods never enter the pack: <c>Tool.actionWhenPurchased</c> sets
    /// <c>Farmer.toolBeingUpgraded</c> and <c>daysLeftForToolUpgrade = 2</c> for the shop id <c>ClintUpgrade</c>
    /// (Tool.cs:875-895) and returns true, so <c>ShopMenu.tryToPurchaseItem</c> discards the entry it charged for
    /// (ShopMenu.cs:1369-1378) while the tool the upgrade consumes leaves the pack (:879-888). Judged by "goods
    /// arrived" alone, a successful upgrade therefore read as <c>Uncertain/purchase_partial</c> — the receipt could not
    /// tell a finished upgrade from a half-done trade. The engine's own two fields are the effect, so they are what
    /// this reads: nothing else in the game writes <c>toolBeingUpgraded</c>.
    /// </para>
    /// <para>
    /// The upgraded tool's id is compared with the requested one because <c>toolBeingUpgraded</c> may already have held
    /// a DIFFERENT tool (Tool.cs:875 is the only writer's guard); a purchase is never the answer for a tool it did not
    /// put there. <paramref name="requiredToolBefore"/> and <paramref name="requiredToolAfter"/> are the pack counts of
    /// the item the upgrade consumes, which is the second half of the engine's effect.
    /// </para>
    /// </summary>
    internal readonly record struct ShopPurchaseOutcome(ExecutionState State, string ReasonCode);

    internal static ShopPurchaseOutcome ShopPurchaseOutcomeFor(
        long currencyBefore,
        long currencyAfter,
        int gained,
        string? purchaseRefusal,
        string expectedItemId,
        string? upgradedToolId,
        int daysLeftForToolUpgrade,
        string? requiredToolId,
        int requiredToolBefore,
        int requiredToolAfter)
    {
        bool paid = currencyAfter < currencyBefore;
        bool requiredToolTaken = requiredToolId is not null && requiredToolAfter == requiredToolBefore - 1;

        if (purchaseRefusal is not null)
            return new ShopPurchaseOutcome(
                paid || gained > 0 || requiredToolTaken ? ExecutionState.Uncertain : ExecutionState.Rejected,
                purchaseRefusal);

        if (paid
            && upgradedToolId is not null
            && string.Equals(upgradedToolId, expectedItemId, StringComparison.Ordinal)
            && daysLeftForToolUpgrade > 0
            && requiredToolTaken)
            return new ShopPurchaseOutcome(ExecutionState.Succeeded, "tool_upgrade_purchased");

        if (paid && gained > 0)
            return new ShopPurchaseOutcome(ExecutionState.Succeeded, "item_purchased");

        if (paid || gained > 0)
            return new ShopPurchaseOutcome(ExecutionState.Uncertain, "purchase_partial");

        return new ShopPurchaseOutcome(ExecutionState.Failed, ShopPurchaseRefusal("no_effect"));
    }

    /// <summary>
    /// What a purchase that was a TOOL UPGRADE adds to the receipt: the engine's own three effects, in the one spelling
    /// the Host's <c>tool_upgrade_purchased</c> rule declares.
    ///
    /// <para>
    /// Empty for every other purchase, which is what keeps the ordinary <c>item_purchased</c> detail byte-identical: the
    /// Host reads a detail as an exact key set, so an extra field on the ordinary path would be a producer bug there.
    /// </para>
    /// </summary>
    internal static string ShopToolUpgradeEvidence(
        string? upgradedToolId,
        int daysLeftForToolUpgrade,
        string requiredToolQualifiedId,
        int requiredToolBefore,
        int requiredToolAfter,
        string purchaseDialogue)
    {
        if (upgradedToolId is null)
            return string.Empty;
        return $";tool_upgraded={upgradedToolId};days_left={daysLeftForToolUpgrade}"
            + $";required_tool={(requiredToolQualifiedId.Length == 0 ? "none" : requiredToolQualifiedId)}"
            + $";required_before={requiredToolBefore};required_after={requiredToolAfter}"
            + $";purchase_dialogue={purchaseDialogue}";
    }

    /// <summary>
    /// What one purchase receipt states, as the handler read each fact from the game.
    ///
    /// <para>
    /// A record rather than a list of arguments because the receipt IS this shape: the Host reads the detail as an exact
    /// key set (see <see cref="ShopPurchaseReceipt"/>), and the shop suite builds the same receipt from these same facts
    /// so the invariant it asserts is asserted on the text the Mod emits.
    /// </para>
    ///
    /// <para>
    /// IT DECLARES WHEN ITS THREE PAIRS WERE READ, because `money_before`/`money_after`, `owned_before`/`owned_after`
    /// and `stock_before`/`stock_after` are a world state compared with itself: a charge that the engine applied after
    /// the read would report no effect, exactly as `pickup_forage`'s `removed=false` did for two rounds. The click that
    /// spends the money runs inside <c>ShopMenu.receiveLeftClick</c> -> <c>tryToPurchaseItem</c> (ShopMenu.cs:1364) and the
    /// after-facts are sampled once those clicks return (<c>RequestLocalShopPurchase</c>), so the point is
    /// <see cref="PostconditionReadPoint.AfterTheSettle"/>.
    /// </para>
    ///
    /// <para>
    /// THE POINT IS DECLARED BUT NOT PRINTED, which is the one place this class of postcondition cannot reach the wire:
    /// the Host's shop_purchase completion rule reads this detail as an exact key set
    /// (host/src/stardew-completion-contracts.ts:4655-4704), so an extra token on the ordinary path is a producer bug
    /// there rather than a fact - see <see cref="ShopToolUpgradeEvidence"/> for the same constraint stated on a field.
    /// THE DISTANCE TRIPLE IS NOT AN EXCEPTION TO THAT RULE BUT AN APPLICATION OF IT: the Host's rule declares
    /// <c>distance_required</c>/<c>distance</c>/<c>why</c> as its declared-optional keys
    /// (<c>declaredCompletionEvidence</c>'s fourth argument), so the ordinary path may carry them and nothing reads them
    /// as an unknown field.
    /// </para>
    /// <para>
    /// THE TWO STOCK FIELDS ARE NULLABLE BECAUSE A MISSING READING IS NOT A COUNT: the handler resolves the stock entry
    /// it buys from once, and a re-read that no longer finds it states nothing rather than a number standing for "no
    /// answer" (<see cref="ShopStockToken"/> writes that as a word, and <c>int.MaxValue</c> is the game's own word for
    /// unbounded).
    /// </para>
    /// <para>
    /// THE MAP IS ON THE RECEIPT because `owner_tile` is a coordinate and a coordinate without a map says nothing: `4,17`
    /// is a tile in Pierre's shop and a tile on the Farm. Every other tile-bearing receipt names its map (`till_soil`'s
    /// `location`, `remove_placed_item`'s `location=NameOrUniqueName`), and a purchase that named only the counter tile
    /// left `round92`'s day-3 `town_market` purpose `unjudged` (`task_purpose_needs_an_unpublished_fact`) over two
    /// purchases that had already succeeded.
    /// </para>
    /// </summary>
    internal readonly record struct ShopPurchaseReceiptFacts(
        string ShopId,
        string Location,
        string OwnerName,
        bool TileOpened,
        string ItemId,
        int Requested,
        int Purchased,
        int UnitPrice,
        long CurrencyBefore,
        long CurrencyAfter,
        int OwnedBefore,
        int OwnedAfter,
        int? StockBefore,
        int? StockAfter,
        int CounterX,
        int CounterY,
        int ActorX,
        int ActorY,
        bool MenuClosed,
        IReadOnlyList<string> Clicks,
        IReadOnlyList<string> Drops,
        string? UpgradedToolId,
        int DaysLeftForToolUpgrade,
        string RequiredToolQualifiedId,
        int RequiredToolBefore,
        int RequiredToolAfter,
        string PurchaseDialogue) : IReadsAWorldStateBeforeAndAfter
    {
        public string ActionId => "shop_purchase";

        public PostconditionReadPoint ReadPoint => PostconditionReadPoint.AfterTheSettle;
    }

    /// <summary>
    /// The ONE producer of a purchase receipt's detail.
    ///
    /// <para>
    /// The evidence has to be MACHINE-READABLE by the Host's exact-shape contract, which splits the whole detail on `;`
    /// and requires every field to be a non-empty `key=value`. <c>money_before</c>/<c>money_after</c> are frozen key
    /// NAMES that the Host's shop_purchase completion rule requires
    /// (host/src/stardew-game-integration-adapter.ts:1995-2055, exactEvidence, money_after &lt; money_before); their values
    /// carry the amount of the CURRENCY the native charge moved, so a club-coin or Qi-gem purchase reports the decrease
    /// that rule looks for:
    /// </para>
    /// <list type="bullet">
    /// <item>a tile-opened shop has NO owner, and writing `owner=` made the field empty, which the Host rejects - so an
    /// absent owner is spelled `none`, the same way other optional values are spelled here;</item>
    /// <item>the two diagnostics spell `key=value` INSIDE their own value, so their parts separate with `|` and never with
    /// `;` - an entry that embedded the separator split into fields the Host cannot read (`drop0:empty_slot=0` is not a
    /// key). They are also FOLDED to the count and the one entry that names the outcome, because one entry per unit
    /// bought made the whole detail grow with the quantity (<see cref="ShopPurchaseTraceField"/>).</item>
    /// <item><c>entry=</c> is the counter FORM, and <c>distance_required=</c> beside it is the distance gate that form
    /// has: <c>none</c> with <c>why=engine_has_no_gate_for_npc_counters</c> for a counter an NPC runs, and the engine's
    /// own click radius with the measured <c>distance=</c> for a counter that IS a tile
    /// (<see cref="ShopPurchaseDistanceEvidence"/>).</item>
    /// </list>
    /// <para>
    /// <c>money_before</c>, <c>money_after</c>, <c>gained</c> and <c>tool_upgraded</c> are also the four fields the
    /// purchase invariant is stated over (tools/check-stardew-shop-purchase-pays-for-goods.mjs): money may leave the
    /// purse only when goods arrived or a tool was upgraded.
    /// </para>
    /// </summary>
    internal static string ShopPurchaseReceipt(ShopPurchaseReceiptFacts facts)
    {
        int gained = facts.OwnedAfter - facts.OwnedBefore;
        string entryKind = facts.TileOpened ? "tile_action" : "npc_owner";
        return $"shop={facts.ShopId};location={facts.Location};owner={ShopOwnerToken(facts.OwnerName)};entry={entryKind};"
            + $"{ShopPurchaseDistanceEvidence(facts.TileOpened, facts.CounterX, facts.CounterY, facts.ActorX, facts.ActorY)};"
            + $"item={facts.ItemId};"
            + $"requested={facts.Requested};purchased={facts.Purchased};unit_price={facts.UnitPrice};"
            + $"money_before={facts.CurrencyBefore};money_after={facts.CurrencyAfter};"
            + $"owned_before={facts.OwnedBefore};owned_after={facts.OwnedAfter};gained={gained};"
            + $"stock_before={ShopStockToken(facts.StockBefore)};stock_after={ShopStockToken(facts.StockAfter)};"
            + $"owner_tile={facts.CounterX},{facts.CounterY};menu_closed={facts.MenuClosed.ToString().ToLowerInvariant()};"
            + ShopPurchaseTraceField("clicks", facts.Clicks) + ";"
            + ShopPurchaseTraceField("drops", facts.Drops)
            + ShopToolUpgradeEvidence(
                facts.UpgradedToolId,
                facts.DaysLeftForToolUpgrade,
                facts.RequiredToolQualifiedId,
                facts.RequiredToolBefore,
                facts.RequiredToolAfter,
                facts.PurchaseDialogue);
    }

    /// <summary>
    /// Which distance gate the counter FORM this purchase went through actually has, and how far the body was when
    /// there was one.
    ///
    /// <para>
    /// AN NPC-RUN COUNTER HAS NO SUCH GATE ANYWHERE IN THE ENGINE. <c>Utility.TryOpenShopMenu(shopId, location,
    /// ownerArea, maxOwnerY, forceOpen, playOpenSound, showClosedMessage)</c> (Utility.cs:4230-4324) searches the room's
    /// characters for an NPC one of the eligible owner entries names (:4243-4268) and opens the menu once it finds one
    /// (:4318-4321); no line of that path measures the player. The two positional parameters it DOES take are gates on
    /// the OWNER's tile - the documentation says so in as many words, "This is used for shops that only work if the NPC
    /// is behind the counter" (Utility.cs:4225) - and the purchase path passes <c>ownerArea: null, maxOwnerY: null</c>,
    /// so neither is applied here either.
    /// </para>
    /// <para>
    /// A COUNTER THAT IS A TILE DOES HAVE ONE: <c>Utility.tileWithinRadiusOfPlayer(tile, 1, player)</c> is what
    /// <c>Game1</c> applies to a tile before it calls <c>GameLocation.checkAction</c> (Game1.cs:11509 and :11637), and
    /// this action refuses through that same gate (<see cref="ShopCounterReachRefusal"/>). The receipt states the
    /// engine's radius beside the measured gap, so a reader can tell <c>distance=0</c> - she stood at the counter - from
    /// <c>distance=1</c>, she stood beside it.
    /// </para>
    /// <para>
    /// WHY IT IS ON THE RECEIPT. Measured round92: a completed purchase read as
    /// <c>shop=SeedShop;owner=Pierre;entry=npc_owner;item=(O)472;requested=12;purchased=12;unit_price=20;
    /// money_before=500;money_after=260</c>, and a watcher asked "she bought seeds at the door without going to Pierre,
    /// why?". Nothing in that text could answer it: <c>owner_tile</c> says where the counter is, never whether reaching
    /// it was required, so "she did not need to" and "a distance gate was skipped" were the same receipt. This token is
    /// that answer, and it is the engine's rather than a rule invented here - the decision was to SAY which gate exists,
    /// not to add one the engine does not have.
    /// </para>
    /// </summary>
    internal static string ShopPurchaseDistanceEvidence(bool tileOpened, int counterX, int counterY, int actorX, int actorY) =>
        tileOpened
            ? $"distance_required={NativeInteractionRadius};distance={ShopCounterDistance(counterX, counterY, actorX, actorY)}"
            : "distance_required=none;why=engine_has_no_gate_for_npc_counters";

    /// <summary>
    /// How far the body was from the counter tile, in the engine's own metric.
    ///
    /// <para>
    /// <c>Utility.tileWithinRadiusOfPlayer</c> tests EACH axis against the radius (Utility.cs:4100-4109), so the metric
    /// is the larger of the two deltas and never their sum. The number is stated rather than only the verdict so a reader
    /// can check the gate, and the two cannot disagree: this is the radius or less exactly when the engine admits the
    /// tile.
    /// </para>
    /// </summary>
    private static int ShopCounterDistance(int counterX, int counterY, int actorX, int actorY) =>
        Math.Max(Math.Abs(counterX - actorX), Math.Abs(counterY - actorY));

    /// <summary>
    /// One stock reading as the wire states it: a count when the counter really counts, the game's own word where it
    /// means unbounded, and a word rather than a number where nothing was read.
    ///
    /// <para>
    /// `ItemStockInformation.Stock` is "the maximum number of sets of this item which can be purchased in one day, or
    /// `ShopMenu.infiniteStock` for unlimited" (ItemStockInformation.cs:12), and `ShopMenu.infiniteStock` IS
    /// <c>int.MaxValue</c> (ShopMenu.cs:168) - the engine never compares it to a count, only to that constant (:1398,
    /// :1483, :1911, :2044). `round92`'s one purchase printed `stock_before=2147483647;stock_after=2147483647`, which a
    /// reader cannot tell from a shop that happens to hold two billion units, and "is there enough stock?" then answers
    /// yes for the wrong reason. A sentinel is not a measurement: the same shape as `money: null` for a purse nobody
    /// measured.
    /// </para>
    /// <para>
    /// "NOT MEASURED" IS THE ABSENCE OF THE VALUE, not a number chosen to stand for it. The handler used to write
    /// <c>-1</c> when the stock entry it had already resolved was no longer in the dictionary; <c>int?</c> is what makes
    /// that unreachable, so no caller can spell an absence as a count and no later comparison can read one as one.
    /// </para>
    /// </summary>
    internal static string ShopStockToken(int? stock) =>
        stock is not int measured
            ? "unreadable"
            : measured == ShopMenu.infiniteStock
                ? "unlimited"
                : measured.ToString(CultureInfo.InvariantCulture);

    /// <summary>
    /// One folded diagnostic trace of a purchase receipt: HOW MANY entries the click loop produced, and the LAST of them.
    ///
    /// <para>
    /// WHY IT IS FOLDED. The loop records one entry per unit bought and each entry is ~146 characters, so the detail grew
    /// with the quantity: a real 25-seed purchase measured 5,059 characters and the Host refused the whole receipt
    /// (`evidence_too_long:5059:4096`), which filed a completed trade as
    /// `succeeded_receipt_without_its_own_postcondition`. The bound is the producer's own
    /// (<c>FarmhandExecutionJournal.MaximumReceiptEvidenceLength</c>) and it is not raised for this: a receipt that cannot
    /// fit its own evidence is a receipt whose evidence is the wrong shape. `buy_seeds_and_expand_plot` needs a
    /// twenty-tile plot, so a purchase of 21 or more units has to fit, and with the fold the length stops depending on the
    /// quantity at all - a thirty-six unit purchase states 343 characters.
    /// </para>
    /// <para>
    /// WHAT A READER CONSUMES, stated so this stays a fold and not a deletion: the LAST entry only. The shop runner reads
    /// that one click's <c>row</c> and <c>cursor</c> to prove the menu's pager really reached the sale
    /// (tools/run-stardew-native-local-player-shop-purchase-smoke.mjs, <c>clickRows</c>), and the Host's `shop_purchase`
    /// rule reads neither field. The count is the fact the receipt owes - `purchased` says how many the loop set out to
    /// buy, this says how many native clicks ran - and the kept entry keeps its own ordinal, so the truncation is named
    /// by the text itself: `clicks=25[click24:...]` is 25 clicks of which the last one, number 24, is printed.
    /// </para>
    /// </summary>
    internal static string ShopPurchaseTraceField(string label, IReadOnlyList<string> entries) =>
        entries.Count == 0 ? $"{label}=0[]" : $"{label}={entries.Count}[{entries[entries.Count - 1]}]";
}
