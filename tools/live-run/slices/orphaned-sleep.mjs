#!/usr/bin/env node
import { refusal, restoreEnding } from "../../live-action.mjs";
/**
 * SLICE ② - A REFUSED TRANSITION DOES NOT LEAVE HER SCRIPT STANDING.
 *
 * THE PROPERTY. The script `enter_exit({x:64,y:14}); sleep()`, written where `(64,14)` is not a door on this map, either
 * refuses WHOLE or carries BOTH nodes. It never becomes a `sleep` submitted alone.
 *
 * WHY IT IS A SLICE. Measured 2026-11-22 (`round93`, `plan_463`): she stood in Town and wrote exactly that pair. The
 * transition was refused by name - `plan_script_door_not_on_this_map:64:14:map=Town`, the door being the FARMHOUSE's,
 * spelled in the town's frame - and the `sleep` was KEPT, because one refused call stops only itself. The plan that ran
 * was therefore hers with the walk home deleted: `sleep()` alone, from Town, which is slice ①'s 308 seconds. The
 * compiler had submitted a plan nobody wrote.
 *
 * THE WORLD. Fixture key `sleep_outdoor` arms the play-session world (`native_play_session_v1`): the actor stands on the
 * Farm, where `(64,14)` is not one of the map's exits, and both `enter_exit` and `sleep` are published - so the script is
 * refused by the MAP and by nothing else. A world that does not publish one of the two would refuse the script for a
 * capability reason and measure the fixture instead of the seam.
 *
 * THE SUBMISSION IS THE PRODUCT'S OWN. The compile, the plan-form check, the node admission challenge and the submit are
 * `tools/live-program.mjs`'s (`runOneProgram`), imported rather than reproduced: this slice must not be a second
 * implementation of the path it is judging.
 *
 * WHAT IT DOES NOT COVER. It measures the FIRST call after a refused transition and says nothing about a script whose
 * refused call comes last (there is nothing to orphan), about `travel` - the other transition source - or about a refusal
 * the Mod answers at execution time rather than one this compiler answers. It also does not judge whether refusing the
 * whole script is better than submitting the prefix that was good: this slice asserts only that nothing runs that she
 * did not write.
 *
 * USAGE
 *   node tools/live-run/slices/orphaned-sleep.mjs [--budget-ms <n>] [--dry-run] [--keep-log]
 */
import { emptyContext, loadProgramHostModules, runOneProgram } from "../../live-program.mjs";
import {
  announceSlice,
  describeSlicePlan,
  finishSlice,
  observeReadyWorld,
  parseSliceArguments,
  planSlice,
  runSliceWorld,
  USAGE_COMMON,
} from "./harness.mjs";

const NAME = "orphaned-sleep";
const SCENARIO = "sleep_outdoor";
const SETTLE_MS = 8_000;

/**
 * The transition to write, and the tile it names.
 *
 * `round93`'s own pair spelled the FARMHOUSE's door, `(64,14)`, in Town's frame. This slice signs that same refusal - a
 * transition to a tile that is not a way out of the map it stands on - but it does not assume any tile is off the map:
 * the tile it names is HER OWN, checked against the exit table the snapshot publishes, so the call is refused for the
 * map and for nothing else. `--door x,y` reproduces `round93`'s exact argument on a world where that tile is bare.
 */
export function orphanedScript({ tile }) {
  return `builder.enter_exit({ x: ${String(tile.x)}, y: ${String(tile.y)} });\nbuilder.sleep();`;
}

/** The tile this slice transitions from: the actor's own, unless the caller reproduces `round93`'s. */
export function transitionTile(snapshot, override) {
  const tile = override ?? { x: snapshot?.tile?.x, y: snapshot?.tile?.y };
  if (!(Number.isInteger(tile.x) && Number.isInteger(tile.y)))
    throw refusal(`slice_transition_tile_unmeasured:${JSON.stringify(tile)}`);
  const exits = Array.isArray(snapshot?.warps) ? snapshot.warps : [];
  if (exits.some((warp) => warp?.sourceX === tile.x && warp?.sourceY === tile.y))
    throw refusal(`slice_door_tile_is_an_exit:${String(tile.x)},${String(tile.y)}`);
  return tile;
}

export const USAGE = `usage: node tools/live-run/slices/orphaned-sleep.mjs [options]

  Compiles and submits enter_exit(<her own tile>); sleep() against the live world and asserts the plan is refused whole
  or keeps both nodes - never a lone sleep.

  --door <x,y>               the transition tile to write (default: her own tile). A tile that IS a way out of this map
                             is refused: the script would then be refused for a reason other than the one under test.

${USAGE_COMMON}`;

/**
 * The one measurement: compile-and-submit through the product's own path, then read what became of each node.
 *
 * A refusal thrown by `runOneProgram` is a RESULT here, not a failure: `live_program_script_not_compiled:*` is exactly
 * the whole-script refusal this slice exists to see. Every other throw is re-raised, because a slice that swallowed an
 * unrelated refusal would report the seam as fixed.
 */
export async function measureOrphanedSleep({ client, receipts, modules, doorOverride = null }) {
  const snapshot = await observeReadyWorld(client, { budgetMs: 30_000 });
  const tile = transitionTile(snapshot, doorOverride);
  const plan = {
    scenarioKey: SCENARIO,
    scenario: "native_move_ladder_v1",
    actions: ["sleep", "enter_exit"],
    script: orphanedScript({ tile }),
    scriptPath: null,
    settleMs: SETTLE_MS,
  };
  const context = emptyContext();
  let thrown = null;
  try {
    await runOneProgram({ plan, session: { client, receipts }, modules, context });
  } catch (error) {
    thrown = error;
  }
  const nodes = context.nodes ?? context.compiled?.program?.nodes ?? null;
  return {
    transition: { x: tile.x, y: tile.y, script: plan.script },
    location: snapshot.location,
    compiled: context.compiled === null ? null : describeCompiled(context.compiled),
    nodes: nodes === null ? null : nodes.map((node) => ({ nodeId: node.nodeId, actionId: node.actionId })),
    submitted: context.submitted === null ? null : { code: context.submitted.code ?? null },
    admission: context.admission,
    settled: context.settled === null ? null : { reachedTerminal: context.settled.reachedTerminal },
    refusal: thrown === null ? null : String(thrown?.message ?? thrown).slice(0, 400),
    refusalDetail: thrown === null || thrown?.detail === undefined ? null : boundDetail(thrown.detail),
  };
}

function describeCompiled(compiled) {
  // `status` is the compiler's answer and it has no `ok` beside it: a boolean that is false for `refused` AND for
  // `partial` is what let a refusal stand for a plan that runs.
  const refused = compiled.status === "refused";
  return {
    status: compiled.status,
    reasonCode: compiled.reasonCode ?? null,
    dropped: compiled.dropped ?? [],
    droppedCount: compiled.droppedCount ?? 0,
    rejected: compiled.rejected ?? [],
    nodes: refused ? null : (compiled.program?.nodes ?? []).map((node) => node.actionId),
  };
}

function boundDetail(detail) {
  return JSON.parse(JSON.stringify(detail).slice(0, 2_000));
}

/** `--door x,y`, parsed: the one argument shape a reader writes for a tile. */
export function parseDoorOverride(value) {
  if (value === undefined) return null;
  const match = /^(\d{1,3}),(\d{1,3})$/u.exec(value.trim());
  if (match === null) throw refusal(`invalid_door_tile:${value}`);
  return { x: Number(match[1]), y: Number(match[2]) };
}

/**
 * The verdict, from what the compiler handed the wire.
 *
 * The failure is stated as the thing that ran, not as an absent check: `lone_sleep_submitted` names the nodes, because a
 * reader has to see that the script she wrote is not the script that ran.
 */
export function judgeOrphanedSleep(measured) {
  if (measured.refusal !== null && /^live_program_script_not_compiled:/u.test(measured.refusal))
    return {
      status: "passed",
      detail: `script_refused_whole:${measured.refusal.replace(/^live_program_script_not_compiled:/u, "")}`,
    };
  if (measured.refusal !== null) return { status: "blocked", detail: `not_measured:${measured.refusal}` };
  const nodes = measured.nodes ?? [];
  const actions = nodes.map((node) => node.actionId);
  const sleepAt = actions.indexOf("sleep");
  if (sleepAt < 0)
    return { status: "failed", detail: `sleep_node_missing_from_program:nodes=${actions.join("+") || "none"}` };
  if (!actions.slice(0, sleepAt).includes("enter_exit"))
    return {
      status: "failed",
      detail: `lone_sleep_submitted:nodes=${actions.join("+")}:dropped=${String(measured.compiled?.droppedCount ?? 0)}`,
    };
  return { status: "passed", detail: `both_nodes_kept:nodes=${actions.join("+")}` };
}

async function main(argv) {
  let options;
  try {
    options = parseSliceArguments(argv, { budgetMs: 60_000, subjectFlags: ["--door"] });
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
    finishSlice({ name: NAME, status: "blocked", detail: String(error?.message ?? error), facts: {} });
    return;
  }
  const calls = ["enter_exit", "sleep"];
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify(describeSlicePlan({ name: NAME, plan, calls }), null, 2)}\n`);
    return;
  }
  announceSlice({ name: NAME, plan, calls });
  const modules = await loadProgramHostModules();
  let run;
  try {
    run = await runSliceWorld({
      plan,
      body: ({ client, receipts }) =>
        measureOrphanedSleep({ client, receipts, modules, doorOverride: parseDoorOverride(options.subject.door) }),
    });
  } catch (error) {
    finishSlice({ name: NAME, status: "blocked", detail: String(error?.message ?? error), facts: {} });
    return;
  }
  const ending = restoreEnding(run.restore);
  if (ending !== null) {
    finishSlice({
      name: NAME,
      status: "blocked",
      detail: ending,
      facts: { measured: run.result, restore: run.restore },
    });
    return;
  }
  if (run.failure !== null) {
    finishSlice({
      name: NAME,
      status: "blocked",
      detail: String(run.failure?.message ?? run.failure),
      facts: { restore: run.restore },
    });
    return;
  }
  const judged = judgeOrphanedSleep(run.result);
  finishSlice({
    name: NAME,
    status: judged.status,
    detail: judged.detail,
    facts: { measured: run.result, restore: run.restore, elapsedMs: run.elapsedMs },
  });
}

await main(process.argv.slice(2));
