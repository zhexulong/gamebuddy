import { readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultSourceRoot = resolve(hostRoot, "src");
const TEST_ARTIFACT_INVENTORY = "test-artifact-inventory.json";
const TEST_ARTIFACT_INVENTORY_SCHEMA = "gamebuddy-host-test-artifact-inventory/v2";
/**
 * The v1 shape listed the emitted test files and nothing about age. It is still readable, and
 * it is read as exactly what it is: an artifact that cannot say whether it is current.
 */
const TEST_ARTIFACT_INVENTORY_SCHEMA_V1 = "gamebuddy-host-test-artifact-inventory/v1";
/** How many missing paths the bounded diagnostic names before it stops listing. */
const MAX_LISTED_MISSING = 5;

const slash = (value) => value.replaceAll("\\", "/");

function inventoryError(code) {
  return new Error(code);
}

function assertInside(root, candidate) {
  const value = relative(root, candidate);
  if (isAbsolute(value) || value === ".." || value.startsWith(`..${sep}`)) throw inventoryError("test_artifact_inventory_root_invalid");
}

/**
 * The relative paths of every emitted `*.test.js` below the artifact root, sorted.
 *
 * This is deliberately the whole file list: paths, no content digests. Its one job is to stop a
 * half-written `dist-test` from being read as "the product is broken". A partial tree reports as
 * a pile of unrelated `ERR_MODULE_NOT_FOUND` failures that finish in tens of milliseconds, which
 * is why it was mistaken for a product defect twice in one day; a digest chain would mean the
 * same thing and cost more to maintain.
 *
 * What this list cannot say is HOW OLD the artifact is. A tree that still contains every file it
 * was built with - a complete artifact - can still be a description of sources that have since
 * changed, and that is a different property. Only completeness was checked here; the source
 * stamp `collectSourceStamp` records below is what makes age observable, because a stale
 * artifact does not announce itself: it produces ordinary, plausible-looking test results. A
 * test source fixed at 21:18 was read back from an artifact built at 20:54, which contained none
 * of the new code, and the red it produced was indistinguishable from that fix being wrong.
 */
export async function collectTestArtifactTestFiles(outputRoot) {
  const root = resolve(outputRoot);
  const files = [];
  async function walk(directory) {
    assertInside(root, directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      assertInside(root, absolute);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile() && entry.name.endsWith(".test.js")) files.push(slash(relative(root, absolute)));
    }
  }
  await walk(root);
  files.sort((left, right) => left.localeCompare(right, "en"));
  return files;
}

function isRelativeInventoryPath(path) {
  return typeof path === "string" && path.length > 0 && !path.includes("\\") && !path.startsWith("/") && !path.split("/").includes("..");
}

/** Host-relative where the tree lives under the Host, so a failure names a path an operator recognizes. */
function displaySourcePath(root, absolute) {
  const hostRelative = relative(hostRoot, absolute);
  if (!isAbsolute(hostRelative) && hostRelative !== ".." && !hostRelative.startsWith(`..${sep}`)) return slash(hostRelative);
  return slash(relative(root, absolute));
}

/**
 * What the Host's own source tree looked like when the artifact was built: a count and the
 * newest write time, never content.
 *
 * Those two answer the question the file list cannot. The newest write time catches an edit that
 * the artifact does not contain; the count catches a source added or removed with the artifact
 * none the wiser, including one deleted after the build, whose compiled test would otherwise
 * keep running from the artifact. Both cost one walk of `stat` calls - a digest over the same
 * files would read every one of them on every check, which is the cost that keeps a guard from
 * being run.
 */
async function collectSourceStamp(sourceRoot) {
  const root = resolve(sourceRoot);
  let sourceFileCount = 0;
  let newestSourceMtimeMs = -1;
  let newestSourcePath;
  async function walk(directory) {
    assertInside(root, directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      assertInside(root, absolute);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        sourceFileCount += 1;
        const details = await stat(absolute);
        if (details.mtimeMs > newestSourceMtimeMs) {
          newestSourceMtimeMs = details.mtimeMs;
          newestSourcePath = displaySourcePath(root, absolute);
        }
      }
    }
  }
  await walk(root);
  return Object.freeze({ sourceFileCount, newestSourcePath, newestSourceMtimeMs });
}

/**
 * Write the artifact's inventory - its emitted test files and the source stamp it was built
 * from - beside the emitted tree.
 *
 * `buildStartedAtMs` is stated by the caller rather than defaulted, because it is the moment the
 * build's inputs were frozen: a source written after it is not reliably in the artifact, which
 * is precisely what a publish-time stamp would hide. A missing or nonsensical value is refused
 * here instead of being written as an inventory that reads as current.
 */
export async function writeTestArtifactInventory({ outputRoot = resolve(hostRoot, "dist-test"), sourceRoot = defaultSourceRoot, buildStartedAtMs } = {}) {
  const root = resolve(outputRoot);
  if (!Number.isSafeInteger(buildStartedAtMs) || buildStartedAtMs <= 0) throw inventoryError("test_artifact_inventory_build_time_invalid");
  const testFiles = await collectTestArtifactTestFiles(root);
  if (testFiles.length === 0) throw inventoryError("test_artifact_inventory_empty");
  const stamp = await collectSourceStamp(sourceRoot);
  if (stamp.sourceFileCount === 0) throw inventoryError("test_artifact_source_tree_empty");
  const inventory = Object.freeze({
    schema: TEST_ARTIFACT_INVENTORY_SCHEMA,
    buildStartedAtMs,
    sourceFileCount: stamp.sourceFileCount,
    newestSourcePath: stamp.newestSourcePath,
    newestSourceMtimeMs: stamp.newestSourceMtimeMs,
    testFileCount: testFiles.length,
    testFiles,
  });
  const temporaryPath = resolve(root, `.${TEST_ARTIFACT_INVENTORY}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(inventory, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, resolve(root, TEST_ARTIFACT_INVENTORY));
  return inventory;
}

function validSourceStamp(value) {
  return (
    Number.isSafeInteger(value.buildStartedAtMs) && value.buildStartedAtMs > 0 &&
    Number.isSafeInteger(value.sourceFileCount) && value.sourceFileCount > 0 &&
    isRelativeInventoryPath(value.newestSourcePath) &&
    Number.isFinite(value.newestSourceMtimeMs) && value.newestSourceMtimeMs > 0
  );
}

function parseInventory(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw inventoryError("test_artifact_inventory_invalid");
  }
  const current = value?.schema === TEST_ARTIFACT_INVENTORY_SCHEMA;
  const plain =
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (current || value.schema === TEST_ARTIFACT_INVENTORY_SCHEMA_V1) &&
    Number.isSafeInteger(value.testFileCount) &&
    value.testFileCount > 0 &&
    Array.isArray(value.testFiles) &&
    value.testFiles.length === value.testFileCount;
  if (!plain) throw inventoryError("test_artifact_inventory_invalid");
  for (const path of value.testFiles) {
    if (!isRelativeInventoryPath(path)) throw inventoryError("test_artifact_inventory_invalid");
  }
  if (current && !validSourceStamp(value)) throw inventoryError("test_artifact_inventory_invalid");
  return value;
}

/**
 * Compare the emitted `*.test.js` on disk against the inventory the builder wrote.
 *
 * `absent` is returned - never a failure - when no inventory exists, because an
 * artifact built before the inventory existed is a normal state, not a defect; the
 * caller warns once and proceeds. Extra test files are not incomplete, so they pass.
 *
 * A shortfall throws `test_artifact_incomplete:present=<n>:expected=<n>:missing=<…>`,
 * bounded to a few named paths. The runner must surface that instead of running the
 * partial tree.
 */
export async function assertTestArtifactInventory({ outputRoot = resolve(hostRoot, "dist-test") } = {}) {
  const inventory = await readArtifactInventory(outputRoot);
  if (inventory === undefined) return Object.freeze({ status: "absent" });
  const present = await collectTestArtifactTestFiles(resolve(outputRoot));
  const presentSet = new Set(present);
  const missing = inventory.testFiles.filter((path) => !presentSet.has(path));
  if (missing.length === 0) {
    return Object.freeze({ status: "complete", present: present.length, expected: inventory.testFileCount });
  }
  throw new Error(
    `test_artifact_incomplete:present=${present.length}:expected=${inventory.testFileCount}:missing=${missing.slice(0, MAX_LISTED_MISSING).join(",")}`,
  );
}

/**
 * Fail fast when the artifact is older than the sources it should describe.
 *
 * The comparison is the newest source write time against the build's own start stamp, not a
 * content digest: content is what the verification manifest already hashes, at the cost of a
 * full read of the source and dependency trees (measured here: 13.4s on a fresh tree), and it
 * reports a mismatch without naming a source or a remedy. This check costs one walk of `stat`
 * calls and names both.
 *
 * An artifact whose inventory predates the stamp says nothing about its own age. That is a
 * normal state, not a defect, so it is reported as `unrecorded` for the caller to warn about
 * once and continue - the content digest still covers its sources.
 */
export async function assertTestArtifactFreshness({ outputRoot = resolve(hostRoot, "dist-test"), sourceRoot = defaultSourceRoot } = {}) {
  const inventory = await readArtifactInventory(outputRoot);
  if (inventory === undefined || inventory.schema !== TEST_ARTIFACT_INVENTORY_SCHEMA) return Object.freeze({ status: "unrecorded" });
  const current = await collectSourceStamp(sourceRoot);
  const remedy = "run=`pnpm build:test`";
  const artifactBuilt = `artifact_built=${new Date(inventory.buildStartedAtMs).toISOString()}`;
  if (current.newestSourceMtimeMs > inventory.buildStartedAtMs)
    throw new Error(`test_artifact_stale:newest_source=${current.newestSourcePath}:${artifactBuilt}:${remedy}`);
  if (current.sourceFileCount !== inventory.sourceFileCount)
    throw new Error(`test_artifact_stale:source_files=${inventory.sourceFileCount}->${current.sourceFileCount}:${artifactBuilt}:${remedy}`);
  return Object.freeze({ status: "fresh", sourceFileCount: current.sourceFileCount });
}

/** The published inventory, or `undefined` when this artifact carries none. */
async function readArtifactInventory(outputRoot) {
  const root = resolve(outputRoot);
  let text;
  try {
    text = await readFile(resolve(root, TEST_ARTIFACT_INVENTORY), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  return parseInventory(text);
}

export { TEST_ARTIFACT_INVENTORY, TEST_ARTIFACT_INVENTORY_SCHEMA };
