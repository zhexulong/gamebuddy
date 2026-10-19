// Offline suite for the published-action gate batch.
//
// It launches NO game, no SMAPI and no provider: the per-action gate is the one
// injection seam, so a stub launcher returns canned results - including one
// blocked gate and one gate that produced nothing at all - and every assertion
// below is about the rollup and the fail-closed verdict, never about a runner's
// postcondition (the batch is not allowed to have one).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { STARDEW_PUBLISHED_ACTION_GATES } from "./stardew-action-gate-descriptors.mjs";
import {
  BATCH_SCHEMA,
  LIFECYCLE_RESULT_SCHEMA,
  RUNNER_CAN_OPEN_GATES,
  buildLauncherArgs,
  classifyGate,
  parseBatchArgs,
  parseLifecycleResult,
  parseRunnerResult,
  readRunnerResult,
  runBatch,
  selectGates,
} from "./run-stardew-action-gates-batch.mjs";

const PASSING_GATE = "move_to_tile";
const BLOCKED_GATE = "equip_tool";
const MISSING_GATE = "harvest_crop";
const PRECHECK_PASS = Object.freeze([
  Object.freeze({ name: "runner_contract_audit", exitCode: 0 }),
  Object.freeze({ name: "runner_fixture_contract", exitCode: 0 }),
]);

/** A hermetic batch request: a real game path shape, everything else in a tmp root. */
function batchRequest({ runDir, only }) {
  const root = mkdtempSync(join(tmpdir(), "action-gate-batch-"));
  const gamePath = join(root, "game");
  mkdirSync(gamePath, { recursive: true });
  writeFileSync(join(gamePath, "StardewModdingAPI.exe"), "", "utf8");
  const args = [
    "--game-path",
    gamePath,
    "--mods-path",
    join(root, "mods"),
    "--save-name",
    "GameBuddyFixtureBatch_445094166",
    "--fixture-root",
    join(root, "fixtures"),
    "--release-dir",
    join(root, "release"),
    "--run-dir",
    runDir ?? join(root, "run"),
    ...only.flatMap((actionId) => ["--only", actionId]),
  ];
  return { args, env: { LOCALAPPDATA: root } };
}

/** The lifecycle record the real launcher publishes, written by the stub launcher. */
function writeLifecycle(path, record) {
  writeFileSync(path, JSON.stringify(record), "utf8");
}

test("the rollup schema is the batch's own published contract", () => {
  assert.equal(BATCH_SCHEMA, "gamebuddy-stardew-action-gate-batch/v1");
});

test("the runner verdict is the last record on stdout that carries one", () => {
  const stdout = [
    "WARNING: another Stardew process is running",
    '{"state":"passed","topology":"native_local_player_fixture"}',
    '{"timestamp":"2026-10-19T00:00:00.000Z","windowMode":"hidden","tag":"hidden","gameWindow":null}',
  ].join("\n");
  assert.deepEqual(parseRunnerResult(stdout), { verdict: "passed" });
  // The equip_tool package child reports `verdict` instead of `state`.
  assert.deepEqual(parseRunnerResult('{"schema":"gamebuddy-action-scenario-result/v1","verdict":"failed"}'), {
    verdict: "failed",
  });
  assert.equal(parseRunnerResult("no json here"), null);
  assert.equal(parseRunnerResult(""), null);
  assert.equal(parseRunnerResult('{"state":42}'), null);
});

test("the launcher's own fixture records are never read as the runner's verdict", () => {
  // The exact record order a live `move_to_tile` run produced: the runner's pass,
  // then the launcher's window evidence, fixture restore and save cleanup. Reading
  // the last record as the verdict made a real pass report as not-passed.
  const stdout = [
    '{"state":"prepared","bindingPath":"C:\\\\fixtures\\\\x.native-local-binding.json","contract":"..."}',
    '{"state":"passed","topology":"native_local_player_fixture","success":{"terminal":{"state":"succeeded","reasonCode":"target_reached"}}}',
    '{"timestamp":"2026-10-19T13:56:42.0941663Z","windowMode":"hidden","tag":"hidden","gameWindow":{"processId":22420}}',
    '{"state":"restored","backup":"C:\\\\fixtures\\\\native-local-move-to-tile-fixture-backup","backupRemoved":true}',
    '{"state":"cleaned","saveName":"GameBuddyFixtureStable2_451844707","workingSavePath":"C:\\\\Saves\\\\GameBuddyFixtureStable2_451844707"}',
  ].join("\n");
  assert.deepEqual(parseRunnerResult(stdout), { verdict: "passed" });
  // A fixture-transaction record alone is never a verdict, so it can never manufacture a pass.
  for (const record of [
    '{"state":"restored","backupRemoved":true}',
    '{"state":"cleaned"}',
    '{"state":"verified"}',
    '{"state":"bootstrap_prepared"}',
    '{"state":"template_initialized"}',
  ])
    assert.equal(parseRunnerResult(record), null, `${record} must not be a runner verdict`);
});

test("only the launcher's own lifecycle schema counts as a lifecycle result", () => {
  // The launcher publishes this record through the action-development package's
  // write-lifecycle-result.mjs; the literal pins the contract this driver reads.
  assert.equal(LIFECYCLE_RESULT_SCHEMA, "gamebuddy-stardew-closure-backend-result/v1");
  assert.deepEqual(parseLifecycleResult(JSON.stringify({ schema: LIFECYCLE_RESULT_SCHEMA, state: "completed" })), {
    state: "completed",
  });
  assert.deepEqual(
    parseLifecycleResult(
      JSON.stringify({ schema: LIFECYCLE_RESULT_SCHEMA, state: "failed", phase: "pipe_readiness", code: "failed" }),
    ),
    { state: "failed", phase: "pipe_readiness" },
  );
  assert.equal(parseLifecycleResult(""), null);
  assert.equal(parseLifecycleResult("not json"), null);
  assert.equal(parseLifecycleResult(JSON.stringify({ state: "completed" })), null);
  assert.equal(parseLifecycleResult(JSON.stringify({ schema: LIFECYCLE_RESULT_SCHEMA, state: "unknown" })), null);
  // A failure with no phase names nothing, so it is not readable evidence.
  assert.equal(parseLifecycleResult(JSON.stringify({ schema: LIFECYCLE_RESULT_SCHEMA, state: "failed" })), null);
});

test("the runner verdict comes from the per-action result file when the runner wrote one", () => {
  const runDir = mkdtempSync(join(tmpdir(), "action-gate-result-"));
  const resultFile = join(runDir, "equip_tool.result.json");
  writeFileSync(
    resultFile,
    JSON.stringify({ schema: "gamebuddy-action-scenario-result/v1", verdict: "passed" }),
    "utf8",
  );
  assert.deepEqual(readRunnerResult({ resultFile, stdout: '{"state":"blocked"}' }), { verdict: "passed" });
  assert.deepEqual(readRunnerResult({ resultFile: join(runDir, "absent.json"), stdout: '{"state":"blocked"}' }), {
    verdict: "blocked",
  });
  assert.equal(readRunnerResult({ resultFile: join(runDir, "absent.json"), stdout: "" }), null);
});

test("a gate is blocked on a timeout, a failed lifecycle phase, a non-passing verdict or a bad exit", () => {
  const completed = { state: "completed" };
  assert.deepEqual(classifyGate({ timedOut: true, exitCode: null, verdict: "passed", lifecycle: completed }), {
    state: "blocked",
    reasonCode: "gate_timeout",
    lifecycleState: "completed",
  });
  assert.deepEqual(
    classifyGate({
      timedOut: false,
      exitCode: 1,
      verdict: null,
      lifecycle: { state: "failed", phase: "pipe_readiness" },
    }),
    { state: "blocked", reasonCode: "gate_lifecycle_failed:pipe_readiness", lifecycleState: "failed" },
  );
  assert.deepEqual(classifyGate({ timedOut: false, exitCode: 2, verdict: "blocked", lifecycle: completed }), {
    state: "blocked",
    reasonCode: "gate_result_not_passed",
    lifecycleState: "completed",
  });
  assert.deepEqual(classifyGate({ timedOut: false, exitCode: 3, verdict: "passed", lifecycle: completed }), {
    state: "blocked",
    reasonCode: "gate_launcher_failed:3",
    lifecycleState: "completed",
  });
});

test("a gate missing either half of its evidence is missing, never a pass", () => {
  assert.deepEqual(classifyGate({ timedOut: false, exitCode: 0, verdict: null, lifecycle: { state: "completed" } }), {
    state: "missing",
    reasonCode: "gate_result_missing",
    lifecycleState: "completed",
  });
  assert.deepEqual(classifyGate({ timedOut: false, exitCode: 0, verdict: "passed", lifecycle: null }), {
    state: "missing",
    reasonCode: "gate_lifecycle_result_missing",
    lifecycleState: "missing",
  });
  assert.deepEqual(
    classifyGate({ timedOut: false, exitCode: 0, verdict: "passed", lifecycle: { state: "completed" } }),
    {
      state: "passed",
      reasonCode: "gate_passed",
      lifecycleState: "completed",
    },
  );
});

test("the launcher arguments are the entry point's own required shape", () => {
  const { args, env } = batchRequest({ only: [PASSING_GATE] });
  const request = parseBatchArgs(args, env);
  const resultFile = join(request.runDir, "move_to_tile.result.json");
  const lifecycleResultFile = join(request.runDir, "move_to_tile.lifecycle.json");
  const argv = buildLauncherArgs({
    request,
    actionId: PASSING_GATE,
    resultFile,
    lifecycleResultFile,
    scenarioIdentity: null,
  });
  assert.deepEqual(
    [...new Set(argv.filter((value) => value.startsWith("-")))].sort(),
    [
      "-Action",
      "-ExecutionPolicy",
      "-File",
      "-FixtureRoot",
      "-GamePath",
      "-LifecycleResultFile",
      "-ModsPath",
      "-NoProfile",
      "-NonInteractive",
      "-ReleaseDir",
      "-ResultFile",
      "-SaveName",
      "-TemplateName",
      "-TimeoutSeconds",
      "-WindowMode",
    ].sort(),
  );
  const value = (flag) => argv[argv.indexOf(flag) + 1];
  assert.equal(value("-Action"), PASSING_GATE);
  assert.equal(value("-GamePath"), request.gamePath);
  assert.equal(value("-ModsPath"), request.modsPath);
  assert.equal(value("-FixtureRoot"), request.fixtureRoot);
  assert.equal(value("-SaveName"), request.saveName);
  assert.equal(value("-TemplateName"), request.saveName);
  assert.equal(value("-ReleaseDir"), request.releaseDir);
  assert.equal(value("-ResultFile"), resultFile);
  assert.equal(value("-LifecycleResultFile"), lifecycleResultFile);
  assert.equal(value("-WindowMode"), "hidden");
  assert.equal(value("-TimeoutSeconds"), "120");
  assert.equal(argv.includes("-ScenarioIdentity"), false);
  // The equip_tool branch refuses without an identity; no other branch reads one.
  const equip = buildLauncherArgs({
    request,
    actionId: BLOCKED_GATE,
    resultFile,
    lifecycleResultFile,
    scenarioIdentity: '{"actionId":"equip_tool"}',
  });
  assert.equal(equip[equip.indexOf("-ScenarioIdentity") + 1], '{"actionId":"equip_tool"}');
});

test("a pass runs the published table, and --only selects exactly the named gates", () => {
  assert.equal(selectGates([]), STARDEW_PUBLISHED_ACTION_GATES);
  assert.deepEqual(
    selectGates([BLOCKED_GATE, PASSING_GATE]).map((gate) => gate.actionId),
    [BLOCKED_GATE, PASSING_GATE],
  );
  assert.equal(selectGates([PASSING_GATE])[0].terminalReasonCode, "target_reached");
  assert.throws(() => selectGates(["not_an_action"]), /unknown_gate_action:not_an_action/);
  assert.throws(() => selectGates([PASSING_GATE, PASSING_GATE]), /duplicate_gate_action:move_to_tile/);
});

test("bad arguments are refused by name before anything is launched", () => {
  const { args, env } = batchRequest({ only: [] });
  const withoutGamePath = args.filter((value, index) => args[index - 1] !== "--game-path" && value !== "--game-path");
  assert.throws(() => parseBatchArgs(withoutGamePath, {}), /game_path_required:GAMEBUDDY_STARDEW_GAME_PATH/);
  const gamePath = args[args.indexOf("--game-path") + 1];
  assert.equal(parseBatchArgs(withoutGamePath, { GAMEBUDDY_STARDEW_GAME_PATH: gamePath }).gamePath, gamePath);
  assert.throws(() => parseBatchArgs([...args, "--nope", "x"], env), /invalid_batch_argument:--nope/);
  assert.throws(
    () =>
      parseBatchArgs(
        args.map((value) => (value === "GameBuddyFixtureBatch_445094166" ? "not-a-fixture-slot" : value)),
        env,
      ),
    /invalid_save_name/,
  );
  assert.throws(() => parseBatchArgs([...args, "--timeout-seconds", "600"], env), /invalid_timeout_seconds/);
  assert.throws(() => parseBatchArgs([...args, "--window-mode", "sideways"], env), /invalid_live_run_window_mode/);
  assert.throws(
    () =>
      parseBatchArgs(
        [
          "--game-path",
          "relative-game",
          "--mods-path",
          "relative-mods",
          "--save-name",
          "GameBuddyFixtureBatch_445094166",
          "--run-dir",
          "relative-run",
        ],
        env,
      ),
    /invalid_game_path/,
  );
  assert.throws(() => parseBatchArgs([...args, "--only"], env), /missing_batch_argument_value:only/);
});

test("the precheck reuses the two existing runner-can-open gates rather than re-implementing them", () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const commands = Object.fromEntries(
    RUNNER_CAN_OPEN_GATES.map((gate) => [gate.name, `node ${gate.nodeArguments.join(" ")}`]),
  );
  assert.equal(commands.runner_contract_audit, packageJson.scripts["audit:stardew-native-local-runner-contract"]);
  assert.equal(
    commands.runner_fixture_contract,
    packageJson.scripts["test:stardew-native-local-runner-fixture-contract"],
  );
  for (const gate of RUNNER_CAN_OPEN_GATES) {
    const script = gate.nodeArguments.at(-1).replace(/^tools\//u, "");
    assert.ok(existsSync(new URL(`./${script}`, import.meta.url)), `${gate.name} must name a real gate`);
  }
});

test("one blocked and one missing gate make the rollup red and are named", async () => {
  const { args, env } = batchRequest({
    only: [PASSING_GATE, BLOCKED_GATE, MISSING_GATE],
    runDir: mkdtempSync(join(tmpdir(), "action-gate-batch-run-")),
  });
  const launched = [];
  const identities = [];
  const { rollup, exitCode } = await runBatch({
    argv: args,
    env,
    runPrecheck: () => PRECHECK_PASS,
    runGate: async ({ actionId, lifecycleResultFile, scenarioIdentity }) => {
      launched.push(actionId);
      identities.push(scenarioIdentity);
      if (actionId === PASSING_GATE) {
        writeLifecycle(lifecycleResultFile, { schema: LIFECYCLE_RESULT_SCHEMA, state: "completed" });
        return {
          exitCode: 0,
          timedOut: false,
          stdout: '{"state":"passed","topology":"native_local_player_fixture"}\n',
          stderr: "",
        };
      }
      if (actionId === BLOCKED_GATE) {
        writeLifecycle(lifecycleResultFile, { schema: LIFECYCLE_RESULT_SCHEMA, state: "completed" });
        return { exitCode: 2, timedOut: false, stdout: '{"verdict":"failed"}\n', stderr: "" };
      }
      // MISSING_GATE: the launcher died before publishing anything at all.
      return { exitCode: 1, timedOut: false, stdout: "", stderr: "harness died\n" };
    },
  });

  // Every requested action was launched, in the order asked for, and only the
  // equip_tool branch (which refuses without one) is handed a scenario identity.
  assert.deepEqual(launched, [PASSING_GATE, BLOCKED_GATE, MISSING_GATE]);
  assert.equal(identities[0], null);
  assert.equal(JSON.parse(identities[1]).actionId, BLOCKED_GATE);
  assert.equal(identities[2], null);
  assert.equal(rollup.schema, BATCH_SCHEMA);
  assert.equal(rollup.state, "blocked");
  assert.equal(rollup.reasonCode, `gate_not_passed:${BLOCKED_GATE}`);
  assert.deepEqual(rollup.counts, { total: 3, passed: 1, blocked: 1, missing: 1 });
  // The rollup's shape is the contract: exactly the five named keys, per action.
  for (const row of rollup.actions)
    assert.deepEqual(Object.keys(row).sort(), [
      "actionId",
      "lifecycleState",
      "reasonCode",
      "state",
      "terminalReasonCode",
    ]);
  assert.deepEqual(
    rollup.actions.map((row) => row.actionId),
    [PASSING_GATE, BLOCKED_GATE, MISSING_GATE],
  );
  assert.deepEqual(
    rollup.actions.map((row) => row.state),
    ["passed", "blocked", "missing"],
  );
  assert.deepEqual(
    rollup.actions.map((row) => row.reasonCode),
    ["gate_passed", "gate_result_not_passed", "gate_result_missing"],
  );
  assert.deepEqual(
    rollup.actions.map((row) => row.lifecycleState),
    ["completed", "completed", "missing"],
  );
  // `terminalReasonCode` is the gate table's registered terminal, not a guess.
  assert.deepEqual(
    rollup.actions.map((row) => row.terminalReasonCode),
    ["target_reached", "tool_equipped", "crop_harvested"],
  );
  // The failing actions are named, and the exit code is non-zero for a non-pass.
  assert.deepEqual(rollup.failedActions, [
    { actionId: BLOCKED_GATE, state: "blocked", reasonCode: "gate_result_not_passed" },
    { actionId: MISSING_GATE, state: "missing", reasonCode: "gate_result_missing" },
  ]);
  assert.equal(exitCode, 2);
  // The evidence each gate produced survives in the run directory.
  assert.match(readFileSync(join(rollup.runDir, `${PASSING_GATE}.launcher.log`), "utf8"), /"state":"passed"/u);
  assert.match(readFileSync(join(rollup.runDir, `${MISSING_GATE}.launcher.log`), "utf8"), /harness died/u);
});

test("a pass whose gates all pass is green, and one failing phase is named", async () => {
  const { args, env } = batchRequest({
    only: [PASSING_GATE],
    runDir: mkdtempSync(join(tmpdir(), "action-gate-batch-green-")),
  });
  const passing = async ({ lifecycleResultFile }) => {
    writeLifecycle(lifecycleResultFile, { schema: LIFECYCLE_RESULT_SCHEMA, state: "completed" });
    return { exitCode: 0, timedOut: false, stdout: '{"state":"passed"}\n', stderr: "" };
  };
  const green = await runBatch({ argv: args, env, runPrecheck: () => PRECHECK_PASS, runGate: passing });
  assert.equal(green.rollup.state, "passed");
  assert.equal(green.rollup.reasonCode, "all_gates_passed");
  assert.deepEqual(green.rollup.failedActions, []);
  assert.equal(green.exitCode, 0);

  const phases = await runBatch({
    argv: batchRequest({ only: [PASSING_GATE], runDir: mkdtempSync(join(tmpdir(), "action-gate-batch-phase-")) }).args,
    env,
    runPrecheck: () => PRECHECK_PASS,
    runGate: async ({ lifecycleResultFile }) => {
      writeLifecycle(lifecycleResultFile, {
        schema: LIFECYCLE_RESULT_SCHEMA,
        state: "failed",
        phase: "pipe_readiness",
        code: "failed",
      });
      return { exitCode: 1, timedOut: false, stdout: "", stderr: "bridge_never_ready\n" };
    },
  });
  assert.equal(phases.rollup.state, "blocked");
  assert.deepEqual(phases.rollup.failedActions, [
    { actionId: PASSING_GATE, state: "blocked", reasonCode: "gate_lifecycle_failed:pipe_readiness" },
  ]);
  assert.equal(phases.exitCode, 2);

  const timedOut = await runBatch({
    argv: batchRequest({ only: [PASSING_GATE], runDir: mkdtempSync(join(tmpdir(), "action-gate-batch-timeout-")) })
      .args,
    env,
    runPrecheck: () => PRECHECK_PASS,
    runGate: async () => ({ exitCode: null, timedOut: true, stdout: '{"state":"passed"}\n', stderr: "" }),
  });
  // A harness timeout is never a pass, even when a verdict was printed.
  assert.deepEqual(timedOut.rollup.failedActions, [
    { actionId: PASSING_GATE, state: "blocked", reasonCode: "gate_timeout" },
  ]);
  assert.equal(timedOut.exitCode, 2);
});

test("a failing runner-can-open precheck refuses the whole batch before any gate launches", async () => {
  const { args, env } = batchRequest({
    only: [PASSING_GATE],
    runDir: mkdtempSync(join(tmpdir(), "action-gate-batch-precheck-")),
  });
  let launches = 0;
  const { rollup, exitCode } = await runBatch({
    argv: args,
    env,
    runPrecheck: () => [
      { name: "runner_contract_audit", exitCode: 0 },
      { name: "runner_fixture_contract", exitCode: 1 },
    ],
    runGate: async () => {
      launches += 1;
      return { exitCode: 0, timedOut: false, stdout: '{"state":"passed"}\n', stderr: "" };
    },
  });
  assert.equal(launches, 0);
  assert.equal(rollup.state, "blocked");
  assert.equal(rollup.reasonCode, "gate_precheck_failed:runner_fixture_contract");
  assert.deepEqual(rollup.actions, []);
  assert.equal(exitCode, 2);
});
