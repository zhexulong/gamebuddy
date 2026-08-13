import type { ActiveChatThreadSelection, ChatThread, ChatThreadStore } from "../chat-thread-store.js";

export type ChatLifecycleStatus = "active" | "archived" | "trashed";

/** Public lifecycle projection is metadata-only: it intentionally has no IDs or transcript content. */
export type ChatLifecycleMetadata = Readonly<{
  status: ChatLifecycleStatus;
  managementRevision: number;
  title: string | null;
}>;

/** Host-internal route-adapter result. Its opaque binding is never public DTO data. */
export type InternalChatLifecycleResult = Readonly<{
  binding: Readonly<{ chatThreadId: string; chatSurfaceSessionId: string }>;
  metadata: ChatLifecycleMetadata;
}>;

export type ChatLifecycleTransitionRequest = Readonly<{
  chatThreadId: string;
  chatSurfaceSessionId: string;
  expectedManagementRevision: number;
}>;

export type SearchChatTitlesRequest = Readonly<{ literal: string; status: ChatLifecycleStatus }>;

export type ChatLifecycleService = Readonly<{
  archive(request: ChatLifecycleTransitionRequest): Promise<ChatLifecycleMetadata>;
  restore(request: ChatLifecycleTransitionRequest): Promise<ChatLifecycleMetadata>;
  trash(request: ChatLifecycleTransitionRequest): Promise<ChatLifecycleMetadata>;
  /** Literal title matching only; transcript content is never opened or scanned. */
  searchTitles(request: SearchChatTitlesRequest): Promise<readonly ChatLifecycleMetadata[]>;
}>;

/** Host-only API for authorized route adapters that need exact opaque target bindings. */
export type InternalChatLifecycleService = ChatLifecycleService &
  Readonly<{
    listInternal(status: ChatLifecycleStatus): Promise<readonly InternalChatLifecycleResult[]>;
    searchTitlesInternal(request: SearchChatTitlesRequest): Promise<readonly InternalChatLifecycleResult[]>;
  }>;

/** Internal Host binding; never part of player-facing lifecycle DTOs. */
export type ChatLifecycleBinding = Readonly<{ companionId: string; continuityId: string; playerId?: string }>;
/** Returns true only when the target is safe to manage outside a non-ended Game return origin. */
export type GameReturnOriginGuard = (
  input: Readonly<{ chatThreadId: string; chatSurfaceSessionId: string; companionId: string; continuityId: string }>,
) => Promise<boolean>;
export type ChatLifecycleMutationReader = Readonly<{
  assertChatLifecycleMutationAllowed(
    identity: Readonly<{ playerId: string; companionId: string; continuityId: string }>,
    binding: Readonly<{ chatThreadId: string; chatSurfaceSessionId: string }>,
  ): Promise<void>;
}>;

/**
 * Required integration seam for the read/guard/mutate interval. The local file
 * store serializes its own metadata record, but cannot serialize independently
 * owned active-selection or Game-return records. Production wiring must supply
 * an adapter backed by the authoritative shared lock/transaction; this module
 * deliberately does not claim cross-system serialization itself.
 */
export type ChatLifecycleAtomicGuard = Readonly<{
  withExactThreadManagementLock<T>(
    binding: Readonly<{
      chatThreadId: string;
      chatSurfaceSessionId: string;
      companionId: string;
      continuityId: string;
    }>,
    operation: () => Promise<T>,
  ): Promise<T>;
}>;

type LifecycleStore = Pick<ChatThreadStore, "listThreads" | "readActiveThreadSelection"> &
  Readonly<{
    transitionLifecycle?: (
      input: Readonly<{
        chatThreadId: string;
        chatSurfaceSessionId: string;
        companionId: string;
        continuityId: string;
        expectedManagementRevision: number;
        operation: "archive" | "restore" | "trash";
      }>,
    ) => Promise<ChatThread>;
  }>;

export function createChatLifecycleService(
  store: LifecycleStore,
  binding: ChatLifecycleBinding,
  gameReturnOriginGuard: GameReturnOriginGuard | undefined,
  atomicGuard: ChatLifecycleAtomicGuard | undefined,
  mutationReader?: ChatLifecycleMutationReader,
): ChatLifecycleService {
  const internal = createInternalChatLifecycleService(
    store,
    binding,
    gameReturnOriginGuard,
    atomicGuard,
    mutationReader,
  );
  return Object.freeze({
    archive: internal.archive,
    restore: internal.restore,
    trash: internal.trash,
    searchTitles: internal.searchTitles,
  });
}

export function createInternalChatLifecycleService(
  store: LifecycleStore,
  binding: ChatLifecycleBinding,
  gameReturnOriginGuard: GameReturnOriginGuard | undefined,
  atomicGuard: ChatLifecycleAtomicGuard | undefined,
  mutationReader?: ChatLifecycleMutationReader,
): InternalChatLifecycleService {
  if (store.listThreads === undefined || store.transitionLifecycle === undefined)
    throw new Error("chat_thread_lifecycle_management_unavailable");
  if (gameReturnOriginGuard === undefined && mutationReader === undefined)
    throw new Error("chat_thread_game_return_origin_guard_unavailable");
  if (atomicGuard === undefined) throw new Error("chat_thread_atomic_guard_unavailable");
  const listThreads = store.listThreads;
  const transitionLifecycle = store.transitionLifecycle;
  const scoped = (thread: ChatThread) =>
    thread.companionId === binding.companionId && thread.continuityId === binding.continuityId;
  const projectInternal = (thread: ChatThread): InternalChatLifecycleResult =>
    Object.freeze({
      binding: Object.freeze({ chatThreadId: thread.chatThreadId, chatSurfaceSessionId: thread.chatSurfaceSessionId }),
      metadata: project(thread),
    });
  const listInternal = async (status: ChatLifecycleStatus): Promise<readonly InternalChatLifecycleResult[]> =>
    Object.freeze(
      (await listThreads())
        .filter((thread) => scoped(thread) && (thread.lifecycleStatus ?? "active") === status)
        .map(projectInternal),
    );
  const searchTitlesInternal = async (
    request: SearchChatTitlesRequest,
  ): Promise<readonly InternalChatLifecycleResult[]> => {
    const literal = normalizeSearchLiteral(request.literal);
    return Object.freeze(
      (await listThreads())
        .filter(
          (thread) =>
            scoped(thread) &&
            (thread.lifecycleStatus ?? "active") === request.status &&
            (literal === "" ||
              (thread.title !== null &&
                thread.title !== undefined &&
                normalizeForSearch(thread.title).includes(literal))),
        )
        .map(projectInternal),
    );
  };
  const transition = async (
    request: ChatLifecycleTransitionRequest,
    operation: "archive" | "restore" | "trash",
  ): Promise<ChatLifecycleMetadata> => {
    const exactBinding = Object.freeze({
      chatThreadId: request.chatThreadId,
      chatSurfaceSessionId: request.chatSurfaceSessionId,
      companionId: binding.companionId,
      continuityId: binding.continuityId,
    });
    return atomicGuard.withExactThreadManagementLock(exactBinding, async () => {
      const active = await store.readActiveThreadSelection();
      if (isExactActiveSelection(active, request)) throw new Error("chat_thread_active_selection");
      if (mutationReader !== undefined)
        await mutationReader.assertChatLifecycleMutationAllowed(
          { playerId: binding.playerId ?? "", companionId: binding.companionId, continuityId: binding.continuityId },
          request,
        );
      else if ((await gameReturnOriginGuard!(exactBinding)) !== true)
        throw new Error("chat_thread_game_return_origin_protected");
      return project(
        await transitionLifecycle({
          ...exactBinding,
          expectedManagementRevision: request.expectedManagementRevision,
          operation,
        }),
      );
    });
  };
  const service: InternalChatLifecycleService = Object.freeze({
    archive: (request) => transition(request, "archive"),
    restore: (request) => transition(request, "restore"),
    trash: (request) => transition(request, "trash"),
    listInternal,
    searchTitlesInternal,
    async searchTitles(request): Promise<readonly ChatLifecycleMetadata[]> {
      return Object.freeze((await searchTitlesInternal(request)).map((result) => result.metadata));
    },
  });
  return service;
}

function normalizeSearchLiteral(value: unknown): string {
  if (typeof value !== "string" || value.length > 120 || /\p{Cc}/u.test(value))
    throw new Error("invalid_chat_thread_title_search");
  return normalizeForSearch(value);
}
function normalizeForSearch(value: string): string {
  return value.normalize("NFC").toLocaleLowerCase("und");
}
function isExactActiveSelection(
  active: ActiveChatThreadSelection | null,
  request: ChatLifecycleTransitionRequest,
): boolean {
  return (
    active !== null &&
    active.chatThreadId === request.chatThreadId &&
    active.chatSurfaceSessionId === request.chatSurfaceSessionId
  );
}
function project(thread: ChatThread): ChatLifecycleMetadata {
  return Object.freeze({
    status: thread.lifecycleStatus ?? "active",
    managementRevision: thread.managementRevision ?? 1,
    title: thread.title ?? null,
  });
}
