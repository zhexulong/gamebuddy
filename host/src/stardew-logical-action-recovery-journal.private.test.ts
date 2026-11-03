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
  recoveryJournalWriteProfile,
  type HostNodeAdmissionRecord,
} from "./stardew-logical-action-recovery-journal.js";
import { HostNodeAdmissionService } from "./action-execution-coordinator.internal.js";
import { validateBodyNodeAdmissionPayload, type BodyNodeAdmissionChallenge } from "./protocol.js";

type R = Parameters<StardewLogicalActionRecoveryJournal["prepare"]>[0];
const record = (id = "logical-1"): R => ({
  logicalActionId: id,
  dispatchOrdinal: 1,
  ownerId: "owner",
  epoch: 2,
  requestId: `request-${id}`,
  idempotencyKey: `key-${id}`,
  actionId: "move_to_tile",
  canonicalArgs: { x: 1, y: 2 },
  canonicalRequest: {
    requestId: `request-${id}`,
    idempotencyKey: `key-${id}`,
    action: "move_to_tile",
    args: { x: 1, y: 2 },
    expectedRevision: 3,
    deadlineMs: 9999,
  },
  expectedRevision: 3,
  deadlineMs: 9999,
  scope: { save: "s" },
  bindingIdentity: { binding: "b" },
});
const admissionRecord = (id: string, ownerId: string, epoch: number, binding: string, dispatchOrdinal: number): R => ({
  ...record(id),
  ownerId,
  epoch,
  bindingIdentity: { binding },
  dispatchOrdinal,
});
const options = (directory: string) => ({ directory, scope: { save: "s" } });
const nodeChallenge = (overrides: Partial<BodyNodeAdmissionChallenge> = {}): BodyNodeAdmissionChallenge => ({
  programId: "program_01",
  nodeId: "node_01",
  nodeAttempt: 1,
  admissionAttempt: 1,
  stopEpoch: 1,
  catalogRevision: 11,
  policyIdentity: { value: "mod-policy_01", capabilityRevision: 7 },
  actionId: "move_to_tile",
  canonicalBoundArgs: { x: { type: "integer", canonicalValue: "1" }, y: { type: "integer", canonicalValue: "2" } },
  derivedResourceClaims: { actor: "embodied_actor" },
  deadlineMs: 9_999,
  ...overrides,
});
const nodeAdmissionRecord = (
  challenge: BodyNodeAdmissionChallenge = nodeChallenge(),
  grantId = "grant_01",
): HostNodeAdmissionRecord => ({
  challenge,
  state: "grant_issued",
  grant: {
    ...challenge,
    grantId,
    attachmentGeneration: "attachment_01",
    policyRevision: "host-policy_01",
    executionBinding: null,
  },
});
async function root() {
  const parent = process.platform === "win32" ? process.env.LOCALAPPDATA : tmpdir();
  if (typeof parent !== "string" || parent.length === 0) throw new Error("test_local_app_data_unavailable");
  return mkdtemp(join(await realpath(parent), "gamebuddy-recovery-"));
}
const LOG_FILE = "stardew-logical-action-recovery-journal.jsonl";
const legacyPath = (directory: string) => join(directory, "stardew-logical-action-recovery-journal.json");
/**
 * Every journal this module opened. A journal holds its append handle open for its lifetime,
 * so a test that forgets to close one cannot even remove its directory on Windows; cleanup
 * closes what is left instead of pretending the handle is not there.
 */
const openedJournals = new Set<StardewLogicalActionRecoveryJournal>();
async function openJournal(
  options: Parameters<typeof StardewLogicalActionRecoveryJournal.open>[0],
): Promise<StardewLogicalActionRecoveryJournal> {
  const journal = await StardewLogicalActionRecoveryJournal.open(options);
  openedJournals.add(journal);
  return journal;
}
async function cleanup(directory: string): Promise<void> {
  for (const journal of [...openedJournals]) await journal.close();
  openedJournals.clear();
  await rm(directory, { recursive: true, force: true });
}
/** The durable log's lines, as any other reader of the file would see them. */
async function readLog(directory: string): Promise<string[]> {
  return (await readFile(join(directory, LOG_FILE), "utf8")).split("\n").filter((line) => line.length > 0);
}
/** Rewrite the log as a foreign writer would; the journal must notice it changed. */
async function writeLog(directory: string, lines: readonly string[]): Promise<void> {
  await writeFile(join(directory, LOG_FILE), `${lines.join("\n")}\n`);
}
/** The newest fact the log holds for one record identity. */
async function foldedRecord(directory: string, logicalActionId: string): Promise<Record<string, any>> {
  let found: Record<string, any> | undefined;
  for (const line of await readLog(directory)) {
    const entry = JSON.parse(line) as { kind: string; value?: Record<string, any> };
    if (entry.kind === "record" && entry.value?.logicalActionId === logicalActionId) found = entry.value;
  }
  assert.notEqual(found, undefined, `the log must carry ${logicalActionId}`);
  return found!;
}
async function replaceFoldedRecord(
  directory: string,
  logicalActionId: string,
  mutate: (record: Record<string, any>) => void,
): Promise<void> {
  const lines = await readLog(directory);
  const target = await foldedRecord(directory, logicalActionId);
  mutate(target);
  await writeLog(
    directory,
    lines.map((line) => {
      const entry = JSON.parse(line) as { kind: string; value?: Record<string, any> };
      return entry.kind === "record" && entry.value?.logicalActionId === logicalActionId
        ? JSON.stringify({ kind: "record", value: target })
        : line;
    }),
  );
}

test("prepare is durable before return and reopens exact pending material", async () => {
  const dir = await root();
  try {
    const j = await openJournal(options(dir));
    const saved = await j.prepare(record());
    assert.deepEqual(saved, j.record("logical-1"));
    await j.close();
    const reopened = await openJournal(options(dir));
    assert.deepEqual(reopened.record("logical-1"), saved);
    assert.equal(reopened.recoverableRecords().length, 1);
  } finally {
    await cleanup(dir);
  }
});

test("stable scope reopens across Host lifecycles while retaining historical owners and epochs", async () => {
  const dir = await root();
  try {
    const first = await openJournal(options(dir));
    const ownerA = await first.prepare(admissionRecord("logical-a", "owner-a", 7, "binding-a", 1));
    await first.close();

    const freshHost = await openJournal(options(dir));
    const ownerB = await freshHost.prepare(admissionRecord("logical-b", "owner-b", 8, "binding-b", 2));
    assert.deepEqual(freshHost.records(), [ownerA, ownerB]);
    assert.equal(freshHost.record("logical-a")?.ownerId, "owner-a");
    assert.equal(freshHost.record("logical-a")?.epoch, 7);
    assert.equal(freshHost.record("logical-b")?.ownerId, "owner-b");
    assert.equal(freshHost.record("logical-b")?.epoch, 8);
  } finally {
    await cleanup(dir);
  }
});

test("transitions survive reopen", async () => {
  const dir = await root();
  try {
    const j = await openJournal(options(dir));
    await j.prepare(record());
    await j.markSentUnknown("logical-1");
    await j.markRecoveryPending("logical-1");
    await j.close();
    const reopened = await openJournal(options(dir));
    assert.equal(reopened.record("logical-1")?.state, "recovery_pending");
  } finally {
    await cleanup(dir);
  }
});

test("historical binding identities coexist and remain immutable across transitions", async () => {
  const dir = await root();
  try {
    const journal = await openJournal(options(dir));
    const first = await journal.prepare(admissionRecord("logical-a", "owner-a", 7, "binding-a", 1));
    const second = await journal.prepare(admissionRecord("logical-b", "owner-b", 8, "binding-b", 2));
    const transitioned = await journal.markSentUnknown("logical-a");
    assert.equal(transitioned.bindingIdentity?.binding, "binding-a");
    assert.deepEqual(journal.record("logical-b"), second);

    // A foreign line that keeps the identity but changes immutable material is not a newer
    // fact about this action; it is refused rather than adopted.
    const tampered = { ...(await foldedRecord(dir, first.logicalActionId)), bindingIdentity: { binding: "tampered" } };
    await writeLog(dir, [...(await readLog(dir)), JSON.stringify({ kind: "record", value: tampered })]);
    await assert.rejects(() => journal.markRecoveryPending(first.logicalActionId), /invalid_recovery_journal_record/);
  } finally {
    await cleanup(dir);
  }
});

test("malformed, duplicate, schema and scope data fail closed", async () => {
  const dir = await root();
  try {
    // Bytes that are not a log at all are refused, not rebuilt.
    await writeFile(join(dir, LOG_FILE), "not-json");
    await assert.rejects(() => StardewLogicalActionRecoveryJournal.open(options(dir)));
    // A log whose header belongs to another schema, or declares no kind at all, is refused.
    await writeFile(join(dir, LOG_FILE), '{"schemaVersion":99}');
    await assert.rejects(
      () => StardewLogicalActionRecoveryJournal.open(options(dir)),
      /invalid_recovery_journal_document/,
    );
    await writeFile(join(dir, LOG_FILE), '{"kind":"header","schemaVersion":2}\n');
    await assert.rejects(
      () => StardewLogicalActionRecoveryJournal.open(options(dir)),
      /invalid_recovery_journal_document/,
    );
    // A record whose durable bytes disagree with themselves is refused by the strict reader.
    await rm(join(dir, LOG_FILE), { force: true });
    const journal = await openJournal(options(dir));
    await journal.prepare(record("logical-a"));
    await journal.prepare(admissionRecord("logical-b", "owner-b", 8, "binding-b", 2));
    await replaceFoldedRecord(dir, "logical-a", (item) => {
      item.canonicalArgs = { x: 9, y: 2 };
    });
    await assert.rejects(() => openJournal(options(dir)), /invalid_recovery_journal_record/);
  } finally {
    await cleanup(dir);
  }
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
    JSON.parse(
      JSON.stringify({
        ...nodeChallenge(),
        canonicalBoundArgs: Object.fromEntries([
          ["__proto__", { type: "string", canonicalValue: "identity-loss" }],
          ["x", { type: "integer", canonicalValue: "1" }],
        ]),
      }),
    ),
    JSON.parse(
      JSON.stringify({
        ...nodeChallenge(),
        derivedResourceClaims: Object.fromEntries([
          ["__proto__", "forged_claim"],
          ["actor", "embodied_actor"],
        ]),
      }),
    ),
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
  const maliciousChallenge: BodyNodeAdmissionChallenge = JSON.parse(
    JSON.stringify({
      ...validChallenge,
      canonicalBoundArgs: Object.fromEntries([
        ...Object.entries(validChallenge.canonicalBoundArgs),
        ["__proto__", { type: "string", canonicalValue: "identity-loss" }],
      ]),
    }),
  );
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
    const journal = await openJournal(options(dir));
    const admission = await journal.recordAdmission(nodeAdmissionRecord());
    const prepared = await journal.prepare(record());
    const transitioned = await journal.markSentUnknown(prepared.logicalActionId);
    await journal.close();

    const reopened = await openJournal(options(dir));
    assert.deepEqual(reopened.admissionRecord(nodeChallenge()), admission);
    assert.deepEqual(reopened.record(prepared.logicalActionId), transitioned);
    await reopened.close();
  } finally {
    await cleanup(dir);
  }
});

test("rejected admission persists and reopens as a terminal transport decision", async () => {
  const dir = await root();
  try {
    const journal = await openJournal(options(dir));
    const rejected = await journal.recordAdmission({
      challenge: nodeChallenge(),
      state: "admission_rejected",
      rejectionCode: "policy_denied",
    });
    await journal.close();
    const reopened = await openJournal(options(dir));
    assert.deepEqual(reopened.admissionRecord(nodeChallenge()), rejected);
    assert.equal(reopened.admissionRecord(nodeChallenge())?.rejectionCode, "policy_denied");
    await reopened.close();
  } finally {
    await cleanup(dir);
  }
});

test("node admission persists the exact opaque Mod policy identity and rejects a mismatched grant", async () => {
  const dir = await root();
  try {
    const journal = await openJournal(options(dir));
    const admission = await journal.recordAdmission(nodeAdmissionRecord());
    assert.deepEqual(admission.grant?.policyIdentity, { value: "mod-policy_01", capabilityRevision: 7 });
    assert.equal(admission.grant?.catalogRevision, 11);
    assert.notEqual(admission.grant?.catalogRevision, admission.grant?.policyIdentity.capabilityRevision);
    const header = JSON.parse((await readLog(dir))[0]!) as { scope: Record<string, unknown> };
    const persisted = (await readLog(dir))
      .slice(1)
      .map((line) => JSON.parse(line) as { kind: string; value: { challenge: Record<string, unknown> } })
      .filter((entry) => entry.kind === "admission");
    assert.deepEqual(header.scope, { save: "s" });
    assert.equal(persisted.length, 1);
    assert.equal(Object.hasOwn(persisted[0]!.value.challenge, "scopeIdentity"), false);
    await journal.close();

    const reopened = await openJournal(options(dir));
    assert.deepEqual(reopened.admissionRecord(nodeChallenge()), admission);
    await reopened.close();

    const lines = await readLog(dir);
    await writeLog(
      dir,
      lines.map((line) => {
        const entry = JSON.parse(line) as { kind: string; value: Record<string, any> };
        if (entry.kind !== "admission") return line;
        entry.value.grant.policyIdentity = { value: "substituted", capabilityRevision: 7 };
        return JSON.stringify(entry);
      }),
    );
    await assert.rejects(
      () => StardewLogicalActionRecoveryJournal.open(options(dir)),
      /invalid_recovery_journal_record/,
    );
  } finally {
    await cleanup(dir);
  }
});

test("persisted legacy admission payload shape is rejected without migration", async () => {
  const dir = await root();
  try {
    await writeFile(
      legacyPath(dir),
      JSON.stringify({
        schemaVersion: 1,
        scope: { save: "s" },
        records: [],
        admissionRecords: [
          {
            challenge: {
              programId: "program_01",
              nodeId: "node_01",
              nodeAttempt: 1,
              admissionAttempt: 1,
              stopEpoch: 1,
              scopeIdentity: { save: "s" },
              policyIdentity: { identity: "legacy" },
              catalogRevision: "catalog_01",
              actionIdentity: "move_to_tile",
              canonicalBoundArgs: { x: 1 },
              derivedResourceClaims: [{ resource: "actor" }],
              deadlineMs: 9_999,
            },
            state: "admission_rejected",
            rejectionCode: "policy_denied",
          },
        ],
      }),
    );
    await assert.rejects(
      () => StardewLogicalActionRecoveryJournal.open(options(dir)),
      /invalid_recovery_journal_document|invalid_recovery_journal_record/,
    );
  } finally {
    await cleanup(dir);
  }
});

test("duplicate logical action and request IDs are rejected", async () => {
  const j = new StardewLogicalActionRecoveryJournal();
  await j.prepare(record("logical-1"));
  await assert.rejects(() => j.prepare(record("logical-1")), /duplicate_recovery_journal_record/);
  await assert.rejects(
    () =>
      j.prepare({
        ...record("logical-2"),
        requestId: "request-logical-1",
        canonicalRequest: { ...record("logical-2").canonicalRequest, requestId: "request-logical-1" },
      }),
    /duplicate_recovery_journal_record/,
  );
});

test("open rejects a changed stable scope", async () => {
  const dir = await root();
  try {
    const j = await openJournal(options(dir));
    await j.prepare(record());
    await assert.rejects(
      () => StardewLogicalActionRecoveryJournal.open({ ...options(dir), scope: { save: "other" } }),
      /invalid_recovery_journal_document/,
    );
  } finally {
    await cleanup(dir);
  }
});

test("unscoped journal reopens only without a stable scope", async () => {
  const dir = await root();
  try {
    const unscoped = await openJournal({ directory: dir });
    const { scope: _scope, ...unscopedRecord } = record();
    const prepared = await unscoped.prepare(unscopedRecord);
    await unscoped.close();

    const header = JSON.parse((await readLog(dir))[0]!) as Record<string, unknown>;
    assert.equal(Object.hasOwn(header, "scope"), false);
    const reopened = await openJournal({ directory: dir });
    assert.deepEqual(reopened.record(prepared.logicalActionId), prepared);
    await assert.rejects(
      () => StardewLogicalActionRecoveryJournal.open({ directory: dir, scope: { save: "s" } }),
      /invalid_recovery_journal_document/,
    );
  } finally {
    await cleanup(dir);
  }
});

test("two open instances merge durable mutations without lost updates", async () => {
  const dir = await root();
  try {
    const first = await openJournal(options(dir));
    const second = await openJournal(options(dir));
    await Promise.all([
      first.prepare(record("logical-1")),
      second.prepare({ ...record("logical-2"), dispatchOrdinal: 2 }),
    ]);
    const reopened = await openJournal(options(dir));
    assert.deepEqual(
      reopened
        .records()
        .map((r) => r.logicalActionId)
        .sort(),
      ["logical-1", "logical-2"],
    );
  } finally {
    await cleanup(dir);
  }
});

test("close prevents mutation", async () => {
  const j = new StardewLogicalActionRecoveryJournal();
  await j.close();
  await assert.rejects(() => j.prepare(record()), /recovery_journal_closed/);
  await assert.rejects(() => j.markSentUnknown("logical-1"), /recovery_journal_closed/);
});

test("writer failure does not create a durable recoverable entry", async () => {
  const dir = await root();
  try {
    const j = new StardewLogicalActionRecoveryJournal({
      write: async () => {
        throw new Error("disk");
      },
    });
    await assert.rejects(() => j.prepare(record()));
    assert.equal(j.records().length, 0);
  } finally {
    await cleanup(dir);
  }
});

test("journal log contains no receipt fields", async () => {
  const dir = await root();
  try {
    const j = await openJournal(options(dir));
    await j.prepare(record());
    const text = await readFile(join(dir, LOG_FILE), "utf8");
    for (const field of ["receipt", "executionId", "body"]) assert.equal(text.includes(field), false);
  } finally {
    await cleanup(dir);
  }
});

test("duplicate idempotency keys and dispatch ordinals are rejected", async () => {
  const j = new StardewLogicalActionRecoveryJournal();
  await j.prepare(record("logical-1"));
  await assert.rejects(
    () =>
      j.prepare({
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
    const journal = await openJournal(options(dir));
    const prepared = await journal.prepare(opaque);
    await journal.close();

    const reopened = await openJournal(options(dir));
    assert.deepEqual(reopened.record(opaque.logicalActionId), prepared);
    assert.throws(
      () =>
        reopened.prepare({
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
      () =>
        reopened.prepare({
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
    await cleanup(dir);
  }
});

test("unknown nested request fields and mismatched canonical args fail closed", async () => {
  const dir = await root();
  try {
    // The whole-document payload this journal replaced is still read strictly on migration,
    // so a document that was never valid is refused rather than folded into the log.
    const path = legacyPath(dir);
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
    await assert.rejects(
      () => StardewLogicalActionRecoveryJournal.open(options(dir)),
      /invalid_recovery_journal_record/,
    );

    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        scope: { save: "s" },
        records: [{ ...base, canonicalArgs: { x: 999, y: 2 } }],
      }),
    );
    await assert.rejects(
      () => StardewLogicalActionRecoveryJournal.open(options(dir)),
      /invalid_recovery_journal_record/,
    );
  } finally {
    await cleanup(dir);
  }
});

test("open snapshots caller-owned stable scope", async () => {
  const dir = await root();
  const scope = { save: "s" };
  try {
    const j = await openJournal({ ...options(dir), scope });
    scope.save = "other";
    await assert.rejects(
      () => j.prepare({ ...record("logical-2"), scope: { save: "other" } }),
      /recovery_journal_scope_mismatch/,
    );
    assert.deepEqual(j.record("logical-1"), null);
  } finally {
    await cleanup(dir);
  }
});

test("serialized transitions cannot regress a terminal disk state", async () => {
  const dir = await root();
  try {
    const first = await openJournal(options(dir));
    await first.prepare(record());
    const second = await openJournal(options(dir));
    await first.markSentUnknown("logical-1");
    await first.markTerminalSettled("logical-1");
    await assert.rejects(() => second.markSentUnknown("logical-1"), /invalid_recovery_journal_transition/);
    const reopened = await openJournal(options(dir));
    assert.equal(reopened.record("logical-1")?.state, "terminal_settled");
  } finally {
    await cleanup(dir);
  }
});

test("initial document budget is enforced", async () => {
  const dir = await root();
  try {
    await assert.rejects(
      () =>
        StardewLogicalActionRecoveryJournal.open({
          ...options(dir),
          maxBytes: 1024,
          scope: { save: "x".repeat(2000) },
        }),
      /recovery_journal_budget_exceeded/,
    );
  } finally {
    await cleanup(dir);
  }
});

test("a full journal evicts settled history instead of wedging every later action", async () => {
  const dir = await root();
  try {
    // A real ladder session filled the 256-record cap with 254 `terminal_settled` records
    // and then could not create ANY action: every write re-validated the same full document
    // and threw `recovery_journal_budget_exceeded`, so the companion, and a real player after
    // enough actions, permanently loses the ability to act. The journal is bounded HISTORY,
    // and nothing may depend on a settled record (`allowedTransition` has no edge out of
    // `terminal_settled`), so a new record must be able to make room by dropping the oldest
    // settled ones.
    const limits = { ...options(dir), maxRecords: 4 };
    const journal = await openJournal(limits);
    for (let index = 1; index <= 4; index += 1) {
      const id = `settled-${index}`;
      await journal.prepare({ ...record(id), dispatchOrdinal: index });
      await journal.markSentUnknown(id);
      await journal.markTerminalSettled(id);
    }
    assert.equal(journal.records().length, 4);

    // The fifth action is the one that used to be impossible.
    await journal.prepare({ ...record("fresh"), dispatchOrdinal: 5 });
    assert.equal(journal.record("fresh")?.state, "prepared");
    assert.ok(journal.records().length <= 4, "eviction must keep the journal inside its record budget");
    assert.equal(journal.record("settled-1"), null, "the oldest settled record is the one evicted");
    assert.equal(journal.record("settled-4")?.state, "terminal_settled", "newer history survives");

    // Memory and disk must agree: a reopen sees exactly the same records.
    const reopened = await openJournal(limits);
    assert.deepEqual(
      reopened
        .records()
        .map((item) => `${item.logicalActionId}:${item.state}`)
        .sort(),
      journal
        .records()
        .map((item) => `${item.logicalActionId}:${item.state}`)
        .sort(),
    );
    assert.equal(reopened.record("fresh")?.state, "prepared");
    const lines = await readLog(dir);
    const folded = new Map<string, string>();
    for (const line of lines.slice(1)) {
      const entry = JSON.parse(line) as { kind: string; value?: { logicalActionId?: string } };
      if (entry.kind === "record") folded.set(entry.value!.logicalActionId!, line);
    }
    assert.equal(folded.size, reopened.records().length);
  } finally {
    await cleanup(dir);
  }
});

test("records that still owe recovery are never evicted, and their refusal stays honest", async () => {
  const dir = await root();
  try {
    // Everything here still owes something (in flight or awaiting recovery), so no eviction
    // is possible. The budget refusal must stand and must be attributable to real in-flight
    // volume, not to settled history the journal could have dropped.
    const limits = { ...options(dir), maxRecords: 2 };
    const journal = await openJournal(limits);
    await journal.prepare({ ...record("pending-1"), dispatchOrdinal: 1 });
    await journal.prepare({ ...record("pending-2"), dispatchOrdinal: 2 });
    await journal.markRecoveryRequired("pending-1");
    await journal.markSentUnknown("pending-2");

    await assert.rejects(
      () => journal.prepare({ ...record("pending-3"), dispatchOrdinal: 3 }),
      /recovery_journal_budget_exceeded/,
    );
    // The records that owe recovery are all still there, in memory and on disk.
    assert.equal(journal.record("pending-1")?.state, "recovery_required");
    assert.equal(journal.record("pending-2")?.state, "sent_unknown");
    const reopened = await openJournal(limits);
    assert.equal(reopened.record("pending-1")?.state, "recovery_required");
    assert.equal(reopened.record("pending-2")?.state, "sent_unknown");
    // `recovery_required` records the OUTCOME that recovery could not resolve, so the module
    // deliberately excludes it from `recoverableRecords()` (nothing active remains to do) —
    // but its evidence is never dropped either: only `terminal_settled` history is evictable.
    assert.deepEqual(
      reopened.recoverableRecords().map((item) => item.logicalActionId),
      ["pending-2"],
    );
  } finally {
    await cleanup(dir);
  }
});

test("a log this path wrote is valid to a fresh reader", async () => {
  const dir = await root();
  try {
    const journal = await openJournal(options(dir));
    await journal.prepare(record());
    const durable = await journal.markSentUnknown("logical-1");
    await journal.close();

    // Crash recovery reads the bytes, not this process: every line on disk must parse on its
    // own, and the fold of those lines must be the state the next Host lifecycle opens.
    const lines = await readLog(dir);
    for (const line of lines) assert.deepEqual(JSON.parse(line), JSON.parse(line));
    assert.deepEqual(await foldedRecord(dir, "logical-1"), durable);
    const freshReader = await openJournal(options(dir));
    assert.deepEqual(freshReader.record("logical-1"), durable);
    await freshReader.close();
  } finally {
    await cleanup(dir);
  }
});

test("an illegal state transition is refused with invalid_recovery_journal_transition", async () => {
  const dir = await root();
  try {
    const journal = await openJournal(options(dir));
    await journal.prepare(record());
    await journal.markSentUnknown("logical-1");
    await journal.markTerminalSettled("logical-1");
    await assert.rejects(() => journal.markRecoveryPending("logical-1"), /invalid_recovery_journal_transition/);
    const reopened = await openJournal(options(dir));
    assert.equal(reopened.record("logical-1")?.state, "terminal_settled");
  } finally {
    await cleanup(dir);
  }
});

test("a write that cannot fit the byte budget is refused", async () => {
  const dir = await root();
  try {
    const journal = await openJournal({ ...options(dir), maxBytes: 1024 });
    await assert.rejects(
      () => journal.prepare({ ...record(), bindingIdentity: { padding: "x".repeat(2048) } }),
      /recovery_journal_budget_exceeded/,
    );
    assert.equal(journal.record("logical-1"), null);
  } finally {
    await cleanup(dir);
  }
});

test("a Host killed inside a write leaves a readable journal, not a partial document", async () => {
  const dir = await root();
  try {
    const path = join(dir, LOG_FILE);
    const journal = await openJournal(options(dir));
    await journal.prepare(record());
    // A rewrite publishes by renaming its exclusive temporary over the log, so a Host killed
    // mid-rewrite can leave that temporary behind but never a half-written journal. The
    // residue here is the interrupted document; the log beside it must still stand on its own.
    await writeFile(`${path}.${process.pid}.interrupted.tmp`, '{"kind":"record","value":{"logicalActionId"');
    await journal.close();

    const reopened = await openJournal(options(dir));
    assert.equal(reopened.record("logical-1")?.state, "prepared");
    await reopened.markSentUnknown("logical-1");
    assert.equal(reopened.record("logical-1")?.state, "sent_unknown");

    for (const line of await readLog(dir)) assert.deepEqual(JSON.parse(line), JSON.parse(line));
    await reopened.close();
  } finally {
    await cleanup(dir);
  }
});

test("a torn final line loses nothing that was already durable", async () => {
  const dir = await root();
  try {
    const journal = await openJournal(options(dir));
    await journal.prepare(record());
    await journal.markSentUnknown("logical-1");
    await journal.close();

    // A Host killed inside an append leaves the PREFIX of the line it was writing: the bytes
    // of a fact that never became durable, with no newline to end it. The lines before it are
    // durable and must survive; the fragment must not cost the journal that holds them.
    const durable = await readFile(join(dir, LOG_FILE), "utf8");
    await writeFile(join(dir, LOG_FILE), `${durable}{"kind":"record","value":{"logicalActionId":"log`);

    const recovered = await openJournal(options(dir));
    assert.equal(recovered.record("logical-1")?.state, "sent_unknown", "durable lines survive the torn tail");
    await recovered.markTerminalSettled("logical-1");
    assert.equal(recovered.record("logical-1")?.state, "terminal_settled");

    // The fragment is not a fact and must not sit in front of the lines that follow it.
    const repaired = await readFile(join(dir, LOG_FILE), "utf8");
    assert.ok(
      repaired.endsWith("\n"),
      "the torn tail is cut back to a whole line, not left to corrupt the next append",
    );
    for (const line of await readLog(dir)) assert.deepEqual(JSON.parse(line), JSON.parse(line));
    const freshReader = await openJournal(options(dir));
    assert.equal(freshReader.record("logical-1")?.state, "terminal_settled");
  } finally {
    await cleanup(dir);
  }
});

test("one action's transitions serialise one record each, never the whole journal", async () => {
  const dir = await root();
  try {
    const journal = await openJournal({ ...options(dir), maxRecords: 200 });
    // Settled history, because a journal that only ever holds the action under test proves
    // nothing about how a write's cost scales with the document that contains it.
    for (let index = 1; index <= 120; index += 1) {
      const id = `history-${index}`;
      await journal.prepare({ ...record(id), dispatchOrdinal: index });
      await journal.markTerminalSettled(id);
    }
    await journal.prepare({ ...record("logical-observed"), dispatchOrdinal: 121 });
    const logBytes = (await readFile(join(dir, LOG_FILE), "utf8")).length;

    const before = recoveryJournalWriteProfile();
    await journal.markSentUnknown("logical-observed");
    await journal.markRecoveryPending("logical-observed");
    await journal.markTerminalSettled("logical-observed");
    const after = recoveryJournalWriteProfile();

    assert.equal(after.appends - before.appends, 3, "every transition must be one appended line");
    assert.equal(
      after.compactions - before.compactions,
      0,
      "a transition over a warm log must never fold the whole journal",
    );
    assert.equal(
      after.documentParses - before.documentParses,
      0,
      "a write over this process's own bytes must not read and fold the log again",
    );
    const written = after.writtenBytes - before.writtenBytes;
    assert.ok(
      written <= 3 * 1024,
      `three transitions wrote ${written} bytes of a ${logBytes}-byte journal: a write must append the record that changed, not rewrite the journal that holds it`,
    );
  } finally {
    await cleanup(dir);
  }
});

test("a fold is reported as a compaction, never counted as an append", async () => {
  const dir = await root();
  try {
    const limits = { ...options(dir), maxRecords: 2 };
    const journal = await openJournal(limits);
    for (const index of [1, 2]) {
      const id = `settled-${index}`;
      await journal.prepare({ ...record(id), dispatchOrdinal: index });
      await journal.markTerminalSettled(id);
    }

    // The write that has to drop settled history cannot append a line and keep its budget, so
    // it publishes the whole folded log instead. The profile has to say so: a compaction is the
    // one O(document) write left in the journal, and counting it as an append would hide it.
    const before = recoveryJournalWriteProfile();
    await journal.prepare({ ...record("fresh"), dispatchOrdinal: 3 });
    const after = recoveryJournalWriteProfile();
    assert.equal(after.compactions - before.compactions, 1, "the evicting write folds the log exactly once");
    assert.equal(after.appends - before.appends, 0, "the fold is not also an append");
    assert.equal(journal.record("fresh")?.state, "prepared");
    assert.equal(
      (await readLog(dir)).length,
      3,
      "the folded log holds the header and its two live facts, with no superseded line left",
    );
  } finally {
    await cleanup(dir);
  }
});

test("superseded facts are folded away once the log is 64 lines beyond its live set", async () => {
  const dir = await root();
  try {
    const journal = await openJournal(options(dir));
    const before = recoveryJournalWriteProfile();
    // Two lines per action and one of them superseded: without a threshold the file would keep
    // one dead line per action for the life of the installation, and replay of it would keep
    // getting longer while the journal's live set stayed the same size.
    for (let index = 1; index <= 66; index += 1) {
      const id = `settled-${index}`;
      await journal.prepare({ ...record(id), dispatchOrdinal: index });
      await journal.markTerminalSettled(id);
    }
    const after = recoveryJournalWriteProfile();
    assert.equal(after.appends - before.appends, 132, "every transition is still one appended line");
    assert.equal(after.compactions - before.compactions, 1, "the 64-line threshold is crossed exactly once");
    assert.equal(
      (await readLog(dir)).length,
      68,
      "header, the 65 facts the fold left live, and the two lines appended after it",
    );

    const reopened = await openJournal(options(dir));
    assert.equal(reopened.records().length, journal.records().length);
    assert.equal(reopened.record("settled-66")?.state, "terminal_settled");
  } finally {
    await cleanup(dir);
  }
});

test("a warm journal does not fold its own bytes, and folds foreign bytes again", async () => {
  const dir = await root();
  try {
    const journal = await openJournal(options(dir));
    await journal.prepare(record("logical-1"));

    const warm = recoveryJournalWriteProfile().documentParses;
    await journal.markSentUnknown("logical-1");
    assert.equal(
      recoveryJournalWriteProfile().documentParses,
      warm,
      "a write over this process's own bytes must not re-read and fold them",
    );

    // Another writer appends a fact, so its bytes can never be taken for ours: the next write
    // folds the log again and keeps what that writer put there.
    await writeLog(dir, [
      ...(await readLog(dir)),
      JSON.stringify({
        kind: "record",
        value: { ...record("logical-foreign"), dispatchOrdinal: 2, state: "prepared" },
      }),
    ]);
    const afterForeignWrite = recoveryJournalWriteProfile().documentParses;
    await journal.markRecoveryPending("logical-1");
    assert.equal(
      recoveryJournalWriteProfile().documentParses,
      afterForeignWrite + 1,
      "foreign bytes must be folded again",
    );

    const reopened = await openJournal(options(dir));
    assert.equal(reopened.record("logical-1")?.state, "recovery_pending");
    assert.equal(reopened.record("logical-foreign")?.state, "prepared", "the write read the file, not memory");
    await reopened.close();

    // Foreign bytes that change immutable material are refused rather than served from memory.
    await replaceFoldedRecord(dir, "logical-1", (item) => {
      item.bindingIdentity = { binding: "tampered" };
    });
    await assert.rejects(() => journal.markTerminalSettled("logical-1"), /invalid_recovery_journal_record/);
  } finally {
    await cleanup(dir);
  }
});

type LockRequest = Readonly<{
  operation: "reclaim_stale_lock" | "release_owned_lock";
  token?: string;
  root: string;
  segments: readonly string[];
}>;
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
