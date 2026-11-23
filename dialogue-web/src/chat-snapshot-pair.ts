import type { ComposedReferenceGameBrowserRootV1 } from "./composed-reference-game-browser-api";
import type { BrowserDraftV1, ReferencePipelineApi, TavernStateSnapshotV1 } from "./reference-pipeline-api";
import { ReferencePipelineSessionError } from "./reference-pipeline-session";

/**
 * The composed root and the durable draft it carries, as one read.
 *
 * The shell builds one view out of the root: `/composed-reference-game/v1/state` carries the
 * transcript, the turn and the draft's `{revision, present, text}`. It used to carry only
 * `{revision, present}`, so the shell read `/api/tavern/v1/draft` for the body and compared the two
 * answers - and the Host commits between them: accepting a player message consumes the draft
 * (`chat-thread-store.ts`: `UPDATE tavern_drafts SET revision = revision + 1, draft_content = NULL`
 * inside the acceptance transaction). A pair read while a turn was landing therefore disagreed while
 * each route was individually correct, every caller treated that as unreconcilable and committed
 * `state_reconciliation_required`, and the whole shell became the problem view.
 *
 * Measured in `shots-final64` (pinned `f28d2abb`): driver P sent its second turn, waited its full
 * budget, and read zero `li.message` rows while `/state` still served five; drivers Q/R/S/T then
 * could not find `.app-bar-actions` at all, because the shell was no longer the shell.
 *
 * The fix is not a retry: the body is in the read that already carried its revision, so there is no
 * second answer left to disagree with. `state_reconciliation_required` keeps its meaning for the
 * failures that are real - a root with no Chat half (here), and the Host's own refusals.
 */
export type ChatSnapshotPair = Readonly<{
  /** The composed root, with its Chat half narrowed: the pair is only produced when one exists. */
  root: ComposedReferenceGameBrowserRootV1 & {
    chat: { chat: NonNullable<ComposedReferenceGameBrowserRootV1["chat"]["chat"]> };
  };
  draft: BrowserDraftV1;
}>;

/**
 * The composed root with its Chat half replaced and its Game half left exactly as it stands.
 *
 * Every Chat read in the shell answers the whole aggregate: `/state` carries the conversation *and* a
 * `game` slice beside it, photographed when the request left. A read is a round trip, so a Game fact
 * that arrives inside it (`GameSurface.applyGameFact`, from the game's own channel, or the panel's own
 * `/game` read) is NEWER than that photograph - committing the photograph over it puts the panel back
 * on an older projection, and nothing in the Chat channel ever puts it forward again: the game channel
 * only speaks when the Host moves, which it has already done.
 *
 * So every Chat path replaces `chat` and keeps `root.game` from the view that is current when the read
 * LANDS. The reverse direction has its own guard (`GameSurface.rereadGame` commits the Game slice and
 * nothing else): each surface's authoritative read writes its own slice, and neither decides the
 * other's. It lives here rather than in the shell because the shell's own reads, the live event
 * stream and the fallback poll are three callers of one rule.
 */
export function withChatHalf(
  current: ComposedReferenceGameBrowserRootV1,
  read: ComposedReferenceGameBrowserRootV1,
): ComposedReferenceGameBrowserRootV1 {
  return { ...current, chat: read.chat };
}

/**
 * The draft the root's Chat half publishes, in the shape the composer and the draft commands use.
 *
 * `present` is the same fact as `text !== null` on this contract - the Host writes both from one
 * facade field (`projectSnapshotDraftV1`) - so the pair carries the body and nothing re-derives it.
 */
function committedDraft(chat: ChatSnapshotPair["root"]["chat"]["chat"]): BrowserDraftV1 {
  return { apiVersion: 1, revision: chat.draft.revision, text: chat.draft.text ?? null };
}

/**
 * The pair a root the caller already holds publishes.
 *
 * The mount is the one caller: `/bootstrap` answers this root, spends the one-time token and adopts the
 * session this page runs on, so the read it just took IS the read the pair is built from. Asking the
 * composed aggregate again would be a second answer to disagree with, and it is the answer no mount may
 * depend on (`game-projection-failure-is-not-the-chats.spec.ts` measures it).
 */
export function chatSnapshotPairFromRoot(root: ComposedReferenceGameBrowserRootV1): ChatSnapshotPair {
  const chat = root.chat.chat;
  if (chat === null) throw new ReferencePipelineSessionError("state_reconciliation_required");
  return { root: root as ChatSnapshotPair["root"], draft: committedDraft(chat) };
}

/**
 * The pair a Chat SWITCH adopts, from the route that carries the Chat half on its own.
 *
 * `/state` answers the whole aggregate, so a read of it is a read of both halves: the Host composes a
 * Game projection into the same document and refuses the document when that half cannot be produced
 * (`state_unavailable`/`game_projection_failed`, `readComposedRoot` in
 * `host/src/composed-reference-game-browser.ts`). A switch reads the Chat half and nothing else - the
 * selection it adopts and the snapshot it rebuilds its session from - so going through the aggregate
 * made a Game fault abort a switch the game has no part in: the Host had already committed the new
 * selection and made the Chat durable, and the player stayed outside the conversation
 * (`frontend--r7.stage/logs/capture.log`, driver `m`: `chat-surface=false`).
 *
 * The Chat half has a route of its own - `GET /api/tavern/v1/state`, the same
 * `TavernStateSnapshotV1` the composed root carries under `chat`, served on the composed broker's own
 * session (`composed-reference-game-static-shell-composition.test.ts` pins both against one Host). A
 * switch reads that, and takes the Game slice from the view it lands on: the same rule every other
 * Chat path applies (`withChatHalf`), and the reason a switch cannot decide the game.
 */
export function chatHalfPair(
  current: ComposedReferenceGameBrowserRootV1,
  chat: TavernStateSnapshotV1,
): ChatSnapshotPair {
  const mounted = chat.chat;
  if (mounted === null) throw new ReferencePipelineSessionError("state_reconciliation_required");
  const read: ComposedReferenceGameBrowserRootV1 = { ...current, chat };
  return { root: withChatHalf(current, read) as ChatSnapshotPair["root"], draft: committedDraft(mounted) };
}
/**
 * The snapshot, from the Chat half's own route, on the root the caller already holds.
 *
 * Every Chat read on a shell that is standing goes through here: the fallback poll, the stream's
 * recovery read and its confirmation read, the shell's own authoritative reread. The route is
 * `GET /api/tavern/v1/state` and never the aggregate, because the Host composes a Game projection into
 * that document and refuses the document when the Game half cannot be produced
 * (`state_unavailable`/`game_projection_failed`, `readComposedRoot` in
 * `host/src/composed-reference-game-browser.ts`) - so an aggregate read here made a Game fault abort a
 * conversation read the game has no part in. Measured on the mount as `problem-view=1 chat-surface=0`,
 * and in session as a Chat reread whose only retry is the same refusal.
 *
 * The Game slice is the caller's own: `chatHalfPair` replaces the Chat half of the root it is handed and
 * keeps the rest, the rule every Chat path follows. This function takes no composed client at all, so
 * there is no aggregate left for it to fall back to; a caller that needs the Game half reads it from its
 * own view (`withChatHalf`) or from the game's own route.
 */
export async function readChatSnapshotPair(
  current: ComposedReferenceGameBrowserRootV1,
  tavernApi: ReferencePipelineApi,
): Promise<ChatSnapshotPair> {
  return chatHalfPair(current, await tavernApi.readState());
}
