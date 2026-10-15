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
import { armGateProfiles, parseDriverResult } from "./run-stardew-multiplayer-gate.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DRIVER = join(REPOSITORY_ROOT, "tools", "run-stardew-shared-world-action.ps1");
const LOOP_RUNNER = "run-stardew-native-local-player-multiplayer-live-loop-smoke.mjs";
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

  return Object.freeze({
    gamePath,
    expectedFarmhandId,
    saveName,
    plan,
    durationSeconds,
    scenario: values.get("--scenario") ?? LOOP_SCENARIO,
    runner: values.get("--runner") ?? LOOP_RUNNER,
    releaseDir,
    profileRoot: values.get("--profile-root") ?? null,
    runRoot: values.get("--run-root") ?? null,
    traceRoot: values.get("--trace-root") ?? null,
    timeoutSeconds,
  });
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

export async function main(argv) {
  const request = parseLoopArgs(argv);
  if (process.platform !== "win32") throw new Error("multiplayer_loop_windows_only");
  if (!existsSync(DRIVER)) throw new Error("multiplayer_loop_driver_missing");
  if (!existsSync(join(request.gamePath, "StardewModdingAPI.exe"))) throw new Error("multiplayer_loop_smapi_missing");
  if (!existsSync(join(request.releaseDir, "GameBuddy.Stardew.dll")))
    throw new Error("multiplayer_loop_release_missing");

  const fixtureRoots = resolveStardewFixtureRoots({ profileRoot: request.profileRoot ?? undefined });
  const runRoot = request.runRoot ?? join(fixtureRoots.profileRoot, `multiplayer-loop-${randomUUID()}`);
  const traceRoot = request.traceRoot ?? join(runRoot, "trace");
  const sessionDirectory = join(runRoot, "session");
  const probeRoot = join(runRoot, "probe");
  const resultFile = join(runRoot, "driver-result.json");
  // The Mod reads only these two variables; the game instances are started by the
  // driver, so the loop runner gets its plan and trace directory by environment.
  const hostLog = join(process.env.APPDATA ?? "", "StardewValley", "ErrorLogs", "SMAPI-latest.txt");
  const aiLog = join(process.env.APPDATA ?? "", "StardewValley", "ErrorLogs", "SMAPI-latest.player-2.txt");

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
  const loopResult = parseLoopResult(run.stdout);
  const state =
    run.timedOut === true
      ? "blocked"
      : driverResult?.state === "action_passed" && run.exitCode === 0
        ? "passed"
        : "failed";

  const report = {
    schemaVersion: 1,
    state,
    reasonCode:
      run.timedOut === true
        ? "multiplayer_loop_timeout"
        : state === "passed"
          ? "multiplayer_loop_completed"
          : `multiplayer_loop_failed:${driverResult?.state ?? "no_driver_result"}`,
    scenario: request.scenario,
    runner: request.runner,
    saveName: request.saveName,
    durationSeconds: request.durationSeconds,
    runRoot,
    traceRoot,
    traceFiles: [
      "timeline.jsonl",
      "positions.jsonl",
      "plan.jsonl",
      "loop-report.json",
      "smapi/host.log",
      "smapi/ai-client.log",
    ],
    driverExitCode: run.exitCode,
    driverState: driverResult?.state ?? null,
    driverPhase: driverResult?.phase ?? null,
    driverReason: driverResult?.reason ?? null,
    loop: loopResult,
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
  const lines = String(stdout ?? "").split(/\r?\n/u);
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
