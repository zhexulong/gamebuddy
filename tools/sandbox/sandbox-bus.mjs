#!/usr/bin/env node
/**
 * Host-side control of a Windows Sandbox over a file bus.
 *
 * Why a file bus and not UI automation: a sandbox is an RDP session, so from the host its window is
 * a DirectX surface with no accessible control tree. The one thing that genuinely crosses the
 * boundary is the mapped folder. So the host writes a task file, a worker inside the guest executes
 * it and writes a result file, and this module is the host half of that.
 *
 * Why it matters for this repository: it is what makes the clean-machine acceptance run automated.
 * The guest has no .NET, no Node and no pnpm, which is the premise the installer has to survive; the
 * host still drives the whole run, reads the verdict, and closes the sandbox without anyone clicking.
 *
 * Lifecycle, in the order the platform requires:
 *   start()  - close any running sandbox (the platform allows exactly ONE instance), write the
 *              .wsb, launch WindowsSandbox.exe with it, then wait for the guest's ready file.
 *   run()    - write a task, poll for its result, return it.
 *   stop()   - close the sandbox UI and wait for the VM worker to go.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const WINDOWS_SANDBOX = "C:\\Windows\\System32\\WindowsSandbox.exe";
export const GUEST_BUS = "C:\\gamebuddy-bus";

const scriptPath = fileURLToPath(import.meta.url);
const sandboxRoot = dirname(scriptPath);

/** The host directories that back the guest's bus folder. */
export const BUS_PATHS = Object.freeze({
  tasks: "tasks",
  results: "results",
  running: "running",
  ready: "guest-ready.txt",
});

export function assertSandboxAvailable() {
  if (process.platform !== "win32") throw new Error("windows_required");
  if (!existsSync(WINDOWS_SANDBOX)) throw new Error("windows_sandbox_unavailable");
  if (!existsSync(join(sandboxRoot, "guest-worker.ps1"))) throw new Error("guest_worker_absent");
  if (!existsSync(join(sandboxRoot, "sandbox-bus.wsb.template"))) throw new Error("wsb_template_absent");
}

/**
 * The `.wsb` for one bus folder.
 *
 * `HostFolder` is substituted rather than templated by the platform, because the configuration
 * format has no variable expansion: the file the host launches names the exact directory this
 * session will use, so two runs cannot share a bus by accident.
 */
export async function writeSandboxConfiguration({ busHostFolder, configurationPath }) {
  const template = await readFile(join(sandboxRoot, "sandbox-bus.wsb.template"), "utf8");
  if (!template.includes("__BUS_HOST_FOLDER__")) throw new Error("wsb_template_marker_missing");
  if (!/^[A-Za-z]:\\/.test(busHostFolder)) throw new Error("bus_host_folder_must_be_absolute");
  // A path is placed into XML, so a `&` or `<` in it would produce a file the platform rejects.
  if (/[<>&"]/.test(busHostFolder)) throw new Error("bus_host_folder_has_xml_specials");
  const configuration = template.replaceAll("__BUS_HOST_FOLDER__", busHostFolder);
  await writeFile(configurationPath, configuration, "utf8");
  return configurationPath;
}

/**
 * Stages the guest worker into the shared folder.
 *
 * The `LogonCommand` runs `C:\gamebuddy-bus\guest-worker.ps1`, which is the HOST folder's copy of
 * this file seen from inside the guest. Measured failure it caused: the `.wsb` mounted the bus and
 * started the logon command, the sandbox came up, and nothing ever wrote a ready file - because the
 * share held only the empty bus directories and no worker at all. The worker's home in the
 * repository is not mounted by anything; it has to be copied in before the sandbox starts.
 *
 * It is copied on every start so an edited worker always takes effect: a stale copy in the share
 * would silently run the previous protocol.
 */
export async function stageGuestWorker(busHostFolder) {
  await copyFile(join(sandboxRoot, "guest-worker.ps1"), join(busHostFolder, "guest-worker.ps1"));
  return join(busHostFolder, "guest-worker.ps1");
}

function sandboxProcesses() {
  const list = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '^WindowsSandbox' } | ForEach-Object { $_.Id }",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  return (list.stdout ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => /^\d+$/u.test(line))
    .map(Number);
}

/**
 * Closes sandbox sessions and confirms the platform actually released them.
 *
 * Measured failure this replaces a naive "stop the UI and go" with: every
 * `WindowsSandbox.exe <wsb>` launch leaves a `WindowsSandboxRemoteSession` holding its `.wsb`, and
 * `Stop-Process` on those does NOT release the Hyper-V compute system behind them. Launch again and
 * the next one may fail with "a session could not be created because there are too many
 * connections", and no guest reaches its `LogonCommand` - so a mapped folder silently stays empty.
 *
 * So this reports what it can and cannot do rather than pretending to succeed: without elevation the
 * orphaned worker cannot be cleared, and the caller needs to know that instead of waiting minutes for
 * a ready file that will never come.
 */
export async function closeSandbox({ timeoutMs = 45_000 } = {}) {
  const ids = sandboxProcesses();
  for (const id of ids) {
    spawnSync("taskkill", ["/PID", String(id), "/F"], { windowsHide: true, stdio: "ignore" });
  }

  const deadline = Date.now() + timeoutMs;
  let sessions = countProtectedWorkers();
  while (Date.now() < deadline) {
    if (sessions === 0)
      return Object.freeze({ released: true, stopped: ids.length, sessions: 0, needsElevation: false });
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    sessions = countProtectedWorkers();
  }
  return Object.freeze({ released: false, stopped: ids.length, sessions, needsElevation: true });
}

function countProtectedWorkers() {
  // What actually runs out is the SESSION pool, not the VM worker.
  //
  // Measured: `vmwp` routinely outlives a closed sandbox for minutes, and a launch that succeeded
  // had one present. Guarding on `vmwp` therefore refused launches that would have worked. The
  // process that exhausts the pool is `WindowsSandboxRemoteSession` - each one holds a `.wsb`, and
  // enough of them is what produces "a session could not be created because there are too many
  // connections".
  const probe = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      "(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -eq 'WindowsSandboxRemoteSession' } | Measure-Object).Count",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  const count = Number((probe.stdout ?? "").trim());
  return Number.isFinite(count) ? count : 0;
}

/**
 * Launches a sandbox on `busHostFolder` and waits for the guest worker to announce itself.
 *
 * A launch can be refused when the previous instance has not finished closing, so this retries with
 * a fresh close in between rather than reporting the platform's bare refusal.
 */
export async function startSandbox({ busHostFolder, configurationPath, readyTimeoutMs = 180_000, attempts = 2 }) {
  await mkdir(busHostFolder, { recursive: true });
  for (const name of [BUS_PATHS.tasks, BUS_PATHS.results, BUS_PATHS.running]) {
    await mkdir(join(busHostFolder, name), { recursive: true });
  }
  await rm(join(busHostFolder, BUS_PATHS.ready), { force: true });
  await stageGuestWorker(busHostFolder);
  await writeSandboxConfiguration({ busHostFolder, configurationPath });

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // Refuse to launch into a dirty platform state. A session pool that still holds orphans does not
    // produce a slow start - it produces no guest at all, so retrying is wasted time and, worse,
    // adds another session to the pool that is already the problem.
    const closed = await closeSandbox();
    if (closed.released !== true) {
      throw new Error(
        `sandbox_session_pool_held:${closed.sessions} (run tools/sandbox/release-sandbox-sessions.ps1 elevated)`,
      );
    }

    const child = spawn(WINDOWS_SANDBOX, [`"${configurationPath}"`], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
    });
    child.unref();
    const readyPath = join(busHostFolder, BUS_PATHS.ready);
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(readyPath)) {
        return Object.freeze({ ready: true, attempts: attempt, readyFile: await readFile(readyPath, "utf8") });
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    }
    lastError = new Error(`guest_worker_not_ready_after_${readyTimeoutMs}ms_attempt_${attempt}`);
  }
  throw lastError ?? new Error("guest_worker_not_ready");
}

/** One task, executed inside the guest. */
export async function runInSandbox(
  busHostFolder,
  command,
  { timeoutMs = 600_000, guestTimeoutSeconds, pollMs = 250 } = {},
) {
  const id = `task_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const taskPath = join(busHostFolder, BUS_PATHS.tasks, `${id}.json`);
  const resultPath = join(busHostFolder, BUS_PATHS.results, `${id}.json`);
  // Written to a temporary name and moved into place: the worker claims a task by renaming it, and
  // a partially written task file would be claimed and then fail to parse.
  const partial = `${taskPath}.partial`;
  await writeFile(partial, JSON.stringify({ id, command, timeoutSeconds: guestTimeoutSeconds }, null, 2), "utf8");
  await rename(partial, taskPath);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(resultPath)) {
      const raw = (await readFile(resultPath, "utf8")).replace(/^\uFEFF/u, "");
      const result = JSON.parse(raw);
      await rm(resultPath, { force: true });
      return Object.freeze({ ...result, id });
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, pollMs));
  }
  throw new Error(`sandbox_task_timed_out:${id}`);
}

/** Convenience: is the guest's own stated premise the one we need (no developer tooling)? */
export function parseReadyFile(text) {
  const facts = {};
  for (const line of text.split(/\r?\n/u)) {
    const at = line.indexOf("=");
    if (at > 0) facts[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return Object.freeze(facts);
}

export const sandboxDirectory = sandboxRoot;
export { resolve as resolvePath };
