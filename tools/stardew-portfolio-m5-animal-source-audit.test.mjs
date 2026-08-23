import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validatePortfolioM5AnimalSourceAudit } from "./lib/stardew-portfolio-m5-animal-source-audit.mjs";

const SOURCE_ROOT = new URL("../ref/external/StardewValleyDecompiled/Stardew Valley/", import.meta.url);
async function fixture() {
  return JSON.parse(
    await readFile(new URL("./stardew-portfolio-m5-animal-source-audit.json", import.meta.url), "utf8"),
  );
}
async function sources(model) {
  return Object.fromEntries(
    await Promise.all(
      model.anchors.map(async ({ relativePath }) => [relativePath, await readFile(new URL(relativePath, SOURCE_ROOT))]),
    ),
  );
}
test("M5 focused audit anchors trough feed, native animal day product availability, and tool delivery without claiming realization", async () => {
  const model = await fixture();
  const result = validatePortfolioM5AnimalSourceAudit(model, await sources(model));
  assert.equal(result.anchorCount, 9);
  assert.equal(result.sourceRealizationStatus, "unknown");
  assert.equal(result.projectionState, "blocked");
});
test("M5 focused audit fails closed when a native animal lifecycle anchor drifts", async () => {
  const model = await fixture();
  const input = await sources(model);
  const anchor = model.anchors.find(({ anchorId }) => anchorId === "animal_product_availability_commit");
  input[anchor.relativePath] = Buffer.from(
    input[anchor.relativePath].toString("utf8").replace(anchor.needle, "currentProduce.Value = null;"),
    "utf8",
  );
  assert.throws(() => validatePortfolioM5AnimalSourceAudit(model, input), {
    code: "portfolio_m5_source_audit_anchor_drift",
  });
});
test("M5 focused audit rejects a self-asserted source or projection promotion", async () => {
  const model = await fixture();
  model.conclusion.projectionState = "projected";
  const input = await sources(model);
  assert.throws(() => validatePortfolioM5AnimalSourceAudit(model, input), {
    code: "portfolio_m5_source_audit_boundary_invalid",
  });
});
