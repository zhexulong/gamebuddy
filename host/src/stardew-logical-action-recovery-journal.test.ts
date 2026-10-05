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
} from "./stardew-logical-action-recovery-journal.js";
import { HostNodeAdmissionService } from "./action-execution-coordinator.internal.js";
import { validateBodyNodeAdmissionPayload, type BodyNodeAdmissionChallenge } from "./protocol.js";

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
const nodeChallenge = (overrides: Partial<BodyNodeAdmissionChallenge> = {}): BodyNodeAdmissionChallenge => ({
  programId: "program_01", nodeId: "node_01", nodeAttempt: 1, admissionAttempt: 1,
  stopEpoch: 1, catalogRevision: 11, policyIdentity: { value: "mod-policy_01", capabilityRevision: 7 },
  actionId: "move_to_tile",
  canonicalBoundArgs: { x: { type: "integer", canonicalValue: "1" }, y: { type: "integer", canonicalValue: "2" } },
  derivedResourceClaims: { actor: "embodied_actor" }, deadlineMs: 9_999, ...overrides,
});
const nodeAdmissionRecord = (
  challenge: BodyNodeAdmissionChallenge = nodeChallenge(),
  grantId = "grant_01",
): HostNodeAdmissionRecord => ({
  challenge,
  state: "grant_issued",
    grant: {
      ...challenge,
      grantId, attachmentGeneration: "attachment_01", policyRevision: "host-policy_01",
      executionBinding: null,
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

test("admission payload validation is independent of envelope scope", async () => {
  const challenge = nodeChallenge();
  const grant = nodeAdmissionRecord(challenge).grant!;
  assert.equal(validateBodyNodeAdmissionPayload(challenge), null);
  assert.equal(validateBodyNodeAdmissionPayload(grant, true), null);

  const journal = new StardewLogicalActionRecoveryJournal();
  assert.deepEqual(await journal.recordAdmission(nodeAdmissionRecord(challenge)), nodeAdmissionRecord(challenge));
});

test("JSON-owned __proto__ admission map keys fail validation before journal canonicalization", async () => {
  const challenges: BodyNodeAdmissionChallenge[] = [
    JSON.parse(JSON.stringify({
      ...nodeChallenge(),
      canonicalBoundArgs: Object.fromEntries([
        ["__proto__", { type: "string", canonicalValue: "identity-loss" }],
        ["x", { type: "integer", canonicalValue: "1" }],
      ]),
    })),
    JSON.parse(JSON.stringify({
      ...nodeChallenge(),
      derivedResourceClaims: Object.fromEntries([
        ["__proto__", "forged_claim"],
        ["actor", "embodied_actor"],
      ]),
    })),
  ];

  for (const challenge of challenges) {
    const map = Object.hasOwn(challenge.canonicalBoundArgs, "__proto__")
      ? challenge.canonicalBoundArgs
      : challenge.derivedResourceClaims;
    assert.equal(Object.hasOwn(map, "__proto__"), true);
    assert.notEqual(validateBodyNodeAdmissionPayload(challenge), null);

    const journal = new StardewLogicalActionRecoveryJournal();
    await assert.rejects(
      () => journal.recordAdmission({ challenge, state: "admission_rejected", rejectionCode: "invalid_payload" }),
      /invalid_recovery_journal_record/,
    );
    assert.equal(Object.hasOwn(map, "__proto__"), true);
    assert.throws(() => journal.admissionRecord(challenge), /node_admission_challenge_mismatch/);
  }
});

test("admissionRecord rejects a JSON-owned __proto__ challenge before replay lookup", async () => {
  const validChallenge = nodeChallenge();
  const maliciousChallenge: BodyNodeAdmissionChallenge = JSON.parse(JSON.stringify({
    ...validChallenge,
    canonicalBoundArgs: Object.fromEntries([
      ...Object.entries(validChallenge.canonicalBoundArgs),
      ["__proto__", { type: "string", canonicalValue: "identity-loss" }],
    ]),
  }));
  assert.equal(Object.hasOwn(maliciousChallenge.canonicalBoundArgs, "__proto__"), true);
  assert.notEqual(validateBodyNodeAdmissionPayload(maliciousChallenge), null);

  const journal = new StardewLogicalActionRecoveryJournal();
  const grant = await journal.recordAdmission(nodeAdmissionRecord(validChallenge));
  assert.deepEqual(journal.admissionRecord(validChallenge), grant);
  assert.throws(() => journal.admissionRecord(maliciousChallenge), /node_admission_challenge_mismatch/);
  assert.deepEqual(journal.admissionRecord(validChallenge), grant);

  const service = new HostNodeAdmissionService(journal, () => ({
    result: "granted",
    attachmentGeneration: "attachment_02",
    policyRevision: "host-policy_02",
  }));
  assert.deepEqual(await service.admit(maliciousChallenge), { result: "rejected", code: "policy_identity_mismatch" });
});

test("malformed NUL-bearing wire admission tuple members are rejected", async () => {
  const journal = new StardewLogicalActionRecoveryJournal();
  const malformed = nodeAdmissionRecord(nodeChallenge({ programId: "program\u0000node" }));
  await assert.rejects(() => journal.recordAdmission(malformed), /invalid_recovery_journal_record/);
  assert.throws(() => journal.admissionRecord(malformed.challenge), /node_admission_challenge_mismatch/);
});

test("admission grants reject the legacy nested challenge wire shape", async () => {
  const journal = new StardewLogicalActionRecoveryJournal();
  const valid = nodeAdmissionRecord();
  const legacyNestedGrant = {
    ...valid,
    grant: { ...valid.grant!, challenge: valid.challenge },
  } as unknown as HostNodeAdmissionRecord;
  await assert.rejects(() => journal.recordAdmission(legacyNestedGrant), /invalid_recovery_journal_record/);
});

test("normal recovery writes preserve durable admission records across reopen", async () => {
  const dir = await root();
  try {
    const journal = await StardewLogicalActionRecoveryJournal.open(options(dir));
    const admission = await journal.recordAdmission(nodeAdmissionRecord());
    const prepared = await journal.prepare(record());
    const transitioned = await journal.markSentUnknown(prepared.logicalActionId);
    await journal.close();

    const reopened = await StardewLogicalActionRecoveryJournal.open(options(dir));
    assert.deepEqual(reopened.admissionRecord(nodeChallenge()), admission);
    assert.deepEqual(reopened.record(prepared.logicalActionId), transitioned);
    await reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejected admission persists and reopens as a terminal transport decision", async () => {
  const dir = await root();
  try {
    const journal = await StardewLogicalActionRecoveryJournal.open(options(dir));
    const rejected = await journal.recordAdmission({ challenge: nodeChallenge(), state: "admission_rejected", rejectionCode: "policy_denied" });
    await journal.close();
    const reopened = await StardewLogicalActionRecoveryJournal.open(options(dir));
    assert.deepEqual(reopened.admissionRecord(nodeChallenge()), rejected);
    assert.equal(reopened.admissionRecord(nodeChallenge())?.rejectionCode, "policy_denied");
    await reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("node admission persists the exact opaque Mod policy identity and rejects a mismatched grant", async () => {
  const dir = await root();
   try {
     const path = join(dir, "stardew-logical-action-recovery-journal.json");
     const journal = await StardewLogicalActionRecoveryJournal.open(options(dir));
      const admission = await journal.recordAdmission(nodeAdmissionRecord());
     assert.deepEqual(admission.grant?.policyIdentity, { value: "mod-policy_01", capabilityRevision: 7 });
     assert.equal(admission.grant?.catalogRevision, 11);
     assert.notEqual(admission.grant?.catalogRevision, admission.grant?.policyIdentity.capabilityRevision);
     const persisted = JSON.parse(await readFile(path, "utf8")) as { scope: Record<string, unknown>; admissionRecords: Array<{ challenge: Record<string, unknown> }> };
     assert.deepEqual(persisted.scope, { save: "s" });
     assert.equal(Object.hasOwn(persisted.admissionRecords[0]!.challenge, "scopeIdentity"), false);
     await journal.close();

     const reopened = await StardewLogicalActionRecoveryJournal.open(options(dir));
    assert.deepEqual(reopened.admissionRecord(nodeChallenge()), admission);
    await reopened.close();

     const document = JSON.parse(await readFile(path, "utf8")) as {
       admissionRecords: Array<{ grant?: { policyIdentity: Record<string, unknown> } }>;
     };
     document.admissionRecords[0]!.grant!.policyIdentity = { value: "substituted", capabilityRevision: 7 };
    await writeFile(path, JSON.stringify(document));
    await assert.rejects(() => StardewLogicalActionRecoveryJournal.open(options(dir)), /invalid_recovery_journal_record/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("persisted legacy admission payload shape is rejected without migration", async () => {
  const dir = await root();
  try {
    await writeFile(
      join(dir, "stardew-logical-action-recovery-journal.json"),
      JSON.stringify({
        schemaVersion: 1,
        scope: { save: "s" },
        records: [],
        admissionRecords: [{
          challenge: {
            programId: "program_01", nodeId: "node_01", nodeAttempt: 1, admissionAttempt: 1,
             stopEpoch: 1, scopeIdentity: { save: "s" }, policyIdentity: { identity: "legacy" },
             catalogRevision: "catalog_01", actionIdentity: "move_to_tile", canonicalBoundArgs: { x: 1 },
             derivedResourceClaims: [{ resource: "actor" }], deadlineMs: 9_999,
          },
          state: "admission_rejected",
          rejectionCode: "policy_denied",
        }],
      }),
    );
    await assert.rejects(() => StardewLogicalActionRecoveryJournal.open(options(dir)), /invalid_recovery_journal_document|invalid_recovery_journal_record/);
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

test("structurally valid opaque action args survive reopen without a Host action list", async () => {
  const dir = await root();
  try {
    const base = record("logical-opaque-action");
    const canonicalRequest = {
      ...base.canonicalRequest,
      action: "mod_future_action",
      args: { target: "opaque", mode: "future" },
    };
    const opaque = {
      ...base,
      actionId: "mod_future_action",
      canonicalArgs: canonicalRequest.args,
      canonicalRequest,
    } as unknown as R;
    const journal = await StardewLogicalActionRecoveryJournal.open(options(dir));
    const prepared = await journal.prepare(opaque);
    await journal.close();

    const reopened = await StardewLogicalActionRecoveryJournal.open(options(dir));
    assert.deepEqual(reopened.record(opaque.logicalActionId), prepared);
    assert.throws(
      () => reopened.prepare({
        ...opaque,
        logicalActionId: "logical-unknown-request-field",
        requestId: "request-unknown-request-field",
        idempotencyKey: "key-unknown-request-field",
        canonicalRequest: {
          ...canonicalRequest,
          requestId: "request-unknown-request-field",
          idempotencyKey: "key-unknown-request-field",
          extra: true,
        },
      } as R),
      /invalid_recovery_journal_record/,
    );
    assert.throws(
      () => reopened.prepare({
        ...opaque,
        logicalActionId: "logical-non-object-args",
        requestId: "request-non-object-args",
        idempotencyKey: "key-non-object-args",
        canonicalRequest: {
          ...canonicalRequest,
          requestId: "request-non-object-args",
          idempotencyKey: "key-non-object-args",
          args: [],
        },
      } as unknown as R),
      /invalid_recovery_journal_record/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
