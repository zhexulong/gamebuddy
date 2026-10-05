import assert from "node:assert/strict";
import test from "node:test";
import {
  assertShopPurchasePostconditions,
  runShopPurchaseSmoke,
} from "./run-stardew-native-local-player-shop-purchase-smoke.mjs";

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
  closedMessage: null,
  stockCount: 12,
};

/**
 * What the Mod actually emits. The two clauses this runner exists for are money and goods:
 * a fake that reported a purchase without moving either would let the runner pass on a
 * contract the Mod does not have.
 */
function purchaseEvidence({ moneyBefore = 5000, moneyAfter = 4980, purchased = 1, unitPrice = 20, ownedBefore = 0, ownedAfter = 1 } = {}) {
  return (
    `shop=SeedShop;owner=Pierre;item=(O)472;requested=1;purchased=${purchased};unit_price=${unitPrice};` +
    `money_before=${moneyBefore};money_after=${moneyAfter};` +
    `owned_before=${ownedBefore};owned_after=${ownedAfter};gained=${ownedAfter - ownedBefore};` +
    `stock_before=12;stock_after=${12 - purchased};owner_tile=5,16;menu_closed=true`
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
    state: { snapshot: current },
    observe: async () => current,
    execute: async (request) => {
      assert.equal(request.action, "shop_purchase");
      assert.equal(request.args.expectedTargetId, SHOP.targetId);
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
    state: { snapshot: snapshot(3, "FarmHouse", []) },
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
    state: { snapshot: snapshot(3, "SeedShop", far) },
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
    shopTargetsBefore: "SeedShop",
    trace: [{ phase: "purchase" }],
  };
  assert.doesNotThrow(() => assertShopPurchasePostconditions({ ...detail }));

  assert.throws(
    () => assertShopPurchasePostconditions({ ...detail, moneyAfter: 5000 }),
    /shop_purse_not_charged/,
  );
  assert.throws(
    () => assertShopPurchasePostconditions({ ...detail, ownedAfter: 0 }),
    /shop_goods_not_received/,
  );
  assert.throws(
    () => assertShopPurchasePostconditions({ ...detail, gained: 1 }),
    /shop_gained_mismatch/,
  );
  assert.throws(
    () => assertShopPurchasePostconditions({ ...detail, menuClosed: false }),
    /shop_menu_left_open/,
  );
  assert.throws(
    () => assertShopPurchasePostconditions({ ...detail, purchased: 0 }),
    /shop_purchased_invalid/,
  );
  assert.throws(
    () => assertShopPurchasePostconditions({ ...detail, unitPrice: 0 }),
    /shop_unit_price_invalid/,
  );
  assert.throws(() => assertShopPurchasePostconditions({ ...detail, trace: [] }), /shop_trace/);
});
