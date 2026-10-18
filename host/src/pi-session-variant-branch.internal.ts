/**
 * The Pi-side half of the two Chat operations that reshape a conversation for the model.
 *
 * One is a same-position variant turn (`branchPiVariantAnchor`), the other a rewind
 * (`branchPiTranscriptTail`). Both are the same act: Pi appends the prompt and the reply as children
 * of the current leaf, so a conversation that the player has shortened must shorten the session's
 * ACTIVE PATH too - moving the leaf is the only way to make the next request carry the transcript
 * the player reads. Both proofs refuse a session shape they cannot prove, and both hand their caller
 * a `revert()` because the store and Pi cannot be atomic.
 *
 * The variant half, in detail:
 *
 * The visible transcript and the model's context are two authorities: the
 * transcript is the store's own message row, while what a request carries is
 * Pi's own append-only session tree (`SessionManager`, `runtime-core.internal.ts`).
 * Pi appends the prompt and the reply as children of the current leaf, so
 * re-asking one player line on the same leaf would leave both the old and the
 * new reply on the path and the player's line twice. This module regenerates the
 * way the session tree itself is built: move the leaf to the entry before the
 * player's line, so the next prompt appends one fresh player line and one reply
 * there. The projection the next request carries is then exactly one player
 * line and one reply, and the reply the player replaced is off the active
 * branch instead of duplicated in it.
 *
 * TRANSITIONAL BINDING. The session-shape facts below stand in for a durable
 * Host-message-id to Pi-entry-id binding, which no authority records yet; the
 * durable owner is the prepared-response transaction and branch binding of
 * `design/archive/legacy-sources/24_TAVERN_COMPATIBILITY_IMPLEMENTATION_PLAN.md:341`.
 * Until that exists, this derivation is the only exact one available, so it
 * proves rather than guesses: the branch's newest reply must carry one of the
 * position's own committed variant texts, and the player line before it must
 * carry the exact text this turn is re-asking. A shape it cannot prove refuses,
 * and the caller must then leave the position unchanged.
 *
 * The walk consumes every consecutive `[player line, reply]` pair the position
 * owns. A session a previous same-leaf regeneration polluted
 * (`[…, P, A1, P, A2]`) is therefore cut back to before its first `P` in one
 * branch, exactly like a clean one, so the fix also repairs the shape the
 * context-edit mechanism left behind.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { chatTranscriptAssistantText } from "./native-companion-content.js";

/** Every variant text one durable reply position has committed, oldest first. */
export type PiVariantPosition = Readonly<{ variantTexts: readonly string[] }>;

/**
 * Why a refused branch left the model's context exactly as it was. Each reason
 * is a statement about the session shape a same-position turn expected and did
 * not find, so the caller refuses the visible variant instead of branching an
 * entry it cannot prove belongs to the position.
 */
type PiVariantBranchRefusal =
  | "variant_position_has_no_variant"
  | "variant_reply_tail_unavailable"
  | "variant_reply_tail_text_mismatch"
  | "variant_anchor_unavailable"
  | "rewind_nothing_dropped"
  | "rewind_tail_unavailable"
  | "rewind_tail_text_mismatch";

export type PiVariantBranchResult =
  | Readonly<{
      status: "branched";
      /**
       * Puts the leaf back where it was before this branch, so a variant that
       * never became visible leaves the model's context exactly as it found it.
       * The store and Pi cannot be atomic, so the caller owns this compensation
       * when its durable commit refuses.
       */
      revert(): void;
    }>
  | Readonly<{ status: "refused"; reason: PiVariantBranchRefusal }>;

/** The branched half of a variant branch, which its caller keeps to revert it. */
export type PiVariantBranch = Extract<PiVariantBranchResult, { status: "branched" }>;

/** The two Pi capabilities this operation needs: the session tree and its re-derivation. */
export type PiVariantBranchSession = Pick<AgentSession, "sessionManager" | "refreshContext">;

/**
 * Moves the active leaf to the entry before `anchorText`'s player line, so the
 * next prompt appends one player line and one reply there and the projection
 * carries each exactly once.
 */
export function branchPiVariantAnchor(
  session: PiVariantBranchSession,
  position: PiVariantPosition,
  anchorText: string,
): PiVariantBranchResult {
  if (position.variantTexts.length === 0) return { status: "refused", reason: "variant_position_has_no_variant" };
  const messages = branchMessageEntries(session);
  const tail = messages[messages.length - 1];
  if (tail === undefined || tail.reply === null) return { status: "refused", reason: "variant_reply_tail_unavailable" };
  if (!position.variantTexts.includes(tail.reply))
    return { status: "refused", reason: "variant_reply_tail_text_mismatch" };
  let anchor = tail;
  let cursor = messages.length - 1;
  while (cursor - 1 >= 0) {
    const player = messages[cursor - 1];
    const reply = messages[cursor];
    if (reply === undefined || reply.reply === null) break;
    if (!position.variantTexts.includes(reply.reply)) break;
    if (player === undefined || player.player !== anchorText) break;
    anchor = player;
    cursor -= 2;
  }
  if (anchor === tail) return { status: "refused", reason: "variant_anchor_unavailable" };
  return branchedTo(session, anchor.parentId);
}

/**
 * The rewind half: moves the active leaf to the entry before the first dropped message, so the
 * dropped tail leaves the model's active path and the next request carries the shortened
 * transcript exactly once.
 *
 * TRANSITIONAL BINDING, the same one `branchPiVariantAnchor` documents: no authority records which
 * Pi entry a durable `tavern_messages` row corresponds to, so the proof is positional. The session
 * branch's own newest message entries must carry the dropped messages, in order, with the exact
 * role and text the transcript holds - Pi appends the prompt the Host passed and the reply the
 * provider returned, so a healthy transcript's tail matches entry for entry. A shape it cannot
 * prove refuses, and the caller must then leave the transcript unchanged.
 *
 * The dropped messages are the named row AND every row after it, which is why the proof is a suffix
 * and not a single lookup: a session whose dropped tail is the newest thing on the branch is
 * exactly the shape a rewind leaves behind, so a second rewind from the same point still matches.
 */
export function branchPiTranscriptTail(
  session: PiVariantBranchSession,
  dropped: readonly PiTranscriptMessage[],
): PiVariantBranchResult {
  if (dropped.length === 0) return { status: "refused", reason: "rewind_nothing_dropped" };
  const messages = branchMessageEntries(session);
  if (messages.length < dropped.length) return { status: "refused", reason: "rewind_tail_unavailable" };
  const start = messages.length - dropped.length;
  for (const [offset, expected] of dropped.entries()) {
    const entry = messages[start + offset];
    const actual = expected.role === "player" ? entry?.player : entry?.reply;
    if (actual !== expected.text) return { status: "refused", reason: "rewind_tail_text_mismatch" };
  }
  // The first dropped message's parent is the last message the player keeps, so the leaf lands on
  // the kept side of the boundary; the next prompt then appends as its child.
  return branchedTo(session, messages[start]!.parentId);
}

/** One Chat transcript message a rewind drops, as the transcript itself holds it. */
export type PiTranscriptMessage = Readonly<{ role: "player" | "companion"; text: string }>;

/** The session branch's message entries in order, each with the text it contributed. */
function branchMessageEntries(session: PiVariantBranchSession): readonly Readonly<{
  parentId: string | null;
  reply: string | null;
  player: string | null;
}>[] {
  const messages: Readonly<{
    parentId: string | null;
    reply: string | null;
    player: string | null;
  }>[] = [];
  for (const entry of session.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    messages.push(
      Object.freeze({
        parentId: entry.parentId,
        reply: chatTranscriptAssistantText(entry.message),
        player: chatTranscriptPlayerText(entry.message),
      }),
    );
  }
  return messages;
}

/** Moves the leaf, and hands back the one call that puts it where it was. */
function branchedTo(session: PiVariantBranchSession, entryId: string | null): PiVariantBranch {
  const previousLeafId = session.sessionManager.getLeafId();
  branchTo(session, entryId);
  return Object.freeze({
    status: "branched",
    revert: (): void => {
      branchTo(session, previousLeafId);
    },
  });
}

function branchTo(session: PiVariantBranchSession, entryId: string | null): void {
  if (entryId === null) session.sessionManager.resetLeaf();
  else session.sessionManager.branch(entryId);
  session.refreshContext();
}

/**
 * The exact text the durable Chat transcript holds for one Pi user message, or
 * `null` when the message is not the player's own line. Pi persists the prompt
 * the Host passed (`agent-session.js` `_prepareRun`), which is the store's own
 * player row text, so the comparison is exact.
 */
function chatTranscriptPlayerText(message: unknown): string | null {
  if (typeof message !== "object" || message === null) return null;
  const value = message as { role?: unknown; content?: unknown };
  if (value.role !== "user") return null;
  if (typeof value.content === "string") return value.content.length === 0 ? null : value.content;
  if (!Array.isArray(value.content)) return null;
  const parts: string[] = [];
  for (const part of value.content) {
    if (typeof part !== "object" || part === null) continue;
    const entry = part as { type?: unknown; text?: unknown };
    if (entry.type === "text" && typeof entry.text === "string") parts.push(entry.text);
  }
  return parts.length === 0 ? null : parts.join("");
}
