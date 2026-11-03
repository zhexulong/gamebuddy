import type {
  ComposedReferenceGameBrowserApi,
  ComposedReferenceGameBrowserRootV1,
} from "./composed-reference-game-browser-api";
import type { BrowserDraftV1 } from "./reference-pipeline-api";
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
 * The draft the root's Chat half publishes, in the shape the composer and the draft commands use.
 *
 * `present` is the same fact as `text !== null` on this contract - the Host writes both from one
 * facade field (`projectSnapshotDraftV1`) - so the pair carries the body and nothing re-derives it.
 */
function committedDraft(chat: ChatSnapshotPair["root"]["chat"]["chat"]): BrowserDraftV1 {
  return { apiVersion: 1, revision: chat.draft.revision, text: chat.draft.text ?? null };
}

/**
 * The snapshot, from one read.
 *
 * `read` is passed in when the caller already holds a fresh read it cannot repeat: the mount's own
 * bootstrap consumed a one-time token, and a reconnect's kickoff read is the frame it is acting on.
 * Omitted, the root is read here - which is what every other caller does.
 */
export async function readChatSnapshotPair(
  composedApi: ComposedReferenceGameBrowserApi,
  read: ComposedReferenceGameBrowserRootV1 | null = null,
): Promise<ChatSnapshotPair> {
  const current = read ?? (await composedApi.readState());
  const chat = current.chat.chat;
  if (chat === null) throw new ReferencePipelineSessionError("state_reconciliation_required");
  return { root: current as ChatSnapshotPair["root"], draft: committedDraft(chat) };
}
