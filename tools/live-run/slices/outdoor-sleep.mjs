#!/usr/bin/env node
import { executeFresh, TERMINAL_STATES } from "../../lib/stardew-native-smoke-harness-v1.mjs";
/**
 * SLICE ① - A NIGHT THAT CANNOT BEGIN IS REFUSED, NOT WAITED OUT.
 *
 * THE PROPERTY. `sleep()` submitted from a place the actor does not sleep in ends with the Mod's own refusal
 * (`not_home`) inside two seconds, and the body is free afterwards. Nothing else is asserted: this slice answers one
 * question about one seam.
 *
 * WHY IT IS A SLICE. Measured 2026-11-22 (`round93`, `plan_463`): the night answered `not_home` for **308 s** while the
 * engine's 2:00 AM pass-out approached. The actions were fine - single-action success in that run was 96.7% - and the
 * seam was not: the walk home that would have cleared `not_home` is a node of a DIFFERENT programme, and the submission
 * path refuses one while this node has not settled, so no amount of waiting could ever have changed the answer.
 *
 * THE WORLD. Fixture key `sleep_outdoor` arms the play-session world (`native_play_session_v1`): the actor stands on the
 * Farm with the farmhouse behind her, which is outside `HomeOf` and therefore exactly the `not_home` world. The slice
 * reads the location from the snapshot and refuses to score a run in which she is at home - a slice that measured a
 * different world must not report this seam as passing.
 *
 * WHAT IT DOES NOT COVER. It does not assert WHAT the refusal's evidence says, it does not cover the co-op barrier or a
 * paused clock (the other eligibility reasons, which a menu or another farmer can clear), and it does not prove the
 * refusal is fast when the actor is one tile from her own bed. It also says nothing about the projection the companion
 * reads (`sleepAdmitsHere`): it measures the wire's terminal, not the sentence the player sees.
 *
 * USAGE
 *   node tools/live-run/slices/outdoor-sleep.mjs [--budget-ms <n>] [--dry-run] [--keep-log]
 */
import { refusal, restoreEnding } from "../../live-action.mjs";
import {
  announceSlice,
  describeBodyFreedom,
  describeSlicePlan,
  finishSlice,
  observeReadyWorld,
  parseSliceArguments,
  planSlice,
  runSliceWorld,
  USAGE_COMMON,
} from "./harness.mjs";

const NAME = "outdoor-sleep";
const SCENARIO = "sleep_outdoor";
/** The property's own bound: a refusal is not a wait, and two seconds is generous for one game-thread answer. */
const NOT_HOME_BOUND_MS = 2_000;

export const USAGE = `usage: node tools/live-run/slices/outdoor-sleep.mjs [options]

  Submits sleep() once, from a world whose actor does not sleep there, and asserts the Mod refuses it by name
  (not_home) inside ${String(NOT_HOME_BOUND_MS)} ms with the body free afterwards.

${USAGE_COMMON}`;

/**
 * The terminal for this one execution, or null when the bound expired first.
 *
 * Written here rather than reusing `waitForTerminal` because the bound is the ASSERTION, not a timeout: a slice that let
 * a shared helper throw "missing_or_stale" would report an absent answer where the interesting fact is how long it took
 * to arrive. The elapsed milliseconds are returned either way.
 */
async function awaitTerminal(receipts, accepted, boundMs) {
  const startedAt = Date.now();
  while (true) {
    const terminal = [accepted, ...receipts].find(
      (receipt) =>
        receipt?.requestId === accepted.requestId &&
        receipt?.executionId === accepted.executionId &&
        TERMINAL_STATES.has(receipt.state),
    );
    if (terminal !== undefined) return { terminal, elapsedMs: Date.now() - startedAt };
    if (Date.now() - startedAt >= boundMs) return { terminal: null, elapsedMs: Date.now() - startedAt };
    await new Promise((done) => setTimeout(done, 25));
  }
}

/** The whole measurement, over one connected session. Pure over the client, so the judgement is one readable function. */
export async function measureOutdoorSleep({ client, receipts, budgetMs }) {
  const before = await observeReadyWorld(client, { budgetMs });
  // A run in which she is at home measures nothing about `not_home`, and scoring it would be the slice inventing a
  // passing answer for a world it never armed.
  if (before.location === null || before.location === undefined) throw refusal("slice_world_location_unmeasured");
  const requestId = `slice_outdoor_sleep_${Date.now()}`;
  const accepted = await executeFresh(client, {
    requestId,
    idempotencyKey: `${requestId}_idem`,
    action: "sleep",
    args: {},
    snapshot: before,
  });
  const { terminal, elapsedMs } = await awaitTerminal(receipts, accepted, NOT_HOME_BOUND_MS);
  let after = null;
  try {
    after = await observeReadyWorld(client, { budgetMs: Math.min(budgetMs, 5_000) });
  } catch (_error) {
    /* the world is not free; `describeBodyFreedom` reports the state that says so */
  }
  return {
    location: before.location,
    tile: before.tile ?? null,
    admission: { state: accepted.state ?? null, reasonCode: accepted.reasonCode ?? null },
    terminal: terminal === null ? null : { state: terminal.state, reasonCode: terminal.reasonCode },
    elapsedMs,
    body: describeBodyFreedom(after ?? client.state?.snapshot ?? null, receipts),
  };
}

/** The verdict: one property, three ways for the world to fail to answer it. */
export function judgeOutdoorSleep(measured) {
  if (measured.terminal === null)
    return {
      status: "failed",
      detail: `sleep_terminal_absent_within_${String(NOT_HOME_BOUND_MS)}ms:elapsed=${String(measured.elapsedMs)}:in_flight=${String(measured.body.activeExecution?.state ?? "none")}`,
    };
  if (measured.terminal.reasonCode !== "not_home")
    return {
      status: "failed",
      detail: `sleep_refused_by_another_name:${String(measured.terminal.state)}:${String(measured.terminal.reasonCode)}`,
    };
  if (measured.terminal.state !== "rejected")
    return {
      status: "failed",
      detail: `sleep_not_home_in_state:${String(measured.terminal.state)}`,
    };
  if (measured.elapsedMs > NOT_HOME_BOUND_MS)
    return { status: "failed", detail: `sleep_not_home_late:${String(measured.elapsedMs)}ms` };
  if (measured.body.actionable !== true || measured.body.activeExecution != null)
    return {
      status: "failed",
      detail: `body_not_free_after_not_home:actionable=${String(measured.body.actionable)}:in_flight=${String(measured.body.activeExecution?.state ?? "none")}`,
    };
  return { status: "passed", detail: `not_home_in_${String(measured.elapsedMs)}ms` };
}

async function main(argv) {
  let options;
  try {
    options = parseSliceArguments(argv, { budgetMs: 30_000 });
  } catch (error) {
    process.stderr.write(`${String(error?.message ?? error)}\n\n${USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  let plan;
  try {
    plan = await planSlice({ scenarioKey: SCENARIO, options });
  } catch (error) {
    finishSlice({
      name: NAME,
      status: "blocked",
      detail: String(error?.message ?? error),
      facts: { detail: error?.detail },
    });
    return;
  }
  const calls = ["sleep"];
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify(describeSlicePlan({ name: NAME, plan, calls }), null, 2)}\n`);
    return;
  }
  announceSlice({ name: NAME, plan, calls });
  let run;
  try {
    run = await runSliceWorld({
      plan,
      body: ({ client, receipts }) => measureOutdoorSleep({ client, receipts, budgetMs: options.budgetMs }),
    });
  } catch (error) {
    finishSlice({ name: NAME, status: "blocked", detail: String(error?.message ?? error), facts: {} });
    return;
  }
  const ending = restoreEnding(run.restore);
  if (run.failure !== null) {
    finishSlice({
      name: NAME,
      status: "blocked",
      detail: ending ?? String(run.failure?.message ?? run.failure),
      facts: { restore: run.restore },
    });
    return;
  }
  if (ending !== null) {
    finishSlice({
      name: NAME,
      status: "blocked",
      detail: ending,
      facts: { measured: run.result, restore: run.restore },
    });
    return;
  }
  const judged = judgeOutdoorSleep(run.result);
  finishSlice({
    name: NAME,
    status: judged.status,
    detail: judged.detail,
    facts: { measured: run.result, restore: run.restore, elapsedMs: run.elapsedMs },
  });
}

await main(process.argv.slice(2));
