import { afterEach, describe, expect, it } from "bun:test";
import { resolveProjectIdentity } from "@magic-context/core/features/magic-context/memory/project-identity";
import { createScheduler } from "@magic-context/core/features/magic-context/scheduler";
import {
	getOrCreateSessionMeta,
	updateSessionMeta,
} from "@magic-context/core/features/magic-context/storage";
import { setOutputReserveConfig } from "@magic-context/core/shared/models-dev-cache";
import { closeQuietly } from "@magic-context/core/shared/sqlite-helpers";

import { buildPiStatusDetail } from "./dialogs/status-dialog";
import {
	formatPiPressureForLog,
	resolvePiPressureSnapshot,
} from "./pi-pressure";
import { renderStatusText } from "./status-line";
import { createTestDb, fakeContext } from "./test-utils.test";

const RAW_WINDOW = 272_000;
const OUTPUT_RESERVE = 24_576;
const USABLE_WINDOW = 247_424;

function reporterContext(sessionId: string, tokens: number) {
	return {
		...fakeContext(sessionId),
		model: {
			provider: "openai-codex",
			id: "gpt-5.6-sol",
			contextWindow: RAW_WINDOW,
			maxTokens: 128_000,
		},
		getContextUsage: () => ({
			tokens,
			percent: (tokens / RAW_WINDOW) * 100,
			contextWindow: RAW_WINDOW,
		}),
		getSystemPrompt: () => "system prompt",
	};
}

describe("Pi pressure alignment (#385)", () => {
	afterEach(() => setOutputReserveConfig(undefined));

	it("uses the reporter's exact token/window pair for scheduler, status, footer, and logs", () => {
		setOutputReserveConfig({ default: OUTPUT_RESERVE });
		const db = createTestDb();
		const sessionId = "ses-issue-385-exact";
		try {
			const inputTokens = 192_162;
			const expectedPercentage = (inputTokens / USABLE_WINDOW) * 100;
			updateSessionMeta(db, sessionId, {
				lastResponseTime: Date.now(),
				cacheTtl: "never",
				lastInputTokens: inputTokens,
				lastContextPercentage: expectedPercentage,
			});
			const pressure = resolvePiPressureSnapshot({
				persistedPercentage: expectedPercentage,
				persistedInputTokens: inputTokens,
				liveInputTokens: inputTokens,
				usableContextLimit: USABLE_WINDOW,
			});
			const scheduler = createScheduler({ executeThresholdPercentage: 90 });
			const schedulerDecision = scheduler.shouldExecute(
				getOrCreateSessionMeta(db, sessionId),
				pressure,
				Date.now(),
				sessionId,
				"openai-codex/gpt-5.6-sol",
				USABLE_WINDOW,
			);
			const ctx = reporterContext(sessionId, inputTokens);
			const detail = buildPiStatusDetail(
				{ getAllTools: () => [] } as never,
				ctx as never,
				{
					db,
					projectIdentity: resolveProjectIdentity(process.cwd()),
				},
				sessionId,
			);
			const footer = renderStatusText(ctx as never, db, sessionId);
			const logPressure = formatPiPressureForLog(pressure);

			expect(pressure.contextLimit).toBe(USABLE_WINDOW);
			expect(pressure.percentage).toBeCloseTo(expectedPercentage, 10);
			expect(detail.contextLimit).toBe(USABLE_WINDOW);
			expect(detail.inputTokens).toBe(inputTokens);
			expect(detail.usagePercentage).toBeCloseTo(expectedPercentage, 10);
			expect(footer).toContain("mc: 192.2K (78%)");
			expect(logPressure).toBe("usage=77.7% (192162 tokens, limit=247424)");
			expect(schedulerDecision).toBe("defer");
		} finally {
			closeQuietly(db);
		}
	});

	it("keeps the second specimen below the force band and crosses 90% on the same numerator", () => {
		const db = createTestDb();
		try {
			const scheduler = createScheduler({ executeThresholdPercentage: 90 });
			const meta = {
				...getOrCreateSessionMeta(db, "ses-issue-385-threshold"),
				lastResponseTime: Date.now(),
				cacheTtl: "never",
			};
			const below = resolvePiPressureSnapshot({
				persistedPercentage: (196_210 / USABLE_WINDOW) * 100,
				persistedInputTokens: 196_210,
				liveInputTokens: 196_210,
				usableContextLimit: USABLE_WINDOW,
			});
			const aboveTokens = Math.ceil(USABLE_WINDOW * 0.9);
			const above = resolvePiPressureSnapshot({
				persistedPercentage: 0,
				persistedInputTokens: aboveTokens,
				liveInputTokens: aboveTokens,
				usableContextLimit: USABLE_WINDOW,
			});

			expect(below.percentage).toBeCloseTo((196_210 / USABLE_WINDOW) * 100, 10);
			expect(below.percentage).toBeCloseTo(79.3, 1);
			expect(below.percentage).toBeLessThan(92);
			expect(scheduler.shouldExecute(meta, below)).toBe("defer");
			expect(scheduler.shouldExecute(meta, above)).toBe("execute");
		} finally {
			closeQuietly(db);
		}
	});
});
