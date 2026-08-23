/**
 * Browser-only strict DTO validators and fetch client for the frozen
 * `tavern_browser_api/v1` reference-pipeline wire contract
 * (`gamebuddy.chat-core.reference-pipeline`).
 *
 * This module is deliberately dependency-free and closed:
 *
 * - it imports nothing (no Host package, no typebox, no runtime code) and
 *   runs identically in the browser and under Node;
 * - every DTO validator is strict and local: extra fields are rejected,
 *   `eventStream` is either `null` or the strict `{epoch,cursor}` checkpoint
 *   used by the reference profile's live events route, handles are canonical
 *   opaque unpadded base64url strings,
 *   idempotency keys are canonical 22-character unpadded base64url strings,
 *   and every union accepts only its exact frozen variants;
 * - the fetch client uses only same-origin relative routes with
 *   `credentials: "same-origin"`; `chat.submit` sends `Content-Type`,
 *   `x-csrf-token` and `idempotency-key`; `chat.submission_status` sends
 *   `Content-Type` only and never a CSRF or idempotency header;
 * - validated non-2xx responses surface the RFC-9457-style `TavernProblemV1`
 *   as `TavernProblemError`; any opaque protocol failure (invalid
 *   request construction, non-JSON body, invalid DTO, wrong success status)
 *   throws `TavernProtocolError` and never echoes raw body text;
 * - network/transport failures propagate unchanged so callers can
 *   distinguish them from protocol failures.
 *
 * The event transport is a validated EventSource boundary; durable state is
 * always read back through `/state`, and no local transcript or mock is
 * created in this module.
 */

export const TAVERN_BROWSER_API_VERSION = 1 as const;
export const TAVERN_BROWSER_CONTRACT = "tavern_browser_api/v1" as const;
export const REFERENCE_PIPELINE_PROFILE_ID = "gamebuddy.chat-core.reference-pipeline" as const;

// --- Frozen v1 DTO shapes (structural mirrors of host/src/tavern/browser-contract). ---

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

export type BrowserDraftV1 = Readonly<{
  apiVersion: 1;
  revision: number;
  text: string | null;
}>;

export type BrowserEventV1 =
  | Readonly<{
      apiVersion: 1;
      epoch: string;
      sequence: number;
      selectionGeneration: number;
      eventType: "companion.delta";
      payload: Readonly<{ turnHandle: string; delta: string }>;
    }>
  | Readonly<{
      apiVersion: 1;
      epoch: string;
      sequence: number;
      selectionGeneration: number;
      eventType: "message.committed";
      payload: BrowserMessageV1;
    }>
  | Readonly<{
      apiVersion: 1;
      epoch: string;
      sequence: number;
      selectionGeneration: number;
      eventType: "draft.changed";
      payload: Readonly<{ revision: number; present: boolean }>;
    }>
  | Readonly<{
      apiVersion: 1;
      epoch: string;
      sequence: number;
      selectionGeneration: number;
      eventType: "turn.state_changed";
      payload: BrowserTurnV1;
    }>
  | Readonly<{
      apiVersion: 1;
      epoch: string;
      sequence: number;
      selectionGeneration: number;
      eventType: "memory.changed";
      payload: Readonly<{
        readAvailable: boolean;
        mutationAvailable: boolean;
        revision: number | null;
        summaries: readonly Readonly<{ handle: string; title: string; pinned: boolean }>[];
        lastOutcome?: "committed" | "conflict" | "unavailable";
      }>;
    }>
  | Readonly<{
      apiVersion: 1;
      epoch: string;
      sequence: number;
      selectionGeneration: number;
      eventType: "stream.resync_required";
      payload: Readonly<{ reason: "gap" | "epoch_changed" | "restart" | "ambiguous_cursor" }>;
    }>;

export type TavernBrowserOperationV1 = Readonly<{
  operationId: "chat.submit" | "chat.cancel" | "draft.save" | "draft.discard";
  labelKey:
    | "tavern.nav.chat"
    | "tavern.nav.memory"
    | "tavern.operation.submit"
    | "tavern.operation.cancel"
    | "tavern.operation.draft.save"
    | "tavern.operation.draft.discard";
  availability: "available" | "busy" | "unavailable";
  routeId: string;
}>;

export type TavernStateSnapshotV1 = Readonly<{
  apiVersion: 1;
  build: Readonly<{
    browserContract: "tavern_browser_api/v1";
    profileId: "gamebuddy.chat-core.reference-pipeline";
  }>;
  csrfToken: string;
  browserSession: Readonly<{ expiresAtMs: number }>;
  operations: readonly TavernBrowserOperationV1[];
  navigation: readonly unknown[];
  selection: Readonly<{ chatHandle: string; generation: number; stateRevision: string }> | null;
  chat: Readonly<{
    companion: Readonly<{ name: string }>;
    title: string | null;
    transcript: readonly BrowserMessageV1[];
    draft: Readonly<{ revision: number; present: boolean }>;
    turn: BrowserTurnV1 | null;
    worldInfo: Readonly<Record<string, unknown>> | null;
  }> | null;
  memory: Readonly<{ readAvailable: boolean; mutationAvailable: boolean; projectionRevision: string | null }>;
  eventStream: Readonly<{ epoch: string; cursor: string }> | null;
}>;

export type SubmitMessageCommandV1 = Readonly<{
  apiVersion: 1;
  selectionGeneration: number;
  text: string;
  locale: "en" | "zh-CN";
  expectedDraftRevision?: number;
}>;

export type SubmitResultV1 = Readonly<{
  apiVersion: 1;
  disposition: "accepted" | "duplicate";
  message: BrowserMessageV1;
  turn: BrowserTurnV1;
}>;

export type CancelTurnCommandV1 = Readonly<{ apiVersion: 1; selectionGeneration: number }>;
export type CancelTurnResultV1 = Readonly<{
  apiVersion: 1;
  disposition: "cancelled" | "completion_won" | "already_terminal";
  turn: BrowserTurnV1;
}>;

export type MessageSubmissionStatusQueryV1 = Readonly<{
  apiVersion: 1;
  idempotencyKey: string;
  selectionGeneration: number;
}>;

export type MessageSubmissionStatusV1 = Readonly<{
  apiVersion: 1;
  disposition: "unknown" | "pending" | "accepted" | "terminal" | "expired";
  committedResult?: SubmitResultV1;
}>;

export type TavernProblemV1 = Readonly<{
  type: string;
  title: string;
  status: number;
  code: string;
  requestId: string;
  retryable: boolean;
}>;

// --- Errors. ---

/** A validated RFC-9457-style server problem; carries the frozen problem fields. */
export class TavernProblemError extends Error {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: string;
  readonly requestId: string;
  readonly retryable: boolean;

  constructor(problem: TavernProblemV1) {
    super(problem.title);
    this.name = "TavernProblemError";
    this.type = problem.type;
    this.title = problem.title;
    this.status = problem.status;
    this.code = problem.code;
    this.requestId = problem.requestId;
    this.retryable = problem.retryable;
  }
}

/**
 * Every opaque protocol failure: invalid request construction, non-JSON or
 * non-conforming response body, wrong success status, invalid DTO. The fixed
 * message never echoes raw body text.
 */
export class TavernProtocolError extends Error {
  constructor() {
    super("tavern_browser_api/v1 protocol error");
    this.name = "TavernProtocolError";
  }
}

// --- Local strict validation primitives (mirroring the frozen contract). ---

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const HANDLE_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const ROUTE_ID_PATTERN = /^[a-z][a-z0-9._-]*$/;
const MAX_TEXT_UTF8_BYTES = 16_384;
const MAX_TRANSCRIPT_MESSAGES = 500;
const MAX_ARRAY_ITEMS = 100;

const MESSAGE_ROLES = ["player", "companion"] as const;
const MESSAGE_LOCALES = ["en", "zh-CN", "und"] as const;
const TURN_STATES = ["queued", "running", "response_visible", "stopping", "completed", "cancelled", "failed"] as const;
const TURN_PROBLEM_CODES = [
  "interrupted",
  "no_visible_presentation",
  "runtime_unavailable",
  "storage_unavailable",
] as const;
const SUBMIT_DISPOSITIONS = ["accepted", "duplicate"] as const;
const CANCEL_DISPOSITIONS = ["cancelled", "completion_won", "already_terminal"] as const;
const STATUS_DISPOSITIONS = ["unknown", "pending", "accepted", "terminal", "expired"] as const;
const OPERATION_IDS = ["chat.submit", "chat.cancel", "draft.save", "draft.discard"] as const;
const LABEL_KEYS = [
  "tavern.nav.chat",
  "tavern.nav.memory",
  "tavern.operation.submit",
  "tavern.operation.cancel",
  "tavern.operation.draft.save",
  "tavern.operation.draft.discard",
] as const;
const OPERATION_AVAILABILITY = ["available", "busy", "unavailable"] as const;
const NAVIGATION_ITEM_IDS = ["chat", "memory"] as const;
const NAVIGATION_AVAILABILITY = ["available", "unavailable"] as const;
const WORLD_INFO_STATES = ["none", "selected", "locked", "unavailable"] as const;
const PROBLEM_CODES = [
  "unauthorized",
  "csrf_failed",
  "invalid_request",
  "unsupported_api_version",
  "profile_operation_unavailable",
  "selection_conflict",
  "draft_conflict",
  "idempotency_conflict",
  "idempotency_in_progress",
  "idempotency_expired",
  "turn_busy",
  "stream_resync_required",
  "selection_busy",
  "turn_not_active",
  "turn_already_terminal",
  "runtime_unavailable",
  "presentation_unavailable",
  "storage_unavailable",
  "state_reconciliation_required",
] as const;

const MESSAGE_KEYS = ["handle", "role", "text", "locale", "order", "revision"] as const;
const TURN_KEYS = ["handle", "state", "projectionRevision", "canCancel"] as const;
const TURN_KEYS_WITH_PROBLEM_CODE = ["handle", "state", "projectionRevision", "canCancel", "problemCode"] as const;
const DRAFT_KEYS = ["apiVersion", "revision", "text"] as const;
const OPERATION_KEYS = ["operationId", "labelKey", "availability", "routeId"] as const;
const NAVIGATION_ITEM_KEYS = ["itemId", "labelKey", "availability"] as const;
const WORLD_INFO_KEYS = ["state", "items"] as const;
const WORLD_INFO_ITEM_KEYS = ["handle", "title", "summary"] as const;
const SNAPSHOT_KEYS = [
  "apiVersion",
  "build",
  "csrfToken",
  "browserSession",
  "operations",
  "navigation",
  "selection",
  "chat",
  "memory",
  "eventStream",
] as const;
const SNAPSHOT_BUILD_KEYS = ["browserContract", "profileId"] as const;
const SNAPSHOT_BROWSER_SESSION_KEYS = ["expiresAtMs"] as const;
const SNAPSHOT_SELECTION_KEYS = ["chatHandle", "generation", "stateRevision"] as const;
const SNAPSHOT_CHAT_KEYS = ["companion", "title", "transcript", "draft", "turn", "worldInfo"] as const;
const CHAT_COMPANION_KEYS = ["name"] as const;
const CHAT_DRAFT_KEYS = ["revision", "present"] as const;
const MEMORY_KEYS = ["readAvailable", "mutationAvailable", "projectionRevision"] as const;
const SUBMIT_COMMAND_KEYS = ["apiVersion", "selectionGeneration", "text", "locale"] as const;
const SUBMIT_COMMAND_KEYS_DRAFT = [
  "apiVersion",
  "selectionGeneration",
  "text",
  "locale",
  "expectedDraftRevision",
] as const;
const SUBMIT_RESULT_KEYS = ["apiVersion", "disposition", "message", "turn"] as const;
const STATUS_KEYS = ["apiVersion", "disposition"] as const;
const STATUS_KEYS_WITH_RESULT = ["apiVersion", "disposition", "committedResult"] as const;
const STATUS_QUERY_KEYS = ["apiVersion", "idempotencyKey", "selectionGeneration"] as const;
const PROBLEM_KEYS = ["type", "title", "status", "code", "requestId", "retryable"] as const;
const EVENT_KEYS = ["apiVersion", "epoch", "sequence", "selectionGeneration", "eventType", "payload"] as const;
const EVENT_STREAM_KEYS = ["epoch", "cursor"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Object.keys(record);
  if (ownKeys.length !== keys.length) return false;
  for (const key of keys) {
    if (!ownKeys.includes(key)) return false;
  }
  return true;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value >= 1;
}

function isLengthBoundedString(value: unknown, minLength: number, maxLength: number): value is string {
  return typeof value === "string" && value.length >= minLength && value.length <= maxLength;
}

function isOneOf(value: unknown, allowed: readonly string[]): value is string {
  return typeof value === "string" && allowed.includes(value);
}

/** Canonical unpadded base64url: no padding, no length%4===1, zeroed trailing bits. */
function isCanonicalUnpaddedBase64Url(value: string): boolean {
  const length = value.length;
  if (length === 0 || length % 4 === 1) return false;
  for (let index = 0; index < length; index += 1) {
    if (BASE64URL_ALPHABET.indexOf(value.charAt(index)) < 0) return false;
  }
  const finalIndex = BASE64URL_ALPHABET.indexOf(value.charAt(length - 1));
  if (length % 4 === 0) return true;
  return length % 4 === 2 ? finalIndex % 16 === 0 : finalIndex % 4 === 0;
}

/** Canonical opaque handle: 22-128 chars, base64url alphabet, canonical unpadded encoding. */
function isOpaqueHandle(value: unknown): value is string {
  return typeof value === "string" && HANDLE_PATTERN.test(value) && isCanonicalUnpaddedBase64Url(value);
}

/** Canonical idempotency key: exactly 22 chars, base64url alphabet, canonical unpadded encoding. */
function isIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && IDEMPOTENCY_KEY_PATTERN.test(value) && isCanonicalUnpaddedBase64Url(value);
}

function hasUnpairedUtf16Surrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** NFC, no unpaired surrogates, 1..16384 UTF-8 bytes (frozen BoundedText). */
function isNfcUtf8Text(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1) return false;
  if (hasUnpairedUtf16Surrogate(value)) return false;
  if (value !== value.normalize("NFC")) return false;
  return new TextEncoder().encode(value).byteLength <= MAX_TEXT_UTF8_BYTES;
}

// --- DTO validators (strict closed shapes; every invalid value throws TavernProtocolError). ---

function isBrowserMessage(value: unknown): value is BrowserMessageV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, MESSAGE_KEYS) &&
    isOpaqueHandle(value.handle) &&
    isOneOf(value.role, MESSAGE_ROLES) &&
    isNfcUtf8Text(value.text) &&
    isOneOf(value.locale, MESSAGE_LOCALES) &&
    isNonNegativeSafeInteger(value.order) &&
    isNonNegativeSafeInteger(value.revision)
  );
}

function isBrowserTurn(value: unknown): value is BrowserTurnV1 {
  if (!isRecord(value)) return false;
  if (!hasExactKeys(value, TURN_KEYS) && !hasExactKeys(value, TURN_KEYS_WITH_PROBLEM_CODE)) return false;
  if (!isOpaqueHandle(value.handle) || !isOneOf(value.state, TURN_STATES)) return false;
  if (!isNonNegativeSafeInteger(value.projectionRevision) || typeof value.canCancel !== "boolean") return false;
  if ("problemCode" in value && !isOneOf(value.problemCode, TURN_PROBLEM_CODES)) return false;
  return true;
}

function isBrowserDraft(value: unknown): value is BrowserDraftV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, DRAFT_KEYS) &&
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    isNonNegativeSafeInteger(value.revision) &&
    (value.text === null || isNfcUtf8Text(value.text))
  );
}

function isTavernBrowserOperation(value: unknown): value is TavernBrowserOperationV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, OPERATION_KEYS) &&
    isOneOf(value.operationId, OPERATION_IDS) &&
    isOneOf(value.labelKey, LABEL_KEYS) &&
    isOneOf(value.availability, OPERATION_AVAILABILITY) &&
    isLengthBoundedString(value.routeId, 1, 128) &&
    ROUTE_ID_PATTERN.test(value.routeId)
  );
}

function isNavigationItem(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, NAVIGATION_ITEM_KEYS) &&
    isOneOf(value.itemId, NAVIGATION_ITEM_IDS) &&
    isOneOf(value.labelKey, LABEL_KEYS) &&
    isOneOf(value.availability, NAVIGATION_AVAILABILITY)
  );
}

function isWorldInfoItem(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, WORLD_INFO_ITEM_KEYS) &&
    isOpaqueHandle(value.handle) &&
    isLengthBoundedString(value.title, 1, 256) &&
    (value.summary === null || isLengthBoundedString(value.summary, 0, 512))
  );
}

function isWorldInfo(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, WORLD_INFO_KEYS)) return false;
  return (
    isOneOf(value.state, WORLD_INFO_STATES) &&
    Array.isArray(value.items) &&
    value.items.length <= MAX_ARRAY_ITEMS &&
    value.items.every(isWorldInfoItem)
  );
}

function isSelection(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, SNAPSHOT_SELECTION_KEYS) &&
    isOpaqueHandle(value.chatHandle) &&
    isPositiveSafeInteger(value.generation) &&
    isOpaqueHandle(value.stateRevision)
  );
}

function isChat(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, SNAPSHOT_CHAT_KEYS)) return false;
  if (
    !isRecord(value.companion) ||
    !hasExactKeys(value.companion, CHAT_COMPANION_KEYS) ||
    !isLengthBoundedString(value.companion.name, 1, 256)
  )
    return false;
  if (value.title !== null && !isLengthBoundedString(value.title, 0, 256)) return false;
  if (
    !Array.isArray(value.transcript) ||
    value.transcript.length > MAX_TRANSCRIPT_MESSAGES ||
    !value.transcript.every(isBrowserMessage)
  )
    return false;
  if (
    !isRecord(value.draft) ||
    !hasExactKeys(value.draft, CHAT_DRAFT_KEYS) ||
    !isNonNegativeSafeInteger(value.draft.revision) ||
    typeof value.draft.present !== "boolean"
  )
    return false;
  if (value.turn !== null && !isBrowserTurn(value.turn)) return false;
  if (value.worldInfo !== null && !isWorldInfo(value.worldInfo)) return false;
  return true;
}

function isEventStream(value: unknown): value is NonNullable<TavernStateSnapshotV1["eventStream"]> {
  return (
    isRecord(value) &&
    hasExactKeys(value, EVENT_STREAM_KEYS) &&
    isOpaqueHandle(value.epoch) &&
    isOpaqueHandle(value.cursor)
  );
}

function isBrowserEvent(value: unknown): value is BrowserEventV1 {
  if (!isRecord(value) || !hasExactKeys(value, EVENT_KEYS)) return false;
  if (
    value.apiVersion !== TAVERN_BROWSER_API_VERSION ||
    !isOpaqueHandle(value.epoch) ||
    !isPositiveSafeInteger(value.sequence) ||
    !isPositiveSafeInteger(value.selectionGeneration)
  )
    return false;
  if (value.eventType === "companion.delta")
    return (
      isRecord(value.payload) &&
      hasExactKeys(value.payload, ["turnHandle", "delta"]) &&
      isOpaqueHandle(value.payload.turnHandle) &&
      isNfcUtf8Text(value.payload.delta)
    );
  if (value.eventType === "message.committed") return isBrowserMessage(value.payload);
  if (value.eventType === "draft.changed")
    return (
      isRecord(value.payload) &&
      hasExactKeys(value.payload, ["revision", "present"]) &&
      isNonNegativeSafeInteger(value.payload.revision) &&
      typeof value.payload.present === "boolean"
    );
  if (value.eventType === "turn.state_changed") return isBrowserTurn(value.payload);
  if (value.eventType === "stream.resync_required")
    return (
      isRecord(value.payload) &&
      hasExactKeys(value.payload, ["reason"]) &&
      isOneOf(value.payload.reason, ["gap", "epoch_changed", "restart", "ambiguous_cursor"])
    );
  if (value.eventType === "memory.changed") {
    if (
      !isRecord(value.payload) ||
      !Object.keys(value.payload).every((key) =>
        ["readAvailable", "mutationAvailable", "revision", "summaries", "lastOutcome"].includes(key),
      )
    )
      return false;
    return (
      typeof value.payload.readAvailable === "boolean" &&
      typeof value.payload.mutationAvailable === "boolean" &&
      (value.payload.revision === null || isNonNegativeSafeInteger(value.payload.revision)) &&
      Array.isArray(value.payload.summaries) &&
      value.payload.summaries.length <= 200 &&
      value.payload.summaries.every(
        (summary) =>
          isRecord(summary) &&
          hasExactKeys(summary, ["handle", "title", "pinned"]) &&
          isOpaqueHandle(summary.handle) &&
          isLengthBoundedString(summary.title, 1, 256) &&
          typeof summary.pinned === "boolean",
      ) &&
      (!Object.hasOwn(value.payload, "lastOutcome") ||
        isOneOf(value.payload.lastOutcome, ["committed", "conflict", "unavailable"]))
    );
  }
  return false;
}

function isSnapshot(value: unknown): value is TavernStateSnapshotV1 {
  if (!isRecord(value) || !hasExactKeys(value, SNAPSHOT_KEYS)) return false;
  if (value.apiVersion !== TAVERN_BROWSER_API_VERSION) return false;
  if (
    !isRecord(value.build) ||
    !hasExactKeys(value.build, SNAPSHOT_BUILD_KEYS) ||
    value.build.browserContract !== TAVERN_BROWSER_CONTRACT ||
    value.build.profileId !== REFERENCE_PIPELINE_PROFILE_ID
  )
    return false;
  if (!isOpaqueHandle(value.csrfToken)) return false;
  if (
    !isRecord(value.browserSession) ||
    !hasExactKeys(value.browserSession, SNAPSHOT_BROWSER_SESSION_KEYS) ||
    !isNonNegativeSafeInteger(value.browserSession.expiresAtMs)
  )
    return false;
  if (
    !Array.isArray(value.operations) ||
    value.operations.length > MAX_ARRAY_ITEMS ||
    !value.operations.every(isTavernBrowserOperation)
  )
    return false;
  if (
    !Array.isArray(value.navigation) ||
    value.navigation.length > MAX_ARRAY_ITEMS ||
    !value.navigation.every(isNavigationItem)
  )
    return false;
  if (value.selection !== null && !isSelection(value.selection)) return false;
  if (value.chat !== null && !isChat(value.chat)) return false;
  if (!isRecord(value.memory) || !hasExactKeys(value.memory, MEMORY_KEYS)) return false;
  if (typeof value.memory.readAvailable !== "boolean" || typeof value.memory.mutationAvailable !== "boolean")
    return false;
  if (value.memory.projectionRevision !== null && !isOpaqueHandle(value.memory.projectionRevision)) return false;
  if (value.eventStream !== null && !isEventStream(value.eventStream)) return false;
  return true;
}

function isSubmitMessageCommand(value: unknown): value is SubmitMessageCommandV1 {
  if (!isRecord(value)) return false;
  const ownKeys = Object.keys(value);
  const expectedKeys = ownKeys.includes("expectedDraftRevision") ? SUBMIT_COMMAND_KEYS_DRAFT : SUBMIT_COMMAND_KEYS;
  if (!hasExactKeys(value, expectedKeys)) return false;
  if (value.apiVersion !== TAVERN_BROWSER_API_VERSION || !isPositiveSafeInteger(value.selectionGeneration))
    return false;
  if (!isNfcUtf8Text(value.text) || !isOneOf(value.locale, ["en", "zh-CN"])) return false;
  if ("expectedDraftRevision" in value && !isNonNegativeSafeInteger(value.expectedDraftRevision)) return false;
  return true;
}

function isSubmitResult(value: unknown): value is SubmitResultV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, SUBMIT_RESULT_KEYS) &&
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    isOneOf(value.disposition, SUBMIT_DISPOSITIONS) &&
    isBrowserMessage(value.message) &&
    isBrowserTurn(value.turn)
  );
}

function isCancelTurnCommand(value: unknown): value is CancelTurnCommandV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["apiVersion", "selectionGeneration"]) &&
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    isPositiveSafeInteger(value.selectionGeneration)
  );
}

function isCancelTurnResult(value: unknown): value is CancelTurnResultV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["apiVersion", "disposition", "turn"]) &&
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    isOneOf(value.disposition, CANCEL_DISPOSITIONS) &&
    isBrowserTurn(value.turn)
  );
}

function isMessageSubmissionStatusQuery(value: unknown): value is MessageSubmissionStatusQueryV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, STATUS_QUERY_KEYS) &&
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    isIdempotencyKey(value.idempotencyKey) &&
    isPositiveSafeInteger(value.selectionGeneration)
  );
}

function isMessageSubmissionStatus(value: unknown): value is MessageSubmissionStatusV1 {
  if (!isRecord(value)) return false;
  if (!hasExactKeys(value, STATUS_KEYS) && !hasExactKeys(value, STATUS_KEYS_WITH_RESULT)) return false;
  if (value.apiVersion !== TAVERN_BROWSER_API_VERSION || !isOneOf(value.disposition, STATUS_DISPOSITIONS)) return false;
  if ("committedResult" in value && !isSubmitResult(value.committedResult)) return false;
  return true;
}

function isProblem(value: unknown): value is TavernProblemV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, PROBLEM_KEYS) &&
    isLengthBoundedString(value.type, 1, 256) &&
    isLengthBoundedString(value.title, 1, 256) &&
    typeof value.status === "number" &&
    Number.isSafeInteger(value.status) &&
    value.status >= 400 &&
    value.status <= 599 &&
    isOneOf(value.code, PROBLEM_CODES) &&
    isOpaqueHandle(value.requestId) &&
    typeof value.retryable === "boolean"
  );
}

// --- Public strict closed validators. ---

/**
 * Validates an exact reference-profile `TavernStateSnapshotV1`. Rejects any
 * extra/missing field, a malformed `eventStream`, a foreign profile/contract,
 * non-canonical opaque handles, non-canonical revisions/generations and any
 * union value outside the frozen variants. Throws `TavernProtocolError`.
 */
export function validateSnapshot(value: unknown): TavernStateSnapshotV1 {
  if (!isSnapshot(value)) throw new TavernProtocolError();
  return value;
}

/** Validates a frozen `BrowserDraftV1`; throws `TavernProtocolError`. */
export function validateEvent(value: unknown): BrowserEventV1 {
  if (!isBrowserEvent(value)) throw new TavernProtocolError();
  return value;
}

export function validateDraft(value: unknown): BrowserDraftV1 {
  if (!isBrowserDraft(value)) throw new TavernProtocolError();
  return value;
}

/** Validates a frozen `SubmitResultV1`; throws `TavernProtocolError`. */
export function validateSubmitResult(value: unknown): SubmitResultV1 {
  if (!isSubmitResult(value)) throw new TavernProtocolError();
  return value;
}

/** Validates a frozen `MessageSubmissionStatusV1`; throws `TavernProtocolError`. */
export function validateSubmissionStatus(value: unknown): MessageSubmissionStatusV1 {
  if (!isMessageSubmissionStatus(value)) throw new TavernProtocolError();
  return value;
}

export function validateCancelTurnResult(value: unknown): CancelTurnResultV1 {
  if (!isCancelTurnResult(value)) throw new TavernProtocolError();
  return value;
}

/** Validates a frozen RFC-9457-style `TavernProblemV1`; throws `TavernProtocolError`. */
export function validateProblem(value: unknown): TavernProblemV1 {
  if (!isProblem(value)) throw new TavernProtocolError();
  return value;
}

// --- Fetch client for the five frozen reference routes. ---

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/**
 * One exchange over the frozen route table. `credentials: "same-origin"` is
 * always set; a JSON `Content-Type` is set exactly when a body is sent.
 * Validated non-2xx responses surface `TavernProblemError`; every other
 * failure (unreadable body, invalid DTO, unexpected success status) throws a
 * non-echoing `TavernProtocolError`. Network errors propagate unchanged.
 */
async function exchange<T>(
  transport: typeof fetch,
  method: string,
  path: string,
  expectedStatus: number,
  decode: (value: unknown) => T,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin" };
  const headerNames = Object.keys(headers);
  if (headerNames.length > 0) init.headers = headers;
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await transport(path, init);
  const bodyValue: unknown = await readJson(response);
  if (!response.ok) {
    // Validated known non-2xx surfaces the RFC-9457 problem; anything else
    // is an opaque protocol failure and must never echo the raw body/text.
    if (isProblem(bodyValue)) throw new TavernProblemError(bodyValue);
    throw new TavernProtocolError();
  }
  if (response.status !== expectedStatus) throw new TavernProtocolError();
  return decode(bodyValue);
}

export type ReferencePipelineEventSource = Readonly<{ close(): void }>;

export type ReferencePipelineApi = Readonly<{
  /** POST /api/tavern/v1/bootstrap (one-time bootstrap token). */
  bootstrap(token: string): Promise<TavernStateSnapshotV1>;
  /** GET /api/tavern/v1/state (browser session cookie). */
  readState(): Promise<TavernStateSnapshotV1>;
  /** GET /api/tavern/v1/draft (browser session cookie). */
  readDraft(): Promise<BrowserDraftV1>;
  /** POST /api/tavern/v1/messages with Content-Type, x-csrf-token, idempotency-key. */
  submit(
    command: SubmitMessageCommandV1,
    options: Readonly<{ csrfToken: string; idempotencyKey: string }>,
  ): Promise<SubmitResultV1>;
  /** POST /api/tavern/v1/turns/:turnHandle/cancel with CSRF. */
  cancel(turnHandle: string, command: CancelTurnCommandV1, csrfToken: string): Promise<CancelTurnResultV1>;
  /** POST /api/tavern/v1/message-submission-status (no CSRF/idempotency headers). */
  readSubmissionStatus(query: MessageSubmissionStatusQueryV1): Promise<MessageSubmissionStatusV1>;
  /** GET /api/tavern/v1/events; events are validated and never merged locally. */
  openEvents(
    options: Readonly<{
      cursor?: string;
      onEvent(event: BrowserEventV1, lastEventId: string): void;
      onError(error: Event): void;
    }>,
  ): ReferencePipelineEventSource;
}>;

/**
 * Creates the browser API client over a fetch-like transport (defaults to
 * `globalThis.fetch`). Requests use the exact frozen same-origin relative
 * routes with `credentials: "same-origin"` and validated request shapes;
 * responses are strictly validated before they are returned.
 */
export function createReferencePipelineApi(fetchLike: typeof fetch = fetch): ReferencePipelineApi {
  if (typeof fetchLike !== "function") {
    throw new TypeError("createReferencePipelineApi requires a fetch-like function");
  }
  return Object.freeze({
    async bootstrap(token: string): Promise<TavernStateSnapshotV1> {
      if (!isOpaqueHandle(token)) throw new TavernProtocolError();
      return exchange(
        fetchLike,
        "POST",
        "/api/tavern/v1/bootstrap",
        200,
        validateSnapshot,
        { "Content-Type": "application/json" },
        { apiVersion: TAVERN_BROWSER_API_VERSION, bootstrapToken: token },
      );
    },
    async readState(): Promise<TavernStateSnapshotV1> {
      return exchange(fetchLike, "GET", "/api/tavern/v1/state", 200, validateSnapshot);
    },
    async readDraft(): Promise<BrowserDraftV1> {
      return exchange(fetchLike, "GET", "/api/tavern/v1/draft", 200, validateDraft);
    },
    async submit(
      command: SubmitMessageCommandV1,
      options: Readonly<{ csrfToken: string; idempotencyKey: string }>,
    ): Promise<SubmitResultV1> {
      if (!isSubmitMessageCommand(command)) throw new TavernProtocolError();
      if (!isOpaqueHandle(options.csrfToken) || !isIdempotencyKey(options.idempotencyKey)) {
        throw new TavernProtocolError();
      }
      return exchange(
        fetchLike,
        "POST",
        "/api/tavern/v1/messages",
        202,
        validateSubmitResult,
        {
          "Content-Type": "application/json",
          "x-csrf-token": options.csrfToken,
          "idempotency-key": options.idempotencyKey,
        },
        command,
      );
    },
    async cancel(turnHandle: string, command: CancelTurnCommandV1, csrfToken: string): Promise<CancelTurnResultV1> {
      if (!isOpaqueHandle(turnHandle) || !isCancelTurnCommand(command) || !isOpaqueHandle(csrfToken))
        throw new TavernProtocolError();
      return exchange(
        fetchLike,
        "POST",
        `/api/tavern/v1/turns/${turnHandle}/cancel`,
        200,
        validateCancelTurnResult,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        command,
      );
    },
    async readSubmissionStatus(query: MessageSubmissionStatusQueryV1): Promise<MessageSubmissionStatusV1> {
      if (!isMessageSubmissionStatusQuery(query)) throw new TavernProtocolError();
      // chat.submission_status is session-authenticated but carries no CSRF
      // and no idempotency header on the wire; only the JSON content type.
      return exchange(
        fetchLike,
        "POST",
        "/api/tavern/v1/message-submission-status",
        200,
        validateSubmissionStatus,
        { "Content-Type": "application/json" },
        query,
      );
    },
    openEvents(options) {
      if (
        typeof EventSource !== "function" ||
        options === null ||
        typeof options !== "object" ||
        typeof options.onEvent !== "function" ||
        typeof options.onError !== "function"
      )
        throw new TavernProtocolError();
      if (options.cursor !== undefined && !isOpaqueHandle(options.cursor)) throw new TavernProtocolError();
      const params = new URLSearchParams({ apiVersion: String(TAVERN_BROWSER_API_VERSION) });
      if (options.cursor !== undefined) params.set("cursor", options.cursor);
      const source = new EventSource(`/api/tavern/v1/events?${params.toString()}`, { withCredentials: true });
      const eventTypes = [
        "companion.delta",
        "message.committed",
        "draft.changed",
        "turn.state_changed",
        "memory.changed",
        "stream.resync_required",
      ] as const;
      const handle = (raw: Event): void => {
        const message = raw as MessageEvent<string>;
        let value: unknown;
        try {
          value = JSON.parse(message.data);
          const event = validateEvent(value);
          if (!isOpaqueHandle(message.lastEventId)) throw new TavernProtocolError();
          options.onEvent(event, message.lastEventId);
        } catch {
          options.onError(new Event("protocol_error"));
        }
      };
      for (const eventType of eventTypes) source.addEventListener(eventType, handle);
      source.onerror = options.onError;
      return Object.freeze({
        close() {
          for (const eventType of eventTypes) source.removeEventListener(eventType, handle);
          source.close();
        },
      });
    },
  });
}
