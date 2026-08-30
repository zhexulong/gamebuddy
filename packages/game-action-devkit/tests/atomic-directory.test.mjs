import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanupAtomicDirectory, commitAtomicDirectory, prepareAtomicDirectory } from "../src/atomic-directory.mjs";

async function cleanup(root) {
  const stack = [{ path: root, visited: false }];
  while (stack.length) {
    const item = stack.pop();
    const state = await lstat(item.path).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (!state) continue;
    if (!state.isDirectory() || state.isSymbolicLink()) { await unlink(item.path); continue; }
    if (!item.visited) {
      stack.push({ path: item.path, visited: true });
      for (const name of await readdir(item.path)) stack.push({ path: path.join(item.path, name), visited: false });
    } else await rmdir(item.path);
  }
}
async function withRoot(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "atomic-directory-"));
  try { await run(root); } finally { await cleanup(root); }
}

test("atomically publishes one exclusive directory", async () => withRoot(async (root) => {
  const output = path.join(root, "nested", "bundle");
  const transaction = await prepareAtomicDirectory(output);
  await writeFile(path.join(transaction.stagingPath, "receipt.json"), "{}");
  await commitAtomicDirectory(transaction);
  assert.deepEqual(await readdir(output), ["receipt.json"]);
  await assert.rejects(prepareAtomicDirectory(output), /atomic_directory_output_exists/);
}));

test("cleanup only accepts empty owned staging by default", async () => withRoot(async (root) => {
  const transaction = await prepareAtomicDirectory(path.join(root, "bundle"));
  await writeFile(path.join(transaction.stagingPath, "unexpected"), "x");
  await assert.rejects(cleanupAtomicDirectory(transaction), /atomic_directory_staging_not_empty/);
  await unlink(path.join(transaction.stagingPath, "unexpected"));
  await cleanupAtomicDirectory(transaction);
  await assert.rejects(lstat(transaction.stagingPath), { code: "ENOENT" });
}));

test("supports recursive cleanup and caller error codes", async () => withRoot(async (root) => {
  const transaction = await prepareAtomicDirectory(path.join(root, "bundle"), { code: "ci_snapshot" });
  await mkdir(path.join(transaction.stagingPath, "nested"));
  await writeFile(path.join(transaction.stagingPath, "nested", "unexpected"), "x");
  await cleanupAtomicDirectory(transaction, { recursive: true });
  await assert.rejects(lstat(transaction.stagingPath), { code: "ENOENT" });

  const missing = await prepareAtomicDirectory(path.join(root, "another", "bundle"), { code: "ci_snapshot", create: false });
  assert.equal(missing.stagingPath.endsWith(".staging-" + missing.stagingPath.split(".staging-").at(-1)), true);
  await assert.rejects(commitAtomicDirectory(missing), /ci_snapshot_temporary_output_invalid/);
}));
