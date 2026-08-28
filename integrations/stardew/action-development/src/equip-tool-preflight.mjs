import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertReadyTargetProfile, parseTargetProfileText } from "./profile.mjs";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXAMPLE_PROFILE = path.join(PACKAGE_ROOT, "profiles", "example.json");
const STATIC_BRIEF = path.join(PACKAGE_ROOT, "briefs", "equip_tool.static.json");
const PREFLIGHT_BRIEF = path.join(PACKAGE_ROOT, "briefs", "equip_tool.preflight.json");
const LEASE_NAME = ".gamebuddy-target-runtime-lease-v1";
const readyProfiles = new WeakMap();

const BUNDLE_FILES = Object.freeze([
  "GameBuddy.Stardew.dll",
  "GameBuddy.Stardew.Core.dll",
  "manifest.json",
  "GameBuddy.Stardew.deps.json",
]);
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
function pathsOverlap(first, second) {
  const firstRoot = path.parse(first).root;
  const secondRoot = path.parse(second).root;
  if (process.platform === "win32") {
    if (firstRoot.toLowerCase() !== secondRoot.toLowerCase()) return false;
  } else if (firstRoot !== secondRoot) return false;
  const relative = path.relative(first, second);
  return relative === "" || (!path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`) && relative !== "..");
}
export async function inspectEquipToolReleaseBundle(profile) {
  const releaseRoot = await realpath(profile.releaseDir);
  const deployedRoot = await realpath(path.join(profile.modsPath, "GameBuddy"));
  if (pathsOverlap(releaseRoot, deployedRoot) || pathsOverlap(deployedRoot, releaseRoot)) throw new Error("release_target_overlap");
  const hash = createHash("sha256");
  let manifest;
  for (const name of BUNDLE_FILES) {
    const file = path.join(profile.releaseDir, name);
    if (!await trustedFile(file)) throw new Error("release_bundle_untrusted");
    const bytes = await readFile(file);
    if (bytes.length === 0) throw new Error("release_bundle_empty");
    hash.update(Buffer.from(name, "utf8"));
    hash.update(Buffer.from([0]));
    hash.update(bytes);
    if (name === "manifest.json") manifest = JSON.parse(bytes.toString("utf8"));
  }
  if (manifest?.Name !== "GameBuddy" || manifest?.UniqueID !== "zhexulong.GameBuddy" || manifest?.EntryDll !== "GameBuddy.Stardew.dll" || manifest?.Version !== profile.adapterVersion) throw new Error("release_manifest_identity_mismatch");
  return Object.freeze({ algorithm: "sha256", digest: hash.digest("hex"), adapterVersion: manifest.Version, files: BUNDLE_FILES.length });
}
async function loadCanonicalDependencies() {
  const [fixture, installation] = await Promise.all([
    import("../../../../tools/lib/stardew-fixture-profile.mjs"),
    import("../../../../tools/create-stardew-portfolio-installation-attestation.mjs"),
  ]);
  return {
    inspectFixture: (profile) => fixture.inspectFixtureTransaction({ root: profile.fixtureRoot }),
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
  let profile;
  try {
    if (!path.isAbsolute(invocation.profileFile ?? "")) return blocked("profile_path_not_absolute");
    profile = assertReadyTargetProfile(parseTargetProfileText(await readFile(invocation.profileFile, "utf8")), { profileFile: invocation.profileFile, exampleProfileFile: EXAMPLE_PROFILE });
  } catch (error) { return blocked(error?.message?.replace("stardew_action_profile_", "") || "profile_invalid"); }
  try {
    const paths = [profile.gameInstallPath, profile.modsPath, profile.releaseDir, profile.fixtureRoot, profile.runtimeLeaseRoot];
    if (!(await Promise.all(paths.map(trustedDirectory))).every(Boolean) || !await trustedFile(profile.nativeClientConfigFile)) reasons.push("untrusted_path");
    if (path.resolve(profile.nativeClientConfigFile) !== path.resolve(profile.modsPath, "GameBuddy", "config.json")) reasons.push("native_client_config_mismatch");
    if (!await leaseUnheld(profile.runtimeLeaseRoot)) reasons.push("runtime_lease_held");
  } catch { reasons.push("target_path_unavailable"); }
  let bundle;
  if (reasons.length === 0) {
    try { bundle = await inspectEquipToolReleaseBundle(profile); }
    catch (error) { reasons.push(error?.message || "release_bundle_invalid"); }
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
