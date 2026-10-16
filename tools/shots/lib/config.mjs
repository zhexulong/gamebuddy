// Shared path + run-config plumbing for the shots capture kit.
//
// A run owns two roots:
//   outRoot  - the deliverable set (PNGs + per-item *.txt + README.txt + REPORT.txt); this is what CI
//              fabric uploads. The lane that owns the run is the only observer of the PNGs.
//   stageRoot - everything else: pinned worktree, build artifact, the run root (KEPT), browser profile,
//              state files and logs. Defaults to `<outRoot>.stage`; override with --stage.
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

export const KIT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
export const REPO_ROOT = dirname(dirname(KIT_ROOT));

export function runPaths(run) {
  const stage = run.stageRoot;
  return Object.freeze({
    outRoot: run.outRoot,
    stageRoot: stage,
    worktree: join(stage, "worktree"),
    artifact: join(stage, "artifact"),
    runRoot: join(stage, "root"),
    stateDir: join(stage, "state"),
    logsDir: join(stage, "logs"),
    browserProfile: join(stage, "browser-profile"),
    deploymentManifest: join(stage, "deployment-manifest.json"),
    rootLayoutFile: join(stage, "state", "rootlayout.json"),
    runConfigFile: join(stage, "state", "run.json"),
    portFile: join(stage, "state", "port.txt"),
    launchStateFile: join(stage, "state", "launch.json"),
    stopFlag: join(stage, "state", "stop.flag"),
    launchLog: join(stage, "logs", "launch.log"),
    buildLog: join(stage, "logs", "build.log"),
    pinLog: join(stage, "logs", "pin.log"),
    captureLog: join(stage, "logs", "capture.log"),
    cleanupLog: join(stage, "logs", "cleanup.log"),
    reportLog: join(stage, "logs", "report.log"),
    runLog: join(stage, "logs", "run.log"),
  });
}

export function defaultStageFor(outRoot) {
  return `${outRoot}.stage`;
}

export function sanitizeTag(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9._-]+/gu, "-")
    .slice(0, 48);
}

export function loadRunConfig(paths) {
  try {
    return JSON.parse(readFileSync(paths.runConfigFile, "utf8"));
  } catch {
    return null;
  }
}

export function saveRunConfig(paths, run) {
  mkdirSync(paths.stateDir, { recursive: true });
  writeFileSync(paths.runConfigFile, JSON.stringify(run, null, 1), "utf8");
  return run;
}
