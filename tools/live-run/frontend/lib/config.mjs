// Shared path + run-config plumbing for the frontend live run.
//
// A run owns two roots:
//   outRoot  - the deliverable set (PNGs + per-item *.txt + README.txt + REPORT.txt); this is what CI
//              artifact uploads. The lane that owns the run is the only observer of the PNGs.
//   stageRoot - everything else: pinned worktree, build artifact, the run root (KEPT), browser profile,
//              state files and logs. Defaults to `<outRoot>.stage`; override with --stage.
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

export const KIT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * The repository root, found by walking up to the directory that owns `.git`.
 *
 * This was `dirname(dirname(KIT_ROOT))` - a fixed number of levels, which was correct while the kit
 * lived at `tools/shots/lib` and silently wrong the moment it moved to `tools/live-run/frontend/lib`:
 * it resolved to `tools/`, so the prerequisite check looked for `tools/node_modules/.pnpm/node_modules`
 * and failed four siblings that are present in the real tree. A path derived by counting directories
 * from a file that can move is a path that will be wrong after the move, and the failure it produces
 * names the missing dependency rather than the arithmetic.
 */
export const REPO_ROOT = (() => {
  let directory = KIT_ROOT;
  for (;;) {
    if (existsSync(join(directory, ".git"))) return directory;
    const parent = resolve(directory, "..");
    if (parent === directory) {
      throw new Error(`no .git above ${KIT_ROOT}: the kit must live inside the repository`);
    }
    directory = parent;
  }
})();

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
    /*
     * Where a run's captured provider request bodies live, if it captured any. The launch phase puts a
     * recording proxy in front of the endpoint the product resolves and points the launched child at it
     * (`lib/wire-capture.mjs`), so a run that could record writes here. A run whose proxy could not be
     * started has no file, and `observe()`'s INJECTION section says so by name instead of reporting an
     * empty injection. The writer appends one record per line, each naming its own source, so a reader
     * never inherits a source from the wrong line (`core/recording-provider-proxy.mjs`).
     */
    wireRequestsFile: join(stage, "state", "wire-requests.jsonl"),
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
