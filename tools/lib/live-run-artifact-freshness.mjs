import { readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The live-run artifact must not be older than the sources it was compiled from.
 *
 * `host/dist-test` is what every native-local live run actually executes: the ladder imports fifteen modules of it
 * directly and the shared smoke harness reaches it through `loadHostTestModule`. Nothing in the repository
 * checked that it was current, so a stale tree silently tested the WRONG artifact, and the failure always
 * looked like a product bug instead. Observed four times: an `Unsupported candidate action:` for a committed
 * action, a chat fix with "no effect", a bridge that rejected every snapshot, and a harvest gate that could not
 * start. Each cost a full live cycle (game launch, fixture prepare, session) to discover.
 *
 * The rule is deliberately coarse — newest compiled input vs newest emitted output — because that is what makes
 * it cheap enough to run before every live cycle, and because a full `tsc` run rewrites every emitted file, so a
 * current artifact is always newer than its inputs.
 */
export const REBUILD_COMMAND = "cd host && node node_modules/typescript/bin/tsc --project tsconfig.test.json --noEmitOnError false";

const IGNORED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "dist-test", "coverage"]);

async function newestModificationTime(root, { match, ignore = IGNORED_DIRECTORIES } = {}) {
  let newest = { path: undefined, mtimeMs: Number.NEGATIVE_INFINITY };
  const walk = async (directory) => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (ignore.has(entry.name)) continue;
        await walk(path);
      } else if (entry.isFile() && (match === undefined || match(path))) {
        const state = await stat(path);
        if (state.mtimeMs > newest.mtimeMs) newest = { path, mtimeMs: state.mtimeMs };
      }
    }
  };
  await walk(root);
  return newest;
}

/**
 * @returns {Promise<{ stale: boolean, reason?: string, inputs?: object, outputs?: object }>}
 */
export async function assessLiveRunArtifactFreshness({ repositoryRoot }) {
  const hostRoot = join(repositoryRoot, "host");
  const sourceRoot = join(hostRoot, "src");
  const outputRoot = join(hostRoot, "dist-test");
  if (!existsSync(sourceRoot)) return { stale: false, reason: "no_source_root" };
  if (!existsSync(outputRoot)) return { stale: true, reason: "artifact_missing" };
  const inputs = await newestModificationTime(sourceRoot, { match: (path) => path.endsWith(".ts") });
  const outputs = await newestModificationTime(outputRoot, {
    // The configuration and the tsconfig are inputs too: changing either changes what the artifact must be.
    match: (path) => path.endsWith(".js"),
  });
  const configurationInputs = await newestModificationTime(hostRoot, {
    match: (path) => /\/(?:tsconfig\.test\.json|package\.json)$/u.test(path),
    ignore: new Set(["node_modules", "dist", "dist-test", "src", "coverage"]),
  });
  const newestInput = [inputs, configurationInputs].reduce((left, right) => (right.mtimeMs > left.mtimeMs ? right : left));
  if (newestInput.path === undefined || outputs.path === undefined)
    return { stale: true, reason: outputs.path === undefined ? "artifact_empty" : "no_inputs", inputs: newestInput, outputs };
  const stale = newestInput.mtimeMs > outputs.mtimeMs;
  return { stale, reason: stale ? "artifact_older_than_inputs" : undefined, inputs: newestInput, outputs };
}

/**
 * Fail-closed guard for live runs: call this before launching anything. `onStale` lets a caller name its own
 * fix; the default throws.
 */
export async function assertLiveRunArtifactFresh({ repositoryRoot, onStale } = {}) {
  const root = repositoryRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const verdict = await assessLiveRunArtifactFreshness({ repositoryRoot: root });
  if (!verdict.stale) return verdict;
  const detail = `${verdict.reason}: newest input ${verdict.inputs?.path ?? "(none)"} @${new Date(verdict.inputs?.mtimeMs ?? 0).toISOString()} vs newest output ${verdict.outputs?.path ?? "(none)"} @${new Date(verdict.outputs?.mtimeMs ?? 0).toISOString()}`;
  if (onStale !== undefined) return onStale(detail);
  throw new Error(`live_run_artifact_stale:${detail} — rebuild with: ${REBUILD_COMMAND}`);
}

const isDirectRun = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const verdict = await assessLiveRunArtifactFreshness({ repositoryRoot });
  if (!verdict.stale) {
    console.log(
      `live-run artifact is current: newest input ${verdict.inputs.path.replace(repositoryRoot, "").replace(/\\/gu, "/")} (${new Date(verdict.inputs.mtimeMs).toISOString()}) is not newer than the newest emitted module (${new Date(verdict.outputs.mtimeMs).toISOString()})`,
    );
    process.exit(0);
  }
  console.error(`live-run artifact is STALE (${verdict.reason})`);
  if (verdict.inputs?.path !== undefined) console.error(`  newest input : ${verdict.inputs.path} @${new Date(verdict.inputs.mtimeMs).toISOString()}`);
  if (verdict.outputs?.path !== undefined) console.error(`  newest output: ${verdict.outputs.path} @${new Date(verdict.outputs.mtimeMs).toISOString()}`);
  console.error(`  rebuild with : ${REBUILD_COMMAND}`);
  process.exit(1);
}

