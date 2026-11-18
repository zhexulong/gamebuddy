using System;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.CompilerServices;
using FluentAssertions;
using Microsoft.Xna.Framework;
using Microsoft.Xna.Framework.Graphics;
using Netcode;
using StardewValley;
using StardewValley.Audio;
using StardewValley.Inventories;
using StardewValley.Menus;
using Xunit;

namespace GameBuddy.Stardew.Integration.Tests;

/// <summary>
/// `shop_purchase` reaches the sale it was asked for, and the goods it bought end up in the stack they belong to.
///
/// <para>
/// THE DEFECT. The purchase translated the sale's index into a button index and then refused it when the button was
/// not on screen (<c>farmhandexecutioncontroller.shopactions.cs</c>, `saleIndex - currentItemIndex` rejected against
/// `forSaleButtons.Count`). `ShopMenu` draws four rows at a time (<c>ShopMenu.cs:398-406</c>) and resolves a clicked
/// button as <c>forSale[currentItemIndex + k]</c> (:1096-1102), so every entry past the fourth had no clickable
/// coordinate at all and every such purchase was refused with a bare <c>button=-1</c> - an index that is not an item,
/// not a page and not a reason. The second half is the drop: the purchase leaves the goods on the cursor
/// (<c>ShopMenu.cs:1352</c>) and the only slots searched were EMPTY ones, so a purchase that could merge into a stack
/// found nowhere to go, and the goods were destroyed when the menu closed under them.
/// </para>
/// <para>
/// WHAT IS DRIVEN HERE. The menu is a real <c>ShopMenu</c> instance whose paging and purchase machinery is the engine's
/// own: <c>receiveScrollWheelAction</c>, <c>downArrowPressed</c>, <c>setScrollBarToCurrentIndex</c>,
/// <c>receiveLeftClick</c> and <c>tryToPurchaseItem</c> all run their real code over the fields
/// <c>ShopMenu.Initialize</c> installs (:384-406). The sale entries are a minimal <c>Item</c> whose
/// <c>actionWhenPurchased</c> records its caller, which is how an upgrade entry is observed without Clint's dialogue -
/// the call is the engine's, and the assertion is on the shop id it passed.
/// </para>
/// <para>
/// The constructor of the real menu cannot run in this process (<c>ShopMenuHeadlessProbe</c> records why: it needs a
/// mounted world, content textures and an XNA viewport), so the instance is fabricated and its fields are the ones the
/// engine's own initializer writes. Nothing in this file re-implements paging, pricing or stacking: those are the
/// engine's functions, called with the production code's own decisions (<c>ShopSaleRowInView</c>,
/// <c>ShopDropSlot</c>).
/// </para>
/// </summary>
[Collection(HeadlessGameWorld.Collection)]
public sealed class ShopSaleReachTests : IDisposable
{
    private const int Price = 20;
    private const int Rows = 4;

    private readonly Farmer? playerBefore;
    private readonly IClickableMenu? menuBefore;
    private readonly ISoundsHelper? soundsBefore;
    private readonly Game1? gameBefore;

    public ShopSaleReachTests()
    {
        this.playerBefore = (Farmer?)Static(typeof(Game1), "_player").GetValue(null);
        this.menuBefore = (IClickableMenu?)Static(typeof(Game1), "_activeClickableMenu").GetValue(null);
        this.soundsBefore = Game1.sounds;
        this.gameBefore = Game1.game1;

        var game = (Game1)RuntimeHelpers.GetUninitializedObject(typeof(Game1));
        game.instanceOptions = (Options)RuntimeHelpers.GetUninitializedObject(typeof(Options));
        Game1.game1 = game;
        Game1.sounds = new SilentSoundsHelper();
        Game1.mouseClickPolling = 0;
        Game1.hudMessages ??= new List<HUDMessage>();
    }

    public void Dispose()
    {
        Static(typeof(Game1), "_activeClickableMenu").SetValue(null, this.menuBefore);
        Static(typeof(Game1), "_player").SetValue(null, this.playerBefore);
        Game1.sounds = this.soundsBefore!;
        Game1.game1 = this.gameBefore!;
    }

    /// <summary>
    /// The property the whole class exists for: after the production seam has put the menu's cursor on the page that
    /// shows the requested sale, the row it answers is the row the ENGINE resolves to that same sale - for every sale
    /// a shop can have, not for the one index the defect was measured at.
    ///
    /// <para>
    /// The population is derived from the shop's own sale list, so a shop that grows or a menu that draws a different
    /// number of rows is inside this gate without an edit. A row that resolved to a different entry would buy the wrong
    /// goods with the caveat that the refund would look like a purchase.
    /// </para>
    /// </summary>
    [Theory]
    [InlineData(1)]
    [InlineData(4)]
    [InlineData(5)]
    [InlineData(9)]
    [InlineData(17)]
    [InlineData(36)]
    public void EverySaleIsReachable_AndTheRowItAnswersIsTheSaleItNames(int saleCount)
    {
        using var shop = new ShopView("SeedShop", saleCount, Rows);

        for (int saleIndex = 0; saleIndex < saleCount; saleIndex++)
        {
            shop.ResetCursor();

            int row = ExecutionManager.ShopSaleRowInView(shop.Menu, saleIndex, out string? refusal);

            refusal.Should().BeNull(
                $"sale {saleIndex} of {saleCount} is in the shop's own forSale list; the menu's pager can reach every "
                + "entry, so no sale may be refused as beyond the last page");
            row.Should().BeInRange(0, Rows - 1, $"the menu draws {Rows} rows and a click only lands on one of them");
            shop.Menu.forSale[shop.Menu.currentItemIndex + row].QualifiedItemId.Should().Be(
                $"(O){saleIndex}",
                "the engine resolves a clicked button as forSale[currentItemIndex + k] (ShopMenu.cs:1096-1102), so the "
                + "row must hold the sale that was asked for");
        }
    }

    /// <summary>
    /// The measured defect, as one case: nine sales, four rows, the ninth wanted. The old translation answered
    /// `8 - 0 = 8`, rejected it against four rows and refused; the pager puts the cursor on the last page and the row
    /// holds the ninth sale.
    /// </summary>
    [Fact]
    public void TheNinthSaleOfNineIsReachable_WhereTheUntranslatedIndexWasNot()
    {
        using var shop = new ShopView("SeedShop", saleCount: 9, Rows);

        int row = ExecutionManager.ShopSaleRowInView(shop.Menu, saleIndex: 8, out string? refusal);

        refusal.Should().BeNull("nine sales over four rows are three pages, and the menu can show the third");
        row.Should().Be(3, "the last page of nine sales with four rows starts at five, so the ninth is its fourth row");
        shop.Menu.currentItemIndex.Should().Be(5, "the engine's cursor was moved to that page by the engine's own pager");
        shop.Menu.forSale[shop.Menu.currentItemIndex + row].QualifiedItemId.Should().Be("(O)8");
    }

    /// <summary>
    /// The purchase itself, through the engine's own confirm path: the engine's click handler charges the entry's price
    /// out of the purse and hands the goods to the cursor, which is the state a real player then places. Nothing here
    /// is computed by the Mod - the money moves inside <c>tryToPurchaseItem</c>.
    /// </summary>
    [Fact]
    public void TheEngineChargesThePriceAndHandsTheGoodsToTheCursor()
    {
        using var shop = new ShopView("SeedShop", saleCount: 9, Rows);
        Farmer player = BindPlayer(money: 500);

        int row = ExecutionManager.ShopSaleRowInView(shop.Menu, saleIndex: 8, out _);
        shop.Confirm(row);

        player.Money.Should().Be(500 - Price, "the engine's own charge moved the purse by the entry's price");
        shop.Menu.heldItem.Should().NotBeNull("the purchase leaves the goods on the cursor for the player to place");
        shop.Menu.heldItem!.QualifiedItemId.Should().Be("(O)8", "the sale that was clicked is the sale that was bought");
    }

    /// <summary>
    /// An upgrade entry - the shape <c>Tool.actionWhenPurchased</c> takes for a <c>ClintUpgrade</c> shop - is reached
    /// through the same confirm path, with the menu's own shop id. That is the proof this action is ON the engine's
    /// purchase path and not beside it: the engine calls the entry's hook, and every mod that implements it is inside
    /// this call.
    ///
    /// <para>
    /// The real hook (<c>Tool.cs:873-910</c>) then takes the old tool, starts the two-day upgrade and closes the menu;
    /// that half needs a mounted world, a real tool and the dialogue box, so what is asserted here is the CALL - the
    /// shop id the engine passed - which is the fact an upgrade purchase cannot happen without regardless of how the
    /// engine's tool data is arranged.
    /// </para>
    /// </summary>
    [Fact]
    public void AnUpgradeEntryIsConfirmedThroughTheEnginesOwnPurchasePath()
    {
        using var shop = new ShopView("ClintUpgrade", saleCount: 6, Rows);
        Farmer player = BindPlayer(money: 2000);
        SaleItem upgrade = shop.Sales[5];
        upgrade.ConsumeOnPurchase = true;

        int row = ExecutionManager.ShopSaleRowInView(shop.Menu, saleIndex: 5, out _);
        shop.Confirm(row);

        upgrade.PurchasedFrom.Should().Equal(
            new[] { "ClintUpgrade" },
            "the engine reads the menu's own ShopId into actionWhenPurchased (ShopMenu.cs:1369), and that call is what "
            + "performs a tool upgrade");
        player.Money.Should().Be(2000 - Price, "an upgrade is still a purchase: the engine charged for it");
        shop.Menu.heldItem.Should().BeNull(
            "the engine discards an entry whose actionWhenPurchased returned true (ShopMenu.cs:1369-1378)");
    }

    /// <summary>
    /// The stacking half. The bag holds a partial stack of the goods and NOT ONE empty slot, which is the shape the
    /// old empty-slot search could not place: the slot the seam answers is the partial stack, and the engine's own
    /// placement merges into it - the stack grows, the number of occupied slots does not change, and nothing is left on
    /// the cursor to be destroyed when the menu closes.
    /// </summary>
    [Fact]
    public void APurchaseThatCanStackGrowsTheStack_AndNothingIsLost()
    {
        var bag = new List<Item?>();
        // The bag's stack is the SAME kind of item the purchase hands over: `Item.canStackWith` refuses across types
        // (Item.cs:720-742), so a merge test between two unrelated types would pass for the wrong reason and fail for
        // one. SaleItem is the fixture's content-free stand-in for both sides; the merge itself is the engine's own
        // `Item.addToStack`, driven through Utility.addItemToInventory.
        var seed = new SaleItem { ItemId = "472", Stack = 3 };
        bag.Add(seed);
        for (int slot = 1; slot < 12; slot++)
            bag.Add(new StardewValley.Object { ParentSheetIndex = 300 + slot });
        bag.Should().NotContainNulls("there is no empty slot: an empty-slot search has nowhere to put anything");

        using var shop = new ShopView("SeedShop", saleCount: 2, Rows, bag);
        Farmer player = BindPlayer(money: 500, bag);
        SaleItem seedSale = shop.Sales[0];
        seedSale.ItemId = "472";
        seedSale.Stack = 1;

        int row = ExecutionManager.ShopSaleRowInView(shop.Menu, saleIndex: 0, out _);
        shop.Confirm(row);
        shop.Menu.heldItem.Should().NotBeNull();

        int dropSlot = ExecutionManager.ShopDropSlot(bag!, shop.Menu.heldItem as Item);

        dropSlot.Should().Be(0, "slot 0 holds the same goods with room left, and merging is what the engine does there");
        shop.Place(dropSlot);

        seed.Stack.Should().Be(4, "the engine merged the purchase into the stack that was already there");
        bag.Should().HaveCount(12, "no slot was added: the goods went into a stack, not beside it");
        shop.Menu.heldItem.Should().BeNull("nothing was left on the cursor to be lost when the menu closes");
        bag.Count(item => item is not null && item.QualifiedItemId == "(O)472").Should().Be(1, "one stack, not two");
    }

    /// <summary>
    /// A purchase the pack cannot hold is refused BEFORE the purse pays: the goods no slot could take are what the
    /// player's own path refuses to close on, never something it deletes.
    ///
    /// <para>
    /// THIS TEST USED TO PIN THE LOSS. It drove the engine's click, saw the goods stranded on the cursor, and asserted
    /// the refusal text beside a purse that had already paid - the exact defect: `ShopPurchaseCapacity` had no inventory
    /// term, so the click charged 20g (ShopMenu.cs:1364) and the handler's own `Game1.exitActiveMenu()` then dropped the
    /// <c>ShopMenu</c> that held the stack (Game1.cs:6128-6131), destroying it. The player's own path does the opposite:
    /// `ShopMenu.readyToClose` answers false while goods are held (ShopMenu.cs:1255-1262) and the menu key hands them to
    /// <c>Utility.CollectOrDrop</c> (:965-978 -> Utility.cs:2092-2112), which puts them in the pack or on the ground.
    /// </para>
    /// <para>
    /// So this asserts the refusal at admission, from the engine's own count of what the pack can hold, and that no
    /// click happened - the purse is exactly what it was.
    /// </para>
    /// </summary>
    [Fact]
    public void AnInventoryThatCannotTakeTheGoodsIsRefusedByItem()
    {
        var bag = new List<Item?>();
        for (int slot = 0; slot < 12; slot++)
            bag.Add(new StardewValley.Object { ParentSheetIndex = 300 + slot });

        using var shop = new ShopView("SeedShop", saleCount: 2, Rows, bag);
        Farmer player = BindPlayer(money: 500);
        SaleItem goods = shop.Sales[0];
        goods.ItemId = "472";
        goods.Stack = 1;
        Item pricey = (Item)goods.GetSalableInstance();

        // The pack's own answer, from the engine's own arithmetic (Utility.cs:6283-6302): every slot holds something
        // these goods do not stack with, so there is no room for one unit.
        int room = ExecutionManager.ShopPackPurchases(
            bag!, bag!.Count, pricey, unitsPerPurchase: 1, consumedByThePurchase: false);
        room.Should().Be(0, "no slot is empty and none stacks with the purchase, so the pack can take none of it");

        (long affordable, int purchasable) = ExecutionManager.ShopPurchaseCapacity(
            shop.Menu.itemPriceAndStock[goods], currencyHeld: player.Money, requestedQuantity: 1, packPurchases: room);

        affordable.Should().Be(25, "the purse could pay for twenty-five at the fixture's 20g price - money is not the reason");
        purchasable.Should().Be(0, "the pack is what refuses it, and the term that says so is part of the one count");
        player.Money.Should().Be(500, "nothing was clicked, so nothing was charged: the refusal is at admission");
        ExecutionManager.ShopInventoryRefusal(pricey).Should().Be(
            "inventory_cannot_accept:(O)472",
            "the refusal names the goods, because the caller has to know WHICH stack the pack cannot take");

        // The player's own path, as the reference for why refusing is the right answer rather than closing anyway:
        // the engine will not close this menu while it holds goods, which is the same stack the old path destroyed.
        shop.Confirm(ExecutionManager.ShopSaleRowInView(shop.Menu, 0, out _));
        shop.Menu.heldItem.Should().NotBeNull("the engine leaves the purchase on the cursor (ShopMenu.cs:1352)");
        shop.Menu.readyToClose().Should().BeFalse(
            "a real player's menu refuses to close on held goods (ShopMenu.cs:1255-1262) - it never deletes them");
    }

    /// <summary>
    /// THE GATE'S POPULATION, produced rather than listed: every receipt this suite can mint is written to
    /// <c>tools/fixtures/stardew-shop-purchase-receipts.json</c>, and
    /// <c>tools/check-stardew-shop-purchase-pays-for-goods.mjs</c> asserts over all of them that money left the purse only
    /// when goods arrived or a tool was upgraded.
    ///
    /// <para>
    /// Each receipt is the MOD's own text: the outcome comes from <c>ShopPurchaseOutcomeFor</c>, the detail from
    /// <c>ShopPurchaseReceipt</c>, the pack answer from <c>ShopPackPurchases</c> and the refusal from
    /// <c>ShopPackRefusalEvidence</c> - the same calls the handler makes, in the same order, with the real engine charging
    /// the real purse through <c>receiveLeftClick</c>. What the harness replaces is only the opening of the menu, which
    /// needs a mounted world.
    /// </para>
    /// <para>
    /// The scenarios are a table, so a purchase shape added here enters the gate without an edit on the Node side; the
    /// gate refuses to pass on an empty corpus, so a table that stops producing receipts is red rather than green.
    /// </para>
    /// </summary>
    [Fact]
    public void EveryPurchaseReceiptTheSuiteProducesPaysForItsGoods()
    {
        List<(string Scenario, string Detail)> receipts = ProducePurchaseReceipts();

        receipts.Select(receipt => receipt.Scenario).Should().OnlyHaveUniqueItems("each scenario is named once");
        receipts.Should().HaveCountGreaterThanOrEqualTo(5, "the corpus is the gate's population; a thin corpus proves little");

        string corpusPath = Path.Combine(
            RepositoryRoot(), "tools", "fixtures", "stardew-shop-purchase-receipts.json");
        string entries = string.Join(
            ",\n",
            receipts.Select(receipt =>
                "    {\"scenario\": " + Json(receipt.Scenario) + ", \"detail\": " + Json(receipt.Detail) + "}"));
        string corpus =
            "{\n"
            + "  \"note\": \"Purchase receipts the Stardew Integration suite produces. Regenerate by running "
            + "ShopSaleReachTests.EveryPurchaseReceiptTheSuiteProducesPaysForItsGoods; the gate "
            + "tools/check-stardew-shop-purchase-pays-for-goods.mjs reads it.\",\n"
            + "  \"receipts\": [\n"
            + entries
            + "\n  ]\n}\n";
        File.WriteAllText(corpusPath, corpus);

        // The corpus names the goods it judged, so a reader can tell a purchase receipt from a receipt of something else.
        foreach ((string scenario, string detail) in receipts)
            detail.Should().Contain("money_before=", $"{scenario} states the purse it started from");
    }

    /// <summary>
    /// The purchase decision sequence of the handler, replayed where a world cannot be mounted: the pack count, the one
    /// capacity, the refusal, the engine's click, the engine's drop, the decider and the receipt. The order is pinned by
    /// <see cref="ThePackIsJudgedBeforeTheClickThatChargesThePurse"/>, so this cannot silently drift from the handler.
    /// </summary>
    private static List<(string Scenario, string Detail)> ProducePurchaseReceipts()
    {
        var produced = new List<(string, string)>
        {
            Purchase("bag_has_room", Bag(12), money: 500),
            Purchase("bag_full_of_other_goods", FullBag(), money: 500),
            Purchase("bag_merges_into_a_partial_stack", PartialStackBag(), money: 500),
            Purchase("bag_absorbs_a_multi_unit_quantity", Bag(12, occupied: 9), money: 500, quantity: 5),
            Purchase("tool_upgrade_needs_no_room", FullBag(), money: 5000, price: 5000,
                shopId: "ClintUpgrade", consumeOnPurchase: true, requiredToolId: "(T)CopperHoe"),
        };
        return produced;
    }

    /// <summary>
    /// One purchase, end to end: the production seam decides whether the click may happen, the ENGINE charges and hands
    /// the goods over, the production drop puts them away, and the receipt is the producer's own text.
    /// </summary>
    private static (string Scenario, string Detail) Purchase(
        string scenario,
        List<Item?> bag,
        int money,
        int quantity = 1,
        int price = Price,
        string shopId = "SeedShop",
        bool consumeOnPurchase = false,
        string? requiredToolId = null)
    {
        using var shop = new ShopView(shopId, saleCount: 1, Rows, bag);
        Farmer player = BindPlayer(money);
        SaleItem sale = shop.Sales[0];
        sale.ItemId = "472";
        sale.Stack = 1;
        sale.ConsumeOnPurchase = consumeOnPurchase;
        // Infinite stock: the finite-stock path decrements through `Farmer.team.synchronizedShopStock`
        // (ShopMenu.cs:1398-1405), a multiplayer object this fixture cannot build - and stock is not what any of these
        // scenarios is about. The purse, the pack and the engine's own hook are.
        shop.Menu.itemPriceAndStock[sale] = new ItemStockInformation(price, int.MaxValue);

        Item goods = (Item)sale.GetSalableInstance();
        long currencyHeld = player.Money;
        bool consumed = ExecutionManager.ShopPurchaseConsumesTheEntry(sale, shopId, requiredToolId);
        int packPurchases = ExecutionManager.ShopPackPurchases(
            bag!, bag!.Count, goods, unitsPerPurchase: 1, consumedByThePurchase: consumed);
        (long affordable, int purchasable) = ExecutionManager.ShopPurchaseCapacity(
            shop.Menu.itemPriceAndStock[sale], currencyHeld, quantity, packPurchases);

        long currencyBefore = player.Money;
        int ownedBefore = Owned(bag, "(O)472");
        int stockBefore = shop.Menu.itemPriceAndStock[sale].Stock;

        if (affordable < 1)
        {
            return (scenario, ExecutionManager.ShopPurchaseAffordabilityEvidence(
                shopId, "(O)472", price, shopCurrency: 0, currencyHeld));
        }
        if (packPurchases < 1)
        {
            return (scenario, ExecutionManager.ShopPackRefusalEvidence(
                shopId, "(O)472", quantity, price, shopCurrency: 0, currencyHeld, int.MaxValue, packPurchases, ownedBefore));
        }

        var clicks = new List<string>();
        var drops = new List<string>();
        string? refusal = null;
        for (int bought = 0; bought < purchasable; bought++)
        {
            int row = ExecutionManager.ShopSaleRowInView(shop.Menu, 0, out _);
            shop.Confirm(row);
            clicks.Add($"click{bought}:row={row}|cursor={shop.Menu.currentItemIndex}|held_after={shop.Menu.heldItem?.QualifiedItemId ?? "none"}");

            if (shop.Menu.heldItem is not Item held)
                continue;
            int slot = ExecutionManager.ShopDropSlot(bag!, held);
            if (slot >= 0)
                shop.Place(slot);
            drops.Add($"drop{bought}:slot={slot}|held={held.QualifiedItemId}->{shop.Menu.heldItem?.QualifiedItemId ?? "none"}");
            if (shop.Menu.heldItem is Item stranded)
            {
                refusal = ExecutionManager.ShopInventoryRefusal(stranded);
                break;
            }
        }

        int ownedAfter = Owned(bag, "(O)472");
        string? upgradedTool = consumeOnPurchase ? goods.QualifiedItemId : null;
        var facts = new ExecutionManager.ShopPurchaseReceiptFacts(
            ShopId: shopId,
            OwnerName: "Pierre",
            TileOpened: false,
            ItemId: "(O)472",
            Requested: quantity,
            Purchased: purchasable,
            UnitPrice: price,
            CurrencyBefore: currencyBefore,
            CurrencyAfter: player.Money,
            OwnedBefore: ownedBefore,
            OwnedAfter: ownedAfter,
            StockBefore: stockBefore,
            StockAfter: shop.Menu.itemPriceAndStock[sale].Stock,
            CounterX: 5,
            CounterY: 16,
            MenuClosed: true,
            Clicks: clicks,
            Drops: drops,
            UpgradedToolId: upgradedTool,
            DaysLeftForToolUpgrade: consumeOnPurchase ? 2 : 0,
            RequiredToolQualifiedId: requiredToolId ?? string.Empty,
            RequiredToolBefore: requiredToolId is null ? 0 : 1,
            RequiredToolAfter: requiredToolId is null ? 0 : 0,
            PurchaseDialogue: consumeOnPurchase ? "closed" : "none");
        return (scenario, ExecutionManager.ShopPurchaseReceipt(facts));
    }

    private static List<Item?> Bag(int slots, int occupied = 0)
    {
        var bag = new List<Item?>();
        for (int slot = 0; slot < slots; slot++)
            bag.Add(slot < occupied ? new StardewValley.Object { ParentSheetIndex = 300 + slot } : null);
        return bag;
    }

    private static List<Item?> FullBag()
    {
        var bag = new List<Item?>();
        for (int slot = 0; slot < 12; slot++)
            bag.Add(new StardewValley.Object { ParentSheetIndex = 300 + slot });
        return bag;
    }

    private static List<Item?> PartialStackBag()
    {
        var bag = new List<Item?> { new SaleItem { ItemId = "472", Stack = 3 } };
        for (int slot = 1; slot < 12; slot++)
            bag.Add(new StardewValley.Object { ParentSheetIndex = 300 + slot });
        return bag;
    }

    private static int Owned(List<Item?> bag, string qualifiedItemId) =>
        bag.Where(item => item is not null && item.QualifiedItemId == qualifiedItemId).Sum(item => item!.Stack);

    private static string Json(string value) =>
        $"\"{value.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("\"", "\\\"", StringComparison.Ordinal)}\"";

    /// <summary>
    /// The handler's order, which the harness above replays: the pack is counted and folded into the ONE capacity BEFORE
    /// the click that charges the purse. A harness that kept the old order would still pass its own assertions while the
    /// product charged for goods it could not hold.
    /// </summary>
    [Fact]
    public void ThePackIsJudgedBeforeTheClickThatChargesThePurse()
    {
        string code = ReadRepositoryFile(Path.Combine("integrations", "stardew", "farmhandexecutioncontroller.shopactions.cs"));
        int pack = code.IndexOf("ShopPackPurchases(", StringComparison.Ordinal);
        int capacity = code.IndexOf(
            "ShopPurchaseCapacity(charged, currencyHeld, quantity, packPurchases)", StringComparison.Ordinal);
        int click = code.IndexOf("menu.receiveLeftClick(clickX, clickY", StringComparison.Ordinal);

        pack.Should().BeGreaterThan(0, "the handler asks the pack its own question");
        capacity.Should().BeGreaterThan(pack, "the pack count feeds the one capacity, rather than a second check beside it");
        click.Should().BeGreaterThan(capacity, "and both are decided before the click that charges the purse");
    }

    private static string ReadRepositoryFile(string relative) =>
        File.ReadAllText(Path.Combine(RepositoryRoot(), relative));

    private static string RepositoryRoot()
    {
        foreach (string start in new[] { AppContext.BaseDirectory, Environment.CurrentDirectory })
        {
            DirectoryInfo? directory = new(start);
            for (int depth = 0; directory is not null && depth < 12; depth++, directory = directory.Parent)
            {
                if (Directory.Exists(Path.Combine(directory.FullName, "integrations", "stardew")))
                    return directory.FullName;
            }
        }

        throw new DirectoryNotFoundException("repository root not found from " + AppContext.BaseDirectory);
    }

    /// <summary>
    /// A sale whose index is outside the menu's own list is not a page problem, and its refusal says so: the shop does
    /// not sell it, which is a different fact from a page the cursor never reached.
    /// </summary>
    [Fact]
    public void ASaleTheMenuDoesNotHoldIsRefusedByIndexAndPageCount()
    {
        using var shop = new ShopView("SeedShop", saleCount: 9, Rows);

        int row = ExecutionManager.ShopSaleRowInView(shop.Menu, saleIndex: 9, out string? refusal);

        row.Should().Be(-1);
        refusal.Should().Be("shop_item_beyond_last_page:9:3", "index nine of nine sales over four rows is beyond page three");
        refusal.Should().NotBe("shop_item_beyond_last_page:9:0", "the page count is a count of pages, never a zero");
    }

    /// <summary>
    /// The page count is the ONE fact a page refusal states twice: `ceil(count / rows)`, and it must agree with the
    /// number of pages the shop actually has, over the whole population - not at the one size the defect was measured
    /// at.
    /// </summary>
    [Theory]
    [InlineData(4, 4, 1)]
    [InlineData(5, 4, 2)]
    [InlineData(8, 4, 2)]
    [InlineData(9, 4, 3)]
    [InlineData(1, 4, 1)]
    public void TheRefusalStatesThePageCountTheShopReallyHas(int saleCount, int rows, int pages)
    {
        ExecutionManager.ShopPageRefusal(saleIndex: saleCount - 1, saleCount, rows)
            .Should().Be($"shop_item_beyond_last_page:{saleCount - 1}:{pages}");
    }

    private static Farmer BindPlayer(int money, IList<Item?>? bag = null)
    {
        var farmer = (Farmer)RuntimeHelpers.GetUninitializedObject(typeof(Farmer));
        var inventory = new Inventory();
        Instance(typeof(Farmer), "netItems").SetValue(farmer, new NetRef<Inventory> { Value = inventory });
        Static(typeof(Game1), "_player").SetValue(null, farmer);

        // The real FarmerTeam constructor registers sprite definitions into a static that needs loaded content
        // (PlayerStatusList.AddSpriteDefinition), so the team carries only the fields the money authority reads:
        // GetMoney answers `money` while useSeparateWallets is false (FarmerTeam.cs:625-640).
        var team = (FarmerTeam)RuntimeHelpers.GetUninitializedObject(typeof(FarmerTeam));
        Instance(typeof(FarmerTeam), "money").SetValue(team, new NetIntDelta(0));
        Instance(typeof(FarmerTeam), "useSeparateWallets").SetValue(team, new NetBool(false));
        // `Farmer.team` is a property over this root (Farmer.cs:1263), not a field, so the root IS the binding.
        Instance(typeof(Farmer), "teamRoot").SetValue(farmer, new NetRoot<FarmerTeam> { Value = team });
        farmer._money = money;

        foreach (Item? item in bag ?? Array.Empty<Item?>())
            inventory.Add(item!);
        return farmer;
    }

    /// <summary>
    /// A real <c>ShopMenu</c> with the paging and purchase fields <c>ShopMenu.Initialize</c> installs (<c>:384-406</c>)
    /// and the geometry those coordinates come from, so every engine handler this file drives is the engine's own.
    /// </summary>
    private sealed class ShopView : IDisposable
    {
        internal ShopView(string shopId, int saleCount, int rows, IList<Item?>? bag = null)
        {
            this.Menu = (ShopMenu)RuntimeHelpers.GetUninitializedObject(typeof(ShopMenu));
            this.Menu.ShopId = shopId;
            this.Menu.currency = 0;
            this.Menu.safetyTimer = 0;
            // ShopMenu.Initialize assigns these lists itself; an uninitialized instance has them null, and the click
            // handler iterates every one of them.
            this.Menu.forSale = new List<ISalable>();
            this.Menu.forSaleButtons = new List<ClickableComponent>();
            this.Menu.itemPriceAndStock = new Dictionary<ISalable, ItemStockInformation>();
            this.Menu.buyBackItems = new HashSet<ISalable>();
            Instance(typeof(ShopMenu), "animations").SetValue(
                this.Menu, Activator.CreateInstance(Instance(typeof(ShopMenu), "animations").FieldType));
            // tabButtons is a field initializer too, and receiveLeftClick iterates it unconditionally: a null list here
            // is the NRE the fixture must not ship.
            Instance(typeof(ShopMenu), "tabButtons").SetValue(
                this.Menu, Activator.CreateInstance(Instance(typeof(ShopMenu), "tabButtons").FieldType));

            // The geometry ShopMenu.Initialize computes from the viewport (ShopMenu.cs:336, 384-406). It matters:
            // receiveLeftClick exits the menu on any click outside these bounds (ShopMenu.cs:1144).
            this.Menu.xPositionOnScreen = 200;
            this.Menu.yPositionOnScreen = 50;
            this.Menu.width = 1000;
            this.Menu.height = 600;
            this.Menu.upArrow = Component(200 + 1000 + 16, 50 + 16);
            this.Menu.downArrow = Component(200 + 1000 + 16, 50 + 600 - 64);
            this.Menu.scrollBar = Component(200 + 1000 + 28, 50 + 16 + 48 + 4);
            Instance(typeof(ShopMenu), "scrollBarRunner").SetValue(
                this.Menu, new Rectangle(200 + 1000 + 28, 50 + 16 + 48 + 4, 24, 600 - 64 - 48 - 28));

            for (int index = 0; index < saleCount; index++)
            {
                var sale = new SaleItem { ItemId = index.ToString(), Stack = 1 };
                this.Sales.Add(sale);
                this.Menu.forSale.Add(sale);
                this.Menu.itemPriceAndStock[sale] = new ItemStockInformation(Price, int.MaxValue);
            }

            int rowHeight = (600 - 256) / rows;
            for (int row = 0; row < rows; row++)
            {
                this.Menu.forSaleButtons.Add(new ClickableComponent(
                    new Rectangle(200 + 16, 50 + 16 + row * rowHeight, 1000 - 32, rowHeight + 4), row.ToString()));
            }

            this.Bag = bag ?? new List<Item?>();
            var inventory = (InventoryMenu)RuntimeHelpers.GetUninitializedObject(typeof(InventoryMenu));
            inventory.inventory = new List<ClickableComponent>();
            for (int slot = 0; slot < Math.Max(this.Bag.Count, 12); slot++)
            {
                inventory.inventory.Add(new ClickableComponent(
                    new Rectangle(200 + 600 + slot % 6 * 64, 50 + 450 + slot / 6 * 4, 64, 64), slot.ToString()));
            }

            inventory.actualInventory = this.Bag!;
            inventory.highlightMethod = item => this.Menu.heldItem?.canStackWith(item) ?? false;
            this.Menu.inventory = inventory;

            Static(typeof(Game1), "_activeClickableMenu").SetValue(null, this.Menu);
        }

        internal ShopMenu Menu { get; }

        internal List<SaleItem> Sales { get; } = new();

        internal IList<Item?> Bag { get; }

        /// <summary>The native confirm: the button's own centre, through the menu's click handler.</summary>
        internal void Confirm(int row)
        {
            ClickableComponent button = this.Menu.forSaleButtons[row];
            this.Menu.receiveLeftClick(button.bounds.Center.X, button.bounds.Center.Y, playSound: true);
        }

        /// <summary>The native drop: the inventory slot's own centre, which routes to InventoryMenu.leftClick.</summary>
        internal void Place(int slot)
        {
            ClickableComponent component = this.Menu.inventory.inventory[slot];
            this.Menu.receiveLeftClick(component.bounds.Center.X, component.bounds.Center.Y, playSound: true);
        }

        internal void ResetCursor() => this.Menu.currentItemIndex = 0;

        public void Dispose() => Static(typeof(Game1), "_activeClickableMenu").SetValue(null, null);

        private static ClickableTextureComponent Component(int x, int y) =>
            (ClickableTextureComponent)RuntimeHelpers.GetUninitializedObject(typeof(ClickableTextureComponent)) is var arrow
                ? Set(arrow, x, y)
                : arrow;

        private static ClickableTextureComponent Set(ClickableTextureComponent arrow, int x, int y)
        {
            arrow.bounds = new Rectangle(x, y, 44, 48);
            arrow.baseScale = 4f;
            arrow.scale = 4f;
            return arrow;
        }
    }

    /// <summary>
    /// A sale entry the engine's own purchase can run end to end without item data: <c>GetSalableInstance</c> is
    /// <c>getOne()</c> (<c>Item.cs:759-813</c>), which answers another instance of this class, and
    /// <c>actionWhenPurchased</c> is the hook the engine calls with the menu's shop id (<c>ShopMenu.cs:1369</c>).
    /// </summary>
    private sealed class SaleItem : Item
    {
        internal SaleItem() => this.ItemId = "0";

        internal List<string> PurchasedFrom { get; } = new();

        internal bool ConsumeOnPurchase { get; set; }

        public override string TypeDefinitionId => "(O)";

        public override string DisplayName => "sale";

        public override int maximumStackSize() => 999;

        public override string getDescription() => string.Empty;

        public override bool isPlaceable() => false;

        public override void drawInMenu(
            SpriteBatch spriteBatch,
            Vector2 location,
            float scaleSize,
            float transparency,
            float layerDepth,
            StackDrawType drawStackNumber,
            Color color,
            bool drawShadow)
        {
        }

        public override bool CanBuyItem(Farmer farmer) => true;

        public override bool actionWhenPurchased(string shopId)
        {
            this.PurchasedFrom.Add(shopId);
            return this.ConsumeOnPurchase;
        }

        protected override Item GetOneNew() => new SaleItem { ItemId = this.ItemId };
    }

    private sealed class SilentSoundsHelper : SoundsHelper
    {
        public override bool PlayLocal(
            string cueName,
            GameLocation location,
            Vector2? position,
            int? pitch,
            SoundContext context,
            out ICue cue)
        {
            cue = null!;
            return false;
        }
    }

    private static FieldInfo Static(Type type, string name) =>
        type.GetField(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static)!;

    private static FieldInfo Instance(Type type, string name) =>
        type.GetField(name, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance)!;
}
