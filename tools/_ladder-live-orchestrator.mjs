import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { resolve } from "node:path";
import { launchStardewLiveRun, normalizeLiveRunWindowMode } from "./lib/stardew-live-run.mjs";

// One-shot orchestrator for the ladder live run.
//
// Order matters: the runner connects to the Mod's named pipe at startup, so the
// game must be launched and its pipe must be listening BEFORE the runner starts.
// (Starting the runner first makes connect() race a pipe that does not exist.)
//
// This script has no options and must be invoked deliberately: it launches a
// real game process and performs a real mutation. Any argument (including a
// stray --help) is refused rather than silently starting a run.
if (process.argv.length > 2) {
  console.error("usage: node tools/_ladder-live-orchestrator.mjs   (no arguments; this starts a real live run)");
  process.exit(2);
}

let GAME_PATH = process.env.GAMEBUDDY_STARDEW_GAME_DIR;
let MODS_PATH = process.env.GAMEBUDDY_STARDEW_MODS_DIR;
if (!GAME_PATH || !MODS_PATH) {
  // No default: this orchestrator deliberately starts a real game process, so
  // machine-specific paths must be supplied explicitly.
  console.error("GAMEBUDDY_STARDEW_GAME_DIR and GAMEBUDDY_STARDEW_MODS_DIR must be set");
  process.exit(2);
}
GAME_PATH = GAME_PATH.replaceAll("/", "\\");
MODS_PATH = MODS_PATH.replaceAll("/", "\\");
const PIPE_NAME = "gamebuddy-stardew";

// Window mode is configuration, not a constant (the frozen 5-mode vocabulary
// lives in tools/lib/stardew-live-run.mjs; host/src/live-run/window-mode.ts is
// the authority). Default `hidden`: a live run must not take the screen or the
// focus. A human who wants to WATCH passes `foreground`, which the Mod honours
// by actually activating the window — before that it stayed behind every other
// window even when asked for `foreground`, so the mode was unobservable.
// An invalid value is refused here rather than silently coerced.
let WINDOW_MODE;
try {
  WINDOW_MODE = normalizeLiveRunWindowMode(process.env.GAMEBUDDY_LADDER_WINDOW_MODE ?? "hidden");
} catch (error) {
  console.error(String(error?.message ?? error));
  process.exit(2);
}

const logPath = process.env.GAMEBUDDY_LADDER_LIVE_LOG ?? resolve(process.cwd(), "tools", "_ladder-live-runner.log");
const runnerLog = createWriteStream(logPath, { flags: "w" });

let game = null;
try {
  // 1. Launch the single SMAPI process and wait for the Mod's pipe to listen.
  game = await launchStardewLiveRun({
    gamePath: GAME_PATH,
    modsPath: MODS_PATH,
    windowMode: WINDOW_MODE,
    pipeName: PIPE_NAME,
    timeoutMs: 150_000,
  });
  console.error("SMAPI_LAUNCHED", JSON.stringify({ pid: game.pid, windowMode: game.windowMode }));

  // 2. Now run the ladder runner against the live bridge.
  const runner = spawn(process.execPath, ["tools/live-run/game/run-stardew-native-local-agent-ab-live.mjs"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let runnerStdout = "";
  runner.stdout.setEncoding("utf8");
  runner.stderr.setEncoding("utf8");
  runner.stdout.on("data", (c) => {
    runnerStdout += c;
    runnerLog.write(c);
  });
  runner.stderr.on("data", (c) => runnerLog.write(c));

  const exitCode = await new Promise((resolvePromise) => runner.once("close", resolvePromise));
  console.error("RUNNER_EXIT", exitCode);
  const resultLine = runnerStdout
    .trim()
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .at(-1);
  console.log(resultLine ?? runnerStdout.slice(-2000));
  console.error("RUNNER_LOG", logPath);
} finally {
  await game?.close?.();
}
