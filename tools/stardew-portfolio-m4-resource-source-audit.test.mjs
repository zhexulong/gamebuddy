import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validatePortfolioM4ResourceSourceAudit } from "./lib/stardew-portfolio-m4-resource-source-audit.mjs";

const SOURCE_ROOT = new URL("../ref/external/StardewValleyDecompiled/Stardew Valley/", import.meta.url);
async function fixture() {
  return JSON.parse(
    await readFile(new URL("./stardew-portfolio-m4-resource-source-audit.json", import.meta.url), "utf8"),
  );
}
async function sources(model) {
  return Object.fromEntries(
    await Promise.all(
      model.anchors.map(async ({ relativePath }) => [relativePath, await readFile(new URL(relativePath, SOURCE_ROOT))]),
    ),
  );
}

test("M4 focused audit anchors source transform, fresh Debris creation, and later delivery without claiming realization", async () => {
  const model = await fixture();
  const result = validatePortfolioM4ResourceSourceAudit(model, await sources(model));
  assert.equal(result.anchorCount, 9);
  assert.equal(result.sourceRealizationStatus, "unknown");
  assert.equal(result.projectionState, "blocked");
});

test("M4 focused audit fails closed when an anchored native source slice drifts", async () => {
  const model = await fixture();
  const input = await sources(model);
  const anchor = model.anchors.find(({ anchorId }) => anchorId === "resource_clump_health_commit");
  input[anchor.relativePath] = Buffer.from(
    input[anchor.relativePath].toString("utf8").replace(anchor.needle, "health.Value = power;"),
    "utf8",
  );
  assert.throws(() => validatePortfolioM4ResourceSourceAudit(model, input), {
    code: "portfolio_m4_source_audit_anchor_drift",
  });
});

test("M4 focused audit rejects a self-asserted source or projection promotion", async () => {
  const model = await fixture();
  model.conclusion.sourceRealizationStatus = "realized";
  const input = await sources(model);
  assert.throws(() => validatePortfolioM4ResourceSourceAudit(model, input), {
    code: "portfolio_m4_source_audit_boundary_invalid",
  });
});
