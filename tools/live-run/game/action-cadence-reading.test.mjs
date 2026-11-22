import assert from "node:assert/strict";
import test from "node:test";

import { publishCadence, readThinkGap } from "./action-cadence-reading.mjs";

// `round87b`'s published cadence, verbatim: 13 flat dispatches (twelve gaps), 280 program executions, and the three
// spans the reader was quoting.
const ROUND87B = Object.freeze({
  actions: 293,
  measured: 293,
  unmeasured: 0,
  flat: 13,
  program: 280,
  execMs: Object.freeze({ median: 76, max: 50317, sum: 468501 }),
  thinkMs: Object.freeze({ median: 50382, max: 645115, sum: 1345364 }),
  idleMs: Object.freeze({ median: 50451, max: 645229, sum: 1346240 }),
});

test("a gap with program work inside it does not answer the thinking question, and says so", () => {
  const gap = readThinkGap(ROUND87B);
  assert.equal(gap.answers, false);
  assert.equal(gap.reason, "program_work_inside_the_gap:13_flat_of_293_actions");
  assert.equal(gap.span.sum, 1345364, "the spans are still what the flat channel measured");
});

test("the published field is null with its reason, and the measured spans keep their own name", () => {
  const published = publishCadence(ROUND87B);
  assert.equal(published.thinkMs, null, "a null is not `0 s of thinking`");
  assert.equal(published.thinkMsNotMeasured, "program_work_inside_the_gap:13_flat_of_293_actions");
  assert.equal(published.dispatchGapMs.max, 645115, "the number is kept, under the name of what it measures");
  assert.equal(published.execMs.sum, 468501, "the other channels are untouched");
});

test("a gap that cannot exist is the other absence: fewer than two flat dispatches", () => {
  const programOnly = publishCadence({ ...ROUND87B, flat: 1, program: 292 });
  assert.equal(programOnly.thinkMs, null);
  assert.equal(programOnly.thinkMsNotMeasured, "no_flat_dispatch_pair:1_flat_of_293_actions");
  assert.equal(programOnly.dispatchGapMs.sum, 1345364);

  const nothing = readThinkGap({ flat: 0, program: 0, thinkMs: null });
  assert.equal(nothing.answers, false);
  assert.equal(nothing.reason, "no_flat_dispatch_pair:0_flat_of_0_actions");
});

test("a run whose work all went through the flat channel keeps its thinkMs", () => {
  const flatOnly = Object.freeze({
    actions: 12,
    measured: 12,
    flat: 12,
    program: 0,
    execMs: Object.freeze({ median: 70, max: 300, sum: 900 }),
    thinkMs: Object.freeze({ median: 4000, max: 9000, sum: 22000 }),
    idleMs: Object.freeze({ median: 4100, max: 9100, sum: 23000 }),
  });
  const gap = readThinkGap(flatOnly);
  assert.equal(gap.answers, true);
  const published = publishCadence(flatOnly);
  assert.deepEqual(published.thinkMs, flatOnly.thinkMs);
  assert.equal(published.thinkMsNotMeasured, null);
  assert.equal(published.dispatchGapMs, null, "the spans are published once, not twice");
});
