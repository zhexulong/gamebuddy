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
const TURN_PREFIX = "gamebuddy:turn:";

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
		byTurn.get(key)[mark.name.replace(TURN_PREFIX, "")] = mark.at;
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
 *
 * The INJECTION lines are keyed by the TURN IDS this page recorded, because the drivers share the page
 * and the capture file: a driver that reported whatever bodies the file held would report another
 * driver's prompt as its own. `durationsByTurn`'s bare `unattributed` bucket is not an id and is never
 * used as one - a turn whose mark carries no key is reported as a turn that cannot be matched.
 *
 * The three shapes are distinct and must stay distinct, because the difference between them is the
 * difference between a measurement and the reader's own blindness:
 *
 *   this driver marked no turn         it asked the request nothing, so it writes no INJECTION line;
 *                                      `report.mjs` names every such driver in the section's silence
 *                                      list, which is a report about the driver, not about the wire.
 *   a turn is marked, with no key      the observation exists and cannot be looked up:
 *                                      `unobserved:observed_turn_has_no_turnId`.
 *   a turn is marked, with a key       each key is looked up in the capture. A key with no record says
 *                                      `no_capture_for_turn` AND names the keys the capture did hold;
 *                                      a record for a key this driver never marked is reported as
 *                                      `capture_keys_with_no_turn_mark_here`, a fact about the shared
 *                                      file and never an absence of this driver's reading. A count of
 *                                      such records used to be written as `unobserved:<n>_capture_records
 *                                      _for_a_turn_not_observed_here`, and on a run where the join had
 *                                      worked perfectly it read as the driver having measured nothing.
 */
async function observe(page, say, label = "run", options = {}) {
	const sinceMs = typeof options.sinceMs === "number" ? options.sinceMs : 0;
	const marks = await readTurnMarks(page, sinceMs);
	const durations = durationsByTurn(marks);
	const turns = Object.keys(durations);
	const turnIds = turns.filter((key) => key !== "unattributed");

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
	/*
	 * A stage marked for a turn the page has no key for cannot be attributed to a turn, so it is not a
	 * duration - but it is not nothing either: regenerating a reply starts a real turn, marks its stages
	 * and posts a real request, and those marks used to disappear between `durationsByTurn` (which needs
	 * a `submit` mark to open a row) and the capture (whose record this driver then could not name).
	 *
	 * Not emitted when the keyless marks include a `submit`: `durationsByTurn` has already reported that
	 * turn as `turn=unattributed`, and one fact must not be spelled twice.
	 */
	const keyless = marks.filter((mark) => mark.turnKey === null);
	if (keyless.length > 0 && durations.unattributed === undefined) {
		const stages = [...new Set(keyless.map((mark) => mark.name.replace(TURN_PREFIX, "")))];
		say(`TIMINGS ${label}: marks_with_no_submission_key=${keyless.length} stages=${JSON.stringify(stages)}`);
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

	let injection = null;
	/* A driver that marked no turn asked the request nothing: `report.mjs` names it in the silence list. */
	if (marks.length > 0 && turnIds.length === 0) {
		say(`INJECTION ${label}: unobserved:observed_turn_has_no_turnId`);
	} else if (turnIds.length > 0) {
		const captured = options.capturedRequests ?? readCapturedRequests(process.env.GB_SHOTS_WIRE_REQUESTS);
		injection = await injectionFacts(captured, turnIds);
		if (!injection.ok) {
			say(`INJECTION ${label}: unobserved:${injection.reason}`);
		} else {
			for (const turn of injection.turns) {
				say(
					turn.unobserved === null
						? `INJECTION ${label} turn=${turn.turnId} source=${injection.source}: ${describeInjection(turn)}`
						: `INJECTION ${label} turn=${turn.turnId} source=${injection.source}: unobserved:${turn.unobserved}`,
				);
				if (turn.census.undeclared.length > 0)
					say(
						`INJECTION ${label} turn=${turn.turnId}: section_not_in_declaration=${turn.census.undeclared.join(",")}:` +
							`declaration=${JSON.stringify(injection.sections)}`,
					);
			}
			const held = JSON.stringify(injection.heldKeys);
			for (const turnId of injection.missing) {
				say(`INJECTION ${label} turn=${turnId}: unobserved:no_capture_for_turn:capture_holds=${held}`);
			}
			const unmarked = injection.unmarked;
			if (unmarked.length > 0)
				say(`INJECTION ${label}: capture_keys_with_no_turn_mark_here=${JSON.stringify(unmarked)}`);
			if (injection.unjoinable > 0)
				say(`INJECTION ${label}: capture_records_naming_a_turn_and_no_submission_key=${injection.unjoinable}`);
			if (injection.unlabelled > 0)
				say(`INJECTION ${label}: capture_records_with_no_turn_identity=${injection.unlabelled}`);
			if (injection.truncated !== null)
				say(
					`INJECTION ${label}: capture_truncated:read_last=${injection.truncated.read}_of=${injection.truncated.total}`,
				);
		}
	}

	return { durations, runtime, paint, switches, injection };
}

/* ---------- what reached the request ---------- */

/**
 * The capture is a reading of ONE instance, and only an instance on THIS machine can be read: something
 * here has to serve the request or forward it for the body to exist locally.
 *
 *   `local-stub-provider`      `core/stub-provider.mjs` ANSWERS the request itself. What the run then
 *                              measures is what the product sends, never what a model replies.
 *   `recording-provider-proxy` `core/recording-provider-proxy.mjs` FORWARDS the request unchanged and
 *                              keeps a copy, so the real endpoint answers and the run measures both the
 *                              reply and the assembled request.
 *
 * `remote-gateway` names an interception that does not exist rather than an absence of injected context:
 * a request posted straight to a gateway leaves this machine after Pi posts it, so nothing on the browser
 * side - and nothing this kit runs - can see it.
 */
const STUB_CAPTURE_SOURCE = "local-stub-provider";
const REMOTE_CAPTURE_SOURCE = "remote-gateway";

/**
 * The captured provider request bodies this run holds, or a named reason it holds none.
 *
 * This is NOT "no memory was injected". A run whose product talks to a remote gateway with nothing in
 * front of it records no provider request on this machine at all, and answering `0 entries` for it would
 * report an absence of memory where the truth is an absence of observation - the confusion this kit has
 * already paid for once (`PAINT`'s permanently-empty LCP). So `ok: false` and the reason, every time.
 *
 * The writer is `startRecordingProviderProxy` (`core/recording-provider-proxy.mjs`), which forwards each
 * request to the endpoint the product resolved and appends one `{ source, at, method, path, turnId,
 * idempotencyKey, body }` line to the file `GB_SHOTS_WIRE_REQUESTS` names. `startLocalStubProvider`
 * (`core/stub-provider.mjs`) serves the same reader for a run whose subject is only what the product
 * sends; it answers the request itself, so that run measures no reply at all.
 *
 * A file declares its writer on EVERY line, and every line must agree: the writer is the only party that
 * knows which instance posted the bodies, and a file that does not say cannot be read as any of them.
 * Three failures are distinct facts rather than one:
 *
 *   capture_source_undeclared   a line names no writer, so nothing says whose wire this is.
 *   capture_source_conflict     two lines name different writers, so this file holds two instances'
 *                               records and no reading of it describes one wire.
 *   capture_file_empty          zero records is not a capture that saw zero requests.
 */
/**
 * How many of a capture's trailing records one reading describes.
 *
 * The capture file is appended for the whole life of a run, and a driver shares its page with the other
 * nineteen, so a reading that described every record could grow without bound. 200 is far past what one
 * frontend run posts - the run that produced these readings posted 4 - and bounded anyway, and a reading
 * taken from the window says so (`capture_truncated:read_last=<n>_of=<total>`) instead of quietly
 * describing part of a file.
 */
const MAX_READ_REQUESTS = 200;

function readCapturedRequests(file, read = readFileSync) {
	if (typeof file !== "string" || file.trim().length === 0)
		return { ok: false, reason: "no_provider_request_capture:GB_SHOTS_WIRE_REQUESTS_is_unset" };
	let text;
	try {
		text = read(file, "utf8");
	} catch (error) {
		return { ok: false, reason: `no_provider_request_capture:capture_file_absent:${file}` };
	}
	const lines = text.split("\n").filter((line) => line.trim().length > 0);
	if (lines.length === 0) return { ok: false, reason: `no_provider_request_capture:capture_file_empty:${file}` };
	const firstRead = Math.max(0, lines.length - MAX_READ_REQUESTS);
	const window = lines.slice(firstRead);
	const requests = [];
	const sources = [];
	for (const [position, line] of window.entries()) {
		/* The message names the line IN THE FILE, not the line in the window. */
		const index = firstRead + position;
		let record;
		try {
			record = JSON.parse(line);
		} catch (error) {
			return {
				ok: false,
				reason: `no_provider_request_capture:capture_file_unreadable:line_${index + 1}:${String(error).slice(0, 60)}`,
			};
		}
		if (record === null || typeof record !== "object" || Array.isArray(record))
			return { ok: false, reason: `no_provider_request_capture:capture_line_is_not_a_record:line_${index + 1}` };
		// The writer puts a `body` on every record, even an empty one, so a line without it is a line of
		// some other shape - a whole document, or a record from a writer this reader does not know.
		if (!("body" in record))
			return { ok: false, reason: `no_provider_request_capture:capture_line_is_not_a_record:line_${index + 1}` };
		requests.push(record);
		sources.push(typeof record.source === "string" ? record.source.trim() : "");
	}
	const undeclared = sources.findIndex((source) => source.length === 0);
	if (undeclared >= 0)
		return { ok: false, reason: `no_provider_request_capture:capture_source_undeclared:line_${undeclared + 1}` };
	const source = sources[0];
	const conflicting = sources.findIndex((other) => other !== source);
	if (conflicting >= 0)
		return {
			ok: false,
			reason:
				`no_provider_request_capture:capture_source_conflict:` +
				`${source}_vs_${sources[conflicting]}:line_${conflicting + 1}`,
		};
	return {
		ok: true,
		source,
		requests,
		total: lines.length,
		truncated: firstRead > 0 ? { read: window.length, total: lines.length } : null,
	};
}

/**
 * One reading per turn this run observed: which authored-context blocks reached THAT turn's request.
 *
 * The index is an identity and nothing else. A capture file is appended in arrival order, and arrival
 * order is not turn order: a retried turn, a provider liveness probe, a second surface or another driver
 * sharing the page all insert records that shift every position after them. Reading by index then reports
 * the N-th captured prompt as the N-th turn - which is how one driver came to report another's prompt.
 *
 * The identity that can be indexed is the SUBMISSION KEY, not the Host's turn id, and that is the whole
 * reason the wire carries it. A driver's own marks name a turn by the idempotency key the browser
 * submitted it under (`newIdempotencyKey()` in `ComposedReferenceGameApp.tsx`); the Host's durable
 * `turn_<uuid>` is never given to the browser, which sees only an HMAC turn handle. The store maps the
 * two, but a reader that joined through it would depend on the store's schema; the header puts the
 * browser's own identity on the same request, so the join needs no second authority. The record still
 * carries the Host turn id, which is what a support engineer correlates with the Host's own logs.
 *
 * So:
 *
 *   `turnIds` given (a driver's own page marks)
 *                   each key is looked up by its own value. A key with no record is reported as
 *                   `no_capture_for_turn`; the capture's own keys come back as `heldKeys` so the caller
 *                   can name the join it could not make instead of printing a count.
 *   `turnIds` omitted
 *                   every record that names a submission key is described under it - never under its
 *                   position. A record naming a turn but no key cannot be attributed to any page and is
 *                   counted as `unjoinable`; one naming neither is counted as `unlabelled`.
 *
 * One turn can post more than one request (Pi's tool-call rounds are continuations of the same authored
 * context), so the first record for a turn is the one described.
 *
 * `names` are the volatile block's own words. The block `<gamebuddy-volatile-source>` carries no name
 * attribute today, so what identifies an entry on the wire is the first line of its prose;
 * `namesFrom` says which of the two a reader is looking at rather than letting an excerpt be mistaken
 * for a title. The blocks are read across every message of the request, through the live kit's ONE wire
 * reader (`chat/wire-contract.mjs::wireMessageText`) rather than a second copy of the content-shape rule:
 * a message's `content` is a string on some turns and `{type,text}` parts on others, and the product puts
 * the authored catalogue in a user message (M0), not in the system prompt.
 *
 * `census` is the part that answers "did the memory, the world book, the identity block reach the model":
 * it names every section `readInjectionDeclaration()` declares that this request carried, with the bytes
 * each cost, and every declared section it did not carry. A request carrying no marker at all comes back
 * `unobserved` rather than as a census of zeros, because this reader saw no injection rather than an
 * injection that was empty.
 */
async function injectionFacts(captured, turnIds) {
	if (captured === null || captured === undefined || captured.ok !== true)
		return { ok: false, reason: (captured && captured.reason) || "no_provider_request_capture" };
	const source = captured.source;
	const { RECORDING_PROXY_CAPTURE_SOURCE } = await import("../../core/recording-provider-proxy.mjs");
	if (source !== STUB_CAPTURE_SOURCE && source !== RECORDING_PROXY_CAPTURE_SOURCE)
		return {
			ok: false,
			reason:
				`no_provider_request_capture:` +
				(source === REMOTE_CAPTURE_SOURCE ? "remote_gateway_wire_unintercepted" : "capture_source_undeclared"),
		};
	const wanted = Array.isArray(turnIds) ? turnIds : null;
	/*
	 * A turn marked with no submission key is a page-side observation this reader cannot look up: the
	 * capture has nothing to look it up by. Not a capture failure, so it carries no capture prefix.
	 */
	if (wanted !== null && wanted.length === 0) return { ok: false, reason: "observed_turn_has_no_turnId" };
	const { readInjectionDeclaration } = await import("./injection-declaration.mjs");
	const declaration = readInjectionDeclaration();
	if (declaration.ok !== true) return { ok: false, reason: declaration.reason };
	const bodies = (Array.isArray(captured.requests) ? captured.requests : []).filter(
		(entry) =>
			entry !== null &&
			typeof entry === "object" &&
			!Array.isArray(entry) &&
			entry.body !== null &&
			typeof entry.body === "object" &&
			!Array.isArray(entry.body),
	);
	if (bodies.length === 0) return { ok: false, reason: "no_provider_request_capture:no_parsed_request_body" };
	const byKey = new Map();
	let unlabelled = 0;
	let unjoinable = 0;
	for (const entry of bodies) {
		const key =
			typeof entry.idempotencyKey === "string" && entry.idempotencyKey.trim().length > 0 ? entry.idempotencyKey : null;
		if (key === null) {
			if (typeof entry.turnId === "string" && entry.turnId.trim().length > 0) unjoinable += 1;
			else unlabelled += 1;
			continue;
		}
		if (!byKey.has(key)) byKey.set(key, entry.body);
	}
	if (byKey.size === 0)
		return { ok: false, reason: "no_provider_request_capture:capture_records_carry_no_submission_key" };
	const { wireMessageText } = await import("../../chat/wire-contract.mjs");
	const ids = wanted ?? [...byKey.keys()];
	const turns = [];
	const missing = [];
	for (const turnId of ids) {
		if (!byKey.has(turnId)) {
			missing.push(turnId);
			continue;
		}
		turns.push({ turnId, ...blocksIn(requestTextOf(byKey.get(turnId), wireMessageText), declaration) });
	}
	const heldKeys = [...byKey.keys()];
	/*
	 * The keys this driver never marked, computed once: `observe` names them, and the writer-side join
	 * gate (`core/recording-provider-proxy.test.mjs`) reads `foreign` as their count.
	 */
	const unmarked = wanted === null ? [] : heldKeys.filter((key) => !wanted.includes(key));
	return {
		ok: true,
		source,
		turns,
		missing,
		heldKeys,
		unmarked,
		foreign: unmarked.length,
		unlabelled,
		unjoinable,
		/* The declared population, so a drift line can name the list the wire disagreed with. */
		sections: declaration.sections,
		truncated: captured.truncated ?? null,
	};
}

const byteLength = (text) => Buffer.byteLength(text, "utf8");
const countOf = (text, pattern) => (text.match(pattern) ?? []).length;

/**
 * Every message's text in the request, in order.
 *
 * The blocks are not always in the system prompt. This product renders the authored catalogue as the first
 * USER message (the cached prefix's M0) and the volatile sources as the message after it, so a reading that
 * asked only for the system message reported `authoredContext=absent` on a turn whose request carried
 * `<gamebuddy-authored-context version="v2">` with two sources - an absence that was the reader's, not the
 * wire's. `wireMessageText` is the live kit's ONE reader of a message's content shape (string or parts), so
 * no second copy of that rule lives here.
 */
function requestTextOf(body, messageText) {
	const messages = Array.isArray(body?.messages) ? body.messages : [];
	return messages.map((message) => messageText(message)).join("\n");
}

/**
 * The section census of one request: which declared sections it carried, what each cost, and which ones
 * it did not carry at all.
 *
 * A byte count per block answers "how big" and nothing else - nobody can read "1173 bytes" and say whether
 * the companion's memory, the world book, its identity or the card's closing direction reached the model.
 * Presence answers those questions, and the sections this request did NOT carry are printed by the name the
 * declaration gives them, because a section that vanished behind a defect looks exactly like a section that
 * was carried empty otherwise.
 *
 * The population is `readInjectionDeclaration()`'s and never a list kept here: a kind, a block or a marker
 * the emitters stop declaring leaves this census without touching its code, and one they start declaring
 * arrives as a section this reader names rather than an unremarked size.
 *
 * The size of a section is the bytes it contributes to the request, with one deliberate exception: the
 * memory directory reports its content, so a directory that was carried but held nothing reads `0B` rather
 * than the width of its own empty wrapper.
 */
function censusOf(text, declaration) {
	/*
	 * Every pattern below ends a tag name at whitespace or `>`, never at `\b`: a hyphen is a word boundary, so
	 * `<session-history\b` also matches `<session-history-since>` - the delta envelope this product wraps the
	 * volatile block in - and a request carrying only the envelope would then read as a carried memory
	 * directory sized by somebody else's block. The same trap waits on `<gamebuddy-authored-context` against a
	 * future `<gamebuddy-authored-context-...>`, so the boundary is spelled once, here.
	 */
	const openTag = (tag) => new RegExp(`<${tag}(?=[\\s>])[^>]*>`, "u");
	const carried = [];
	const openingTag = openTag(declaration.authored.tag).exec(text);
	if (openingTag !== null) carried.push({ name: declaration.authored.tag, bytes: byteLength(openingTag[0]) });

	const kindBytes = new Map();
	const kindsOnWire = [];
	const sourceElements = text.matchAll(
		new RegExp(`<${declaration.authored.source}(?=[\\s>])([^>]*)>[\\s\\S]*?</${declaration.authored.source}>`, "gu"),
	);
	for (const element of sourceElements) {
		const kind = /\bkind="([^"]*)"/u.exec(element[1]);
		if (kind === null) continue;
		kindsOnWire.push(kind[1]);
		kindBytes.set(kind[1], (kindBytes.get(kind[1]) ?? 0) + byteLength(element[0]));
	}
	for (const kind of declaration.stableKinds) {
		if (kindBytes.has(kind)) carried.push({ name: kind, bytes: kindBytes.get(kind) });
	}

	const worldBook = new RegExp(
		`<${declaration.volatile.tag}(?=[\\s>])[^>]*>[\\s\\S]*?</${declaration.volatile.tag}>`,
		"u",
	).exec(text);
	if (worldBook !== null) carried.push({ name: declaration.volatile.kind, bytes: byteLength(worldBook[0]) });

	for (const block of [...declaration.memoryBlocks, declaration.memoryDeltaBlock]) {
		const memory = new RegExp(`<${block}(?=[\\s>])[^>]*>([\\s\\S]*?)</${block}>`, "u").exec(text);
		if (memory !== null) carried.push({ name: block, bytes: byteLength(memory[1]) });
	}

	const closing = new RegExp(
		`<${declaration.closing}(?=[\\s>])[^>]*>[\\s\\S]*?</${declaration.closing}>`,
		"u",
	).exec(text);
	if (closing !== null) carried.push({ name: declaration.closing, bytes: byteLength(closing[0]) });

	/* Declaration order, so two readings of the same request are the same string. */
	const sections = declaration.sections
		.map((name) => carried.find((section) => section.name === name))
		.filter((section) => section !== undefined);
	const absent = declaration.sections.filter((name) => !sections.some((section) => section.name === name));

	/*
	 * Names the wire carries that the declaration does not: a kind or a `<gamebuddy-...>` block nobody counted.
	 * It is reported by name because the alternative - a section the census silently skips - is the very
	 * confusion between "empty" and "vanished" this section exists to end.
	 */
	const wireTags = [...new Set([...text.matchAll(/<(gamebuddy-[a-z0-9-]+)/gu)].map((match) => match[1]))];
	const undeclared = [
		...new Set([
			...wireTags.filter((tag) => !declaration.tags.includes(tag)),
			...kindsOnWire.filter((kind) => !declaration.stableKinds.includes(kind)),
		]),
	];
	return {
		sections,
		absent,
		undeclared,
		/* No marker at all is not a request that carried nothing: it is a request this reader cannot read. */
		unobserved: sections.length === 0 ? "request_carries_no_injection_marker" : null,
	};
}

/** The authored-context and volatile blocks a request carries, with their sizes, and the section census. */
function blocksIn(requestText, declaration) {
	const text = typeof requestText === "string" ? requestText : "";
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
	const census = censusOf(text, declaration);
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
		census,
		unobserved: census.unobserved,
	};
}

/** One turn's injection as one facts-file line: presence, size, what the block named, and the census. */
function describeInjection(turn) {
	const authored = turn.authoredContext.present
		? `present block=${turn.authoredContext.block} bytes=${turn.authoredContext.bytes} sources=${turn.authoredContext.sources} kinds=${JSON.stringify(turn.authoredContext.kinds)}`
		: "absent";
	const volatile = turn.volatileContext.present
		? `present bytes=${turn.volatileContext.bytes} sources=${turn.volatileContext.sources} names=${JSON.stringify(turn.volatileContext.names)} namesFrom=${turn.volatileContext.namesFrom}`
		: "absent";
	const carried = turn.census.sections.map((section) => `${section.name}:${section.bytes}B`).join(",");
	const absent = turn.census.absent.length === 0 ? "none" : turn.census.absent.join(",");
	const undeclared = turn.census.undeclared.length === 0 ? "" : ` undeclared=${turn.census.undeclared.join(",")}`;
	return `authoredContext=${authored} volatileContext=${volatile} sections=${carried} absent=${absent}${undeclared}`;
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
