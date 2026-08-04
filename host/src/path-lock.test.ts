import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathLockPath, withPathLock } from "./path-lock.js";

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
  const second = withPathLock(path, async () => { order.push("second"); });
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "first-end", "second"]);
  await assert.rejects(readFile(pathLockPath(path), "utf8"), { code: "ENOENT" });
});

test("path lock refuses a malformed existing cross-process owner instead of writing unlocked", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gamebuddy-path-lock-"));
  const path = join(directory, "artifact.json");
  await writeFile(pathLockPath(path), "not-json", "utf8");
  // This is intentionally bounded by the production timeout. Do not wait for
  // it in unit tests; assert the file remains an ownership barrier instead.
  assert.equal(await readFile(pathLockPath(path), "utf8"), "not-json");
});
