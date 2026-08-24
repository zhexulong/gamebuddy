import type { ChatThread, ChatThreadStore } from "../chat-thread-store.js";

/** Player-safe title metadata. Opaque thread and ownership bindings stay Host-local. */
export type ChatTitleManagementMetadata = Readonly<{ title: string | null; revision: number }>;
export type SetChatTitleRequest = Readonly<{ title: string; expectedRevision: number }>;
export type ChatTitleManagementBinding = Readonly<{ chatThreadId: string; chatSurfaceSessionId: string }>;
export type ChatTitleManagementService = Readonly<{
  read(): Promise<ChatTitleManagementMetadata>;
  setTitle(request: SetChatTitleRequest): Promise<ChatTitleManagementMetadata>;
}>;

type ChatTitleStore = Pick<ChatThreadStore, "resumeThread"> &
  Readonly<{
    renameThreadTitle(
      input: Readonly<{
        chatThreadId: string;
        chatSurfaceSessionId: string;
        expectedManagementRevision: number;
        title: string;
      }>,
    ): Promise<ChatThread>;
  }>;

/**
 * Metadata-only adapter for one exact selected thread/surface pair. The store
 * remains the authority for title validation, durable management CAS, and
 * journal-backed readback.
 */
export function createChatTitleManagementService(
  store: ChatTitleStore,
  binding: ChatTitleManagementBinding,
): ChatTitleManagementService {
  const renameThreadTitle = store.renameThreadTitle;
  return Object.freeze({
    async read(): Promise<ChatTitleManagementMetadata> {
      return project((await store.resumeThread(binding.chatThreadId, binding.chatSurfaceSessionId)).thread);
    },
    async setTitle(request: SetChatTitleRequest): Promise<ChatTitleManagementMetadata> {
      return project(
        await renameThreadTitle({
          chatThreadId: binding.chatThreadId,
          chatSurfaceSessionId: binding.chatSurfaceSessionId,
          expectedManagementRevision: request.expectedRevision,
          title: request.title,
        }),
      );
    },
  });
}

function project(thread: ChatThread): ChatTitleManagementMetadata {
  return Object.freeze({ title: thread.title ?? null, revision: thread.managementRevision ?? 1 });
}
