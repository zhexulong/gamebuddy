import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertReadyTargetProfile, parseTargetProfileText } from "./profile.mjs";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXAMPLE_PROFILE = path.join(PACKAGE_ROOT, "profiles", "example.json");
const STATIC_BRIEF = path.join(PACKAGE_ROOT, "briefs", "equip_tool.static.json");
const PREFLIGHT_BRIEF = path.join(PACKAGE_ROOT, "briefs", "equip_tool.preflight.json");
const LEASE_NAME = ".gamebuddy-target-runtime-lease-v1";
const PROFILE_ERROR_SUFFIXES = new Set([
  "duplicate_key", "example_not_ready", "invalid_adapter_version", "invalid_fixture_transaction_root",
  "invalid_game_install_path", "invalid_game_version", "invalid_identity", "invalid_json", "invalid_mods_path",
  "invalid_native_client_config_file", "invalid_native_fixture_root", "invalid_release_dir", "invalid_runtime_lease_identity",
  "invalid_runtime_lease_root", "invalid_save_binding", "invalid_save_identity", "invalid_schema", "invalid_shape",
  "invalid_size", "invalid_smapi_version", "invalid_target_version", "invalid_template_identity", "invalid_timeout",
  "placeholder_not_ready", "profile_path_not_absolute",
]);
const RELEASE_BUNDLE_ERROR_CODES = new Set([
  "stardew_immutable_release_bundle_invalid_input",
  "stardew_immutable_release_bundle_manifest_identity_mismatch",
  "stardew_immutable_release_bundle_mods_path_untrusted",
  "stardew_immutable_release_bundle_path_overlap",
  "stardew_immutable_release_bundle_source_drift",
  "stardew_immutable_release_bundle_source_untrusted",
]);
const LIFECYCLE_PREFLIGHT_ERROR_CODES = new Set([
  "invalid_fixture_backup_name",
  "invalid_fixture_observed_save_slot",
  "invalid_native_local_fixture_action",
  "invalid_native_local_fixture_timeout",
  "native_local_fixture_absolute_paths_required",
  "native_local_fixture_action_policy_invalid",
  "native_local_fixture_appdata_unavailable",
  "native_local_fixture_backup_already_exists",
  "native_local_fixture_binding_invalid",
  "native_local_fixture_binding_not_unique",
  "native_local_fixture_bridge_config_invalid",
  "native_local_fixture_config_invalid",
  "native_local_fixture_save_root_required",
  "native_local_fixture_template_invalid",
  "native_local_fixture_topology_not_isolated",
  "native_local_fixture_transaction_locked",
  "native_local_fixture_working_save_exists",
]);
const readyProfiles = new WeakMap();

function publicProfileReason(error) {
  const match = typeof error?.message === "string" && /^stardew_action_profile_([a-z0-9_]{1,80})$/.exec(error.message);
  return match && PROFILE_ERROR_SUFFIXES.has(match[1]) ? match[1] : "profile_invalid";
}
function publicDependencyReason(error, allowedCodes, fallback) {
  return typeof error?.message === "string" && allowedCodes.has(error.message) ? error.message : fallback;
}

function blocked(...reasons) { return Object.freeze({ gameId: "stardew", actionId: "equip_tool", status: "preflight", state: "BLOCKED", ready: false, reasons: Object.freeze([...new Set(reasons)]) }); }

async function trustedDirectory(candidate) {
  const absolute = path.resolve(candidate);
  let current = path.parse(absolute).root;
  for (const segment of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) return false;
  }
  return (await lstat(absolute)).isDirectory() && await realpath(absolute) === absolute;
}
async function trustedFile(candidate) {
  const parent = path.dirname(candidate);
  return await trustedDirectory(parent) && (await lstat(candidate)).isFile() && !(await lstat(candidate)).isSymbolicLink() && await realpath(candidate) === candidate;
}
async function leaseUnheld(root) {
  try { await lstat(path.join(root, LEASE_NAME)); return false; } catch (error) { if (error?.code === "ENOENT") return true; throw error; }
}
const BUNDLE_FILES = Object.freeze([
  "GameBuddy.Stardew.dll",
  "GameBuddy.Stardew.Core.dll",
  "Raffinert.FuzzySharp.dll",
  "manifest.json",
  "GameBuddy.Stardew.deps.json",
]);
const BUNDLE_FILE_SET = new Set(BUNDLE_FILES);

function bundleFail(code) {
  throw new Error(`stardew_immutable_release_bundle_${code}`);
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function overlaps(left, right) {
  const leftRoot = path.parse(left).root;
  const rightRoot = path.parse(right).root;
  const sameRoot = process.platform === "win32"
    ? leftRoot.toLowerCase() === rightRoot.toLowerCase()
    : leftRoot === rightRoot;
  if (!sameRoot) return false;
  const relative = path.relative(left, right);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function trustedDirectoryWithDetails(candidate, code = "untrusted_directory") {
  const absolute = path.resolve(candidate);
  let current = path.parse(absolute).root;
  try {
    for (const segment of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      const details = await lstat(current);
      if (details.isSymbolicLink()) bundleFail(code);
    }
    const details = await lstat(absolute);
    if (!details.isDirectory() || details.isSymbolicLink() || await realpath(absolute) !== absolute) bundleFail(code);
    return Object.freeze({ absolute, details });
  } catch (error) {
    if (error?.message?.startsWith("stardew_immutable_release_bundle_")) throw error;
    bundleFail(code);
  }
}

async function exactEntries(directory, code) {
  let entries;
  try { entries = await readdir(directory); } catch (error) { bundleFail(code); }
  if (entries.length !== BUNDLE_FILES.length || entries.some((entry) => !BUNDLE_FILE_SET.has(entry))) bundleFail(code);
}

async function openTrustedSource(directory, directoryDetails, name) {
  const candidate = path.join(directory, name);
  let before;
  let handle;
  try {
    const currentDirectory = await lstat(directory);
    if (!sameFile(currentDirectory, directoryDetails) || !currentDirectory.isDirectory() || currentDirectory.isSymbolicLink()) bundleFail("source_drift");
    before = await lstat(candidate);
    if (!before.isFile() || before.isSymbolicLink()) bundleFail("source_untrusted");
    handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFile(before, opened)) bundleFail("source_drift");
    return { candidate, handle, opened };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error?.message?.startsWith("stardew_immutable_release_bundle_")) throw error;
    bundleFail("source_untrusted");
  }
}

async function digestTrustedBundle(directory, directoryDetails, code) {
  await exactEntries(directory, code);
  const hash = createHash("sha256");
  let manifest;
  for (const name of BUNDLE_FILES) {
    const source = await openTrustedSource(directory, directoryDetails, name);
    try {
      const bytes = await source.handle.readFile();
      if (bytes.length === 0) bundleFail(code);
      hash.update(Buffer.from(name, "utf8"));
      hash.update(Buffer.from([0]));
      hash.update(bytes);
      if (name === "manifest.json") {
        try { manifest = JSON.parse(bytes.toString("utf8")); }
        catch (error) { bundleFail(code); }
      }
      const afterHandle = await source.handle.stat();
      const afterPath = await lstat(source.candidate);
      if (!sameFile(source.opened, afterHandle) || !sameFile(source.opened, afterPath)
        || source.opened.size !== afterHandle.size || source.opened.mtimeNs !== afterHandle.mtimeNs
        || source.opened.ctimeNs !== afterHandle.ctimeNs) bundleFail(code);
    } finally { await source.handle.close().catch(() => {}); }
  }
  return Object.freeze({ digest: hash.digest("hex"), manifest });
}

async function inspectReleaseSource({ releaseDir, modsPath, expectedAdapterVersion }) {
  const source = await trustedDirectoryWithDetails(releaseDir, "source_untrusted");
  const mods = await trustedDirectoryWithDetails(modsPath, "mods_path_untrusted");
  const target = path.join(mods.absolute, "GameBuddy");
  if (overlaps(source.absolute, target) || overlaps(target, source.absolute)) bundleFail("path_overlap");
  const inspected = await digestTrustedBundle(source.absolute, source.details, "source_untrusted");
  const manifest = inspected.manifest;
  if (manifest?.Name !== "GameBuddy" || manifest?.UniqueID !== "zhexulong.GameBuddy"
    || manifest?.EntryDll !== "GameBuddy.Stardew.dll" || typeof manifest?.Version !== "string"
    || expectedAdapterVersion !== undefined && manifest.Version !== expectedAdapterVersion) bundleFail("manifest_identity_mismatch");
  return Object.freeze({ source, mods, target, digest: inspected.digest, adapterVersion: manifest.Version, files: BUNDLE_FILES.length });
}

export async function inspectExactReleaseBundle({ releaseDir, modsPath, expectedAdapterVersion } = {}) {
  if (![releaseDir, modsPath].every((value) => typeof value === "string" && path.isAbsolute(value) && !value.includes("\0"))) bundleFail("invalid_input");
  const inspected = await inspectReleaseSource({ releaseDir, modsPath, expectedAdapterVersion });
  return Object.freeze({ algorithm: "sha256", digest: inspected.digest, adapterVersion: inspected.adapterVersion, files: inspected.files });
}

export async function inspectEquipToolReleaseBundle(profile) {
  return await inspectExactReleaseBundle({
    releaseDir: profile.releaseDir,
    modsPath: profile.modsPath,
    expectedAdapterVersion: profile.adapterVersion,
  });
}
async function loadCanonicalDependencies() {
  const [fixture, nativeFixture, installation] = await Promise.all([
    import("../../../../tools/lib/stardew-fixture-profile.mjs"),
    import("../../../../tools/lib/stardew-native-local-player-fixture.mjs"),
    import("../../../../tools/create-stardew-portfolio-installation-attestation.mjs"),
  ]);
  return {
    inspectFixture: (profile) => fixture.inspectFixtureTransaction({ root: profile.fixtureTransactionRoot }),
    inspectLifecyclePreparation: async (profile) => {
      const candidates = [];
      for (const name of await readdir(profile.nativeFixtureRoot)) {
        if (!name.endsWith(".native-local-binding.json")) continue;
        const candidate = path.join(profile.nativeFixtureRoot, name);
        if (!await trustedFile(candidate)) continue;
        let binding;
        try { binding = JSON.parse(await readFile(candidate, "utf8")); } catch { continue; }
        if (binding?.observedSaveSlot === profile.saveIdentity) candidates.push(binding);
      }
      if (candidates.length !== 1) throw new Error("native_local_fixture_binding_not_unique");
      const appData = process.env.APPDATA;
      if (!appData || !path.isAbsolute(appData)) throw new Error("native_local_fixture_appdata_unavailable");
      return await nativeFixture.validateNativeLocalPlayerFixturePreparation({
        root: profile.nativeFixtureRoot,
        modsPath: profile.modsPath,
        releaseDir: profile.releaseDir,
        saveName: profile.saveIdentity,
        backupName: "native-local-equip-tool-fixture-backup",
        timeoutSeconds: Math.ceil(profile.timeoutMs / 1_000),
        action: "equip_tool",
        binding: candidates[0],
        stardewSaveRoot: path.join(appData, "StardewValley", "Saves"),
      });
    },
    inspectTarget: async (profile, bundle) => Object.freeze({
      ...await installation.inspectPortfolioTargetInstallation(profile.gameInstallPath),
      adapterVersion: bundle.adapterVersion,
    }),
  };
}

export async function preflightEquipTool({ invocation, dependencies }) {
  const reasons = [];
  if (invocation.actionId !== "equip_tool") return blocked("action_not_available");
  if (invocation.briefFile && path.resolve(invocation.briefFile) === STATIC_BRIEF) return blocked("static_brief_not_live");
  if (invocation.briefFile && path.resolve(invocation.briefFile) !== PREFLIGHT_BRIEF) return blocked("brief_identity_mismatch");
  try {
    const brief = JSON.parse(await readFile(PREFLIGHT_BRIEF, "utf8"));
    if (brief.schema !== "gamebuddy-stardew-action-preflight-brief/v1" || brief.gameId !== "stardew" || brief.actionId !== "equip_tool" || brief.stage !== "preflight" || brief.effect !== "read-only" || brief.scenario !== "native-local-equip-tool-preflight-v1" || Object.keys(brief).length !== 6) return blocked("brief_identity_mismatch");
  } catch { return blocked("brief_identity_mismatch"); }
  let profileText;
  if (!path.isAbsolute(invocation.profileFile ?? "")) return blocked("profile_path_not_absolute");
  try { profileText = await readFile(invocation.profileFile, "utf8"); }
  catch { return blocked("profile_unavailable"); }
  let profile;
  try {
    profile = assertReadyTargetProfile(parseTargetProfileText(profileText), { profileFile: invocation.profileFile, exampleProfileFile: EXAMPLE_PROFILE });
  } catch (error) { return blocked(publicProfileReason(error)); }
  try {
    const paths = [profile.gameInstallPath, profile.modsPath, profile.releaseDir, profile.fixtureTransactionRoot, profile.nativeFixtureRoot, profile.runtimeLeaseRoot];
    if (!(await Promise.all(paths.map(trustedDirectory))).every(Boolean) || !await trustedFile(profile.nativeClientConfigFile)) reasons.push("untrusted_path");
    if (path.resolve(profile.nativeClientConfigFile) !== path.resolve(profile.modsPath, "GameBuddy", "config.json")) reasons.push("native_client_config_mismatch");
    if (!await leaseUnheld(profile.runtimeLeaseRoot)) reasons.push("runtime_lease_held");
  } catch { reasons.push("target_path_unavailable"); }
  let bundle;
  if (reasons.length === 0) {
    try { bundle = await (dependencies?.inspectReleaseBundle ?? inspectEquipToolReleaseBundle)(profile); }
    catch (error) { reasons.push(publicDependencyReason(error, RELEASE_BUNDLE_ERROR_CODES, "release_bundle_invalid")); }
  }
  let deps = dependencies;
  if (!deps) { try { deps = await loadCanonicalDependencies(); } catch { reasons.push("preflight_dependency_unavailable"); } }
  if (deps && reasons.length === 0) {
    try {
      const target = await deps.inspectTarget(profile, bundle);
      if (target && (target.profileIdentity !== undefined && target.profileIdentity !== profile.profileIdentity || target.targetVersion !== undefined && target.targetVersion !== profile.targetVersion)) reasons.push("target_identity_mismatch");
      if (target && (target.gameVersion !== profile.gameVersion || target.smapiVersion !== profile.smapiVersion || target.adapterVersion !== profile.adapterVersion)) reasons.push("target_version_mismatch");
    } catch { reasons.push("target_identity_unavailable"); }
    try {
      const fixture = await deps.inspectFixture(profile);
      if (fixture?.mutationPerformed !== false || fixture?.transactionState !== "idle") reasons.push("fixture_not_idle");
    } catch { reasons.push("fixture_invalid"); }
    try {
      if (typeof deps.inspectLifecyclePreparation !== "function") reasons.push("lifecycle_preflight_unavailable");
      else {
        const lifecycle = await deps.inspectLifecyclePreparation(profile);
        if (lifecycle?.state !== "ready" || lifecycle.saveName !== profile.saveIdentity || lifecycle.workingSaveAbsent !== true)
          reasons.push("lifecycle_preflight_invalid");
      }
    } catch (error) {
      reasons.push(publicDependencyReason(error, LIFECYCLE_PREFLIGHT_ERROR_CODES, "lifecycle_preflight_invalid"));
    }
    const repositoryRoot = path.resolve(PACKAGE_ROOT, "../../..");
    const requiredLifecycleFiles = [
      path.join(repositoryRoot, "tools", "run-stardew-native-local-player-move-fixture.ps1"),
      path.join(repositoryRoot, "tools", "resolve-stardew-action-gate-runner.mjs"),
      path.join(PACKAGE_ROOT, "scenarios", "equip-tool-live-child.mjs"),
      path.join(PACKAGE_ROOT, "scenarios", "write-lifecycle-result.mjs"),
    ];
    try {
      if (!(await Promise.all(requiredLifecycleFiles.map(trustedFile))).every(Boolean)) reasons.push("lifecycle_files_unavailable");
    } catch { reasons.push("lifecycle_files_unavailable"); }
  }
  if (reasons.length) return blocked(...reasons);
  const report = Object.freeze({
    gameId: "stardew",
    actionId: "equip_tool",
    status: "preflight",
    state: "READY",
    ready: true,
    freshSnapshotCount: 0,
    reasons: Object.freeze([]),
    bundle,
  });
  readyProfiles.set(report, profile);
  return report;
}

export function consumeReadyEquipToolProfile(report) {
  const profile = readyProfiles.get(report);
  if (!profile) throw new Error("stardew_equip_tool_preflight_ready_binding_invalid");
  readyProfiles.delete(report);
  return profile;
}
