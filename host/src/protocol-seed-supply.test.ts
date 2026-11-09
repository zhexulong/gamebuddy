/**
 * The `seedSupplyTargets` wire contract, both ways.
 *
 * WHY THIS EXISTS. A null key cost a live run once already: a nullable C# member serialised as
 * `"daysToHarvest": null` and the Host refused the WHOLE snapshot (`invalid_snapshot:cropTargets`). The family added
 * here has six nullable members, and the Mod's serializer omits them (`BridgeProtocol.JsonOptions`:
 * `WhenWritingNull`), so the contract that matters is the one this file pins:
 *
 *   - every shape the Mod actually publishes is ADMITTED, including the three answers for "is the shop open" -
 *     `true`, `false`, and ABSENT with a reason;
 *   - a null is REFUSED by name, because `openNow: null` is the exact shape that took a run down;
 *   - the shop half is all-or-nothing: a price with no shop, or a shop with no price, is refused, so a reader can
 *     never see a number it cannot walk to.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { diagnoseBridgeMessage, validateBridgeMessage, type Scope } from "./protocol.js";

const scope: Scope = {
  integrationId: "integration",
  saveId: "save",
  worldId: "world",
  playerId: "player",
  companionId: "companion",
};

/** A snapshot with nothing in it but the family under test: the smallest frame the bridge can carry. */
function snapshotWith(seedSupplyTargets: unknown, extra: Record<string, unknown> = {}): unknown {
  return {
    protocolVersion: 1,
    messageId: "6f1c5e5c-0000-4000-8000-000000000000",
    correlationId: "6f1c5e5c-0000-4000-8000-000000000001",
    timestampMs: Date.now(),
    scope,
    type: "snapshot",
    payload: {
      revision: 1,
      location: "Farm",
      tile: { x: 1, y: 1 },
      stamina: 100,
      exhausted: false,
      health: 100,
      currentTool: null,
      inventorySlots: 12,
      actionable: true,
      capabilities: [],
      catalogRevision: 1,
      enabledActionIds: [],
      activeExecution: null,
      timeOfDay: 600,
      dayOfMonth: 1,
      seasonIndex: 0,
      year: 1,
      weather: "sunny",
      presentationLocale: "zh",
      seedSupplyTargets,
      ...extra,
    },
  };
}

const seed = (row: Record<string, unknown>): unknown => snapshotWith([row]);

test("the Host admits every shape the Mod publishes for a seed supply row", () => {
  const published = {
    // A seed no shop stocks: the seed and its count, and no shop half at all.
    noKnownSource: { qualifiedItemId: "(O)745", displayName: "Strawberry Seeds", heldCount: 1 },
    // The ordinary row: a shop, what the menu charges, the row's declared number, the owner's own window, open now.
    open: {
      qualifiedItemId: "(O)472",
      displayName: "Parsnip Seeds",
      heldCount: 2,
      shopId: "SeedShop",
      shopDisplayName: "Pierre's General Store",
      ownerName: "Pierre",
      hoursCondition: "TIME 900 2100",
      price: 20,
      declaredPrice: 20,
      currency: 0,
      openNow: true,
    },
    // The same shop at 02:00: the answer is false and the window still travels, so "closed" is explainable.
    closed: {
      qualifiedItemId: "(O)472",
      displayName: "Parsnip Seeds",
      heldCount: 2,
      shopId: "SeedShop",
      ownerName: "Pierre",
      hoursCondition: "TIME 900 2100",
      price: 20,
      currency: 0,
      openNow: false,
    },
    // The question could not be asked: `openNow` is ABSENT and the reason is named. This must not read as closed.
    unanswerable: {
      qualifiedItemId: "(O)472",
      displayName: "Parsnip Seeds",
      shopId: "SeedShop",
      price: 20,
      currency: 0,
      openNowReason: "owner_condition_unreadable",
    },
    // The count was not measured: `heldCount` is absent, never 0.
    uncounted: { qualifiedItemId: "(O)472", displayName: "Parsnip Seeds", shopId: "SeedShop", price: 20, currency: 0 },
  };
  for (const [label, row] of Object.entries(published)) {
    assert.equal(validateBridgeMessage(seed(row), scope), null, `${label} must be admitted`);
    assert.equal(diagnoseBridgeMessage(seed(row), scope), "accepted", `${label} must be admitted`);
  }
  // A measured empty family is a legal answer ("she holds no plantable seed"), and so is a cap count beside it.
  assert.equal(validateBridgeMessage(snapshotWith([], { seedSupplyTargetsOmitted: 0 }), scope), null);
});

test("a null in the family is refused by name, because a null key once refused a whole snapshot", () => {
  const withNull = {
    qualifiedItemId: "(O)472",
    displayName: "Parsnip Seeds",
    shopId: "SeedShop",
    price: 20,
    currency: 0,
    openNow: null,
  };
  assert.equal(validateBridgeMessage(seed(withNull), scope), "invalid_snapshot");
  assert.equal(diagnoseBridgeMessage(seed(withNull), scope), "invalid_snapshot:seedSupplyTargets");
});

test("the shop half is all-or-nothing, so no number is published without a shop to walk to", () => {
  const priceWithoutShop = { qualifiedItemId: "(O)472", displayName: "Parsnip Seeds", price: 20 };
  const shopWithoutPrice = { qualifiedItemId: "(O)472", displayName: "Parsnip Seeds", shopId: "SeedShop" };
  for (const [label, row] of Object.entries({ priceWithoutShop, shopWithoutPrice })) {
    assert.equal(validateBridgeMessage(seed(row), scope), "invalid_snapshot", `${label} must be refused`);
    assert.equal(diagnoseBridgeMessage(seed(row), scope), "invalid_snapshot:seedSupplyTargets");
  }
});

test("an entry carrying a key the contract does not declare is refused, not ignored", () => {
  const extra = {
    qualifiedItemId: "(O)472",
    displayName: "Parsnip Seeds",
    shopId: "SeedShop",
    price: 20,
    currency: 0,
    note: "x",
  };
  assert.equal(diagnoseBridgeMessage(seed(extra), scope), "invalid_snapshot:seedSupplyTargets");
});
