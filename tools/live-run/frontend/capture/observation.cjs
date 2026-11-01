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

/** Every mark the product records, in page order. */
async function readTurnMarks(page) {
	return page.evaluate(() => {
		if (typeof performance === "undefined" || typeof performance.getEntriesByType !== "function") return [];
		return performance
			.getEntriesByType("mark")
			.filter((entry) => entry.name.indexOf("gamebuddy:turn:") === 0)
			.map((entry) => ({
				name: entry.name,
				at: Math.round(entry.startTime * 100) / 100,
				turnKey: (entry.detail && entry.detail.turnKey) || null,
			}));
	});
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

/** First-paint facts. Every field is null when that entry never arrived, which is itself a reading. */
async function readPaintFacts(page) {
	return page.evaluate(() => {
		if (typeof performance === "undefined" || typeof performance.getEntriesByType !== "function") {
			return { firstPaintMs: null, firstContentfulPaintMs: null, largestContentfulPaintMs: null };
		}
		const at = (name) => {
			const entry = performance.getEntriesByType("paint").find((candidate) => candidate.name === name);
			return entry === undefined ? null : Math.round(entry.startTime);
		};
		const lcp = performance.getEntriesByType("largest-contentful-paint");
		return {
			firstPaintMs: at("first-paint"),
			firstContentfulPaintMs: at("first-contentful-paint"),
			largestContentfulPaintMs: lcp.length === 0 ? null : Math.round(lcp[lcp.length - 1].startTime),
		};
	});
}

/**
 * Write the three sections a driver's facts file carries about the run rather than the layout.
 *
 * Lines are prefixed so `report.mjs` can pick them out of the same per-driver text it already reads,
 * which is why this writes through the driver's own `say` instead of a second file: one driver, one
 * facts file, and the sections travel with the measurements they belong beside.
 */
async function observe(page, say, label = "run") {
	const marks = await readTurnMarks(page);
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
			`fcp=${paint.firstContentfulPaintMs === null ? "unobserved" : `${paint.firstContentfulPaintMs}ms`} ` +
			`lcp=${paint.largestContentfulPaintMs === null ? "unobserved" : `${paint.largestContentfulPaintMs}ms`}`,
	);

	return { durations, runtime, paint };
}

module.exports = { observe, readTurnMarks, durationsByTurn, readRuntimeFacts, readPaintFacts };
