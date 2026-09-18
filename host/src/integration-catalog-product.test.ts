import assert from "node:assert/strict";
import test from "node:test";
import { PRODUCT_INTEGRATION_CATALOG } from "./integration-catalog-product.js";

test("product catalog registers only the audited Stardew launcher", async () => {
  assert.deepEqual(PRODUCT_INTEGRATION_CATALOG.ids, ["stardew"]);
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

test("Task 0 characterization: current Stardew product selection accepts operator bridge facts", async () => {
  const selected = await PRODUCT_INTEGRATION_CATALOG.select(
    "stardew",
    {
      pipeName: "gamebuddy_stardew",
      bridgeToken: "0123456789abcdef",
      saveId: "save_01",
      worldId: "world_01",
    },
    { configDirectory: "C:/profile" },
  );

  assert.equal(selected.launcher.integrationId, "stardew");
  assert.deepEqual(selected.prepared, {
    launchConfig: {
      pipeName: "gamebuddy_stardew",
      bridgeToken: "0123456789abcdef",
    },
    identityScope: { saveId: "save_01", worldId: "world_01" },
  });
});
