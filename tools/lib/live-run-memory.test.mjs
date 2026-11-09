// The memory instrument, as the artifact has to carry it.
//
// MEASURED 2026-11-09 (`round40`, 34 minutes): the runner wrote 46 `HOST_MEMORY_TURN` lines to its own log - first rss
// 316 MB, last 545 MB, max 632 MB - and the bundle an auditor reads carried no memory field at all. The instrument
// existed and could not be read from the artifact it exists to explain, so "was this a leak or one allocation spread"
// was answered by grepping a terminal log. These are the falsifiers for the projection that puts it in the bundle.
import assert from "node:assert/strict";
import test from "node:test";

import { appendTurnMemory, HOST_MEMORY_TURN_CAP, summarizeHostMemory, turnMemoryPoint } from "./live-run-memory.mjs";

const point = (turn) => turnMemoryPoint({ turn, rssMb: 300 + turn, heapUsedMb: 100 + turn, sessionBytes: 1000 * turn });

test("a run that sampled its turns publishes a measured series, and its extremes", () => {
  // round40's own shape, one point per turn: 46 turns, rss from 316 to 632 MB.
  let series = Object.freeze([]);
  let omitted = 0;
  for (let turn = 0; turn < 46; turn += 1) {
    const appended = appendTurnMemory({ series, point: point(turn), omitted });
    series = appended.turns;
    omitted = appended.omitted;
  }
  const published = summarizeHostMemory({
    samples: 412,
    startRssMb: 316,
    minRssMb: 229,
    maxRssMb: 632,
    minFreeMb: 1057,
    turns: series,
    omitted,
  });
  assert.equal(published.state, "measured");
  assert.equal(published.samples, 412);
  assert.equal(published.startRssMb, 316);
  assert.equal(published.minRssMb, 229);
  assert.equal(published.maxRssMb, 632);
  assert.equal(published.minFreeMb, 1057);
  assert.equal(published.turns.length, 46);
  assert.equal(published.omitted, 0);
  assert.deepEqual(published.turns[0], { turn: 0, rssMb: 300, heapUsedMb: 100, sessionBytes: 0 });
  assert.deepEqual(published.turns.at(-1), { turn: 45, rssMb: 345, heapUsedMb: 145, sessionBytes: 45_000 });
});

test("the series is bounded, and the count it dropped is published beside it", () => {
  // A four-hour run makes more turns than an artifact should carry, and a truncation nobody counted is a series that
  // quietly starts later than the run did. The TAIL is what survives: the death is at the end.
  let series = Object.freeze([]);
  let omitted = 0;
  for (let turn = 0; turn < HOST_MEMORY_TURN_CAP + 15; turn += 1) {
    const appended = appendTurnMemory({ series, point: point(turn), omitted });
    series = appended.turns;
    omitted = appended.omitted;
  }
  assert.equal(series.length, HOST_MEMORY_TURN_CAP, "the cap is the cap");
  assert.equal(omitted, 15, "every dropped point is counted");
  assert.equal(series.at(-1).turn, HOST_MEMORY_TURN_CAP + 14, "the last turn of the run is still there");
  assert.equal(series[0].turn, 15, "the oldest surviving point is the cap'th from the end");
});

test("no turn sample is a named reason, never a null", () => {
  // A run that died before its first turn, or a scenario that never took one, must be readable as "not measured" - the
  // distinction the round40 bundle destroyed by saying nothing at all.
  const published = summarizeHostMemory({
    samples: 0,
    startRssMb: null,
    minRssMb: null,
    maxRssMb: null,
    minFreeMb: null,
    turns: [],
    omitted: 0,
  });
  assert.equal(published.state, "not_measured:no_turn_samples");
  assert.deepEqual(published.turns, []);
  assert.equal(published.samples, 0);
});
