import type { ComposedReferenceGameBrowserApi, ComposedReferenceGameBrowserRootV1 } from "./composed-reference-game-browser-api";
import type { BrowserDraftV1, ReferencePipelineApi } from "./reference-pipeline-api";
import { ReferencePipelineSessionError } from "./reference-pipeline-session";

/**
 * The composed root and the durable draft read as one reconciled pair.
 *
 * The shell builds one view out of two routes: `/composed-reference-game/v1/state` carries the
 * transcript, the turn and the draft's `{revision, present}`, and `/api/tavern/v1/draft` carries the
 * draft itself. Both are projections of the same durable record, but they are two reads, and the
 * Host commits between them - accepting a player message consumes the draft
 * (`chat-thread-store.ts`: `UPDATE tavern_drafts SET revision = revision + 1, draft_content = NULL`
 * inside the acceptance transaction). So a pair read while a turn is landing can disagree while each
 * route is individually correct, and every call site that compared them treated that as an
 * unreconcilable state: it committed `state_reconciliation_required` and the whole shell became the
 * problem view.
 *
 * Measured in `shots-final64` (pinned `f28d2abb`): driver P sent its second turn, waited its full
 * budget, and read zero `li.message` rows while `/state` still served five; drivers Q/R/S/T then
 * could not find `.app-bar-actions` at all, because the shell was no longer the shell. The failure
 * is not a state fault - a re-read of the same authority agrees - so the fix belongs here rather
 * than in the panel that renders the sentence.
 *
 * What this preserves, and why it is not a retry of a side effect: both routes are pure reads. A
 * pair that disagrees only because something committed in between is settled by reading the pair
 * again; a pair that still disagrees after `PAIR_READ_ATTEMPTS` is a real conflict between what the
 * two projections say, and it still fails closed with `state_reconciliation_required`.
 *
 * `held` is the draft this surface already committed. When it agrees with the root's own draft
 * revision, the read-back is skipped entirely - that is the fallback poll's one optimisation, so a
 * hop with nothing to learn still costs a single request.
 */
const PAIR_READ_ATTEMPTS = 2;

export type ChatSnapshotPair = Readonly<{
  /** The composed root, with its Chat half narrowed: the pair is only produced when one exists. */
  root: ComposedReferenceGameBrowserRootV1 & { chat: { chat: NonNullable<ComposedReferenceGameBrowserRootV1["chat"]["chat"]> } };
  draft: BrowserDraftV1;
}>;

function agrees(draft: BrowserDraftV1, chatDraft: Readonly<{ revision: number; present: boolean }>): boolean {
  return draft.revision === chatDraft.revision && (draft.text !== null) === chatDraft.present;
}

/**
 * The pair, read from both routes and reconciled.
 *
 * `root` is passed in when the caller already holds a fresh read it cannot repeat: the mount's own
 * bootstrap consumed a one-time token, and a reconnect's kickoff read is the frame it is acting on.
 * Omitted, the root is read here - which is what every other caller does.
 */
export async function readChatSnapshotPair(
  composedApi: ComposedReferenceGameBrowserApi,
  tavernApi: ReferencePipelineApi,
  held: BrowserDraftV1 | null = null,
  read: ComposedReferenceGameBrowserRootV1 | null = null,
): Promise<ChatSnapshotPair> {
  let root = read;
  for (let attempt = 0; attempt < PAIR_READ_ATTEMPTS; attempt += 1) {
    const current: ComposedReferenceGameBrowserRootV1 = root ?? (await composedApi.readState());
    const chat = current.chat.chat;
    if (chat === null) throw new ReferencePipelineSessionError("state_reconciliation_required");
    const mounted = current as ChatSnapshotPair["root"];
    if (held !== null && agrees(held, chat.draft)) return { root: mounted, draft: held };
    const draft = await tavernApi.readDraft();
    if (agrees(draft, chat.draft)) return { root: mounted, draft };
    // The pair disagreed, so nothing read on this attempt may be trusted: the next attempt starts
    // from a root read taken after the draft read that disagreed with it.
    root = null;
  }
  throw new ReferencePipelineSessionError("state_reconciliation_required");
}
