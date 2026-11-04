/*
 * red-proof: inject  the fake timeline below is installed on `globalThis.performance` before the
 * module is imported. The first case marks submit + settled and reads 40ms; the second marks only
 * submit and must report NO settled duration (a turn that never settled has no duration, and 0 would
 * describe a fast turn that did not happen); the third filters by turnKey and must see only its own.
 *
 * Verified by running it against a deliberately broken reader: replacing the `end !== undefined`
 * guard in `turnDurations` with an unconditional assignment makes the second case read
 * `{ settled: 0 }` and reddens it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

/** A Performance API that records what the product marks, and nothing else. */
function installFakeTimeline() {
	const entries = [];
	let clock = 0;
	const original = globalThis.performance;
	globalThis.performance = {
		...original,
		mark(name, init) {
			entries.push({ name, startTime: clock, detail: init?.detail });
			return { name, startTime: clock, detail: init?.detail, duration: 0, entryType: "mark" };
		},
		getEntriesByType(type) {
			return type === "mark" ? [...entries] : [];
		},
	};
	return {
		advance(ms) {
			clock += ms;
		},
		restore() {
			globalThis.performance = original;
		},
	};
}

test("a duration exists only when both ends were marked", async () => {
	const timeline = installFakeTimeline();
	try {
		const { markTurn, turnDurations } = await import("../src/components/turn-timings.ts");
		markTurn("submit", { surface: "chat", turnKey: "turn-a" });
		timeline.advance(40);
		markTurn("settled", { surface: "chat", turnKey: "turn-a" });
		const durations = turnDurations("turn-a");
		assert.equal(durations.settled, 40, "the gap between the two marks is the duration");
		assert.equal(
			durations.firstToken,
			undefined,
			"no first-token mark means no first-token duration; 0 would report a stream that never started",
		);
	} finally {
		timeline.restore();
	}
});

test("a turn that only submitted reports nothing rather than zeros", async () => {
	const timeline = installFakeTimeline();
	try {
		const { markTurn, turnDurations } = await import("../src/components/turn-timings.ts");
		markTurn("submit", { surface: "chat", turnKey: "turn-b" });
		assert.deepEqual(
			{ ...turnDurations("turn-b") },
			{},
			"zero would be a measurement; absence is the truth while the turn is still running",
		);
	} finally {
		timeline.restore();
	}
});

test("marks from another turn are not attributed to this one", async () => {
	const timeline = installFakeTimeline();
	try {
		const { markTurn, turnDurations } = await import("../src/components/turn-timings.ts");
		markTurn("submit", { surface: "chat", turnKey: "turn-c" });
		markTurn("submit", { surface: "chat", turnKey: "turn-d" });
		timeline.advance(25);
		markTurn("settled", { surface: "chat", turnKey: "turn-d" });
		assert.equal(
			turnDurations("turn-c").settled,
			undefined,
			"interleaved turns must not borrow each other's end mark",
		);
		assert.equal(turnDurations("turn-d").settled, 25);
	} finally {
		timeline.restore();
	}
});

test("no Performance API costs the turn nothing", async () => {
	const original = globalThis.performance;
	delete globalThis.performance;
	try {
		const { markTurn, turnDurations } = await import("../src/components/turn-timings.ts");
		assert.doesNotThrow(() => markTurn("submit", { surface: "chat" }), "a missing timing must not break a turn");
		assert.deepEqual({ ...turnDurations() }, {});
	} finally {
		globalThis.performance = original;
	}
});

test("every stage the shell marks is a declared mark name", async () => {
	const { TURN_MARK, TURN_MARK_PREFIX } = await import("../src/components/turn-timings.ts");
	for (const [stage, name] of Object.entries(TURN_MARK)) {
		assert.ok(
			name.startsWith(TURN_MARK_PREFIX),
			`${stage} must be namespaced, so a reader can filter without knowing every stage`,
		);
	}
	assert.deepEqual(
		Object.keys(TURN_MARK).sort(),
		["accepted", "failed", "firstToken", "settled", "submit"],
		"the shell marks these five; a stage added here without a call site would be a name nothing emits",
	);
});

/**
 * A turn the surface starts has to be a turn the surface can name.
 *
 * `markTurn` is only half the contract: the stages after `submit` are emitted from the stream with
 * `turnKeyRef.current`, and that ref is written by the mutation that starts the turn. A
 * turn-starting mutation that skips both leaves every mark it produces naming no turn - and, because
 * only a terminal state event clears the ref, it can leave the marks naming the PREVIOUS turn, which
 * attributes one turn's timing to another. Measured on a real run 2026-11-04: `handleRegenerate`
 * called `beginTurnMutation` and nothing else, so its captured request was a turn nothing on the
 * page could name.
 *
 * The population is the source itself, not a list here: every call site of `beginTurnMutation` is
 * a mutation that opens a durable turn, by that function's own contract. A third one added tomorrow
 * fails this gate until it follows the same two lines, and the message names which handler drifted.
 */
test("every turn-starting mutation joins the turn ledger it opens", async () => {
	const { readFile } = await import("node:fs/promises");
	const source = await readFile(new URL("../src/components/ComposedReferenceGameApp.tsx", import.meta.url), "utf8");
	// The declaration is `const beginTurnMutation = (`; only a call has the paren hard against it.
	const callSites = [...source.matchAll(/beginTurnMutation\(/gu)].map((match) => match.index ?? 0);
	assert.ok(callSites.length > 0, "the shell must open its turns through one seam, and this gate found none");
	const disciplines = [
		["writes the turn key", /turnKeyRef\.current\s*=\s*idempotencyKey\s*;/u],
		[
			"marks the submit",
			/markTurn\(\s*"submit"\s*,\s*\{[^}]*turnKey:\s*idempotencyKey\s*\}/u,
		],
	];
	for (const [index, at] of callSites.entries()) {
		const handler = [...source.slice(0, at).matchAll(/const (handle\w+) =/gu)].pop()?.[1] ?? `call site ${index}`;
		// The segment this call owns runs to the next one: a handler that set the key for a
		// DIFFERENT mutation would otherwise satisfy its neighbour's gate.
		const segment = source.slice(at, callSites[index + 1] ?? source.length);
		for (const [what, pattern] of disciplines)
			assert.ok(
				pattern.test(segment),
				`${handler} starts a durable turn through beginTurnMutation but never ${what}; a turn nothing names cannot be read back from the page's timeline`,
			);
	}
});
