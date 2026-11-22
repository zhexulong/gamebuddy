using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.RegularExpressions;
using FluentAssertions;
using GameBuddy.Stardew.Core.Policy;
using Microsoft.Xna.Framework;
using Netcode;
using StardewValley;
using StardewValley.GameData.Shops;
using StardewValley.Network;
using Xunit;
using Xunit.Abstractions;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// WHAT MAKES A COUNTER PURCHASABLE, asked of the gate the engine actually has.
///
/// <para>
/// Measured round42 (live), six refusals and one wasted day:
/// </para>
/// <code>
/// shop_purchase rejected  shop_counter_out_of_reach
///   owner=Pierre;owner_tile=4,17;actor_tile=5,19;radius=1
/// </code>
/// <para>
/// The world let her stand at (5,19); the counter is the row in front of Pierre and the game would have opened it
/// from there and sold her the seed. The refusal was measured against the OWNER NPC, and no native shop path measures
/// that distance: <c>Utility.TryOpenShopMenu(shopId, location, ...)</c> resolves the eligible owner entries and searches
/// the room's characters (<c>Utility.cs:4243-4268</c>), and the radius the engine does apply -
/// <c>Utility.tileWithinRadiusOfPlayer(tile, 1, player)</c> - is applied to the TILE before
/// <c>GameLocation.checkAction</c> (<c>Game1.cs:11509</c>, <c>:11637</c>). The two facts are therefore stated separately
/// below: an NPC-run counter has no distance at all, and a tile counter has exactly the engine's radius on its own tile.
/// </para>
/// </summary>
// MIXED SHAPE AND BEHAVIOUR: the pins here assert on repository source text where the native seam cannot load headless, while the rest of the class drives the product's own predicates with a real Farmer; keeping both in one file keeps each pin beside the behaviour it protects.
public sealed class ShopCounterReachTests
{
    private const string ImplementationRelativePath = "integrations/stardew/farmhandexecutioncontroller.shopactions.cs";

    private readonly ITestOutputHelper output;

    public ShopCounterReachTests(ITestOutputHelper output) => this.output = output;

    /// <summary>The round42 pair: the owner's tile and the tile the actor was standing on.</summary>
    private const int OwnerX = 4;
    private const int OwnerY = 17;
    private const int ActorX = 5;
    private const int ActorY = 19;

    /// <summary>
    /// THE MEASURED CASE. An NPC-run counter is admitted from wherever the actor stands in the room, including from two
    /// tiles away from Pierre - the distance that produced all six refusals - because the engine's own open call, not a
    /// radius, is what decides it.
    /// </summary>
    [Fact]
    public void AnNpcRunCounterIsAdmittedFromWhereverTheActorStandsInTheRoom()
    {
        using ActorHarness harness = ActorHarness.Create();

        harness.StandOn(ActorX, ActorY);
        ExecutionManager
            .ShopCounterReachRefusal(counterIsTileAction: false, "Pierre", OwnerX, OwnerY, harness.Actor)
            .Should()
            .BeNull("round42: the shop was at (4,17), she stood at (5,19), and no native shop path measures that");

        harness.StandOn(ActorX + 4, ActorY + 4);
        ExecutionManager
            .ShopCounterReachRefusal(counterIsTileAction: false, "Pierre", OwnerX, OwnerY, harness.Actor)
            .Should()
            .BeNull("the engine searches the room's whole character list (Utility.cs:4243-4268), so distance cannot refuse");

        harness.StandOn(OwnerX, OwnerY);
        ExecutionManager
            .ShopCounterReachRefusal(counterIsTileAction: false, "Pierre", OwnerX, OwnerY, harness.Actor)
            .Should()
            .BeNull("standing on the counter tile is not a worse place to buy from either");
    }

    /// <summary>
    /// A TILE counter is the other form, and there the engine does gate on distance - on the tile it is about to action.
    /// The published refusal must BE that gate at every boundary: a hand-written Manhattan or Euclidean distance would
    /// disagree on the diagonal immediately, and then the row that says "in reach" is refused by the action that reads it.
    /// </summary>
    [Fact]
    public void ATileCounterIsAdmittedOnlyInsideTheEnginesRadiusOnThatTile()
    {
        using ActorHarness harness = ActorHarness.Create();

        (int X, int Y, bool InRange)[] cases =
        {
            (OwnerX, OwnerY, true),
            (OwnerX + 1, OwnerY, true),
            (OwnerX, OwnerY + 1, true),
            (OwnerX + 1, OwnerY + 1, true),
            (ActorX, ActorY, false),
            (OwnerX + 2, OwnerY, false),
            (OwnerX, OwnerY + 2, false),
            (OwnerX - 2, OwnerY + 2, false),
        };

        foreach ((int x, int y, bool inRange) in cases)
        {
            harness.StandOn(x, y);
            bool native = Utility.tileWithinRadiusOfPlayer(OwnerX, OwnerY, 1, harness.Actor);
            string? refusal = ExecutionManager.ShopCounterReachRefusal(
                counterIsTileAction: true, string.Empty, OwnerX, OwnerY, harness.Actor);

            native.Should().Be(inRange, $"the engine's gate is the rule being reported, at {x},{y}");
            (refusal is null).Should().Be(native, $"the counter's reach must BE the engine's answer at {x},{y}");
        }

        // The refusal names the TILE that has to be reached, the body, and the engine's own radius - the tokens a caller
        // computes an approach from, and the same three the round42 refusal carried.
        harness.StandOn(ActorX, ActorY);
        ExecutionManager
            .ShopCounterReachRefusal(counterIsTileAction: true, string.Empty, OwnerX, OwnerY, harness.Actor)
            .Should()
            .Be("owner=none;owner_tile=4,17;actor_tile=5,19;radius=1");
    }

    /// <summary>
    /// THE RECEIPT'S OWN HALF: a purchase says which distance gate its counter form HAS, so "she did not need to walk"
    /// and "the gate was skipped" stop being the same receipt.
    ///
    /// <para>
    /// Measured round92, a completed purchase a watcher read as <em>"she bought seeds at the door without going to
    /// Pierre, why?"</em>:
    /// </para>
    /// <code>
    /// shop=SeedShop;owner=Pierre;entry=npc_owner;item=(O)472;requested=12;purchased=12;unit_price=20;
    /// money_before=500;money_after=260
    /// </code>
    /// <para>
    /// Nothing in that text could answer it. <c>owner_tile</c> says where the counter is and never whether reaching it
    /// was required, so the two readings - she stood at the counter, she never had to - were one receipt. The decision
    /// was NOT to invent a distance rule the engine does not have (see
    /// <see cref="ExecutionManager.ShopCounterReachRefusal"/>): the receipt states which gate exists. That is why the
    /// two kinds carry two different tokens rather than one number, and why the NPC form states NO distance at all
    /// instead of a zero that would read as a measurement.
    /// </para>
    /// </summary>
    [Fact]
    public void APurchaseReceiptStatesWhichDistanceGateItsCounterFormHas()
    {
        string npcOwner = Receipt(tileOpened: false, OwnerX, OwnerY, ActorX, ActorY);
        npcOwner.Should().Contain(
            "entry=npc_owner;distance_required=none;why=engine_has_no_gate_for_npc_counters",
            "round92: the counter an NPC runs has no player-distance gate anywhere in the engine, and the receipt has to "
                + "say so rather than leave a watcher to guess at a boundary that was never crossed");
        npcOwner.Should().NotContain(
            ";distance=",
            "no gap was measured against any gate, so none is stated: a `distance=0` here would be a number invented for "
                + "a gate the engine does not have");

        string tileCounter = Receipt(tileOpened: true, OwnerX, OwnerY, ActorX + 1, ActorY);
        tileCounter.Should().Contain(
            "entry=tile_action;distance_required=1;distance=1",
            "a counter that IS a tile is gated by the engine's own click radius, and the receipt states the gap it "
                + "measured beside the radius it was measured against");
        tileCounter.Should().NotContain(
            ";why=",
            "the gated form has a gate, so there is no absence to explain - the two tokens are exclusive");
    }

    /// <summary>
    /// THE NUMBER AND THE GATE ARE ONE FACT. <c>distance</c> is measured in the engine's own metric
    /// (<c>Utility.tileWithinRadiusOfPlayer</c>, Utility.cs:4100-4109), so "at or below the radius" must hold exactly
    /// where the engine admits the tile, at every offset of a two-tile window. A sum of axis deltas is what would
    /// disagree first: it refuses the diagonal the engine admits, and the receipt would then state a gap for a purchase
    /// the engine refuses.
    ///
    /// <para>
    /// THIS IS A CROSS-CHECK, not a restatement: the expected answer comes from the engine's own function called with
    /// the same body, and the produced answer comes from the receipt's own text. The counts - nine admitted, sixteen
    /// refused - are the square radius measured rather than asserted.
    /// </para>
    /// </summary>
    [Fact]
    public void TheDistanceAReceiptStatesIsTheEnginesOwnGateAtEveryOffset()
    {
        using ActorHarness harness = ActorHarness.Create();
        int admitted = 0;
        int refused = 0;
        for (int dy = -2; dy <= 2; dy++)
        {
            for (int dx = -2; dx <= 2; dx++)
            {
                harness.StandOn(OwnerX + dx, OwnerY + dy);
                bool native = Utility.tileWithinRadiusOfPlayer(
                    OwnerX, OwnerY, ExecutionManager.NativeInteractionRadius, harness.Actor);
                int stated = StatedDistance(Receipt(tileOpened: true, OwnerX, OwnerY, OwnerX + dx, OwnerY + dy));

                (stated <= ExecutionManager.NativeInteractionRadius).Should().Be(
                    native,
                    $"the receipt states distance={stated} from an offset of {dx},{dy} and the engine's own answer there "
                        + $"is {native}");
                if (native)
                    admitted++;
                else
                    refused++;
            }
        }

        admitted.Should().Be(
            9,
            "the engine tests BOTH axes against the radius, so nine tiles of a two-tile window are inside it");
        refused.Should().Be(
            16,
            "and the sixteen outside it are the ones the action refuses: five tiles would be a sum of axis deltas");
    }

    /// <summary>
    /// round92's own purchase, as the producer emits it: twelve seeds at Pierre's counter, 500g in the purse and 260g
    /// after. The two counter forms are the two this action opens (see the class summary), and the body's tile is a
    /// parameter because the distance the receipt states is measured against it.
    /// </summary>
    private static string Receipt(bool tileOpened, int counterX, int counterY, int actorX, int actorY)
    {
        const int unitPrice = 20;
        const int requested = 12;
        const int purse = 500;
        return ExecutionManager.ShopPurchaseReceipt(new ExecutionManager.ShopPurchaseReceiptFacts(
            ShopId: "SeedShop",
            OwnerName: tileOpened ? string.Empty : "Pierre",
            TileOpened: tileOpened,
            ItemId: "(O)472",
            Requested: requested,
            Purchased: requested,
            UnitPrice: unitPrice,
            CurrencyBefore: purse,
            CurrencyAfter: purse - (requested * unitPrice),
            OwnedBefore: 0,
            OwnedAfter: requested,
            StockBefore: 999,
            StockAfter: 999 - requested,
            CounterX: counterX,
            CounterY: counterY,
            MenuClosed: true,
            Clicks: new[] { "click11:row=0|cursor=0|held_after=(O)472" },
            Drops: new[] { "drop11:slot=0|held=(O)472->none" },
            UpgradedToolId: null,
            DaysLeftForToolUpgrade: 0,
            RequiredToolQualifiedId: string.Empty,
            RequiredToolBefore: 0,
            RequiredToolAfter: 0,
            PurchaseDialogue: "none"));
    }

    /// <summary>The gap a receipt states, read off the receipt's own text - the producer's answer, not a second count.</summary>
    private static int StatedDistance(string detail)
    {
        int at = Array.FindIndex(
            detail.Split(';'), part => part.StartsWith("distance=", StringComparison.Ordinal));
        if (at < 0)
            throw new InvalidOperationException($"a tile counter's receipt states the gap it measured: {detail}");
        return int.Parse(
            detail.Split(';')[at]["distance=".Length..], NumberStyles.Integer, CultureInfo.InvariantCulture);
    }

    /// <summary>
    /// A counter that is shut today answers with DISCOVERY'S OWN WORD. The old purchase path answered
    /// <c>shop_counter_out_of_reach</c> with a <c>closed_message=</c> appended - a distance for a shop that was not open -
    /// so the companion walked closer, which could never have helped. One token, one meaning, both callers.
    /// </summary>
    [Fact]
    public void ACounterThatIsShutAnswersWithTheDiscoveryGatesOwnReason()
    {
        GameBuddy.Stardew.Core.Policy.DiscoveryExclusionReasons.ShopClosedToday.Should().Be("shop_closed_today");

        ExecutionManager
            .ShopClosedNowRefusal("SeedShop", "Pierre", OwnerX, OwnerY, ActorX, ActorY, "Pierre's shop is closed today.")
            .Should()
            .Be("shop=SeedShop;owner=Pierre;owner_tile=4,17;actor_tile=5,19;closed_message=Pierre's shop is closed today.");

        // A counter no NPC runs is spelled `none`, the same way every optional value is spelled in this action's evidence.
        ExecutionManager
            .ShopClosedNowRefusal("Joja", string.Empty, 2, 3, 2, 4, null)
            .Should()
            .Be("shop=Joja;owner=none;owner_tile=2,3;actor_tile=2,4");

        string source = File.ReadAllText(RepositorySourcePath(ImplementationRelativePath));
        int discoveryAt = source.IndexOf("exclusions.Record(\"shopTargets\", DiscoveryExclusionReasons.ShopClosedToday)", StringComparison.Ordinal);
        int purchaseAt = source.IndexOf("DiscoveryExclusionReasons.ShopClosedToday,", StringComparison.Ordinal);
        discoveryAt.Should().BeGreaterThanOrEqualTo(0, "discovery names the withheld counter in the family's exclusions");
        purchaseAt.Should().BeGreaterThan(discoveryAt, "the purchase path answers with the SAME token, not a second one");
        source.Should().NotContain(
            "\"shop_open_refused\"",
            "a shut counter is not an open-refusal: the reason is the one discovery already publishes");
    }

    /// <summary>
    /// The population gate: every reason a purchase can REFUSE with is named here with what it states, so a new refusal
    /// cannot appear without someone saying which world fact it reports. The four world answers are the counter being
    /// shut, the item not being sold, the item being out of stock and the purse being short; the rest are identity or
    /// request-shape answers, which are not about the trade.
    ///
    /// <para>
    /// The POPULATION is the handler's, never this table's: every <c>ExecutionState.Rejected</c> code the request body
    /// emits, plus every code a refusal producer that body reaches by name mints. A producer spells its family
    /// <c>family:{payload}</c> because the code carries an item id, a page count or the engine's own reason, so it is
    /// declared by family. When the confirm moved into the engine's own click path the row refusal split into
    /// <c>shop_item_absent_from_sale</c>, <c>shop_item_beyond_last_page</c>, <c>inventory_cannot_accept</c> and
    /// <c>shop_purchase_refused</c>, and <c>shop_offer_not_purchasable</c> stopped existing - this gate said so instead
    /// of agreeing with a stale copy.
    /// </para>
    /// </summary>
    [Fact]
    public void EveryRefusalAPurchaseCanReachIsNamedAndJustified()
    {
        IReadOnlyDictionary<string, string> declared = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            // The four the trade can answer with.
            ["shop_closed_today"] = "the counter is here and shut today: discovery's own reason, with the game's closed text",
            ["item_not_sold_here"] = "NO counter in this room carries the item: stock= is this counter's row count and sold_here_by=none says the scan found nothing that does - not that no shop in the game sells it, which is a fact only the top shop table would answer",
            ["item_sold_by_another_counter"] = "THIS counter's rows do not carry the item and another counter in this room does: sold_here_by= names it, so the caller has an address instead of a dismissal",
            ["out_of_stock"] = "the counter offers it and has none left",
            ["insufficient_money"] = "the purse is short: price=/currency=/available=/held=/short=, the comparison and its gap",
            ["shop_counter_out_of_reach"] = "a TILE counter the actor cannot act on from here, or no eligible owner can run this counter from this room",
            // Identity and request shape: what the caller asked for, not what the world offered.
            ["shop_target_unavailable"] = "this id names no counter in this room",
            ["shop_target_is_a_shop_id_not_a_counter:*"] = "the value is a Data/Shops SHOP id, not a counter: kind=shop_id with the counters here that would run it, beside available_here",
            ["missing_expected_target_id"] = "the request named no counter",
            ["missing_expected_item"] = "the request named no item",
            ["invalid_quantity"] = "the request asked for fewer than one",
            ["world_not_ready"] = "the actor has no current location",
            ["modal_open"] = "a menu or dialogue is up, so this action would be driving over whatever opened it",
            // What the engine's own confirm path answered, each named by the goods or by the reason it carries.
            ["shop_item_absent_from_sale:*"] = "the opened menu's own forSale list does not hold the item, so there is no row to click",
            ["shop_item_beyond_last_page:*"] = "the engine's own pager could not bring the sale's row on screen, so no click can address it",
            ["inventory_cannot_accept:*"] = "the engine charged and the goods are still on the cursor: no inventory slot could take the stack",
            ["shop_purchase_refused:*"] = "the engine's confirm charged nothing; the payload is its reason (no_effect, native_click_refused, held_item_occupied, menu_closed)",
            // The Bookseller's own tile gate: refused rather than bypassed, because a real click would not have opened it.
            ["shop_tile_gate_refused"] = "the Bookseller stall is not open on this day of the season (GameLocation.cs:8727-8744)",
            ["shop_tile_requires_dialogue"] = "the Bookseller stall asks a Buy/Trade/Leave question, which this action does not drive",
        };

        string handler = File.ReadAllText(RepositorySourcePath(ImplementationRelativePath));
        string body = MethodBody(handler, "public LocalExecutionReceipt RequestLocalShopPurchase(");

        // The set is read out of the handler. The two the body spells as expressions are handled here: the bound-actor
        // guard's own reason comes from `TryGetBoundActor`, and the closed token is discovery's (which is why
        // `shop_closed_today` must NOT be a literal in this body).
        HashSet<string> reached = RefusalCodesReachedBy(handler, body);
        reached.Should().NotContain("shop_closed_today", "the closed token has ONE spelling, in DiscoveryExclusionReasons");
        body.Should().Contain(
            "DiscoveryExclusionReasons.ShopClosedToday,",
            "the shut-counter refusal is emitted, through discovery's own token");
        reached.Add("shop_closed_today");

        List<string> undeclared = reached
            .Where(code => !declared.ContainsKey(code))
            .OrderBy(code => code, StringComparer.Ordinal)
            .ToList();
        undeclared.Should().BeEmpty(
            "every refusal this purchase can reach must be declared with the fact it reports; undeclared: "
            + string.Join(", ", undeclared));

        List<string> unreached = declared.Keys
            .Where(key => !reached.Contains(key))
            .OrderBy(key => key, StringComparer.Ordinal)
            .ToList();
        unreached.Should().BeEmpty(
            "a declared refusal the handler no longer mints is a stale copy of it, not a gate; stale: "
            + string.Join(", ", unreached));
    }

    /// <summary>
    /// The other half of "stop lying": a refusal may not be decided by a distance to the OWNER, and a refusal that names a
    /// price may not skip the tokens the price comparison owes (<c>held=</c> and <c>short=</c>, asserted on the renderer by
    /// <see cref="ShopPurchasePriceComparisonTests"/>). Both are read from the body rather than from a second copy.
    /// </summary>
    [Fact]
    public void NoRefusalIsDecidedByADistanceToTheOwner()
    {
        string body = StripLineComments(MethodBody(
            File.ReadAllText(RepositorySourcePath(ImplementationRelativePath)),
            "public LocalExecutionReceipt RequestLocalShopPurchase("));

        body.Should().NotContain("OwnerInReach", "that fact is published for the caller to read, not enforced by the action");
        body.Should().NotContain("ShopOwnerInteractionRadius", "an NPC-proximity radius is not a gate the engine has");
        body.Should().NotContain(
            "tileWithinRadiusOfPlayer(",
            "the tile gate is asked through `ShopCounterReachRefusal`/`IsWithinRangeOfRequest`, which is the engine's own "
                + "call, so the action cannot measure a second distance beside it");
        body.Should().Contain("ShopCounterReachRefusal(", "the reach fact has one producer");

        // One RENDERER per token: two sites would be two meanings again. The code is reached from a tile outside the
        // engine's radius and from a counter no eligible owner can run in this room, and both spell the same three tokens.
        body.Should().Contain("\"shop_counter_out_of_reach\"", "the action refuses an unreachable counter");
        body.Should().NotContain(
            "radius=",
            "the radius token is produced by `ShopCounterReachEvidence` and respelled at no site");
        body.Should().Contain(
            "ShopCounterReachEvidence(",
            "the no-owner refusal renders its comparison through that one producer");
        // One RENDERER per token, now that two refusals name a price: the purse refusal goes through
        // `ShopPurchaseAffordabilityEvidence` (held=/short=) and the full-pack refusal through `ShopPackRefusalEvidence`
        // (room=). Neither spelling may appear in the body itself, which is what the count below says.
        body.Should().NotContain(
            "price=",
            "a refusal's price is rendered by its producer, never spelled in the request body");
        body.Should().Contain(
            "ShopPurchaseAffordabilityEvidence(",
            "the affordability refusal renders its comparison through that one producer");
        body.Should().Contain(
            "ShopPackRefusalEvidence(",
            "and the purchase the pack cannot hold renders ITS comparison through its own producer, before the purse pays");
    }

    /// <summary>One counter in this room, built the way discovery builds it: the published opaque id, the shop it belongs
    /// to, the owner that runs it (empty for a tile-opened stall) and the tile it is acted on from.</summary>
    private static ExecutionManager.DiscoveredShopCounter Counter(
        string shopId,
        string ownerName,
        int x,
        int y,
        bool opensNow = true,
        string? closedMessage = null) =>
        new(ExecutionManager.ShopTargetId(shopId, ownerName, x, y), shopId, new ShopData(), ownerName, x, y, opensNow, closedMessage);

    /// <summary>The world's shop table as far as this file needs it: which ids `Data/Shops` keys. The real table is the
    /// game's; a set of keys is all the identity question asks of it.</summary>
    private static IReadOnlyDictionary<string, ShopData> Shops(params string[] shopIds) =>
        shopIds.ToDictionary(shopId => shopId, _ => new ShopData(), StringComparer.Ordinal);

    /// <summary>
    /// THE ARGUMENT'S CONTRACT IS A COUNTER, AND `SeedShop` IS NOT ONE.
    ///
    /// <para>
    /// Measured round81, two of three `shop_purchase` attempts, verbatim:
    /// </para>
    /// <code>
    /// shop_purchase rejected  shop_target_unavailable
    ///   target=SeedShop;location=SeedShop;available_here=...,SeedShop
    /// </code>
    /// <para>
    /// She was standing IN `SeedShop` and had passed the shop's own `Data/Shops` id where a counter id goes; the refusal
    /// said the target was unavailable, which names no kind, so nothing in the receipt said "that is a shop, not the
    /// counter you meant". The value is now CLASSED against the world's shop table and refused by name, with the counters
    /// that would run it - the ids discovery already published for them.
    /// </para>
    /// </summary>
    [Fact]
    public void AShopIdPassedAsTheCounterIsRefusedByItsKindAndTheCountersItCouldMean()
    {
        ExecutionManager.DiscoveredShopCounter pierre = Counter("SeedShop", "Pierre", OwnerX, OwnerY);

        // The two identities are different strings and the world keys only one of them.
        ExecutionManager.NamesAKnownShop("SeedShop", Shops("SeedShop", "Carpenter")).Should().BeTrue(
            "`SeedShop` is a `Data/Shops` key: the SHOP, which owns no counter by itself");
        ExecutionManager.NamesAKnownShop(pierre.TargetId, Shops("SeedShop", "Carpenter")).Should().BeFalse(
            "the counter id is minted here and is no shop's key, so the two can never be confused by this test");
        ExecutionManager.NamesAKnownShop("NotAShop", Shops("SeedShop")).Should().BeFalse(
            "an id the world does not key stays `shop_target_unavailable`, which is still the truthful answer for it");

        ExecutionManager.ShopIdAsCounterRefusalCode("SeedShop").Should().Be(
            "shop_target_is_a_shop_id_not_a_counter:SeedShop",
            "the KIND is in the code, so a caller that reads only `reasonCode` still learns what it passed");

        string evidence = ExecutionManager.ShopIdTargetRefusalEvidence(
            "SeedShop", "SeedShop", new[] { pierre }, availableHere: "SeedShop");
        evidence.Should().Be(
            $"target=SeedShop;kind=shop_id;location=SeedShop;counters={pierre.TargetId}@{OwnerX},{OwnerY};available_here=SeedShop",
            "the counters it could mean are spelled in the id `shop_purchase` takes, beside the shops this room has");
        evidence.Length.Should().BeLessThanOrEqualTo(
            SweepTargetRefusalNamingTests.RefusalActionability.ModelShare,
            "a refusal the model cannot read in full is a refusal it cannot act on");

        // The same room, a shop whose counter is NOT here: the kind is still named, and the list says `none` rather than
        // leaving the field out - an absent field and an empty one are different facts.
        ExecutionManager
            .ShopIdTargetRefusalEvidence("SeedShop", "Farm", Array.Empty<ExecutionManager.DiscoveredShopCounter>(), "Joja")
            .Should()
            .Be("target=SeedShop;kind=shop_id;location=Farm;counters=none;available_here=Joja");
    }

    /// <summary>
    /// A COUNTER THAT DOES NOT CARRY THE ITEM SAYS WHICH ABSENCE IT MEANS.
    ///
    /// <para>
    /// Measured round81, the one attempt that reached a counter, verbatim:
    /// </para>
    /// <code>
    /// shop_purchase rejected  item_not_sold_here
    ///   shop=DesertFestival_Gus;item=(O)474;stock=5
    /// </code>
    /// <para>
    /// A festival stall holding five stock rows and not this one, in a shape a counter that stocks NOTHING would have
    /// answered identically - and those are different problems: the first says leave, the second says the stall is empty
    /// today. So the receipt names the COUNTER it read (a shop has one counter per owner here, so `shop=` alone does not
    /// say which) and any counter in this room whose own rows do carry the item. `available_here` in the sibling refusals
    /// could NOT have answered this: it lists SHOPS, and a shop being here says nothing about its rows.
    /// </para>
    /// </summary>
    [Fact]
    public void ACountersStockMissingTheItemSaysWhichAbsenceItMeans()
    {
        ExecutionManager.DiscoveredShopCounter stall = Counter("DesertFestival_Gus", string.Empty, 12, 40);
        ExecutionManager.DiscoveredShopCounter pierre = Counter("SeedShop", "Pierre", OwnerX, OwnerY);

        ExecutionManager
            .ShopItemNotSoldEvidence(
                "DesertFestival_Gus",
                stall,
                "(O)474",
                stock: 5,
                soldHereBy: $"{pierre.TargetId}@{OwnerX},{OwnerY}",
                countersRead: 1)
            .Should()
            .Be(
                $"shop=DesertFestival_Gus;counter={stall.TargetId}@12,40;item=(O)474;stock=5;"
                + $"sold_here_by={pierre.TargetId}@{OwnerX},{OwnerY};counters_read=1",
                "the counter that has it is named in the shape the action takes, which is the half `stock=5` never carried");

        // Nothing in this room carries it: `none` is a fact about the room, and `counters_read=0` says there was nothing
        // else to ask - the reading is a count of what was measured, never a silent zero.
        ExecutionManager
            .ShopItemNotSoldEvidence("DesertFestival_Gus", stall, "(O)474", stock: 5, soldHereBy: "none", countersRead: 0)
            .Should()
            .Be($"shop=DesertFestival_Gus;counter={stall.TargetId}@12,40;item=(O)474;stock=5;sold_here_by=none;counters_read=0");

        // AN UNREADABLE STOCK IS NOT AN EMPTY ONE. The scan's answer is three-valued for that reason; a counter whose
        // stock could not be read is left out of both halves rather than counted as "does not carry it".
        ExecutionManager
            .ShopStockCarries("DesertFestival_Gus", new ShopData(), "(O)474")
            .Should()
            .NotBe(true, "a world with no shop stock mounted can never answer that this counter carries anything");
    }

    /// <summary>
    /// THE GATE: an identity argument names the kind of thing it is.
    ///
    /// <para>
    /// The POPULATION is the action surface's, never this file's: every argument whose name ends in the kind word `Id`, on
    /// every mounted execution action that declares the <c>shopTargets</c> family - the family whose ids the world can
    /// classify, because `Data/Shops` keys the SHOP and <see cref="ExecutionManager.ShopTargetId"/> mints a COUNTER, so one
    /// argument in this family can legitimately receive either. A new shop action's identity argument is drawn in by the
    /// registry, not by this file remembering to add it.
    /// </para>
    /// <para>
    /// CLASSIFIED means the argument's refusals spell that kind, through ONE producer the request body reaches: a value the
    /// world can class two ways, answered by a word that names neither, is what round81's three attempts spent a day on.
    /// </para>
    /// </summary>
    [Fact]
    public void AnIdentityArgumentNamesTheKindOfThingItIs()
    {
        string handler = File.ReadAllText(RepositorySourcePath(ImplementationRelativePath));
        string body = MethodBody(handler, "public LocalExecutionReceipt RequestLocalShopPurchase(");

        List<(string ActionId, string Argument)> arguments = FarmhandActionCatalog.Registrations
            .Where(registration => registration.Kind == FarmhandOperationKind.Execution && registration.Descriptor is not null)
            .Where(registration => string.Equals(
                registration.Descriptor!.TargetFamily, ShopTargetFamily, StringComparison.Ordinal))
            .SelectMany(registration => registration.Descriptor!.Arguments
                .Where(argument => argument.Name.EndsWith(KindWord, StringComparison.Ordinal))
                .Select(argument => (registration.ActionId, argument.Name)))
            .ToList();

        List<string> bare = new();
        foreach ((string actionId, string argument) in arguments)
        {
            if (!KindSpelling.TryGetValue(argument, out (string Token, string Producer) spelling)
                || !body.Contains(spelling.Producer, StringComparison.Ordinal)
                || !MethodBody(handler, spelling.Producer).Contains(spelling.Token, StringComparison.Ordinal))
            {
                bare.Add($"{actionId}.{argument}");
            }
        }

        this.output.WriteLine(
            $"an_identity_argument_names_the_kind_of_thing_it_is: arguments {arguments.Count} · "
            + $"classified {arguments.Count - bare.Count} · bare {bare.Count}");

        arguments.Should().NotBeEmpty(
            $"a zero population agrees with itself: no mounted action declares {ShopTargetFamily} any more, so this gate "
                + "has stopped reading the surface it was written for");

        List<string> stale = KindSpelling.Keys
            .Where(argument => !arguments.Any(entry => string.Equals(entry.Argument, argument, StringComparison.Ordinal)))
            .OrderBy(argument => argument, StringComparer.Ordinal)
            .ToList();
        stale.Should().BeEmpty(
            "a declared kind whose argument has left the surface is a stale copy, not a gate: " + string.Join(", ", stale));

        bare.Should().BeEmpty(
            "an identity argument whose value the world can class must name the kind it received; bare: "
                + string.Join(", ", bare));
    }

    /// <summary>What an argument's NAME has to end in to be an identity argument: the kind word, not a kind.</summary>
    private const string KindWord = "Id";

    /// <summary>The published row family whose ids a shop action's counter argument takes.</summary>
    private const string ShopTargetFamily = "shopTargets";

    /// <summary>
    /// The kind each identity argument's refusals spell, and the ONE producer that spells it. Declared here because the
    /// kind a value is has to be chosen by someone: a `SeedShop` is a shop and a `shop_<16 hex>` is a counter, and no
    /// naming scheme the argument could carry would say both.
    /// </summary>
    private static readonly IReadOnlyDictionary<string, (string Token, string Producer)> KindSpelling =
        new Dictionary<string, (string Token, string Producer)>(StringComparer.Ordinal)
        {
            // The value can be a counter id OR a `Data/Shops` key: the refusal names which it got.
            ["expectedTargetId"] = ("kind=shop_id", "ShopIdTargetRefusalEvidence("),
            // A qualified item id names its own kind by its `(T)` prefix, so the refusals that carry it have only to
            // carry it AS an item id - which is what an `item=` field is and what a bare `stock=5` was not.
            ["expectedQualifiedItemId"] = ("item=", "ShopPackRefusalEvidence("),
        };

    /// <summary>How far the closure follows producers: request body, the producer it calls, and the one that calls.</summary>
    private const int MaxProducerHops = 3;

    private static readonly Regex RejectedCode =
        new("ExecutionState\\.Rejected,\\s*\"([a-z][a-z0-9_]*)\"", RegexOptions.Compiled);

    private static readonly Regex RefusalFamily = new("\\$?\"([a-z][a-z0-9_]*):", RegexOptions.Compiled);

    private static readonly Regex NamedCall = new("\\b([A-Za-z_][A-Za-z0-9_]*)\\s*\\(", RegexOptions.Compiled);

    /// <summary>
    /// Every refusal code this purchase can return, read from the handler itself: the literals the request body emits
    /// and the codes each refusal producer it reaches by name mints. A producer's code carries a payload (an item id, a
    /// page count, the engine's reason), so it is collected as the family <c>name:*</c>.
    /// </summary>
    private static HashSet<string> RefusalCodesReachedBy(string handler, string requestBody)
    {
        var codes = new HashSet<string>(StringComparer.Ordinal);
        var pending = new Queue<(string Body, int Hop)>();
        var visited = new HashSet<string>(StringComparer.Ordinal);
        int bodies = 0;
        pending.Enqueue((requestBody, 0));
        while (pending.Count > 0)
        {
            (string body, int hop) = pending.Dequeue();
            bodies++;
            foreach (Match match in RejectedCode.Matches(body))
                codes.Add(match.Groups[1].Value);
            foreach (Match match in RefusalFamily.Matches(body))
                codes.Add(match.Groups[1].Value + ":*");
            if (hop >= MaxProducerHops)
                continue;
            foreach (Match call in NamedCall.Matches(body))
            {
                string name = call.Groups[1].Value;
                if (!visited.Add(name))
                    continue;
                int declaration = DeclarationOf(handler, name);
                if (declaration >= 0)
                    pending.Enqueue((MemberBody(handler, declaration), hop + 1));
            }
        }

        bodies.Should().BeGreaterThan(
            1, "the closure must reach the producers the body calls, or this gate reads nothing but the request");
        return codes;
    }

    /// <summary>Where this file declares <paramref name="name"/>, or -1 when the member lives elsewhere.</summary>
    private static int DeclarationOf(string handler, string name)
    {
        Match declaration = Regex.Match(
            handler,
            $@"(?:internal|private|public)\s+static\s+[^;{{}}]*?\b{Regex.Escape(name)}\s*\(",
            RegexOptions.Singleline);
        return declaration.Success ? declaration.Index : -1;
    }

    /// <summary>The body of the member declared at <paramref name="declaration"/>, braced or expression-bodied.</summary>
    private static string MemberBody(string handler, int declaration)
    {
        int brace = handler.IndexOf('{', declaration);
        int arrow = handler.IndexOf("=>", declaration, StringComparison.Ordinal);
        if (arrow >= 0 && (brace < 0 || arrow < brace))
        {
            int end = handler.IndexOf(';', arrow);
            return handler[arrow..(end + 1)];
        }

        int depth = 0;
        for (int cursor = brace; cursor < handler.Length; cursor++)
        {
            if (handler[cursor] == '{')
                depth++;
            else if (handler[cursor] == '}' && --depth == 0)
                return handler[brace..(cursor + 1)];
        }

        throw new InvalidOperationException("unbalanced member body");
    }

    private static int Occurrences(string source, string needle)
    {
        int count = 0;
        for (int index = source.IndexOf(needle, StringComparison.Ordinal); index >= 0;
             index = source.IndexOf(needle, index + needle.Length, StringComparison.Ordinal))
        {
            count++;
        }

        return count;
    }

    /// <summary>The brace-balanced body of the method whose signature starts at <paramref name="signature"/>.</summary>
    private static string MethodBody(string source, string signature)
    {
        int start = source.IndexOf(signature, StringComparison.Ordinal);
        start.Should().BeGreaterThanOrEqualTo(0, $"{signature} must exist, or this gate reads nothing");
        int opening = source.IndexOf('{', start);
        int depth = 0;
        for (int cursor = opening; cursor < source.Length; cursor++)
        {
            if (source[cursor] == '{')
                depth++;
            else if (source[cursor] == '}' && --depth == 0)
                return source[opening..(cursor + 1)];
        }

        throw new InvalidOperationException("unbalanced method body");
    }

    /// <summary>Drops line comments, because the gate is about what the action DOES.</summary>
    private static string StripLineComments(string source)
    {
        string[] lines = source.Split('\n');
        for (int index = 0; index < lines.Length; index++)
        {
            int comment = lines[index].IndexOf("//", StringComparison.Ordinal);
            if (comment >= 0)
                lines[index] = lines[index][..comment];
        }

        return string.Join('\n', lines);
    }

    private static string RepositorySourcePath(string relative)
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++)
            {
                string candidate = Path.Combine(directory.FullName, relative);
                if (File.Exists(candidate))
                    return candidate;
                directory = directory.Parent;
            }
        }

        throw new FileNotFoundException($"repository source not found: {relative}");
    }

    /// <summary>
    /// A real <see cref="Farmer"/> with the engine's 48x32 body, placed on whole tiles, plus the <c>Game1</c> statics
    /// <see cref="Character.Tile"/> dereferences (<c>NetPosition.Get</c> reads <c>Game1.HostPaused</c>,
    /// <c>StandingPixel</c> reads the sprite and the mount). The assembly already runs without parallelization, so
    /// restoring the statics on dispose is sufficient.
    /// </summary>
    private sealed class ActorHarness : IDisposable
    {
        private readonly Game1? gameBefore;
        private readonly Farmer? playerBefore;
        private readonly object? worldStateBefore;

        private ActorHarness()
        {
            this.gameBefore = Game1.game1;
            this.playerBefore = Game1.player;
            this.worldStateBefore = typeof(Game1)
                .GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!
                .GetValue(null);
            this.Actor = null!;
        }

        public Farmer Actor { get; private set; }

        public static ActorHarness Create()
        {
            var harness = new ActorHarness();

            var root = (NetRoot<NetWorldState>)System.Runtime.Serialization.FormatterServices
                .GetUninitializedObject(typeof(NetRoot<NetWorldState>));
            root.Value = new NetWorldState();
            typeof(Game1)
                .GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!
                .SetValue(null, root);
            if (Game1.game1 is null)
                Game1.game1 = (Game1)System.Runtime.Serialization.FormatterServices.GetUninitializedObject(typeof(Game1));

            var sprite = (FarmerSprite)System.Runtime.Serialization.FormatterServices
                .GetUninitializedObject(typeof(FarmerSprite));
            SetField(sprite, "spriteWidth", new NetInt(16));
            SetField(sprite, "spriteHeight", new NetInt(32));
            SetField(sprite, "tempSpriteHeight", -1);

            var actor = (Farmer)System.Runtime.Serialization.FormatterServices.GetUninitializedObject(typeof(Farmer));
            SetField(actor, "position", new NetPosition());
            SetField(actor, "currentLocationRef", new NetLocationRef());
            SetField(actor, "netMount", new NetRef<StardewValley.Characters.Horse>());
            SetField(actor, "sprite", new NetRef<AnimatedSprite> { Value = sprite });
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, actor);

            harness.Actor = actor;
            harness.StandOn(0, 0);
            return harness;
        }

        /// <summary>Puts the body on <paramref name="x"/>,<paramref name="y"/>: tile centre in X, tile top in Y.</summary>
        public void StandOn(int x, int y) => this.Actor.position.Set(new Vector2(x * 64 + 8, y * 64));

        private static void SetField(object target, string name, object value) =>
            target.GetType()
                .GetField(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!
                .SetValue(target, value);

        public void Dispose()
        {
            typeof(Game1).GetField("_player", BindingFlags.NonPublic | BindingFlags.Static)!.SetValue(null, this.playerBefore);
            typeof(Game1)
                .GetField("netWorldState", BindingFlags.Public | BindingFlags.Static)!
                .SetValue(null, this.worldStateBefore);
            Game1.game1 = this.gameBefore!;
        }
    }
}
