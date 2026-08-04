import { queuePendingOp } from "../../features/magic-context/storage-ops";
import { getTagsBySession } from "../../features/magic-context/storage-tags";
import { sessionLog } from "../../shared/logger";
import type { Database } from "../../shared/sqlite";
import { getRawSessionTagKeysThrough } from "./read-session-chunk";

/**
 * Queue drop ops for every tag whose source content lies inside the
 * compartment range `[1, upToMessageIndex]`.
 *
 * v3.3.1 Layer C — Finding D: pre-fix this matched tool tags by bare
 * `messageId` (= callId), so a callId reused outside the compartment
 * would match a tag inside the compartment by string equality alone.
 * Both occurrences would get queued for drop, including the live
 * out-of-range tag — silent corruption.
 *
 * Post-fix: tool tags are matched by composite identity
 * `(callId, tool_owner_message_id)`. The visible-window scan in
 * `getRawSessionTagKeysThrough` produces both the callId and the FIFO-
 * paired ownerMsgId; we drop only when both match the persisted tag.
 *
 * Legacy NULL-owner rows (pre-Layer-B-backfill data the user hasn't
 * regenerated yet) fall back to the bare-callId match. The trade-off
 * is documented in plan §Risk #20: in unbackfilled sessions a
 * collision could still wrong-drop the lowest-numbered orphan, but
 * the bug is bounded to that one tag and lazy adoption converts the
 * row to non-NULL on next observation, so the next pass behaves
 * correctly.
 */
export function queueDropsForCompartmentalizedMessages(
    db: Database,
    sessionId: string,
    upToMessageIndex: number,
): void {
    const tags = getTagsBySession(db, sessionId);
    const { messageFileKeys, toolObservations } = getRawSessionTagKeysThrough(
        sessionId,
        upToMessageIndex,
    );
    let dropsQueued = 0;

    for (const tag of tags) {
        if (tag.status !== "active") continue;

        if (tag.type === "tool") {
            const observedOwners = toolObservations.get(tag.messageId);
            if (!observedOwners) continue;

            if (tag.toolOwnerMessageId !== null) {
                // Composite-key match: tag's owner must be one of the
                // owners we observed for this callId in the visible
                // window. If not, this tag belongs to a DIFFERENT
                // assistant turn (outside the compartment) — leave it
                // active.
                if (!observedOwners.has(tag.toolOwnerMessageId)) continue;
            }
            // tag.toolOwnerMessageId === null: legacy unbackfilled row.
            // Fall back to bare-callId match (existing behavior). Plan
            // accepted trade-off documented in §Risk #20.

            queuePendingOp(db, sessionId, tag.tagNumber, "drop");
            dropsQueued += 1;
            continue;
        }

        // Message and file tags: bare contentId match (globally unique
        // within a session, no collision risk).
        if (messageFileKeys.has(tag.messageId)) {
            queuePendingOp(db, sessionId, tag.tagNumber, "drop");
            dropsQueued += 1;
        }
    }

    sessionLog(
        sessionId,
        `compartment agent: queued ${dropsQueued} drops for messages 0-${upToMessageIndex}`,
    );
}
