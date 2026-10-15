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
