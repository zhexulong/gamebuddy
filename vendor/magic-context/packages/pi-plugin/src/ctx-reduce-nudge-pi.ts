// Pi parity for the ctx_reduce nudge redesign (Channels 1 & 2).
//
// The metric math is fully shared from `@magic-context/core` — only the
// harness-specific I/O differs:
//
//   Channel 1 (in-turn tool-output nudge): OpenCode appends to a tool's
//   `output.output` string in `tool.execute.after`; Pi appends a TextContent
//   block to a `toolResult.content[]` in `pi.on("tool_result")`. Both persist
//   (OpenCode→DB, Pi→JSONL via `appendMessage` on `message_end`) and replay
//   verbatim, so both are "free sticky" with no anchor/CAS/replay machinery.
//
//   Channel 2 (ceiling nudge): OpenCode delivers via the in-process client's
//   `promptAsync` (which joins the in-flight runner on OpenCode >= 1.17.7). Pi
//   is single-process, so it just calls the native `pi.sendMessage(..., {
//   deliverAs })` as a hidden custom message (`display:false`). The
//   `channel2_nudge_state` lease is kept both to enforce the one-nudge-per-
//   session cap and because the intent is recorded at one point in the pipeline
//   but delivered later, when a `tool_result` or `agent_end` event arrives.

import {
	casChannel2NudgeState,
	getChannel2NudgeState,
	getLastNudgeLevel,
	getLastNudgeUndropped,
	resetLastNudgeCycle,
	setChannel2NudgeState,
	setLastNudgeLevel,
	setLastNudgeUndropped,
} from "@magic-context/core/features/magic-context/storage";
import {
	buildChannel1Reminder,
	buildChannel2Reminder,
	CHANNEL1_SENTINEL,
	type Channel1State,
	computePressure,
	decideChannel1,
	isDroppedToolOutput,
	shouldTriggerChannel2,
	type TailTokenEstimate,
	tailToolTokensFromStrings,
	toolOutputTokens,
} from "@magic-context/core/hooks/magic-context/ctx-reduce-nudge";
import { sessionLog } from "@magic-context/core/shared/logger";
import type { Database } from "@magic-context/core/shared/sqlite";

export type { Channel1State };

function sealDeliveredAfterUnconfirmedSend(
	db: Database,
	sessionId: string,
): "already-delivered" | "sealed" | "stuck-claimed" {
	try {
		if (getChannel2NudgeState(db, sessionId) === "delivered") {
			return "already-delivered";
		}
	} catch {
		// Best-effort probe only — if the read fails, still try to seal the cap.
	}

	try {
		setChannel2NudgeState(db, sessionId, "delivered");
		return "sealed";
	} catch {
		// Preserve the stale claim so the shared TTL heal can recover it later.
		return "stuck-claimed";
	}
}

// Per-session Channel 1 metric baseline. Written at the end of each pipeline
// pass (post-drop), read in the `tool_result` handler. Primary-only: subagents
// never get a baseline, which is how Channel 1 stays off for them (matches
// OpenCode's `channel1StateBySession` gating).
const channel1StateBySession = new Map<string, Channel1State>();

export function setPiChannel1Baseline(
	sessionId: string,
	state: Channel1State,
): void {
	channel1StateBySession.set(sessionId, state);
}

export function getPiChannel1Baseline(
	sessionId: string,
): Channel1State | undefined {
	return channel1StateBySession.get(sessionId);
}

export function clearPiChannel1State(sessionId: string): void {
	channel1StateBySession.delete(sessionId);
}

/** Mark that the agent ran ctx_reduce since the last baseline refresh (suppress self-nag). */
export function markPiChannel1Reduced(sessionId: string, db?: Database): void {
	const state = channel1StateBySession.get(sessionId);
	if (state) state.reducedSinceRefresh = true;
	if (db) resetLastNudgeCycle(db, sessionId);
}

interface PiTextContent {
	type: "text";
	text: string;
}

function isPiTextContent(c: unknown): c is PiTextContent {
	return (
		c !== null &&
		typeof c === "object" &&
		(c as { type?: unknown }).type === "text" &&
		typeof (c as { text?: unknown }).text === "string"
	);
}

/** Concatenated text of a `toolResult.content[]` (image blocks ignored). */
function toolResultText(content: readonly unknown[]): string {
	let text = "";
	for (const c of content) {
		if (isPiTextContent(c)) text += c.text;
	}
	return text;
}

/**
 * Sum approximate tokens of non-dropped tool output across Pi messages. Pi tool
 * output lives in `toolResult.content[].text` (not OpenCode's
 * `parts[].state.output`); the math is the shared `tailToolTokensFromStrings`.
 * `messages` is the post-injection wire array, already trimmed to the live tail.
 */
export function computeTailToolTokensPi(messages: readonly unknown[]): number {
	const outputs: string[] = [];
	for (const m of messages) {
		if (
			m !== null &&
			typeof m === "object" &&
			(m as { role?: unknown }).role === "toolResult"
		) {
			const content = (m as { content?: unknown }).content;
			if (Array.isArray(content)) outputs.push(toolResultText(content));
		}
	}
	return tailToolTokensFromStrings(outputs);
}

function jsonTokens(value: unknown): number {
	if (value === undefined || value === null) return 0;
	try {
		return toolOutputTokens(JSON.stringify(value));
	} catch {
		return 0;
	}
}

function textTokens(content: unknown): number {
	if (typeof content === "string") return toolOutputTokens(content);
	if (!Array.isArray(content)) return 0;
	let tokens = 0;
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const p = part as { type?: unknown; text?: unknown; thinking?: unknown };
		if (typeof p.text === "string") tokens += toolOutputTokens(p.text);
		else if (typeof p.thinking === "string")
			tokens += toolOutputTokens(p.thinking);
		else if (p.type === "image") tokens += 1200;
	}
	return tokens;
}

export function computeTailTokenEstimatePi(
	messages: readonly unknown[],
): TailTokenEstimate {
	let tailToolTokens = 0;
	let liveTailTokens = 0;
	for (const raw of messages) {
		if (!raw || typeof raw !== "object") continue;
		const msg = raw as { role?: unknown; content?: unknown };
		if (msg.role === "toolResult") {
			const outputText = Array.isArray(msg.content)
				? toolResultText(msg.content)
				: typeof msg.content === "string"
					? msg.content
					: "";
			const outputTokens =
				outputText && !isDroppedToolOutput(outputText)
					? toolOutputTokens(outputText)
					: 0;
			tailToolTokens += outputTokens;
			liveTailTokens += outputTokens;
			continue;
		}
		if (msg.role === "assistant" && Array.isArray(msg.content)) {
			for (const part of msg.content) {
				if (!part || typeof part !== "object") continue;
				const p = part as {
					type?: unknown;
					name?: unknown;
					arguments?: unknown;
				};
				if (p.type === "toolCall") {
					if (typeof p.name === "string")
						liveTailTokens += toolOutputTokens(p.name);
					liveTailTokens += jsonTokens(p.arguments);
				}
			}
		}
		liveTailTokens += textTokens(msg.content);
	}
	return { tailToolTokens, liveTailTokens };
}

/**
 * Channel 1 decision for a just-finished tool result. Returns the reminder
 * TextContent block to append (so the caller's `tool_result` handler can return
 * `{ content: [...event.content, block] }`), or null when no nudge should fire.
 * `toolName` of `ctx_reduce` short-circuits to suppression (the agent is
 * actively managing context) — mirrors OpenCode's `tool.execute.after` branch.
 */
export function maybeChannel1ReminderForToolResult(args: {
	db: Database;
	sessionId: string;
	toolName: string;
	content: readonly unknown[];
}): PiTextContent | null {
	const { db, sessionId, toolName } = args;
	const state = channel1StateBySession.get(sessionId);
	if (!state) return null; // primary-only: no baseline ⇒ subagent ⇒ off

	if (toolName === "ctx_reduce") {
		state.reducedSinceRefresh = true;
		resetLastNudgeCycle(db, sessionId);
		return null;
	}

	const text = toolResultText(args.content);
	if (text.length === 0) return null;
	// Content-based idempotency (bare `<system-reminder>` opener is the marker).
	if (text.includes(CHANNEL1_SENTINEL)) return null;

	// Accumulate this tool's tokens into the per-turn accumulator (prospective:
	// not yet reflected in the baseline tail snapshot).
	state.turnToolTokens += toolOutputTokens(text);

	if (state.reducedSinceRefresh) return null;

	const undroppedTokens = state.tailToolTokens + state.turnToolTokens;
	const pressure = computePressure({
		lastInputTokens: state.lastInputTokens,
		turnToolTokens: state.turnToolTokens,
		contextLimit: state.contextLimit,
		executeThresholdPercentage: state.executeThresholdPercentage,
	});

	const workingWindowTokens = Math.round(
		(state.contextLimit * state.executeThresholdPercentage) / 100,
	);
	const decision = decideChannel1({
		undroppedTokens,
		pressure,
		estimatedInputTokens: state.lastInputTokens + state.turnToolTokens,
		workingWindowTokens,
		lastNudgeUndropped: getLastNudgeUndropped(db, sessionId),
		lastNudgeLevel: getLastNudgeLevel(db, sessionId),
		hasRecentReduce: false, // handled by reducedSinceRefresh above
	});

	setLastNudgeUndropped(db, sessionId, decision.nextLastNudge);
	setLastNudgeLevel(db, sessionId, decision.nextLastNudgeLevel);
	if (!decision.fire) return null;

	return {
		type: "text",
		text: buildChannel1Reminder(
			decision.level,
			decision.undroppedTokens,
			state.oldestReclaimableToolTags,
		),
	};
}

/**
 * Minimal shape of the Pi API needed to deliver a Channel 2 ceiling nudge.
 * Uses `sendMessage` (custom message) rather than `sendUserMessage` so the nudge
 * can render `display: false` — hidden from the Pi TUI while still reaching the
 * model (Pi converts a `role:"custom"` entry to a model-visible user message via
 * `convertToLlm`). This is the Pi parity for OpenCode marking the same nudge
 * `synthetic: true`: an agent-directed steer should drive the run + reach the
 * model but NOT show up as a literal user turn the user didn't type. Available
 * since published pi-coding-agent 0.74.0 (our floor); MC already uses
 * `sendMessage` for /ctx-status.
 */
interface PiSendMessage {
	sendMessage: (
		message: {
			customType: string;
			content: string;
			display: boolean;
			details?: unknown;
		},
		options?: { deliverAs?: "steer" | "followUp"; triggerTurn?: boolean },
	) => void;
}

const CHANNEL2_NUDGE_CUSTOM_TYPE = "magic-context:ceiling-nudge";

/**
 * Deliver a pending Channel 2 ceiling nudge for `sessionId`, if any. Safe to
 * call from BOTH delivery sites; no-ops unless a `pending` intent exists. Pi
 * is single-process so delivery coalesces natively — no #28202 workaround.
 * Delivered as a hidden custom message (`sendMessage` + `display:false`) so it
 * reaches the model but isn't presented as a literal user turn.
 *
 * Delivery sites + mode:
 * - `tool_result` (mid-turn, the primary site): deliverAs "steer" — Pi queues
 *   the message and the agent loop pulls it at the NEXT STEP boundary, so the
 *   agent is warned while the pile is still growing and can act THIS turn.
 *   Waiting for idle would deliver the warning after all the growth happened.
 * - `agent_end` (idle fallback): catches the intent when the turn ended before
 *   a tool boundary could deliver it; deliverAs "followUp" starts a fresh turn.
 *
 * Lease: pending → claimed → delivered (revert to pending on failure so a
 * transient error doesn't burn the one-shot cap). Returns true on delivery.
 */
export function maybeDeliverChannel2Pi(
	pi: PiSendMessage,
	db: Database,
	sessionId: string,
	deliverAs: "steer" | "followUp" = "followUp",
): boolean {
	let state: string;
	try {
		state = getChannel2NudgeState(db, sessionId);
	} catch {
		return false;
	}
	if (state !== "pending") return false;

	// Revalidate before delivering (parity with OpenCode channel2-delivery).
	// The `pending` intent was recorded at high pressure during a context pass;
	// by this agent_end the agent may have run ctx_reduce (markPiChannel1Reduced
	// + the next pass refreshes the baseline), so the ceiling condition may no
	// longer hold. Firing anyway injects a stale follow-up AND burns the
	// one-per-session cap.
	//
	// Two rules, both cap-preserving (mirrors OpenCode):
	// - UNKNOWN baseline → do NOT deliver, do NOT touch the lease: leave
	//   `pending` for a later agent_end with a real measurement. Never
	//   substitute a default and burn the cap on an unvalidated condition.
	// - KNOWN baseline → re-run the FULL trigger predicate (floor AND the
	//   reclaimable ≥ usable/3 ratio that armed the intent), not just the
	//   floor. Predicate false → cancel to '' (re-armable).
	const baseline = channel1StateBySession.get(sessionId);
	if (!baseline) return false;
	if (baseline.reducedSinceRefresh) return false;
	const undropped = baseline.tailToolTokens + baseline.turnToolTokens;
	if (
		!shouldTriggerChannel2({
			reclaimableTokens: undropped,
			usableTokens: baseline.usableTokens,
		})
	) {
		try {
			casChannel2NudgeState(db, sessionId, "pending", "");
		} catch {
			// best-effort; next pass re-evaluates.
		}
		return false;
	}

	if (!casChannel2NudgeState(db, sessionId, "pending", "claimed")) return false;

	try {
		// display: false → hidden from the Pi TUI (agent steer, not a user turn),
		// but still model-visible via convertToLlm. deliverAs preserves the
		// existing scheduling (steer mid-turn / followUp at agent_end).
		pi.sendMessage(
			{
				customType: CHANNEL2_NUDGE_CUSTOM_TYPE,
				content: buildChannel2Reminder(
					undropped,
					baseline.oldestReclaimableToolTags,
				),
				display: false,
				details: { kind: "channel-2-ceiling-nudge" },
			},
			{ deliverAs },
		);
	} catch (error) {
		try {
			casChannel2NudgeState(db, sessionId, "claimed", "pending");
		} catch (revertError) {
			sessionLog(
				sessionId,
				"channel2 ceiling nudge delivery failed; pending restore was busy so the stale claim will heal later:",
				{ deliveryError: error, revertError },
			);
			return false;
		}
		sessionLog(
			sessionId,
			"channel2 ceiling nudge delivery failed (will retry):",
			error,
		);
		return false;
	}

	try {
		const confirmed = casChannel2NudgeState(
			db,
			sessionId,
			"claimed",
			"delivered",
		);
		if (confirmed) {
			sessionLog(sessionId, "channel2 ceiling nudge delivered");
			return true;
		}

		const outcome = sealDeliveredAfterUnconfirmedSend(db, sessionId);
		if (outcome === "already-delivered") {
			sessionLog(
				sessionId,
				"channel2 ceiling nudge duplicate window: our send returned after a sibling reclaimed the stale lease and already delivered",
			);
		} else if (outcome === "sealed") {
			sessionLog(
				sessionId,
				"channel2 ceiling nudge sent but claim confirmation was lost; sealed delivered without an authoritative confirm",
			);
		} else {
			sessionLog(
				sessionId,
				"channel2 ceiling nudge sent but claim confirmation was lost; lease stayed claimed and will heal later",
			);
		}
		return false;
	} catch (error) {
		// The nudge has already been handed to Pi; never re-arm on a post-send
		// confirm failure, or a transient DB error can duplicate the one-shot cap.
		const outcome = sealDeliveredAfterUnconfirmedSend(db, sessionId);
		if (outcome === "already-delivered") {
			sessionLog(
				sessionId,
				"channel2 ceiling nudge duplicate window: our send returned after a sibling reclaimed the stale lease and already delivered",
			);
		} else if (outcome === "sealed") {
			sessionLog(
				sessionId,
				"channel2 ceiling nudge sent but confirm failed:",
				error,
			);
		} else {
			sessionLog(
				sessionId,
				"channel2 ceiling nudge sent but confirm failed; lease stayed claimed and will heal later:",
				error,
			);
		}
		return false;
	}
}
