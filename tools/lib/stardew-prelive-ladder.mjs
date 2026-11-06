/**
 * The four-rung "prelive" ladder for the native-local fixture launcher.
 *
 * A prelive run answers ONE question in about twenty seconds and nothing else: does this fixture still
 * boot, arm its world, speak over the bridge, and leave cleanly? It dispatches no action and calls no
 * model. That makes it cheap enough to run before every live gate, which is the point: the failure it
 * exists for (measured 2026-11-05: a missing Mod-side scenario for `move_to_tile` was rejected at launch and
 * the game then idled at `frame=1` for 303 seconds) costs a whole boot to discover otherwise.
 *
 * The rungs are ordered by dependency, and each one is red for a distinct cause:
 *
 *   1. `config_accepted`            the Mod's own pre-attachment gate accepted the armed scenario
 *   2. `bridge_listening`           the named pipe answers (the launcher's existing readiness wait)
 *   3. `first_snapshot_actionable`  the world is actually playable, not merely connected
 *   4. `clean_teardown`             the deliberate disconnect logged no fatal marker
 *
 * Rung 4 exists because nothing tested it: commit 8bc21682 fixed a NullReferenceException thrown at world
 * setup when the bridge was off, and a disconnect-time equivalent would today be invisible - the game
 * process is torn down a second later, so nobody reads the line it wrote.
 *
 * Rung 1's acceptance line is the Mod's OWN, never a second spelling invented here. Which line that is
 * depends on the armed scenario, and the discriminator is the same `FixtureScenario` field the Mod reads: a
 * scenario with an empty name provisions nothing and logs nothing
 * (`TryInitializeNativeLocalPlayerFixtureScenario` returns early), so its acceptance evidence is the Mod's
 * arming line; every non-empty scenario announces `initialized ... before bridge attachment` once its
 * precondition stands.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadHostTestModule } from "./host-test-module.mjs";
import { REBUILD_COMMAND, assessLiveRunArtifactFreshness } from "./live-run-artifact-freshness.mjs";
import {
  connectNativeLocalClient,
  delay,
  readNativeClientConfig,
  summarizeSnapshot,
  waitForActionable,
} from "./stardew-native-smoke-harness-v1.mjs";

const PRELIVE_REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The ladder itself: one row per rung, in order, carrying the rung number, the name a reader sees, and the
 * code a PASS reports. The numbers live here only, so the launcher, the result JSON and the tests cannot
 * disagree about which rung is which.
 */
export const PRELIVE_RUNGS = Object.freeze([
  Object.freeze({ rung: 1, name: "config_accepted", passCode: "prelive_config_accepted" }),
  Object.freeze({ rung: 2, name: "bridge_listening", passCode: "prelive_bridge_listening" }),
  Object.freeze({ rung: 3, name: "first_snapshot_actionable", passCode: "prelive_snapshot_actionable" }),
  Object.freeze({ rung: 4, name: "clean_teardown", passCode: "prelive_clean_teardown" }),
]);

/** Every way a rung can be RED, named. A caller matches these codes; it never parses a message. */
export const PRELIVE_FAILURE_CODES = Object.freeze({
  /** The Mod rejected the profile at launch (`GameBuddy rejected ...`). */
  configRejected: "prelive_config_rejected",
  /** The Mod's world-setup gate rejected the armed scenario (`... fixture rejected ...`). */
  scenarioRejected: "prelive_scenario_rejected",
  /** The bound expired with neither an acceptance nor a rejection: the scenario never armed. */
  scenarioNotInitialized: "prelive_scenario_not_initialized",
  /** The pipe never answered. */
  bridgeNotListening: "prelive_bridge_not_listening",
  /**
   * The Host artifact the probe loads (`host/dist-test` via `loadHostTestModule`) is missing or older than
   * its sources. Its OWN code, because folding it into `snapshotNotActionable` claims an observation that
   * never happened - measured 2026-11-05, the first real prelive run: `game-tools.ts` had been edited after
   * `dist-test` was built, and the ladder reported "the snapshot was not actionable".
   */
  harnessStale: "prelive_harness_stale",
  /** The pipe answered, but the session could not be established or observed at all: nothing was seen. */
  snapshotUnobservable: "prelive_snapshot_unobservable",
  /**
   * A REAL snapshot was observed and it was not actionable (held body, active execution). The only code
   * allowed to carry the location/can_move/fade/menu diagnosis, because it is the only one with a snapshot.
   */
  snapshotNotActionable: "prelive_snapshot_not_actionable",
  /** A fatal marker appeared in the Mod log after the deliberate disconnect. */
  dirtyTeardown: "prelive_dirty_teardown",
  /** The run never reached rung 1 (fixture prepare, locale guard, launch, ...). */
  launchFailed: "prelive_launch_failed",
});

const CONFIG_REJECTION = /GameBuddy rejected /u;
const SCENARIO_REJECTION = /GameBuddy native-local-player fixture rejected /u;
const SCENARIO_INITIALIZED = /GameBuddy native-local-player initialized .*before bridge attachment/u;
const ORDINARY_WORLD_ARMED = /GameBuddy native-local-player fixture armed for its explicit observed native save slot/u;
const READINESS = "[DEBUG-native-local-readiness]";
/**
 * The tolerance on the launch timestamp when attributing a log file to this run. The launcher records its
 * clock BEFORE spawning the process, so a file written by that process is never earlier - but file times and
 * the launcher's clock on Windows are both coarse enough that an exact comparison would be a coin flip.
 */
const LOG_ATTRIBUTION_SLACK_MS = 2_000;

/**
 * What a dirty teardown looks like in the Mod/SMAPI log.
 *
 * These are SMAPI's and .NET's own words for "something threw where nobody was listening", which is why they
 * are matched rather than a Mod-specific message: whatever throws during a disconnect is named by SMAPI, and
 * SMAPI's unhandled-exception banner uses the other two.
 */
const TEARDOWN_MARKERS = Object.freeze([
  Object.freeze({ name: "NullReferenceException", pattern: /NullReferenceException/u }),
  Object.freeze({ name: "Fatal error", pattern: /Fatal error/u }),
  Object.freeze({ name: "Unhandled exception", pattern: /Unhandled exception/u }),
  Object.freeze({ name: "crash", pattern: /\bcrash(?:ed|es|ing)?\b/iu }),
]);

const CONNECT_TIMEOUT_MS = 15_000;
const ACTIONABLE_TIMEOUT_MS = 30_000;
const CONFIG_POLL_MS = 250;

function rungRow(rungNumber) {
  const row = PRELIVE_RUNGS.find((candidate) => candidate.rung === rungNumber);
  if (row === undefined) throw new Error(`unknown_prelive_rung:${rungNumber}`);
  return row;
}

function pass(rungNumber, detail) {
  return { rung: rungNumber, passed: true, code: rungRow(rungNumber).passCode, detail };
}

function fail(rungNumber, code, detail) {
  return { rung: rungNumber, passed: false, code, detail };
}

function lastModLine(lines) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].includes("GameBuddy")) return lines[index].trim().slice(0, 400);
  }
  return "";
}

/** The `key=value;閳ヮ泦 pairs of one instrumented log line or evidence string. */
function parseFactPairs(text) {
  const facts = {};
  for (const part of String(text ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    facts[part.slice(0, separator).trim()] = part
      .slice(separator + 1)
      .trim()
      .replace(/\.$/u, "");
  }
  return facts;
}

/**
 * Rung 1: did the Mod accept the profile and arm the scenario this run asked for?
 *
 * A rejection is checked FIRST and reported with the offending line quoted, because a rejected profile is
 * exactly the failure that used to be indistinguishable from a slow boot.
 */
export function evaluatePreliveConfigRung({ logText, scenario }) {
  const lines = String(logText ?? "").split(/\r?\n/u);
  const rejection = lines.find((line) => CONFIG_REJECTION.test(line));
  if (rejection !== undefined) return fail(1, PRELIVE_FAILURE_CODES.configRejected, rejection.trim().slice(0, 400));
  const scenarioRejection = lines.find((line) => SCENARIO_REJECTION.test(line));
  if (scenarioRejection !== undefined)
    return fail(1, PRELIVE_FAILURE_CODES.scenarioRejected, scenarioRejection.trim().slice(0, 400));
  const armedScenario = typeof scenario === "string" ? scenario : "";
  const acceptance = lines.find((line) =>
    (armedScenario.length > 0 ? SCENARIO_INITIALIZED : ORDINARY_WORLD_ARMED).test(line),
  );
  if (acceptance !== undefined) return pass(1, acceptance.trim().slice(0, 400));
  return fail(
    1,
    PRELIVE_FAILURE_CODES.scenarioNotInitialized,
    `no ${armedScenario.length > 0 ? `initialized line for scenario ${armedScenario}` : "fixture arming line"} after launch; last_mod_line=${lastModLine(lines)}`,
  );
}

/** The freshest SMAPI log this launch is writing to, or null while it does not exist yet. */
export function resolvePreliveModLog({ errorLogsDir, launchedAtMs }) {
  if (typeof errorLogsDir !== "string" || errorLogsDir.length === 0) return null;
  if (!Number.isSafeInteger(launchedAtMs)) throw new Error("invalid_prelive_launch_clock");
  let names;
  try {
    names = readdirSync(errorLogsDir);
  } catch {
    return null;
  }
  let newest = null;
  for (const name of names) {
    if (!name.startsWith("SMAPI-latest") || !name.endsWith(".txt")) continue;
    const path = join(errorLogsDir, name);
    let metadata;
    try {
      metadata = statSync(path);
    } catch {
      continue;
    }
    if (metadata.mtimeMs < launchedAtMs - LOG_ATTRIBUTION_SLACK_MS) continue;
    if (newest === null || metadata.mtimeMs > newest.writtenAtMs)
      newest = { path, writtenAtMs: metadata.mtimeMs, length: metadata.size };
  }
  return newest === null ? null : Object.freeze({ path: newest.path, length: newest.length });
}

/** The log bytes from `offset` to the end. */
export function readPreliveLogTail({ path, offset = 0 }) {
  if (typeof path !== "string" || path.length === 0) throw new Error("invalid_prelive_log_path");
  const buffer = readFileSync(path);
  // A recorded offset larger than the file means the log was re-created or rotated between the capture and
  // the read (SMAPI re-creates it per launch); the WHOLE current file is then newer than the capture and
  // therefore entirely in scope, so reading from zero is the honest answer rather than a truncated tail.
  const from = Number.isSafeInteger(offset) && offset > 0 && offset <= buffer.length ? offset : 0;
  return buffer.subarray(from).toString("utf8");
}

/**
 * Rung 1, live: watch the Mod log until it accepts or rejects, inside the launcher's own pipe bound.
 *
 * The bound is `-TimeoutSeconds`, not a second budget: the acceptance line is written BEFORE the bridge
 * attaches, so a profile not accepted by the time the pipe bound expires has already failed the rung that
 * precedes it.
 */
export async function pollPreliveConfigRung({
  errorLogsDir,
  launchedAtMs,
  scenario,
  timeoutMs,
  pollMs = CONFIG_POLL_MS,
}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("invalid_prelive_config_timeout");
  const deadline = Date.now() + timeoutMs;
  let logPath = null;
  let lastResult = null;
  while (Date.now() < deadline) {
    const log = resolvePreliveModLog({ errorLogsDir, launchedAtMs });
    if (log !== null) {
      logPath = log.path;
      lastResult = evaluatePreliveConfigRung({ logText: readPreliveLogTail({ path: log.path }), scenario });
      // "Nothing yet" is the only answer worth polling past: an acceptance ends the rung green and a
      // rejection ends it red immediately, so a profile the Mod refuses is named in one poll rather than
      // after the whole bound.
      if (lastResult.code !== PRELIVE_FAILURE_CODES.scenarioNotInitialized)
        return Object.freeze({ ...lastResult, logPath });
    }
    await delay(pollMs);
  }
  return Object.freeze(
    lastResult ??
      fail(
        1,
        PRELIVE_FAILURE_CODES.scenarioNotInitialized,
        `no SMAPI log written by this launch appeared in ${errorLogsDir}`,
      ),
  );
}

/**
 * Rung 4: did the deliberate disconnect leave a fatal line behind?
 *
 * The caller hands this the log TAIL from the moment of disconnect, so a marker from an earlier phase of the
 * same run cannot be charged to the teardown.
 */
export function evaluatePreliveTeardownRung({ logText }) {
  const lines = String(logText ?? "").split(/\r?\n/u);
  for (const line of lines) {
    const marker = TEARDOWN_MARKERS.find((candidate) => candidate.pattern.test(line));
    if (marker !== undefined)
      return fail(4, PRELIVE_FAILURE_CODES.dirtyTeardown, `${marker.name}: ${line.trim().slice(0, 400)}`);
  }
  return pass(4, `after_disconnect_lines=${lines.filter((line) => line.trim().length > 0).length}`);
}

/**
 * The Mod's own body-hold observation, projected to the four facts a blocked rung 3 needs to say WHY.
 *
 * `LogNativeLocalPlayerReadinessIfBlocked` writes exactly this line while the actor is held, and its field
 * names already ARE `location`/`can_move`/`fade`/`menu` - so this reads them rather than inventing a second
 * vocabulary. The line is Trace level (the default SMAPI verbosity drops it), so absence stays `absent` and
 * is never filled in with a guess.
 */
export function readPreliveReadinessFacts(logText) {
  const lines = String(logText ?? "").split(/\r?\n/u);
  const line = [...lines].reverse().find((row) => row.includes(READINESS));
  if (line === undefined) return null;
  const facts = parseFactPairs(line.slice(line.indexOf(READINESS) + READINESS.length));
  return Object.freeze({
    state: facts.state ?? "absent",
    location: facts.location ?? "absent",
    can_move: facts.can_move ?? "absent",
    fade: facts.fade ?? "absent",
    menu: facts.menu ?? "absent",
  });
}

/**
 * Why a first snapshot was not actionable, in the four facts a reader needs.
 *
 * Two authorities, each used for what it actually knows: the snapshot's own disposition detail says which
 * modal holds the actor and whether it can move (`modal_type=閳?can_move=閳ヮ泦, written by the World Model),
 * while the engine fade alpha exists only in the Mod's readiness line. A fact neither source observed stays
 * `unknown`.
 */
export function describePreliveSnapshotBlock({ snapshot, logText }) {
  const disposition = parseFactPairs(snapshot?.actorDispositionDetail ?? "");
  const readiness = readPreliveReadinessFacts(logText);
  return Object.freeze({
    location: snapshot?.location ?? readiness?.location ?? "unknown",
    can_move: disposition.can_move ?? readiness?.can_move ?? "unknown",
    fade: readiness?.fade ?? "unknown",
    menu: disposition.modal_type ?? readiness?.menu ?? "unknown",
  });
}

/**
 * Rung 3's PRECONDITION: the Host artifact the probe executes must be current.
 *
 * The probe loads `host/dist-test` through `loadHostTestModule`, which refuses an artifact older than its
 * sources (or missing) - and that refusal is correct, but it is NOT an observation: nothing was connected,
 * nothing was seen. Asked only at observe time it surfaced as `prelive_snapshot_not_actionable`, a code
 * naming a cause that was not the cause (measured 2026-11-05, the first real prelive run: `game-tools.ts` was
 * edited after `dist-test` was built). So the same authority is asked here, before rung 3 touches the bridge,
 * and the verdict keeps its own identity.
 */
export async function readPreliveHarnessStaleness({ repositoryRoot = PRELIVE_REPOSITORY_ROOT } = {}) {
  return await assessLiveRunArtifactFreshness({ repositoryRoot });
}

/** Rung 3's verdict on that precondition, naming the newest input, the artifact and the rebuild command. */
export function evaluatePreliveHarnessRung(staleness, { repositoryRoot = PRELIVE_REPOSITORY_ROOT } = {}) {
  const artifact = staleness?.outputs?.path ?? join(repositoryRoot, "host", "dist-test");
  const newestInput = staleness?.inputs?.path ?? "(no compiled input found)";
  // The freshness verdict states its own comparison, because which RULE answered (content hashes or modification
  // times) changes what the reader has to do; restating it here from mtimes would tell a content mismatch to
  // touch the artifact.
  const stated = typeof staleness?.detail === "string" ? staleness.detail : undefined;
  if (staleness?.stale !== true)
    return {
      rung: 3,
      passed: true,
      code: null,
      detail:
        stated ??
        `host artifact is current: newest input ${newestInput} is not newer than the newest emitted module ${staleness?.outputs?.path ?? "unknown"}`,
    };
  const reason = staleness.reason ?? "stale_artifact";
  // A missing artifact has no modification time to compare, so it is reported as a fact rather than as a
  // comparison against an invented timestamp.
  const comparison =
    stated ??
    (staleness.outputs?.path === undefined
      ? `artifact ${artifact} does not exist`
      : `newest input ${newestInput} @${new Date(staleness.inputs?.mtimeMs ?? 0).toISOString()} vs artifact ${artifact} @${new Date(staleness.outputs.mtimeMs).toISOString()}`);
  return {
    rung: 3,
    passed: false,
    code: PRELIVE_FAILURE_CODES.harnessStale,
    detail: `${reason}: ${comparison}; rebuild with: ${REBUILD_COMMAND}`,
  };
}

/**
 * Why rung 3 did not produce an actionable snapshot, in the code that names the ACTUAL cause.
 *
 * One function, three outcomes, and no borrowing: a stale artifact never reads as a blocker (`harnessStale`),
 * a session that never produced a snapshot never reads as one either (`snapshotUnobservable`), and only a REAL
 * observed snapshot that is not actionable carries `snapshotNotActionable` together with its
 * location/can_move/fade/menu diagnosis.
 */
export function describePreliveProbeFailure({ error, snapshot = null, logText = "", staleness = null }) {
  const message = String(error instanceof Error ? error.message : error).slice(0, 240);
  if (staleness?.stale === true) {
    const harness = evaluatePreliveHarnessRung(staleness);
    return { code: harness.code, detail: `${harness.detail};probe=${message}`, snapshot: null };
  }
  if (snapshot === null || snapshot === undefined)
    return { code: PRELIVE_FAILURE_CODES.snapshotUnobservable, detail: message, snapshot: null };
  const block = describePreliveSnapshotBlock({ snapshot, logText });
  return {
    code: PRELIVE_FAILURE_CODES.snapshotNotActionable,
    detail:
      `${message};location=${block.location};can_move=${block.can_move};fade=${block.fade};menu=${block.menu}` +
      `;actionable=${snapshot.actionable ?? "unknown"};disposition=${snapshot.actorDispositionKind ?? "none"}`,
    snapshot: { ...summarizeSnapshot(snapshot), ...block },
  };
}

/**
 * Rung 3, live: connect the way a smoke runner does, and require an actionable snapshot.
 *
 * The connection is retried on ENOENT because the game creates its pipe asynchronously after launch (the same
 * bounded retry every runner uses), and the client is always closed - deliberately, before the result is
 * printed - because that close IS the disconnect rung 4 examines.
 */
export async function runPreliveSnapshotProbe(
  config,
  { connectTimeoutMs = CONNECT_TIMEOUT_MS, actionableTimeoutMs = ACTIONABLE_TIMEOUT_MS, modLogPath } = {},
) {
  const startedAt = Date.now();
  let session = null;
  let result;
  try {
    session = await connectWithRetry(config, connectTimeoutMs);
    const seed = session.client.state?.snapshot ?? (await session.client.observe());
    const actionable = await waitForActionable(session.client, seed, actionableTimeoutMs);
    result = {
      state: "passed",
      passed: true,
      rung: 3,
      code: rungRow(3).passCode,
      detail: `revision=${actionable.revision};location=${actionable.location}`,
      snapshot: summarizeSnapshot(actionable),
      timings: { snapshotMs: Date.now() - startedAt },
    };
  } catch (error) {
    // The loader refuses a stale artifact BEFORE anything is observed, so that refusal is asked of the same
    // authority here: the code must name the artifact, not a blocker nobody saw.
    const failure = describePreliveProbeFailure({
      error,
      snapshot: session?.client?.state?.snapshot ?? null,
      logText: safeLogText(modLogPath),
      staleness: await safeStaleness(),
    });
    result = {
      state: "failed",
      passed: false,
      rung: 3,
      code: failure.code,
      detail: failure.detail,
      snapshot: failure.snapshot,
      timings: { snapshotMs: Date.now() - startedAt },
    };
  }
  if (session !== null) await session.close();
  return Object.freeze(result);
}

/** Staleness for a failure already in flight. A walk that cannot run must not replace the failure it explains. */
async function safeStaleness() {
  try {
    return await readPreliveHarnessStaleness();
  } catch {
    return null;
  }
}

function safeLogText(path) {
  if (typeof path !== "string" || path.length === 0) return "";
  try {
    return readPreliveLogTail({ path });
  } catch {
    return "";
  }
}

// The game process creates its named pipe asynchronously after launch, so the connect is retried on ENOENT
// within a bounded window - the same shape (and the same test-module loader) every smoke runner uses.
async function connectWithRetry(config, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
    } catch (error) {
      lastError = error;
      if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
      await delay(250);
    }
  }
  throw lastError ?? new Error("native_local_bridge_connect_timeout");
}

function argumentValue(name, argv) {
  const index = argv.indexOf(name);
  return index < 0 || index + 1 >= argv.length ? undefined : argv[index + 1];
}

function numberArgument(name, argv, fallback) {
  const raw = argumentValue(name, argv);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`invalid_prelive_argument:${name.slice(2)}`);
  return value;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const mode = argumentValue("--mode", argv);
  const logPath = argumentValue("--log", argv);
  const offset = numberArgument("--offset", argv, 0);
  const errorLogsDir = argumentValue("--error-logs", argv);
  const launchedAtMs = numberArgument("--since-ms", argv, Number.NaN);
  let payload;
  const usage = (message) => {
    process.stderr.write(
      `${message}\nusage: --mode ladder|log|harness|config|teardown|snapshot [--log <path>] [--offset <bytes>] [--error-logs <dir>] [--since-ms <ms>] [--scenario <name>] [--timeout-seconds <n>] [--client-config <path>] [--repository-root <dir>]\n`,
    );
    process.exitCode = 2;
  };
  if (mode === "ladder") {
    payload = { rungs: PRELIVE_RUNGS, failureCodes: PRELIVE_FAILURE_CODES };
  } else if (mode === "log") {
    payload = resolvePreliveModLog({ errorLogsDir, launchedAtMs }) ?? { path: null, length: 0 };
  } else if (mode === "harness") {
    // Always exit 0: the verdict IS the payload, so a stale artifact is read as `prelive_harness_stale` by a
    // caller that reads the JSON, and never mistaken for "the checker itself failed".
    const repositoryRoot = argumentValue("--repository-root", argv);
    const rootOptions = repositoryRoot === undefined ? undefined : { repositoryRoot: resolve(repositoryRoot) };
    payload = evaluatePreliveHarnessRung(await readPreliveHarnessStaleness(rootOptions), rootOptions);
  } else if (mode === "config") {
    const timeoutSeconds = numberArgument("--timeout-seconds", argv, Number.NaN);
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) usage("config mode requires --timeout-seconds");
    else if (!Number.isSafeInteger(launchedAtMs)) usage("config mode requires --since-ms");
    else
      payload = await pollPreliveConfigRung({
        errorLogsDir,
        launchedAtMs,
        scenario: argumentValue("--scenario", argv) ?? "",
        timeoutMs: timeoutSeconds * 1000,
      });
  } else if (mode === "teardown") {
    payload = evaluatePreliveTeardownRung({ logText: readPreliveLogTail({ path: logPath, offset }) });
  } else if (mode === "snapshot") {
    payload = await runPreliveSnapshotProbe(await readNativeClientConfig(argv), { modLogPath: logPath });
    if (payload.state !== "passed") process.exitCode = 2;
  } else {
    usage(`unknown prelive mode '${String(mode)}'`);
  }
  if (payload !== undefined) process.stdout.write(JSON.stringify(payload));
}
