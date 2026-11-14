/*
 * What the Host answered the player's press, and what that answer means for the run's verdict.
 *
 * Measured 2026-11-15 (`shots` run, driver `n-message-edit`): the driver typed, clicked send, then
 * polled 90 times at 2 s for a companion row. The Host's answer had been a refusal, no player row was
 * ever committed, and no provider request was ever made - so the row could not arrive, the poll spent
 * its whole 180 s budget, and the driver exited 0 with `SKIPPED:no_player_row_to_edit_after_the_turn`.
 * The run reported green for a press the Host refused, and the driver printed neither the answer nor
 * the fact that nothing happened. The answer was in a `page.on("response")` array the driver only
 * printed two items later, on a path that this run never reached.
 *
 * Two facts were missing, and they are two functions:
 *
 *   readSubmitAnswer   the answer itself - the HTTP status, the Host's bounded problem code and its
 *                      problem document, or for an accepted press the disposition and the turn.
 *   pressVerdict       the decision - a press that produced no player row and no turn is a FAILED
 *                      reading named with the Host's own code, never a skip.
 *
 * Both are pure so a test can hold them without a browser: the driver passes in what it read
 * (`status`, raw `body`), and the surface facts it counted.
 */

/** The submit route: the one answer that says whether the press became a turn. */
const SUBMIT_ROUTE = "/api/tavern/v1/messages";

/**
 * The Host's answer, read once and in the Host's own vocabulary.
 *
 * A 202 carries `SubmitResultV1` (`disposition` + the committed `message` + the `turn` it started);
 * a refusal carries `TavernProblemV1` (`status` + `code` + `title` + `retryable`). The two are
 * different documents and are reported as different facts, because the difference decides whether
 * the press did something: only the accepted shape names a row the transcript can hold.
 *
 * `body` is the raw text, already read by the caller (a Playwright `Response` cannot be read twice,
 * and it must not be read here or this function would own an I/O failure). Unparseable text is
 * reported as `document: "unreadable"` with the first 200 characters kept, never dropped: a refusal
 * whose body this reader could not parse is still a refusal with a status.
 */
function readSubmitAnswer({ status, body = null } = {}) {
	const text = typeof body === "string" ? body : "";
	const document = { kind: "none", value: null };
	if (text.length > 0) {
		try {
			const parsed = JSON.parse(text);
			document.kind = "readable";
			document.value = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
		} catch {
			document.kind = "unreadable";
		}
	}
	const value = document.value;
	const problem =
		document.kind === "readable" && value !== null && typeof value.code === "string"
			? {
					type: typeof value.type === "string" ? value.type : null,
					title: typeof value.title === "string" ? value.title : null,
					status: typeof value.status === "number" ? value.status : null,
					code: value.code,
					retryable: typeof value.retryable === "boolean" ? value.retryable : null,
				}
			: null;
	const turn = value !== null && typeof value.turn === "object" && value.turn !== null ? value.turn : null;
	return {
		status: typeof status === "number" ? status : null,
		document: document.kind,
		problem,
		/* The accepted shape: a disposition, the committed player row, and the turn the Host started. */
		disposition: value !== null && typeof value.disposition === "string" ? value.disposition : null,
		committedRow: value !== null && typeof value.message === "object" && value.message !== null,
		turn: turn === null ? null : { handle: turn.handle ?? null, state: turn.state ?? null },
		excerpt: text.length > 200 ? `${text.slice(0, 200)}…` : text,
	};
}

/**
 * Did the press become something?
 *
 * `playerRows` is what the transcript DOM holds after the press: a real `li.message.player`, never
 * the optimistic `div.message-pending` echo. A row is the press having happened - it is the only
 * thing this driver can edit. No row, with the answer in hand, is the failure this driver exists to
 * name: `send_produced_nothing:status=<n>:code=<code>`, where `<n>` is the answer's status (`none`
 * when no answer arrived at all) and `<code>` is the Host's own bounded code (`no_answer` when there
 * was none, `no_player_row` when an accepted-shaped answer committed nothing the transcript can show).
 */
function pressVerdict({ answer, playerRows }) {
	if (typeof playerRows !== "number") throw new Error("pressVerdict_requires_player_rows_read");
	if (playerRows > 0) return { ok: true, line: null };
	if (answer === null || answer === undefined) return { ok: false, line: "send_produced_nothing:status=none:code=no_answer" };
	const status = answer.status === null ? "none" : String(answer.status);
	const code = answer.problem?.code ?? "no_player_row";
	return { ok: false, line: `send_produced_nothing:status=${status}:code=${code}` };
}

/**
 * Wait for the answer a press earns, without spending a fixed budget on a guess.
 *
 * `page.waitForResponse` is the measurement: the driver's own click is the only request in flight,
 * so the first submit response after it is the answer to it. A press whose click never reached the
 * wire answers `null` (the composer refused it, or the surface was not mounted), which is the same
 * absence `pressVerdict` names as `status=none:code=no_answer` rather than a wait.
 */
async function deliverPress(page, { timeoutMs = 15000 } = {}) {
	const pending = page.waitForResponse(
		(response) => response.url().includes(SUBMIT_ROUTE) && response.request().method() === "POST",
		{ timeout: timeoutMs },
	);
	await page.locator(".composer-button.send-button").click();
	const response = await pending.catch(() => null);
	if (response === null) return null;
	let body = null;
	try {
		body = await response.text();
	} catch {
		body = null;
	}
	return readSubmitAnswer({ status: response.status(), body });
}

module.exports = { SUBMIT_ROUTE, readSubmitAnswer, pressVerdict, deliverPress };
