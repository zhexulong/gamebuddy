#!/usr/bin/env node
// frontend live run — single entry.
//
// Drives the product's own UI at a pinned commit and reports what the player saw (geometry), what a
// turn cost (TIMINGS, from the product's marks), what the runtime held (RUNTIME) and when the first
// screen painted (PAINT). The screenshots are one observation among four.
//
//   node tools/live-run/frontend/run.mjs --commit <sha|HEAD> --out <root>          full run (check→pin→build→launch→capture→cleanup→report)
//   node tools/live-run/frontend/run.mjs --check [--commit sha] [--out root]      fast prerequisites only
//   node tools/live-run/frontend/run.mjs <phase> [same keys]                      resumable stepwise run
//
// Phases (in run order): check pin build launch capture cleanup report
//   pin     create a detached worktree at the pinned commit + materialize prerequisites
//   build   typecheck + Mod + reclaimer + Host generation (the ONLY production-shaped build)
//   launch  drive the product's own entry, wait for mount, then HOLD (background)
//   capture run the capture drivers against the mounted product (resumable per driver)
//   cleanup stop the product, orphan sweep, ports closed, no tracked file changed, keep run root
//   report  assemble README.txt + REPORT.txt into the out root
//
// Key flags: --commit (required for a full run), --out (deliverable set root), --stage (default
// <out>.stage), --runtime (dir that DIRECTLY contains node.exe; else discovered), --game-dir,
// --edge, --cdp-port, --wait-for-cdp=<seconds> (default 0: a held port is refused by name at once),
// --force (re-run finished capture drivers), --driver=a,b (capture subset).
//
// Whatever way this process leaves - a phase that failed, a full run that finished, or an abnormal
// exit - the run closes through one owner (`lib/run-owner.mjs`): every process the run started is
// terminated, its CDP lock is released, and what remained is printed as `LEFTOVERS:`. The one
// exception is a STEPWISE run that succeeded: a mounted session is the next phase's input, so it is
// kept and named; `cleanup` is the operator's stop.
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { cleanOutputLines } from "../../lib/subprocess-output.mjs";
import {
  defaultStageFor,
  KIT_ROOT,
  loadRunConfig,
  REPO_ROOT,
  runPaths,
  sanitizeTag,
  saveRunConfig,
} from "./lib/config.mjs";
import { describePhaseFailure } from "./lib/phase-failure.mjs";
import { describeWorldInvocations, worldInvocations } from "./lib/world-invocations.mjs";
import {
  closeProcessLedger,
  collectProcessLedger,
  deliberatelyKept,
  describeProcessLedger,
  openProcessLedger,
  writeProcessLedger,
} from "./lib/process-ledger.mjs";
import { describeGameCleanup, recordedGameProcesses, recordRunGame, survivingGameIdentities } from "./lib/run-game.mjs";
import {
  closeRunInvocation,
  describeReaper,
  openRunInvocation,
  reapRunOrphans,
  writeReaperReading,
} from "./lib/run-reaper.mjs";
import {
  describeLeftovers,
  describeTeardown,
  inspectRunLeftovers,
  registeredRunProcesses,
  registerRunProcess,
  retireRunProcesses,
  teardownRun,
  writeLeftoversReading,
} from "./lib/run-owner.mjs";
import { DRIVERS } from "./phases/drivers.mjs";

const PHASES = ["check", "pin", "build", "launch", "capture", "cleanup", "report"];
const POWER = "powershell.exe";
const PS_POLICY = ["-NoProfile", "-ExecutionPolicy", "Bypass"];

function parseArgs(argv) {
  const values = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") values.check = true;
    else if (arg === "--force") values.force = true;
    else if (arg.startsWith("--driver=")) {
      values.drivers = (values.drivers ?? []).concat(
        arg
          .slice("--driver=".length)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
    } else if (arg.startsWith("--") && arg.includes("=")) {
      const [key, ...rest] = arg.slice(2).split("=");
      values[key] = rest.join("=");
    } else if (arg.startsWith("--")) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        values[arg.slice(2)] = next;
        i += 1;
      } else {
        values[arg.slice(2)] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { values, positional };
}

function git(args) {
  const result = spawnSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.status !== 0)
    throw new Error(`git ${args[0]} failed: ${(result.stderr ?? result.stdout ?? "").slice(0, 400)}`);
  return result.stdout.trim();
}

function resolveCommit(commit) {
  if (typeof commit !== "string" || commit.length === 0)
    throw new Error("--commit is required (sha or HEAD) for a full run");
  return git(["rev-parse", commit]);
}

function discoverRuntime(explicit) {
  const args = [join(KIT_ROOT, "probes", "runtime-discover.mjs")];
  if (typeof explicit === "string" && explicit.length > 0) args.push(`--runtime=${explicit}`);
  const result = spawnSync(process.execPath, args, { cwd: REPO_ROOT, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return null;
  try {
    return JSON.parse(cleanOutputLines(result.stdout.trim()).pop())?.found ?? null;
  } catch {
    return null;
  }
}

function prepareRun(paths, values) {
  const outRoot = values.out;
  if (typeof outRoot !== "string" || outRoot.length === 0) throw new Error("--out <root> is required");
  const stageRoot = values.stage ?? defaultStageFor(outRoot);
  const prior = loadRunConfig(paths);
  const commit =
    values.commit !== undefined && String(values.commit).length > 0
      ? resolveCommit(values.commit)
      : (prior?.commit ?? null);
  if (commit === null) throw new Error("--commit is required (sha or HEAD) for a new run");
  const explicitRuntime = values.runtime ?? process.env.GB_SHOTS_RUNTIME ?? prior?.runtimeFixture ?? "";
  const runtimeFixture = explicitRuntime.length > 0 ? explicitRuntime : (discoverRuntime("") ?? "");
  if (runtimeFixture.length === 0)
    throw new Error(
      "no runtime fixture: pass --runtime <dir-with-node.exe> or set GB_SHOTS_RUNTIME / GB_SHOTS_RUNTIME_SEARCH",
    );
  const run = {
    tag: sanitizeTag(basename(outRoot)) || sanitizeTag(commit.slice(0, 12)),
    commit,
    shortCommit: commit.slice(0, 12),
    outRoot,
    stageRoot,
    runtimeFixture,
    gameDir: values["game-dir"] ?? process.env.GB_SHOTS_GAME_DIR ?? "D:\\Steam\\steamapps\\common\\Stardew Valley",
    edgeExe:
      values.edge ?? process.env.GB_SHOTS_EDGE ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    cdpPort: Number(values["cdp-port"] ?? process.env.GB_SHOTS_CDP_PORT ?? prior?.cdpPort ?? 9341),
    // 0 is the default: a held port is refused by name at once. A caller that knows a sibling run is
    // finishing may ask to wait, and the wait prints the holder and the whole budget.
    cdpWaitMs: Math.max(0, Number(values["wait-for-cdp"] ?? process.env.GB_SHOTS_CDP_WAIT_MS ?? 0) * 1000),
    homeLocalAppData: process.env.LOCALAPPDATA ?? "C:\\Users\\long\\AppData\\Local",
    credentialPresent: typeof process.env.CPA_OAI_API_KEY === "string" && process.env.CPA_OAI_API_KEY.length > 0,
    // The world this run enters. `own` (the default) creates one, so a launch always measures a world with a
    // seat; `existing` enters the world the product already has, which is the ordinary second session of a
    // player's farm and the only way a run can measure a world an EARLIER run created.
    world: values.world === "existing" ? "existing" : "own",
  };
  saveRunConfig(paths, run);
  mkdirSync(paths.logsDir, { recursive: true });
  return run;
}

async function runPhaseForever(childCommand, { logPath }) {
  const stream = createWriteStream(logPath, { flags: "a" });
  const [cmd, ...args] = childCommand;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: REPO_ROOT, windowsHide: true, stdio: "ignore", detached: true });
    child.unref();
    child.on("error", (error) => {
      stream.write(`spawn error: ${String(error)}\n`);
      stream.end();
      reject(new Error(String(error)));
    });
    resolve(child.pid);
  });
}

async function runPhase(childCommand, { logPath }) {
  mkdirSync(dirname(logPath), { recursive: true });
  const stream = createWriteStream(logPath, { flags: "a" });
  const [cmd, ...args] = childCommand;
  return await new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: REPO_ROOT, windowsHide: false, shell: false });
    const write = (chunk) => {
      const text = chunk.toString("utf8");
      if (process.env.GB_SHOTS_QUIET !== "1") process.stdout.write(text);
      stream.write(text);
    };
    child.stdout?.on("data", write);
    child.stderr?.on("data", write);
    child.on("error", (error) => {
      stream.write(`spawn error: ${String(error)}\n`);
      stream.end();
      resolve({ code: 127, error: String(error) });
    });
    child.on("close", (code) => {
      stream.end();
      resolve({ code: code ?? 1 });
    });
  });
}

async function phaseCheck(paths, run) {
  const probe = join(KIT_ROOT, "probes", "prerequisite-check.mjs");
  const args = [probe];
  if (run.commit) args.push(`--commit=${run.commit}`);
  if (run.outRoot) args.push(`--out=${run.outRoot}`);
  if (run.runtimeFixture) args.push(`--runtime=${run.runtimeFixture}`);
  const result = spawnSync(process.execPath, args, { cwd: REPO_ROOT, encoding: "utf8", windowsHide: true });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr ?? "");
  let requiredMissing = 1;
  try {
    requiredMissing = JSON.parse(cleanOutputLines(result.stdout.trim()).pop())?.requiredMissing ?? 1;
  } catch {
    requiredMissing = 1;
  }
  if (result.status === 0 && requiredMissing === 0) console.log("CHECK: all required prerequisites present");
  else console.log("CHECK: named missing required prerequisites (above); fix before the build");
  return result.status === 0 && requiredMissing === 0 ? 0 : 1;
}

async function phasePin(paths, run) {
  const script = join(KIT_ROOT, "phases", "pin.ps1");
  return await runPhase(
    [
      POWER,
      ...PS_POLICY,
      "-File",
      script,
      "-Repo",
      REPO_ROOT,
      "-Worktree",
      paths.worktree,
      "-StageRoot",
      paths.stageRoot,
      "-Commit",
      run.commit,
      "-Log",
      paths.pinLog,
    ],
    { logPath: paths.runLog },
  );
}

async function phaseBuild(paths, run) {
  const script = join(KIT_ROOT, "phases", "build.ps1");
  return await runPhase(
    [
      POWER,
      ...PS_POLICY,
      "-File",
      script,
      "-Worktree",
      paths.worktree,
      "-OutRoot",
      paths.artifact,
      "-RuntimeDir",
      run.runtimeFixture,
      "-GameDir",
      run.gameDir,
      "-Log",
      paths.buildLog,
    ],
    { logPath: paths.runLog },
  );
}

async function phaseLaunch(paths, run) {
  // Reuse an already-mounted launch when both the CDP endpoint and the product port answer.
  try {
    const state = JSON.parse(readFileSync(paths.launchStateFile, "utf8"));
    if (state.kind === "mounted" && state.mounted === true) {
      const cdpUp = await probesUp(`http://127.0.0.1:${state.cdpPort}/json/version`);
      const productUp = await probesUp(`http://127.0.0.1:${state.port}/`);
      if (cdpUp && productUp) {
        console.log(`LAUNCH: reuse already-mounted run (pid ${state.childPid}, port ${state.port})`);
        return { code: 0 };
      }
    }
  } catch {
    /* fresh launch needed */
  }
  const launchScript = join(KIT_ROOT, "phases", "launch.mjs");
  const driverPid = await runPhaseForever([process.execPath, launchScript, paths.runConfigFile], {
    logPath: paths.launchLog,
  });
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(join(paths.stateDir, "launch-driver.pid"), String(driverPid), "utf8");
  registerRunProcess(paths, { pid: driverPid, role: "launch-driver" });
  console.log(`LAUNCH: spawn driver pid=${driverPid}; waiting for mount (log ${paths.launchLog})`);
  const deadline = Date.now() + 360_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    try {
      const state = JSON.parse(readFileSync(paths.launchStateFile, "utf8"));
      if (state.kind === "mounted" && state.mounted === true) {
        console.log(`LAUNCH: mounted (pid ${state.childPid}, port ${state.port}, stderrBytes=${state.stderrBytes})`);
        return { code: 0 };
      }
      if (state.kind === "launch_failed") {
        console.log(`LAUNCH: FAILED — tail of ${paths.launchLog}:`);
        console.log(readFileSync(paths.launchLog, "utf8").split("\n").slice(-30).join("\n"));
        return { code: 2 };
      }
    } catch {
      /* launchStateFile not written yet */
    }
  }
  console.log(`LAUNCH: mount timeout (no mounted fact within 360s); tail of ${paths.launchLog}:`);
  try {
    console.log(readFileSync(paths.launchLog, "utf8").split("\n").slice(-30).join("\n"));
  } catch {
    /* no log yet */
  }
  return { code: 2 };
}

/**
 * The Host child this run launched, as the launch state recorded it: the pid together with the start time of
 * the process that pid named when the launch was written (`<stage>/state/launch.json`). `null` before a mount.
 *
 * `pid` alone is what a ledger cannot hold: Windows hands a dead process's number to the next one, and a bare
 * number then names a stranger (measured on `D:/gb-modcheck/frontend--r12`, see `phases/launch.mjs`).
 */
function readHostIdentity(paths) {
  try {
    const state = JSON.parse(readFileSync(paths.launchStateFile, "utf8"));
    const pid = Number.isSafeInteger(state?.childPid) && state.childPid > 0 ? state.childPid : null;
    const startTime = typeof state?.childStartTime === "string" ? state.childStartTime : null;
    return { pid, startTime };
  } catch {
    return { pid: null, startTime: null };
  }
}

async function probesUp(url) {
  try {
    const response = await fetch(url);
    return response.ok || response.status === 200;
  } catch {
    return false;
  }
}

async function phaseCapture(paths, run, values) {
  const script = join(KIT_ROOT, "phases", "capture.mjs");
  const args = [script, paths.runConfigFile];
  if (values.drivers?.length > 0) for (const driver of values.drivers) args.push(`--driver=${driver}`);
  if (values.force) args.push("--force");
  return await runPhase([process.execPath, ...args], { logPath: paths.captureLog });
}

/**
 * WHICH CAPTURE INVOCATIONS A FULL ROUND RUNS, and why one mount is not enough.
 *
 * ONE MOUNTED HOST CARRIES ONE WORLD: the product draws neither the launch nor the activation control while an
 * instance exists, and a state driver's scenario ends or occupies the world it is measured on. So the drivers
 * the roster marks `ownWorld` cannot share an invocation - the second one arrives at the world the first one
 * killed and reports `not_measured: world_not_owned_by_this_driver` (measured 2026-11-22, `.tmp/livenow-r29.log`:
 * two of the three did exactly that).
 *
 * The split is DERIVED from the roster (`lib/world-invocations.mjs`), never listed here: the shared invocation
 * runs every driver that does not own a world, and each world-owning driver then gets a `cleanup` + `launch` +
 * `capture` of its own, with the launch-chain driver ahead of it on that same mount because that driver is the
 * one that brings a world to `attachment=attached`.
 *
 * `--driver=` stays the operator's selection: a world-owning driver it does not name gets no mount, and a
 * selection that names only world-owning drivers runs no shared invocation at all.
 */
function captureInvocations(values) {
  const worlds = worldInvocations(DRIVERS);
  if (worlds.problems.length > 0)
    throw new Error(
      `world_invocations_refused: ${worlds.problems.map((problem) => `${problem.code} - ${problem.detail}`).join("; ")}`,
    );
  const operator = Array.isArray(values.drivers) && values.drivers.length > 0 ? values.drivers : null;
  const owners = new Set(worlds.invocations.map((invocation) => invocation.driver));
  const shared = operator === null ? [...worlds.shared] : operator.filter((key) => !owners.has(key));
  const invocations = worlds.invocations.filter(
    (invocation) => operator === null || operator.includes(invocation.driver),
  );
  const lines = [describeWorldInvocations(worlds)];
  if (operator !== null) {
    const unknown = operator.filter((key) => !DRIVERS.some((driver) => driver.key === key));
    lines.push(
      `WORLDS: --driver= selected ${operator.join(",")}: the shared invocation runs [${shared.join(",")}] and ${String(invocations.length)} world invocation(s) run [${invocations.map((invocation) => invocation.driver).join(",")}]`,
    );
    if (unknown.length > 0) lines.push(`WORLDS: --driver= names ${unknown.join(",")}, which the roster does not hold`);
  }
  return { shared: shared.length === 0 ? null : shared, invocations, lines };
}

async function phaseCleanup(paths, run) {
  const script = join(KIT_ROOT, "phases", "cleanup.ps1");
  return await runPhase(
    [
      POWER,
      ...PS_POLICY,
      "-File",
      script,
      "-StageRoot",
      paths.stageRoot,
      "-OutRoot",
      paths.outRoot,
      "-Repo",
      REPO_ROOT,
      "-RunConfigPath",
      paths.runConfigFile,
      "-Log",
      paths.cleanupLog,
    ],
    { logPath: paths.runLog },
  );
}

async function phaseReport(paths, run) {
  const script = join(KIT_ROOT, "phases", "report.mjs");
  return await runPhase([process.execPath, script, paths.runConfigFile], { logPath: paths.reportLog });
}

async function main() {
  const { values, positional } = parseArgs(process.argv.slice(2));
  const phase = positional[0] ?? null;
  if (phase !== null && !PHASES.includes(phase)) {
    console.log(`unknown phase '${phase}'; expected one of ${PHASES.join(", ")}`);
    process.exit(64);
  }
  const fullMode = phase === null;

  if (fullMode && values.check === true) {
    // --check alone: no run config is persisted and nothing is built.
    const outRoot = values.out ?? "";
    const probeRun = {
      commit: values.commit ?? "",
      outRoot,
      runtimeFixture: values.runtime ?? process.env.GB_SHOTS_RUNTIME ?? "",
    };
    const probePaths = runPaths({
      outRoot: outRoot || ".",
      stageRoot: values.stage ?? defaultStageFor(outRoot || "."),
    });
    process.exit(await phaseCheck(probePaths, probeRun));
  }

  if (!values.out) throw new Error("--out <root> is required");
  const paths = runPaths({ outRoot: values.out, stageRoot: values.stage ?? defaultStageFor(values.out) });
  const run = prepareRun(paths, values);

  // Each phase writes its own log, and a failed one almost always named its cause there. The operator
  // reads the terminal, so that line carries the refusal instead of a phase name and a number.
  const PHASE_LOGS = {
    pin: "pinLog",
    build: "buildLog",
    launch: "launchLog",
    capture: "captureLog",
    cleanup: "cleanupLog",
    report: "reportLog",
  };
  const runner = async (name, fn) => {
    console.log(`== phase ${name} ==`);
    const result = await fn();
    const code = typeof result === "object" && result !== null ? result.code : result;
    if (code !== 0)
      throw new Error(describePhaseFailure({ phase: name, code, logPath: paths[PHASE_LOGS[name]] ?? paths.runLog }));
    return result;
  };

  // One owner for the whole run, opened once and closed once, whichever way this process leaves.
  // `kill` terminates every process this run started, releases its CDP lock and asserts what remained;
  // `keep` is the stepwise `launch`/`capture` contract - a mounted session is the next phase's input, so
  // it survives and says so. Only a FAILED phase, a full run's end, or `cleanup` stops anything, which
  // is why a stepwise session is never pulled out from under the operator by a re-run of one phase.
  let closed = false;
  /*
   * Before anything of this run exists, take back what a HARD-KILLED invocation of this stage left: nothing runs an
   * exit handler through a `taskkill /F`, so the game that invocation opened is still on screen and the guardian
   * deliberately keeps it (product rule #3023). The population, the three identity checks and the refusal to touch
   * a stage another invocation still holds are all in `lib/run-reaper.mjs`; this is the one call site.
   */
  const previousInvocation = openRunInvocation({ paths, phase });
  const reaped = reapRunOrphans({ paths, previous: previousInvocation });
  writeReaperReading(paths, reaped);
  for (const line of describeReaper(reaped)) console.log(line);
  // What that invocation left belongs to it, and is settled: retire it so this run neither claims to have killed it
  // nor reports it as a process still holding this stage.
  retireRunProcesses(paths, [...reaped.terminated, ...reaped.alreadyGone]);
  /*
   * The ledger is opened here and closed on the way out, around the same teardown: its "before" snapshot has
   * to predate the first process this invocation creates, and its "after" snapshot has to follow the last one
   * it stops. A ledger opened inside `close()` would have nothing to compare.
   */
  const ledger = openProcessLedger({ stageRoot: paths.stageRoot });
  const close = ({ code, reason, teardown }) => {
    if (closed) return code;
    closed = true;
    // This invocation is no longer in flight: from here on, what it leaves running was left on purpose (a
    // stepwise session) or has just been asserted gone - either way the next run must not reap it.
    closeRunInvocation(paths);
    // The game this run started is recorded BEFORE anything is torn down, from the only authority for it: the
    // process table, filtered for the game's own images and matched to this run's mods root. The sweep below
    // cannot see it (`Stardew Valley.exe` is launched with no arguments), and the product deliberately keeps a
    // player's world alive when the Host dies - so a harness that opened a game must name it and take it back.
    const gameRecord = recordRunGame({ paths, stageRoot: paths.stageRoot });
    const host = readHostIdentity(paths);
    const collected = collectProcessLedger(ledger, {
      registry: registeredRunProcesses(paths),
      hostPid: host.pid,
      hostStartTime: host.startTime,
    });
    if (teardown === "keep") {
      const kept = registeredRunProcesses(paths);
      const reading = closeProcessLedger(ledger, collected, {
        keptAlive: deliberatelyKept(collected.entries, { stepwise: true }),
      });
      writeProcessLedger(paths, reading);
      for (const line of describeProcessLedger(reading)) console.log(line);
      if (kept.length > 0)
        console.log(
          `RUN-CLEANUP(${reason}): stepwise mode leaves this run's processes running for the next phase [${kept
            .map((record) => `${record.pid}(${record.role})`)
            .join(" ")}] - the \`cleanup\` phase stops them`,
        );
      return code;
    }
    const teardownReport = teardownRun({ paths, run, reason });
    console.log(describeTeardown(teardownReport));
    // What happened to the game, in one line: it is a population of its own, so nothing about it has to be
    // inferred from a sweep that cannot see it.
    const game = {
      recorded: recordedGameProcesses(paths),
      surviving: survivingGameIdentities(recordedGameProcesses(paths)),
      examined: gameRecord.examined,
      // The Stardew processes this run examined and did not claim. Named so the line cannot read as "no game"
      // beside a live one on a machine where a sibling lane runs its own game (`.tmp/lane-launchorphan.md`).
      unclaimed: gameRecord.unclaimed,
    };
    for (const line of describeGameCleanup(game)) console.log(line);
    const reading = closeProcessLedger(ledger, collected, {
      endedByRun: teardownReport.killed.map((entry) => entry.pid),
      keptAlive: deliberatelyKept(collected.entries, { gamePids: new Set(game.recorded.map((entry) => entry.pid)) }),
    });
    writeProcessLedger(paths, reading);
    for (const line of describeProcessLedger(reading)) console.log(line);
    const leftovers = inspectRunLeftovers({ paths, run, game });
    writeLeftoversReading(paths, leftovers);
    console.log(describeLeftovers(leftovers, run));
    // A run that leaves its own processes alive did not finish, whatever its phase said - and so did a run that
    // ended a process it did not own, one that left the game it started on screen, one whose ledger could not
    // account for the pids it registered, or one that could not prove a recorded pid was still the process it
    // recorded and so refused to end it (#3715: an unconfirmed identity is reported, never resolved by a kill).
    const ledgerFailed =
      reading.leftovers.length > 0 ||
      reading.population === "unmeasured" ||
      reading.collateral?.endedByRunUnowned > 0 ||
      teardownReport.unverified.length > 0;
    const gameFailed =
      game.surviving.kind === "alive" || (game.surviving.kind === "unverifiable" && game.recorded.length > 0);
    return code !== 0 ||
      leftovers.status === "ours_remain" ||
      leftovers.status === "game_alive" ||
      gameFailed ||
      ledgerFailed
      ? Math.max(code, 1)
      : code;
  };
  process.once("exit", () => close({ code: 1, reason: "abnormal_exit", teardown: "kill" }));
  // The stepwise path that kills: `cleanup` is the operator's stop, so it reports what it stopped.
  const stepwise = phase === "cleanup" || fullMode ? "kill" : "keep";

  try {
    if (fullMode) {
      const worlds = captureInvocations(values);
      for (const line of worlds.lines) console.log(line);
      await runner("check", () => phaseCheck(paths, run));
      await runner("pin", () => phasePin(paths, run));
      await runner("build", () => phaseBuild(paths, run));
      if (worlds.shared !== null) {
        await runner("launch", () => phaseLaunch(paths, run));
        await runner("capture", () => phaseCapture(paths, run, { ...values, drivers: worlds.shared ?? undefined }));
      }
      for (const invocation of worlds.invocations) {
        console.log(
          `WORLDS: ${invocation.driver} gets a mounted Host of its own: cleanup, launch, capture --driver=${invocation.drivers.join(",")}`,
        );
        await runner("cleanup", () => phaseCleanup(paths, run));
        await runner("launch", () => phaseLaunch(paths, run));
        await runner("capture", () =>
          phaseCapture(paths, run, { ...values, drivers: invocation.drivers, force: true }),
        );
      }
      await runner("cleanup", () => phaseCleanup(paths, run));
      await runner("report", () => phaseReport(paths, run));
      console.log("DONE-FULL-RUN");
      process.exit(close({ code: 0, reason: "run_complete", teardown: "kill" }));
    }
    switch (phase) {
      case "check":
        process.exit(close({ code: await phaseCheck(paths, run), reason: "phase_check", teardown: "keep" }));
        break;
      case "pin":
        await runner("pin", () => phasePin(paths, run));
        break;
      case "build":
        await runner("build", () => phaseBuild(paths, run));
        break;
      case "launch":
        await runner("launch", () => phaseLaunch(paths, run));
        break;
      case "capture":
        await runner("capture", () => phaseCapture(paths, run, values));
        break;
      case "cleanup":
        await runner("cleanup", () => phaseCleanup(paths, run));
        break;
      case "report":
        await runner("report", () => phaseReport(paths, run));
        break;
      default:
        throw new Error(`no phase selected (expected one of ${PHASES.join(", ")})`);
    }
    process.exit(close({ code: 0, reason: `phase_${phase}_complete`, teardown: stepwise }));
  } catch (error) {
    console.error(String(error));
    process.exit(close({ code: 1, reason: "phase_failure", teardown: "kill" }));
  }
}

await main().catch((error) => {
  console.error(`RUN FAILED: ${String(error).slice(0, 1200)}`);
  process.exit(1);
});
