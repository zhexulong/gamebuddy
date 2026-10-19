// Offline suite for the cold-session lifecycle gate.
//
// It launches NO game, no SMAPI and no provider: every stage is the injection seam, so a
// stub returns canned outcomes and every assertion below is about the rollup, the stage
// order and the fail-closed verdict - never about a runner's postcondition (the driver is
// not allowed to have one).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SESSION_SCHEMA,
  SESSION_STAGES,
  classifyStageResult,
  parseSessionArgs,
  runColdSession,
} from "./run-stardew-lifecycle-cold-session.mjs";

/** A hermetic request: a real client-config shape, everything else in a tmp root. */
function sessionRequest({ runDir, extra = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "cold-session-"));
  const gamePath = join(root, "game");
  const modsPath = join(root, "mods");
  mkdirSync(gamePath, { recursive: true });
  mkdirSync(join(modsPath, "GameBuddy.Stardew"), { recursive: true });
  writeFileSync(
    join(modsPath, "GameBuddy.Stardew", "config.json"),
    JSON.stringify({
      SaveId: "save-1",
      WorldId: "world-1",
      PlayerId: "player-1",
      CompanionId: "companion-1",
      PipeName: "gamebuddy-stardew",
      BridgeToken: "0123456789abcdef0123456789abcdef",
    }),
    "utf8",
  );
  return {
    args: [
      "--game-path",
      gamePath,
      "--mods-path",
      modsPath,
      "--action",
      "move_to_tile",
      "--run-dir",
      runDir ?? join(root, "run"),
      ...extra,
    ],
    env: {},
  };
}

/** Every required stage, each recording its own call so the order is assertable. */
function stubStages(overrides = {}, order = []) {
  const stages = {};
  for (const stage of SESSION_STAGES) {
    if (stage.optional === true) continue;
    stages[stage.name] = async () => {
      order.push(stage.name);
      return { ok: true };
    };
  }
  // An override still records: the order assertion is about which stages RAN, and a
  // failing stage ran too.
  for (const [name, run] of Object.entries(overrides))
    stages[name] = async (session) => {
      order.push(name);
      return await run(session);
    };
  return { stages, order };
}

const REQUIRED_STAGES = SESSION_STAGES.filter((stage) => stage.optional !== true).map((stage) => stage.name);

test("the rollup schema and the stage table are the driver's own published contract", () => {
  assert.equal(SESSION_SCHEMA, "gamebuddy-stardew-lifecycle-cold-session/v1");
  assert.deepEqual(
    SESSION_STAGES.map((stage) => stage.name),
    ["admission", "deployment", "launch", "attach", "action", "stop", "survives", "detach", "world", "endgame"],
  );
  assert.deepEqual(
    SESSION_STAGES.map((stage) => stage.failureCode),
    [
      "admission_refused",
      "deployment_undecided",
      "launch_failed",
      "attach_failed",
      "action_refused",
      "stop_not_settled",
      "game_did_not_survive",
      "detach_failed",
      "world_changed",
      "endgame_failed",
    ],
  );
  // Exactly one stage is optional, and it is the product-owned endgame.
  assert.deepEqual(
    SESSION_STAGES.filter((stage) => stage.optional === true).map((stage) => stage.name),
    ["endgame"],
  );
});

test("a stage that produced no evidence is never a pass", () => {
  const stage = SESSION_STAGES[0];
  assert.deepEqual(classifyStageResult(stage, { ok: true }), { state: "passed", reasonCode: "admission_passed" });
  assert.deepEqual(classifyStageResult(stage, { ok: false, reasonCode: "admission_refused:chosen" }), {
    state: "blocked",
    reasonCode: "admission_refused:chosen",
  });
  // A refusal with no code falls back to the stage's registered failure code.
  assert.deepEqual(classifyStageResult(stage, { ok: false }), {
    state: "blocked",
    reasonCode: "admission_refused",
  });
  for (const value of [undefined, null, {}, "ok", 1, [], { ok: "yes" }])
    assert.deepEqual(classifyStageResult(stage, value), {
      state: "blocked",
      reasonCode: "lifecycle_stage_evidence_missing:admission",
    });
});

test("bad arguments are refused by name before any stage runs", () => {
  const { args, env } = sessionRequest();
  const value = (flag) => args[args.indexOf(flag) + 1];
  const without = (flag) => {
    const index = args.indexOf(flag);
    return args.filter((_, position) => position !== index && position !== index + 1);
  };
  assert.throws(() => parseSessionArgs(without("--game-path"), {}), /game_path_required:GAMEBUDDY_STARDEW_GAME_PATH/);
  assert.equal(
    parseSessionArgs(without("--game-path"), { GAMEBUDDY_STARDEW_GAME_PATH: value("--game-path") }).gamePath,
    value("--game-path"),
  );
  assert.throws(() => parseSessionArgs(without("--mods-path"), env), /mods_path_required/);
  assert.throws(() => parseSessionArgs([...args, "--nope", "x"], env), /invalid_session_argument:--nope/);
  assert.throws(() => parseSessionArgs([...args, "--action"], env), /missing_session_argument_value:action/);
  assert.throws(
    () =>
      parseSessionArgs(
        args.map((v) => (v === "move_to_tile" ? "Not An Action" : v)),
        env,
      ),
    /invalid_action/,
  );
  assert.throws(() => parseSessionArgs([...args, "--action-args", "not-json"], env), /invalid_action_args/);
  assert.throws(() => parseSessionArgs([...args, "--action-args", "[1]"], env), /invalid_action_args/);
  assert.deepEqual(parseSessionArgs([...args, "--action-args", '{"x":10,"y":9}'], env).actionArgs, { x: 10, y: 9 });
  assert.deepEqual(parseSessionArgs(args, env).actionArgs, {});
  assert.throws(() => parseSessionArgs([...args, "--timeout-seconds", "5"], env), /invalid_timeout_seconds/);
  assert.throws(() => parseSessionArgs([...args, "--window-mode", "sideways"], env), /invalid_live_run_window_mode/);
  assert.throws(
    () =>
      parseSessionArgs(
        ["--game-path", "relative-game", "--mods-path", "relative-mods", "--run-dir", "relative-run"],
        env,
      ),
    /invalid_game_path/,
  );
  assert.throws(
    () => parseSessionArgs([...args, "--client-config", join(value("--mods-path"), "absent.json")], env),
    /client_config_missing/,
  );
});

test("the client config is validated against the six fields the bridge needs, and never reaches the rollup", async () => {
  const { args, env } = sessionRequest();
  const configPath = join(args[args.indexOf("--mods-path") + 1], "GameBuddy.Stardew", "config.json");
  writeFileSync(configPath, JSON.stringify({ SaveId: "save-1" }), "utf8");
  assert.throws(() => parseSessionArgs(args, env), /client_config_invalid/);
  writeFileSync(configPath, "not json", "utf8");
  assert.throws(() => parseSessionArgs(args, env), /client_config_invalid/);

  const { args: goodArgs } = sessionRequest({ runDir: mkdtempSync(join(tmpdir(), "cold-session-run-")) });
  const { stages } = stubStages();
  const { rollup } = await runColdSession({ argv: goodArgs, env, stages });
  const text = readFileSync(join(rollup.runDir, "rollup.json"), "utf8");
  assert.doesNotMatch(text, /BridgeToken|0123456789abcdef/u, "a session token must never be written to the rollup");
});

test("a fully passing run is green, in the declared stage order", async () => {
  const { args, env } = sessionRequest({ runDir: mkdtempSync(join(tmpdir(), "cold-session-run-")) });
  const { stages, order } = stubStages();
  const { rollup, exitCode } = await runColdSession({ argv: args, env, stages });

  assert.equal(rollup.schema, SESSION_SCHEMA);
  assert.equal(rollup.state, "passed");
  assert.equal(rollup.reasonCode, "cold_session_passed");
  assert.equal(rollup.action, "move_to_tile");
  assert.deepEqual(rollup.failedStage, null);
  assert.equal(exitCode, 0);
  // The order is the contract: an attach cannot precede a launch.
  assert.deepEqual(order, REQUIRED_STAGES);
  assert.deepEqual(rollup.counts, { total: 10, passed: 9, blocked: 0, not_run: 0, not_requested: 1 });
  // The row shape is the contract: exactly three named keys, per stage.
  for (const row of rollup.stages) assert.deepEqual(Object.keys(row).sort(), ["reasonCode", "stage", "state"]);
  assert.deepEqual(
    rollup.stages.map((row) => row.stage),
    SESSION_STAGES.map((stage) => stage.name),
  );
  assert.deepEqual(
    rollup.stages.map((row) => row.state),
    [...REQUIRED_STAGES.map(() => "passed"), "not_requested"],
  );
  assert.equal(rollup.stages.at(-1).reasonCode, "lifecycle_stage_not_requested");
});

test("a failure at each stage is named with its own code, and stops the run", async () => {
  const codes = SESSION_STAGES.filter((stage) => stage.optional !== true).map((stage) => [
    stage.name,
    `${stage.failureCode}:detail`,
  ]);
  for (const [name, reasonCode] of codes) {
    const { args, env } = sessionRequest({ runDir: mkdtempSync(join(tmpdir(), `cold-session-${name}-`)) });
    const { stages, order } = stubStages({ [name]: async () => ({ ok: false, reasonCode }) });
    const { rollup, exitCode } = await runColdSession({ argv: args, env, stages });

    assert.equal(rollup.state, "blocked", `${name} must block the run`);
    assert.deepEqual(rollup.failedStage, { stage: name, reasonCode });
    assert.equal(rollup.reasonCode, `cold_session_blocked:${name}:${reasonCode}`);
    assert.notEqual(exitCode, 0, `${name} must exit non-zero`);
    const index = REQUIRED_STAGES.indexOf(name);
    // The failing stage is blocked with its own code; everything before it passed and
    // everything after it never ran.
    assert.deepEqual(
      rollup.stages.slice(0, index + 1).map((row) => row.state),
      [...Array(index).fill("passed"), "blocked"],
    );
    assert.deepEqual(
      rollup.stages
        .slice(index + 1)
        .map((row) => row.state)
        .slice(0, -1),
      [...Array(REQUIRED_STAGES.length - index - 1).fill("not_run")],
    );
    assert.equal(rollup.stages[index].reasonCode, reasonCode);
    // The stage that failed was reached, and no later stage ran.
    assert.deepEqual(order, REQUIRED_STAGES.slice(0, index + 1));
  }
});

test("a missing stage fails closed rather than being skipped", async () => {
  const { args, env } = sessionRequest({ runDir: mkdtempSync(join(tmpdir(), "cold-session-missing-")) });
  // Every stage is wired EXCEPT `stop`: the driver must not report success.
  const { stages, order } = stubStages();
  delete stages.stop;
  const { rollup, exitCode } = await runColdSession({ argv: args, env, stages });

  assert.equal(rollup.state, "blocked");
  assert.deepEqual(rollup.failedStage, { stage: "stop", reasonCode: "lifecycle_stage_missing:stop" });
  assert.equal(rollup.stages.find((row) => row.stage === "stop").state, "blocked");
  assert.equal(rollup.stages.find((row) => row.stage === "stop").reasonCode, "lifecycle_stage_missing:stop");
  assert.equal(rollup.stages.at(-2).state, "not_run");
  assert.deepEqual(order, ["admission", "deployment", "launch", "attach", "action"]);
  assert.notEqual(exitCode, 0);
});

test("a stage that throws or loses its evidence is blocked, never a pass", async () => {
  const { args, env } = sessionRequest({ runDir: mkdtempSync(join(tmpdir(), "cold-session-threw-")) });
  const threw = await runColdSession({
    argv: args,
    env,
    stages: stubStages({
      world: async () => {
        throw new Error("bridge_vanished");
      },
    }).stages,
  });
  assert.equal(threw.rollup.state, "blocked");
  assert.equal(threw.rollup.failedStage.stage, "world");
  assert.match(threw.rollup.failedStage.reasonCode, /^lifecycle_stage_threw:world:bridge_vanished$/u);
  assert.notEqual(threw.exitCode, 0);

  const silent = await runColdSession({
    argv: args,
    env,
    stages: stubStages({ stop: async () => undefined }).stages,
  });
  assert.equal(silent.rollup.state, "blocked");
  assert.deepEqual(silent.rollup.failedStage, {
    stage: "stop",
    reasonCode: "lifecycle_stage_evidence_missing:stop",
  });
  assert.notEqual(silent.exitCode, 0);
});

test("the endgame stage is only required when it was asked for", async () => {
  // Not requested: reported as such, and a run without an endgame implementation is green.
  const { args, env } = sessionRequest({ runDir: mkdtempSync(join(tmpdir(), "cold-session-endgame-off-")) });
  const off = await runColdSession({ argv: args, env, stages: stubStages().stages });
  assert.equal(off.rollup.state, "passed");
  assert.equal(off.rollup.stages.at(-1).state, "not_requested");

  // Requested but unwired: fail closed, named.
  const requested = await runColdSession({
    argv: [...args, "--endgame"],
    env,
    stages: stubStages().stages,
  });
  assert.equal(requested.rollup.state, "blocked");
  assert.deepEqual(requested.rollup.failedStage, {
    stage: "endgame",
    reasonCode: "lifecycle_stage_missing:endgame",
  });
  assert.notEqual(requested.exitCode, 0);

  // Requested and wired: the injection seam is what the operator would use.
  const wired = await runColdSession({
    argv: [...args, "--endgame"],
    env,
    stages: stubStages({ endgame: async () => ({ ok: true }) }).stages,
  });
  assert.equal(wired.rollup.state, "passed");
  assert.equal(wired.rollup.stages.at(-1).state, "passed");
  assert.equal(wired.exitCode, 0);
});
