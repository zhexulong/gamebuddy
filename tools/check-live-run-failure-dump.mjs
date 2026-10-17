/**
 * The failure-dump gate: a run that fails must leave a dump a replay can use, and the replay engine's
 * clock gate must be what actually holds a dispatch back.
 *
 * Everything here runs offline from fixtures, so the gate is checkable in CI. The live half (a real replay
 * against a restored slot) is the operator path in `run-single-step.mjs`.
 *
 * Usage: node tools/check-live-run-failure-dump.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { readEvidenceBundle, writeEvidenceBundle } from "./lib/evidence-bundle.mjs";

const TRACE = [traceEntry("req-1", "till_soil", "620"), traceEntry("req-2", "water_crop", "900")];

function traceEntry(requestId, action, inGameTime) {
  return {
    requestId,
    action,
    args: { targetX: 12, targetY: 8 },
    state: "succeeded",
    reasonCode: action === "till_soil" ? "soil_tilled" : "crop_watered",
    inGameTime,
    day: 5,
    season: "spring",
    year: 1,
    dispatchedAtMs: 1_700_000_000_000,
  };
}

function failingBundle({ failure, repro }) {
  return {
    schemaVersion: 1,
    run: {
      id: "gate-failure-dump",
      scenario: "morning_routine",
      startedAtMs: 1_700_000_000_000,
      durationMs: 600_000,
      gitSha: "0000000",
      runtimeRoot: "C:/fixture/runtime",
    },
    env: {
      smapiVersion: "4.5.2",
      gameVersion: "1.6.15",
      os: "windows",
      windowMode: "hidden",
      gpu: null,
      resolution: null,
      saveHash: "fixture",
      reason: "headless_environment",
    },
    verdict: { state: "failed", reasonCode: "native_door_locked", rubric: { broken: [], unmeasured: [] } },
    timeline: { path: "timeline.jsonl", records: 0, sources: ["player", "llm"] },
    actionTrace: { path: "actionTrace.jsonl", records: TRACE.length },
    keyFrames: { status: "skipped", reason: "headless_environment", dir: null },
    reclamation: { state: "clean", exitReason: "completed", steps: [], reflection: "completed" },
    voice: { state: "disabled", playback: "disabled", reasonCode: "voice_preference_absent" },
    failure,
    repro,
  };
}

const completeFailure = {
  reasonCode: "native_door_locked",
  component: "native-state",
  step: 2,
  playerTile: { x: 12, y: 8 },
  playerFacing: "up",
  poseSource: "execution_receipt_observation",
  inGameTime: "900",
  day: 5,
  season: "spring",
  year: 1,
  location: "Town",
  blockingProperties: ["NPCPassable"],
  collisionLayers: ["Buildings"],
  atMs: 1_700_000_500_000,
};

const completeRepro = {
  command:
    "node tools/live-run/game/run-single-step.mjs --day-start-slot GameBuddyFixtureStable_1 --day-action-trace actionTrace.jsonl --turn 2",
  expectedWallClockMs: 112_000,
  reach: "the_failing_day",
};

const checks = [];
const check = (id, ok, detail) =>
  checks.push({ id, status: ok ? "passed" : "failed", ...(detail === undefined ? {} : { detail }) });

function withFixture(name, mutate, run) {
  const root = mkdtempSync(join(tmpdir(), `gb-failure-dump-${name}-`));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function main() {
  // 1. A complete dump validates and survives the on-disk round trip.
  await withFixture("complete", null, async (root) => {
    const written = await writeEvidenceBundle(root, {
      bundle: failingBundle({ failure: completeFailure, repro: completeRepro }),
      actionTrace: TRACE,
    });
    const read = await readEvidenceBundle(root);
    check(
      "complete_dump_validates",
      read.violations.length === 0,
      read.violations.map((item) => item.code).join(",") || undefined,
    );
    check("failure_and_repro_written", written.files.failure !== null && written.files.repro !== null);
  });

  // 2. Each field a replay needs is individually load-bearing: drop it and the gate must name it.
  await withFixture("missing-fields", null, async (root) => {
    // `playerFacing` is checked separately: it is a NAMED absence, not a required field (a bare snapshot has no
    // facing). Dropping it while the source says the observation carried it is a dropped fact, which is refused.
    for (const field of [
      "playerTile",
      "poseSource",
      "inGameTime",
      "day",
      "season",
      "year",
      "location",
      "blockingProperties",
      "collisionLayers",
    ]) {
      const failure = { ...completeFailure, [field]: undefined };
      const result = await writeEvidenceBundle(root, {
        bundle: failingBundle({ failure, repro: completeRepro }),
        actionTrace: TRACE,
      }).then(
        () => "written",
        (error) => String(error.message),
      );
      check(`failure_${field}_required`, String(result).includes("failure_field_missing"), String(result));
    }
    {
      const failure = { ...completeFailure, playerFacing: null };
      const result = await writeEvidenceBundle(root, {
        bundle: failingBundle({ failure, repro: completeRepro }),
        actionTrace: TRACE,
      }).then(
        () => "written",
        (error) => String(error.message),
      );
      check(
        "failure_playerFacing_required",
        String(result).includes("failure_facing_missing_from_observation"),
        String(result),
      );
    }
  });

  // 3. A failing run with no dump at all is refused (not written as a smaller artifact).
  await withFixture("no-dump", null, async (root) => {
    const result = await writeEvidenceBundle(root, {
      bundle: failingBundle({ failure: null, repro: null }),
      actionTrace: TRACE,
    }).then(
      () => "written",
      (error) => String(error.message),
    );
    check(
      "failed_run_requires_a_dump",
      String(result).includes("failure_snapshot_missing") && String(result).includes("repro_command_missing"),
      String(result),
    );
  });

  // 4. A budget is not optional: without it the replay would be killed by an unrelated harness timeout.
  await withFixture("no-budget", null, async (root) => {
    const result = await writeEvidenceBundle(root, {
      bundle: failingBundle({ failure: completeFailure, repro: { ...completeRepro, expectedWallClockMs: null } }),
      actionTrace: TRACE,
    }).then(
      () => "written",
      (error) => String(error.message),
    );
    check("repro_budget_required", String(result).includes("repro_budget_missing"), String(result));
  });

  // 5a. A repro that does not say what it can REACH is not one this bundle can vouch for.
  await withFixture("no-reach", null, async (root) => {
    const result = await writeEvidenceBundle(root, {
      bundle: failingBundle({ failure: completeFailure, repro: { ...completeRepro, reach: undefined } }),
      actionTrace: TRACE,
    }).then(
      () => "written",
      (error) => String(error.message),
    );
    check("repro_reach_required", String(result).includes("repro_reach_unstated"), String(result));
  });

  // 5. The trace cannot lose the clock: a replay with no recorded game time cannot be gated.
  await withFixture("no-clock", null, async (root) => {
    const { inGameTime, ...withoutClock } = TRACE[0];
    const result = await writeEvidenceBundle(root, {
      bundle: failingBundle({ failure: completeFailure, repro: completeRepro }),
      actionTrace: [withoutClock],
    }).then(
      () => "written",
      (error) => String(error.message),
    );
    check("trace_clock_required", String(result).includes("action_trace_field_missing"), String(result));
  });

  // 6. The dry-run entry point runs with no game and reports the same budget the plan derives.
  const dryRunRoot = mkdtempSync(join(tmpdir(), "gb-failure-dump-dryrun-"));
  try {
    const tracePath = join(dryRunRoot, "actionTrace.jsonl");
    mkdirSync(dryRunRoot, { recursive: true });
    writeFileSync(tracePath, `${TRACE.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
    let output = null;
    let failure = null;
    try {
      output = execFileSync(
        process.execPath,
        [
          "tools/live-run/game/run-single-step.mjs",
          "--dry-run",
          "--day-start-slot",
          "GameBuddyFixtureStable_1",
          "--day-action-trace",
          tracePath,
          "--turn",
          "2",
        ],
        { encoding: "utf8", cwd: process.cwd() },
      );
    } catch (error) {
      failure = String(error?.stderr ?? error?.message ?? error);
    }
    const parsed = output === null ? null : JSON.parse(output);
    check(
      "dry_run_plans_without_a_game",
      parsed?.state === "planned" && parsed.replayedSteps === 2,
      failure ?? undefined,
    );
    check(
      "dry_run_budget_matches_the_trace",
      parsed?.expectedWallClockMs === 112_000,
      String(parsed?.expectedWallClockMs),
    );
    check(
      "dry_run_publishes_the_gate_schedule",
      Array.isArray(parsed?.schedule) && parsed.schedule.every((step) => step.decision === "dispatch"),
    );
  } finally {
    rmSync(dryRunRoot, { recursive: true, force: true });
  }

  // 7. The acceleration seam is refused by name until the control run exists: a silent fast path would be
  //    exactly the "replayed at a speed nobody validated" failure this gate is about.
  {
    const tracePath = join(tmpdir(), `gb-failure-dump-ff-${Date.now()}.jsonl`);
    writeFileSync(tracePath, `${JSON.stringify(TRACE[0])}\n`, "utf8");
    let failure = "";
    try {
      execFileSync(
        process.execPath,
        [
          "tools/live-run/game/run-single-step.mjs",
          "--fast-forward",
          "--day-start-slot",
          "s",
          "--day-action-trace",
          tracePath,
          "--turn",
          "1",
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (error) {
      failure = String(error?.stderr ?? "");
    }
    rmSync(tracePath, { force: true });
    check(
      "fast_forward_refused_by_name",
      failure.includes("replay_fast_forward_unavailable"),
      failure.trim() || "no failure reported",
    );
  }

  const failed = checks.filter((entry) => entry.status !== "passed");
  process.stdout.write(
    `${JSON.stringify({ gate: "live_run_failure_dump/v1", status: failed.length === 0 ? "passed" : "failed", checks })}\n`,
  );
  if (failed.length > 0) process.exitCode = 1;
}

await main();
