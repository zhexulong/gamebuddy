import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const STANDALONE_MANIFEST_SCHEMA = "gamebuddy-stardew-standalone-extraction/v1";
export const STANDALONE_MANIFEST_PATH = fileURLToPath(new URL("./standalone-extraction-manifest.json", import.meta.url));

const SOURCE_AUDIT_SCHEMA = "gamebuddy-stardew-extraction-audit/v1";
const ALLOWED_ROOT = "inputs";
const FORBIDDEN_ROOT_DIRECTORIES = Object.freeze(["tools", ".ci", "host"]);
const FORBIDDEN_ROOT_FILES = Object.freeze(["package.json"]);
const EXPECTED_SOURCE_AUDIT_BLOCKERS = Object.freeze([]);
const EXPECTED_ENTRY_IDS = Object.freeze([
  "devkit-workspace-link",
  "stardew-contract-exporter-project",
  "stardew-core-source-closure",
"stardew-scaffold-source-closure",
"action-projection-source-closure",
"package-owned-node-pnpm-pins",
  "package-owned-dotnet-pin",
  "package-owned-frozen-lockfile",
]);

function fail(code) {
  throw new Error(`stardew_standalone_extraction_manifest_${code}`);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, allowed, code) {
  if (!isPlainObject(value)) fail(`${code}_shape`);
  const keys = Object.keys(value);
  if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) fail(`${code}_unknown_key`);
}

function nonEmptyString(value, code) {
  if (typeof value !== "string" || value.length === 0) fail(code);
}

function exactStringArray(value, expected, code) {
  if (!Array.isArray(value) || value.length !== expected.length || value.some((item, index) => item !== expected[index])) {
    fail(code);
  }
}

function uniqueCaseFolded(values, code) {
  const seen = new Set();
  for (const value of values) {
    const folded = value.toLocaleLowerCase("en-US");
    if (seen.has(folded)) fail(code);
    seen.add(folded);
  }
}

function safePath(value, code) {
  nonEmptyString(value, code);
  if (
    value.includes("\\")
    || value.includes("\0")
    || value.includes(":")
    || value.startsWith("/")
    || value.startsWith("//")
  ) {
    fail(`${code}_escape`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) fail(`${code}_escape`);
  return segments;
}

function packageOwnedPath(value, code) {
  const segments = safePath(value, code);
  const folded = value.toLocaleLowerCase("en-US");
  if (folded === "package.json") fail("root_package_json_forbidden");
  if (folded === "tools" || folded.startsWith("tools/")) fail("root_tools_path_forbidden");
  if (folded === ".ci" || folded.startsWith(".ci/")) fail("root_ci_path_forbidden");
  if (folded === "host" || folded.startsWith("host/")) fail("root_host_path_forbidden");
  if (segments.length < 2 || segments[0] !== ALLOWED_ROOT) fail(`${code}_not_package_owned`);
  return value;
}

function validateSourceAudit(input) {
  exactKeys(input, new Set(["schema", "status", "blockerIds"]), "source_audit");
  if (input.schema !== SOURCE_AUDIT_SCHEMA) fail("source_audit_schema_invalid");
  if (input.status !== "standalone-ready") fail("source_audit_status_invalid");
  exactStringArray(input.blockerIds, EXPECTED_SOURCE_AUDIT_BLOCKERS, "source_audit_blockers_missing_or_changed");
  uniqueCaseFolded(input.blockerIds, "source_audit_blocker_duplicate");
}

function validateReadPolicy(input) {
  exactKeys(input, new Set(["mode", "allowedRoot", "forbiddenRootDirectories", "forbiddenRootFiles", "runtimeInputs"]), "read_policy");
  if (input.mode !== "reject-former-monorepo-root") fail("read_policy_mode_invalid");
  if (input.allowedRoot !== ALLOWED_ROOT) fail("read_policy_allowed_root_invalid");
  exactStringArray(input.forbiddenRootDirectories, FORBIDDEN_ROOT_DIRECTORIES, "read_policy_forbidden_directories_missing_or_changed");
  exactStringArray(input.forbiddenRootFiles, FORBIDDEN_ROOT_FILES, "read_policy_forbidden_files_missing_or_changed");
  uniqueCaseFolded(input.forbiddenRootDirectories, "read_policy_forbidden_directory_duplicate");
  uniqueCaseFolded(input.forbiddenRootFiles, "read_policy_forbidden_file_duplicate");
  if (!Array.isArray(input.runtimeInputs) || input.runtimeInputs.length !== 0) fail("runtime_inputs_forbidden");
}

function commonEntry(entry, keys, expectedKind, expectedSource) {
  exactKeys(entry, new Set(keys), "entry");
  if (entry.kind !== expectedKind) fail("entry_kind_invalid");
  if (entry.owner !== "standalone-package") fail("entry_owner_invalid");
  if (entry.required !== true) fail("entry_required_invalid");
  if (entry.source !== expectedSource) fail("entry_source_invalid");
}

function validateEntries(entries) {
  if (!Array.isArray(entries) || entries.length !== EXPECTED_ENTRY_IDS.length) fail("entries_missing_or_extra");
  const expectedIds = new Set(EXPECTED_ENTRY_IDS);
  const seenIds = new Set();
  const paths = [];
  let devkitEntry;

  function addUniquePath(value) {
    const folded = value.toLocaleLowerCase("en-US");
    if (paths.some((existing) => existing.toLocaleLowerCase("en-US") === folded)) fail("entry_path_duplicate");
    paths.push(value);
  }

  for (const entry of entries) {
    if (!isPlainObject(entry) || typeof entry.id !== "string") fail("entry_shape");
    if (!expectedIds.has(entry.id)) fail("entry_unknown");
    if (seenIds.has(entry.id)) fail("entry_duplicate");
    seenIds.add(entry.id);

    if (entry.id === "devkit-workspace-link") {
      commonEntry(entry, ["id", "kind", "path", "owner", "required", "source"], "packed-devkit-artifact", "current-extraction-audit");
      packageOwnedPath(entry.path, "entry_path");
      addUniquePath(entry.path);
      if (entry.path !== "inputs/devkit/game-action-devkit-0.1.0.tgz") fail("devkit_artifact_path_invalid");
      if (!entry.path.endsWith(".tgz")) fail("devkit_artifact_not_packed");
      devkitEntry = entry;
    } else if (entry.id === "stardew-contract-exporter-project") {
      commonEntry(entry, ["id", "kind", "path", "owner", "required", "source"], "dotnet-contract-export-project", "current-extraction-audit");
      packageOwnedPath(entry.path, "entry_path");
      addUniquePath(entry.path);
      if (entry.path !== "inputs/stardew-contract-export/ActionDevelopmentContractExport.csproj") fail("contract_export_project_path_invalid");
    } else if (entry.id === "stardew-core-source-closure") {
      commonEntry(entry, ["id", "kind", "projectPath", "sourcePath", "recursive", "owner", "required", "source"], "dotnet-core-source-closure", "current-extraction-audit");
      packageOwnedPath(entry.projectPath, "core_project_path");
      addUniquePath(entry.projectPath);
      packageOwnedPath(entry.sourcePath, "core_source_path");
      addUniquePath(entry.sourcePath);
      if (entry.projectPath !== "inputs/stardew-core/GameBuddy.Stardew.Core.csproj") fail("core_project_path_invalid");
      if (entry.sourcePath !== "inputs/stardew-core/src/Core") fail("core_source_path_invalid");
      if (entry.recursive !== true) fail("core_source_closure_not_recursive");
    } else if (entry.id === "stardew-scaffold-source-closure") {
      commonEntry(entry, ["id", "kind", "projectPath", "sourcePath", "recursive", "owner", "required", "source"], "stardew-scaffold-source-closure", "design-95-task-11");
      packageOwnedPath(entry.projectPath, "scaffold_project_path");
      addUniquePath(entry.projectPath);
      packageOwnedPath(entry.sourcePath, "scaffold_source_path");
      addUniquePath(entry.sourcePath);
      if (entry.projectPath !== "inputs/stardew-scaffold/integrations/stardew/GameBuddy.Stardew.csproj") fail("scaffold_project_path_invalid");
      if (entry.sourcePath !== "inputs/stardew-scaffold/integrations/stardew") fail("scaffold_source_path_invalid");
if (entry.recursive !== true) fail("scaffold_source_closure_not_recursive");
} else if (entry.id === "action-projection-source-closure") {
commonEntry(entry, ["id", "kind", "sourcePath", "recursive", "owner", "required", "source"], "action-projection-source-closure", "design-95-task-7");
packageOwnedPath(entry.sourcePath, "projection_source_path");
addUniquePath(entry.sourcePath);
if (entry.sourcePath !== "inputs/action-projection-source") fail("projection_source_path_invalid");
if (entry.recursive !== true) fail("projection_source_closure_not_recursive");
} else if (entry.id === "package-owned-node-pnpm-pins") {
      commonEntry(entry, ["id", "kind", "path", "nodeEngine", "pnpmPackageManager", "owner", "required", "source"], "node-pnpm-pins", "design-95-task-11");
      packageOwnedPath(entry.path, "toolchain_path");
      addUniquePath(entry.path);
      if (entry.path !== "inputs/package.json") fail("package_manifest_path_invalid");
      if (typeof entry.nodeEngine !== "string" || !/^>=\d+\.\d+\.\d+ <\d+$/.test(entry.nodeEngine)) fail("node_pin_invalid");
      if (typeof entry.pnpmPackageManager !== "string" || !/^pnpm@\d+\.\d+\.\d+$/.test(entry.pnpmPackageManager)) fail("pnpm_pin_invalid");
    } else if (entry.id === "package-owned-dotnet-pin") {
      commonEntry(entry, ["id", "kind", "path", "field", "value", "owner", "required", "source"], "dotnet-sdk-pin", "design-95-task-11");
      packageOwnedPath(entry.path, "toolchain_path");
      addUniquePath(entry.path);
      if (entry.path !== "inputs/global.json") fail("global_json_path_invalid");
      if (entry.field !== "sdk.version") fail("dotnet_pin_field_invalid");
      if (typeof entry.value !== "string" || !/^\d+\.\d+\.\d+$/.test(entry.value)) fail("dotnet_pin_invalid");
    } else if (entry.id === "package-owned-frozen-lockfile") {
      commonEntry(entry, ["id", "kind", "path", "mode", "owner", "required", "source"], "frozen-lockfile", "design-95-task-11");
      packageOwnedPath(entry.path, "lockfile_path");
      addUniquePath(entry.path);
      if (entry.path !== "inputs/pnpm-lock.yaml") fail("lockfile_path_invalid");
      if (entry.mode !== "frozen") fail("lockfile_mode_invalid");
    }
  }

  if (seenIds.size !== expectedIds.size) fail("entry_missing");
  uniqueCaseFolded(paths, "entry_path_duplicate");
  return { entries, paths, devkitEntry };
}

function validatePackage(input, devkitEntry) {
  exactKeys(input, new Set(["name", "devkit"]), "package");
  if (input.name !== "@gamebuddy/stardew-action-development") fail("package_name_invalid");
  exactKeys(input.devkit, new Set(["name", "source", "artifactEntryId", "specifier", "forbiddenSpecifier"]), "devkit");
  if (input.devkit.name !== "@gamebuddy/game-action-devkit") fail("devkit_name_invalid");
  if (input.devkit.source !== "packed-artifact") fail("devkit_source_not_packed");
  if (input.devkit.artifactEntryId !== devkitEntry.id) fail("devkit_artifact_entry_invalid");
  if (input.devkit.forbiddenSpecifier !== "workspace:*") fail("devkit_workspace_blocker_missing");
  nonEmptyString(input.devkit.specifier, "devkit_specifier_invalid");
  if (input.devkit.specifier === "workspace:*" || input.devkit.specifier.startsWith("workspace:")) fail("devkit_workspace_link_forbidden");
  if (!input.devkit.specifier.startsWith("file:")) fail("devkit_specifier_not_file");
  const relativeArtifactPath = input.devkit.specifier.slice("file:".length);
  safePath(relativeArtifactPath, "devkit_specifier_path");
  if (relativeArtifactPath !== devkitEntry.path) fail("devkit_specifier_mismatch");
}

export function validateStandaloneExtractionManifest(input) {
  exactKeys(input, new Set(["schema", "status", "claim", "projectRoot", "sourceAudit", "package", "entries", "readPolicy"]), "manifest");
  if (input.schema !== STANDALONE_MANIFEST_SCHEMA) fail("schema_invalid");
  if (input.status !== "standalone-ready") fail("status_invalid");
  if (input.claim !== "package-owned-deterministic-closure") fail("claim_invalid");
  if (input.projectRoot !== "standalone") fail("project_root_invalid");

  validateSourceAudit(input.sourceAudit);
  const entryResult = validateEntries(input.entries);
  validatePackage(input.package, entryResult.devkitEntry);
  validateReadPolicy(input.readPolicy);

  return Object.freeze({
    schema: STANDALONE_MANIFEST_SCHEMA,
    status: "standalone-ready",
    claim: "package-owned-deterministic-closure",
    sourceAuditBlockerIds: Object.freeze([...EXPECTED_SOURCE_AUDIT_BLOCKERS]),
    entryIds: Object.freeze([...EXPECTED_ENTRY_IDS]),
    packageOwnedPathCount: entryResult.paths.length,
    rootReadPolicy: "reject-former-monorepo-root",
    runtimeInputCount: 0,
  });
}

export async function readStandaloneExtractionManifest() {
  let parsed;
  try {
    parsed = JSON.parse(await readFile(STANDALONE_MANIFEST_PATH, "utf8"));
  } catch {
    fail("manifest_unreadable");
  }
  return validateStandaloneExtractionManifest(parsed);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  readStandaloneExtractionManifest().then(
    (report) => process.stdout.write(`${JSON.stringify(report)}\n`),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
