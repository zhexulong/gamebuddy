/**
 * Pi-side recent-commit detector for note-nudge `commit_detected` trigger.
 *
 * Scans the last few assistant messages for a commit-hash mention paired with a
 * commit-related word IN THE SAME text part, using the shared
 * `textMentionsRecentCommit` predicate (the single source of truth, also used by
 * OpenCode's `tag-messages.ts` walk and the historian). Runs against Pi's
 * `AgentMessage[]` shape since Pi doesn't have OpenCode's MessageLike structure.
 *
 * Used inside runPipeline to fire `onNoteTrigger(db, sessionId,
 * "commit_detected")` when a NEW commit appears (i.e. one the previous
 * pass did not already see). Tracking the last-seen state lives in
 * `commitSeenLastPass` per-session, mirroring OpenCode parity.
 */

import { textMentionsRecentCommit } from "@magic-context/core/shared/commit-detection";

// We accept a broad `unknown[]` and inspect each entry defensively.
// Pi's `event.messages` from the `pi.on("context", ...)` hook is the
// canonical input. Avoiding a hard dependency on the internal
// AgentMessage type keeps this helper resilient to Pi-side type
// renames and makes it harness-agnostic.

const COMMIT_LOOKBACK = 5;

/**
 * Detect whether the recent assistant messages mention a commit hash
 * in a commit-related context. Returns `true` if any of the last
 * COMMIT_LOOKBACK assistant messages contain a 7-12 char hex string
 * paired with a commit verb in the same text part.
 */
export function detectRecentCommit(messages: unknown[]): boolean {
	let assistantsScanned = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (
			!message ||
			typeof message !== "object" ||
			!("role" in message) ||
			message.role !== "assistant"
		) {
			continue;
		}
		assistantsScanned++;
		if (assistantsScanned > COMMIT_LOOKBACK) break;

		// AgentMessage.content is an array of parts. Walk text parts
		// only — commit hashes cited in tool args/results don't count
		// (they're noisy, e.g. `git log` output dumping every commit).
		if (!("content" in message)) continue;
		const content = (message as { content: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (
				part &&
				typeof part === "object" &&
				"type" in part &&
				part.type === "text" &&
				"text" in part &&
				typeof part.text === "string"
			) {
				if (textMentionsRecentCommit(part.text)) {
					return true;
				}
			}
		}
	}
	return false;
}
