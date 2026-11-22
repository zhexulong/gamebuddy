import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { bridgePipeNameFor } from "./lib/stardew-bridge-pipe.mjs";
import { dirname, join, resolve } from "node:path";
import { launchStardewLiveRun, normalizeLiveRunWindowMode } from "./lib/stardew-live-run.mjs";
import { listStardewProcessIds } from "./lib/windows-process-tree.mjs";
import { firstToLeaveLine, openChildRoster, writeChildRecord } from "./live-run/core/child-roster.mjs";
import { judgeRunnerExit } from "./live-run/game/ladder-runner-exit.mjs";

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
if (!(GAME_PATH && MODS_PATH)) {
  // No default: this orchestrator deliberately starts a real game process, so
  // machine-specific paths must be supplied explicitly.
  console.error("GAMEBUDDY_STARDEW_GAME_DIR and GAMEBUDDY_STARDEW_MODS_DIR must be set");
  process.exit(2);
}
GAME_PATH = GAME_PATH.replaceAll("/", "\\");
MODS_PATH = MODS_PATH.replaceAll("/", "\\");
// The pipe name comes from the config the MOD reads - single authority, see tools/lib/stardew-bridge-pipe.mjs.

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
// THIS lane's SMAPI log, next to its runner log. SMAPI's own file is named by player index inside the game, so a
// second concurrent lane writes `SMAPI-latest.player-2.txt` and neither name is attributable to a lane. Piping the
// console into a path this lane owns is the only log a lane can read as its own; the runner is told the same path so
// its heartbeat/stall sampling and its archived `mod-log.txt` describe THIS run.
const laneLogPath = process.env.GAMEBUDDY_LADDER_SMAPI_LOG ?? join(dirname(logPath), "_ladder-smapi-console.log");

let game = null;
// EVERY CHILD THIS PROCESS STARTS GETS A ROW, with the exit its own handle reports (`live-run/core/child-roster.mjs`).
// Measured `round90`: this record named only the game - the one process it could name - so the Host's exit (the pipe's
// client, which left first) was nowhere, and `bridge_disconnected` could not be attributed to anything.
const childRoster = openChildRoster();
try {
  // 1. Launch the single SMAPI process and wait for the Mod's pipe to listen.
  const gameStartedAtMs = Date.now();
  game = await launchStardewLiveRun({
    gamePath: GAME_PATH,
    modsPath: MODS_PATH,
    windowMode: WINDOW_MODE,
    pipeName: bridgePipeNameFor(MODS_PATH),
    timeoutMs: 150_000,
    logPath: laneLogPath,
  });
  childRoster.started({ role: "game", pid: game.pid, startedAtMs: gameStartedAtMs });
  console.error(
    "SMAPI_LAUNCHED",
    JSON.stringify({ pid: game.pid, windowMode: game.windowMode, laneLog: game.laneLogPath }),
  );
  // Log the moment the game process ends, as it happens, with the pair that separates the two possibilities.
  //
  // A **code** means the process ended itself; a **signal** means something else terminated it; both null means the exit
  // was never reported to the runtime. Three runs ended with no channel able to say which, so this is the one that can -
  // and it is logged EAGERLY rather than after the runner completes, because the interesting case is precisely the one
  // where the process disappears while the harness is still waiting.
  void game.exitObserved.then((exit) => {
    console.error("SMAPI_EXIT", JSON.stringify(exit));
    childRoster.ended({ pid: game.pid, code: exit.code, signal: exit.signal, atMs: exit.atMs });
  });

  // 2. Now run the ladder runner against the live bridge.
  const hostStartedAtMs = Date.now();
  const runner = spawn(process.execPath, ["tools/live-run/game/run-stardew-native-local-agent-ab-live.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, GAMEBUDDY_STARDEW_LANE_LOG_PATH: laneLogPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (Number.isInteger(runner.pid)) childRoster.started({ role: "host", pid: runner.pid, startedAtMs: hostStartedAtMs });
  let runnerStdout = "";
  runner.stdout.setEncoding("utf8");
  runner.stderr.setEncoding("utf8");
  runner.stdout.on("data", (c) => {
    runnerStdout += c;
    runnerLog.write(c);
  });
  runner.stderr.on("data", (c) => runnerLog.write(c));

  const runnerExit = await new Promise((resolvePromise) =>
    runner.once("close", (code, signal) => {
      // The Host's own exit, from the handle that owned it. Round90 is the case this exists for: the Host left first and
      // nothing recorded it, so the run's ending read as the game's kill.
      if (Number.isInteger(runner.pid)) {
        childRoster.ended({ pid: runner.pid, code, signal, atMs: Date.now() });
      }
      resolvePromise(code);
    }),
  );
  console.error("RUNNER_EXIT", runnerExit);
  // Also reported at the end, because the eager line above only fires while this process is still alive to print it.
  console.error("SMAPI_EXIT_AT_END", JSON.stringify(game?.exit ?? null));
  const verdict = judgeRunnerExit({ exitCode: runnerExit, stdout: runnerStdout });
  // THE CHILD'S EXIT CODE IS THIS PROCESS'S. It was printed above and then dropped, so the orchestrator ended 0 whatever
  // the runner had said and every failure read as a pass. And a run that printed no verdict is never 0 either: 0 is the
  // answer that hides it.
  process.exitCode = verdict.exitCode;
  if (verdict.reading !== null) console.error(verdict.reading, JSON.stringify({ runnerExitCode: runnerExit }));
  console.log(verdict.verdictLine ?? runnerStdout.slice(-2000));
  console.error("RUNNER_LOG", logPath);
  console.error("SMAPI_LOG", laneLogPath);
} finally {
  const reclamation = await game?.close?.();
  // ZERO SURVIVORS IS THE ASSERTION, not an assumption. A launch that reclaimed its owner still leaves the
  // question open for the game image that owner spawned, and this is what proves the tree was actually reached.
  // A survivor is REPORTED, never killed by image name: a game process this harness did not launch is not its to
  // terminate. The next run would otherwise meet it as a busy fixture root with an orphaned transaction, which
  // reads as an unrelated failure.
  const survivors = listStardewProcessIds();
  console.error("PROCESS_RECLAMATION", JSON.stringify({ outcome: reclamation?.outcome ?? "no_launch", survivors }));
  // …and the same facts as a RECORD, because this process holds the handles of the children it started and is the only
  // one that knows their pids and how each of them ended. The launcher merges its own child into this file and completes
  // the run's reclamation account from it. Until the file carried more than one row, "which process was reaped, and with
  // what exit" was knowable for the game alone (measured 2026-11-09, `round40`: `reclamation.steps: []`; 2026-11-22,
  // `round90`: the Host's exit was in no artifact at all).
  const recordPath = process.env.GAMEBUDDY_PROCESS_RECLAMATION_FILE;
  if (typeof recordPath === "string" && recordPath.length > 0) {
    try {
      const recorded = writeChildRecord({
        path: recordPath,
        children: childRoster.record().children,
        // A launch that never returned a pid is named rather than published as "this run started nothing": the launch
        // kills the process it spawned before it throws, and an empty roster would hide that.
        state: game === null ? "partial:game_launch_unobserved" : "measured",
        fields: {
          windowMode: WINDOW_MODE,
          closeOutcome: reclamation?.outcome ?? "no_launch",
          survivors,
          atMs: Date.now(),
        },
      });
      console.error("FIRST_TO_LEAVE", firstToLeaveLine(recorded.firstToLeave));
    } catch (error) {
      console.error("PROCESS_RECLAMATION_NOT_RECORDED", String(error?.message ?? error).slice(0, 200));
    }
  }
}
