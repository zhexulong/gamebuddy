import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	getChannel2NudgeClaimedAt,
	getChannel2NudgeState,
	setChannel2NudgeState,
} from "@magic-context/core/features/magic-context/storage";
import * as loggerModule from "@magic-context/core/shared/logger";
import {
	clearPiChannel1State,
	computeTailTokenEstimatePi,
	computeTailToolTokensPi,
	maybeChannel1ReminderForToolResult,
	maybeDeliverChannel2Pi,
	setPiChannel1Baseline,
} from "./ctx-reduce-nudge-pi";
import { createTestDb } from "./test-utils.test";

function toolResultMsg(text: string) {
	return { role: "toolResult", content: [{ type: "text", text }] };
}

afterEach(() => {
	mock.restore();
});

describe("computeTailToolTokensPi", () => {
	it("sums non-dropped toolResult text, excludes sentinels", () => {
		const big = "x".repeat(40_000); // ~10k tokens
		const msgs = [
			toolResultMsg(big),
			toolResultMsg("[dropped §5§]"),
			toolResultMsg("[truncated]"),
			{
				role: "assistant",
				content: [{ type: "text", text: "x".repeat(40_000) }],
			},
		];
		const tokens = computeTailToolTokensPi(msgs);
		expect(tokens).toBeGreaterThan(9_000);
		expect(tokens).toBeLessThan(11_000);
	});

	it("estimates the full live tail separately from reclaimable tool output", () => {
		const estimate = computeTailTokenEstimatePi([
			{
				role: "user",
				content: [{ type: "text", text: "conversation ".repeat(1000) }],
			},
			{
				role: "assistant",
				content: [
					{ type: "toolCall", name: "bash", arguments: { cmd: "echo hi" } },
				],
			},
			toolResultMsg("tool output ".repeat(1000)),
		]);

		expect(estimate.tailToolTokens).toBeGreaterThan(0);
		expect(estimate.liveTailTokens).toBeGreaterThan(estimate.tailToolTokens);
	});
});

describe("maybeChannel1ReminderForToolResult", () => {
	const SESSION = "ses-ch1";

	function seedBaseline(tailTokens: number): void {
		setPiChannel1Baseline(SESSION, {
			tailToolTokens: tailTokens,
			historyBudgetTokens: 100_000,
			contextLimit: 200_000,
			executeThresholdPercentage: 65,
			lastInputTokens: 150_000, // pressure ≈ (75 / 65) ≈ 1.15
			turnToolTokens: 0,
			usableTokens: 60_000,
			reducedSinceRefresh: false,
			oldestReclaimableToolTags: [{ tagNumber: 9, toolName: "bash" }],
		});
	}

	it("returns null when no baseline exists (subagent / off)", () => {
		const db = createTestDb();
		clearPiChannel1State(SESSION);
		const block = maybeChannel1ReminderForToolResult({
			db,
			sessionId: SESSION,
			toolName: "bash",
			content: [{ type: "text", text: "x".repeat(80_000) }],
		});
		expect(block).toBeNull();
	});

	it("fires a system-reminder block when pressure + undropped warrant it", () => {
		const db = createTestDb();
		seedBaseline(90_000);
		const block = maybeChannel1ReminderForToolResult({
			db,
			sessionId: SESSION,
			toolName: "bash",
			content: [{ type: "text", text: "some bash output" }],
		});
		expect(block).not.toBeNull();
		expect(block?.type).toBe("text");
		expect(block?.text).toContain("<system-reminder>");
		expect(block?.text).toContain("ctx_reduce");
		clearPiChannel1State(SESSION);
	});

	it("includes oldest reclaimable hints from the baseline", () => {
		const db = createTestDb();
		setPiChannel1Baseline(SESSION, {
			tailToolTokens: 90_000,
			historyBudgetTokens: 100_000,
			contextLimit: 200_000,
			executeThresholdPercentage: 65,
			lastInputTokens: 150_000,
			turnToolTokens: 0,
			usableTokens: 60_000,
			reducedSinceRefresh: false,
			oldestReclaimableToolTags: [{ tagNumber: 123, toolName: "read" }],
		});
		const block = maybeChannel1ReminderForToolResult({
			db,
			sessionId: SESSION,
			toolName: "bash",
			content: [{ type: "text", text: "some bash output" }],
		});
		expect(block?.text).toContain("oldest reclaimable: §123§ read.");
		clearPiChannel1State(SESSION);
	});

	it("suppresses on a ctx_reduce tool result and marks reduced", () => {
		const db = createTestDb();
		seedBaseline(90_000);
		const block = maybeChannel1ReminderForToolResult({
			db,
			sessionId: SESSION,
			toolName: "ctx_reduce",
			content: [{ type: "text", text: "dropped 5 tags" }],
		});
		expect(block).toBeNull();
		// After a reduce, a subsequent tool result is also suppressed this turn.
		const next = maybeChannel1ReminderForToolResult({
			db,
			sessionId: SESSION,
			toolName: "bash",
			content: [{ type: "text", text: "more output" }],
		});
		expect(next).toBeNull();
		clearPiChannel1State(SESSION);
	});

	it("is idempotent — does not double-append to a result already carrying the marker", () => {
		const db = createTestDb();
		seedBaseline(90_000);
		const block = maybeChannel1ReminderForToolResult({
			db,
			sessionId: SESSION,
			toolName: "bash",
			content: [{ type: "text", text: "out <system-reminder> already here" }],
		});
		expect(block).toBeNull();
		clearPiChannel1State(SESSION);
	});
});

describe("maybeDeliverChannel2Pi", () => {
	const SESSION = "ses-ch2-pi";

	it("no-ops when no pending intent exists", () => {
		const db = createTestDb();
		let sent = 0;
		const delivered = maybeDeliverChannel2Pi(
			{
				sendMessage: () => {
					sent += 1;
				},
			},
			db,
			SESSION,
		);
		expect(delivered).toBe(false);
		expect(sent).toBe(0);
	});

	/** A baseline whose measurement still satisfies the full Channel-2 trigger. */
	function armStrongBaseline(sessionId: string): void {
		setPiChannel1Baseline(sessionId, {
			tailToolTokens: 30_000,
			historyBudgetTokens: 0,
			contextLimit: 200_000,
			executeThresholdPercentage: 65,
			lastInputTokens: 120_000,
			turnToolTokens: 0,
			usableTokens: 60_000, // 30k >= 60k/3 -> trigger holds
			reducedSinceRefresh: false,
			oldestReclaimableToolTags: [{ tagNumber: 9, toolName: "bash" }],
		});
	}

	it("regression: keeps the model-visible ceiling nudge on sendMessage(display:false, followUp)", () => {
		const db = createTestDb();
		setChannel2NudgeState(db, SESSION, "pending");
		armStrongBaseline(SESSION);
		let capturedContent = "";
		let capturedDeliverAs = "";
		let capturedDisplay: boolean | undefined;
		let capturedCustomType = "";
		const delivered = maybeDeliverChannel2Pi(
			{
				sendMessage: (message, options) => {
					capturedContent = message.content;
					capturedDisplay = message.display;
					capturedCustomType = message.customType;
					capturedDeliverAs = options?.deliverAs ?? "";
				},
			},
			db,
			SESSION,
		);
		expect(delivered).toBe(true);
		expect(capturedDeliverAs).toBe("followUp");
		// Hidden from the Pi TUI (agent steer, not a user turn) but still model-visible.
		expect(capturedDisplay).toBe(false);
		expect(capturedCustomType).toBe("magic-context:ceiling-nudge");
		expect(capturedContent).toContain("<system-reminder>");
		expect(capturedContent).toContain("ctx_reduce");
		expect(capturedContent).toContain("oldest reclaimable");
		expect(getChannel2NudgeState(db, SESSION)).toBe("delivered");
	});

	it("does NOT deliver and leaves pending when no baseline measurement exists", () => {
		const db = createTestDb();
		const session = "ses-ch2-pi-unknown";
		setChannel2NudgeState(db, session, "pending");
		clearPiChannel1State(session);
		let sent = 0;
		const delivered = maybeDeliverChannel2Pi(
			{
				sendMessage: () => {
					sent += 1;
				},
			},
			db,
			session,
		);
		// Unknown pressure must never burn the one-shot cap NOR cancel the
		// intent — a later agent_end with a real measurement decides.
		expect(delivered).toBe(false);
		expect(sent).toBe(0);
		expect(getChannel2NudgeState(db, session)).toBe("pending");
	});

	it("cancels (re-armable) when the full trigger predicate no longer holds", () => {
		const db = createTestDb();
		const session = "ses-ch2-pi-stale";
		setChannel2NudgeState(db, session, "pending");
		// 11k reclaimable >= 10k floor, but < usable/3 (44k/3 ~ 14.7k) — the
		// audit repro: floor-only validation would deliver and burn the cap.
		setPiChannel1Baseline(session, {
			tailToolTokens: 11_000,
			historyBudgetTokens: 0,
			contextLimit: 200_000,
			executeThresholdPercentage: 65,
			lastInputTokens: 100_000,
			turnToolTokens: 0,
			usableTokens: 44_000,
			reducedSinceRefresh: false,
			oldestReclaimableToolTags: [],
		});
		let sent = 0;
		const delivered = maybeDeliverChannel2Pi(
			{
				sendMessage: () => {
					sent += 1;
				},
			},
			db,
			session,
		);
		expect(delivered).toBe(false);
		expect(sent).toBe(0);
		// Cancelled to '' (re-armable), NOT 'delivered' — cap preserved.
		expect(getChannel2NudgeState(db, session)).toBe("");
	});

	it("reverts to pending on send failure (cap not burned)", () => {
		const db = createTestDb();
		setChannel2NudgeState(db, SESSION, "pending");
		armStrongBaseline(SESSION);
		const delivered = maybeDeliverChannel2Pi(
			{
				sendMessage: () => {
					throw new Error("transient");
				},
			},
			db,
			SESSION,
		);
		expect(delivered).toBe(false);
		expect(getChannel2NudgeState(db, SESSION)).toBe("pending");
	});

	it("returns false and leaves the claim healable when claimed→pending CAS throws", async () => {
		const db = createTestDb();
		const session = "ses-ch2-pi-revert-throw";
		setChannel2NudgeState(db, session, "pending");
		armStrongBaseline(session);

		const originalPrepare = db.prepare.bind(db);
		(db as unknown as { prepare: typeof db.prepare }).prepare = (
			sql: string,
		) => {
			const statement = originalPrepare(sql);
			if (
				sql ===
				"UPDATE session_meta SET channel2_nudge_state = ?, channel2_nudge_claimed_at = ?, channel2_nudge_claim_token = '' WHERE session_id = ? AND channel2_nudge_state = ?"
			) {
				return {
					...statement,
					run: (...args: unknown[]) => {
						if (
							args[0] === "pending" &&
							args[1] === 0 &&
							args[2] === session &&
							args[3] === "claimed"
						) {
							throw new Error("SQLITE_BUSY: database is locked");
						}
						return statement.run(
							...(args as [unknown, unknown, unknown, unknown]),
						);
					},
				} as typeof statement;
			}
			return statement;
		};

		const delivered = maybeDeliverChannel2Pi(
			{
				sendMessage: () => {
					throw new Error("transient");
				},
			},
			db,
			session,
		);

		expect(delivered).toBe(false);
		expect(getChannel2NudgeState(db, session)).toBe("claimed");
		expect(getChannel2NudgeClaimedAt(db, session)).toBeGreaterThan(0);
	});

	it("preserves a sibling's delivered claim and logs the duplicate window distinctly", async () => {
		const db = createTestDb();
		const session = "ses-ch2-pi-duplicate";
		setChannel2NudgeState(db, session, "pending");
		armStrongBaseline(session);

		const sessionLog = spyOn(loggerModule, "sessionLog").mockImplementation(
			() => {},
		);

		const delivered = maybeDeliverChannel2Pi(
			{
				sendMessage: () => {
					db.prepare(
						"UPDATE session_meta SET channel2_nudge_state = 'delivered', channel2_nudge_claimed_at = 0 WHERE session_id = ?",
					).run(session);
				},
			},
			db,
			session,
		);

		expect(delivered).toBe(false);
		expect(getChannel2NudgeState(db, session)).toBe("delivered");
		expect(
			sessionLog.mock.calls.some(
				(call) =>
					call[0] === session &&
					typeof call[1] === "string" &&
					call[1].includes("duplicate window"),
			),
		).toBe(true);
	});

	it("does not re-deliver after success (one nudge per lifetime)", () => {
		const db = createTestDb();
		setChannel2NudgeState(db, SESSION, "delivered");
		let sent = 0;
		const delivered = maybeDeliverChannel2Pi(
			{
				sendMessage: () => {
					sent += 1;
				},
			},
			db,
			SESSION,
		);
		expect(delivered).toBe(false);
		expect(sent).toBe(0);
	});
});

describe("Channel 2 delivery wiring (regression)", () => {
	// The helper is well-tested above, but the bug it guards against is that
	// `index.ts` never CALLED it — Pi recorded `pending` and never delivered.
	// Assert the agent_end handler actually invokes the delivery.
	const INDEX_SRC = readFileSync(join(import.meta.dir, "index.ts"), "utf8");

	it("index.ts imports maybeDeliverChannel2Pi", () => {
		expect(INDEX_SRC).toContain("maybeDeliverChannel2Pi");
	});

	it("the agent_end handler calls maybeDeliverChannel2Pi", () => {
		const handler = INDEX_SRC.match(/pi\.on\("agent_end",[\s\S]*?\n\s*\}\);/);
		expect(handler).not.toBeNull();
		expect(handler?.[0] ?? "").toContain(
			"maybeDeliverChannel2Pi(pi, db, sessionId)",
		);
	});
});
