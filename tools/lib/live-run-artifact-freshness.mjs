import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectTestArtifactInputs,
  isTestSourcePath,
  readTestArtifactBuildManifest,
  TEST_ARTIFACT_BUILD_MANIFEST,
} from "../../host/scripts/test-artifact-build-manifest.mjs";

/**
 * The live-run artifact must not describe sources that have since changed.
 *
 * `host/dist-test` is what every native-local live run actually executes: the ladder imports fifteen modules of it
 * directly and the shared smoke harness reaches it through `loadHostTestModule`. Nothing in the repository
 * checked that it was current, so a stale tree silently tested the WRONG artifact, and the failure always
 * looked like a product bug instead. Observed four times: an `Unsupported candidate action:` for a committed
 * action, a chat fix with "no effect", a bridge that rejected every snapshot, and a harvest gate that could not
 * start. Each cost a full live cycle (game launch, fixture prepare, session) to discover.
 *
 * TWO RULES, and which one answered is part of the verdict:
 *
 *   content   - the artifact carries `build-manifest.json` (written by the build, `host/scripts/
 *               test-artifact-build-manifest.mjs`). Every input's current sha256 is compared with the recorded one,
 *               and a file added or removed since the build is drift too. Modification times are NOT consulted:
 *               a `git checkout` or a formatter pass that rewrites a file with the bytes it already had is not
 *               stale (measured: `provider-catalog.ts` touched with unchanged content refused a live run for
 *               nothing), and an edit inside one clock tick is not fresh.
 *   time      - no manifest (an artifact built before the manifest existed). The old rule - newest input write
 *               time vs newest emitted module - still answers, and the message says `no_manifest` so nobody has to
 *               guess which rule refused them.
 *
 * Because the comparison is by CONTENT, copying another tree's `host/dist-test` into a lane worktree is correct
 * exactly while that lane's Host sources are byte-identical to the tree that built it, and wrong the moment one
 * differs - `tools/new-lane-worktree.mjs` is the copy that respects that. A lane can also build its own artifact:
 * it installs its own `node_modules`, so the compiler entry resolves inside the lane.
 *
 * The rebuild it names is the locked public entry (`pnpm build:test`). A bare `tsc` reads as a shorter command,
 * but it bypasses the artifact lock and the test-only overlay, and `--noEmitOnError false` emits a PARTIAL tree
 * by construction - which then surfaces as unrelated module-not-found failures, not as a build error.
 * red-proof: inject  one byte changed in an input build-manifest.json records, after the build ->
 * *                    `live-run artifact is STALE (artifact_content_mismatch:<the edited input>)`, exit 1, while the
 * *                    same tree before the edit printed `current` (tools/lib/live-run-artifact-freshness.mjs)
 */
export const REBUILD_COMMAND = "cd host && pnpm build:test";

const IGNORED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "dist-test", "coverage"]);
/** How many drifting inputs the message names before it stops listing and counts the rest. */
const MAX_LISTED_DRIFT = 5;
/** How many touched-but-unchanged inputs the current verdict names as evidence that mtime is not the rule. */
const MAX_LISTED_TOUCHED = 3;

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

/** The first emitted module, which is all the artifact-empty check needs and cheaper than the whole tree's times. */
async function firstEmittedModule(root) {
  let found;
  const walk = async (directory) => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found !== undefined) return;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".js")) found = { path, mtimeMs: (await stat(path)).mtimeMs };
    }
  };
  await walk(root);
  return found;
}

/**
 * Which recorded inputs disagree with the tree as it is now: one entry per drifting path, sorted so the message is
 * stable across runs. Three shapes, each naming its own cause instead of sharing one vague code:
 *
 *   artifact_content_mismatch:<path>  the file is an input on both sides and its bytes differ
 *   artifact_input_missing:<path>     the build read it; it is not an input now (deleted, renamed, or reclassified)
 *   artifact_input_unrecorded:<path>  it is an input now; the build never read it (added after the build)
 */
export function findTestArtifactInputDrift({ manifest, inputs }) {
  const current = new Map(inputs.map((entry) => [entry.path, entry.sha256]));
  const drift = [];
  for (const [path, recorded] of Object.entries(manifest.inputs)) {
    const digest = current.get(path);
    if (digest === undefined) drift.push({ code: "artifact_input_missing", path });
    else if (digest !== recorded) drift.push({ code: "artifact_content_mismatch", path });
  }
  for (const entry of inputs)
    if (!Object.hasOwn(manifest.inputs, entry.path))
      drift.push({ code: "artifact_input_unrecorded", path: entry.path });
  return drift.sort(
    (left, right) => left.path.localeCompare(right.path, "en") || left.code.localeCompare(right.code, "en"),
  );
}

function describeDrift({ code, path }, builtAtIso) {
  if (code === "artifact_content_mismatch")
    return `${path} has different content than ${TEST_ARTIFACT_BUILD_MANIFEST} recorded (built ${builtAtIso})`;
  if (code === "artifact_input_missing")
    return `${path} is recorded in ${TEST_ARTIFACT_BUILD_MANIFEST} (built ${builtAtIso}) but is no longer an input`;
  return `${path} is an input now but ${TEST_ARTIFACT_BUILD_MANIFEST} (built ${builtAtIso}) does not record it, so it was added after the build`;
}

function describeDriftRest(drift) {
  if (drift.length <= 1) return "";
  const listed = drift.slice(1, MAX_LISTED_DRIFT).map((entry) => `${entry.code}:${entry.path}`);
  const remaining = drift.length - MAX_LISTED_DRIFT;
  return `; also ${listed.join(", ")}${remaining > 0 ? `, and ${remaining} more` : ""}`;
}

/**
 * The verdict for a current artifact, in the words that stop the next reader from re-adding mtime: the touched
 * inputs are named WITH the fact that their content is unchanged.
 */
function describeCurrentInputs({ inputs, manifest, builtAtIso }) {
  const touched = inputs.filter((entry) => entry.mtimeMs > manifest.builtAtMs);
  const note =
    touched.length === 0
      ? "no input was written after the build"
      : `${touched.length} input(s) were written after the build but their content is unchanged (${touched
          .slice(0, MAX_LISTED_TOUCHED)
          .map((entry) => entry.path)
          .join(", ")}${touched.length > MAX_LISTED_TOUCHED ? ", …" : ""}), which is not stale`;
  return `all ${inputs.length} inputs match ${TEST_ARTIFACT_BUILD_MANIFEST} (built ${builtAtIso}); modification times are not consulted: ${note}`;
}

async function assessByContent({ repositoryRoot, manifest, outputRoot }) {
  const builtAtIso = new Date(manifest.builtAtMs).toISOString();
  let inputs;
  try {
    inputs = await collectTestArtifactInputs({ repositoryRoot });
  } catch (error) {
    return {
      stale: true,
      rule: "content",
      reason: "artifact_inputs_unreadable",
      detail: `the inputs ${TEST_ARTIFACT_BUILD_MANIFEST} records cannot be read from this tree (${error?.message ?? error}), so the artifact cannot be shown to describe it`,
    };
  }
  const drift = findTestArtifactInputDrift({ manifest, inputs });
  if (drift.length > 0) {
    const [first] = drift;
    return {
      stale: true,
      rule: "content",
      reason: `${first.code}:${first.path}`,
      drift,
      inputs: { path: resolve(repositoryRoot, first.path) },
      detail: `${describeDrift(first, builtAtIso)}${describeDriftRest(drift)}`,
    };
  }
  const emitted = await firstEmittedModule(outputRoot);
  if (emitted === undefined)
    return {
      stale: true,
      rule: "content",
      reason: "artifact_empty",
      detail: `host/dist-test carries no emitted .js module although ${TEST_ARTIFACT_BUILD_MANIFEST} is present: the tree is half-written`,
    };
  const newest = inputs.reduce((left, right) => (right.mtimeMs > left.mtimeMs ? right : left));
  return {
    stale: false,
    rule: "content",
    inputs: newest,
    outputs: emitted,
    detail: describeCurrentInputs({ inputs, manifest, builtAtIso }),
  };
}

/**
 * The rule an artifact without a build manifest gets. Kept because artifacts built before the manifest existed are
 * a normal state, not a defect - but it is now a fallback, and every message it produces says so.
 */
async function assessByModificationTime({ repositoryRoot, sourceRoot, hostRoot, outputRoot }) {
  const inputs = await newestModificationTime(sourceRoot, {
    // TEST sources are deliberately excluded: the harm this gate prevents is that the run executes a module whose
    // source has changed, and a test file cannot change any production module a live run imports. The same predicate
    // is what the build manifest records, so both rules count the same population.
    match: (path) => path.endsWith(".ts") && !isTestSourcePath(path),
  });
  const outputs = await newestModificationTime(outputRoot, {
    match: (path) => path.endsWith(".js"),
  });
  const configurationInputs = await newestModificationTime(hostRoot, {
    match: (path) => /\/(?:tsconfig\.test\.json|package\.json)$/u.test(path),
    ignore: new Set(["node_modules", "dist", "dist-test", "src", "coverage"]),
  });
  const newestInput = [inputs, configurationInputs].reduce((left, right) =>
    right.mtimeMs > left.mtimeMs ? right : left,
  );
  const display = (path) => (path === undefined ? "(none)" : relative(repositoryRoot, path).replaceAll("\\", "/"));
  const absent = `no_manifest: host/dist-test/${TEST_ARTIFACT_BUILD_MANIFEST} is absent, so freshness falls back to modification times`;
  if (newestInput.path === undefined || outputs.path === undefined)
    return {
      stale: true,
      rule: "modification_time",
      reason: outputs.path === undefined ? "artifact_empty" : "no_inputs",
      inputs: newestInput,
      outputs,
      detail: `${absent}; ${outputs.path === undefined ? "no emitted .js module exists" : "no compiled input exists"}`,
    };
  const stale = newestInput.mtimeMs > outputs.mtimeMs;
  return {
    stale,
    rule: "modification_time",
    reason: stale ? "artifact_older_than_inputs" : undefined,
    inputs: newestInput,
    outputs,
    detail: stale
      ? `${absent}; newest input ${display(newestInput.path)} @${new Date(newestInput.mtimeMs).toISOString()} is newer than the newest emitted module ${display(outputs.path)} @${new Date(outputs.mtimeMs).toISOString()}`
      : `${absent}; newest input ${display(newestInput.path)} @${new Date(newestInput.mtimeMs).toISOString()} is not newer than the newest emitted module ${display(outputs.path)} @${new Date(outputs.mtimeMs).toISOString()}`,
  };
}

/**
 * @returns {Promise<{ stale: boolean, reason?: string, rule: "content"|"modification_time"|"none", detail: string,
 *   drift?: Array<{code: string, path: string}>, inputs?: {path: string, mtimeMs?: number}, outputs?: {path: string, mtimeMs?: number} }>}
 */
export async function assessLiveRunArtifactFreshness({ repositoryRoot }) {
  const hostRoot = join(repositoryRoot, "host");
  const sourceRoot = join(hostRoot, "src");
  const outputRoot = join(hostRoot, "dist-test");
  if (!existsSync(sourceRoot))
    return {
      stale: false,
      rule: "none",
      reason: "no_source_root",
      detail: "this tree has no host/src, so there is no artifact that could be stale",
    };
  if (!existsSync(outputRoot))
    return { stale: true, rule: "none", reason: "artifact_missing", detail: "host/dist-test does not exist" };
  let manifest;
  try {
    manifest = await readTestArtifactBuildManifest({ outputRoot });
  } catch (error) {
    return {
      stale: true,
      rule: "content",
      reason: "artifact_build_manifest_invalid",
      detail: `host/dist-test/${TEST_ARTIFACT_BUILD_MANIFEST} cannot be read (${error?.message ?? error}), so this artifact cannot say what it was built from`,
    };
  }
  if (manifest === undefined)
    return await assessByModificationTime({ repositoryRoot, sourceRoot, hostRoot, outputRoot });
  return await assessByContent({ repositoryRoot, manifest, outputRoot });
}

/**
 * Fail-closed guard for live runs: call this before launching anything. `onStale` lets a caller name its own
 * fix; the default throws.
 */
export async function assertLiveRunArtifactFresh({ repositoryRoot, onStale } = {}) {
  const root = repositoryRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const verdict = await assessLiveRunArtifactFreshness({ repositoryRoot: root });
  if (!verdict.stale) return verdict;
  const detail = `${verdict.reason}: ${verdict.detail}`;
  if (onStale !== undefined) return onStale(detail);
  throw new Error(`live_run_artifact_stale:${detail} — rebuild with: ${REBUILD_COMMAND}`);
}

const isDirectRun = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const verdict = await assessLiveRunArtifactFreshness({ repositoryRoot });
  if (!verdict.stale) {
    console.log(`live-run artifact is current (${verdict.rule}): ${verdict.detail}`);
    process.exit(0);
  }
  console.error(`live-run artifact is STALE (${verdict.reason})`);
  console.error(`  ${verdict.detail}`);
  for (const entry of (verdict.drift ?? []).slice(0, MAX_LISTED_DRIFT)) console.error(`  ${entry.code}: ${entry.path}`);
  console.error(`  rebuild with : ${REBUILD_COMMAND}`);
  process.exit(1);
}
