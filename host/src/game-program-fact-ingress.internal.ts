export const GAME_PROGRAM_FACT_CUSTOM_TYPE = "gamebuddy.game_program_fact/v1" as const;

const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_FACT_CONTENT_BYTES = 8_192;
const MAX_PENDING_FACTS = 128;

type GameProgramFactClass =
  | "progress"
  | "terminal"
  | "resource_released"
  | "recovery_required";

/**
 * Addressed Mod-authoritative fact. The Host carries it unchanged and never
 * derives program state, completion, resource ownership, or a successor.
 */
type GameProgramFact = Readonly<{
  type: typeof GAME_PROGRAM_FACT_CUSTOM_TYPE;
  cursor: number;
  programId: string;
  nodeId: string;
  nodeAttempt: number;
  factClass: GameProgramFactClass;
  fact: Readonly<Record<string, unknown>>;
}>;

export type GameProgramFactIngressState = Readonly<{
  deliveredCursor: number;
  pending: readonly GameProgramFact[];
}>;

/** The implementation must atomically replace the complete scope-fixed state. */
export interface GameProgramFactIngressStore {
  load(): Promise<GameProgramFactIngressState | undefined>;
  save(state: GameProgramFactIngressState): Promise<void>;
}

/**
 * Pi composition must resolve only after its custom message is durably present
 * in the Pi session. No tool result is accepted by this boundary.
 */
type DurablePiFactConsumer = (record: Readonly<{
  customType: typeof GAME_PROGRAM_FACT_CUSTOM_TYPE;
  content: string;
  details: GameProgramFact;
}>) => Promise<void>;

/** Construction-only consumer surface. It is intentionally not a runtime capability. */
export type GameProgramFactIngressController = Readonly<{
  ingest(record: unknown): Promise<"accepted" | "duplicate" | "coalesced">;
  deliverOne(consumer: DurablePiFactConsumer): Promise<boolean>;
  snapshot(): Promise<GameProgramFactIngressState>;
}>;

/**
 * Creates an offline, scope-local fact queue. Progress replaces only pending
 * progress for its exact program/node/attempt lineage; terminal, resource
 * release, and recovery-required facts are never coalesced or discarded.
 *
 * A restart resumes the committed pending records. A record is removed only
 * after the Pi consumer reports its own durable custom-message write and the
 * replacement state advances the durable delivery cursor.
 */
export function createGameProgramFactIngress(
  store: GameProgramFactIngressStore,
): GameProgramFactIngressController {
  let operation: Promise<void> = Promise.resolve();

  const exclusive = async <T>(callback: () => Promise<T>): Promise<T> => {
    const previous = operation;
    let release!: () => void;
    operation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await callback();
    } finally {
      release();
    }
  };

  const read = async (): Promise<GameProgramFactIngressState> => normalizeState(await store.load());
  const write = async (state: GameProgramFactIngressState): Promise<void> => store.save(freezeState(state));

  return Object.freeze({
    ingest: (record) =>
      exclusive(async () => {
        const fact = decodeGameProgramFact(record);
        const state = await read();
        if (fact.cursor <= state.deliveredCursor || state.pending.some((item) => item.cursor === fact.cursor))
          return "duplicate";
        const newestPendingCursor = state.pending.at(-1)?.cursor;
        if (newestPendingCursor !== undefined && fact.cursor <= newestPendingCursor)
          throw new Error("game_program_fact_cursor_out_of_order");
        if (state.pending.length >= MAX_PENDING_FACTS && fact.factClass !== "progress")
          throw new Error("game_program_fact_non_droppable_overflow");
        const progressIndex =
          fact.factClass === "progress"
            ? state.pending.findIndex((item) => item.factClass === "progress" && sameLineage(item, fact))
            : -1;
        if (progressIndex >= 0) {
          const pending = [...state.pending];
          pending.splice(progressIndex, 1);
          insertPendingByCursor(pending, fact);
          await write({ deliveredCursor: state.deliveredCursor, pending });
          return "coalesced";
        }
        if (state.pending.length >= MAX_PENDING_FACTS) throw new Error("game_program_fact_progress_overflow");
        const pending = [...state.pending];
        insertPendingByCursor(pending, fact);
        await write({ deliveredCursor: state.deliveredCursor, pending });
        return "accepted";
      }),
    deliverOne: (consumer) =>
      exclusive(async () => {
        if (typeof consumer !== "function") throw new Error("invalid_game_program_fact_consumer");
        const state = await read();
        const next = state.pending[0];
        if (next === undefined) return false;
        await consumer(
          Object.freeze({
            customType: GAME_PROGRAM_FACT_CUSTOM_TYPE,
            content: encodeGameProgramFact(next),
            details: next,
          }),
        );
        await write({
          deliveredCursor: Math.max(state.deliveredCursor, next.cursor),
          pending: state.pending.slice(1),
        });
        return true;
      }),
    snapshot: () => exclusive(read),
  });
}

function encodeGameProgramFact(record: GameProgramFact): string {
  return JSON.stringify(decodeGameProgramFact(record));
}

function decodeGameProgramFact(value: unknown): GameProgramFact {
  if (!hasExactEnumerableDataKeys(value, ["type", "cursor", "programId", "nodeId", "nodeAttempt", "factClass", "fact"]))
    throw new Error("invalid_game_program_fact");
  if (value.type !== GAME_PROGRAM_FACT_CUSTOM_TYPE || !isCursor(value.cursor) || !isIdentifier(value.programId) || !isIdentifier(value.nodeId) || !isCursor(value.nodeAttempt) || !isFactClass(value.factClass) || !isStrictJsonRecord(value.fact))
    throw new Error("invalid_game_program_fact");
  const record = Object.freeze({
    type: GAME_PROGRAM_FACT_CUSTOM_TYPE,
    cursor: value.cursor,
    programId: value.programId,
    nodeId: value.nodeId,
    nodeAttempt: value.nodeAttempt,
    factClass: value.factClass,
    fact: freezeJsonRecord(value.fact),
  });
  if (Buffer.byteLength(JSON.stringify(record), "utf8") > MAX_FACT_CONTENT_BYTES)
    throw new Error("game_program_fact_too_large");
  return record;
}

function normalizeState(value: GameProgramFactIngressState | undefined): GameProgramFactIngressState {
  if (value === undefined) return Object.freeze({ deliveredCursor: -1, pending: Object.freeze([]) });
  if (!hasExactEnumerableDataKeys(value, ["deliveredCursor", "pending"]) || !isDeliveryCursor(value.deliveredCursor) || !Array.isArray(value.pending) || value.pending.length > MAX_PENDING_FACTS || !hasOwnArrayEntries(value.pending))
    throw new Error("invalid_game_program_fact_ingress_state");
  const pending = value.pending.map(decodeGameProgramFact);
  if (pending.some((fact, index) => fact.cursor <= value.deliveredCursor || (index > 0 && fact.cursor <= (pending[index - 1]?.cursor ?? -1))))
    throw new Error("invalid_game_program_fact_ingress_state");
  return freezeState({ deliveredCursor: value.deliveredCursor, pending });
}

function freezeState(state: GameProgramFactIngressState): GameProgramFactIngressState {
  return Object.freeze({ deliveredCursor: state.deliveredCursor, pending: Object.freeze([...state.pending]) });
}

function sameLineage(left: GameProgramFact, right: GameProgramFact): boolean {
  return left.programId === right.programId && left.nodeId === right.nodeId && left.nodeAttempt === right.nodeAttempt;
}

function isFactClass(value: unknown): value is GameProgramFactClass {
  return value === "progress" || value === "terminal" || value === "resource_released" || value === "recovery_required";
}
function isIdentifier(value: unknown): value is string { return typeof value === "string" && IDENTIFIER.test(value); }
function isCursor(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function isDeliveryCursor(value: unknown): value is number { return value === -1 || isCursor(value); }
function isPlainRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function isStrictJsonRecord(value: unknown): value is Record<string, unknown> { return isPlainRecord(value) && isStrictJsonValue(value, new Set<object>()); }
function isStrictJsonValue(value: unknown, ancestors: Set<object>): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object" || ancestors.has(value)) return false;
  const isArray = Array.isArray(value);
  if ((isArray && Object.getPrototypeOf(value) !== Array.prototype) || (!isArray && !isPlainRecord(value))) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  const descriptors = Object.entries(Object.getOwnPropertyDescriptors(value));
  if (descriptors.some(([key, descriptor]) => key !== "length" && (!descriptor.enumerable || "get" in descriptor || "set" in descriptor))) return false;
  if (isArray && descriptors.some(([key]) => key !== "length" && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) return false;
  ancestors.add(value);
  const valid = isArray
    ? Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index) && isStrictJsonValue(value[index], ancestors)).every(Boolean)
    : Object.values(value).every((entry) => isStrictJsonValue(entry, ancestors));
  ancestors.delete(value);
  return valid;
}
function hasOwnArrayEntries(value: readonly unknown[]): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return true;
}
function hasExactEnumerableDataKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isPlainRecord(value) || Object.getOwnPropertySymbols(value).length > 0) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Object.keys(descriptors);
  return actual.length === keys.length && actual.every((key) => {
    const descriptor = descriptors[key];
    return keys.includes(key) && descriptor !== undefined && descriptor.enumerable && "value" in descriptor;
  });
}
function freezeJsonRecord(value: Record<string, unknown>): Readonly<Record<string, unknown>> { return freezeJsonValue(value) as Readonly<Record<string, unknown>>; }
function freezeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeJsonValue));
  if (isPlainRecord(value)) return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, freezeJsonValue(entry)])));
  return value;
}
function insertPendingByCursor(pending: GameProgramFact[], fact: GameProgramFact): void {
  const index = pending.findIndex((item) => item.cursor > fact.cursor);
  pending.splice(index < 0 ? pending.length : index, 0, fact);
}
