/**
 * Pure, identity-bound browser session reducer for the frozen
 * `tavern_browser_api/v1` reference-pipeline snapshot/status DTO shapes.
 *
 * This module is deliberately self-contained: it imports nothing (no Host
 * package, no network client, no storage, no timers) and only reduces plain
 * values into immutable session state. Full DTO wire validation belongs to
 * the browser API client (`reference-pipeline-api.ts`); this reducer performs
 * only the identity/state/operation checks it must enforce to keep the
 * mounted session safe, atomic and content-free:
 *
 * - bootstrap records a stable identity fingerprint derived ONLY from
 *   `build.profileId` (+ contract) and `selection.{chatHandle,generation,stateRevision}`;
 * - `applySnapshot` atomically replaces the snapshot only while the exact
 *   mounted identity is unchanged; any mismatch throws
 *   `state_reconciliation_required` and preserves all prior state including
 *   any pending submission;
 * - a pending submission carries ONLY `{idempotencyKey, selectionGeneration,
 *   stateRevision, expectedDraftRevision}` — never player text, locale, csrf,
 *   token, handle or raw durable ids — and is created only from the current
 *   valid snapshot plus public command correlation values;
 * - `applyStatus` preserves pending for every non-terminal disposition and
 *   clears it ONLY for a terminal disposition; snapshot and turn are never
 *   mutated from a status result.
 *
 * No local transcript merge, fake message, local handle, cancel route,
 * storage or HTTP exists here; events only advance a validated checkpoint and
 * require the UI to perform durable `/state` read-back.
 */

export const TAVERN_BROWSER_API_VERSION = 1 as const;
export const TAVERN_BROWSER_CONTRACT = "tavern_browser_api/v1" as const;

// --- Minimal local structural types mirroring the frozen v1 DTO shapes. ---
// They are a structural subset used by this reducer only; the browser API
// client owns the complete validated DTO authority.

export type TavernBrowserOperationV1 = Readonly<{
  operationId: "chat.submit" | "chat.cancel" | "draft.save" | "draft.discard";
  labelKey: string;
  availability: "available" | "busy" | "unavailable";
  routeId: string;
}>;

export type BrowserMessageV1 = Readonly<{
  handle: string;
  role: "player" | "companion";
  text: string;
  locale: "en" | "zh-CN" | "und";
  order: number;
  revision: number;
}>;

export type BrowserTurnV1 = Readonly<{
  handle: string;
  state: "queued" | "running" | "response_visible" | "stopping" | "completed" | "cancelled" | "failed";
  projectionRevision: number;
  canCancel: boolean;
  problemCode?: "interrupted" | "no_visible_presentation" | "runtime_unavailable" | "storage_unavailable";
}>;

export type SubmitResultV1 = Readonly<{
  apiVersion: 1;
  disposition: "accepted" | "duplicate";
  message: BrowserMessageV1;
  turn: BrowserTurnV1;
}>;

export type MessageSubmissionStatusV1 = Readonly<{
  apiVersion: 1;
  disposition: "unknown" | "pending" | "accepted" | "terminal" | "expired";
  committedResult?: SubmitResultV1;
}>;

export type BrowserEventV1 = Readonly<{
  apiVersion: 1;
  epoch: string;
  sequence: number;
  selectionGeneration: number;
  eventType: "message.committed" | "draft.changed" | "turn.state_changed" | "memory.changed" | "stream.resync_required";
  payload: unknown;
}>;

export type TavernStateSnapshotV1 = Readonly<{
  apiVersion: 1;
  build: Readonly<{ browserContract: "tavern_browser_api/v1"; profileId: string }>;
  csrfToken: string;
  browserSession: Readonly<{ expiresAtMs: number }>;
  operations: readonly TavernBrowserOperationV1[];
  navigation: readonly unknown[];
  selection: Readonly<{ chatHandle: string; generation: number; stateRevision: string }> | null;
  chat:
    | Readonly<{
        companion: Readonly<{ name: string }>;
        title: string | null;
        transcript: readonly BrowserMessageV1[];
        draft: Readonly<{ revision: number; present: boolean }>;
        turn: BrowserTurnV1 | null;
        worldInfo: Readonly<Record<string, unknown>> | null;
      }>
    | null;
  memory: Readonly<{ readAvailable: boolean; mutationAvailable: boolean; projectionRevision: string | null }>;
  eventStream: Readonly<{ epoch: string; cursor: string }> | null;
}>;

/** A snapshot whose active identity (build profile + selection) is present and well-formed. */
export type ActiveTavernStateSnapshotV1 = TavernStateSnapshotV1 & Readonly<{
  selection: Readonly<{ chatHandle: string; generation: number; stateRevision: string }>;
}>;

/**
 * Content-free pending submission: exactly the four enumerable keys below.
 * No player text, locale, csrf, token, handle or raw durable id ever lives
 * in this record.
 */
export type PendingSubmission = Readonly<{
  idempotencyKey: string;
  selectionGeneration: number;
  stateRevision: string;
  expectedDraftRevision: number;
}>;

export type ReferencePipelineSession = Readonly<{
  snapshot: TavernStateSnapshotV1;
  pending: PendingSubmission | null;
  applySnapshot(snapshot: TavernStateSnapshotV1): ReferencePipelineSession;
  applyEvent(event: BrowserEventV1): ReferencePipelineSession;
  withPending(pending: PendingSubmission | null): ReferencePipelineSession;
}>;

export type SubmissionStatusResult = Readonly<{ pending: PendingSubmission | null }>;

/**
 * Error raised for every reducer-level rejection. `code` uses the frozen
 * `tavern_browser_api/v1` problem codes so the API adapter can map it
 * directly; `message` equals `code` (the design's tests match on the code).
 */
export class ReferencePipelineSessionError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "ReferencePipelineSessionError";
    this.code = code;
  }
}

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const TERMINAL_DISPOSITIONS = new Set<string>(["terminal"]);
const KNOWN_DISPOSITIONS = new Set<string>(["unknown", "pending", "accepted", "terminal", "expired"]);
const PENDING_KEYS = new Set<string>(["idempotencyKey", "selectionGeneration", "stateRevision", "expectedDraftRevision"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isNonnegativeSafeInteger(value) && value >= 1;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isBrowserEvent(value: unknown): value is BrowserEventV1 {
  if (!isRecord(value) || value.apiVersion !== TAVERN_BROWSER_API_VERSION) return false;
  if (!isNonEmptyString(value.epoch) || !isPositiveSafeInteger(value.sequence) || !isPositiveSafeInteger(value.selectionGeneration)) return false;
  if (!isNonEmptyString(value.eventType) || !isRecord(value.payload)) return false;
  return ["message.committed", "draft.changed", "turn.state_changed", "memory.changed", "stream.resync_required"].includes(value.eventType);
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    Object.freeze(value);
  } else if (isRecord(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

/** A snapshot has an active identity iff build profile and selection are present and well-formed. */
function isActiveIdentity(value: unknown): value is ActiveTavernStateSnapshotV1 {
  return (
    isRecord(value) &&
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    isRecord(value.build) &&
    value.build.browserContract === TAVERN_BROWSER_CONTRACT &&
    isNonEmptyString(value.build.profileId) &&
    isRecord(value.selection) &&
    isNonEmptyString(value.selection.chatHandle) &&
    isPositiveSafeInteger(value.selection.generation) &&
    isNonEmptyString(value.selection.stateRevision)
  );
}

function requireActiveIdentity(snapshot: unknown): ActiveTavernStateSnapshotV1 {
  if (!isActiveIdentity(snapshot)) throw new ReferencePipelineSessionError("state_reconciliation_required");
  return snapshot;
}

/**
 * Stable identity fingerprint derived ONLY from the snapshot build profile
 * and the selection identity. Transcript, draft, turn, csrf and every other
 * field are intentionally excluded: they must never influence whether a
 * snapshot may atomically replace the mounted one.
 */
function identityFingerprint(snapshot: unknown): string {
  const active = requireActiveIdentity(snapshot);
  return [
    active.build.browserContract,
    active.build.profileId,
    active.selection.chatHandle,
    String(active.selection.generation),
    active.selection.stateRevision,
  ].join("|");
}

function isPendingSubmission(value: unknown): value is PendingSubmission {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === 4 &&
    PENDING_KEYS.has(keys[0]) &&
    PENDING_KEYS.has(keys[1]) &&
    PENDING_KEYS.has(keys[2]) &&
    PENDING_KEYS.has(keys[3]) &&
    typeof value.idempotencyKey === "string" &&
    IDEMPOTENCY_KEY_PATTERN.test(value.idempotencyKey) &&
    isPositiveSafeInteger(value.selectionGeneration) &&
    isNonEmptyString(value.stateRevision) &&
    isNonnegativeSafeInteger(value.expectedDraftRevision)
  );
}

function requirePendingSubmission(value: unknown): PendingSubmission {
  if (!isPendingSubmission(value)) throw new ReferencePipelineSessionError("state_reconciliation_required");
  return value;
}

interface SessionState {
  fingerprint: string;
  snapshot: TavernStateSnapshotV1;
  pending: PendingSubmission | null;
  eventEpoch: string | null;
  eventSequence: number | null;
}

function createSession(state: SessionState): ReferencePipelineSession {
  const session: ReferencePipelineSession = Object.freeze({
    snapshot: state.snapshot,
    pending: state.pending,
    applySnapshot(next: TavernStateSnapshotV1): ReferencePipelineSession {
      const frozenNext = deepFreeze(next);
      if (identityFingerprint(frozenNext) !== state.fingerprint) {
        // Mismatch: reject without touching any prior state, including pending.
        throw new ReferencePipelineSessionError("state_reconciliation_required");
      }
      return createSession({
        fingerprint: state.fingerprint,
        snapshot: frozenNext,
        pending: state.pending,
        eventEpoch: frozenNext.eventStream?.epoch ?? null,
        eventSequence: frozenNext.eventStream?.epoch === state.eventEpoch ? state.eventSequence : null,
      });
    },
    applyEvent(event: BrowserEventV1): ReferencePipelineSession {
      if (!isBrowserEvent(event)) throw new ReferencePipelineSessionError("stream_resync_required");
      const selection = requireActiveIdentity(state.snapshot).selection;
      if (event.eventType === "stream.resync_required") throw new ReferencePipelineSessionError("stream_resync_required");
      if (state.snapshot.eventStream === null || event.epoch !== state.snapshot.eventStream.epoch || event.selectionGeneration !== selection.generation) {
        throw new ReferencePipelineSessionError("stream_resync_required");
      }
      if (state.eventEpoch !== null && state.eventEpoch !== event.epoch && state.eventSequence !== null) {
        throw new ReferencePipelineSessionError("stream_resync_required");
      }
      if (state.eventSequence !== null && event.sequence <= state.eventSequence) return session;
      if (state.eventSequence !== null && event.sequence !== state.eventSequence + 1) {
        throw new ReferencePipelineSessionError("stream_resync_required");
      }
      return createSession({ ...state, eventEpoch: event.epoch, eventSequence: event.sequence });
    },
    withPending(pending: PendingSubmission | null): ReferencePipelineSession {
      const frozenPending = pending === null ? null : deepFreeze(requirePendingSubmission(pending));
      return createSession({
        fingerprint: state.fingerprint,
        snapshot: state.snapshot,
        pending: frozenPending,
        eventEpoch: state.eventEpoch,
        eventSequence: state.eventSequence,
      });
    },
  });
  return session;
}

/**
 * Bootstrap a session from the first validated snapshot. Records the stable
 * identity fingerprint once; rejects an absent or malformed active identity
 * with `state_reconciliation_required`.
 */
export function createReferencePipelineSession(snapshot: TavernStateSnapshotV1): ReferencePipelineSession {
  return createSession({
    fingerprint: identityFingerprint(snapshot),
    snapshot: deepFreeze(snapshot),
    pending: null,
    eventEpoch: snapshot.eventStream?.epoch ?? null,
    eventSequence: null,
  });
}

/**
 * Create the content-free pending record from the current valid snapshot and
 * the supplied public command correlation values. `selectionGeneration` and
 * `stateRevision` always come from the snapshot (never from caller input);
 * `expectedDraftRevision` defaults to the snapshot's mounted draft revision.
 *
 * Rejects with `state_reconciliation_required` when the snapshot has no
 * active identity or no mounted chat, with `profile_operation_unavailable`
 * when the mounted `chat.submit` operation is absent or unavailable, and with
 * `turn_busy` when it is busy.
 */
export function pendingSubmission(
  idempotencyKey: string,
  snapshot: TavernStateSnapshotV1,
  expectedDraftRevision?: number,
): PendingSubmission {
  const active = requireActiveIdentity(snapshot);
  if (active.chat === null || !isNonnegativeSafeInteger(active.chat.draft.revision)) {
    throw new ReferencePipelineSessionError("state_reconciliation_required");
  }
  const operations = Array.isArray(active.operations) ? active.operations : [];
  const submit = operations.find((operation) => isRecord(operation) && operation.operationId === "chat.submit");
  if (submit === undefined || !isRecord(submit) || submit.availability !== "available") {
    if (submit !== undefined && isRecord(submit) && submit.availability === "busy") {
      throw new ReferencePipelineSessionError("turn_busy");
    }
    throw new ReferencePipelineSessionError("profile_operation_unavailable");
  }
  if (typeof idempotencyKey !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    throw new ReferencePipelineSessionError("invalid_request");
  }
  const draftRevision = expectedDraftRevision === undefined ? active.chat.draft.revision : expectedDraftRevision;
  if (!isNonnegativeSafeInteger(draftRevision)) {
    throw new ReferencePipelineSessionError("invalid_request");
  }
  return deepFreeze({
    idempotencyKey,
    selectionGeneration: active.selection.generation,
    stateRevision: active.selection.stateRevision,
    expectedDraftRevision: draftRevision,
  });
}

/**
 * Reduce one `message-submission-status` result against the session's
 * pending record. Pending is preserved for every non-terminal disposition
 * (unknown, pending, accepted, expired) and cleared ONLY for terminal.
 * Snapshot and turn are never read or mutated here; a status result never
 * synthesizes chat content.
 */
export function applyStatus(pending: PendingSubmission | null, status: MessageSubmissionStatusV1): SubmissionStatusResult {
  const statusValue: unknown = status;
  if (
    !isRecord(statusValue) ||
    statusValue.apiVersion !== TAVERN_BROWSER_API_VERSION ||
    typeof statusValue.disposition !== "string" ||
    !KNOWN_DISPOSITIONS.has(statusValue.disposition)
  ) {
    throw new ReferencePipelineSessionError("state_reconciliation_required");
  }
  const result = TERMINAL_DISPOSITIONS.has(statusValue.disposition) ? null : pending;
  return Object.freeze({ pending: result });
}