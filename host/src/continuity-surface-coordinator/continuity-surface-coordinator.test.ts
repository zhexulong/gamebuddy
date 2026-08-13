import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createContinuitySurfaceCoordinator } from "./continuity-surface-coordinator.js";

test("coordinator runs callbacks only while held, rejects same-partition reentry, and permits another partition", async () => {
  const coordinator = createContinuitySurfaceCoordinator(await mkdtemp(join(tmpdir(), "coordinator-")));
  let called = false;
  await coordinator.withTransition("continuity_01", async () => {
    called = true;
    await assert.rejects(
      coordinator.withTransition("continuity_01", async () => undefined),
      /reentrant/,
    );
    await coordinator.withTransition("continuity_02", async () => undefined);
  });
  assert.equal(called, true);
});

test("separate durable coordinator instances serialize one continuity partition", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "coordinator-shared-"));
  const first = createContinuitySurfaceCoordinator(runtimeRoot);
  const second = createContinuitySurfaceCoordinator(runtimeRoot);
  let entered = 0;
  let releaseFirst!: () => void;
  const firstReleased = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const firstRun = first.withTransition("continuity_shared", async () => {
    entered++;
    await firstReleased;
  });
  while (entered !== 1) await new Promise((resolve) => setImmediate(resolve));
  let secondEntered = false;
  const secondRun = second.withTransition("continuity_shared", async () => {
    secondEntered = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondEntered, false);
  releaseFirst();
  await Promise.all([firstRun, secondRun]);
  assert.equal(secondEntered, true);
});

test("coordinator permits independent durable continuity partitions concurrently", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "coordinator-independent-"));
  const first = createContinuitySurfaceCoordinator(runtimeRoot);
  const second = createContinuitySurfaceCoordinator(runtimeRoot);
  let entered = 0;
  const barrier = new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (entered === 2) {
        clearInterval(timer);
        resolve();
      }
    }, 1);
  });
  const runs = Promise.all([
    first.withTransition("continuity_a", async () => {
      entered++;
      await barrier;
    }),
    second.withTransition("continuity_b", async () => {
      entered++;
      await barrier;
    }),
  ]);
  await runs;
  assert.equal(entered, 2);
});

test("coordinator never invokes callback when lock acquisition fails", async () => {
  const coordinator = createContinuitySurfaceCoordinator("\0invalid");
  let called = false;
  await assert.rejects(
    coordinator.withTransition("continuity_01", async () => {
      called = true;
    }),
    /invalid_continuity_transition_runtime_root/,
  );
  assert.equal(called, false);
});
