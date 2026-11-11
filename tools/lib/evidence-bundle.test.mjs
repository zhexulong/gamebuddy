// The evidence bundle's falsifiers: every obligation must be able to fail on its own, and the
// bundle must refuse to be written when it cannot describe its own run honestly.
//
// red-proof: inject  the `repro_command_missing` obligation dropped from `validateEvidenceBundle` ->
//                    `✖ a failed run without its snapshot or its replay is not evidence`, exit 1; the unmodified
//                    bundle prints `fail 0`, exit 0 (tools/lib/evidence-bundle.test.mjs)
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  EVIDENCE_BUNDLE_FILES,
  EVIDENCE_BUNDLE_VERDICT_STATES,
  readEvidenceBundle,
  validateActionTraceEntry,
  validateEvidenceBundle,
  writeEvidenceBundle,
} from "./evidence-bundle.mjs";
import { decideReplayDispatch, expectedReplayWallClockMs, REAL_MILLISECONDS_PER_GAME_MINUTE } from "./replay-clock.mjs";
import { HOST_MEMORY_TURN_CAP } from "./live-run-memory.mjs";
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
