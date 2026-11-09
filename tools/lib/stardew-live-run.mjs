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
import { assertLiveRunArtifactFresh } from "./live-run-artifact-freshness.mjs";
import { killProcessTree } from "./windows-process-tree.mjs";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

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

/**
 * The Mod's own arm-time refusal, read out of the SMAPI log this launch is writing.
 *
 * WHY THIS EXISTS. Measured 2026-11-09: a fixture Given dropped a building that severed the farm's door→field route, so
 * the Mod refused the world with `fixture setup failed: ... fixture_native_local_multi_day_home_unreachable` at second
 * 17 - and the launcher went on waiting for a bridge that could never open, reporting `stardew_pipe_not_listening` two
 * minutes later. The Mod had already said, by name, why the world was impossible; nobody was reading it. A refusal that
 * is only discoverable by timeout is a refusal the operator has to guess at.
 *
 * Pure so a test can drive it with the exact text, and matched on the marker alone: the rest of the line is the Mod's
 * reason and belongs in the message verbatim.
 */
export function fixtureSetupFailureIn(text) {
  for (const line of String(text).split("\n")) {
    const at = line.indexOf("fixture setup failed:");
    if (at >= 0) return line.slice(at).trim();
  }
  return null;
}

async function waitForPipe(pipeName, timeoutMs, readModLog = () => "") {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (isPipeListening(pipeName)) return;
    const refused = fixtureSetupFailureIn(readModLog());
    if (refused !== null) throw new Error(`stardew_fixture_setup_failed:${refused}`);
    if (Date.now() >= deadline) throw new Error(`stardew_pipe_not_listening:${pipeName}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

// ── Launch ────────────────────────────────────────────────────────────────
/**
 * A lane's own console log, opened for the launch.
 *
 * A live run must survive a log it cannot write - the run is the evidence, the log is the diagnostic - so a write
 * error is reported on stderr and the run continues. The directory is created because the lane log lives below the
 * lane's own root, one level deeper than anything the fixture transaction creates. Exported together with
 * `pipeConsoleInto` because the launch itself needs `StardewModdingAPI.exe` and a listening pipe, while "the bytes the
 * drain keeps land in the lane's own file" is a property a test can drive with any child process.
 */
export function openLaneLog(logPath) {
  mkdirSync(dirname(logPath), { recursive: true });
  const stream = createWriteStream(logPath, { flags: "w" });
  stream.on("error", (error) => {
    process.stderr.write(`[live-run] lane log unavailable: ${String(error?.message ?? error)}\n`);
  });
  return stream;
}

/**
 * Keep the console stream the drain must read, in this lane's own file.
 *
 * Called while the child is alive: `stderr` is written through on arrival, `stdout` is piped. Neither stream may be
 * left unread - see the drain comment in `launchStardewLiveRun` for the freeze that costs.
 */
export function pipeConsoleInto(laneLog, { stdout, stderr }) {
  stdout?.pipe(laneLog);
  stderr?.on("data", (chunk) => laneLog.write(chunk));
}

export async function launchStardewLiveRun({
  gamePath,
  modsPath,
  windowMode,
  pipeName,
  timeoutMs = 120_000,
  detached = false,
  logPath,
}) {
  if (typeof gamePath !== "string" || !isAbsolute(gamePath)) throw new Error("invalid_live_run_game_path");
  if (typeof modsPath !== "string" || !isAbsolute(modsPath)) throw new Error("invalid_live_run_mods_path");
  if (typeof pipeName !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(pipeName))
    throw new Error("invalid_live_run_pipe_name");
  // A lane's log path is caller-supplied because only the caller knows its lane: SMAPI names its own file by PLAYER
  // INDEX (`SMAPI-latest.txt`, then `SMAPI-latest.player-2.txt`), so under two lanes the unsuffixed file belongs to
  // whichever instance SMAPI numbered first. See `stardew-lane-scope.mjs` for the measurement.
  if (logPath !== undefined && (typeof logPath !== "string" || !logPath.length || !isAbsolute(logPath)))
    throw new Error("invalid_live_run_log_path");
  // The window mode is validated with the REST of the caller's inputs, before any environment check: a malformed
  // argument is a caller bug regardless of the tree's state, and checking the build first made this refusable only
  // as `live_run_artifact_stale` whenever another lane had touched host/src (found by this module's own test on a
  // genuinely stale tree).
  const mode = normalizeLiveRunWindowMode(windowMode);
  // Refuse BEFORE a game process exists. The runner checks this too, but a caller that reaches the runner has
  // already paid for a save load -- measured: a stale artifact refused the run and left the launched game behind.
  await assertLiveRunArtifactFresh();
  // Exactly one GameBuddy, or the game quietly loads none. SMAPI refuses a mod it finds twice ("multiple copies of this
  // mod installed") and then starts WITHOUT it, which surfaces as a 120 s pipe timeout rather than as the configuration
  // error it is. Measured 2026-10-19: four consecutive runs died that way after the default mods path (the game own Mods
  // directory) grew a second, older GameBuddy folder. The caller names the directory; this checks what is in it, before a
  // game process exists to pay for it.
  const gameBuddyFolders = readdirSync(modsPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^GameBuddy[.]/u.test(`${entry.name}.`))
    .map((entry) => entry.name);
  if (gameBuddyFolders.length !== 1)
    throw new Error(`live_run_mods_path_needs_exactly_one_gamebuddy:${gameBuddyFolders.join("+") || "none"}`);
  const smapi = join(gamePath, "StardewModdingAPI.exe");
  // Opened BEFORE the spawn, so an unusable lane-log path is a refusal with a name instead of a crashed run.
  const laneLog = logPath === undefined ? null : openLaneLog(logPath);

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
  // DRAIN stdout, into the lane's own log when one was named. This is the freeze's root cause (2026-10-19). SMAPI
  // writes its log to disk, but it ALSO writes to the console, and a pipe nobody reads fills: once the OS buffer is
  // full (~64 KiB) the write blocks IN THE KERNEL on the game thread, which is exactly what the freeze looks like - a
  // thread in WaitReason.Executive for the whole stall (46 of 48 unresponsive samples in one run), the engine render
  // counter stopped, no Mod log line ever written, and the Mod's own watchdog silent because the game thread never
  // returned. Reproduced directly: a child writing to an unread pipe never exits, while the same child with
  // `stdout.resume()` exits immediately. Piping into the lane log is the same drain with the bytes kept: it is the
  // one log that belongs to THIS lane, because SMAPI's own file name is decided by player index inside the game.
  // stderr has two readers on purpose: the tail is what an error message quotes, the lane log is what an audit reads
  // afterwards, and neither is derivable from the other.
  if (laneLog === null) child.stdout?.resume();
  else pipeConsoleInto(laneLog, { stdout: child.stdout, stderr: child.stderr });
  child.once("close", () => laneLog?.end());
  let rejectSpawnError;
  const spawnError = new Promise((_resolve, reject) => {
    rejectSpawnError = reject;
  });
  child.on("error", (error) => {
    rejectSpawnError(new Error(`smapi_spawn_failed:${error.message}; stderr=${stderrTail}`));
  });

  try {
    // The Mod's own arm-time refusal ends the wait immediately instead of costing the full pipe timeout: measured
    // 2026-11-09, a fixture that severed the farm's route was reported by the Mod at second 17 and by this launcher
    // two minutes later as `stardew_pipe_not_listening`, which names the wrong component.
    const modLog = join(process.env.APPDATA ?? "", "StardewValley", "ErrorLogs", "SMAPI-latest.txt");
    const modLogStart = existsSync(modLog) ? readFileSync(modLog, "utf8").length : 0;
    const readNewModLog = () => {
      try {
        return existsSync(modLog) ? readFileSync(modLog, "utf8").slice(modLogStart) : "";
      } catch {
        return "";
      }
    };
    await Promise.race([waitForPipe(pipeName, timeoutMs, readNewModLog), spawnError]);
  } catch (error) {
    killProcessTree(pid);
    // The lane log is closed here too: a launch that refused still leaves a file an operator will open to see WHY,
    // and an unfinished stream is a file whose last lines may never have been flushed.
    laneLog?.end();
    throw error;
  }

  const launchedPid = pid;
  // HOW the process ended, captured from the handle that owns it.
  //
  // Three runs (`round21`, `round27`, and every night of `round26`) ended with the process gone and no channel able to
  // say why: SMAPI writes no shutdown, no `SMAPI-crash.txt` appears, Windows records no Application or System event in
  // the whole window (verified against a log that holds 40 events in 24 h, so the empty window is real), the Mod has no
  // `Exit` path, and no Stardew live-run path calls `kill`. The instrumented heartbeat then ruled out memory as well -
  // `managedMB` and `wsMB` are FLAT over the second half of the run.
  //
  // The one channel that was never opened is the child handle itself. Node reports `(code, signal)` on `exit`, and that
  // pair separates the possibilities that everything else collapsed: a **code** means the process ended itself, a
  // **signal** means something else terminated it, and both being null means the handle went away without the runtime
  // being told. No log can distinguish those; this can.
  //
  // Recorded rather than acted on: nothing here changes what the launcher does, and `close()` still reclaims the tree.
  const exitRecord = { code: null, signal: null, atMs: null, uptimeMs: null };
  const exitObserved = new Promise((resolveExit) => {
    child.once("exit", (code, signal) => {
      exitRecord.code = code;
      exitRecord.signal = signal;
      exitRecord.atMs = Date.now();
      exitRecord.uptimeMs = typeof child.connected === "boolean" ? Date.now() - exitRecord.atMs : null;
      resolveExit(Object.freeze({ ...exitRecord }));
    });
  });
  return Object.freeze({
    pid,
    pipeName,
    windowMode: mode,
    /**
     * Where THIS lane's SMAPI console stream is being written, or null when the caller named none.
     *
     * A reader that needs the Mod's own lines takes this path. The machine-global
     * `%APPDATA%/StardewValley/ErrorLogs/SMAPI-latest*.txt` is numbered by player index, so under two lanes it holds
     * whichever instance SMAPI numbered first - not this one.
     */
    laneLogPath: logPath ?? null,
    /**
     * HOW the game process ended: `{ code, signal, atMs }`, or nulls while it is still running.
     *
     * Read it after a run to tell “the game exited” from “the game was terminated”: a code is the first, a signal is the
     * second, and both null means the exit was never reported to the runtime.
     */
    get exit() {
      return Object.freeze({ ...exitRecord });
    },
    /** Resolves when the child reports its exit; never resolves while the process lives. */
    exitObserved,
    /**
     * Reclaim the launch AND its tree.
     *
     * `child.kill()` does not kill a tree on Windows, and the game is a separate image the SMAPI child spawns;
     * killing the child left `Stardew Valley.exe` running, so the next run found a busy fixture root and an
     * orphaned transaction (measured repeatedly 2026-10-16/17). The kill is by exact PID via `taskkill /T /F`,
     * and the result says which of the two happened instead of assuming either.
     */
    close: () => {
      // Always kill the TREE, even when the SMAPI child already exited: its own children may outlive it, which is
      // exactly the orphan this replaced `child.kill()` for. The outcome distinguishes the two normal cases.
      return Promise.resolve(Object.freeze({ outcome: killProcessTree(launchedPid) }));
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
      case "--print-map":
        options.printMap = true;
        break;
      case "--game-path":
        options.gamePath = value;
        index += 1;
        break;
      case "--mods-path":
        options.modsPath = value;
        index += 1;
        break;
      case "--window-mode":
        options.windowMode = value;
        index += 1;
        break;
      case "--pipe-name":
        options.pipeName = value;
        index += 1;
        break;
      case "--timeout-ms":
        options.timeoutMs = Number(value);
        index += 1;
        break;
      case "--detached":
        options.detached = true;
        break;
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
    const map = Object.fromEntries(
      WINDOW_MODES.map((mode) => [
        mode,
        {
          style: windowModeToStyle(mode),
          captureEvidence: shouldCaptureWindowEvidence(mode),
        },
      ]),
    );
    process.stdout.write(`${JSON.stringify({ windowModes: map })}\n`);
    return;
  }
  try {
    const handle = await launchStardewLiveRun({ ...options, detached: options.detached === true });
    process.stdout.write(
      `${JSON.stringify({ pid: handle.pid, pipeName: handle.pipeName, windowMode: handle.windowMode, evidenceCaptured: shouldCaptureWindowEvidence(handle.windowMode) })}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

const isCli = process.argv[1]?.replaceAll("\\", "/").endsWith("tools/lib/stardew-live-run.mjs") ?? false;
if (isCli) await cliMain(process.argv.slice(2));
