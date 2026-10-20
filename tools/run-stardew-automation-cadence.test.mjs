// Offline suite for the automation cadence pass.
//
// It launches NO game, no SMAPI and no provider: the block child and the entry-existence check
// are the two injection seams, so every assertion below is about the rollup, the step plan and
// the fail-closed verdict - never about a block's verdict (the pass is not allowed to have one).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseBatchArgs } from "./run-stardew-action-gates-batch.mjs";
import {
  ACTION_GATE_BATCH_SCHEMA,
  actionsNotJudgedByCadence,
  BLOCK_ENTRIES,
  BLOCKS_NOT_IN_CADENCE,
  buildBlockInvocation,
  CADENCE_BLOCKS,
  CADENCE_SCHEMA,
  classifyBlock,
  isMachineCannotHostReason,
  LADDER_SCENARIOS,
  lastJsonRecord,
  MACHINE_CANNOT_HOST_REASONS,
  missingBlockEntries,
  parseCadenceArgs,
  planCadence,
  publishedResultPath,
  readBlockVerdict,
  resolveActionGateScope,
  runCadence,
} from "./run-stardew-automation-cadence.mjs";
import { MULTIPLAYER_GATE_ACTIONS, parseGateArgs } from "./run-stardew-multiplayer-gate.mjs";
import { STARDEW_PUBLISHED_ACTION_GATES } from "./stardew-action-gate-descriptors.mjs";

const SAVE_NAME = "GameBuddyFixtureCadence_445094166";
const FARMHAND_ID = "123456789";
const ROW_KEYS = ["block", "blockReasonCode", "reasonCode", "state", "target"];

/** A hermetic cadence request: the B2 block's parser wants a SMAPI launcher, everything else is a tmp root. */
function cadenceRequest({ runDir, cadence = "nightly", blocks = [], only = [], scenario = null, extra = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "automation-cadence-"));
  const gamePath = join(root, "game");
  mkdirSync(gamePath, { recursive: true });
  writeFileSync(join(gamePath, "StardewModdingAPI.exe"), "", "utf8");
  const args = [
    "--cadence",
    cadence,
    "--game-path",
    gamePath,
    "--mods-path",
    join(root, "mods"),
    "--save-name",
    SAVE_NAME,
    "--fixture-root",
    join(root, "fixtures"),
    "--release-dir",
    join(root, "release"),
    "--run-dir",
    runDir ?? join(root, "run"),
    ...blocks.flatMap((block) => ["--blocks", block]),
    ...only.flatMap((actionId) => ["--only", actionId]),
    ...(scenario === null ? [] : ["--scenario", scenario]),
    ...extra,
  ];
  return { args, env: { LOCALAPPDATA: root } };
}

/** One canned block child: the block's OWN published verdict, so a row is judged as a real block would be. */
function passingBlock(block, target) {
  if (block === "b2_action_gates")
    return {
      exitCode: 0,
      timedOut: false,
      stdout: `${JSON.stringify({ schema: ACTION_GATE_BATCH_SCHEMA, state: "passed", reasonCode: "all_gates_passed" })}\n`,
      stderr: "",
    };
  const resultPath = join(mkdtempSync(join(tmpdir(), "cadence-ladder-")), "ladder.result.json");
  writeFileSync(resultPath, JSON.stringify({ state: "passed", scenario: target }), "utf8");
  return { exitCode: 0, timedOut: false, stdout: `RESULT {"state":"passed"}\nresult: ${resultPath}\n`, stderr: "" };
}

test("the cadence schema, the block table and the cadence map are the driver's own published contract", () => {
  assert.equal(CADENCE_SCHEMA, "gamebuddy-stardew-automation-cadence/v2");
  assert.equal(ACTION_GATE_BATCH_SCHEMA, "gamebuddy-stardew-action-gate-batch/v1");
  assert.deepEqual(Object.keys(BLOCK_ENTRIES), ["b2_action_gates", "b3_companion_session", "b4_shared_world"]);
  assert.deepEqual(CADENCE_BLOCKS, {
    nightly: ["b2_action_gates", "b3_companion_session"],
    release: ["b2_action_gates", "b3_companion_session", "b4_shared_world"],
  });
  // Every block names the ONE existing entry the plan names for it, and that entry is on disk.
  assert.equal(BLOCK_ENTRIES.b2_action_gates.entry, "tools/run-stardew-action-gates-batch.mjs");
  assert.equal(BLOCK_ENTRIES.b3_companion_session.entry, "tools/live-run/game/launch-ladder-live.mjs");
  assert.equal(BLOCK_ENTRIES.b4_shared_world.entry, "tools/run-stardew-multiplayer-gate.mjs");
  for (const [block, entry] of Object.entries(BLOCK_ENTRIES))
    assert.ok(existsSync(new URL(`../${entry.entry}`, import.meta.url)), `${block} must name a real entry`);
  // The plan's other blocks are NAMED with a reason, never silently dropped.
  assert.deepEqual(
    BLOCKS_NOT_IN_CADENCE.map((entry) => entry.block),
    ["b1_offline_gates", "b5_game_surface", "b6_lifecycle_cold_session"],
  );
  for (const entry of BLOCKS_NOT_IN_CADENCE) assert.ok(entry.reason.length > 0, `${entry.block} must say why`);
});

test("the ladder scenarios mirror the launcher's own list", () => {
  // `launch-ladder-live.mjs` launches a real game at module scope, so it cannot be imported; the
  // list is compared as text, the way `run-scenarios.test.mjs` pins the runner's own literals.
  const source = readFileSync(new URL("./live-run/game/launch-ladder-live.mjs", import.meta.url), "utf8");
  const declared = /const SCENARIOS = Object\.freeze\(\[([^\]]*)\]\);/u.exec(source);
  assert.ok(declared !== null, "the launcher must still declare SCENARIOS as one literal");
  assert.deepEqual(
    declared[1]
      .split(",")
      .map((value) => value.trim().replaceAll('"', ""))
      .filter((value) => value.length > 0),
    LADDER_SCENARIOS,
  );
});

test("a cadence's steps are the plan's cadence table", () => {
  assert.deepEqual(
    planCadence(CADENCE_BLOCKS.nightly, { cadence: "nightly", scenario: "memory_covenant" }).map((step) => [
      step.block,
      step.target,
    ]),
    [
      ["b2_action_gates", null],
      ["b3_companion_session", "memory_covenant"],
    ],
  );
  // Release runs every ladder scenario and both shared-world actions, from the gate's own table.
  assert.deepEqual(
    planCadence(CADENCE_BLOCKS.release, { cadence: "release", scenario: null }).map((step) => [
      step.block,
      step.target,
    ]),
    [
      ["b2_action_gates", null],
      ...LADDER_SCENARIOS.map((scenario) => ["b3_companion_session", scenario]),
      ...Object.keys(MULTIPLAYER_GATE_ACTIONS).map((action) => ["b4_shared_world", action]),
    ],
  );
  assert.deepEqual(Object.keys(MULTIPLAYER_GATE_ACTIONS), ["send_multiplayer_chat", "talk_to_npc"]);
});

test("the B2 block judges the published gates the shared-world lane does not own", () => {
  const scope = resolveActionGateScope();
  const published = STARDEW_PUBLISHED_ACTION_GATES.map((gate) => gate.actionId);
  // The split is DERIVED from the two tables it reads: the published surface, and the actions the
  // shared-world lane's own table says it can start. Neither list is written here.
  assert.deepEqual(scope.ownedElsewhere, Object.keys(MULTIPLAYER_GATE_ACTIONS));
  assert.deepEqual(
    scope.judged,
    published.filter((actionId) => !scope.ownedElsewhere.includes(actionId)),
  );
  assert.deepEqual([...scope.judged, ...scope.ownedElsewhere].sort(), [...published].sort());
  assert.equal(scope.judged.length + scope.ownedElsewhere.length, STARDEW_PUBLISHED_ACTION_GATES.length);

  // The B2 block's own parser is the authority on what its entry accepts: an unscoped pass runs
  // exactly the judged set, in the published table's own order, and never the two B4 owns.
  const unscoped = cadenceRequest({ blocks: ["b2_action_gates"] });
  const unscopedRequest = parseCadenceArgs(unscoped.args, unscoped.env);
  const b2 = buildBlockInvocation({
    block: "b2_action_gates",
    target: null,
    request: unscopedRequest,
    runDir: unscopedRequest.runDir,
  });
  assert.deepEqual(parseBatchArgs(b2.args.slice(1), unscoped.env).only, scope.judged);

  // An operator who narrows the pass keeps their own scope: naming one of the two B4 owns is the
  // batch's own documented way to say "this red is known and intended", so it must survive.
  const narrowed = cadenceRequest({ blocks: ["b2_action_gates"], only: ["send_multiplayer_chat"] });
  const narrowedRequest = parseCadenceArgs(narrowed.args, narrowed.env);
  const narrowedB2 = buildBlockInvocation({
    block: "b2_action_gates",
    target: null,
    request: narrowedRequest,
    runDir: narrowedRequest.runDir,
  });
  assert.deepEqual(parseBatchArgs(narrowedB2.args.slice(1), narrowed.env).only, ["send_multiplayer_chat"]);

  // Two tables that disagree, or a split that leaves B2 nothing to judge, refuse by name.
  assert.throws(
    () => resolveActionGateScope({ sharedWorld: ["not_a_published_action"] }),
    /shared_world_action_not_published:not_a_published_action/,
  );
  assert.throws(
    () =>
      resolveActionGateScope({
        published: STARDEW_PUBLISHED_ACTION_GATES.filter(
          (gate) => MULTIPLAYER_GATE_ACTIONS[gate.actionId] !== undefined,
        ),
      }),
    /action_gate_scope_empty/,
  );
});

test("a pass says which published actions its cadence did not judge", () => {
  const scope = resolveActionGateScope();
  // The plan's cadence table makes B4 release-only, so a nightly pass runs no block that judges the
  // two actions B4 owns. That is the plan's own cadence - and it is written down, so a nightly green
  // never reads as "the whole published surface still opens" (plan §7: absence is never a pass).
  assert.deepEqual(actionsNotJudgedByCadence(CADENCE_BLOCKS.nightly, scope), Object.keys(MULTIPLAYER_GATE_ACTIONS));
  assert.deepEqual(actionsNotJudgedByCadence(CADENCE_BLOCKS.release, scope), []);
  // Narrowed to B4 alone, the pass judges the two B4 owns and none of the other 89.
  assert.deepEqual(actionsNotJudgedByCadence(["b4_shared_world"], scope), scope.judged);
  // Every published action is named exactly once as judged or as not judged in this cadence.
  for (const blocks of [CADENCE_BLOCKS.nightly, CADENCE_BLOCKS.release, ["b2_action_gates"], ["b4_shared_world"]]) {
    const notJudged = actionsNotJudgedByCadence(blocks, scope);
    const judged = [...scope.judged, ...scope.ownedElsewhere].filter((actionId) => !notJudged.includes(actionId));
    assert.deepEqual([...judged, ...notJudged].sort(), [...scope.judged, ...scope.ownedElsewhere].sort());
  }
});

test("each block's verdict is the record its OWN authority publishes", () => {
  // B2: the whole-table pass's rollup, and only that schema.
  assert.deepEqual(
    readBlockVerdict({
      block: "b2_action_gates",
      stdout: `{"state":"prepared"}\n${JSON.stringify({ schema: ACTION_GATE_BATCH_SCHEMA, state: "blocked", reasonCode: "gate_not_passed:harvest_crop" })}\n`,
    }),
    { state: "blocked", reasonCode: "gate_not_passed:harvest_crop" },
  );
  // A record without the batch's schema is not the batch's verdict - it can never manufacture one.
  assert.equal(readBlockVerdict({ block: "b2_action_gates", stdout: '{"state":"passed"}' }), null);
  // B4: the shared-world gate's own reduced outcome.
  assert.deepEqual(
    readBlockVerdict({
      block: "b4_shared_world",
      stdout: 'WARNING: xxx\n{"state":"blocked","reasonCode":"multiplayer_gate_topology_timeout"}\n',
    }),
    { state: "blocked", reasonCode: "multiplayer_gate_topology_timeout" },
  );
  // B3: the ladder's own result, at the path its launcher published.
  const resultDir = mkdtempSync(join(tmpdir(), "cadence-result-"));
  const resultPath = join(resultDir, "ladder.result.json");
  writeFileSync(resultPath, JSON.stringify({ state: "passed", scenario: "morning_routine" }), "utf8");
  assert.deepEqual(readBlockVerdict({ block: "b3_companion_session", stdout: "", resultPath }), {
    state: "passed",
    reasonCode: null,
  });
  assert.equal(readBlockVerdict({ block: "b3_companion_session", stdout: "", resultPath: null }), null);
  assert.equal(readBlockVerdict({ block: "b3_companion_session", stdout: "", resultPath: pathIn(resultDir) }), null);
  // A block this pass does not compose has no verdict here, whatever a caller asks for.
  assert.equal(readBlockVerdict({ block: "b6_lifecycle_cold_session", stdout: '{"state":"passed"}' }), null);
});

function pathIn(directory) {
  return join(directory, "absent.json");
}

test("the ladder's result path is read from the line its launcher publishes", () => {
  const path = "C:\\repo\\tools\\_morning_routine-ab12cd34-1.result.json";
  const stdout = [
    '{"state":"prepared"}',
    'RESULT {"state":"passed","scenario":"morning_routine"}',
    `result: ${path}`,
    "",
  ].join("\n");
  assert.equal(publishedResultPath(stdout), path);
  // The `RESULT {...}` diagnostic is not the published path, and no line is not a path.
  assert.equal(publishedResultPath('RESULT {"state":"passed"}'), null);
  assert.equal(publishedResultPath("no result line"), null);
  assert.equal(publishedResultPath(""), null);
});

test("a block's record is looked up backwards on stdout, never assumed to be the first line", () => {
  assert.deepEqual(
    lastJsonRecord('{"a":1}\nnot json\n{"b":2}', (record) => record.b === 2),
    { b: 2 },
  );
  assert.equal(
    lastJsonRecord('{"a":1}', (record) => record.b === 2),
    null,
  );
  assert.equal(lastJsonRecord("nothing here"), null);
  assert.equal(lastJsonRecord(""), null);
  assert.equal(lastJsonRecord("[{},{}]"), null);
});

test("a block is blocked on a timeout, a missing verdict, a non-passing verdict or a bad exit", () => {
  const block = BLOCK_ENTRIES.b2_action_gates;
  const passed = { state: "passed", reasonCode: "all_gates_passed" };
  assert.deepEqual(classifyBlock({ failureCode: block.failureCode, timedOut: true, exitCode: null, verdict: passed }), {
    state: "blocked",
    reasonCode: "cadence_block_timeout",
    blockReasonCode: null,
  });
  // A timeout is a harness failure even when the block managed to print a pass before it was killed.
  assert.deepEqual(classifyBlock({ failureCode: block.failureCode, timedOut: false, exitCode: 0, verdict: null }), {
    state: "blocked",
    reasonCode: "cadence_block_verdict_missing",
    blockReasonCode: null,
  });
  // A block that reports not-passed with its own code is named by that code, not by a generic one.
  assert.deepEqual(
    classifyBlock({
      failureCode: block.failureCode,
      timedOut: false,
      exitCode: 2,
      verdict: { state: "blocked", reasonCode: "gate_not_passed:harvest_crop" },
    }),
    { state: "blocked", reasonCode: "gate_not_passed:harvest_crop", blockReasonCode: "gate_not_passed:harvest_crop" },
  );
  // ... and by the registered code for that block when it published none.
  assert.deepEqual(
    classifyBlock({
      failureCode: block.failureCode,
      timedOut: false,
      exitCode: 2,
      verdict: { state: "blocked", reasonCode: null },
    }),
    { state: "blocked", reasonCode: block.failureCode, blockReasonCode: null },
  );
  // A pass that contradicts its own exit code is not believed.
  assert.deepEqual(classifyBlock({ failureCode: block.failureCode, timedOut: false, exitCode: 3, verdict: passed }), {
    state: "blocked",
    reasonCode: "cadence_block_exit:3",
    blockReasonCode: "all_gates_passed",
  });
  assert.deepEqual(classifyBlock({ failureCode: block.failureCode, timedOut: false, exitCode: 0, verdict: passed }), {
    state: "passed",
    reasonCode: "cadence_block_passed",
    blockReasonCode: "all_gates_passed",
  });
});

test("bad arguments are refused by name before any block runs", () => {
  const { args, env } = cadenceRequest({ scenario: "morning_routine" });
  const without = (flag) => {
    const index = args.indexOf(flag);
    return args.filter((_, position) => position !== index && position !== index + 1);
  };
  assert.throws(() => parseCadenceArgs(without("--cadence"), env), /cadence_required/);
  assert.throws(() => parseCadenceArgs([...args, "--cadence", "hourly"], env), /invalid_cadence_argument:--cadence/);
  assert.throws(
    () =>
      parseCadenceArgs(
        args.map((value) => (value === "nightly" ? "hourly" : value)),
        env,
      ),
    /unknown_cadence:hourly/,
  );
  assert.throws(() => parseCadenceArgs(without("--game-path"), {}), /game_path_required:GAMEBUDDY_STARDEW_GAME_PATH/);
  assert.equal(
    parseCadenceArgs(without("--game-path"), {
      GAMEBUDDY_STARDEW_GAME_PATH: args[args.indexOf("--game-path") + 1],
    }).gamePath,
    args[args.indexOf("--game-path") + 1],
  );
  assert.throws(() => parseCadenceArgs(without("--mods-path"), env), /mods_path_required/);
  assert.throws(() => parseCadenceArgs(without("--save-name"), env), /save_name_required/);
  assert.throws(
    () =>
      parseCadenceArgs(
        args.map((value) => (value === SAVE_NAME ? "not-a-fixture-slot" : value)),
        env,
      ),
    /invalid_save_name/,
  );
  assert.throws(() => parseCadenceArgs([...args, "--nope", "x"], env), /invalid_cadence_argument:--nope/);
  assert.throws(() => parseCadenceArgs([...args, "--blocks"], env), /missing_cadence_argument_value:blocks/);
  assert.throws(() => parseCadenceArgs([...args, "--window-mode", "sideways"], env), /invalid_live_run_window_mode/);
  assert.throws(
    () =>
      parseCadenceArgs(
        [
          "--cadence",
          "nightly",
          "--game-path",
          "relative-game",
          "--mods-path",
          "relative-mods",
          "--save-name",
          SAVE_NAME,
          "--run-dir",
          "relative-run",
        ],
        env,
      ),
    /invalid_game_path/,
  );
  // The nightly B3 block runs the scenario named here; a release pass runs all four and needs none.
  assert.throws(() => parseCadenceArgs(without("--scenario"), env), /scenario_required/);
  assert.throws(
    () =>
      parseCadenceArgs(
        args.map((value) => (value === "morning_routine" ? "not_a_scenario" : value)),
        env,
      ),
    /unknown_scenario:not_a_scenario/,
  );
  assert.equal(parseCadenceArgs(cadenceRequest({ blocks: ["b2_action_gates"] }).args, env).scenario, null);
  assert.deepEqual(parseCadenceArgs(cadenceRequest({ blocks: ["b2_action_gates"] }).args, env).blocks, [
    "b2_action_gates",
  ]);
  // A block can only be selected from the cadence that owns it, and only once.
  assert.throws(
    () => parseCadenceArgs([...args, "--blocks", "b4_shared_world"], env),
    /block_not_in_cadence:nightly:b4_shared_world/,
  );
  assert.throws(
    () =>
      parseCadenceArgs(
        [
          ...cadenceRequest({ blocks: ["b2_action_gates"], scenario: "morning_routine" }).args,
          "--blocks",
          "b2_action_gates",
        ],
        env,
      ),
    /duplicate_cadence_block:b2_action_gates/,
  );
  // `--only` is the B2 block's own flag, validated by that block's own selector.
  assert.throws(
    () =>
      parseCadenceArgs(
        [
          ...cadenceRequest({ blocks: ["b3_companion_session"], scenario: "morning_routine" }).args,
          "--only",
          "move_to_tile",
        ],
        env,
      ),
    /only_requires_action_gates_block/,
  );
  assert.throws(
    () => parseCadenceArgs([...cadenceRequest({ blocks: ["b2_action_gates"] }).args, "--only", "not_an_action"], env),
    /unknown_gate_action:not_an_action/,
  );
  // A release pass only needs the identity its B4 block binds to.
  const release = cadenceRequest({ cadence: "release", blocks: ["b4_shared_world"] });
  assert.throws(() => parseCadenceArgs(release.args, release.env), /expected_farmhand_id_required/);
  assert.equal(
    parseCadenceArgs([...release.args, "--expected-farmhand-id", FARMHAND_ID], release.env).expectedFarmhandId,
    FARMHAND_ID,
  );
});

test("the arguments this pass builds are the entries' own shapes", () => {
  const nightly = cadenceRequest({
    blocks: ["b2_action_gates", "b3_companion_session"],
    only: ["move_to_tile"],
    scenario: "morning_routine",
  });
  const request = parseCadenceArgs(nightly.args, nightly.env);
  assert.deepEqual(request.only, ["move_to_tile"]);

  // The B2 block's own parser is the authority on what its entry accepts.
  const b2 = buildBlockInvocation({ block: "b2_action_gates", target: null, request, runDir: request.runDir });
  const batch = parseBatchArgs(b2.args.slice(1), nightly.env);
  assert.equal(batch.gamePath, request.gamePath);
  assert.equal(batch.modsPath, request.modsPath);
  assert.equal(batch.saveName, SAVE_NAME);
  assert.equal(batch.fixtureRoot, request.fixtureRoot);
  assert.equal(batch.releaseDir, request.releaseDir);
  assert.equal(batch.windowMode, "hidden");
  assert.deepEqual(batch.only, ["move_to_tile"]);
  assert.equal(batch.runDir, join(request.runDir, "b2-action-gates"));

  // The ladder has no exported parser, so its flag list is pinned here: the launcher's own
  // documented flags, its own scenario vocabulary, and a label that isolates this run's artifacts.
  const b3 = buildBlockInvocation({
    block: "b3_companion_session",
    target: "morning_routine",
    request: { ...request, label: "ab12cd34-1" },
    runDir: request.runDir,
  });
  for (const flag of ["--scenario", "--game", "--mods", "--save", "--root", "--release", "--label"])
    assert.ok(b3.args.includes(flag), `the ladder block must pass ${flag}`);
  assert.equal(b3.args[b3.args.indexOf("--scenario") + 1], "morning_routine");
  assert.equal(b3.args[b3.args.indexOf("--label") + 1], "ab12cd34-1");
  assert.equal(b3.args[b3.args.indexOf("--game") + 1], request.gamePath);
  assert.equal(b3.args[b3.args.indexOf("--mods") + 1], request.modsPath);
  assert.equal(b3.args[b3.args.indexOf("--save") + 1], SAVE_NAME);
  assert.equal(b3.args[b3.args.indexOf("--root") + 1], request.fixtureRoot);
  assert.equal(b3.args[b3.args.indexOf("--release") + 1], request.releaseDir);
  // The ladder reads window mode from its environment instead of a flag.
  assert.deepEqual(b3.env, { GAMEBUDDY_LADDER_WINDOW_MODE: "hidden" });
  assert.deepEqual(b2.env, {});

  // The shared-world gate's own parser is the authority on what its entry accepts.
  const release = cadenceRequest({
    cadence: "release",
    blocks: ["b4_shared_world"],
    extra: ["--expected-farmhand-id", FARMHAND_ID],
  });
  const releaseRequest = parseCadenceArgs(release.args, release.env);
  const b4 = buildBlockInvocation({
    block: "b4_shared_world",
    target: "talk_to_npc",
    request: releaseRequest,
    runDir: releaseRequest.runDir,
  });
  const gate = parseGateArgs(b4.args.slice(1));
  assert.equal(gate.action, "talk_to_npc");
  assert.equal(gate.expectedFarmhandId, FARMHAND_ID);
  assert.equal(gate.saveName, SAVE_NAME);
  assert.equal(gate.gamePath, releaseRequest.gamePath);
  assert.equal(gate.keepRunRoot, true);
  assert.equal(gate.runRoot, join(releaseRequest.runDir, "b4-shared-world", "talk_to_npc"));
  assert.equal(gate.resultFile, join(releaseRequest.runDir, "b4-shared-world", "talk_to_npc", "driver-result.json"));
});

test("a block whose entry is not wired refuses the pass before anything runs", async () => {
  const { args, env } = cadenceRequest({
    blocks: ["b2_action_gates", "b3_companion_session"],
    scenario: "morning_routine",
  });
  assert.deepEqual(missingBlockEntries(["b2_action_gates"], { exists: () => false }), ["b2_action_gates"]);
  assert.deepEqual(missingBlockEntries(["b2_action_gates"]), []);

  let launches = 0;
  const { rollup, exitCode } = await runCadence({
    argv: args,
    env,
    entryExists: () => false,
    runBlock: async () => {
      launches += 1;
      return passingBlock("b2_action_gates", null);
    },
  });
  assert.equal(launches, 0);
  assert.equal(rollup.schema, CADENCE_SCHEMA);
  assert.equal(rollup.state, "blocked");
  assert.equal(rollup.reasonCode, "cadence_block_entry_missing:b2_action_gates");
  assert.deepEqual(rollup.rows, []);
  assert.deepEqual(rollup.counts, { total: 0, passed: 0, blocked: 0 });
  assert.deepEqual(rollup.unavailableBlocks, []);
  // A refused pass publishes the SAME rollup shape, scope included: a reader never has to tell a
  // refusal's shape from a pass's.
  assert.deepEqual(rollup.actionGateScope.ownedElsewhere, Object.keys(MULTIPLAYER_GATE_ACTIONS));
  assert.deepEqual(rollup.actionGateScope.notInThisCadence, Object.keys(MULTIPLAYER_GATE_ACTIONS));
  assert.equal(exitCode, 2);
});

test("a passing pass is green, in the plan's order, with the block's own codes in the rows", async () => {
  const { args, env } = cadenceRequest({
    runDir: mkdtempSync(join(tmpdir(), "cadence-run-")),
    blocks: ["b2_action_gates", "b3_companion_session"],
    scenario: "morning_routine",
  });
  const seen = [];
  const { rollup, exitCode } = await runCadence({
    argv: args,
    env,
    runBlock: async ({ block, target, args: blockArgs, env: blockEnv, timeoutMs }) => {
      seen.push({ block, target, blockArgs, blockEnv, timeoutMs });
      return passingBlock(block, target);
    },
  });

  assert.equal(rollup.schema, CADENCE_SCHEMA);
  assert.equal(rollup.cadence, "nightly");
  assert.equal(rollup.state, "passed");
  assert.equal(rollup.reasonCode, "cadence_passed");
  assert.equal(exitCode, 0);
  assert.deepEqual(rollup.counts, { total: 2, passed: 2, blocked: 0 });
  assert.deepEqual(rollup.failedBlocks, []);
  // The row shape is the contract: exactly the five named keys, per block target.
  for (const row of rollup.rows) assert.deepEqual(Object.keys(row).sort(), [...ROW_KEYS].sort());
  assert.deepEqual(
    rollup.rows.map((row) => [row.block, row.target]),
    [
      ["b2_action_gates", null],
      ["b3_companion_session", "morning_routine"],
    ],
  );
  assert.deepEqual(
    rollup.rows.map((row) => row.state),
    ["passed", "passed"],
  );
  assert.deepEqual(
    rollup.rows.map((row) => row.blockReasonCode),
    ["all_gates_passed", null],
  );
  // The blocks ran in the plan's order, one at a time, with the harness bound their entry declares.
  assert.deepEqual(
    seen.map((entry) => entry.block),
    ["b2_action_gates", "b3_companion_session"],
  );
  assert.equal(seen[0].timeoutMs, BLOCK_ENTRIES.b2_action_gates.timeoutMs);
  assert.equal(seen[1].timeoutMs, BLOCK_ENTRIES.b3_companion_session.timeoutMs);
  assert.deepEqual(seen[1].blockEnv, { GAMEBUDDY_LADDER_WINDOW_MODE: "hidden" });
  // The plan's other blocks are named in the rollup, so a reader never has to guess what did not run.
  assert.deepEqual(
    rollup.blocksNotInCadence.map((entry) => entry.block),
    ["b1_offline_gates", "b5_game_surface", "b6_lifecycle_cold_session"],
  );
  // So is the action-subject boundary: what B2 judged, what it handed to B4 instead, and what this
  // cadence did not judge at all (B4 does not run in a nightly pass).
  assert.deepEqual(rollup.actionGateScope.ownedElsewhere, Object.keys(MULTIPLAYER_GATE_ACTIONS));
  assert.deepEqual(rollup.actionGateScope.notInThisCadence, Object.keys(MULTIPLAYER_GATE_ACTIONS));
  assert.equal(
    rollup.actionGateScope.judged.length + rollup.actionGateScope.ownedElsewhere.length,
    STARDEW_PUBLISHED_ACTION_GATES.length,
  );
  // Each block's own evidence survives in the run directory.
  assert.match(readFileSync(join(rollup.runDir, "b2_action_gates.log"), "utf8"), /all_gates_passed/u);
  assert.match(readFileSync(join(rollup.runDir, "b3_companion_session-morning_routine.log"), "utf8"), /result: /u);
});

test("a block that reports not-passed makes the pass red and is named by the block's own code", async () => {
  const { args, env } = cadenceRequest({
    runDir: mkdtempSync(join(tmpdir(), "cadence-red-")),
    blocks: ["b2_action_gates", "b3_companion_session"],
    scenario: "morning_routine",
  });
  const { rollup, exitCode } = await runCadence({
    argv: args,
    env,
    runBlock: async ({ block, target }) =>
      block === "b2_action_gates"
        ? {
            exitCode: 2,
            timedOut: false,
            stdout: `${JSON.stringify({ schema: ACTION_GATE_BATCH_SCHEMA, state: "blocked", reasonCode: "gate_not_passed:harvest_crop" })}\n`,
            stderr: "",
          }
        : passingBlock(block, target),
  });

  assert.equal(rollup.state, "blocked");
  assert.equal(rollup.reasonCode, "cadence_block_not_passed:b2_action_gates");
  assert.deepEqual(rollup.counts, { total: 2, passed: 1, blocked: 1 });
  assert.deepEqual(rollup.failedBlocks, [
    { block: "b2_action_gates", target: null, reasonCode: "gate_not_passed:harvest_crop" },
  ]);
  // A product refusal is NOT a host refusal: the run verdict stays `blocked`.
  assert.deepEqual(rollup.unavailableBlocks, []);
  assert.deepEqual(
    rollup.rows.map((row) => [row.state, row.reasonCode, row.blockReasonCode]),
    [
      ["blocked", "gate_not_passed:harvest_crop", "gate_not_passed:harvest_crop"],
      ["passed", "cadence_block_passed", null],
    ],
  );
  assert.equal(exitCode, 2);
});

test("a block that produced no verdict is missing, never a pass", async () => {
  const { args, env } = cadenceRequest({
    runDir: mkdtempSync(join(tmpdir(), "cadence-missing-")),
    blocks: ["b2_action_gates", "b3_companion_session"],
    scenario: "morning_routine",
  });
  const { rollup, exitCode } = await runCadence({
    argv: args,
    env,
    // The ladder died before publishing where its result is: nothing on stdout, no result file.
    runBlock: async ({ block, target }) =>
      block === "b2_action_gates"
        ? passingBlock(block, target)
        : { exitCode: 1, timedOut: false, stdout: "", stderr: "harness died\n" },
  });

  assert.equal(rollup.state, "blocked");
  assert.equal(rollup.reasonCode, "cadence_block_not_passed:b3_companion_session:morning_routine");
  assert.deepEqual(rollup.failedBlocks, [
    { block: "b3_companion_session", target: "morning_routine", reasonCode: "cadence_block_verdict_missing" },
  ]);
  assert.equal(rollup.rows[1].reasonCode, "cadence_block_verdict_missing");
  assert.equal(rollup.rows[1].blockReasonCode, null);
  assert.equal(exitCode, 2);
  // The evidence the block did produce is kept even when its verdict is missing.
  assert.match(readFileSync(join(rollup.runDir, "b3_companion_session-morning_routine.log"), "utf8"), /harness died/u);
});

test("a harness timeout is a blocked block, never a product verdict", async () => {
  const { args, env } = cadenceRequest({
    runDir: mkdtempSync(join(tmpdir(), "cadence-timeout-")),
    blocks: ["b2_action_gates"],
  });
  const { rollup, exitCode } = await runCadence({
    argv: args,
    env,
    // A timeout with a printed pass would still be a harness failure, not a green block.
    runBlock: async () => ({ exitCode: null, timedOut: true, stdout: "", stderr: "" }),
  });
  assert.deepEqual(rollup.failedBlocks, [
    { block: "b2_action_gates", target: null, reasonCode: "cadence_block_timeout" },
  ]);
  assert.equal(rollup.state, "blocked");
  assert.equal(exitCode, 2);
});

test("a release pass runs every ladder scenario and both shared-world actions", async () => {
  const { args, env } = cadenceRequest({
    runDir: mkdtempSync(join(tmpdir(), "cadence-release-")),
    cadence: "release",
    extra: ["--expected-farmhand-id", FARMHAND_ID],
  });
  const launched = [];
  let b2Only = null;
  const { rollup, exitCode } = await runCadence({
    argv: args,
    env,
    runBlock: async ({ block, target, args: blockArgs }) => {
      launched.push(`${block}${target === null ? "" : `:${target}`}`);
      if (block === "b2_action_gates") b2Only = parseBatchArgs(blockArgs.slice(1), env).only;
      if (block === "b4_shared_world")
        return {
          exitCode: 0,
          timedOut: false,
          stdout: '{"state":"passed","reasonCode":"multiplayer_gate_passed"}\n',
          stderr: "",
        };
      return passingBlock(block, target);
    },
  });
  assert.deepEqual(launched, [
    "b2_action_gates",
    ...LADDER_SCENARIOS.map((scenario) => `b3_companion_session:${scenario}`),
    ...Object.keys(MULTIPLAYER_GATE_ACTIONS).map((action) => `b4_shared_world:${action}`),
  ]);
  assert.equal(rollup.state, "passed");
  assert.equal(rollup.counts.total, 1 + LADDER_SCENARIOS.length + Object.keys(MULTIPLAYER_GATE_ACTIONS).length);
  assert.equal(exitCode, 0);
  // One owner per action, whichever cadence runs: B2 judged the published gates the shared-world
  // lane does not own, and the two it does are the two B4 ran.
  assert.deepEqual(b2Only, resolveActionGateScope().judged);
  assert.deepEqual(rollup.actionGateScope.ownedElsewhere, Object.keys(MULTIPLAYER_GATE_ACTIONS));
  // A release pass runs a block that judges each side of the split, so it leaves nothing unjudged.
  assert.deepEqual(rollup.actionGateScope.notInThisCadence, []);
});

test("the codes that mean this machine cannot host a block are named once, each with its source file", () => {
  // The set is the composed blocks' OWN published codes, and each names the file that throws it: the
  // literal is there, so the set cannot go stale behind a rename.
  assert.deepEqual(
    MACHINE_CANNOT_HOST_REASONS.map((entry) => entry.reasonCode),
    ["game_path_missing_smapi", "multiplayer_gate_smapi_missing", "multiplayer_gate_release_missing"],
  );
  for (const entry of MACHINE_CANNOT_HOST_REASONS) {
    assert.equal(isMachineCannotHostReason(entry.reasonCode), true, `${entry.reasonCode} must be a host code`);
    const source = readFileSync(new URL(`../${entry.source}`, import.meta.url), "utf8");
    assert.match(
      source,
      new RegExp(`\\b${entry.reasonCode}\\b`, "u"),
      `${entry.source} must still carry ${entry.reasonCode}`,
    );
  }
  // A product refusal, a harness timeout and a missing verdict are NOT host facts - and null is not one.
  for (const code of [
    "gate_not_passed:harvest_crop",
    "gate_result_not_passed",
    "cadence_block_timeout",
    "cadence_block_verdict_missing",
    "cadence_block_exit:2",
    null,
  ])
    assert.equal(isMachineCannotHostReason(code), false, `${code} must not be read as a host fact`);
});

test("a machine that cannot host a block reads unavailable, and the block's own code names why", async () => {
  const { args, env } = cadenceRequest({
    runDir: mkdtempSync(join(tmpdir(), "cadence-unavailable-")),
    blocks: ["b2_action_gates", "b3_companion_session"],
    scenario: "morning_routine",
  });
  const { rollup, exitCode } = await runCadence({
    argv: args,
    env,
    runBlock: async ({ block }) =>
      block === "b2_action_gates"
        ? // The batch's own refusal, exactly as its CLI publishes it when <game-path>\StardewModdingAPI.exe is absent.
          {
            exitCode: 1,
            timedOut: false,
            stdout: `${JSON.stringify({ schema: ACTION_GATE_BATCH_SCHEMA, state: "blocked", reasonCode: "game_path_missing_smapi" })}\n`,
            stderr: "",
          }
        : // The ladder died before it wrote a result: a missing verdict, NOT a host code.
          { exitCode: 1, timedOut: false, stdout: "", stderr: "no native-local binding\n" },
  });

  // The run verdict is the distinct one, and it names the block this machine cannot host.
  assert.equal(rollup.schema, CADENCE_SCHEMA);
  assert.equal(rollup.state, "unavailable");
  assert.notEqual(rollup.state, "blocked");
  assert.equal(rollup.reasonCode, "cadence_block_unavailable:b2_action_gates");
  assert.deepEqual(rollup.unavailableBlocks, [
    { block: "b2_action_gates", target: null, reasonCode: "game_path_missing_smapi" },
  ]);
  // Both failures survive: the host refusal and the generic missing verdict are not conflated.
  assert.deepEqual(rollup.failedBlocks, [
    { block: "b2_action_gates", target: null, reasonCode: "game_path_missing_smapi" },
    { block: "b3_companion_session", target: "morning_routine", reasonCode: "cadence_block_verdict_missing" },
  ]);
  // A row is still its block's own failure; only the RUN verdict is the new word.
  assert.deepEqual(
    rollup.rows.map((row) => [row.state, row.reasonCode]),
    [
      ["blocked", "game_path_missing_smapi"],
      ["blocked", "cadence_block_verdict_missing"],
    ],
  );
  assert.deepEqual(rollup.counts, { total: 2, passed: 0, blocked: 2 });
  // It is STILL not a pass, whatever the state word.
  assert.equal(exitCode, 2);
});

test("a shared-world host refusal names the B4 block too", async () => {
  const { args, env } = cadenceRequest({
    runDir: mkdtempSync(join(tmpdir(), "cadence-unavailable-b4-")),
    cadence: "release",
    blocks: ["b4_shared_world"],
    extra: ["--expected-farmhand-id", FARMHAND_ID],
  });
  const { rollup, exitCode } = await runCadence({
    argv: args,
    env,
    runBlock: async () => ({
      exitCode: 1,
      timedOut: false,
      stdout: '{"state":"blocked","reasonCode":"multiplayer_gate_smapi_missing"}\n',
      stderr: "",
    }),
  });
  assert.equal(rollup.state, "unavailable");
  assert.equal(rollup.reasonCode, "cadence_block_unavailable:b4_shared_world:send_multiplayer_chat");
  assert.deepEqual(
    rollup.unavailableBlocks,
    Object.keys(MULTIPLAYER_GATE_ACTIONS).map((action) => ({
      block: "b4_shared_world",
      target: action,
      reasonCode: "multiplayer_gate_smapi_missing",
    })),
  );
  assert.equal(exitCode, 2);
});
