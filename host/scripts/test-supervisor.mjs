import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

/**
 * Repository-owned boundary for a test child and every child it creates.
 * `ChildProcess#close` only proves the direct child and its stdio have closed;
 * it does not prove descendants have exited. On Windows a timed-out suite is
 * therefore reaped with `taskkill /T`, scoped to the exact spawned PID.
 */
export const DEFAULT_SUITE_TIMEOUT_MS = 15 * 60_000;
export const CLEANUP_TIMEOUT_MS = 5_000;
const OUTPUT_LIMIT_BYTES = 64 * 1024;

function utf8Boundary(bytes, limit) {
  let end = Math.min(bytes.length, limit);
  if (end === bytes.length) return end;
  let start = end - 1;
  while (start > 0 && (bytes[start] & 0xc0) === 0x80) start -= 1;
  const lead = bytes[start];
  const expected = lead <= 0x7f ? 1 : lead >= 0xc2 && lead <= 0xdf ? 2 : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 1;
  if (expected > end - start) end = start;
  return end;
}

function boundedAppend(current, chunk) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  const remaining = OUTPUT_LIMIT_BYTES - Buffer.byteLength(current, "utf8");
  if (remaining <= 0) return current;
  const bytes = Buffer.from(text, "utf8");
  return current + bytes.subarray(0, utf8Boundary(bytes, remaining)).toString("utf8");
}

function waitForExit(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve({ code: child.exitCode, signal: child.signalCode });
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", () => resolve({ code: null, signal: "spawn_error" }));
  });
}

function taskkillTree(pid, { spawnProcess = spawn } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve();
  if (process.platform === "win32") {
    return new Promise((resolve) => {
      let reaper;
      try {
        reaper = spawnProcess("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      } catch {
        resolve();
        return;
      }
      reaper.once("error", resolve);
      reaper.once("close", resolve);
    });
  }
  // The supervisor creates a detached process group below. Killing the group,
  // rather than only the direct Node child, also reaps production wrappers and
  // the node --test worker they launch. A direct fallback covers injected
  // runners that cannot honor `detached`.
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") {
      try { process.kill(pid, "SIGKILL"); } catch (fallbackError) {
        if (fallbackError?.code !== "ESRCH") throw fallbackError;
      }
    }
  }
  return Promise.resolve();
}

function waitAtMost(promise, timeoutMs) {
  let timeoutId;
  const deadline = new Promise((resolve) => {
    timeoutId = setTimeout(resolve, timeoutMs);
    timeoutId.unref?.();
  });
  return Promise.race([Promise.resolve(promise).catch(() => undefined), deadline]).finally(() => clearTimeout(timeoutId));
}

/** Run one suite with bounded output and a total deadline. A timeout is always
 * a failure, even if cleanup eventually succeeds. */
export async function runBoundedChild({ command, args, cwd, timeoutMs = DEFAULT_SUITE_TIMEOUT_MS, spawnProcess = spawn, killTree = taskkillTree, cleanupTimeoutMs = CLEANUP_TIMEOUT_MS, stdio = "pipe", spawnOptions = {}, onHeartbeat = undefined, heartbeatIntervalMs = 30_000 }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100) throw new Error("invalid_test_supervisor_timeout");
  if (onHeartbeat !== undefined && typeof onHeartbeat !== "function") throw new Error("invalid_test_supervisor_heartbeat");
  if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 10) throw new Error("invalid_test_supervisor_heartbeat_interval");
  const startedAtMs = Date.now();
  const child = spawnProcess(command, args, {
    ...spawnOptions,
    cwd,
    stdio,
    windowsHide: true,
    // POSIX process groups are the cross-platform counterpart to Windows'
    // taskkill /T tree ownership. The option is ignored on Windows.
    detached: process.platform !== "win32",
  });
  let output = "";
  let stdout = "";
  let stderr = "";
  const stdoutDecoder = new StringDecoder("utf8");
  const stderrDecoder = new StringDecoder("utf8");
  const appendStdout = (text) => {
    stdout = boundedAppend(stdout, text);
    output = boundedAppend(output, text);
  };
  const appendStderr = (text) => {
    stderr = boundedAppend(stderr, text);
    output = boundedAppend(output, text);
  };
  child.stdout?.on("data", (chunk) => appendStdout(stdoutDecoder.write(chunk)));
  child.stderr?.on("data", (chunk) => appendStderr(stderrDecoder.write(chunk)));
  const heartbeat = onHeartbeat === undefined ? undefined : setInterval(() => {
    // Progress is diagnostic only. A reporter must never control test outcome
    // or turn an otherwise bounded runner into an unhandled callback failure.
    try { onHeartbeat(Object.freeze({ pid: child.pid, elapsedMs: Date.now() - startedAtMs })); } catch { /* ignore reporter failures */ }
  }, heartbeatIntervalMs);
  heartbeat?.unref?.();
  const exit = waitForExit(child);
  // `close` follows `exit`, but inherited stdio from a production wrapper or
  // node --test descendant can keep it open after the direct child exits. The
  // deadline therefore races the complete close, not only the direct exit.
  const close = new Promise((resolve) => child.once("close", (code, signal) => {
    appendStdout(stdoutDecoder.end());
    appendStderr(stderrDecoder.end());
    resolve({ code, signal });
  }));
  const completed = close.then(() => exit);
  let timeoutId;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve(undefined), timeoutMs);
    timeoutId.unref?.();
  });
  const outcome = await Promise.race([completed, timeout]);
  if (timeoutId !== undefined) clearTimeout(timeoutId);
  if (heartbeat !== undefined) clearInterval(heartbeat);
  if (outcome === undefined) {
    // Reaping is itself untrusted: taskkill/kill may reject, throw, or hang.
    // Keep the entire cleanup phase bounded so the original suite timeout
    // remains authoritative, including when the child handle never closes.
    const cleanupDeadline = Date.now() + cleanupTimeoutMs;
    const remainingCleanup = () => Math.max(0, cleanupDeadline - Date.now());
    await waitAtMost(Promise.resolve().then(() => killTree(child.pid)), remainingCleanup());
    // `taskkill` is asynchronous relative to Node's child handle. Do not
    // permit a hung child to hold this test command forever after reaping.
    await waitAtMost(exit, Math.min(5_000, remainingCleanup()));
    await waitAtMost(close, Math.min(1_000, remainingCleanup()));
    throw new Error(`test_supervisor_timeout:pid=${child.pid ?? "unknown"}:timeout_ms=${timeoutMs}\n${output}`);
  }
  if (outcome.code !== 0) throw new Error(`test_runner_failed:code=${outcome.code}:signal=${outcome.signal ?? "none"}\n${output}`);
  return Object.freeze({ code: outcome.code, signal: outcome.signal, output, stdout, stderr });
}
