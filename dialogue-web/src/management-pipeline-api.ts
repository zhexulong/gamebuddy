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

const TAVERN_BROWSER_API_VERSION = 1 as const;
const TAVERN_BROWSER_CONTRACT = "tavern_browser_api/v1" as const;
const MANAGEMENT_PROFILE_ID = "gamebuddy.tavern-management.chat-list-title" as const;

// --- Frozen v1 DTO shapes (structural mirrors of host/src/tavern/browser-contract). ---

type BrowserMessageV1 = Readonly<{
  handle: string;
  role: "player" | "companion";
  text: string;
  locale: "en" | "zh-CN" | "und";
  order: number;
  revision: number;
}>;

type BrowserTurnV1 = Readonly<{
  handle: string;
  state: "queued" | "running" | "response_visible" | "stopping" | "completed" | "cancelled" | "failed";
  projectionRevision: number;
  canCancel: boolean;
  problemCode?: "interrupted" | "no_visible_presentation" | "runtime_unavailable" | "storage_unavailable";
}>;

type TavernBrowserOperationV1 = Readonly<{
  operationId:
    | "chat.submit"
    | "chat.cancel"
    | "draft.save"
    | "draft.discard"
    | "chat.rename"
    | "memory.mutate"
    | "world-info.bind"
    | "settings.voice.read"
    | "settings.voice.consent"
    | "settings.voice.devices"
    | "settings.language.read"
    | "settings.language.update"
    | "settings.connection.read"
    | "settings.connection.create"
    | "settings.connection.test"
    | "settings.connection.activate"
    | "settings.connection.model"
    | "settings.connection.remove"
    | "companion.list"
    | "companion.detail"
    | "companion.create"
    | "character.import.stage"
    | "character.import.read"
    | "character.import.review"
    | "character.import.confirm"
    | "persona.read"
    | "persona.update"
    | "scenario.read"
    | "scenario.update"
    | "greeting.read"
    | "greeting.update"
    | "chat.archive"
    | "chat.restore"
    | "chat.trash";
  labelKey:
    | "tavern.nav.chat"
    | "tavern.nav.memory"
    | "tavern.nav.characters"
    | "tavern.operation.submit"
    | "tavern.operation.cancel"
    | "tavern.operation.draft.save"
    | "tavern.operation.draft.discard"
    | "tavern.operation.rename"
    | "tavern.operation.memory.mutate"
    | "tavern.operation.world-info.bind"
    | "tavern.operation.settings.voice.read"
    | "tavern.operation.settings.voice.consent"
    | "tavern.operation.settings.voice.devices"
    | "tavern.operation.settings.language.read"
    | "tavern.operation.settings.language.update"
    | "tavern.operation.settings.connection.read"
    | "tavern.operation.settings.connection.create"
    | "tavern.operation.settings.connection.test"
    | "tavern.operation.settings.connection.activate"
    | "tavern.operation.settings.connection.model"
    | "tavern.operation.settings.connection.remove"
    | "tavern.operation.companion.list"
    | "tavern.operation.companion.detail"
    | "tavern.operation.companion.create"
    | "tavern.operation.character.import.stage"
    | "tavern.operation.character.import.read"
    | "tavern.operation.character.import.review"
    | "tavern.operation.character.import.confirm"
    | "tavern.operation.persona.read"
    | "tavern.operation.persona.update"
    | "tavern.operation.scenario.read"
    | "tavern.operation.scenario.update"
    | "tavern.operation.greeting.read"
    | "tavern.operation.greeting.update"
    | "tavern.operation.chat.archive"
    | "tavern.operation.chat.restore"
    | "tavern.operation.chat.trash";
  availability: "available" | "busy" | "unavailable";
  routeId: string;
}>;

type WorldInfoItemV1 = Readonly<{
  handle: string;
  title: string;
  summary: string | null;
  selected: boolean;
  pending: boolean;
}>;

/** Safe opaque projection for binding World Info to the exact mounted Chat. */
export type WorldInfoStateV1 = Readonly<{
  state: "none" | "selected" | "pending" | "unavailable";
  revision: string;
  items: readonly WorldInfoItemV1[];
}>;

export type SetWorldInfoBindingCommandV1 = Readonly<{
  apiVersion: 1;
  selectionGeneration: number;
  expectedRevision: string;
  sourceHandle: string | null;
}>;

/** Metadata-only companion library entry: opaque handle plus display name. */
export type CompanionListEntryV1 = Readonly<{
  handle: string;
  name: string;
  isCurrent: boolean;
}>;
export type CompanionListV1 = Readonly<{
  apiVersion: 1;
  companions: readonly CompanionListEntryV1[];
}>;
/** Safe player-visible companion detail: name only. */
export type CompanionDetailV1 = Readonly<{
  apiVersion: 1;
  name: string;
}>;
export type StCardImportFieldSummaryV1 = Readonly<{
  field: string;
  eligibility: "candidate_only" | "profile_eligible_after_explicit_review" | "never_runtime";
  chars: number;
}>;
export type StCardImportDispositionV1 = Readonly<{
  field: string;
  classification: "accepted_typed" | "preserved_opaque" | "dropped_unsupported" | "rejected_invalid";
  reason: string;
}>;
export type StCardImportStageResultV1 = Readonly<{
  apiVersion: 1;
  importId: string;
  name: string;
  candidateRevision: number;
  fields: readonly StCardImportFieldSummaryV1[];
  dispositions: readonly StCardImportDispositionV1[];
}>;
export type StCardImportReadResultV1 = Readonly<{
  apiVersion: 1;
  importId: string;
  name: string;
  candidateRevision: number;
  reviewed: boolean;
  reviewedFields: readonly string[];
  fields: readonly StCardImportFieldSummaryV1[];
  dispositions: readonly StCardImportDispositionV1[];
}>;
export type StCardImportReviewResultV1 = Readonly<{
  apiVersion: 1;
  importId: string;
  reviewedFields: readonly string[];
  approvedAtMs: number;
}>;
export type StCardImportConfirmResultV1 = Readonly<{ apiVersion: 1; name: string }>;
/** How many raw card fields the decoder kept or dropped, per disposition class. */
export type StCardImportDispositionCountsV1 = Readonly<{
  accepted_typed: number;
  preserved_opaque: number;
  dropped_unsupported: number;
  rejected_invalid: number;
}>;
/** Durable evidence row for one confirmed import; never a capability. */
export type StCardImportHistoryEntryV1 = Readonly<{
  importId: string;
  occurredAtMs: number;
  cardName: string;
  counts: StCardImportDispositionCountsV1;
}>;
export type StCardImportHistoryV1 = Readonly<{
  apiVersion: 1;
  entries: readonly StCardImportHistoryEntryV1[];
}>;
/** Player persona projection: revision and safe display fields. */
export type PersonaV1 = Readonly<{
  apiVersion: 1;
  present: boolean;
  revision: number | null;
  name: string | null;
  description: string | null;
}>;
/** Player scenario projection. */
export type ScenarioV1 = Readonly<{
  apiVersion: 1;
  present: boolean;
  revision: number | null;
  name: string | null;
  description: string | null;
  preview: string | null;
}>;
/** Player greeting set projection. */
export type GreetingV1 = Readonly<{
  apiVersion: 1;
  present: boolean;
  revision: number | null;
  label: string | null;
  variants: readonly Readonly<{ label: string | null; text: string }>[];
}>;
/** Chat lifecycle retention result. */
export type ChatRetentionResultV1 = Readonly<{
  apiVersion: 1;
  handle: string;
  status: "active" | "archived" | "trashed";
  managementRevision: number;
}>;

export type TavernVoicePreferenceV1 = Readonly<{
  revision: number;
  disclosureVersion: "mimo-cloud-tts-v1" | null;
  consent: "undecided" | "accepted" | "revoked";
  decidedAtMs: number | null;
  /** `null` = Windows default output; `waveout:N` pins one enumerated endpoint. */
  outputDevice: string | null;
}>;

export type TavernVoiceDevicesV1 = Readonly<{
  devices: readonly Readonly<{ id: string; name: string }>[];
  defaultSelectable: true;
}>;

export type TavernVoicePreferenceConsentCommandV1 =
  | Readonly<{ expectedRevision: number; action: "accept"; disclosureVersion: "mimo-cloud-tts-v1" }>
  | Readonly<{ expectedRevision: number; action: "revoke" }>
  | Readonly<{
      expectedRevision: number;
      action: "setOutputDevice";
      outputDevice: string | null;
    }>;

/** Mirrors the Host's TavernLanguagePreferenceV1. */
export type TavernLanguagePreferenceV1 = Readonly<{
  revision: number;
  /** `null` = the player has never chosen; the runtime then uses its default. */
  locale: "zh-CN" | "en-US" | null;
}>;

/** Mirrors the Host's TavernLanguagePreferenceCommandV1. */
export type TavernLanguagePreferenceCommandV1 = Readonly<{
  expectedRevision: number;
  locale: "zh-CN" | "en-US";
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
type SaveDraftCommandV1 = Readonly<{
  apiVersion: 1;
  selectionGeneration: number;
  expectedRevision: number;
  text: string;
}>;
type DiscardDraftCommandV1 = Readonly<{ apiVersion: 1; selectionGeneration: number; expectedRevision: number }>;
type ChatListQueryV1 = Readonly<{ apiVersion: 1; state?: "active" }>;

/** Metadata-only Chat list entry: no durable identifier ever appears. */
type ChatListEntryV1 = Readonly<{
  handle: string;
  title: string | null;
  status: "active";
  managementRevision: number;
  isSelected: boolean;
}>;

type ChatListV1 = Readonly<{
  apiVersion: 1;
  chats: readonly ChatListEntryV1[];
}>;

type RenameChatTitleCommandV1 = Readonly<{
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
  | Readonly<{
      apiVersion: 1;
      operation: "update";
      expectedProjectionRevision: string;
      handle: string;
      content: string;
    }>
  | Readonly<{ apiVersion: 1; operation: "archive"; expectedProjectionRevision: string; handle: string }>;

export type TavernProblemV1 = Readonly<{
  type: string;
  title: string;
  status: number;
  code: string;
  requestId: string;
  retryable: boolean;
}>;

/**
 * Connection and model management (design/28 §1, §5.1).
 *
 * `connectionId` is an opaque write handle; each row also carries the labels a
 * player reads. `baseUrl` is present only for the connection whose endpoint the
 * player typed (the OpenAI-compatible escape hatch) — it is the one endpoint
 * fact a player may read back. No credential, credential source or raw provider
 * error exists anywhere in these shapes.
 */
export type TavernConnectionSetupFieldV1 = "apiKey" | "baseUrl" | "modelId";
export type TavernConnectionThinkingLevelV1 = "low" | "medium" | "high" | "xhigh" | "max";
export type TavernConnectionReadinessV1 = "unconfigured" | "configured" | "ready" | "failed";
export type TavernConnectionFailureV1 =
  | "invalid_endpoint"
  | "not_configured"
  | "unauthorized"
  | "not_found"
  | "unreachable"
  | "timeout"
  | "invalid_response";

export type TavernConnectionModelV1 = Readonly<{
  modelId: string;
  modelLabel: string;
  allowedThinkingLevels: readonly TavernConnectionThinkingLevelV1[];
  defaultThinkingLevel: TavernConnectionThinkingLevelV1;
}>;

export type TavernConnectionProviderV1 = Readonly<{
  providerId: string;
  label: string;
  setupFields: readonly TavernConnectionSetupFieldV1[];
  allowedPlayerModels: readonly TavernConnectionModelV1[];
  escapeHatch: boolean;
  environmentManaged: boolean;
}>;

export type TavernConnectionV1 = Readonly<{
  connectionId: string;
  label: string;
  providerId: string;
  providerLabel: string;
  configured: boolean;
  readiness: TavernConnectionReadinessV1;
  active: boolean;
  modelId: string;
  modelLabel: string;
  thinkingLevel: TavernConnectionThinkingLevelV1;
  baseUrl: string | null;
  failure: TavernConnectionFailureV1 | null;
  lastCheckedAtMs: number | null;
}>;

export type TavernConnectionActiveV1 = Readonly<{
  connectionId: string;
  label: string;
  providerLabel: string;
  modelId: string;
  modelLabel: string;
  thinkingLevel: TavernConnectionThinkingLevelV1;
  readiness: TavernConnectionReadinessV1;
  baseUrl: string | null;
  failure: TavernConnectionFailureV1 | null;
  lastCheckedAtMs: number | null;
}>;

export type TavernConnectionStateV1 = Readonly<{
  apiVersion: 1;
  revision: number;
  active: TavernConnectionActiveV1 | null;
  connections: readonly TavernConnectionV1[];
  providers: readonly TavernConnectionProviderV1[];
}>;

export type TavernConnectionCreateCommandV1 = Readonly<{
  apiVersion: 1;
  providerId: string;
  apiKey?: string;
  baseUrl?: string;
  modelId?: string;
}>;

export type TavernConnectionProbeV1 = Readonly<{
  apiVersion: 1;
  connectionId: string;
  outcome: "ready" | "failed";
  failure: TavernConnectionFailureV1 | null;
  state: TavernConnectionStateV1;
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
const OPERATION_IDS = [
  "chat.submit",
  "chat.cancel",
  "draft.save",
  "draft.discard",
  "chat.rename",
  "memory.mutate",
  "world-info.bind",
  "settings.voice.read",
  "settings.voice.consent",
  "settings.voice.devices",
  "settings.language.read",
  "settings.language.update",
  "settings.connection.read",
  "settings.connection.create",
  "settings.connection.test",
  "settings.connection.activate",
  "settings.connection.model",
  "settings.connection.remove",
  // design/28 §2 Character / Persona / Scenario / Greeting + Chat retention.
  "companion.list",
  "companion.detail",
  "companion.create",
  // design/28 §2 import/export row: reviewed ST-card import pipeline.
  "character.import.stage",
  "character.import.read",
  "character.import.review",
  "character.import.confirm",
  "character.import.history",
  "persona.read",
  "persona.update",
  "scenario.read",
  "scenario.update",
  "greeting.read",
  "greeting.update",
  "chat.archive",
  "chat.restore",
  "chat.trash",
] as const;
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
  "tavern.operation.settings.voice.read",
  "tavern.operation.settings.voice.consent",
  "tavern.operation.settings.voice.devices",
  "tavern.operation.settings.language.read",
  "tavern.operation.settings.language.update",
  "tavern.operation.settings.connection.read",
  "tavern.operation.settings.connection.create",
  "tavern.operation.settings.connection.test",
  "tavern.operation.settings.connection.activate",
  "tavern.operation.settings.connection.model",
  "tavern.operation.settings.connection.remove",
  "tavern.nav.characters",
  "tavern.operation.companion.list",
  "tavern.operation.companion.detail",
  "tavern.operation.companion.create",
  "tavern.operation.character.import.stage",
  "tavern.operation.character.import.read",
  "tavern.operation.character.import.review",
  "tavern.operation.character.import.confirm",
  "tavern.operation.character.import.history",
  "tavern.operation.persona.read",
  "tavern.operation.persona.update",
  "tavern.operation.scenario.read",
  "tavern.operation.scenario.update",
  "tavern.operation.greeting.read",
  "tavern.operation.greeting.update",
  "tavern.operation.chat.archive",
  "tavern.operation.chat.restore",
  "tavern.operation.chat.trash",
] as const;
const OPERATION_AVAILABILITY = ["available", "busy", "unavailable"] as const;
const NAVIGATION_ITEM_IDS = ["chat", "memory", "characters"] as const;
const NAVIGATION_AVAILABILITY = ["available", "unavailable"] as const;
const WORLD_INFO_STATES = ["none", "selected", "pending", "unavailable"] as const;
const VOICE_DISCLOSURE_VERSIONS = ["mimo-cloud-tts-v1"] as const;
const VOICE_CONSENTS = ["undecided", "accepted", "revoked"] as const;
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
  "settings_revision_conflict",
  // design/28 §5.3: activation may not switch a running turn, and the
  // connection routes carry their own closed problem codes.
  "dialogue_busy",
  "connection_not_found",
  "connection_not_ready",
  "connection_conflict",
  "connection_limit_reached",
  "companion_not_found",
  "companion_conflict",
  // design/28 §2 import/export row: the staged-card pipeline has its own closed
  // problem codes (rejected card, unknown import, unreviewed confirm).
  "st_card_import_rejected",
  "character_import_not_found",
  "character_import_review_invalid",
  "character_import_confirm_invalid",
  "persona_conflict",
  "scenario_conflict",
  "greeting_conflict",
  "authored_content_invalid",
] as const;

const MESSAGE_KEYS = ["handle", "role", "text", "locale", "order", "revision"] as const;
const TURN_KEYS = ["handle", "state", "projectionRevision", "canCancel"] as const;
const TURN_KEYS_WITH_PROBLEM_CODE = ["handle", "state", "projectionRevision", "canCancel", "problemCode"] as const;
const OPERATION_KEYS = ["operationId", "labelKey", "availability", "routeId"] as const;
const NAVIGATION_ITEM_KEYS = ["itemId", "labelKey", "availability"] as const;
const WORLD_INFO_KEYS = ["state", "revision", "items"] as const;
const WORLD_INFO_ITEM_KEYS = ["handle", "title", "summary", "selected", "pending"] as const;
const SET_WORLD_INFO_BINDING_COMMAND_KEYS = [
  "apiVersion",
  "selectionGeneration",
  "expectedRevision",
  "sourceHandle",
] as const;
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
// `voice` is `Type.Optional` in the Host contract (host/src/tavern/browser-contract).
// This mirror is strict - hasExactKeys compares lengths - so "optional" has to be
// written as "exactly one of these two shapes", not left out of the list. Leaving
// it out made the client reject any snapshot that carried the field, and the time
// between the Host adding a key and this mirror learning it is exactly when the
// whole management surface goes dark (the `pending` World Info key did that: no
// panel was reachable at all).
const SNAPSHOT_KEYS_WITH_VOICE = [
  "apiVersion",
  "build",
  "csrfToken",
  "browserSession",
  "operations",
  "navigation",
  "selection",
  "chat",
  "memory",
  "voice",
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
const MEMORY_MUTATION_UPDATE_KEYS = [
  "apiVersion",
  "operation",
  "expectedProjectionRevision",
  "handle",
  "content",
] as const;
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
const LANGUAGE_PREFERENCE_KEYS = ["revision", "locale"] as const;
const LANGUAGE_PREFERENCE_COMMAND_KEYS = ["expectedRevision", "locale"] as const;
const VOICE_PREFERENCE_KEYS = ["revision", "disclosureVersion", "consent", "decidedAtMs", "outputDevice"] as const;
const VOICE_PREFERENCE_ACCEPT_KEYS = ["expectedRevision", "action", "disclosureVersion"] as const;
const VOICE_PREFERENCE_REVOKE_KEYS = ["expectedRevision", "action"] as const;
const VOICE_PREFERENCE_DEVICE_KEYS = ["expectedRevision", "action", "outputDevice"] as const;
const VOICE_DEVICES_KEYS = ["devices", "defaultSelectable"] as const;
const VOICE_DEVICE_KEYS = ["id", "name"] as const;
const CONNECTION_STATE_KEYS = ["apiVersion", "revision", "active", "connections", "providers"] as const;
const CONNECTION_ROW_KEYS = [
  "connectionId",
  "label",
  "providerId",
  "providerLabel",
  "configured",
  "readiness",
  "active",
  "modelId",
  "modelLabel",
  "thinkingLevel",
  "baseUrl",
  "failure",
  "lastCheckedAtMs",
] as const;
const CONNECTION_ACTIVE_KEYS = [
  "connectionId",
  "label",
  "providerLabel",
  "modelId",
  "modelLabel",
  "thinkingLevel",
  "readiness",
  "baseUrl",
  "failure",
  "lastCheckedAtMs",
] as const;
const CONNECTION_PROVIDER_KEYS = [
  "providerId",
  "label",
  "setupFields",
  "allowedPlayerModels",
  "escapeHatch",
  "environmentManaged",
] as const;
const CONNECTION_MODEL_KEYS = [
  "modelId",
  "modelLabel",
  "allowedThinkingLevels",
  "defaultThinkingLevel",
] as const;
const CONNECTION_PROBE_KEYS = ["apiVersion", "connectionId", "outcome", "failure", "state"] as const;
const CONNECTION_SETUP_FIELDS = ["apiKey", "baseUrl", "modelId"] as const;
const CONNECTION_THINKING_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
const CONNECTION_READINESS = ["unconfigured", "configured", "ready", "failed"] as const;
const CONNECTION_FAILURES = [
  "invalid_endpoint",
  "not_configured",
  "unauthorized",
  "not_found",
  "unreachable",
  "timeout",
  "invalid_response",
] as const;

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
    typeof value.selected === "boolean" &&
    typeof value.pending === "boolean"
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

const COMPANION_LIST_KEYS = ["apiVersion", "companions"] as const;
const COMPANION_LIST_ENTRY_KEYS = ["handle", "name", "isCurrent"] as const;
const COMPANION_DETAIL_KEYS = ["apiVersion", "name"] as const;
const PERSONA_KEYS = ["apiVersion", "present", "revision", "name", "description"] as const;
const SCENARIO_KEYS = ["apiVersion", "present", "revision", "name", "description", "preview"] as const;
const GREETING_KEYS = ["apiVersion", "present", "revision", "label", "variants"] as const;
const GREETING_VARIANT_KEYS = ["label", "text"] as const;
const RETENTION_RESULT_KEYS = ["apiVersion", "handle", "status", "managementRevision"] as const;
const RETENTION_OPERATIONS = ["archive", "restore", "trash"] as const;

function isCompanionList(value: unknown): value is CompanionListV1 {
  if (!isRecord(value) || !hasExactKeys(value, COMPANION_LIST_KEYS)) return false;
  return (
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    Array.isArray(value.companions) &&
    value.companions.every(
      (entry) =>
        isRecord(entry) &&
        hasExactKeys(entry, COMPANION_LIST_ENTRY_KEYS) &&
        isOpaqueHandle(entry.handle) &&
        isLengthBoundedString(entry.name, 1, 128) &&
        typeof entry.isCurrent === "boolean",
    )
  );
}

function isCompanionDetail(value: unknown): value is CompanionDetailV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, COMPANION_DETAIL_KEYS) &&
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    isLengthBoundedString(value.name, 1, 128)
  );
}

const IMPORT_FIELD_KEYS = ["field", "eligibility", "chars"] as const;
const IMPORT_DISPOSITION_KEYS = ["field", "classification", "reason"] as const;
const IMPORT_STAGE_KEYS = ["apiVersion", "importId", "name", "candidateRevision", "fields", "dispositions"] as const;
const IMPORT_READ_KEYS = [
  "apiVersion",
  "importId",
  "name",
  "candidateRevision",
  "reviewed",
  "reviewedFields",
  "fields",
  "dispositions",
] as const;
const IMPORT_REVIEW_KEYS = ["apiVersion", "importId", "reviewedFields", "approvedAtMs"] as const;
const IMPORT_CONFIRM_KEYS = ["apiVersion", "name"] as const;
const IMPORT_HISTORY_COUNTS_KEYS = [
  "accepted_typed",
  "preserved_opaque",
  "dropped_unsupported",
  "rejected_invalid",
] as const;
const IMPORT_HISTORY_ENTRY_KEYS = ["importId", "occurredAtMs", "cardName", "counts"] as const;
const IMPORT_HISTORY_KEYS = ["apiVersion", "entries"] as const;
const IMPORT_ELIGIBILITY = new Set([
  "candidate_only",
  "profile_eligible_after_explicit_review",
  "never_runtime",
]);
const IMPORT_CLASSIFICATION = new Set([
  "accepted_typed",
  "preserved_opaque",
  "dropped_unsupported",
  "rejected_invalid",
]);

function isImportField(value: unknown): value is StCardImportFieldSummaryV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, IMPORT_FIELD_KEYS) &&
    isLengthBoundedString(value.field, 1, 64) &&
    typeof value.eligibility === "string" &&
    IMPORT_ELIGIBILITY.has(value.eligibility) &&
    isNonNegativeSafeInteger(value.chars)
  );
}

function isImportDisposition(value: unknown): value is StCardImportDispositionV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, IMPORT_DISPOSITION_KEYS) &&
    isLengthBoundedString(value.field, 1, 128) &&
    typeof value.classification === "string" &&
    IMPORT_CLASSIFICATION.has(value.classification) &&
    isLengthBoundedString(value.reason, 1, 128)
  );
}

function isImportFields(value: unknown): value is readonly StCardImportFieldSummaryV1[] {
  return Array.isArray(value) && value.length <= 32 && value.every(isImportField);
}

function isImportDispositions(value: unknown): value is readonly StCardImportDispositionV1[] {
  return Array.isArray(value) && value.length <= 128 && value.every(isImportDisposition);
}

function isReviewedFields(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length <= 32 &&
    value.every((field) => isLengthBoundedString(field, 1, 64))
  );
}

function isStCardImportStageResult(value: unknown): value is StCardImportStageResultV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, IMPORT_STAGE_KEYS) &&
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    isOpaqueHandle(value.importId) &&
    isLengthBoundedString(value.name, 1, 128) &&
    isNonNegativeSafeInteger(value.candidateRevision) &&
    isImportFields(value.fields) &&
    isImportDispositions(value.dispositions)
  );
}

function isStCardImportReadResult(value: unknown): value is StCardImportReadResultV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, IMPORT_READ_KEYS) &&
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    isOpaqueHandle(value.importId) &&
    isLengthBoundedString(value.name, 1, 128) &&
    isNonNegativeSafeInteger(value.candidateRevision) &&
    typeof value.reviewed === "boolean" &&
    isReviewedFields(value.reviewedFields) &&
    isImportFields(value.fields) &&
    isImportDispositions(value.dispositions)
  );
}

function isStCardImportReviewResult(value: unknown): value is StCardImportReviewResultV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, IMPORT_REVIEW_KEYS) &&
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    isOpaqueHandle(value.importId) &&
    isReviewedFields(value.reviewedFields) &&
    isNonNegativeSafeInteger(value.approvedAtMs)
  );
}

function isStCardImportConfirmResult(value: unknown): value is StCardImportConfirmResultV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, IMPORT_CONFIRM_KEYS) &&
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    isLengthBoundedString(value.name, 1, 128)
  );
}

function isStCardImportHistory(value: unknown): value is StCardImportHistoryV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, IMPORT_HISTORY_KEYS) &&
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    Array.isArray(value.entries) &&
    value.entries.length <= 100 &&
    value.entries.every(isStCardImportHistoryEntry)
  );
}

function isStCardImportHistoryEntry(value: unknown): value is StCardImportHistoryEntryV1 {
  if (!isRecord(value)) return false;
  const counts = value.counts;
  return (
    hasExactKeys(value, IMPORT_HISTORY_ENTRY_KEYS) &&
    isOpaqueHandle(value.importId) &&
    isNonNegativeSafeInteger(value.occurredAtMs) &&
    isLengthBoundedString(value.cardName, 1, 128) &&
    isRecord(counts) &&
    hasExactKeys(counts, IMPORT_HISTORY_COUNTS_KEYS) &&
    IMPORT_HISTORY_COUNTS_KEYS.every((key) => isNonNegativeSafeInteger(counts[key]))
  );
}

function isPersona(value: unknown): value is PersonaV1 {
  if (!isRecord(value) || !hasExactKeys(value, PERSONA_KEYS)) return false;
  return (
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    typeof value.present === "boolean" &&
    (value.present ? isNonNegativeSafeInteger(value.revision) : value.revision === null) &&
    (value.name === null || isLengthBoundedString(value.name, 1, 128)) &&
    (value.description === null || isLengthBoundedString(value.description, 1, 4096))
  );
}

function isScenario(value: unknown): value is ScenarioV1 {
  if (!isRecord(value) || !hasExactKeys(value, SCENARIO_KEYS)) return false;
  return (
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    typeof value.present === "boolean" &&
    (value.present ? isNonNegativeSafeInteger(value.revision) : value.revision === null) &&
    (value.name === null || isLengthBoundedString(value.name, 1, 128)) &&
    (value.description === null || isLengthBoundedString(value.description, 1, 8192)) &&
    (value.preview === null || isLengthBoundedString(value.preview, 1, 512))
  );
}

function isGreeting(value: unknown): value is GreetingV1 {
  if (!isRecord(value) || !hasExactKeys(value, GREETING_KEYS)) return false;
  return (
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    typeof value.present === "boolean" &&
    (value.present ? isNonNegativeSafeInteger(value.revision) : value.revision === null) &&
    (value.label === null || isLengthBoundedString(value.label, 1, 128)) &&
    Array.isArray(value.variants) &&
    value.variants.every(
      (variant) =>
        isRecord(variant) &&
        hasExactKeys(variant, GREETING_VARIANT_KEYS) &&
        (variant.label === null || isLengthBoundedString(variant.label, 1, 128)) &&
        isLengthBoundedString(variant.text, 1, 8192),
    )
  );
}

function isChatRetentionResult(value: unknown): value is ChatRetentionResultV1 {
  if (!isRecord(value) || !hasExactKeys(value, RETENTION_RESULT_KEYS)) return false;
  return (
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    isOpaqueHandle(value.handle) &&
    isOneOf(value.status, ["active", "archived", "trashed"]) &&
    isNonNegativeSafeInteger(value.managementRevision)
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
  if (!Array.isArray(value.transcript) || !value.transcript.every(isBrowserMessage)) return false;
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
  if (!isRecord(value)) return false;
  if (!hasExactKeys(value, SNAPSHOT_KEYS) && !hasExactKeys(value, SNAPSHOT_KEYS_WITH_VOICE)) return false;
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

function isVoicePreference(value: unknown): value is TavernVoicePreferenceV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, VOICE_PREFERENCE_KEYS) &&
    isNonNegativeSafeInteger(value.revision) &&
    (value.disclosureVersion === null || isOneOf(value.disclosureVersion, VOICE_DISCLOSURE_VERSIONS)) &&
    isOneOf(value.consent, VOICE_CONSENTS) &&
    (value.decidedAtMs === null || isNonNegativeSafeInteger(value.decidedAtMs)) &&
    (value.outputDevice === null || (typeof value.outputDevice === "string" && /^waveout:[0-9]{1,4}$/.test(value.outputDevice))) &&
    (value.consent === "undecided"
      ? value.disclosureVersion === null && value.decidedAtMs === null
      : value.decidedAtMs !== null && (value.consent !== "accepted" || value.disclosureVersion === "mimo-cloud-tts-v1"))
  );
}

function isVoiceDevice(value: unknown): value is Readonly<{ id: string; name: string }> {
  return (
    isRecord(value) &&
    hasExactKeys(value, VOICE_DEVICE_KEYS) &&
    typeof value.id === "string" &&
    /^waveout:[0-9]{1,4}$/.test(value.id) &&
    typeof value.name === "string" &&
    value.name.length >= 1 &&
    value.name.length <= 128
  );
}

function isVoiceDevices(value: unknown): value is TavernVoiceDevicesV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, VOICE_DEVICES_KEYS) &&
    Array.isArray(value.devices) &&
    value.devices.length <= 32 &&
    value.devices.every(isVoiceDevice) &&
    value.defaultSelectable === true
  );
}

export function validateVoiceDevices(value: unknown): TavernVoiceDevicesV1 {
  if (!isVoiceDevices(value)) throw new TavernProtocolError();
  return value;
}

function isVoicePreferenceConsentCommand(value: unknown): value is TavernVoicePreferenceConsentCommandV1 {
  if (!isRecord(value) || !isNonNegativeSafeInteger(value.expectedRevision)) return false;
  if (value.action === "accept")
    return hasExactKeys(value, VOICE_PREFERENCE_ACCEPT_KEYS) && value.disclosureVersion === "mimo-cloud-tts-v1";
  if (value.action === "setOutputDevice")
    return (
      hasExactKeys(value, VOICE_PREFERENCE_DEVICE_KEYS) &&
      (value.outputDevice === null || (typeof value.outputDevice === "string" && /^waveout:[0-9]{1,4}$/.test(value.outputDevice)))
    );
  return value.action === "revoke" && hasExactKeys(value, VOICE_PREFERENCE_REVOKE_KEYS);
}

export function validateLanguagePreference(value: unknown): TavernLanguagePreferenceV1 {
  if (!isLanguagePreference(value)) throw new TavernProtocolError();
  return value;
}

function isLanguagePreference(value: unknown): value is TavernLanguagePreferenceV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, LANGUAGE_PREFERENCE_KEYS) &&
    isNonNegativeSafeInteger(value.revision) &&
    (value.locale === null || isLanguageLocale(value.locale))
  );
}

function isLanguagePreferenceCommand(value: unknown): value is TavernLanguagePreferenceCommandV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, LANGUAGE_PREFERENCE_COMMAND_KEYS) &&
    isNonNegativeSafeInteger(value.expectedRevision) &&
    isLanguageLocale(value.locale)
  );
}

function isLanguageLocale(value: unknown): value is "zh-CN" | "en-US" {
  return value === "zh-CN" || value === "en-US";
}

export function validateVoicePreference(value: unknown): TavernVoicePreferenceV1 {
  if (!isVoicePreference(value)) throw new TavernProtocolError();
  return value;
}

export function validateVoicePreferenceConsentCommand(value: unknown): TavernVoicePreferenceConsentCommandV1 {
  if (!isVoicePreferenceConsentCommand(value)) throw new TavernProtocolError();
  return value;
}

function isConnectionFailure(value: unknown): value is TavernConnectionFailureV1 | null {
  return value === null || isOneOf(value, CONNECTION_FAILURES);
}

function isConnectionModel(value: unknown): value is TavernConnectionModelV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, CONNECTION_MODEL_KEYS) &&
    isLengthBoundedString(value.modelId, 1, 128) &&
    isLengthBoundedString(value.modelLabel, 1, 128) &&
    Array.isArray(value.allowedThinkingLevels) &&
    value.allowedThinkingLevels.length > 0 &&
    value.allowedThinkingLevels.length <= 5 &&
    value.allowedThinkingLevels.every((level) => isOneOf(level, CONNECTION_THINKING_LEVELS)) &&
    isOneOf(value.defaultThinkingLevel, CONNECTION_THINKING_LEVELS) &&
    value.allowedThinkingLevels.includes(value.defaultThinkingLevel as string)
  );
}

function isConnectionProvider(value: unknown): value is TavernConnectionProviderV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, CONNECTION_PROVIDER_KEYS) &&
    isLengthBoundedString(value.providerId, 1, 64) &&
    isLengthBoundedString(value.label, 1, 128) &&
    Array.isArray(value.setupFields) &&
    value.setupFields.length <= 3 &&
    value.setupFields.every((field) => isOneOf(field, CONNECTION_SETUP_FIELDS)) &&
    new Set(value.setupFields).size === value.setupFields.length &&
    Array.isArray(value.allowedPlayerModels) &&
    value.allowedPlayerModels.length <= 32 &&
    value.allowedPlayerModels.every(isConnectionModel) &&
    typeof value.escapeHatch === "boolean" &&
    typeof value.environmentManaged === "boolean"
  );
}

function isConnectionRow(value: unknown): value is TavernConnectionV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, CONNECTION_ROW_KEYS) &&
    isOpaqueHandle(value.connectionId) &&
    isLengthBoundedString(value.label, 1, 256) &&
    isLengthBoundedString(value.providerId, 1, 64) &&
    isLengthBoundedString(value.providerLabel, 1, 128) &&
    typeof value.configured === "boolean" &&
    isOneOf(value.readiness, CONNECTION_READINESS) &&
    typeof value.active === "boolean" &&
    isLengthBoundedString(value.modelId, 1, 128) &&
    isLengthBoundedString(value.modelLabel, 1, 128) &&
    isOneOf(value.thinkingLevel, CONNECTION_THINKING_LEVELS) &&
    // The player's own endpoint — the one endpoint fact they read back.
    (value.baseUrl === null || isLengthBoundedString(value.baseUrl, 1, 512)) &&
    isConnectionFailure(value.failure) &&
    (value.lastCheckedAtMs === null || isNonNegativeSafeInteger(value.lastCheckedAtMs)) &&
    (value.readiness !== "ready" || value.failure === null) &&
    (value.readiness !== "failed" || value.failure !== null)
  );
}

function isConnectionActive(value: unknown): value is TavernConnectionActiveV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, CONNECTION_ACTIVE_KEYS) &&
    isOpaqueHandle(value.connectionId) &&
    isLengthBoundedString(value.label, 1, 256) &&
    isLengthBoundedString(value.providerLabel, 1, 128) &&
    isLengthBoundedString(value.modelId, 1, 128) &&
    isLengthBoundedString(value.modelLabel, 1, 128) &&
    isOneOf(value.thinkingLevel, CONNECTION_THINKING_LEVELS) &&
    isOneOf(value.readiness, CONNECTION_READINESS) &&
    (value.baseUrl === null || isLengthBoundedString(value.baseUrl, 1, 512)) &&
    isConnectionFailure(value.failure) &&
    (value.lastCheckedAtMs === null || isNonNegativeSafeInteger(value.lastCheckedAtMs)) &&
    (value.readiness !== "ready" || value.failure === null) &&
    (value.readiness !== "failed" || value.failure !== null)
  );
}

function isConnectionState(value: unknown): value is TavernConnectionStateV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, CONNECTION_STATE_KEYS) ||
    value.apiVersion !== TAVERN_BROWSER_API_VERSION ||
    !isNonNegativeSafeInteger(value.revision) ||
    (value.active !== null && !isConnectionActive(value.active)) ||
    !Array.isArray(value.connections) ||
    value.connections.length > 16 ||
    !value.connections.every(isConnectionRow) ||
    !Array.isArray(value.providers) ||
    value.providers.length > 16 ||
    !value.providers.every(isConnectionProvider)
  )
    return false;
  // The projection must be internally consistent: exactly one row may carry the
  // active flag, and it must be the row the active selection names.
  const activeRows = value.connections.filter((row) => row.active);
  if (value.active === null) return activeRows.length === 0;
  return activeRows.length === 1 && activeRows[0]!.connectionId === (value.active as TavernConnectionActiveV1).connectionId;
}

export function validateConnectionState(value: unknown): TavernConnectionStateV1 {
  if (!isConnectionState(value)) throw new TavernProtocolError();
  return value;
}

export function validateConnectionProbe(value: unknown): TavernConnectionProbeV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, CONNECTION_PROBE_KEYS) ||
    value.apiVersion !== TAVERN_BROWSER_API_VERSION ||
    !isOpaqueHandle(value.connectionId) ||
    (value.outcome !== "ready" && value.outcome !== "failed") ||
    !isConnectionFailure(value.failure) ||
    (value.outcome === "ready" ? value.failure !== null : value.failure === null) ||
    !isConnectionState(value.state)
  )
    throw new TavernProtocolError();
  return value as TavernConnectionProbeV1;
}

function isMemoryMutationCommand(value: unknown): value is MemoryMutationCommandV1 {
  if (
    !isRecord(value) ||
    value.apiVersion !== TAVERN_BROWSER_API_VERSION ||
    !isOpaqueHandle(value.expectedProjectionRevision)
  )
    return false;
  if (value.operation === "create")
    return hasExactKeys(value, MEMORY_MUTATION_CREATE_KEYS) && isBoundedText(value.content, MAX_MEMORY_TEXT_UTF8_BYTES);
  if (value.operation === "update")
    return (
      hasExactKeys(value, MEMORY_MUTATION_UPDATE_KEYS) &&
      isOpaqueHandle(value.handle) &&
      isBoundedText(value.content, MAX_MEMORY_TEXT_UTF8_BYTES)
    );
  return (
    value.operation === "archive" && hasExactKeys(value, MEMORY_MUTATION_ARCHIVE_KEYS) && isOpaqueHandle(value.handle)
  );
}

// --- Public strict closed validators. ---

export function validateSnapshot(value: unknown): TavernStateSnapshotV1 {
  if (!isSnapshot(value)) throw new TavernProtocolError();
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

export function validateCompanionList(value: unknown): CompanionListV1 {
  if (!isCompanionList(value)) throw new TavernProtocolError();
  return value;
}

export function validateCompanionDetail(value: unknown): CompanionDetailV1 {
  if (!isCompanionDetail(value)) throw new TavernProtocolError();
  return value;
}

export function validatePersona(value: unknown): PersonaV1 {
  if (!isPersona(value)) throw new TavernProtocolError();
  return value;
}

export function validateScenario(value: unknown): ScenarioV1 {
  if (!isScenario(value)) throw new TavernProtocolError();
  return value;
}

export function validateGreeting(value: unknown): GreetingV1 {
  if (!isGreeting(value)) throw new TavernProtocolError();
  return value;
}

export function validateChatRetentionResult(value: unknown): ChatRetentionResultV1 {
  if (!isChatRetentionResult(value)) throw new TavernProtocolError();
  return value;
}

export function validateStCardImportStageResult(value: unknown): StCardImportStageResultV1 {
  if (!isStCardImportStageResult(value)) throw new TavernProtocolError();
  return value;
}

export function validateStCardImportReadResult(value: unknown): StCardImportReadResultV1 {
  if (!isStCardImportReadResult(value)) throw new TavernProtocolError();
  return value;
}

export function validateStCardImportReviewResult(value: unknown): StCardImportReviewResultV1 {
  if (!isStCardImportReviewResult(value)) throw new TavernProtocolError();
  return value;
}

export function validateStCardImportConfirmResult(value: unknown): StCardImportConfirmResultV1 {
  if (!isStCardImportConfirmResult(value)) throw new TavernProtocolError();
  return value;
}

export function validateStCardImportHistory(value: unknown): StCardImportHistoryV1 {
  if (!isStCardImportHistory(value)) throw new TavernProtocolError();
  return value;
}

function validateChatList(value: unknown): ChatListV1 {
  if (!isChatList(value)) throw new TavernProtocolError();
  return value;
}

function validateChatTitle(value: unknown): ChatTitleV1 {
  if (!isChatTitle(value)) throw new TavernProtocolError();
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
  /** GET /api/tavern/v1/settings/language (browser session; no CSRF header). */
  readLanguagePreference(): Promise<TavernLanguagePreferenceV1>;
  /**
   * PUT /api/tavern/v1/settings/language with browser-session CSRF protection.
   * The Host owns this preference and every runtime reads it, so the companion
   * speaks the language the player chose here.
   */
  updateLanguagePreference(
    command: TavernLanguagePreferenceCommandV1,
    csrfToken: string,
  ): Promise<TavernLanguagePreferenceV1>;
  /** GET /api/tavern/v1/settings/voice-preference (browser session; no CSRF header). */
  readVoicePreference(): Promise<TavernVoicePreferenceV1>;
  /** GET /api/tavern/v1/settings/voice-devices (browser-session read). */
  readVoiceDevices(): Promise<TavernVoiceDevicesV1>;
  /** PUT /api/tavern/v1/settings/voice-preference with browser-session CSRF protection. */
  updateVoicePreference(
    command: TavernVoicePreferenceConsentCommandV1,
    csrfToken: string,
  ): Promise<TavernVoicePreferenceV1>;
  /** GET /api/tavern/v1/settings/connection (browser session; no CSRF header). */
  readConnection(): Promise<TavernConnectionStateV1>;
  /** POST /api/tavern/v1/settings/connections: creates a draft record whose credential is write-only. */
  createConnection(
    command: TavernConnectionCreateCommandV1,
    csrfToken: string,
  ): Promise<TavernConnectionStateV1>;
  /** POST /api/tavern/v1/settings/connections/:id/test against the Host-owned probe. */
  testConnection(connectionId: string, expectedRevision: number, csrfToken: string): Promise<TavernConnectionProbeV1>;
  /** POST /api/tavern/v1/settings/connections/:id/activate: selects only a ready record. */
  activateConnection(
    connectionId: string,
    expectedRevision: number,
    csrfToken: string,
  ): Promise<TavernConnectionStateV1>;
  /** POST /api/tavern/v1/settings/connections/:id/model with the record revision. */
  selectConnectionModel(
    connectionId: string,
    command: Readonly<{ expectedRevision: number; modelId: string; thinkingLevel: TavernConnectionThinkingLevelV1 }>,
    csrfToken: string,
  ): Promise<TavernConnectionStateV1>;
  /** DELETE /api/tavern/v1/settings/connections/:id: removes an inactive record and its credential. */
  removeConnection(
    connectionId: string,
    expectedRevision: number,
    csrfToken: string,
  ): Promise<TavernConnectionStateV1>;
  /** GET /api/tavern/v1/companions: metadata-only companion library. */
  listCompanions(): Promise<CompanionListV1>;
  /** GET /api/tavern/v1/companions/:handle: safe detail for one projected handle. */
  readCompanionDetail(handle: string): Promise<CompanionDetailV1>;
  /** POST /api/tavern/v1/companions: creates a Host-owned namespace from a display name. */
  createCompanion(name: string, csrfToken: string): Promise<CompanionDetailV1>;
  /** GET /api/tavern/v1/persona: the player's own persona projection. */
  readPersona(): Promise<PersonaV1>;
  /** PUT /api/tavern/v1/persona with durable revision CAS. */
  updatePersona(
    command: Readonly<{ expectedRevision: number; name: string; description?: string }>,
    csrfToken: string,
  ): Promise<PersonaV1>;
  /** GET /api/tavern/v1/scenario. */
  readScenario(): Promise<ScenarioV1>;
  /** PUT /api/tavern/v1/scenario with durable revision CAS. */
  updateScenario(
    command: Readonly<{ expectedRevision: number; name: string; description: string }>,
    csrfToken: string,
  ): Promise<ScenarioV1>;
  /** GET /api/tavern/v1/greeting. */
  readGreeting(): Promise<GreetingV1>;
  /** PUT /api/tavern/v1/greeting with durable revision CAS. */
  updateGreeting(
    command: Readonly<{
      expectedRevision: number;
      label?: string;
      variants: readonly Readonly<{ label?: string; text: string }>[];
    }>,
    csrfToken: string,
  ): Promise<GreetingV1>;
  /** POST /api/tavern/v1/chats/:handle/{archive|restore|trash} with durable lifecycle CAS. */
  transitionChatLifecycle(
    chatHandle: string,
    operation: "archive" | "restore" | "trash",
    selectionGeneration: number,
    expectedManagementRevision: number,
    csrfToken: string,
  ): Promise<ChatRetentionResultV1>;
  /** POST /api/tavern/v1/imports: stage a character card for review (design/28 Import row). */
  stageStCardImport(card: string, csrfToken: string): Promise<StCardImportStageResultV1>;
  /** GET /api/tavern/v1/imports/:importId: safe review data for one staged card. */
  readStCardImport(importId: string): Promise<StCardImportReadResultV1>;
  /** POST /api/tavern/v1/imports/:importId/review: record an explicit eligible-field review. */
  reviewStCardImport(
    importId: string,
    reviewedFields: readonly string[],
    approvedAtMs: number,
    csrfToken: string,
  ): Promise<StCardImportReviewResultV1>;
  /** POST /api/tavern/v1/imports/:importId/confirm: provision the reviewed companion. */
  confirmStCardImport(importId: string, csrfToken: string): Promise<StCardImportConfirmResultV1>;
  /** GET /api/tavern/v1/import-history: the durable loss report for confirmed imports. */
  readStCardImportHistory(): Promise<StCardImportHistoryV1>;
}>;

export type ManagementOperationObservation = Readonly<{
  operationId: string;
  outcome: "passed" | "not_applicable" | "blocked";
  projectionRevision?: string;
}>;

export function createManagementPipelineApi(
  fetchLike: typeof fetch = fetch,
  onOperation?: (observation: ManagementOperationObservation) => void,
): ManagementPipelineApi {
  if (typeof fetchLike !== "function") {
    throw new TypeError("createManagementPipelineApi requires a fetch-like function");
  }
  const observe = (
    operationId: string,
    outcome: ManagementOperationObservation["outcome"],
    projectionRevision?: string,
  ): void => {
    onOperation?.(
      Object.freeze({ operationId, outcome, ...(projectionRevision === undefined ? {} : { projectionRevision }) }),
    );
  };
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
      const result = await exchange(
        fetchLike,
        "PUT",
        "/api/tavern/v1/draft",
        200,
        validateDraft,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        command,
      );
      observe("draft.save", "passed", String(result.revision));
      return result;
    },
    async discardDraft(command: DiscardDraftCommandV1, csrfToken: string): Promise<BrowserDraftV1> {
      if (!isDiscardDraftCommand(command) || !isOpaqueHandle(csrfToken)) throw new TavernProtocolError();
      const result = await exchange(
        fetchLike,
        "DELETE",
        "/api/tavern/v1/draft",
        200,
        validateDraft,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        command,
      );
      observe("draft.discard", "passed", String(result.revision));
      return result;
    },
    async renameChatTitle(command: RenameChatTitleCommandV1, csrfToken: string): Promise<ChatTitleV1> {
      if (!isRenameChatTitleCommand(command)) throw new TavernProtocolError();
      if (!isOpaqueHandle(csrfToken)) throw new TavernProtocolError();
      const result = await exchange(
        fetchLike,
        "PUT",
        "/api/tavern/v1/chat/title",
        200,
        validateChatTitle,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        command,
      );
      observe("chat.rename", "passed", String(result.managementRevision));
      return result;
    },
    async readMemory(): Promise<MemoryReadV1> {
      return exchange(fetchLike, "GET", "/api/tavern/v1/memory", 200, validateMemoryRead);
    },
    async mutateMemory(command: MemoryMutationCommandV1, csrfToken: string): Promise<MemoryReadV1> {
      if (!isMemoryMutationCommand(command) || !isOpaqueHandle(csrfToken)) throw new TavernProtocolError();
      const result = await exchange(
        fetchLike,
        "PUT",
        "/api/tavern/v1/memory",
        200,
        validateMemoryRead,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        command,
      );
      observe("memory.mutate", "passed", result.projectionRevision);
      return result;
    },
    async readWorldInfo(): Promise<WorldInfoStateV1> {
      return exchange(fetchLike, "GET", "/api/tavern/v1/world-info", 200, validateWorldInfoState);
    },
    async setWorldInfoBinding(command: SetWorldInfoBindingCommandV1, csrfToken: string): Promise<WorldInfoStateV1> {
      if (!isSetWorldInfoBindingCommand(command) || !isOpaqueHandle(csrfToken)) throw new TavernProtocolError();
      const result = await exchange(
        fetchLike,
        "PUT",
        "/api/tavern/v1/world-info",
        200,
        validateWorldInfoState,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        command,
      );
      observe("world-info.bind", "passed", result.revision);
      return result;
    },
    async readVoicePreference(): Promise<TavernVoicePreferenceV1> {
      return exchange(fetchLike, "GET", "/api/tavern/v1/settings/voice-preference", 200, validateVoicePreference);
    },
    async readVoiceDevices(): Promise<TavernVoiceDevicesV1> {
      return exchange(fetchLike, "GET", "/api/tavern/v1/settings/voice-devices", 200, validateVoiceDevices);
    },
    async readLanguagePreference(): Promise<TavernLanguagePreferenceV1> {
      return exchange(fetchLike, "GET", "/api/tavern/v1/settings/language", 200, validateLanguagePreference);
    },
    async updateLanguagePreference(
      command: TavernLanguagePreferenceCommandV1,
      csrfToken: string,
    ): Promise<TavernLanguagePreferenceV1> {
      if (!isLanguagePreferenceCommand(command) || !isOpaqueHandle(csrfToken))
        throw new TavernProtocolError();
      const result = await exchange(
        fetchLike,
        "PUT",
        "/api/tavern/v1/settings/language",
        200,
        validateLanguagePreference,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        command,
      );
      observe("settings.language.update", "passed", String(result.revision));
      return result;
    },
    async updateVoicePreference(
      command: TavernVoicePreferenceConsentCommandV1,
      csrfToken: string,
    ): Promise<TavernVoicePreferenceV1> {
      if (!isVoicePreferenceConsentCommand(command) || !isOpaqueHandle(csrfToken)) throw new TavernProtocolError();
      const result = await exchange(
        fetchLike,
        "PUT",
        "/api/tavern/v1/settings/voice-preference",
        200,
        validateVoicePreference,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        command,
      );
      observe("settings.voice.consent", "passed", String(result.revision));
      return result;
    },
    async readConnection(): Promise<TavernConnectionStateV1> {
      return exchange(fetchLike, "GET", "/api/tavern/v1/settings/connection", 200, validateConnectionState);
    },
    async createConnection(
      command: TavernConnectionCreateCommandV1,
      csrfToken: string,
    ): Promise<TavernConnectionStateV1> {
      if (!isOpaqueHandle(csrfToken)) throw new TavernProtocolError();
      // The browser sends only the fields the selected catalog entry declares.
      // The credential is a write-only request field and is never retained here.
      const body: Record<string, unknown> = { apiVersion: TAVERN_BROWSER_API_VERSION, providerId: command.providerId };
      if (command.apiKey !== undefined) body.apiKey = command.apiKey;
      if (command.baseUrl !== undefined) body.baseUrl = command.baseUrl;
      if (command.modelId !== undefined) body.modelId = command.modelId;
      return exchange(
        fetchLike,
        "POST",
        "/api/tavern/v1/settings/connections",
        200,
        validateConnectionState,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body,
      );
    },
    async testConnection(
      connectionId: string,
      expectedRevision: number,
      csrfToken: string,
    ): Promise<TavernConnectionProbeV1> {
      if (!isOpaqueHandle(connectionId) || !isOpaqueHandle(csrfToken) || !isNonNegativeSafeInteger(expectedRevision))
        throw new TavernProtocolError();
      return exchange(
        fetchLike,
        "POST",
        `/api/tavern/v1/settings/connections/${connectionId}/test`,
        200,
        validateConnectionProbe,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        { apiVersion: TAVERN_BROWSER_API_VERSION, expectedRevision },
      );
    },
    async activateConnection(
      connectionId: string,
      expectedRevision: number,
      csrfToken: string,
    ): Promise<TavernConnectionStateV1> {
      if (!isOpaqueHandle(connectionId) || !isOpaqueHandle(csrfToken) || !isNonNegativeSafeInteger(expectedRevision))
        throw new TavernProtocolError();
      return exchange(
        fetchLike,
        "POST",
        `/api/tavern/v1/settings/connections/${connectionId}/activate`,
        200,
        validateConnectionState,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        { apiVersion: TAVERN_BROWSER_API_VERSION, expectedRevision },
      );
    },
    async selectConnectionModel(
      connectionId: string,
      command: Readonly<{ expectedRevision: number; modelId: string; thinkingLevel: TavernConnectionThinkingLevelV1 }>,
      csrfToken: string,
    ): Promise<TavernConnectionStateV1> {
      if (
        !isOpaqueHandle(connectionId) ||
        !isOpaqueHandle(csrfToken) ||
        !isNonNegativeSafeInteger(command.expectedRevision) ||
        !isLengthBoundedString(command.modelId, 1, 128) ||
        !isOneOf(command.thinkingLevel, CONNECTION_THINKING_LEVELS)
      )
        throw new TavernProtocolError();
      return exchange(
        fetchLike,
        "POST",
        `/api/tavern/v1/settings/connections/${connectionId}/model`,
        200,
        validateConnectionState,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        {
          apiVersion: TAVERN_BROWSER_API_VERSION,
          expectedRevision: command.expectedRevision,
          modelId: command.modelId,
          thinkingLevel: command.thinkingLevel,
        },
      );
    },
    async removeConnection(
      connectionId: string,
      expectedRevision: number,
      csrfToken: string,
    ): Promise<TavernConnectionStateV1> {
      if (!isOpaqueHandle(connectionId) || !isOpaqueHandle(csrfToken) || !isNonNegativeSafeInteger(expectedRevision))
        throw new TavernProtocolError();
      return exchange(
        fetchLike,
        "DELETE",
        `/api/tavern/v1/settings/connections/${connectionId}`,
        200,
        validateConnectionState,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        { apiVersion: TAVERN_BROWSER_API_VERSION, expectedRevision },
      );
    },
    async listCompanions(): Promise<CompanionListV1> {
      return exchange(fetchLike, "GET", "/api/tavern/v1/companions", 200, validateCompanionList);
    },
    async readCompanionDetail(handle: string): Promise<CompanionDetailV1> {
      if (!isOpaqueHandle(handle)) throw new TavernProtocolError();
      return exchange(fetchLike, "GET", `/api/tavern/v1/companions/${handle}`, 200, validateCompanionDetail);
    },
    async createCompanion(name: string, csrfToken: string): Promise<CompanionDetailV1> {
      if (!isLengthBoundedString(name, 1, 128) || !isOpaqueHandle(csrfToken)) throw new TavernProtocolError();
      const result = await exchange(
        fetchLike,
        "POST",
        "/api/tavern/v1/companions",
        200,
        validateCompanionDetail,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        { apiVersion: TAVERN_BROWSER_API_VERSION, name },
      );
      observe("companion.create", "passed", String(result.name));
      return result;
    },
    async readPersona(): Promise<PersonaV1> {
      return exchange(fetchLike, "GET", "/api/tavern/v1/persona", 200, validatePersona);
    },
    async updatePersona(
      command: Readonly<{ expectedRevision: number; name: string; description?: string }>,
      csrfToken: string,
    ): Promise<PersonaV1> {
      if (!isNonNegativeSafeInteger(command.expectedRevision) || !isOpaqueHandle(csrfToken))
        throw new TavernProtocolError();
      const result = await exchange(
        fetchLike,
        "PUT",
        "/api/tavern/v1/persona",
        200,
        validatePersona,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        {
          apiVersion: TAVERN_BROWSER_API_VERSION,
          expectedRevision: command.expectedRevision,
          name: command.name,
          ...(command.description === undefined ? {} : { description: command.description }),
        },
      );
      observe("persona.update", "passed", String(result.revision));
      return result;
    },
    async readScenario(): Promise<ScenarioV1> {
      return exchange(fetchLike, "GET", "/api/tavern/v1/scenario", 200, validateScenario);
    },
    async updateScenario(
      command: Readonly<{ expectedRevision: number; name: string; description: string }>,
      csrfToken: string,
    ): Promise<ScenarioV1> {
      if (!isNonNegativeSafeInteger(command.expectedRevision) || !isOpaqueHandle(csrfToken))
        throw new TavernProtocolError();
      const result = await exchange(
        fetchLike,
        "PUT",
        "/api/tavern/v1/scenario",
        200,
        validateScenario,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        {
          apiVersion: TAVERN_BROWSER_API_VERSION,
          expectedRevision: command.expectedRevision,
          name: command.name,
          description: command.description,
        },
      );
      observe("scenario.update", "passed", String(result.revision));
      return result;
    },
    async readGreeting(): Promise<GreetingV1> {
      return exchange(fetchLike, "GET", "/api/tavern/v1/greeting", 200, validateGreeting);
    },
    async updateGreeting(
      command: Readonly<{
        expectedRevision: number;
        label?: string;
        variants: readonly Readonly<{ label?: string; text: string }>[];
      }>,
      csrfToken: string,
    ): Promise<GreetingV1> {
      if (!isNonNegativeSafeInteger(command.expectedRevision) || !isOpaqueHandle(csrfToken))
        throw new TavernProtocolError();
      const result = await exchange(
        fetchLike,
        "PUT",
        "/api/tavern/v1/greeting",
        200,
        validateGreeting,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        {
          apiVersion: TAVERN_BROWSER_API_VERSION,
          expectedRevision: command.expectedRevision,
          ...(command.label === undefined ? {} : { label: command.label }),
          variants: command.variants.map((variant) => ({
            ...(variant.label === undefined ? {} : { label: variant.label }),
            text: variant.text,
          })),
        },
      );
      observe("greeting.update", "passed", String(result.revision));
      return result;
    },
    async transitionChatLifecycle(
      chatHandle: string,
      operation: "archive" | "restore" | "trash",
      selectionGeneration: number,
      expectedManagementRevision: number,
      csrfToken: string,
    ): Promise<ChatRetentionResultV1> {
      if (
        !isOpaqueHandle(chatHandle) ||
        !isOpaqueHandle(csrfToken) ||
        !isNonNegativeSafeInteger(selectionGeneration) ||
        !isNonNegativeSafeInteger(expectedManagementRevision) ||
        !isOneOf(operation, RETENTION_OPERATIONS)
      )
        throw new TavernProtocolError();
      const result = await exchange(
        fetchLike,
        "POST",
        `/api/tavern/v1/chats/${chatHandle}/${operation}`,
        200,
        validateChatRetentionResult,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        {
          apiVersion: TAVERN_BROWSER_API_VERSION,
          selectionGeneration,
          expectedManagementRevision,
        },
      );
      observe(operation === "archive" ? "chat.archive" : operation === "restore" ? "chat.restore" : "chat.trash", "passed", String(result.managementRevision));
      return result;
    },
    async stageStCardImport(card: string, csrfToken: string): Promise<StCardImportStageResultV1> {
      if (!isLengthBoundedString(card, 1, 2_097_152) || !isOpaqueHandle(csrfToken)) throw new TavernProtocolError();
      const result = await exchange(
        fetchLike,
        "POST",
        "/api/tavern/v1/imports",
        200,
        validateStCardImportStageResult,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        { apiVersion: TAVERN_BROWSER_API_VERSION, card },
      );
      observe("character.import.stage", "passed", result.importId);
      return result;
    },
    async readStCardImport(importId: string): Promise<StCardImportReadResultV1> {
      if (!isOpaqueHandle(importId)) throw new TavernProtocolError();
      return exchange(fetchLike, "GET", `/api/tavern/v1/imports/${importId}`, 200, validateStCardImportReadResult);
    },
    async reviewStCardImport(
      importId: string,
      reviewedFields: readonly string[],
      approvedAtMs: number,
      csrfToken: string,
    ): Promise<StCardImportReviewResultV1> {
      if (!isOpaqueHandle(importId) || !isOpaqueHandle(csrfToken) || !isNonNegativeSafeInteger(approvedAtMs) || !isReviewedFields(reviewedFields))
        throw new TavernProtocolError();
      const result = await exchange(
        fetchLike,
        "POST",
        `/api/tavern/v1/imports/${importId}/review`,
        200,
        validateStCardImportReviewResult,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        { apiVersion: TAVERN_BROWSER_API_VERSION, reviewedFields: [...reviewedFields], approvedAtMs },
      );
      observe("character.import.review", "passed", result.importId);
      return result;
    },
    async confirmStCardImport(importId: string, csrfToken: string): Promise<StCardImportConfirmResultV1> {
      if (!isOpaqueHandle(importId) || !isOpaqueHandle(csrfToken)) throw new TavernProtocolError();
      const result = await exchange(
        fetchLike,
        "POST",
        `/api/tavern/v1/imports/${importId}/confirm`,
        200,
        validateStCardImportConfirmResult,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        { apiVersion: TAVERN_BROWSER_API_VERSION },
      );
      observe("character.import.confirm", "passed", result.name);
      return result;
    },
    async readStCardImportHistory(): Promise<StCardImportHistoryV1> {
      return exchange(
        fetchLike,
        "GET",
        "/api/tavern/v1/import-history",
        200,
        validateStCardImportHistory,
      );
    },
  });
}
