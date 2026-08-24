import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  validatePortfolioM1RouteCharterBinding,
  validatePortfolioM1RouteProvenance,
  validatePortfolioM1RouteSourceAudit,
} from "./lib/stardew-portfolio-m1-route-source-audit.mjs";

const SOURCE_ROOT = new URL("../ref/external/StardewValleyDecompiled/Stardew Valley/", import.meta.url);
async function fixture() {
  return JSON.parse(await readFile(new URL("./stardew-portfolio-m1-route-source-audit.json", import.meta.url), "utf8"));
}
async function sources(model) {
  return Object.fromEntries(
    await Promise.all(
      model.anchors.map(async ({ relativePath }) => [relativePath, await readFile(new URL(relativePath, SOURCE_ROOT))]),
    ),
  );
}
async function charter() {
  return JSON.parse(await readFile(new URL("./stardew-portfolio-command-path-charter.json", import.meta.url), "utf8"));
}
async function provenance() {
  return await readFile(new URL("../design/13_STARDEW_NATIVE_PROVENANCE.md", import.meta.url), "utf8");
}

test("M1 focused source audit anchors bounded native route lifecycle without claiming realization or projection", async () => {
  const model = await fixture();
  const result = validatePortfolioM1RouteSourceAudit(model, await sources(model));
  assert.equal(result.anchorCount, 10);
  assert.equal(result.sourceRealizationStatus, "unknown");
  assert.equal(result.projectionState, "blocked");
  assert.equal(result.liveState, "not_performed");
});
test("M1 focused source audit fails closed on changed normal-player ingress anchor", async () => {
  const model = await fixture();
  const input = await sources(model);
  const anchor = model.anchors[0];
  input[anchor.relativePath] = Buffer.from(
    input[anchor.relativePath].toString("utf8").replace(anchor.needle, "Warp warp = null;"),
    "utf8",
  );
  assert.throws(() => validatePortfolioM1RouteSourceAudit(model, input), {
    code: "portfolio_m1_source_audit_anchor_drift",
  });
});
test("M1 focused source audit rejects an anchor path that mimics a Stardew prefix", async () => {
  const model = await fixture();
  model.anchors[0].relativePath = "StardewValley/../../../../../package.json";
  assert.throws(() => validatePortfolioM1RouteSourceAudit(model, {}), {
    code: "portfolio_m1_source_audit_anchor_invalid",
  });
});
test("M1 focused source audit rejects attempted source or live closure promotion", async () => {
  const model = await fixture();
  const input = await sources(model);
  model.conclusion.sourceRealizationStatus = "realized";
  assert.throws(() => validatePortfolioM1RouteSourceAudit(model, input), {
    code: "portfolio_m1_source_audit_boundary_invalid",
  });
});
test("M1 focused source audit rejects textual authorization drift even while formal statuses remain blocked", async () => {
  const model = await fixture();
  const input = await sources(model);
  model.conclusion.authorizationBoundary.rawUiInput = "allowed";
  assert.throws(() => validatePortfolioM1RouteSourceAudit(model, input), {
    code: "portfolio_m1_source_audit_boundary_invalid",
  });
});
test("M1 source audit binds provenance hashes to designated design/13 rows", async () => {
  const model = await fixture();
  const evidence = await provenance();
  validatePortfolioM1RouteProvenance(model, evidence);
  model.auditSource.targetAssemblySha256 = model.auditSource.localSnapshotContentManifestSha256;
  assert.throws(() => validatePortfolioM1RouteProvenance(model, evidence), {
    code: "portfolio_m1_source_audit_provenance_mismatch",
  });
});
test("M1 source audit validates its exact trace and topology against the current Charter", async () => {
  const model = await fixture();
  const currentCharter = await charter();
  validatePortfolioM1RouteCharterBinding(model, currentCharter);
  currentCharter.traceFamilies = currentCharter.traceFamilies.filter(
    (trace) => trace.traceFamilyId !== model.traceFamilyId,
  );
  assert.throws(() => validatePortfolioM1RouteCharterBinding(model, currentCharter), {
    code: "portfolio_m1_source_audit_charter_mismatch",
  });
});
