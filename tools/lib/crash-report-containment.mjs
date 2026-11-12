/**
 * The environment we hand a child process, with Node's crash reporter aimed outside the repository.
 *
 * WHY THIS EXISTS (measured 2026-11-12). `NODE_OPTIONS` on this machine carries `--report-on-fatalerror`, so every
 * Node process that dies writes a JSON crash report - and the report carries the whole environment of the process
 * that died. 787 of them had accumulated in the repository root and 238 held a plaintext
 * `GITHUB_PERSONAL_ACCESS_TOKEN` / `CPA_OAI_API_KEY` / `CONTEXT7_API_KEY` / `TAVILY_API_KEY` assignment. None was
 * tracked, so no key had to be rotated, but the tree was one `git add -A` away from committing them.
 *
 * The switch is machine-wide and not ours to remove. `--diagnostic-dir` looked like it would contain them and does
 * not: a crash report honours `--report-directory` alone, which is why the configured diagnostic directory held 0
 * files while every crashing child's own cwd collected the rest. So containment happens per child, at the point we
 * build its environment: the switch that fires a report goes, the directory it would be written to is set outside the
 * repository, and every other flag stays - this variable also carries the `--import …/memwatch.mjs` preload and the
 * heap ceiling someone put there deliberately, and unsetting the whole variable would remove those silently.
 *
 * The directory is the OS temp root rather than a subdirectory of the checkout for the same reason: a report written
 * inside the repository is the leak, wherever in the repository it lands.
 */
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The flag that fires a report. Removed, because a report is what carries the environment. */
const REPORT_SWITCH = "--report-on-fatalerror";
/** The flag that decides where a report lands. Rewritten, because `--diagnostic-dir` does not govern it. */
const REPORT_DIRECTORY = "--report-directory=";
/** Where a report is allowed to land: the OS temp root, which is outside every checkout on this machine. */
export const CRASH_REPORT_DIRECTORY = join(tmpdir(), "gamebuddy-node-reports");

/**
 * `nodeOptions` with the reporting switch removed and the reporting directory pointed at `directory`, every other
 * flag preserved in order. An empty or absent value stays empty: there is nothing to contain and nothing to add.
 */
export function containedNodeOptions(nodeOptions, directory = CRASH_REPORT_DIRECTORY) {
  if (typeof nodeOptions !== "string" || nodeOptions.trim() === "") return "";
  const flags = nodeOptions
    .trim()
    .split(/\s+/u)
    .filter((flag) => flag !== REPORT_SWITCH && !flag.startsWith(REPORT_DIRECTORY));
  return [...flags, `${REPORT_DIRECTORY}${directory}`].join(" ");
}

/**
 * The `env` a child process is spawned with: the parent's environment, its `NODE_OPTIONS` contained, nothing else
 * touched. Creating the directory here is what keeps the flag honest - a `--report-directory` that does not exist is
 * not a directory a dying process can write into.
 */
export function containedChildEnvironment(env = process.env, directory = CRASH_REPORT_DIRECTORY) {
  const { NODE_OPTIONS: nodeOptions, ...rest } = env;
  if (typeof nodeOptions !== "string" || nodeOptions.trim() === "") return rest;
  mkdirSync(directory, { recursive: true });
  return { ...rest, NODE_OPTIONS: containedNodeOptions(nodeOptions, directory) };
}
