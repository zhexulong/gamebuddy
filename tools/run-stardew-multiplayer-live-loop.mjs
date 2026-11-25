/**
 * Programmatic entry for a MULTIPLAYER live-run LOOP (design:
 * `design/architecture/stardew-multiplayer-live-run-loop.md`).
 *
 * WHAT THIS STARTS, AND WHY IT REUSES THE GATE'S DRIVER
 * ----------------------------------------------------
 * The topology order is load-bearing and already owned by
 * `tools/run-stardew-shared-world-action.ps1` (host launch -> native LAN world ->
 * signed attachment -> AI-client launch -> bridge readiness -> `-SmokeScript` ->
 * teardown of both games). That is the same form `tools/run-stardew-multiplayer-gate.mjs`
 * uses for a one-shot action gate, and the gate's own header explains why it drives
 * the shared-world driver rather than the Preview launcher (the bridge accepts ONE
 * consumer, so a Preview would own the slot).
 *
 * A loop differs from a gate in exactly two ways, and neither changes the topology:
 *   * the runner is long-lived and measured over time, not reduced to a verdict;
 *   * the run root is KEPT, because the trace IS the deliverable
 *     (`design/handbook/live-run-patterns.md:12-28`: a live run's product is a
 *    体检 trace, not a verdict).
 *
 * It grants no capability, changes no action contract, and publishes no decision.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { resolveStardewFixtureRoots } from "./lib/stardew-fixture-roots.mjs";
import { cleanOutputLines } from "./lib/subprocess-output.mjs";
import { armGateProfiles, parseDriverResult } from "./run-stardew-multiplayer-gate.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DRIVER = join(REPOSITORY_ROOT, "tools", "run-stardew-shared-world-action.ps1");
const LOOP_RUNNER = "run-stardew-native-local-player-multiplayer-live-loop-smoke.mjs";
/**
 * THE PAIRED COMPANION RUN, and the driver table row that names the world it arms.
 *
 * `run-stardew-native-local-player-paired-companion-live-run.mjs` stages two bodies on one shared world: the Host player
 * through the fixture's own record-stream lane and the companion through her own model turn. It cannot be started like
 * the loop runner, for two reasons that are both FACTS ABOUT ITS WORLD rather than preferences:
 *   * the world it needs is `native_paired_companion_v1`, which only the driver's own `$ACTION_SETUP` table names - so
 *     the loop passes `-Action` for this runner and lets the table stay the single authority for the scenario;
 *   * two of its four slices drive the Host player, so the driver must be given the script and records paths. They are
 *     allocated under the trace root, because the trace is the deliverable and the report can then name them.
 */
const PAIRED_RUNNER = "run-stardew-native-local-player-paired-companion-live-run.mjs";
const PAIRED_DRIVER_ACTION = "paired_companion";
/**
 * Where the two runners put their own record, and what shape it has. `paired-report.json` carries the four slice
 * verdicts; `loop-report.json` carries the tail instrumentation. A run writes exactly one of them.
 */
const LOOP_REPORT_FILE = "loop-report.json";
const PAIRED_REPORT_FILE = "paired-report.json";
const DEFAULT_RELEASE_DIR = join(REPOSITORY_ROOT, "integrations", "stardew", "bin", "Release", "net6.0");
/**
 * `send_multiplayer_chat` is the ONLY action the loop needs the AI profile to opt
 * into: it is Experimental, and it is how a `say` step reaches the world's chat.
 * `move_to_tile` is published, so it needs no opt-in. The Host fixture is the
 * chat scenario the multiplayer gate already uses for this action.
 */
const LOOP_ACTION = "send_multiplayer_chat";
/**
 * NO experimental opt-in, and that is a fact about the actions rather than a preference: both actions a loop uses are
 * PUBLISHED -- `send_multiplayer_chat` is `FarmhandActionLifecycle.LiveVerified` (`FarmhandActionDefinitions.cs`) and
 * `move_to_tile` likewise -- so listing one under `ExperimentalActions` makes the AI profile's policy invalid, and the
 * client logs "rejected Stardew Game Action policy ... ExperimentalActions may [only name experimental candidates]"
 * and never advances a fixture tick. Measured on a real run.
 */
const LOOP_ACTION_IS_EXPERIMENTAL = false;
// EMPTY is not a placeholder: HostAutomationConfig.IsValid (ModConfig.cs:347-353) accepts an empty
// FixtureScenario or one of 25 hard-coded values, and a loop needs no world precondition beyond the farmhand’s
// own cabin. The driver’s own $ACTION_SETUP uses scenario = "" for exactly that shape. A named scenario outside
// that list makes the Host log "rejected the HostAutomation fixture configuration" and never load the world.
const LOOP_SCENARIO = "";

const REQUIRED_ARGUMENTS = Object.freeze(["--game-path", "--expected-farmhand-id", "--save-name"]);
const OPTIONAL_ARGUMENTS = Object.freeze([
  "--plan",
  "--trace-root",
  "--duration-seconds",
  "--scenario",
  "--runner",
  "--release-dir",
  "--profile-root",
  "--run-root",
  "--timeout-seconds",
]);

/** Parse the CLI into the exact request shape; every refusal is a stable code. */
export function parseLoopArgs(argv = process.argv.slice(2)) {
  const values = new Map();
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (!(REQUIRED_ARGUMENTS.includes(key) || OPTIONAL_ARGUMENTS.includes(key)))
      throw new Error(`invalid_multiplayer_loop_argument:${key}`);
    if (values.has(key)) throw new Error(`invalid_multiplayer_loop_argument:${key}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`missing_multiplayer_loop_value:${key.slice(2)}`);
    values.set(key, value);
    index++;
  }
  for (const key of REQUIRED_ARGUMENTS)
    if (!values.has(key)) throw new Error(`missing_multiplayer_loop_argument:${key.slice(2)}`);

  const gamePath = values.get("--game-path");
  const expectedFarmhandId = values.get("--expected-farmhand-id");
  const saveName = values.get("--save-name");
  if (!isAbsolute(gamePath)) throw new Error("invalid_multiplayer_loop_game_path");
  if (!/^[0-9]{6,20}$/u.test(expectedFarmhandId)) throw new Error("invalid_multiplayer_loop_expected_farmhand_id");
  if (!/^GameBuddyFixture[A-Za-z0-9_-]{1,96}$/u.test(saveName)) throw new Error("invalid_multiplayer_loop_save_name");

  const plan = values.get("--plan") ?? null;
  if (plan !== null && !existsSync(plan)) throw new Error("multiplayer_loop_plan_missing");
  const durationSeconds = Number(values.get("--duration-seconds") ?? 0);
  if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 0 || durationSeconds > 7_200)
    throw new Error("invalid_multiplayer_loop_duration_seconds");
  const timeoutSeconds = Number(values.get("--timeout-seconds") ?? 900);
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 60 || timeoutSeconds > 7_200)
    throw new Error("invalid_multiplayer_loop_timeout_seconds");
  const releaseDir = values.get("--release-dir") ?? DEFAULT_RELEASE_DIR;
  if (!isAbsolute(releaseDir)) throw new Error("invalid_multiplayer_loop_release_dir");
  const runner = values.get("--runner") ?? LOOP_RUNNER;
  const scenario = values.get("--scenario") ?? LOOP_SCENARIO;
  // THE PAIRED RUN NAMES ITS WORLD IN THE DRIVER'S TABLE. Accepting `--scenario` here as well would be a second
  // spelling of one fact, and the driver overrides the profile's value from the table anyway - so a flag that looked
  // honoured and was not is refused by name instead.
  if (isPairedRunner(runner) && scenario.length > 0)
    throw new Error("multiplayer_loop_paired_scenario_comes_from_the_driver_table");

  return Object.freeze({
    gamePath,
    expectedFarmhandId,
    saveName,
    plan,
    durationSeconds,
    scenario,
    runner,
    releaseDir,
    profileRoot: values.get("--profile-root") ?? null,
    runRoot: values.get("--run-root") ?? null,
    traceRoot: values.get("--trace-root") ?? null,
    timeoutSeconds,
  });
}

/**
 * Whether this request is the paired companion run. `--runner` is a FILE NAME the driver resolves against its own
 * directory, so the comparison is on the last path segment.
 */
export function isPairedRunner(runner) {
  return typeof runner === "string" && runner.split(/[\\/]/u).pop() === PAIRED_RUNNER;
}

/**
 * Arm the native save that an attachment needs, in both copies of the Host config.
 *
 * Why this is required rather than optional: attaching (even to an EXISTING binding) leaves the provisioner awaiting a
 * native save to persist the issued manifest and the consumed request id, and the Mod only opens that SaveGameMenu when
 * `HostAutomation.TriggerNativeSaveAfterAttachment` is set (`ModEntry.Fixtures.cs:5319-5334`). Without it the client
 * waits 60 seconds and then reports `stardew_attachment_rejected_save_persistence_timeout` (`HostFarmhandProvisioner.cs:110-126`).
 * Measured: a run with the previous default failed exactly that way.
 *
 * The Host profile carries two copies of the config (the Mod reads the one under `Mods/GameBuddy`), so both are patched.
 */
function armAttachmentSavePersistence(hostRoot) {
  const paths = [join(hostRoot, "GameBuddy", "config.json"), join(hostRoot, "Mods", "GameBuddy", "config.json")];
  let patched = 0;
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const raw = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/u, ""));
    raw.HostAutomation = { ...(raw.HostAutomation ?? {}), TriggerNativeSaveAfterAttachment: true };
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
    patched += 1;
  }
  if (patched === 0) throw new Error("multiplayer_loop_host_config_missing");
  return patched;
}
/** Resolve PowerShell 7 first, then Windows PowerShell. */
function resolvePowerShell() {
  const probe = spawnSync("where.exe", ["pwsh"], { encoding: "utf8", windowsHide: true });
  return probe.status === 0 ? "pwsh" : "powershell";
}

function killTree(pid) {
  if (!Number.isSafeInteger(pid)) return;
  spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
}

/**
 * Runs the driver with a bounded wall clock. The bound is never a success path: on
 * timeout the whole tree is killed and the outcome is `blocked`.
 */
function runDriver({ powerShell, args, timeoutSeconds, sessionSeconds, cwd, env }) {
  return new Promise((resolvePromise) => {
    const child = spawn(powerShell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", DRIVER, ...args], {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    const stdout = [];
    const stderr = [];
    let settled = false;
    const finish = (exitCode, timedOut) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ exitCode, timedOut, stdout: stdout.join(""), stderr: stderr.join("") });
    };
    const timer = setTimeout(
      () => {
        killTree(child.pid);
        finish(null, true);
      },
      // The session itself runs for `sessionSeconds`, so the driver must be allowed to outlive it: a bound of
      // `timeoutSeconds + 60` killed a 600-second session at roughly 360 seconds.
      (timeoutSeconds + sessionSeconds + 60) * 1_000,
    );
    child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    child.on("error", () => finish(null, false));
    child.on("close", (code) => finish(code, false));
  });
}

/**
 * Rebuild the test artifact when it is stale, then re-verify — bounded, and it fails with the gate's own message.
 *
 * Why the ENTRY does this: `host/dist-test` is what the run executes, and in this repository other lanes edit
 * `host/src` continuously. Measured: a rebuild at 02:58:55 followed by a production-source edit at 03:03:45 killed the
 * run inside the driver's attachment step (`live_run_artifact_stale`), which is a real refusal but leaves a live run
 * impossible to start by hand. The gate's stated remedy is `cd host && pnpm build:test`, so the entry takes it once and
 * re-verifies; if the artifact is STILL stale the run fails with the gate's message rather than racing again.
 */
async function ensureFreshArtifact() {
  const { assessLiveRunArtifactFreshness } = await import("./lib/live-run-artifact-freshness.mjs");
  const before = await assessLiveRunArtifactFreshness({ repositoryRoot: REPOSITORY_ROOT });
  if (before.stale === false) return { rebuilt: false, verdict: before };
  const rebuild = spawnSync(
    process.execPath,
    [
      join(REPOSITORY_ROOT, "host", "node_modules", "typescript", "bin", "tsc"),
      "--project",
      "tsconfig.test.json",
      "--noEmitOnError",
      "false",
    ],
    { cwd: join(REPOSITORY_ROOT, "host"), encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
  );
  const after = await assessLiveRunArtifactFreshness({ repositoryRoot: REPOSITORY_ROOT });
  if (after.stale === true)
    throw new Error(
      `live_run_artifact_stale_after_rebuild:${after.reason ?? "unknown"}:${JSON.stringify(after.inputs?.path ?? null)}`,
    );
  return { rebuilt: true, verdict: after, tscExit: rebuild.status };
}

/**
 * The run's verdict, as a pure function so the gate itself can be tested.
 *
 * WHY IT IS EXTRACTED: the audit that found `state=passed` on a 36 s-gapped session found it by DERIVING the gate's
 * behaviour from the numbers -- which is exactly what a test should have done. A gate that can only be exercised by
 * launching a game is a gate nobody re-derives, and this one had drifted into reading a key the agent path had moved.
 *
 * The tail is accepted from BOTH shapes the two modes publish (top level, or nested under `runReport`), and a report that
 * published NEITHER is `blocked`: a missing measurement must never read as "no gap".
 */
export function deriveLoopVerdict({ timedOut, exitCode, driverState, loopResult }) {
  const reportedTailMs = [loopResult?.unobservedTailMs, loopResult?.runReport?.unobservedTailMs].find((value) =>
    Number.isFinite(value),
  );
  const measuredTail = reportedTailMs !== undefined;
  const unobservedTailMs = measuredTail ? reportedTailMs : 0;
  const agentTurns = Number.isFinite(loopResult?.agentTurns) ? loopResult.agentTurns : null;
  const dropped = loopResult?.connectionDropped === true;
  if (timedOut === true)
    return { state: "blocked", unobservedTailMs, measuredTail, reasonCode: "multiplayer_loop_timeout" };
  if (driverState !== "action_passed" || exitCode !== 0)
    return {
      state: "failed",
      unobservedTailMs,
      measuredTail,
      reasonCode: `multiplayer_loop_failed:${driverState ?? "no_driver_result"}`,
    };
  if (measuredTail)
    return unobservedTailMs > 30_000
      ? {
          state: "degraded",
          unobservedTailMs,
          measuredTail,
          reasonCode: `multiplayer_loop_observed_gap:${Math.round(unobservedTailMs / 1000)}s`,
        }
      : { state: "passed", unobservedTailMs, measuredTail, reasonCode: "multiplayer_loop_completed" };
  // AGENT MODE has no sampling to measure: its tail is model generation plus the harness quiet window, which an audit
  // correctly called a latency proxy. Its liveness is proved by real signals instead -- the Agent spoke, and the pipe
  // never dropped -- so a healthy agent session is not labelled "unobserved" for having thought.
  if (agentTurns !== null)
    return agentTurns === 0
      ? { state: "blocked", unobservedTailMs, measuredTail, reasonCode: "multiplayer_loop_agent_spoke_nothing" }
      : dropped
        ? { state: "degraded", unobservedTailMs, measuredTail, reasonCode: "multiplayer_loop_bridge_dropped" }
        : { state: "passed", unobservedTailMs, measuredTail, reasonCode: "multiplayer_loop_agent_turn_completed" };
  return { state: "blocked", unobservedTailMs, measuredTail, reasonCode: "multiplayer_loop_observation_unmeasured" };
}

/**
 * The paired run's verdict, from the record it wrote itself.
 *
 * IT IS NOT `deriveLoopVerdict` WITH EXTRA FIELDS. The two runners state different facts: the loop record measures an
 * unobserved tail, and the paired record states four SLICE verdicts it already derived from its own readings. So this
 * reads her producer's verdict - and refuses to accept it when it disagrees with its own slices, because a report that
 * says `passed` beside a slice that says `not_measured` is exactly the "a verdict that ignores a third of the session"
 * defect this entry already had to fix once.
 */
export function derivePairedVerdict({ timedOut, exitCode, driverState, pairedReport }) {
  if (timedOut === true) return { state: "blocked", reasonCode: "multiplayer_loop_timeout" };
  if (driverState !== "action_passed" || exitCode !== 0)
    return { state: "failed", reasonCode: `multiplayer_loop_failed:${driverState ?? "no_driver_result"}` };
  if (pairedReport === null || pairedReport === undefined)
    return { state: "blocked", reasonCode: "paired_runner_report_missing" };
  const slices = Array.isArray(pairedReport.slices) ? pairedReport.slices : [];
  if (slices.length === 0) return { state: "blocked", reasonCode: "paired_runner_report_has_no_slices" };
  const notPassed = slices.find((entry) => entry?.state !== "passed") ?? null;
  if (pairedReport.state === "passed")
    return notPassed === null
      ? { state: "passed", reasonCode: "paired_slices_passed" }
      : {
          state: "blocked",
          reasonCode: `paired_runner_report_ignores_a_slice:${notPassed.slice}:${notPassed.reasonCode}`,
        };
  // WHICH SLICE, AND WHY. `reasonCode` alone would say "a slice did not pass" about a report of four, and the slice's
  // own name plus its own reason is the whole of what a reader needs to open the right part of the trace.
  const named = `${notPassed?.slice ?? "none"}:${notPassed?.reasonCode ?? pairedReport.reasonCode ?? "unknown"}`;
  return pairedReport.state === "failed"
    ? { state: "failed", reasonCode: `paired_slice_failed:${named}` }
    : { state: "blocked", reasonCode: `paired_slice_not_measured:${named}` };
}

/** One JSON object from one report file, or null. A missing file and an unreadable one are both "no record here". */
export function readRunnerReportFile(path) {
  if (typeof path !== "string" || path.length === 0 || !existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** Every report file this entry can read, by the shape it carries and the runner that writes it. */
export const RUNNER_REPORTS = Object.freeze([
  Object.freeze({ kind: "paired", file: PAIRED_REPORT_FILE }),
  Object.freeze({ kind: "loop", file: LOOP_REPORT_FILE }),
]);

/**
 * THE RUNNER'S RECORD, from its file first - and the SHAPE it is - because the two runners state different facts.
 *
 * ONE READER, TWO SHAPES. The reading pipeline is IDENTICAL for both and is written once: the file first (a real
 * session's Chinese text reached stdout as replacement characters and `JSON.parse` refused the line, so the file is the
 * instrument), then the runner's own stdout, then the driver's captured `actionResult` for a runner whose output the
 * console mangled. What is not shared is the MEANING, which stays with each shape's own verdict function.
 */
export function readRunnerReport({ traceRoot = null, stdout = "", fallbackText = "" } = {}) {
  for (const { kind, file } of RUNNER_REPORTS) {
    const fromFile = traceRoot === null ? null : readRunnerReportFile(join(traceRoot, file));
    if (fromFile !== null) return { kind, report: fromFile, source: "file" };
  }
  const fromStdout = readRunnerReportText(stdout);
  if (fromStdout.kind !== null) return { ...fromStdout, source: "stdout" };
  const fromFallback = readRunnerReportText(fallbackText);
  if (fromFallback.kind !== null) return { ...fromFallback, source: "driver_action_result" };
  return { kind: null, report: null, source: null };
}

/** The shape a runner's own line carries, decided by the field only one of them has: `slices`. */
function readRunnerReportText(text) {
  const paired = parsePairedResult(text);
  if (paired !== null) return { kind: "paired", report: paired };
  const loop = parseLoopResult(text);
  if (loop !== null) return { kind: "loop", report: loop };
  return { kind: null, report: null };
}

export async function main(argv) {
  const request = parseLoopArgs(argv);
  if (process.platform !== "win32") throw new Error("multiplayer_loop_windows_only");
  if (!existsSync(DRIVER)) throw new Error("multiplayer_loop_driver_missing");
  if (!existsSync(join(request.gamePath, "StardewModdingAPI.exe"))) throw new Error("multiplayer_loop_smapi_missing");
  if (!existsSync(join(request.releaseDir, "GameBuddy.Stardew.dll")))
    throw new Error("multiplayer_loop_release_missing");

  const fixtureRoots = resolveStardewFixtureRoots({ profileRoot: request.profileRoot ?? undefined });
  const artifact = await ensureFreshArtifact();
  // Self-heal the armed profiles. `armGateProfiles` reads them from `fixtureRoots.profilesDir`
  // (`<profileRoot>/stardew-profiles`), and that directory has been emptied by unrelated cleanup more than once — each
  // time surfacing as `multiplayer_gate_profile_missing:A-host` AFTER the driver had started, i.e. the run died for an
  // environmental reason with a one-command remedy this entry already knows. The provisioner writes `A-host` and
  // `A-ai-client` directly inside the root it is handed and requires that root to exist (`:253`, `:268-269`), so the
  // argument is `profilesDir`, not its parent. Idempotent, and named when it fails rather than retried blindly.
  if (
    !existsSync(join(fixtureRoots.profilesDir, "A-host")) ||
    !existsSync(join(fixtureRoots.profilesDir, "A-ai-client"))
  ) {
    await mkdir(fixtureRoots.profilesDir, { recursive: true });
    const provision = spawnSync(
      process.execPath,
      [
        join(REPOSITORY_ROOT, "tools", "provision-stardew-multiplayer-profiles.mjs"),
        "--profile-root",
        fixtureRoots.profilesDir,
      ],
      { cwd: REPOSITORY_ROOT, encoding: "utf8", windowsHide: true },
    );
    if (provision.status !== 0)
      throw new Error(
        `multiplayer_loop_profile_provision_failed:${String(provision.stdout ?? provision.stderr ?? "")
          .trim()
          .slice(0, 200)}`,
      );
    if (!existsSync(join(fixtureRoots.profilesDir, "A-host")))
      throw new Error("multiplayer_loop_profile_provision_incomplete:A-host");
  }
  const runRoot = request.runRoot ?? join(fixtureRoots.profileRoot, `multiplayer-loop-${randomUUID()}`);
  const traceRoot = request.traceRoot ?? join(runRoot, "trace");
  const sessionDirectory = join(runRoot, "session");
  const probeRoot = join(runRoot, "probe");
  const resultFile = join(runRoot, "driver-result.json");
  // THE PAIRED RUN'S HOST PLAYER LANE, allocated by this entry and written under the trace root, because the trace is the
  // deliverable: the report can name both files and an operator reading the trace finds the script and the records beside
  // it. Both are required together by the driver, which refuses one path alone.
  const paired = isPairedRunner(request.runner);
  const hostPlayerScript = paired ? join(traceRoot, "host-player-script.json") : null;
  const hostPlayerScriptRecords = paired ? join(traceRoot, "host-player-script-records.jsonl") : null;
  // The Mod reads only these two variables; the game instances are started by the
  // driver, so the loop runner gets its plan and trace directory by environment.
  // THIS run's own streams. The driver redirects each role's console output into `$ProbeRoot/logs`, and the
  // machine-global `SMAPI-latest*.txt` files are shared by every Stardew process on the box and overwritten by
  // whichever run starts last -- archiving those put ANOTHER lane's logs into this trace (verified: the archived
  // host log named a `D:\gb-fixture-lane\...` mods root while this run's was under `E:\gb-loop\`).
  const hostLog = join(probeRoot, "logs", "host.stdout.log");
  const aiLog = join(probeRoot, "logs", "ai-client.stdout.log");

  await mkdir(runRoot, { recursive: true });
  await mkdir(traceRoot, { recursive: true });
  const plan = {
    action: LOOP_ACTION,
    scenario: request.scenario,
    experimental: LOOP_ACTION_IS_EXPERIMENTAL,
    runner: request.runner,
  };
  const armed = await armGateProfiles({ fixtureRoots, runRoot, plan, expectedFarmhandId: request.expectedFarmhandId });
  armAttachmentSavePersistence(armed.hostRoot);

  const childEnv = {
    ...process.env,
    GAMEBUDDY_LOOP_TRACE_DIR: traceRoot,
    GAMEBUDDY_LOOP_DURATION_SECONDS: String(request.durationSeconds),
    GAMEBUDDY_LOOP_HOST_LOG: hostLog,
    GAMEBUDDY_LOOP_AI_LOG: aiLog,
  };
  if (request.plan !== null) childEnv.GAMEBUDDY_LOOP_PLAN = request.plan;

  const driverArgs = [
    "-GamePath",
    request.gamePath,
    "-HostProfileRoot",
    armed.hostRoot,
    "-AiProfileRoot",
    armed.aiRoot,
    "-ProbeRoot",
    probeRoot,
    "-ReleaseDir",
    request.releaseDir,
    "-SessionDirectory",
    sessionDirectory,
    "-SaveName",
    request.saveName,
    "-ExpectedFarmhandId",
    request.expectedFarmhandId,
    // `-SmokeScript` WITHOUT `-Action`: the armed Host scenario is the precondition,
    // and `-Action` would look the action up in the driver's own three-entry table.
    "-SmokeScript",
    request.runner,
    "-TimeoutSeconds",
    String(request.timeoutSeconds),
    "-ResultFile",
    resultFile,
    // THE PAIRED WORLD IS NAMED IN THE DRIVER'S TABLE, so it is asked for by name: `-Action paired_companion` makes the
    // driver arm `native_paired_companion_v1` from its own `$ACTION_SETUP` row (and keeps the scenario out of this
    // entry's hands - `--scenario` is refused for this runner). The table also carries that row's policy opt-in, which
    // for this run is "none": every action it dispatches is published or live-verified.
    ...(paired ? ["-Action", PAIRED_DRIVER_ACTION] : []),
    // The two-body lane. Without these S1 and S2 have no Host player to walk, wave or speak, and the paired world's
    // placement handshake has no record stream - the run would arm a world and measure an empty world.
    ...(paired ? ["-HostPlayerScript", hostPlayerScript, "-HostPlayerScriptRecords", hostPlayerScriptRecords] : []),
  ];

  const run = await runDriver({
    powerShell: resolvePowerShell(),
    args: driverArgs,
    timeoutSeconds: request.timeoutSeconds,
    sessionSeconds: request.durationSeconds,
    cwd: REPOSITORY_ROOT,
    env: childEnv,
  });
  // The driver output is PERSISTED, not just parsed: on a blocked run the reason exists only on its stdout (its catch
  // prints {state, phase, reason} and rethrows without writing the result file), so a run that discards it is
  // undiagnosable after the fact.
  writeFileSync(join(runRoot, "driver.stdout.txt"), run.stdout, "utf8");
  writeFileSync(join(runRoot, "driver.stderr.txt"), run.stderr, "utf8");
  const driverResult = parseDriverResult(run.stdout);
  // THE RUNNER'S RECORD, read from its file first and its shape named - see `readRunnerReport` for why the pipeline is
  // shared and the verdicts are not. Measured: a real session's record could not be parsed out of the driver's stdout at
  // all, because the child's Chinese text reached it as replacement characters (`�`) and `JSON.parse` refused the line,
  // so the FILE is the instrument and stdout is the fallback.
  const runnerReport = readRunnerReport({
    traceRoot,
    stdout: run.stdout,
    fallbackText: driverResult?.actionResult ?? "",
  });
  // A verdict that ignores a third of the session is not a verdict, and a MISSING measurement is not "no gap": both
  // rules live in the verdict functions so they are testable without a game, and the paired run's four slices are its
  // own record's to state.
  const verdict =
    runnerReport.kind === "paired"
      ? derivePairedVerdict({
          timedOut: run.timedOut,
          exitCode: run.exitCode,
          driverState: driverResult?.state,
          pairedReport: runnerReport.report,
        })
      : deriveLoopVerdict({
          timedOut: run.timedOut,
          exitCode: run.exitCode,
          driverState: driverResult?.state,
          loopResult: runnerReport.kind === "loop" ? runnerReport.report : null,
        });
  const { state } = verdict;

  const report = {
    schemaVersion: 1,
    state,
    reasonCode: verdict.reasonCode,
    scenario: request.scenario,
    runner: request.runner,
    saveName: request.saveName,
    durationSeconds: request.durationSeconds,
    runRoot,
    traceRoot,
    // The files that EXIST, not a fixed wish-list: an audit found this naming six while four (positions.jsonl,
    // plan.jsonl, smapi/*) were absent in agent mode, which reads as "recorded but lost" instead of "not produced here".
    traceFiles: [
      ...RUNNER_REPORTS.filter(({ file }) => existsSync(join(traceRoot, file))).map(({ file }) => file),
      ...(existsSync(join(traceRoot, "slices.jsonl")) ? ["slices.jsonl"] : []),
      "timeline.jsonl",
      ...(existsSync(join(traceRoot, "positions.jsonl")) ? ["positions.jsonl"] : []),
      ...(existsSync(join(traceRoot, "plan.jsonl")) ? ["plan.jsonl"] : []),
      ...(existsSync(join(traceRoot, "smapi")) ? ["smapi/host.log", "smapi/ai-client.log"] : []),
    ],
    artifact,
    driverExitCode: run.exitCode,
    driverState: driverResult?.state ?? null,
    // WHICH record the entry read, and from where: "the report is missing" and "the report is unreadable" are different
    // failures and this one has already been both. `kind` is the shape (and therefore which verdict function read it).
    runnerReportKind: runnerReport.kind,
    runnerReportSource: runnerReport.source,
    driverPhase: driverResult?.phase ?? null,
    driverReason: driverResult?.reason ?? null,
    loop: runnerReport.kind === "loop" ? runnerReport.report : null,
    paired: runnerReport.kind === "paired" ? runnerReport.report : null,
    // The two-body lane's two files, named in the report so a reader can open the run's own script and records without
    // reconstructing the trace root's layout; absent for every run that has no Host player lane.
    hostPlayerScript: hostPlayerScript,
    hostPlayerScriptRecords: hostPlayerScriptRecords,
    // The audit段 is filled by the reviewing action, not by this tool: a loop run is
    // not finished until a fresh-context auditing-runs reviewer has read the trace
    // (design §5, and handbook/live-run-patterns.md:12-28).
    audit: {
      requirement: "auditing-runs reviewer must read traceRoot before this run counts as finished",
      status: "pending",
    },
  };
  writeFileSync(join(runRoot, "loop-entry-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(traceRoot, "entry-report.json"), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

/** The loop runner's own JSON line, which carries the rubric and the fact counts. */
export function parseLoopResult(stdout) {
  const lines = cleanOutputLines(stdout);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trim();
    const at = line.indexOf("{");
    if (at < 0) continue;
    try {
      const value = JSON.parse(line.slice(at));
      if (value !== null && typeof value === "object" && typeof value.state === "string" && "rubric" in value)
        return value;
    } catch {
      // Not the loop's record; keep looking.
    }
  }
  return null;
}

/**
 * The paired runner's own JSON line (`PAIRED_RESULT {...}`). Its `slices` are what distinguish it from the loop's record:
 * the same line shape, stating four verdicts instead of a sampling measurement.
 */
export function parsePairedResult(stdout) {
  const lines = cleanOutputLines(stdout);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trim();
    const at = line.indexOf("{");
    if (at < 0) continue;
    try {
      const value = JSON.parse(line.slice(at));
      if (value !== null && typeof value === "object" && typeof value.state === "string" && Array.isArray(value.slices))
        return value;
    } catch {
      // Not the paired runner's record; keep looking.
    }
  }
  return null;
}

if (import.meta.main) {
  try {
    const report = await main(process.argv.slice(2));
    console.log(JSON.stringify(report));
    if (report.state !== "passed") process.exitCode = 2;
  } catch (error) {
    console.log(JSON.stringify({ state: "blocked", reasonCode: String(error?.message ?? error) }));
    process.exitCode = 1;
  }
}
