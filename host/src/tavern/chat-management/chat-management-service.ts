import {
  isCurrentMountedChatRuntimeLease,
  type MountedChatRuntimeLease,
} from "../../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type { HostDeploymentManifest } from "../../deployment-manifest.js";
import { readIdentityProfile } from "../../identity-profile.js";
import { identityKey, resolveRuntimePaths } from "../../runtime.js";
import {
  type BrowserDraftV1,
  type ChatExportCommandV1,
  type ChatExportV1,
  type ChatListEntryV1,
  type ChatListQueryV1,
  type ChatListV1,
  type ChatOpeningCommandV1,
  type ChatOpeningResultV1,
  type ChatRetentionResultV1,
  type ChatTitleV1,
  type ComposedTavernProfile,
  type DiscardDraftCommandV1,
  type RenameChatTitleCommandV1,
  type SaveDraftCommandV1,
  TAVERN_BROWSER_API_VERSION,
  TavernBrowserValidatorsV1,
  chatListPreviewText,
} from "../browser-contract/index.js";

/**
 * Service-level retention command: the wire body (revision) plus the exact
 * target handle the route named and the operation it named. Kept separate from
 * the browser contract type so the wire shape can never carry a handle the
 * browser could forge.
 */
export type ChatRetentionServiceCommand = Readonly<{
  apiVersion: number;
  chatHandle: string;
  expectedManagementRevision: number;
  operation: "archive" | "restore" | "trash";
}>;
import { type ChatThread, createChatThreadStore, ExactThreadSurfaceMismatchError } from "../chat-thread-store.js";
import { createChatTitleManagementService } from "./chat-title-management.js";
import { TavernArtifactStore } from "../artifact-store.js";
import { exportSafeChat, isRepresentableChatHeaderName } from "../interchange.js";
import { commitGreetingOpeningVariant, isTavernArtifactUnreadable } from "../library-service.js";
import { createPersonaManagementService } from "../persona-management/persona-management.js";
import { resolveTavernPaths } from "../tavern-paths.js";

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
  /** Rejects new admission and drains admitted dispatches before resolving. */
  listChats(query: ChatListQueryV1): Promise<ChatListV1>;
  /** Title rename of any Chat of the mounted companion/continuity, by handle and that Chat's own management-revision CAS. */
  renameChatTitle(command: RenameChatTitleCommandV1): Promise<ChatTitleV1>;
  /**
   * Durable Chat lifecycle retention (archive / restore / trash) through the
   * store's lifecycle CAS. The command names the exact mounted Chat handle and
   * an expected management revision; messages, bindings, title and draft are
   * never changed. Archived/trashed Chats leave the active list.
   */
  transitionLifecycle(command: ChatRetentionServiceCommand): Promise<ChatRetentionResultV1>;
  /**
   * Chooses the greeting variant the exact mounted, not-yet-locked Chat opens with. It reuses
   * `ChatThreadStore.commitOpening` and the existing `greeting_variant_id`; a sealed opening is
   * refused with `chat_opening_locked` rather than silently no-opped.
   */
  commitOpeningVariant(command: ChatOpeningCommandV1): Promise<ChatOpeningResultV1>;
  /** Reads the exact mounted Chat draft after validating the selection generation. */
  readDraft(): Promise<BrowserDraftV1>;
  /** Saves the exact mounted Chat draft through durable revision CAS. */
  saveDraft(command: SaveDraftCommandV1): Promise<BrowserDraftV1>;
  /** Discards the exact mounted Chat draft through durable revision CAS. */
  discardDraft(command: DiscardDraftCommandV1): Promise<BrowserDraftV1>;
  /**
   * Exports one Chat of this companion/continuity as a SillyTavern chat file. The Chat is named by
   * the handle the list handed out - it need not be the mounted one - and the file is the bytes the
   * interchange's own exporter produced, never a re-serialization of the transcript here. OPTIONAL:
   * it is the chat-export route's only consumer, so a mount that serves every other Chat route but
   * not this one leaves it absent and the route fails closed (404) rather than widening every
   * service stub in the repository.
   */
  exportChat?(command: ChatExportCommandV1): Promise<ChatExportV1>;
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
  const artifactStore = new TavernArtifactStore(manifest.runtimeRoot);
  const runtimePaths = resolveRuntimePaths(manifest.principal, manifest.runtimeRoot, lease.chatSurfaceSessionId);
  const tavernPaths = resolveTavernPaths(runtimePaths, manifest.principal);
  const personaService = createPersonaManagementService(artifactStore, tavernPaths.playerRoot);
  const renameThreadTitle = store.renameThreadTitle;
  const listThreads = store.listThreads;
  const listThreadLastMessages = store.listThreadLastMessages;
  const saveDraftMutation = store.saveDraft;
  const discardDraftMutation = store.discardDraft;
  if (
    renameThreadTitle === undefined ||
    listThreads === undefined ||
    listThreadLastMessages === undefined ||
    saveDraftMutation === undefined ||
    discardDraftMutation === undefined
  )
    throw unavailable();
  const titleServiceFor = (
    target: Readonly<{ chatThreadId: string; chatSurfaceSessionId: string }>,
  ): ReturnType<typeof createChatTitleManagementService> =>
    createChatTitleManagementService(Object.freeze({ resumeThread: store.resumeThread, renameThreadTitle }), target);

  let closed = false;

  const assertOpen = (): void => {
    if (closed) throw closedError();
  };

  /** Shared post-await guard; production lease authority stays coordinator-private. */
  const assertLeaseAfterDurableRead = (): void => {
    if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
  };

  /**
   * Resolves the opaque handle a management command names to the exact durable
   * thread/surface pair of THIS companion/continuity. The handle is a per-mount
   * projection carrying no durable identifier, so the only read that can invert it
   * is the thread list this service already projects: each thread's own handle is
   * recomputed and matched. No lease is consulted - the command may name any Chat,
   * not only the mounted one - so a handle that no Chat of the partition carries is
   * `chat_not_found`, not a selection conflict about a selection the request never
   * made. Archived and trashed threads are included, so `restore` can still name
   * the Chat it needs.
   */
  const resolveChatTarget = async (handle: string): Promise<ChatThread> => {
    const threads = await listThreads();
    const target = threads.find(
      (thread) =>
        thread.chatThreadId !== undefined &&
        thread.chatSurfaceSessionId !== undefined &&
        thread.companionId === manifest.principal.companionId &&
        thread.continuityId === manifest.principal.continuityId &&
        lease.browserProjection.projectChatHandle(thread.chatThreadId, thread.chatSurfaceSessionId) === handle,
    );
    if (target === undefined) throw new Error("chat_not_found");
    return target;
  };

  const listChats = async (query: ChatListQueryV1): Promise<ChatListV1> => {
    assertOpen();
    validateListQuery(query);
    if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
    try {
      const threads = await listThreads();
      // The last message of every thread in one batched read, before the lease is
      // re-checked with the thread list: a row per `resumeThread` would make this
      // projection N+1 durable transcript reads.
      const lastMessages = await listThreadLastMessages();
      assertLeaseAfterDurableRead();
      const previews = new Map(lastMessages.map((last) => [last.chatThreadId, last.text]));
      const chats = threads
        .filter(
          (thread) =>
            thread.companionId === manifest.principal.companionId &&
            thread.continuityId === manifest.principal.continuityId &&
            (thread.lifecycleStatus ?? "active") === "active",
        )
        .map((thread) => projectListEntry(thread, previews.get(thread.chatThreadId) ?? null));
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
    validateRenameCommand(command);
    if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
    try {
      const target = await resolveChatTarget(command.chatHandle);
      assertLeaseAfterDurableRead();
      const metadata = await titleServiceFor(target).setTitle({
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

  const transitionLifecycle = async (command: ChatRetentionServiceCommand): Promise<ChatRetentionResultV1> => {
    assertOpen();
    validateRetentionCommand(command);
    if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
    if (typeof store.transitionLifecycle !== "function") throw unavailable();
    try {
      const target = await resolveChatTarget(command.chatHandle);
      assertLeaseAfterDurableRead();
      const thread = await store.transitionLifecycle({
        chatThreadId: target.chatThreadId,
        chatSurfaceSessionId: target.chatSurfaceSessionId,
        companionId: manifest.principal.companionId,
        continuityId: manifest.principal.continuityId,
        expectedManagementRevision: command.expectedManagementRevision,
        operation: command.operation,
      });
      assertLeaseAfterDurableRead();
      if (thread.chatThreadId === undefined || thread.chatSurfaceSessionId === undefined) throw unavailable();
      const result: ChatRetentionResultV1 = Object.freeze({
        apiVersion: TAVERN_BROWSER_API_VERSION,
        handle: lease.browserProjection.projectChatHandle(thread.chatThreadId, thread.chatSurfaceSessionId),
        status: (thread.lifecycleStatus ?? "active") as ChatRetentionResultV1["status"],
        managementRevision: thread.managementRevision ?? 1,
      });
      if (!TavernBrowserValidatorsV1.ChatRetentionResultV1Schema.Check(result)) throw unavailable();
      return result;
    } catch (error) {
      throw rethrowRetentionError(error);
    }
  };

  const commitOpeningVariant = async (command: ChatOpeningCommandV1): Promise<ChatOpeningResultV1> => {
    assertOpen();
    if (command === null || typeof command !== "object" || Array.isArray(command)) throw invalidRequest();
    if (command.apiVersion !== TAVERN_BROWSER_API_VERSION) throw unavailable();
    if (command.selectionGeneration !== lease.browserProjection.selectionGeneration) throw selectionConflict();
    if ((command.direction === undefined) === (command.targetIndex === undefined)) throw invalidRequest();
    if (command.direction !== undefined && command.direction !== "prev" && command.direction !== "next")
      throw invalidRequest();
    if (command.targetIndex !== undefined && (!Number.isSafeInteger(command.targetIndex) || command.targetIndex < 0))
      throw invalidRequest();
    if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
    try {
      const { variant } = await commitGreetingOpeningVariant({
        store: artifactStore,
        threads: store,
        paths: tavernPaths,
        chatThreadId: lease.chatThreadId,
        chatSurfaceSessionId: lease.chatSurfaceSessionId,
        ...(command.direction === undefined ? {} : { direction: command.direction }),
        ...(command.targetIndex === undefined ? {} : { targetIndex: command.targetIndex }),
      });
      assertLeaseAfterDurableRead();
      // The commit only succeeds while the opening is unlocked, so the freshly-committed fact is
      // never `locked`; the durable lock is re-read from the thread on the next state projection.
      const result: ChatOpeningResultV1 = Object.freeze({
        apiVersion: TAVERN_BROWSER_API_VERSION,
        openingVariant: Object.freeze({ ...variant, locked: false }),
      });
      if (!TavernBrowserValidatorsV1.ChatOpeningResultV1Schema.Check(result)) throw unavailable();
      return result;
    } catch (error) {
      throw rethrowOpeningError(error);
    }
  };

  /**
   * Exports one Chat's transcript. The two display names the file's header carries are the ones
   * this product already owns - the player's persona and the mounted companion's own name - and
   * a name that cannot be read falls back to the exporter's own default rather than inventing one.
   */
  const exportNames = async (): Promise<Readonly<{ userName?: string; characterName?: string }>> => {
    const persona = await personaService.read().catch(() => null);
    const character = await readIdentityProfile(runtimePaths.identityProfilePath)
      .then((profile) => profile.identity.name)
      .catch(() => null);
    // A name the file's header cannot carry (its own byte bound is UTF-8, the product's is
    // characters) is left to the format's default: the file still carries every message, and a
    // failed export over a label would lose all of them.
    return Object.freeze({
      ...(persona === null || !isRepresentableChatHeaderName(persona.name) ? {} : { userName: persona.name }),
      ...(character === null || !isRepresentableChatHeaderName(character) ? {} : { characterName: character }),
    });
  };

  const exportChat = async (command: ChatExportCommandV1): Promise<ChatExportV1> => {
    assertOpen();
    validateExportCommand(command);
    if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
    try {
      const target = await resolveChatTarget(command.chatHandle);
      assertLeaseAfterDurableRead();
      const state = await store.resumeThread(target.chatThreadId, target.chatSurfaceSessionId);
      assertLeaseAfterDurableRead();
      const exported = exportSafeChat(target.chatThreadId, state.messages, await exportNames());
      const result: ChatExportV1 = Object.freeze({
        apiVersion: TAVERN_BROWSER_API_VERSION,
        format: exported.format,
        chatHandle: command.chatHandle,
        messageCount: exported.messages.length,
        dispositions: exported.dispositions,
        canonicalHash: exported.canonicalHash,
        jsonl: exported.jsonl,
      });
      if (!TavernBrowserValidatorsV1.ChatExportV1Schema.Check(result)) throw unavailable();
      return result;
    } catch (error) {
      throw rethrowExportError(error);
    }
  };

  return Object.freeze({
    listChats,
    renameChatTitle,
    transitionLifecycle,
    commitOpeningVariant,
    readDraft,
    saveDraft,
    discardDraft,
    exportChat,
    async close(): Promise<void> {
      closed = true;
      store.close?.();
    },
  });

  function projectListEntry(thread: ChatThread, lastMessageText: string | null): ChatListEntryV1 {
    if (thread.chatThreadId === undefined || thread.chatSurfaceSessionId === undefined) throw unavailable();
    const entry = Object.freeze({
      handle: lease.browserProjection.projectChatHandle(thread.chatThreadId, thread.chatSurfaceSessionId),
      title: thread.title ?? null,
      status: "active" as const,
      managementRevision: thread.managementRevision ?? 1,
      isSelected:
        thread.chatThreadId === lease.chatThreadId && thread.chatSurfaceSessionId === lease.chatSurfaceSessionId,
      updatedAtMs: thread.updatedAtMs,
      preview: chatListPreviewText(lastMessageText),
    });
    if (!TavernBrowserValidatorsV1.ChatListEntryV1Schema.Check(entry)) throw unavailable();
    return entry;
  }
}

function rethrowOpeningError(error: unknown): Error {
  if (!(error instanceof Error)) return unavailable();
  if (
    error.message === "chat_opening_locked" ||
    error.message === "chat_thread_opening_locked" ||
    error.message === "chat_opening_not_greeting" ||
    error.message === "chat_opening_variant_not_found"
  )
    return error;
  if (error.message === "invalid_chat_opening_request") return new Error("invalid_request");
  if (error.message === "tavern_chat_scope_mismatch") return selectionConflict();
  if (isTavernArtifactUnreadable(error)) return companionUnreadable();
  if (isStorageError(error)) return storageUnavailable();
  return unavailable();
}

function validateListQuery(query: ChatListQueryV1): void {
  if (query === null || typeof query !== "object" || Array.isArray(query)) throw unavailable();
  if (query.apiVersion !== TAVERN_BROWSER_API_VERSION) throw unavailable();
  if (query.state !== undefined && query.state !== "active") throw unavailable();
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

function validateRenameCommand(command: RenameChatTitleCommandV1): void {
  if (command === null || typeof command !== "object" || Array.isArray(command)) throw unavailable();
  if (command.apiVersion !== TAVERN_BROWSER_API_VERSION) throw unavailable();
  if (!Number.isSafeInteger(command.expectedManagementRevision) || command.expectedManagementRevision < 0)
    throw unavailable();
  if (typeof command.title !== "string" || command.title.length === 0 || command.title.length > 120)
    throw unavailable();
}

function validateRetentionCommand(command: ChatRetentionServiceCommand): void {
  if (command === null || typeof command !== "object" || Array.isArray(command)) throw unavailable();
  if (command.apiVersion !== TAVERN_BROWSER_API_VERSION) throw unavailable();
  if (!Number.isSafeInteger(command.expectedManagementRevision) || command.expectedManagementRevision < 0)
    throw unavailable();
  if (command.operation !== "archive" && command.operation !== "restore" && command.operation !== "trash")
    throw unavailable();
}

function rethrowRetentionError(error: unknown): Error {
  if (!(error instanceof Error)) return unavailable();
  if (error.message === "chat_not_found") return error;
  if (error.message === "chat_thread_management_revision_conflict")
    return new Error("chat_management_revision_conflict");
  if (error instanceof ExactThreadSurfaceMismatchError) return selectionConflict();
  if (error.message === "chat_thread_lifecycle_not_active") return new Error("chat_management_service_unavailable");
  if (error.message === "chat_thread_lifecycle_transition_invalid")
    return new Error("chat_management_lifecycle_invalid");
  if (isStorageError(error)) return storageUnavailable();
  return unavailable();
}

function rethrowReadError(error: unknown): Error {
  if (isTavernArtifactUnreadable(error)) return companionUnreadable();
  if (isStorageError(error)) return storageUnavailable();
  return unavailable();
}

function rethrowDraftError(error: unknown): Error {
  if (!(error instanceof Error)) return unavailable();
  if (error.message === "chat_draft_revision_conflict") return new Error("chat_management_revision_conflict");
  if (error instanceof ExactThreadSurfaceMismatchError) return selectionConflict();
  if (error.message === "invalid_chat_thread_draft") return new Error("invalid_request");
  if (error.message === "chat_thread_lifecycle_not_active") return new Error("chat_management_service_unavailable");
  if (isStorageError(error)) return storageUnavailable();
  return unavailable();
}

function rethrowExportError(error: unknown): Error {
  if (!(error instanceof Error)) return unavailable();
  // A handle that names no Chat of this partition is the same bounded 404 the retention routes
  // answer, rather than a conflict about a selection the request never made.
  if (error.message === "chat_not_found") return error;
  if (error instanceof ExactThreadSurfaceMismatchError) return selectionConflict();
  if (isStorageError(error)) return storageUnavailable();
  return unavailable();
}

function validateExportCommand(command: ChatExportCommandV1): void {
  if (command === null || typeof command !== "object" || Array.isArray(command)) throw unavailable();
  if (typeof command.chatHandle !== "string") throw unavailable();
}

function rethrowRenameError(error: unknown): Error {
  if (!(error instanceof Error)) return unavailable();
  if (error.message === "chat_not_found") return error;
  if (error.message === "chat_thread_management_revision_conflict" || error.message === "chat_thread_title_unchanged")
    // Existing player-visible revision-CAS conflict semantics: the browser
    // expectation does not match durable management state; re-read and retry.
    return new Error("chat_management_revision_conflict");
  if (error instanceof ExactThreadSurfaceMismatchError) return selectionConflict();
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
function invalidRequest(): Error {
  return new Error("invalid_request");
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
function companionUnreadable(): Error {
  return new Error("chat_management_companion_unreadable");
}
