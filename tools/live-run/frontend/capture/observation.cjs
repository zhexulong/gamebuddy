/*
 * The observation layer every driver shares: what a turn cost, what the runtime holds, what the first
 * screen painted.
 *
 * This is a separate module rather than more text inside `PAGE_HELPERS`, because the page-global string
 * is a single template literal and adding a nested object with its own braces there is one escaping
 * mistake away from a driver that silently observes nothing. Each function here evaluates its own
 * expression in the page.
 *
 * Three rules, all learned from the same defect family:
 *
 *   Absence is reported as null, never as 0. `performance.memory` is Chrome-only and the paint buffer
 *   is empty on a page that has not painted; `0` would be a measurement where there was none.
 *
 *   The turn timings are READ from the product's own marks (`turn-timings.ts`), not re-measured. A
 *   driver that timed the same span itself would be a second opinion about where a turn's time went,
 *   and the two would disagree the moment either changed.
 *
 *   Nothing here fails the run. A missing observation is recorded as `unobserved:<reason>` beside the
 *   numbers that did arrive - an instrument that silently reports "fine" because it could not measure
 *   is worse than one that says it could not.
 */

const { readFileSync } = require("node:fs");

/**
 * The page's own clock, so a driver can say "the marks that arrived while I was running".
 *
 * The mark buffer belongs to the PAGE, and the drivers share one page across a whole capture phase,
 * so a reader that takes the whole buffer attributes every earlier driver's turn and switch to
 * whoever asks last - which is the defect that made `PAINT` say the same firstPaint on every driver.
 * A driver records this once at its start and hands it to `observe`.
 *
 * `null` when the page has no Performance API: then there is no baseline, and every reading below is
 * `unobserved` rather than zero.
 */
async function observationStart(page) {
	return page.evaluate(() => (typeof performance === "undefined" ? null : performance.now()));
}

/** Every mark the product records, in page order, from `sinceMs` on. */
async function readTurnMarks(page, sinceMs = 0) {
	return page.evaluate((from) => {
		if (typeof performance === "undefined" || typeof performance.getEntriesByType !== "function") return [];
		return performance
			.getEntriesByType("mark")
			.filter((entry) => entry.name.indexOf("gamebuddy:turn:") === 0 && entry.startTime >= from)
			.map((entry) => ({
				name: entry.name,
				at: Math.round(entry.startTime * 100) / 100,
				turnKey: (entry.detail && entry.detail.turnKey) || null,
			}));
	}, sinceMs);
}

/**
 * Every surface-switch mark the product records, in page order, from `sinceMs` on.
 *
 * The product marks the ends of a switch where the switch happens (`composed-surface-route.ts`):
 * `gamebuddy:switch:<surface>:start` when the player selects a surface, `:done` when the new region is
 * committed and painted. Nothing here times a click: a driver that measured its own click would be a
 * second opinion about where the switch's time went, and the two would disagree the first time the
 * shell changed.
 */
async function readSwitchMarks(page, sinceMs = 0) {
	return page.evaluate((from) => {
		if (typeof performance === "undefined" || typeof performance.getEntriesByType !== "function") return [];
		return performance
			.getEntriesByType("mark")
			.filter((entry) => entry.name.indexOf("gamebuddy:switch:") === 0 && entry.startTime >= from)
			.map((entry) => ({ name: entry.name, at: Math.round(entry.startTime * 100) / 100 }));
	}, sinceMs);
}

const SWITCH_PREFIX = "gamebuddy:switch:";

/**
 * Pair each switch's two ends, in page order.
 *
 * A switch is one `start` and one `done` for the same surface, in that order. Three shapes are NOT a
 * pair and each is reported as what it is rather than dropped:
 *
 *   done alone      Back and Escape move the history entry, so the browser switched the surface with
 *                   no press on an entry. `startMs` is null and there is no duration: the player's
 *                   selection is the thing that was timed, and there was none.
 *   start alone     the switch never committed before the driver read the buffer. `doneMs` is null -
 *                   a duration here would describe a switch that had not finished.
 *   start again     a second `start` for a surface whose `start` never got a `done` closes the first
 *                   one as unfinished and opens a new pair; the buffer keeps both.
 */
function switchDurations(marks) {
	const open = new Map();
	const pairs = [];
	for (const mark of marks) {
		const rest = mark.name.slice(SWITCH_PREFIX.length);
		const split = rest.lastIndexOf(":");
		if (split < 0) continue;
		const surface = rest.slice(0, split);
		const stage = rest.slice(split + 1);
		if (stage === "start") {
			if (open.has(surface)) pairs.push({ surface, startMs: open.get(surface), doneMs: null, durationMs: null });
			open.set(surface, mark.at);
			continue;
		}
		if (stage !== "done") continue;
		const startMs = open.has(surface) ? open.get(surface) : null;
		open.delete(surface);
		pairs.push({
			surface,
			startMs,
			doneMs: mark.at,
			durationMs: startMs === null ? null : Math.round((mark.at - startMs) * 100) / 100,
		});
	}
	for (const [surface, startMs] of open) pairs.push({ surface, startMs, doneMs: null, durationMs: null });
	return pairs;
}

/**
 * The durations between one turn's submit mark and each later stage.
 *
 * Grouped by `turnKey`, so interleaved turns do not borrow each other's end marks - the same rule the
 * product's own `turnDurations` follows, applied here because a driver reads the whole buffer.
 */
function durationsByTurn(marks) {
	const byTurn = new Map();
	for (const mark of marks) {
		const key = mark.turnKey ?? "unattributed";
		if (!byTurn.has(key)) byTurn.set(key, {});
		byTurn.get(key)[mark.name.replace("gamebuddy:turn:", "")] = mark.at;
	}
	const durations = {};
	for (const [key, stages] of byTurn) {
		if (stages.submit === undefined) continue;
		const row = {};
		for (const stage of ["accepted", "first-token", "settled", "failed"]) {
			if (stages[stage] !== undefined) row[stage] = Math.round((stages[stage] - stages.submit) * 100) / 100;
		}
		durations[key] = row;
	}
	return durations;
}

/** DOM size, heap and mark counts. Heap is null when the browser does not expose `performance.memory`. */
async function readRuntimeFacts(page) {
	return page.evaluate(() => {
		const memory = typeof performance !== "undefined" ? performance.memory : undefined;
		return {
			domNodes: document.getElementsByTagName("*").length,
			heapUsedBytes: memory === undefined || memory === null ? null : memory.usedJSHeapSize,
			heapTotalBytes: memory === undefined || memory === null ? null : memory.totalJSHeapSize,
			markCount: typeof performance === "undefined" ? null : performance.getEntriesByType("mark").length,
		};
	});
}

/**
 * First-paint facts. Every field is null when that entry never arrived, which is itself a reading.
 *
 * `largestContentfulPaintMs` is NOT read here, and that is deliberate. LCP entries only exist when a
 * `PerformanceObserver` was subscribed with `type: "largest-contentful-paint"` BEFORE the content
 * painted; `getEntriesByType("largest-contentful-paint")` returns an empty list on a page where nobody
 * subscribed, even though the page has content. The first version of this reader did exactly that, so
 * every driver reported `lcp=unobserved` across a full run - a field that could never produce a number,
 * listed as if it were measured.
 *
 * Measuring LCP properly means the launch phase installing the observer before navigation, which is a
 * different change in a different file. Until then the field is absent rather than permanently empty:
 * a reader who wants LCP must run Lighthouse (which installs its own observer) rather than trust a
 * mark this kit does not take.
 */
async function readPaintFacts(page) {
	return page.evaluate(() => {
		if (typeof performance === "undefined" || typeof performance.getEntriesByType !== "function") {
			return { firstPaintMs: null, firstContentfulPaintMs: null };
		}
		const at = (name) => {
			const entry = performance.getEntriesByType("paint").find((candidate) => candidate.name === name);
			return entry === undefined ? null : Math.round(entry.startTime);
		};
		return { firstPaintMs: at("first-paint"), firstContentfulPaintMs: at("first-contentful-paint") };
	});
}

/**
 * Write the five sections a driver's facts file carries about the run rather than the layout.
 *
 * Lines are prefixed so `report.mjs` can pick them out of the same per-driver text it already reads,
 * which is why this writes through the driver's own `say` instead of a second file: one driver, one
 * facts file, and the sections travel with the measurements they belong beside.
 *
 * `options.sinceMs` is the page clock this driver started at (see `observationStart`). The mark buffer
 * belongs to the page and the drivers share one page, so without a baseline the last driver to read
 * would report every earlier driver's turn and switch as its own - which is the same misattribution
 * that made `PAINT` say one firstPaint on every driver.
 *
 * `options.capturedRequests` is the provider capture the caller already holds; unset, the run's own
 * capture is read from `GB_SHOTS_WIRE_REQUESTS`. Neither is the same fact as "no memory was
 * injected": when neither exists the INJECTION line says `unobserved` and names why.
 */
async function observe(page, say, label = "run", options = {}) {
	const sinceMs = typeof options.sinceMs === "number" ? options.sinceMs : 0;
	const marks = await readTurnMarks(page, sinceMs);
	const durations = durationsByTurn(marks);
	const turns = Object.keys(durations);

	if (turns.length === 0) {
		say(`TIMINGS ${label}: unobserved:no-turn-marks (${marks.length} mark(s) present)`);
	} else {
		for (const key of turns) {
			const row = durations[key];
			const parts = Object.entries(row)
				.map(([stage, ms]) => `${stage}=${ms}ms`)
				.join(" ");
			say(`TIMINGS ${label} turn=${key}: ${parts.length === 0 ? "unobserved:no-terminal-mark" : parts}`);
		}
	}

	const runtime = await readRuntimeFacts(page);
	const heap = runtime.heapUsedBytes === null ? "unobserved:no-performance-memory" : `${Math.round(runtime.heapUsedBytes / 1024)}KiB`;
	say(`RUNTIME ${label}: domNodes=${runtime.domNodes} heap=${heap} marks=${runtime.markCount}`);

	const paint = await readPaintFacts(page);
	say(
		`PAINT ${label}: firstPaint=${paint.firstPaintMs === null ? "unobserved" : `${paint.firstPaintMs}ms`} ` +
			`fcp=${paint.firstContentfulPaintMs === null ? "unobserved" : `${paint.firstContentfulPaintMs}ms`}`,
	);

	const switchMarks = await readSwitchMarks(page, sinceMs);
	const switches = switchDurations(switchMarks);
	if (switches.length === 0) {
		say(`SWITCHES ${label}: unobserved:no-switch-marks (${switchMarks.length} mark(s) present)`);
	} else {
		for (const row of switches) {
			const ends =
				row.startMs === null
					? `done=${row.doneMs}ms no-start-mark:this-switch-came-from-history`
					: row.doneMs === null
						? `start=${row.startMs}ms unobserved:no-done-mark-before-this-read`
						: `start=${row.startMs}ms done=${row.doneMs}ms duration=${row.durationMs}ms`;
			say(`SWITCHES ${label} switch=${row.surface}: ${ends}`);
		}
	}

	const captured = options.capturedRequests ?? readCapturedRequests(process.env.GB_SHOTS_WIRE_REQUESTS);
	const injection = await injectionFacts(captured);
	if (!injection.ok) {
		say(`INJECTION ${label}: unobserved:${injection.reason}`);
	} else {
		for (const turn of injection.turns) {
			say(`INJECTION ${label} turn=${turn.turn}: ${describeInjection(turn)}`);
		}
	}

	return { durations, runtime, paint, switches, injection };
}

/* ---------- what reached the request ---------- */

/**
 * The captured provider request bodies this run holds, or a named reason it holds none.
 *
 * This is NOT "no memory was injected". A run whose product talks to a remote gateway records no
 * provider request on this machine at all, and answering `0 entries` for it would report an absence of
 * memory where the truth is an absence of observation - the confusion this kit has already paid for
 * once (`PAINT`'s permanently-empty LCP). So `ok: false` and the reason, every time.
 *
 * The kit reuses `startLocalStubProvider` (`tools/live-run/core/stub-provider.mjs`) for the runs that
 * can capture: it records `{ method, url, body }` per request and writes them where
 * `GB_SHOTS_WIRE_REQUESTS` points. No run writes that file today, so `capture_file_absent` is the
 * honest reading of a real run.
 */
function readCapturedRequests(file, read = readFileSync) {
	if (typeof file !== "string" || file.trim().length === 0)
		return { ok: false, reason: "no_provider_request_capture:GB_SHOTS_WIRE_REQUESTS_is_unset" };
	let text;
	try {
		text = read(file, "utf8");
	} catch (error) {
		return { ok: false, reason: `no_provider_request_capture:capture_file_absent:${file}` };
	}
	const trimmed = text.trim();
	if (trimmed.length === 0) return { ok: false, reason: `no_provider_request_capture:capture_file_empty:${file}` };
	let parsed;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		/* One request per line is what a stub provider appends; a single array is what a run delivers. */
		try {
			parsed = trimmed.split("\n").map((line) => JSON.parse(line));
		} catch (error) {
			return { ok: false, reason: `no_provider_request_capture:capture_file_unreadable:${String(error).slice(0, 80)}` };
		}
	}
	const requests = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.requests) ? parsed.requests : null;
	if (requests === null) return { ok: false, reason: `no_provider_request_capture:capture_file_holds_no_request_array:${file}` };
	return { ok: true, requests };
}

/**
 * One reading per captured turn: which authored-context blocks reached the request, and how big.
 *
 * `names` are the volatile block's own words. The block `<gamebuddy-volatile-source>` carries no name
 * attribute today, so what identifies an entry on the wire is the first line of its prose;
 * `namesFrom` says which of the two a reader is looking at rather than letting an excerpt be mistaken
 * for a title. The system prompt is read through the live kit's ONE wire reader
 * (`chat/wire-contract.mjs::systemPromptOf`), not a second copy of the content-shape rule: the wire
 * sends `content` as a string on some turns and as `{type,text}` parts on others.
 */
async function injectionFacts(captured) {
	if (captured === null || captured === undefined || captured.ok !== true)
		return { ok: false, reason: (captured && captured.reason) || "no_provider_request_capture" };
	const bodies = (Array.isArray(captured.requests) ? captured.requests : [])
		.map((entry) => (entry !== null && typeof entry === "object" && "body" in entry ? entry.body : entry))
		.filter((body) => body !== null && typeof body === "object" && !Array.isArray(body));
	if (bodies.length === 0) return { ok: false, reason: "no_provider_request_capture:no_parsed_request_body" };
	const { systemPromptOf } = await import("../../chat/wire-contract.mjs");
	return { ok: true, turns: bodies.map((body, index) => ({ turn: index + 1, ...blocksIn(systemPromptOf(body)) })) };
}

const byteLength = (text) => Buffer.byteLength(text, "utf8");
const countOf = (text, pattern) => (text.match(pattern) ?? []).length;

/** The authored-context and volatile blocks a system prompt carries, with their sizes. */
function blocksIn(systemText) {
	const text = typeof systemText === "string" ? systemText : "";
	const authored = /<gamebuddy-authored-context[\s\S]*?<\/gamebuddy-authored-context>/u.exec(text);
	const stable = /<gamebuddy-stable-context[\s\S]*?<\/gamebuddy-stable-context>/u.exec(text);
	const stableBlock = authored ?? stable;
	const volatileBlock = /<gamebuddy-volatile-context[\s\S]*?<\/gamebuddy-volatile-context>/u.exec(text);
	const volatileSources = volatileBlock === null ? [] : [...volatileBlock[0].matchAll(/<gamebuddy-volatile-source([^>]*)>([\s\S]*?)<\/gamebuddy-volatile-source>/gu)];
	// A block that names itself wins; one that does not is identified by the first line of its prose.
	// `namesFrom` reports which of the two happened per turn, so an excerpt is never read as a title.
	const attributeNames = volatileSources.map((source) => /\bname="([^"]+)"/u.exec(source[1]));
	const attributeCount = attributeNames.filter((match) => match !== null).length;
	const namesFrom =
		volatileSources.length === 0 || attributeCount === 0
			? "block-first-line"
			: attributeCount === volatileSources.length
				? "attribute"
				: "mixed";
	return {
		authoredContext:
			stableBlock === null
				? { present: false }
				: {
						present: true,
						block: authored === null ? "gamebuddy-stable-context" : "gamebuddy-authored-context",
						bytes: byteLength(stableBlock[0]),
						sources: countOf(stableBlock[0], /<gamebuddy-authored-source\b/gu),
						kinds: [...stableBlock[0].matchAll(/<gamebuddy-authored-source kind="([^"]*)"/gu)].map((match) => match[1]),
					},
		volatileContext:
			volatileBlock === null
				? { present: false }
				: {
						present: true,
						bytes: byteLength(volatileBlock[0]),
						sources: volatileSources.length,
						names: volatileSources.map((source, index) =>
							attributeNames[index] === null
								? (source[2].split("\n").map((line) => line.trim()).find((line) => line.length > 0) ?? "").slice(0, 40)
								: attributeNames[index][1],
						),
						namesFrom,
					},
	};
}

/** One turn's injection as one facts-file line: presence, size, and what the block named. */
function describeInjection(turn) {
	const authored = turn.authoredContext.present
		? `present block=${turn.authoredContext.block} bytes=${turn.authoredContext.bytes} sources=${turn.authoredContext.sources} kinds=${JSON.stringify(turn.authoredContext.kinds)}`
		: "absent";
	const volatile = turn.volatileContext.present
		? `present bytes=${turn.volatileContext.bytes} sources=${turn.volatileContext.sources} names=${JSON.stringify(turn.volatileContext.names)} namesFrom=${turn.volatileContext.namesFrom}`
		: "absent";
	return `authoredContext=${authored} volatileContext=${volatile}`;
}

module.exports = {
	observe,
	observationStart,
	readTurnMarks,
	readSwitchMarks,
	switchDurations,
	durationsByTurn,
	readRuntimeFacts,
	readPaintFacts,
	readCapturedRequests,
	injectionFacts,
};
