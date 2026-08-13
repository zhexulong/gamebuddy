import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathLockPath, readSafeDirectory, withPathLock } from "./path-lock.js";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

test("path lock serializes local callers and removes its ownership file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-path-lock-"));
  const path = join(directory, "artifact.json");
  const order: string[] = [];
  const first = withPathLock(path, async () => {
    order.push("first-start");
    await delay(15);
    order.push("first-end");
  });
  await delay(1);
  const second = withPathLock(path, async () => {
    order.push("second");
  });
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "first-end", "second"]);
  await assert.rejects(readFile(pathLockPath(path), "utf8"), { code: "ENOENT" });
});

test("path lock rejects a symlink parent before creating its lock directory", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-path-lock-symlink-"));
  const realParent = join(directory, "real");
  const linkedParent = join(directory, "linked");
  const path = join(linkedParent, "nested", "artifact.json");
  await mkdir(realParent);
  try {
    try {
      await symlink(realParent, linkedParent, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (process.platform === "win32" && error instanceof Error && "code" in error && ["EPERM", "EACCES", "ENOTSUP"].includes(String(error.code))) {
        t.skip("Windows junction fixture creation is unsupported");
        return;
      }
      throw error;
    }
    await assert.rejects(withPathLock(path, async () => undefined), /unsafe_path_boundary/);
    await assert.rejects(lstat(join(realParent, "nested")), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("path lock rejects a parent replaced with a symlink before acquisition", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-path-lock-replaced-"));
  const parent = join(directory, "parent");
  const moved = join(directory, "moved");
  const path = join(parent, "artifact.json");
  await mkdir(parent);
  await rename(parent, moved);
  try {
    try {
      await symlink(moved, parent, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (process.platform === "win32" && error instanceof Error && "code" in error && ["EPERM", "EACCES", "ENOTSUP"].includes(String(error.code))) {
        t.skip("Windows junction fixture creation is unsupported");
        return;
      }
      throw error;
    }
    await assert.rejects(withPathLock(path, async () => undefined), /unsafe_path_boundary/);
    await assert.rejects(lstat(pathLockPath(path)), { code: "ENOENT" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("path lock refuses a malformed existing cross-process owner instead of writing unlocked", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-path-lock-"));
  try {
    const path = join(directory, "artifact.json");
    await writeFile(pathLockPath(path), "not-json", "utf8");
    await assert.rejects(withPathLock(path, async () => undefined, { timeoutMs: 25 }), /durable_path_lock_timeout/);
    assert.equal(await readFile(pathLockPath(path), "utf8"), "not-json");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("safe directory enumeration rejects linked entries before returning them", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-safe-directory-"));
  const outside = await mkdtemp(join(tmpdir(), "gamebuddy-safe-directory-outside-"));
  try {
    await writeFile(join(directory, "valid.json"), "ok", "utf8");
    try {
      await symlink(outside, join(directory, "linked"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (process.platform === "win32" && error instanceof Error && "code" in error && ["EPERM", "EACCES", "ENOTSUP"].includes(String(error.code))) {
        t.skip("Windows junction fixture creation is unsupported");
        return;
      }
      throw error;
    }
    await assert.rejects(readSafeDirectory(directory, directory), /unsafe_path_boundary/);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
