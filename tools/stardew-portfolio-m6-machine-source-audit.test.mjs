import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validatePortfolioM6MachineSourceAudit } from "./lib/stardew-portfolio-m6-machine-source-audit.mjs";
const SOURCE_ROOT = new URL("../ref/external/StardewValleyDecompiled/Stardew Valley/", import.meta.url);
async function fixture() {
  return JSON.parse(
    await readFile(new URL("./stardew-portfolio-m6-machine-source-audit.json", import.meta.url), "utf8"),
  );
}
async function sources(model) {
  return Object.fromEntries(
    await Promise.all(
      model.anchors.map(async ({ relativePath }) => [relativePath, await readFile(new URL(relativePath, SOURCE_ROOT))]),
    ),
  );
}
test("M6 focused audit anchors machine ingress, native processing, collection, and capacity without claiming realization", async () => {
  const model = await fixture();
  const result = validatePortfolioM6MachineSourceAudit(model, await sources(model));
  assert.equal(result.anchorCount, 8);
  assert.equal(result.sourceRealizationStatus, "unknown");
  assert.equal(result.projectionState, "blocked");
});
test("M6 focused audit fails closed when the native machine readiness anchor drifts", async () => {
  const model = await fixture();
  const input = await sources(model);
  const anchor = model.anchors.find(({ anchorId }) => anchorId === "machine_ready_transition");
  input[anchor.relativePath] = Buffer.from(
    input[anchor.relativePath].toString("utf8").replace(anchor.needle, "if (MinutesUntilReady > 0)"),
    "utf8",
  );
  assert.throws(() => validatePortfolioM6MachineSourceAudit(model, input), {
    code: "portfolio_m6_source_audit_anchor_drift",
  });
});
test("M6 focused audit rejects a self-asserted source or projection promotion", async () => {
  const model = await fixture();
  model.conclusion.sourceRealizationStatus = "realized";
  const input = await sources(model);
  assert.throws(() => validatePortfolioM6MachineSourceAudit(model, input), {
    code: "portfolio_m6_source_audit_boundary_invalid",
  });
});
