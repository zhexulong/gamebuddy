import assert from "node:assert/strict";
import test from "node:test";
import { PRODUCT_INTEGRATION_CATALOG } from "./integration-catalog-product.js";

test("product catalog registers only the audited Stardew launcher", async () => {
  assert.deepEqual(PRODUCT_INTEGRATION_CATALOG.ids, ["stardew"]);
  assert.equal(PRODUCT_INTEGRATION_CATALOG.get("test-arcade"), undefined);
  await assert.rejects(
    () => PRODUCT_INTEGRATION_CATALOG.select("test-arcade", {}, { configDirectory: "C:/profile" }),
    /integration_not_registered/,
  );
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
