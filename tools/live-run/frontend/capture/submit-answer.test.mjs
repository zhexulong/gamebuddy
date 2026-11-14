/*
 * The press's answer, and the verdict a driver must reach from it.
 *
 * Every case here is a reading the run of 2026-11-15 actually produced, or the boundary next to one.
 * The first case is the one that cost that run 180 s and a green exit: the Host refused the press
 * (409 `turn_busy`), the transcript held no player row, no turn was ever started - and the driver
 * waited out its budget and reported a skip. The verdict for that reading is a named failure.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { deliverPress, pressVerdict, readSubmitAnswer } from "./submit-answer.cjs";

const problem = (status, code) =>
  JSON.stringify({
    type: "about:blank",
    title: "The command was refused",
    status,
    code,
    requestId: "R".repeat(43),
    retryable: false,
  });

const accepted = (state = "queued") =>
  JSON.stringify({
    apiVersion: 1,
    disposition: "accepted",
    message: { handle: "P".repeat(42) + "A", role: "player", text: "在吗？", locale: "zh", order: 1, revision: 1 },
    turn: { handle: "T".repeat(42) + "A", state, projectionRevision: 1, canCancel: true },
  });

test("a refused press whose answer produced nothing is a named failure, not a skip", () => {
  const answer = readSubmitAnswer({ status: 409, body: problem(409, "turn_busy") });
  assert.deepEqual(
    {
      code: answer.problem?.code,
      disposition: answer.disposition,
      committedRow: answer.committedRow,
      turn: answer.turn,
    },
    { code: "turn_busy", disposition: null, committedRow: false, turn: null },
    "a problem document is a refusal: it names no row and no turn",
  );
  assert.deepEqual(pressVerdict({ answer, playerRows: 0 }), {
    ok: false,
    line: "send_produced_nothing:status=409:code=turn_busy",
  });
});

test("the Host's code is carried verbatim, so the failure names the refusal the player met", () => {
  for (const [status, code] of [
    [409, "draft_conflict"],
    [409, "selection_conflict"],
    [409, "state_reconciliation_required"],
    [503, "runtime_unavailable"],
    [403, "csrf_failed"],
  ]) {
    const answer = readSubmitAnswer({ status, body: problem(status, code) });
    assert.equal(
      pressVerdict({ answer, playerRows: 0 }).line,
      `send_produced_nothing:status=${status}:code=${code}`,
      `${code} must reach the failure line unchanged`,
    );
  }
});

test("a press that never reached the wire reports no answer rather than a wait", () => {
  assert.deepEqual(pressVerdict({ answer: null, playerRows: 0 }), {
    ok: false,
    line: "send_produced_nothing:status=none:code=no_answer",
  });
  assert.equal(readSubmitAnswer({ status: 0, body: null }).document, "none");
});

test("an accepted press that still left no row is named by its own absence", () => {
  const answer = readSubmitAnswer({ status: 202, body: accepted("completed") });
  assert.deepEqual(
    { disposition: answer.disposition, committedRow: answer.committedRow, turn: answer.turn?.state },
    { disposition: "accepted", committedRow: true, turn: "completed" },
    "the accepted shape is read as accepted, with the turn the Host started",
  );
  assert.deepEqual(pressVerdict({ answer, playerRows: 0 }), {
    ok: false,
    line: "send_produced_nothing:status=202:code=no_player_row",
  });
});

test("a press that became a player row passes", () => {
  const refused = readSubmitAnswer({ status: 409, body: problem(409, "turn_busy") });
  assert.deepEqual(pressVerdict({ answer: refused, playerRows: 1 }), { ok: true, line: null });
  assert.deepEqual(pressVerdict({ answer: null, playerRows: 1 }), { ok: true, line: null });
  assert.throws(
    () => pressVerdict({ answer: refused }),
    /pressVerdict_requires_player_rows_read/u,
    "a verdict with no row count is a verdict about nothing",
  );
});

test("a body this reader cannot parse is a refusal with a status, never a drop", () => {
  const answer = readSubmitAnswer({ status: 502, body: "<html>bad gateway</html>" });
  assert.deepEqual(
    { document: answer.document, code: answer.problem, excerpt: answer.excerpt },
    { document: "unreadable", code: null, excerpt: "<html>bad gateway</html>" },
  );
  assert.deepEqual(pressVerdict({ answer, playerRows: 0 }), {
    ok: false,
    line: "send_produced_nothing:status=502:code=no_player_row",
  });
  assert.equal(
    readSubmitAnswer({ status: 500, body: "x".repeat(1200) }).excerpt.length,
    201,
    "the excerpt is bounded, and says so with its own ellipsis",
  );
});

test("a press is delivered as the answer to its own click", async () => {
  const page = {
    waitForResponse: async () => ({ status: () => 409, text: async () => problem(409, "turn_busy") }),
    locator: () => ({ click: async () => undefined }),
  };
  assert.deepEqual(await deliverPress(page), readSubmitAnswer({ status: 409, body: problem(409, "turn_busy") }));

  const silent = {
    waitForResponse: async () => {
      throw new Error("Timeout 15000ms exceeded");
    },
    locator: () => ({ click: async () => undefined }),
  };
  assert.equal(await deliverPress(silent), null, "a press nothing answered is null, not a guess");
});
