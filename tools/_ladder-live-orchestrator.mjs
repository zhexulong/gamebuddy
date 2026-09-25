import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { launchStardewLiveRun } from "./lib/stardew-live-run.mjs";

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

const GAME_PATH = "D:\\Steam\\steamapps\\common\\Stardew Valley";
const MODS_PATH = "D:\\Steam\\steamapps\\common\\Stardew Valley\\Mods";
const PIPE_NAME = "gamebuddy-stardew";

const logPath = "E:\\projects\\ai-game-companion\\tools\\_ladder-live-runner.log";
const runnerLog = createWriteStream(logPath, { flags: "w" });

let game = null;
try {
  // 1. Launch the single SMAPI process and wait for the Mod's pipe to listen.
  game = await launchStardewLiveRun({
    gamePath: GAME_PATH,
    modsPath: MODS_PATH,
    windowMode: "visible",
    pipeName: PIPE_NAME,
    timeoutMs: 150_000,
  });
  console.error("SMAPI_LAUNCHED", JSON.stringify({ pid: game.pid }));

  // 2. Now run the ladder runner against the live bridge.
  const runner = spawn(process.execPath, ["tools/run-stardew-native-local-agent-ab-live.mjs"], {
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
