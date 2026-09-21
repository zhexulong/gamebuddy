/**
 * Harness-level unified Stardew live-run launcher.
 *
 * Single authority note: the 5-state window-mode vocabulary and its env
 * envelope are frozen in `host/src/live-run/window-mode.ts` (T1 contract);
 * this module carries a read-only mirror of that contract because it runs in
 * the `tools/` harness layer, which must not import Host source. The mirror is
 * guarded by tests in this directory; the Host module stays the authority.
 *
 * This is a HARNESS tool only. It is never imported by `host/src` and it
 * spawns SMAPI directly for gate/native-local fixtures. The product-owned
 * lifecycle (guardian/coordinator) is unaffected; this tool exists for
 * disposable, harness-owned game transactions only.
 *
 * The Mod itself applies the window shape from the `GAMEBUDDY_WINDOW_MODE`
 * environment variable inside the game thread (WindowModeManagement), so
 * spawn does not need STARTUPINFO window-style control: set the env, then the
 * Mod hides/shows the window exactly per the frozen contract.
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";

// ── Window-mode mirror (authority: host/src/live-run/window-mode.ts) ──────
const WINDOW_MODES = Object.freeze(["visible", "foreground", "minimized", "hidden", "background"]);

export function isLiveRunWindowMode(value) {
  return typeof value === "string" && WINDOW_MODES.includes(value);
}

/** Fails closed on invalid/missing mode so fixtures cannot inject an unknown shape. */
export function normalizeLiveRunWindowMode(value) {
  if (value !== undefined && isLiveRunWindowMode(value)) return value;
  throw new TypeError(`invalid_live_run_window_mode:${value === undefined ? "undefined" : JSON.stringify(value)}`);
}

/** PS1/CLI mapping: hidden|background → Hidden, minimized → Minimized, else Normal. */
export function windowModeToStyle(mode) {
  const value = normalizeLiveRunWindowMode(mode);
  if (value === "hidden" || value === "background") return "Hidden";
  if (value === "minimized") return "Minimized";
  return "Normal";
}

/** visible/foreground/minimized capture window evidence; hidden/background do not. */
export function shouldCaptureWindowEvidence(mode) {
  const value = normalizeLiveRunWindowMode(mode);
  return value === "visible" || value === "foreground" || value === "minimized";
}

export function windowModeEnvironment(mode) {
  return Object.freeze({ GAMEBUDDY_WINDOW_MODE: normalizeLiveRunWindowMode(mode) });
}

// ── Named-pipe readiness (observational, mirrors lib/stardew-named-pipe-readiness.ps1) ──
function isPipeListening(pipeName) {
  try {
    const names = readdirSync("\\\\.\\pipe\\");
    return names.includes(pipeName);
  } catch {
    return false;
  }
}

async function waitForPipe(pipeName, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (isPipeListening(pipeName)) return;
    if (Date.now() >= deadline) throw new Error(`stardew_pipe_not_listening:${pipeName}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

// ── Launch ────────────────────────────────────────────────────────────────
export async function launchStardewLiveRun({
  gamePath,
  modsPath,
  windowMode,
  pipeName,
  timeoutMs = 120_000,
  detached = false,
}) {
  if (typeof gamePath !== "string" || !isAbsolute(gamePath)) throw new Error("invalid_live_run_game_path");
  if (typeof modsPath !== "string" || !isAbsolute(modsPath)) throw new Error("invalid_live_run_mods_path");
  if (typeof pipeName !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(pipeName)) throw new Error("invalid_live_run_pipe_name");
  const mode = normalizeLiveRunWindowMode(windowMode);
  const smapi = join(gamePath, "StardewModdingAPI.exe");

  const child = spawn(smapi, ["--mods-path", modsPath], {
    cwd: gamePath,
    env: { ...process.env, ...windowModeEnvironment(mode) },
    stdio: ["ignore", "pipe", "pipe"],
    detached,
    windowsHide: mode === "hidden" || mode === "background",
  });

  const pid = child.pid ?? 0;
  let stderrTail = "";
  child.stderr.on("data", (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4096);
  });
  let rejectSpawnError;
  const spawnError = new Promise((_resolve, reject) => {
    rejectSpawnError = reject;
  });
  child.on("error", (error) => {
    rejectSpawnError(new Error(`smapi_spawn_failed:${error.message}; stderr=${stderrTail}`));
  });

  try {
    await Promise.race([waitForPipe(pipeName, timeoutMs), spawnError]);
  } catch (error) {
    child.kill();
    throw error;
  }

  return Object.freeze({
    pid,
    pipeName,
    windowMode: mode,
    close: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      return Promise.resolve();
    },
    get _child() {
      return child;
    },
  });
}

// ── CLI (PowerShell fixture driver) ───────────────────────────────────────
function parseCli(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    switch (argument) {
      case "--print-map": options.printMap = true; break;
      case "--game-path": options.gamePath = value; index += 1; break;
      case "--mods-path": options.modsPath = value; index += 1; break;
      case "--window-mode": options.windowMode = value; index += 1; break;
      case "--pipe-name": options.pipeName = value; index += 1; break;
      case "--timeout-ms": options.timeoutMs = Number(value); index += 1; break;
      case "--detached": options.detached = true; break;
      default:
        if (argument === undefined) break;
        throw new Error(`unknown_argument:${argument}`);
    }
  }
  return options;
}

async function cliMain(argv) {
  let options;
  try {
    options = parseCli(argv);
    if (options.printMap !== true && options.windowMode === undefined) {
      throw new TypeError("missing_window_mode");
    }
    if (options.windowMode !== undefined) {
      options.windowMode = normalizeLiveRunWindowMode(options.windowMode);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
    return;
  }
  if (options.printMap === true) {
    const map = Object.fromEntries(WINDOW_MODES.map((mode) => [mode, {
      style: windowModeToStyle(mode),
      captureEvidence: shouldCaptureWindowEvidence(mode),
    }]));
    process.stdout.write(`${JSON.stringify({ windowModes: map })}\n`);
    return;
  }
  try {
    const handle = await launchStardewLiveRun({ ...options, detached: options.detached === true });
    process.stdout.write(`${JSON.stringify({ pid: handle.pid, pipeName: handle.pipeName, windowMode: handle.windowMode, evidenceCaptured: shouldCaptureWindowEvidence(handle.windowMode) })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

const isCli = process.argv[1] !== undefined && process.argv[1].replaceAll("\\", "/").endsWith("tools/lib/stardew-live-run.mjs");
if (isCli) await cliMain(process.argv.slice(2));