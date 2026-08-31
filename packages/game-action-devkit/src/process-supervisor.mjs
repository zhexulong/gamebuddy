import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export const DEFAULT_SUITE_TIMEOUT_MS = 15 * 60_000;
export const CLEANUP_TIMEOUT_MS = 5_000;
const MAX_CAPTURE_BYTES = 64 * 1024;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const VALID_TERMINATION_POLICIES = new Set(["immediate", "term-then-kill"]);

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

function defaultKillTree(pid, { terminationPolicy, graceMs, signal }) {
  validatePid(pid);
  if (process.platform === "win32") {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return resolve();
      const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("error", reject);
      killer.once("close", (code) => {
        if (code === 0 || code === 128) resolve();
        else reject(new Error(`test_supervisor_taskkill_failed:${code ?? "signal"}`));
      });
    });
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

function assertBoundedJsonLine(value, errorCode) {
  let serialized;
  try { serialized = JSON.stringify(value); } catch { throw validationError(errorCode); }
  if (typeof serialized !== "string") throw validationError(errorCode);
  const line = `${serialized}\n`;
  if (Buffer.byteLength(line, "utf8") > MAX_CAPTURE_BYTES) {
    throw validationError(errorCode);
  }
  return line;
}

function parseOneBoundedJsonResult(stdout) {
  if (!stdout.endsWith("\n") || stdout.indexOf("\n") !== stdout.length - 1) {
    throw validationError("control_child_invalid_result");
  }
  const line = stdout.slice(0, -1);
  if (line.length === 0 || Buffer.byteLength(stdout, "utf8") > MAX_CAPTURE_BYTES) {
    throw validationError("control_child_invalid_result");
  }
  try { return JSON.parse(line); } catch { throw validationError("control_child_invalid_result"); }
}

async function terminateChild(child, completionObserver, killTree, cleanupTimeoutMs, terminationPolicy, graceMs) {
  const deadline = Date.now() + cleanupTimeoutMs;
  const cleanupAbort = new AbortController();
  try {
    if (!childAlreadyExited(child)) {
      validatePid(child.pid);
      await boundedWait(killTree(child.pid, {
        terminationPolicy,
        graceMs: Math.min(graceMs, remainingBefore(deadline)),
        signal: cleanupAbort.signal,
      }), remainingBefore(deadline));
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
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw validationError("invalid_control_child_signal");
  }
  if (typeof spawnProcess !== "function" || typeof killTree !== "function") {
    throw validationError("invalid_control_child_process_hooks");
  }
  validateOptions({ timeoutMs, cleanupTimeoutMs, heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS, terminationPolicy, graceMs });
  assertMandatorySpawnOptions(spawnOptions);
  const startLine = assertBoundedJsonLine(start, "invalid_control_child_start");
  if (signal?.aborted) throw validationError("control_child_aborted");

  const state = { stdout: "", stderr: "", stdoutOversize: false };
  const streamDisposers = [];
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
  for (const key of ["stdout", "stderr"]) {
    const stream = child[key];
    const decoder = new StringDecoder("utf8");
    const onData = (chunk) => {
      const decoded = decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const next = appendUtf8Bounded(state[key], decoded);
      if (key === "stdout" && Buffer.byteLength(state.stdout, "utf8") + Buffer.byteLength(decoded, "utf8") > MAX_CAPTURE_BYTES) state.stdoutOversize = true;
      state[key] = next;
    };
    const onEnd = () => { state[key] = appendUtf8Bounded(state[key], decoder.end()); };
    stream.on("data", onData);
    stream.on("end", onEnd);
    streamDisposers.push(() => {
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
    });
  }
  const completionObserver = observeChildCompletion(child);
  const completion = completionObserver.completion;
  let rejectProtocol;
  let completeFrameObserved = false;
  const protocolFailure = new Promise((resolve) => { rejectProtocol = resolve; });
  const inspectProtocol = () => {
    if (state.stdoutOversize) return rejectProtocol();
    if (completeFrameObserved) return rejectProtocol();
    const newline = state.stdout.indexOf("\n");
    if (newline < 0) return;
    try {
      parseOneBoundedJsonResult(state.stdout);
      completeFrameObserved = true;
    } catch {
      rejectProtocol();
    }
  };
  child.stdout.on("data", inspectProtocol);
  child.stdin.end(startLine, "utf8");

  let timer;
  let abortListener;
  let completed = false;
  try {
    const outcome = await Promise.race([
      completion.then((value) => { completed = value.kind === "close"; return value; }),
      protocolFailure.then(() => ({ kind: "protocol-failure" })),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs); }),
      new Promise((resolve) => {
        abortListener = () => resolve({ kind: "aborted" });
        signal?.addEventListener("abort", abortListener, { once: true });
      }),
    ]);
    // A completed close wins only when abort was not observed before that close.
    if (outcome.kind === "aborted" || (signal?.aborted && !completed) || outcome.kind === "timeout" || outcome.kind === "protocol-failure") {
      await terminateChild(child, completionObserver, killTree, cleanupTimeoutMs, terminationPolicy, graceMs);
      if (outcome.kind === "aborted" || signal?.aborted) throw validationError("control_child_aborted");
      if (outcome.kind === "timeout") throw validationError("control_child_timeout");
      throw validationError("control_child_invalid_result");
    }
    if (outcome.kind === "spawn-error") throw validationError("control_child_spawn_failed");
    if (state.stdoutOversize) throw validationError("control_child_invalid_result");
    const result = parseOneBoundedJsonResult(state.stdout);
    return Object.freeze({
      child: Object.freeze({ pid: child.pid, stdout: state.stdout, stderr: state.stderr }),
      result,
      exit: Object.freeze({ code: outcome.code, signal: outcome.signal }),
    });
  } finally {
    child.stdout.removeListener("data", inspectProtocol);
    if (timer) clearTimeout(timer);
    if (abortListener) signal?.removeEventListener("abort", abortListener);
    completionObserver.dispose();
    for (const dispose of streamDisposers) dispose();
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
