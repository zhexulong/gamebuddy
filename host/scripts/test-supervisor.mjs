import { spawn } from "node:child_process";

/**
 * Repository-owned boundary for a test child and every child it creates.
 * `ChildProcess#close` only proves the direct child and its stdio have closed;
 * it does not prove descendants have exited. On Windows a timed-out suite is
 * therefore reaped with `taskkill /T`, scoped to the exact spawned PID.
 */
export const DEFAULT_SUITE_TIMEOUT_MS = 15 * 60_000;
const OUTPUT_LIMIT_BYTES = 64 * 1024;

function boundedAppend(current, chunk) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
  const remaining = OUTPUT_LIMIT_BYTES - Buffer.byteLength(current, "utf8");
  if (remaining <= 0) return current;
  return current + text.slice(0, remaining);
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
  if (process.platform !== "win32") return Promise.resolve();
  return new Promise((resolve) => {
    const reaper = spawnProcess("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    reaper.once("error", resolve);
    reaper.once("close", resolve);
  });
}

/** Run one suite with bounded output and a total deadline. A timeout is always
 * a failure, even if cleanup eventually succeeds. */
export async function runBoundedChild({ command, args, cwd, timeoutMs = DEFAULT_SUITE_TIMEOUT_MS, spawnProcess = spawn, killTree = taskkillTree, stdio = "pipe" }) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100) throw new Error("invalid_test_supervisor_timeout");
  const child = spawnProcess(command, args, { cwd, stdio, windowsHide: true });
  let output = "";
  child.stdout?.on("data", (chunk) => { output = boundedAppend(output, chunk); });
  child.stderr?.on("data", (chunk) => { output = boundedAppend(output, chunk); });
  const exit = waitForExit(child);
  const close = new Promise((resolve) => child.once("close", resolve));
  let timeoutId;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve(undefined), timeoutMs);
    timeoutId.unref?.();
  });
  const outcome = await Promise.race([exit, timeout]);
  if (timeoutId !== undefined) clearTimeout(timeoutId);
  if (outcome === undefined) {
    await killTree(child.pid);
    // `taskkill` is asynchronous relative to Node's child handle. Do not
    // permit a hung child to hold this test command forever after reaping.
    await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    await Promise.race([close, new Promise((resolve) => setTimeout(resolve, 1_000))]);
    throw new Error(`test_supervisor_timeout:pid=${child.pid ?? "unknown"}:timeout_ms=${timeoutMs}\n${output}`);
  }
  // Node's `close` follows `exit` and drains the direct child's stdio. Await
  // it so no suite output can bleed into the next suite after a successful run.
  await close;
  if (outcome.code !== 0) throw new Error(`test_runner_failed:code=${outcome.code}:signal=${outcome.signal ?? "none"}\n${output}`);
  return Object.freeze({ code: outcome.code, signal: outcome.signal, output });
}
