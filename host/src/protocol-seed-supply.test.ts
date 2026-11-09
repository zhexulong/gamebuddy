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
 *     never see a number it cannot walk to;
 *   - the ADDRESS half is exactly one of `shopDestination`, `shopLocation` and `shopLocationUnknown`, because a price
 *     and an open-now answer with none of them reads as a shop she can walk to.
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

/** The counter the actor is standing beside: the Mod's own `shopTargets` row, selected into the address half. */
const counterHere = {
  location: "SeedShop",
  targetId: "shop_0123456789abcdef",
  tile: { x: 12, y: 14 },
  label: "Pierre",
};

/** The family-level refusal names this row, so a frame with eight rows still says which one it could not read. */
const refusedEntry = (diagnosis: string | null, entry = 0): boolean =>
  diagnosis?.startsWith(`invalid_snapshot:seedSupplyTargets:entry${entry}`) === true;

test("the Host admits every shape the Mod publishes for a seed supply row", () => {
  const published = {
    // A seed no shop stocks: the seed and its count, the shop half absent, and the address saying WHY it is absent.
    noKnownSource: {
      qualifiedItemId: "(O)745",
      displayName: "Strawberry Seeds",
      heldCount: 1,
      shopLocationUnknown: "no_shop_stocks_this_seed",
    },
    // The ordinary row, with the counter in this very location: the destination IS the published shop row.
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
      shopDestination: counterHere,
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
      shopLocation: "SeedShop",
    },
    // The question could not be asked: `openNow` is ABSENT and the reason is named. This must not read as closed.
    unanswerable: {
      qualifiedItemId: "(O)472",
      displayName: "Parsnip Seeds",
      shopId: "SeedShop",
      price: 20,
      currency: 0,
      openNowReason: "owner_condition_unreadable",
      shopLocation: "SeedShop",
    },
    // The count was not measured: `heldCount` is absent, never 0.
    uncounted: {
      qualifiedItemId: "(O)472",
      displayName: "Parsnip Seeds",
      shopId: "SeedShop",
      price: 20,
      currency: 0,
      shopLocation: "SeedShop",
    },
  };
  for (const [label, row] of Object.entries(published)) {
    assert.equal(validateBridgeMessage(seed(row), scope), null, `${label} must be admitted`);
    assert.equal(diagnoseBridgeMessage(seed(row), scope), "accepted", `${label} must be admitted`);
  }
  // A measured empty family is a legal answer ("she holds no plantable seed"), and so is a cap count beside it.
  assert.equal(validateBridgeMessage(snapshotWith([], { seedSupplyTargetsOmitted: 0 }), scope), null);
});

test("the address half is exactly one of the three, so a row with none is refused", () => {
  // The farm case the whole half exists for. Before this family accepted it, `shopLocation` was an unknown key and the
  // whole frame was refused, which is the red this case was written from.
  const located = { qualifiedItemId: "(O)472", displayName: "Parsnip Seeds", shopLocation: "SeedShop" };
  assert.equal(validateBridgeMessage(seed(located), scope), null, "shopLocation alone must be admitted");
  // A price with no address is the defect the half removes: it reads as a shop she can walk to.
  const none = { qualifiedItemId: "(O)472", displayName: "Parsnip Seeds" };
  assert.equal(
    validateBridgeMessage(seed(none), scope),
    "invalid_snapshot",
    "a row with no address half must be refused",
  );
  const diagnosis = diagnoseBridgeMessage(seed(none), scope);
  assert.ok(refusedEntry(diagnosis), `a row with no address half must name the row; got ${diagnosis}`);
});

test("a row carrying two address keys is refused, naming the row", () => {
  // Both halves cannot be true at once: the counter is here (destination) and it is elsewhere (location).
  const both = {
    qualifiedItemId: "(O)472",
    displayName: "Parsnip Seeds",
    shopLocation: "SeedShop",
    shopDestination: counterHere,
  };
  assert.equal(validateBridgeMessage(seed(both), scope), "invalid_snapshot", "two address keys must be refused");
  const diagnosis = diagnoseBridgeMessage(seed(both), scope);
  assert.ok(refusedEntry(diagnosis), `two address keys must name the row; got ${diagnosis}`);
  // The three keys are all it may not combine: a row that also names the reason is the same defect.
  const destinationAndReason = {
    qualifiedItemId: "(O)472",
    displayName: "Parsnip Seeds",
    shopDestination: counterHere,
    shopLocationUnknown: "shop_location_unreadable",
  };
  assert.equal(validateBridgeMessage(seed(destinationAndReason), scope), "invalid_snapshot");
  assert.ok(refusedEntry(diagnoseBridgeMessage(seed(destinationAndReason), scope)));
});

test("shopDestination is the published counter row and nothing else: four keys, an accepted id and a real tile", () => {
  const row = (shopDestination: unknown): Record<string, unknown> => ({
    qualifiedItemId: "(O)472",
    displayName: "Parsnip Seeds",
    shopDestination,
  });
  const refused = (label: string, shopDestination: unknown): void => {
    assert.equal(
      validateBridgeMessage(seed(row(shopDestination)), scope),
      "invalid_snapshot",
      `${label} must be refused`,
    );
    const diagnosis = diagnoseBridgeMessage(seed(row(shopDestination)), scope);
    assert.ok(refusedEntry(diagnosis), `${label} must name the row; got ${diagnosis}`);
  };
  // The id `shop_purchase` accepts, and no other spelling: a minted or truncated id names no counter.
  for (const targetId of ["counter_0123456789abcdef", "shop_0123456789abcde", "shop_0123456789ABCDEF", ""])
    refused(`shopDestination.targetId=${targetId}`, { ...counterHere, targetId });
  // The tile is the snapshot's own coordinate: 1000 is the largest the wire allows and 0 the smallest.
  refused("shopDestination.tile.x = -1", { ...counterHere, tile: { x: -1, y: 14 } });
  refused("shopDestination.tile.x = 1001", { ...counterHere, tile: { x: 1001, y: 14 } });
  refused("shopDestination.tile.y = 1001", { ...counterHere, tile: { x: 12, y: 1001 } });
  refused("shopDestination.tile.x = 1.5", { ...counterHere, tile: { x: 1.5, y: 14 } });
  // Four keys exactly: a missing one leaves the walk without an address, an extra one is not part of the row it copies.
  const withoutLabel = { location: counterHere.location, targetId: counterHere.targetId, tile: counterHere.tile };
  refused("shopDestination with no label", withoutLabel);
  refused("shopDestination with an extra key", { ...counterHere, ownerTileX: 12 });
  assert.equal(validateBridgeMessage(seed(row({ ...counterHere, tile: { x: 0, y: 1000 } })), scope), null);
  // The location is a published location name, the same bound the snapshot's own `location` carries.
  refused("shopDestination.location = ''", { ...counterHere, location: "" });
  assert.equal(validateBridgeMessage(seed(row({ ...counterHere, location: "s".repeat(256) })), scope), null);
  refused("shopDestination.location = 257 chars", { ...counterHere, location: "s".repeat(257) });
});

test("shopLocation and shopLocationUnknown are bounded words, like the reasons beside them", () => {
  const row = (address: Record<string, unknown>): Record<string, unknown> => ({
    qualifiedItemId: "(O)472",
    displayName: "Parsnip Seeds",
    ...address,
  });
  const refused = (label: string, address: Record<string, unknown>): void => {
    assert.equal(validateBridgeMessage(seed(row(address)), scope), "invalid_snapshot", `${label} must be refused`);
    const diagnosis = diagnoseBridgeMessage(seed(row(address)), scope);
    assert.ok(refusedEntry(diagnosis), `${label} must name the row; got ${diagnosis}`);
  };
  // A location with no name is no address at all.
  refused("shopLocation = ''", { shopLocation: "" });
  refused("shopLocation = 257 chars", { shopLocation: "s".repeat(257) });
  refused("shopLocation = 3", { shopLocation: 3 });
  // The reason is bounded like openNowReason beside it, and carries no free-text excuse for a number.
  refused("shopLocationUnknown = ''", { shopLocationUnknown: "" });
  refused("shopLocationUnknown = 65 chars", { shopLocationUnknown: "s".repeat(65) });
  refused("shopLocationUnknown = true", { shopLocationUnknown: true });
  for (const reason of ["shop_location_unreadable", "no_shop_stocks_this_seed"]) {
    assert.equal(validateBridgeMessage(seed(row({ shopLocationUnknown: reason })), scope), null, reason);
    assert.equal(diagnoseBridgeMessage(seed(row({ shopLocationUnknown: reason })), scope), "accepted", reason);
  }
  assert.equal(validateBridgeMessage(seed(row({ shopLocation: "s".repeat(256) })), scope), null);
});

test("a null in the family is refused by name, because a null key once refused a whole snapshot", () => {
  const withNull = {
    qualifiedItemId: "(O)472",
    displayName: "Parsnip Seeds",
    shopId: "SeedShop",
    price: 20,
    currency: 0,
    openNow: null,
    shopLocation: "SeedShop",
  };
  assert.equal(validateBridgeMessage(seed(withNull), scope), "invalid_snapshot");
  assert.ok(refusedEntry(diagnoseBridgeMessage(seed(withNull), scope)));
});

test("the shop half is all-or-nothing, so no number is published without a shop to walk to", () => {
  const priceWithoutShop = {
    qualifiedItemId: "(O)472",
    displayName: "Parsnip Seeds",
    price: 20,
    shopLocationUnknown: "no_shop_stocks_this_seed",
  };
  const shopWithoutPrice = {
    qualifiedItemId: "(O)472",
    displayName: "Parsnip Seeds",
    shopId: "SeedShop",
    shopLocation: "SeedShop",
  };
  for (const [label, row] of Object.entries({ priceWithoutShop, shopWithoutPrice })) {
    assert.equal(validateBridgeMessage(seed(row), scope), "invalid_snapshot", `${label} must be refused`);
    assert.ok(refusedEntry(diagnoseBridgeMessage(seed(row), scope)), `${label} must name the row`);
  }
});

test("an entry carrying a key the contract does not declare is refused, not ignored", () => {
  const extra = {
    qualifiedItemId: "(O)472",
    displayName: "Parsnip Seeds",
    shopId: "SeedShop",
    price: 20,
    currency: 0,
    shopLocation: "SeedShop",
    note: "x",
  };
  assert.ok(refusedEntry(diagnoseBridgeMessage(seed(extra), scope)));
});
