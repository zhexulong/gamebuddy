/**
 * Pure, identity-bound browser session reducer for the
 * `tavern_browser_api/v1` tavern-management snapshot/list/title DTO shapes.
 *
 * This module is deliberately self-contained: it imports nothing (no Host
 * package, no network client, no storage, no timers) and only reduces plain
 * values into immutable session state. Full DTO wire validation belongs to
 * the browser API client (`management-pipeline-api.ts`); this reducer performs
 * only the identity/state checks it must enforce to keep the mounted session
 * safe, atomic and content-free:
 *
 * - bootstrap records a stable identity fingerprint derived ONLY from
 *   `build.profileId` (+ contract) and `selection.{chatHandle,generation,stateRevision}`;
 * - `applySnapshot` atomically replaces the snapshot only while the exact
 *   mounted identity is unchanged; any mismatch throws
 *   `state_reconciliation_required`;
 * - `withChatList` replaces the metadata-only Chat list after exact identity
 *   validation of every entry handle;
 * - `applyRenamedTitle` folds one exact rename read-back into the list entry
 *   (and the mounted snapshot title when the renamed handle is the mounted
 *   one). It never guesses a revision or synthesizes a title.
 *
 * No local list generation, fake select/switch, new Chat, timer, storage or
 * HTTP exists here.
 */

const TAVERN_BROWSER_API_VERSION = 1 as const;
const TAVERN_BROWSER_CONTRACT = "tavern_browser_api/v1" as const;

/** Frozen structural mirror of the `tavern_browser_api/v1` management operation DTO. */
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
    | "settings.profiles.read"
    | "settings.profiles.update"
    | "companion.list"
    | "companion.detail"
    | "companion.create"
    | "character.import.stage"
    | "character.import.read"
    | "character.import.review"
    | "character.import.confirm"
    | "character.import.history"
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
    | "tavern.operation.settings.profiles.read"
    | "tavern.operation.settings.profiles.update"
    | "tavern.operation.companion.list"
    | "tavern.operation.companion.detail"
    | "tavern.operation.companion.create"
    | "tavern.operation.character.import.stage"
    | "tavern.operation.character.import.read"
    | "tavern.operation.character.import.review"
    | "tavern.operation.character.import.confirm"
    | "tavern.operation.character.import.history"
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

/** Frozen structural mirror of the `tavern_browser_api/v1` dual-attributed turn DTO. */
type BrowserTurnV1 = Readonly<{
  handle: string;
  state: "queued" | "running" | "response_visible" | "stopping" | "completed" | "cancelled" | "failed";
  projectionRevision: number;
  canCancel: boolean;
  problemCode?: "interrupted" | "no_visible_presentation" | "runtime_unavailable" | "storage_unavailable";
}>;

/** Frozen structural mirror of the `tavern_browser_api/v1` Memory capability projection. */
type MemoryStateV1 = Readonly<{
  readAvailable: boolean;
  mutationAvailable: boolean;
  projectionRevision: string | null;
}>;

type WorldInfoItemV1 = Readonly<{
  handle: string;
  title: string;
  summary: string | null;
  selected: boolean;
  pending: boolean;
}>;

type WorldInfoStateV1 = Readonly<{
  state: "none" | "selected" | "pending" | "unavailable";
  revision: string;
  items: readonly WorldInfoItemV1[];
}>;

type BrowserMessageV1 = Readonly<{
  handle: string;
  role: "player" | "companion";
  text: string;
  locale: "en" | "zh-CN" | "und";
  order: number;
  revision: number;
}>;

export type TavernStateSnapshotV1 = Readonly<{
  apiVersion: 1;
  build: Readonly<{ browserContract: "tavern_browser_api/v1"; profileId: string }>;
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
  memory: MemoryStateV1;
  eventStream: null;
}>;

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

type BrowserDraftV1 = Readonly<{
  apiVersion: 1;
  revision: number;
  text: string | null;
}>;

type ChatTitleV1 = Readonly<{
  apiVersion: 1;
  title: string | null;
  managementRevision: number;
}>;

export type ManagementPipelineSession = Readonly<{
  snapshot: TavernStateSnapshotV1;
  chatList: ChatListV1 | null;
  applySnapshot(snapshot: TavernStateSnapshotV1): ManagementPipelineSession;
  withChatList(list: ChatListV1): ManagementPipelineSession;
  applyRenamedTitle(handle: string, result: ChatTitleV1): ManagementPipelineSession;
  applyDraft(result: BrowserDraftV1): ManagementPipelineSession;
}>;

export class ManagementPipelineSessionError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = "ManagementPipelineSessionError";
    this.code = code;
  }
}

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

function isActiveIdentity(value: unknown): value is TavernStateSnapshotV1 & {
  selection: Readonly<{ chatHandle: string; generation: number; stateRevision: string }>;
} {
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

function identityFingerprint(snapshot: unknown): string {
  if (!isActiveIdentity(snapshot)) throw new ManagementPipelineSessionError("state_reconciliation_required");
  return [
    snapshot.build.browserContract,
    snapshot.build.profileId,
    snapshot.selection.chatHandle,
    String(snapshot.selection.generation),
    snapshot.selection.stateRevision,
  ].join("|");
}

function isChatListEntry(value: unknown): value is ChatListEntryV1 {
  return (
    isRecord(value) &&
    isNonEmptyString(value.handle) &&
    (value.title === null || typeof value.title === "string") &&
    value.status === "active" &&
    isNonnegativeSafeInteger(value.managementRevision) &&
    typeof value.isSelected === "boolean"
  );
}

function requireChatList(value: unknown): ChatListV1 {
  if (
    !isRecord(value) ||
    value.apiVersion !== TAVERN_BROWSER_API_VERSION ||
    !Array.isArray(value.chats) ||
    !value.chats.every(isChatListEntry)
  )
    throw new ManagementPipelineSessionError("state_reconciliation_required");
  return value as unknown as ChatListV1;
}

interface SessionState {
  fingerprint: string;
  snapshot: TavernStateSnapshotV1;
  chatList: ChatListV1 | null;
}

function createSession(state: SessionState): ManagementPipelineSession {
  const session: ManagementPipelineSession = Object.freeze({
    snapshot: state.snapshot,
    chatList: state.chatList,
    applySnapshot(next: TavernStateSnapshotV1): ManagementPipelineSession {
      const frozenNext = deepFreeze(next);
      if (identityFingerprint(frozenNext) !== state.fingerprint) {
        throw new ManagementPipelineSessionError("state_reconciliation_required");
      }
      return createSession({ fingerprint: state.fingerprint, snapshot: frozenNext, chatList: state.chatList });
    },
    withChatList(list: ChatListV1): ManagementPipelineSession {
      const frozenList = deepFreeze(requireChatList(list));
      return createSession({ fingerprint: state.fingerprint, snapshot: state.snapshot, chatList: frozenList });
    },
    applyDraft(result: BrowserDraftV1): ManagementPipelineSession {
      const frozenResult = deepFreeze(result);
      if (frozenResult.apiVersion !== TAVERN_BROWSER_API_VERSION || !isNonnegativeSafeInteger(frozenResult.revision)) {
        throw new ManagementPipelineSessionError("state_reconciliation_required");
      }
      const snapshot = state.snapshot;
      if (
        snapshot.chat === null ||
        !isNonnegativeSafeInteger(snapshot.chat.draft.revision) ||
        frozenResult.revision <= snapshot.chat.draft.revision
      ) {
        throw new ManagementPipelineSessionError("state_reconciliation_required");
      }
      return createSession({
        fingerprint: state.fingerprint,
        chatList: state.chatList,
        snapshot: Object.freeze({
          ...snapshot,
          chat: Object.freeze({
            ...snapshot.chat,
            draft: Object.freeze({ revision: frozenResult.revision, present: frozenResult.text !== null }),
          }),
        }),
      });
    },
    applyRenamedTitle(handle: string, result: ChatTitleV1): ManagementPipelineSession {
      if (!isNonEmptyString(handle)) throw new ManagementPipelineSessionError("invalid_request");
      const frozenResult = deepFreeze(result);
      if (frozenResult.apiVersion !== TAVERN_BROWSER_API_VERSION) {
        throw new ManagementPipelineSessionError("state_reconciliation_required");
      }
      if (state.chatList === null) {
        throw new ManagementPipelineSessionError("state_reconciliation_required");
      }
      let matched = false;
      const chats = state.chatList.chats.map((entry) => {
        if (entry.handle !== handle) return entry;
        matched = true;
        return Object.freeze({
          handle: entry.handle,
          title: frozenResult.title,
          status: entry.status,
          managementRevision: frozenResult.managementRevision,
          isSelected: entry.isSelected,
        });
      });
      if (!matched) throw new ManagementPipelineSessionError("state_reconciliation_required");
      const chatList: ChatListV1 = Object.freeze({ apiVersion: 1, chats: Object.freeze(chats) });
      const snapshot =
        isActiveIdentity(state.snapshot) && state.snapshot.selection.chatHandle === handle
          ? Object.freeze({
              ...state.snapshot,
              chat:
                state.snapshot.chat === null
                  ? null
                  : Object.freeze({ ...state.snapshot.chat, title: frozenResult.title }),
            })
          : state.snapshot;
      return createSession({ fingerprint: state.fingerprint, snapshot, chatList });
    },
  });
  return session;
}

/**
 * Bootstrap a session from the first validated snapshot. Records the stable
 * identity fingerprint once; rejects an absent or malformed active identity
 * with `state_reconciliation_required`.
 */
export function createManagementPipelineSession(snapshot: TavernStateSnapshotV1): ManagementPipelineSession {
  return createSession({
    fingerprint: identityFingerprint(snapshot),
    snapshot: deepFreeze(snapshot),
    chatList: null,
  });
}
