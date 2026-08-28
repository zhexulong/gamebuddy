import assert from "node:assert/strict";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { beginEvidenceRun, finalizeEvidenceRun, finalizeIncompleteEvidenceRun, readEvidenceStatus, readLatestEvidenceStatus, readPassedEvidence } from "../src/evidence.mjs";

const identity = { gameId: "stardew", actionId: "equip_tool", runId: "run-001" };

async function removeTreeWithoutFollowingLinks(target) {
  const pending = [{ target, visited: false }];
  let operations = 0;
  while (pending.length > 0) {
    if (++operations > 10_000) throw new Error("evidence_test_cleanup_did_not_converge");
    const current = pending.pop();
    let stat;
    try {
      stat = await lstat(current.target);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      await unlink(current.target);
      continue;
    }
    if (current.visited) {
      try {
        await rmdir(current.target);
        continue;
      } catch (error) {
        if (error?.code !== "ENOTEMPTY") throw error;
      }
    }
    pending.push({ target: current.target, visited: true });
    for (const name of await readdir(current.target)) {
      pending.push({ target: path.join(current.target, name), visited: false });
    }
  }
}

async function withRoot(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "game-action-evidence-"));
  try { await callback(root); } finally { await removeTreeWithoutFollowingLinks(root); }
}

test("first run safely creates a missing evidence root while status remains read-only", async () => {
  await withRoot(async (parent) => {
    const root = path.join(parent, "owned", "action-runs");
    assert.deepEqual(await readLatestEvidenceStatus({ root, gameId: "stardew", actionId: "equip_tool" }), {
      availability: "unavailable",
      reason: "missing",
    });
    await assert.rejects(access(root), /ENOENT/);

    const firstIdentity = { ...identity, runId: "ar1_first_create" };
    const secondIdentity = { ...identity, runId: "ar1_second_create" };
    const [first, second] = await Promise.all([
      beginEvidenceRun({ root, identity: firstIdentity }),
      beginEvidenceRun({ root, identity: secondIdentity }),
    ]);
    assert.notEqual(first.staging, second.staging);
    await finalizeEvidenceRun(first, { status: "complete", verdict: "passed" });
    await finalizeIncompleteEvidenceRun(second, { verdict: "uncertain" });
  });
});

test("first run rejects a symlinked evidence root leaf", async (context) => {
  await withRoot(async (parent) => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "game-action-evidence-outside-"));
    const root = path.join(parent, "action-runs");
    try {
      await symlink(outside, root, "junction");
    } catch (error) {
      await rmdir(outside);
      if (error?.code === "EPERM") {
        context.skip("Windows symlink capability unavailable");
        return;
      }
      throw error;
    }
    await assert.rejects(beginEvidenceRun({ root, identity }), /path_symlink/);
    await rmdir(outside);
  });
});

test("read-only status rejects an intermediate symlink in an existing evidence root", async (context) => {
  await withRoot(async (parent) => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "game-action-evidence-outside-"));
    const linked = path.join(parent, "linked");
    await mkdir(path.join(outside, "action-runs"));
    try {
      await symlink(outside, linked, "junction");
    } catch (error) {
      await rmdir(path.join(outside, "action-runs"));
      await rmdir(outside);
      if (error?.code === "EPERM") {
        context.skip("Windows symlink capability unavailable");
        return;
      }
      throw error;
    }
    await assert.rejects(
      readLatestEvidenceStatus({ root: path.join(linked, "action-runs"), gameId: "stardew", actionId: "equip_tool" }),
      /path_symlink/,
    );
    await rmdir(path.join(outside, "action-runs"));
    await rmdir(outside);
  });
});

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

test("two attempts have distinct final destinations and latest selects the newest validated run", async () => {
  await withRoot(async (root) => {
    const firstIdentity = { ...identity, runId: "ar1_first" };
    const secondIdentity = { ...identity, runId: "ar1_second" };
    const first = await finalizeEvidenceRun(await beginEvidenceRun({ root, identity: firstIdentity }), { status: "complete", verdict: "passed" });
    const second = await finalizeIncompleteEvidenceRun(await beginEvidenceRun({ root, identity: secondIdentity }), { verdict: "uncertain" });
    assert.notEqual(first.directory, second.directory);
    assert.deepEqual(await readLatestEvidenceStatus({ root, gameId: "stardew", actionId: "equip_tool" }), {
      availability: "available", schema: "gamebuddy-action-evidence/v1", identity: secondIdentity,
      status: "incomplete", verdict: "uncertain", metadata: {},
    });
  });
});

test("latest observation reports missing and corrupt without scanning or throwing", async () => {
  await withRoot(async (root) => {
    assert.deepEqual(await readLatestEvidenceStatus({ root, gameId: "stardew", actionId: "equip_tool" }), { availability: "unavailable", reason: "missing" });
    const actionRoot = path.join(root, "stardew", "equip_tool");
    await mkdir(actionRoot, { recursive: true });
    await writeFile(path.join(actionRoot, "latest.json"), "not-json");
    assert.deepEqual(await readLatestEvidenceStatus({ root, gameId: "stardew", actionId: "equip_tool" }), { availability: "unavailable", reason: "corrupt" });
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

test("validated status reads preserve non-passing terminal evidence without projecting passed", async () => {
  await withRoot(async (root) => {
    const run = await beginEvidenceRun({ root, identity });
    await finalizeIncompleteEvidenceRun(run, { metadata: { cleanup: "failed" } });
    assert.deepEqual(await readEvidenceStatus({ root, identity }), {
      schema: "gamebuddy-action-evidence/v1",
      identity,
      status: "incomplete",
      verdict: "uncertain",
      metadata: { cleanup: "failed" },
    });
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
    await removeTreeWithoutFollowingLinks(oversized.staging);
    await removeTreeWithoutFollowingLinks(path.join(root, identity.gameId));
    const outside = await mkdtemp(path.join(os.tmpdir(), "game-action-outside-"));
    await symlink(outside, path.join(root, identity.gameId), "junction");
    await assert.rejects(beginEvidenceRun({ root, identity }), /path_symlink/);
    await removeTreeWithoutFollowingLinks(outside);
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
    await assert.rejects(readEvidenceStatus({ root, identity }), /bundle_invalid/);
    await assert.rejects(readPassedEvidence({ root, identity }), /bundle_invalid/);
  });
});

test("refuses query through a symlinked final directory or bundle leaf", async () => {
  await withRoot(async (root) => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "game-action-outside-"));
    const destination = path.join(root, identity.gameId, identity.actionId, identity.runId);
    await mkdir(path.dirname(destination), { recursive: true });
    await symlink(outside, destination, "junction");
    await assert.rejects(readEvidenceStatus({ root, identity }), /path_symlink/);
    await assert.rejects(readPassedEvidence({ root, identity }), /path_symlink/);
    await unlink(destination);
    const run = await beginEvidenceRun({ root, identity });
    await finalizeEvidenceRun(run, { status: "complete", verdict: "passed" });
    const leafTarget = path.join(outside, "bundle.json");
    await writeFile(leafTarget, JSON.stringify({ schema: "gamebuddy-action-evidence/v1", identity, status: "complete", verdict: "passed", metadata: {} }));
    const leaf = path.join(root, identity.gameId, identity.actionId, identity.runId, "bundle.json");
    await unlink(leaf);
    try {
      await symlink(leafTarget, leaf, "file");
    } catch (error) {
      await removeTreeWithoutFollowingLinks(outside);
      if (error?.code !== "EPERM") throw error;
      return;
    }
    await assert.rejects(readEvidenceStatus({ root, identity }), /path_symlink/);
    await assert.rejects(readPassedEvidence({ root, identity }), /path_symlink/);
    await removeTreeWithoutFollowingLinks(outside);
  });
});

test("refuses staging replacement and persists the exact validated manifest bytes", async () => {
  await withRoot(async (root) => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "game-action-outside-"));
    const run = await beginEvidenceRun({ root, identity });
    await removeTreeWithoutFollowingLinks(run.staging);
    await symlink(outside, run.staging, "junction");
    await assert.rejects(finalizeEvidenceRun(run, { status: "complete", verdict: "passed" }), /path_symlink/);
    await assert.rejects(readFile(path.join(outside, "bundle.json"), "utf8"), /ENOENT/);
    const changing = await beginEvidenceRun({ root, identity: { ...identity, runId: "run-003" } });
    let calls = 0;
    const metadata = { toJSON: () => (++calls === 1 ? { stable: true } : null) };
    const saved = await finalizeEvidenceRun(changing, { status: "complete", verdict: "passed", metadata });
    assert.deepEqual(saved.metadata, { stable: true });
    assert.equal((await readPassedEvidence({ root, identity: changing.identity })).metadata.stable, true);
    await removeTreeWithoutFollowingLinks(outside);
  });
});


test("first run rejects a regular-file evidence path component", async () => {
  await withRoot(async (parent) => {
    const component = path.join(parent, "owned");
    await writeFile(component, "not-a-directory", { flag: "wx" });
    await assert.rejects(
      beginEvidenceRun({ root: path.join(component, "action-runs"), identity }),
      /path_symlink/,
    );
  });
});
