import { readFile as fsReadFile } from "node:fs/promises";
import { join } from "node:path";
import {
  atomicWriteFile,
  withPathLock as lockedPath,
  readSafeDirectory,
  removeSafeFile,
  verifySafePathBoundary,
} from "../path-lock.js";

/**
 * Scoped Tavern persistence seam. It owns only a ChatThread's visible opening
 * and append-only normal messages; it neither reads Pi/Magic Context state nor
 * implements message edit/swipe/branch or any Game operation.
 */
export const CHAT_THREAD_SCHEMA_VERSION = 1 as const;
export const CHAT_THREAD_SELECTION_SCHEMA_VERSION = 1 as const;

export type GreetingSource = Readonly<{
  greetingSetId: string;
  sourceRevision: number;
  /** Undefined only for read-compatible historical openings; new writes require it. */
  canonicalHash?: string;
  variantId: string;
  profileRevision: number;
  scenarioRevision: number | null;
}>;

export type OpeningSelection =
  | Readonly<{ kind: "blank" }>
  | Readonly<{ kind: "greeting"; messageId: string; source: GreetingSource }>;

export type TavernStableArtifactBinding = Readonly<{
  kind: "persona" | "scenario" | "dialogue_examples";
  sourceId: string;
  revision: number;
  canonicalHash: string;
}>;
/** Metadata only: the external WorldBook body stays at the independently-audited binding. */
export type TavernStableWorldBookBinding = Readonly<{
  worldBookId: string;
  revision: number;
  canonicalHash: string;
  provenance: "authored" | "st-card-import" | "reviewed-import";
}>;
/**
 * A managed World Info revision is an explicit source variant, rather than a
 * type-punned WorldBook. Its public title is the only public resolver key.
 */
export type TavernStableManagedWorldInfoBinding = Readonly<{
  source: "managed_world_info";
  publicTitle: string;
  revision: number;
  canonicalHash: string;
}>;
export type TavernStableWorldInfoBinding = TavernStableWorldBookBinding | TavernStableManagedWorldInfoBinding;

export type ChatThread = Readonly<{
  schemaVersion: typeof CHAT_THREAD_SCHEMA_VERSION;
  chatThreadId: string;
  companionId: string;
  continuityId: string;
  /** Tavern-only selected presentation sources; never runtime identity or Game state. */
  personaId?: string;
  scenarioId?: string;
  /** Exact immutable source records; no source may be resolved as latest. */
  stableArtifactBindings?: readonly TavernStableArtifactBinding[];
  worldBookBinding?: TavernStableWorldInfoBinding;
  /** Exact continuity-ledger Chat session this thread is attached to. */
  chatSurfaceSessionId: string;
  createdAtMs: number;
  updatedAtMs: number;
  openingSelection: OpeningSelection;
  /** Player-authored display metadata only; it never derives from transcript content. */
  title?: string | null;
  /** Lifecycle metadata is independent from content revision/timestamps. */
  lifecycleStatus?: "active" | "archived" | "trashed";
  /** Monotonically increasing durable lifecycle-management revision. */
  managementRevision?: number;
  /** Exact durable pre-trash state; present only while lifecycleStatus is trashed. */
  trashRestoreStatus?: "active" | "archived";
  /** The first non-opening event makes either opening choice immutable. */
  openingLockedAtEventId: string | null;
}>;

export type ChatThreadMessage = Readonly<{
  messageId: string;
  role: "player" | "companion";
  kind: "opening" | "player" | "response";
  text: string;
  occurredAtMs: number;
  /** Present only on message zero; unselected greetings are never persisted. */
  greetingSource: GreetingSource | null;
}>;

export type ChatThreadState = Readonly<{
  thread: ChatThread;
  messages: readonly ChatThreadMessage[];
}>;

/**
 * The durable Tavern selector is intentionally distinct from the active Host
 * runtime. A caller must still construct the exact Pi session named here; the
 * store never treats selection as a context handoff or runtime switch.
 */
export type ActiveChatThreadSelection = Readonly<{
  schemaVersion: typeof CHAT_THREAD_SELECTION_SCHEMA_VERSION;
  chatThreadId: string;
  chatSurfaceSessionId: string;
  selectedAtMs: number;
}>;

export type CreateChatThreadRequest = Readonly<{
  chatThreadId: string;
  companionId: string;
  continuityId: string;
  chatSurfaceSessionId: string;
  personaId?: string;
  scenarioId?: string;
  stableArtifactBindings?: readonly TavernStableArtifactBinding[];
  worldBookBinding?: TavernStableWorldInfoBinding;
  opening: "blank" | Readonly<{ messageId: string; text: string; source: GreetingSource }>;
}>;

export type InitialChatExactContentCapability = Readonly<{
  resumeExact(chatThreadId: string, chatSurfaceSessionId: string): Promise<ChatThreadState>;
  createExplicit(request: CreateChatThreadRequest): Promise<ChatThreadState>;
  ensureExactContent(
    binding: Readonly<{
      chatThreadId: string;
      companionId: string;
      continuityId: string;
      chatSurfaceSessionId: string;
    }>,
    request: CreateChatThreadRequest,
  ): Promise<ChatThreadState>;
}>;

export type ChatThreadStore = Readonly<{
  createThread(request: CreateChatThreadRequest): Promise<ChatThreadState>;
  /** Lists durable thread metadata only; transcript data remains explicitly opened. */
  listThreads?(): Promise<readonly ChatThread[]>;
  /** Returns no selection rather than guessing from a latest thread. */
  readActiveThreadSelection(): Promise<ActiveChatThreadSelection | null>;
  /**
   * Reads a durable selector and its exact thread binding without nesting a
   * selector→thread lock. A final selector read detects a concurrent change.
   */
  readActiveThreadBinding?(): Promise<ChatThreadState | null>;
  /**
   * Persists only an exact already-bound thread/surface pair after durable
   * readback. It neither creates a surface nor changes a live Pi runtime.
   */
  selectActiveThread(chatThreadId: string, chatSurfaceSessionId: string): Promise<ActiveChatThreadSelection>;
  /** Opens precisely one persisted thread; there is deliberately no "latest" fallback. */
  resumeThread(chatThreadId: string, chatSurfaceSessionId: string): Promise<ChatThreadState>;
  commitOpening(chatThreadId: string, opening: CreateChatThreadRequest["opening"]): Promise<ChatThreadState>;
  appendPlayer(
    chatThreadId: string,
    message: Readonly<{ messageId: string; text: string; occurredAtMs: number }>,
  ): Promise<ChatThreadState>;
  /** Resolves only after the response and its pristine lock are durably committed. */
  commitResponse(
    chatThreadId: string,
    response: Readonly<{ messageId: string; text: string; occurredAtMs: number }>,
  ): Promise<ChatThreadState>;
  /** Exact pristine-thread only WorldBook binding mutation with optimistic revision guard. */
  setWorldBookBinding?(
    input: Readonly<{
      chatThreadId: string;
      chatSurfaceSessionId: string;
      companionId: string;
      continuityId: string;
      expectedUpdatedAtMs: number;
      binding?: TavernStableWorldInfoBinding;
    }>,
  ): Promise<ChatThreadState>;
  /** Metadata-only player title mutation using the lifecycle management CAS. */
  renameThreadTitle?(
    input: Readonly<{
      chatThreadId: string;
      chatSurfaceSessionId: string;
      expectedManagementRevision: number;
      title: string;
    }>,
  ): Promise<ChatThread>;
  /** Durable lifecycle operation; no messages, bindings, title, or draft are changed. */
  transitionLifecycle?(
    input: Readonly<{
      chatThreadId: string;
      chatSurfaceSessionId: string;
      companionId: string;
      continuityId: string;
      expectedManagementRevision: number;
      operation: "archive" | "restore" | "trash";
    }>,
  ): Promise<ChatThread>;
}>;

type StoredMessages = Readonly<{
  schemaVersion: typeof CHAT_THREAD_SCHEMA_VERSION;
  chatThreadId: string;
  messages: readonly ChatThreadMessage[];
}>;
type PreparedTransaction = Readonly<{ schemaVersion: typeof CHAT_THREAD_SCHEMA_VERSION; state: ChatThreadState }>;

const genuineChatThreadStores = new WeakSet<object>();
const initialExactContentCapabilities = new WeakSet<object>();

/** Only a store created by this module can mint this unmounted capability. */
export function createInitialChatExactContentCapability(store: ChatThreadStore): InitialChatExactContentCapability {
  if (!genuineChatThreadStores.has(store)) throw new Error("untrusted_chat_thread_store");
  const capability = initialExactContentCapabilityByStore.get(store);
  if (capability === undefined) throw new Error("missing_chat_thread_store_capability");
  return capability;
}

/** Port-only identity check; matching methods or proxies are never capabilities. */
export function isInitialChatExactContentCapability(value: unknown): value is InitialChatExactContentCapability {
  return !!value && typeof value === "object" && initialExactContentCapabilities.has(value);
}

export function classifyInitialChatExactContentFailure(error: unknown): "not_found" | "already_exists" | undefined {
  if (error instanceof ExactThreadNotFoundError) return "not_found";
  if (error instanceof ExactThreadAlreadyExistsError) return "already_exists";
  return undefined;
}

const initialExactContentCapabilityByStore = new WeakMap<object, InitialChatExactContentCapability>();
class ExactThreadNotFoundError extends Error {
  constructor() {
    super("chat_thread_not_found");
  }
}
class ExactThreadAlreadyExistsError extends Error {
  constructor() {
    super("chat_thread_already_exists");
  }
}

/**
 * The caller supplies the already-derived opaque continuity key (normally
 * RuntimeSession.identityKey). This keeps storage derivation out of browser
 * input and avoids creating a second identity scheme before Tavern artifacts.
 */
export function createChatThreadStore(
  root: string,
  continuityKey: string,
  now: () => number = Date.now,
): ChatThreadStore {
  assertId("continuityKey", continuityKey);
  const continuityRoot = join(root, "tavern", "v1", "continuities", continuityKey);
  const threadRoot = join(continuityRoot, "threads");
  const activeSelectionPath = join(continuityRoot, "active-chat-thread.json");
  const containmentRoot = join(root, "tavern", "v1");
  const withPathLock = <T>(path: string, work: () => Promise<T>): Promise<T> =>
    lockedPath(path, work, { containmentRoot });

  const pathsFor = (chatThreadId: string) => {
    assertId("chatThreadId", chatThreadId);
    const directory = join(threadRoot, chatThreadId);
    return Object.freeze({
      directory,
      thread: join(directory, "thread.json"),
      messages: join(directory, "messages.json"),
      journal: join(directory, "transaction.json"),
    });
  };

  const mutate = async (
    chatThreadId: string,
    change: (current: ChatThreadState) => ChatThreadState,
  ): Promise<ChatThreadState> => {
    const paths = pathsFor(chatThreadId);
    return withPathLock(paths.thread, async () => {
      const current = await readState(paths, containmentRoot);
      const next = freezeState(change(current));
      await commitState(paths, next, containmentRoot);
      return next;
    });
  };

  const store: ChatThreadStore = Object.freeze({
    async createThread(request): Promise<ChatThreadState> {
      validateCreate(request);
      const paths = pathsFor(request.chatThreadId);
      return withPathLock(paths.thread, async () => {
        if (
          (await exists(paths.thread, containmentRoot)) ||
          (await exists(paths.messages, containmentRoot)) ||
          (await exists(paths.journal, containmentRoot))
        )
          throw new ExactThreadAlreadyExistsError();
        const timestamp = now();
        const opening = normalizeOpening(request.opening);
        const messages =
          opening === "blank"
            ? []
            : [
                freezeMessage({
                  messageId: opening.messageId,
                  role: "companion",
                  kind: "opening",
                  text: opening.text,
                  occurredAtMs: timestamp,
                  greetingSource: opening.source,
                }),
              ];
        const thread = freezeThread({
          schemaVersion: CHAT_THREAD_SCHEMA_VERSION,
          chatThreadId: request.chatThreadId,
          companionId: request.companionId,
          continuityId: request.continuityId,
          ...(request.personaId === undefined ? {} : { personaId: request.personaId }),
          ...(request.scenarioId === undefined ? {} : { scenarioId: request.scenarioId }),
          stableArtifactBindings: freezeStableArtifactBindings(request.stableArtifactBindings ?? []),
          ...(request.worldBookBinding === undefined
            ? {}
            : { worldBookBinding: freezeStableWorldBookBinding(request.worldBookBinding) }),
          chatSurfaceSessionId: request.chatSurfaceSessionId,
          createdAtMs: timestamp,
          updatedAtMs: timestamp,
          openingSelection:
            opening === "blank"
              ? Object.freeze({ kind: "blank" as const })
              : Object.freeze({ kind: "greeting" as const, messageId: opening.messageId, source: opening.source }),
          title: null,
          lifecycleStatus: "active",
          managementRevision: 1,
          openingLockedAtEventId: null,
        });
        const state = freezeState({ thread, messages });
        await commitState(paths, state, containmentRoot);
        return state;
      });
    },

    async listThreads(): Promise<readonly ChatThread[]> {
      let entries: readonly string[];
      try {
        entries = await readSafeDirectory(threadRoot, join(root, "tavern", "v1"));
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return Object.freeze([]);
        throw error;
      }
      const threads = await Promise.all(
        [...entries].sort().map(async (chatThreadId) => {
          if (!isId(chatThreadId)) throw new Error("invalid_chat_thread_directory");
          const paths = pathsFor(chatThreadId);
          return withPathLock(paths.thread, async () => (await readState(paths, containmentRoot)).thread);
        }),
      );
      return Object.freeze(threads);
    },

    async readActiveThreadSelection(): Promise<ActiveChatThreadSelection | null> {
      return withPathLock(activeSelectionPath, async () => {
        try {
          return validateActiveSelection(
            JSON.parse(await safeReadFile(activeSelectionPath, containmentRoot)) as unknown,
          );
        } catch (error) {
          if (isNodeError(error) && error.code === "ENOENT") return null;
          throw error;
        }
      });
    },

    async readActiveThreadBinding(): Promise<ChatThreadState | null> {
      const first = await readSelection();
      if (first === null) return null;
      const state = await resumeExact(first.chatThreadId, first.chatSurfaceSessionId);
      const final = await readSelection();
      if (
        final === null ||
        final.chatThreadId !== first.chatThreadId ||
        final.chatSurfaceSessionId !== first.chatSurfaceSessionId ||
        final.selectedAtMs !== first.selectedAtMs
      )
        throw new Error("active_chat_thread_selection_changed");
      return state;
    },

    async selectActiveThread(chatThreadId, chatSurfaceSessionId): Promise<ActiveChatThreadSelection> {
      assertId("chatSurfaceSessionId", chatSurfaceSessionId);
      const paths = pathsFor(chatThreadId);
      // Read the exact durable mapping before publishing it. Lock ordering is
      // thread then selector everywhere this operation needs both resources.
      return withPathLock(paths.thread, async () => {
        const state = await readState(paths, containmentRoot);
        if (state.thread.chatSurfaceSessionId !== chatSurfaceSessionId) throw new Error("chat_thread_surface_mismatch");
        return withPathLock(activeSelectionPath, async () => {
          const selection = freezeActiveSelection({
            schemaVersion: CHAT_THREAD_SELECTION_SCHEMA_VERSION,
            chatThreadId,
            chatSurfaceSessionId,
            selectedAtMs: now(),
          });
          await atomicWriteFile(activeSelectionPath, JSON.stringify(selection, null, 2), containmentRoot);
          // Read back and validate so callers never claim durable selection
          // based solely on a successful write.
          return validateActiveSelection(
            JSON.parse(await safeReadFile(activeSelectionPath, containmentRoot)) as unknown,
          );
        });
      });
    },

    async resumeThread(chatThreadId, chatSurfaceSessionId): Promise<ChatThreadState> {
      assertId("chatSurfaceSessionId", chatSurfaceSessionId);
      const paths = pathsFor(chatThreadId);
      return withPathLock(paths.thread, async () => {
        const state = await readState(paths, containmentRoot);
        if (state.thread.chatSurfaceSessionId !== chatSurfaceSessionId) throw new Error("chat_thread_surface_mismatch");
        return state;
      });
    },

    async commitOpening(chatThreadId, requestedOpening): Promise<ChatThreadState> {
      const opening = normalizeOpening(requestedOpening);
      return mutate(chatThreadId, (current) => {
        if (
          current.thread.openingLockedAtEventId !== null ||
          current.messages.some((message) => message.kind !== "opening")
        )
          throw new Error("chat_thread_opening_locked");
        const messages =
          opening === "blank"
            ? []
            : [
                freezeMessage({
                  messageId: opening.messageId,
                  role: "companion",
                  kind: "opening",
                  text: opening.text,
                  occurredAtMs: now(),
                  greetingSource: opening.source,
                }),
              ];
        return {
          thread: freezeThread({
            ...current.thread,
            updatedAtMs: now(),
            openingSelection:
              opening === "blank"
                ? Object.freeze({ kind: "blank" as const })
                : Object.freeze({ kind: "greeting" as const, messageId: opening.messageId, source: opening.source }),
          }),
          messages,
        };
      });
    },

    async appendPlayer(chatThreadId, message): Promise<ChatThreadState> {
      return appendNormal(chatThreadId, "player", message);
    },

    async commitResponse(chatThreadId, response): Promise<ChatThreadState> {
      // This method is the response publication boundary: callers must await
      // it before SSE/UI display. No in-memory-only response is returned.
      return appendNormal(chatThreadId, "response", response);
    },

    async setWorldBookBinding(input): Promise<ChatThreadState> {
      assertId("chatSurfaceSessionId", input.chatSurfaceSessionId);
      assertId("companionId", input.companionId);
      assertId("continuityId", input.continuityId);
      assertTimestamp(input.expectedUpdatedAtMs);
      if (input.binding !== undefined) freezeStableWorldBookBinding(input.binding);
      return mutate(input.chatThreadId, (current) => {
        if (
          current.thread.chatSurfaceSessionId !== input.chatSurfaceSessionId ||
          current.thread.companionId !== input.companionId ||
          current.thread.continuityId !== input.continuityId
        )
          throw new Error("chat_thread_scope_mismatch");
        if (current.thread.updatedAtMs !== input.expectedUpdatedAtMs) throw new Error("chat_thread_revision_conflict");
        if (current.messages.length !== 0) throw new Error("chat_thread_worldbook_locked");
        return {
          thread: freezeThread({
            ...current.thread,
            ...(input.binding === undefined ? { worldBookBinding: undefined } : { worldBookBinding: input.binding }),
            updatedAtMs: now(),
          }),
          messages: current.messages,
        };
      });
    },

    async transitionLifecycle(input): Promise<ChatThread> {
      assertId("chatSurfaceSessionId", input.chatSurfaceSessionId);
      assertId("companionId", input.companionId);
      assertId("continuityId", input.continuityId);
      assertManagementRevision(input.expectedManagementRevision);
      if (input.operation !== "archive" && input.operation !== "restore" && input.operation !== "trash")
        throw new Error("invalid_chat_thread_lifecycle_operation");
      const paths = pathsFor(input.chatThreadId);
      return withPathLock(paths.thread, async () => {
        const current = await readState(paths, containmentRoot);
        const thread = current.thread;
        if (thread.chatSurfaceSessionId !== input.chatSurfaceSessionId) throw new Error("chat_thread_surface_mismatch");
        if (thread.companionId !== input.companionId || thread.continuityId !== input.continuityId)
          throw new Error("chat_thread_scope_mismatch");
        const currentManagementRevision = thread.managementRevision ?? 1;
        if (currentManagementRevision !== input.expectedManagementRevision)
          throw new Error("chat_thread_management_revision_conflict");
        const transition = resolveLifecycleTransition(
          thread.lifecycleStatus ?? "active",
          thread.trashRestoreStatus,
          input.operation,
        );
        const next = freezeState({
          thread: freezeThread({
            ...thread,
            lifecycleStatus: transition.status,
            ...(transition.trashRestoreStatus === undefined
              ? { trashRestoreStatus: undefined }
              : { trashRestoreStatus: transition.trashRestoreStatus }),
            managementRevision: currentManagementRevision + 1,
          }),
          messages: current.messages,
        });
        await commitState(paths, next, containmentRoot);
        return (await readState(paths, containmentRoot)).thread;
      });
    },

    async renameThreadTitle(input): Promise<ChatThread> {
      assertId("chatSurfaceSessionId", input.chatSurfaceSessionId);
      assertManagementRevision(input.expectedManagementRevision);
      const title = normalizeThreadTitle(input.title);
      const paths = pathsFor(input.chatThreadId);
      return withPathLock(paths.thread, async () => {
        const current = await readState(paths, containmentRoot);
        const managementRevision = current.thread.managementRevision ?? 1;
        if (current.thread.chatSurfaceSessionId !== input.chatSurfaceSessionId)
          throw new Error("chat_thread_surface_mismatch");
        if (managementRevision !== input.expectedManagementRevision)
          throw new Error("chat_thread_management_revision_conflict");
        if (current.thread.title === title) throw new Error("chat_thread_title_unchanged");
        const next = freezeState({
          thread: freezeThread({ ...current.thread, title, managementRevision: managementRevision + 1 }),
          messages: current.messages,
        });
        await commitState(paths, next, containmentRoot);
        return (await readState(paths, containmentRoot)).thread;
      });
    },
  });

  const initialCapability: InitialChatExactContentCapability = Object.freeze({
    async resumeExact(chatThreadId, chatSurfaceSessionId): Promise<ChatThreadState> {
      return resumeExact(chatThreadId, chatSurfaceSessionId);
    },
    async createExplicit(request): Promise<ChatThreadState> {
      await store.createThread(request);
      return resumeExact(request.chatThreadId, request.chatSurfaceSessionId);
    },
    async ensureExactContent(binding, request): Promise<ChatThreadState> {
      if (
        binding.chatThreadId !== request.chatThreadId ||
        binding.companionId !== request.companionId ||
        binding.continuityId !== request.continuityId ||
        binding.chatSurfaceSessionId !== request.chatSurfaceSessionId
      )
        throw new Error("chat_thread_binding_mismatch");
      try {
        return await resumeExact(binding.chatThreadId, binding.chatSurfaceSessionId);
      } catch (error) {
        if (!(error instanceof ExactThreadNotFoundError)) throw error;
      }
      await store.createThread(request);
      return resumeExact(binding.chatThreadId, binding.chatSurfaceSessionId);
    },
  });
  genuineChatThreadStores.add(store);
  initialExactContentCapabilities.add(initialCapability);
  initialExactContentCapabilityByStore.set(store, initialCapability);
  return store;

  async function readSelection(): Promise<ActiveChatThreadSelection | null> {
    return withPathLock(activeSelectionPath, async () => {
      try {
        return validateActiveSelection(JSON.parse(await safeReadFile(activeSelectionPath, containmentRoot)) as unknown);
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return null;
        throw error;
      }
    });
  }
  async function resumeExact(chatThreadId: string, chatSurfaceSessionId: string): Promise<ChatThreadState> {
    const paths = pathsFor(chatThreadId);
    return withPathLock(paths.thread, async () => {
      const state = await readState(paths, containmentRoot);
      if (state.thread.chatSurfaceSessionId !== chatSurfaceSessionId) throw new Error("chat_thread_surface_mismatch");
      return state;
    });
  }

  async function appendNormal(
    chatThreadId: string,
    kind: "player" | "response",
    input: Readonly<{ messageId: string; text: string; occurredAtMs: number }>,
  ): Promise<ChatThreadState> {
    validateNormalMessage(input);
    return mutate(chatThreadId, (current) => {
      const existing = current.messages.find((message) => message.messageId === input.messageId);
      if (existing !== undefined) {
        if (existing.kind !== kind || existing.text !== input.text) throw new Error("chat_thread_message_id_conflict");
        return current;
      }
      const message = freezeMessage({
        messageId: input.messageId,
        role: kind === "player" ? "player" : "companion",
        kind,
        text: input.text,
        occurredAtMs: input.occurredAtMs,
        greetingSource: null,
      });
      const lockedAt = current.thread.openingLockedAtEventId ?? input.messageId;
      return {
        thread: freezeThread({ ...current.thread, updatedAtMs: now(), openingLockedAtEventId: lockedAt }),
        messages: [...current.messages, message],
      };
    });
  }
}

async function readState(
  paths: Readonly<{ thread: string; messages: string; journal: string }>,
  containmentRoot: string,
): Promise<ChatThreadState> {
  if (await exists(paths.journal, containmentRoot)) {
    const prepared = validatePrepared(JSON.parse(await safeReadFile(paths.journal, containmentRoot)) as unknown);
    await writeStateFiles(paths, prepared.state, containmentRoot);
    await removeSafeFile(paths.journal, containmentRoot);
    return prepared.state;
  }
  let rawThread: string;
  try {
    rawThread = await safeReadFile(paths.thread, containmentRoot);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      // Missing is nominal only when no exact thread artifact exists. A lone
      // messages file is corruption/collision, never permission to create.
      if (!(await exists(paths.messages, containmentRoot))) throw new ExactThreadNotFoundError();
      throw new Error("chat_thread_incomplete_artifacts");
    }
    throw error;
  }
  const thread = validateThread(JSON.parse(rawThread) as unknown);
  let rawMessages: string;
  try {
    rawMessages = await safeReadFile(paths.messages, containmentRoot);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") throw new Error("chat_thread_incomplete_artifacts");
    throw error;
  }
  const stored = validateMessages(JSON.parse(rawMessages) as unknown, thread.chatThreadId);
  return validateState({ thread, messages: stored.messages });
}

async function commitState(
  paths: Readonly<{ thread: string; messages: string; journal: string }>,
  state: ChatThreadState,
  containmentRoot: string,
): Promise<void> {
  await atomicWriteFile(
    paths.journal,
    JSON.stringify({ schemaVersion: CHAT_THREAD_SCHEMA_VERSION, state } satisfies PreparedTransaction, null, 2),
    containmentRoot,
  );
  await writeStateFiles(paths, state, containmentRoot);
  await removeSafeFile(paths.journal, containmentRoot);
}
async function writeStateFiles(
  paths: Readonly<{ thread: string; messages: string }>,
  state: ChatThreadState,
  containmentRoot: string,
): Promise<void> {
  await atomicWriteFile(
    paths.messages,
    JSON.stringify(
      {
        schemaVersion: CHAT_THREAD_SCHEMA_VERSION,
        chatThreadId: state.thread.chatThreadId,
        messages: state.messages,
      } satisfies StoredMessages,
      null,
      2,
    ),
    containmentRoot,
  );
  await atomicWriteFile(paths.thread, JSON.stringify(state.thread, null, 2), containmentRoot);
}
async function safeReadFile(path: string, containmentRoot: string): Promise<string> {
  // The lock's boundary check is not a read capability. Reverify immediately
  // before every filesystem read so a replaced parent fails closed.
  await verifySafePathBoundary(path, containmentRoot);
  return fsReadFile(path, "utf8");
}
async function exists(path: string, containmentRoot: string): Promise<boolean> {
  try {
    await safeReadFile(path, containmentRoot);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function validateActiveSelection(value: unknown): ActiveChatThreadSelection {
  if (!isRecord(value) || value.schemaVersion !== CHAT_THREAD_SELECTION_SCHEMA_VERSION)
    throw new Error("invalid_active_chat_thread_selection");
  assertId("chatThreadId", value.chatThreadId);
  assertId("chatSurfaceSessionId", value.chatSurfaceSessionId);
  assertTimestamp(value.selectedAtMs);
  return freezeActiveSelection({
    schemaVersion: CHAT_THREAD_SELECTION_SCHEMA_VERSION,
    chatThreadId: value.chatThreadId,
    chatSurfaceSessionId: value.chatSurfaceSessionId,
    selectedAtMs: value.selectedAtMs,
  });
}
function freezeActiveSelection(value: ActiveChatThreadSelection): ActiveChatThreadSelection {
  return Object.freeze({ ...value });
}
function validateCreate(request: CreateChatThreadRequest): void {
  assertId("chatThreadId", request.chatThreadId);
  assertId("companionId", request.companionId);
  assertId("continuityId", request.continuityId);
  assertId("chatSurfaceSessionId", request.chatSurfaceSessionId);
  if (request.personaId !== undefined) assertId("personaId", request.personaId);
  if (request.scenarioId !== undefined) assertId("scenarioId", request.scenarioId);
  freezeStableArtifactBindings(request.stableArtifactBindings ?? []);
  if (request.worldBookBinding !== undefined) freezeStableWorldBookBinding(request.worldBookBinding);
  normalizeOpening(request.opening);
}
function normalizeOpening(
  opening: CreateChatThreadRequest["opening"],
): "blank" | Readonly<{ messageId: string; text: string; source: GreetingSource }> {
  if (opening === "blank") return opening;
  if (!isRecord(opening)) throw new Error("invalid_chat_thread_opening");
  assertId("messageId", opening.messageId);
  assertText(opening.text);
  validateGreetingSource(opening.source, true);
  return Object.freeze({
    messageId: opening.messageId,
    text: opening.text,
    source: freezeGreetingSource(opening.source),
  });
}
function validateNormalMessage(message: Readonly<{ messageId: string; text: string; occurredAtMs: number }>): void {
  assertId("messageId", message.messageId);
  assertText(message.text);
  assertTimestamp(message.occurredAtMs);
}
function validateGreetingSource(value: unknown, requireCanonicalHash = false): asserts value is GreetingSource {
  if (!isRecord(value)) throw new Error("invalid_greeting_source");
  assertId("greetingSetId", value.greetingSetId);
  assertId("variantId", value.variantId);
  for (const key of ["sourceRevision", "profileRevision"] as const)
    if (!isRevision(value[key])) throw new Error("invalid_greeting_source");
  if (value.scenarioRevision !== null && !isRevision(value.scenarioRevision))
    throw new Error("invalid_greeting_source");
  if (
    (requireCanonicalHash && !isHash(value.canonicalHash)) ||
    (value.canonicalHash !== undefined && !isHash(value.canonicalHash))
  )
    throw new Error("invalid_greeting_source");
}
function validatePrepared(value: unknown): PreparedTransaction {
  if (!isRecord(value) || value.schemaVersion !== CHAT_THREAD_SCHEMA_VERSION)
    throw new Error("invalid_chat_thread_transaction");
  return Object.freeze({ schemaVersion: CHAT_THREAD_SCHEMA_VERSION, state: validateState(value.state) });
}
function validateState(value: unknown): ChatThreadState {
  if (!isRecord(value)) throw new Error("invalid_chat_thread_state");
  const thread = validateThread(value.thread);
  if (!Array.isArray(value.messages)) throw new Error("invalid_chat_thread_state");
  const messages = value.messages.map(validateMessage);
  validateOpeningConsistency(thread, messages);
  return freezeState({ thread, messages });
}
function validateThread(value: unknown): ChatThread {
  if (!isRecord(value) || value.schemaVersion !== CHAT_THREAD_SCHEMA_VERSION) throw new Error("invalid_chat_thread");
  const chatThreadId = value.chatThreadId;
  const companionId = value.companionId;
  const continuityId = value.continuityId;
  const personaId = value.personaId;
  const scenarioId = value.scenarioId;
  const chatSurfaceSessionId = value.chatSurfaceSessionId;
  assertId("chatThreadId", chatThreadId);
  assertId("companionId", companionId);
  assertId("continuityId", continuityId);
  if (personaId !== undefined && !isId(personaId)) throw new Error("invalid_chat_thread");
  if (scenarioId !== undefined && !isId(scenarioId)) throw new Error("invalid_chat_thread");
  assertId("chatSurfaceSessionId", chatSurfaceSessionId);
  const stableArtifactBindings = freezeStableArtifactBindings(
    value.stableArtifactBindings === undefined ? [] : value.stableArtifactBindings,
  );
  const worldBookBinding =
    value.worldBookBinding === undefined ? undefined : freezeStableWorldBookBinding(value.worldBookBinding);
  const createdAtMs = value.createdAtMs;
  const updatedAtMs = value.updatedAtMs;
  assertTimestamp(createdAtMs);
  assertTimestamp(updatedAtMs);
  if (updatedAtMs < createdAtMs) throw new Error("invalid_chat_thread");
  const title = value.title === undefined ? null : validateStoredThreadTitle(value.title);
  const lifecycleStatus =
    value.lifecycleStatus === undefined ? "active" : validateLifecycleStatus(value.lifecycleStatus);
  const managementRevision =
    value.managementRevision === undefined ? 1 : validateManagementRevision(value.managementRevision);
  const trashRestoreStatus =
    value.trashRestoreStatus === undefined ? undefined : validateTrashRestoreStatus(value.trashRestoreStatus);
  if (lifecycleStatus === "trashed" ? trashRestoreStatus === undefined : trashRestoreStatus !== undefined)
    throw new Error("invalid_chat_thread_trash_restore_status");
  const locked = value.openingLockedAtEventId;
  if (locked !== null) assertId("openingLockedAtEventId", locked);
  const opening = validateOpeningSelection(value.openingSelection);
  return freezeThread({
    schemaVersion: CHAT_THREAD_SCHEMA_VERSION,
    chatThreadId,
    companionId,
    continuityId,
    ...(personaId === undefined ? {} : { personaId }),
    ...(scenarioId === undefined ? {} : { scenarioId }),
    stableArtifactBindings,
    ...(worldBookBinding === undefined ? {} : { worldBookBinding }),
    chatSurfaceSessionId,
    createdAtMs,
    updatedAtMs,
    openingSelection: opening,
    title,
    lifecycleStatus,
    managementRevision,
    ...(trashRestoreStatus === undefined ? {} : { trashRestoreStatus }),
    openingLockedAtEventId: locked,
  });
}
function validateOpeningSelection(value: unknown): OpeningSelection {
  if (!isRecord(value)) throw new Error("invalid_chat_thread_opening");
  const kind = value.kind;
  if (kind === "blank" && Object.keys(value).length === 1) return Object.freeze({ kind: "blank" });
  if (kind === "greeting") {
    const messageId = value.messageId;
    const source = value.source;
    assertId("messageId", messageId);
    validateGreetingSource(source);
    return Object.freeze({ kind: "greeting", messageId, source: freezeGreetingSource(source) });
  }
  throw new Error("invalid_chat_thread_opening");
}
function validateMessages(value: unknown, chatThreadId: string): StoredMessages {
  if (
    !isRecord(value) ||
    value.schemaVersion !== CHAT_THREAD_SCHEMA_VERSION ||
    value.chatThreadId !== chatThreadId ||
    !Array.isArray(value.messages)
  )
    throw new Error("invalid_chat_thread_messages");
  return Object.freeze({
    schemaVersion: CHAT_THREAD_SCHEMA_VERSION,
    chatThreadId,
    messages: Object.freeze(value.messages.map(validateMessage)),
  });
}
function validateMessage(value: unknown): ChatThreadMessage {
  if (!isRecord(value)) throw new Error("invalid_chat_thread_message");
  const messageId = value.messageId;
  const role = value.role;
  const kind = value.kind;
  const text = value.text;
  const occurredAtMs = value.occurredAtMs;
  const greetingSourceValue = value.greetingSource;
  if (
    !isId(messageId) ||
    (role !== "player" && role !== "companion") ||
    (kind !== "opening" && kind !== "player" && kind !== "response") ||
    !isText(text) ||
    !isTimestamp(occurredAtMs) ||
    (greetingSourceValue !== null && !isRecord(greetingSourceValue))
  )
    throw new Error("invalid_chat_thread_message");
  if ((kind === "opening") !== (greetingSourceValue !== null)) throw new Error("invalid_chat_thread_message");
  let greetingSource: GreetingSource | null;
  if (greetingSourceValue === null) {
    greetingSource = null;
  } else {
    validateGreetingSource(greetingSourceValue);
    greetingSource = freezeGreetingSource(greetingSourceValue);
  }
  return freezeMessage({ messageId, role, kind, text, occurredAtMs, greetingSource });
}
function validateOpeningConsistency(thread: ChatThread, messages: readonly ChatThreadMessage[]): void {
  const opening = messages.filter((message) => message.kind === "opening");
  if (
    thread.openingSelection.kind === "blank"
      ? opening.length !== 0
      : opening.length !== 1 ||
        opening[0]!.messageId !== thread.openingSelection.messageId ||
        !sameSource(opening[0]!.greetingSource, thread.openingSelection.source)
  )
    throw new Error("invalid_chat_thread_opening_consistency");
  if (
    messages.some(
      (message, index) => messages.findIndex((candidate) => candidate.messageId === message.messageId) !== index,
    )
  )
    throw new Error("invalid_chat_thread_duplicate_message");
}
function sameSource(left: GreetingSource | null, right: GreetingSource): boolean {
  return (
    left !== null &&
    left.greetingSetId === right.greetingSetId &&
    left.sourceRevision === right.sourceRevision &&
    left.canonicalHash === right.canonicalHash &&
    left.variantId === right.variantId &&
    left.profileRevision === right.profileRevision &&
    left.scenarioRevision === right.scenarioRevision
  );
}
function freezeState(state: { thread: ChatThread; messages: readonly ChatThreadMessage[] }): ChatThreadState {
  validateOpeningConsistency(state.thread, state.messages);
  return Object.freeze({ thread: state.thread, messages: Object.freeze([...state.messages]) });
}
function freezeThread(thread: ChatThread): ChatThread {
  const lifecycleStatus = validateLifecycleStatus(thread.lifecycleStatus);
  const trashRestoreStatus =
    thread.trashRestoreStatus === undefined ? undefined : validateTrashRestoreStatus(thread.trashRestoreStatus);
  if (lifecycleStatus === "trashed" ? trashRestoreStatus === undefined : trashRestoreStatus !== undefined)
    throw new Error("invalid_chat_thread_trash_restore_status");
  return Object.freeze({
    ...thread,
    title: validateStoredThreadTitle(thread.title),
    lifecycleStatus,
    managementRevision: validateManagementRevision(thread.managementRevision),
    ...(trashRestoreStatus === undefined ? { trashRestoreStatus: undefined } : { trashRestoreStatus }),
    stableArtifactBindings: freezeStableArtifactBindings(thread.stableArtifactBindings ?? []),
    ...(thread.worldBookBinding === undefined
      ? {}
      : { worldBookBinding: freezeStableWorldBookBinding(thread.worldBookBinding) }),
    openingSelection:
      thread.openingSelection.kind === "blank"
        ? Object.freeze({ kind: "blank" })
        : Object.freeze({
            kind: "greeting",
            messageId: thread.openingSelection.messageId,
            source: freezeGreetingSource(thread.openingSelection.source),
          }),
  });
}
function freezeStableArtifactBindings(values: unknown): readonly TavernStableArtifactBinding[] {
  if (!Array.isArray(values) || values.length > 3) throw new Error("invalid_tavern_stable_binding");
  const bindings = values.map((value) => {
    if (
      !isRecord(value) ||
      (value.kind !== "persona" && value.kind !== "scenario" && value.kind !== "dialogue_examples") ||
      !isId(value.sourceId) ||
      !isRevision(value.revision) ||
      !isHash(value.canonicalHash)
    )
      throw new Error("invalid_tavern_stable_binding");
    return Object.freeze({
      kind: value.kind,
      sourceId: value.sourceId,
      revision: value.revision,
      canonicalHash: value.canonicalHash,
    });
  });
  if (new Set(bindings.map((value) => value.kind)).size !== bindings.length)
    throw new Error("invalid_tavern_stable_binding");
  return Object.freeze(bindings);
}
function freezeStableWorldBookBinding(value: unknown): TavernStableWorldInfoBinding {
  if (!isRecord(value) || !isRevision(value.revision) || !isHash(value.canonicalHash))
    throw new Error("invalid_tavern_worldbook_binding");
  if ("source" in value && value.source === "managed_world_info") {
    if (!isText(value.publicTitle) || Object.keys(value).length !== 4)
      throw new Error("invalid_tavern_worldbook_binding");
    return Object.freeze({
      source: "managed_world_info",
      publicTitle: value.publicTitle,
      revision: value.revision,
      canonicalHash: value.canonicalHash,
    });
  }
  if (
    !("worldBookId" in value) ||
    !isId(value.worldBookId) ||
    (value.provenance !== "authored" && value.provenance !== "st-card-import" && value.provenance !== "reviewed-import")
  )
    throw new Error("invalid_tavern_worldbook_binding");
  return Object.freeze({
    worldBookId: value.worldBookId,
    revision: value.revision,
    canonicalHash: value.canonicalHash,
    provenance: value.provenance,
  });
}
function freezeMessage(message: ChatThreadMessage): ChatThreadMessage {
  return Object.freeze({
    ...message,
    greetingSource: message.greetingSource === null ? null : freezeGreetingSource(message.greetingSource),
  });
}
function freezeGreetingSource(source: GreetingSource): GreetingSource {
  return Object.freeze({ ...source });
}
function assertId(label: string, value: unknown): asserts value is string {
  if (!isId(value)) throw new Error(`invalid_${label}`);
}
function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}
function assertText(value: unknown): asserts value is string {
  if (!isText(value)) throw new Error("invalid_chat_thread_text");
}
function normalizeThreadTitle(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid_chat_thread_title");
  const title = value.trim();
  if (!isThreadTitle(title)) throw new Error("invalid_chat_thread_title");
  return title;
}
function validateStoredThreadTitle(value: unknown): string | null {
  if (value === null) return null;
  if (!isThreadTitle(value)) throw new Error("invalid_chat_thread_title");
  return value;
}
function isThreadTitle(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 120 &&
    !/\p{Cc}/u.test(value) &&
    value === value.trim()
  );
}
function validateLifecycleStatus(value: unknown): "active" | "archived" | "trashed" {
  if (value === "active" || value === "archived" || value === "trashed") return value;
  throw new Error("invalid_chat_thread_lifecycle_status");
}
function validateTrashRestoreStatus(value: unknown): "active" | "archived" {
  if (value === "active" || value === "archived") return value;
  throw new Error("invalid_chat_thread_trash_restore_status");
}
function resolveLifecycleTransition(
  status: "active" | "archived" | "trashed",
  restoreStatus: "active" | "archived" | undefined,
  operation: "archive" | "restore" | "trash",
): Readonly<{ status: "active" | "archived" | "trashed"; trashRestoreStatus?: "active" | "archived" }> {
  if (operation === "archive" && status === "active") return Object.freeze({ status: "archived" });
  if (operation === "restore" && status === "archived") return Object.freeze({ status: "active" });
  if (operation === "trash" && (status === "active" || status === "archived"))
    return Object.freeze({ status: "trashed", trashRestoreStatus: status });
  if (operation === "restore" && status === "trashed" && restoreStatus !== undefined)
    return Object.freeze({ status: restoreStatus });
  throw new Error("chat_thread_lifecycle_transition_invalid");
}
function validateManagementRevision(value: unknown): number {
  assertManagementRevision(value);
  return value;
}
function assertManagementRevision(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("invalid_chat_thread_management_revision");
}
function assertTimestamp(value: unknown): asserts value is number {
  if (!isTimestamp(value)) throw new Error("invalid_chat_thread_timestamp");
}
function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 16_000 && !/[\u0000\u007f]/u.test(value);
}
function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}
