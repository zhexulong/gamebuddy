// The plan builder's round trip is one field with four stages in it, and this reader is what separates them. Measured
// `round94` (2026-11-23): the category then called `plan_compile` read 128,573 ms over 62 calls, the trace's submit span
// read 2,900 ms, and the settlement wait was 122,924 ms of it. A reader who takes the whole field for compilation
// optimises the JS compiler to save at most 649 ms.
//
// Every fixture is fabricated on purpose and nothing here reads `.live-runs`: each test states one property, and the
// history it protects is named in the test that protects it.
//
// red-proof: history  the module's `settlementWaitMs` before this change does not exist - the category published one
//                    number and no reader split it, so this suite's first assertion finds no `settlementWaitMs` at all.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  decomposePlanWork,
  formatPlanWork,
  NOT_MEASURED,
  PLAN_SUBMIT_SPAN,
  PLAN_WORK_TOOL,
  readPlanWorkTiming,
  SNAPSHOT_OBSERVE_SPAN,
} from "./plan-work-timing.mjs";

const START = Date.parse("2026-11-23T03:20:00.000Z");
const iso = (ms) => new Date(ms).toISOString();

/** One `stardew_plan_work` call: the assistant's call at `atMs`, answered `durationMs` later with `waitedMs` if held. */
function callEntry(id, atMs, durationMs, waitedMs) {
  const answer =
    waitedMs === null ? { accepted: false, planStatus: "refused" } : { accepted: true, waited: { waitedMs } };
  return [
    {
      type: "message",
      timestamp: iso(atMs),
      message: { role: "assistant", content: [{ type: "toolCall", id, name: PLAN_WORK_TOOL }] },
    },
    {
      type: "message",
      timestamp: iso(atMs + durationMs),
      message: {
        role: "toolResult",
        toolCallId: id,
        content: [{ type: "text", text: JSON.stringify(answer) }],
      },
    },
  ];
}

/** A stage as this reader takes it: a span name, its duration in ms, and the attributes the caller asked with. */
const span = (name, ms, args = {}) => ({ name, durationMs: ms, args });

/** The same stage as the trace file writes it: Chrome-trace microseconds, which is what the export carries. */
const event = (name, ms, args) => ({ ph: "X", name, ts: 0, dur: Math.round(ms * 1000), pid: 1, tid: 1, args });

/** A run directory holding one trace and one bound session record, written where a real run keeps them. */
function writeRun({ spans, entries }) {
  const runDir = mkdtempSync(join(tmpdir(), "plan-work-timing-"));
  const traceEvents = spans.map((entry) => event(entry.name, entry.durationMs, entry.args));
  writeFileSync(
    join(runDir, "run-trace.json"),
    JSON.stringify({ displayTimeUnit: "ms", droppedSpans: 0, traceEvents }),
    "utf8",
  );
  const sessionDir = join(runDir, "runtime-root", "contexts", "ctx-1", "surface-sessions", "game-1", "sessions");
  mkdirSync(sessionDir, { recursive: true });
  const sessionPath = join(sessionDir, "session-1.jsonl");
  writeFileSync(sessionPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
  return { runDir, sessionPath };
}

/** Two held calls and one refused: the population a round94-shaped run has, in miniature. */
function mixedRun() {
  const entries = [
    ...callEntry("call-1", START, 4_000, 3_900),
    ...callEntry("call-2", START + 10_000, 2_000, 1_800),
    ...callEntry("call-3", START + 20_000, 500, null),
  ];
  const spans = [
    span(PLAN_WORK_TOOL, 6_400),
    span(PLAN_SUBMIT_SPAN, 120),
    span(PLAN_SUBMIT_SPAN, 80),
    span(PLAN_SUBMIT_SPAN, 30),
    span(SNAPSHOT_OBSERVE_SPAN, 90, { ask: "plan_wait" }),
    span(SNAPSHOT_OBSERVE_SPAN, 60, { ask: "plan_wait" }),
    // A world read for another caller (`stardew_observe`): it must not be charged to the plan's own re-read.
    span(SNAPSHOT_OBSERVE_SPAN, 500, { surface: "game" }),
  ];
  return writeRun({ spans, entries });
}

test("the four stages of the round trip add up to the total the category published", () => {
  // The property: no time is created by naming it, and none is lost. Total 6500 = held 5700 (3900 + 1800) + submit 230
  // + the refused call's 500 + the rest, with the world re-read moved out of the held window rather than counted twice.
  const reading = decomposePlanWork({
    spans: [
      span(PLAN_SUBMIT_SPAN, 120),
      span(PLAN_SUBMIT_SPAN, 80),
      span(PLAN_SUBMIT_SPAN, 30),
      span(SNAPSHOT_OBSERVE_SPAN, 90, { ask: "plan_wait" }),
      span(SNAPSHOT_OBSERVE_SPAN, 60, { ask: "plan_wait" }),
    ],
    calls: [
      { durationMs: 4_000, waitedMs: 3_900 },
      { durationMs: 2_000, waitedMs: 1_800 },
      { durationMs: 500, waitedMs: null },
    ],
  });
  assert.equal(reading.observed, true);
  assert.equal(reading.calls, 3);
  assert.equal(reading.heldCalls, 2);
  // A call whose answer reports no held window (a refused plan) is counted, and its time is in `other`: it never waited
  // for anything to settle, and charging it to the settlement wait would invent a wait.
  assert.equal(reading.neverHeldCalls, 1);
  assert.equal(reading.totalMs, 6_500);
  assert.equal(reading.dispatchMs, 230);
  assert.equal(reading.worldRereadMs, 150);
  assert.equal(reading.settlementWaitMs, 5_550, "the held window less the world re-read inside it");
  assert.equal(reading.otherMs, 570, "the refused call plus compilation and plumbing");
  assert.equal(
    reading.settlementWaitMs + reading.dispatchMs + reading.worldRereadMs + reading.otherMs,
    reading.totalMs,
    "the named stages and the remainder are the whole round trip",
  );
  assert.equal(reading.compilation.measured, false, "no artifact times the compiler");
  assert.equal(
    reading.compilation.upperBoundMs,
    reading.otherMs,
    "the bound to attribute to it is the whole remainder",
  );
});

test("a world read for another caller is not the plan's own re-read", () => {
  // `snapshot.observe` is emitted by `stardew_observe` too; only the held arm asks with `plan_wait`. Without that filter
  // the settlement wait would be short by whatever else read the world in the same run.
  const { runDir, sessionPath } = mixedRun();
  try {
    const reading = readPlanWorkTiming({ runDirectory: runDir, sessionPath });
    assert.equal(reading.observed, true);
    assert.equal(reading.worldRereadMs, 150);
    assert.equal(reading.settlementWaitMs, 5_550);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("a run that planned nothing is a measured zero, and a run with no trace is withheld", () => {
  // The three zeroes stay apart: no plan calls is 0, an unreadable trace is `not_measured` with the reason, and neither
  // is a decomposition of zero milliseconds.
  const empty = decomposePlanWork({ spans: [], calls: [] });
  assert.equal(empty.observed, true);
  assert.equal(empty.totalMs, 0);
  assert.equal(empty.otherMs, 0);

  const runDir = mkdtempSync(join(tmpdir(), "plan-work-timing-empty-"));
  try {
    const unbound = readPlanWorkTiming({ runDirectory: runDir, sessionPath: null });
    assert.deepEqual({ ...unbound }, { observed: false, reasonCode: "run_trace_not_written", detail: null });
    writeFileSync(join(runDir, "run-trace.json"), JSON.stringify({ traceEvents: [] }), "utf8");
    const noSession = readPlanWorkTiming({ runDirectory: runDir, sessionPath: null });
    assert.equal(noSession.reasonCode, "session_record_unbound");
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});

test("a trace and a session record that disagree are withheld, with both counts named", () => {
  // Two artifacts of one run: subtracting one run's span from another run's call would be exactly the 2026-10-22
  // defect (`foreign record, 45 dispatches`) in a new place. The disagreement is the only thing published.
  const spansAndCalls = {
    spans: [span(PLAN_SUBMIT_SPAN, 120)],
    calls: [
      { durationMs: 4_000, waitedMs: 3_900 },
      { durationMs: 2_000, waitedMs: 1_800 },
    ],
  };
  const submitted = decomposePlanWork(spansAndCalls);
  assert.equal(submitted.observed, false);
  assert.equal(submitted.reasonCode, "trace_and_record_disagree:plan_submit_spans");
  assert.deepEqual({ ...submitted.detail }, { spans: 1, calls: 2 });

  const rereads = decomposePlanWork({
    spans: [span(PLAN_SUBMIT_SPAN, 120), span(PLAN_SUBMIT_SPAN, 120)],
    calls: [
      { durationMs: 4_000, waitedMs: 3_900 },
      { durationMs: 2_000, waitedMs: 1_800 },
    ],
  });
  assert.equal(rereads.reasonCode, "trace_and_record_disagree:plan_world_reread_spans");
  assert.deepEqual({ ...rereads.detail }, { spans: 0, heldCalls: 2 });
});

test("a held window smaller than the world re-read inside it is withheld, not published as negative time", () => {
  const reading = decomposePlanWork({
    spans: [
      span(PLAN_SUBMIT_SPAN, 10),
      span(PLAN_SUBMIT_SPAN, 10),
      span(SNAPSHOT_OBSERVE_SPAN, 400, { ask: "plan_wait" }),
      span(SNAPSHOT_OBSERVE_SPAN, 400, { ask: "plan_wait" }),
    ],
    calls: [
      { durationMs: 500, waitedMs: 100 },
      { durationMs: 500, waitedMs: 100 },
    ],
  });
  assert.equal(reading.observed, false);
  assert.equal(reading.reasonCode, "world_reread_exceeds_the_held_window");
  assert.deepEqual({ ...reading.detail }, { heldMs: 200, worldRereadMs: 800 });
});

test("a large remainder is said out loud, and the printed block adds up to its own total", () => {
  // The property the printed table must keep: the numbers a reader is handed are the numbers that were computed, and
  // the stages plus the remainder equal the total ON THE PAGE - a decomposition whose printed rows do not add up is how
  // the field got quoted for compilation in the first place.
  const reading = decomposePlanWork({
    spans: [span(PLAN_SUBMIT_SPAN, 100), span(SNAPSHOT_OBSERVE_SPAN, 100, { ask: "plan_wait" })],
    calls: [{ durationMs: 10_000, waitedMs: 5_100 }],
  });
  assert.equal(reading.otherIsLarge, true, "4,800 of 10,000 is not the compiler hiding in the total");
  const lines = formatPlanWork(reading);
  const stageMs = ["dispatch (submit)", "settlement wait", "world re-read", "other"].map((label) => {
    const line = lines.find((entry) => entry.trimStart().startsWith(label));
    assert.ok(line, `the printed block names ${label}`);
    return Number(/(\d+)ms/u.exec(line)[1]);
  });
  const totalLine = lines.find((entry) => entry.trimStart().startsWith("total"));
  assert.equal(
    stageMs.reduce((sum, ms) => sum + ms, 0),
    Number(/(\d+)ms/u.exec(totalLine)[1]),
  );
  assert.match(lines.join("\n"), /script compilation\s+not_measured/u);
  assert.match(lines.join("\n"), /LARGE/u);
  assert.ok(formatPlanWork({ observed: false, reasonCode: "run_trace_not_written" })[0].includes(NOT_MEASURED));
});
