import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validatePortfolioM7BundleSourceAudit } from "./lib/stardew-portfolio-m7-bundle-source-audit.mjs";

const SOURCE_ROOT = new URL("../ref/external/StardewValleyDecompiled/Stardew Valley/", import.meta.url);
async function fixture() {
  return JSON.parse(
    await readFile(new URL("./stardew-portfolio-m7-bundle-source-audit.json", import.meta.url), "utf8"),
  );
}
async function sources(model) {
  return Object.fromEntries(
    await Promise.all(
      model.anchors.map(async ({ relativePath }) => [relativePath, await readFile(new URL(relativePath, SOURCE_ROOT))]),
    ),
  );
}
test("M7 focused audit anchors bundle contribution, completion, reward claim, and presentation boundary without claiming realization", async () => {
  const model = await fixture();
  const result = validatePortfolioM7BundleSourceAudit(model, await sources(model));
  assert.equal(result.anchorCount, 8);
  assert.equal(result.sourceRealizationStatus, "unknown");
  assert.equal(result.projectionState, "blocked");
});
test("M7 focused audit fails closed when the bundle contribution anchor drifts", async () => {
  const model = await fixture();
  const input = await sources(model);
  const anchor = model.anchors.find(({ anchorId }) => anchorId === "bundle_slot_progress_commit");
  input[anchor.relativePath] = Buffer.from(
    input[anchor.relativePath]
      .toString("utf8")
      .replace(anchor.needle, "communityCenter.bundles.FieldDict[bundleIndex][i] = false;"),
    "utf8",
  );
  assert.throws(() => validatePortfolioM7BundleSourceAudit(model, input), {
    code: "portfolio_m7_source_audit_anchor_drift",
  });
});
test("M7 focused audit rejects a self-asserted source or projection promotion", async () => {
  const model = await fixture();
  model.conclusion.projectionState = "projected";
  const input = await sources(model);
  assert.throws(() => validatePortfolioM7BundleSourceAudit(model, input), {
    code: "portfolio_m7_source_audit_boundary_invalid",
  });
});
