import { createHash } from "node:crypto";
import { readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * `host/dist-test` records what it was built from - one content hash per input - so freshness can be decided by
 * content instead of by modification time.
 *
 * WHY: the live-run gate answered "is this artifact current?" by comparing the newest input write time against the
 * newest emitted module. Time is not content. A `git checkout`, a formatter pass, or a branch switch that rewrites a
 * file with the bytes it already had moves the clock and refuses a run whose artifact is exactly right (measured:
 * `provider-catalog.ts` touched with unchanged content refused a live run), while the mirror image - an edit inside
 * the same clock tick, or a file restored to older bytes - passes a gate that should have stopped it. The artifact is
 * the only thing that knows which inputs produced it, so it says so here and the check compares hashes.
 *
 * The input list is not hand-written: `collectTestArtifactInputs` is the single walk the build and the check share, and
 * `COPIED_TEST_ARTIFACT_ASSETS` is also the build's own copy loop. A file the build reads but this list omits would be
 * invisible to the check, which is the defect this module exists to prevent.
 */

export const TEST_ARTIFACT_BUILD_MANIFEST = "build-manifest.json";
export const TEST_ARTIFACT_BUILD_MANIFEST_SCHEMA = "gamebuddy-host-test-artifact-build/v1";
/** Repo-relative: the one directory whose changes change the artifact's modules. */
export const TEST_ARTIFACT_SOURCE_ROOT = "host/src";

/** Host-relative source and its destination inside the artifact. One list, used by the copy loop and the manifest. */
export const COPIED_TEST_ARTIFACT_ASSETS = Object.freeze([
  { source: "src/test-fixtures/windows-named-mutex-abandon-child.ps1", destination: "test-fixtures/windows-named-mutex-abandon-child.ps1" },
  { source: "src/test-fixtures/windows-named-mutex-broker-test-sidecar.ps1", destination: "test-fixtures/windows-named-mutex-broker-test-sidecar.ps1" },
  { source: "src/test-fixtures/windows-named-mutex-retained-abandon.ps1", destination: "test-fixtures/windows-named-mutex-retained-abandon.ps1" },
  { source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" },
]);

/** Configuration the compiler reads. `tsconfig.test.json` extends `tsconfig.json`, so both are inputs. */
const CONFIGURATION_INPUTS = Object.freeze(["package.json", "tsconfig.json", "tsconfig.test.json"]);

const SHA256 = /^[a-f0-9]{64}$/u;
const slash = (value) => value.replaceAll("\\", "/");
const sha256 = (contents) => createHash("sha256").update(contents).digest("hex");

/**
 * A source file that exists only to test production code; a change to one cannot alter what a live run executes.
 *
 * Measured: four consecutive live runs were refused because another lane edited a `*.test.ts` file seconds after each
 * rebuild. The harm the gate prevents is that a run executes a production module whose source has changed, and a test
 * file cannot change any production module a live run imports - so test sources are outside the input population on
 * both sides of the comparison, and the artifact's own compiled test files are the suite's business.
 */
export function isTestSourcePath(path) {
  const normalised = slash(path);
  return (
    normalised.endsWith(".test.ts") ||
    normalised.includes("/__tests__/") ||
    normalised.endsWith(".fixture.ts") ||
    normalised.includes("/fixtures/")
  );
}

function hostRelativePath(hostRoot, absolute) {
  const value = relative(hostRoot, absolute);
  if (isAbsolute(value) || value === ".." || value.startsWith(`..${sep}`))
    throw new Error("test_artifact_build_manifest_input_escapes_host_root");
  return slash(value);
}

/**
 * Every input the build consumes, with its content hash and current write time.
 *
 * The write time is carried for the MESSAGE only: it lets a current verdict say "these inputs were written after the
 * build but their content is unchanged, which is not stale" instead of inviting the next reader to re-add mtime.
 */
export async function collectTestArtifactInputs({ repositoryRoot }) {
  const hostRoot = resolve(repositoryRoot, "host");
  const inputs = new Map();
  const record = async (absolute) => {
    const details = await stat(absolute);
    if (!details.isFile()) throw new Error(`test_artifact_build_manifest_input_not_a_file:${hostRelativePath(hostRoot, absolute)}`);
    const path = `host/${hostRelativePath(hostRoot, absolute)}`;
    inputs.set(path, { path, sha256: sha256(await readFile(absolute)), mtimeMs: details.mtimeMs });
  };
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile() && entry.name.endsWith(".ts") && !isTestSourcePath(hostRelativePath(hostRoot, absolute)))
        await record(absolute);
    }
  };
  await walk(resolve(hostRoot, "src"));
  for (const asset of COPIED_TEST_ARTIFACT_ASSETS) await record(resolve(hostRoot, asset.source));
  for (const configuration of CONFIGURATION_INPUTS) await record(resolve(hostRoot, configuration));
  return [...inputs.values()].sort((left, right) => left.path.localeCompare(right.path, "en"));
}

function isRelativeManifestPath(path) {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !path.includes("\\") &&
    !path.startsWith("/") &&
    !path.split("/").includes("..")
  );
}

function validManifest(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.schema === TEST_ARTIFACT_BUILD_MANIFEST_SCHEMA &&
    Number.isSafeInteger(value.builtAtMs) &&
    value.builtAtMs > 0 &&
    value.sourceRoot === TEST_ARTIFACT_SOURCE_ROOT &&
    value.inputs !== null &&
    typeof value.inputs === "object" &&
    !Array.isArray(value.inputs) &&
    Object.keys(value.inputs).length > 0 &&
    Object.entries(value.inputs).every(([path, digest]) => isRelativeManifestPath(path) && SHA256.test(digest))
  );
}

/**
 * Write the artifact's build manifest beside the emitted tree, from the same walk the freshness check will repeat.
 *
 * `builtAtMs` is stated by the caller rather than defaulted, because it is the moment the build's inputs were frozen:
 * a source written after it is not reliably in the artifact. It is the same stamp the inventory records.
 */
export async function writeTestArtifactBuildManifest({ repositoryRoot, outputRoot, builtAtMs }) {
  if (!Number.isSafeInteger(builtAtMs) || builtAtMs <= 0) throw new Error("test_artifact_build_manifest_time_invalid");
  const inputs = await collectTestArtifactInputs({ repositoryRoot });
  if (inputs.length === 0) throw new Error("test_artifact_build_manifest_inputs_empty");
  const manifest = Object.freeze({
    schema: TEST_ARTIFACT_BUILD_MANIFEST_SCHEMA,
    builtAtMs,
    sourceRoot: TEST_ARTIFACT_SOURCE_ROOT,
    inputs: Object.freeze(Object.fromEntries(inputs.map((entry) => [entry.path, entry.sha256]))),
  });
  const root = resolve(outputRoot);
  const temporaryPath = resolve(root, `.${TEST_ARTIFACT_BUILD_MANIFEST}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, resolve(root, TEST_ARTIFACT_BUILD_MANIFEST));
  return manifest;
}

/** The published build manifest, or `undefined` when this artifact carries none (one built before it existed). */
export async function readTestArtifactBuildManifest({ outputRoot }) {
  let text;
  try {
    text = await readFile(resolve(outputRoot, TEST_ARTIFACT_BUILD_MANIFEST), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("test_artifact_build_manifest_invalid");
  }
  if (!validManifest(value)) throw new Error("test_artifact_build_manifest_invalid");
  return value;
}
