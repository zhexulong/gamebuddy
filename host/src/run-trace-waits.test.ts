import assert from "node:assert/strict";
import test from "node:test";

import { RUN_SPAN_NAMES } from "./run-trace.js";
import { RUN_WAIT_NAMES } from "./run-trace-budget.js";
import { deriveModelWaits, modelWaitMs, uncontestedModelWaits } from "./run-trace-waits.js";

/**
 * The gap between two actions is the same interval `actionCadence.thinkMs` measured - it just was not
 * thinking. These cases pin the part that matters: a gap another wait already owns must not be reported
 * as model time, because that is how "the model took 40 seconds" gets said about a pass-out.
 */

const action = (startMs: number, endMs: number | null) => ({ name: RUN_SPAN_NAMES.action, startMs, endMs });

test("a clean gap between two actions is model time", () => {
  const waits = deriveModelWaits([action(0, 1_000), action(4_000, 5_000)]);

  assert.equal(waits.length, 1);
  assert.equal(waits[0]!.startMs, 1_000);
  assert.equal(waits[0]!.endMs, 4_000);
  assert.equal(waits[0]!.contested, false);
  assert.equal(modelWaitMs(waits), 3_000);
});

test("a gap a body wait already covers is not model time", () => {
  const waits = deriveModelWaits([
    action(0, 1_000),
    { name: RUN_WAIT_NAMES.body, startMs: 1_500, endMs: 3_500 },
    action(4_000, 5_000),
  ]);

  assert.equal(waits.length, 1);
  assert.equal(waits[0]!.contested, true, "the body owned the middle of this gap");
  assert.equal(modelWaitMs(waits), 0, "an owned gap must not be counted as deciding time");
  assert.equal(uncontestedModelWaits(waits).length, 0);
});

test("a body wait that starts inside the gap and runs past its end still contests it", () => {
  // Overlap, not containment: the gap was not pure thinking just because the body wait had not finished.
  const waits = deriveModelWaits([
    action(0, 1_000),
    { name: RUN_WAIT_NAMES.body, startMs: 3_000, endMs: 9_000 },
    action(4_000, 5_000),
  ]);

  assert.equal(waits[0]!.contested, true);
  assert.equal(modelWaitMs(waits), 0);
});

test("nested or out-of-order actions do not invent a negative gap", () => {
  const waits = deriveModelWaits([action(0, 5_000), action(1_000, 2_000)]);
  assert.equal(waits.length, 0);
  assert.equal(modelWaitMs(waits), 0);
});

test("the sum is over uncontested gaps only, and mixed traces report both", () => {
  const waits = deriveModelWaits([
    action(0, 1_000),
    action(3_000, 4_000), // 2s clean
    { name: RUN_WAIT_NAMES.body, startMs: 4_100, endMs: 10_000 },
    action(11_000, 12_000), // 7s but owned from 4.1s
  ]);

  assert.equal(waits.length, 2);
  assert.equal(waits[0]!.contested, false);
  assert.equal(waits[1]!.contested, true);
  assert.equal(modelWaitMs(waits), 2_000, "only the clean 2s counts");
});

test("a trace with no actions reports no waits rather than throwing", () => {
  assert.equal(deriveModelWaits([]).length, 0);
  assert.equal(modelWaitMs([]), 0);
});
