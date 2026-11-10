/*
 * The chat capability observations that do not need a declared expectation: a real shipped worldbook
 * entry and the rendered transcript, read from the same live page the drivers use.
 *
 * The conversational-quality gate at `tools/check-chat-conversational-quality-gate.mjs` has four
 * dimensions, and three of them need `expectations.needleFacts` / `memorySupersedes` /
 * `lorebookRules` - a declaration of what SHOULD happen. Nobody has declared one for a live run, so
 * those three answer `blocked`, honestly.
 *
 * Two of them can be observed without a declaration, because the authority already exists:
 *
 *   lorebookTrigger   the shipped worldbook has an entry with `constant: true` and keys
 *                     ["农场","开拓","伙伴","约定"]. Saying a line containing one of those keys is a
 *                     real trigger, and the entry's content must then be in the assembled prompt.
 *                     The expectation is not invented here: it is read from the worldbook file.
 *
 *   transcriptShape   the transcript must contain the player's line and the companion's reply, in that
 *                     order, with no duplicated reply for one turn. That is a shape, not a judgement
 *                     of quality, and it needs no expectation either.
 *
 * What this deliberately does NOT do is score the reply. "Is she in character" needs the judge work
 * that has not been built, and a number produced by a heuristic here would look like that work had
 * been done.
 *
 * `transcriptContinuityFindings` extends the shape half across turns, which is where a one-exchange
 * snapshot cannot see anything: a row lost between turns, a message committed twice, or an order that
 * goes backwards are all invisible to a reading taken once.
 */
const { readFileSync } = require("node:fs");
const path = require("node:path");

const REPO = path.resolve(__dirname, "../../../..");

function loadChromium() {
	for (const candidate of [
		path.join(REPO, "dialogue-web", "node_modules", "@playwright", "test"),
		path.join(REPO, "dialogue-web", "node_modules", "playwright"),
		path.join(REPO, "node_modules", "playwright"),
	]) {
		try {
			return require(candidate).chromium;
		} catch {
			/* next */
		}
	}
	throw new Error("no playwright found");
}

/**
 * The worldbook's always-on entries, the keys that gate the rest, and the entries the book switches off.
 *
 * Read from the file, not typed. `enabled: false` is the product's own SillyTavern switch
 * (`host/src/worldbook.ts`, `WorldBookEntry.enabled`): the entry is kept, listed and editable, and
 * "reaches nothing: not the always-on block, not the per-turn candidates, not the lookup tools". So an
 * expectation built without reading it would demand that the prompt carry an entry the product must not
 * carry - a reading that blames the product for obeying its own rule, and that no live run could ever
 * satisfy. The `disabled` list is returned rather than dropped because the other direction of the same
 * claim is read from it: these entries must be absent from the request.
 */
function worldbookExpectation(worldbookPath) {
	const book = JSON.parse(readFileSync(worldbookPath, "utf8"));
	const entries = Array.isArray(book.entries) ? book.entries : [];
	const reaches = entries.filter((entry) => entry.enabled !== false);
	const constant = reaches.filter((entry) => entry.constant === true);
	const gated = reaches.filter(
		(entry) => entry.constant !== true && Array.isArray(entry.keys) && entry.keys.length > 0,
	);
	return {
		alwaysOn: constant.map((entry) => ({ entryId: entry.entryId, title: entry.title, keys: entry.keys || [] })),
		gated: gated.map((entry) => ({ entryId: entry.entryId, title: entry.title, keys: entry.keys })),
		disabled: entries
			.filter((entry) => entry.enabled === false)
			.map((entry) => ({ entryId: entry.entryId, title: entry.title, keys: entry.keys || [] })),
	};
}

/**
 * Say a line carrying one of the always-on entry's keys, then wait for the turn to settle.
 *
 * The key comes from the worldbook rather than being written here: if the shipped entry's keys
 * change, this probe follows them instead of testing a phrase nothing gates on any more.
 */
async function probeLorebookTrigger(page, key, timeoutMs = 25000) {
	const said = `今天${key}的事你怎么看`;
	await page.fill("textarea.composer-textarea", said);
	await page.click(".composer-button.send-button");
	await page
		.waitForFunction(
			() => performance.getEntriesByType("mark").some((entry) => entry.name === "gamebuddy:turn:settled"),
			undefined,
			{ timeout: timeoutMs },
		)
		.catch(() => undefined);
	return said;
}

/** The transcript the surface is showing, in order, with roles. */
async function readRenderedTranscript(page) {
	return page.evaluate(() => {
		const rows = [...document.querySelectorAll("ol.message-list li.message")];
		return rows.map((row) => ({
			role: row.getAttribute("data-role") || (row.className.includes("player") ? "player" : "companion"),
			text: (row.querySelector(".message-text")?.textContent || row.textContent || "").trim().slice(0, 400),
		}));
	});
}

/**
 * The shape assertions that need no declared expectation.
 *
 * `expectedPlayerLines` is how many player lines the probe produced; the companion must have answered
 * each exactly once, in order. A duplicated companion row for one player line is what a
 * double-committed turn looks like in the transcript.
 */
function transcriptShapeFindings(transcript, options = {}) {
	const expectedPlayerLines = options.expectedPlayerLines === undefined ? 1 : options.expectedPlayerLines;
	const settled = options.settled === true;
	const findings = [];
	const player = transcript.filter((row) => row.role === "player");
	const companion = transcript.filter((row) => row.role === "companion");
	if (player.length !== expectedPlayerLines) {
		findings.push({
			code: "player_line_count",
			message: `expected ${expectedPlayerLines} player line(s), the surface shows ${player.length}`,
		});
	}
	for (let i = 0; i < transcript.length; i += 1) {
		if (transcript[i].role !== "player") continue;
		const next = transcript[i + 1];
		if (next === undefined) {
			if (settled) {
				findings.push({
					code: "player_line_unanswered",
					message: `player row ${i} is the last row after the turn settled`,
				});
			}
			continue;
		}
		if (next.role !== "companion") {
			findings.push({
				code: "player_line_not_followed_by_companion",
				message: `player row ${i} is followed by a ${next.role} row`,
			});
			continue;
		}
		const after = transcript[i + 2];
		if (after !== undefined && after.role === "companion") {
			findings.push({
				code: "companion_double_reply",
				message: `player row ${i} is answered twice (rows ${i + 1} and ${i + 2})`,
			});
		}
	}
	const empty = transcript.filter((row) => row.text.length === 0);
	if (empty.length > 0) findings.push({ code: "empty_row", message: `${empty.length} row(s) render no text` });
	return findings;
}

/**
 * The always-on worldbook entries and their gating keys, read from the state body the caller already
 * has.
 *
 * Takes the parsed state rather than fetching it: `readDurableTranscript` in `common.cjs` already holds
 * the one authenticated read of `/api/tavern/v1/state`, and a second fetch from this module failed with
 * `TypeError: Failed to fetch` on a page connected over CDP - a different execution context from the
 * one the driver launched. One read, passed down, avoids both the second request and the context
 * mismatch.
 *
 * Returns a one-line summary, because that is what a facts file holds.
 */
function worldbookSummary(state) {
	const entries = state?.worldBook?.entries ?? state?.chat?.worldBook?.entries ?? null;
	if (entries === null) return "unobserved:no_worldbook_in_state";
	const constant = entries.filter((entry) => entry.constant === true);
	if (constant.length === 0) {
		return `unobserved:no_always_on_entry (${entries.length} entries, all keyword-gated)`;
	}
	const first = constant[0];
	return `ok alwaysOn=${constant.length} of ${entries.length} first=${JSON.stringify(first.entryId)} keys=${JSON.stringify(first.keys ?? [])}`;
}

/**
 * The durable transcript's growth across turns: append-only, in order, every row still there once.
 *
 * `transcriptShapeFindings` above judges ONE exchange, so it cannot see the defect that only appears
 * on the second turn - a row lost between turns, a message committed twice by a re-read, or an order
 * that goes backwards when a later turn is inserted before an earlier one. Those are the shapes a
 * two-turn conversation produces and a one-turn snapshot cannot.
 *
 * The input is the sequence of durable snapshots a driver already takes (`/api/tavern/v1/state`),
 * each with the order/role/handle the Host minted. Two invariants, both about rows rather than counts:
 *
 *   within a snapshot   order strictly increases (it is the transcript's own sequencing), and no handle
 *                       appears twice (a handle is one message).
 *   across snapshots    every handle the earlier snapshot held is still present later, keeps its
 *                       relative order, and nothing new is inserted BEFORE an existing row.
 *
 * A step that is SUPPOSED to remove rows (a delete, a rewind) declares them in `removedHandles`; a row
 * that vanishes without a declaration is the finding, which is what makes the declared list useful
 * rather than a licence to lose rows.
 */
function transcriptContinuityFindings(snapshots) {
	const findings = [];
	const list = Array.isArray(snapshots) ? snapshots : [];
	let previous = null;
	for (const snapshot of list) {
		const rows = Array.isArray(snapshot?.rows) ? snapshot.rows : [];
		const label = typeof snapshot?.label === "string" ? snapshot.label : "snapshot";
		const declared = new Set(Array.isArray(snapshot?.removedHandles) ? snapshot.removedHandles : []);

		for (let index = 1; index < rows.length; index += 1) {
			const before = rows[index - 1]?.order;
			const after = rows[index]?.order;
			if (typeof before !== "number" || typeof after !== "number") {
				findings.push({
					code: "order_unreadable",
					message: `${label}: row ${index} carries order ${JSON.stringify(after)} after row ${index - 1}'s ${JSON.stringify(before)}`,
				});
				continue;
			}
			if (after <= before) {
				findings.push({
					code: "order_not_monotonic",
					message: `${label}: row ${index} carries order ${after} after row ${index - 1}'s ${before}`,
				});
			}
		}

		const seen = new Set();
		rows.forEach((row, index) => {
			if (row?.handle === null || row?.handle === undefined) {
				findings.push({ code: "row_without_handle", message: `${label}: row ${index} carries no handle` });
				return;
			}
			if (seen.has(row.handle)) {
				findings.push({
					code: "row_duplicated",
					message: `${label}: handle ${JSON.stringify(row.handle)} is carried twice, so one turn committed the same message twice`,
				});
			}
			seen.add(row.handle);
		});

		if (previous !== null) {
			const present = rows.map((row) => row?.handle).filter((handle) => handle !== null && handle !== undefined);
			const presentSet = new Set(present);
			for (const handle of previous.handles) {
				if (presentSet.has(handle) || declared.has(handle)) continue;
				findings.push({
					code: "row_lost",
					message: `${label}: handle ${JSON.stringify(handle)}, present in "${previous.label}", is gone and this step did not declare its removal`,
				});
			}
			const survivors = present.filter((handle) => previous.handles.includes(handle));
			const expectedOrder = previous.handles.filter((handle) => presentSet.has(handle));
			if (survivors.join("\u0000") !== expectedOrder.join("\u0000")) {
				findings.push({
					code: "row_reordered",
					message: `${label}: the rows "${previous.label}" already held are in a different relative order (${JSON.stringify(survivors)} against ${JSON.stringify(expectedOrder)})`,
				});
			}
		}
		previous = { label, handles: rows.map((row) => row?.handle).filter((handle) => handle !== null && handle !== undefined) };
	}
	return findings;
}

/**
 * One facts-file line for the continuity invariants, so both callers spell them the same way.
 *
 * Named `ok` versus `FAIL` rather than a count: "3 snapshots, 7 rows" is a reading of how big the
 * conversation got, which is not what this checks.
 */
function continuityLine(label, snapshots) {
	const findings = transcriptContinuityFindings(snapshots);
	if (findings.length === 0) {
		return `ok ${label}: ${snapshots.length} snapshot(s) append-only, order strictly increasing, no row lost and none duplicated`;
	}
	return `FAIL ${label}: ${findings.map((finding) => `${finding.code} - ${finding.message}`).join(" | ")}`;
}

module.exports = {
	loadChromium,
	worldbookExpectation,
	worldbookSummary,
	probeLorebookTrigger,
	readRenderedTranscript,
	transcriptShapeFindings,
	transcriptContinuityFindings,
	continuityLine,
};
