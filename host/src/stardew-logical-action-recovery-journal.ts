import { atomicWriteFile, withPathLock } from "./path-lock.js";
import { readStrictJsonFile } from "./strict-json-reader.js";
import type { ExecutionRequest } from "./protocol.js";
import { resolve } from "node:path";

export const STARDEW_LOGICAL_ACTION_RECOVERY_STATES = Object.freeze([
  "prepared",
  "sent_unknown",
  "recovery_pending",
  "terminal_settled",
  "recovery_required",
] as const);
export type StardewLogicalActionRecoveryState = (typeof STARDEW_LOGICAL_ACTION_RECOVERY_STATES)[number];

export type StardewLogicalActionRecoveryDispatchMaterial = Readonly<{
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

export type StardewLogicalActionRecoveryJournalOptions = Readonly<{
  initialRecords?: readonly StardewLogicalActionRecoveryRecord[];
  /** Test-only writer; production callers must use open(). */
  write?: (
    record: StardewLogicalActionRecoveryRecord,
  ) => void | StardewLogicalActionRecoveryRecord | Promise<void | StardewLogicalActionRecoveryRecord>;
}>;

export type StardewLogicalActionRecoveryJournalOpenOptions = Readonly<{
  directory: string;
  ownerId: string;
  epoch: number;
  scope?: Readonly<Record<string, unknown>>;
  bindingIdentity?: Readonly<Record<string, unknown>>;
  maxRecords?: number;
  maxBytes?: number;
}>;

type Document = Readonly<{
  schemaVersion: 1;
  ownerId: string;
  epoch: number;
  scope?: Record<string, unknown>;
  bindingIdentity?: Record<string, unknown>;
  records: StardewLogicalActionRecoveryRecord[];
}>;

type NormalizedOpenOptions = StardewLogicalActionRecoveryJournalOpenOptions & {
  scope?: Readonly<Record<string, unknown>>;
  bindingIdentity?: Readonly<Record<string, unknown>>;
};

const FILE_NAME = "stardew-logical-action-recovery-journal.json";
const DEFAULT_MAX_RECORDS = 256;
const DEFAULT_MAX_BYTES = 1024 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_STRING_LENGTH = 16 * 1024;
const ACTION_ARGUMENT_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  move_to_tile: ["x", "y"],
  navigate_to_destination: ["destination"],
  equip_tool: ["slot"],
  travel: ["x", "y"],
  enter_exit: ["x", "y"],
  till_soil: ["x", "y"],
  pickup_forage: ["x", "y", "expectedQualifiedItemId", "expectedTargetId"],
  pickup_item: ["x", "y", "expectedQualifiedItemId", "expectedTargetId"],
  water_crop: ["x", "y", "expectedTargetId"],
  refill_watering_can: ["slot", "x", "y", "expectedTargetId"],
  harvest_crop: ["x", "y", "expectedQualifiedItemId", "expectedTargetId"],
  plant_seed: ["slot", "x", "y", "expectedQualifiedItemId", "expectedTargetId"],
  fertilize_tile: ["slot", "x", "y", "expectedQualifiedItemId", "expectedTargetId"],
  place_wood_fence: ["slot", "x", "y", "expectedQualifiedItemId", "expectedTargetId"],
  place_crab_pot: ["slot", "x", "y", "expectedQualifiedItemId", "expectedTargetId"],
  bait_crab_pot: ["slot", "x", "y", "expectedQualifiedItemId", "expectedTargetId"],
  clear_debris: ["slot", "x", "y", "expectedTargetId"],
  machine_inspect: ["x", "y", "expectedTargetId"],
  machine_load: ["slot", "x", "y", "expectedQualifiedItemId", "expectedTargetId"],
  machine_collect_output: ["x", "y", "expectedTargetId"],
  npc_relationship: ["x", "y", "expectedTargetId"],
  pet_animal: ["x", "y", "expectedTargetId"],
  collect_animal_product: ["slot", "x", "y", "expectedTargetId"],
  feed_animal: ["slot", "x", "y", "expectedTargetId"],
  use_item: ["slot", "expectedQualifiedItemId"],
  chop_tree_source: ["slot", "x", "y", "expectedTargetId"],
  break_rock_source: ["slot", "x", "y", "expectedTargetId"],
  clear_hoedirt: ["slot", "x", "y", "expectedTargetId"],
  dig_artifact_spot: ["slot", "x", "y", "expectedTargetId"],
});

export class StardewLogicalActionRecoveryJournal {
  readonly #records = new Map<string, StardewLogicalActionRecoveryRecord>();
  readonly #requestIds = new Map<string, string>();
  readonly #idempotencyKeys = new Map<string, string>();
  readonly #dispatchOrdinals = new Map<number, string>();
  #write: (
    record: StardewLogicalActionRecoveryRecord,
  ) => void | StardewLogicalActionRecoveryRecord | Promise<void | StardewLogicalActionRecoveryRecord>;
  #scope?: Readonly<Record<string, unknown>>;
  #bindingIdentity?: Readonly<Record<string, unknown>>;
  #ownerId?: string;
  #epoch?: number;
  #closed = false;
  #nextDispatchOrdinal = 1;
  #tail: Promise<void> = Promise.resolve();

  public constructor(options: StardewLogicalActionRecoveryJournalOptions = {}) {
    this.#write = options.write ?? (() => undefined);
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

    const journal = new StardewLogicalActionRecoveryJournal({ initialRecords: document!.records });
    journal.#ownerId = normalized.ownerId;
    journal.#epoch = normalized.epoch;
    journal.#scope = normalized.scope;
    journal.#bindingIdentity = normalized.bindingIdentity;

    journal.#write = async (record): Promise<StardewLogicalActionRecoveryRecord> => {
      let durableRecord: StardewLogicalActionRecoveryRecord | undefined;
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
          const next = makeDocument(normalized, records);
          const encoded = JSON.stringify(next);
          if (records.length > maxRecords || Buffer.byteLength(encoded, "utf8") > maxBytes) {
            throw new Error("recovery_journal_budget_exceeded");
          }
          await atomicWriteFile(path, encoded, normalized.directory);
        },
        { containmentRoot: normalized.directory },
      );
      return durableRecord!;
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
  public recoverableRecords(): readonly StardewLogicalActionRecoveryRecord[] {
    return Object.freeze(
      [...this.#records.values()].filter(
        (record) => record.state === "prepared" || record.state === "sent_unknown" || record.state === "recovery_pending",
      ),
    );
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
    if (
      this.#ownerId !== undefined &&
      (record.ownerId !== this.#ownerId ||
        record.epoch !== this.#epoch ||
        !sameOptional(record.scope, this.#scope) ||
        !sameOptional(record.bindingIdentity, this.#bindingIdentity))
    ) {
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
      .then(() => this.#write(record))
      .then((durable) => {
        const saved = durable ?? record;
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
      return Promise.resolve(this.#write(next)).then((durable) => {
        const saved = durable ?? next;
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
  if (!isRecord(options) || !validText(options.ownerId) || !Number.isSafeInteger(options.epoch) || options.epoch < 0) {
    throw new Error("invalid_recovery_journal_scope");
  }
  if (options.scope !== undefined && (!isRecord(options.scope) || !isJsonSafe(options.scope))) {
    throw new Error("invalid_recovery_journal_scope");
  }
  if (options.bindingIdentity !== undefined && (!isRecord(options.bindingIdentity) || !isJsonSafe(options.bindingIdentity))) {
    throw new Error("invalid_recovery_journal_scope");
  }
  return deepFreeze({
    ...options,
    ...(options.scope === undefined ? {} : { scope: canonicalize(options.scope) }),
    ...(options.bindingIdentity === undefined ? {} : { bindingIdentity: canonicalize(options.bindingIdentity) }),
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

function makeDocument(options: NormalizedOpenOptions, records: StardewLogicalActionRecoveryRecord[] = []): Document {
  return canonicalize({
    schemaVersion: 1,
    ownerId: options.ownerId,
    epoch: options.epoch,
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    ...(options.bindingIdentity === undefined ? {} : { bindingIdentity: options.bindingIdentity }),
    records,
  }) as Document;
}

function validateDocument(value: unknown, options: NormalizedOpenOptions, maxRecords: number): Document {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.ownerId !== options.ownerId ||
    value.epoch !== options.epoch ||
    !Array.isArray(value.records) ||
    value.records.length > maxRecords ||
    !sameOptional(value.scope, options.scope) ||
    !sameOptional(value.bindingIdentity, options.bindingIdentity) ||
    !exactKeys(value, [
      "schemaVersion",
      "ownerId",
      "epoch",
      "records",
      ...(options.scope === undefined ? [] : ["scope"]),
      ...(options.bindingIdentity === undefined ? [] : ["bindingIdentity"]),
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
      record.ownerId !== options.ownerId ||
      record.epoch !== options.epoch ||
      !sameOptional(record.scope, options.scope) ||
      !sameOptional(record.bindingIdentity, options.bindingIdentity) ||
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
  return makeDocument(options, records);
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
    !isJsonSafe(record.scope) ||
    !isJsonSafe(record.bindingIdentity) ||
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
    !Object.hasOwn(ACTION_ARGUMENT_KEYS, value.action) ||
    !isRecord(value.args) ||
    !exactKeys(value.args, ACTION_ARGUMENT_KEYS[value.action]!) ||
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
