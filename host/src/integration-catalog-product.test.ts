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
