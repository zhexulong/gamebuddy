import assert from "node:assert/strict";
import { test } from "node:test";

import { analyzeSilence, MAX_SILENT_STRETCH_MS, OBSERVABLE_EVENT_INTERVAL_MS } from "./latency-silence.mjs";

const flagged = (report) => report.longestSilentMs !== null && report.longestSilentMs > OBSERVABLE_EVENT_INTERVAL_MS;
const overBudget = (report) => report.longestSilentMs !== null && report.longestSilentMs > MAX_SILENT_STRETCH_MS;

test("a 3.1 s gap between observable events is flagged", () => {
  // The operating rule is 3 s; one tenth of a second past it must red the gate, or the rule is decoration.
  const report = analyzeSilence({
    startedAtMs: 1_000,
    endedAtMs: 4_100,
    presentedText: [{ atMs: 1_000 }, { atMs: 4_100 }],
  });
  assert.equal(report.longestSilentMs, 3_100);
  assert.equal(report.fromMs, 1_000);
  assert.equal(report.toMs, 4_100);
  assert.equal(flagged(report), true);
});

test("a 2.9 s gap between observable events is not flagged", () => {
  const report = analyzeSilence({
    startedAtMs: 1_000,
    endedAtMs: 3_900,
    presentedText: [{ atMs: 1_000 }, { atMs: 3_900 }],
  });
  assert.equal(report.longestSilentMs, 2_900);
  assert.equal(flagged(report), false);
});

test("a run whose only events are model turns is flagged at its real gap", () => {
  // Nothing the player could see happened: no world action, no presented line, no heartbeat. The turn is the WAIT
  // being judged, not an observable event, so the whole 25 s is silence and the cause says why.
  const report = analyzeSilence({
    startedAtMs: 0,
    endedAtMs: 25_000,
    modelTurns: [{ startedAtMs: 0, endedAtMs: 25_000 }],
  });
  assert.deepEqual(report.events, []);
  assert.equal(report.longestSilentMs, 25_000);
  assert.equal(report.fromMs, 0);
  assert.equal(report.toMs, 25_000);
  assert.equal(report.cause, "model_wait");
  assert.equal(flagged(report), true);
});

test("a 12 s gap names the stretch it measured", () => {
  // The absolute ceiling: the report must carry the window, not only the number, so a reader can find the stretch.
  const report = analyzeSilence({
    startedAtMs: 0,
    endedAtMs: 12_500,
    presentedText: [{ atMs: 0 }, { atMs: 12_000 }],
  });
  assert.equal(report.longestSilentMs, 12_000);
  assert.equal(report.fromMs, 0);
  assert.equal(report.toMs, 12_000);
  assert.equal(report.cause, "between_observable_events");
  assert.equal(overBudget(report), true);
});

test("a presented line inside the stretch is what shortens it", () => {
  // Without the presentation timestamp this run would be one 6 s silence; with it the longest is 2 s.
  const report = analyzeSilence({
    startedAtMs: 0,
    endedAtMs: 6_000,
    presentedText: [{ atMs: 0 }, { atMs: 2_000 }, { atMs: 4_000 }],
  });
  assert.equal(report.longestSilentMs, 2_000);
  assert.equal(flagged(report), false);
});

test("a heartbeat proves the world was alive without clearing the silence", () => {
  // The defect this rule prevents: counting per-tick heartbeats as observable would report ~2 s of silence for a
  // 20 s turn in which the player saw nothing at all.
  const report = analyzeSilence({
    startedAtMs: 0,
    endedAtMs: 20_000,
    modelTurns: [{ startedAtMs: 0, endedAtMs: 20_000 }],
    heartbeats: Array.from({ length: 20 }, (_, index) => ({ atMs: index * 1_000 })),
  });
  assert.equal(report.longestSilentMs, 20_000);
  assert.equal(report.cause, "model_wait");
  assert.equal(flagged(report), true);
});

test("a stretch with no heartbeat inside names the world as the stalled side", () => {
  const report = analyzeSilence({
    startedAtMs: 0,
    endedAtMs: 33_000,
    presentedText: [{ atMs: 3_000 }, { atMs: 33_000 }],
    heartbeats: [{ atMs: 0 }, { atMs: 1_000 }, { atMs: 2_000 }, { atMs: 3_000 }],
  });
  assert.equal(report.longestSilentMs, 30_000);
  assert.equal(report.fromMs, 3_000);
  assert.equal(report.cause, "world_stalled");
});

test("a stretch that cannot be measured answers null, never zero", () => {
  const report = analyzeSilence({ presentedText: [{ atMs: 5_000 }] });
  assert.equal(report.longestSilentMs, null);
  assert.equal(report.fromMs, null);
  assert.equal(report.toMs, null);
  assert.equal(report.cause, "unmeasured");
  assert.equal(flagged(report), false);
});

test("an action that never settled keeps its stretch open instead of counting the dispatch as an answer", () => {
  const report = analyzeSilence({
    startedAtMs: 0,
    endedAtMs: 40_000,
    actions: [{ action: "water_crop", dispatchedAtMs: 0, settledAtMs: null }],
  });
  assert.equal(report.longestSilentMs, 40_000);
  assert.equal(report.cause, "world_action_wait");
});
