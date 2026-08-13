import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validatePortfolioM2CropSourceAudit } from "./lib/stardew-portfolio-m2-crop-source-audit.mjs";

const SOURCE_ROOT = new URL("../ref/external/StardewValleyDecompiled/Stardew Valley/", import.meta.url);

async function fixture() {
  return JSON.parse(await readFile(new URL("./stardew-portfolio-m2-crop-source-audit.json", import.meta.url), "utf8"));
}
async function sources(model) {
  const pairs = await Promise.all(
    model.anchors.map(async ({ relativePath }) => [relativePath, await readFile(new URL(relativePath, SOURCE_ROOT))]),
  );
  return Object.fromEntries(pairs);
}

test("M2 focused source audit anchors its bounded native lifecycle without claiming realization or projection", async () => {
  const model = await fixture();
  const result = validatePortfolioM2CropSourceAudit(model, await sources(model));
  assert.equal(result.anchorCount, 9);
  assert.equal(result.sourceRealizationStatus, "unknown");
  assert.equal(result.projectionState, "blocked");
  assert.equal(result.liveState, "not_performed");
});

test("M2 focused source audit fails closed on a changed native anchor", async () => {
  const model = await fixture();
  const input = await sources(model);
  const anchor = model.anchors[0];
  input[anchor.relativePath] = Buffer.from(
    input[anchor.relativePath].toString("utf8").replace(anchor.needle, "location.makeHoeDirt(changedTile);"),
    "utf8",
  );
  assert.throws(() => validatePortfolioM2CropSourceAudit(model, input), {
    code: "portfolio_m2_source_audit_anchor_drift",
  });
});

test("M2 focused source audit rejects an anchor path that mimics a Stardew prefix", async () => {
  const model = await fixture();
  const anchor = model.anchors[0];
  anchor.relativePath = "StardewValley/../../../../../package.json";
  assert.throws(() => validatePortfolioM2CropSourceAudit(model, {}), {
    code: "portfolio_m2_source_audit_anchor_invalid",
  });
});

test("M2 focused source audit rejects an attempted promotion into source or live closure", async () => {
  const model = await fixture();
  model.conclusion.sourceRealizationStatus = "realized";
  const input = await sources(model);
  assert.throws(() => validatePortfolioM2CropSourceAudit(model, input), {
    code: "portfolio_m2_source_audit_boundary_invalid",
  });
});
