import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  assertExactDirectory,
  assertExactSmapiLaunch,
  assertTransitionProfile,
  runNavigationTransitionCharacterization,
  validateTransitionRunEnvironment,
} from "./run-stardew-navigation-transition-characterization.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const pass = {
  schemaVersion: 1,
  terminalStatus: "passed",
  targetBuild: "1.6.15.24356",
  targetBinding: "tb1_7a1c9e0d22b4f6a1c3e5d7098a2b4c6e8d0f1a3c5d7e9f1a3b5c7d9e1f3a5b7c",
  methodAnchors: {
    warpResolver: "GameLocation.warps",
    doorResolver: "GameLocation.getWarpFromDoor",
    approachPlanner: "PathFindController",
    correlation: "IPlayerEvents.Warped",
  },
  observationScope: "current_source_only",
  opaqueEdgeIds: ["te1_91aF2bC3dE4f5a6b7c8d9e0f1A2B3c4D", "te1_02b4C6d8E0f2a3b4c5d6e7f8a9b0A1B2C"],
  permittedFamilyCounts: { ordinaryWarp: 1, ordinaryDoor: 1 },
  excludedFamilyCounts: { action: 0, touchAction: 0, modHook: 0, special: 0, m8: 0, missingIdentity: 0, unsafeApproach: 0 },
  dryPlanSafe: true,
  correlationApiShapeVerified: true,
  mutationCount: 0,
  executionReceiptCount: 0,
  fixtureCleanup: { restored: false, noStardewProcess: false, noSmapiProcess: false },
  predicateCode: "successful_characterization",
};

async function fixture(root) {
  const f = join(root, "fixture"), saveName = "GameBuddyFixtureTest_123", save = join(f, saveName);
  await mkdir(save, { recursive: true });
  await writeFile(join(save, saveName), "safe");
  await writeFile(join(save, "SaveGameInfo"), "info");
  await writeFile(join(f, "fixture-manifest.json"), JSON.stringify({
    schemaVersion: 1,
    fixtureKind: "stardew_navigation_transition_characterization",
    saveDirectoryName: saveName,
    files: [
      { path: `${saveName}/${saveName}`, sha256: sha256("safe") },
      { path: `${saveName}/SaveGameInfo`, sha256: sha256("info") },
    ],
  }));
  return f;
}
async function builds(root) {
  const game = join(root, "game"), probe = join(root, "probe"), loader = join(root, "loader");
  await Promise.all([mkdir(game), mkdir(probe), mkdir(loader)]);
  await writeFile(join(game, "StardewModdingAPI.exe"), "smapi");
  await writeFile(join(probe, "manifest.json"), JSON.stringify({ UniqueID: "zhexulong.GameBuddy.NavigationTransitionCharacterization" }));
  await writeFile(join(probe, "StardewNavigationTransitionCharacterization.dll"), "probe");
  await writeFile(join(loader, "manifest.json"), JSON.stringify({ UniqueID: "zhexulong.GameBuddy.NavigationP4Loader" }));
  await writeFile(join(loader, "StardewNavigationP4Loader.dll"), "loader");
  return { game, probe, loader };
}
const environment = (build, fixtureRoot, root, artifactPath) => ({
  APPDATA: join(root, "AppData"),
  GAMEBUDDY_STARDEW_GAME_PATH: build.game,
  GAMEBUDDY_NAVIGATION_TRANSITION_CHARACTERIZATION_PROBE_BUILD_PATH: build.probe,
  GAMEBUDDY_NAVIGATION_TRANSITION_CHARACTERIZATION_LOADER_BUILD_PATH: build.loader,
  GAMEBUDDY_NAVIGATION_TRANSITION_CHARACTERIZATION_FIXTURE_ROOT: fixtureRoot,
  GAMEBUDDY_NAVIGATION_TRANSITION_CHARACTERIZATION_SAVE_ROOT: join(root, "AppData", "StardewValley", "Saves"),
  GAMEBUDDY_NAVIGATION_TRANSITION_CHARACTERIZATION_ARTIFACT_PATH: artifactPath,
});
async function writeObservation(args, launchEnv) {
  const profile = args[args.indexOf("-ModsPath") + 1];
  const arm = JSON.parse(await readFile(join(profile, "GameBuddy.NavigationTransitionCharacterization", "arm.json")));
  const observation = JSON.stringify(pass);
  const integrityMac = createHmac("sha256", launchEnv.GAMEBUDDY_NAVIGATION_TRANSITION_CHARACTERIZATION_TRANSACTION_KEY)
    .update(`observation|${arm.nonce}|${arm.transactionPath}|${arm.observationPath}|${observation}`).digest("hex");
  await writeFile(arm.observationPath, JSON.stringify({ nonce: arm.nonce, observation, integrityMac }));
}

test("rejects incomplete environment and profile identity", async () => {
  assert.throws(() => validateTransitionRunEnvironment({ GAMEBUDDY_STARDEW_GAME_PATH: "E:/game" }), /probe_build_missing/);
  assert.throws(() => assertTransitionProfile(["GameBuddy.NavigationP4Loader"]), /not_exact/);
  assert.throws(() => assertExactDirectory(["manifest.json"], ["manifest.json", "probe.dll"]), /not_exact/);
  assert.throws(() => assertExactSmapiLaunch("E:/other.exe", ["--mods-path", "E:/mods"], "E:/game", "E:/mods"), /identity/);
});

test("authenticates observation, proves cleanup, and writes only the final artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "transition-runner-"));
  const build = await builds(root), fixtureRoot = await fixture(root), artifactPath = join(root, "artifact.json");
  let launchCount = 0;
  const result = await runNavigationTransitionCharacterization({
    env: environment(build, fixtureRoot, root, artifactPath),
    tempRoot: root,
    deadlineMs: 10_000,
    listProcesses: async () => [],
    launch: async (_script, args, launchEnv) => { launchCount++; await writeObservation(args, launchEnv); },
  });
  assert.equal(launchCount, 1);
  assert.equal(result.validation.valid, true, result.validation.errors.join(","));
  assert.deepEqual(result.artifact.fixtureCleanup, { restored: true, noStardewProcess: true, noSmapiProcess: true });
  assert.deepEqual(JSON.parse(await readFile(artifactPath, "utf8")), result.artifact);
  await assert.rejects(readFile(join(root, "AppData", "StardewValley", "Saves", "GameBuddyFixtureTest_123", "SaveGameInfo")), /ENOENT/);
  assert.deepEqual((await readdir(root)).sort(), ["AppData", "artifact.json", "fixture", "game", "loader", "probe"]);
  await rm(root, { recursive: true, force: true });
});

test("rejects missing terminal and still cleans transaction", async () => {
  const root = await mkdtemp(join(tmpdir(), "transition-missing-"));
  const build = await builds(root), fixtureRoot = await fixture(root);
  await assert.rejects(runNavigationTransitionCharacterization({
    env: environment(build, fixtureRoot, root, join(root, "artifact.json")),
    tempRoot: root,
    deadlineMs: 10_000,
    listProcesses: async () => [],
    launch: async () => {},
  }), /ENOENT|terminal/);
  assert.deepEqual((await readdir(root)).sort(), ["AppData", "fixture", "game", "loader", "probe"]);
  await rm(root, { recursive: true, force: true });
});

test("reports fixture hash failure instead of producing an artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "transition-integrity-"));
  const build = await builds(root), fixtureRoot = await fixture(root);
  await assert.rejects(runNavigationTransitionCharacterization({
    env: environment(build, fixtureRoot, root, join(root, "artifact.json")),
    tempRoot: root,
    deadlineMs: 10_000,
    listProcesses: async () => [],
    launch: async (_script, _args, launchEnv) => {
      await writeFile(join(fixtureRoot, "GameBuddyFixtureTest_123", "SaveGameInfo"), "changed");
      void launchEnv;
    },
  }), /hash_mismatch/);
  assert.equal((await readdir(root)).includes("artifact.json"), false);
  await rm(root, { recursive: true, force: true });
});
