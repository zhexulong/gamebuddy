// The evidence bundle's falsifiers: every obligation must be able to fail on its own, and the
// bundle must refuse to be written when it cannot describe its own run honestly.
//
// red-proof: inject  the `repro_command_missing` obligation dropped from `validateEvidenceBundle` ->
//                    `✖ a failed run without its snapshot or its replay is not evidence`, exit 1; the unmodified
//                    bundle prints `fail 0`, exit 0 (tools/lib/evidence-bundle.test.mjs)
// red-proof: history  the shipped 2026-11-10 `fixtures/stardew/evidence-bundle/manifest.json` (no `hostMemory`, a
//                    completed reclamation over no steps) -> `✖ the documented bundle publishes what its producers
//                    derive`, exit 1; the corrected fixture prints `fail 0`, exit 0 (tools/lib/evidence-bundle.test.mjs)
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  EVIDENCE_BUNDLE_CANONICAL_DIR,
  EVIDENCE_BUNDLE_FILES,
  EVIDENCE_BUNDLE_VERDICT_STATES,
  readEvidenceBundle,
  validateActionTraceEntry,
  validateEvidenceBundle,
  writeEvidenceBundle,
} from "./evidence-bundle.mjs";
import { decideReplayDispatch, expectedReplayWallClockMs, REAL_MILLISECONDS_PER_GAME_MINUTE } from "./replay-clock.mjs";
import { HOST_MEMORY_TURN_CAP, summarizeHostMemory } from "./live-run-memory.mjs";
import { RECLAMATION_REQUIRED_STEPS, reclamationRecord, reclamationStep } from "./live-run-teardown.mjs";
import { deriveLoopVerdict } from "../run-stardew-multiplayer-live-loop.mjs";

const TRACE = [
  {
    requestId: "req-1",
    action: "till_soil",
    args: { targetX: 12, targetY: 8 },
    state: "succeeded",
    reasonCode: "soil_tilled",
    inGameTime: "620",
    day: 5,
    season: "spring",
    year: 1,
    dispatchedAtMs: 1_700_000_000_000,
  },
  {
    requestId: "req-2",
    action: "water_crop",
    args: { targetX: 12, targetY: 8 },
    state: "succeeded",
    reasonCode: "crop_watered",
    inGameTime: "900",
    day: 5,
    season: "spring",
    year: 1,
    dispatchedAtMs: 1_700_000_040_000,
  },
];

const bundle = (overrides = {}) => ({
  schemaVersion: 1,
  run: {
    id: "run-1",
    scenario: "morning_routine",
    startedAtMs: 1_700_000_000_000,
    durationMs: 900_000,
    gitSha: "e8e86c3",
    runtimeRoot: "D:\\GameBuddy\\runtimes\\lane-a",
  },
  env: {
    smapiVersion: "4.5.2",
    gameVersion: "1.6.15",
    os: "windows",
    windowMode: "hidden",
    gpu: null,
    resolution: null,
    saveHash: "abcd",
    reason: "headless_environment",
  },
  verdict: {
    state: "passed",
    reasonCode: "multiplayer_loop_agent_turn_completed",
    rubric: { broken: [], unmeasured: [] },
  },
  timeline: { path: EVIDENCE_BUNDLE_FILES.timeline, records: 1, sources: ["player", "llm"] },
  actionTrace: { path: EVIDENCE_BUNDLE_FILES.actionTrace, records: TRACE.length },
  // The run trace's record, as the run directory's writer publishes it: a source the product wrote, or a named absence.
  runTrace: {
    path: EVIDENCE_BUNDLE_FILES.runTrace,
    present: false,
    reason: "run_trace_not_declared",
    sourcePath: null,
    spans: null,
  },
  keyFrames: { status: "skipped", reason: "no_evidence_display", dir: null },
  hostMemory: {
    state: "measured",
    samples: 412,
    startRssMb: 316,
    minRssMb: 229,
    maxRssMb: 632,
    minFreeMb: 1057,
    turns: [{ turn: 0, rssMb: 316, heapUsedMb: 208, sessionBytes: 12_345 }],
    omitted: 0,
  },
  reclamation: {
    state: "clean",
    exitReason: "game_exit:code:0",
    steps: [
      { step: "runtime_close", state: "ok", detail: null, pids: [] },
      { step: "process_reap", state: "ok", detail: "game_exit:code:0", pids: [4321] },
      { step: "fixture_restore", state: "ok", detail: null, pids: [] },
    ],
    reflection: "completed",
  },
  voice: { state: "disabled", playback: "disabled", reasonCode: "voice_preference_absent" },
  failure: null,
  repro: { command: null, expectedWallClockMs: null },
  ...overrides,
});

const failing = (failureOverrides = {}, reproOverrides = {}) =>
  bundle({
    verdict: {
      state: "failed",
      reasonCode: "native_door_locked",
      rubric: { broken: ["no_blind_retry"], unmeasured: [] },
    },
    failure: {
      reasonCode: "native_door_locked",
      component: "native-state",
      step: 30,
      playerTile: { x: 12, y: 8 },
      playerFacing: "up",
      inGameTime: "900",
      day: 5,
      season: "spring",
      year: 1,
      location: "Town",
      poseSource: "execution_receipt_observation",
      blockingProperties: ["NPCPassable"],
      collisionLayers: ["Buildings"],
      atMs: 1_700_000_500_000,
      ...failureOverrides,
    },
    repro: {
      command: "node tools/live-run/game/run-single-step.mjs --day-action-trace actionTrace.jsonl --turn 30",
      expectedWallClockMs: 2_520_000,
      reach: "the_failing_day",
      ...reproOverrides,
    },
  });

const codesFor = (candidate, options) => validateEvidenceBundle(candidate, options).violations.map((item) => item.code);

test("a bundle that describes its own run passes every obligation", () => {
  const result = validateEvidenceBundle(bundle({}), { actionTrace: TRACE });
  assert.deepEqual(result.violations, []);
  assert.equal(result.ok, true);
  // The obligation list is the contract: a code that no check can emit would be coverage theatre.
  assert.ok(result.checkedObligations.length > 20);
});

test("a failed run without its snapshot or its replay is not evidence", () => {
  assert.ok(
    codesFor(bundle({ verdict: { state: "failed", rubric: { broken: [], unmeasured: [] } } })).includes(
      "failure_snapshot_missing",
    ),
  );
  assert.ok(codesFor(failing({}, { command: null })).includes("repro_command_missing"));
  assert.ok(codesFor(failing({}, { expectedWallClockMs: null })).includes("repro_budget_missing"));
  // Every field the contract requires is individually load-bearing: drop one and it is named.
  for (const field of ["location", "poseSource", "blockingProperties", "collisionLayers"]) {
    assert.ok(codesFor(failing({ [field]: undefined })).includes("failure_field_missing"), `${field} must be required`);
  }
  assert.ok(codesFor(failing({ playerTile: { x: 1 } })).includes("failure_player_tile_invalid"));
  // The replay is repositioned by TIME as well as place: a dump with no game moment cannot be re-entered.
  assert.ok(codesFor(failing({ inGameTime: null })).includes("failure_in_game_time_invalid"));
  assert.ok(codesFor(failing({ day: 30 })).includes("failure_date_invalid"));
  assert.ok(codesFor(failing({ season: "monsoon" })).includes("failure_date_invalid"));
  assert.ok(codesFor(failing({ location: null })).includes("failure_field_missing"));
  // Facing may be absent (a bare snapshot has none), but the ABSENCE must be named, and a receipt-sourced pose
  // that lost its facing is a dropped fact rather than an absent one.
  assert.ok(codesFor(failing({ poseSource: null })).includes("failure_pose_source_unknown"));
  assert.ok(codesFor(failing({ poseSource: "guessed" })).includes("failure_pose_source_unknown"));
  assert.ok(codesFor(failing({ playerFacing: null })).includes("failure_facing_missing_from_observation"));
  assert.deepEqual(codesFor(failing({ playerFacing: null, poseSource: "snapshot_only" })), []);
});

test("an unmeasured field must say so instead of taking a plausible default", () => {
  assert.deepEqual(codesFor(bundle({})), []);
  // A visible run has the window it can measure: the headless reason does not apply to it.
  const visible = bundle({
    env: { ...bundle().env, windowMode: "visible", gpu: "NVIDIA", resolution: "1920x1080", reason: null },
  });
  assert.deepEqual(codesFor(visible), []);
  assert.ok(codesFor(bundle({ env: { ...visible.env, gpu: null } })).includes("env_fact_not_measured"));
  // Only the headless window mode may omit the two window probes, with its own reason.
  assert.ok(codesFor(bundle({ env: { ...bundle().env, gpu: "NVIDIA" } })).includes("env_fact_not_measured") === false);
  assert.ok(
    codesFor(bundle({ env: { ...bundle().env, gpu: null, reason: "not_probed" } })).includes("env_fact_not_measured"),
  );
  assert.ok(
    codesFor(bundle({ env: { ...bundle().env, windowMode: "hidden", reason: null } })).includes(
      "env_fact_not_measured",
    ),
  );
  assert.ok(
    codesFor(bundle({ env: { ...bundle().env, smapiVersion: null, reason: "headless_environment" } })).includes(
      "env_fact_not_measured",
    ),
  );
  assert.ok(
    codesFor(bundle({ env: { ...bundle().env, windowMode: "invisible" } })).includes("env_window_mode_unknown"),
  );
  assert.ok(
    codesFor(bundle({ keyFrames: { status: "skipped", reason: null, dir: null } })).includes(
      "key_frames_reason_missing",
    ),
  );
  assert.ok(
    codesFor(bundle({ voice: { state: "disabled", playback: "disabled", reasonCode: null } })).includes(
      "voice_reason_missing",
    ),
  );
});

test("the request frame a replay needs cannot be dropped", () => {
  const { inGameTime, ...withoutTime } = TRACE[0];
  assert.ok(codesFor(bundle({}), { actionTrace: [withoutTime] }).includes("action_trace_field_missing"));
  const { args, ...withoutArgs } = TRACE[0];
  assert.ok(codesFor(bundle({}), { actionTrace: [withoutArgs] }).includes("action_trace_field_missing"));
  assert.ok(
    codesFor(bundle({}), { actionTrace: [{ ...TRACE[0], args: "target=12,8" }] }).includes(
      "action_trace_args_not_object",
    ),
  );
  assert.ok(
    codesFor(bundle({}), { actionTrace: [{ ...TRACE[0], inGameTime: "625" }] }).includes(
      "action_trace_in_game_time_invalid",
    ),
  );
  assert.ok(
    codesFor(bundle({}), { actionTrace: [{ ...TRACE[0], inGameTime: 620 }] }).includes(
      "action_trace_in_game_time_invalid",
    ),
  );
  assert.ok(codesFor(bundle({}), { actionTrace: [{ ...TRACE[0], day: 30 }] }).includes("action_trace_date_invalid"));
  assert.ok(
    codesFor(bundle({}), { actionTrace: [{ ...TRACE[0], season: "winter " }] }).includes("action_trace_date_invalid"),
  );
  const mismatched = bundle({ actionTrace: { path: EVIDENCE_BUNDLE_FILES.actionTrace, records: 1 } });
  assert.ok(codesFor(mismatched, { actionTrace: TRACE }).includes("action_trace_records_mismatch"));
});

test("the verdict vocabulary is the loop's own plus the one outcome the loop cannot decide", () => {
  const produced = [
    deriveLoopVerdict({ timedOut: false, exitCode: 0, driverState: "action_passed", loopResult: { agentTurns: 2 } }),
    deriveLoopVerdict({ timedOut: false, exitCode: 0, driverState: "action_passed", loopResult: {} }),
    deriveLoopVerdict({ timedOut: false, exitCode: 1, driverState: "action_failed", loopResult: {} }),
    deriveLoopVerdict({
      timedOut: false,
      exitCode: 0,
      driverState: "action_passed",
      loopResult: { agentTurns: 2, connectionDropped: true },
    }),
  ].map((verdict) => verdict.state);
  for (const state of produced)
    assert.ok(EVIDENCE_BUNDLE_VERDICT_STATES.includes(state), `${state} is not in the bundle's vocabulary`);
  // `killed` is the one state the loop cannot derive - nothing external interrupts the loop itself - so it joins the
  // set here rather than being given a second vocabulary. A new loop state still fails, and so does a vocabulary entry
  // that neither the loop nor the signal trap produces.
  assert.ok(!produced.includes("killed"), "the loop must never decide a run was killed");
  assert.deepEqual([...new Set([...produced, "killed"])].sort(), [...EVIDENCE_BUNDLE_VERDICT_STATES].sort());
  assert.ok(
    codesFor(bundle({ verdict: { state: "green", rubric: { broken: [], unmeasured: [] } } })).includes(
      "verdict_state_unknown",
    ),
  );
});

test("a run interrupted from outside is its own verdict, and may not pose as a failure", () => {
  // An external SIGTERM/SIGINT is not a measurement of the product: nothing about the companion was decided, so the
  // bundle needs neither a failure snapshot nor a replay, and the state must be sayable rather than squeezed into
  // `blocked` (where every aggregate would read it as a defect).
  const killed = bundle({
    verdict: {
      state: "killed",
      reasonCode: "run_killed_by_signal:SIGTERM",
      rubric: { broken: [], unmeasured: [] },
    },
  });
  assert.deepEqual(codesFor(killed), []);
  // ...and the reverse: a run that publishes `killed` beside a failure dump is claiming a failure moment nobody
  // observed, which is exactly how an interrupt would end up counted as a product defect.
  assert.ok(
    codesFor(bundle({ verdict: killed.verdict, failure: failing().failure })).includes(
      "killed_run_published_a_failure",
    ),
  );
});

test("a bundle reports a multi-day crossing only when the baseline's own judgement says so", () => {
  // Optional field: a single-day run has no crossings, so it is absent rather than an empty object. When
  // present, a run cannot report a passing crossing the baseline did not pass.
  assert.deepEqual(codesFor(bundle({})), []);
  const passing = bundle({
    multiday: {
      crossings: 2,
      assessment: { state: "passed", ok: true, violations: [] },
      dayRecords: [
        { day: 1, terminal: null, after: null, menus: [], nextDayAccomplishedActionIds: [] },
        { day: 2, terminal: null, after: null, menus: [], nextDayAccomplishedActionIds: [] },
      ],
    },
  });
  assert.deepEqual(codesFor(passing), []);
  assert.ok(
    codesFor(
      bundle({
        multiday: {
          crossings: 2,
          assessment: { state: "passed", ok: false, violations: [] },
          dayRecords: [{}, {}],
        },
      }),
    ).includes("multiday_assessment_disagrees_with_its_own_state"),
  );
  assert.ok(
    codesFor(
      bundle({ multiday: { crossings: 2, assessment: { state: "passed", ok: true }, dayRecords: [{}] } }),
    ).includes("multiday_day_records_disagree_with_crossings"),
  );
  assert.ok(
    codesFor(bundle({ multiday: { crossings: 0, assessment: { state: "blocked", ok: false } } })).includes(
      "multiday_crossings_invalid",
    ),
  );
  assert.ok(codesFor(bundle({ multiday: "two" })).includes("multiday_not_object"));
});

test("a run directory is validated against what is on disk", async () => {
  const root = mkdtempSync(join(tmpdir(), "evidence-bundle-"));
  try {
    const written = await writeEvidenceBundle(root, {
      bundle: failing(),
      timeline: [{ atMs: 1, source: "player" }],
      actionTrace: TRACE,
    });
    assert.ok(written.files.failure !== null);
    const clean = await readEvidenceBundle(root);
    assert.deepEqual(clean.violations, []);

    // A manifest that claims one timeline record while the file has two is a lie about the run.
    writeFileSync(written.files.timeline, '{"atMs":1}\n{"atMs":2}\n', "utf8");
    assert.ok(
      (await readEvidenceBundle(root)).violations.map((item) => item.code).includes("timeline_records_mismatch"),
    );

    writeFileSync(written.files.timeline, '{"atMs":1}\n', "utf8");
    rmSync(written.files.timeline, { force: true });
    assert.ok((await readEvidenceBundle(root)).violations.map((item) => item.code).includes("timeline_missing"));
    writeFileSync(written.files.timeline, '{"atMs":1}\n', "utf8");
    const failureOnly = bundle({ verdict: { state: "failed", rubric: { broken: [], unmeasured: [] } }, failure: null });
    writeFileSync(join(root, EVIDENCE_BUNDLE_FILES.manifest), `${JSON.stringify(failureOnly)}\n`, "utf8");
    const codes = (await readEvidenceBundle(root)).violations.map((item) => item.code);
    assert.ok(codes.includes("failure_file_not_declared"));
    assert.ok(codes.includes("failure_file_missing") === false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a bundle that cannot describe its run is refused rather than written", async () => {
  const root = mkdtempSync(join(tmpdir(), "evidence-bundle-refused-"));
  try {
    await assert.rejects(
      () => writeEvidenceBundle(root, { bundle: failing({ location: null }), actionTrace: TRACE }),
      /evidence_bundle_invalid:failure_field_missing/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("replay waits for the recorded game time instead of smelling a false failure", () => {
  // Same game moment: dispatch. Behind it: wait, with the size of the gap.
  assert.deepEqual(decideReplayDispatch("900", "900"), { decision: "dispatch", reasonCode: null, gapGameMinutes: 0 });
  const waiting = decideReplayDispatch("900", "630");
  assert.equal(waiting.decision, "wait");
  assert.equal(waiting.gapGameMinutes, 150);
  // The day is over before the recorded moment arrived: nothing left to wait for.
  const dayOver = decideReplayDispatch("1400", "2600");
  assert.equal(dayOver.decision, "fail");
  assert.equal(dayOver.reasonCode, "replay_clock_behind:1400:2600");
  // 2:00 AM is the pass-out floor, so a trace recorded at it can never be reproduced.
  assert.equal(decideReplayDispatch("2600", "1200").reasonCode, "replay_clock_target_passed_out");
  assert.equal(decideReplayDispatch("900", "905").reasonCode, "replay_clock_input_invalid");
  // Waiting has a ceiling, and exhausting it is a named failure, never a silent early dispatch.
  const exhausted = decideReplayDispatch("2200", "630", { waitedMs: 700_000, maxWaitMs: 600_000 });
  assert.equal(exhausted.decision, "fail");
  assert.equal(exhausted.reasonCode, "replay_clock_wait_exhausted:2200:630");
  assert.equal(decideReplayDispatch("2200", "630", { waitedMs: 60_000, maxWaitMs: 600_000 }).decision, "wait");
});

test("the replay budget is derivable, so a long wait is planned rather than discovered", () => {
  const budget = expectedReplayWallClockMs(TRACE);
  // 620 -> 900 is 160 game minutes at the engine's own 700 ms per game minute.
  assert.equal(budget.totalMs, 160 * REAL_MILLISECONDS_PER_GAME_MINUTE);
  assert.equal(budget.totalMs, 112_000);
  assert.equal(expectedReplayWallClockMs([{ inGameTime: "nope" }]), null);
  assert.equal(expectedReplayWallClockMs(null), null);
});

test("the entry validator is usable on its own, per entry", () => {
  assert.deepEqual(validateActionTraceEntry(TRACE[0]), []);
  assert.equal(validateActionTraceEntry(null).length, 1);
  // Nothing to validate is a violation, not an empty pass.
  assert.deepEqual(codesFor(null), ["bundle_not_object"]);
  assert.equal(validateEvidenceBundle(null).ok, false);
});

// ── The two fields round40 published as nothing at all ────────────────────────────────────────────────────────────
//
// MEASURED 2026-11-09 (`round40`): the artifact an auditor reads carried no `hostMemory` and a `reclamation` of
// `{state: "unobserved", steps: [], reflection: "completed"}` - a completed reflection over zero teardown steps - while
// the run had 46 memory samples in its log and had genuinely reaped its game and released its fixture. The contract
// accepted both, so the bundle passed every obligation while being unable to answer either question. These are the
// falsifiers: a bundle that says NOTHING about its memory, and one that claims a completed unwind it never measured.

const HOST_MEMORY = {
  state: "measured",
  samples: 412,
  startRssMb: 316,
  minRssMb: 229,
  maxRssMb: 632,
  minFreeMb: 1057,
  turns: [{ turn: 0, rssMb: 316, heapUsedMb: 208, sessionBytes: 12_345 }],
  omitted: 0,
};

const RECLAMATION = {
  state: "clean",
  exitReason: "game_exit:code:0",
  steps: [
    { step: "runtime_close", state: "ok", detail: null, pids: [] },
    { step: "process_reap", state: "ok", detail: "game_exit:code:0", pids: [4321] },
    { step: "fixture_restore", state: "ok", detail: null, pids: [] },
  ],
  reflection: "completed",
};

test("a bundle that says nothing about its host memory is refused, and the refusal names the field", () => {
  assert.deepEqual(codesFor(bundle({ hostMemory: null })), ["host_memory_missing"]);
  assert.deepEqual(codesFor(bundle({ hostMemory: { ...HOST_MEMORY, state: "" } })), ["host_memory_missing"]);
  assert.deepEqual(codesFor(bundle({ hostMemory: { ...HOST_MEMORY, omitted: null } })), ["host_memory_missing"]);
  // Bounded is part of the contract: an unbounded series is not a projection of the run, it is the run.
  const unbounded = Array.from({ length: HOST_MEMORY_TURN_CAP + 1 }, (_, turn) => ({ ...HOST_MEMORY.turns[0], turn }));
  assert.deepEqual(codesFor(bundle({ hostMemory: { ...HOST_MEMORY, turns: unbounded } })), [
    "host_memory_series_unbounded",
  ]);
  // The one shape that is allowed to be empty says WHY it is empty.
  assert.deepEqual(
    codesFor(bundle({ hostMemory: { ...HOST_MEMORY, state: "not_measured:no_turn_samples", turns: [] } })),
    [],
  );
});

test("round40's reclamation - completed, with no steps - is refused", () => {
  // The real artifact, verbatim: `{state: "unobserved", exitReason: null, steps: [], reflection: "completed"}`.
  assert.deepEqual(
    codesFor(bundle({ reclamation: { state: "unobserved", exitReason: null, steps: [], reflection: "completed" } })),
    ["reclamation_completed_without_steps"],
  );
  // A skipped reflection over no steps is honest, and passes.
  assert.deepEqual(
    codesFor(bundle({ reclamation: { state: "unobserved", exitReason: null, steps: [], reflection: "skipped" } })),
    [],
  );
  // A state outside the closed set cannot be judged by a reader or by a gate.
  assert.deepEqual(codesFor(bundle({ reclamation: { ...RECLAMATION, state: "mostly_fine" } })), [
    "reclamation_state_unknown",
  ]);
  // A step that does not say whether it finished is not a step.
  assert.deepEqual(codesFor(bundle({ reclamation: { ...RECLAMATION, steps: [{ step: "runtime_close" }] } })), [
    "reclamation_step_malformed",
  ]);
  assert.deepEqual(codesFor(bundle({ reclamation: RECLAMATION, hostMemory: HOST_MEMORY })), []);
});

// ── The run trace: the slot a declared span name lands in ─────────────────────────────────────────────────────────
//
// MEASURED 2026-11-11: the product wrote `run-trace.json` for every graceful run (152 KB beside one run's manifest) and
// every evidence package published `runTrace: {present: false, reason: "product_did_not_flush_run_trace"}`, because the
// runner probed for the file while assembling the package - before `runtime.close()` ran - and nothing ever copied it
// in. A slot for a file that is read too early is still empty, and a bundle that cannot answer "how long did admission
// take" is the whole reason the trace exists.

const RUN_TRACE_SPANS = [
  {
    ph: "X",
    ts: 1_000_000,
    dur: 40_000,
    pid: 1,
    tid: 1,
    name: "admission",
    args: { programId: "program_01", nodeId: "node_01", actionId: "water_crop", result: "granted" },
  },
  { ph: "X", ts: 1_040_000, dur: 90_000, pid: 1, tid: 1, name: "mod.execute", args: { actionId: "water_crop" } },
];

/** A trace file in the product's own format (`host/src/run-trace.ts`), written where the product would put it. */
const runTraceSource = (root) => {
  const path = join(root, "runtime-root", "surface-sessions", "game-1", "run-trace.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ displayTimeUnit: "ms", droppedSpans: 0, traceEvents: RUN_TRACE_SPANS })}\n`);
  return path;
};

test("the run trace is copied into the package, and the manifest's record is the file's own", async () => {
  const root = mkdtempSync(join(tmpdir(), "evidence-bundle-run-trace-"));
  try {
    const sourcePath = runTraceSource(root);
    const written = await writeEvidenceBundle(join(root, "run"), {
      bundle: bundle({ runTrace: { path: sourcePath } }),
      timeline: [{ atMs: 1, source: "llm" }],
      actionTrace: TRACE,
    });
    assert.equal(written.files.runTrace, join(root, "run", EVIDENCE_BUNDLE_FILES.runTrace));
    const copied = JSON.parse(readFileSync(written.files.runTrace, "utf8"));
    assert.deepEqual(
      copied.traceEvents.map((event) => event.name),
      ["admission", "mod.execute"],
    );
    const manifest = JSON.parse(readFileSync(join(root, "run", EVIDENCE_BUNDLE_FILES.manifest), "utf8"));
    assert.equal(manifest.runTrace.present, true);
    assert.equal(manifest.runTrace.reason, null);
    assert.equal(manifest.runTrace.spans, RUN_TRACE_SPANS.length);
    assert.equal(manifest.runTrace.sourcePath, sourcePath);
    assert.deepEqual((await readEvidenceBundle(join(root, "run"))).violations, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run that ended without a graceful close still publishes the trace it had written", async () => {
  // The file exists because the product rewrites it while the run is live; the close never ran, so the only evidence
  // that it ever existed is this copy. A killed run is not a failure assertion either - it is its own verdict.
  const root = mkdtempSync(join(tmpdir(), "evidence-bundle-killed-run-trace-"));
  try {
    const sourcePath = runTraceSource(root);
    const written = await writeEvidenceBundle(join(root, "run"), {
      bundle: bundle({
        verdict: {
          state: "killed",
          reasonCode: "run_killed_by_signal:SIGTERM",
          rubric: { broken: [], unmeasured: [] },
        },
        runTrace: { path: sourcePath, present: false, reason: "product_did_not_flush_run_trace" },
      }),
      timeline: [{ atMs: 1, source: "llm" }],
      actionTrace: TRACE,
    });
    const manifest = JSON.parse(readFileSync(join(root, "run", EVIDENCE_BUNDLE_FILES.manifest), "utf8"));
    // The writer's answer wins: the file is the authority, not the probe the runner took before teardown.
    assert.equal(manifest.runTrace.present, true);
    assert.equal(manifest.verdict.state, "killed");
    assert.equal(written.files.runTrace !== null, true);
    assert.deepEqual((await readEvidenceBundle(join(root, "run"))).violations, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing trace is a named absence, and a claimed one must be on disk", async () => {
  const root = mkdtempSync(join(tmpdir(), "evidence-bundle-no-run-trace-"));
  try {
    const written = await writeEvidenceBundle(join(root, "run"), {
      bundle: bundle({ runTrace: { path: join(root, "never-written", "run-trace.json") } }),
      timeline: [{ atMs: 1, source: "llm" }],
      actionTrace: TRACE,
    });
    const manifest = JSON.parse(readFileSync(join(root, "run", EVIDENCE_BUNDLE_FILES.manifest), "utf8"));
    assert.equal(manifest.runTrace.present, false);
    assert.equal(manifest.runTrace.reason, "run_trace_absent_at_bundle_time");
    assert.equal(written.files.runTrace, null);
    // The package is still honest: an absent trace is reported, and reading it back reports nothing new.
    assert.deepEqual((await readEvidenceBundle(join(root, "run"))).violations, []);

    // A bundle whose manifest CLAIMS a trace the directory does not hold is a lie about the run.
    writeFileSync(
      join(root, "run", EVIDENCE_BUNDLE_FILES.manifest),
      `${JSON.stringify(bundle({ runTrace: { path: EVIDENCE_BUNDLE_FILES.runTrace, present: true, reason: null, spans: 2 } }))}\n`,
    );
    assert.ok(
      (await readEvidenceBundle(join(root, "run"))).violations.map((item) => item.code).includes("run_trace_missing"),
    );
    // ...and one whose declaration is not a record at all is named rather than skipped.
    assert.ok(codesFor(bundle({ runTrace: undefined })).includes("run_trace_declaration_missing"));
    assert.ok(codesFor(bundle({ runTrace: { present: false, reason: null } })).includes("run_trace_reason_missing"));
    assert.ok(codesFor(bundle({ runTrace: { present: "yes" } })).includes("run_trace_presence_unstated"));
    assert.ok(codesFor(bundle({ runTrace: { present: true, reason: null } })).includes("run_trace_spans_invalid"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── The documented bundle is what its producers derive, not a copy of the shape ───────────────────────────────────
//
// MEASURED 2026-11-12: `fixtures/stardew/evidence-bundle` is the shape `pnpm check:evidence-bundle` validates in contract
// mode, and it was never given the two facts this contract began requiring on 2026-11-10. So the gate read
// `reclamation_completed_without_steps` and `host_memory_missing` on the DOCUMENTED shape while every real run's
// manifest passed (`--run-dir` over the 2026-11-10 and 2026-11-11 runs: zero violations) - a standing red that named no
// run, no writer and no fix. Two hand-written copies of one shape drift in silence; these assertions re-derive the
// fixture's own facts with the producers, so a shape no producer can emit fails here by name.

const CANONICAL_BUNDLE_DIR = fileURLToPath(new URL(`../../${EVIDENCE_BUNDLE_CANONICAL_DIR}`, import.meta.url));
const readCanonicalBundle = (name) => readFileSync(join(CANONICAL_BUNDLE_DIR, name), "utf8");

test("the documented bundle publishes what its producers derive", () => {
  const documented = JSON.parse(readCanonicalBundle(EVIDENCE_BUNDLE_FILES.manifest));

  assert.ok(
    documented.reclamation !== null && typeof documented.reclamation === "object",
    "the documented bundle publishes no reclamation account",
  );
  assert.ok(
    documented.hostMemory !== null && typeof documented.hostMemory === "object",
    "the documented bundle publishes no hostMemory",
  );

  // The teardown: `state` and `reflection` are DERIVED from the steps (`reclamationRecord`), never written by hand, which
  // is what makes a completed reflection over no step impossible to publish.
  const steps = documented.reclamation.steps.map((entry) =>
    reclamationStep({ step: entry.step, ok: entry.state === "ok", detail: entry.detail, pids: entry.pids }),
  );
  assert.deepEqual(
    documented.reclamation,
    reclamationRecord({ steps, exitReason: documented.reclamation.exitReason }),
    "the documented reclamation is not what reclamationRecord derives from its own steps",
  );
  // ...and a finished run owes every step, so the example cannot document a partial unwind either.
  assert.deepEqual(
    steps.map((entry) => entry.step),
    [...RECLAMATION_REQUIRED_STEPS],
    "the documented teardown omits a step every finished run owes",
  );

  // The memory: the field list and the state are `summarizeHostMemory`'s, derived here from the fixture's own samples.
  assert.deepEqual(
    Object.keys(documented.hostMemory).sort(),
    Object.keys(summarizeHostMemory({})).sort(),
    "the documented hostMemory is not the shape summarizeHostMemory publishes",
  );
  assert.equal(
    documented.hostMemory.state,
    summarizeHostMemory({ turns: documented.hostMemory.turns }).state,
    "the documented hostMemory's state is not the one its own turn samples give it",
  );

  // The document is what the gate accepts, so this test and `pnpm check:evidence-bundle` can only disagree by name.
  const actionTrace = readCanonicalBundle(EVIDENCE_BUNDLE_FILES.actionTrace)
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
  assert.deepEqual(validateEvidenceBundle(documented, { actionTrace }).violations, []);
});
