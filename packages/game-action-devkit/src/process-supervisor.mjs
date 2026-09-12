import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export const DEFAULT_SUITE_TIMEOUT_MS = 15 * 60_000;
export const CLEANUP_TIMEOUT_MS = 5_000;
const MAX_CAPTURE_BYTES = 64 * 1024;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const VALID_TERMINATION_POLICIES = new Set(["immediate", "term-then-kill"]);
const WINDOWS_TASKKILL_COMMAND = "taskkill.exe";
const WINDOWS_TASKKILL_OPTIONS = Object.freeze({ windowsHide: true, stdio: "ignore" });

function validationError(code) {
  return new Error(code);
}

function appendUtf8Bounded(current, incoming, maxBytes = MAX_CAPTURE_BYTES) {
  if (!incoming) return current;
  const bytes = Buffer.concat([Buffer.from(current, "utf8"), Buffer.from(incoming, "utf8")]);
  if (bytes.byteLength <= maxBytes) return bytes.toString("utf8");
  let end = maxBytes;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (end > 0) {
    try {
      return decoder.decode(bytes.subarray(0, end));
    } catch {
      end -= 1;
    }
  }
  return "";
}

function boundedOutput({ stdout, stderr }) {
  return appendUtf8Bounded(appendUtf8Bounded("", stdout), stderr);
}

function remainingBefore(deadline) {
  return Math.max(0, deadline - Date.now());
}

function boundedWait(promise, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
    Promise.resolve(promise).then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

function validateOptions({ timeoutMs, cleanupTimeoutMs, heartbeatIntervalMs, terminationPolicy, graceMs }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100) {
    throw validationError("invalid_test_supervisor_timeout");
  }
  if (!Number.isSafeInteger(cleanupTimeoutMs) || cleanupTimeoutMs < 1) {
    throw validationError("invalid_test_supervisor_cleanup_timeout");
  }
  if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 100) {
    throw validationError("invalid_test_supervisor_heartbeat_interval");
  }
  if (!VALID_TERMINATION_POLICIES.has(terminationPolicy)) {
    throw validationError("invalid_test_supervisor_termination_policy");
  }
  if (!Number.isSafeInteger(graceMs) || graceMs < 0) {
    throw validationError("invalid_test_supervisor_grace_ms");
  }
}

function validatePid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw validationError("test_supervisor_process_id_invalid");
  }
}

function killWindowsProcessTree(pid, { signal }, spawnProcess = spawn) {
  validatePid(pid);
  if (typeof spawnProcess !== "function") throw validationError("invalid_test_supervisor_kill_tree_factory");
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return resolve();
    const killer = spawnProcess(WINDOWS_TASKKILL_COMMAND, ["/PID", String(pid), "/T", "/F"], WINDOWS_TASKKILL_OPTIONS);
    killer.once("error", reject);
    killer.once("close", (code) => {
      if (code === 0 || code === 128) resolve();
      else reject(new Error(`test_supervisor_taskkill_failed:${code ?? "signal"}`));
    });
  });
}

export function createWindowsProcessTreeKillerForTest(spawnProcess) {
  return (pid, options) => killWindowsProcessTree(pid, options, spawnProcess);
}

function defaultKillTree(pid, { terminationPolicy, graceMs, signal }) {
  validatePid(pid);
  if (process.platform === "win32") {
    return killWindowsProcessTree(pid, { signal });
  }

  const group = -pid;
  if (terminationPolicy === "term-then-kill") {
    try {
      process.kill(group, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return resolve();
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", cancel);
        resolve();
      };
      const cancel = () => {
        clearTimeout(timer);
        settle();
      };
      const timer = setTimeout(() => {
        if (signal?.aborted) return settle();
        try {
          process.kill(group, "SIGKILL");
        } catch (error) {
          if (error?.code !== "ESRCH") return reject(error);
        }
        settle();
      }, graceMs);
      timer.unref?.();
      signal?.addEventListener("abort", cancel, { once: true });
    });
  }

  try {
    process.kill(group, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  return Promise.resolve();
}

function captureStream(stream, state, key) {
  if (!stream) return () => {};
  const decoder = new StringDecoder("utf8");
  const onData = (chunk) => {
    const decoded = decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    state[key] = appendUtf8Bounded(state[key], decoded);
  };
  const onEnd = () => {
    state[key] = appendUtf8Bounded(state[key], decoder.end());
  };
  stream.on("data", onData);
  stream.on("end", onEnd);
  return () => {
    stream.removeListener("data", onData);
    stream.removeListener("end", onEnd);
  };
}

function observeChildCompletion(child) {
  let settled = false;
  let resolveCompletion;
  const completion = new Promise((resolve) => { resolveCompletion = resolve; });
  const settle = (result) => {
    if (settled) return;
    settled = true;
    resolveCompletion(result);
  };
  const onError = (error) => settle({ kind: "spawn-error", error });
  const onClose = (code, signal) => settle({ kind: "close", code, signal });
  child.once("error", onError);
  child.once("close", onClose);
  return Object.freeze({
    completion,
    dispose() {
      child.removeListener("error", onError);
      child.removeListener("close", onClose);
    },
  });
}

function hasEventSurface(value) {
  return value && typeof value.once === "function" && typeof value.on === "function" &&
    typeof value.removeListener === "function";
}

function hasCaptureSurface(value) {
  return value && typeof value.on === "function" && typeof value.removeListener === "function";
}

async function cleanupInvalidChildSurface(child, killTree, cleanupTimeoutMs, terminationPolicy, graceMs) {
  if (!Number.isSafeInteger(child?.pid) || child.pid <= 0) return;
  const cleanupAbort = new AbortController();
  try {
    await boundedWait(killTree(child.pid, {
      terminationPolicy,
      graceMs: Math.min(graceMs, cleanupTimeoutMs),
      signal: cleanupAbort.signal,
    }), cleanupTimeoutMs);
  } catch {
    // The original invalid-surface error is authoritative.
  } finally {
    cleanupAbort.abort();
  }
}

function assertMandatorySpawnOptions(spawnOptions) {
  if (!spawnOptions || typeof spawnOptions !== "object" || Array.isArray(spawnOptions)) {
    throw validationError("invalid_test_supervisor_spawn_options");
  }
  for (const key of ["shell", "windowsHide", "detached", "stdio"]) {
    if (Object.hasOwn(spawnOptions, key)) {
      throw validationError("test_supervisor_spawn_options_override_mandatory");
    }
  }
}

function childAlreadyExited(child) {
  return (child.exitCode !== null && child.exitCode !== undefined) ||
    (child.signalCode !== null && child.signalCode !== undefined);
}

const MAX_CONTROL_MESSAGE_BYTES = 32 * 1024;
const CONTROL_START_KEYS = new Set([
  "protocolVersion",
  "runId",
  "correlationId",
  "scenarioId",
  "deadlineEpochMs",
  "cancellationId",
]);
const CONTROL_RESULT_KEYS = new Set([
  "protocolVersion",
  "runId",
  "correlationId",
  "terminalCode",
  "actionOutcome",
  "harnessOutcome",
  "cleanupOutcome",
  "proof",
  "cleanupFacts",
]);
const CONTROL_TERMINAL_CODES = new Set([
  "succeeded",
  "blocked",
  "cancelled",
  "deadline_exceeded",
  "protocol_error",
  "child_exit",
  "supervisor_closed",
  "recovery_incomplete",
]);
const CONTROL_ACTION_OUTCOMES = new Set(["succeeded", "failed", "not_started", "indeterminate"]);
const CONTROL_HARNESS_OUTCOMES = new Set(["succeeded", "failed", "cancelled", "not_started"]);
const CONTROL_CLEANUP_OUTCOMES = new Set(["succeeded", "failed", "not_started"]);
const CONTROL_PROOF_KEYS = new Set(["issuer", "binding", "data"]);
const CONTROL_PROOF_BINDING_KEYS = new Set([
  "runId",
  "correlationId",
  "requestId",
  "executionId",
  "actionId",
]);

function assertOpaqueControlId(value, errorCode) {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") === 0 ||
    Buffer.byteLength(value, "utf8") > 128) {
    throw validationError(errorCode);
  }
}

function assertPlainRecord(value, errorCode) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) {
    throw validationError(errorCode);
  }
}

function assertExactRecord(value, keys, errorCode) {
  assertPlainRecord(value, errorCode);
  const actual = Object.keys(value);
  if (actual.length !== keys.size || actual.some((key) => !keys.has(key))) {
    throw validationError(errorCode);
  }
}

function assertControlStart(start) {
  assertExactRecord(start, CONTROL_START_KEYS, "invalid_control_child_start");
  if (start.protocolVersion !== 1) throw validationError("control_child_unknown_protocol");
  if (start.scenarioId !== "equip_tool_control") {
    throw validationError("invalid_control_child_start");
  }
  if (!Number.isSafeInteger(start.deadlineEpochMs) || start.deadlineEpochMs <= 0) {
    throw validationError("invalid_control_child_start");
  }
  assertOpaqueControlId(start.runId, "invalid_control_child_start");
  assertOpaqueControlId(start.correlationId, "invalid_control_child_start");
  assertOpaqueControlId(start.cancellationId, "invalid_control_child_start");
}

function controlJsonLine(value, errorCode) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw validationError(errorCode);
  }
  if (typeof serialized !== "string") throw validationError(errorCode);
  const line = `${serialized}\n`;
  if (Buffer.byteLength(line, "utf8") > MAX_CONTROL_MESSAGE_BYTES) {
    throw validationError(errorCode);
  }
  return line;
}

function jsonWhitespace(text, index) {
  while (index < text.length && /\s/.test(text[index])) index++;
  return index;
}

function jsonStringEnd(text, index) {
  if (text[index] !== '"') throw validationError("control_child_invalid_result");
  const start = index++;
  let escaped = false;
  while (index < text.length) {
    const character = text[index++];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      try {
        return { value: JSON.parse(text.slice(start, index)), index };
      } catch {
        throw validationError("control_child_invalid_result");
      }
    }
  }
  throw validationError("control_child_invalid_result");
}

function jsonValueEnd(text, start) {
  let index = jsonWhitespace(text, start);
  if (text[index] === '"') return jsonStringEnd(text, index).index;
  if (text[index] === "{") {
    const keys = new Set();
    index = jsonWhitespace(text, index + 1);
    if (text[index] === "}") return index + 1;
    while (true) {
      const key = jsonStringEnd(text, index);
      if (keys.has(key.value)) throw validationError("control_child_duplicate_key");
      keys.add(key.value);
      index = jsonWhitespace(text, key.index);
      if (text[index] !== ":") throw validationError("control_child_invalid_result");
      index = jsonValueEnd(text, index + 1);
      index = jsonWhitespace(text, index);
      if (text[index] === "}") return index + 1;
      if (text[index] !== ",") throw validationError("control_child_invalid_result");
      index = jsonWhitespace(text, index + 1);
    }
  }
  if (text[index] === "[") {
    index = jsonWhitespace(text, index + 1);
    if (text[index] === "]") return index + 1;
    while (true) {
      index = jsonValueEnd(text, index);
      index = jsonWhitespace(text, index);
      if (text[index] === "]") return index + 1;
      if (text[index] !== ",") throw validationError("control_child_invalid_result");
      index = jsonWhitespace(text, index + 1);
    }
  }
  const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(index));
  if (!literal) throw validationError("control_child_invalid_result");
  return index + literal[0].length;
}

function parseControlJsonLine(line) {
  try {
    const end = jsonValueEnd(line, 0);
    if (jsonWhitespace(line, end) !== line.length) {
      throw validationError("control_child_invalid_result");
    }
    return JSON.parse(line);
  } catch (error) {
    if (error instanceof Error && error.message === "control_child_duplicate_key") throw error;
    throw validationError("control_child_invalid_result");
  }
}

const MAX_CONTROL_DATA_DEPTH = 8;
const MAX_CONTROL_DATA_ITEMS = 64;
const MAX_CONTROL_DATA_STRING_BYTES = 8 * 1024;

function assertBoundedControlData(value, depth = 0) {
  if (depth > MAX_CONTROL_DATA_DEPTH) throw validationError("control_child_invalid_result");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw validationError("control_child_invalid_result");
    return;
  }
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > MAX_CONTROL_DATA_STRING_BYTES) throw validationError("control_child_invalid_result");
    return;
  }
  assertPlainRecord(value, "control_child_invalid_result");
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_CONTROL_DATA_ITEMS || keys.some((key) => typeof key !== "string")) {
    throw validationError("control_child_invalid_result");
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw validationError("control_child_invalid_result");
    assertBoundedControlData(descriptor.value, depth + 1);
  }
}

function assertControlResult(result, start) {
  assertExactRecord(result, CONTROL_RESULT_KEYS, "control_child_invalid_result");
  if (result.protocolVersion !== 1) throw validationError("control_child_unknown_protocol");
  if (!CONTROL_TERMINAL_CODES.has(result.terminalCode) ||
    !CONTROL_ACTION_OUTCOMES.has(result.actionOutcome) ||
    !CONTROL_HARNESS_OUTCOMES.has(result.harnessOutcome) ||
    !CONTROL_CLEANUP_OUTCOMES.has(result.cleanupOutcome)) {
    throw validationError("control_child_invalid_result");
  }
  assertOpaqueControlId(result.runId, "control_child_invalid_result");
  assertOpaqueControlId(result.correlationId, "control_child_invalid_result");
  if (result.runId !== start.runId || result.correlationId !== start.correlationId) {
    throw validationError("control_child_result_identity_mismatch");
  }
  assertExactRecord(result.proof, CONTROL_PROOF_KEYS, "control_child_invalid_result");
  if (result.proof.issuer !== "host_control_runner") {
    throw validationError("control_child_invalid_result");
  }
  assertExactRecord(result.proof.binding, CONTROL_PROOF_BINDING_KEYS, "control_child_invalid_result");
  for (const key of ["runId", "correlationId", "requestId", "executionId"]) {
    assertOpaqueControlId(result.proof.binding[key], "control_child_invalid_result");
  }
  if (result.proof.binding.runId !== start.runId ||
    result.proof.binding.correlationId !== start.correlationId ||
    result.proof.binding.actionId !== "equip_tool") {
    throw validationError("control_child_invalid_result");
  }
  assertBoundedControlData(result.proof.data);
  assertBoundedControlData(result.cleanupFacts);
  return Object.freeze(result);
}

function appendControlStdout(state, chunk) {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  state.stdoutBytesSeen += bytes.byteLength;
  if (state.stdoutBytesSeen > MAX_CONTROL_MESSAGE_BYTES) {
    state.stdoutOversize = true;
    return;
  }
  state.stdoutBytes = Buffer.concat([state.stdoutBytes, bytes]);
  state.stdout += state.stdoutDecoder.write(bytes);
}

function finishControlStdout(state) {
  state.stdout += state.stdoutDecoder.end();
  if (state.stdoutOversize) return;
  try {
    // StringDecoder keeps split code points intact while the fatal decoder
    // checks the complete bounded byte frame for malformed UTF-8.
    state.stdout = new TextDecoder("utf-8", { fatal: true }).decode(state.stdoutBytes);
  } catch {
    state.stdoutInvalidUtf8 = true;
  }
}

function inspectControlStdout(state, start, failProtocol, { allowSettled = false } = {}) {
  if (state.stdoutOversize || state.stdoutInvalidUtf8) return failProtocol("control_child_invalid_result");
  const newline = state.stdout.indexOf("\n");
  if (newline < 0) {
    if (state.stdoutBytesSeen >= MAX_CONTROL_MESSAGE_BYTES) failProtocol("control_child_invalid_result");
    return;
  }
  if (newline !== state.stdout.length - 1 || (state.terminalResult && !allowSettled)) {
    return failProtocol("control_child_invalid_result");
  }
  if (state.terminalResult) return;
  const line = state.stdout.slice(0, -1);
  try {
    state.terminalResult = assertControlResult(parseControlJsonLine(line), start);
  } catch (error) {
    failProtocol(error instanceof Error ? error.message : "control_child_invalid_result");
  }
}

async function terminateControlChild(child, completionObserver, killTree, cleanupTimeoutMs, terminationPolicy, graceMs) {
  const deadline = Date.now() + cleanupTimeoutMs;
  const cleanupAbort = new AbortController();
  try {
    if (!childAlreadyExited(child)) {
      try {
        validatePid(child.pid);
        await boundedWait(killTree(child.pid, {
          terminationPolicy,
          graceMs: Math.min(graceMs, remainingBefore(deadline)),
          signal: cleanupAbort.signal,
        }), remainingBefore(deadline));
      } catch {
        // The triggering protocol/cancellation error remains authoritative.
      }
    }
    await boundedWait(completionObserver.completion, remainingBefore(deadline));
  } finally {
    cleanupAbort.abort();
    completionObserver.dispose();
  }
}

export async function runOneShotControlChild({
  command,
  args = [],
  cwd,
  start,
  signal,
  timeoutMs = DEFAULT_SUITE_TIMEOUT_MS,
  spawnProcess = spawn,
  killTree = defaultKillTree,
  cleanupTimeoutMs = CLEANUP_TIMEOUT_MS,
  terminationPolicy = "immediate",
  graceMs = 250,
  spawnOptions = {},
} = {}) {
  if (typeof command !== "string" || command.length === 0 || !Array.isArray(args)) {
    throw validationError("invalid_control_child_command");
  }
  if (signal !== undefined && (typeof signal !== "object" || signal === null ||
    typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function")) {
    throw validationError("invalid_control_child_signal");
  }
  if (typeof spawnProcess !== "function" || typeof killTree !== "function") {
    throw validationError("invalid_control_child_process_hooks");
  }
  validateOptions({ timeoutMs, cleanupTimeoutMs, heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS, terminationPolicy, graceMs });
  assertMandatorySpawnOptions(spawnOptions);
  assertControlStart(start);
  const startLine = controlJsonLine(start, "invalid_control_child_start");
  if (signal?.aborted) throw validationError("control_child_aborted");

  const state = {
    stdout: "",
    stderr: "",
    stdoutBytes: Buffer.alloc(0),
    stdoutDecoder: new StringDecoder("utf8"),
    stdoutBytesSeen: 0,
    stdoutOversize: false,
    stdoutInvalidUtf8: false,
    terminalResult: undefined,
    protocolFailureCode: "control_child_invalid_result",
  };
  const child = spawnProcess(command, args, {
    cwd,
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
    ...spawnOptions,
  });
  if (!hasEventSurface(child) || !child.stdin || typeof child.stdin.end !== "function" ||
    !hasCaptureSurface(child.stdout) || !hasCaptureSurface(child.stderr)) {
    await cleanupInvalidChildSurface(child, killTree, cleanupTimeoutMs, terminationPolicy, graceMs);
    throw validationError("invalid_control_child_process");
  }

  const stderrDecoder = new StringDecoder("utf8");
  const onStdoutData = (chunk) => {
    appendControlStdout(state, chunk);
    inspectControlStdout(state, start, failProtocol);
  };
  const onStdoutEnd = () => {
    if (!state.stdoutInvalidUtf8) {
      try {
        finishControlStdout(state);
      } catch {
        state.stdoutInvalidUtf8 = true;
      }
    }
    inspectControlStdout(state, start, failProtocol, { allowSettled: true });
  };
  const onStderrData = (chunk) => {
    const decoded = stderrDecoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    state.stderr = appendUtf8Bounded(state.stderr, decoded);
  };
  const onStderrEnd = () => {
    state.stderr = appendUtf8Bounded(state.stderr, stderrDecoder.end());
  };
  child.stdout.on("data", onStdoutData);
  child.stdout.on("end", onStdoutEnd);
  child.stderr.on("data", onStderrData);
  child.stderr.on("end", onStderrEnd);

  const completionObserver = observeChildCompletion(child);
  const completion = completionObserver.completion;
  let rejectProtocol;
  const protocolFailure = new Promise((resolve) => {
    rejectProtocol = () => resolve({ kind: "protocol-failure" });
  });
  // The stream callbacks are installed before this function can receive data.
  const failProtocol = (code = "control_child_invalid_result") => {
    if (!state.protocolFailed) {
      state.protocolFailed = true;
      state.protocolFailureCode = code;
      rejectProtocol?.();
    }
  };
  let timer;
  let abortListener;
  let stdinErrorListener;
  let startWriteFailed = false;
  let completed = false;
  try {
    if (signal?.aborted) throw validationError("control_child_aborted");
    const outcomePromise = Promise.race([
      completion.then((value) => {
        completed = value.kind === "close";
        return value;
      }),
      protocolFailure,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
      }),
      new Promise((resolve) => {
        abortListener = () => resolve({ kind: "aborted" });
        signal?.addEventListener("abort", abortListener, { once: true });
      }),
      new Promise((resolve, reject) => {
        stdinErrorListener = (error) => {
          startWriteFailed = true;
          reject(error);
        };
        child.stdin.once?.("error", stdinErrorListener);
      }),
    ]);
    try {
      child.stdin.end(startLine, "utf8");
    } catch {
      startWriteFailed = true;
    }
    let outcome;
    try {
      outcome = await outcomePromise;
    } catch {
      outcome = { kind: "stdin-error" };
    }
    if (outcome.kind === "aborted" || (signal?.aborted && !completed) ||
      outcome.kind === "timeout" || outcome.kind === "protocol-failure" ||
      outcome.kind === "stdin-error" || startWriteFailed) {
      await terminateControlChild(child, completionObserver, killTree, cleanupTimeoutMs, terminationPolicy, graceMs);
      if (outcome.kind === "aborted" || signal?.aborted) throw validationError("control_child_aborted");
      if (outcome.kind === "timeout") throw validationError("control_child_timeout");
      if (outcome.kind === "stdin-error" || startWriteFailed) throw validationError("control_child_start_failed");
      throw validationError("control_child_invalid_result");
    }
    if (outcome.kind === "spawn-error") throw validationError("control_child_spawn_failed");
    if (!state.terminalResult) throw validationError("control_child_invalid_result");
    return Object.freeze({
      result: state.terminalResult,
      stderr: state.stderr,
      exit: Object.freeze({ code: outcome.code, signal: outcome.signal }),
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (abortListener) signal?.removeEventListener("abort", abortListener);
    if (stdinErrorListener) child.stdin.removeListener?.("error", stdinErrorListener);
    completionObserver.dispose();
    child.stdout.removeListener("data", onStdoutData);
    child.stdout.removeListener("end", onStdoutEnd);
    child.stderr.removeListener("data", onStderrData);
    child.stderr.removeListener("end", onStderrEnd);
  }
}

export async function runBoundedChild({
  command,
  args = [],
  cwd,
  timeoutMs = DEFAULT_SUITE_TIMEOUT_MS,
  spawnProcess = spawn,
  killTree = defaultKillTree,
  cleanupTimeoutMs = CLEANUP_TIMEOUT_MS,
  stdio = "pipe",
  spawnOptions = {},
  onHeartbeat,
  heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
  terminationPolicy = "immediate",
  graceMs = 250,
} = {}) {
  if (typeof command !== "string" || command.length === 0 || !Array.isArray(args)) {
    throw validationError("invalid_test_supervisor_command");
  }
  if (stdio !== "pipe" && stdio !== "inherit") {
    throw validationError("invalid_test_supervisor_stdio");
  }
  if (typeof spawnProcess !== "function" || typeof killTree !== "function") {
    throw validationError("invalid_test_supervisor_process_hooks");
  }
  if (onHeartbeat !== undefined && typeof onHeartbeat !== "function") {
    throw validationError("invalid_test_supervisor_heartbeat");
  }
  validateOptions({ timeoutMs, cleanupTimeoutMs, heartbeatIntervalMs, terminationPolicy, graceMs });
  assertMandatorySpawnOptions(spawnOptions);

  const startedAt = Date.now();
  const state = { stdout: "", stderr: "" };
  const child = spawnProcess(command, args, {
    cwd,
    shell: false,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio,
    ...spawnOptions,
  });
  if (!hasEventSurface(child) || (stdio === "pipe" &&
    (!hasCaptureSurface(child.stdout) || !hasCaptureSurface(child.stderr)))) {
    await cleanupInvalidChildSurface(child, killTree, cleanupTimeoutMs, terminationPolicy, graceMs);
    throw validationError("invalid_test_supervisor_child");
  }
  const streamDisposers = stdio === "pipe"
    ? [captureStream(child.stdout, state, "stdout"), captureStream(child.stderr, state, "stderr")]
    : [];
  const completionObserver = observeChildCompletion(child);
  const completion = completionObserver.completion;
  const heartbeat = onHeartbeat
    ? setInterval(() => {
      try {
        onHeartbeat({ pid: child.pid, elapsedMs: Date.now() - startedAt });
      } catch {
        // Heartbeats are diagnostic and cannot affect the child outcome.
      }
    }, heartbeatIntervalMs)
    : undefined;
  heartbeat?.unref?.();

  let result;
  let timedOut = false;
  let deadlineTimer;
  try {
    const deadline = new Promise((resolve) => {
      deadlineTimer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
    });
    result = childAlreadyExited(child) ? await completion : await Promise.race([completion, deadline]);
    if (result.kind === "timeout") {
      timedOut = true;
      validatePid(child.pid);
      const cleanupDeadline = Date.now() + cleanupTimeoutMs;
      const cleanupAbort = new AbortController();
      let cleanupResult;
      try {
        cleanupResult = await boundedWait(
          killTree(child.pid, {
            terminationPolicy,
            graceMs: Math.min(graceMs, cleanupTimeoutMs),
            signal: cleanupAbort.signal,
          }),
          remainingBefore(cleanupDeadline),
        );
      } catch {
        cleanupResult = false;
      }
      if (!cleanupResult) cleanupAbort.abort();
      // A reaper is untrusted. It gets its own independent bounded window after
      // the suite deadline; a late close cannot keep this supervisor alive.
      await boundedWait(completion, Math.min(1_000, remainingBefore(cleanupDeadline)));
      const output = boundedOutput(state);
      throw new Error(`test_supervisor_timeout:pid=${child.pid}:timeout_ms=${timeoutMs}\n${output}`);
    }
    if (result.kind === "spawn-error") {
      throw new Error(`test_runner_failed:spawn:${result.error?.message ?? "unknown"}`);
    }
    if (result.code !== 0 || result.signal) {
      throw new Error(`test_runner_failed:code=${result.code ?? "none"}:signal=${result.signal ?? "none"}\n${boundedOutput(state)}`);
    }
    return Object.freeze({ code: result.code, signal: result.signal, output: boundedOutput(state), stdout: state.stdout, stderr: state.stderr });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    completionObserver.dispose();
    for (const dispose of streamDisposers) dispose();
    void timedOut;
  }
}
