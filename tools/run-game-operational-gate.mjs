#!/usr/bin/env node
/**
 * Production-wrapper IPC orchestrator for the Game Operational Gate.
 *
 * The runner owns only the launch nonce and the external harness timeout. The
 * Game/Host child owns Pi and Game session identity and publishes one
 * source-owned terminal aggregate over the private Node IPC channel. No marker
 * file, stdout line, or fixture projection can satisfy this gate.
 */
import { randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateGameOperationalGatePreflight } from "./lib/game-operational-gate-preflight.mjs";

const PROJECT_ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));
const HOST_ROOT = join(PROJECT_ROOT, "host");
const RELEASE_EVIDENCE_ROOT = join(PROJECT_ROOT, "artifacts", "game-operational-gate");
// Every live attempt must cross the reviewed immutable-artifact launcher.
const PRODUCTION_LAUNCHER = join(HOST_ROOT, "scripts", "start-production-artifact.mjs");
const RUNNER_SCHEMA = "gamebuddy-game-operational-gate/v1";
const TASK_FIXTURE_SCHEMA = "gamebuddy-stardew-game-operational-task/v1";
const TASK_INGRESS_SCHEMA = "gamebuddy-production-game-task-ingress/v1";
const TERMINAL_EVIDENCE_SCHEMA = "gamebuddy-game-operational-gate-evidence/v2";
const RUNNER_ID = "game-operational-gate";
const SHA256 = /^[a-f0-9]{64}$/;
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/;
const PROFILE = /^[A-Za-z0-9._-]{1,128}$/;
const PATH_LIMIT = 4096;
// This is an external harness bound, not a product gameplay budget. The task
// itself remains entirely natural language and may choose its own real actions.
export const OPERATIONAL_GATE_TIMEOUT_MS = 60_000;
const TEARDOWN_TIMEOUT_MS = 5_000;
const CONFIG_KEYS = Object.freeze([
  "runtimeRoot",
  "sharedIdentity",
  "foreignIdentity",
  "surfaceSessions",
  "gameOperatorConfigPath",
  "taskFixturePath",
]);
const FIXTURE_KEYS = Object.freeze(["schema", "task", "targetVersion", "profile", "environment"]);
const FORBIDDEN_FIXTURE_FIELD = /^(?:actions?|routes?|tools?|capability(?:Subset|Set|Allowlist)?|(?:turn|tool|action|wallClock|model|runtime|execution|gameplay)?Budget|quotas?|limits?)$/i;

export function parseArguments(argv) {
  if (
    argv.length !== 2 ||
    argv[0] !== "--config" ||
    typeof argv[1] !== "string" ||
    argv[1].length === 0 ||
    argv[1].includes("\0")
  )
    throw new Error("usage: node tools/run-game-operational-gate.mjs --config <path>");
  return Object.freeze({ configPath: resolve(argv[1]) });
}

function blocked(reasonCode) {
  return Object.freeze({ state: "BLOCKED", reasonCode });
}

function gateFailed(reasonCode) {
  return Object.freeze({ state: "GATE_FAILED", reasonCode });
}

/**
 * Runs the exact child-side ingress/evidence protocol against a transport. The
 * transport seam is private to the production wrapper; exporting this small
 * state machine keeps negative cases deterministic without a fake Game bridge.
 */
export async function runOperationalGateIpc({
  transport,
  task,
  nonceSha256,
  timeoutMs = OPERATIONAL_GATE_TIMEOUT_MS,
  teardownTimeoutMs = TEARDOWN_TIMEOUT_MS,
}) {
  if (!transport || typeof transport !== "object") return blocked("operational_gate_transport_unavailable");
  if (!SHA256.test(nonceSha256) || !canonicalTask(task)) return blocked("operational_gate_input_invalid");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) return blocked("operational_gate_timeout_invalid");
  if (!Number.isSafeInteger(teardownTimeoutMs) || teardownTimeoutMs < 1)
    return blocked("operational_gate_teardown_timeout_invalid");

  let phase = "awaiting_ready";
  let ready;
  let outcome;
  let dispatchCount = 0;
  let terminalCount = 0;
  let childExited = false;
  let childExitCode;
  let childExitSignal;
  let terminationStarted = false;
  let settled = false;
  let timeoutHandle;
  let teardownHandle;
  let resolveResult;
  const removers = [];
  const resultPromise = new Promise((resolveResultValue) => {
    resolveResult = resolveResultValue;
  });

  const removeListeners = () => {
    let cleanupFailed = false;
    while (removers.length > 0) {
      const remove = removers.pop();
      try {
        remove?.();
      } catch {
        cleanupFailed = true;
      }
    }
    return cleanupFailed;
  };

  const finish = (result) => {
    if (settled) return;
    const cleanupFailed = removeListeners();
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    if (teardownHandle !== undefined) clearTimeout(teardownHandle);
    settled = true;
    phase = "finished";
    resolveResult(cleanupFailed ? blocked("teardown_failure") : result);
  };

  const terminate = () => {
    if (terminationStarted || settled) return;
    terminationStarted = true;
    phase = "tearing_down";
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    if (childExited) {
      if (outcome?.state === "PASSED" && (childExitCode !== 0 || childExitSignal !== null))
        outcome = blocked("teardown_failure");
      finish(outcome ?? blocked("teardown_failure"));
      return;
    }
    let termination;
    try {
      termination = transport.terminate();
    } catch {
      finish(blocked("teardown_failure"));
      return;
    }
    teardownHandle = setTimeout(() => finish(blocked("teardown_failure")), teardownTimeoutMs);
    teardownHandle.unref?.();
    void Promise.resolve(termination).then(
      (terminated) => {
        if (terminated !== true) finish(blocked("teardown_failure"));
      },
      () => finish(blocked("teardown_failure")),
    );
  };

  const fail = (reasonCode) => {
    if (settled) return;
    if (phase === "tearing_down") {
      // A second terminal message or any post-terminal protocol event revokes
      // an otherwise successful result, but does not issue a second kill.
      if (outcome?.state === "PASSED") outcome = blocked(reasonCode);
      return;
    }
    outcome = blocked(reasonCode);
    terminate();
  };

  const onMessage = (message) => {
    if (settled) return;
    if (phase === "awaiting_ready") {
      const candidate = parseTaskReady(message);
      if (candidate === null) {
        fail("game_task_ready_invalid");
        return;
      }
      if (candidate.nonceSha256 !== nonceSha256) {
        fail("game_task_ready_correlation_mismatch");
        return;
      }
      ready = candidate;
      phase = "dispatching";
      dispatchCount += 1;
      if (dispatchCount !== 1) {
        fail("game_task_dispatch_duplicate");
        return;
      }
      const dispatch = Object.freeze({
        schema: TASK_INGRESS_SCHEMA,
        kind: "dispatch_task",
        surface: "game",
        nonceSha256,
        gameSessionId: candidate.gameSessionId,
        piSessionId: candidate.piSessionId,
        task,
      });
      let callbackSettled = false;
      try {
        const sent = transport.send(dispatch, (error) => {
          if (callbackSettled) {
            fail("game_task_dispatch_callback_duplicate");
            return;
          }
          callbackSettled = true;
          if (error !== null && error !== undefined) {
            fail("game_task_dispatch_delivery_failed");
            return;
          }
          if (phase === "dispatching") phase = "awaiting_terminal";
        });
        if (sent !== true) fail("game_task_dispatch_delivery_unavailable");
      } catch {
        fail("game_task_dispatch_delivery_failed");
      }
      return;
    }

    if (phase === "tearing_down") {
      const duplicate = parseTerminalEvidence(message);
      fail(duplicate === null ? "game_task_protocol_after_terminal" : "game_task_terminal_evidence_duplicate");
      return;
    }

    const duplicateReady = parseTaskReady(message);
    if (duplicateReady !== null) {
      fail(duplicateReady.nonceSha256 === nonceSha256 ? "game_task_ready_duplicate" : "game_task_ready_correlation_mismatch");
      return;
    }
    const evidence = parseTerminalEvidence(message);
    if (evidence === null) {
      fail("game_task_terminal_evidence_invalid");
      return;
    }
    if (evidence.nonceSha256 !== nonceSha256 || ready === undefined || evidence.piSessionId !== ready.piSessionId) {
      fail("game_task_terminal_evidence_correlation_mismatch");
      return;
    }
    terminalCount += 1;
    if (terminalCount !== 1) {
      fail("game_task_terminal_evidence_duplicate");
      return;
    }
    outcome = Object.freeze({
      state: "PASSED",
      ready,
      terminalEvidence: evidence,
      dispatchCount,
      terminalCount,
    });
    terminate();
  };

  const onDisconnect = () => {
    fail(phase === "tearing_down" ? "teardown_failure" : "game_task_disconnect");
  };

  const onError = () => {
    fail(phase === "tearing_down" ? "teardown_failure" : "production_wrapper_process_error");
  };

  const onExit = (code, signal) => {
    if (settled) return;
    childExited = true;
    childExitCode = code;
    childExitSignal = signal;
    if (!terminationStarted) {
      finish(blocked(phase === "awaiting_ready" ? "game_task_ready_unavailable" : "production_wrapper_exited_before_terminal"));
      return;
    }
    if (outcome?.state === "PASSED" && (code !== 0 || signal !== null)) outcome = blocked("teardown_failure");
    finish(outcome ?? blocked("teardown_failure"));
  };

  try {
    if (typeof transport.onMessage !== "function" || typeof transport.onDisconnect !== "function" || typeof transport.onError !== "function" || typeof transport.onExit !== "function" || typeof transport.send !== "function" || typeof transport.terminate !== "function")
      return blocked("operational_gate_transport_unavailable");
    removers.push(transport.onMessage(onMessage));
    removers.push(transport.onDisconnect(onDisconnect));
    removers.push(transport.onError(onError));
    removers.push(transport.onExit(onExit));
  } catch {
    return blocked("operational_gate_transport_unavailable");
  }

  timeoutHandle = setTimeout(() => {
    if (phase === "tearing_down") finish(blocked("teardown_failure"));
    else {
      outcome = gateFailed("harness_timeout");
      terminate();
    }
  }, timeoutMs);
  timeoutHandle.unref?.();
  return resultPromise;
}

export async function terminateOwnedProcessTree(
  child,
  { platform = process.platform, spawnProcess = spawn, killProcess = process.kill } = {},
) {
  if (!Number.isSafeInteger(child?.pid) || child.pid <= 0) return false;
  if (platform === "win32") {
    let reaper;
    try {
      reaper = spawnProcess("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      });
    } catch {
      return false;
    }
    return await new Promise((resolveTermination) => {
      let settled = false;
      const settle = (result) => {
        if (settled) return;
        settled = true;
        resolveTermination(result);
      };
      reaper.once("error", () => settle(false));
      reaper.once("close", (code, signal) => settle(code === 0 && signal === null));
    });
  }
  try {
    killProcess(-child.pid, "SIGTERM");
    return true;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

/** Starts exactly the reviewed production launcher and binds its IPC stream. */
export async function runProductionOperationalGate({ config, task, nonceSha256, timeoutMs = OPERATIONAL_GATE_TIMEOUT_MS, spawnProcess = spawn }) {
  if (!config || typeof config !== "object" || !isAbsolute(config.gameOperatorConfigPath))
    return blocked("game_operator_config_invalid");
  let child;
  try {
    child = spawnProcess(process.execPath, [PRODUCTION_LAUNCHER, "main.js", config.gameOperatorConfigPath], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
      detached: process.platform !== "win32",
      env: Object.freeze({
        ...process.env,
        GAMEBUDDY_GAME_OPERATIONAL_GATE_NONCE_SHA256: nonceSha256,
      }),
    });
  } catch {
    return blocked("production_wrapper_spawn_failed");
  }

  // Child stdout is intentionally drained and never parsed. In particular, a
  // line that resembles terminal evidence cannot satisfy this IPC-only gate.
  child.stdout?.resume?.();
  child.stderr?.pipe?.(process.stderr);
  const transport = Object.freeze({
    send: (message, callback) => child.send(message, undefined, undefined, callback),
    onMessage: (listener) => {
      child.on("message", listener);
      return () => child.off("message", listener);
    },
    onDisconnect: (listener) => {
      child.on("disconnect", listener);
      return () => child.off("disconnect", listener);
    },
    onError: (listener) => {
      child.on("error", listener);
      return () => child.off("error", listener);
    },
    onExit: (listener) => {
      child.on("exit", listener);
      return () => child.off("exit", listener);
    },
    terminate: () => terminateOwnedProcessTree(child, { spawnProcess }),
  });
  return runOperationalGateIpc({ transport, task, nonceSha256, timeoutMs });
}

function parseTaskReady(value) {
  if (
    !exactRecord(value, ["gameSessionId", "kind", "nonceSha256", "piSessionId", "schema", "surface"]) ||
    value.schema !== TASK_INGRESS_SCHEMA ||
    value.kind !== "ready" ||
    value.surface !== "game" ||
    !SHA256.test(value.nonceSha256) ||
    !OPAQUE_ID.test(value.gameSessionId) ||
    !OPAQUE_ID.test(value.piSessionId)
  )
    return null;
  return Object.freeze({
    schema: TASK_INGRESS_SCHEMA,
    kind: "ready",
    surface: "game",
    nonceSha256: value.nonceSha256,
    gameSessionId: value.gameSessionId,
    piSessionId: value.piSessionId,
  });
}

function parseTerminalEvidence(value) {
  if (
    !exactRecord(value, ["capabilityCount", "capabilityRevision", "nonceSha256", "piSessionId", "schema", "stopSettled", "surface", "terminalState", "transitions"]) ||
    value.schema !== TERMINAL_EVIDENCE_SCHEMA ||
    !SHA256.test(value.nonceSha256) ||
    !OPAQUE_ID.test(value.piSessionId) ||
    value.surface !== "game" ||
    !safeRevision(value.capabilityRevision) ||
    !safeCount(value.capabilityCount) ||
    value.terminalState !== "completed" ||
    value.stopSettled !== true ||
    !exactRecord(value.transitions, ["allPostconditionsObserved", "count", "distinctActionCount", "freshObservationCount"]) ||
    value.transitions.count !== 2 ||
    value.transitions.distinctActionCount !== 2 ||
    value.transitions.freshObservationCount !== 2 ||
    value.transitions.allPostconditionsObserved !== true
  )
    return null;
  return Object.freeze({
    schema: TERMINAL_EVIDENCE_SCHEMA,
    nonceSha256: value.nonceSha256,
    piSessionId: value.piSessionId,
    surface: "game",
    capabilityRevision: value.capabilityRevision,
    capabilityCount: value.capabilityCount,
    transitions: Object.freeze({
      count: 2,
      distinctActionCount: 2,
      freshObservationCount: 2,
      allPostconditionsObserved: true,
    }),
    terminalState: "completed",
    stopSettled: true,
  });
}

function safeRevision(value) {
  return Number.isSafeInteger(value) && value >= 0;
}
function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 512;
}

function exactRecord(value, keys) {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return false;
    const names = Object.getOwnPropertyNames(value).sort();
    const expected = [...keys].sort();
    if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) return false;
    return keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor !== undefined && Object.hasOwn(descriptor, "value");
    });
  } catch {
    return false;
  }
}

function canonicalTask(value) {
  if (typeof value !== "string") return false;
  let scalarValues = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0) return false;
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return false;
    scalarValues += 1;
    if (scalarValues > 2_000) return false;
  }
  return scalarValues >= 1;
}

async function loadConfig(path, nonceSha256) {
  if (!isAbsolute(path) || path.length > PATH_LIMIT) throw new Error("config_path_invalid");
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("operational_gate_config_unreadable");
  }
  if (!exactRecord(parsed, CONFIG_KEYS)) throw new Error("operational_gate_config_shape_invalid");
  if (!isAbsoluteString(parsed.gameOperatorConfigPath) || !isAbsoluteString(parsed.taskFixturePath))
    throw new Error("game_operator_or_fixture_path_invalid");
  // The preflight module remains pure. Its nonce field is supplied by this
  // attempt, never accepted from configuration, so every launch is unique.
  const preflight = validateGameOperationalGatePreflight({
    runtimeRoot: parsed.runtimeRoot,
    sharedIdentity: parsed.sharedIdentity,
    foreignIdentity: parsed.foreignIdentity,
    surfaceSessions: parsed.surfaceSessions,
    markerNonceSha256: nonceSha256,
  });
  if (preflight.state !== "READY") throw new Error(preflight.reasonCode);
  return Object.freeze({
    ...preflight,
    nonceSha256,
    gameOperatorConfigPath: parsed.gameOperatorConfigPath,
    taskFixturePath: parsed.taskFixturePath,
  });
}

async function loadTaskFixture(path) {
  if (!isAbsoluteString(path)) throw new Error("task_fixture_path_invalid");
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("task_fixture_unreadable");
  }
  if (
    !exactRecord(parsed, FIXTURE_KEYS) ||
    parsed.schema !== TASK_FIXTURE_SCHEMA ||
    !canonicalTask(parsed.task) ||
    typeof parsed.targetVersion !== "string" ||
    !VERSION.test(parsed.targetVersion) ||
    typeof parsed.profile !== "string" ||
    !PROFILE.test(parsed.profile) ||
    !environmentFacts(parsed.environment)
  )
    throw new Error("task_fixture_shape_invalid");
  return Object.freeze({
    task: parsed.task,
    targetVersion: parsed.targetVersion,
    profile: parsed.profile,
    environment: Object.freeze({ ...parsed.environment }),
  });
}

function environmentFacts(value) {
  if (!exactRecordAtLeastOne(value)) return false;
  for (const [key, fact] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key) || FORBIDDEN_FIXTURE_FIELD.test(key)) return false;
    if (
      fact !== null &&
      typeof fact !== "string" &&
      typeof fact !== "boolean" &&
      !(typeof fact === "number" && Number.isSafeInteger(fact))
    )
      return false;
    if (typeof fact === "string" && (fact.length === 0 || fact.length > 256 || /[\0\r\n]/.test(fact))) return false;
  }
  return true;
}

function exactRecordAtLeastOne(value) {
  try {
    return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && Object.getOwnPropertySymbols(value).length === 0 && Object.keys(value).length >= 1 && Object.keys(value).length <= 16;
  } catch {
    return false;
  }
}

function isAbsoluteString(value) {
  return typeof value === "string" && value.length > 0 && value.length <= PATH_LIMIT && !value.includes("\0") && isAbsolute(value);
}

export async function prepareReleaseReportTarget(runId) {
  if (!OPAQUE_ID.test(runId)) throw new Error("invalid_report_run_id");
  await mkdir(RELEASE_EVIDENCE_ROOT, { recursive: true });
  const root = await realpath(RELEASE_EVIDENCE_ROOT);
  if (root !== RELEASE_EVIDENCE_ROOT) throw new Error("release_evidence_root_identity_mismatch");
  const rootState = await lstat(root);
  if (!rootState.isDirectory() || rootState.isSymbolicLink()) throw new Error("release_evidence_root_not_real_directory");
  return prepareReportTarget(join(root, `${runId}.json`));
}

export async function prepareReportTarget(path) {
  if (!isAbsolute(path) || relative(path, dirname(path)) === "") throw new Error("invalid_report_path");
  try {
    await lstat(path);
    throw new Error("report_target_already_exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  let parent;
  try {
    parent = await realpath(dirname(path));
  } catch {
    throw new Error("report_parent_missing_or_unresolvable");
  }
  const state = await lstat(parent);
  if (!state.isDirectory() || state.isSymbolicLink()) throw new Error("report_parent_not_real_directory");
  return join(parent, basename(path));
}

export async function writeOperationalGateReport(path, report) {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (/(?:content|prompt|provider|cookie|csrf|token|jsonl|sqlite|route|tool|budget)/i.test(serialized))
    throw new Error("evidence_report_content_guard_rejected");
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(serialized, "utf8");
  } finally {
    await handle.close();
  }
}

async function productionArtifactIdentity() {
  try {
    const pointer = JSON.parse(await readFile(join(HOST_ROOT, "dist", "current.json"), "utf8"));
    if (!exactRecord(pointer, ["generation", "inventoryDigest"]) || !OPAQUE_ID.test(pointer.generation) || !SHA256.test(pointer.inventoryDigest)) throw new Error("invalid");
    return Object.freeze({ generation: pointer.generation, inventoryDigest: pointer.inventoryDigest });
  } catch {
    throw new Error("production_artifact_identity_unavailable");
  }
}

function safeReasonCode(error) {
  const value = error instanceof Error ? error.message : String(error);
  return /^[a-z0-9_:.-]{1,160}$/i.test(value) ? value : "live_runner_internal_error";
}

function reportBase(runId, nonceSha256, artifact) {
  return {
    schema: RUNNER_SCHEMA,
    runner: { id: RUNNER_ID, version: 2 },
    runId,
    nonceSha256,
    artifact,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  const runId = randomBytes(12).toString("hex");
  const reportPath = await prepareReleaseReportTarget(runId);
  const nonceSha256 = randomBytes(32).toString("hex");
  let report;
  try {
    const config = await loadConfig(args.configPath, nonceSha256);
    const fixture = await loadTaskFixture(config.taskFixturePath);
    const artifact = await productionArtifactIdentity();
    const result = await runProductionOperationalGate({
      config,
      task: fixture.task,
      nonceSha256,
    });
    report = {
      ...reportBase(runId, nonceSha256, artifact),
      target: Object.freeze({ version: fixture.targetVersion, profile: fixture.profile }),
      ...(result.state === "PASSED"
        ? {
            state: "PASSED",
            ready: result.ready,
            terminalEvidence: result.terminalEvidence,
            assertions: {
              readyObserved: true,
              dispatchCount: result.dispatchCount,
              terminalAggregateCount: result.terminalCount,
              stdoutEvidenceAccepted: false,
              teardown: "clean",
            },
            scope: "production_wrapper_ipc",
          }
        : result.state === "GATE_FAILED"
          ? {
              state: "GATE_FAILED",
              reasonCode: result.reasonCode,
              scope: "external_harness",
            }
          : {
              state: "BLOCKED",
              reasonCode: result.reasonCode,
              scope: "no_game_result_fabricated",
            }),
    };
  } catch (error) {
    report = {
      ...reportBase(runId, nonceSha256, null),
      state: "BLOCKED",
      reasonCode: safeReasonCode(error),
      scope: "no_game_result_fabricated",
    };
  }
  await writeOperationalGateReport(reportPath, report);
  console.log(JSON.stringify(report));
  return report.state === "PASSED" ? 0 : 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(JSON.stringify({ schema: RUNNER_SCHEMA, state: "BLOCKED", reasonCode: safeReasonCode(error) }));
      process.exitCode = 2;
    });
