import {
  isCurrentMountedChatRuntimeLease,
  type MountedChatRuntimeLease,
} from "../../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type { HostDeploymentManifest } from "../../deployment-manifest.js";
import { readIdentityProfile } from "../../identity-profile.js";
import { identityKey, resolveRuntimePaths } from "../../runtime.js";
import {
  type BrowserDraftV1,
  CHAT_EXPORT_JSONL_MAX_LENGTH,
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

/**
 * The read-only semantic catalog observation the retention guard needs: which Chats carry verified
 * content, and whether a selection the player already asked for still waits for its settlement.
 * Nothing else of the semantic authority crosses this boundary.
 */
export type ChatCatalogRead = Readonly<{
  readChatCatalog(): Promise<
    Readonly<{
      threads: readonly Readonly<{ chatThreadId: string; chatSurfaceSessionId: string; contentState: string }>[];
      /** The selection the player recorded and the next mount has not settled yet, or null. */
      expectedSelection: Readonly<{ chatThreadId: string; chatSurfaceSessionId: string }> | null;
    }>
  >;
  /**
   * Records the settlement expectation the next mount keeps for a survivor no verification has reached yet,
   * and answers whether it is now recorded. This is the same `create`-shaped expectation the player's own
   * `chat.select` records, so the settlement - not this mount - registers, verifies and selects it.
   */
  recordExpectedSelection(target: Readonly<{ chatThreadId: string; chatSurfaceSessionId: string }>): Promise<boolean>;
}>;

export type ChatManagementServiceOptions = Readonly<{
  manifest: HostDeploymentManifest;
  lease: MountedChatRuntimeLease;
  /** The composed tavern_management capability slice that gates `chat.rename`. */
  profile: ComposedTavernProfile;
  /**
   * The semantic authority's own answer to "could a start mount this Chat". Required: a mount that
   * cannot ask it is not a mount that may serve Chat removal at all.
   */
  chatCatalog: ChatCatalogRead;
}>;

/**
 * Builds the management service from the deployment principal, the
 * coordinator-branded current mounted lease and the composed management
 * profile. Forged, revoked or structurally-copied leases fail closed before
 * any durable I/O.
 */
export function createChatManagementService(options: ChatManagementServiceOptions): ChatManagementService {
  const { manifest, lease, profile, chatCatalog } = options;
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

  /**
   * THE CHAT A START WILL HAVE TO MOUNT MUST BE ONE THE SEMANTIC AUTHORITY CAN MOUNT.
   *
   * Removing the Chat this mount serves is an ordinary product action: the durable authority marks
   * the row and the shell migrates its selection onto another live Chat. But when every Chat left
   * behind is one the catalog never registered - a New Chat the player created and never opened -
   * the next start's successor settlement has no Chat it can move the selection to and fails closed.
   * That failure used to be unrepairable from inside the product, so the removal refused it by name and
   * told the player to open the other Chat once. The settlement it named is now recorded for that
   * survivor here instead: the same `create`-shaped expectation the player's own New Chat records,
   * which the next mount's `settleExpectedChatSelection` registers, verifies against the Chat's own
   * Tavern content, selects and clears. So the removal proceeds and the next start mounts the survivor.
   *
   * What this answers is the survivor whose settlement the removal has to record, or null when it has to
   * record none. Every clause narrows to that alone. Only the removal that would orphan the selection:
   * while the Chat this mount serves is still a live row, removing any other Chat leaves that selection
   * itself live and verified, and the next start reads it and writes nothing - so the lease is the
   * evidence, and a durable archive never moves it. Only the removal that leaves a survivor, because an
   * empty list is `chat_active_list_empty`, judged inside the removal's own transaction. Only the removal
   * that leaves no survivor carrying verified content. And only the removal no recorded expectation
   * already names a survivor for, because one expectation is the player's own choice and the next mount
   * settles exactly what it names.
   */
  const unsettledSuccessor = async (target: ChatThread): Promise<ChatThread | null> => {
    if ((target.lifecycleStatus ?? "active") !== "active") return null;
    const threads = await listThreads();
    const served = threads.find(
      (thread) =>
        thread.chatThreadId === lease.chatThreadId && thread.chatSurfaceSessionId === lease.chatSurfaceSessionId,
    );
    const targetIsServed =
      target.chatThreadId === lease.chatThreadId && target.chatSurfaceSessionId === lease.chatSurfaceSessionId;
    // The selection can only be orphaned by a removal while the Chat it names is still live: the lease
    // is what says which Chat that is, and another Chat's removal leaves it exactly where it was. Once
    // the served Chat has left the list through any writer, every removal is judged by what it leaves.
    if (!targetIsServed && served !== undefined && (served.lifecycleStatus ?? "active") === "active") return null;
    const survivors = threads.filter(
      (thread) =>
        thread.companionId === manifest.principal.companionId &&
        thread.continuityId === manifest.principal.continuityId &&
        (thread.lifecycleStatus ?? "active") === "active" &&
        thread.chatThreadId !== target.chatThreadId,
    );
    assertLeaseAfterDurableRead();
    // Nothing left at all is the store's fact, and it judges it inside the removal's transaction.
    if (survivors.length === 0) return null;
    const catalog = await chatCatalog.readChatCatalog();
    assertLeaseAfterDurableRead();
    const mountable = new Set(
      catalog.threads
        .filter((thread) => thread.contentState === "verified")
        .map((thread) => thread.chatSurfaceSessionId),
    );
    if (
      survivors.some(
        (thread) => thread.chatSurfaceSessionId !== undefined && mountable.has(thread.chatSurfaceSessionId),
      )
    )
      return null;
    const expected = catalog.expectedSelection;
    // A recorded expectation is a promise the next mount keeps only in the settlement's own `create`
    // shape: the Chat it names has no row here yet, so the settlement registers it, verifies the
    // content the player's New Chat already wrote, and selects it. A row that exists without a
    // receipt is not such a promise - the settlement returns without verifying it - and a `select`
    // expectation can only name a Chat that already carries a receipt, which the check above saw.
    const promised = (thread: ChatThread): boolean =>
      expected !== null &&
      thread.chatThreadId === expected.chatThreadId &&
      thread.chatSurfaceSessionId === expected.chatSurfaceSessionId &&
      !catalog.threads.some(
        (row) => row.chatThreadId === thread.chatThreadId && row.chatSurfaceSessionId === thread.chatSurfaceSessionId,
      );
    if (survivors.some(promised)) return null;
    // The survivor whose settlement gets recorded. Most recently updated first, ties by id: two removals
    // that read the same list must name the same Chat, or the Chat the next start mounts would depend on
    // which copy of the list happened to be read.
    return [...survivors].sort((left, right) =>
      right.updatedAtMs - left.updatedAtMs === 0
        ? left.chatThreadId.localeCompare(right.chatThreadId)
        : right.updatedAtMs - left.updatedAtMs,
    )[0]!;
  };

  /**
   * Durable lifecycle retention. The invariants a removal must not break - the active list is never
   * emptied, and the Chat the next start has to mount has something behind it - are judged by
   * `ChatThreadStore.transitionLifecycle` inside its own transaction and by the successor settlement
   * just above it; this method resolves the handle, hands the exact CAS vector over and renames what
   * comes back.
   *
   * The settlement is recorded AFTER the removal lands, never before: a removal that refuses (the last
   * live Chat, a stale revision) must not leave the player's next mount pointing at a Chat they never
   * chose. A crash in that one-step window is the state the next start already heals - it records this
   * same expectation for a live, unverified successor before the mount.
   */
  const transitionLifecycle = async (command: ChatRetentionServiceCommand): Promise<ChatRetentionResultV1> => {
    assertOpen();
    validateRetentionCommand(command);
    if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
    if (typeof store.transitionLifecycle !== "function") throw unavailable();
    try {
      const target = await resolveChatTarget(command.chatHandle);
      assertLeaseAfterDurableRead();
      const settlement = await unsettledSuccessor(target);
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
      if (settlement !== null)
        await chatCatalog.recordExpectedSelection(
          Object.freeze({
            chatThreadId: settlement.chatThreadId,
            chatSurfaceSessionId: settlement.chatSurfaceSessionId,
          }),
        );
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
      // The reply carries one file, and the wire carries it whole or not at all: an export over the
      // contract's own ceiling cannot be served, and the reply's validation below would report it as a
      // service failure - the one answer that invites a retry which can never succeed.
      if (!chatExportFitsWire(exported.jsonl.length))
        throw new ChatExportTooLargeError(exported.jsonl.length, CHAT_EXPORT_JSONL_MAX_LENGTH);
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
  // The store's own refusal of the last live Chat, carried out under its own name so the route
  // reports the player-actionable fact instead of a service outage.
  if (error.message === "chat_active_list_empty") return new ChatActiveListEmptyError();
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

/**
 * Whether one Chat's exported file fits the ceiling the wire carries.
 *
 * The comparison is named because it is the whole decision: `CHAT_EXPORT_JSONL_MAX_LENGTH` bounds the
 * reply's own schema, and a reply that fails that check reads to the player as a service outage.
 */
export function chatExportFitsWire(jsonlLength: number): boolean {
  return jsonlLength <= CHAT_EXPORT_JSONL_MAX_LENGTH;
}

/**
 * A Chat whose own exported file is over the ceiling the wire carries.
 *
 * Both numbers travel in the message, because that is the only place a support path can read them:
 * the player reads the sentence the code earns, never a byte count, and a log line that says how far
 * over the conversation is has to name the length and the ceiling together.
 */
export class ChatExportTooLargeError extends Error {
  constructor(jsonlLength: number, maxLength: number) {
    super(`chat_export_too_large:${jsonlLength}:${maxLength}`);
  }
}

/**
 * The one removal this library refuses: the last active Chat of the companion/continuity.
 *
 * It is named because the alternative is a root that can never start again - the mount finds no
 * active Chat to move the selection to and fails closed - so a caller that produced this request has
 * to read which rule it broke, not a generic service failure. The forward path is creating the
 * successor first (see `refuseAnEmptyActiveList`).
 */
export class ChatActiveListEmptyError extends Error {
  constructor() {
    super("chat_active_list_empty");
  }
}

function rethrowExportError(error: unknown): Error {
  if (!(error instanceof Error)) return unavailable();
  // The Chat's own size is already the answer, with both numbers in the message: the caller logs it,
  // and the player reads the sentence the code earns instead of a byte count.
  if (error instanceof ChatExportTooLargeError) return error;
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
