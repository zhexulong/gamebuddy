import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { withContinuitySurfaceTransitionLock } from "./continuity-transition-lock.js";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const lockTarget = (runtimeRoot: string, continuityId: string) =>
  join(
    runtimeRoot,
    ".gamebuddy-internal-locks",
    `continuity-surface-transition-${createHash("sha256").update(`gamebuddy:continuity-surface-transition-lock:v1\0${continuityId}`, "utf8").digest("hex")}`,
  );

async function createRuntimeRoot(): Promise<string> {
  return await realpath(await mkdtemp(join(await realpath(tmpdir()), "gamebuddy-continuity-transition-")));
}

async function removeRuntimeRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

test("continuity surface transition lock serializes competing callers without placing the opaque id in its path", async () => {
  const runtimeRoot = await createRuntimeRoot();
  try {
    const continuityId = "opaque_continuity_42";
    const order: string[] = [];
    const first = withContinuitySurfaceTransitionLock(runtimeRoot, continuityId, async () => {
      order.push("first-start");
      const entries = await readdir(join(runtimeRoot, ".gamebuddy-internal-locks"), { recursive: true });
      assert.equal(
        entries.some((entry) => entry.includes(continuityId)),
        false,
      );
      await delay(20);
      order.push("first-end");
    });
    await delay(1);
    const second = withContinuitySurfaceTransitionLock(runtimeRoot, continuityId, async () => {
      order.push("second");
    });

    await Promise.all([first, second]);
    assert.deepEqual(order, ["first-start", "first-end", "second"]);
  } finally {
    await removeRuntimeRoot(runtimeRoot);
  }
});

test("continuity surface transition lock rejects malformed root and continuity partition before work", async () => {
  let calls = 0;
  const work = async () => {
    calls += 1;
  };
  await assert.rejects(
    withContinuitySurfaceTransitionLock("", "opaque_continuity", work),
    /invalid_continuity_transition_runtime_root/,
  );
  await assert.rejects(
    withContinuitySurfaceTransitionLock("relative/root", "opaque_continuity", work),
    /invalid_continuity_transition_runtime_root/,
  );
  await assert.rejects(
    withContinuitySurfaceTransitionLock(join(tmpdir(), "gamebuddy-lock-root"), "not/a/key", work),
    /invalid_continuity_transition_partition/,
  );
  assert.equal(calls, 0);
});

test("continuity surface transition lock fails closed when its durable lock acquisition times out", async () => {
  const runtimeRoot = await createRuntimeRoot();
  try {
    const continuityId = "opaque_timeout_partition";
    const target = lockTarget(runtimeRoot, continuityId);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(`${target}.lock`, "malformed-owner", "utf8");

    await assert.rejects(
      withContinuitySurfaceTransitionLock(runtimeRoot, continuityId, async () =>
        assert.fail("work must not run without lock ownership"),
      ),
      /durable_path_lock_timeout/,
    );
  } finally {
    await removeRuntimeRoot(runtimeRoot);
  }
});
