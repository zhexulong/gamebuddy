import assert from "node:assert/strict";
import test from "node:test";
import { PRODUCT_INTEGRATION_CATALOG } from "./integration-catalog-product.js";

test("product catalog registers no directly selectable launcher but one audited game provider", async () => {
  // The product registry is provider-only: the composition root reaches Stardew
  // through the audited game provider, never through an operator-config attach.
  assert.deepEqual(PRODUCT_INTEGRATION_CATALOG.ids, []);
  assert.deepEqual(PRODUCT_INTEGRATION_CATALOG.providerIds, ["stardew"]);
  assert.equal(PRODUCT_INTEGRATION_CATALOG.get("test-arcade"), undefined);
  assert.equal(PRODUCT_INTEGRATION_CATALOG.getProvider("test-arcade"), undefined);
  await assert.rejects(
    () => PRODUCT_INTEGRATION_CATALOG.select("test-arcade", {}, { configDirectory: "C:/profile" }),
    /integration_not_registered/,
  );
});

test("product catalog exposes the audited Stardew game integration provider", () => {
  const provider = PRODUCT_INTEGRATION_CATALOG.getProvider("stardew");
  assert.ok(provider);
  assert.equal(provider.gameId, "stardew");
  assert.equal(typeof provider.createLifecycleCoordinator, "function");
});

// Task 0 characterization (retired): Stardew product selection previously accepted
// raw operator bridge facts through a directly selectable catalog launcher. That route
// was removed by Task 2, so the characterization is replaced by the Task 1 assertions
// below: the catalog no longer registers any selectable launcher at all, and only the
// composition-owned provider lookup survives.
//
// Task 1 (post-activation): the shipped product catalog must not be able to turn raw
// operator bridge facts into a Stardew attachment.
//
// The two halves are deliberately separated because only one of them is the decided
// product route:
//   - `getProvider("stardew")` (gameId) is the LAWFUL composition lookup: it returns
//     the typed provider the composition root binds to the coordinator, and no
//     operator configuration participates.
//   - `select("stardew", <operator config>)` (integrationId) was the TRANSITIONAL
//     direct attach, removed here.
//
// It asserts the PRODUCT boundary, not the adapter: `STARDEW_INTEGRATION_LAUNCHER`
// still exists for Preview and for the coordinator's private materializer, so a test
// that merely proved the launcher cannot run would be wrong and would over-constrain
// the retained private seam.
test("Task 1: the shipped product catalog cannot select Stardew from raw operator bridge facts", async () => {
  // The lawful provider lookup stays: composition depends on it.
  const provider = PRODUCT_INTEGRATION_CATALOG.getProvider("stardew");
  assert.ok(provider, "the composition-owned provider lookup must remain available");
  assert.equal(typeof provider.createLifecycleCoordinator, "function");

  // No launcher is registered, so there is no integrationId that a product caller —
  // or a rehydrated operator config — could name to obtain operator-supplied
  // pipe/token launch facts.
  assert.deepEqual(PRODUCT_INTEGRATION_CATALOG.ids, []);
  assert.equal(PRODUCT_INTEGRATION_CATALOG.get("stardew"), undefined);
  await assert.rejects(
    () => PRODUCT_INTEGRATION_CATALOG.select(
      "stardew",
      { pipeName: "gamebuddy_stardew", bridgeToken: "0123456789abcdef" },
      { configDirectory: "C:/profile" },
    ),
    (error) => {
      assert.ok(error instanceof Error, "a rejected direct selection must raise");
      assert.match(error.message, /integration_not_registered/);
      return true;
    },
  );
});
