import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { bindWindowsStaleLockReclaimer } from "./path-lock.js";
import { createTestWindowsStaleLockReclaimer } from "./windows-stale-lock-reclaimer/index.test-support.js";
import {
  StardewLogicalActionRecoveryJournal,
  type HostNodeAdmissionRecord,
  type NodeAdmissionChallenge,
} from "./stardew-logical-action-recovery-journal.js";

type R = Parameters<StardewLogicalActionRecoveryJournal["prepare"]>[0];
const record = (id = "logical-1"): R => ({ logicalActionId: id, dispatchOrdinal: 1, ownerId: "owner", epoch: 2, requestId: `request-${id}`, idempotencyKey: `key-${id}`, actionId: "move_to_tile", canonicalArgs: { x: 1, y: 2 }, canonicalRequest: { requestId: `request-${id}`, idempotencyKey: `key-${id}`, action: "move_to_tile", args: { x: 1, y: 2 }, expectedRevision: 3, deadlineMs: 9999 }, expectedRevision: 3, deadlineMs: 9999, scope: { save: "s" }, bindingIdentity: { binding: "b" } });
const admissionRecord = (id: string, ownerId: string, epoch: number, binding: string, dispatchOrdinal: number): R => ({
  ...record(id),
  ownerId,
  epoch,
  bindingIdentity: { binding },
  dispatchOrdinal,
});
const options = (directory: string) => ({ directory, scope: { save: "s" } });
const nodeChallenge = (overrides: Partial<NodeAdmissionChallenge> = {}): NodeAdmissionChallenge => ({
  programId: "program_01", nodeId: "node_01", nodeAttempt: 1, admissionAttempt: 1,
  stopEpoch: 1, scopeIdentity: { save: "s" }, policyIdentity: { identity: "mod-policy_01" },
  catalogRevision: "catalog_01", actionIdentity: "move_to_tile", canonicalBoundArgs: { x: 1, y: 2 },
  derivedResourceClaims: [{ resource: "actor" }], deadlineMs: 9_999, ...overrides,
});
const nodeAdmissionRecord = (
  challenge: NodeAdmissionChallenge = nodeChallenge(),
  grantId = "grant_01",
): HostNodeAdmissionRecord => ({
  challenge,
  state: "grant_issued",
  grant: {
    grantId, challenge, attachmentGeneration: "attachment_01", policyRevision: "host-policy_01",
    policyIdentity: challenge.policyIdentity, catalogRevision: challenge.catalogRevision,
  },
});
async function root() {
  const parent = process.platform === "win32" ? process.env.LOCALAPPDATA : tmpdir();
  if (typeof parent !== "string" || parent.length === 0) throw new Error("test_local_app_data_unavailable");
  return mkdtemp(join(await realpath(parent), "gamebuddy-recovery-"));
}

test("prepare is durable before return and reopens exact pending material", async () => {
  const dir = await root();
  try { const j = await StardewLogicalActionRecoveryJournal.open(options(dir)); const saved = await j.prepare(record()); assert.deepEqual(saved, j.record("logical-1")); await j.close(); const reopened = await StardewLogicalActionRecoveryJournal.open(options(dir)); assert.deepEqual(reopened.record("logical-1"), saved); assert.equal(reopened.recoverableRecords().length, 1); } finally { await rm(dir, { recursive: true, force: true }); }
});

test("stable scope reopens across Host lifecycles while retaining historical owners and epochs", async () => {
  const dir = await root();
  try {
    const first = await StardewLogicalActionRecoveryJournal.open(options(dir));
    const ownerA = await first.prepare(admissionRecord("logical-a", "owner-a", 7, "binding-a", 1));
    await first.close();

    const freshHost = await StardewLogicalActionRecoveryJournal.open(options(dir));
    const ownerB = await freshHost.prepare(admissionRecord("logical-b", "owner-b", 8, "binding-b", 2));
    assert.deepEqual(freshHost.records(), [ownerA, ownerB]);
    assert.equal(freshHost.record("logical-a")?.ownerId, "owner-a");
    assert.equal(freshHost.record("logical-a")?.epoch, 7);
    assert.equal(freshHost.record("logical-b")?.ownerId, "owner-b");
    assert.equal(freshHost.record("logical-b")?.epoch, 8);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("transitions survive reopen", async () => {
  const dir = await root();
  try { const j = await StardewLogicalActionRecoveryJournal.open(options(dir)); await j.prepare(record()); await j.markSentUnknown("logical-1"); await j.markRecoveryPending("logical-1"); await j.close(); const reopened = await StardewLogicalActionRecoveryJournal.open(options(dir)); assert.equal(reopened.record("logical-1")?.state, "recovery_pending"); } finally { await rm(dir, { recursive: true, force: true }); }
});

test("historical binding identities coexist and remain immutable across transitions", async () => {
  const dir = await root();
  try {
    const journal = await StardewLogicalActionRecoveryJournal.open(options(dir));
    const first = await journal.prepare(admissionRecord("logical-a", "owner-a", 7, "binding-a", 1));
    const second = await journal.prepare(admissionRecord("logical-b", "owner-b", 8, "binding-b", 2));
    const transitioned = await journal.markSentUnknown("logical-a");
    assert.equal(transitioned.bindingIdentity?.binding, "binding-a");
    assert.deepEqual(journal.record("logical-b"), second);

    const path = join(dir, "stardew-logical-action-recovery-journal.json");
    const document = JSON.parse(await readFile(path, "utf8")) as { records: Array<Record<string, unknown>> };
    document.records[0]!.bindingIdentity = { binding: "tampered" };
    await writeFile(path, JSON.stringify(document));
    await assert.rejects(() => journal.markRecoveryPending(first.logicalActionId), /invalid_recovery_journal_record/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("malformed, duplicate, schema and scope data fail closed", async () => {
  const dir = await root();
  try {
    const path = join(dir, "stardew-logical-action-recovery-journal.json");
    await writeFile(path, "{\"schemaVersion\":99}"); await assert.rejects(() => StardewLogicalActionRecoveryJournal.open(options(dir)));
    await writeFile(path, "not-json"); await assert.rejects(() => StardewLogicalActionRecoveryJournal.open(options(dir)));
    await writeFile(path, JSON.stringify({ schemaVersion: 1, ownerId: "owner", epoch: 2, scope: { save: "s" }, records: [] }));
    await assert.rejects(() => StardewLogicalActionRecoveryJournal.open(options(dir)), /invalid_recovery_journal_document/);
    await writeFile(path, JSON.stringify({ schemaVersion: 1, scope: { save: "s" }, records: [{ ...record(), canonicalArgs: { x: 9, y: 2 } }] }));
    await assert.rejects(() => StardewLogicalActionRecoveryJournal.open(options(dir)), /invalid_recovery_journal_record/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("NUL-bearing admission tuple members remain distinct and persist across reopen", async () => {
  const dir = await root();
  try {
    const journal = await StardewLogicalActionRecoveryJournal.open(options(dir));
    const firstChallenge = nodeChallenge({ programId: "program\u0000node", nodeId: "source" });
    const secondChallenge = nodeChallenge({ programId: "program", nodeId: "node\u0000source" });
    const first = nodeAdmissionRecord(firstChallenge);
    const second = nodeAdmissionRecord(secondChallenge, "grant_02");

    await journal.recordAdmission(first);
    await journal.recordAdmission(second);
    assert.deepEqual(journal.admissionRecord(firstChallenge), first);
    assert.deepEqual(journal.admissionRecord(secondChallenge), second);
    await journal.close();

    const reopened = await StardewLogicalActionRecoveryJournal.open(options(dir));
    assert.deepEqual(reopened.admissionRecord(firstChallenge), first);
    assert.deepEqual(reopened.admissionRecord(secondChallenge), second);
    assert.deepEqual(await reopened.recordAdmission(first), first);
    await reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("node admission persists the exact opaque Mod policy identity and rejects a mismatched grant", async () => {
  const dir = await root();
  try {
    const journal = await StardewLogicalActionRecoveryJournal.open(options(dir));
    const admission = await journal.recordAdmission(nodeAdmissionRecord());
    assert.deepEqual(admission.grant?.policyIdentity, { identity: "mod-policy_01" });
    await journal.close();

    const path = join(dir, "stardew-logical-action-recovery-journal.json");
    const reopened = await StardewLogicalActionRecoveryJournal.open(options(dir));
    assert.deepEqual(reopened.admissionRecord(nodeChallenge()), admission);
    await reopened.close();

    const document = JSON.parse(await readFile(path, "utf8")) as {
      admissionRecords: Array<{ grant?: { policyIdentity: Record<string, unknown> } }>;
    };
    document.admissionRecords[0]!.grant!.policyIdentity = { identity: "substituted" };
    await writeFile(path, JSON.stringify(document));
    await assert.rejects(() => StardewLogicalActionRecoveryJournal.open(options(dir)), /invalid_recovery_journal_record/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("duplicate logical action and request IDs are rejected", async () => {
  const j = new StardewLogicalActionRecoveryJournal();
  await j.prepare(record("logical-1"));
  await assert.rejects(() => j.prepare(record("logical-1")), /duplicate_recovery_journal_record/);
  await assert.rejects(() => j.prepare({ ...record("logical-2"), requestId: "request-logical-1", canonicalRequest: { ...record("logical-2").canonicalRequest, requestId: "request-logical-1" } }), /duplicate_recovery_journal_record/);
});

test("open rejects a changed stable scope", async () => {
  const dir = await root();
  try {
    const j = await StardewLogicalActionRecoveryJournal.open(options(dir)); await j.prepare(record());
    await assert.rejects(() => StardewLogicalActionRecoveryJournal.open({ ...options(dir), scope: { save: "other" } }), /invalid_recovery_journal_document/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("unscoped journal reopens only without a stable scope", async () => {
  const dir = await root();
  try {
    const unscoped = await StardewLogicalActionRecoveryJournal.open({ directory: dir });
    const { scope: _scope, ...unscopedRecord } = record();
    const prepared = await unscoped.prepare(unscopedRecord);
    await unscoped.close();

    const document = JSON.parse(await readFile(join(dir, "stardew-logical-action-recovery-journal.json"), "utf8")) as Record<string, unknown>;
    assert.equal(Object.hasOwn(document, "scope"), false);
    const reopened = await StardewLogicalActionRecoveryJournal.open({ directory: dir });
    assert.deepEqual(reopened.record(prepared.logicalActionId), prepared);
    await assert.rejects(
      () => StardewLogicalActionRecoveryJournal.open({ directory: dir, scope: { save: "s" } }),
      /invalid_recovery_journal_document/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
        scope: { save: "s" },
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
        scope: { save: "s" },
        records: [{ ...base, canonicalArgs: { x: 999, y: 2 } }],
      }),
    );
    await assert.rejects(() => StardewLogicalActionRecoveryJournal.open(options(dir)), /invalid_recovery_journal_record/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("open snapshots caller-owned stable scope", async () => {
  const dir = await root();
  const scope = { save: "s" };
  try {
    const j = await StardewLogicalActionRecoveryJournal.open({ ...options(dir), scope });
    scope.save = "other";
    await assert.rejects(
      () => j.prepare({ ...record("logical-2"), scope: { save: "other" } }),
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
