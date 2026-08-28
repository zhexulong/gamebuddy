import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { beginEvidenceRun, finalizeEvidenceRun, finalizeIncompleteEvidenceRun, readPassedEvidence } from "../src/evidence.mjs";

const identity = { gameId: "stardew", actionId: "equip_tool", runId: "run-001" };

async function withRoot(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "game-action-evidence-"));
  try { await callback(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test("atomically finalizes a complete passing bundle and reads it by exact identity", async () => {
  await withRoot(async (root) => {
    const run = await beginEvidenceRun({ root, identity });
    const bundle = await finalizeEvidenceRun(run, { status: "complete", verdict: "passed", metadata: { contractVersion: 1 } });
    assert.equal(bundle.status, "complete");
    assert.equal(bundle.verdict, "passed");
    const saved = JSON.parse(await readFile(path.join(bundle.directory, "bundle.json"), "utf8"));
    assert.deepEqual(saved.identity, identity);
    assert.equal((await readPassedEvidence({ root, identity })).verdict, "passed");
  });
});

test("rejects duplicate staging, final destination, and double finalization", async () => {
  await withRoot(async (root) => {
    const first = await beginEvidenceRun({ root, identity });
    await assert.rejects(beginEvidenceRun({ root, identity }), /staging_exists/);
    await finalizeEvidenceRun(first, { status: "complete", verdict: "passed" });
    await assert.rejects(beginEvidenceRun({ root, identity }), /final_destination_exists|staging_exists/);
    await assert.rejects(finalizeEvidenceRun(first, { status: "complete", verdict: "passed" }), /already_finalized/);
  });
});

test("incomplete or non-passing bundles never satisfy passing reads", async () => {
  await withRoot(async (root) => {
    const run = await beginEvidenceRun({ root, identity });
    await finalizeIncompleteEvidenceRun(run, { metadata: { cleanup: "failed" } });
    await assert.rejects(readPassedEvidence({ root, identity }), /bundle_not_passing/);
    const invalid = await beginEvidenceRun({ root, identity: { ...identity, runId: "run-002" } });
    await assert.rejects(finalizeEvidenceRun(invalid, { status: "incomplete", verdict: "passed" }), /bundle_invalid/);
  });
});

test("rejects unsafe identities, oversized metadata, and symlinked ancestors", async () => {
  await withRoot(async (root) => {
    await assert.rejects(beginEvidenceRun({ root, identity: { ...identity, actionId: "../escape" } }), /invalid_action_id/);
    const oversized = await beginEvidenceRun({ root, identity });
    await assert.rejects(finalizeEvidenceRun(oversized, { status: "complete", verdict: "passed", metadata: { value: "x".repeat(33 * 1024) } }), /bundle_invalid/);
    await rm(oversized.staging, { recursive: true, force: true });
    await rm(path.join(root, identity.gameId), { recursive: true, force: true });
    const outside = await mkdtemp(path.join(os.tmpdir(), "game-action-outside-"));
    await symlink(outside, path.join(root, identity.gameId), "junction");
    await assert.rejects(beginEvidenceRun({ root, identity }), /path_symlink/);
    await rm(outside, { recursive: true, force: true });
  });
});

test("reserves finalization before awaits and rejects malformed persisted bundles", async () => {
  await withRoot(async (root) => {
    const run = await beginEvidenceRun({ root, identity });
    const first = finalizeEvidenceRun(run, { status: "complete", verdict: "passed" });
    await assert.rejects(finalizeEvidenceRun(run, { status: "complete", verdict: "passed" }), /already_finalized/);
    await first;
    const bundlePath = path.join(root, identity.gameId, identity.actionId, identity.runId, "bundle.json");
    await writeFile(bundlePath, JSON.stringify({ schema: "gamebuddy-action-evidence/v1", identity, status: "complete", verdict: "passed", metadata: null, extra: true }));
    await assert.rejects(readPassedEvidence({ root, identity }), /bundle_invalid/);
  });
});

test("refuses query through a symlinked final directory or bundle leaf", async () => {
  await withRoot(async (root) => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "game-action-outside-"));
    const destination = path.join(root, identity.gameId, identity.actionId, identity.runId);
    await mkdir(path.dirname(destination), { recursive: true });
    await symlink(outside, destination, "junction");
    await assert.rejects(readPassedEvidence({ root, identity }), /path_symlink/);
    await rm(destination, { recursive: true, force: true });
    const run = await beginEvidenceRun({ root, identity });
    await finalizeEvidenceRun(run, { status: "complete", verdict: "passed" });
    const leafTarget = path.join(outside, "bundle.json");
    await writeFile(leafTarget, JSON.stringify({ schema: "gamebuddy-action-evidence/v1", identity, status: "complete", verdict: "passed", metadata: {} }));
    const leaf = path.join(root, identity.gameId, identity.actionId, identity.runId, "bundle.json");
    await rm(leaf);
    try {
      await symlink(leafTarget, leaf, "file");
    } catch (error) {
      await rm(outside, { recursive: true, force: true });
      if (error?.code !== "EPERM") throw error;
      return;
    }
    await assert.rejects(readPassedEvidence({ root, identity }), /path_symlink/);
    await rm(outside, { recursive: true, force: true });
  });
});

test("refuses staging replacement and persists the exact validated manifest bytes", async () => {
  await withRoot(async (root) => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "game-action-outside-"));
    const run = await beginEvidenceRun({ root, identity });
    await rm(run.staging, { recursive: true, force: true });
    await symlink(outside, run.staging, "junction");
    await assert.rejects(finalizeEvidenceRun(run, { status: "complete", verdict: "passed" }), /path_symlink/);
    await assert.rejects(readFile(path.join(outside, "bundle.json"), "utf8"), /ENOENT/);
    const changing = await beginEvidenceRun({ root, identity: { ...identity, runId: "run-003" } });
    let calls = 0;
    const metadata = { toJSON: () => (++calls === 1 ? { stable: true } : null) };
    const saved = await finalizeEvidenceRun(changing, { status: "complete", verdict: "passed", metadata });
    assert.deepEqual(saved.metadata, { stable: true });
    assert.equal((await readPassedEvidence({ root, identity: changing.identity })).metadata.stable, true);
    await rm(outside, { recursive: true, force: true });
  });
});
