import { readFileSync } from "node:fs";
import { join } from "node:path";

import { readSessionEntries, toolResultPayload } from "../../lib/session-jsonl.mjs";

/**
 * Where one `stardew_plan_work` round trip actually goes.
 *
 * WHY THIS EXISTS. `toolTiming.byCategory` published a category called `plan_compile`, and its duration was the whole
 * tool call: the script compiled by the Host, the submit to the Mod, the window the call then HELD its own turn waiting
 * for that program to settle (`planSelfWaitDecision`), and the world re-read the held arm answers with
 * (`readPlanWorldSnapshot`). Measured on `round94` (2026-11-23): that category read 128.6 s over 62 calls, the trace's
 * narrower `plan.script` span read 2.9 s, and a reader optimising "plan compile" from the first number would have gone
 * to the JS compiler - which owns at most 665 ms of it (`other`, below). One name over four stages is the same defect this repository
 * keeps finding, so the stages are named here, each beside the file it comes from.
 *
 * <p>
 * The four stages, and why each comes from where it does:
 * </p>
 *
 * <ul>
 *   <li><b>settlement wait</b> - the answer's own `waited.waitedMs` ("how long this call held the turn"), less the
 *       world re-read that happened inside that window. The answer is the only artifact that publishes it.</li>
 *   <li><b>dispatch</b> - the trace's `plan.script` span. It BEGINS AFTER `compilePlanScript` returns and ends when the
 *       Mod's answer code arrives, so it measures the submit, not the script; it is read under its own name and
 *       described here rather than renamed, because a rename would leave every trace already on disk unreadable.</li>
 *   <li><b>world re-read</b> - the trace's `snapshot.observe` span with `ask: "plan_wait"`, which only the held arm
 *       emits.</li>
 *   <li><b>compilation</b> - <i>not measured</i>: no artifact records it. It is inside `other` and bounded by it, and
 *       this reader says so instead of attributing the remainder to it by guess.</li>
 * </ul>
 *
 * <p>
 * THE TOTAL IS THE ROUND TRIP, UNCHANGED: the sum of the calls' own durations, which is the number the category
 * published. The parts are that total's parts and `other` is the remainder, so a run cannot move time between stages
 * without this reading showing it.
 * </p>
 */

/** The tool whose round trip this decomposes: the Host's mounted plan builder, and the trace span it records per call. */
export const PLAN_WORK_TOOL = "stardew_plan_work";
/** The Host's submit span: it starts after the script compiles and ends when the Mod's answer code arrives. */
export const PLAN_SUBMIT_SPAN = "plan.script";
/** The Host's observation span; the held arm is the only caller that asks with `plan_wait`. */
export const SNAPSHOT_OBSERVE_SPAN = "snapshot.observe";
const PLAN_WORLD_REREAD_ASK = "plan_wait";
/** The file `writeRunTrace`/`startRunTraceFile` keep beside the run; the trace viewer name, not a second spelling. */
const PLAN_WORK_TRACE_FILE = "run-trace.json";
/** The value every part this reader could not measure carries; the reason is in `reasonCode` beside it. */
export const NOT_MEASURED = "not_measured";
/** A remainder above this share of the round trip is reported as large, not hidden in the total. */
const OTHER_IS_LARGE_SHARE = 0.1;

const sum = (items, of) => items.reduce((total, item) => total + of(item), 0);

/**
 * The decomposition, from spans and calls that were already measured.
 *
 * <p>
 * Every guard here is a real inconsistency rather than a defensive ornament: the trace and the session record are two
 * artifacts of one run, and a decomposition that silently tolerates them disagreeing would subtract one run's span
 * from another run's call. When they disagree the reading is WITHHELD with the two counts named,
 * never published with a caveat.
 * </p>
 *
 * @param {{ spans: readonly {name: string, durationMs: number, args?: object}[], calls: readonly {durationMs: number, waitedMs: number|null}[] }} input
 */
export function decomposePlanWork({ spans, calls }) {
  const submitSpans = spans.filter((span) => span.name === PLAN_SUBMIT_SPAN);
  const worldRereadSpans = spans.filter(
    (span) => span.name === SNAPSHOT_OBSERVE_SPAN && span.args?.ask === PLAN_WORLD_REREAD_ASK,
  );
  const heldCalls = calls.filter((call) => Number.isFinite(call.waitedMs));

  const withheld = (reasonCode, detail) => Object.freeze({ observed: false, reasonCode, detail });
  if (submitSpans.length !== calls.length) {
    return withheld("trace_and_record_disagree:plan_submit_spans", {
      spans: submitSpans.length,
      calls: calls.length,
    });
  }
  if (worldRereadSpans.length !== heldCalls.length) {
    return withheld("trace_and_record_disagree:plan_world_reread_spans", {
      spans: worldRereadSpans.length,
      heldCalls: heldCalls.length,
    });
  }

  const totalMs = Math.round(sum(calls, (call) => call.durationMs));
  const heldMs = Math.round(sum(heldCalls, (call) => call.waitedMs));
  const dispatchMs = Math.round(sum(submitSpans, (span) => span.durationMs));
  const worldRereadMs = Math.round(sum(worldRereadSpans, (span) => span.durationMs));
  // The re-read happens INSIDE the held window the answer reports, so it is taken out of the wait and published as its
  // own stage: charged twice it would inflate the total, and left in the wait it would hide 2 s of round94 in "settling".
  const settlementWaitMs = heldMs - worldRereadMs;
  if (settlementWaitMs < 0) {
    return withheld("world_reread_exceeds_the_held_window", { heldMs, worldRereadMs });
  }
  const otherMs = totalMs - settlementWaitMs - dispatchMs - worldRereadMs;
  if (otherMs < 0) {
    return withheld("named_stages_exceed_the_round_trip", { totalMs, settlementWaitMs, dispatchMs, worldRereadMs });
  }
  const toolSpanMs = Math.round(
    sum(
      spans.filter((span) => span.name === PLAN_WORK_TOOL),
      (span) => span.durationMs,
    ),
  );
  return Object.freeze({
    observed: true,
    reasonCode: null,
    calls: calls.length,
    heldCalls: heldCalls.length,
    neverHeldCalls: calls.length - heldCalls.length,
    totalMs,
    settlementWaitMs,
    dispatchMs,
    worldRereadMs,
    otherMs,
    otherIsLarge: totalMs > 0 && otherMs / totalMs >= OTHER_IS_LARGE_SHARE,
    // The trace's own window around the same round trip, and what lies outside it (call issued -> result delivered and
    // the Pi-side plumbing): context for reconciling two recorders, not a fifth stage.
    toolSpanMs,
    outsideToolSpanMs: Math.max(0, totalMs - toolSpanMs),
    // No artifact times the compiler today. The bound is what the reader could have attributed to it, which is the
    // whole remainder - so "inside other, at most this" is the strongest true statement, not an estimate.
    compilation: Object.freeze({
      measured: false,
      reasonCode: "no_artifact_records_script_compilation",
      upperBoundMs: otherMs,
    }),
    sources: Object.freeze({
      total: "session record: call timestamp to result timestamp, per `stardew_plan_work` call",
      settlementWait: "session record: the answer's `waited.waitedMs`, less the world re-read inside it",
      dispatch: `${PLAN_WORK_TRACE_FILE}: \`${PLAN_SUBMIT_SPAN}\` spans, one per call`,
      worldReread: `${PLAN_WORK_TRACE_FILE}: \`${SNAPSHOT_OBSERVE_SPAN}\` spans with ask=${PLAN_WORLD_REREAD_ASK}`,
    }),
  });
}

/**
 * The `stardew_plan_work` calls of one session record: duration to its own result, and the held window the answer
 * reports. A call with no result (the session was cut off mid-call) has no duration and is left out - the same rule the
 * runner's own `readToolTiming` applies, so the two cannot report different call counts for one record.
 */
function readPlanWorkCalls(sessionPath) {
  let entries;
  try {
    entries = readSessionEntries(sessionPath);
  } catch {
    return null;
  }
  const pending = new Map();
  const calls = [];
  for (const entry of entries) {
    if (entry?.type !== "message") continue;
    const atMs = Date.parse(entry.timestamp);
    if (!Number.isFinite(atMs)) continue;
    const message = entry.message;
    if (message?.role === "assistant") {
      for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part?.type === "toolCall" && part.name === PLAN_WORK_TOOL) pending.set(part.id, atMs);
      }
      continue;
    }
    if (message?.role !== "toolResult") continue;
    const startedAtMs = pending.get(message.toolCallId);
    if (startedAtMs === undefined) continue;
    pending.delete(message.toolCallId);
    const durationMs = atMs - startedAtMs;
    if (durationMs < 0) continue;
    const waitedMs = toolResultPayload(message)?.waited?.waitedMs;
    calls.push({ durationMs, waitedMs: Number.isFinite(waitedMs) ? waitedMs : null });
  }
  return calls;
}

/**
 * The decomposition for one run directory, or the reason it could not be read.
 *
 * `sessionPath` is resolved by the caller (`report-run-cost.mjs` already binds `result.toolTiming.record`), so this
 * reader holds no second rule for finding the record that belongs to a run.
 */
export function readPlanWorkTiming({ runDirectory, sessionPath = null }) {
  let trace;
  try {
    trace = JSON.parse(readFileSync(join(runDirectory, PLAN_WORK_TRACE_FILE), "utf8"));
  } catch {
    return Object.freeze({ observed: false, reasonCode: "run_trace_not_written", detail: null });
  }
  if (typeof sessionPath !== "string" || sessionPath.length === 0) {
    return Object.freeze({ observed: false, reasonCode: "session_record_unbound", detail: null });
  }
  const calls = readPlanWorkCalls(sessionPath);
  if (calls === null)
    return Object.freeze({ observed: false, reasonCode: "session_record_not_readable", detail: null });
  const events = Array.isArray(trace?.traceEvents) ? trace.traceEvents : [];
  const spans = events.map((event) => ({
    name: event.name,
    // The export writes microseconds (Chrome trace); the record writes milliseconds.
    durationMs: (Number(event.dur) || 0) / 1000,
    args: event.args ?? {},
  }));
  return decomposePlanWork({ spans, calls });
}

/** Percent of the round trip, as the report prints it: `null` when there is no total to divide. */
function share(partMs, totalMs) {
  return totalMs > 0 ? `${((partMs / totalMs) * 100).toFixed(1)}%` : "n/a";
}

/**
 * The decomposition as printed lines, so the numbers a test asserts are the numbers a reader is handed.
 *
 * The stages come first and `other` closes the list, because a remainder named before the stages it stands for reads
 * like a stage of its own.
 */
export function formatPlanWork(reading) {
  if (reading.observed === false) {
    return [`${"plan work".padEnd(20)} ${NOT_MEASURED}:${reading.reasonCode}`];
  }
  const lines = [
    `${"plan work".padEnd(20)} ${reading.calls} calls, ${reading.heldCalls} of them held their turn`,
    `  ${"dispatch (submit)".padEnd(20)} ${`${reading.dispatchMs}ms`.padStart(9)} ${share(reading.dispatchMs, reading.totalMs).padStart(7)}  ${reading.sources.dispatch}, starting after the script compiles`,
    `  ${"settlement wait".padEnd(20)} ${`${reading.settlementWaitMs}ms`.padStart(9)} ${share(reading.settlementWaitMs, reading.totalMs).padStart(7)}  ${reading.sources.settlementWait}`,
    `  ${"world re-read".padEnd(20)} ${`${reading.worldRereadMs}ms`.padStart(9)} ${share(reading.worldRereadMs, reading.totalMs).padStart(7)}  ${reading.sources.worldReread}`,
    `  ${"script compilation".padEnd(20)} ${NOT_MEASURED.padStart(9)} ${"".padStart(7)}  no artifact times it (${reading.compilation.reasonCode}), so it is inside \`other\`, at most ${reading.compilation.upperBoundMs}ms`,
    `  ${"other".padEnd(20)} ${`${reading.otherMs}ms`.padStart(9)} ${share(reading.otherMs, reading.totalMs).padStart(7)}  the remainder: compilation (no artifact times it) and the ${reading.neverHeldCalls} call(s) that never held${reading.otherIsLarge ? " - LARGE: this split does not explain the round trip" : ""}`,
    `  ${"total".padEnd(20)} ${`${reading.totalMs}ms`.padStart(9)} ${"".padStart(7)}  ${reading.sources.total}; the Host's own span covers ${reading.toolSpanMs}ms of it, ${reading.outsideToolSpanMs}ms lies outside that span`,
  ];
  return lines;
}
