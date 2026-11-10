/**
 * The readings seam: `tools/lib/reading.mjs`.
 *
 * WHAT THIS PROTECTS. Measured 2026-11-10, in one session, five numbers printed as facts and five wrong in five
 * different ways - 97 `plan_work` calls that were 26, `unaccounted 0` over 13 of 59 pieces, "till 16 tiles" from plan
 * coordinates where the receipts said 9, "no mining at all" from one point in time, "9 failing tests" whose count
 * depended on the mode they ran in. Each failure is one of the facts this suite pins: a value that cannot be written
 * without its population, a window that cannot be omitted, a second method that must be consulted, and a census that
 * refuses to render an empty collection as zero.
 *
 * The assertions are shaped so they cannot pass by accident:
 *
 *   - every refusal is asserted by its stable `code`, not by message text, so a caller keying on
 *     `reading_population_missing` keeps working when the prose is rewritten;
 *   - the rendered line is asserted to CARRY all four facts, so a `format` that quietly dropped the window fails;
 *   - `format(26)` is asserted to throw: a bare number is not renderable, which is the whole point;
 *   - the cross-check is driven with the real numbers from the run that produced them (97 mentions of the name in a
 *     session text, 26 toolCall parts in the same file), so the mechanism is proved against the defect, not against a
 *     synthetic one.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { census, crossCheck, format, formatCensus, ReadingError, reading, verdictFrom } from "./reading.mjs";

const WINDOW = Object.freeze({
  start: Date.parse("2026-11-10T09:01:00.000Z"),
  end: Date.parse("2026-11-10T09:21:00.000Z"),
});

const toolCalls = (value, total = value) =>
  reading({
    value,
    population: { unit: "toolCall parts", total },
    source: "session.jsonl",
    method: "structured parse of message.content",
    window: WINDOW,
  });

const codeOf = (body) => {
  try {
    body();
  } catch (error) {
    assert.ok(error instanceof ReadingError, `expected a ReadingError, got ${error?.name}: ${error?.message}`);
    return error.code;
  }
  assert.fail("expected a refusal and the call returned instead");
};

test("a reading without a population is refused by name", () => {
  assert.equal(
    codeOf(() =>
      reading({ value: 26, source: "session.jsonl", method: "structured parse", window: { wholeRun: true } }),
    ),
    "reading_population_missing",
  );
  assert.equal(
    codeOf(() =>
      reading({
        value: 26,
        population: { unit: "", total: 26 },
        source: "session.jsonl",
        method: "structured parse",
        window: { wholeRun: true },
      }),
    ),
    "reading_population_missing",
  );
});

test("a value larger than its population is refused: the two count different things", () => {
  assert.equal(
    codeOf(() => toolCalls(97, 26)),
    "reading_value_exceeds_population",
  );
  assert.equal(
    codeOf(() =>
      reading({
        value: -1,
        population: { unit: "toolCall parts", total: 26 },
        source: "session.jsonl",
        method: "structured parse",
        window: { wholeRun: true },
      }),
    ),
    "reading_value_invalid",
  );
});

test("a null value without notMeasured is refused, and with it prints as not measured rather than 0", () => {
  const missing = { value: null, population: { unit: "result.json executions", total: 0 }, source: "result.json" };
  assert.equal(
    codeOf(() => reading({ ...missing, method: "bundle", window: { wholeRun: true } })),
    "reading_not_measured_undeclared",
  );
  const rendered = format(
    reading({
      ...missing,
      method: "bundle",
      window: { wholeRun: true },
      notMeasured: { reason: "the run published no programOutcomes", missingField: "programOutcomes[].executions" },
    }),
  );
  assert.match(rendered, /^not measured: result\.json executions/);
  assert.match(rendered, /needs programOutcomes\[\]\.executions$/);
  assert.doesNotMatch(rendered, /\b0 of\b/);
});

test("the window is mandatory and cannot be left to the reader", () => {
  const base = { value: 9, population: { unit: "receipts", total: 16 }, source: "result.json", method: "receipt scan" };
  assert.equal(
    codeOf(() => reading(base)),
    "reading_window_missing",
  );
  assert.equal(
    codeOf(() => reading({ ...base, window: { start: WINDOW.end, end: WINDOW.start } })),
    "reading_window_inverted",
  );
  assert.equal(
    codeOf(() => reading({ ...base, window: { wholeRun: true, start: WINDOW.start, end: WINDOW.end } })),
    "reading_window_ambiguous",
  );
});

test("format carries the value, its population, its source, its method and its window in one line", () => {
  assert.equal(
    format(toolCalls(26)),
    "26 of 26 toolCall parts (session.jsonl, structured parse of message.content, this run's window 09:01-09:21)",
  );
  assert.equal(
    format({ ...toolCalls(26), window: Object.freeze({ kind: "wholeRun" }) }),
    "26 of 26 toolCall parts (session.jsonl, structured parse of message.content, the whole run)",
  );
});

test("a quotient declares the unit it produced, so the share does not read as a subset", () => {
  const tasks = reading({
    value: 8,
    population: { unit: "player_input events", total: 24 },
    source: "session.jsonl",
    method: "declared texts, deduped",
    window: { wholeRun: true },
    quotient: { unit: "declared player tasks" },
  });
  assert.equal(
    format(tasks),
    "8 declared player tasks from 24 player_input events (session.jsonl, declared texts, deduped, the whole run)",
  );
  assert.equal(
    codeOf(() =>
      reading({
        value: 30,
        population: { unit: "player_input events", total: 24 },
        source: "session.jsonl",
        method: "declared texts, deduped",
        window: { wholeRun: true },
        quotient: { unit: "declared player tasks" },
      }),
    ),
    "reading_value_exceeds_population",
  );
});

test("a bare number is not renderable", () => {
  assert.equal(
    codeOf(() => format(26)),
    "reading_not_a_reading",
  );
  assert.equal(
    codeOf(() => format(`${26} calls`)),
    "reading_not_a_reading",
  );
});

test("the round43 re-derivation: 97 mentions and 26 calls disagree, and the disagreement blocks the verdict", () => {
  const mentions = reading({
    value: 97,
    population: { unit: "mentions of `plan_work` in the session text", total: 97 },
    source: "round43 session.jsonl",
    method: "substring count",
    window: { wholeRun: true },
  });
  const calls = reading({
    value: 26,
    population: { unit: "plan_work toolCall parts", total: 26 },
    source: "round43 session.jsonl",
    method: "structured parse of message.content",
    window: { wholeRun: true },
  });
  const check = crossCheck(mentions, calls);
  assert.equal(check.outcome, "disagree");
  assert.equal(check.reason, "the two readings count different units");
  assert.match(
    check.text,
    /97 of 97 mentions of `plan_work` in the session text \(round43 session\.jsonl, substring count, the whole run\)/,
  );
  assert.match(
    check.text,
    /26 of 26 plan_work toolCall parts \(round43 session\.jsonl, structured parse of message\.content, the whole run\)/,
  );
  assert.match(check.text, /-> DISAGREE/);
  assert.equal(verdictFrom(check, "PASS"), "BLOCKED");
});

test("agreement needs the same unit, the same population and the same value", () => {
  const agreed = crossCheck(toolCalls(26), toolCalls(26));
  assert.equal(agreed.outcome, "agree");
  assert.equal(verdictFrom(agreed, "PASS"), "PASS");

  const valueDrift = crossCheck(toolCalls(26), toolCalls(25, 26));
  assert.equal(valueDrift.outcome, "disagree");
  assert.equal(valueDrift.reason, "the same population, two different values");

  const populationDrift = crossCheck(toolCalls(26, 26), toolCalls(26, 30));
  assert.equal(populationDrift.outcome, "disagree");
  assert.equal(populationDrift.reason, "the two readings count different populations");

  const oneSideMissing = crossCheck(
    toolCalls(26),
    reading({
      value: null,
      population: { unit: "toolCall parts", total: 26 },
      source: "session.jsonl",
      method: "structured parse of message.content",
      window: WINDOW,
      notMeasured: { reason: "the session was never copied here", missingField: "toolTiming.record" },
    }),
  );
  assert.equal(oneSideMissing.outcome, "disagree");
  assert.equal(verdictFrom(oneSideMissing, "PASS"), "BLOCKED");
});

test("a census refuses an empty collection instead of rendering examined 0", () => {
  const facts = { unit: "mod-log lines", source: "mod-log.txt", method: "line scan", window: { wholeRun: true } };
  assert.equal(
    codeOf(() => census([], () => "x", facts)),
    "census_empty_population",
  );
  assert.equal(
    codeOf(() => census("mod-log.txt", () => "x", facts)),
    "census_not_a_collection",
  );
  assert.equal(
    codeOf(() => census(["a"], null, facts)),
    "census_no_key",
  );
});

test("a census prints what it examined beside what it counted", () => {
  const lines = ["pickup_forage ok", "nothing", "pickup_forage again", "forage_picked_up", "nothing"];
  const counted = census(lines, (line) => (line.includes("pickup_forage") ? "pickup_forage" : null), {
    unit: "mod-log lines",
    source: "mod-log.txt",
    method: "line scan",
    window: { wholeRun: true },
  });
  assert.equal(counted.examined, 5);
  assert.equal(counted.counted, 2);
  assert.equal(counted.omitted, 3);
  assert.deepEqual(counted.counts, [{ key: "pickup_forage", total: 2 }]);
  assert.equal(
    formatCensus(counted),
    "examined 5 mod-log lines · counted 2 (pickup_forage 2) · omitted 3 (mod-log.txt, line scan, the whole run)",
  );
});

test("a census whose collection is the counter's own output is not a census of the run", () => {
  // The 2026-11-10 shape: a ledger over 13 pieces printed `unaccounted 0` because its population was the pieces the
  // previous pass had already found. The seam cannot see that mistake, but it does force the population to be written
  // down, so the mismatch is on the page beside the verdict rather than inside a tool nobody re-read.
  const pieces = [{ state: "accounted" }, { state: "accounted" }];
  const ledger = census(pieces, (piece) => (piece.state === "accounted" ? "accounted" : "unaccounted"), {
    unit: "pieces this pass found",
    source: "previous pass output",
    method: "state filter",
    window: { wholeRun: true },
  });
  assert.equal(ledger.omitted, 0);
  assert.match(formatCensus(ledger), /examined 2 pieces this pass found/);
});

test("a reading is frozen: a caller cannot edit the population after the number was read", () => {
  const record = toolCalls(26);
  assert.ok(Object.isFrozen(record));
  assert.ok(Object.isFrozen(record.population));
  assert.throws(() => {
    record.population.total = 30;
  }, TypeError);
});
