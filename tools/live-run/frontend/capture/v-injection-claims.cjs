// Driver V: the three authored-context claims, each read in BOTH directions from this run's own wire.
//
// The census (`observation.cjs`) already says which declared section a request carried and how big it
// was. It cannot say whether the fact the player put in the store is the fact the model received, and it
// cannot see a sampler value at all. So this driver produces the CONTRAST the census lacks - a turn with
// the fact bound and a turn with it unbound - and hands both to `injection-claims.mjs`, which reads each
// claim twice and reports `proven` only when the bound turn carried it and the unbound turn did not.
// One direction alone passes on a broken instrument, which is why both are taken from one run.
//
// THE THREE CLAIMS, and what each one's two directions are:
//
//   memory     the player's own durable Memory row, written and archived through the product's own management
//              route (`PUT /api/tavern/v1/memory`: `create`, then `archive`) and read in the block that carries
//              the durable rows, `<project-memory>`.
//              INJECTION PATH, NOT FOLD. A compartment is MODEL OUTPUT and nothing here folds one: this claim is
//              about the block the product renders from durable rows the player's own route wrote.
//              `<session-history>` - the decayed-compartment directory - is a different section fed by a
//              different reader, and this driver says nothing about it (see WHAT THIS RUN CANNOT SAY below).
//
//              WHERE A ROW ATTACHES, measured on the real assembly before this pair was written
//              (`.tmp/memory-attach-probe.ts` drives the real CRUD facade and the real per-turn assembly):
//              `<project-memory>` is rendered when a session's m[0] baseline MATERIALIZES
//              (`inject-compartments-pi.ts:1412` reads the rows; `materializeM0Pi` caches the bytes) and is
//              replayed from that cache on every later turn. A row written after the baseline exists does not
//              reach `<project-memory>` and does not even re-materialize it - `maxMemoryId` is deliberately
//              not a materialization trigger (`inject-compartments-pi.ts:1351-1355`) - it arrives in that
//              turn's m[1] delta as `<new-memories>` (`:2270`). Measured both ways: a fresh session's first
//              turn carried the row in `<project-memory>`; a turn taken after a mid-chat write carried it in
//              `<new-memories>` and in `<project-memory>` not at all.
//              So the pair is taken ACROSS MOUNTS from ONE row: created, then a Chat created after the write
//              (whose fresh baseline contains it), then archived, then a second Chat created after the archive
//              (whose baseline has no memory block at all). The row is the variable and the mount is the
//              condition - the same shape as the world book's pair one claim over.
//   worldBook  one fixture book, ONE field flipped. Two entries are added to her own world book through
//              the product's own route: a control entry that is `enabled: true`, and a probe entry that is
//              `enabled: false`. Both are the book's ALWAYS-ON kind (`constant: true`), so they ride the
//              stable authored block on every turn and a turn must bring the control's text and must NOT
//              bring the probe's. Then the probe's `enabled` is flipped to true in the SAME book (a real
//              fixture toggle through the product, not a second fixture) and a second turn must bring it.
//              The flip is the falsifier, so the flag - not the fixture - is the variable.
//
//              WHY ALWAYS-ON AND NOT KEYWORD-GATED. A keyword-gated entry only reaches a turn that carries
//              its trigger word, so the probe would have to TYPE that trigger into the player's own turn to
//              falsify it - and the player's turn is the one message this driver authors. The 2026-11-12 run
//              did exactly that with probe-identifying strings (`gbw3enabledkey and gbw3disabledkey are both
//              in this line`) and read its own sentence back as the product's injection. `enabled` is the
//              variable in both designs, so the cheaper fixture that needs no probe-authored trigger is the
//              honest one.
//
//              EACH DIRECTION IS MEASURED IN A CHAT CREATED AFTER ITS BOOK WAS WRITTEN, and that is not
//              a convenience. The Chat publishes her authored catalogue ONCE, when it mounts
//              (`host/src/runtime-core.internal.ts:1289-1293`: getSessionId ->
//              `materializeStableContextForPiSession` -> `publishGameBuddyAuthoredStableCatalog`), and the
//              only refresh path (`continuity-semantic-production-coordinator.internal.ts:668`) fires on a
//              MANAGED World Info binding change and on nothing else. `host/src/tavern/companion-world-book-service.ts:218-223`
//              states the rule in the product's own words: "Editing is invisible to a Chat that is already
//              mounted ... it picks this change up when it mounts again." The 2026-11-10 run of this
//              driver flipped the flag INSIDE one mount, took two turns there, and read the world-book
//              section as 313 bytes in both - correctly, because that mount never saw the fixture at all.
//              A fixture that the measured turn cannot observe is not a falsifier, so each reading now
//              comes from a mount that has the book it is asserting about.
//   preset     the preset bound to this run's Chat runtime, in its TWO halves, because they reach the wire by
//              different paths and only one of them can be un-bound while the Host runs:
//
//                prompts   the entries the bound document renders, placed by `preset-request-segments.ts`:
//                          `before` joins the LEADING SYSTEM MESSAGE, `after`/`depth` become `user` messages
//                          after the transcript. Three marker strings that exist nowhere else in the product,
//                          so one `indexOf` decides presence, and the block each one lands in is checked
//                          against its own placement rule rather than against "somewhere in the body".
//                sampling  `temperature` from the fixture's `samplingParams`, spliced into `models.json`
//                          (`withPresetSampling`) and written into the HTTP body as a top-level field.
//
//              WHERE THE PRESET COMES FROM, stated because the product has no route for it: the browser
//              contract declares ONE preset route (`presets.read`, a readout) and `preset-binding.ts`'s
//              `bind`/`clear` are called from nothing in `host/src`, so nothing a player can click imports a
//              preset or binds one. The harness does both BEFORE the Host boots, through the product's own
//              store and binding APIs loaded from the generation this launch installs (`lib/preset-seed.mjs`,
//              `lib/preset-fixture.mjs`) - a real Host on a real root, never a hand-written JSON file. If
//              that seed skips, this driver says `unobserved:no_preset_imported:<reason>` and the claim
//              reports no turn pair rather than a preset that arrived nowhere.
//
//              THE PAIR IS TAKEN ACROSS AN UNBIND, in a Chat mounted after each state - the same discipline the
//              other two claims use, and the reason it matters here: the sampler is re-derived from the binding
//              when a Chat runtime is CONSTRUCTED (`runtime-core.internal.ts:1456`), so the bound turn's Chat
//              carries it and the Chat mounted after the unbind does not. `models.json`'s last write is 3 ms
//              after that mount's surface session appeared, so the write is the mount, not a later rewrite.
//              A run that took its absent turn in the ALREADY-mounted Chat would read
//              `absent_direction_failed` instead (markers gone, sampler still matching) - the shape this
//              reader names.
//
// WHAT THIS RUN CANNOT SAY, named rather than counted as zero:
//
//   `<session-history>` content     a compartment is the Historian's output. This driver will not write
//                                   one into the vendor SQLite: the memory loop's own maintenance
//                                   contract refuses a second connection to that database while the
//                                   product holds it, and a fixture row would stand in for the fold.
//   the m[1] memory delta         a row written inside an ALREADY MOUNTED Chat reaches the next turn as
//                                   `<new-memories>`, not as `<project-memory>` (measured above). This
//                                   claim's pair is the baseline block because that is the block it names,
//                                   so a run with no mid-chat write has no delta reading to take - and this
//                                   driver takes none: it is named here instead of being counted as absent.
//   a sampler that outlives its unbind  this run did not produce it: its absent turn was taken in a Chat
//                                   mounted after the unbind, whose construction saw no binding. A turn in the
//                                   already-mounted Chat would read `absent_direction_failed` with
//                                   `markersInBody=0` and the sampler still matching, and the reader names
//                                   that shape rather than rounding it.
//
// WHAT IT WRITES, AND THAT IT PUTS IT BACK: two entries added to her world book, six Chats created to
// mount them, and one Memory row (created, then archived). The book is restored to the entries it had (by
// the same route, CASing on the revision it reads at the end) and the Memory row is archived, so the
// conversation the player was reading is untouched. The created Chats stay: they are the mounts, they hold
// nothing but the synthetic lines, and deleting them would be a second write this driver has no reading
// for. Every restore is reported with its outcome; a failed restore is printed, never swallowed.
//
// The preset is the one durable fact this driver does NOT put back, because it is the run's own fixture: it
// is unbound on purpose (that is the absent direction) and the run root it lives in is kept for the report.
// It is not the player's preset - a fresh root has none, and the harness imports this one under an id this
// driver names.
//
// NO CONTENT IS PRINTED. The fact strings, the entry texts and the player's line stay in this process:
// what travels is a reading, a section name, a byte count and whether the probe string was found. The ONE
// exception is the preset fixture's three marker strings and its sampler value, which are this lane's own
// opaque bytes rather than anything a player wrote - they are printed so the wire grep in a run's report can
// be reproduced by hand. A LEAK reading prints the marker it found for the same reason: the marker is this
// lane's own opaque bytes, and a leak that did not name it would cost the next reader the afternoon it cost
// this one.
//
// WHAT MAKES THIS PROBE'S OWN EVIDENCE UNCOUNTABLE, asserted rather than promised. Every claim's marker is
// checked against EVERY message of the request it was read from: the marker must sit inside the block its own
// placement rule names, it must never sit inside an `assistant` message (model output no probe wrote), and the
// sentence this driver used to submit must not appear anywhere at all. A finding names the marker and the role
// and makes the driver exit non-zero, because a capture whose instrument wrote its own evidence has measured
// the probe and nothing else (`injection-claims.mjs::messageLeaks` / `instrumentFindings`).
const { readFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");const {
	connect,
	reporter,
	observe,
	observationStart,
	canStartTurn,
	activateSurface,
	createChat,
	REPO_ROOT,
} = require("./common.cjs");

/** Opaque, unique and NFC-safe: one `indexOf` decides presence, and none of it is player prose. */
const TOKEN_ENABLED = "gbw3-enabled-entry-token";
const TOKEN_DISABLED = "gbw3-disabled-entry-token";
const MEMORY_FACT = "gbw3 memory fact: the spare key hangs inside the third pot";
/**
 * The one line every turn of this driver sends, and it is INNOCUOUS PLAYER PROSE.
 *
 * That is a measurement requirement, not a courtesy. This driver is the only author of this line, so every
 * byte in it is the probe's own writing - and the 2026-11-12 run submitted a diagnostic sentence built out
 * of the probe's own strings (`gbw3enabledkey and gbw3disabledkey are both in this line`), which turned the
 * player's turn into a place the probe could then "find" its own markers. A turn that carries a marker, a
 * trigger word or the claim's wording measures the instrument. The world-book entries this driver flips are
 * the book's ALWAYS-ON ones (`constant: true`), so no turn needs to carry a trigger word for them either.
 */
const SAID = "今早我在北边地里忙了一上午，回头跟你细说都干了些什么。";
/**
 * The sentence this driver used to submit as the player's turn, kept ONLY as a negative constant.
 *
 * The reader asserts it never reaches a request body again; without it there is no way to check the one thing
 * the fix promised.
 */
const PROBE_DIAGNOSTIC_SENTENCE = "gbw3enabledkey and gbw3disabledkey are both in this line";

const API = 1;

(async () => {
	const { browser, page } = await connect();
	const { say, flush } = reporter("v-injection-claims.txt");
	const sinceMs = await observationStart(page);

	const get = (path) =>
		page.evaluate(async (target) => {
			const response = await fetch(target, { credentials: "same-origin" });
			return { status: response.status, body: await response.json().catch(() => null) };
		}, path);

	/*
	 * The page's own session facts: the CSRF token a write must carry, and the projection this shell publishes
	 * about memory. Both come from the product's own state read rather than from a request the page happened to
	 * have made before this driver attached a listener - a token learnt from another driver's traffic is a token
	 * this run does not own. Nothing is printed: the token is a session capability.
	 *
	 * The memory fields on this line are recorded as what the shell SAYS, not as a measurement: in this shell the
	 * state handler projects `readAvailable/mutationAvailable = false` as a constant, so they cannot answer whether
	 * a memory row can be written. `memoryHalf` reads the route itself (see there).
	 */
	const state = await get("/api/tavern/v1/state");
	const csrfToken = typeof state.body?.csrfToken === "string" ? state.body.csrfToken : null;
	const memorySnapshot = state.body?.memory ?? null;
	say(
		`STATE: read=${state.status} csrf=${csrfToken === null ? "unobserved:no_csrf_token_in_state" : "present"} memory.read=${memorySnapshot?.readAvailable ?? "unobserved"} memory.mutate=${memorySnapshot?.mutationAvailable ?? "unobserved"}`,
	);

	const put = (path, body) =>
		page.evaluate(
			async ({ target, payload, token }) => {
				const response = await fetch(target, {
					method: "PUT",
					credentials: "same-origin",
					headers: { "Content-Type": "application/json", ...(token === null ? {} : { "x-csrf-token": token }) },
					body: JSON.stringify(payload),
				});
				return { status: response.status, body: await response.json().catch(() => null) };
			},
			{ target: path, payload: body, token: csrfToken },
		);

	/**
	 * Say one line and wait for the turn to settle, then answer the submission key the page marked.
	 *
	 * The key is what joins a turn to its provider request (`observation.cjs::injectionFacts`), so a turn
	 * whose mark carries none cannot be read at all - that is reported as its own reason rather than as a
	 * line that never happened.
	 */
	const sendTurn = async (label, text) => {
		const composed = await canStartTurn(page);
		if (!composed.ok) return { label, sent: false, reason: composed.reason, turnKey: null };
		const from = await page.evaluate(() => performance.now());
		await page.fill("textarea.composer-textarea", text);
		await page.click(".composer-button.send-button");
		/*
		 * Both terminal marks end the wait. Waiting only for `settled` made a FAILED turn cost the full timeout,
		 * and four turns of that is eight minutes of a run that already knows the answer - a failed turn has no
		 * reply to wait for, and its request may still have been posted.
		 */
		await page
			.waitForFunction(
				(mark) =>
					performance
						.getEntriesByType("mark")
						.some(
							(entry) =>
								(entry.name === "gamebuddy:turn:settled" || entry.name === "gamebuddy:turn:failed") &&
								entry.startTime >= mark,
						),
				from,
				{ timeout: 120000 },
			)
			.catch(() => undefined);
		const terminal = await page.evaluate(
			(mark) =>
				performance
					.getEntriesByType("mark")
					.filter(
						(entry) =>
							(entry.name === "gamebuddy:turn:settled" || entry.name === "gamebuddy:turn:failed") &&
							entry.startTime >= mark,
					)
					.map((entry) => entry.name.replace("gamebuddy:turn:", "")),
			from,
		);
		const submits = await page.evaluate(
			(mark) =>
				performance
					.getEntriesByType("mark")
					.filter((entry) => entry.name === "gamebuddy:turn:submit" && entry.startTime >= mark)
					.map((entry) => ({ at: entry.startTime, turnKey: (entry.detail && entry.detail.turnKey) || null })),
			from,
		);
		const last = submits.length === 0 ? null : submits[submits.length - 1];
		const turnKey = last === null ? null : last.turnKey;
		say(
			`TURN ${label}: sent=${last !== null} terminal=${terminal.length === 0 ? "unobserved:no_terminal_mark" : terminal[terminal.length - 1]} key=${turnKey === null ? "unobserved:submit_mark_carries_no_key" : "present"} chars=${text.length}`,
		);
		return { label, sent: last !== null, turnKey, reason: turnKey === null ? "submit_mark_carries_no_key" : null };
	};

	const companionHandle = async () => {
		const companions = await get("/api/tavern/v1/companions");
		const list = Array.isArray(companions.body?.companions) ? companions.body.companions : [];
		const current = list.find((entry) => entry.isCurrent === true) ?? null;
		return { status: companions.status, handle: current === null ? null : current.handle, count: list.length };
	};

	const readBook = async (handle) => {
		const read = await get(`/api/tavern/v1/companions/${handle}/worldbook`);
		const body = read.body ?? {};
		return {
			status: read.status,
			revision: typeof body.revision === "number" ? body.revision : null,
			entries: Array.isArray(body.entries) ? body.entries : [],
		};
	};

	const writeBook = (handle, revision, entries) =>
		put(`/api/tavern/v1/companions/${handle}/worldbook`, { apiVersion: API, expectedRevision: revision, entries });

	/**
	 * The companion and her book, resolved FRESH from the mount that is up now.
	 *
	 * The companion handle is a per-mount HMAC (`desktop-presentation-admission-owner.ts:342-343`,
	 * `lease.browserProjection.projectCompanionHandle`), so the handle a World Book write must carry is the one
	 * the CURRENT lease minted. The 2026-11-12 run read the handle once and wrote the `enabled` flip after
	 * creating a Chat: the handle belonged to the mount before, the route answered 404 `companion_not_found`,
	 * the restore never ran, and the player's book was left carrying two probe entries. That is the probe
	 * switching its own subject mid-measurement, and resolving the handle per write is what removes it.
	 *
	 * The SUBJECT does not change: the mounted companion is the manifest's in-play one for the whole Host run
	 * (`currentCompanionId = manifest.principal.companionId`, same file), so a fresh handle reaches the same
	 * book. The caller checks that rather than assuming it - see `withoutFixture`.
	 */
	const currentBook = async () => {
		const companion = await companionHandle();
		if (companion.handle === null)
			return { handle: null, status: 0, revision: null, entries: [], companions: companion.count };
		const read = await readBook(companion.handle);
		return { handle: companion.handle, status: read.status, revision: read.revision, entries: read.entries };
	};

	/** The book's own fields, as an edit sends them back: the projection's shape, nothing else. */
	const asEntry = (entry) => ({
		title: entry.title,
		keys: Array.isArray(entry.keys) ? entry.keys : [],
		constant: entry.constant === true,
		enabled: entry.enabled !== false,
		content: entry.content ?? "",
	});

	/**
	 * The player's own entries, as one comparable string.
	 *
	 * This is the assertion the operator asked for: a mount that changes the LEASE is allowed (the flip has to
	 * be read from a mount that has the book it asserts about), but the rest of the context must be the same
	 * one - so the two reads are compared and a difference is named instead of read as the toggle's effect.
	 */
	const withoutFixture = (entries, titles) =>
		JSON.stringify(entries.filter((entry) => !titles.includes(entry.title)).map(asEntry));

	const claims = { memory: null, worldBook: null, preset: null };
	const steps = [];

	/**
	 * A Chat created now, so it mounts the book (or the memory baseline) as it stands now.
	 *
	 * The authored catalogue is published at mount (see this driver's header), and a Memory baseline is
	 * materialized by a session's first turn, so a direction can only be measured in a Chat that was created
	 * after the write it is about. A create that does not land is reported by name and that direction is not
	 * taken: a turn read from the previous mount would answer a different question and read exactly like a
	 * product defect.
	 */
	const mountFor = async (half, direction) => {
		// The New Chat control lives on the Chats surface; creating lands in the Chat it made.
		await activateSurface(page, "会话");
		const created = await createChat(page);
		say(
			`${half}: ${direction} mount created=${created.started} committed=${JSON.stringify(created.committed)} landed=${created.landed}`,
		);
		if (created.landed !== true) steps.push({ half, reason: `${direction}_mount_not_created` });
		if (created.landed !== true) return false;
		// A mount that has not drawn its composer yet is a turn this driver cannot send: wait for the
		// field the turn needs, and let `sendTurn` say so by name if it never arrives.
		await page
			.waitForFunction(() => document.querySelector("textarea.composer-textarea") !== null, undefined, {
				timeout: 30000,
			})
			.catch(() => undefined);
		return true;
	};

	const worldBookHalf = async () => {
		const before = await currentBook();
		if (before.handle === null) {
			say(`worldBook: unobserved:no_current_companion:companions=${before.companions}`);
			steps.push({ half: "worldBook", reason: "no_current_companion" });
			return;
		}
		if (before.revision === null) {
			say(`worldBook: unobserved:no_durable_book:status=${before.status}:companions=${before.companions}`);
			steps.push({ half: "worldBook", reason: "no_durable_book" });
			return;
		}
		say(`worldBook: durable book revision=${before.revision} entries=${before.entries.length}`);
		const fixtureTitles = ["w3 control entry", "w3 probe entry"];
		const original = before.entries.map(asEntry);
		/* The book this claim measures, as the two reads after each mount are compared against. */
		const subject = withoutFixture(before.entries, fixtureTitles);
		/*
		 * BOTH entries are the book's ALWAYS-ON kind (`constant: true`), which is why they carry no trigger
		 * words: a keyword-gated fixture would make the probe type the trigger into the player's own turn, and
		 * `enabled` is the only variable this claim needs. A switched-off entry is background the reader leaves
		 * out of both the always-on source and the per-turn volatile list (`worldbook.ts:222-234`).
		 */
		const control = {
			title: "w3 control entry",
			keys: [],
			constant: true,
			enabled: true,
			content: `${TOKEN_ENABLED} this entry is switched on.`,
		};
		const probeEntry = {
			title: "w3 probe entry",
			keys: [],
			constant: true,
			enabled: false,
			content: `${TOKEN_DISABLED} this entry is switched off.`,
		};

		const first = await writeBook(before.handle, before.revision, [...original, control, probeEntry]);
		say(
			`worldBook: fixture added status=${first.status} revision=${first.body?.revision ?? "none"} code=${first.body?.code ?? "none"} entries=${first.body?.entries?.length ?? "none"} (both entries always-on; control enabled, probe enabled:false)`,
		);
		if (first.status !== 200) {
			steps.push({ half: "worldBook", reason: `book_write_refused:${first.status}:${first.body?.code ?? "none"}` });
			return;
		}

		const offTurn =
			(await mountFor("worldBook", "off")) === true
				? await sendTurn("worldbook-off", SAID)
				: null;
		/*
		 * The flip is written against the book the OFF mount is showing, resolved from that same lease. A mount
		 * is allowed - the pair has to read from mounts that carry the book each direction asserts about - but the
		 * subject must not have moved, so the player's own entries are compared before the flip is sent.
		 */
		const offBook = await currentBook();
		say(
			`worldBook: the off mount's own book revision=${offBook.revision ?? "none"} entries=${offBook.entries.length} same-subject=${withoutFixture(offBook.entries, fixtureTitles) === subject}`,
		);
		if (offBook.revision !== null && withoutFixture(offBook.entries, fixtureTitles) !== subject)
			steps.push({ half: "worldBook", reason: "the_mount_changed_the_book_being_measured" });
		const second =
			offBook.revision === null
				? { status: 0, body: { code: "no_book_to_flip" } }
				: await writeBook(offBook.handle, offBook.revision, [...original, control, { ...probeEntry, enabled: true }]);
		say(
			`worldBook: the probe's own enabled flipped false->true status=${second.status} revision=${second.body?.revision ?? "none"} code=${second.body?.code ?? "none"}`,
		);
		if (second.status !== 200) {
			steps.push({ half: "worldBook", reason: `book_flip_refused:${second.status}:${second.body?.code ?? "none"}` });
		}
		const onTurn =
			second.status === 200 && (await mountFor("worldBook", "on")) === true
				? await sendTurn("worldbook-on", SAID)
				: null;
		const onBook = await currentBook();
		say(
			`worldBook: the on mount's own book revision=${onBook.revision ?? "none"} entries=${onBook.entries.length} same-subject=${withoutFixture(onBook.entries, fixtureTitles) === subject}`,
		);
		if (onBook.revision !== null && withoutFixture(onBook.entries, fixtureTitles) !== subject)
			steps.push({ half: "worldBook", reason: "the_mount_changed_the_book_being_measured" });

		// Put the player's book back exactly as it was found, and say what happened.
		const restoreRead = await currentBook();
		const restored =
			restoreRead.revision === null
				? null
				: await writeBook(restoreRead.handle, restoreRead.revision, original);
		say(
			`worldBook: restored status=${restored === null ? "unobserved:no_book_to_restore_into" : restored.status} entries=${original.length}`,
		);

		claims.worldBook = {
			text: TOKEN_DISABLED,
			control: TOKEN_ENABLED,
			turns: { carried: onTurn?.turnKey ?? null, absent: offTurn?.turnKey ?? null },
		};
		if (offTurn !== null && onTurn !== null && (onTurn.turnKey === null || offTurn.turnKey === null))
			steps.push({ half: "worldBook", reason: "a_turn_marked_no_submission_key" });
	};

	const memoryHalf = async () => {
		/*
		 * The memory ROUTE decides, not the state snapshot's projection of it.
		 *
		 * `/api/tavern/v1/state` is served by the reference Chat handler in this shell, and its memory projection
		 * is the literal `{ readAvailable: false, mutationAvailable: false, projectionRevision: null }`
		 * (`host/src/tavern/composed-reference-game-static-shell-composition.ts:441-445`) - a constant, not a
		 * reading of the management routes the same shell mounts beside it. The 2026-11-10 run gated on that
		 * constant, reported `memory_mutation_not_mounted`, wrote no row, and so had no turn pair to read: the
		 * claim came back `probe_names_no_turn_pair`, which is a blocked reading, not a negative one.
		 */
		const readMemory = async () => {
			const read = await get("/api/tavern/v1/memory");
			const body = read.body ?? {};
			return {
				status: read.status,
				code: typeof body.code === "string" ? body.code : null,
				revision: typeof body.projectionRevision === "string" ? body.projectionRevision : null,
				rows: Array.isArray(body.memories) ? body.memories : [],
			};
		};
		const rowNamedTheFact = (rows) =>
			rows.find((row) => typeof row.content === "string" && row.content.includes(MEMORY_FACT)) ?? null;

		const before = await readMemory();
		say(
			`memory: route read status=${before.status} code=${before.code ?? "none"} rows=${before.rows.length} revision=${before.revision === null ? "none" : "present"}`,
		);
		if (before.status !== 200 || before.revision === null) {
			say(`memory: unobserved:memory_route_unreadable:status=${before.status}:code=${before.code ?? "none"}`);
			steps.push({ half: "memory", reason: `memory_route_unreadable:${before.status}:${before.code ?? "none"}` });
			return;
		}
		/*
		 * A disagreement between the projection and the route is worth one line: it is the difference between
		 * "this Host cannot take a memory row" and "this shell does not project one", and only the second is true.
		 */
		if (memorySnapshot?.readAvailable === false)
			say(
				"memory: disagreement:the_state_projection_says_readAvailable=false:the_memory_route_answered_200:the_projection_is_the_reference_shell_constant",
			);

		const created = await put("/api/tavern/v1/memory", {
			apiVersion: API,
			operation: "create",
			expectedProjectionRevision: before.revision,
			content: MEMORY_FACT,
		});
		const createdRow = rowNamedTheFact(created.status === 200 ? (created.body?.memories ?? []) : []);
		// Causal ordering: the row must be durable and read back BEFORE the mount whose baseline is meant to
		// carry it. A mount taken first would leave a miss with two possible causes.
		say(
			`memory: create status=${created.status} code=${created.body?.code ?? "none"} readback=${createdRow === null ? "no_row_named_the_fact" : "row_named_the_fact"}`,
		);
		if (created.status !== 200 || createdRow === null) {
			steps.push({ half: "memory", reason: `memory_create_refused:${created.status}:${created.body?.code ?? "none"}` });
			return;
		}

		// Direction 1: a Chat mounted while the row is durable. Its first turn materializes a baseline that
		// reads the row, which is the only moment `<project-memory>` is written from durable rows.
		const bound =
			(await mountFor("memory", "bound")) === true
				? await sendTurn("memory-bound", SAID)
				: null;

		/*
		 * The archive is read fresh, not carried over from the create: mounting a Chat swaps the lane, and the
		 * management Memory service mints its handles and its projection revision from a per-mount secret
		 * (`host/src/tavern/memory-management/memory-management.ts:76-78,188-190`), so the handle and revision the
		 * create returned address the lane that has just been replaced.
		 */
		const mountedRead = await readMemory();
		const mountedRow = mountedRead.revision === null ? null : rowNamedTheFact(mountedRead.rows);
		const archived =
			mountedRow === null
				? { status: 0, body: { code: "row_not_found_after_mount" } }
				: await put("/api/tavern/v1/memory", {
						apiVersion: API,
						operation: "archive",
						expectedProjectionRevision: mountedRead.revision,
						handle: mountedRow.handle,
					});
		say(
			`memory: archive status=${archived.status} code=${archived.body?.code ?? "none"} rowReadback=${mountedRow === null ? "none" : "present"}`,
		);
		if (archived.status !== 200) {
			steps.push({ half: "memory", reason: `memory_archive_refused:${archived.status}:${archived.body?.code ?? "none"}` });
			claims.memory = {
				fact: MEMORY_FACT,
				sections: ["project-memory"],
				turns: { carried: bound?.turnKey ?? null, absent: null },
			};
			if (bound !== null && bound.turnKey === null)
				steps.push({ half: "memory", reason: "a_turn_marked_no_submission_key" });
			return;
		}

		// Direction 2: a Chat mounted after the archive, whose baseline has no memory block at all.
		const unbound =
			(await mountFor("memory", "absent")) === true
				? await sendTurn("memory-unbound", SAID)
				: null;
		/*
		 * `sections` is the claim's own block list, not the declaration's whole memory population: this pair is
		 * about `<project-memory>`, and a fact that turned up in `<session-history>` or in the m[1] delta would be
		 * a different carrier answering a different question.
		 */
		claims.memory = {
			fact: MEMORY_FACT,
			sections: ["project-memory"],
			turns: { carried: bound?.turnKey ?? null, absent: unbound?.turnKey ?? null },
		};
		if (unbound !== null && unbound.turnKey === null)
			steps.push({ half: "memory", reason: "a_turn_marked_no_submission_key" });
		if (bound !== null && bound.turnKey === null)
			steps.push({ half: "memory", reason: "a_turn_marked_no_submission_key" });
	};

	/**
	 * The preset fact the launch phase wrote, or a named reason it is absent.
	 *
	 * A launch state that names no preset and a seed that skipped are different silences, so they get different
	 * reasons: the first is a harness too old to have planted one, the second is this run failing to import a
	 * preset the product has no route for.
	 */
	const presetFact = () => {
		let state = null;
		try {
			state = JSON.parse(readFileSync(process.env.GB_SHOTS_LAUNCH_STATE ?? "", "utf8"));
		} catch {
			state = null;
		}
		if (state === null) return { ok: false, reason: "launch_state_unreadable" };
		if (state.preset === null || state.preset === undefined) return { ok: false, reason: "launch_state_names_no_preset" };
		if (state.preset.kind !== "seeded") return { ok: false, reason: String(state.preset.reason ?? "unknown") };
		if (
			typeof state.artifactRoot !== "string" ||
			typeof state.declaredDataRoot !== "string" ||
			state.principal === null ||
			state.principal === undefined
		)
			return { ok: false, reason: "launch_state_lacks_the_paths_an_unbind_needs" };
		return {
			ok: true,
			preset: state.preset,
			artifactRoot: state.artifactRoot,
			runtimeRoot: state.declaredDataRoot,
			principal: state.principal,
		};
	};

	/** The carried direction: a turn taken while the harness's preset is in force. */
	const presetBoundTurn = async () => {
		const fact = presetFact();
		if (fact.ok !== true) {
			say(`preset: unobserved:no_preset_imported:${fact.reason}`);
			steps.push({ half: "preset", reason: `no_preset_imported:${fact.reason}` });
			return null;
		}
		say(
			`preset: bound before this Host mounted id=${fact.preset.presetId} revision=${fact.preset.revision} markers=${JSON.stringify(fact.preset.markers)} sampling=${fact.preset.sampling.key}=${fact.preset.sampling.value}`,
		);
		const turn = (await mountFor("preset", "bound")) === true ? await sendTurn("preset-bound", SAID) : null;
		return { fact, turn };
	};

	/**
	 * The absent direction: unbind through the same store the Host read the binding from, then take a turn.
	 *
	 * The unbind is a real product write (the binding file is the authority the Host re-reads before every
	 * prompt), performed with `createPresetBindingStore().clear()` loaded from the generation this run
	 * installs - there is no route a player could use, so the harness names what it did instead.
	 */
	const presetUnboundTurn = async (bound) => {
		if (bound === null) return null;
		const { clearRunPreset } = await import("../lib/preset-seed.mjs");
		const cleared = await clearRunPreset({
			artifactRoot: bound.fact.artifactRoot,
			runtimeRoot: bound.fact.runtimeRoot,
			principal: bound.fact.principal,
		});
		say(
			`preset: unbind ${cleared.kind}${cleared.kind === "cleared" ? ` named=${cleared.presetId ?? "none"}` : ` reason=${cleared.reason}`}`,
		);
		if (cleared.kind !== "cleared" || cleared.presetId === null) {
			steps.push({ half: "preset", reason: `unbind_${cleared.kind}` });
			return null;
		}
		return (await mountFor("preset", "unbound")) === true ? await sendTurn("preset-unbound", SAID) : null;
	};

	say(`=== ITEM: the preset in force, taken before the world book ===`);
	const presetBound = await presetBoundTurn();

	say(`=== ITEM: the world book, one flag flipped in the same fixture ===`);
	if (csrfToken === null) {
		/*
		 * Both halves are writes, and the product refuses every write without the session's own token. Saying so
		 * once is honest; letting two PUTs fail with 403 and reading those refusals as a claim about injection is
		 * the substitution that makes a broken driver look like a product defect.
		 */
		say("worldBook: unobserved:no_csrf_token_in_state:a_book_edit_is_a_write");
		say("memory: unobserved:no_csrf_token_in_state:a_memory_row_is_a_write");
		steps.push({ half: "worldBook", reason: "no_csrf_token_in_state" }, { half: "memory", reason: "no_csrf_token_in_state" });
	} else {
		await worldBookHalf();
		say(`=== ITEM: her memory, written and archived through the management route ===`);
		await memoryHalf();
	}

	say(`=== ITEM: the same preset, unbound, in a Chat mounted after the unbind ===`);
	const presetUnbound = await presetUnboundTurn(presetBound);
	if (presetBound !== null) {
		claims.preset = {
			/* The anchor for "after the transcript": the driver's own line, which it may look for and never print. */
			playerLine: SAID,
			markers: presetBound.fact.preset.markers,
			sampling: presetBound.fact.preset.sampling,
			turns: { carried: presetBound.turn?.turnKey ?? null, absent: presetUnbound?.turnKey ?? null },
		};
		if (presetBound.turn === null || presetBound.turn?.turnKey === null)
			steps.push({ half: "preset", reason: "the_bound_turn_marked_no_submission_key" });
		if (presetUnbound !== null && presetUnbound.turnKey === null)
			steps.push({ half: "preset", reason: "the_unbound_turn_marked_no_submission_key" });
	}

	say(`=== ITEM: the three claims, read from this run's own capture ===`);
	const { readClaimsFromCaptureFile, describeClaims, presetSamplingCallers } = await import("./injection-claims.mjs");
	const captureFile = process.env.GB_SHOTS_WIRE_REQUESTS;
	const probe = {
		memory: claims.memory,
		worldBook: claims.worldBook,
		preset: claims.preset,
		/*
		 * The turn this driver itself typed, and the sentence it used to type. Those are the only bytes in a
		 * request body the probe authored, so they are the two things the reader's instrument assertions check:
		 * a marker inside the turn, or the old diagnostic sentence anywhere, is the probe certifying itself.
		 */
		said: SAID,
		diagnosticSentence: PROBE_DIAGNOSTIC_SENTENCE,
	};
	const reading = await readClaimsFromCaptureFile({ captureFile, probe });
	for (const line of describeClaims("v", reading)) say(line);
	/*
	 * The world-book control is the half a single pair cannot state: the control entry is enabled in BOTH
	 * turns, so its presence in both is what says the flip changed one variable and not the block itself.
	 */
	let controlInstrument = [];
	if (reading.ok === true && claims.worldBook !== null) {
		const control = await readClaimsFromCaptureFile({
			captureFile,
			probe: {
				worldBook: { text: claims.worldBook?.control ?? "", turns: claims.worldBook?.turns ?? {} },
				said: SAID,
				diagnosticSentence: PROBE_DIAGNOSTIC_SENTENCE,
			},
		});
		/*
		 * A CONTROL IS NOT A CLAIM. The control entry is enabled in BOTH directions, so its presence in the
		 * absent turn is exactly what it is for - and reading it through the claim vocabulary labelled it
		 * `absent_direction_failed` on a body that carried the control exactly as intended. A control that reads
		 * like a failure is the mirror of a claim that passes by asserting less, so it prints its own line and
		 * the claim vocabulary is left to the claims.
		 */
		const controlClaim =
			control.ok === true ? ((control.claims ?? []).find((one) => one.name === "worldBook") ?? null) : null;
		const carriedIn = (side) => controlClaim?.readings?.[side]?.detail?.inBody === true;
		const inBoth = carriedIn("carried") && carriedIn("absent");
		say(
			`INJECTION v-control claim=worldBook control=${inBoth ? "carried-in-both-turns" : "the_control_entry_did_not_ride_both_turns"} carried=${carriedIn("carried")} absent=${carriedIn("absent")}`,
		);
		for (const side of ["carried", "absent"]) {
			const detail = controlClaim?.readings?.[side]?.detail ?? null;
			if (detail === null) continue;
			say(
				`INJECTION v-control claim=worldBook reading=${side}: turn=${detail.turn} bytes=${detail.sectionBytes ?? "none"} inBody=${detail.inBody} inAuthoredBlock=${detail.inAuthoredBlock}`,
			);
			for (const leak of detail.leaks ?? [])
				say(
					`INJECTION v-control claim=worldBook reading=${side} leak: marker=${leak.marker} label=${leak.label} role=${leak.role} at=${leak.at} why=${leak.reason}`,
				);
		}
		controlInstrument = control.ok === true ? (control.instrument ?? []) : [];
	}
	/*
	 * An instrument that wrote its own evidence makes every claim above it a reading of the PROBE, so the run
	 * is red rather than green and the count is visible with names (`phases/capture.mjs` prints the failed
	 * driver keys). A capture whose instrument is dirty has measured nothing about the product.
	 */
	const instrument = [...(reading.ok === true ? (reading.instrument ?? []) : []), ...controlInstrument];
	say(`INJECTION v instrument readings=${instrument.length}`);
	if (instrument.length > 0) process.exitCode = 1;

	/*
	 * The seam's own caller census, beside the reading rather than instead of it: it names the production file
	 * that folds the bound preset's values into the provider entry, so a reader can see the path the sampler
	 * took. It used to stand in for a carried reading that did not exist; it is now the receipt for one.
	 */
	const seam = presetSamplingCallers(join(REPO_ROOT, "host", "src"));
	say(
		`INJECTION v claim=preset seam=${seam.ok === true ? "measured" : `unobserved:${seam.reason}`} callers=${seam.ok === true ? seam.callers.join(",") || "none" : "unobserved"} files=${seam.files}`,
	);
	/* The wire's own sampler values, key by key: the preset claim reads ONE key, and this says what else the
	 * same bodies carried (a model's own default, another layer's value) so nothing is read into a silence. */
	const capturedForSampling = reading.ok === true ? readFileSync(captureFile, "utf8") : "";
	const samplerKeys = ["temperature", "top_p", "top_k", "min_p", "repetition_penalty", "presence_penalty", "frequency_penalty"];
	const samplerSeen = new Map();
	for (const line of capturedForSampling.split("\n")) {
		if (line.trim().length === 0) continue;
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof record?.idempotencyKey !== "string") continue;
		const body = record.body ?? {};
		for (const key of samplerKeys) if (Object.hasOwn(body, key)) samplerSeen.set(key, String(body[key]));
	}
	say(
		`INJECTION v claim=sampling reading=wire: ${samplerKeys
			.map((key) => `${key}=${samplerSeen.has(key) ? samplerSeen.get(key) : "not-carried"}`)
			.join(" ")}`,
	);

	await observe(page, say, "v", { sinceMs });
	say(`STEPS: ${JSON.stringify(steps)}`);
	await flush();
	await browser.close().catch(() => undefined);
})().catch((error) => {
	console.log(`DRIVER v-injection-claims FAILED: ${String(error).slice(0, 600)}`);
	process.exit(1);
});
