/**
 * Pi dropped-placeholder stripping — mirrors OpenCode's
 * `stripDroppedPlaceholderMessages` plus persisted
 * `session_meta.stripped_placeholder_ids` replay.
 *
 * OpenCode replaces placeholder-only messages with sentinel shells to
 * keep provider-cache array structure stable. Pi rebuilds `AgentMessage[]`
 * from JSONL on every pass, so the Pi-native operation is simpler: remove
 * messages whose only model-visible content is `[dropped §N§]` after
 * `applyFlushedStatuses` has replayed dropped tag state.
 *
 * Replay is persistent and runs on every pass from stable Pi message ids.
 * Discovery of new placeholder-only ids happens only on cache-busting
 * passes, matching OpenCode's "discover on execute, replay everywhere"
 * contract.
 */

import type { ContextDatabase } from "@magic-context/core/features/magic-context/storage";
import {
	applyStrippedPlaceholderDelta,
	getStrippedPlaceholderIds,
} from "@magic-context/core/features/magic-context/storage";
import { sessionLog } from "@magic-context/core/shared/logger";
import { resolvePiStableId } from "./read-session-pi";

const DROPPED_SEGMENT_PATTERN = /^\[dropped(?: §[^§]+§)?\]$/;

function isDroppedOnlyText(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed.length === 0) return true;
	const segments = trimmed
		.split(/(?=\[dropped(?: §[^§]+§)?\])/)
		.map((segment) => segment.trim())
		.filter((segment) => segment.length > 0);
	return (
		segments.length > 0 &&
		segments.every((s) => DROPPED_SEGMENT_PATTERN.test(s))
	);
}

function messageIsPlaceholderOnly(message: unknown): boolean {
	if (!message || typeof message !== "object") return false;
	const msg = message as { role?: unknown; content?: unknown };
	// Only assistant messages may be neutralized/removed. User-role messages
	// anchor turn boundaries the AI SDK relies on to avoid merging consecutive
	// assistants — removing one can collapse a boundary. Mirrors OpenCode's
	// strip-content.ts ("Never neutralize user-role messages — they anchor turn
	// boundaries"). In Pi's raw array, tool results carry role "toolResult"
	// (synthetic tool-result user folds live only in the transcript view, never
	// written back to this array), so genuine user prompts are the only user-role
	// entries here — never all-[dropped] — making this a safe parity guard.
	if (msg.role !== "assistant") return false;

	if (typeof msg.content === "string") return isDroppedOnlyText(msg.content);
	if (!Array.isArray(msg.content)) return false;
	if (msg.content.length === 0) return false;

	let sawVisibleContent = false;
	for (const part of msg.content) {
		if (!part || typeof part !== "object") return false;
		const p = part as { type?: unknown; text?: unknown };
		if (p.type !== "text") return false;
		if (typeof p.text !== "string") return false;
		sawVisibleContent = true;
		if (!isDroppedOnlyText(p.text)) return false;
	}
	return sawVisibleContent;
}

export interface StripPiDroppedPlaceholderResult {
	removed: number;
	discovered: number;
}

export function stripPiDroppedPlaceholderMessages(args: {
	db: ContextDatabase;
	sessionId: string;
	messages: unknown[];
	isCacheBusting: boolean;
	/**
	 * Carried stable-id map keyed by message object reference, built by the caller
	 * POST-commit / PRE-injection (see context-handler). This runs AFTER
	 * injectM0M1Pi splices the array, so positional index→id is stale; object
	 * identity survives the splice. Skip-on-miss: the only legitimate misses are
	 * injection's synthetic m[0]/m[1] prepends (never placeholders).
	 */
	stableIdByRef?: ReadonlyMap<object, string>;
	/**
	 * Force placeholder rediscovery regardless of isCacheBusting. Set on the
	 * stable-id-scheme cutover pass so previously-stripped placeholders get
	 * re-keyed under the new scheme (discovery is otherwise history-refresh-gated).
	 */
	forceDiscovery?: boolean;
	/** Test seam for exhausting the durable CAS write. */
	applyDelta?: typeof applyStrippedPlaceholderDelta;
}): StripPiDroppedPlaceholderResult {
	const { db, sessionId, messages, isCacheBusting, stableIdByRef } = args;
	const persistedIds = getStrippedPlaceholderIds(db, sessionId);
	const idsToStrip = new Set(persistedIds);

	const idOf = (msg: unknown, index: number): string | undefined => {
		const m = msg && typeof msg === "object" ? (msg as object) : undefined;
		const carried = m ? stableIdByRef?.get(m) : undefined;
		if (typeof carried === "string" && carried.length > 0) return carried;
		if (stableIdByRef) return undefined;
		return resolvePiStableId(msg, index);
	};

	const canPrune =
		(isCacheBusting || args.forceDiscovery === true) && !!stableIdByRef;
	const presentIds = canPrune ? new Set<string>() : null;
	const discoveredIds: string[] = [];
	if (isCacheBusting || args.forceDiscovery) {
		for (let i = 0; i < messages.length; i++) {
			const id = idOf(messages[i], i);
			if (!id) continue;
			presentIds?.add(id);
			if (messageIsPlaceholderOnly(messages[i]) && !persistedIds.has(id)) {
				discoveredIds.push(id);
			}
		}
	}

	const removedIds: string[] = [];
	if (presentIds) {
		for (const id of persistedIds) {
			if (!presentIds.has(id)) removedIds.push(id);
		}
	}

	let discovered = 0;
	let pruned = 0;
	if (discoveredIds.length > 0 || removedIds.length > 0) {
		const persisted = (args.applyDelta ?? applyStrippedPlaceholderDelta)(
			db,
			sessionId,
			{
				add: discoveredIds,
				remove: removedIds,
			},
		);
		if (persisted) {
			// Bytes ship only after their replay state is durable. If the CAS fails,
			// replay the old frozen set and retry discovery on the next busting pass.
			for (const id of discoveredIds) idsToStrip.add(id);
			for (const id of removedIds) idsToStrip.delete(id);
			discovered = discoveredIds.length;
			pruned = removedIds.length;
		} else {
			sessionLog(
				sessionId,
				"placeholder strip: persistence failed; leaving newly discovered messages intact",
			);
		}
	}

	let removed = 0;
	for (let i = messages.length - 1; i >= 0; i--) {
		const id = idOf(messages[i], i);
		if (!id || !idsToStrip.has(id)) continue;
		messages.splice(i, 1);
		removed++;
	}

	if (removed > 0 || discovered > 0 || pruned > 0) {
		sessionLog(
			sessionId,
			`placeholder strip: removed=${removed} discovered=${discovered} pruned=${pruned}`,
		);
	}
	return { removed, discovered };
}
