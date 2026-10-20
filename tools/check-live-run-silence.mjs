/**
 * The silence gate: a live run may never go silent for long without an observable event.
 *
 * WHY THIS EXISTS: the world answers in about two frames and the model round-trip is median 3.4 s / p90 25 s, so
 * what the player actually suffers is the SILENCE around a turn. The product budget
 * (design/research/companion-latency-budget.md) is: every model wait must have an observable event at least every
 * 3 s, and no run may report a silent stretch longer than 10 s. This gate measures exactly that from a run's own
 * artifacts.
 *
 * Two modes, both offline:
 *
 *   --rules         the analyzer is exercised on synthetic timelines, one falsifier per rule, so the gate cannot
 *                   pass without being able to fail.
 *   --run-dir DIR   a REAL run is measured. `actionTrace.jsonl` supplies absolute `dispatchedAtMs`/`settledAtMs`;
 *                   `result.json` supplies the run window (`startedAtMs`/`endedAtMs`). See the caveats printed in
 *                   `unmeasured`: presented lines, model turns and heartbeats are NOT run-clock anchored in today's
 *                   artifacts, so the measured stretch is an upper bound on what the player actually saw.
 *
 * Usage:
 *   node tools/check-live-run-silence.mjs --rules
 *   node tools/check-live-run-silence.mjs --run-dir .live-runs/game-ladder/<run>
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { analyzeSilence, MAX_SILENT_STRETCH_MS, OBSERVABLE_EVENT_INTERVAL_MS } from "./lib/latency-silence.mjs";

const checks = [];
const checkStatus = (status) => {
  if (status === true) return "passed";
  if (status === false) return "failed";
  return status;
};
const check = (id, status, detail) =>
  checks.push({
    id,
    status: checkStatus(status),
    ...(detail === undefined ? {} : { detail }),
  });

function readTrace(path) {
  const entries = [];
  const malformed = [];
  for (const [index, line] of readFileSync(path, "utf8").split(/\r?\n/).entries()) {
    if (line.trim().length === 0) continue;
    try {
      entries.push(JSON.parse(line));
    } catch (error) {
      malformed.push({ line: index + 1, error: String(error?.message ?? error) });
    }
  }
  return { entries, malformed };
}

function readJson(path) {
  try {
    return { value: JSON.parse(readFileSync(path, "utf8")), error: null };
  } catch (error) {
    return { value: null, error: String(error?.message ?? error) };
  }
}

const at = (report) =>
  `${String(report.longestSilentMs)} ms from ${String(report.fromMs)} to ${String(report.toMs)} (${report.cause})`;

/**
 * One falsifier per rule. A rule that cannot red this gate is a rule nobody is enforcing.
 */
function rulesChecks() {
  const past = analyzeSilence({
    startedAtMs: 0,
    endedAtMs: 3_100,
    presentedText: [{ atMs: 0 }, { atMs: 3_100 }],
  });
  check(
    "a_gap_past_the_interval_is_flagged",
    past.longestSilentMs === 3_100 && past.longestSilentMs > OBSERVABLE_EVENT_INTERVAL_MS,
    at(past),
  );

  const under = analyzeSilence({
    startedAtMs: 0,
    endedAtMs: 2_900,
    presentedText: [{ atMs: 0 }, { atMs: 2_900 }],
  });
  check(
    "a_gap_under_the_interval_is_not_flagged",
    under.longestSilentMs === 2_900 && under.longestSilentMs <= OBSERVABLE_EVENT_INTERVAL_MS,
    at(under),
  );

  const modelOnly = analyzeSilence({
    startedAtMs: 0,
    endedAtMs: 25_000,
    modelTurns: [{ startedAtMs: 0, endedAtMs: 25_000 }],
  });
  check(
    "a_model_only_run_is_flagged_at_its_real_gap",
    modelOnly.longestSilentMs === 25_000 && modelOnly.cause === "model_wait" && modelOnly.events.length === 0,
    at(modelOnly),
  );

  const twelve = analyzeSilence({
    startedAtMs: 0,
    endedAtMs: 12_500,
    presentedText: [{ atMs: 0 }, { atMs: 12_000 }],
  });
  check(
    "a_twelve_second_gap_names_its_stretch",
    twelve.longestSilentMs === 12_000 &&
      twelve.fromMs === 0 &&
      twelve.toMs === 12_000 &&
      twelve.longestSilentMs > MAX_SILENT_STRETCH_MS,
    at(twelve),
  );

  const spoken = analyzeSilence({
    startedAtMs: 0,
    endedAtMs: 6_000,
    presentedText: [{ atMs: 0 }, { atMs: 2_000 }, { atMs: 4_000 }],
  });
  check("a_presented_line_shortens_the_stretch", spoken.longestSilentMs === 2_000, at(spoken));

  const heartbeatMask = analyzeSilence({
    startedAtMs: 0,
    endedAtMs: 20_000,
    modelTurns: [{ startedAtMs: 0, endedAtMs: 20_000 }],
    heartbeats: Array.from({ length: 20 }, (_, index) => ({ atMs: index * 1_000 })),
  });
  check(
    "a_heartbeat_does_not_clear_the_silence",
    heartbeatMask.longestSilentMs === 20_000 && heartbeatMask.cause === "model_wait",
    at(heartbeatMask),
  );

  const stalled = analyzeSilence({
    startedAtMs: 0,
    endedAtMs: 33_000,
    presentedText: [{ atMs: 3_000 }, { atMs: 33_000 }],
    heartbeats: [{ atMs: 0 }, { atMs: 1_000 }, { atMs: 2_000 }, { atMs: 3_000 }],
  });
  check(
    "a_heartbeatless_stretch_names_the_world",
    stalled.longestSilentMs === 30_000 && stalled.cause === "world_stalled",
    at(stalled),
  );

  // The distinction this gate exists to make: an UPPER BOUND versus an attribution. A run whose longest stretch is
  // bounded by the run window says nothing about what the player waited through; a run whose stretch sits between two
  // observable events names the segment, and only that number is worth optimising.
  const bounded = analyzeSilence({
    startedAtMs: 0,
    endedAtMs: 90_000,
    actions: [{ dispatchedAtMs: 5_000, settledAtMs: 5_100 }],
  });
  check("a_run_bounded_by_its_window_is_an_upper_bound", bounded.cause === "run_end", at(bounded));
  const attributable = analyzeSilence({
    startedAtMs: 0,
    endedAtMs: 90_000,
    actions: [
      { dispatchedAtMs: 5_000, settledAtMs: 5_100 },
      { dispatchedAtMs: 60_000, settledAtMs: 60_100 },
    ],
  });
  check(
    "attributable_run_names_its_segment",
    attributable.cause === "model_wait" && attributable.longestSilentMs === 54_900,
    at(attributable),
  );

  const unmeasurable = analyzeSilence({ presentedText: [{ atMs: 5_000 }] });
  check(
    "an_unmeasurable_run_answers_null_not_zero",
    unmeasurable.longestSilentMs === null && unmeasurable.cause === "unmeasured",
    `${String(unmeasurable.longestSilentMs)} (${unmeasurable.cause})`,
  );

  const unsettled = analyzeSilence({
    startedAtMs: 0,
    endedAtMs: 40_000,
    actions: [{ action: "water_crop", dispatchedAtMs: 0, settledAtMs: null }],
  });
  check(
    "an_unsettled_action_keeps_its_stretch_open",
    unsettled.longestSilentMs === 40_000 && unsettled.cause === "world_action_wait",
    at(unsettled),
  );
}

/**
 * A real run: the trace's absolute timestamps and the run's own window. Everything the artifacts cannot anchor is
 * reported in `unmeasured` next to the number instead of being assumed onto the clock.
 */
function runDirChecks(runDir) {
  if (!(existsSync(runDir) && statSync(runDir).isDirectory())) {
    check("run_dir_exists", false, runDir);
    return null;
  }
  check("run_dir_exists", true);

  const tracePath = join(runDir, "actionTrace.jsonl");
  const resultPath = join(runDir, "result.json");
  const resultRead = existsSync(resultPath) ? readJson(resultPath) : { value: null, error: `missing: ${resultPath}` };
  check("result_json_present", resultRead.error === null, resultRead.error ?? resultPath);

  if (!existsSync(tracePath)) {
    check("action_trace_present", false, tracePath);
    return null;
  }
  check("action_trace_present", true);
  const trace = readTrace(tracePath);
  check(
    "action_trace_readable",
    trace.malformed.length === 0,
    `${String(trace.entries.length)} entries, ${String(trace.malformed.length)} unreadable`,
  );

  const result = resultRead.value;
  const startedAtMs = typeof result?.startedAtMs === "number" ? result.startedAtMs : null;
  const endedAtMs = typeof result?.endedAtMs === "number" ? result.endedAtMs : null;
  check(
    "run_window_present",
    startedAtMs !== null && endedAtMs !== null,
    `startedAtMs=${String(startedAtMs)} endedAtMs=${String(endedAtMs)}`,
  );

  const pieces = Array.isArray(result?.presentation?.pieces) ? result.presentation.pieces : [];
  const placedPieces = pieces.filter((piece) => typeof piece?.atMs === "number" && Number.isFinite(piece.atMs));
  const presentedStatus = pieces.length === 0 || placedPieces.length === pieces.length ? true : "unmeasured";
  check(
    "presented_text_placed_on_run_clock",
    presentedStatus,
    pieces.length === 0
      ? "the run recorded no presented pieces"
      : `${String(pieces.length)} pieces, ${String(placedPieces.length)} carry an absolute atMs; ` +
          "the rest carry elapsedMs relative to a turnStartedAtMs that result.json does not publish",
  );
  check(
    "world_liveness_samples_present",
    "unmeasured",
    "result.json records no heartbeat samples; the per-tick lines exist only in mod-log.txt, which is copied from a " +
      "rotating shared SMAPI log with second-resolution timestamps and is not run-scoped",
  );

  const actions = trace.entries
    .filter((entry) => typeof entry?.dispatchedAtMs === "number")
    .map((entry) => ({
      action: entry.action,
      dispatchedAtMs: entry.dispatchedAtMs,
      settledAtMs: typeof entry.settledAtMs === "number" ? entry.settledAtMs : null,
    }));
  check(
    "action_trace_has_dispatches",
    actions.length > 0,
    `${String(trace.entries.length)} rows, ${String(actions.length)} with a dispatchedAtMs`,
  );

  const report = analyzeSilence({
    startedAtMs,
    endedAtMs,
    presentedText: placedPieces.map((piece) => ({ atMs: piece.atMs })),
    actions,
    heartbeats: [],
    modelTurns: [],
  });

  const within = (limitMs) => (report.longestSilentMs === null ? "unmeasured" : report.longestSilentMs <= limitMs);
  check(
    "observable_event_interval_within_3s",
    within(OBSERVABLE_EVENT_INTERVAL_MS),
    `${at(report)}; limit ${String(OBSERVABLE_EVENT_INTERVAL_MS)} ms`,
  );
  check(
    "longest_silent_stretch_within_10s",
    within(MAX_SILENT_STRETCH_MS),
    `${at(report)}; limit ${String(MAX_SILENT_STRETCH_MS)} ms`,
  );
  check(
    "unsettled_actions_are_counted",
    actions.every((entry) => entry.settledAtMs !== null) ? true : "unmeasured",
    `${String(actions.filter((entry) => entry.settledAtMs === null).length)} of ${String(actions.length)} dispatches have no terminal`,
  );

  return {
    report,
    measurement: {
      actionRows: trace.entries.length,
      malformedTraceLines: trace.malformed.length,
      dispatches: actions.length,
      presentedPieces: pieces.length,
      presentedPiecesPlaced: placedPieces.length,
      heartbeatSamples: 0,
      observableEvents: report.events.length,
    },
  };
}

function parseOption(name) {
  const index = process.argv.indexOf(name);
  return index < 0 || index + 1 >= process.argv.length ? null : process.argv[index + 1];
}

const runDir = parseOption("--run-dir");
const measurement = runDir === null ? rulesChecks() : runDirChecks(runDir);

const failed = checks.filter((entry) => entry.status === "failed");
const unmeasured = checks.filter((entry) => entry.status === "unmeasured");
const status = failed.length > 0 ? "failed" : "passed";

process.stdout.write(
  `${JSON.stringify({
    gate: "live_run_silence/v1",
    mode: runDir === null ? "rules" : "run-dir",
    runDir,
    status,
    thresholds: {
      observableEventIntervalMs: OBSERVABLE_EVENT_INTERVAL_MS,
      maxSilentStretchMs: MAX_SILENT_STRETCH_MS,
    },
    ...(measurement === null ? {} : measurement),
    checks,
    // A pass must not read as wider than the artifacts support: everything that could not be placed on the run
    // clock is named here rather than assumed into the number.
    ...(unmeasured.length > 0 ? { unmeasured: unmeasured.map((entry) => entry.id) } : {}),
  })}\n`,
);
if (failed.length > 0) process.exitCode = 1;
