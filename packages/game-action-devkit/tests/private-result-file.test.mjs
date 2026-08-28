import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { beginPrivateResultFile, cleanupPrivateResultFile, MAX_RESULT_BYTES, readPrivateResultFile, writePrivateResultFile } from "../src/private-result-file.mjs";

async function withRoot(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "game-action-private-result-"));
  try { await callback(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("reserves a unique absent absolute path and reads it once", async () => {
  await withRoot(async (root) => {
    const claim = await beginPrivateResultFile({ root });
    assert.ok(path.isAbsolute(claim.resultFile));
    await assert.rejects(readPrivateResultFile(claim), /ENOENT/);
    const second = await beginPrivateResultFile({ root });
    await writeFile(second.resultFile, '{"result":"ok"}', { encoding: "utf8", flag: "wx" });
    assert.equal(await readPrivateResultFile(second), '{"result":"ok"}');
    await assert.rejects(readPrivateResultFile(second), /invalid_or_consumed_claim/);
    await cleanupPrivateResultFile(second);
  });
});

test("writes exactly once through exclusive sibling temporary file", async () => {
  await withRoot(async (root) => {
    const claim = await beginPrivateResultFile({ root });
    await writePrivateResultFile(claim.resultFile, "{\"result\":\"ok\"}");
    assert.equal(await readPrivateResultFile(claim), "{\"result\":\"ok\"}");
    await assert.rejects(writePrivateResultFile(claim.resultFile, "again"), /destination_exists/);
  });
});

test("rejects symlink, invalid UTF-8, empty, and oversized result files", async () => {
  await withRoot(async (root) => {
    const claim = await beginPrivateResultFile({ root });
    const outside = path.join(root, "outside.json");
    await writeFile(outside, "{}", "utf8");
    try { await symlink(outside, claim.resultFile, "file"); } catch (error) { if (error?.code !== "EPERM") throw error; }
    try { await assert.rejects(readPrivateResultFile(claim), /result_untrusted/); } catch (error) {
      if (!error?.message?.includes("ENOENT")) throw error;
    }
    await rm(claim.directory, { recursive: true, force: true });
    const invalidUtf8 = await beginPrivateResultFile({ root });
    await writeFile(invalidUtf8.resultFile, Buffer.from([0xff]), { flag: "wx" });
    await assert.rejects(readPrivateResultFile(invalidUtf8), /invalid_utf8/);
    const empty = await beginPrivateResultFile({ root });
    await writeFile(empty.resultFile, "", { flag: "wx" });
    await assert.rejects(readPrivateResultFile(empty), /invalid_size/);
    const oversized = await beginPrivateResultFile({ root });
    await writeFile(oversized.resultFile, "x".repeat(MAX_RESULT_BYTES + 1), { flag: "wx" });
    await assert.rejects(readPrivateResultFile(oversized), /invalid_size/);
  });
});

test("writer rejects invalid paths and oversized text without sharing temporary ownership", async () => {
  await withRoot(async (root) => {
    const claim = await beginPrivateResultFile({ root });
    await assert.rejects(writePrivateResultFile("relative.json", "{}"), /invalid_write_input/);
    await assert.rejects(writePrivateResultFile(claim.resultFile, "x".repeat(MAX_RESULT_BYTES + 1)), /invalid_size/);
    const [first, second] = await Promise.allSettled([
      writePrivateResultFile(claim.resultFile, "first"),
      writePrivateResultFile(claim.resultFile, "second"),
    ]);
    assert.equal([first, second].filter((item) => item.status === "fulfilled").length, 1);
    assert.equal([first, second].filter((item) => item.status === "rejected").length, 1);
    assert.equal(await readPrivateResultFile(claim), first.status === "fulfilled" ? "first" : "second");
    assert.deepEqual((await readdir(claim.directory)).filter((entry) => entry.endsWith(".tmp")), []);
  });
});

test("cleanup rejects a replaced private directory and is one-shot", async () => {
  await withRoot(async (root) => {
    const claim = await beginPrivateResultFile({ root });
    const outside = await mkdtemp(path.join(os.tmpdir(), "game-action-private-outside-"));
    await rm(claim.directory, { recursive: true, force: true });
    await symlink(outside, claim.directory, "junction");
    await assert.rejects(cleanupPrivateResultFile(claim), /root_untrusted/);
    await rm(claim.directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
    const clean = await beginPrivateResultFile({ root });
    await cleanupPrivateResultFile(clean);
    await assert.rejects(cleanupPrivateResultFile(clean), /already_cleaned/);
  });
});
