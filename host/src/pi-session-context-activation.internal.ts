/**
 * The Pi-side activation primitive for one player-visible Chat variant.
 *
 * The visible transcript and the model's context are two authorities: the transcript
 * is the store's own message row, while what a request carries is Pi's own
 * append-only session (`SessionManager.continueRecent`, `runtime-core.internal.ts`).
 * Pi appends every prompt and every assistant reply, so a companion replying twice
 * to one prompt leaves both replies in the session and the next request carries
 * both, while the player was shown only the active one. This module closes that
 * divergence with Pi's own mechanism instead of a second context authority: a
 * `ContextEditEntry` is an append-only, durable change to one earlier entry's
 * contribution to model context.
 *
 * `appendContextEdit` alone does not change what the model sees: it moves the
 * session leaf to the new edit entry and leaves the projection untouched until
 * something re-derives the messages. Both halves belong to this one operation,
 * because an activation that appended the edit and skipped the re-derivation
 * would look committed everywhere except in the next request.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { chatTranscriptAssistantText } from "./native-companion-content.js";

/** One activation: the superseded Pi session entry, and what replaces it. */
export type PiContextActivationTarget = Readonly<{
  /**
   * Pi session entry id of the entry whose context contribution is superseded -
   * a session entry id, never a durable store message id or a Pi message id.
   * The entry must be on the model's active branch.
   */
  targetId: string;
  /**
   * The active variant's text, or `null` to omit the entry from model context
   * entirely (a variant the player deleted contributes nothing).
   */
  replacement: string | null;
}>;

/**
 * Why a refused activation left the model's context exactly as it was. A refusal
 * is a bounded, actionable answer about the target the caller handed in; a target
 * that is present and on the branch but carries no editable model content is a
 * caller defect and propagates Pi's own error instead of being folded in here.
 */
export type PiContextActivationRefusal = "unknown_target" | "target_off_active_branch";

export type PiContextActivationResult =
  | Readonly<{ status: "activated"; contextEditEntryId: string }>
  | Readonly<{ status: "refused"; reason: PiContextActivationRefusal }>;

/**
 * The two Pi capabilities this operation needs: the session's own append-only
 * store, and the one call that re-derives the model-visible messages from it.
 * `AgentSession` satisfies this structurally.
 */
export type PiContextActivationSession = Pick<AgentSession, "sessionManager" | "refreshContext">;

/**
 * Makes the model's context carry `target.replacement` in place of the entry
 * `target.targetId` names, durably and idempotently.
 *
 * Applies the last edit per target on the active branch, so activating twice
 * leaves one effective replacement - the last one - and activating with `null`
 * omits the entry. The edit is a session entry, so it survives re-opening the
 * session from its file; the leaf alone would not, because re-opening resets the
 * leaf to the file's last entry.
 */
export function activatePiSessionContextEntry(
  session: PiContextActivationSession,
  target: PiContextActivationTarget,
): PiContextActivationResult {
  const { sessionManager } = session;
  if (sessionManager.getEntry(target.targetId) === undefined) return { status: "refused", reason: "unknown_target" };
  if (!sessionManager.getBranch().some((entry) => entry.id === target.targetId))
    return { status: "refused", reason: "target_off_active_branch" };
  const contextEditEntryId = sessionManager.appendContextEdit(
    target.targetId,
    target.replacement === null ? null : { content: target.replacement },
  );
  session.refreshContext();
  return { status: "activated", contextEditEntryId };
}

/**
 * Every variant text one durable reply position has committed, oldest first -
 * the exact set `tavern_message_swipes` holds for that position.
 */
export type PiVariantPosition = Readonly<{ variantTexts: readonly string[] }>;

/**
 * Why a same-position activation left the model's context exactly as it was.
 *
 * Each reason is a statement about the session shape a same-position turn
 * expected and did not find, so the caller can refuse the visible variant
 * instead of activating an entry it cannot prove belongs to the position.
 */
export type PiVariantActivationRefusal =
  | "variant_position_has_no_variant"
  | "variant_reply_tail_unavailable"
  | "variant_reply_tail_text_mismatch"
  | "variant_stale_reply_count_mismatch"
  | "variant_stale_reply_text_mismatch"
  | "variant_prior_content_unavailable";

export type PiVariantActivationResult =
  | Readonly<{
      status: "activated";
      contextEditEntryIds: readonly string[];
      /**
       * Puts every entry this activation changed back to the content it carried
       * before it. A variant that never became visible must leave no trace in
       * the model's history, and the pair cannot be atomic across the store and
       * Pi, so the caller owns this compensation when its durable commit refuses.
       * It refuses rather than guessing when a previous content is unavailable.
       */
      revert(): PiVariantRevertResult;
    }>
  | Readonly<{ status: "refused"; reason: PiVariantActivationRefusal | PiContextActivationRefusal }>;

export type PiVariantRevertResult =
  | Readonly<{ status: "reverted" }>
  | Readonly<{ status: "refused"; reason: "variant_revert_content_unavailable" }>;

/** The activated half of a variant activation, which its caller keeps to revert it. */
export type PiVariantActivation = Extract<PiVariantActivationResult, { status: "activated" }>;

/**
 * Makes the model's context carry `replacement` at every Pi entry the reply
 * position owns, for a position that has just re-generated its reply.
 *
 * TRANSITIONAL BINDING. The session-shape facts below stand in for a durable
 * Host-message-id to Pi-entry-id binding, which no authority records yet; the
 * durable owner is the prepared-response transaction and branch binding of
 * `design/archive/legacy-sources/24_TAVERN_COMPATIBILITY_IMPLEMENTATION_PLAN.md:341`.
 * Until that exists, this derivation is the only exact one available, so it
 * proves rather than guesses: `replacement` is the exact text this commit is
 * about to make visible and must be the branch's newest reply, and every entry
 * it edits must carry one of the position's own committed variant texts. It
 * cannot tolerate a wrong entry - any shape it cannot prove refuses, and the
 * caller must then leave the position unchanged.
 *
 * Why every earlier sibling and not just the newest one: Pi appends one reply
 * per `prompt()`, so the Nth variant of a position is the Nth assistant entry
 * that position owns. Leaving an older sibling unedited would keep the
 * superseded text in the model's history, which is the divergence this whole
 * mechanism exists to close.
 */
export function activatePiVariantPosition(
  session: PiContextActivationSession,
  position: PiVariantPosition,
  replacement: string,
): PiVariantActivationResult {
  if (position.variantTexts.length === 0) return { status: "refused", reason: "variant_position_has_no_variant" };
  const replies: Readonly<{ id: string; text: string }>[] = [];
  for (const entry of session.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const text = chatTranscriptAssistantText(entry.message);
    if (text !== null) replies.push(Object.freeze({ id: entry.id, text }));
  }
  const tail = replies[replies.length - 1];
  if (tail === undefined) return { status: "refused", reason: "variant_reply_tail_unavailable" };
  if (tail.text !== replacement) return { status: "refused", reason: "variant_reply_tail_text_mismatch" };
  const staleCount = position.variantTexts.length;
  const stale = replies.slice(replies.length - 1 - staleCount, replies.length - 1);
  if (stale.length !== staleCount) return { status: "refused", reason: "variant_stale_reply_count_mismatch" };
  for (const entry of stale)
    if (!position.variantTexts.includes(entry.text))
      return { status: "refused", reason: "variant_stale_reply_text_mismatch" };
  const contextEditEntryIds: string[] = [];
  const previous: Readonly<{ targetId: string; content: string }>[] = [];
  for (const entry of stale) {
    const prior = effectiveAssistantText(session, entry.id);
    if (prior === null) return { status: "refused", reason: "variant_prior_content_unavailable" };
    const activated = activatePiSessionContextEntry(session, { targetId: entry.id, replacement });
    if (activated.status === "refused") return { status: "refused", reason: activated.reason };
    previous.push(Object.freeze({ targetId: entry.id, content: prior }));
    contextEditEntryIds.push(activated.contextEditEntryId);
  }
  return Object.freeze({
    status: "activated",
    contextEditEntryIds: Object.freeze(contextEditEntryIds),
    revert: (): PiVariantRevertResult => {
      for (const entry of previous) {
        const reverted = activatePiSessionContextEntry(session, {
          targetId: entry.targetId,
          replacement: entry.content,
        });
        if (reverted.status === "refused") return { status: "refused", reason: "variant_revert_content_unavailable" };
      }
      return { status: "reverted" };
    },
  });
}

/**
 * The text one entry contributed to the model's context, edits and omissions
 * included: the value this activation must restore if the variant it made room
 * for never becomes visible. It is the projection's own content, not the
 * transcript projection, because the restore has to reproduce exactly what the
 * request carried rather than re-derive a durable row from it.
 */
function effectiveAssistantText(session: PiContextActivationSession, targetId: string): string | null {
  const projected = session.sessionManager
    .buildSessionProjection()
    .entries.find((entry) => entry.sourceEntry.id === targetId);
  if (projected === undefined) return null;
  const parts: string[] = [];
  for (const message of projected.messages) {
    if ((message as { role?: unknown }).role !== "assistant") continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part !== "object" || part === null) continue;
      const value = part as { type?: unknown; text?: unknown };
      if (value.type === "text" && typeof value.text === "string") parts.push(value.text);
    }
  }
  const joined = parts.join("");
  return joined.length === 0 ? null : joined;
}
