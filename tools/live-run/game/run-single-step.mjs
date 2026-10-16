/**
 * Re-enter one failing step of a day that already ran.
 *
 * A day-level replay, not an in-day checkpoint: the engine writes its save only at day end, so the way back
 * is "start that day's morning slot again, drive the recorded trace to step n, then inject the failure".
 * Two rules make it faithful, and both are enforced here rather than trusted:
 *
 *   1. The SOURCE slot is never run on. The caller restores a copy and points this command at the copy's own
 *      client config; a config whose observed slot equals `--day-start-slot` is refused by name, because a
 *      replay that mutates the source cannot be run a second time.
 *   2. Dispatch is gated on the world's OWN clock (see `tools/lib/replay-clock.mjs`). Waiting is the correct
 *      answer and is budgeted from the trace, so a long replay never dies on an unrelated harness timeout.
 *
 * `--dry-run` needs no game at all: it validates the trace and prints the schedule and budget the live form
 * would follow, which is what makes this checkable in CI.
 *
 * Usage:
 *   node tools/live-run/game/run-single-step.mjs --dry-run --day-start-slot <slot> --day-action-trace <file> --turn <n>
 *   node tools/live-run/game/run-single-step.mjs --day-start-slot <recorded-slot> --day-action-trace <file> \
 *     --turn <n> --client-config <repro-slot>/GameBuddy.Stardew/config.json [--scenario <name>]
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import { validateActionTraceEntry } from "../../lib/evidence-bundle.mjs";
import { planReplaySchedule } from "../../lib/failure-dump.mjs";
import { replayActionTrace } from "../../lib/replay-engine.mjs";
import { decideReplayDispatch, expectedReplayWallClockMs } from "../../lib/replay-clock.mjs";
import { connectNativeLocalClient } from "../../lib/stardew-native-smoke-harness-v1.mjs";

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--dry-run" || token === "--fast-forward") {
      values.set(token, true);
      continue;
    }
    if (!token.startsWith("--") || index + 1 >= argv.length)
      throw new Error(`invalid_replay_argument:${String(token)}`);
    values.set(token, argv[index + 1]);
    index += 1;
  }
  return values;
}

const required = (values, name) => {
  const value = values.get(name);
  if (typeof value !== "string" || value.length === 0) throw new Error(`replay_missing_argument:${name}`);
  return value;
};

async function readActionTrace(path) {
  const text = await readFile(path, "utf8");
  const lines = text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new Error("replay_trace_empty");
  return lines.map((line) => JSON.parse(line));
}

function validateTrace(trace) {
  const violations = [];
  for (const [index, entry] of trace.entries())
    violations.push(...validateActionTraceEntry(entry, `actionTrace[${String(index)}]`));
  if (violations.length > 0) {
    const codes = [...new Set(violations.map((item) => item.code))].sort().join(",");
    throw new Error(`replay_trace_invalid:${codes}`);
  }
}

async function main(argv) {
  const values = parseArgs(argv);
  const dayStartSlot = required(values, "--day-start-slot");
  const tracePath = required(values, "--day-action-trace");
  const turn = Number.parseInt(required(values, "--turn"), 10);
  const scenario = values.get("--scenario") ?? null;
  const trace = await readActionTrace(tracePath);
  validateTrace(trace);
  if (!Number.isInteger(turn) || turn < 0 || turn > trace.length) throw new Error("replay_turn_out_of_range");

  const schedule = planReplaySchedule(trace.slice(0, turn), decideReplayDispatch);
  const budget = expectedReplayWallClockMs(trace.slice(0, turn));
  // The clock gate is what makes this replay faithful; the schedule is published so a reader can see the
  // engine plans the same waits this command reported, rather than discovering them at runtime.
  const plan = Object.freeze({
    dayStartSlot,
    scenario,
    turn,
    replayedSteps: turn,
    expectedWallClockMs: budget === null ? null : budget.totalMs,
    schedule,
  });

  if (values.get("--dry-run") === true) {
    process.stdout.write(`${JSON.stringify({ state: "planned", ...plan })}\n`);
    return;
  }

  // The acceleration seam is reserved but NOT enabled: the plan requires a slow-vs-fast control proving the
  // same causal preconditions at step n before it can become a default, and the Mod-side tick seam it would
  // drive does not exist yet. Refusing by name keeps the channel honest instead of silently replaying at a
  // speed nobody validated.
  if (values.get("--fast-forward") === true)
    throw new Error("replay_fast_forward_unavailable:no_mod_tick_seam_and_no_control_run");

  const clientConfigPath = required(values, "--client-config");
  if (!existsSync(clientConfigPath)) throw new Error("replay_client_config_missing");
  const config = JSON.parse(await readFile(clientConfigPath, "utf8"));
  const observedSlot = config?.NativeLocalPlayerFixture?.ObservedSaveSlot ?? null;
  if (observedSlot === null) throw new Error("replay_client_config_not_a_native_local_fixture");
  if (observedSlot === dayStartSlot) {
    throw new Error(
      `replay_source_slot_not_a_copy: the client config drives ${observedSlot}, which is the recorded source slot; restore a copy and point this command at the copy (a replay on the source destroys the only copy of that morning)`,
    );
  }

  const session = await connectNativeLocalClient(config);
  try {
    const result = await replayActionTrace({
      connection: session.client,
      actionTrace: trace,
      turn,
      stepTimeoutMs: Number.parseInt(values.get("--step-timeout-ms") ?? "", 10) || undefined,
      maxClockWaitMs: Number.parseInt(values.get("--clock-wait-ms") ?? "", 10) || undefined,
      onStep: (step) => process.stderr.write(`REPLAY_STEP ${JSON.stringify(step)}\n`),
      onClockWait: ({ recordedInGameTime, current, gapGameMinutes }) =>
        process.stderr.write(`REPLAY_CLOCK_WAIT ${JSON.stringify({ recordedInGameTime, current, gapGameMinutes })}\n`),
    });
    const payload = { ...plan, ...result };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    if (result.state !== "reached") process.exitCode = 1;
  } finally {
    await session.close();
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
