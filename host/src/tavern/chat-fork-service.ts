import {
  isCurrentMountedChatRuntimeLease,
  type MountedChatRuntimeLease,
} from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import {
  type ChatListEntryV1,
  type ComposedTavernProfile,
  type ForkChatCommandV1,
  type ForkChatResultV1,
  TAVERN_BROWSER_API_VERSION,
  TavernBrowserValidatorsV1,
  chatListPreviewText,
} from "./browser-contract/index.js";
import {
  type ChatThreadState,
  type ChatThreadStore,
  classifyInitialChatExactContentFailure,
} from "./chat-thread-store.js";

/**
 * The player's one branch entry: the conversation up to a message they are looking at, as a second Chat.
 *
 * It is the ingress `ChatThreadStore.forkThread` never had. The store's half is complete and refuses by name;
 * what was missing was the two things only a mount can supply - the durable message a browser's opaque handle
 * names, and the identity of the new Chat - plus one thing the store deliberately does not own: idempotency.
 *
 * WHY THE KEY IS REQUIRED. A fork MINTS a durable Chat. If the response is lost after the commit, a retry
 * without a key mints a SECOND branch of the same conversation and the player has no way to tell which one
 * they are on. `chat.create` tolerates that shape because an empty Chat is trivially identifiable; a
 * duplicated half-conversation is not. So the new Chat's identity is DERIVED from the key the browser sent,
 * and a replay therefore lands on the Chat the first attempt created rather than a second one. Nothing new is
 * stored for this: the store's own `chat_thread_already_exists` refusal is the collision signal, and the
 * durable `tavern_thread_forks` row says whether the thread it found is the same fork (same origin, same row)
 * or a key that is being reused for a different one.
 *
 * WHAT A FORK MEANS TO THE PLAYER. The origin keeps every message it had - not one row is added, moved or
 * removed - and the branch carries a COPY of the prefix, not a pointer into it. Two threads that share one
 * `continuityId` are the same conversation as far as her Memory is concerned; the confirm copy the surface
 * shows says so, because a player who branches to explore a darker path would otherwise be surprised later.
 */
export type ChatForkService = Readonly<{
  /**
   * Branches the mounted conversation at the message the handle names and answers the created Chat's
   * metadata-only list entry. It does not select it: that is `chat.select`, and keeping them apart is what
   * lets a failed switch leave a branch the player can still see and open.
   */
  fork(command: ForkChatCommandV1, idempotencyKey: string): Promise<ForkChatResultV1>;
}>;

export type ChatForkServiceOptions = Readonly<{
  /** The one durable thread store this mount already owns; this service never opens a second connection. */
  threads: Pick<ChatThreadStore, "forkThread" | "resumeThread">;
  lease: MountedChatRuntimeLease;
  /** The composed capability slice that gates `chat.fork`. */
  profile: ComposedTavernProfile;
}>;

/** The idempotency-key shape the contract's `IdempotencyKey` accepts, re-checked because it becomes an id. */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
/**
 * The two identities one key mints. They are prefixed rather than bare so a fork's ids can never collide with
 * the `chat-<hex>` / `surface-<hex>` pair `chat.create` mints, and they stay inside the store's own id alphabet
 * (`^[A-Za-z0-9_-]{1,128}$`) so they are usable as a surface-session directory name.
 */
const FORK_THREAD_PREFIX = "chat-fork-";
const FORK_SURFACE_PREFIX = "surface-fork-";

/**
 * The durable identity one idempotency key mints.
 *
 * This is the whole of the Host's idempotency for a fork: the same key always names the same pair, so a retry
 * that arrives after the first attempt committed collides with the Chat it created instead of minting a second
 * branch. Deriving it is what keeps that promise without a second durable record beside the fork's own row.
 */
export function forkIdentityFor(
  idempotencyKey: string,
): Readonly<{ chatThreadId: string; chatSurfaceSessionId: string }> {
  return Object.freeze({
    chatThreadId: `${FORK_THREAD_PREFIX}${idempotencyKey}`,
    chatSurfaceSessionId: `${FORK_SURFACE_PREFIX}${idempotencyKey}`,
  });
}

/**
 * Whether the Chat a key already names is the fork THIS request means: the same origin, cut at the same row.
 *
 * The durable `tavern_thread_forks` row is the authority, so a key reused for another point is refused rather
 * than silently answered with a branch of somewhere else.
 */
export function isReplayOfFork(
  existing: ChatThreadState,
  originChatThreadId: string,
  originMessageId: string,
): boolean {
  const forkedFrom = existing.thread.forkedFrom;
  return forkedFrom?.chatThreadId === originChatThreadId && forkedFrom.messageId === originMessageId;
}

export function createChatForkService(options: ChatForkServiceOptions): ChatForkService {
  const { threads, lease, profile } = options;
  if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
  if (!profile.routeIds.includes("chat.fork")) throw unavailable();
  const forkThread = threads.forkThread;
  if (forkThread === undefined) throw unavailable();

  return Object.freeze({
    async fork(command, idempotencyKey): Promise<ForkChatResultV1> {
      if (!isCurrentMountedChatRuntimeLease(lease)) throw unavailable();
      if (!TavernBrowserValidatorsV1.ForkChatCommandV1Schema.Check(command)) throw unavailable();
      if (typeof idempotencyKey !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) throw unavailable();
      if (command.selectionGeneration !== lease.browserProjection.selectionGeneration)
        throw new Error("chat_management_selection_conflict");
      const origin = await threads.resumeThread(lease.chatThreadId, lease.chatSurfaceSessionId);
      // The handle is a per-mount projection carrying no durable identifier, so the only read that can invert
      // it is the transcript this mount already projects. A handle this Chat does not carry is exactly that.
      const target = origin.messages.find(
        (message) => lease.browserProjection.projectMessageHandle(message.messageId) === command.messageHandle,
      );
      if (target === undefined) throw new Error("chat_fork_target_not_found");
      const { chatThreadId, chatSurfaceSessionId } = forkIdentityFor(idempotencyKey);
      // The store is the authority for every other refusal - a row it no longer carries, a turn that has not
      // reached a terminal state, the opening itself - so they are not re-decided here.
      let forked: ChatThreadState;
      try {
        forked = await forkThread({
          originChatThreadId: lease.chatThreadId,
          originMessageId: target.messageId,
          chatThreadId,
          chatSurfaceSessionId,
        });
      } catch (error) {
        if (classifyInitialChatExactContentFailure(error) !== "already_exists") throw error;
        // This key already minted a Chat. It is the answer only if that Chat is the SAME fork: the same origin,
        // cut at the same row. A key reused for another point is refused rather than silently answered with a
        // branch of somewhere else.
        forked = await replayOf(chatThreadId, chatSurfaceSessionId, target.messageId);
      }
      return projectForked(forked);
    },
  });

  async function replayOf(
    chatThreadId: string,
    chatSurfaceSessionId: string,
    originMessageId: string,
  ): Promise<ChatThreadState> {
    let existing: ChatThreadState;
    try {
      existing = await threads.resumeThread(chatThreadId, chatSurfaceSessionId);
    } catch {
      // The identity is taken by a Chat this mount cannot open exactly, which is a key collision rather than a
      // replay.
      throw new Error("idempotency_conflict");
    }
    if (!isReplayOfFork(existing, lease.chatThreadId, originMessageId)) throw new Error("idempotency_conflict");
    return existing;
  }

  function projectForked(state: ChatThreadState): ForkChatResultV1 {
    const thread = state.thread;
    const last = state.messages[state.messages.length - 1];
    const entry: ChatListEntryV1 = Object.freeze({
      handle: lease.browserProjection.projectChatHandle(thread.chatThreadId, thread.chatSurfaceSessionId),
      title: thread.title ?? null,
      status: "active" as const,
      managementRevision: thread.managementRevision ?? 1,
      // The branch is not the mounted Chat: the surface selects it with `chat.select`, exactly as it selects
      // any other row of the list.
      isSelected: false,
      updatedAtMs: thread.updatedAtMs,
      preview: chatListPreviewText(last === undefined ? null : last.text),
    });
    if (!TavernBrowserValidatorsV1.ChatListEntryV1Schema.Check(entry)) throw unavailable();
    const result: ForkChatResultV1 = Object.freeze({ apiVersion: TAVERN_BROWSER_API_VERSION, chat: entry });
    // Fail closed unless the committed representation satisfies its frozen contract schema; a partial or
    // invalid projection never escapes.
    if (!TavernBrowserValidatorsV1.ForkChatResultV1Schema.Check(result)) throw unavailable();
    return result;
  }
}

function unavailable(): Error {
  return new Error("chat_fork_unavailable");
}
