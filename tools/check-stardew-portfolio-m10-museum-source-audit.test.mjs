import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
const root = resolve("."),
  script = resolve("tools/check-stardew-portfolio-m10-museum-source-audit.mjs");
function run() {
  return new Promise((done, reject) => {
    const c = spawn(process.execPath, [script], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "",
      stderr = "";
    c.stdout.on("data", (x) => (stdout += x));
    c.stderr.on("data", (x) => (stderr += x));
    c.on("error", reject);
    c.on("close", (code) => done({ code, stdout, stderr }));
  });
}
test("M10 CLI revalidates authority, provenance metadata, and bounded anchors", async () => {
  const r = await run();
  assert.equal(r.code, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.equal(o.anchorCount, 8);
  assert.equal(o.authorityHashVerified, true);
  assert.equal(o.provenanceMetadataVerified, true);
  assert.equal(o.sourceRealizationStatus, "unknown");
  assert.equal(o.projectionState, "blocked");
});
