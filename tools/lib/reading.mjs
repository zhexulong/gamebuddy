/**
 * A number about a run is only readable beside the four facts that make it a measurement: the population it was counted
 * out of, the source it came from, the method that counted it, and the window it covers. A reading cannot be built
 * without them, and cannot be printed without them either, because the only renderer takes the record.
 *
 * WHAT THIS EXISTS TO STOP, all measured in one session (2026-11-10):
 *
 *   - `97` `plan_work` calls, from a substring count over the whole session text, where 26 calls were actually made -
 *     the tool schema repeats a tool name, so the blob mentioned it 97 times and the run dispatched it 26;
 *   - `unaccounted 0`, from a ledger whose population was the tool's own previous output: 13 pieces of 59;
 *   - `till 16 tiles`, counted from plan-script coordinates rather than from receipts - the receipts said 9;
 *   - `no mining at all`, a point-in-time reading reported as a whole-run verdict;
 *   - `9 failing tests`, true in parallel, 2 in serial, 0 per class alone - the mode was part of the fact.
 *
 * Every one is the same shape: a value without its population, its source, its window, or a second method. So
 * `reading()` throws rather than returning a number that has lost them, `crossCheck()` refuses to call two readings of
 * different populations "agreement", and `verdictFrom()` turns any non-agreement into `BLOCKED` instead of letting a
 * caller pick the number it prefers.
 *
 * TWO SHAPES, ONE RULE
 *
 * `reading()` is for a count of a known population - 26 of 26 toolCall parts. `census()` is for the same fact derived
 * from a collection that has to be enumerated first - examined 4213 lines, counted 5, omitted 4208 - and it refuses an
 * empty collection outright: a census over nothing has no reading, and rendering it as `0` is the defect, not the
 * measurement. A `quotient` declaration covers the third shape honestly - 8 declared tasks distilled from 24
 * `player_input` events - because those 8 are not a subset of the 24 and saying "of" would be a lie.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not know whether the population was the right one. `value <= population.total` proves arithmetic, not
 * judgement: a caller who passes `{ unit: "plan_work mentions in the session text", total: 97 }` and reports 97 as a
 * call count still holds a wrong belief - what the record makes possible is `crossCheck` against the structured count,
 * which returns `disagree` and blocks the verdict. The window is mandatory for the same reason: "no mining at all"
 * measured over nine minutes is not the run's answer, and the record cannot be rendered without saying which it is.
 */

/** A reading that cannot be built or rendered as asked. `code` is the stable name a gate or a caller keys on. */
export class ReadingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReadingError";
    this.code = code;
  }
}

/** How a value relates to its population: a part of it, or members of a narrower unit distilled from it. */
const SUBSET = "subset";
const QUOTIENT = "quotient";

const WINDOW_WHOLE_RUN = Object.freeze({ kind: "wholeRun" });

function fail(code, message) {
  throw new ReadingError(code, message);
}

function requireText(field, value, code) {
  if (typeof value !== "string" || value.trim() === "")
    fail(code, `${field} is required: a number without it cannot be re-derived by the next reader`);
  return value.trim();
}

/**
 * The window a reading covers: two bounds, or `{ wholeRun: true }` said out loud.
 *
 * Bounds render as `HH:MM` in UTC. A run's own timestamps are absolute instants, and a local-time rendering would make
 * the same reading print differently on two machines - a reading whose text depends on where it was rendered is one
 * more fact that can silently disagree with itself.
 */
function normalizeWindow(window) {
  if (window === null || typeof window !== "object")
    fail(
      "reading_window_missing",
      "window is required: a point-in-time reading reported as a whole-run verdict is measured over nine minutes and " +
        "read as the run - pass { start, end } or { wholeRun: true }",
    );
  if (window.wholeRun === true) {
    if (window.start !== undefined || window.end !== undefined)
      fail("reading_window_ambiguous", "window carries wholeRun and bounds: say which run-span the reading covers");
    return WINDOW_WHOLE_RUN;
  }
  const start = instant("start", window.start);
  const end = instant("end", window.end);
  if (end < start) fail("reading_window_inverted", `window ends (${end}) before it starts (${start})`);
  return Object.freeze({ kind: "bounded", start, end });
}

function instant(field, value) {
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(ms))
    fail("reading_window_missing", `window.${field} is required as a Date or an epoch-ms number, got ${typeof value}`);
  return ms;
}

function clock(ms) {
  return new Date(ms).toISOString().slice(11, 16);
}

function windowText(window) {
  return window.kind === "wholeRun" ? "the whole run" : `this run's window ${clock(window.start)}-${clock(window.end)}`;
}

function normalizePopulation(population) {
  if (population === null || typeof population !== "object" || Array.isArray(population))
    fail(
      "reading_population_missing",
      "population is required: { unit, total } - the count of what the value was counted out of, named in the unit the " +
        "counter actually examined (toolCall parts, not 'calls'; session lines, not 'batches')",
    );
  const unit = requireText("population.unit", population.unit, "reading_population_missing");
  if (!Number.isFinite(population.total) || population.total < 0)
    fail(
      "reading_population_invalid",
      `population.total must be a finite non-negative number of ${unit}, got ${String(population.total)}`,
    );
  return Object.freeze({ unit, total: population.total });
}

function normalizeNotMeasured(notMeasured) {
  if (notMeasured === null || typeof notMeasured !== "object")
    fail(
      "reading_not_measured_undeclared",
      "a null value must say why: { reason, missingField } - an unmeasured reading is printed as not measured, never " +
        "as 0, and the field it needed is what a later run has to publish",
    );
  return Object.freeze({
    reason: requireText("notMeasured.reason", notMeasured.reason, "reading_not_measured_undeclared"),
    missingField: requireText("notMeasured.missingField", notMeasured.missingField, "reading_not_measured_undeclared"),
  });
}

function requireValue(value, population, quotient, unit) {
  if (!Number.isFinite(value) || value < 0)
    fail("reading_value_invalid", `value must be a finite non-negative number, got ${String(value)}`);
  if (value > population.total) {
    const relation = quotient === null ? "part of" : "distilled from";
    fail(
      "reading_value_exceeds_population",
      `${value} cannot be ${relation} a population of ${population.total} ${population.unit}: the value and the ` +
        `population are counting different things (reported unit ${unit})`,
    );
  }
  return value;
}

/**
 * One reading, frozen, with every fact it needs to be re-derived.
 *
 * `reading({ value: 26, population: { unit: "toolCall parts", total: 26 }, source: "session.jsonl", method:
 * "structured parse of message.content", window: { wholeRun: true } })`.
 *
 * A `null` value is a legitimate reading of an absent field and is allowed only with
 * `notMeasured: { reason, missingField }`. `quotient: { unit }` declares that the value counts members of a narrower
 * unit distilled from the population (8 declared player tasks from 24 `player_input` events) - without it, a value is
 * a part of the population it names and `format()` says "of".
 */
export function reading({ value, population, source, method, window, notMeasured = null, quotient = null } = {}) {
  const counted = normalizePopulation(population);
  const facts = Object.freeze({
    source: requireText("source", source, "reading_source_missing"),
    method: requireText("method", method, "reading_method_missing"),
    window: normalizeWindow(window),
  });
  const narrower =
    quotient === null
      ? null
      : Object.freeze({ unit: requireText("quotient.unit", quotient?.unit, "reading_quotient_invalid") });
  const unit = narrower === null ? counted.unit : narrower.unit;
  if (value === null || value === undefined) {
    if (notMeasured === null)
      fail(
        "reading_not_measured_undeclared",
        `no value for ${unit} and no notMeasured: an unmeasured reading names the reason and the field it needed`,
      );
    return Object.freeze({
      kind: "not_measured",
      value: null,
      unit,
      population: counted,
      relation: narrower === null ? SUBSET : QUOTIENT,
      notMeasured: normalizeNotMeasured(notMeasured),
      ...facts,
    });
  }
  return Object.freeze({
    kind: "measured",
    value: requireValue(value, counted, narrower, unit),
    unit,
    population: counted,
    relation: narrower === null ? SUBSET : QUOTIENT,
    notMeasured: null,
    ...facts,
  });
}

function requireReading(record, role) {
  if (record === null || typeof record !== "object" || (record.kind !== "measured" && record.kind !== "not_measured"))
    fail(
      "reading_not_a_reading",
      `${role} is not a reading: build it with reading() - a bare number does not carry the population, source, ` +
        "method and window that make it one",
    );
  if (typeof record.unit !== "string" || typeof record.source !== "string" || typeof record.method !== "string")
    fail("reading_not_a_reading", `${role} is missing the unit, source or method a reading carries`);
  return record;
}

/** The reading as one line: the number and its four facts, inseparable. */
export function format(record) {
  requireReading(record, "format() argument");
  const facts = `${record.source}, ${record.method}, ${windowText(record.window)}`;
  if (record.kind === "not_measured")
    return `not measured: ${record.unit} (${facts}) - ${record.notMeasured.reason}; needs ${record.notMeasured.missingField}`;
  if (record.relation === QUOTIENT)
    return `${record.value} ${record.unit} from ${record.population.total} ${record.population.unit} (${facts})`;
  return `${record.value} of ${record.population.total} ${record.unit} (${facts})`;
}

/**
 * Two readings of the same quantity, compared.
 *
 * `agree` means same unit, same population total, same value. Anything else is `disagree` with the reason named, and
 * `not_measured` when neither side produced a number. THE POINT OF THE FIRST CHECK: 97 mentions of `plan_work` in a
 * session text and 26 `plan_work` toolCall parts are not two answers to one question - they are answers to two
 * questions, and a report that picked the first as "calls" was wrong by a factor of 3.7 while every arithmetic in it
 * was correct.
 */
export function crossCheck(left, right) {
  const first = requireReading(left, "crossCheck left");
  const second = requireReading(right, "crossCheck right");
  const rendered = `${format(first)} | ${format(second)}`;
  const outcome = (reason, verdict) =>
    Object.freeze({
      outcome: verdict,
      reason,
      readings: Object.freeze([first, second]),
      text: `${rendered} -> ${verdict.toUpperCase()}${reason === null ? "" : ` (${reason})`}`,
    });
  const missing = (record) => record.kind === "not_measured";
  if (missing(first) && missing(second)) return outcome("both readings are not measured", "not_measured");
  if (missing(first) || missing(second)) return outcome("only one side produced a reading", "disagree");
  if (first.unit !== second.unit) return outcome("the two readings count different units", "disagree");
  if (first.population.total !== second.population.total)
    return outcome("the two readings count different populations", "disagree");
  if (first.value !== second.value) return outcome("the same population, two different values", "disagree");
  return outcome(null, "agree");
}

/**
 * A verdict that consumes a cross-check: it survives only on agreement.
 *
 * A caller that wants "PASS" on a disagreement has to bypass this function on purpose, which is the reviewable act the
 * old reports did silently ("parallelism is her willingness" was offered while the mechanism that refused `for_each`
 * sat unread in the same log).
 */
export function verdictFrom(check, agreedVerdict) {
  if (check?.outcome === "agree") return agreedVerdict;
  return "BLOCKED";
}

/**
 * A census over a collection: examined N, counted M, omitted K.
 *
 * `keyFn` returns the key an item is counted under, or `null` for an item that is not counted - so "examined" is the
 * real population, including the items that did not match, and the omitted count is visible instead of being the
 * difference nobody printed. An empty collection throws: `examined 0 · counted 0` is a census that measured nothing,
 * and the caller either has the wrong population or has not run the thing it is reporting on.
 */
export function census(collection, keyFn, facts = {}) {
  if (!Array.isArray(collection)) fail("census_not_a_collection", "census needs an array to examine");
  if (typeof keyFn !== "function") fail("census_no_key", "census needs a keyFn returning the key, or null to omit");
  if (collection.length === 0)
    fail(
      "census_empty_population",
      "a census over an empty collection has nothing to count: name the missing population instead of rendering 0",
    );
  const counts = new Map();
  let counted = 0;
  for (const item of collection) {
    const key = keyFn(item);
    if (key === null || key === undefined) continue;
    counted += 1;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return Object.freeze({
    kind: "census",
    examined: collection.length,
    counted,
    omitted: collection.length - counted,
    counts: Object.freeze([...counts.entries()].map(([key, total]) => Object.freeze({ key, total }))),
    unit: requireText("unit", facts.unit, "census_population_missing"),
    source: requireText("source", facts.source, "census_population_missing"),
    method: requireText("method", facts.method, "census_population_missing"),
    window: normalizeWindow(facts.window),
  });
}

/** The census as one line: examined, counted, omitted, and the same three facts a reading carries. */
export function formatCensus(record) {
  if (record === null || typeof record !== "object" || record.kind !== "census")
    fail("reading_not_a_census", "formatCensus() takes a census() record");
  const keys =
    record.counts.length === 0 ? "" : ` (${record.counts.map(({ key, total }) => `${key} ${total}`).join(", ")})`;
  return (
    `examined ${record.examined} ${record.unit} · counted ${record.counted}${keys} · omitted ${record.omitted}` +
    ` (${record.source}, ${record.method}, ${windowText(record.window)})`
  );
}
