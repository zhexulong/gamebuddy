import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validatePortfolioM3ForageSourceAudit } from "./lib/stardew-portfolio-m3-forage-source-audit.mjs";

const SOURCE_ROOT = new URL("../ref/external/StardewValleyDecompiled/Stardew Valley/", import.meta.url);
async function fixture() {
  return JSON.parse(
    await readFile(new URL("./stardew-portfolio-m3-forage-source-audit.json", import.meta.url), "utf8"),
  );
}
async function sources(model) {
  return Object.fromEntries(
    await Promise.all(
      model.anchors.map(async ({ relativePath }) => [relativePath, await readFile(new URL(relativePath, SOURCE_ROOT))]),
    ),
  );
}

test("M3 focused audit anchors distinct spawned-object and Debris lifecycles without claiming realization", async () => {
  const model = await fixture();
  const result = validatePortfolioM3ForageSourceAudit(model, await sources(model));
  assert.equal(result.anchorCount, 6);
  assert.equal(result.sourceRealizationStatus, "unknown");
  assert.equal(result.projectionState, "blocked");
});

test("M3 focused audit fails closed when an anchored source slice drifts", async () => {
  const model = await fixture();
  const input = await sources(model);
  const anchor = model.anchors[0];
  input[anchor.relativePath] = Buffer.from(
    input[anchor.relativePath]
      .toString("utf8")
      .replace(anchor.needle, "public static bool alteredCheckAt(Vector2 grabTile, Farmer who)"),
    "utf8",
  );
  assert.throws(() => validatePortfolioM3ForageSourceAudit(model, input), {
    code: "portfolio_m3_source_audit_anchor_drift",
  });
});

test("M3 focused audit rejects a self-asserted promotion", async () => {
  const model = await fixture();
  model.conclusion.projectionState = "primitive";
  const input = await sources(model);
  assert.throws(() => validatePortfolioM3ForageSourceAudit(model, input), {
    code: "portfolio_m3_source_audit_boundary_invalid",
  });
});
