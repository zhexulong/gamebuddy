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
  if (!stream) return;
  const decoder = new StringDecoder("utf8");
  stream.on("data", (chunk) => {
    const decoded = decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    state[key] = appendUtf8Bounded(state[key], decoded);
  });
  stream.on("end", () => {
    state[key] = appendUtf8Bounded(state[key], decoder.end());
  });
}

function childCompletion(child, state) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once("error", (error) => settle({ kind: "spawn-error", error }));
    child.once("close", (code, signal) => settle({ kind: "close", code, signal }));
  });
}

function childAlreadyExited(child) {
  return (child.exitCode !== null && child.exitCode !== undefined) ||
    (child.signalCode !== null && child.signalCode !== undefined);
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
  if (!child || typeof child.once !== "function" || typeof child.on !== "function") {
    throw validationError("invalid_test_supervisor_child");
  }
  if (stdio === "pipe") {
    captureStream(child.stdout, state, "stdout");
    captureStream(child.stderr, state, "stderr");
  }

  const completion = childCompletion(child, state);
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
    void timedOut;
  }
}
