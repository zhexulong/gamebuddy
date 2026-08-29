import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runActionProject } from "../src/project-adapter.mjs";

async function fixture(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "equip-preflight-"));
  try {
    for (const name of ["game", "game/Mods/GameBuddy", "release", "fixture-transaction", "native-fixture", "lease"]) await mkdir(path.join(root, name), { recursive: true });
    for (const [name, contents] of [
      ["GameBuddy.Stardew.dll", "mod"],
      ["GameBuddy.Stardew.Core.dll", "core"],
      ["Raffinert.FuzzySharp.dll", "fuzzy"],
      ["manifest.json", JSON.stringify({ Name: "GameBuddy", UniqueID: "zhexulong.GameBuddy", EntryDll: "GameBuddy.Stardew.dll", Version: "0.1.0" })],
      ["GameBuddy.Stardew.deps.json", "{}"],
    ]) await writeFile(path.join(root, "release", name), contents);
    const config = path.join(root, "game", "Mods", "GameBuddy", "config.json"); await writeFile(config, "{}");
    const profile = {
      schema: "gamebuddy-action-target-profile/v1", profileIdentity: "local-target", targetVersion: "stardew-1.6.15-smapi-4.1",
      gameInstallPath: path.join(root, "game"), modsPath: path.join(root, "game", "Mods"), releaseDir: path.join(root, "release"), fixtureTransactionRoot: path.join(root, "fixture-transaction"), nativeFixtureRoot: path.join(root, "native-fixture"),
      saveIdentity: "GameBuddyFixtureEquipTool_123456789", templateIdentity: "GameBuddyFixtureEquipTool_123456789", gameVersion: "1.6.15", smapiVersion: "4.1.10", adapterVersion: "0.1.0",
      runtimeLeaseRoot: path.join(root, "lease"), runtimeLeaseIdentity: "equip-tool-local", timeoutMs: 30000, nativeClientConfigFile: config,
    };
    const profileFile = path.join(root, "profile.json"); await writeFile(profileFile, JSON.stringify(profile));
    await callback({ root, profile, profileFile });
  } finally {
    const fs = await import("node:fs/promises");
    const pending = [{ candidate: root, visited: false }];
    let passes = 0;
    while (pending.length) {
      if (++passes > 10_000) throw new Error("equip_preflight_cleanup_limit_exceeded");
      const item = pending.pop();
      const metadata = await fs.lstat(item.candidate);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) { await unlink(item.candidate); continue; }
      if (!item.visited) {
        pending.push({ candidate: item.candidate, visited: true });
        for (const name of await fs.readdir(item.candidate)) pending.push({ candidate: path.join(item.candidate, name), visited: false });
      } else await rmdir(item.candidate);
    }
  }
}
const snapshot = { revision: 1, observedAt: new Date().toISOString(), actionable: true, activeExecution: null, capabilities: ["equip_tool"], toolSlots: [{ slot: 0, label: "Axe" }], currentTool: "Hoe" };
function deps(overrides = {}) {
  const calls = { observe: 0, execute: 0, acquire: 0, write: 0 };
  const client = { state: { connected: true, authenticated: true }, execute() { calls.execute++; } };
  return { calls, value: {
    inspectTarget: async (p, bundle) => ({ gameVersion: p.gameVersion, smapiVersion: p.smapiVersion, adapterVersion: bundle.adapterVersion }),
    inspectFixture: async () => ({ transactionState: "idle", mutationPerformed: false }),
    inspectLifecyclePreparation: async (profile) => ({ state: "ready", saveName: profile.saveIdentity, workingSaveAbsent: true }),
    connect: async () => ({ client, scope: { integrationId: "stardew", saveId: "s", worldId: "w", playerId: "p", companionId: "c" }, close() {} }),
    observeFresh: async () => { calls.observe++; return snapshot; }, readPublishedActionIds: async () => ["equip_tool"], ...overrides,
  }};
}
async function run(profileFile, dependencies, extra = {}) {
  return runActionProject({ manifest: { gameId: "stardew" }, invocation: { command: "preflight", actionId: "equip_tool", profileFile, ...extra }, dependencies });
}

test("live child performs read-only admission after connection and before execute scenario", async () => {
  const child = await readFile(new URL("../scenarios/equip-tool-live-child.mjs", import.meta.url), "utf8");
  const connect = child.indexOf("connectNativeLocalClient(config)");
  const admission = child.indexOf("runEquipToolReadOnlyPreflight", connect);
  const smoke = child.indexOf("runEquipToolSmoke", admission);
  assert.ok(connect >= 0 && connect < admission && admission < smoke);
  assert.match(child.slice(admission, smoke), /state !== "READY"/);
});

test("static preflight validates package and target inputs without any bridge connection", async () => fixture(async ({ profile, profileFile }) => {
  let connections = 0;
  const observedRoots = [];
  const d = deps({
    inspectFixture: async (candidate) => { observedRoots.push(["transaction", candidate.fixtureTransactionRoot]); return { transactionState: "idle", mutationPerformed: false }; },
    inspectLifecyclePreparation: async (candidate) => { observedRoots.push(["native", candidate.nativeFixtureRoot]); return { state: "ready", saveName: candidate.saveIdentity, workingSaveAbsent: true }; },
    connect: async () => { connections++; throw new Error("static_preflight_must_not_connect"); },
  });
  const report = await run(profileFile, d.value);
  assert.equal(report.state, "READY");
  assert.equal(report.freshSnapshotCount, 0);
  assert.deepEqual(report.bundle, { algorithm: "sha256", digest: report.bundle.digest, adapterVersion: "0.1.0", files: 5 });
  assert.match(report.bundle.digest, /^[a-f0-9]{64}$/);
  assert.equal(connections, 0);
  assert.deepEqual(observedRoots, [["transaction", profile.fixtureTransactionRoot], ["native", profile.nativeFixtureRoot]]);
  assert.deepEqual(d.calls, { observe: 0, execute: 0, acquire: 0, write: 0 });
}));

test("static preflight blocks held lease, non-idle fixture, and target version drift", async () => fixture(async ({ root, profileFile }) => {
  await mkdir(path.join(root, "lease", ".gamebuddy-target-runtime-lease-v1"));
  assert.deepEqual((await run(profileFile, deps().value)).reasons, ["runtime_lease_held"]);
  await rmdir(path.join(root, "lease", ".gamebuddy-target-runtime-lease-v1"));
  assert.deepEqual((await run(profileFile, deps({ inspectFixture: async () => ({ transactionState: "locked", mutationPerformed: false }) }).value)).reasons, ["fixture_not_idle"]);
  assert.deepEqual((await run(profileFile, deps({ inspectTarget: async () => ({ gameVersion: "wrong" }) }).value)).reasons, ["target_version_mismatch"]);
  assert.deepEqual((await run(profileFile, deps({ inspectTarget: async (p) => ({ profileIdentity: "wrong", targetVersion: p.targetVersion, gameVersion: p.gameVersion, smapiVersion: p.smapiVersion, adapterVersion: p.adapterVersion }) }).value)).reasons, ["target_identity_mismatch"]);
}));

test("profile read and parse failures expose only bounded public reasons", async () => fixture(async ({ root }) => {
  const missingProfile = path.join(root, "missing-private-profile.json");
  const missingReport = await run(missingProfile, deps().value);
  assert.deepEqual(missingReport.reasons, ["profile_unavailable"]);
  assert.doesNotMatch(JSON.stringify(missingReport), /ENOENT|no such file|missing-private-profile|equip-preflight-/i);

  const malformedProfile = path.join(root, "malformed-private-profile.json");
  const rawMalformedText = '{"schema":"private-json-marker"';
  await writeFile(malformedProfile, rawMalformedText);
  const malformedReport = await run(malformedProfile, deps().value);
  assert.deepEqual(malformedReport.reasons, ["invalid_json"]);
  assert.doesNotMatch(JSON.stringify(malformedReport), /private-json-marker|malformed-private-profile|equip-preflight-/i);
}));

test("refuses relative/example/placeholder profiles and static brief", async () => fixture(async ({ profile, profileFile }) => {
  assert.deepEqual((await run("relative.json", deps().value)).reasons, ["profile_path_not_absolute"]);
  const placeholder = path.join(path.dirname(profileFile), "placeholder.json"); await writeFile(placeholder, JSON.stringify({ ...profile, profileIdentity: "example-placeholder" }));
  assert.deepEqual((await run(placeholder, deps().value)).reasons, ["placeholder_not_ready"]);
  const staticBrief = fileURLToPath(new URL("../briefs/equip_tool.static.json", import.meta.url));
  assert.deepEqual((await run(profileFile, deps().value, { briefFile: staticBrief })).reasons, ["static_brief_not_live"]);
  assert.deepEqual((await run(profileFile, deps().value, { briefFile: profileFile })).reasons, ["brief_identity_mismatch"]);
}));

test("rejects invalid release bundles and release/deployment overlap", async () => fixture(async ({ root, profile, profileFile }) => {
  await writeFile(path.join(root, "release", "manifest.json"), JSON.stringify({ Name: "GameBuddy", UniqueID: "zhexulong.GameBuddy", EntryDll: "GameBuddy.Stardew.dll", Version: "wrong" }));
  assert.deepEqual((await run(profileFile, deps().value)).reasons, ["stardew_immutable_release_bundle_manifest_identity_mismatch"]);
  await writeFile(profileFile, JSON.stringify({ ...profile, releaseDir: path.join(root, "game", "Mods", "GameBuddy") }));
  for (const [name, contents] of [
     ["GameBuddy.Stardew.dll", "mod"], ["GameBuddy.Stardew.Core.dll", "core"], ["Raffinert.FuzzySharp.dll", "fuzzy"],
     ["manifest.json", JSON.stringify({ Name: "GameBuddy", UniqueID: "zhexulong.GameBuddy", EntryDll: "GameBuddy.Stardew.dll", Version: "0.1.0" })],
    ["GameBuddy.Stardew.deps.json", "{}"],
  ]) await writeFile(path.join(root, "game", "Mods", "GameBuddy", name), contents);
  assert.deepEqual((await run(profileFile, deps().value)).reasons, ["stardew_immutable_release_bundle_path_overlap"]);
}));

test("release inspector exceptions expose only explicitly allowed bounded codes", async () => fixture(async ({ profileFile }) => {
  for (const privateMessage of ["private release path C:/Users/player/save", "identifier_shaped_private_release_error"]) {
    const report = await run(profileFile, deps({ inspectReleaseBundle: async () => { throw new Error(privateMessage); } }).value);
    assert.deepEqual(report.reasons, ["release_bundle_invalid"]);
    assert.doesNotMatch(JSON.stringify(report), /private release path|identifier_shaped_private_release_error|Users|player\/save/);
  }
}));

test("lifecycle preparation exceptions expose only explicitly allowed bounded codes", async () => fixture(async ({ profileFile }) => {
  for (const privateMessage of ["private lifecycle path C:/Users/player/save", "identifier_shaped_private_lifecycle_error"]) {
    const report = await run(profileFile, deps({ inspectLifecyclePreparation: async () => { throw new Error(privateMessage); } }).value);
    assert.deepEqual(report.reasons, ["lifecycle_preflight_invalid"]);
    assert.doesNotMatch(JSON.stringify(report), /private lifecycle path|identifier_shaped_private_lifecycle_error|Users|player\/save/);
  }
  const known = await run(profileFile, deps({ inspectLifecyclePreparation: async () => { throw new Error("native_local_fixture_transaction_locked"); } }).value);
  assert.deepEqual(known.reasons, ["native_local_fixture_transaction_locked"]);
}));

test("rejects secret/endpoint fields and untrusted or missing paths", async (t) => fixture(async ({ root, profile, profileFile }) => {
  await writeFile(profileFile, JSON.stringify({ ...profile, bridgeToken: "secret" }));
  assert.deepEqual((await run(profileFile, deps().value)).reasons, ["invalid_shape"]);
  await writeFile(profileFile, JSON.stringify({ ...profile, gameInstallPath: path.join(root, "missing") }));
  assert.deepEqual((await run(profileFile, deps().value)).reasons, ["target_path_unavailable"]);
  if (process.platform !== "win32") {
    const link = path.join(root, "link"); await import("node:fs/promises").then((fs) => fs.symlink(path.join(root, "game"), link));
    await writeFile(profileFile, JSON.stringify({ ...profile, gameInstallPath: link }));
    assert.deepEqual((await run(profileFile, deps().value)).reasons, ["untrusted_path"]);
  } else t.diagnostic("symlink case covered on non-Windows test hosts");
}));
