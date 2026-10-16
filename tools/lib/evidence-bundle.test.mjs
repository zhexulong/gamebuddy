// The evidence bundle's falsifiers: every obligation must be able to fail on its own, and the
// bundle must refuse to be written when it cannot describe its own run honestly.
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
  reclamation: { state: "clean", exitReason: "completed", steps: [], reflection: "completed" },
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
      blockingProperties: ["NPCPassable"],
      collisionLayers: ["Buildings"],
      atMs: 1_700_000_500_000,
      ...failureOverrides,
    },
    repro: {
      command: "node tools/live-run/game/run-single-step.mjs --day-action-trace actionTrace.jsonl --turn 30",
      expectedWallClockMs: 2_520_000,
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
  const incomplete = failing({ playerFacing: undefined });
  assert.ok(codesFor(incomplete).includes("failure_field_missing"));
  assert.ok(codesFor(failing({ playerTile: { x: 1 } })).includes("failure_player_tile_invalid"));
  // The replay is repositioned by TIME as well as place: a dump with no game moment cannot be re-entered.
  assert.ok(codesFor(failing({ inGameTime: null })).includes("failure_in_game_time_invalid"));
  assert.ok(codesFor(failing({ day: 30 })).includes("failure_date_invalid"));
  assert.ok(codesFor(failing({ season: "monsoon" })).includes("failure_date_invalid"));
  assert.ok(codesFor(failing({ location: null })).includes("failure_field_missing"));
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

test("the verdict vocabulary is the loop's own, not a second list", () => {
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
  assert.deepEqual([...new Set(produced)].sort(), [...EVIDENCE_BUNDLE_VERDICT_STATES].sort());
  assert.ok(
    codesFor(bundle({ verdict: { state: "green", rubric: { broken: [], unmeasured: [] } } })).includes(
      "verdict_state_unknown",
    ),
  );
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
      () => writeEvidenceBundle(root, { bundle: failing({ playerFacing: null }), actionTrace: TRACE }),
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
