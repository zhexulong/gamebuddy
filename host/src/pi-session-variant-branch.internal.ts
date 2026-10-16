/**
 * The Pi-side half of one same-position Chat variant turn.
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
  | "variant_anchor_unavailable";

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
  const previousLeafId = session.sessionManager.getLeafId();
  branchTo(session, anchor.parentId);
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
