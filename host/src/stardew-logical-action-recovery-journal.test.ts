import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { bindWindowsStaleLockReclaimer } from "./path-lock.js";
import { createTestWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.test-support.js";
import { StardewLogicalActionRecoveryJournal } from "./stardew-logical-action-recovery-journal.js";

type R = Parameters<StardewLogicalActionRecoveryJournal["prepare"]>[0];
const record = (id = "logical-1"): R => ({ logicalActionId: id, dispatchOrdinal: 1, ownerId: "owner", epoch: 2, requestId: `request-${id}`, idempotencyKey: `key-${id}`, actionId: "move_to_tile", canonicalArgs: { x: 1, y: 2 }, canonicalRequest: { requestId: `request-${id}`, idempotencyKey: `key-${id}`, action: "move_to_tile", args: { x: 1, y: 2 }, expectedRevision: 3, deadlineMs: 9999 }, expectedRevision: 3, deadlineMs: 9999, scope: { save: "s" }, bindingIdentity: { binding: "b" } });
const options = (directory: string) => ({ directory, ownerId: "owner", epoch: 2, scope: { save: "s" }, bindingIdentity: { binding: "b" } });
async function root() { return mkdtemp(join(tmpdir(), "gamebuddy-recovery-")); }

test("prepare is durable before return and reopens exact pending material", async () => {
  const dir = await root();
  try { const j = await StardewLogicalActionRecoveryJournal.open(options(dir)); const saved = await j.prepare(record()); assert.deepEqual(saved, j.record("logical-1")); await j.close(); const reopened = await StardewLogicalActionRecoveryJournal.open(options(dir)); assert.deepEqual(reopened.record("logical-1"), saved); assert.equal(reopened.recoverableRecords().length, 1); } finally { await rm(dir, { recursive: true, force: true }); }
});

test("transitions survive reopen", async () => {
  const dir = await root();
  try { const j = await StardewLogicalActionRecoveryJournal.open(options(dir)); await j.prepare(record()); await j.markSentUnknown("logical-1"); await j.markRecoveryPending("logical-1"); await j.close(); const reopened = await StardewLogicalActionRecoveryJournal.open(options(dir)); assert.equal(reopened.record("logical-1")?.state, "recovery_pending"); } finally { await rm(dir, { recursive: true, force: true }); }
});

test("malformed, duplicate, schema and scope data fail closed", async () => {
  const dir = await root();
  try {
    const path = join(dir, "stardew-logical-action-recovery-journal.json");
    await writeFile(path, "{\"schemaVersion\":99}"); await assert.rejects(() => StardewLogicalActionRecoveryJournal.open(options(dir)));
    await writeFile(path, "not-json"); await assert.rejects(() => StardewLogicalActionRecoveryJournal.open(options(dir)));
    await writeFile(path, JSON.stringify({ schemaVersion: 1, ownerId: "owner", epoch: 2, scope: { save: "s" }, bindingIdentity: { binding: "b" }, records: [{ ...record(), canonicalArgs: { x: 9, y: 2 } }] }));
    await assert.rejects(() => StardewLogicalActionRecoveryJournal.open(options(dir)));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("duplicate logical action and request IDs are rejected", async () => {
  const j = new StardewLogicalActionRecoveryJournal();
  await j.prepare(record("logical-1"));
  await assert.rejects(() => j.prepare(record("logical-1")), /duplicate_recovery_journal_record/);
  await assert.rejects(() => j.prepare({ ...record("logical-2"), requestId: "request-logical-1", canonicalRequest: { ...record("logical-2").canonicalRequest, requestId: "request-logical-1" } }), /duplicate_recovery_journal_record/);
});

test("open rejects scope and binding mismatches", async () => {
  const dir = await root();
  try {
    const j = await StardewLogicalActionRecoveryJournal.open(options(dir)); await j.prepare(record());
    await assert.rejects(() => StardewLogicalActionRecoveryJournal.open({ ...options(dir), scope: { save: "other" } }));
    await assert.rejects(() => StardewLogicalActionRecoveryJournal.open({ ...options(dir), bindingIdentity: { binding: "other" } }));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("two open instances merge durable mutations without lost updates", async () => {
  const dir = await root();
  try {
    const first = await StardewLogicalActionRecoveryJournal.open(options(dir));
    const second = await StardewLogicalActionRecoveryJournal.open(options(dir));
    await Promise.all([first.prepare(record("logical-1")), second.prepare({ ...record("logical-2"), dispatchOrdinal: 2 })]);
    const reopened = await StardewLogicalActionRecoveryJournal.open(options(dir));
    assert.deepEqual(reopened.records().map((r) => r.logicalActionId).sort(), ["logical-1", "logical-2"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("close prevents mutation", async () => {
  const j = new StardewLogicalActionRecoveryJournal(); await j.close();
  await assert.rejects(() => j.prepare(record()), /recovery_journal_closed/);
  await assert.rejects(() => j.markSentUnknown("logical-1"), /recovery_journal_closed/);
});

test("writer failure does not create a durable recoverable entry", async () => {
  const dir = await root();
  try { const j = new StardewLogicalActionRecoveryJournal({ write: async () => { throw new Error("disk"); } }); await assert.rejects(() => j.prepare(record())); assert.equal(j.records().length, 0); } finally { await rm(dir, { recursive: true, force: true }); }
});

test("journal document contains no receipt fields", async () => {
  const dir = await root();
  try { const j = await StardewLogicalActionRecoveryJournal.open(options(dir)); await j.prepare(record()); const text = await readFile(join(dir, "stardew-logical-action-recovery-journal.json"), "utf8"); for (const field of ["receipt", "executionId", "body"]) assert.equal(text.includes(field), false); } finally { await rm(dir, { recursive: true, force: true }); }
});


test("duplicate idempotency keys and dispatch ordinals are rejected", async () => {
  const j = new StardewLogicalActionRecoveryJournal();
  await j.prepare(record("logical-1"));
  await assert.rejects(
    () => j.prepare({
      ...record("logical-2"),
      idempotencyKey: "key-logical-1",
      canonicalRequest: { ...record("logical-2").canonicalRequest, idempotencyKey: "key-logical-1" },
    }),
    /duplicate_recovery_journal_record/,
  );
  await assert.rejects(() => j.prepare({ ...record("logical-2") }), /duplicate_recovery_journal_record/);
});

test("unknown nested request fields and mismatched canonical args fail closed", async () => {
  const dir = await root();
  try {
    const path = join(dir, "stardew-logical-action-recovery-journal.json");
    const base = record();
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        ownerId: "owner",
        epoch: 2,
        scope: { save: "s" },
        bindingIdentity: { binding: "b" },
        records: [
          {
            ...base,
            canonicalRequest: { ...base.canonicalRequest, receipt: { state: "succeeded" } },
          },
        ],
      }),
    );
    await assert.rejects(() => StardewLogicalActionRecoveryJournal.open(options(dir)), /invalid_recovery_journal_record/);

    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        ownerId: "owner",
        epoch: 2,
        scope: { save: "s" },
        bindingIdentity: { binding: "b" },
        records: [{ ...base, canonicalArgs: { x: 999, y: 2 } }],
      }),
    );
    await assert.rejects(() => StardewLogicalActionRecoveryJournal.open(options(dir)), /invalid_recovery_journal_record/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("open snapshots caller-owned scope and binding identity", async () => {
  const dir = await root();
  const scope = { save: "s" };
  const bindingIdentity = { binding: "b" };
  try {
    const j = await StardewLogicalActionRecoveryJournal.open({ ...options(dir), scope, bindingIdentity });
    scope.save = "other";
    bindingIdentity.binding = "other";
    await assert.rejects(
      () => j.prepare({ ...record("logical-2"), scope: { save: "other" }, bindingIdentity: { binding: "other" } }),
      /recovery_journal_scope_mismatch/,
    );
    assert.deepEqual(j.record("logical-1"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("serialized transitions cannot regress a terminal disk state", async () => {
  const dir = await root();
  try {
    const first = await StardewLogicalActionRecoveryJournal.open(options(dir));
    await first.prepare(record());
    const second = await StardewLogicalActionRecoveryJournal.open(options(dir));
    await first.markSentUnknown("logical-1");
    await first.markTerminalSettled("logical-1");
    await assert.rejects(() => second.markSentUnknown("logical-1"), /invalid_recovery_journal_transition/);
    const reopened = await StardewLogicalActionRecoveryJournal.open(options(dir));
    assert.equal(reopened.record("logical-1")?.state, "terminal_settled");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("initial document budget is enforced", async () => {
  const dir = await root();
  try {
    await assert.rejects(
      () => StardewLogicalActionRecoveryJournal.open({ ...options(dir), maxBytes: 1024, scope: { save: "x".repeat(2000) } }),
      /recovery_journal_budget_exceeded/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});


type LockRequest = Readonly<{ operation: "reclaim_stale_lock" | "release_owned_lock"; token?: string; root: string; segments: readonly string[] }>;
function testLockChild(): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  });
  child.stdin.on("data", (chunk: Buffer) => {
    const request = JSON.parse(chunk.toString("utf8")) as LockRequest;
    void (async () => {
      let result = "indeterminate";
      if (request.operation === "release_owned_lock") {
        try {
          const path = resolve(request.root, ...request.segments);
          const parsed = JSON.parse(await readFile(path, "utf8")) as { token?: unknown };
          if (parsed.token === request.token) {
            await rm(path, { force: true });
            result = "released";
          } else result = "kept_token_mismatch";
        } catch (error) {
          result = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "kept_not_regular";
        }
      }
      child.stdout.end(`${JSON.stringify({ schemaVersion: 1, result })}\n`);
      child.stderr.end();
      queueMicrotask(() => child.emit("close", 0, null));
    })();
  });
  return child as unknown as ChildProcess;
}

test.beforeEach(() => bindWindowsStaleLockReclaimer(createTestWindowsStaleLockReclaimer(testLockChild)));
test.after(() => bindWindowsStaleLockReclaimer(undefined));
