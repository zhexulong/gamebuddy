#!/usr/bin/env node
// shots capture kit — single entry.
//
//   node tools/shots/run.mjs --commit <sha|HEAD> --out <root>          full run (check→pin→build→launch→capture→cleanup→report)
//   node tools/shots/run.mjs --check [--commit sha] [--out root]      fast prerequisites only
//   node tools/shots/run.mjs <phase> [same keys]                      resumable stepwise run
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
// --edge, --cdp-port, --force (re-run finished capture drivers), --driver=a,b (capture subset).
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  runPaths,
  loadRunConfig,
  saveRunConfig,
  defaultStageFor,
  sanitizeTag,
  REPO_ROOT,
  KIT_ROOT,
} from "./lib/config.mjs";

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
  const run = {
    tag: sanitizeTag(`shots-${basename(outRoot)}`) || sanitizeTag(commit.slice(0, 12)),
    commit,
    shortCommit: commit.slice(0, 12),
    outRoot,
    stageRoot,
    runtimeFixture: values.runtime ?? process.env.GB_SHOTS_RUNTIME ?? prior?.runtimeFixture ?? "",
    gameDir: values["game-dir"] ?? process.env.GB_SHOTS_GAME_DIR ?? "D:\\Steam\\steamapps\\common\\Stardew Valley",
    edgeExe:
      values.edge ?? process.env.GB_SHOTS_EDGE ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    cdpPort: Number(values["cdp-port"] ?? process.env.GB_SHOTS_CDP_PORT ?? prior?.cdpPort ?? 9341),
    homeLocalAppData: process.env.LOCALAPPDATA ?? "C:\\Users\\long\\AppData\\Local",
    credentialPresent: typeof process.env.CPA_OAI_API_KEY === "string" && process.env.CPA_OAI_API_KEY.length > 0,
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
    requiredMissing = JSON.parse(result.stdout.trim().split("\n").pop())?.requiredMissing ?? 1;
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

  const runner = async (name, fn) => {
    console.log(`== phase ${name} ==`);
    const result = await fn();
    const code = typeof result === "object" && result !== null ? result.code : result;
    if (code !== 0) throw new Error(`phase ${name} failed (exit ${code})`);
    return result;
  };

  try {
    if (fullMode) {
      await runner("check", () => phaseCheck(paths, run));
      await runner("pin", () => phasePin(paths, run));
      await runner("build", () => phaseBuild(paths, run));
      await runner("launch", () => phaseLaunch(paths, run));
      await runner("capture", () => phaseCapture(paths, run, values));
      await runner("cleanup", () => phaseCleanup(paths, run));
      await runner("report", () => phaseReport(paths, run));
      console.log("DONE-FULL-RUN");
      process.exit(0);
    }
    switch (phase) {
      case "check":
        process.exit(await phaseCheck(paths, run));
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
  } catch (error) {
    console.error(String(error));
    process.exit(1);
  }
}

await main().catch((error) => {
  console.error(`RUN FAILED: ${String(error).slice(0, 1200)}`);
  process.exit(1);
});
