import assert from "node:assert/strict";
import test from "node:test";
import { createSerialDrain } from "./serial-drain";

/**
 * The queue's two promises, both of which the shell's stream depends on.
 *
 * (a) Tasks run one at a time, in the order they were pushed, however fast the caller pushes them - a
 * burst of frames must not interleave their authoritative reads. (b) A task that rejects does not stop
 * the drain: the later tasks still run, and the rejection reaches `onFailed` instead of the queue.
 */

/** A promise, its resolver, and the task that waits on it - the fill/drain pair, driven by hand. */
function gate(): Readonly<{ wait: Promise<void>; open: () => void }> {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

test("a drain slower than the fill still runs every task, in order", async () => {
  const failed: string[] = [];
  const drain = createSerialDrain(() => failed.push("failed"));
  const steps: string[] = [];
  const first = gate();
  drain.push(async () => {
    steps.push("first:start");
    await first.wait;
    steps.push("first:end");
  });
  drain.push(async () => {
    steps.push("second");
  });
  drain.push(async () => {
    steps.push("third");
  });
  // Nothing after the first task has started while it is still waiting: one slot, not three.
  await Promise.resolve();
  assert.deepEqual(steps, ["first:start"]);
  first.open();
  await drain.drained();
  assert.deepEqual(steps, ["first:start", "first:end", "second", "third"]);
  assert.deepEqual(failed, []);
});

test("a rejected task is reported and the drain keeps running", async () => {
  const failed: string[] = [];
  const drain = createSerialDrain(() => failed.push("failed"));
  const steps: string[] = [];
  drain.push(async () => {
    steps.push("throws");
    throw new Error("readChatSnapshotPair failed");
  });
  drain.push(async () => {
    steps.push("after");
  });
  await drain.drained();
  assert.deepEqual(steps, ["throws", "after"]);
  assert.deepEqual(failed, ["failed"]);
});

test("a failing handler does not stop the drain either", async () => {
  const drain = createSerialDrain(() => {
    throw new Error("the recovery itself threw");
  });
  const steps: string[] = [];
  drain.push(async () => {
    throw new Error("first");
  });
  drain.push(async () => {
    steps.push("second");
  });
  await drain.drained();
  assert.deepEqual(steps, ["second"]);
});

test("a task pushed from inside a task is queued behind the rest", async () => {
  const drain = createSerialDrain(() => undefined);
  const steps: string[] = [];
  drain.push(async () => {
    steps.push("outer");
    drain.push(async () => {
      steps.push("inner");
    });
  });
  drain.push(async () => {
    steps.push("sibling");
  });
  await drain.drained();
  assert.deepEqual(steps, ["outer", "sibling", "inner"]);
});
