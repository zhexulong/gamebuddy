import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
const root = resolve(".");
const script = resolve("tools/check-stardew-portfolio-m7-bundle-source-audit.mjs");
function run() {
  return new Promise((done, reject) => {
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
test("M7 source-audit CLI revalidates authority, provenance metadata, and bounded local anchors", async () => {
  const result = await run();
  assert.equal(result.code, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.anchorCount, 8);
  assert.equal(output.authorityHashVerified, true);
  assert.equal(output.provenanceMetadataVerified, true);
  assert.equal(output.sourceRealizationStatus, "unknown");
  assert.equal(output.projectionState, "blocked");
});
