import { atomicWriteFile, withPathLock } from "./path-lock.js";
import { readStrictJsonFile } from "./strict-json-reader.js";
import {
  validateBodyNodeAdmissionPayload,
  type BodyNodeAdmissionChallenge,
  type BodyNodeAdmissionGrant,
  type ExecutionRequest,
} from "./protocol.js";
import { resolve } from "node:path";

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
  (record: StardewLogicalActionRecoveryRecord): StardewLogicalActionRecoveryRecord | Promise<StardewLogicalActionRecoveryRecord>;
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

const FILE_NAME = "stardew-logical-action-recovery-journal.json";
const DEFAULT_MAX_RECORDS = 256;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_STRING_LENGTH = 16 * 1024;

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

/**
 * Make a document fit the journal's budget by dropping the OLDEST settled history first.
 *
 * Without this the journal is not "bounded", it is a one-way wedge: `#writeRecovery` throws
 * `recovery_journal_budget_exceeded` once the record cap is reached, every later write
 * re-validates the same full document and throws identically, and the Host can no longer
 * create ANY game action — a real ladder session hit exactly that (256 records, 254 of them
 * `terminal_settled`) and the companion could not act for three consecutive runs while the
 * player was told "Game action was not created": a played-through failure for the player,
 * with no recovery path in or out of the game.
 *
 * Eviction is deliberately conservative: only settled history is dropped, and only as much
 * as the budget requires. If the budget cannot be met while keeping every record that still
 * owes recovery, this returns the unbounded document and the caller's budget refusal stands
 * — a refusal that is then honest, because the in-flight set alone is over budget.
 */
function makeRoom(
  document: Document,
  maxRecords: number,
  maxBytes: number,
  encode: (candidate: Document) => string = (candidate) => JSON.stringify(candidate),
): Document {
  let current = document;
  for (;;) {
    const encoded = encode(current);
    if (current.records.length <= maxRecords && Buffer.byteLength(encoded, "utf8") <= maxBytes) return current;
    const victim = current.records.findIndex((record) => owesNothing(record));
    if (victim < 0) return current;
    current = makeDocumentFrom(current, current.records.filter((_, index) => index !== victim));
  }
}

export class StardewLogicalActionRecoveryJournal {
  readonly #records = new Map<string, StardewLogicalActionRecoveryRecord>();
  readonly #requestIds = new Map<string, string>();
  readonly #idempotencyKeys = new Map<string, string>();
  readonly #dispatchOrdinals = new Map<number, string>();
  readonly #admissionRecords = new Map<string, HostNodeAdmissionRecord>();
  #writeRecovery: RecoveryRecordWriter;
  #writeAdmission: AdmissionRecordWriter;
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
  public static async open(options: StardewLogicalActionRecoveryJournalOpenOptions): Promise<StardewLogicalActionRecoveryJournal> {
    const normalized = normalizeOpenOptions(options);
    const maxRecords = normalized.maxRecords ?? DEFAULT_MAX_RECORDS;
    const maxBytes = normalized.maxBytes ?? DEFAULT_MAX_BYTES;
    assertBudget(maxRecords, maxBytes);
    const path = resolve(normalized.directory, FILE_NAME);
    let document: Document;

    await withPathLock(
      path,
      async () => {
        try {
          document = validateDocument(await readStrictJsonFile(path, maxBytes), normalized, maxRecords);
        } catch (error) {
          if (!isNodeError(error) || error.code !== "ENOENT") throw error;
          document = makeDocument(normalized);
          const encoded = JSON.stringify(document);
          if (Buffer.byteLength(encoded, "utf8") > maxBytes) throw new Error("recovery_journal_budget_exceeded");
          await atomicWriteFile(path, encoded, normalized.directory);
        }
      },
      { containmentRoot: normalized.directory },
    );

    const journal = new StardewLogicalActionRecoveryJournal();
    journal.#scope = normalized.scope;
    journal.#scopeConfigured = true;
    for (const record of document!.records) journal.#seed(record);
    for (const record of document!.admissionRecords ?? []) journal.#seedAdmission(record);

    journal.#writeAdmission = async (record): Promise<void> => {
      await withPathLock(
        path,
        async () => {
          const current = validateDocument(await readStrictJsonFile(path, maxBytes), normalized, maxRecords);
          const admissionRecords = [...(current.admissionRecords ?? [])];
          if (admissionRecords.some((item) => admissionKey(item.challenge) === admissionKey(record.challenge)))
            throw new Error("duplicate_node_admission_record");
          admissionRecords.push(record);
          // Admission records are not settled history, so eviction never removes one; the
          // bounded document still has to fit, and evicting settled actions is what keeps a
          // long-lived journal writable (see makeRoom).
          const next = makeRoom(makeDocument(normalized, current.records, admissionRecords), maxRecords, maxBytes);
          const encoded = JSON.stringify(next);
          if (Buffer.byteLength(encoded, "utf8") > maxBytes) throw new Error("recovery_journal_budget_exceeded");
          await atomicWriteFile(path, encoded, normalized.directory);
        },
        { containmentRoot: normalized.directory },
      );
    };
    journal.#writeRecovery = async (record): Promise<{ saved: StardewLogicalActionRecoveryRecord; evicted: readonly string[] }> => {
      let durableRecord: StardewLogicalActionRecoveryRecord | undefined;
      let evicted: readonly string[] = [];
      await withPathLock(
        path,
        async () => {
          const current = validateDocument(await readStrictJsonFile(path, maxBytes), normalized, maxRecords);
          const records = [...current.records];
          const index = records.findIndex((item) => item.logicalActionId === record.logicalActionId);
          if (index < 0) {
            if (record.state !== "prepared" || records.some((item) => sameIdentity(item, record))) {
              throw new Error("duplicate_recovery_journal_record");
            }
            records.push(record);
            durableRecord = record;
          } else {
            const existing = records[index]!;
            assertSameImmutableMaterial(existing, record);
            if (record.state === "prepared") throw new Error("duplicate_recovery_journal_record");
            if (existing.state === record.state) {
              durableRecord = existing;
            } else {
              if (!allowedTransition(existing.state, record.state)) {
                throw new Error("invalid_recovery_journal_transition");
              }
              records[index] = record;
              durableRecord = record;
            }
          }
          const next = makeRoom(makeDocument(normalized, records, current.admissionRecords ?? []), maxRecords, maxBytes);
          const encoded = JSON.stringify(next);
          if (next.records.length > maxRecords || Buffer.byteLength(encoded, "utf8") > maxBytes) {
            throw new Error("recovery_journal_budget_exceeded");
          }
          // Tell the in-memory view which settled records the durable document no longer
          // holds, so memory and disk cannot disagree about what the journal contains.
          const kept = new Set(next.records.map((item) => item.logicalActionId));
          evicted = records.filter((item) => !kept.has(item.logicalActionId)).map((item) => item.logicalActionId);
          await atomicWriteFile(path, encoded, normalized.directory);
        },
        { containmentRoot: normalized.directory },
      );
      return { saved: durableRecord!, evicted };
    };
    return journal;
  }

  public async close(): Promise<void> {
    this.#closed = true;
    await this.#tail;
  }

  public allocateDispatchOrdinal(): number {
    if (this.#closed) throw new Error("recovery_journal_closed");
    return this.#nextDispatchOrdinal++;
  }

  public prepare(record: Omit<StardewLogicalActionRecoveryRecord, "state">): Promise<StardewLogicalActionRecoveryRecord> {
    assertRecord({ ...record, state: "prepared" });
    const prepared = freezeRecord({ ...record, state: "prepared" });
    return this.#enqueue(async () => {
      this.#assertOpen();
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
        (record) => record.state === "prepared" || record.state === "sent_unknown" || record.state === "recovery_pending",
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
   * Drop records the durable document no longer holds (settled history evicted to stay
   * inside the journal's budget). Every index that pointed at them goes with them, so the
   * in-memory view and the file cannot disagree about what the journal contains.
   */
  #forget(ids: readonly string[]): void {
    for (const id of ids) {
      const record = this.#records.get(id);
      if (record === undefined) continue;
      this.#records.delete(id);
      if (this.#requestIds.get(record.requestId) === id) this.#requestIds.delete(record.requestId);
      if (this.#idempotencyKeys.get(record.idempotencyKey) === id)
        this.#idempotencyKeys.delete(record.idempotencyKey);
      if (this.#dispatchOrdinals.get(record.dispatchOrdinal) === id)
        this.#dispatchOrdinals.delete(record.dispatchOrdinal);
    }
  }

  #transition(id: string, state: StardewLogicalActionRecoveryState): Promise<StardewLogicalActionRecoveryRecord> {
    return this.#enqueue(async () => {
      this.#assertOpen();
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

function makeDocument(
  options: NormalizedOpenOptions,
  records: StardewLogicalActionRecoveryRecord[] = [],
  admissionRecords: HostNodeAdmissionRecord[] = [],
): Document {
  return canonicalize({
    schemaVersion: 1,
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    records,
    ...(admissionRecords.length === 0 ? {} : { admissionRecords }),
  }) as Document;
}

/**
 * The same document with a different record list, keeping its scope and admission records.
 * Used by eviction, which only ever removes settled history.
 */
function makeDocumentFrom(
  document: Document,
  records: StardewLogicalActionRecoveryRecord[],
  admissionRecords: HostNodeAdmissionRecord[] = document.admissionRecords ?? [],
): Document {
  return canonicalize({
    schemaVersion: 1,
    ...(document.scope === undefined ? {} : { scope: document.scope }),
    records,
    ...(admissionRecords.length === 0 ? {} : { admissionRecords }),
  }) as Document;
}

function validateDocument(value: unknown, options: NormalizedOpenOptions, maxRecords: number): Document {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
     !Array.isArray(value.records) ||
     (value.admissionRecords !== undefined && !Array.isArray(value.admissionRecords)) ||
     value.records.length > maxRecords ||
    !isOptionalJsonRecord(value.scope) ||
    !sameOptional(value.scope, options.scope) ||
     !exactKeys(value, ["schemaVersion", "records", ...(options.scope === undefined ? [] : ["scope"]), ...(value.admissionRecords === undefined ? [] : ["admissionRecords"])])
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
  return makeDocument(options, records, admissionRecords);
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

function sameIdentity(left: StardewLogicalActionRecoveryRecord, right: StardewLogicalActionRecoveryRecord): boolean {
  return (
    left.logicalActionId === right.logicalActionId ||
    left.requestId === right.requestId ||
    left.idempotencyKey === right.idempotencyKey ||
    left.dispatchOrdinal === right.dispatchOrdinal
  );
}

function freezeRecord(record: StardewLogicalActionRecoveryRecord): StardewLogicalActionRecoveryRecord {
  return deepFreeze(canonicalize(record)) as StardewLogicalActionRecoveryRecord;
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
  if (!isRecord(record) || !exactKeys(record, ["challenge", "state", ...(record.grant === undefined ? [] : ["grant"]), ...(record.rejectionCode === undefined ? [] : ["rejectionCode"])]))
    throw new Error("invalid_recovery_journal_record");
  assertNodeAdmissionChallenge(record.challenge);
  if (!HOST_NODE_ADMISSION_STATES.includes(record.state)) throw new Error("invalid_recovery_journal_record");
  if (record.state === "grant_issued") {
    if (record.grant === undefined || record.rejectionCode !== undefined) throw new Error("invalid_recovery_journal_record");
    assertHostAdmissionGrant(record.grant);
    if (!sameAdmissionChallenge(grantChallenge(record.grant), record.challenge)) throw new Error("invalid_recovery_journal_record");
  } else if (record.grant !== undefined || (record.state === "admission_rejected" && !validText(record.rejectionCode ?? "")) || (record.state !== "admission_rejected" && record.rejectionCode !== undefined)) {
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
  return JSON.stringify([
    challenge.programId,
    challenge.nodeId,
    challenge.nodeAttempt,
    challenge.admissionAttempt,
  ]);
}
function sameAdmissionChallenge(left: BodyNodeAdmissionChallenge, right: BodyNodeAdmissionChallenge): boolean {
  return sameOptional(left, right);
}
function freezeAdmissionRecord(record: HostNodeAdmissionRecord): HostNodeAdmissionRecord {
  return deepFreeze(canonicalize(record)) as HostNodeAdmissionRecord;
}
