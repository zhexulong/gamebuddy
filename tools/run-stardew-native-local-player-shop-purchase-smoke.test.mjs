import assert from "node:assert/strict";
import test from "node:test";
import {
  assertShopPurchasePostconditions,
  assertToolUpgradePostconditions,
  clickRows,
  runShopPurchaseSmoke,
} from "./run-stardew-native-local-player-shop-purchase-smoke.mjs";
import { publishedActionRegistrations } from "./lib/stardew-native-smoke-harness-v1.mjs";

const SCENARIO = "native_shop_purchase_v1";
const CAPABILITIES = ["cancel_active_execution", "inspect_self", "shop_purchase"];

const config = {
  SaveId: "save",
  WorldId: "world",
  PlayerId: "player",
  CompanionId: "companion",
  PipeName: "pipe",
  BridgeToken: "token",
  DeniedActions: [],
  DeniedActionFamilies: [],
  ExperimentalActions: [],
  NativeLocalPlayerFixture: { Enable: true, Bootstrap: { Enable: false }, FixtureScenario: SCENARIO },
};

const SHOP = {
  targetId: "shop_1a2b3c4d5e6f7a8b",
  shopId: "SeedShop",
  ownerName: "Pierre",
  location: "SeedShop",
  ownerTileX: 5,
  ownerTileY: 16,
  ownerInReach: true,
  stockCount: 6,
  // What the shop can sell right now. The Mod sends this, and the runner picks its target
  // from it rather than guessing an item id. SIX entries because the case buys the FIFTH:
  // a shop with four or fewer sales has nothing the menu's pager is needed for.
  stockItemIds: ["(O)472", "(O)473", "(O)474", "(O)475", "(O)476", "(O)477"],
};

/**
 * What the Mod actually emits. The two clauses this runner exists for are money and goods:
 * a fake that reported a purchase without moving either would let the runner pass on a
 * contract the Mod does not have.
 *
 * `clicks` is the Mod's own click diagnostic, in its own spelling (`||` between entries, `|` between parts): the sale
 * this case buys sits at index four, so a genuine purchase from it was made with the menu's cursor at 1 and clicked the
 * fourth row - `cursor + row = 4`, which is what `assertPagerSaleWasReached` reads.
 */
function purchaseEvidence({
  moneyBefore = 5000,
  moneyAfter = 4980,
  purchased = 1,
  unitPrice = 20,
  ownedBefore = 0,
  ownedAfter = 1,
  item = "(O)476",
  clicks = "1[click0:row=3|cursor=1|at=100,200|held_after=(O)476]",
} = {}) {
  return (
    `shop=SeedShop;owner=Pierre;item=${item};requested=1;purchased=${purchased};unit_price=${unitPrice};` +
    `money_before=${moneyBefore};money_after=${moneyAfter};` +
    `owned_before=${ownedBefore};owned_after=${ownedAfter};gained=${ownedAfter - ownedBefore};` +
    `stock_before=12;stock_after=${12 - purchased};owner_tile=5,16;menu_closed=true;` +
    `clicks=${clicks};drops=1[drop0:slot=0|held=${item}->none]`
  );
}

function snapshot(revision, location, shops = [SHOP]) {
  return {
    revision,
    location,
    tile: { x: 6, y: 16 },
    actionable: true,
    activeExecution: null,
    capabilities: [...CAPABILITIES],
    shopTargets: shops,
  };
}

function makeClient({ evidence = purchaseEvidence(), shops = [SHOP], menuClosed = true } = {}) {
  let current = snapshot(3, "SeedShop", shops);
  const client = {
    state: { catalogRegistrations: publishedActionRegistrations(), snapshot: current },
    observe: async () => current,
    execute: async (request) => {
      assert.equal(request.action, "shop_purchase");
      assert.equal(request.args.expectedTargetId, SHOP.targetId);
      assert.equal(
        request.args.expectedQualifiedItemId,
        SHOP.stockItemIds[4],
        "the case buys the FIFTH sale, which the menu's pager has to reach",
      );
      const receipt = {
        requestId: request.requestId,
        executionId: "exec_shop_purchase",
        state: "succeeded",
        reasonCode: "item_purchased",
        revision: 4,
        evidence: { detail: evidence },
      };
      current = {
        ...snapshot(4, "SeedShop", shops),
        // The runner re-reads after the terminal; the menu-closed clause is asserted from
        // the RECEIPT (that is where the Mod reports it), so this only moves the revision.
        menuOpen: !menuClosed,
      };
      return receipt;
    },
  };
  return { client };
}

test("passes when the purse paid and the goods arrived", async () => {
  const { client } = makeClient();
  const result = await runShopPurchaseSmoke(client, config, { timeoutMs: 500 });

  assert.equal(result.state, "passed");
  assert.equal(result.reasonCode, "item_purchased");
  assert.equal(result.shopId, "SeedShop");
  assert.equal(result.owner, "Pierre");
  assert.equal(result.purchased, 1);
  assert.equal(result.unitPrice, 20);
  assert.equal(result.moneyBefore - result.moneyAfter, 20);
  assert.equal(result.ownedAfter - result.ownedBefore, 1);
  assert.equal(result.menuClosed, true);
  // The case buys the FIFTH sale, so the receipt it earns is one the menu's pager had to reach.
  assert.equal(result.item, "(O)476");
  assert.deepEqual(result.pager, { row: 3, cursor: 1 });
  assert.equal(result.pager.cursor + result.pager.row, 4, "the clicked sale is the fifth: cursor + row");
});

test("blocks when the receipt shows the menu's pager never moved", async () => {
  // The shape this runner used to accept: `stockItemIds[0]`, a first-page sale, `cursor=0`. It proves the purchase and
  // nothing about reaching a sale the menu only shows after scrolling - which is the half that was broken live.
  const { client } = makeClient({
    evidence: purchaseEvidence({ clicks: "1[click0:row=0|cursor=0|held_after=(O)476]" }),
  });
  const result = await runShopPurchaseSmoke(client, config, { timeoutMs: 500 });

  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /shop_pager_not_exercised:row=0;cursor=0/);
});

test("blocks when the shop cannot advertise the fifth sale", async () => {
  // Four or fewer sales: nothing to scroll to, so the case cannot be demonstrated and must say so rather than quietly
  // buying the first page and reporting a pass.
  const short = [{ ...SHOP, stockCount: 2, stockItemIds: ["(O)472", "(O)473"] }];
  const { client } = makeClient({ shops: short });
  const result = await runShopPurchaseSmoke(client, config, { timeoutMs: 500 });

  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /shop_pager_sale_not_advertised:stock=2;need_at_least=5/);
});

test("the click diagnostic is read as the Mod writes it", () => {
  // The Mod FOLDS the trace to `<count>[<last entry>]`: one entry per unit bought grew the detail with the quantity,
  // and a 36-unit purchase overflowed the receipt bound. The fold is `ShopPurchaseTraceField` in
  // farmhandexecutioncontroller.shoppurchasereceipt.cs, and the kept entry keeps its real ordinal - `click35` beside
  // `clicks=36` names the thirty-five that were folded away.
  const clicks = clickRows({ clicks: "36[click35:row=3|cursor=1|at=100,200|held_after=(O)476]" });

  assert.deepEqual(clicks, [{ row: 3, cursor: 1 }]);
  assert.deepEqual(clickRows({}), [], "a receipt with no click field records no click");
  assert.deepEqual(clickRows({ clicks: "0[]" }), [], "and a count of zero is no click either");
});

test("blocks when the purse was never charged", async () => {
  // The receipt claims a purchase but money is untouched: that is not a purchase.
  const { client } = makeClient({ evidence: purchaseEvidence({ moneyAfter: 5000 }) });
  const result = await runShopPurchaseSmoke(client, config, { timeoutMs: 500 });

  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /shop_purse_not_charged/);
});

test("blocks when the goods never arrived", async () => {
  const { client } = makeClient({ evidence: purchaseEvidence({ ownedAfter: 0, purchased: 1 }) });
  const result = await runShopPurchaseSmoke(client, config, { timeoutMs: 500 });

  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /shop_goods_not_received|shop_gained_mismatch/);
});

test("blocks when the price does not match what was charged", async () => {
  // paid 40 for one unit priced at 20 -> the arithmetic must not be accepted.
  const { client } = makeClient({ evidence: purchaseEvidence({ moneyAfter: 4960, ownedAfter: 2, purchased: 1 }) });
  const result = await runShopPurchaseSmoke(client, config, { timeoutMs: 500 });

  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /shop_purse_not_charged|shop_goods_not_received/);
});

test("blocks when the menu was left open", async () => {
  const { client } = makeClient({ evidence: purchaseEvidence().replace("menu_closed=true", "menu_closed=false") });
  const result = await runShopPurchaseSmoke(client, config, { timeoutMs: 500 });

  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /shop_menu_left_open/);
});

test("blocks when no shop is advertised at all", async () => {
  const client = {
    state: { catalogRegistrations: publishedActionRegistrations(), snapshot: snapshot(3, "FarmHouse", []) },
    observe: async () => snapshot(3, "FarmHouse", []),
    execute: async () => {
      throw new Error("must not execute without an advertised shop");
    },
  };
  const result = await runShopPurchaseSmoke(client, config, { timeoutMs: 500 });

  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /shop_no_targets_advertised/);
});

test("blocks when the owner is advertised but out of reach", async () => {
  // This is the scope boundary: the action does not walk. The runner must report the
  // refusal rather than reaching for the shop anyway.
  const far = [{ ...SHOP, ownerInReach: false, ownerTileX: 20, ownerTileY: 1 }];
  const client = {
    state: { catalogRegistrations: publishedActionRegistrations(), snapshot: snapshot(3, "SeedShop", far) },
    observe: async () => snapshot(3, "SeedShop", far),
    execute: async () => {
      throw new Error("must not execute while the owner is out of reach");
    },
  };
  const result = await runShopPurchaseSmoke(client, config, { timeoutMs: 500 });

  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /shop_owner_out_of_reach/);
});

test("blocks when the terminal is not the native purchase", async () => {
  const { client } = makeClient();
  const target = client.execute;
  client.execute = async (request) => ({ ...(await target(request)), reasonCode: "purchase_partial" });
  const result = await runShopPurchaseSmoke(client, config, { timeoutMs: 500 });

  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /shop_terminal_mismatch/);
});

test("refuses a config that is not this scenario or is not topology-isolated", async () => {
  const { client } = makeClient();

  const wrong = await runShopPurchaseSmoke(client, {
    ...config,
    NativeLocalPlayerFixture: { ...config.NativeLocalPlayerFixture, FixtureScenario: "native_ride_bus_v1" },
  });
  assert.equal(wrong.state, "blocked");
  assert.match(wrong.reasonCode, /native_local_fixture_scenario_mismatch/);

  const notIsolated = await runShopPurchaseSmoke(client, { ...config, Portfolio: { Enable: true } });
  assert.equal(notIsolated.state, "blocked");
  assert.match(notIsolated.reasonCode, /native_local_fixture_topology_not_isolated/);
});

test("the pass contract rejects each clause it claims", () => {
  const detail = {
    reasonCode: "item_purchased",
    shopId: "SeedShop",
    owner: "Pierre",
    item: "(O)472",
    quantity: 1,
    purchased: 2,
    unitPrice: 20,
    moneyBefore: 5000,
    moneyAfter: 4960,
    ownedBefore: 0,
    ownedAfter: 2,
    gained: 2,
    ownerTile: "5,16",
    menuClosed: true,
    pager: { row: 3, cursor: 1 },
    shopTargetsBefore: "SeedShop",
    trace: [{ phase: "purchase" }],
  };
  assert.doesNotThrow(() => assertShopPurchasePostconditions({ ...detail }));

  assert.throws(() => assertShopPurchasePostconditions({ ...detail, moneyAfter: 5000 }), /shop_purse_not_charged/);
  assert.throws(() => assertShopPurchasePostconditions({ ...detail, ownedAfter: 0 }), /shop_goods_not_received/);
  assert.throws(() => assertShopPurchasePostconditions({ ...detail, gained: 1 }), /shop_gained_mismatch/);
  assert.throws(() => assertShopPurchasePostconditions({ ...detail, menuClosed: false }), /shop_menu_left_open/);
  assert.throws(() => assertShopPurchasePostconditions({ ...detail, purchased: 0 }), /shop_purchased_invalid/);
  assert.throws(() => assertShopPurchasePostconditions({ ...detail, unitPrice: 0 }), /shop_unit_price_invalid/);
  assert.throws(() => assertShopPurchasePostconditions({ ...detail, trace: [] }), /shop_trace/);
  // The pager clause, each way it can fail: a click the receipt never recorded, a cursor that never moved (the shape
  // `stockItemIds[0]` always produced, because the first sale is on the first page), and a row that adds up to a sale
  // inside the first page.
  assert.throws(() => assertShopPurchasePostconditions({ ...detail, pager: null }), /shop_pager_click_missing/);
  assert.throws(
    () => assertShopPurchasePostconditions({ ...detail, pager: { row: 0, cursor: 0 } }),
    /shop_pager_not_exercised:row=0;cursor=0/,
  );
  assert.throws(
    () => assertShopPurchasePostconditions({ ...detail, pager: { row: 1, cursor: 1 } }),
    /shop_pager_sale_not_reached:sale=2;row=1;cursor=1/,
  );
});

// ---------------------------------------------------------------------------------------------------------------
// The tool-upgrade case: the same action over the blacksmith's counter.
// ---------------------------------------------------------------------------------------------------------------

const UPGRADE_SCENARIO = "native_shop_tool_upgrade_v1";
const UPGRADE_ITEM = "(T)SteelHoe";

const upgradeConfig = {
  ...config,
  NativeLocalPlayerFixture: { ...config.NativeLocalPlayerFixture, FixtureScenario: UPGRADE_SCENARIO },
};

const UPGRADE_SHOP = {
  targetId: "shop_blacksmith_upgrade",
  shopId: "ClintUpgrade",
  ownerName: "Clint",
  location: "Blacksmith",
  ownerTileX: 9,
  ownerTileY: 5,
  ownerInReach: true,
  stockCount: 1,
  // One entry, because the fixture leaves exactly one upgradable tool in the pack.
  stockItemIds: [UPGRADE_ITEM],
};

/**
 * What the Mod emits for an engine-recorded upgrade. The four facts this case exists for are the last five fields:
 * the tool the engine put into `Farmer.toolBeingUpgraded`, the two days it is due back in, the tool the upgrade
 * consumed (and its count before/after), and the notice the purchase mounted. `gained` is 0 because the entry is
 * discarded rather than carried - which is exactly why `item_purchased` could never describe this purchase.
 */
function upgradeEvidence({
  moneyBefore = 5000,
  moneyAfter = 0,
  purchased = 1,
  unitPrice = 5000,
  toolUpgraded = UPGRADE_ITEM,
  daysLeft = 2,
  requiredTool = "(T)CopperHoe",
  requiredBefore = 1,
  requiredAfter = 0,
  purchaseDialogue = "closed",
} = {}) {
  return (
    `shop=ClintUpgrade;owner=Clint;entry=npc_owner;item=${UPGRADE_ITEM};requested=1;purchased=${purchased};` +
    `unit_price=${unitPrice};money_before=${moneyBefore};money_after=${moneyAfter};` +
    `owned_before=0;owned_after=0;gained=0;stock_before=1;stock_after=1;owner_tile=9,5;menu_closed=true;` +
    `clicks=1[click0:row=0|cursor=0];drops=0[];` +
    `tool_upgraded=${toolUpgraded};days_left=${daysLeft};required_tool=${requiredTool};` +
    `required_before=${requiredBefore};required_after=${requiredAfter};purchase_dialogue=${purchaseDialogue}`
  );
}

function makeUpgradeClient({ evidence = upgradeEvidence(), shops = [UPGRADE_SHOP], reasonCode } = {}) {
  let current = snapshot(3, "Blacksmith", shops);
  const client = {
    state: { catalogRegistrations: publishedActionRegistrations(), snapshot: current },
    observe: async () => current,
    execute: async (request) => {
      assert.equal(request.action, "shop_purchase");
      assert.equal(request.args.expectedTargetId, UPGRADE_SHOP.targetId);
      assert.equal(request.args.expectedQualifiedItemId, UPGRADE_ITEM);
      const receipt = {
        requestId: request.requestId,
        executionId: "exec_shop_tool_upgrade",
        state: "succeeded",
        reasonCode: reasonCode ?? "tool_upgrade_purchased",
        revision: 4,
        evidence: { detail: evidence },
      };
      current = { ...snapshot(4, "Blacksmith", shops), menuOpen: false };
      return receipt;
    },
  };
  return { client };
}

test("the upgrade case passes when the engine recorded the upgrade and took the tool", async () => {
  const { client } = makeUpgradeClient();
  const result = await runShopPurchaseSmoke(client, upgradeConfig, { timeoutMs: 500 });

  assert.equal(result.state, "passed");
  assert.equal(result.caseName, "clint_upgrade");
  assert.equal(result.reasonCode, "tool_upgrade_purchased");
  assert.equal(result.shopId, "ClintUpgrade");
  assert.equal(result.toolUpgraded, UPGRADE_ITEM);
  assert.equal(result.daysLeftForToolUpgrade, 2);
  assert.equal(result.requiredBefore - result.requiredAfter, 1);
  assert.equal(result.moneyBefore - result.moneyAfter, 5000);
  assert.equal(result.returnPathVerified, false, "the two-night return is deliberately not exercised");
});

test("the tally names the case this launch did not arm, and counts it", async () => {
  const { client } = makeUpgradeClient();
  const result = await runShopPurchaseSmoke(client, upgradeConfig, { timeoutMs: 500 });

  assert.equal(result.tally.cases, 2);
  assert.equal(result.tally.passed, 1);
  assert.equal(result.tally.failed, 0);
  assert.deepEqual(result.tally.unarmed, ["item_purchase:native_shop_purchase_v1"]);

  const { client: ordinaryClient } = makeClient();
  const ordinary = await runShopPurchaseSmoke(ordinaryClient, config, { timeoutMs: 500 });
  assert.deepEqual(ordinary.tally.unarmed, ["clint_upgrade:native_shop_tool_upgrade_v1"]);
});

test("a failed case still counts as failed in the tally, so the run cannot read as green", async () => {
  const { client } = makeUpgradeClient({ evidence: upgradeEvidence({ requiredAfter: 1 }) });
  const result = await runShopPurchaseSmoke(client, upgradeConfig, { timeoutMs: 500 });

  assert.equal(result.state, "blocked");
  assert.equal(result.tally.passed, 0);
  assert.equal(result.tally.failed, 1);
});

test("the upgrade reported as the OLD partial terminal is not a pass", async () => {
  // This is the shape the defect produced: a finished, paid-for upgrade came back `purchase_partial` because the
  // terminal required the goods to arrive. The runner must never accept it as proof of the upgrade.
  const { client } = makeUpgradeClient({ reasonCode: "purchase_partial" });
  const result = await runShopPurchaseSmoke(client, upgradeConfig, { timeoutMs: 500 });

  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /shop_terminal_mismatch:state=succeeded;reason=purchase_partial/);
});

test("blocks when the blacksmith's upgrade counter is not advertised", async () => {
  const { client } = makeUpgradeClient({ shops: [{ ...SHOP }] });
  const result = await runShopPurchaseSmoke(client, upgradeConfig, { timeoutMs: 500 });

  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /shop_upgrade_counter_not_advertised:location=Blacksmith/);
  assert.match(result.reasonCode, /advertised=SeedShop/, "the refusal names what IS on offer, not just what is not");
});

test("blocks when the shop offers more than the one entry the Given leaves", async () => {
  const { client } = makeUpgradeClient({
    shops: [{ ...UPGRADE_SHOP, stockCount: 4, stockItemIds: [UPGRADE_ITEM, "(T)CopperAxe"] }],
  });
  const result = await runShopPurchaseSmoke(client, upgradeConfig, { timeoutMs: 500 });

  assert.equal(result.state, "blocked");
  assert.match(result.reasonCode, /shop_upgrade_entry_ambiguous:\(T\)SteelHoe\/\(T\)CopperAxe/);
});

test("the upgrade contract rejects each of the four facts it claims", () => {
  const detail = {
    reasonCode: "tool_upgrade_purchased",
    shopId: "ClintUpgrade",
    owner: "Clint",
    item: UPGRADE_ITEM,
    targetItemId: UPGRADE_ITEM,
    purchased: 1,
    unitPrice: 5000,
    moneyBefore: 5000,
    moneyAfter: 0,
    toolUpgraded: UPGRADE_ITEM,
    daysLeftForToolUpgrade: 2,
    requiredTool: "(T)CopperHoe",
    requiredBefore: 1,
    requiredAfter: 0,
    gained: 0,
    menuClosed: true,
    purchaseDialogue: "closed",
    trace: [{ phase: "purchase" }],
  };
  assert.doesNotThrow(() => assertToolUpgradePostconditions({ ...detail }));

  // 1. the engine's own field
  assert.throws(() => assertToolUpgradePostconditions({ ...detail, toolUpgraded: null }), /shop_upgrade_tool_absent/);
  assert.throws(
    () => assertToolUpgradePostconditions({ ...detail, toolUpgraded: "(T)GoldHoe" }),
    /shop_upgrade_tool_mismatch/,
  );
  assert.throws(
    () => assertToolUpgradePostconditions({ ...detail, targetItemId: "(T)CopperAxe" }),
    /shop_upgrade_tool_not_the_entry/,
  );
  // 2. two days
  assert.throws(
    () => assertToolUpgradePostconditions({ ...detail, daysLeftForToolUpgrade: 1 }),
    /shop_upgrade_days_not_fresh/,
  );
  // 3. the consumed tool
  assert.throws(
    () => assertToolUpgradePostconditions({ ...detail, requiredTool: null }),
    /shop_upgrade_required_tool_absent/,
  );
  assert.throws(
    () => assertToolUpgradePostconditions({ ...detail, requiredTool: UPGRADE_ITEM }),
    /shop_upgrade_required_tool_is_the_entry/,
  );
  assert.throws(
    () => assertToolUpgradePostconditions({ ...detail, requiredAfter: 1 }),
    /shop_upgrade_tool_not_consumed/,
  );
  // 4. the purse
  assert.throws(() => assertToolUpgradePostconditions({ ...detail, moneyAfter: 5000 }), /shop_purse_not_charged/);
  assert.throws(() => assertToolUpgradePostconditions({ ...detail, unitPrice: 0 }), /shop_unit_price_invalid/);
  // and the body is free
  assert.throws(() => assertToolUpgradePostconditions({ ...detail, menuClosed: false }), /shop_menu_left_open/);
  assert.throws(
    () => assertToolUpgradePostconditions({ ...detail, purchaseDialogue: null }),
    /shop_upgrade_notice_not_settled/,
  );
  assert.throws(() => assertToolUpgradePostconditions({ ...detail, shopId: "SeedShop" }), /shop_upgrade_shop_mismatch/);
  assert.throws(() => assertToolUpgradePostconditions({ ...detail, trace: [] }), /shop_trace/);
});
