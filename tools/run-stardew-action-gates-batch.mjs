#!/usr/bin/env node
/**
 * One repeatable pass over the published-action native-local gate table.
 *
 * WHY THIS EXISTS (`.pi/tools/game-automation-plan.md` §3 B2 / §5 G1 / §6 slice 1)
 * -------------------------------------------------------------------------------
 * Every published action already has its own live gate, and each one is a
 * separate operator invocation of `tools/run-stardew-native-local-player-move-fixture.ps1
 * -Action <id>`: only the invocation was manual, so nothing ran them together and
 * nothing rolled the outcomes into one record. This driver is that loop, and it
 * does nothing else:
 *
 *   * it never re-implements a runner's postcondition, fixture or assertion. Each
 *     action still runs through the ONE existing launcher and the ONE existing
 *     per-action runner the gate table names, and this driver judges the run only
 *     by what those two already publish: the launcher's single lifecycle result,
 *     the runner's own verdict, and the launcher's exit code;
 *   * before it launches anything it re-runs the two EXISTING runner-can-open gates
 *     (`audit:stardew-native-local-runner-contract`, `test:stardew-native-local-runner-fixture-contract`)
 *     and refuses the whole batch if either fails;
 *   * it fails closed. A gate with no runner verdict, no lifecycle result, a failed
 *     lifecycle phase, a non-passing verdict, a non-zero exit or a harness timeout
 *     is never a pass.
 *
 * THE ONE ROLLUP
 * --------------
 * One row per action - `{actionId, state, reasonCode, terminalReasonCode, lifecycleState}`
 * - plus the batch verdict. `terminalReasonCode` is the gate table's REGISTERED
 * terminal for that action, i.e. the code the runner asserts; it is deliberately
 * not read out of the runner, because a runner's result shape is the runner's own
 * business and guessing at it here is how an orchestrator starts re-implementing
 * the thing it is orchestrating.
 *
 * WHAT IT DOES NOT COVER
 * ----------------------
 * The table contains `send_multiplayer_chat` and `talk_to_npc`, whose proof belongs
 * to the shared-world lane (`tools/run-stardew-multiplayer-gate.mjs`): a
 * single-player fixture cannot exhibit their native seam, so a full pass is expected
 * to name those two as not-passed. They are reported, not exempted - scope a pass
 * with `--only` when the red is known and intended.
 *
 * A timeout is a HARNESS failure, never a product verdict, and it is never retried:
 * the launcher is killed by its own pid tree, which means its pinned teardown never
 * ran. The fixture transaction is then left for the operator, and the run directory
 * (reported in the rollup) keeps the launcher output of every action.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveStardewFixtureRoots } from "./lib/stardew-fixture-roots.mjs";
import { normalizeLiveRunWindowMode } from "./lib/stardew-live-run.mjs";
import { STARDEW_PUBLISHED_ACTION_GATES } from "./stardew-action-gate-descriptors.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = join(REPOSITORY_ROOT, "tools", "run-stardew-native-local-player-move-fixture.ps1");
const DEFAULT_RELEASE_DIR = join(REPOSITORY_ROOT, "integrations", "stardew", "bin", "Release", "net6.0");
export const BATCH_SCHEMA = "gamebuddy-stardew-action-gate-batch/v1";
/** Read-only mirror of the launcher's own record schema (`integrations/stardew/action-development/src/write-lifecycle-result.mjs`). */
export const LIFECYCLE_RESULT_SCHEMA = "gamebuddy-stardew-closure-backend-result/v1";
const GAME_PATH_ENV = "GAMEBUDDY_STARDEW_GAME_PATH";
const EQUIP_TOOL_ACTION_ID = "equip_tool";
/** The launcher's own observed-slot contract for a disposable action run. */
const OBSERVED_SAVE_SLOT = /^GameBuddyFixture[A-Za-z0-9]{0,64}_[0-9]{1,32}$/u;
/**
 * The launcher's `-TimeoutSeconds` bounds pipe readiness only, so the batch's own
 * wall clock has to carry the action, its terminal wait and the pinned teardown
 * order beyond it. It is a harness deadline: expiry is a harness failure.
 */
const ACTION_AND_TEARDOWN_GRACE_SECONDS = 120;
const ARGUMENTS = Object.freeze([
  "--game-path",
  "--mods-path",
  "--save-name",
  "--template-name",
  "--fixture-root",
  "--release-dir",
  "--run-dir",
  "--timeout-seconds",
  "--window-mode",
]);
/**
 * The two existing runner-can-open gates, reused rather than re-implemented
 * (`package.json` owns the commands; the test pins that this list cannot drift
 * from them). One is a static ratchet over the runner source, the other feeds each
 * runner the policy block the fixture actually writes.
 */
export const RUNNER_CAN_OPEN_GATES = Object.freeze([
  Object.freeze({
    name: "runner_contract_audit",
    nodeArguments: Object.freeze(["tools/audit-stardew-native-local-runner-contract.mjs"]),
  }),
  Object.freeze({
    name: "runner_fixture_contract",
    nodeArguments: Object.freeze(["--test", "tools/stardew-native-local-runner-fixture-contract.test.mjs"]),
  }),
]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonRecord(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return isPlainObject(value) ? value : null;
}

function readJsonRecord(path) {
  return parseJsonRecord(readTextFile(path));
}

function readTextFile(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * The runner's own verdict: the smoke runners report `state`, the `equip_tool`
 * package child reports `verdict`. Anything else is not a verdict.
 */
function observedVerdict(record) {
  if (!isPlainObject(record)) return null;
  if (typeof record.state === "string") return record.state;
  if (typeof record.verdict === "string") return record.verdict;
  return null;
}

/**
 * The LAST record on the launcher's stdout that carries a verdict.
 *
 * The generic launcher branch runs the smoke runner as a child over an inherited
 * stdout, so the runner's one-line result is the last such record; PowerShell may
 * prefix warnings and the launcher prints a window-evidence record afterwards that
 * carries no verdict. Same rule as `tools/_ladder-live-orchestrator.mjs` and
 * `tools/run-stardew-multiplayer-gate.mjs`.
 */
export function parseRunnerResult(stdout) {
  const lines = String(stdout ?? "").split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trim();
    if (!line.startsWith("{")) continue;
    const verdict = observedVerdict(parseJsonRecord(line));
    if (verdict !== null) return Object.freeze({ verdict });
  }
  return null;
}

/**
 * The runner verdict of one gate, from the per-action result file when the runner
 * wrote one (`equip_tool`'s package child writes a private scenario result and
 * prints nothing) and otherwise from the launcher's stdout.
 */
export function readRunnerResult({ resultFile, stdout }) {
  const fromFile = observedVerdict(readJsonRecord(resultFile));
  return fromFile === null ? parseRunnerResult(stdout) : Object.freeze({ verdict: fromFile });
}

/** The launcher's single terminal lifecycle result, or null when absent/unreadable. */
export function parseLifecycleResult(text) {
  const record = parseJsonRecord(text);
  if (record === null || record.schema !== LIFECYCLE_RESULT_SCHEMA) return null;
  if (record.state === "completed") return Object.freeze({ state: "completed" });
  if (record.state === "failed" && typeof record.phase === "string" && record.phase.length > 0)
    return Object.freeze({ state: "failed", phase: record.phase });
  return null;
}

/**
 * One gate's outcome from the launcher's exit code, its lifecycle result and the
 * runner's verdict. The order is the fail-closed part of this driver: the
 * launcher's own terminal record is the most specific evidence and is read first,
 * and a gate missing either half of its evidence is `missing`, never a pass.
 */
export function classifyGate({ timedOut, exitCode, verdict, lifecycle }) {
  const lifecycleState = lifecycle === null ? "missing" : lifecycle.state;
  if (timedOut === true) return Object.freeze({ state: "blocked", reasonCode: "gate_timeout", lifecycleState });
  if (lifecycle !== null && lifecycle.state === "failed")
    return Object.freeze({
      state: "blocked",
      reasonCode: `gate_lifecycle_failed:${lifecycle.phase}`,
      lifecycleState: "failed",
    });
  if (verdict === null) return Object.freeze({ state: "missing", reasonCode: "gate_result_missing", lifecycleState });
  if (lifecycle === null)
    return Object.freeze({ state: "missing", reasonCode: "gate_lifecycle_result_missing", lifecycleState });
  if (verdict !== "passed")
    return Object.freeze({ state: "blocked", reasonCode: "gate_result_not_passed", lifecycleState });
  if (exitCode !== 0)
    return Object.freeze({
      state: "blocked",
      reasonCode: `gate_launcher_failed:${exitCode ?? "none"}`,
      lifecycleState,
    });
  return Object.freeze({ state: "passed", reasonCode: "gate_passed", lifecycleState });
}

/**
 * The launcher invocation for one action. Every parameter below is a mandatory
 * parameter of `tools/run-stardew-native-local-player-move-fixture.ps1` except
 * `-ScenarioIdentity`, which its `equip_tool` branch requires and no other branch
 * reads.
 */
export function buildLauncherArgs({ request, actionId, resultFile, lifecycleResultFile, scenarioIdentity }) {
  return Object.freeze([
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    LAUNCHER,
    "-GamePath",
    request.gamePath,
    "-ModsPath",
    request.modsPath,
    "-FixtureRoot",
    request.fixtureRoot,
    "-SaveName",
    request.saveName,
    "-TemplateName",
    request.templateName,
    "-ReleaseDir",
    request.releaseDir,
    "-ResultFile",
    resultFile,
    "-LifecycleResultFile",
    lifecycleResultFile,
    "-Action",
    actionId,
    "-WindowMode",
    request.windowMode,
    "-TimeoutSeconds",
    String(request.timeoutSeconds),
    ...(scenarioIdentity === null ? [] : ["-ScenarioIdentity", scenarioIdentity]),
  ]);
}

/**
 * The `equip_tool` branch's scenario identity.
 *
 * Its runner is a PACKAGE child that writes a private scenario result instead of
 * printing one, and it is handed this identity verbatim. The action-development
 * lane mints one from its own target profile; this driver holds no target profile,
 * so it mints the identity it truthfully owns and labels the claim scope as its
 * own rather than borrowing a profile identity it does not have.
 */
function scenarioIdentity(runId) {
  return JSON.stringify({
    gameId: "stardew",
    actionId: EQUIP_TOOL_ACTION_ID,
    runId: `${runId}-${EQUIP_TOOL_ACTION_ID}`,
    stage: "run-live",
    profileIdentity: null,
    claimScope: "native-local-action-gate-batch-v1",
  });
}

/** The PowerShell 7 host. The launcher uses `[IO.Path]::IsPathFullyQualified`, absent from 5.1. */
function resolvePowerShell() {
  const probe = spawnSync("where.exe", ["pwsh"], { encoding: "utf8", windowsHide: true });
  if (probe.status !== 0) throw new Error("pwsh_required");
  return "pwsh";
}

/** Kill the launcher and every process it owns. A launcher-owned tree only, by its own pid. */
function killProcessTree(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
}

function runLauncherChild({ command, args, timeoutMs }) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd: REPOSITORY_ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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
      killProcessTree(child.pid);
      finish(null, true);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    child.on("error", () => finish(null, false));
    child.on("close", (code) => finish(code, false));
  });
}

/** The real per-action gate: one bounded launch of the one existing launcher. */
function createLauncherGate({ request }) {
  if (process.platform !== "win32") throw new Error("stardew_action_gate_batch_windows_only");
  const powerShell = resolvePowerShell();
  const timeoutMs = (request.timeoutSeconds + ACTION_AND_TEARDOWN_GRACE_SECONDS) * 1_000;
  return ({ actionId, resultFile, lifecycleResultFile, scenarioIdentity: identity }) =>
    runLauncherChild({
      command: powerShell,
      args: buildLauncherArgs({ request, actionId, resultFile, lifecycleResultFile, scenarioIdentity: identity }),
      timeoutMs,
    });
}

/** Run the two existing runner-can-open gates, on this process' own node. */
function runRunnerCanOpenGates() {
  return RUNNER_CAN_OPEN_GATES.map((gate) => {
    const run = spawnSync(process.execPath, [...gate.nodeArguments], {
      cwd: REPOSITORY_ROOT,
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return Object.freeze({ name: gate.name, exitCode: run.status });
  });
}

/** The published gates a pass runs, in the order asked for. */
export function selectGates(only) {
  if (only.length === 0) return STARDEW_PUBLISHED_ACTION_GATES;
  const selected = [];
  for (const actionId of only) {
    const gate = STARDEW_PUBLISHED_ACTION_GATES.find((candidate) => candidate.actionId === actionId);
    if (gate === undefined) throw new Error(`unknown_gate_action:${actionId}`);
    if (selected.includes(gate)) throw new Error(`duplicate_gate_action:${actionId}`);
    selected.push(gate);
  }
  return Object.freeze(selected);
}

/** The bounded, typed argument set this entry accepts; `--only` is repeatable. */
export function parseBatchArgs(argv = [], env = process.env) {
  const values = new Map();
  const only = [];
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (key !== "--only" && !ARGUMENTS.includes(key)) throw new Error(`invalid_batch_argument:${String(key)}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing_batch_argument_value:${key.slice(2)}`);
    if (key === "--only") {
      only.push(value);
      index++;
      continue;
    }
    if (values.has(key)) throw new Error(`invalid_batch_argument:${key}`);
    values.set(key, value);
    index++;
  }

  const gamePath = values.get("--game-path") ?? env?.[GAME_PATH_ENV];
  if (typeof gamePath !== "string" || gamePath.length === 0) throw new Error(`game_path_required:${GAME_PATH_ENV}`);
  const modsPath = values.get("--mods-path");
  if (modsPath === undefined) throw new Error("mods_path_required");
  const saveName = values.get("--save-name");
  if (saveName === undefined) throw new Error("save_name_required");
  if (!OBSERVED_SAVE_SLOT.test(saveName)) throw new Error("invalid_save_name");

  const fixtureRoot = values.get("--fixture-root") ?? resolveStardewFixtureRoots({ env }).fixturesRoot;
  const releaseDir = values.get("--release-dir") ?? DEFAULT_RELEASE_DIR;
  const timeoutSeconds = Number(values.get("--timeout-seconds") ?? 120);
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 30 || timeoutSeconds > 300)
    throw new Error("invalid_timeout_seconds");
  const runId = randomUUID();
  const runDir = values.get("--run-dir") ?? join(tmpdir(), `gamebuddy-stardew-action-gate-batch-${runId}`);

  for (const [name, value] of [
    ["game_path", gamePath],
    ["mods_path", modsPath],
    ["fixture_root", fixtureRoot],
    ["release_dir", releaseDir],
    ["run_dir", runDir],
  ]) {
    if (!isAbsolute(value)) throw new Error(`invalid_${name}`);
  }
  if (!existsSync(join(gamePath, "StardewModdingAPI.exe"))) throw new Error("game_path_missing_smapi");

  return Object.freeze({
    gamePath,
    modsPath,
    fixtureRoot,
    releaseDir,
    saveName,
    templateName: values.get("--template-name") ?? saveName,
    timeoutSeconds,
    windowMode: normalizeLiveRunWindowMode(values.get("--window-mode") ?? "hidden"),
    runId,
    runDir,
    only: Object.freeze(only),
  });
}

function countStates(actions) {
  const counts = { total: actions.length, passed: 0, blocked: 0, missing: 0 };
  for (const row of actions) counts[row.state] += 1;
  return Object.freeze(counts);
}

function blockedRollup({ reasonCode, runDir }) {
  return Object.freeze({
    schema: BATCH_SCHEMA,
    state: "blocked",
    reasonCode,
    runDir,
    counts: Object.freeze({ total: 0, passed: 0, blocked: 0, missing: 0 }),
    actions: Object.freeze([]),
    failedActions: Object.freeze([]),
  });
}

/**
 * The whole pass: precheck, one gate per action, one rollup.
 *
 * `runGate` and `runPrecheck` are the injection seam this slice's offline test
 * drives; the CLI never passes them.
 */
export async function runBatch({ argv = [], env = process.env, runGate, runPrecheck, log = () => {} } = {}) {
  const request = parseBatchArgs(argv, env);
  const gates = selectGates(request.only);
  mkdirSync(request.runDir, { recursive: true });
  // Both per-action result files must live in a directory whose canonical path is
  // itself: the launcher's lifecycle writer and the equip_tool package child's
  // private-result writer both refuse a parent that `realpath` changes.
  const runDir = realpathSync(request.runDir);
  log(
    `[stardew-action-gate-batch] save=${request.saveName} fixtureRoot=${request.fixtureRoot} windowMode=${request.windowMode} timeoutSeconds=${request.timeoutSeconds} runDir=${runDir}`,
  );

  const precheck = await (runPrecheck ?? runRunnerCanOpenGates)();
  const refused = precheck.filter((entry) => entry.exitCode !== 0);
  if (refused.length > 0)
    return { rollup: blockedRollup({ reasonCode: `gate_precheck_failed:${refused[0].name}`, runDir }), exitCode: 2 };

  const gate = runGate ?? createLauncherGate({ request });
  const actions = [];
  for (const entry of gates) {
    const resultFile = join(runDir, `${entry.actionId}.result.json`);
    const lifecycleResultFile = join(runDir, `${entry.actionId}.lifecycle.json`);
    let outcome;
    try {
      outcome = await gate({
        actionId: entry.actionId,
        resultFile,
        lifecycleResultFile,
        scenarioIdentity: entry.actionId === EQUIP_TOOL_ACTION_ID ? scenarioIdentity(request.runId) : null,
      });
    } catch (error) {
      // One gate that cannot even be started must not abort the pass: its launcher
      // output is kept below and the row reports the missing evidence.
      outcome = { exitCode: null, timedOut: false, stdout: "", stderr: String(error?.message ?? error) };
    }
    const stdout = String(outcome.stdout ?? "");
    const stderr = String(outcome.stderr ?? "");
    writeFileSync(join(runDir, `${entry.actionId}.launcher.log`), `${stdout}${stderr}`, "utf8");
    const classified = classifyGate({
      timedOut: outcome.timedOut,
      exitCode: outcome.exitCode,
      verdict: readRunnerResult({ resultFile, stdout })?.verdict ?? null,
      lifecycle: parseLifecycleResult(readTextFile(lifecycleResultFile)),
    });
    const row = Object.freeze({
      actionId: entry.actionId,
      state: classified.state,
      reasonCode: classified.reasonCode,
      terminalReasonCode: entry.terminalReasonCode,
      lifecycleState: classified.lifecycleState,
    });
    actions.push(row);
    log(`${entry.actionId}: ${row.state} (${row.reasonCode})`);
  }

  const failedActions = Object.freeze(
    actions
      .filter((row) => row.state !== "passed")
      .map((row) => Object.freeze({ actionId: row.actionId, state: row.state, reasonCode: row.reasonCode })),
  );
  return {
    rollup: Object.freeze({
      schema: BATCH_SCHEMA,
      state: failedActions.length === 0 ? "passed" : "blocked",
      reasonCode: failedActions.length === 0 ? "all_gates_passed" : `gate_not_passed:${failedActions[0].actionId}`,
      runDir,
      counts: countStates(actions),
      actions: Object.freeze(actions),
      failedActions,
    }),
    exitCode: failedActions.length === 0 ? 0 : 2,
  };
}

if (import.meta.main) {
  try {
    const { rollup, exitCode } = await runBatch({
      argv: process.argv.slice(2),
      log: (line) => process.stderr.write(`${line}\n`),
    });
    process.stdout.write(`${JSON.stringify(rollup)}\n`);
    process.exitCode = exitCode;
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ schema: BATCH_SCHEMA, state: "blocked", reasonCode: String(error?.message ?? error) })}\n`,
    );
    process.exitCode = 1;
  }
}
