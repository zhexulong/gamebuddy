/**
 * Browser-only strict DTO validators and fetch client for the
 * `tavern_browser_api/v1` tavern-management wire contract
 * (`gamebuddy.tavern-management.chat-list-title`): metadata-only Chat list and
 * exact title rename.
 *
 * This module is deliberately dependency-free and closed:
 *
 * - it imports nothing (no Host package, no typebox, no runtime code);
 * - every DTO validator is strict and local: extra fields are rejected,
 *   handles are canonical opaque unpadded base64url strings, and every union
 *   accepts only its exact frozen variants;
 * - the fetch client uses only same-origin relative routes with
 *   `credentials: "same-origin"`; `chat.rename` sends `Content-Type` and
 *   `x-csrf-token`; reads never send a CSRF header;
 * - validated non-2xx responses surface the RFC-9457-style `TavernProblemV1`
 *   as `TavernProblemError`; any opaque protocol failure throws
 *   `TavernProtocolError` and never echoes raw body text.
 *
 * There is no SSE, polling, timer, storage, generated handle, local list or
 * mock anywhere in this module.
 */

export const TAVERN_BROWSER_API_VERSION = 1 as const;
export const TAVERN_BROWSER_CONTRACT = "tavern_browser_api/v1" as const;
export const MANAGEMENT_PROFILE_ID = "gamebuddy.tavern-management.chat-list-title" as const;

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

export type TavernBrowserOperationV1 = Readonly<{
  operationId: "chat.submit" | "chat.cancel" | "draft.save" | "draft.discard" | "chat.rename" | "memory.mutate" | "world-info.bind";
  labelKey:
    | "tavern.nav.chat"
    | "tavern.nav.memory"
    | "tavern.operation.submit"
    | "tavern.operation.cancel"
    | "tavern.operation.draft.save"
    | "tavern.operation.draft.discard"
    | "tavern.operation.rename"
    | "tavern.operation.memory.mutate"
    | "tavern.operation.world-info.bind";
  availability: "available" | "busy" | "unavailable";
  routeId: string;
}>;

export type WorldInfoItemV1 = Readonly<{
  handle: string;
  title: string;
  summary: string | null;
  selected: boolean;
}>;

/** Safe opaque projection for binding World Info to the exact mounted Chat. */
export type WorldInfoStateV1 = Readonly<{
  state: "none" | "selected" | "locked" | "unavailable";
  revision: string;
  items: readonly WorldInfoItemV1[];
}>;

export type SetWorldInfoBindingCommandV1 = Readonly<{
  apiVersion: 1;
  selectionGeneration: number;
  expectedRevision: string;
  sourceHandle: string | null;
}>;

export type TavernStateSnapshotV1 = Readonly<{
  apiVersion: 1;
  build: Readonly<{
    browserContract: "tavern_browser_api/v1";
    profileId: "gamebuddy.tavern-management.chat-list-title";
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
    worldInfo: WorldInfoStateV1 | null;
  }> | null;
  memory: Readonly<{ readAvailable: boolean; mutationAvailable: boolean; projectionRevision: string | null }>;
  eventStream: null;
}>;

export type BrowserDraftV1 = Readonly<{ apiVersion: 1; revision: number; text: string | null }>;
export type SaveDraftCommandV1 = Readonly<{
  apiVersion: 1;
  selectionGeneration: number;
  expectedRevision: number;
  text: string;
}>;
export type DiscardDraftCommandV1 = Readonly<{ apiVersion: 1; selectionGeneration: number; expectedRevision: number }>;
export type ChatListQueryV1 = Readonly<{ apiVersion: 1; state?: "active" }>;

/** Metadata-only Chat list entry: no durable identifier ever appears. */
export type ChatListEntryV1 = Readonly<{
  handle: string;
  title: string | null;
  status: "active";
  managementRevision: number;
  isSelected: boolean;
}>;

export type ChatListV1 = Readonly<{
  apiVersion: 1;
  chats: readonly ChatListEntryV1[];
}>;

export type RenameChatTitleCommandV1 = Readonly<{
  apiVersion: 1;
  selectionGeneration: number;
  chatHandle: string;
  expectedManagementRevision: number;
  title: string;
}>;

export type ChatTitleV1 = Readonly<{
  apiVersion: 1;
  title: string | null;
  managementRevision: number;
}>;

export type MemoryItemV1 = Readonly<{
  handle: string;
  title: string;
  content: string;
  category: "semantic" | "interaction";
  status: "active" | "permanent" | "archived";
  pinned: boolean;
}>;

export type MemoryReadV1 = Readonly<{
  apiVersion: 1;
  projectionRevision: string;
  memories: readonly MemoryItemV1[];
}>;

export type MemoryMutationCommandV1 =
  | Readonly<{ apiVersion: 1; operation: "create"; expectedProjectionRevision: string; content: string }>
  | Readonly<{ apiVersion: 1; operation: "update"; expectedProjectionRevision: string; handle: string; content: string }>
  | Readonly<{ apiVersion: 1; operation: "archive"; expectedProjectionRevision: string; handle: string }>;

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

/** Every opaque protocol failure; the fixed message never echoes raw body text. */
export class TavernProtocolError extends Error {
  constructor() {
    super("tavern_browser_api/v1 protocol error");
    this.name = "TavernProtocolError";
  }
}

// --- Local strict validation primitives (mirroring the frozen contract). ---

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const HANDLE_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;
const ROUTE_ID_PATTERN = /^[a-z][a-z0-9._-]*$/;
const MAX_TEXT_UTF8_BYTES = 16_384;
const MAX_MEMORY_TEXT_UTF8_BYTES = 4096;
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
const OPERATION_IDS = ["chat.submit", "chat.cancel", "draft.save", "draft.discard", "chat.rename", "memory.mutate", "world-info.bind"] as const;
const LABEL_KEYS = [
  "tavern.nav.chat",
  "tavern.nav.memory",
  "tavern.operation.submit",
  "tavern.operation.cancel",
  "tavern.operation.draft.save",
  "tavern.operation.draft.discard",
  "tavern.operation.rename",
  "tavern.operation.memory.mutate",
  "tavern.operation.world-info.bind",
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
const OPERATION_KEYS = ["operationId", "labelKey", "availability", "routeId"] as const;
const NAVIGATION_ITEM_KEYS = ["itemId", "labelKey", "availability"] as const;
const WORLD_INFO_KEYS = ["state", "revision", "items"] as const;
const WORLD_INFO_ITEM_KEYS = ["handle", "title", "summary", "selected"] as const;
const SET_WORLD_INFO_BINDING_COMMAND_KEYS = ["apiVersion", "selectionGeneration", "expectedRevision", "sourceHandle"] as const;
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
const MEMORY_ITEM_KEYS = ["handle", "title", "content", "category", "status", "pinned"] as const;
const MEMORY_READ_KEYS = ["apiVersion", "projectionRevision", "memories"] as const;
const MEMORY_MUTATION_CREATE_KEYS = ["apiVersion", "operation", "expectedProjectionRevision", "content"] as const;
const MEMORY_MUTATION_UPDATE_KEYS = ["apiVersion", "operation", "expectedProjectionRevision", "handle", "content"] as const;
const MEMORY_MUTATION_ARCHIVE_KEYS = ["apiVersion", "operation", "expectedProjectionRevision", "handle"] as const;
const MEMORY_CATEGORIES = ["semantic", "interaction"] as const;
const MEMORY_STATUSES = ["active", "permanent", "archived"] as const;
const MAX_MEMORY_ITEMS = 200;
const DRAFT_KEYS = ["apiVersion", "revision", "text"] as const;
const SAVE_DRAFT_KEYS = ["apiVersion", "selectionGeneration", "expectedRevision", "text"] as const;
const DISCARD_DRAFT_KEYS = ["apiVersion", "selectionGeneration", "expectedRevision"] as const;
const _CHAT_LIST_QUERY_KEYS = ["apiVersion", "state"] as const;
const CHAT_LIST_ENTRY_KEYS = ["handle", "title", "status", "managementRevision", "isSelected"] as const;
const CHAT_LIST_KEYS = ["apiVersion", "chats"] as const;
const RENAME_COMMAND_KEYS = [
  "apiVersion",
  "selectionGeneration",
  "chatHandle",
  "expectedManagementRevision",
  "title",
] as const;
const CHAT_TITLE_KEYS = ["apiVersion", "title", "managementRevision"] as const;
const PROBLEM_KEYS = ["type", "title", "status", "code", "requestId", "retryable"] as const;

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

/** NFC, no unpaired surrogates, bounded UTF-8 bytes (frozen BoundedText). */
function isBoundedText(value: unknown, maxBytes: number): value is string {
  return isNfcUtf8Text(value, 1, maxBytes);
}

function isNfcUtf8Text(value: unknown, minLength = 1, maxBytes = MAX_TEXT_UTF8_BYTES): value is string {
  if (typeof value !== "string" || value.length < minLength) return false;
  if (hasUnpairedUtf16Surrogate(value)) return false;
  if (value !== value.normalize("NFC")) return false;
  return new TextEncoder().encode(value).byteLength <= maxBytes;
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

function isWorldInfoItem(value: unknown): value is WorldInfoItemV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, WORLD_INFO_ITEM_KEYS) &&
    isOpaqueHandle(value.handle) &&
    isLengthBoundedString(value.title, 1, 256) &&
    (value.summary === null || isLengthBoundedString(value.summary, 0, 512)) &&
    typeof value.selected === "boolean"
  );
}

function isWorldInfo(value: unknown): value is WorldInfoStateV1 {
  if (!isRecord(value) || !hasExactKeys(value, WORLD_INFO_KEYS)) return false;
  return (
    isOneOf(value.state, WORLD_INFO_STATES) &&
    isOpaqueHandle(value.revision) &&
    Array.isArray(value.items) &&
    value.items.length <= MAX_ARRAY_ITEMS &&
    value.items.every(isWorldInfoItem)
  );
}

function isSetWorldInfoBindingCommand(value: unknown): value is SetWorldInfoBindingCommandV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, SET_WORLD_INFO_BINDING_COMMAND_KEYS) &&
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    isPositiveSafeInteger(value.selectionGeneration) &&
    isOpaqueHandle(value.expectedRevision) &&
    (value.sourceHandle === null || isOpaqueHandle(value.sourceHandle))
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

function isMemoryState(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, MEMORY_KEYS)) return false;
  if (typeof value.readAvailable !== "boolean" || typeof value.mutationAvailable !== "boolean") return false;
  if (value.projectionRevision !== null && !isOpaqueHandle(value.projectionRevision)) return false;
  return (
    (value.readAvailable && value.projectionRevision !== null) ||
    (!value.readAvailable && value.projectionRevision === null && !value.mutationAvailable)
  );
}

function isSnapshot(value: unknown): value is TavernStateSnapshotV1 {
  if (!isRecord(value) || !hasExactKeys(value, SNAPSHOT_KEYS)) return false;
  if (value.apiVersion !== TAVERN_BROWSER_API_VERSION) return false;
  if (
    !isRecord(value.build) ||
    !hasExactKeys(value.build, SNAPSHOT_BUILD_KEYS) ||
    value.build.browserContract !== TAVERN_BROWSER_CONTRACT ||
    value.build.profileId !== MANAGEMENT_PROFILE_ID
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
  if (!isMemoryState(value.memory)) return false;
  // The management profile mounts no events route: any event stream object is
  // a different (looser) contract and must reconcile, never be read loosely.
  if (value.eventStream !== null) return false;
  return true;
}

function isDraft(value: unknown): value is BrowserDraftV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, DRAFT_KEYS) &&
    value.apiVersion === 1 &&
    isNonNegativeSafeInteger(value.revision) &&
    (value.text === null || isNfcUtf8Text(value.text))
  );
}
function isSaveDraftCommand(value: unknown): value is SaveDraftCommandV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, SAVE_DRAFT_KEYS) &&
    value.apiVersion === 1 &&
    isPositiveSafeInteger(value.selectionGeneration) &&
    isNonNegativeSafeInteger(value.expectedRevision) &&
    isNfcUtf8Text(value.text)
  );
}
function isDiscardDraftCommand(value: unknown): value is DiscardDraftCommandV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, DISCARD_DRAFT_KEYS) &&
    value.apiVersion === 1 &&
    isPositiveSafeInteger(value.selectionGeneration) &&
    isNonNegativeSafeInteger(value.expectedRevision)
  );
}
function validateDraft(value: unknown): BrowserDraftV1 {
  if (!isDraft(value)) throw new TavernProtocolError();
  return value;
}

function isChatListQuery(value: unknown): value is ChatListQueryV1 {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1 && keys.length !== 2) return false;
  if (!keys.includes("apiVersion") || (keys.length === 2 && !keys.includes("state"))) return false;
  if (value.apiVersion !== TAVERN_BROWSER_API_VERSION) return false;
  return keys.length === 1 || value.state === "active";
}

function isChatListEntry(value: unknown): value is ChatListEntryV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, CHAT_LIST_ENTRY_KEYS) &&
    isOpaqueHandle(value.handle) &&
    (value.title === null || isLengthBoundedString(value.title, 0, 256)) &&
    value.status === "active" &&
    isNonNegativeSafeInteger(value.managementRevision) &&
    typeof value.isSelected === "boolean"
  );
}

function isChatList(value: unknown): value is ChatListV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, CHAT_LIST_KEYS) &&
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    Array.isArray(value.chats) &&
    value.chats.length <= MAX_ARRAY_ITEMS &&
    value.chats.every(isChatListEntry)
  );
}

function isRenameChatTitleCommand(value: unknown): value is RenameChatTitleCommandV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, RENAME_COMMAND_KEYS) &&
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    isPositiveSafeInteger(value.selectionGeneration) &&
    isOpaqueHandle(value.chatHandle) &&
    isNonNegativeSafeInteger(value.expectedManagementRevision) &&
    isNfcUtf8Text(value.title, 1) &&
    value.title.length <= 120
  );
}

function isChatTitle(value: unknown): value is ChatTitleV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, CHAT_TITLE_KEYS) &&
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    (value.title === null || isLengthBoundedString(value.title, 0, 256)) &&
    isNonNegativeSafeInteger(value.managementRevision)
  );
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

function isMemoryItem(value: unknown): value is MemoryItemV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, MEMORY_ITEM_KEYS) &&
    isOpaqueHandle(value.handle) &&
    isLengthBoundedString(value.title, 1, 256) &&
    isBoundedText(value.content, MAX_MEMORY_TEXT_UTF8_BYTES) &&
    isOneOf(value.category, MEMORY_CATEGORIES) &&
    isOneOf(value.status, MEMORY_STATUSES) &&
    typeof value.pinned === "boolean"
  );
}

function isMemoryRead(value: unknown): value is MemoryReadV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, MEMORY_READ_KEYS) &&
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    isOpaqueHandle(value.projectionRevision) &&
    Array.isArray(value.memories) &&
    value.memories.length <= MAX_MEMORY_ITEMS &&
    value.memories.every(isMemoryItem)
  );
}

function isMemoryMutationCommand(value: unknown): value is MemoryMutationCommandV1 {
  if (!isRecord(value) || value.apiVersion !== TAVERN_BROWSER_API_VERSION || !isOpaqueHandle(value.expectedProjectionRevision)) return false;
  if (value.operation === "create")
    return hasExactKeys(value, MEMORY_MUTATION_CREATE_KEYS) && isBoundedText(value.content, MAX_MEMORY_TEXT_UTF8_BYTES);
  if (value.operation === "update")
    return hasExactKeys(value, MEMORY_MUTATION_UPDATE_KEYS) && isOpaqueHandle(value.handle) && isBoundedText(value.content, MAX_MEMORY_TEXT_UTF8_BYTES);
  return value.operation === "archive" && hasExactKeys(value, MEMORY_MUTATION_ARCHIVE_KEYS) && isOpaqueHandle(value.handle);
}

// --- Public strict closed validators. ---

export function validateSnapshot(value: unknown): TavernStateSnapshotV1 {
  if (!isSnapshot(value)) throw new TavernProtocolError();
  return value;
}
export function validateChatList(value: unknown): ChatListV1 {
  if (!isChatList(value)) throw new TavernProtocolError();
  return value;
}
export function validateChatTitle(value: unknown): ChatTitleV1 {
  if (!isChatTitle(value)) throw new TavernProtocolError();
  return value;
}
export function validateProblem(value: unknown): TavernProblemV1 {
  if (!isProblem(value)) throw new TavernProtocolError();
  return value;
}
export function validateMemoryRead(value: unknown): MemoryReadV1 {
  if (!isMemoryRead(value)) throw new TavernProtocolError();
  return value;
}
export function validateMemoryMutationCommand(value: unknown): MemoryMutationCommandV1 {
  if (!isMemoryMutationCommand(value)) throw new TavernProtocolError();
  return value;
}
export function validateWorldInfoState(value: unknown): WorldInfoStateV1 {
  if (!isWorldInfo(value)) throw new TavernProtocolError();
  return value;
}
export function validateSetWorldInfoBindingCommand(value: unknown): SetWorldInfoBindingCommandV1 {
  if (!isSetWorldInfoBindingCommand(value)) throw new TavernProtocolError();
  return value;
}

// --- Fetch client for the management routes. ---

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

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
    if (isProblem(bodyValue)) throw new TavernProblemError(bodyValue);
    throw new TavernProtocolError();
  }
  if (response.status !== expectedStatus) throw new TavernProtocolError();
  return decode(bodyValue);
}

export type ManagementPipelineApi = Readonly<{
  /** POST /api/tavern/v1/bootstrap (one-time bootstrap token). */
  bootstrap(token: string): Promise<TavernStateSnapshotV1>;
  /** GET /api/tavern/v1/state (browser session cookie). */
  readState(): Promise<TavernStateSnapshotV1>;
  /** GET /api/tavern/v1/chats (metadata-only list; no CSRF header). */
  listChats(query?: ChatListQueryV1): Promise<ChatListV1>;
  /** GET /api/tavern/v1/draft for the exact mounted Chat. */
  readDraft(): Promise<BrowserDraftV1>;
  /** PUT /api/tavern/v1/draft with durable revision CAS. */
  saveDraft(command: SaveDraftCommandV1, csrfToken: string): Promise<BrowserDraftV1>;
  /** DELETE /api/tavern/v1/draft with durable revision CAS. */
  discardDraft(command: DiscardDraftCommandV1, csrfToken: string): Promise<BrowserDraftV1>;
  /** PUT /api/tavern/v1/chat/title with Content-Type and x-csrf-token. */
  renameChatTitle(command: RenameChatTitleCommandV1, csrfToken: string): Promise<ChatTitleV1>;
  /** GET /api/tavern/v1/memory (browser session; no CSRF header). */
  readMemory(): Promise<MemoryReadV1>;
  /** PUT /api/tavern/v1/memory with ordinary projection-revision CAS. */
  mutateMemory(command: MemoryMutationCommandV1, csrfToken: string): Promise<MemoryReadV1>;
  /** GET safe World Info state for the exact mounted Chat. */
  readWorldInfo(): Promise<WorldInfoStateV1>;
  /** PUT exact bind/unbind command with browser-session CSRF protection. */
  setWorldInfoBinding(command: SetWorldInfoBindingCommandV1, csrfToken: string): Promise<WorldInfoStateV1>;
}>;

export function createManagementPipelineApi(fetchLike: typeof fetch = fetch): ManagementPipelineApi {
  if (typeof fetchLike !== "function") {
    throw new TypeError("createManagementPipelineApi requires a fetch-like function");
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
    async listChats(query: ChatListQueryV1 = { apiVersion: TAVERN_BROWSER_API_VERSION }): Promise<ChatListV1> {
      if (!isChatListQuery(query)) throw new TavernProtocolError();
      const params = new URLSearchParams({ apiVersion: String(TAVERN_BROWSER_API_VERSION) });
      if (query.state !== undefined) params.set("state", query.state);
      return exchange(fetchLike, "GET", `/api/tavern/v1/chats?${params.toString()}`, 200, validateChatList);
    },
    async readDraft(): Promise<BrowserDraftV1> {
      return exchange(fetchLike, "GET", "/api/tavern/v1/draft", 200, validateDraft);
    },
    async saveDraft(command: SaveDraftCommandV1, csrfToken: string): Promise<BrowserDraftV1> {
      if (!isSaveDraftCommand(command) || !isOpaqueHandle(csrfToken)) throw new TavernProtocolError();
      return exchange(
        fetchLike,
        "PUT",
        "/api/tavern/v1/draft",
        200,
        validateDraft,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        command,
      );
    },
    async discardDraft(command: DiscardDraftCommandV1, csrfToken: string): Promise<BrowserDraftV1> {
      if (!isDiscardDraftCommand(command) || !isOpaqueHandle(csrfToken)) throw new TavernProtocolError();
      return exchange(
        fetchLike,
        "DELETE",
        "/api/tavern/v1/draft",
        200,
        validateDraft,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        command,
      );
    },
    async renameChatTitle(command: RenameChatTitleCommandV1, csrfToken: string): Promise<ChatTitleV1> {
      if (!isRenameChatTitleCommand(command)) throw new TavernProtocolError();
      if (!isOpaqueHandle(csrfToken)) throw new TavernProtocolError();
      return exchange(
        fetchLike,
        "PUT",
        "/api/tavern/v1/chat/title",
        200,
        validateChatTitle,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        command,
      );
    },
    async readMemory(): Promise<MemoryReadV1> {
      return exchange(fetchLike, "GET", "/api/tavern/v1/memory", 200, validateMemoryRead);
    },
    async mutateMemory(command: MemoryMutationCommandV1, csrfToken: string): Promise<MemoryReadV1> {
      if (!isMemoryMutationCommand(command) || !isOpaqueHandle(csrfToken)) throw new TavernProtocolError();
      return exchange(
        fetchLike,
        "PUT",
        "/api/tavern/v1/memory",
        200,
        validateMemoryRead,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        command,
      );
    },
    async readWorldInfo(): Promise<WorldInfoStateV1> {
      return exchange(fetchLike, "GET", "/api/tavern/v1/world-info", 200, validateWorldInfoState);
    },
    async setWorldInfoBinding(command: SetWorldInfoBindingCommandV1, csrfToken: string): Promise<WorldInfoStateV1> {
      if (!isSetWorldInfoBindingCommand(command) || !isOpaqueHandle(csrfToken)) throw new TavernProtocolError();
      return exchange(
        fetchLike,
        "PUT",
        "/api/tavern/v1/world-info",
        200,
        validateWorldInfoState,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        command,
      );
    },
  });
}
