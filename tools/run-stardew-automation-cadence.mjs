#!/usr/bin/env node
/**
 * The plan's cadence table, as one pass: the local live blocks, in order, one rollup.
 *
 * WHY THIS EXISTS (`.pi/tools/game-automation-plan.md` §3 "Cadence")
 * ------------------------------------------------------------------
 * Every block of the plan now has a repeatable entry point, and every one of them is still
 * invoked by a human typing one command per block: nothing runs them together and nothing
 * rolls their outcomes into one record, so "does the whole local flow still run" is a
 * question no single artifact answers. This driver is that pass, and it does nothing else.
 *
 * ORCHESTRATE ONLY. It re-implements no postcondition, invents no fixture and adds no
 * assertion about the product: each block still runs through its ONE existing entry, and
 * this driver judges it only by the verdict that entry already publishes.
 *
 *   | block                | the verdict it reads                              | owning authority |
 *   |----------------------|--------------------------------------------------|------------------|
 *   | b2_action_gates      | the whole-table pass's own rollup (`state` + `reasonCode`) | `tools/run-stardew-action-gates-batch.mjs` (`gamebuddy-stardew-action-gate-batch/v1`) |
 *   | b3_companion_session | the ladder runner's own result `state`, at the path the launcher prints | `tools/live-run/game/run-stardew-native-local-agent-ab-live.mjs` (launched by `tools/live-run/game/launch-ladder-live.mjs`) |
 *   | b4_shared_world      | the shared-world gate's own reduced outcome        | `tools/run-stardew-multiplayer-gate.mjs` (`classifyMultiplayerGateOutcome`) |
 *
 * WHICH BLOCKS A CADENCE RUNS (§3's table, local rows only)
 * --------------------------------------------------------
 *   nightly: B2 (the full published-action table) + B3 (the one scenario named by `--scenario`)
 *   release: B2 + B3 (all four ladder scenarios) + B4 (both shared-world actions)
 *
 * WHAT IT DOES NOT COVER, BY NAME (`blocksNotInCadence` in the rollup)
 * -------------------------------------------------------------------
 *   * B1 (offline contract / install / promotion) — owned by CI per change; a cadence pass
 *     over live blocks does not re-run a 60-minute offline suite.
 *   * B5 (game surface shots) — its kit publishes COMPUTED FACTS and honest per-driver named
 *     skips, not one verdict, so the only thing left to judge it by would be its exit code;
 *     "the process exited 0" is exactly the "it did not throw" verdict §7 forbids. It stays
 *     a separately-invoked kit.
 *   * B6 (lifecycle cold session) — its entry deliberately does not own the fixture
 *     transaction: arming needs a binding the LAUNCHER computes
 *     (`tools/prepare-stardew-native-local-player-fixture.mjs` requires `--binding-path`), so
 *     the cold session is invoked through that transaction, not from a cadence pass. Composing
 *     it here would make this file a second owner of the pinned prepare/restore ordering
 *     (§4 seam 4). Reported, not faked.
 *
 * THE ACTION-SUBJECT BOUNDARY (§7: a gate whose suite runs nowhere is worse than a failing gate)
 * ------------------------------------------------------------------------------------------
 * The published surface is not one lane's subject. Two of its actions — `send_multiplayer_chat`
 * and `talk_to_npc` — are published and live-verified, and a single-player fixture can never
 * exhibit their native seam (`Multiplayer.sendChatMessage` returns without sending unless
 * `Game1.IsClient`/`Game1.IsServer` holds), which is why the B2 batch's own header says a full pass
 * is expected to name those two not-passed. A B2 block that judged them would make every nightly
 * pass red on a healthy machine, and a pass that is red by construction is one an operator learns
 * to ignore: it would say nothing about the gates that CAN open. The lane that owns those two
 * publishes exactly which actions they are (`MULTIPLAYER_GATE_ACTIONS`, which is also what this
 * pass's b4 block runs), so the B2 scope is DERIVED from the two existing tables rather than written
 * here: B2 judges the published gates that lane does not own, B4 judges those, and a table that
 * names an action the other does not refuses the pass by name rather than running a silently
 * smaller scope.
 *
 * ONLY ONE BLOCK AT A TIME. The Mod's bridge is a single named pipe and the fixture root is a
 * single-owner transaction (§7), so the blocks run strictly one after another. Each block's own
 * entry arbitrates the fixture root and waits for it (`launch-ladder-live.mjs` waits for a free
 * root and recovers an orphaned lock; the per-action launcher takes the transaction per action),
 * and this driver adds no second, weaker copy of that logic: this pass would contend with
 * itself, not with another lane, if it did.
 *
 * FAIL CLOSED. A block with no verdict, a timeout, a verdict that is not its authority's own
 * pass word, or a contradictory exit code is never a pass; it is named, the pass is red and the
 * exit code is non-zero. A timeout is a HARNESS failure: the block is killed by its own pid tree,
 * which means its pinned teardown never ran, so the fixture transaction is left for the operator
 * and the run directory keeps the block's output.
 *
 * A MACHINE THAT CANNOT HOST A BLOCK reads `unavailable`, not the same `blocked` a product failure
 * gets. The blocks that refuse before they launch (no game/SMAPI, no built Release bundle) publish
 * their own codes; `MACHINE_CANNOT_HOST_REASONS` names that set once, and the rollup splits the
 * failure class out and names the block. It is still never a pass: the exit code stays non-zero.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveStardewFixtureRoots } from "./lib/stardew-fixture-roots.mjs";
import { normalizeLiveRunWindowMode } from "./lib/stardew-live-run.mjs";
import { killProcessTree } from "./lib/windows-process-tree.mjs";
import { STARDEW_PUBLISHED_ACTION_GATES } from "./stardew-action-gate-descriptors.mjs";
import { selectGates } from "./run-stardew-action-gates-batch.mjs";
import { MULTIPLAYER_GATE_ACTIONS } from "./run-stardew-multiplayer-gate.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GAME_PATH_ENV = "GAMEBUDDY_STARDEW_GAME_PATH";
const DEFAULT_RELEASE_DIR = join(REPOSITORY_ROOT, "integrations", "stardew", "bin", "Release", "net6.0");
/** The B2 block's own observed save-slot contract; its launcher refuses the same shape. */
const SAVE_SLOT = /^GameBuddyFixture[A-Za-z0-9]{0,64}_[0-9]{1,32}$/u;

/** This driver's own verdict contract. `v2` adds the `unavailable` verdict for a host-less machine. */
export const CADENCE_SCHEMA = "gamebuddy-stardew-automation-cadence/v2";
/** The B2 block's own published rollup schema: the row reads only that record. */
export const ACTION_GATE_BATCH_SCHEMA = "gamebuddy-stardew-action-gate-batch/v1";

/**
 * The block codes that mean "this machine cannot host the block".
 *
 * Each is a composed block's OWN published `reasonCode` - the code its entry throws BEFORE it runs
 * anything because a host prerequisite is missing - with the file that throws it. The prerequisites
 * are the game's SMAPI launcher and the built Release bundle; a code naming a product refusal or a
 * harness failure is deliberately not here. A row is matched by `blockReasonCode` (what the block
 * itself published), so "no game here" stops reading as the same `blocked` a product failure gets.
 *
 * B3 publishes no such code: on a host-less machine `launch-ladder-live.mjs` dies before it writes
 * a result, so its row carries this cadence's own `cadence_block_verdict_missing`, which is a
 * missing verdict and never a host fact.
 */
export const MACHINE_CANNOT_HOST_REASONS = Object.freeze([
  Object.freeze({ reasonCode: "game_path_missing_smapi", source: "tools/run-stardew-action-gates-batch.mjs" }),
  Object.freeze({ reasonCode: "multiplayer_gate_smapi_missing", source: "tools/run-stardew-multiplayer-gate.mjs" }),
  Object.freeze({ reasonCode: "multiplayer_gate_release_missing", source: "tools/run-stardew-multiplayer-gate.mjs" }),
]);

/**
 * The four ladder scenarios, for the release cadence.
 *
 * A read-only mirror of `tools/live-run/game/launch-ladder-live.mjs`'s own `SCENARIOS`: that file
 * launches a real game at module scope, so it cannot be imported. The offline suite reads it as text
 * and compares, and a rename fails closed from BOTH sides - this driver refuses a scenario the
 * launcher no longer knows (`unknown_scenario:<name>`), and the launcher refuses one this list does
 * not know yet (the b3 row is then `cadence_block_verdict_missing`, with the launcher's own
 * `unknown_run_scenario:...` text in the block's log).
 */
export const LADDER_SCENARIOS = Object.freeze([
  "morning_routine",
  "memory_covenant",
  "npc_social_and_presence",
  "multiday_routine",
]);

/** Both shared-world actions, from the gate's own table rather than a second copy of it. */
const SHARED_WORLD_ACTIONS = Object.freeze(Object.keys(MULTIPLAYER_GATE_ACTIONS));

/**
 * The published gates the B2 block judges, and the actions this pass hands to its B4 block.
 *
 * Both tables are READ, never copied: `STARDEW_PUBLISHED_ACTION_GATES` is the published surface
 * (the same authority the batch, the promotion gate and the shared-world gate read) and
 * `MULTIPLAYER_GATE_ACTIONS` is the shared-world lane's own list of the actions it can start.
 * A table that names an action the other does not, or a split that leaves B2 nothing to judge, is
 * a refusal by name — never a silently smaller scope.
 */
export function resolveActionGateScope({
  published = STARDEW_PUBLISHED_ACTION_GATES,
  sharedWorld = SHARED_WORLD_ACTIONS,
} = {}) {
  const publishedIds = new Set(published.map((gate) => gate.actionId));
  for (const actionId of sharedWorld)
    if (!publishedIds.has(actionId)) throw new Error(`shared_world_action_not_published:${actionId}`);
  const judged = published.map((gate) => gate.actionId).filter((actionId) => !sharedWorld.includes(actionId));
  if (judged.length === 0) throw new Error("action_gate_scope_empty");
  return Object.freeze({ judged: Object.freeze(judged), ownedElsewhere: Object.freeze([...sharedWorld]) });
}

/**
 * The published actions no block of THIS pass judges.
 *
 * `resolveActionGateScope` splits the published surface by which lane owns each action; this names
 * what that split leaves unrun in the cadence being run. The plan's cadence table makes B4
 * release-only, so a nightly pass judges 89 of the 91 published actions and the two B4 owns are
 * simply not asked that night. That is the plan's own cadence — but it has to be written down, or a
 * nightly green reads as "the whole published surface still opens" when two of its actions were
 * never run at all (§7: absence is never a pass).
 */
export function actionsNotJudgedByCadence(blocks, scope) {
  const judged = [];
  if (blocks.includes("b2_action_gates")) judged.push(...scope.judged);
  if (blocks.includes("b4_shared_world")) judged.push(...scope.ownedElsewhere);
  return Object.freeze([...scope.judged, ...scope.ownedElsewhere].filter((actionId) => !judged.includes(actionId)));
}

/**
 * The blocks this driver composes: the ONE existing entry, the code a block is named by when
 * it reports no code of its own, and this driver's harness bound for it.
 *
 * A bound is the block's own budget plus what launching and tearing it down cost, never a
 * product verdict (§7: a harness timeout is a harness failure).
 */
export const BLOCK_ENTRIES = Object.freeze({
  b2_action_gates: Object.freeze({
    entry: "tools/run-stardew-action-gates-batch.mjs",
    failureCode: "action_gate_pass_not_passed",
    // One launch per published action; §3 calls a full pass "an overnight job", so the bound is one night.
    timeoutMs: 8 * 60 * 60 * 1000,
  }),
  b3_companion_session: Object.freeze({
    entry: "tools/live-run/game/launch-ladder-live.mjs",
    failureCode: "companion_session_not_passed",
    // The ladder's own run budget (600 s default, 4 h multi-day) plus arming, SMAPI readiness and restore.
    timeoutMs: (4 * 60 + 30) * 60 * 1000,
  }),
  b4_shared_world: Object.freeze({
    entry: "tools/run-stardew-multiplayer-gate.mjs",
    failureCode: "shared_world_gate_not_passed",
    // The gate's own ceiling (`--timeout-seconds` max 900) plus its driver child's `(timeout + 60)` bound.
    timeoutMs: (900 + 60 + 180) * 1000,
  }),
});

/** Which blocks each cadence runs, in the plan's own block order (§3). */
export const CADENCE_BLOCKS = Object.freeze({
  nightly: Object.freeze(["b2_action_gates", "b3_companion_session"]),
  release: Object.freeze(["b2_action_gates", "b3_companion_session", "b4_shared_world"]),
});

/** The plan's other blocks, named with the reason they are not part of a cadence pass. */
export const BLOCKS_NOT_IN_CADENCE = Object.freeze([
  Object.freeze({ block: "b1_offline_gates", reason: "ci_per_change" }),
  Object.freeze({ block: "b5_game_surface", reason: "publishes_computed_facts_and_named_skips_not_a_verdict" }),
  Object.freeze({
    block: "b6_lifecycle_cold_session",
    reason: "fixture_transaction_owned_by_the_launcher_not_the_block",
  }),
]);

const ARGUMENTS = Object.freeze([
  "--cadence",
  "--blocks",
  "--only",
  "--game-path",
  "--mods-path",
  "--save-name",
  "--fixture-root",
  "--release-dir",
  "--scenario",
  "--expected-farmhand-id",
  "--run-dir",
  "--window-mode",
]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonRecord(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  try {
    const value = JSON.parse(text);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

function readJsonRecord(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  return parseJsonRecord(text);
}

/** The block's own published `{state, reasonCode}` pair, or null when it published neither. */
function recordedVerdict(record) {
  if (!isPlainObject(record) || typeof record.state !== "string") return null;
  return Object.freeze({
    state: record.state,
    reasonCode: typeof record.reasonCode === "string" && record.reasonCode.length > 0 ? record.reasonCode : null,
  });
}

/**
 * The LAST record on stdout that `matches`, or null.
 *
 * The same backwards scan `tools/run-stardew-multiplayer-gate.mjs` uses on its driver's output:
 * a PowerShell host may prefix a block's single JSON record with warnings, so the record is
 * looked up rather than assumed to be the first line.
 */
export function lastJsonRecord(stdout, matches = () => true) {
  const lines = String(stdout ?? "").split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trim();
    if (!line.startsWith("{")) continue;
    const record = parseJsonRecord(line);
    if (record !== null && matches(record)) return record;
  }
  return null;
}

/**
 * The result path `launch-ladder-live.mjs` publishes on its own stdout (`result: <path>`).
 *
 * Read from the line rather than reconstructed from the `--label` this driver passed: the
 * launcher owns its artifact naming, and a second copy of that convention here would be a
 * guess that goes stale silently.
 */
export function publishedResultPath(stdout) {
  const lines = String(stdout ?? "").split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index--) {
    const match = /^result:\s*(.+)$/u.exec(lines[index].trim());
    if (match !== null && match[1].trim().length > 0) return match[1].trim();
  }
  return null;
}

/**
 * One block's own verdict, from what its authority published and nothing else.
 *
 * `resultPath` is where the b3 launcher said its runner wrote the result; b2 and b4 publish
 * on stdout. A block whose authority published nothing readable returns null, and a null
 * verdict is `missing`, never a pass.
 */
export function readBlockVerdict({ block, stdout, resultPath = null }) {
  if (block === "b2_action_gates")
    return recordedVerdict(lastJsonRecord(stdout, (record) => record.schema === ACTION_GATE_BATCH_SCHEMA));
  if (block === "b4_shared_world")
    return recordedVerdict(lastJsonRecord(stdout, (record) => typeof record.state === "string"));
  if (block === "b3_companion_session") return recordedVerdict(resultPath === null ? null : readJsonRecord(resultPath));
  return null;
}

/**
 * One block's outcome from its exit code and its authority's verdict.
 *
 * The order is the fail-closed part: a harness timeout is read first (its teardown never ran),
 * then the block's own verdict, then the exit code. A block that reports a pass but exits
 * non-zero is a contradiction and is blocked, not believed.
 */
export function classifyBlock({ failureCode, timedOut, exitCode, verdict }) {
  if (timedOut === true)
    return Object.freeze({ state: "blocked", reasonCode: "cadence_block_timeout", blockReasonCode: null });
  if (verdict === null)
    return Object.freeze({ state: "blocked", reasonCode: "cadence_block_verdict_missing", blockReasonCode: null });
  if (verdict.state !== "passed")
    return Object.freeze({
      state: "blocked",
      reasonCode: verdict.reasonCode ?? failureCode,
      blockReasonCode: verdict.reasonCode,
    });
  if (exitCode !== 0)
    return Object.freeze({
      state: "blocked",
      reasonCode: `cadence_block_exit:${exitCode ?? "none"}`,
      blockReasonCode: verdict.reasonCode,
    });
  return Object.freeze({ state: "passed", reasonCode: "cadence_block_passed", blockReasonCode: verdict.reasonCode });
}

/** Whether a block's OWN published reason code means this machine cannot host the block. */
export function isMachineCannotHostReason(reasonCode) {
  return MACHINE_CANNOT_HOST_REASONS.some((entry) => entry.reasonCode === reasonCode);
}

/**
 * The bounded, typed argument set this entry accepts; `--blocks` and `--only` are repeatable.
 *
 * Split by what each refusal is about - the argv scan, the cadence and its blocks, the inputs a
 * block requires, the shared paths and the save slot - so every refusal is one named code in one
 * place instead of one long ladder.
 */
export function parseCadenceArgs(argv = [], env = process.env) {
  const { values, blocks, only } = scanCadenceArgv(argv);
  const cadence = values.get("--cadence");
  if (cadence === undefined) throw new Error("cadence_required");
  if (!Object.hasOwn(CADENCE_BLOCKS, cadence)) throw new Error(`unknown_cadence:${cadence}`);
  const selected = selectCadenceBlocks({ cadence, blocks });
  const paths = readCadencePaths({ values, env });
  const saveName = readSaveName(values);
  const { scenario, expectedFarmhandId } = readBlockInputs({ cadence, selected, values });

  // Every `--only` is the B2 block's own `--only`, so it is validated by the B2 block's own
  // selector rather than by a second copy of the gate table.
  if (only.length > 0) {
    if (!selected.includes("b2_action_gates")) throw new Error("only_requires_action_gates_block");
    selectGates(only);
  }

  return Object.freeze({
    cadence,
    blocks: selected,
    only: Object.freeze(only),
    actionGateScope: resolveActionGateScope(),
    saveName,
    ...paths,
    scenario,
    expectedFarmhandId,
    windowMode: normalizeLiveRunWindowMode(values.get("--window-mode") ?? "hidden"),
  });
}

/** One argv scan: the single-valued flags, and the two repeatable ones, refused by name. */
function scanCadenceArgv(argv) {
  const values = new Map();
  const blocks = [];
  const only = [];
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (!ARGUMENTS.includes(key)) throw new Error(`invalid_cadence_argument:${String(key)}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`missing_cadence_argument_value:${key.slice(2)}`);
    if (key === "--blocks" || key === "--only") {
      (key === "--blocks" ? blocks : only).push(value);
      index++;
      continue;
    }
    if (values.has(key)) throw new Error(`invalid_cadence_argument:${key}`);
    values.set(key, value);
    index++;
  }
  return Object.freeze({ values, blocks, only });
}

/**
 * The inputs a block requires, read from the blocks this pass will actually run: the nightly
 * cadence's B3 block runs the one scenario named here, and a release pass's B4 block binds to the
 * farmhand identity named here.
 */
function readBlockInputs({ cadence, selected, values }) {
  const scenario = values.get("--scenario");
  if (cadence === "nightly" && selected.includes("b3_companion_session") && scenario === undefined)
    throw new Error("scenario_required");
  if (scenario !== undefined && !LADDER_SCENARIOS.includes(scenario)) throw new Error(`unknown_scenario:${scenario}`);
  const expectedFarmhandId = values.get("--expected-farmhand-id");
  if (selected.includes("b4_shared_world") && expectedFarmhandId === undefined)
    throw new Error("expected_farmhand_id_required");
  return Object.freeze({ scenario: scenario ?? null, expectedFarmhandId: expectedFarmhandId ?? null });
}

/** The paths every block is handed, each in the absolute form its own entry requires. */
function readCadencePaths({ values, env }) {
  const gamePath = values.get("--game-path") ?? env?.[GAME_PATH_ENV];
  if (typeof gamePath !== "string" || gamePath.length === 0) throw new Error(`game_path_required:${GAME_PATH_ENV}`);
  const modsPath = values.get("--mods-path");
  if (modsPath === undefined) throw new Error("mods_path_required");
  const runId = randomUUID();
  const paths = [
    ["game_path", gamePath],
    ["mods_path", modsPath],
    ["fixture_root", values.get("--fixture-root") ?? resolveStardewFixtureRoots({ env }).fixturesRoot],
    ["release_dir", values.get("--release-dir") ?? DEFAULT_RELEASE_DIR],
    ["run_dir", values.get("--run-dir") ?? join(tmpdir(), `gamebuddy-stardew-automation-cadence-${runId}`)],
  ];
  for (const [name, value] of paths) {
    if (!isAbsolute(value)) throw new Error(`invalid_${name}`);
  }
  return Object.freeze({
    gamePath,
    modsPath,
    fixtureRoot: paths[2][1],
    releaseDir: paths[3][1],
    runDir: paths[4][1],
    runId,
  });
}

/** The one save slot a pass runs: the B2 block's own observed shape, refused by name otherwise. */
function readSaveName(values) {
  const saveName = values.get("--save-name");
  if (saveName === undefined) throw new Error("save_name_required");
  if (!SAVE_SLOT.test(saveName)) throw new Error("invalid_save_name");
  return saveName;
}

/** The cadence's blocks, narrowed by `--blocks` and checked against the cadence that owns them. */
function selectCadenceBlocks({ cadence, blocks }) {
  if (blocks.length === 0) return CADENCE_BLOCKS[cadence];
  const selected = [];
  for (const block of blocks) {
    if (!CADENCE_BLOCKS[cadence].includes(block)) throw new Error(`block_not_in_cadence:${cadence}:${block}`);
    if (selected.includes(block)) throw new Error(`duplicate_cadence_block:${block}`);
    selected.push(block);
  }
  return Object.freeze(selected);
}

/**
 * The pass's ordered steps: one per block, and one per target the block runs within it.
 *
 * The release cadence runs every ladder scenario and both shared-world actions (§3's table);
 * the nightly cadence runs the one scenario the operator names.
 */
export function planCadence(blocks, request) {
  const steps = [];
  for (const block of blocks) {
    if (block === "b3_companion_session") {
      const scenarios = request.cadence === "release" ? LADDER_SCENARIOS : [request.scenario];
      for (const scenario of scenarios) steps.push(Object.freeze({ block, target: scenario }));
      continue;
    }
    if (block === "b4_shared_world") {
      for (const action of SHARED_WORLD_ACTIONS) steps.push(Object.freeze({ block, target: action }));
      continue;
    }
    steps.push(Object.freeze({ block, target: null }));
  }
  return Object.freeze(steps);
}

/**
 * One step's invocation: the entry's own flags, and the environment its entry reads instead of
 * a flag. Only the ladder takes window mode from the environment (`GAMEBUDDY_LADDER_WINDOW_MODE`);
 * the two Node entries take it as an argument.
 */
export function buildBlockInvocation({ block, target, request, runDir }) {
  const entry = resolve(REPOSITORY_ROOT, BLOCK_ENTRIES[block].entry);
  if (block === "b2_action_gates")
    return Object.freeze({
      args: Object.freeze([
        entry,
        "--game-path",
        request.gamePath,
        "--mods-path",
        request.modsPath,
        "--save-name",
        request.saveName,
        "--fixture-root",
        request.fixtureRoot,
        "--release-dir",
        request.releaseDir,
        "--run-dir",
        join(runDir, "b2-action-gates"),
        "--window-mode",
        request.windowMode,
        // The operator's own list when they narrowed the pass - the batch's documented way to say
        // "this red is known and intended" - otherwise the derived scope above.
        ...(request.only.length > 0 ? request.only : request.actionGateScope.judged).flatMap((actionId) => [
          "--only",
          actionId,
        ]),
      ]),
      env: Object.freeze({}),
    });
  if (block === "b3_companion_session")
    return Object.freeze({
      args: Object.freeze([
        entry,
        "--scenario",
        target,
        "--game",
        request.gamePath,
        "--mods",
        request.modsPath,
        "--save",
        request.saveName,
        "--root",
        request.fixtureRoot,
        "--release",
        request.releaseDir,
        "--label",
        request.label,
      ]),
      env: Object.freeze({ GAMEBUDDY_LADDER_WINDOW_MODE: request.windowMode }),
    });
  if (block === "b4_shared_world")
    return Object.freeze({
      args: Object.freeze([
        entry,
        "--game-path",
        request.gamePath,
        "--expected-farmhand-id",
        request.expectedFarmhandId,
        "--save-name",
        request.saveName,
        "--action",
        target,
        "--release-dir",
        request.releaseDir,
        "--run-root",
        join(runDir, "b4-shared-world", target),
        "--result-file",
        join(runDir, "b4-shared-world", target, "driver-result.json"),
        "--keep-run-root",
      ]),
      env: Object.freeze({}),
    });
  throw new Error(`unknown_cadence_block:${block}`);
}

/**
 * The selected blocks whose entry file is not wired: a structural refusal, checked before
 * anything is launched, so a half-wired pass can never report success.
 */
export function missingBlockEntries(blocks, { exists = existsSync, repositoryRoot = REPOSITORY_ROOT } = {}) {
  return Object.freeze(blocks.filter((block) => !exists(resolve(repositoryRoot, BLOCK_ENTRIES[block].entry))));
}

/** One block's child: bounded by its own harness bound, killed by its own pid tree on expiry. */
function runBlockChild({ args, env, timeoutMs }) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, args, {
      cwd: REPOSITORY_ROOT,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    const stdout = [];
    const stderr = [];
    let timer = null;
    let settled = false;
    const finish = (exitCode, timedOut) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ exitCode, timedOut, stdout: stdout.join(""), stderr: stderr.join("") });
    };
    timer = setTimeout(() => {
      try {
        killProcessTree(child.pid);
      } catch {
        // The block's own tree could not be reclaimed; the run directory keeps the output and
        // the row still reports the harness failure, which is the fact that matters.
      }
      finish(null, true);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    child.on("error", () => finish(null, false));
    child.on("close", (code) => finish(code, false));
  });
}

function countStates(rows) {
  const counts = { total: rows.length, passed: 0, blocked: 0 };
  for (const row of rows) counts[row.state] += 1;
  return Object.freeze(counts);
}

/** The frozen rollup a refused pass publishes: no block ran, and nothing is faked as passed. */
function refusedRollup({ reasonCode, cadence, runId, runDir, actionGateScope }) {
  return Object.freeze({
    schema: CADENCE_SCHEMA,
    cadence,
    state: "blocked",
    reasonCode,
    runId,
    runDir,
    actionGateScope,
    rows: Object.freeze([]),
    counts: Object.freeze({ total: 0, passed: 0, blocked: 0 }),
    failedBlocks: Object.freeze([]),
    unavailableBlocks: Object.freeze([]),
    blocksNotInCadence: BLOCKS_NOT_IN_CADENCE,
  });
}

/**
 * The whole pass: one ordered step per block target, one rollup.
 *
 * `runBlock` and `entryExists` are the injection seams this slice's offline suite drives; the CLI
 * never passes them, so the CLI always runs the production entries against the real filesystem.
 */
export async function runCadence({
  argv = [],
  env = process.env,
  runBlock,
  entryExists = existsSync,
  log = () => {},
} = {}) {
  const request = parseCadenceArgs(argv, env);
  const steps = planCadence(request.blocks, request);
  mkdirSync(request.runDir, { recursive: true });
  // The B2 block's result files must live under a directory whose canonical path is itself
  // (its launcher refuses a parent `realpath` changes), so the run directory is canonicalised
  // once, here, for every block.
  const runDir = realpathSync(request.runDir);
  log(`[stardew-automation-cadence] cadence=${request.cadence} blocks=${request.blocks.join(",")} runDir=${runDir}`);
  // What this pass judges, and what it does not: the split of the published surface by lane, plus
  // the actions this cadence runs no block for at all.
  const actionGateScope = Object.freeze({
    ...request.actionGateScope,
    notInThisCadence: actionsNotJudgedByCadence(request.blocks, request.actionGateScope),
  });
  if (actionGateScope.notInThisCadence.length > 0)
    log(`[stardew-automation-cadence] not judged by this cadence: ${actionGateScope.notInThisCadence.join(",")}`);

  // A block whose entry is not wired refuses the pass before any of it runs: a pass that skipped
  // the missing block and reported the rest as green would be absence-as-pass (§7).
  const missing = missingBlockEntries(request.blocks, { exists: entryExists });
  if (missing.length > 0)
    return {
      rollup: refusedRollup({
        reasonCode: `cadence_block_entry_missing:${missing[0]}`,
        cadence: request.cadence,
        runId: request.runId,
        runDir,
        actionGateScope,
      }),
      exitCode: 2,
    };

  const rows = [];
  const launch = runBlock ?? runBlockChild;
  for (const [index, step] of steps.entries()) {
    const failureCode = BLOCK_ENTRIES[step.block].failureCode;
    const label = `${request.runId.slice(0, 8)}-${index}`;
    const invocation = buildBlockInvocation({
      block: step.block,
      target: step.target,
      request: { ...request, label },
      runDir,
    });
    const outcome = await launch({
      block: step.block,
      target: step.target,
      args: invocation.args,
      env: invocation.env,
      timeoutMs: BLOCK_ENTRIES[step.block].timeoutMs,
    });
    const stdout = String(outcome.stdout ?? "");
    const stderr = String(outcome.stderr ?? "");
    writeFileSync(
      join(runDir, `${step.block}${step.target === null ? "" : `-${step.target}`}.log`),
      `${stdout}${stderr}`,
      "utf8",
    );
    const classified = classifyBlock({
      failureCode,
      timedOut: outcome.timedOut,
      exitCode: outcome.exitCode,
      verdict: readBlockVerdict({ block: step.block, stdout, resultPath: publishedResultPath(stdout) }),
    });
    const row = Object.freeze({
      block: step.block,
      target: step.target,
      state: classified.state,
      reasonCode: classified.reasonCode,
      blockReasonCode: classified.blockReasonCode,
    });
    rows.push(row);
    log(`${step.block}${step.target === null ? "" : `:${step.target}`}: ${row.state} (${row.reasonCode})`);
  }

  const failedBlocks = Object.freeze(
    rows
      .filter((row) => row.state !== "passed")
      .map((row) => Object.freeze({ block: row.block, target: row.target, reasonCode: row.reasonCode })),
  );
  // The host-refused subset of the failures: rows whose OWN block code says this machine cannot host
  // the block. A row is still `blocked` (it did not pass); what this splits out is the RUN's verdict,
  // so "no game here" and "the product failed" no longer read the same `blocked`.
  const unavailableBlocks = Object.freeze(
    rows
      .filter((row) => row.state !== "passed" && isMachineCannotHostReason(row.blockReasonCode))
      .map((row) => Object.freeze({ block: row.block, target: row.target, reasonCode: row.blockReasonCode })),
  );
  const first = failedBlocks[0];
  const firstUnavailable = unavailableBlocks[0];
  if (firstUnavailable !== undefined)
    log(
      `[stardew-automation-cadence] unavailable: this runner cannot host ${firstUnavailable.block}${
        firstUnavailable.target === null ? "" : `:${firstUnavailable.target}`
      } (${firstUnavailable.reasonCode})`,
    );
  return {
    rollup: Object.freeze({
      schema: CADENCE_SCHEMA,
      cadence: request.cadence,
      state: unavailableBlocks.length > 0 ? "unavailable" : failedBlocks.length === 0 ? "passed" : "blocked",
      reasonCode:
        firstUnavailable !== undefined
          ? `cadence_block_unavailable:${firstUnavailable.block}${firstUnavailable.target === null ? "" : `:${firstUnavailable.target}`}`
          : first === undefined
            ? "cadence_passed"
            : `cadence_block_not_passed:${first.block}${first.target === null ? "" : `:${first.target}`}`,
      runId: request.runId,
      runDir,
      actionGateScope,
      rows: Object.freeze(rows),
      counts: countStates(rows),
      failedBlocks,
      unavailableBlocks,
      blocksNotInCadence: BLOCKS_NOT_IN_CADENCE,
    }),
    // A run that could not be hosted is still not a pass: the exit code is non-zero either way.
    exitCode: failedBlocks.length === 0 ? 0 : 2,
  };
}

if (import.meta.main) {
  try {
    const { rollup, exitCode } = await runCadence({
      argv: process.argv.slice(2),
      log: (line) => process.stderr.write(`${line}\n`),
    });
    process.stdout.write(`${JSON.stringify(rollup)}\n`);
    process.exitCode = exitCode;
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ schema: CADENCE_SCHEMA, state: "blocked", reasonCode: String(error?.message ?? error) })}\n`,
    );
    process.exitCode = 1;
  }
}
