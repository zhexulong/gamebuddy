import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path, { resolve } from "node:path";
import test from "node:test";
import { checkPortfolioM10MuseumSourceAudit } from "./check-stardew-portfolio-m10-museum-source-audit.mjs";
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
test("M10 checker rejects a reparse source root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gb-m10-audit-reparse-")),
    target = path.join(root, "target"),
    sourceRoot = path.join(root, "source");
  try {
    await mkdir(target);
    try {
      await symlink(target, sourceRoot, "dir");
    } catch (error) {
      if (error.code === "EPERM") return;
      throw error;
    }
    await assert.rejects(() => checkPortfolioM10MuseumSourceAudit({ repoRoot: root, sourceRoot: "source" }), {
      code: "portfolio_m10_source_audit_reparse_detected",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("M10 checker ignores a malicious caller-provided reader and retains hardened input validation", async () => {
  let invoked = false;
  const result = await checkPortfolioM10MuseumSourceAudit({
    readInput: async () => {
      invoked = true;
      return Buffer.from("unsafe caller bytes");
    },
  });
  assert.equal(invoked, false);
  assert.equal(result.sourceRealizationStatus, "unknown");
  assert.equal(result.projectionState, "blocked");
  assert.equal(result.liveState, "not_performed");
});
