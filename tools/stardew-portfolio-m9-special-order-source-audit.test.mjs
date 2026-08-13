import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validatePortfolioM9SpecialOrderSourceAudit } from "./lib/stardew-portfolio-m9-special-order-source-audit.mjs";
const SOURCE_ROOT = new URL("../ref/external/StardewValleyDecompiled/Stardew Valley/", import.meta.url);
async function fixture() {
  return JSON.parse(
    await readFile(new URL("./stardew-portfolio-m9-special-order-source-audit.json", import.meta.url), "utf8"),
  );
}
async function sources(model) {
  return Object.fromEntries(
    await Promise.all(
      model.anchors.map(async ({ relativePath }) => [relativePath, await readFile(new URL(relativePath, SOURCE_ROOT))]),
    ),
  );
}
test("M9 focused audit anchors native acceptance, objective protocol, completion, reward grant, and failure without claiming realization", async () => {
  const model = await fixture();
  const result = validatePortfolioM9SpecialOrderSourceAudit(model, await sources(model));
  assert.equal(result.anchorCount, 8);
  assert.equal(result.sourceRealizationStatus, "unknown");
  assert.equal(result.projectionState, "blocked");
});
test("M9 focused audit fails closed when native reward grant anchor drifts", async () => {
  const model = await fixture();
  const input = await sources(model);
  const anchor = model.anchors.find(({ anchorId }) => anchorId === "special_order_reward_grant");
  input[anchor.relativePath] = Buffer.from(
    input[anchor.relativePath].toString("utf8").replace(anchor.needle, "reward.Reset();"),
    "utf8",
  );
  assert.throws(() => validatePortfolioM9SpecialOrderSourceAudit(model, input), {
    code: "portfolio_m9_source_audit_anchor_drift",
  });
});
test("M9 focused audit rejects source or projection promotion", async () => {
  const model = await fixture();
  model.conclusion.projectionState = "projected";
  const input = await sources(model);
  assert.throws(() => validatePortfolioM9SpecialOrderSourceAudit(model, input), {
    code: "portfolio_m9_source_audit_boundary_invalid",
  });
});
