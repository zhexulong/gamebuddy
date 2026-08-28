import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  STANDALONE_MANIFEST_SCHEMA,
  readStandaloneExtractionManifest,
  validateStandaloneExtractionManifest,
} from "../standalone-extraction-manifest.mjs";

const MANIFEST_URL = new URL("../standalone-extraction-manifest.json", import.meta.url);
const EXPECTED_BLOCKERS = [];

async function readManifest() {
  return JSON.parse(await readFile(MANIFEST_URL, "utf8"));
}

function assertRejected(candidate, code) {
  assert.throws(
    () => validateStandaloneExtractionManifest(candidate),
    new RegExp(`stardew_standalone_extraction_manifest_${code}`),
  );
}

test("reads the attested standalone manifest with no source-audit blockers", async () => {
  const report = await readStandaloneExtractionManifest();
  assert.equal(report.schema, STANDALONE_MANIFEST_SCHEMA);
  assert.equal(report.status, "standalone-ready");
  assert.equal(report.claim, "package-owned-deterministic-closure");
  assert.deepEqual(report.sourceAuditBlockerIds, EXPECTED_BLOCKERS);
  assert.deepEqual(report.entryIds, [
    "devkit-workspace-link",
    "stardew-contract-exporter-project",
    "stardew-core-source-closure",
    "stardew-scaffold-source-closure",
    "action-projection-source-closure",
    "package-owned-node-pnpm-pins",
    "package-owned-dotnet-pin",
    "package-owned-frozen-lockfile",
  ]);
  assert.equal(report.rootReadPolicy, "reject-former-monorepo-root");
  assert.equal(report.runtimeInputCount, 0);
});

test("accepts the exact package-owned dependency inventory without reading or writing dependencies", async () => {
  const manifest = await readManifest();
  const report = validateStandaloneExtractionManifest(manifest);
  assert.equal(report.packageOwnedPathCount, 10);
  assert.equal(manifest.package.devkit.source, "packed-artifact");
  assert.equal(manifest.package.devkit.specifier, "file:inputs/devkit/game-action-devkit-0.1.0.tgz");
  assert.equal(manifest.readPolicy.runtimeInputs.length, 0);
});

test("rejects unknown keys at the manifest and nested declaration boundaries", async () => {
  const manifest = await readManifest();
  const topLevelUnknown = structuredClone(manifest);
  topLevelUnknown.untrusted = true;
  assertRejected(topLevelUnknown, "manifest_unknown_key");

  const nestedUnknown = structuredClone(manifest);
  nestedUnknown.package.devkit.untrusted = true;
  assertRejected(nestedUnknown, "devkit_unknown_key");

  const entryUnknown = structuredClone(manifest);
  entryUnknown.entries[0].untrusted = true;
  assertRejected(entryUnknown, "entry_unknown_key");
});

test("rejects missing, unknown, and duplicate entries", async () => {
  const manifest = await readManifest();

  const missing = structuredClone(manifest);
  missing.entries.pop();
  assertRejected(missing, "entries_missing_or_extra");

  const unknown = structuredClone(manifest);
  unknown.entries[0].id = "unlisted-input";
  assertRejected(unknown, "entry_unknown");

  const duplicate = structuredClone(manifest);
  duplicate.entries[1].id = duplicate.entries[0].id;
  assertRejected(duplicate, "entry_duplicate");

  const duplicatePath = structuredClone(manifest);
  duplicatePath.entries[1].path = duplicatePath.entries[0].path;
  assertRejected(duplicatePath, "entry_path_duplicate");
});

test("rejects root tools, .ci, package.json, and Host paths", async () => {
  const manifest = await readManifest();

  const rootTools = structuredClone(manifest);
  rootTools.entries[0].path = "tools/run-stardew-action.mjs";
  assertRejected(rootTools, "root_tools_path_forbidden");

  const rootCi = structuredClone(manifest);
  rootCi.entries[1].path = ".ci/test-portfolio.json";
  assertRejected(rootCi, "root_ci_path_forbidden");

  const rootPackage = structuredClone(manifest);
  rootPackage.entries.find((entry) => entry.id === "package-owned-node-pnpm-pins").path = "package.json";
  assertRejected(rootPackage, "root_package_json_forbidden");

  const rootHost = structuredClone(manifest);
  rootHost.entries[2].projectPath = "Host/src/stardew-adapter.csproj";
  assertRejected(rootHost, "root_host_path_forbidden");
});

test("rejects workspace devkit declarations and non-packed artifact forms", async () => {
  const manifest = await readManifest();

  const workspace = structuredClone(manifest);
  workspace.package.devkit.specifier = "workspace:*";
  assertRejected(workspace, "devkit_workspace_link_forbidden");

  const workspaceRange = structuredClone(manifest);
  workspaceRange.package.devkit.specifier = "workspace:^0.1.0";
  assertRejected(workspaceRange, "devkit_workspace_link_forbidden");

  const registry = structuredClone(manifest);
  registry.package.devkit.specifier = "0.1.0";
  assertRejected(registry, "devkit_specifier_not_file");

  const unpacked = structuredClone(manifest);
  unpacked.entries[0].path = "inputs/devkit/package.json";
  assertRejected(unpacked, "devkit_artifact_path_invalid");
});

test("rejects escaping, absolute, and duplicate dependency paths", async () => {
  const manifest = await readManifest();

  const parentEscape = structuredClone(manifest);
  parentEscape.entries[1].path = "inputs/../ActionDevelopmentContractExport.csproj";
  assertRejected(parentEscape, "entry_path_escape");

  const absolute = structuredClone(manifest);
  absolute.entries[1].path = "/tmp/ActionDevelopmentContractExport.csproj";
  assertRejected(absolute, "entry_path_escape");

  const windowsAbsolute = structuredClone(manifest);
  windowsAbsolute.entries[1].path = "C:/ActionDevelopmentContractExport.csproj";
  assertRejected(windowsAbsolute, "entry_path_escape");

  const caseFoldedDuplicate = structuredClone(manifest);
  caseFoldedDuplicate.entries[2].projectPath = "inputs/stardew-contract-export/ActionDevelopmentContractExport.csproj";
  assertRejected(caseFoldedDuplicate, "entry_path_duplicate");
});

test("rejects live/runtime inputs and any attempt to widen the root read policy", async () => {
  const manifest = await readManifest();

  const runtime = structuredClone(manifest);
  runtime.readPolicy.runtimeInputs.push("save/profile.json");
  assertRejected(runtime, "runtime_inputs_forbidden");

  const liveEntry = structuredClone(manifest);
  liveEntry.entries[0].kind = "live-runtime-artifact";
  assertRejected(liveEntry, "entry_kind_invalid");

  const widenedRoot = structuredClone(manifest);
  widenedRoot.readPolicy.allowedRoot = ".";
  assertRejected(widenedRoot, "read_policy_allowed_root_invalid");

  const sourceRoot = structuredClone(manifest);
  sourceRoot.entries[1].path = "inputs/../../integrations/stardew/tests/ActionDevelopmentContractExport.csproj";
  assertRejected(sourceRoot, "entry_path_escape");
});

test("rejects altered ready status or fabricated blocker set", async () => {
  const manifest = await readManifest();

  const blocked = structuredClone(manifest);
  blocked.status = "blocked";
  assertRejected(blocked, "status_invalid");

  const auditBlocked = structuredClone(manifest);
  auditBlocked.sourceAudit.status = "blocked";
  assertRejected(auditBlocked, "source_audit_status_invalid");

  const fabricatedBlocker = structuredClone(manifest);
  fabricatedBlocker.sourceAudit.blockerIds.push("stale-blocker");
  assertRejected(fabricatedBlocker, "source_audit_blockers_missing_or_changed");
});
