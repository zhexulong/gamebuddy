import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validatePortfolioM8MineSourceAudit } from "./lib/stardew-portfolio-m8-mine-source-audit.mjs";

const SOURCE_ROOT = new URL("../ref/external/StardewValleyDecompiled/Stardew Valley/", import.meta.url);
async function fixture() {
  return JSON.parse(await readFile(new URL("./stardew-portfolio-m8-mine-source-audit.json", import.meta.url), "utf8"));
}
async function sources(model) {
  return Object.fromEntries(
    await Promise.all(
      model.anchors.map(async ({ relativePath }) => [relativePath, await readFile(new URL(relativePath, SOURCE_ROOT))]),
    ),
  );
}
test("M8 focused audit anchors nearby ingress, progress gates, native route transitions, and dynamic ladder boundary without claiming realization", async () => {
  const model = await fixture();
  const result = validatePortfolioM8MineSourceAudit(model, await sources(model));
  assert.equal(result.anchorCount, 8);
  assert.equal(result.sourceRealizationStatus, "unknown");
  assert.equal(result.projectionState, "blocked");
});
test("M8 focused audit fails closed when target-floor warp anchor drifts", async () => {
  const model = await fixture();
  const input = await sources(model);
  const anchor = model.anchors.find(({ anchorId }) => anchorId === "mine_target_floor_warp");
  input[anchor.relativePath] = Buffer.from(
    input[anchor.relativePath].toString("utf8").replace(anchor.needle, 'warpFarmer("Mine", 17, 4, flip: true);'),
    "utf8",
  );
  assert.throws(() => validatePortfolioM8MineSourceAudit(model, input), {
    code: "portfolio_m8_source_audit_anchor_drift",
  });
});
test("M8 focused audit rejects signed DSM authorization claims", async () => {
  const model = await fixture();
  model.unresolvedQuestions.push({
    questionId: "signed_dsm_authorization",
    question: "A signed DSM authorizes the runtime checkpoint.",
    disposition: "requires_signed_dsm_selection",
  });
  const input = await sources(model);
  assert.throws(() => validatePortfolioM8MineSourceAudit(model, input), {
    code: "portfolio_m8_source_audit_invalid",
  });
});
test("M8 focused audit rejects source or projection promotion", async () => {
  const model = await fixture();
  model.conclusion.sourceRealizationStatus = "realized";
  const input = await sources(model);
  assert.throws(() => validatePortfolioM8MineSourceAudit(model, input), {
    code: "portfolio_m8_source_audit_boundary_invalid",
  });
});
