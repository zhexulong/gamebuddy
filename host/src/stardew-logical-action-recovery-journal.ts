import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import { readStrictJsonFile } from "./strict-json-reader.js";
import {
  validateBodyNodeAdmissionPayload,
  type BodyNodeAdmissionChallenge,
  type BodyNodeAdmissionGrant,
  type ExecutionRequest,
} from "./protocol.js";

const STARDEW_LOGICAL_ACTION_RECOVERY_STATES = Object.freeze([
  "prepared",
  "sent_unknown",
  "recovery_pending",
  "terminal_settled",
  "recovery_required",
] as const);
export type StardewLogicalActionRecoveryState = (typeof STARDEW_LOGICAL_ACTION_RECOVERY_STATES)[number];

type StardewLogicalActionRecoveryDispatchMaterial = Readonly<{
  actionId: string;
  canonicalRequest: Readonly<ExecutionRequest>;
  canonicalArgs: Readonly<Record<string, unknown>>;
  expectedRevision: number;
  deadlineMs: number;
  scope?: Readonly<Record<string, unknown>>;
  bindingIdentity?: Readonly<Record<string, unknown>>;
}>;

export type StardewLogicalActionRecoveryRecord = StardewLogicalActionRecoveryDispatchMaterial &
  Readonly<{
    logicalActionId: string;
    dispatchOrdinal: number;
    ownerId: string;
    epoch: number;
    requestId: string;
    idempotencyKey: string;
    state: StardewLogicalActionRecoveryState;
  }>;

type RecoveryRecordWriter = (
  record: StardewLogicalActionRecoveryRecord,
) => Promise<{ saved: StardewLogicalActionRecoveryRecord; evicted: readonly string[] }>;
type AdmissionRecordWriter = (record: HostNodeAdmissionRecord) => Promise<void>;

/** Test-only writer with distinct return types for the two journal owners. */
export type StardewLogicalActionRecoveryJournalWriter = {
  (
    record: StardewLogicalActionRecoveryRecord,
  ): StardewLogicalActionRecoveryRecord | Promise<StardewLogicalActionRecoveryRecord>;
  (record: HostNodeAdmissionRecord): void | Promise<void>;
};

export type StardewLogicalActionRecoveryJournalOptions = Readonly<{
  initialRecords?: readonly StardewLogicalActionRecoveryRecord[];
  /** Test-only writer; production callers must use open(). */
  write?: StardewLogicalActionRecoveryJournalWriter;
}>;

export type StardewLogicalActionRecoveryJournalOpenOptions = Readonly<{
  directory: string;
  scope?: Readonly<Record<string, unknown>>;
  maxRecords?: number;
  maxBytes?: number;
}>;

const HOST_NODE_ADMISSION_STATES = Object.freeze([
  "challenge_received",
  "grant_issued",
  "admission_rejected",
  "admission_unavailable",
] as const);
type HostNodeAdmissionState = (typeof HOST_NODE_ADMISSION_STATES)[number];

/** Durable Host transport record uses the exact protocol wire payloads. */
export type HostNodeAdmissionRecord = Readonly<{
  challenge: BodyNodeAdmissionChallenge;
  state: HostNodeAdmissionState;
  grant?: BodyNodeAdmissionGrant;
  rejectionCode?: string;
}>;

type Document = Readonly<{
  schemaVersion: 1;
  scope?: Record<string, unknown>;
  records: StardewLogicalActionRecoveryRecord[];
  admissionRecords?: HostNodeAdmissionRecord[];
}>;

type NormalizedOpenOptions = StardewLogicalActionRecoveryJournalOpenOptions;

const FILE_NAME = "stardew-logical-action-recovery-journal.jsonl";
const LEGACY_FILE_NAME = "stardew-logical-action-recovery-journal.json";
const LOG_SCHEMA_VERSION = 2;
const DEFAULT_MAX_RECORDS = 256;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_STRING_LENGTH = 16 * 1024;
/** Superseded lines a log may carry beyond its live set before it is folded into a new one. */
const COMPACTION_SLACK_LINES = 64;
const COMPACTION_CONFLICT_ATTEMPTS = 3;

let documentParseCount = 0;
let appendCount = 0;
let compactionCount = 0;
let writtenByteCount = 0;

/**
 * What the durable write path actually did, so the cost of a write is a measured fact rather
 * than an estimate. One action causes about three transitions; each must cost one bounded
 * append of the fact that changed, not a parse and a re-serialisation of the whole journal
 * that holds it. Appends and compactions are counted apart because they are different work:
 * an append is one line, a compaction is the whole journal.
 */
export type StardewLogicalActionRecoveryJournalWriteProfile = Readonly<{
  /** Times the whole journal had to be read, validated and folded back into memory. */
  documentParses: number;
  /** Lines appended: one durable fact each, and the whole durable cost of a transition. */
  appends: number;
  /** Times the log was folded into a fresh file, which writes every live record. */
  compactions: number;
  /** Bytes this process wrote: one line per append, the whole log per compaction. */
  writtenBytes: number;
}>;

export function recoveryJournalWriteProfile(): StardewLogicalActionRecoveryJournalWriteProfile {
  return Object.freeze({
    documentParses: documentParseCount,
    appends: appendCount,
    compactions: compactionCount,
    writtenBytes: writtenByteCount,
  });
}

/**
 * A SETTLED action is finished history. Its record exists so a crash in the middle of a
 * dispatch can be recovered; once the action reached a terminal outcome there is nothing
 * left to recover, and `allowedTransition` has no edge out of `terminal_settled` (so no
 * later write can depend on it). The other states DO owe something: they are in flight or
 * awaiting recovery.
 */
function owesNothing(record: StardewLogicalActionRecoveryRecord): boolean {
  return record.state === "terminal_settled";
}

/** One record with the bytes its log line occupies, encoded once. */
type EncodedRecord<T> = Readonly<{ record: T; fragment: string; bytes: number }>;

/** The journal as its live facts: one newest line per identity, plus the header. */
type FoldedLog = Readonly<{
  header: string;
  records: readonly EncodedRecord<StardewLogicalActionRecoveryRecord>[];
  admissionRecords: readonly EncodedRecord<HostNodeAdmissionRecord>[];
}>;

function encodeRecord<T>(record: T): EncodedRecord<T> {
  const fragment = JSON.stringify(record);
  return Object.freeze({ record, fragment, bytes: Buffer.byteLength(fragment, "utf8") });
}

/** Bytes one line occupies in the file, including its newline. */
function lineBytes(fragment: string): number {
  return Buffer.byteLength(fragment, "utf8") + 1;
}

function headerLine(scope: Readonly<Record<string, unknown>> | undefined): string {
  return scope === undefined
    ? `{"kind":"header","schemaVersion":${LOG_SCHEMA_VERSION}}`
    : `{"kind":"header","schemaVersion":${LOG_SCHEMA_VERSION},"scope":${JSON.stringify(scope)}}`;
}

function recordLine(fragment: string): string {
  return `{"kind":"record","value":${fragment}}`;
}

function admissionLine(fragment: string): string {
  return `{"kind":"admission","value":${fragment}}`;
}

function logSource(folded: FoldedLog): string {
  const lines = [folded.header];
  for (const item of folded.records) lines.push(recordLine(item.fragment));
  for (const item of folded.admissionRecords) lines.push(admissionLine(item.fragment));
  return `${lines.join("\n")}\n`;
}

function foldedBytes(folded: FoldedLog): number {
  let total = lineBytes(folded.header);
  for (const item of folded.records) total += item.bytes + 1;
  for (const item of folded.admissionRecords) total += item.bytes + 1;
  return total;
}

/** What a `stat` says about the log this process last read or wrote. */
type DurableSignature = Readonly<{ size: number; mtimeMs: number; ino: number }>;

function sameSignature(left: DurableSignature, right: DurableSignature): boolean {
  return left.size === right.size && left.mtimeMs === right.mtimeMs && left.ino === right.ino;
}

/**
 * The durable append log: one open handle, one line per fact, and a whole-file rewrite only
 * when its live set has to change shape.
 *
 * A transition used to read, parse and rewrite the whole document under the path lock - and
 * that lock's release re-verifies the 67.5 MB Windows stale-lock helper before every spawn,
 * measured at 50-120 ms. A live run spent 28.1 s of one action family's 46.9 s span there. A
 * fact is now appended as one line to an already-open handle and flushed; the reader folds
 * the lines back into exactly the state the document held, so nothing about the journal's
 * meaning changed - only the cost of writing to it.
 */
class JournalLog {
  readonly #path: string;
  readonly #options: NormalizedOpenOptions;
  readonly #maxRecords: number;
  readonly #maxBytes: number;
  readonly #records = new Map<string, EncodedRecord<StardewLogicalActionRecoveryRecord>>();
  readonly #admissions = new Map<string, EncodedRecord<HostNodeAdmissionRecord>>();
  #header: string;
  #bytes: number;
  #handle: FileHandle;
  #signature: DurableSignature;
  #appendedLines = 0;

  private constructor(
    path: string,
    options: NormalizedOpenOptions,
    maxRecords: number,
    maxBytes: number,
    handle: FileHandle,
    folded: FoldedLog,
  ) {
    this.#path = path;
    this.#options = options;
    this.#maxRecords = maxRecords;
    this.#maxBytes = maxBytes;
    this.#handle = handle;
    this.#header = folded.header;
    this.#bytes = lineBytes(folded.header);
    this.#signature = { size: 0, mtimeMs: 0, ino: 0 };
    this.#apply(folded);
  }

  public static async open(options: NormalizedOpenOptions, maxRecords: number, maxBytes: number): Promise<JournalLog> {
    const path = resolve(options.directory, FILE_NAME);
    await mkdir(options.directory, { recursive: true });
    let source = await readIfPresent(path);
    if (source === undefined) {
      // The whole-document format this log replaced is folded in once, then removed: it stays
      // readable, and no legacy file survives to be picked up a second time.
      const legacy = await readLegacyDocument(resolve(options.directory, LEGACY_FILE_NAME), options, maxRecords);
      source =
        legacy === undefined
          ? `${headerLine(options.scope)}\n`
          : logSource(encodeFolded(headerLine(options.scope), legacy.records, legacy.admissionRecords ?? []));
      await writeFile(path, source, legacy === undefined ? { flag: "wx" } : undefined);
      writtenByteCount += Buffer.byteLength(source, "utf8");
      if (legacy !== undefined) await rm(resolve(options.directory, LEGACY_FILE_NAME), { force: true });
    }
    source = await repairTornTail(path, source);
    const folded = parseLog(source, options, maxRecords, maxBytes);
    const handle = await open(path, "a");
    const log = new JournalLog(path, options, maxRecords, maxBytes, handle, folded);
    await log.#captureSignature();
    return log;
  }

  /** The live facts this log holds, newest line per identity. */
  public snapshot(): FoldedLog {
    return {
      header: this.#header,
      records: [...this.#records.values()],
      admissionRecords: [...this.#admissions.values()],
    };
  }

  /** True while the bytes on disk are still the ones this process last read or wrote. */
  public async isCurrent(): Promise<boolean> {
    return sameSignature(await this.#readSignature(), this.#signature);
  }

  public async reload(): Promise<FoldedLog> {
    const source = await repairTornTail(this.#path, await readFile(this.#path, "utf8"));
    const folded = parseLog(source, this.#options, this.#maxRecords, this.#maxBytes);
    this.#header = folded.header;
    this.#apply(folded);
    await this.#captureSignature();
    return this.snapshot();
  }

  /** Durably record one transition. Returns the settled history this write had to drop. */
  public async writeRecord(record: StardewLogicalActionRecoveryRecord): Promise<readonly string[]> {
    if (!(await this.isCurrent())) await this.reload();
    const encoded = encodeRecord(record);
    const previous = this.#records.get(record.logicalActionId);
    this.#storeRecord(encoded);
    if (this.#records.size > this.#maxRecords || this.#bytes > this.#maxBytes) {
      const evicted = this.#evictSettled();
      if (this.#records.size > this.#maxRecords || this.#bytes > this.#maxBytes) {
        // Every remaining record still owes recovery: the refusal is honest, and nothing of
        // this write may survive in memory or on disk.
        this.#restoreRecord(record.logicalActionId, previous);
        throw new Error("recovery_journal_budget_exceeded");
      }
      await this.#publish();
      return evicted;
    }
    await this.#appendLine(recordLine(encoded.fragment));
    if (this.#appendedLines > this.#records.size + COMPACTION_SLACK_LINES) await this.#publish();
    return Object.freeze([]);
  }

  /** Durably record one node admission. Admission records are never evicted. */
  public async writeAdmission(record: HostNodeAdmissionRecord): Promise<void> {
    if (!(await this.isCurrent())) await this.reload();
    const encoded = encodeRecord(record);
    const key = admissionKey(record.challenge);
    if (this.#admissions.has(key)) throw new Error("duplicate_node_admission_record");
    const previousBytes = this.#bytes;
    this.#admissions.set(key, encoded);
    this.#bytes += encoded.bytes + 1;
    if (this.#bytes > this.#maxBytes) {
      this.#evictSettled();
      if (this.#bytes > this.#maxBytes) {
        this.#admissions.delete(key);
        this.#bytes = previousBytes;
        throw new Error("recovery_journal_budget_exceeded");
      }
      await this.#publish();
      return;
    }
    await this.#appendLine(admissionLine(encoded.fragment));
  }

  public async close(): Promise<void> {
    await this.#handle.close().catch(() => undefined);
  }

  #storeRecord(encoded: EncodedRecord<StardewLogicalActionRecoveryRecord>): void {
    const previous = this.#records.get(encoded.record.logicalActionId);
    this.#records.set(encoded.record.logicalActionId, encoded);
    this.#bytes += encoded.bytes + 1 - (previous === undefined ? 0 : previous.bytes + 1);
  }

  #restoreRecord(id: string, previous: EncodedRecord<StardewLogicalActionRecoveryRecord> | undefined): void {
    const current = this.#records.get(id);
    if (current === undefined) return;
    if (previous === undefined) {
      this.#records.delete(id);
      this.#bytes -= current.bytes + 1;
      return;
    }
    this.#records.set(id, previous);
    this.#bytes += previous.bytes - current.bytes;
  }

  /**
   * Drop the OLDEST settled history first, and only as much as the budget requires.
   *
   * Without this the journal is not "bounded", it is a one-way wedge: the write throws
   * `recovery_journal_budget_exceeded` once the record cap is reached, every later write
   * refuses identically, and the Host can no longer create ANY game action - a real ladder
   * session hit exactly that (256 records, 254 of them `terminal_settled`) and the companion
   * could not act for three consecutive runs while the player was told "Game action was not
   * created": a played-through failure for the player, with no recovery path in or out of the
   * game. Only settled history is ever dropped; a record that still owes recovery keeps its
   * evidence, so a budget refusal that remains is attributable to real in-flight volume.
   */
  #evictSettled(): readonly string[] {
    const evicted: string[] = [];
    for (const [id, item] of this.#records) {
      if (this.#records.size <= this.#maxRecords && this.#bytes <= this.#maxBytes) break;
      if (!owesNothing(item.record)) continue;
      this.#records.delete(id);
      this.#bytes -= item.bytes + 1;
      evicted.push(id);
    }
    return Object.freeze(evicted);
  }

  async #appendLine(line: string): Promise<void> {
    appendCount += 1;
    await this.#handle.write(`${line}\n`);
    writtenByteCount += lineBytes(line);
    // `prepare()` must be durable before the bridge write it guards, so this append is
    // flushed before returning. Only this one line reaches the device.
    await this.#handle.sync();
    this.#appendedLines += 1;
    await this.#captureSignature();
  }

  /**
   * Fold the log: one line per live fact, published by rename so a Host killed inside the
   * rewrite leaves either the old log or the new one, never a partial document.
   */
  async #publish(): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      if (attempt > COMPACTION_CONFLICT_ATTEMPTS) throw new Error("recovery_journal_write_failed");
      const source = logSource(this.snapshot());
      const temporary = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
      const handle = await open(temporary, "wx");
      try {
        compactionCount += 1;
        await handle.write(source);
        writtenByteCount += Buffer.byteLength(source, "utf8");
        await handle.sync();
      } finally {
        await handle.close().catch(() => undefined);
      }
      if (!(await this.isCurrent())) {
        // Another writer appended while this rewrite was being prepared. Those lines are
        // durable facts, so fold them in and rewrite again rather than replace them.
        await rm(temporary, { force: true }).catch(() => undefined);
        await this.reload();
        this.#evictSettled();
        continue;
      }
      await this.#handle.close().catch(() => undefined);
      await rename(temporary, this.#path);
      this.#handle = await open(this.#path, "a");
      this.#appendedLines = 0;
      await this.#captureSignature();
      return;
    }
  }

  #apply(folded: FoldedLog): void {
    this.#records.clear();
    this.#admissions.clear();
    this.#bytes = lineBytes(folded.header);
    for (const item of folded.records) {
      this.#records.set(item.record.logicalActionId, item);
      this.#bytes += item.bytes + 1;
    }
    for (const item of folded.admissionRecords) {
      this.#admissions.set(admissionKey(item.record.challenge), item);
      this.#bytes += item.bytes + 1;
    }
  }

  async #readSignature(): Promise<DurableSignature> {
    const stats = await stat(this.#path);
    return { size: stats.size, mtimeMs: stats.mtimeMs, ino: stats.ino };
  }

  async #captureSignature(): Promise<void> {
    this.#signature = await this.#readSignature();
  }
}

function encodeFolded(
  header: string,
  records: readonly StardewLogicalActionRecoveryRecord[],
  admissionRecords: readonly HostNodeAdmissionRecord[],
): FoldedLog {
  return {
    header,
    records: records.map(encodeRecord),
    admissionRecords: admissionRecords.map(encodeRecord),
  };
}

export class StardewLogicalActionRecoveryJournal {
  readonly #records = new Map<string, StardewLogicalActionRecoveryRecord>();
  readonly #requestIds = new Map<string, string>();
  readonly #idempotencyKeys = new Map<string, string>();
  readonly #dispatchOrdinals = new Map<number, string>();
  readonly #admissionRecords = new Map<string, HostNodeAdmissionRecord>();
  #writeRecovery: RecoveryRecordWriter;
  #writeAdmission: AdmissionRecordWriter;
  #log: JournalLog | undefined;
  #scope: Readonly<Record<string, unknown>> | undefined;
  #scopeConfigured = false;
  #closed = false;
  #nextDispatchOrdinal = 1;
  #tail: Promise<void> = Promise.resolve();

  public constructor(options: StardewLogicalActionRecoveryJournalOptions = {}) {
    const writer = options.write ?? (() => undefined);
    this.#writeRecovery = (record) =>
      Promise.resolve(writer(record)).then((durable) => ({ saved: durable ?? record, evicted: [] }));
    this.#writeAdmission = (record) => Promise.resolve(writer(record)).then(() => undefined);
    for (const record of options.initialRecords ?? []) this.#seed(record);
  }

  /** Open the durable, bounded Host-owned journal. */
  public static async open(
    options: StardewLogicalActionRecoveryJournalOpenOptions,
  ): Promise<StardewLogicalActionRecoveryJournal> {
    const normalized = normalizeOpenOptions(options);
    const maxRecords = normalized.maxRecords ?? DEFAULT_MAX_RECORDS;
    const maxBytes = normalized.maxBytes ?? DEFAULT_MAX_BYTES;
    assertBudget(maxRecords, maxBytes);
    const log = await JournalLog.open(normalized, maxRecords, maxBytes);
    const journal = new StardewLogicalActionRecoveryJournal();
    journal.#scope = normalized.scope;
    journal.#scopeConfigured = true;
    journal.#log = log;
    const folded = log.snapshot();
    for (const item of folded.records) journal.#seed(item.record);
    for (const item of folded.admissionRecords) journal.#seedAdmission(item.record);

    journal.#writeAdmission = (record) => log.writeAdmission(record);
    journal.#writeRecovery = async (record) => ({
      saved: record,
      evicted: await log.writeRecord(record),
    });
    return journal;
  }

  public async close(): Promise<void> {
    this.#closed = true;
    await this.#tail;
    const log = this.#log;
    this.#log = undefined;
    await log?.close();
  }

  public allocateDispatchOrdinal(): number {
    if (this.#closed) throw new Error("recovery_journal_closed");
    return this.#nextDispatchOrdinal++;
  }

  public prepare(
    record: Omit<StardewLogicalActionRecoveryRecord, "state">,
  ): Promise<StardewLogicalActionRecoveryRecord> {
    assertRecord({ ...record, state: "prepared" });
    const prepared = freezeRecord({ ...record, state: "prepared" });
    return this.#enqueue(async () => {
      this.#assertOpen();
      await this.#refresh();
      this.#assertNew(prepared);
      return this.#commitNew(prepared);
    });
  }

  public markSentUnknown(id: string): Promise<StardewLogicalActionRecoveryRecord> {
    return this.#transition(id, "sent_unknown");
  }
  public markRecoveryPending(id: string): Promise<StardewLogicalActionRecoveryRecord> {
    return this.#transition(id, "recovery_pending");
  }
  public markTerminalSettled(id: string): Promise<StardewLogicalActionRecoveryRecord> {
    return this.#transition(id, "terminal_settled");
  }
  public markRecoveryRequired(id: string): Promise<StardewLogicalActionRecoveryRecord> {
    return this.#transition(id, "recovery_required");
  }

  public record(id: string): StardewLogicalActionRecoveryRecord | null {
    return this.#records.get(id) ?? null;
  }
  public records(): readonly StardewLogicalActionRecoveryRecord[] {
    return Object.freeze([...this.#records.values()]);
  }
  /** Durable exact-node Host transport records; never a Mod program graph or fact store. */
  public admissionRecord(challenge: BodyNodeAdmissionChallenge): HostNodeAdmissionRecord | null {
    try {
      assertNodeAdmissionChallenge(challenge);
    } catch (error) {
      if (error instanceof Error && error.message === "invalid_recovery_journal_record") {
        throw new Error("node_admission_challenge_mismatch");
      }
      throw error;
    }
    const record = this.#admissionRecords.get(admissionKey(challenge));
    if (record !== undefined && !sameAdmissionChallenge(record.challenge, challenge))
      throw new Error("node_admission_challenge_mismatch");
    return record ?? null;
  }
  public async recordAdmission(record: HostNodeAdmissionRecord): Promise<HostNodeAdmissionRecord> {
    assertAdmissionRecord(record);
    return this.#enqueue(async () => {
      this.#assertOpen();
      await this.#refresh();
      const key = admissionKey(record.challenge);
      const existing = this.#admissionRecords.get(key);
      if (existing !== undefined) {
        if (!sameAdmissionChallenge(existing.challenge, record.challenge) || !sameOptional(existing, record))
          throw new Error("duplicate_node_admission_record");
        return existing;
      }
      await this.#writeAdmission(record);
      const saved = freezeAdmissionRecord(record);
      this.#admissionRecords.set(key, saved);
      return saved;
    });
  }
  public recoverableRecords(): readonly StardewLogicalActionRecoveryRecord[] {
    return Object.freeze(
      [...this.#records.values()].filter(
        (record) =>
          record.state === "prepared" || record.state === "sent_unknown" || record.state === "recovery_pending",
      ),
    );
  }

  #seedAdmission(input: HostNodeAdmissionRecord): void {
    assertAdmissionRecord(input);
    const record = freezeAdmissionRecord(input);
    const key = admissionKey(record.challenge);
    if (this.#admissionRecords.has(key)) throw new Error("duplicate_node_admission_record");
    this.#admissionRecords.set(key, record);
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(operation);
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("recovery_journal_closed");
  }

  /**
   * Fold in anything another writer appended since this process last touched the log, so the
   * decision about to be taken rests on the durable facts and not on a stale view. One `stat`
   * per operation: a changed size, mtime or file identity means these bytes are not ours.
   */
  async #refresh(): Promise<void> {
    const log = this.#log;
    if (log === undefined || (await log.isCurrent())) return;
    this.#rebuild(await log.reload());
  }

  #rebuild(folded: FoldedLog): void {
    const previous = new Map(this.#records);
    // A record this process already holds may gain a newer state, but never different
    // immutable material: a durable line that rewrites what an action IS is refused here, and
    // not quietly adopted because it happens to be the newest line on disk.
    for (const item of folded.records) {
      const held = previous.get(item.record.logicalActionId);
      if (held !== undefined) assertSameImmutableMaterial(held, item.record);
    }
    this.#records.clear();
    this.#requestIds.clear();
    this.#idempotencyKeys.clear();
    this.#dispatchOrdinals.clear();
    this.#admissionRecords.clear();
    this.#nextDispatchOrdinal = 1;
    for (const item of folded.records) this.#seed(item.record);
    for (const item of folded.admissionRecords) this.#seedAdmission(item.record);
    this.#forget([...previous.keys()].filter((id) => !this.#records.has(id)));
  }

  #seed(input: StardewLogicalActionRecoveryRecord): void {
    assertRecord(input);
    const record = freezeRecord(input);
    this.#assertNew(record);
    this.#records.set(record.logicalActionId, record);
    this.#requestIds.set(record.requestId, record.logicalActionId);
    this.#idempotencyKeys.set(record.idempotencyKey, record.logicalActionId);
    this.#dispatchOrdinals.set(record.dispatchOrdinal, record.logicalActionId);
    this.#nextDispatchOrdinal = Math.max(this.#nextDispatchOrdinal, record.dispatchOrdinal + 1);
  }

  #assertNew(record: StardewLogicalActionRecoveryRecord): void {
    assertRecord(record);
    if (this.#scopeConfigured && !sameOptional(record.scope, this.#scope)) {
      throw new Error("recovery_journal_scope_mismatch");
    }
    if (
      this.#records.has(record.logicalActionId) ||
      this.#requestIds.has(record.requestId) ||
      this.#idempotencyKeys.has(record.idempotencyKey) ||
      this.#dispatchOrdinals.has(record.dispatchOrdinal)
    ) {
      throw new Error("duplicate_recovery_journal_record");
    }
  }

  #commitNew(record: StardewLogicalActionRecoveryRecord): Promise<StardewLogicalActionRecoveryRecord> {
    return Promise.resolve()
      .then(() => this.#writeRecovery(record))
      .then(({ saved, evicted }) => {
        this.#forget(evicted);
        this.#records.set(saved.logicalActionId, saved);
        this.#requestIds.set(saved.requestId, saved.logicalActionId);
        this.#idempotencyKeys.set(saved.idempotencyKey, saved.logicalActionId);
        this.#dispatchOrdinals.set(saved.dispatchOrdinal, saved.logicalActionId);
        this.#nextDispatchOrdinal = Math.max(this.#nextDispatchOrdinal, saved.dispatchOrdinal + 1);
        return saved;
      })
      .catch((error: unknown) => {
        if (isJournalError(error)) throw error;
        throw new Error("recovery_journal_write_failed");
      });
  }

  /**
   * Drop records the durable journal no longer holds (settled history evicted to stay
   * inside the journal's budget). Every index that pointed at them goes with them, so the
   * in-memory view and the log cannot disagree about what the journal contains.
   */
  #forget(ids: readonly string[]): void {
    for (const id of ids) {
      const record = this.#records.get(id);
      if (record === undefined) continue;
      this.#records.delete(id);
      if (this.#requestIds.get(record.requestId) === id) this.#requestIds.delete(record.requestId);
      if (this.#idempotencyKeys.get(record.idempotencyKey) === id) this.#idempotencyKeys.delete(record.idempotencyKey);
      if (this.#dispatchOrdinals.get(record.dispatchOrdinal) === id)
        this.#dispatchOrdinals.delete(record.dispatchOrdinal);
    }
  }

  #transition(id: string, state: StardewLogicalActionRecoveryState): Promise<StardewLogicalActionRecoveryRecord> {
    return this.#enqueue(async () => {
      this.#assertOpen();
      await this.#refresh();
      const current = this.#records.get(id);
      if (!current) throw new Error("unknown_recovery_journal_record");
      if (current.state === state) return current;
      if (current.state === "terminal_settled" || !allowedTransition(current.state, state)) {
        throw new Error("invalid_recovery_journal_transition");
      }
      const next = freezeRecord({ ...current, state });
      return this.#writeRecovery(next).then(({ saved, evicted }) => {
        this.#forget(evicted);
        this.#records.set(id, saved);
        return saved;
      });
    });
  }
}

/**
 * Fold the log's lines back into the state the whole-document format carried: the newest line
 * for an identity wins, and every surviving record is validated exactly as strictly as a
 * document record was.
 */
function parseLog(source: string, options: NormalizedOpenOptions, maxRecords: number, maxBytes: number): FoldedLog {
  documentParseCount += 1;
  const lines = source.split("\n").filter((line) => line.length > 0);
  if (lines.length === 0) throw new Error("invalid_recovery_journal_document");
  const header = parseLine(lines[0]!);
  if (
    !isRecord(header) ||
    header.kind !== "header" ||
    header.schemaVersion !== LOG_SCHEMA_VERSION ||
    !isOptionalJsonRecord(header.scope) ||
    !sameOptional(header.scope, options.scope) ||
    !exactKeys(header, ["kind", "schemaVersion", ...(header.scope === undefined ? [] : ["scope"])])
  ) {
    throw new Error("invalid_recovery_journal_document");
  }
  const records = new Map<string, EncodedRecord<StardewLogicalActionRecoveryRecord>>();
  const admissions = new Map<string, EncodedRecord<HostNodeAdmissionRecord>>();
  const requestOwners = new Map<string, string>();
  const keyOwners = new Map<string, string>();
  const ordinalOwners = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const entry = parseLine(line);
    if (
      !isRecord(entry) ||
      (entry.kind !== "record" && entry.kind !== "admission") ||
      !exactKeys(entry, ["kind", "value"])
    ) {
      throw new Error("invalid_recovery_journal_document");
    }
    if (entry.kind === "admission") {
      if (!isHostNodeAdmissionRecord(entry.value)) throw new Error("invalid_recovery_journal_record");
      const record = freezeAdmissionRecord(entry.value);
      admissions.set(admissionKey(record.challenge), encodeRecord(record));
      continue;
    }
    const record = freezeRecord(entry.value as StardewLogicalActionRecoveryRecord);
    if (!sameOptional(record.scope, options.scope)) throw new Error("invalid_recovery_journal_scope");
    const owner = record.logicalActionId;
    const existing = records.get(owner);
    if (existing !== undefined) {
      // Immutable material never changes for an identity, and the log may only ever advance
      // through the transitions the writer itself would allow: a later line is a newer fact
      // about the same action, never a different action wearing its identity.
      assertSameImmutableMaterial(existing.record, record);
      if (existing.record.state !== record.state && !allowedTransition(existing.record.state, record.state))
        throw new Error("invalid_recovery_journal_record");
    }
    // An identity belongs to one logical action for the whole journal; a line that hands it to
    // a second action is a corrupt or foreign document, not a newer fact.
    if (
      claimsOtherAction(requestOwners, record.requestId, owner) ||
      claimsOtherAction(keyOwners, record.idempotencyKey, owner) ||
      claimsOtherAction(ordinalOwners, String(record.dispatchOrdinal), owner)
    ) {
      throw new Error("invalid_recovery_journal_scope");
    }
    records.set(owner, encodeRecord(record));
  }
  if (records.size > maxRecords) throw new Error("invalid_recovery_journal_document");
  const folded: FoldedLog = {
    header: lines[0]!,
    records: [...records.values()],
    admissionRecords: [...admissions.values()],
  };
  if (foldedBytes(folded) > maxBytes) throw new Error("recovery_journal_budget_exceeded");
  return folded;
}

function parseLine(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    throw new Error("invalid_recovery_journal_document");
  }
}

function claimsOtherAction(owners: Map<string, string>, identity: string, owner: string): boolean {
  const existing = owners.get(identity);
  if (existing !== undefined && existing !== owner) return true;
  owners.set(identity, owner);
  return false;
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Cut a crash-torn tail back to a whole line.
 *
 * The log's unit is a newline-terminated line, so a Host killed inside an append leaves a PREFIX
 * of the fact it was writing: bytes that are not a fact, on a file whose earlier lines are.
 * Folding that fragment would refuse the whole journal and lose every durable fact in it, and
 * appending after it would glue the next line onto the fragment and lose that one too. The
 * fragment is therefore dropped, and the file is truncated to its last complete line, before
 * anything is folded or appended. A file with no complete line at all is left untouched: it was
 * never a log, and it is refused rather than replaced.
 */
async function repairTornTail(path: string, source: string): Promise<string> {
  if (source.endsWith("\n")) return source;
  const repaired = source.slice(0, source.lastIndexOf("\n") + 1);
  if (repaired.length === 0) return source;
  const handle = await open(path, "r+");
  try {
    await handle.truncate(Buffer.byteLength(repaired, "utf8"));
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
  return repaired;
}

/** Read the replaced whole-document format, strictly, once. */
async function readLegacyDocument(
  path: string,
  options: NormalizedOpenOptions,
  maxRecords: number,
): Promise<Document | undefined> {
  let value: unknown;
  // "No legacy document" is the normal case once a journal has been migrated, and the strict reader reports a missing
  // file as `invalid_strict_json_file` with the ENOENT buried in its cause - so the check is a stat, not a catch on the
  // error shape. Measured 2026-10-22: after the append-only migration removed the v1 file, every open crashed here at
  // step 0 with `invalid_strict_json_file`, which reads like corruption rather than "nothing to migrate".
  let present = true;
  try {
    await stat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") present = false;
    else throw error;
  }
  if (!present) return undefined;
  try {
    documentParseCount += 1;
    value = await readStrictJsonFile(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  return validateDocument(value, options, maxRecords);
}

function allowedTransition(from: StardewLogicalActionRecoveryState, to: StardewLogicalActionRecoveryState): boolean {
  if (to === "recovery_required") return from !== "terminal_settled";
  if (from === "prepared") return to === "sent_unknown" || to === "recovery_pending" || to === "terminal_settled";
  if (from === "sent_unknown") return to === "recovery_pending" || to === "terminal_settled";
  if (from === "recovery_pending") return to === "terminal_settled";
  return false;
}

function normalizeOpenOptions(options: StardewLogicalActionRecoveryJournalOpenOptions): NormalizedOpenOptions {
  if (
    !isRecord(options) ||
    Object.keys(options).some((key) => !["directory", "scope", "maxRecords", "maxBytes"].includes(key))
  ) {
    throw new Error("invalid_recovery_journal_scope");
  }
  if (options.scope !== undefined && (!isRecord(options.scope) || !isJsonSafe(options.scope))) {
    throw new Error("invalid_recovery_journal_scope");
  }
  return deepFreeze({
    ...options,
    ...(options.scope === undefined ? {} : { scope: canonicalize(options.scope) }),
  }) as NormalizedOpenOptions;
}

function assertBudget(maxRecords: number, maxBytes: number): void {
  if (
    !Number.isSafeInteger(maxRecords) ||
    maxRecords < 1 ||
    maxRecords > 4096 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1024 ||
    maxBytes > 21 * 1024 * 1024
  ) {
    throw new Error("invalid_recovery_journal_budget");
  }
}

/** Validates a whole-document payload from the format this journal replaced. */
function validateDocument(value: unknown, options: NormalizedOpenOptions, maxRecords: number): Document {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.records) ||
    (value.admissionRecords !== undefined && !Array.isArray(value.admissionRecords)) ||
    value.records.length > maxRecords ||
    !isOptionalJsonRecord(value.scope) ||
    !sameOptional(value.scope, options.scope) ||
    !exactKeys(value, [
      "schemaVersion",
      "records",
      ...(options.scope === undefined ? [] : ["scope"]),
      ...(value.admissionRecords === undefined ? [] : ["admissionRecords"]),
    ])
  ) {
    throw new Error("invalid_recovery_journal_document");
  }
  const seenLogical = new Set<string>();
  const seenRequest = new Set<string>();
  const seenIdempotency = new Set<string>();
  const seenOrdinal = new Set<number>();
  const records = value.records.map((item) => {
    if (!isRecord(item)) throw new Error("invalid_recovery_journal_record");
    const record = item as StardewLogicalActionRecoveryRecord;
    assertRecord(record);
    if (
      !sameOptional(record.scope, options.scope) ||
      seenLogical.has(record.logicalActionId) ||
      seenRequest.has(record.requestId) ||
      seenIdempotency.has(record.idempotencyKey) ||
      seenOrdinal.has(record.dispatchOrdinal)
    ) {
      throw new Error("invalid_recovery_journal_scope");
    }
    seenLogical.add(record.logicalActionId);
    seenRequest.add(record.requestId);
    seenIdempotency.add(record.idempotencyKey);
    seenOrdinal.add(record.dispatchOrdinal);
    return freezeRecord(record);
  });
  const admissionRecords = ((value.admissionRecords ?? []) as unknown[]).map((item: unknown) => {
    if (!isHostNodeAdmissionRecord(item)) throw new Error("invalid_recovery_journal_record");
    return freezeAdmissionRecord(item);
  });
  return {
    schemaVersion: 1,
    ...(options.scope === undefined ? {} : { scope: options.scope as Record<string, unknown> }),
    records,
    ...(admissionRecords.length === 0 ? {} : { admissionRecords }),
  };
}

function assertRecord(record: StardewLogicalActionRecoveryRecord): void {
  if (
    !exactRecordKeys(record) ||
    !validText(record.logicalActionId) ||
    !Number.isSafeInteger(record.dispatchOrdinal) ||
    record.dispatchOrdinal < 1 ||
    !validText(record.ownerId) ||
    !Number.isSafeInteger(record.epoch) ||
    record.epoch < 0 ||
    !validText(record.requestId) ||
    !validText(record.idempotencyKey) ||
    !validText(record.actionId) ||
    !isExecutionRequest(record.canonicalRequest) ||
    !isRecord(record.canonicalArgs) ||
    !Number.isSafeInteger(record.expectedRevision) ||
    record.expectedRevision < 0 ||
    !Number.isFinite(record.deadlineMs) ||
    !isOptionalJsonRecord(record.scope) ||
    !isOptionalJsonRecord(record.bindingIdentity) ||
    !isJsonSafe(record.canonicalRequest) ||
    !isJsonSafe(record.canonicalArgs) ||
    !STARDEW_LOGICAL_ACTION_RECOVERY_STATES.includes(record.state) ||
    record.canonicalRequest.requestId !== record.requestId ||
    record.canonicalRequest.idempotencyKey !== record.idempotencyKey ||
    record.canonicalRequest.action !== record.actionId ||
    record.canonicalRequest.expectedRevision !== record.expectedRevision ||
    record.canonicalRequest.deadlineMs !== record.deadlineMs ||
    !sameOptional(record.canonicalArgs, record.canonicalRequest.args)
  ) {
    throw new Error("invalid_recovery_journal_record");
  }
}

function isExecutionRequest(value: unknown): value is ExecutionRequest {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["requestId", "idempotencyKey", "action", "args", "expectedRevision", "deadlineMs"]) ||
    !validText(value.requestId) ||
    !validText(value.idempotencyKey) ||
    typeof value.action !== "string" ||
    !isRecord(value.args) ||
    !Number.isSafeInteger(value.expectedRevision) ||
    value.expectedRevision < 0 ||
    !Number.isFinite(value.deadlineMs) ||
    !isJsonSafe(value.args)
  ) {
    return false;
  }
  return true;
}

function freezeRecord(record: StardewLogicalActionRecoveryRecord): StardewLogicalActionRecoveryRecord {
  return deepFreeze(canonicalize(record)) as StardewLogicalActionRecoveryRecord;
}

function assertSameImmutableMaterial(
  left: StardewLogicalActionRecoveryRecord,
  right: StardewLogicalActionRecoveryRecord,
): void {
  if (
    left.logicalActionId !== right.logicalActionId ||
    left.ownerId !== right.ownerId ||
    left.epoch !== right.epoch ||
    left.requestId !== right.requestId ||
    left.idempotencyKey !== right.idempotencyKey ||
    left.dispatchOrdinal !== right.dispatchOrdinal ||
    left.actionId !== right.actionId ||
    left.expectedRevision !== right.expectedRevision ||
    left.deadlineMs !== right.deadlineMs ||
    !sameOptional(left.scope, right.scope) ||
    !sameOptional(left.bindingIdentity, right.bindingIdentity) ||
    !sameOptional(left.canonicalArgs, right.canonicalArgs) ||
    !sameOptional(left.canonicalRequest, right.canonicalRequest)
  ) {
    throw new Error("invalid_recovery_journal_record");
  }
}

function canonicalize(value: unknown): any {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) output[key] = canonicalize(value[key]);
    return output;
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as object)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonSafe(value: unknown, ancestors = new Set<object>(), depth = 0): boolean {
  if (depth > MAX_JSON_DEPTH) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "string") return value.length <= MAX_JSON_STRING_LENGTH;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return false;
    ancestors.add(value);
    const valid = value.every((item) => isJsonSafe(item, ancestors, depth + 1));
    ancestors.delete(value);
    return valid;
  }
  if (isRecord(value)) {
    if (ancestors.has(value) || Object.keys(value).some((key) => key === "__proto__")) return false;
    ancestors.add(value);
    const valid = Object.keys(value).every((key) => isJsonSafe(value[key], ancestors, depth + 1));
    ancestors.delete(value);
    return valid;
  }
  return false;
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function isOptionalJsonRecord(value: unknown): value is Readonly<Record<string, unknown>> | undefined {
  return value === undefined || (isRecord(value) && isJsonSafe(value));
}

function sameOptional(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function exactRecordKeys(record: Record<string, unknown>): boolean {
  return exactKeys(record, [
    "actionId",
    "canonicalArgs",
    "canonicalRequest",
    "deadlineMs",
    "dispatchOrdinal",
    "epoch",
    "expectedRevision",
    "idempotencyKey",
    "logicalActionId",
    "ownerId",
    "requestId",
    "state",
    ...(record.scope === undefined ? [] : ["scope"]),
    ...(record.bindingIdentity === undefined ? [] : ["bindingIdentity"]),
  ]);
}

function isJournalError(error: unknown): boolean {
  return (
    error instanceof Error &&
    [
      "recovery_journal_closed",
      "duplicate_recovery_journal_record",
      "invalid_recovery_journal_record",
      "invalid_recovery_journal_transition",
      "unknown_recovery_journal_record",
      "recovery_journal_scope_mismatch",
      "recovery_journal_budget_exceeded",
      "duplicate_node_admission_record",
    ].includes(error.message)
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}

function isHostNodeAdmissionRecord(value: unknown): value is HostNodeAdmissionRecord {
  try {
    assertAdmissionRecord(value as HostNodeAdmissionRecord);
    return true;
  } catch {
    return false;
  }
}

function assertAdmissionRecord(record: HostNodeAdmissionRecord): void {
  if (
    !isRecord(record) ||
    !exactKeys(record, [
      "challenge",
      "state",
      ...(record.grant === undefined ? [] : ["grant"]),
      ...(record.rejectionCode === undefined ? [] : ["rejectionCode"]),
    ])
  )
    throw new Error("invalid_recovery_journal_record");
  assertNodeAdmissionChallenge(record.challenge);
  if (!HOST_NODE_ADMISSION_STATES.includes(record.state)) throw new Error("invalid_recovery_journal_record");
  if (record.state === "grant_issued") {
    if (record.grant === undefined || record.rejectionCode !== undefined)
      throw new Error("invalid_recovery_journal_record");
    assertHostAdmissionGrant(record.grant);
    if (!sameAdmissionChallenge(grantChallenge(record.grant), record.challenge))
      throw new Error("invalid_recovery_journal_record");
  } else if (
    record.grant !== undefined ||
    (record.state === "admission_rejected" && !validText(record.rejectionCode ?? "")) ||
    (record.state !== "admission_rejected" && record.rejectionCode !== undefined)
  ) {
    throw new Error("invalid_recovery_journal_record");
  }
}

function assertNodeAdmissionChallenge(challenge: BodyNodeAdmissionChallenge): void {
  if (validateBodyNodeAdmissionPayload(challenge) !== null) throw new Error("invalid_recovery_journal_record");
}

function assertHostAdmissionGrant(grant: BodyNodeAdmissionGrant): void {
  if (validateBodyNodeAdmissionPayload(grant, true) !== null) throw new Error("invalid_recovery_journal_record");
}

function grantChallenge(grant: BodyNodeAdmissionGrant): BodyNodeAdmissionChallenge {
  const {
    grantId: _grantId,
    attachmentGeneration: _attachmentGeneration,
    policyRevision: _policyRevision,
    executionBinding: _executionBinding,
    ...challenge
  } = grant;
  return challenge;
}

function admissionKey(challenge: BodyNodeAdmissionChallenge): string {
  // JSON encodes each string independently, so permitted NULs cannot shift a
  // delimiter boundary or make distinct controller-named tuples collide.
  return JSON.stringify([challenge.programId, challenge.nodeId, challenge.nodeAttempt, challenge.admissionAttempt]);
}
function sameAdmissionChallenge(left: BodyNodeAdmissionChallenge, right: BodyNodeAdmissionChallenge): boolean {
  return sameOptional(left, right);
}
function freezeAdmissionRecord(record: HostNodeAdmissionRecord): HostNodeAdmissionRecord {
  return deepFreeze(canonicalize(record)) as HostNodeAdmissionRecord;
}
