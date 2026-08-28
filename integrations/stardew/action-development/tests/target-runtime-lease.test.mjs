import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireTargetRuntimeLease } from "../src/target-runtime-lease.mjs";

const LOCK_NAME = ".gamebuddy-target-runtime-lease-v1";

async function withRoot(run) {
  const parent = await mkdtemp(path.join(tmpdir(), "stardew-target-runtime-lease-"));
  const root = path.join(parent, "target");
  await mkdir(root);
  try { await run({ parent, root }); } finally { await rm(parent, { recursive: true, force: true }); }
}

async function rejectsCode(operation, code) {
  await assert.rejects(operation, (error) => error instanceof Error && error.message === `stardew_target_runtime_lease_${code}`);
}

test("acquires one content-free exclusive lease and releases it for a later run", async () => {
  await withRoot(async ({ root }) => {
    const lease = await acquireTargetRuntimeLease({ root, identity: "run-001" });
    assert.deepEqual(lease.inspect(), { version: 1, identity: "run-001", released: false });
    assert.equal((await lstat(path.join(root, LOCK_NAME))).isDirectory(), true);
    assert.deepEqual(await readdir(path.join(root, LOCK_NAME)), []);

    await rejectsCode(() => acquireTargetRuntimeLease({ root, identity: "run-002" }), "owned");
    await lease.release();
    assert.deepEqual(lease.inspect(), { version: 1, identity: "run-001", released: true });
    await rejectsCode(() => lease.release(), "released");

    const next = await acquireTargetRuntimeLease({ root, identity: "run-002" });
    await next.release();
  });
});

test("fails closed on existing unknown or malformed lock ownership", async () => {
  await withRoot(async ({ root }) => {
    await writeFile(path.join(root, LOCK_NAME), "unknown owner", "utf8");
    await rejectsCode(() => acquireTargetRuntimeLease({ root, identity: "run-file" }), "owned");
  });
  await withRoot(async ({ root }) => {
    await mkdir(path.join(root, LOCK_NAME));
    await writeFile(path.join(root, LOCK_NAME, "owner"), "malformed", "utf8");
    await rejectsCode(() => acquireTargetRuntimeLease({ root, identity: "run-dir" }), "owned");
  });
});

test("rejects untrusted symlink roots and lock paths", async (t) => {
  if (process.platform === "win32") {
    t.skip("creating symlinks requires privileges on Windows");
    return;
  }
  await withRoot(async ({ parent, root }) => {
    const linkedRoot = path.join(parent, "linked-target");
    await symlink(root, linkedRoot, "dir");
    await rejectsCode(() => acquireTargetRuntimeLease({ root: linkedRoot, identity: "run-link-root" }), "untrusted_path");
  });
  await withRoot(async ({ parent, root }) => {
    const elsewhere = path.join(parent, "elsewhere");
    await mkdir(elsewhere);
    await symlink(elsewhere, path.join(root, LOCK_NAME), "dir");
    await rejectsCode(() => acquireTargetRuntimeLease({ root, identity: "run-link-lock" }), "owned");
  });
});

test("validates bounded run identity and an existing directory root", async () => {
  await withRoot(async ({ root }) => {
    for (const identity of ["", " contains-space", "../escape", "x".repeat(129)]) {
      await rejectsCode(() => acquireTargetRuntimeLease({ root, identity }), "invalid_identity");
    }
    await rejectsCode(() => acquireTargetRuntimeLease({ root: path.join(root, "missing"), identity: "run-valid" }), "untrusted_path");
  });
});

test("release fails closed if the lock path was replaced", async () => {
  await withRoot(async ({ root }) => {
    const lease = await acquireTargetRuntimeLease({ root, identity: "run-replaced" });
    await rmdir(path.join(root, LOCK_NAME));
    await mkdir(path.join(root, LOCK_NAME));
    await rejectsCode(() => lease.release(), "ownership_lost");
  });
});
