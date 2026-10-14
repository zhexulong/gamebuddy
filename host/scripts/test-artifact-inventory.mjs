import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEST_ARTIFACT_INVENTORY = "test-artifact-inventory.json";
const TEST_ARTIFACT_INVENTORY_SCHEMA = "gamebuddy-host-test-artifact-inventory/v1";
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
 * This is deliberately the whole inventory: a count and a list, no content digests.
 * Its one job is to stop a half-written `dist-test` from being read as "the product
 * is broken". A partial tree reports as a pile of unrelated `ERR_MODULE_NOT_FOUND`
 * failures that finish in tens of milliseconds, which is why it was mistaken for a
 * product defect twice in one day; a digest chain would mean the same thing and cost
 * more to maintain.
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

/** Write the artifact's test-file inventory beside the emitted tree. */
export async function writeTestArtifactInventory({ outputRoot = resolve(hostRoot, "dist-test") } = {}) {
  const root = resolve(outputRoot);
  const testFiles = await collectTestArtifactTestFiles(root);
  if (testFiles.length === 0) throw inventoryError("test_artifact_inventory_empty");
  const inventory = Object.freeze({
    schema: TEST_ARTIFACT_INVENTORY_SCHEMA,
    testFileCount: testFiles.length,
    testFiles,
  });
  const temporaryPath = resolve(root, `.${TEST_ARTIFACT_INVENTORY}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temporaryPath, `${JSON.stringify(inventory, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, resolve(root, TEST_ARTIFACT_INVENTORY));
  return inventory;
}

function parseInventory(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw inventoryError("test_artifact_inventory_invalid");
  }
  const plain =
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.schema === TEST_ARTIFACT_INVENTORY_SCHEMA &&
    Number.isSafeInteger(value.testFileCount) &&
    value.testFileCount > 0 &&
    Array.isArray(value.testFiles) &&
    value.testFiles.length === value.testFileCount;
  if (!plain) throw inventoryError("test_artifact_inventory_invalid");
  for (const path of value.testFiles) {
    if (
      typeof path !== "string" ||
      path.length === 0 ||
      path.includes("\\") ||
      path.startsWith("/") ||
      path.split("/").includes("..")
    ) {
      throw inventoryError("test_artifact_inventory_invalid");
    }
  }
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
  const root = resolve(outputRoot);
  let text;
  try {
    text = await readFile(resolve(root, TEST_ARTIFACT_INVENTORY), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze({ status: "absent" });
    throw error;
  }
  const inventory = parseInventory(text);
  const present = await collectTestArtifactTestFiles(root);
  const presentSet = new Set(present);
  const missing = inventory.testFiles.filter((path) => !presentSet.has(path));
  if (missing.length === 0) {
    return Object.freeze({ status: "complete", present: present.length, expected: inventory.testFileCount });
  }
  throw new Error(
    `test_artifact_incomplete:present=${present.length}:expected=${inventory.testFileCount}:missing=${missing.slice(0, MAX_LISTED_MISSING).join(",")}`,
  );
}

export { TEST_ARTIFACT_INVENTORY, TEST_ARTIFACT_INVENTORY_SCHEMA };
