import type { ChatThread, ChatThreadStore } from "../chat-thread-store.js";

/** Player-facing title lifecycle seam. Its DTOs deliberately exclude thread, surface, companion, continuity, message, and runtime identifiers. */
export type ChatTitleMetadata = Readonly<{ title: string | null; revision: number }>;
export type RenameChatTitleRequest = Readonly<{ title: string; expectedRevision: number }>;
export type ChatTitleService = Readonly<{
  read(): Promise<ChatTitleMetadata>;
  rename(request: RenameChatTitleRequest): Promise<ChatTitleMetadata>;
}>;
/** Internal Host binding; it is never part of a player-facing DTO. */
export type ChatTitleServiceBinding = Readonly<{ chatThreadId: string; chatSurfaceSessionId: string }>;

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

export function createChatTitleService(store: ChatTitleStore, binding: ChatTitleServiceBinding): ChatTitleService {
  if (store.renameThreadTitle === undefined) throw new Error("chat_thread_title_management_unavailable");
  const renameThreadTitle = store.renameThreadTitle;
  return Object.freeze({
    async read(): Promise<ChatTitleMetadata> {
      const { thread } = await store.resumeThread(binding.chatThreadId, binding.chatSurfaceSessionId);
      return project(thread);
    },
    async rename(request): Promise<ChatTitleMetadata> {
      const thread = await renameThreadTitle({
        chatThreadId: binding.chatThreadId,
        chatSurfaceSessionId: binding.chatSurfaceSessionId,
        expectedManagementRevision: request.expectedRevision,
        title: request.title,
      });
      return project(thread);
    },
  });
}
function project(thread: ChatThread): ChatTitleMetadata {
  return Object.freeze({ title: thread.title ?? null, revision: thread.managementRevision ?? 1 });
}
