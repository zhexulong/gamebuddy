import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA = "gamebuddy-stardew-tool-inventory/v1";
const ALLOWED_TOP_LEVEL_KEYS = new Set(["schema", "governedPatterns", "entries", "pilotLegacyClosure"]);
const ALLOWED_ENTRY_KEYS = new Set(["path", "classification", "disposition", "futureProjectPath"]);
const ALLOWED_CLASSIFICATIONS = new Set([
  "canonical-scenario",
  "shared-runtime",
  "conformance-test",
  "replay-preflight",
  "diagnostic",
  "obsolete",
]);
const ALLOWED_DISPOSITIONS = new Set([
  "keep-project-local",
  "fold-into-stardew-runtime",
  "diagnostic-only",
  "delete-obsolete",
]);
const GOVERNED_PATH = /^tools\/(?:run|check|replay|prepare|restore)-stardew-[^/]+$/;
const EXPECTED_CLOSURE = Object.freeze([
  "tools/run-stardew-native-local-player-equip-tool-smoke.mjs",
  "tools/run-stardew-native-local-player-equip-tool-smoke.test.mjs",
  "tools/lib/stardew-native-smoke-harness-v1.mjs",
  "tools/lib/host-production-module.mjs",
  "host/scripts/production-artifact.mjs",
  "tools/run-stardew-native-local-player-move-fixture.ps1",
  "tools/lib/stardew-named-pipe-readiness.ps1",
  "tools/prepare-stardew-action-fixture.ps1",
  "tools/lib/stardew-native-local-player-fixture.mjs",
  "tools/stardew-native-local-player-fixture.test.mjs",
  "tools/stardew-action-gate-descriptors.mjs",
  "tools/stardew-action-gate-descriptors.test.mjs",
  "tools/resolve-stardew-action-gate-runner.mjs",
]);

function fail(code) {
  throw new Error(`stardew_action_tool_inventory_${code}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, allowed, code) {
  if (!isPlainObject(value)) fail(code);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${code}_unknown_key`);
  }
}

function assertSafePath(value, code) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.startsWith("/") || value.includes("//")) {
    fail(code);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) fail(code);
}

function caseFoldedUnique(paths, code) {
  const seen = new Set();
  for (const item of paths) {
    const folded = item.toLocaleLowerCase("en-US");
    if (seen.has(folded)) fail(code);
    seen.add(folded);
  }
}

function sameSet(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sortedUnique(paths) {
  return [...new Set(paths)].sort((a, b) => a.localeCompare(b));
}

export function readTrackedGovernedPaths(repositoryRoot) {
  let output;
  try {
    output = execFileSync("git", ["-C", repositoryRoot, "ls-files", "tools"], { encoding: "utf8" });
  } catch {
    fail("tracked_paths_unavailable");
  }
  return output.split(/\r?\n/).filter((entry) => GOVERNED_PATH.test(entry)).sort((a, b) => a.localeCompare(b));
}

export function validateToolInventory(inventory, { trackedPaths, repositoryRoot } = {}) {
  assertExactKeys(inventory, ALLOWED_TOP_LEVEL_KEYS, "invalid_top_level");
  if (inventory.schema !== SCHEMA || !Array.isArray(inventory.governedPatterns) || !Array.isArray(inventory.entries) || !Array.isArray(inventory.pilotLegacyClosure)) {
    fail("invalid_schema");
  }
  const patterns = inventory.governedPatterns;
  if (patterns.length === 0 || patterns.some((pattern) => typeof pattern !== "string" || !/^tools\/(?:run|check|replay|prepare|restore)-stardew-\*$/.test(pattern))) {
    fail("invalid_governed_patterns");
  }
  caseFoldedUnique(patterns, "governed_pattern_duplicate");

  const entries = inventory.entries;
  const entryPaths = [];
  const countsByClassification = {};
  const countsByDisposition = {};
  for (const entry of entries) {
    assertExactKeys(entry, ALLOWED_ENTRY_KEYS, "invalid_entry");
    if (!GOVERNED_PATH.test(entry.path)) fail("entry_path_not_governed");
    assertSafePath(entry.path, "entry_path_unsafe");
    assertSafePath(entry.futureProjectPath, "future_project_path_unsafe");
    if (!ALLOWED_CLASSIFICATIONS.has(entry.classification)) fail("classification_invalid");
    if (!ALLOWED_DISPOSITIONS.has(entry.disposition)) fail("disposition_invalid");
    entryPaths.push(entry.path);
    countsByClassification[entry.classification] = (countsByClassification[entry.classification] ?? 0) + 1;
    countsByDisposition[entry.disposition] = (countsByDisposition[entry.disposition] ?? 0) + 1;
  }
  caseFoldedUnique(entryPaths, "entry_path_duplicate");

  const actualTrackedPaths = trackedPaths ?? readTrackedGovernedPaths(repositoryRoot);
  if (!Array.isArray(actualTrackedPaths) || actualTrackedPaths.some((entry) => !GOVERNED_PATH.test(entry))) fail("tracked_path_invalid");
  caseFoldedUnique(actualTrackedPaths, "tracked_path_duplicate");
  const normalizedEntries = sortedUnique(entryPaths);
  const normalizedTracked = sortedUnique(actualTrackedPaths);
  if (!sameSet(normalizedEntries, normalizedTracked)) fail("coverage_mismatch");

  const closure = inventory.pilotLegacyClosure;
  if (closure.some((entry) => typeof entry !== "string")) fail("pilot_closure_invalid");
  for (const entry of closure) assertSafePath(entry, "pilot_closure_path_unsafe");
  caseFoldedUnique(closure, "pilot_closure_duplicate");
  if (!sameSet(closure, EXPECTED_CLOSURE)) fail("pilot_closure_expanded_or_changed");
  if (repositoryRoot && closure.some((entry) => !existsSync(path.join(repositoryRoot, entry)))) fail("pilot_closure_missing");

  return Object.freeze({
    schema: SCHEMA,
    fileCount: normalizedEntries.length,
    countsByClassification: Object.freeze(countsByClassification),
    countsByDisposition: Object.freeze(countsByDisposition),
    pilotLegacyClosureCount: closure.length,
  });
}

export function findRepositoryRoot(fromDirectory) {
  let current = path.resolve(fromDirectory);
  while (true) {
    if (existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) fail("repository_root_not_found");
    current = parent;
  }
}

function main() {
  const packageDirectory = path.dirname(fileURLToPath(import.meta.url));
  const projectDirectory = path.dirname(packageDirectory);
  const repositoryRoot = findRepositoryRoot(projectDirectory);
  const inventoryPath = path.join(projectDirectory, "tool-inventory.json");
  let inventory;
  try {
    inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
  } catch {
    fail("inventory_json_invalid");
  }
  process.stdout.write(`${JSON.stringify(validateToolInventory(inventory, { repositoryRoot }))}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
