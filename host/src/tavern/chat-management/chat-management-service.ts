import {
  isCurrentMountedChatRuntimeLease,
  type MountedChatRuntimeLease,
} from "../../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type { HostDeploymentManifest } from "../../deployment-manifest.js";
import { identityKey } from "../../runtime.js";
import {
  type BrowserDraftV1,
  type ChatListEntryV1,
  type ChatListQueryV1,
  type ChatListV1,
  type ChatTitleV1,
  type ComposedTavernProfile,
  type DiscardDraftCommandV1,
  type RenameChatTitleCommandV1,
  type SaveDraftCommandV1,
  TAVERN_BROWSER_API_VERSION,
  TavernBrowserValidatorsV1,
} from "../browser-contract/index.js";
import { type ChatThread, createChatThreadStore } from "../chat-thread-store.js";
import { createChatTitleManagementService } from "./chat-title-management.js";

/**
 * Host-owned management boundary for the mounted tavern_management profile
 * (design/78 P9 Chat list + title rename micro-pipeline). It exposes only
 * browser-safe opaque facts; no store, root, lease, raw durable identifier or
 * coordinator authority escapes. `listChats` reads durable metadata only and
 * `renameChatTitle` mutates through the existing `ChatThreadStore`
 * management-revision CAS (`renameThreadTitle`) with durable read-back.
 */
export type ChatManagementService = Readonly<{
  /** Metadata-only list of the exact companion/continuity's active Chats. */
  listChats(query: ChatListQueryV1): Promise<ChatListV1>;
  /** Exact mounted-Chat title rename with selection generation, handle and management-revision CAS. */
  renameChatTitle(command: RenameChatTitleCommandV1): Promise<ChatTitleV1>;
  /** Reads the exact mounted Chat draft after validating the selection generation. */
  readDraft(): Promise<BrowserDraftV1>;
  /** Saves the exact mounted Chat draft through durable revision CAS. */
  saveDraft(command: SaveDraftCommandV1): Promise<BrowserDraftV1>;
  /** Discards the exact mounted Chat draft through durable revision CAS. */
  discardDraft(command: DiscardDraftCommandV1): Promise<BrowserDraftV1>;
  /** Rejects new work and drains admitted dispatches before resolving. */
  close(): Promise<void>;
}>;

export type ChatManagementServiceOptions = Readonly<{
  manifest: HostDeploymentManifest;
  lease: MountedChatRuntimeLease;
  /** The composed tavern_management capability slice that gates `chat.rename`. */
  profile: ComposedTavernProfile;
}>;

/**
 * Builds the management service from the deployment principal, the
 * coordinator-branded current mounted lease and the composed management
 * profile. Forged, revoked or structurally-copied leases fail closed before
 * any durable I/O.
 */
export function createChatManagementService(options: ChatManagementServiceOptions): ChatManagementService {
  const { manifest, lease, profile } = options;
  if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
  assertComposedProfile(profile);
  if (
    !profile.operationIds.includes("chat.rename") ||
    !profile.operationIds.includes("draft.save") ||
    !profile.operationIds.includes("draft.discard")
  )
    throw unavailable();
  if (!identifier(lease.chatThreadId) || !identifier(lease.chatSurfaceSessionId)) throw unavailable();

  const store = createChatThreadStore(manifest.runtimeRoot, identityKey(manifest.principal));
  const renameThreadTitle = store.renameThreadTitle;
  const listThreads = store.listThreads;
  const saveDraftMutation = store.saveDraft;
  const discardDraftMutation = store.discardDraft;
  if (
    renameThreadTitle === undefined ||
    listThreads === undefined ||
    saveDraftMutation === undefined ||
    discardDraftMutation === undefined
  )
    throw unavailable();
  const titleService = createChatTitleManagementService(
    Object.freeze({
      resumeThread: store.resumeThread,
      renameThreadTitle,
    }),
    {
      chatThreadId: lease.chatThreadId,
      chatSurfaceSessionId: lease.chatSurfaceSessionId,
    },
  );

  let closed = false;

  const assertOpen = (): void => {
    if (closed) throw closedError();
  };

  /** Shared post-await guard; production lease authority stays coordinator-private. */
  const assertLeaseAfterDurableRead = (): void => {
    if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
  };

  const listChats = async (query: ChatListQueryV1): Promise<ChatListV1> => {
    assertOpen();
    validateListQuery(query);
    if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
    try {
      const threads = await listThreads();
      assertLeaseAfterDurableRead();
      const chats = threads
        .filter(
          (thread) =>
            thread.companionId === manifest.principal.companionId &&
            thread.continuityId === manifest.principal.continuityId &&
            (thread.lifecycleStatus ?? "active") === "active",
        )
        .map((thread) => projectListEntry(thread));
      const list: ChatListV1 = Object.freeze({
        apiVersion: TAVERN_BROWSER_API_VERSION,
        chats,
      });
      if (!TavernBrowserValidatorsV1.ChatListV1Schema.Check(list)) throw unavailable();
      return list;
    } catch (error) {
      throw rethrowReadError(error);
    }
  };

  const readDraft = async (): Promise<BrowserDraftV1> => {
    assertOpen();
    if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
    if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
    try {
      const state = await store.resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId);
      assertLeaseAfterDurableRead();
      const result = Object.freeze({
        apiVersion: TAVERN_BROWSER_API_VERSION,
        revision: state.draft.revision,
        text: state.draft.text,
      });
      if (!TavernBrowserValidatorsV1.BrowserDraftV1Schema.Check(result)) throw unavailable();
      return result;
    } catch (error) {
      throw rethrowDraftError(error);
    }
  };

  const saveDraft = async (command: SaveDraftCommandV1): Promise<BrowserDraftV1> => {
    assertOpen();
    validateDraftCommand(command, lease, true);
    if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
    try {
      const draft = await saveDraftMutation({
        chatThreadId: lease.chatThreadId,
        chatSurfaceSessionId: lease.chatSurfaceSessionId,
        expectedDraftRevision: command.expectedRevision,
        text: command.text,
      });
      assertLeaseAfterDurableRead();
      return projectDraft(draft);
    } catch (error) {
      throw rethrowDraftError(error);
    }
  };

  const discardDraft = async (command: DiscardDraftCommandV1): Promise<BrowserDraftV1> => {
    assertOpen();
    validateDraftCommand(command, lease, false);
    if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
    try {
      const draft = await discardDraftMutation({
        chatThreadId: lease.chatThreadId,
        chatSurfaceSessionId: lease.chatSurfaceSessionId,
        expectedDraftRevision: command.expectedRevision,
      });
      assertLeaseAfterDurableRead();
      return projectDraft(draft);
    } catch (error) {
      throw rethrowDraftError(error);
    }
  };

  const renameChatTitle = async (command: RenameChatTitleCommandV1): Promise<ChatTitleV1> => {
    assertOpen();
    validateRenameCommand(command, lease);
    if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
    try {
      const metadata = await titleService.setTitle({
        title: command.title,
        expectedRevision: command.expectedManagementRevision,
      });
      assertLeaseAfterDurableRead();
      const result = Object.freeze({
        apiVersion: TAVERN_BROWSER_API_VERSION,
        title: metadata.title,
        managementRevision: metadata.revision,
      });
      if (!TavernBrowserValidatorsV1.ChatTitleV1Schema.Check(result)) throw unavailable();
      return result;
    } catch (error) {
      throw rethrowRenameError(error);
    }
  };

  return Object.freeze({
    listChats,
    renameChatTitle,
    readDraft,
    saveDraft,
    discardDraft,
    async close(): Promise<void> {
      closed = true;
    },
  });

  function projectListEntry(thread: ChatThread): ChatListEntryV1 {
    if (thread.chatThreadId === undefined || thread.chatSurfaceSessionId === undefined) throw unavailable();
    const entry = Object.freeze({
      handle: lease.browserProjection.projectChatHandle(thread.chatThreadId, thread.chatSurfaceSessionId),
      title: thread.title ?? null,
      status: "active" as const,
      managementRevision: thread.managementRevision ?? 1,
      isSelected:
        thread.chatThreadId === lease.chatThreadId && thread.chatSurfaceSessionId === lease.chatSurfaceSessionId,
    });
    if (!TavernBrowserValidatorsV1.ChatListEntryV1Schema.Check(entry)) throw unavailable();
    return entry;
  }
}

function validateListQuery(query: ChatListQueryV1): void {
  if (query === null || typeof query !== "object" || Array.isArray(query)) throw unavailable();
  if (query.apiVersion !== TAVERN_BROWSER_API_VERSION) throw unavailable();
  if (query.state !== undefined && query.state !== "active") throw unavailable();
}

function _validateSelectionGeneration(selectionGeneration: number, lease: MountedChatRuntimeLease): void {
  if (!Number.isSafeInteger(selectionGeneration) || selectionGeneration < 1) throw unavailable();
  if (selectionGeneration !== lease.browserProjection.selectionGeneration) throw selectionConflict();
}

function validateDraftCommand(
  command: SaveDraftCommandV1 | DiscardDraftCommandV1,
  lease: MountedChatRuntimeLease,
  saving: boolean,
): void {
  if (command === null || typeof command !== "object" || Array.isArray(command)) throw unavailable();
  if (
    command.apiVersion !== TAVERN_BROWSER_API_VERSION ||
    command.selectionGeneration !== lease.browserProjection.selectionGeneration
  )
    throw selectionConflict();
  if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0)
    throw new Error("invalid_request");
  if (saving && typeof (command as SaveDraftCommandV1).text !== "string") throw new Error("invalid_request");
}

function projectDraft(draft: Readonly<{ revision: number; text: string | null }>): BrowserDraftV1 {
  const result = Object.freeze({ apiVersion: TAVERN_BROWSER_API_VERSION, revision: draft.revision, text: draft.text });
  if (!TavernBrowserValidatorsV1.BrowserDraftV1Schema.Check(result)) throw unavailable();
  return result;
}

function validateRenameCommand(command: RenameChatTitleCommandV1, lease: MountedChatRuntimeLease): void {
  if (command === null || typeof command !== "object" || Array.isArray(command)) throw unavailable();
  if (command.apiVersion !== TAVERN_BROWSER_API_VERSION) throw unavailable();
  if (!Number.isSafeInteger(command.selectionGeneration) || command.selectionGeneration < 1) throw unavailable();
  if (!Number.isSafeInteger(command.expectedManagementRevision) || command.expectedManagementRevision < 0)
    throw unavailable();
  if (typeof command.title !== "string" || command.title.length === 0 || command.title.length > 120)
    throw unavailable();
  // Exact-binding selection: browser input can never name another generation
  // or another Chat than the one mounted by the coordinator.
  if (command.selectionGeneration !== lease.browserProjection.selectionGeneration) throw selectionConflict();
  if (command.chatHandle !== lease.browserProjection.chatHandle) throw selectionConflict();
}

function rethrowReadError(error: unknown): Error {
  if (isStorageError(error)) return storageUnavailable();
  return unavailable();
}

function rethrowDraftError(error: unknown): Error {
  if (!(error instanceof Error)) return unavailable();
  if (error.message === "chat_draft_revision_conflict") return new Error("chat_management_revision_conflict");
  if (error.message === "chat_thread_surface_mismatch") return selectionConflict();
  if (error.message === "invalid_chat_thread_draft") return new Error("invalid_request");
  if (error.message === "chat_thread_lifecycle_not_active") return new Error("chat_management_service_unavailable");
  if (isStorageError(error)) return storageUnavailable();
  return unavailable();
}

function rethrowRenameError(error: unknown): Error {
  if (!(error instanceof Error)) return unavailable();
  if (error.message === "chat_thread_management_revision_conflict" || error.message === "chat_thread_title_unchanged")
    // Existing player-visible revision-CAS conflict semantics: the browser
    // expectation does not match durable management state; re-read and retry.
    return new Error("chat_management_revision_conflict");
  if (error.message === "chat_thread_surface_mismatch") return selectionConflict();
  if (error.message === "invalid_chat_thread_title") return new Error("invalid_request");
  if (isStorageError(error)) return storageUnavailable();
  return unavailable();
}

function isStorageError(error: unknown): boolean {
  return error instanceof Error && /storage|sqlite|eio|enoent/i.test(error.message);
}

/**
 * Accepts only a composed tavern capability slice (the frozen shape produced
 * by `composeTavernProfile`); plain or partial forgeries fail closed before
 * any I/O.
 */
function assertComposedProfile(profile: ComposedTavernProfile): void {
  if (
    typeof profile !== "object" ||
    profile === null ||
    Array.isArray(profile) ||
    Object.getPrototypeOf(profile) !== Object.prototype ||
    !Object.isFrozen(profile)
  )
    throw unavailable();
  const expectedKeys = ["profileId", "releaseTier", "routeIds", "operationIds", "navigationItemIds"] as const;
  const keys = Reflect.ownKeys(profile);
  if (
    keys.length !== expectedKeys.length ||
    !expectedKeys.every((key) => keys.includes(key)) ||
    !Object.isFrozen(profile.operationIds) ||
    profile.operationIds.some((operationId) => typeof operationId !== "string")
  )
    throw unavailable();
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}
function unavailable(): Error {
  return new Error("chat_management_service_unavailable");
}
function closedError(): Error {
  return new Error("chat_management_service_closed");
}
function selectionConflict(): Error {
  return new Error("chat_management_selection_conflict");
}
function storageUnavailable(): Error {
  return new Error("chat_management_storage_unavailable");
}
