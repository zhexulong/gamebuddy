/**
 * Programmatic entry for a GameBuddy MULTIPLAYER (shared-world) game-action gate.
 *
 * WHY THIS EXISTS
 * ---------------
 * Two actions are blocked on a REAL live LAN lobby rather than a single-player
 * fixture:
 *   * `send_multiplayer_chat` — the game's own egress
 *     (`Multiplayer.sendChatMessage`) RETURNS WITHOUT SENDING when neither
 *     `Game1.IsClient` nor `Game1.IsServer` holds, so on a single-player fixture
 *     the Mod's honest `chat_multiplayer_only` refusal is all a fixture can ever
 *     produce; a green receipt there would be a false green.
 *   * `talk_to_npc` — the sensitivity register requires shared-world evidence
 *     before it may leave Experimental.
 * Starting that lobby used to be a hand-built, human-driven invocation. This
 * script is the one programmatic entry: it starts the two-process topology, runs
 * the gate runner against the live AI-client bridge, and reports ONE named
 * outcome.
 *
 * WHY IT DRIVES `run-stardew-shared-world-action.ps1` AND NOT THE PREVIEW LAUNCHER
 * ------------------------------------------------------------------------------
 * `tools/start-farmhand-launcher.ps1` also starts a two-process topology, but it
 * additionally starts the immutable Preview, and the Preview is itself a bridge
 * CLIENT of the AI farmhand. The Mod's named-pipe bridge accepts exactly one
 * connection at a time (`NamedPipeServerStream(..., maxNumberOfServerInstances: 1)`,
 * `integrations/stardew/LocalPipeBridge.cs:112`), so the Preview would own the
 * single bridge slot and the gate runner could never connect. The shared-world
 * driver is the same Host → attachment → AI-client sequence WITHOUT a bridge
 * consumer, which is precisely the entry a gate needs. The Preview launcher is
 * still the right entry for the interactive Companion Preview; it is not a gate
 * entry.
 *
 * WHAT THE DRIVER WAITS FOR (the readiness signal this entry relies on)
 * --------------------------------------------------------------------
 * Before it runs any gate, the driver waits for exactly two live facts, both
 * owned by the Mod:
 *   1. the Host's own line `HostAutomation native world ready for save '<save>';
 *      native LAN server started.` — the native LAN server is up; and
 *   2. the AI client's own line `FarmhandProvisioner reached readyToPlay with
 *      the expected native Farmhand identity and save/world scope.`
 *      (`integrations/stardew/FarmhandProvisioner.cs:149`) — the vanilla LAN
 *      handshake completed and the farmhand's `UniqueMultiplayerID` and
 *      save/world scope match the signed manifest.
 * No readiness state is re-derived here; the driver's wait IS the authority.
 *
 * HOW THE AI CLIENT IS TOLD WHICH SCENARIO TO ARM
 * -----------------------------------------------
 * `run-stardew-shared-world-action.ps1` copies the two profile roots it is given
 * and then arms the copied Host config itself only when it is passed `-Action`
 * (its internal `ACTION_SETUP` table). `send_multiplayer_chat` is not in that
 * table and its `-Action` branch is fail-closed (`shared_world_action_not_wired`),
 * so this entry pre-arms PRIVATE COPIES of the profiles instead: the Host copy
 * gets `HostAutomation.FixtureScenario`, and the AI copy gets the Experimental
 * opt-in the action needs. It never writes the shared A-host / A-ai-client
 * profiles (those are other lanes' transaction inputs), so this entry shares no
 * lock and no mutable state with them.
 *
 * This entry grants no capability, changes no action contract, and publishes no
 * decision: it starts the topology, runs the gate runner, and reduces the
 * driver's result to a named outcome.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { resolveStardewFixtureRoots } from "./lib/stardew-fixture-roots.mjs";
import { STARDEW_SHARED_WORLD_ACTION_SCENARIOS } from "./stardew-action-gate-descriptors.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DRIVER = join(REPOSITORY_ROOT, "tools", "run-stardew-shared-world-action.ps1");
const DEFAULT_RELEASE_DIR = join(REPOSITORY_ROOT, "integrations", "stardew", "bin", "Release", "net6.0");

/**
 * The multiplayer gates this entry can start.
 *
 * `scenario` is the Host fixture precondition the live world must be built from
 * (a shared-world action cannot establish its own precondition, and the Fixture
 * Scenario list is allowlisted by `tools/lib/stardew-fixture-profile.mjs`).
 * `experimental` is the Mod catalog lifecycle that decides whether the AI client
 * profile must opt into the action under the version-1 default-consent policy.
 * `runner` is the gate runner the driver invokes with `--client-config`.
 *
 * `send_multiplayer_chat` and `talk_to_npc` are the two gates wired today.
 * `talk_to_npc` is the last action still registered `Experimental`: the multiplayer
 * sensitivity register derives its native seam as mp-semantic, so a native-local
 * pass cannot stand in for it, and the shared-world Given it is armed on now exists.
 *
 * The scenario for each gate is NOT spelled here: it comes from
 * `STARDEW_SHARED_WORLD_ACTION_SCENARIOS` in `stardew-action-gate-descriptors.mjs`,
 * so a scenario is authored once. `talk_to_npc`'s Given places the bound Farmhand in
 * the Saloon one step from Gus, because the native talk branch builds its dialogue
 * keys from `Game1.currentLocation.name.Value` and no shipped villager dialogue
 * table has a key reachable from the Farm or the Cabin (see
 * `ModEntry.Fixtures.TalkToNpcSharedWorld.cs`).
 */
export const MULTIPLAYER_GATE_ACTIONS = Object.freeze({
  send_multiplayer_chat: Object.freeze({
    experimental: true,
    runner: "run-stardew-native-local-player-send-multiplayer-chat-smoke.mjs",
  }),
  talk_to_npc: Object.freeze({
    experimental: true,
    runner: "run-stardew-native-local-player-talk-to-npc-smoke.mjs",
  }),
});

/** The one place a gate name becomes the topology + runner this entry starts. */
export function resolveMultiplayerGatePlan({ action, runner } = {}) {
  const entry = MULTIPLAYER_GATE_ACTIONS[action];
  if (entry === undefined) throw new Error(`unknown_multiplayer_gate_action:${action}`);
  const scenario = STARDEW_SHARED_WORLD_ACTION_SCENARIOS[action];
  if (typeof scenario !== "string" || scenario.length === 0)
    throw new Error(`missing_multiplayer_gate_scenario:${action}`);
  return Object.freeze({
    action,
    scenario,
    experimental: entry.experimental,
    runner: runner ?? entry.runner,
  });
}

/**
 * The driver's LAST parseable JSON object on stdout, or null.
 *
 * The driver writes exactly one JSON object (its result, or its `blocked`
 * record), but PowerShell can prefix it with a warning line, so the search runs
 * backwards for the first line that parses rather than assuming the first line.
 */
export function parseDriverResult(stdout) {
  const lines = String(stdout ?? "").split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trim();
    if (!line.startsWith("{")) continue;
    try {
      const value = JSON.parse(line);
      if (value !== null && typeof value === "object" && typeof value.state === "string") return value;
    } catch {
      // Not the driver's record; keep looking.
    }
  }
  return null;
}

/**
 * The driver's exit code + record, reduced to ONE named outcome.
 *
 * The names are this entry's contract, so a caller can branch without knowing
 * the driver's result shape. A `passed` outcome needs BOTH the driver's own
 * `action_passed` and a zero exit; either alone is not success.
 */
export function classifyMultiplayerGateOutcome({ exitCode, result } = {}) {
  if (result?.state === "action_passed" && exitCode === 0)
    return { state: "passed", reasonCode: "multiplayer_gate_passed" };
  if (result?.state === "action_passed")
    return { state: "blocked", reasonCode: `multiplayer_gate_driver_failed:${exitCode}` };
  if (result?.state === "action_failed") return { state: "failed", reasonCode: "multiplayer_gate_action_failed" };
  if (result?.state === "blocked")
    return { state: "blocked", reasonCode: `multiplayer_gate_topology_failed:${String(result.phase ?? "unknown")}` };
  if (result === null) return { state: "blocked", reasonCode: "multiplayer_gate_driver_output_missing" };
  if (result.state === "attached") return { state: "blocked", reasonCode: "multiplayer_gate_runner_not_invoked" };
  return { state: "blocked", reasonCode: `multiplayer_gate_driver_unexpected_state:${String(result.state)}` };
}

/** The bounded, typed argument set this entry accepts. */
const REQUIRED_ARGUMENTS = Object.freeze(["--game-path", "--expected-farmhand-id", "--save-name"]);
const OPTIONAL_ARGUMENTS = Object.freeze([
  "--action",
  "--runner",
  "--profile-root",
  "--release-dir",
  "--run-root",
  "--timeout-seconds",
  "--result-file",
]);
const FLAG_ARGUMENTS = Object.freeze(["--keep-run-root"]);

/**
 * Parse and validate the CLI into the exact request shape. Every refusal is a
 * stable code, so a caller never has to read an English message.
 */
export function parseGateArgs(argv = process.argv.slice(2)) {
  const values = new Map();
  const flags = new Set();
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (FLAG_ARGUMENTS.includes(key)) {
      flags.add(key);
      continue;
    }
    if (!(REQUIRED_ARGUMENTS.includes(key) || OPTIONAL_ARGUMENTS.includes(key)))
      throw new Error(`invalid_multiplayer_gate_argument:${key}`);
    if (values.has(key)) throw new Error(`invalid_multiplayer_gate_argument:${key}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`missing_multiplayer_gate_value:${key.slice(2)}`);
    values.set(key, value);
    index++;
  }
  for (const key of REQUIRED_ARGUMENTS)
    if (!values.has(key)) throw new Error(`missing_multiplayer_gate_argument:${key.slice(2)}`);

  const gamePath = values.get("--game-path");
  const expectedFarmhandId = values.get("--expected-farmhand-id");
  const saveName = values.get("--save-name");
  if (!isAbsolute(gamePath)) throw new Error("invalid_multiplayer_gate_game_path");
  if (!/^[0-9]{6,20}$/u.test(expectedFarmhandId)) throw new Error("invalid_multiplayer_gate_expected_farmhand_id");
  if (!/^GameBuddyFixture[A-Za-z0-9_-]{1,96}$/u.test(saveName)) throw new Error("invalid_multiplayer_gate_save_name");

  const timeoutSeconds = Number(values.get("--timeout-seconds") ?? 300);
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 60 || timeoutSeconds > 900)
    throw new Error("invalid_multiplayer_gate_timeout_seconds");
  const releaseDir = values.get("--release-dir") ?? DEFAULT_RELEASE_DIR;
  if (!isAbsolute(releaseDir)) throw new Error("invalid_multiplayer_gate_release_dir");

  return Object.freeze({
    gamePath,
    expectedFarmhandId,
    saveName,
    action: values.get("--action") ?? "send_multiplayer_chat",
    runner: values.get("--runner") ?? null,
    profileRoot: values.get("--profile-root") ?? null,
    releaseDir,
    runRoot: values.get("--run-root") ?? null,
    timeoutSeconds,
    resultFile: values.get("--result-file") ?? null,
    keepRunRoot: flags.has("--keep-run-root"),
  });
}

/** Read one JSON config file. */
function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/u, ""));
}

/** Write one JSON config file the driver's `ConvertFrom-Json` can read back. */
function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** The four config sources one profile transaction manages, for one profile copy. */
function profileConfigPaths(profileRoot) {
  return [join(profileRoot, "GameBuddy", "config.json"), join(profileRoot, "Mods", "GameBuddy", "config.json")];
}

/**
 * Arm PRIVATE copies of the two profiles the driver will consume.
 *
 * The Host copy carries the gate's fixture scenario; the AI copy carries the
 * Experimental opt-in when the action is experimental. Both copies must already
 * be in the formal attachment shape, so a profile that would fail deep inside
 * the run fails here by name instead.
 */
export async function armGateProfiles({ fixtureRoots, runRoot, plan, expectedFarmhandId }) {
  const profilesDir = fixtureRoots.profilesDir;
  const hostRoot = join(runRoot, "input", "host");
  const aiRoot = join(runRoot, "input", "ai");
  for (const [name, source, destination] of [
    ["A-host", join(profilesDir, "A-host"), hostRoot],
    ["A-ai-client", join(profilesDir, "A-ai-client"), aiRoot],
  ]) {
    if (!existsSync(source)) throw new Error(`multiplayer_gate_profile_missing:${name}`);
    await cp(source, destination, { recursive: true });
  }

  const hostConfigs = profileConfigPaths(hostRoot);
  const aiConfigs = profileConfigPaths(aiRoot);
  for (const path of [...hostConfigs, ...aiConfigs])
    if (!existsSync(path)) throw new Error(`multiplayer_gate_profile_config_missing:${path}`);

  const hostConfig = readJson(hostConfigs[0]);
  const aiConfig = readJson(aiConfigs[0]);
  if (hostConfig.HostFarmhandProvisioning?.Enable !== true)
    throw new Error("multiplayer_gate_profile_not_formal:A-host");
  if (aiConfig.FarmhandProvisioner?.Enable !== true) throw new Error("multiplayer_gate_profile_not_formal:A-ai-client");

  hostConfig.HostAutomation = { ...hostConfig.HostAutomation, FixtureScenario: plan.scenario };
  aiConfig.ExperimentalActions = plan.experimental ? [plan.action] : [];

  for (const path of hostConfigs) writeJson(path, hostConfig);
  for (const path of aiConfigs) writeJson(path, aiConfig);

  return {
    hostRoot,
    aiRoot,
    // The bridge scope the driver copies from the Host config into the AI config.
    // It is diagnostic only: the Mod advertises the SIGNED MANIFEST's scope for a
    // formal client, so a profile whose scope here does not match the live save
    // makes the gate runner's own handshake fail rather than silently lie.
    hostScope: {
      saveId: typeof hostConfig.SaveId === "string" && hostConfig.SaveId.length > 0,
      worldId: typeof hostConfig.WorldId === "string" && hostConfig.WorldId.length > 0,
      playerIdMatchesExpectedFarmhandId: String(hostConfig.PlayerId ?? "") === String(expectedFarmhandId),
      companionId: typeof hostConfig.CompanionId === "string" && hostConfig.CompanionId.length > 0,
    },
  };
}

/** Resolve the PowerShell 7 host first, then Windows PowerShell. */
function resolvePowerShell() {
  const probe = spawnSync("where.exe", ["pwsh"], { encoding: "utf8", windowsHide: true });
  return probe.status === 0 ? "pwsh" : "powershell";
}

/** Kill the driver and every process it owns. A launcher-owned tree only. */
function killTree(pid) {
  if (!Number.isSafeInteger(pid)) return;
  spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
}

/**
 * Run the driver with a bounded wall clock and collect its output.
 *
 * The bound exists so a hung SMAPI child cannot hold this entry forever; it is
 * never a success path. The driver's own `finally` tears the two SMAPI children
 * down in reverse order, and this kills the whole tree on the timeout path.
 */
function runDriver({ powerShell, args, timeoutSeconds, cwd }) {
  return new Promise((resolvePromise) => {
    const child = spawn(powerShell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", DRIVER, ...args], {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
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
      (timeoutSeconds + 60) * 1_000,
    );
    child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    child.on("error", () => finish(null, false));
    child.on("close", (code) => finish(code, false));
  });
}

async function main(argv) {
  const request = parseGateArgs(argv);
  const plan = resolveMultiplayerGatePlan({ action: request.action, runner: request.runner });

  if (process.platform !== "win32") throw new Error("multiplayer_gate_windows_only");
  if (!existsSync(DRIVER)) throw new Error("multiplayer_gate_driver_missing");
  if (!existsSync(join(request.gamePath, "StardewModdingAPI.exe"))) throw new Error("multiplayer_gate_smapi_missing");
  if (!existsSync(join(request.releaseDir, "GameBuddy.Stardew.dll")))
    throw new Error("multiplayer_gate_release_missing");

  const fixtureRoots = resolveStardewFixtureRoots({ profileRoot: request.profileRoot ?? undefined });
  const runRoot = request.runRoot ?? join(fixtureRoots.profileRoot, `multiplayer-gate-${randomUUID()}`);
  const sessionDirectory = join(runRoot, "session");
  const probeRoot = join(runRoot, "probe");
  const resultFile = request.resultFile ?? join(runRoot, "driver-result.json");

  let armed = null;
  let outcome;
  try {
    await mkdir(runRoot, { recursive: true });
    armed = await armGateProfiles({ fixtureRoots, runRoot, plan, expectedFarmhandId: request.expectedFarmhandId });

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
      "-SmokeScript",
      plan.runner,
      "-TimeoutSeconds",
      String(request.timeoutSeconds),
      "-ResultFile",
      resultFile,
    ];

    const run = await runDriver({
      powerShell: resolvePowerShell(),
      args: driverArgs,
      timeoutSeconds: request.timeoutSeconds,
      cwd: REPOSITORY_ROOT,
    });
    const driverResult = parseDriverResult(run.stdout);
    if (run.timedOut === true) outcome = { state: "blocked", reasonCode: "multiplayer_gate_topology_timeout" };
    else outcome = classifyMultiplayerGateOutcome({ exitCode: run.exitCode, result: driverResult });
    outcome = { ...outcome, driverExitCode: run.exitCode, driverResult, driverStderrPresent: run.stderr.length > 0 };
    // When the DRIVER itself dies without emitting its record, its stderr is the only thing that says why - and a bare
    // `driverStderrPresent: true` (which is what this used to report) sends the operator to read the driver's source.
    // Bounded to the tail, because a driver error is a Windows/PowerShell diagnostic and the useful part is the end.
    if (run.stderr.length > 0) outcome = { ...outcome, driverStderrTail: run.stderr.slice(-1500) };
  } finally {
    if (!request.keepRunRoot) await rm(runRoot, { recursive: true, force: true }).catch(() => {});
  }

  return {
    state: outcome.state,
    reasonCode: outcome.reasonCode,
    action: plan.action,
    scenario: plan.scenario,
    runner: plan.runner,
    saveName: request.saveName,
    expectedFarmhandId: request.expectedFarmhandId,
    hostScopePresent: armed?.hostScope ?? null,
    driverExitCode: outcome.driverExitCode ?? null,
    driverResult: outcome.driverResult ?? null,
      driverStderrPresent: outcome.driverStderrPresent ?? null,
    driverStderrTail: outcome.driverStderrTail ?? null,
  };
}

if (import.meta.main) {
  try {
    const result = await main(process.argv.slice(2));
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } catch (error) {
    console.log(JSON.stringify({ state: "blocked", reasonCode: String(error?.message ?? error) }));
    process.exitCode = 1;
  }
}
