/*
 * Does the real Stardew world outlive every AI-side termination, and end only when the Player is contained?
 *
 * The gap this closes: the survival invariant is written down in the product (ADR-0007's superseding
 * clarification, and the coordinator's own comment at `stardew-production-lifecycle-coordinator.internal.ts`
 * "Ordinary close stops AI authority only. The Player Host keeps running"), and it is proven twice - by unit
 * tests with fake collaborators, and by `host/native/windows-bootstrap-guardian/guardian-live.test.mjs` with
 * `RoleRootFixture.exe`. Neither of those ever ran against a real Player Host with a real game world, so no
 * production revision could fail or pass on the fact the policy is about. This file is that gate.
 *
 * The production authority is used for every layer, and none of them is re-implemented here:
 *
 *   | what a reading needs                | owning authority |
 *   | installation root + executables     | `stardew-game-install` (`discoverStardewGameInstallation`) |
 *   | the game process and its pipe       | `tools/lib/stardew-live-run.mjs` (`launchStardewLiveRun`) |
 *   | the AI authority's attachment       | `local-stardew-bridge.js` (`LocalStardewBridgeClient.connect`) |
 *   | an observation with real world time | `tools/lib/stardew-native-smoke-harness-v1.mjs` (`observeFresh`) |
 *   | role Jobs, containment, control EOF | the published native Guardian (`GameBuddy.WindowsBootstrapGuardian.exe`) |
 *
 * Roles are launched BY THE GUARDIAN, not by this parent, because role containment is the operation under
 * test: `contain_role ai_client` is the exact call the coordinator's ordinary close makes for the AI role
 * (`containedRuntimeTeardown.containAiClient`), and `contain_role player_host` is the exact call its explicit
 * endgame makes for the Player (`containPlayerHost`). A parent-side kill would prove nothing about either.
 *
 * Why the Player Host role is a node process that launches SMAPI instead of SMAPI itself: the Guardian creates
 * roles with `bInheritHandle = false`, so a role has no std handles of its own, and SMAPI's console stream is
 * the documented freeze path - an unread pipe fills and blocks the game thread in the kernel (see the drain
 * comment in `launchStardewLiveRun`). A launcher that owns the pipes gives SMAPI a drained console, and the
 * game stays inside the Player Job by ordinary Job inheritance from its parent. That inheritance is also what
 * makes the endgame reading meaningful: terminating the Player Job must take the game with it.
 *
 *   node tools/live-run/game/stardew-world-survival-live.mjs
 *
 * Six readings, each against a real world:
 *   1. Player Host + world up, AI authority attached over the real bridge (both PIDs, real observation)
 *   2. ordinary close (`contain_role ai_client`)                -> world alive, NEW observation
 *   3. AI crash (`taskkill /F` of the exact AI-side PID)        -> world alive, NEW observation
 *   4. controller EOF (the Guardian's control channel closed)   -> world alive, NEW observation
 *   5. guardian last-handle close (Guardian ended by its EXACT PID)   -> world alive, NEW observation
 *   6. Player containment, the operation explicit endgame drives       -> world alive and answering first,
 *                                                                         gone only after it, no observation
 *
 * "New observation" is not "no error": every reading must read a world clock (`timeOfDay`) or revision that
 * advanced past the previous reading's. A paused or frozen world fails here rather than passing quietly.
 *
 * Reading 5 kills the Guardian by its exact PID, never `taskkill /T`: `/T` ends the target's descendants, both
 * role processes are its descendants, and the first run of this reading therefore killed the world with the
 * harness's own hand (`alive=false`, then `ENOENT \\.\pipe\gamebuddy-stardew`). That is recorded because the
 * reading is only worth its method.
 *
 * Does NOT prove: the `gameended` projection itself. Reading 6 drives the containment half of explicit endgame
 * (`containPlayerHost`), which is the half that terminates the world; the authenticated `game_endgame`
 * operation that produces the projection needs a full desktop-composition activation (browser admission, Pi,
 * an AI provider credential) and cannot be minted by a harness. The readings JSON carries that boundary in
 * `notProven` so a green run cannot be read as covering the whole endgame. It also runs against the prepared
 * native-local fixture save and a Mod deployed in the fixture root, so it says nothing about mod deployment
 * into a store-managed install.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadSelectedHostProductionModule, selectHostProductionArtifact } from "../../lib/host-production-module.mjs";
import { resolveStardewFixtureRoots } from "../../lib/stardew-fixture-roots.mjs";
import { connectNativeLocalClient, observeFresh } from "../../lib/stardew-native-smoke-harness-v1.mjs";
import { launchStardewLiveRun } from "../../lib/stardew-live-run.mjs";
import { fixtureScenario } from "../../lib/stardew-native-local-player-fixture.mjs";
import {
  killProcessTree,
  listStardewProcessIds,
  TASKKILL_ALREADY_EXITED_STATUS,
} from "../../lib/windows-process-tree.mjs";

const SELF = fileURLToPath(import.meta.url);
const REPO = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const GUARDIAN = join(
  REPO,
  "host",
  "native",
  "windows-bootstrap-guardian",
  ".dist",
  "win-x64",
  "GameBuddy.WindowsBootstrapGuardian.exe",
);
const DISCOVERY = join(REPO, "host", "dist-test", "stardew-game-install", "index.js");

/** A role may not outlive the harness by accident: one failed run must not leak a game per attempt. */
const ROLE_MAX_LIFETIME_MS = 900_000;
/** Per-step ceilings. SMAPI cold start to first dispatch is measured in tens of seconds (live-run-patterns.md:138). */
const WORLD_READY_MS = 180_000;
const ATTACH_MS = 60_000;
const OBSERVE_WINDOW_MS = 45_000;
const TERMINATION_SETTLE_MS = 5_000;
const ROLE_EXIT_SETTLE_MS = 15_000;
/** How often the attached AI authority re-observes the world it holds the one attachment to. */
const ATTACHED_SAMPLE_INTERVAL_MS = 2_000;
/** How old that sample may be and still count as "what the world answers now". */
const ATTACHED_OBSERVATION_MAX_AGE_MS = 10_000;

/**
 * What this gate cannot speak to, named where a reader of its JSON will see it.
 *
 * The `gameended` projection is the product's own authenticated `game_endgame` operation, and it needs a full
 * desktop-composition activation - browser admission, a Pi runtime and an AI provider credential. A harness
 * cannot mint one, so reading 6 proves the containment that terminates the world, not the projection that
 * follows it. A gate that stayed silent about this would be read as covering the whole endgame.
 */
const NOT_PROVEN = Object.freeze([
  "the `gameended` projection: explicit endgame's authenticated `game_endgame` operation needs a full desktop-composition activation (browser admission, a Pi runtime and an AI provider credential), which a harness cannot mint",
  "mod deployment into a store-managed install: this gate loads the Mod from a copy of the shared fixture tree",
]);

/* ------------------------------------------------------------------ the readings */

const findings = [];
function record(question, ok, reading) {
  findings.push(Object.freeze({ question, ok, reading }));
  console.log(`  ${ok ? "ok  " : "FAIL"} ${question}: ${reading}`);
}
function note(line) {
  console.log(`  ... ${line}`);
}

/**
 * What changed between two observations, or null when nothing did.
 *
 * A clock that went backwards is the engine's own day rollover, so it only counts when the calendar moved with
 * it; a bare decrease is not an advance and must not be read as one.
 */
function describeAdvance(previous, next) {
  const clock = `time=${String(previous.timeOfDay)}->${String(next.timeOfDay)}`;
  if (next.timeOfDay > previous.timeOfDay) return clock;
  if (next.revision > previous.revision)
    return `revision=${String(previous.revision)}->${String(next.revision)}; ${clock}`;
  const calendarMoved =
    next.year > previous.year ||
    (next.year === previous.year && next.seasonIndex > previous.seasonIndex) ||
    (next.year === previous.year && next.seasonIndex === previous.seasonIndex && next.dayOfMonth > previous.dayOfMonth);
  return calendarMoved
    ? `calendar=${String(previous.year)}/${String(previous.seasonIndex)}/${String(previous.dayOfMonth)}->${String(next.year)}/${String(next.seasonIndex)}/${String(next.dayOfMonth)}; ${clock}`
    : null;
}

function project(snapshot) {
  return Object.freeze({
    revision: snapshot.revision,
    location: snapshot.location,
    tile: Object.freeze({ x: snapshot.tile?.x ?? null, y: snapshot.tile?.y ?? null }),
    timeOfDay: snapshot.timeOfDay,
    dayOfMonth: snapshot.dayOfMonth,
    seasonIndex: snapshot.seasonIndex,
    year: snapshot.year,
    actionable: snapshot.actionable,
    stamina: snapshot.stamina,
    actorDispositionKind: snapshot.actorDispositionKind ?? null,
  });
}

function describeObservation(observation) {
  return (
    `location=${observation.location} tile=${String(observation.tile.x)},${String(observation.tile.y)} ` +
    `time=${String(observation.timeOfDay)} day=${String(observation.dayOfMonth)}/${String(observation.seasonIndex)}/${String(observation.year)} ` +
    `revision=${String(observation.revision)} actionable=${String(observation.actionable)} stamina=${String(observation.stamina)}`
  );
}

const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * End ONE process by its exact PID. Never a tree, never an image name.
 *
 * `killProcessTree` adds `/T`, which ends the target's descendants as well - and the two role processes are the
 * Guardian's descendants, so a tree kill of the Guardian kills the world with this harness's own hand. That is
 * precisely the defect reading 5 exists to have measured, and it is why this reader has its own kill.
 */
function killExactProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return `invalid_pid:${String(pid)}`;
  const outcome = spawnSync("taskkill", ["/PID", String(pid), "/F"], {
    stdio: "ignore",
    windowsHide: true,
    timeout: 60_000,
  });
  if (outcome.status === 0) return "killed";
  if (outcome.status === TASKKILL_ALREADY_EXITED_STATUS) return "already_exited";
  return `taskkill_status_${String(outcome.status)}`;
}

/** Whether the Mod's bridge pipe is listening, as a fact to assert on rather than infer from a connect failure. */
function bridgePipePresent(pipeName) {
  try {
    return readdirSync("\\\\.\\pipe\\").includes(pipeName);
  } catch {
    return false;
  }
}

function argumentReader(argv) {
  const value = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : undefined;
  };
  return Object.freeze({
    optional: value,
    required(flag) {
      const found = value(flag);
      if (found === undefined) throw new Error(`world_survival_argument_missing:${flag}`);
      return found;
    },
  });
}

/* ------------------------------------------------------------------ roles */

function writeStateFile(path, value) {
  const staged = `${path}.staged`;
  writeFileSync(staged, JSON.stringify(value), "utf8");
  renameSync(staged, path);
}

function readStateFile(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

async function waitForState(path, kind, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const state = readStateFile(path);
    if (state !== null && state.kind === kind) return state;
    const failed = readStateFile(path);
    if (failed !== null && failed.kind.endsWith("_failed")) return null;
    if (Date.now() >= deadline) return null;
    await delay(200);
  }
}

/**
 * The Player Host role: launch the real game, hand the harness its PID, then stay alive holding it.
 *
 * Holding is the whole job. Every termination under test happens outside this process, and the world is only
 * still there because nothing here was killed by one of them.
 */
async function runWorldHost(argv) {
  const option = argumentReader(argv);
  const clientConfig = JSON.parse(readFileSync(option.required("--client-config"), "utf8"));
  const launch = await launchStardewLiveRun({
    gamePath: option.required("--game-path"),
    modsPath: option.required("--mods-path"),
    windowMode: "foreground",
    pipeName: clientConfig.PipeName,
    timeoutMs: WORLD_READY_MS,
    logPath: option.required("--lane-log"),
  });
  writeStateFile(option.required("--state"), {
    kind: "world_host_ready",
    pid: process.pid,
    gamePid: launch.pid,
    pipeName: clientConfig.PipeName,
  });
  setTimeout(() => process.exit(0), ROLE_MAX_LIFETIME_MS).unref();
  setInterval(() => undefined, 1_000);
}

/**
 * The AI authority role: one real authenticated bridge attachment, re-observed while it stays attached.
 *
 * The re-observation exists because the Mod's bridge serves ONE attachment: while this role holds it, a second
 * client cannot connect at all - measured twice on this machine as
 * `ETIMEDOUT:connect ETIMEDOUT \\.\pipe\gamebuddy-stardew`, with the pipe still present. A reading that needs
 * "what the world answers right now" during an attached session therefore has to come from the attached
 * authority itself. Every sample is written to the state file, and a failed sample leaves the last good one in
 * place: the last readable observation is a fact worth keeping, not an error worth overwriting it with.
 */
async function runAiAttach(argv) {
  const option = argumentReader(argv);
  const clientConfig = JSON.parse(readFileSync(option.required("--client-config"), "utf8"));
  const stateFile = option.required("--state");
  let connection = null;
  const publish = (snapshot) => {
    writeStateFile(stateFile, {
      kind: "ai_attached",
      pid: process.pid,
      connected: connection.client.state?.connected === true,
      observedAt: Date.now(),
      observation: project(snapshot),
    });
  };
  try {
    connection = await connectNativeLocalClient(clientConfig, { loadModule: loadBridgeModule });
    publish(await observeFresh(connection.client));
  } catch (error) {
    writeStateFile(stateFile, {
      kind: "ai_attach_failed",
      pid: process.pid,
      reason: error instanceof Error ? `${error.code ?? error.name}:${error.message}` : String(error),
    });
    process.exitCode = 1;
    return;
  }
  const sample = async () => {
    for (;;) {
      await delay(ATTACHED_SAMPLE_INTERVAL_MS);
      try {
        publish(await observeFresh(connection.client));
      } catch {
        // The world ended or the attachment dropped. The state file keeps the last observation the world gave,
        // and its `observedAt` is what tells a reader how old that is.
      }
    }
  };
  void sample();
  setTimeout(() => process.exit(0), ROLE_MAX_LIFETIME_MS).unref();
  setInterval(() => undefined, 1_000);
}

/* ------------------------------------------------------------------ the Guardian control channel */

/**
 * One resident Guardian session, driven exactly as `guardian-live.test.mjs` drives it: `arm_attempt` on the
 * public stdin channel, then the private arm frame over the named pipe it opens, then public commands whose
 * results arrive as one JSON line each.
 */
/** Each channel step is bounded: an unanswered Guardian frame must not hang the whole gate. */
const SESSION_STEP_TIMEOUT_MS = 60_000;

async function openGuardianSession({ label }) {
  const controlPipe = `GameBuddyWorldSurvival-${label}-${String(Date.now())}`;
  const token = randomUUID();
  const guardianInstanceId = randomUUID();
  const attemptId = randomUUID();
  const child = spawn(GUARDIAN, [], {
    cwd: REPO,
    windowsHide: true,
    shell: false,
    env: {
      ...process.env,
      GAMEBUDDY_GUARDIAN_MODE: "resident",
      GAMEBUDDY_GUARDIAN_CONTROL_PIPE: controlPipe,
      GAMEBUDDY_GUARDIAN_CONTROL_TOKEN: token,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const publicResults = [];
  const nextPublicLine = lineReader(child.stdout, (line) => {
    try {
      publicResults.push(JSON.parse(line).result);
    } catch {
      publicResults.push("unparsed");
    }
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const sendPublic = (command) => child.stdin.write(`${JSON.stringify(command)}\n`);
  const publicCommand = (operation, role) => ({
    schemaVersion: 1,
    operation,
    guardianInstanceId,
    guardianEpoch: 1,
    attemptId,
    ...(role === undefined ? {} : { role }),
  });

  const within = async (promise, step) => {
    const outcome = await Promise.race([
      promise.then((value) => ({ value })),
      delay(SESSION_STEP_TIMEOUT_MS).then(() => ({ timedOut: true })),
    ]);
    if (outcome.timedOut === true) throw new Error(`guardian_channel_timeout:${step}`);
    return outcome.value;
  };
  sendPublic(publicCommand("arm_attempt"));
  const socket = await connectPipe(`\\\\.\\pipe\\${controlPipe}`, child);
  const nextPrivateLine = lineReader(socket);
  socket.write(
    `${JSON.stringify({
      token,
      guardianInstanceId,
      guardianEpoch: 1,
      attemptId,
      revision: randomUUID(),
      leaseName: `Local\\WorldSurvivalLease-${randomUUID()}`,
      playerJobName: `Local\\WorldSurvivalPlayer-${randomUUID()}`,
      aiJobName: `Local\\WorldSurvivalAi-${randomUUID()}`,
      // The arm fixes the approved executable; the plan must name this exact file or the launch is refused.
      approvedExecutable: process.execPath,
    })}\n`,
  );
  const armedPrivate = await within(nextPrivateLine(), "arm_private");
  const armedPublic = JSON.parse(await within(nextPublicLine(), "arm_public")).result;

  const session = {
    child,
    armedPrivate,
    armedPublic,
    publicResults,
    stderr: () => stderr,
    async launch(role, args) {
      socket.write(
        `${JSON.stringify({
          guardianInstanceId,
          guardianEpoch: 1,
          attemptId,
          planId: randomUUID(),
          role,
          deadlineUnixMs: Date.now() + 60_000,
          executable: process.execPath,
          cwd: REPO,
          arguments: args,
          environment: roleEnvironment(),
        })}\n`,
      );
      sendPublic(publicCommand("launch_role", role));
      const accepted = await within(nextPrivateLine(), `launch_private:${role}`);
      const result = JSON.parse(await within(nextPublicLine(), `launch_public:${role}`)).result;
      return Object.freeze({ accepted, result });
    },
    async contain(role) {
      sendPublic(publicCommand("contain_role", role));
      return JSON.parse(await within(nextPublicLine(), `contain:${role}`)).result;
    },
    async closeControllerChannel() {
      child.stdin.end();
    },
    /**
     * The controller closes the Guardian's last session handle and nothing else.
     *
     * Deliberately NOT `killProcessTree`: that runs `taskkill /T`, which ends the Guardian AND every descendant
     * - and the two role processes are its descendants. A tree kill would therefore kill the world itself and
     * the survival reading would be an artifact of this harness.
     *
     * The kill is of the EXACT PID, and the world is expected to survive it because the Guardian creates the
     * Player Job with `killOnJobClose: false` (`Program.cs:66`, "Player world ownership survives
     * guardian/controller closure"). Losing the last handle to a non-kill-on-close Job does not end its
     * processes, so this reading measures the product's Job limit, not a timeout.
     */
    async closeLastHandle() {
      socket.destroy();
      const outcome = killExactProcess(child.pid);
      const exited = await session.exitedWithin(TERMINATION_SETTLE_MS);
      return Object.freeze({ outcome, exited });
    },
    async exitedWithin(milliseconds) {
      const deadline = Date.now() + milliseconds;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) return true;
        await delay(50);
      }
      return child.exitCode !== null;
    },
    async terminate() {
      socket.destroy();
      if (isProcessAlive(child.pid)) killProcessTree(child.pid);
      await session.exitedWithin(TERMINATION_SETTLE_MS);
    },
  };
  return Object.freeze(session);
}

/** The exact allowlisted role environment; no ambient inheritance reaches a role. */
function roleEnvironment() {
  const pick = (name, fallback) => ({ [name]: process.env[name] ?? fallback });
  return {
    ...pick("PATH", "C:\\Windows\\System32"),
    ...pick("SystemRoot", "C:\\Windows"),
    ...pick("WINDIR", "C:\\Windows"),
    ...pick("TEMP", "C:\\Windows\\Temp"),
    ...pick("TMP", "C:\\Windows\\Temp"),
    ...pick("USERPROFILE", "C:\\Users\\Default"),
    GAMEBUDDY_STARDEW_LAUNCH_GENERATION: "world-survival-live",
  };
}

function lineReader(stream, onLine = () => {}) {
  let buffered = "";
  const lines = [];
  const waiters = [];
  let terminalError;
  const deliver = () => {
    while (lines.length > 0 && waiters.length > 0) waiters.shift().resolve(lines.shift());
    if (terminalError !== undefined) while (waiters.length > 0) waiters.shift().reject(terminalError);
  };
  stream.on("data", (chunk) => {
    buffered += String(chunk);
    for (;;) {
      const index = buffered.indexOf("\n");
      if (index < 0) break;
      const line = buffered.slice(0, index);
      buffered = buffered.slice(index + 1);
      onLine(line);
      lines.push(line);
    }
    deliver();
  });
  stream.once("error", (error) => {
    terminalError ??= error;
    deliver();
  });
  stream.once("end", () => {
    terminalError ??= new Error("stream ended before line");
    deliver();
  });
  return () => {
    if (lines.length > 0) return Promise.resolve(lines.shift());
    if (terminalError !== undefined) return Promise.reject(terminalError);
    return new Promise((resolveLine, rejectLine) => waiters.push({ resolve: resolveLine, reject: rejectLine }));
  };
}

async function connectPipe(path, child) {
  let last;
  for (let attempt = 0; attempt < 800; attempt += 1) {
    if (child.exitCode !== null) throw new Error("guardian_exited_before_private_pipe");
    const candidate = net.createConnection({ path });
    try {
      await new Promise((connected, failed) => {
        candidate.once("connect", connected);
        candidate.once("error", failed);
      });
      return candidate;
    } catch (error) {
      last = error;
      candidate.destroy();
      if (error?.code !== "ENOENT") throw error;
      await delay(25);
    }
  }
  throw last ?? new Error("guardian_private_pipe_unavailable");
}

/* ------------------------------------------------------------------ the observer */

/**
 * One real observation of the world through a fresh authenticated attachment.
 *
 * Fresh every time on purpose: the product's own reconnect rule is that AI authority comes back only through a
 * new authentication and observation sync (what `attachResumedWorld`/`resume` do), so a reused client would
 * prove nothing about a world a previous attachment had stopped talking to.
 */
async function observeWorld(clientConfig, { windowMs }) {
  const deadline = Date.now() + windowMs;
  let attempts = 0;
  let lastError = null;
  while (Date.now() < deadline) {
    attempts += 1;
    let connection = null;
    try {
      connection = await connectNativeLocalClient(clientConfig, { loadModule: loadBridgeModule });
      const snapshot = await observeFresh(connection.client);
      return Object.freeze({ ok: true, attempts, observation: project(snapshot), error: null });
    } catch (error) {
      lastError = error instanceof Error ? `${error.code ?? error.name}:${error.message}` : String(error);
      await delay(750);
    } finally {
      if (connection !== null) {
        try {
          await connection.close();
        } catch {
          // A connection that could not observe is closed best-effort; the reading is the observation.
        }
      }
    }
  }
  return Object.freeze({ ok: false, attempts, observation: null, error: lastError ?? "observe_window_elapsed" });
}

/**
 * The newest observation the ATTACHED authority published, how old it is, and whether it advanced.
 *
 * Deliberately not a fresh connect: the Mod's bridge serves one attachment, so while the AI authority holds it
 * a second client cannot connect at all (measured twice as `ETIMEDOUT ... \\.\pipe\gamebuddy-stardew`, with
 * the pipe present). Reading the world's own answer to the authority that IS attached is both the possible
 * reading and the truer one - it is the same answer the product's AI would act on.
 *
 * A sample older than `ATTACHED_OBSERVATION_MAX_AGE_MS` is not "what the world answers now", and a paused world
 * produces a fresh sample that never advances; the two checks catch different failures.
 */
async function readAttachedAdvance(statePath, previous, { windowMs }) {
  const deadline = Date.now() + windowMs;
  let latest = null;
  let ageMs = null;
  let advance = null;
  while (Date.now() < deadline) {
    const state = readStateFile(statePath);
    if (state?.kind === "ai_attached" && state.observation != null) {
      latest = state.observation;
      ageMs = Number.isSafeInteger(state.observedAt) ? Date.now() - state.observedAt : null;
      advance = previous === null ? null : describeAdvance(previous, latest);
      const fresh = ageMs !== null && ageMs <= ATTACHED_OBSERVATION_MAX_AGE_MS;
      if (fresh && advance !== null) break;
    }
    await delay(250);
  }
  return Object.freeze({ latest, ageMs, advance });
}

/* ------------------------------------------------------------------ the three sessions */

async function prepareRunRoot(plan, label) {
  const root = join(plan.root, label);
  mkdirSync(root, { recursive: true });
  return Object.freeze({
    root,
    worldState: join(root, "world-host.json"),
    aiState: join(root, "ai-attach.json"),
    aiCrashState: join(root, "ai-crash.json"),
    laneLog: join(root, "smapi-lane.log"),
  });
}

async function launchWorldHost(run, plan) {
  const launched = await plan.session.launch("player_host", [
    SELF,
    "--client-config",
    plan.clientConfigPath,
    "--game-path",
    plan.installRoot,
    "--mods-path",
    plan.modsPath,
    "--lane-log",
    run.laneLog,
    "--state",
    run.worldState,
    "--role",
    "world-host",
  ]);
  const state = await waitForState(run.worldState, "world_host_ready", WORLD_READY_MS);
  return Object.freeze({
    launched,
    state,
    pid: state?.pid ?? null,
    gamePid: state?.gamePid ?? null,
  });
}

async function launchGuardianAiAuthority(run, plan) {
  const launched = await plan.session.launch("ai_client", [
    SELF,
    "--client-config",
    plan.clientConfigPath,
    "--state",
    run.aiState,
    "--role",
    "ai-attach",
  ]);
  const state = await waitForState(run.aiState, "ai_attached", ATTACH_MS);
  return Object.freeze({ launched, state, failed: state === null ? readStateFile(run.aiState) : null });
}

/** The AI-side process this harness owns, so a force-kill is of an exact PID it launched itself. */
async function launchHarnessAiAuthority(run, plan) {
  const child = spawn(
    process.execPath,
    [SELF, "--client-config", plan.clientConfigPath, "--state", run.aiCrashState, "--role", "ai-attach"],
    { windowsHide: true, stdio: ["ignore", "ignore", "ignore"], env: { ...process.env } },
  );
  const state = await waitForState(run.aiCrashState, "ai_attached", ATTACH_MS);
  return Object.freeze({ child, state, pid: state?.pid ?? child.pid ?? null });
}

/** Reading 1: the world is up and an AI authority is really attached to it. */
async function readWorldUp(world, ai, phase) {
  const live = listStardewProcessIds();
  record(
    `[${phase}] the real Player Host and game world came up`,
    world.launched.result === "role_active" &&
      Number.isSafeInteger(world.gamePid) &&
      live.includes(world.gamePid) &&
      isProcessAlive(world.pid),
    `guardian_role=${world.launched.result} world_host_pid=${String(world.pid)} game_pid=${String(world.gamePid)} ` +
      `stardew_images=${live.join(",") || "none"}`,
  );
  record(
    `[${phase}] the AI authority attached over the real bridge and read a real world`,
    ai.state !== null && ai.state.connected === true && ai.state.observation != null,
    ai.state === null
      ? `no AI attachment (state=${JSON.stringify(ai.failed)})`
      : `ai_pid=${String(ai.state.pid)} connected=${String(ai.state.connected)} ${describeObservation(ai.state.observation)}`,
  );
  return Object.freeze({ observation: ai.state?.observation ?? null });
}

/**
 * After a termination: the world is still there, and it ANSWERS with an observation newer than the last.
 *
 * The advance is POLLED to a deadline rather than sampled once: the world clock moves 10 game-minutes per
 * ~7 s of real time, so two readings a few seconds apart can legitimately agree while the world is perfectly
 * alive. A single sample would turn that arithmetic into a false red.
 */
async function readSurvivalAfter(plan, phase, scenario, world, previous) {
  const aliveHost = isProcessAlive(world.pid);
  const live = listStardewProcessIds();
  const aliveGame = live.includes(world.gamePid);
  record(
    `[${phase}] ${scenario}: the Player Host and the world are still there`,
    aliveHost && aliveGame,
    `world_host_pid=${String(world.pid)} alive=${String(aliveHost)} game_pid=${String(world.gamePid)} ` +
      `alive=${String(aliveGame)} stardew_images=${live.join(",") || "none"}`,
  );
  const deadline = Date.now() + OBSERVE_WINDOW_MS;
  let attempts = 0;
  let latest = null;
  let advance = null;
  let lastError = null;
  while (Date.now() < deadline) {
    attempts += 1;
    const observed = await observeWorld(plan.clientConfig, { windowMs: 20_000 });
    if (!observed.ok) {
      lastError = observed.error;
      await delay(500);
      continue;
    }
    latest = observed.observation;
    advance = previous === null ? null : describeAdvance(previous, latest);
    if (advance !== null) break;
    await delay(1_000);
  }
  record(
    `[${phase}] ${scenario}: a new observation is readable from the surviving world`,
    latest !== null,
    latest === null
      ? `no observation after ${String(attempts)} attempt(s): ${String(lastError)}`
      : `attempts=${String(attempts)} ${describeObservation(latest)}`,
  );
  record(
    `[${phase}] ${scenario}: the world ADVANCED since the previous reading`,
    advance !== null,
    advance ??
      `no advance within ${String(OBSERVE_WINDOW_MS)}ms: ${latest === null ? "no observation" : describeObservation(latest)} ` +
        `(previous revision=${String(previous?.revision)} time=${String(previous?.timeOfDay)})`,
  );
  return latest ?? previous;
}

/**
 * Reclaim exactly what this run launched: the game tree by its own PID, then the Player Host role.
 *
 * A survivor this run did not launch is never killed - it is reported by identity, because a stray Stardew
 * process may be the player's own game. A reclamation that cannot complete is REPORTED, never thrown: the
 * readings this run already took are its verdict, and a teardown failure must not replace them.
 */
function teardownWorld(world) {
  for (const [label, pid] of [
    ["game", world.gamePid],
    ["world-host", world.pid],
  ]) {
    if (!Number.isSafeInteger(pid) || !isProcessAlive(pid)) continue;
    try {
      killProcessTree(pid);
    } catch (error) {
      note(
        `reclamation of the ${label} (${String(pid)}) failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const survivors = listStardewProcessIds().filter((pid) => pid === world.gamePid);
  if (survivors.length > 0) note(`launched game pid survived its own reclamation: ${survivors.join(",")}`);
}

/**
 * Session A: the AI authority stops three ways and the world does not.
 *
 * Order is load-bearing: the ordinary close consumes the Guardian's own AI role, so the AI crash afterwards
 * must be a process this harness launched itself. That is also the truer reading - "the AI side died" is a
 * fact about the AI process, and taking the role's exact PID from the Guardian's launch only works once.
 */
async function aiSideSession(plan) {
  const run = await prepareRunRoot(plan, "ai-side");
  const session = await openGuardianSession({ label: "ai-side" });
  let world = Object.freeze({ pid: null, gamePid: null });
  let crashChild = null;
  try {
    record(
      "[A] the Guardian armed and accepted the private arm frame",
      session.armedPrivate === "accepted" && session.armedPublic === "armed",
      `private=${session.armedPrivate} public=${session.armedPublic}`,
    );
    world = await launchWorldHost(run, { ...plan, session });
    const ai = await launchGuardianAiAuthority(run, { ...plan, session });
    const first = await readWorldUp(world, ai, "A");
    if (world.gamePid === null) return;

    // Reading 2: ordinary close. The coordinator's close contains the AI role and nothing else.
    const contained = await session.contain("ai_client");
    record(
      "[A] ordinary close contained the AI role (the coordinator's own close operation)",
      contained === "role_contained",
      `contain_role ai_client => ${contained}`,
    );
    const afterClose = await readSurvivalAfter(plan, "A", "ordinary close", world, first.observation);

    // Reading 3: AI crash, by the exact PID of an AI-side process this harness started.
    const crash = await launchHarnessAiAuthority(run, plan);
    crashChild = crash.child;
    record(
      "[A] a second AI authority attached before the crash",
      crash.state !== null,
      crash.state === null
        ? `no attachment (state=${JSON.stringify(readStateFile(run.aiCrashState))})`
        : `ai_pid=${String(crash.pid)} ${describeObservation(crash.state.observation)}`,
    );
    const killed = killProcessTree(crash.pid);
    let gone = false;
    for (let attempt = 0; attempt < 60 && !gone; attempt += 1) {
      gone = !isProcessAlive(crash.pid);
      if (!gone) await delay(100);
    }
    record(
      "[A] the AI authority was force-killed by its exact PID",
      gone,
      `taskkill=${killed} ai_pid=${String(crash.pid)} alive=${String(!gone)}`,
    );
    await delay(TERMINATION_SETTLE_MS);
    const afterCrash = await readSurvivalAfter(plan, "A", "AI crash", world, afterClose);

    // Reading 4: controller EOF on the Guardian's control channel.
    await session.closeControllerChannel();
    const exited = await session.exitedWithin(TERMINATION_SETTLE_MS);
    record(
      "[A] the controller closed its channel and the Guardian exited",
      exited,
      `guardian_pid=${String(session.child.pid)} exit_code=${String(session.child.exitCode)} within=${String(TERMINATION_SETTLE_MS)}ms`,
    );
    await readSurvivalAfter(plan, "A", "controller EOF", world, afterCrash);
  } finally {
    await session.terminate();
    if (crashChild !== null && isProcessAlive(crashChild.pid)) killProcessTree(crashChild.pid);
    teardownWorld(world);
    keepOrRemoveRoot(run.root);
  }
}

/** Session B: the Guardian holds the last handle on the Player Job, and loses it. */
async function guardianCloseSession(plan) {
  const run = await prepareRunRoot(plan, "guardian-close");
  const session = await openGuardianSession({ label: "guardian-close" });
  let world = Object.freeze({ pid: null, gamePid: null });
  try {
    world = await launchWorldHost(run, { ...plan, session });
    record(
      "[B] the real Player Host and game world came up under the Guardian",
      world.launched.result === "role_active" &&
        Number.isSafeInteger(world.gamePid) &&
        listStardewProcessIds().includes(world.gamePid),
      `guardian_role=${world.launched.result} world_host_pid=${String(world.pid)} game_pid=${String(world.gamePid)}`,
    );
    if (world.gamePid === null) return;
    const before = await observeWorld(plan.clientConfig, { windowMs: OBSERVE_WINDOW_MS });
    record(
      "[B] a baseline observation was read before the Guardian was lost",
      before.ok,
      before.ok ? describeObservation(before.observation) : `no observation: ${String(before.error)}`,
    );

    // Reading 5: the Guardian's last session handle is closed - its exact PID, never its tree.
    const closed = await session.closeLastHandle();
    record(
      "[B] the Guardian was terminated by its exact PID (no /T, so no descendant was touched by this harness)",
      closed.exited && !isProcessAlive(session.child.pid),
      `guardian_pid=${String(session.child.pid)} kill=${closed.outcome} exited=${String(closed.exited)} ` +
        `alive=${String(isProcessAlive(session.child.pid))} exit_code=${String(session.child.exitCode)}`,
    );
    await delay(TERMINATION_SETTLE_MS);
    record(
      "[B] the world's bridge pipe was still listening the instant the Guardian was gone",
      bridgePipePresent(plan.clientConfig.PipeName),
      `pipe=${plan.clientConfig.PipeName} present=${String(bridgePipePresent(plan.clientConfig.PipeName))}`,
    );
    await readSurvivalAfter(plan, "B", "guardian last-handle close", world, before.ok ? before.observation : null);
  } finally {
    await session.terminate();
    teardownWorld(world);
    keepOrRemoveRoot(run.root);
  }
}

/**
 * Session C: the operation explicit endgame drives is the only thing that ends the world.
 *
 * The contrast is the reading: sessions A and B ended the AI authority three different ways, and the world was
 * still answering. The same launch recipe here stops answering the moment the Player is contained.
 *
 * The "still answering" half is read from the ATTACHED authority's own samples, not from a fresh connection: the
 * Mod's bridge serves one attachment, so while the AI authority holds it a second client cannot connect at all
 * (measured: `ETIMEDOUT ... \\.\pipe\gamebuddy-stardew`, pipe present).
 */
async function endgameContainmentSession(plan) {
  const run = await prepareRunRoot(plan, "endgame");
  const session = await openGuardianSession({ label: "endgame" });
  let world = Object.freeze({ pid: null, gamePid: null });
  try {
    world = await launchWorldHost(run, { ...plan, session });
    const ai = await launchGuardianAiAuthority(run, { ...plan, session });
    const worldUp = await readWorldUp(world, ai, "C");
    if (world.gamePid === null) return;

    // Reading 6, first half: the world is alive AND ANSWERING in the instant before the Player is contained.
    // Both halves are one reading: without this, "the world was terminated" is also satisfied by a world that
    // had already stopped answering a minute earlier, which would prove nothing about containment. The answer is
    // taken from the attached AI authority, because a second client cannot attach at all while it holds the pipe.
    const beforeEndgame = await readAttachedAdvance(run.aiState, worldUp.observation, { windowMs: OBSERVE_WINDOW_MS });
    const attachedFresh =
      beforeEndgame.latest !== null &&
      beforeEndgame.ageMs !== null &&
      beforeEndgame.ageMs <= ATTACHED_OBSERVATION_MAX_AGE_MS;
    record(
      "[C] the attached AI authority read the world moments before the Player was contained",
      attachedFresh,
      beforeEndgame.latest === null
        ? `no attached observation was published in ${run.aiState}`
        : `age_ms=${String(beforeEndgame.ageMs)} ${describeObservation(beforeEndgame.latest)}`,
    );
    record(
      "[C] the world ADVANCED between the AI authority's attach and the Player's containment",
      beforeEndgame.advance !== null,
      beforeEndgame.advance ??
        `no advance: ${beforeEndgame.latest === null ? "no observation" : describeObservation(beforeEndgame.latest)} ` +
          `(attach reading revision=${String(worldUp.observation?.revision)} time=${String(worldUp.observation?.timeOfDay)})`,
    );

    // The two liveness facts are re-read immediately before the call, so "it was alive when it was ended" is not
    // carried over from a reading taken seconds earlier.
    const aliveAtContainment = isProcessAlive(world.pid) && listStardewProcessIds().includes(world.gamePid);
    const pipeAtContainment = bridgePipePresent(plan.clientConfig.PipeName);
    const containedAt = Date.now();
    const contained = await session.contain("player_host");
    record(
      "[C] explicit endgame's Player containment was driven (containPlayerHost) against a world that was alive and answering",
      contained === "role_contained" && aliveAtContainment && pipeAtContainment && attachedFresh,
      `contain_role player_host => ${contained} world_host_pid=${String(world.pid)} alive_at_containment=${String(aliveAtContainment)} ` +
        `game_pid=${String(world.gamePid)} pipe_present_at_containment=${String(pipeAtContainment)} ` +
        `last_observation=${beforeEndgame.latest === null ? "none" : describeObservation(beforeEndgame.latest)} ` +
        `observation_age_ms=${String(beforeEndgame.ageMs)}`,
    );

    let gameGone = false;
    let goneAfterMs = null;
    const deadline = Date.now() + ROLE_EXIT_SETTLE_MS;
    while (Date.now() < deadline) {
      gameGone = !listStardewProcessIds().includes(world.gamePid);
      if (gameGone) {
        goneAfterMs = Date.now() - containedAt;
        break;
      }
      await delay(100);
    }
    record(
      "[C] the world was terminated by that containment, and only then",
      gameGone,
      `game_pid=${String(world.gamePid)} gone_after_ms=${String(goneAfterMs)} still_listed=${String(!gameGone)} ` +
        `stardew_images=${listStardewProcessIds().join(",") || "none"}`,
    );
    const hostGone = !isProcessAlive(world.pid);
    const pipeGone = !bridgePipePresent(plan.clientConfig.PipeName);
    record(
      "[C] the Player Host process went with the Player Job, and the bridge pipe stopped listening",
      hostGone && pipeGone,
      `world_host_pid=${String(world.pid)} alive=${String(!hostGone)} ` +
        `pipe=${plan.clientConfig.PipeName} present=${String(!pipeGone)}`,
    );

    const after = await observeWorld(plan.clientConfig, { windowMs: 15_000 });
    record(
      "[C] no observation is possible from the ended world",
      !after.ok,
      `attempts=${String(after.attempts)} pipe_present=${String(bridgePipePresent(plan.clientConfig.PipeName))} error=${String(after.error)}`,
    );
    note(
      "[C] the `gameended` projection is NOT reached by this reading: it is minted by the authenticated " +
        "`game_endgame` operation, which needs a full desktop-composition activation (browser admission, a Pi " +
        "runtime and an AI provider credential). What is proven here is the containment that ends the world.",
    );
    await session.contain("ai_client");
  } finally {
    await session.terminate();
    teardownWorld(world);
    keepOrRemoveRoot(run.root);
  }
}

/** A red run keeps its lane log and state files.
 *
 * Only the SESSION's own directory is removed on green: the gate root holds the Mod copy every later session
 * loads through `--mods-path`, so it is removed once, at the end of the whole gate.
 */
function keepOrRemoveRoot(runRoot) {
  if (findings.some((finding) => !finding.ok)) {
    note(`run root kept for diagnosis: ${runRoot}`);
    return;
  }
  rmSync(runRoot, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ environment */

/**
 * The bridge client's own module, from the immutable published generation when that generation can serve it.
 *
 * `local-stardew-bridge.js` lazily imports `composition/companion-session-reflection.js`, and a published
 * generation that predates that file refuses the entry with `production_dynamic_external_module_missing`. That
 * refusal is recorded, not smoothed over: which artifact served the AI authority's attachment is part of what
 * this run can be said to have tested.
 */
let bridgeModule = null;
let bridgeArtifactLabel = "unresolved";
async function loadBridgeModule() {
  if (bridgeModule !== null) return bridgeModule;
  try {
    const selected = await selectHostProductionArtifact();
    bridgeModule = await loadSelectedHostProductionModule(selected, "local-stardew-bridge.js");
    bridgeArtifactLabel = `published generation ${String(selected.generation ?? "")}`.trim();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    bridgeModule = await import(fileUrlOf(join(REPO, "host", "dist-test", "local-stardew-bridge.js")));
    bridgeArtifactLabel = `host/dist-test, because the published generation could not serve the bridge entry (${reason})`;
  }
  return bridgeModule;
}

/**
 * Every environment fact comes from an authority that already owns it.
 *
 * The installation is the product's own discovery (the provider the OOBE runs), never a path written here; the
 * Mod tree, the save binding and the bridge pipe/token are the fixture transaction's, resolved by the one
 * shared resolver, and the fixture scenario comes from the fixture's own `fixtureScenario` table.
 *
 * The Mod tree is COPIED into this gate's own root instead of written into the shared fixture root: a run here
 * must not rewrite a config another lane's game is about to load, and the shared root's config is another run's
 * leftover in any case. Only the scenario leaf differs from the copy's source, and that difference is printed.
 */
function prepareGateRoot() {
  const root = mkdtempSync(join(tmpdir(), "gamebuddy-world-survival-gate-"));
  return Object.freeze({ root, modsPath: join(root, "mods"), label: "gate" });
}

async function resolveEnvironment() {
  if (!existsSync(GUARDIAN)) throw new Error(`world_survival_blocked:guardian_missing:${GUARDIAN}`);
  if (!existsSync(DISCOVERY)) throw new Error(`world_survival_blocked:discovery_not_built:${DISCOVERY}`);
  const { discoverStardewGameInstallation } = await import(fileUrlOf(DISCOVERY));
  const resolution = await discoverStardewGameInstallation({});
  if (resolution.kind !== "resolved") throw new Error(`world_survival_blocked:installation_${resolution.kind}`);
  const installRoot = resolution.installation.installRoot;

  const fixtureRoot = resolveStardewFixtureRoots().fixturesRoot;
  const sourceMods = join(fixtureRoot, "mods");
  const sourceConfigPath = join(sourceMods, "GameBuddy", "config.json");
  if (!existsSync(sourceConfigPath)) throw new Error(`world_survival_blocked:mod_config_missing:${sourceConfigPath}`);
  const sourceConfig = JSON.parse(readFileSync(sourceConfigPath, "utf8"));
  const fixture = sourceConfig.NativeLocalPlayerFixture;
  if (fixture?.Enable !== true) throw new Error("world_survival_blocked:fixture_mode_disabled_in_mod_config");
  const saveSlot = join(process.env.APPDATA ?? "", "StardewValley", "Saves", String(fixture.ObservedSaveSlot));
  if (!existsSync(saveSlot)) throw new Error(`world_survival_blocked:fixture_save_missing:${saveSlot}`);

  const gate = prepareGateRoot();
  cpSync(sourceMods, gate.modsPath, { recursive: true });
  const clientConfigPath = join(gate.modsPath, "GameBuddy", "config.json");
  // The plain play session: this gate needs a live, observation-answering world, not a multi-day script, and
  // the multi-day Given refuses a save whose skills it cannot pin (`fixture_native_local_multi_day_skill_not_pinned`).
  const scenario = fixtureScenario(Object.freeze([]), "play_session");
  const clientConfig = {
    ...sourceConfig,
    NativeLocalPlayerFixture: { ...fixture, FixtureScenario: scenario, NavigationMutationTargetLabel: "" },
  };
  writeFileSync(clientConfigPath, JSON.stringify(clientConfig, null, 2), "utf8");
  for (const field of ["PipeName", "BridgeToken", "SaveId", "WorldId", "PlayerId", "CompanionId"]) {
    if (typeof clientConfig[field] !== "string" || clientConfig[field].length === 0)
      throw new Error(`world_survival_blocked:mod_config_field_${field}`);
  }
  const modDll = join(gate.modsPath, "GameBuddy", "GameBuddy.Stardew.dll");
  if (!existsSync(modDll)) throw new Error(`world_survival_blocked:mod_assembly_missing:${modDll}`);
  /**
   * The fixture root is shared with every other live lane, and a game already listening on this pipe would be
   * attached to instead of this run's own. That is a refusal, never a warning: a reading taken against another
   * lane's world says nothing about this one.
   */
  const live = listStardewProcessIds();
  if (live.length > 0) throw new Error(`world_survival_blocked:another_stardew_is_running:${live.join(",")}`);
  if (readdirSync("\\\\.\\pipe\\").includes(clientConfig.PipeName))
    throw new Error(`world_survival_blocked:bridge_pipe_already_listening:${clientConfig.PipeName}`);
  await loadBridgeModule();

  return Object.freeze({
    root: gate.root,
    installRoot,
    source: resolution.installation.source,
    modsPath: gate.modsPath,
    clientConfigPath,
    clientConfig,
    saveSlot,
    modDll,
    scenario,
    sourceScenario: fixture.FixtureScenario,
  });
}

function fileUrlOf(path) {
  const normalized = path.replaceAll("\\", "/");
  return normalized.startsWith("/") ? `file://${normalized}` : `file:///${normalized}`;
}

/* ------------------------------------------------------------------ main */

async function main(argv) {
  const option = argumentReader(argv);
  const role = option.optional("--role");
  if (role === "world-host") return await runWorldHost(argv);
  if (role === "ai-attach") return await runAiAttach(argv);
  if (role !== undefined) throw new Error(`world_survival_unknown_role:${role}`);
  /**
   * This file spawns itself as roles, and a role that failed to recognize its own role would run the whole
   * close/containment sequence against a world it never launched. The witnesses are the argument and the
   * environment, so an inherited live child cannot reach the parent branch either.
   */
  if (process.env.GAMEBUDDY_LIVE_CHILD === "1") throw new Error("world_survival_refuses_parent_branch_in_a_child");
  if (process.platform !== "win32") throw new Error("world_survival_blocked:the_guardian_is_windows_only");

  const plan = await resolveEnvironment();
  console.log(
    `stardew_world_survival: install=${plan.installRoot} source=${plan.source} mods=${plan.modsPath} ` +
      `save_slot=${plan.saveSlot} mod_dll=${plan.modDll}`,
  );
  console.log(
    `stardew_world_survival: fixture_scenario=${plan.scenario} (shared root carried ${String(plan.sourceScenario)}) ` +
      `bridge_artifact=${bridgeArtifactLabel}`,
  );
  const startedAt = Date.now();
  const only = (option.optional("--only") ?? "A,B,C")
    .split(",")
    .map((phase) => phase.trim().toUpperCase())
    .filter((phase) => phase.length > 0);
  if (only.includes("A")) await aiSideSession(plan);
  if (only.includes("B")) await guardianCloseSession(plan);
  if (only.includes("C")) await endgameContainmentSession(plan);
  if (!findings.some((finding) => !finding.ok)) rmSync(plan.root, { recursive: true, force: true });

  const failed = findings.filter((finding) => !finding.ok);
  console.log(
    `stardew_world_survival: examined ${String(findings.length)} reading(s) on this machine, ${String(failed.length)} disagreement(s), ${String(Math.round((Date.now() - startedAt) / 1000))}s`,
  );
  for (const limitation of NOT_PROVEN) console.log(`stardew_world_survival: NOT PROVEN: ${limitation}`);
  console.log(
    `stardew_world_survival_readings ${JSON.stringify({
      schema: "gamebuddy-stardew-world-survival/v1",
      install: plan.installRoot,
      examined: findings.length,
      agreed: findings.length - failed.length,
      disagreements: failed.map((finding) => finding.question),
      notProven: NOT_PROVEN,
      findings,
    })}`,
  );
  if (failed.length > 0) process.exitCode = 1;
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(`world_survival_blocked: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exitCode = 2;
}
