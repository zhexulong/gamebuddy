import assert from "node:assert/strict";
import test from "node:test";
import {
  authorityRootMutexName,
  createWindowsAuthorityRootMutex,
  type WindowsPartitionMutexBroker,
} from "./windows-partition-mutex.js";

const rootIdentity = "a".repeat(64);

function fake(disposition: "acquired" | "abandoned" = "acquired") {
  const calls: string[] = [];
  let releaseError = false;
  const broker: WindowsPartitionMutexBroker = {
    async acquire(name) {
      calls.push(`acquire:${name}`);
      return {
        disposition,
        async release() {
          calls.push("release");
          if (releaseError) throw new Error("release");
        },
        async safetySealAfterAbandonedQuarantineFailure() {
          calls.push("seal");
        },
      };
    },
    async close() {
      calls.push("close");
    },
  };
  return {
    calls,
    broker,
    failRelease: () => {
      releaseError = true;
    },
  };
}

test("derives a root-scoped legal mutex name without continuity IDs", () => {
  const name = authorityRootMutexName(rootIdentity);
  assert.match(name, /^Local\\GameBuddy\.Host\.semantic-authority-root-v2-[a-f0-9]{64}$/);
  assert.doesNotMatch(name, /continuity/);
});

test("runs synchronous section and always releases", async () => {
  const h = fake();
  const mutex = createWindowsAuthorityRootMutex(h.broker, { timeoutMs: 7 });
  assert.equal(await mutex.runExclusive(rootIdentity, (disposition) => disposition), "acquired");
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1], "release");
});

test("rejects a delayed real Promise without release, seals exactly once, and poisons future work", async () => {
  const h = fake();
  const mutex = createWindowsAuthorityRootMutex(h.broker);
  let resolve!: () => void;
  const delayed = new Promise<void>((done) => {
    resolve = done;
  });
  await assert.rejects(
    mutex.runExclusive(rootIdentity, () => delayed),
    /async_partition_mutex_section_rejected/,
  );
  assert.deepEqual(h.calls.slice(-1), ["seal"]);
  resolve();
  await assert.rejects(
    mutex.runExclusive(rootIdentity, () => "never"),
    /windows_partition_mutex_containment_failed/,
  );
  assert.equal(h.calls.filter((call) => call === "seal").length, 1);
  assert.equal(h.calls.filter((call) => call === "release").length, 0);
});

test("rejects an exotic thenable without invoking its getter", async () => {
  const h = fake();
  const mutex = createWindowsAuthorityRootMutex(h.broker);
  const exotic = Object.defineProperty({}, "then", {
    get() {
      throw new Error("getter must not run");
    },
  });
  await assert.rejects(
    mutex.runExclusive(rootIdentity, () => exotic),
    /async_partition_mutex_section_rejected/,
  );
  assert.deepEqual(h.calls.slice(-1), ["seal"]);
  assert.equal(h.calls.includes("release"), false);
});

test("release failure overrides a successful section", async () => {
  const h = fake();
  h.failRelease();
  await assert.rejects(
    createWindowsAuthorityRootMutex(h.broker).runExclusive(rootIdentity, () => "done"),
    /windows_partition_mutex_containment_failed/,
  );
});

test("preserves the section error when release also fails", async () => {
  const h = fake();
  h.failRelease();
  const primary = new Error("primary");
  await assert.rejects(
    createWindowsAuthorityRootMutex(h.broker).runExclusive(rootIdentity, () => {
      throw primary;
    }),
    primary,
  );
});

test("preserves abandoned disposition", async () => {
  const h = fake("abandoned");
  assert.equal(
    await createWindowsAuthorityRootMutex(h.broker).runExclusive(rootIdentity, (value) => value),
    "abandoned",
  );
});

test("closing one adapter does not close its caller-owned shared broker", async () => {
  const h = fake();
  const first = createWindowsAuthorityRootMutex(h.broker);
  const second = createWindowsAuthorityRootMutex(h.broker);
  await first.close();
  assert.deepEqual(h.calls, []);
  await second.runExclusive(rootIdentity, () => "still-open");
  assert.match(h.calls.at(-2)!, /^acquire:Local\\GameBuddy\.Host\.semantic-authority-root-v2-[a-f0-9]{64}$/);
  assert.equal(h.calls.at(-1), "release");
});
