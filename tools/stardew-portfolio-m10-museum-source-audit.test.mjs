import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { validatePortfolioM10MuseumSourceAudit } from "./lib/stardew-portfolio-m10-museum-source-audit.mjs";
const ROOT = new URL("../ref/external/StardewValleyDecompiled/Stardew Valley/", import.meta.url);
async function fixture() {
  return JSON.parse(
    await readFile(new URL("./stardew-portfolio-m10-museum-source-audit.json", import.meta.url), "utf8"),
  );
}
async function sources(m) {
  return Object.fromEntries(
    await Promise.all(
      m.anchors.map(async ({ relativePath }) => [relativePath, await readFile(new URL(relativePath, ROOT))]),
    ),
  );
}
test("M10 audit anchors donation, collection, reward eligibility, and claim without claiming realization", async () => {
  const m = await fixture(),
    r = validatePortfolioM10MuseumSourceAudit(m, await sources(m));
  assert.equal(r.anchorCount, 8);
  assert.equal(r.sourceRealizationStatus, "unknown");
  assert.equal(r.projectionState, "blocked");
});
test("M10 audit fails closed on museum collection anchor drift", async () => {
  const m = await fixture(),
    s = await sources(m),
    a = m.anchors.find((x) => x.anchorId === "museum_piece_commit");
  s[a.relativePath] = Buffer.from(
    s[a.relativePath].toString().replace(a.needle, "museum.museumPieces.Remove(new Vector2(mapXTile, mapYTile));"),
  );
  assert.throws(() => validatePortfolioM10MuseumSourceAudit(m, s), { code: "portfolio_m10_source_audit_anchor_drift" });
});
test("M10 audit rejects source realization promotion", async () => {
  const m = await fixture(),
    s = await sources(m);
  m.conclusion.sourceRealizationStatus = "realized";
  assert.throws(() => validatePortfolioM10MuseumSourceAudit(m, s), {
    code: "portfolio_m10_source_audit_boundary_invalid",
  });
});
