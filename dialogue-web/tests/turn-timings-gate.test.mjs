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

/**
 * The message-mutation envelope: one latch, one refusal, one home.
 *
 * Seven commands - the swipe, the opening variant, the regenerate, the rewind, the delete, the
 * variant discard and the in-place edit - ran the same fifteen-line envelope by hand: take
 * `chatMutationRef`, clear the last refusal, publish the busy row, `await` the wire call, `await`
 * the authoritative reread; on a failure say the sentence BEFORE that reread (the reread restores
 * the transcript the Host still holds, so the sentence is the only thing that makes a refused press
 * visible) and commit the problem view if the reread fails too; release the latch in `finally`.
 * Six of the copies were byte-identical and the seventh was `handleRegenerate`'s.
 *
 * A copy is the defect: any one of them can drop the release (a row that stays busy until the page
 * is reloaded), the sentence (a refusal that flickers and reverts with nothing said - measured once
 * already, which is why the notice exists), or the reread (a local guess at what the Host holds).
 * The envelope is one module now, and these cases hold its two halves: the first reads the source
 * and the rest drive the real module with the shell's own seams as fakes.
 *
 * Population, stated: the source of the shell and of the envelope. The failure names the handler
 * and the line, and the gate refuses to pass by the envelope's behaviour being deleted - it asserts
 * the module still carries both halves.
 */
function matchesWithOwner(source, pattern) {
	return [...source.matchAll(pattern)].map((match) => {
		const before = source.slice(0, match.index ?? 0);
		const owner = [...before.matchAll(/const (handle[A-Z]\w*) =/gu)].pop()?.[1] ?? "module scope";
		return { owner, line: before.split("\n").length, text: match[0] };
	});
}

const describeMatch = (match) => `${match.owner} line ${match.line}: ${match.text}`;

test("the shell writes no message-mutation envelope of its own", async (t) => {
	const { readFile } = await import("node:fs/promises");
	const read = async (name) => readFile(new URL(`../src/components/${name}`, import.meta.url), "utf8");
	const shell = await read("ComposedReferenceGameApp.tsx");

	const releases = matchesWithOwner(shell, /chatMutationRef\.current = false\s*;/gu);
	const refusals = matchesWithOwner(shell, /setMessageMutationNotice\(problemView/gu);
	// The handlers that take the latch: each owns its press, so each must let the envelope word it.
	const takers = new Set(matchesWithOwner(shell, /beginMessageMutation\(/gu).map((match) => match.owner));
	const wordedHere = refusals.filter((match) => takers.has(match.owner));

	t.diagnostic(
		`envelope (shell): ${releases.length} latch release(s), ${refusals.length} refusal sentence(s), ` +
			`${wordedHere.length} of them written by a handler that takes the latch`,
	);
	assert.deepEqual(
		releases.map(describeMatch),
		[],
		"the single-flight latch is released in one place - the message-mutation envelope - not once per command",
	);
	assert.deepEqual(
		wordedHere.map(describeMatch),
		[],
		"a handler that takes the message-mutation latch must let the envelope word its refusal, or the next copy can drop the sentence",
	);

	// The envelope must still carry both halves: a gate that passes because the behaviour was deleted
	// has stopped guarding anything.
	const envelope = await read("message-mutation.ts");
	const moduleReleases = matchesWithOwner(envelope, /chatMutationRef\.current = false\s*;/gu);
	const moduleSentences = matchesWithOwner(envelope, /setMessageMutationNotice\(/gu);
	const { CHAT_MUTATION_KINDS } = await import("../src/components/message-mutation.ts");
	const undispatched = CHAT_MUTATION_KINDS.filter((kind) => !shell.includes(`kind: "${kind}"`));

	t.diagnostic(
		`envelope (module): ${moduleReleases.length} release(s), ${moduleSentences.length} sentence(s); ` +
			`${CHAT_MUTATION_KINDS.length - undispatched.length}/${CHAT_MUTATION_KINDS.length} mutation kinds dispatched`,
	);
	assert.equal(moduleReleases.length, 1, "the envelope must still release the latch it took");
	assert.equal(moduleSentences.length, 1, "the envelope must still say the refusal it carries");
	assert.deepEqual(
		undispatched,
		[],
		"every mutation kind the envelope declares is a kind some command asks it for; one declared but never dispatched is a busy state nothing can show",
	);
});

/** A ready view with only the facts one mutation reads: enough to be the real shape, no more. */
const readyView = () => ({
	kind: "ready",
	root: {},
	session: { snapshot: { selection: { generation: 7 }, csrfToken: "csrf-token" } },
	draft: { revision: 0, text: null },
	locale: "en",
});

/** The catalogue's own sentence for a failure - the producer the envelope reads, not a copy of it. */
async function sentenceOf(error) {
	const { composedProblemView } = await import("../src/composed-problem-view.ts");
	const { messages } = await import("../src/i18n.ts");
	return composedProblemView(error, messages("en")).detail;
}

/** A Host refusal: the error class whose own code carries the player's sentence. */
async function hostRefusal(code) {
	const { TavernProblemError } = await import("../src/reference-pipeline-api.ts");
	return new TavernProblemError({
		type: "about:blank",
		title: "The command was refused",
		status: 409,
		code,
		requestId: "R".repeat(43),
		retryable: false,
	});
}

/**
 * The shell's own seams, as the envelope receives them, plus the log of what reached the wire.
 *
 * `beginMessageMutation` mirrors the shell's: the latch goes up, the last refusal is spent and the
 * busy row is published. `rereadChat` records the sentence as it stood when the read ran, because
 * "said before the reread" is an ordering and a log of both is how it is observed.
 */
async function install({ view = readyView(), latchHeld = false, reread = async () => {} } = {}) {
	const { createMessageMutation } = await import("../src/components/message-mutation.ts");
	const log = [];
	const notice = { sentence: null };
	const chatMutationRef = { current: latchHeld };
	const mutate = createMessageMutation({
		viewRef: { current: view },
		chatMutationRef,
		beginMessageMutation: (kind, handle) => {
			chatMutationRef.current = true;
			notice.sentence = null;
			log.push(["begin", kind, handle]);
		},
		rereadChat: async () => {
			log.push(["reread", notice.sentence]);
			await reread();
		},
		commit: (next) => log.push(["commit", next]),
		setMessageMutationNotice: (sentence) => {
			notice.sentence = sentence;
			log.push(["notice", sentence]);
		},
		setChatMutation: (mutation) => log.push(["busy", mutation]),
	});
	const request = (overrides = {}) => ({
		kind: "swipe",
		handle: "message-handle",
		send: async () => log.push(["send"]),
		...overrides,
	});
	return { mutate, request, log, notice, chatMutationRef };
}

test("a second message mutation is refused while one is in flight", async () => {
	const { mutate, request, log, chatMutationRef } = await install({ latchHeld: true });
	const outcome = await mutate(request());
	assert.deepEqual(outcome, { kind: "refused" }, "a press that could not start says so, instead of pretending it ran");
	assert.deepEqual(
		log,
		[],
		"a refused press must not reach the wire, take the latch, publish a busy row or spend the sentence of the press it lost to",
	);
	assert.equal(chatMutationRef.current, true, "the mutation already in flight keeps the latch it took");
});

test("a landed message mutation rereads once and releases the latch exactly once", async () => {
	const { mutate, request, log, notice, chatMutationRef } = await install();
	const outcome = await mutate(
		request({ kind: "edit", handle: "row", send: async (admission) => log.push(["send", admission]) }),
	);
	assert.deepEqual(outcome, { kind: "landed" });
	assert.deepEqual(
		log,
		[
			["begin", "edit", "row"],
			["send", { selectionGeneration: 7, csrfToken: "csrf-token" }],
			["reread", null],
			["busy", null],
		],
		"the latch is taken before the wire, the authoritative reread follows it, and the busy row is spent last",
	);
	assert.equal(chatMutationRef.current, false, "a press that landed leaves the surface able to take the next one");
	assert.equal(notice.sentence, null, "a press that landed has nothing to explain");
});

test("a refused message mutation is said before the reread that restores the transcript", async () => {
	const { mutate, request, log, notice, chatMutationRef } = await install();
	const refusal = await hostRefusal("chat_rewind_turn_active");
	const outcome = await mutate(
		request({
			kind: "rewind",
			send: async () => {
				throw refusal;
			},
		}),
	);
	const expected = await sentenceOf(refusal);
	assert.deepEqual(outcome, { kind: "failed", error: refusal }, "the caller gets the answer back to settle its own record");
	assert.deepEqual(
		log.find((entry) => entry[0] === "reread"),
		["reread", expected],
		"the sentence stands before the read runs; the other order lets the reread restore the transcript over a press nobody explained",
	);
	assert.equal(notice.sentence, expected, "the refusal's own words, from the catalogue that owns them");
	assert.equal(chatMutationRef.current, false, "a refusal releases the latch, or the row stays busy for good");
});

test("a refusal whose reread also fails commits the problem view for the refusal it answered", async () => {
	const refused = new Error("the Host refused this press");
	const { mutate, request, log } = await install({
		reread: async () => {
			throw new Error("the read behind it is down as well");
		},
	});
	const outcome = await mutate(
		request({
			send: async () => {
				throw refused;
			},
		}),
	);
	assert.equal(outcome.kind, "failed");
	const commits = log.filter((entry) => entry[0] === "commit").map((entry) => entry[1]);
	assert.equal(commits.length, 1, "one read that could not land is one problem to state");
	assert.equal(commits[0].kind, "problem");
	assert.equal(
		commits[0].detail,
		await sentenceOf(refused),
		"the problem view names the refusal that was being reread, not the read's own failure",
	);
});

test("a press with no ready view and no selection is refused without touching anything", async () => {
	for (const view of [{ kind: "loading" }, { ...readyView(), session: { snapshot: { selection: null, csrfToken: "t" } } }]) {
		const { mutate, request, log } = await install({ view });
		assert.deepEqual(await mutate(request()), { kind: "refused" });
		assert.deepEqual(log, [], "there is nothing to reread and nothing to say about a press nothing could address");
	}
});

test("the press's own admission runs after the guards and before the latch", async () => {
	const { mutate, request, log, chatMutationRef } = await install();
	const outcome = await mutate(
		request({
			kind: "regenerate",
			before: (current) => {
				log.push(["before", current.kind]);
				return true;
			},
		}),
	);
	assert.deepEqual(outcome, { kind: "landed" });
	assert.deepEqual(log.slice(0, 2), [["before", "ready"], ["begin", "regenerate", "message-handle"]]);
	assert.equal(chatMutationRef.current, false);

	const declined = await install({ latchHeld: false });
	const refused = await declined.mutate(
		declined.request({
			kind: "regenerate",
			before: () => {
				declined.log.push(["before"]);
				return false;
			},
		}),
	);
	assert.deepEqual(refused, { kind: "refused" }, "an admission the Host would not take is not a mutation");
	assert.deepEqual(declined.log, [["before"]], "a declined press never takes the latch and never reaches the wire");
	assert.equal(declined.chatMutationRef.current, false);
});
