/**
 * Pi pressure computation — OpenCode-equivalent semantics.
 *
 * Pi's built-in `ctx.getContextUsage()` reports a `percent` field
 * computed as `(input + output + cacheRead + cacheWrite) / contextWindow`.
 * That includes output tokens, which makes Pi's percentage drift above
 * the wire-input-only pressure OpenCode tracks. The drift is small but
 * material:
 *
 *   - Test assertions expect exact integer percentages (40, 50, …) and
 *     Pi off-by-output produces 40.1, 46.9, … on the same inputs.
 *   - The overflow-recovery path's "use detectedContextLimit for next
 *     pressure pass" contract is unimplementable if Pi keeps reporting
 *     its own percent — that field is locked to Pi's `contextWindow`
 *     from settings/models.json and cannot be re-divided by the
 *     post-overflow limit.
 *
 * The fix is to compute pressure ourselves from the latest assistant
 * message's `usage` field, exactly the way OpenCode's
 * `event-handler.ts` does:
 *
 *     inputTokens = usage.input + usage.cacheRead + usage.cacheWrite
 *     percentage  = (inputTokens / contextLimit) * 100
 *
 * The contextLimit MUST already be the output-reserved safe window, with any
 * persisted `session_meta.detected_context_limit` applied to the raw window
 * first. Callers resolve that ordering before invoking this helper, mirroring
 * OpenCode's `resolveContextLimit()` path.
 */

interface PiAssistantUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
}

export interface PiPressure {
	/** Tokens charged against contextLimit, mirroring OpenCode's pressure-input definition. */
	inputTokens: number;
	/** Percentage of contextLimit. Capped at 0 when contextLimit is unknown. */
	percentage: number;
}

/**
 * Extract `usage` from a Pi `event.message` assistant payload.
 * Pi puts the usage in `message.usage` per its AssistantMessage type.
 * Returns null when the message is not an assistant or carries no
 * usage data (aborted/error messages have no usage).
 */
export function extractAssistantUsage(
	message: unknown,
): PiAssistantUsage | null {
	if (!message || typeof message !== "object") return null;
	const m = message as { role?: unknown; usage?: unknown };
	if (m.role !== "assistant") return null;
	if (!m.usage || typeof m.usage !== "object") return null;
	const u = m.usage as Record<string, unknown>;
	const result: PiAssistantUsage = {};
	if (typeof u.input === "number") result.input = u.input;
	if (typeof u.output === "number") result.output = u.output;
	if (typeof u.cacheRead === "number") result.cacheRead = u.cacheRead;
	if (typeof u.cacheWrite === "number") result.cacheWrite = u.cacheWrite;
	if (typeof u.totalTokens === "number") result.totalTokens = u.totalTokens;
	return result;
}

/**
 * Compute OpenCode-equivalent pressure from a Pi usage payload + the
 * effective context limit. Returns null when no usage is available.
 *
 * The formula intentionally omits output tokens — they're not part of
 * the prefix sent to the next prompt, so they don't count against
 * cacheable-prefix pressure. This matches
 * `packages/plugin/src/hooks/magic-context/event-handler.ts:388-397`
 * exactly:
 *
 *     totalInputTokens = info.tokens.input + info.tokens.cache.read + info.tokens.cache.write
 */
export function computePiPressure(
	usage: PiAssistantUsage | null,
	contextLimit: number,
): PiPressure | null {
	if (!usage) return null;
	const input = usage.input ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	const cacheWrite = usage.cacheWrite ?? 0;
	const inputTokens = input + cacheRead + cacheWrite;
	if (inputTokens === 0) return null;
	const percentage = contextLimit > 0 ? (inputTokens / contextLimit) * 100 : 0;
	return { inputTokens, percentage };
}

export interface PiPressureSnapshot extends PiPressure {
	/** Usable prompt-token denominator used for both percentage and display. */
	contextLimit?: number;
}

export interface ResolvePiPressureSnapshotArgs {
	persistedPercentage: number;
	persistedInputTokens: number;
	liveInputTokens?: number | null;
	usableContextLimit?: number;
}

/**
 * Resolve one pressure pair for every Pi scheduler and display consumer.
 *
 * Pi's live estimate protects long, tool-heavy turns between assistant usage rows,
 * while the persisted input count is the provider-reported prompt-token source.
 * Whichever numerator is larger is divided by the actual usable window exactly
 * once. A separate safety-scaled denominator would make the percentage disagree
 * with the token/limit pair shown to users.
 */
export function resolvePiPressureSnapshot(
	args: ResolvePiPressureSnapshotArgs,
): PiPressureSnapshot {
	const persistedInputTokens =
		Number.isFinite(args.persistedInputTokens) && args.persistedInputTokens > 0
			? args.persistedInputTokens
			: 0;
	const liveInputTokens =
		typeof args.liveInputTokens === "number" &&
		Number.isFinite(args.liveInputTokens) &&
		args.liveInputTokens > 0
			? args.liveInputTokens
			: 0;
	const inputTokens = Math.max(persistedInputTokens, liveInputTokens);
	const contextLimit =
		typeof args.usableContextLimit === "number" &&
		Number.isFinite(args.usableContextLimit) &&
		args.usableContextLimit > 0
			? args.usableContextLimit
			: undefined;

	if (contextLimit !== undefined) {
		return {
			inputTokens,
			percentage: inputTokens > 0 ? (inputTokens / contextLimit) * 100 : 0,
			contextLimit,
		};
	}

	return {
		inputTokens: persistedInputTokens,
		percentage:
			Number.isFinite(args.persistedPercentage) && args.persistedPercentage > 0
				? args.persistedPercentage
				: 0,
	};
}

export function formatPiPressureForLog(snapshot: PiPressureSnapshot): string {
	return `usage=${snapshot.percentage.toFixed(1)}% (${snapshot.inputTokens} tokens, limit=${snapshot.contextLimit ?? "?"})`;
}
