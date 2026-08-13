import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(".");
const script = resolve("tools/check-stardew-portfolio-m1-route-source-audit.mjs");
async function run() {
  return await new Promise((done, reject) => {
    const child = spawn(process.execPath, [script], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}
test("M1 source-audit CLI verifies authority, recorded provenance metadata, and bounded anchors without claiming realization", async () => {
  const result = await run();
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.anchorCount, 10);
  assert.equal(output.authorityHashVerified, true);
  assert.equal(output.charterBindingVerified, true);
  assert.equal(output.provenanceMetadataVerified, true);
  assert.equal(output.sourceRealizationStatus, "unknown");
  assert.equal(output.projectionState, "blocked");
});
