import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertExactModDirectory,
  assertExactSmapiLaunch,
  assertProbeOnlyProfile,
  readFixtureManifest,
  runNavigationP4RuntimeProbe,
  validateProbeRunEnvironment,
  verifyLaunchedProcess,
} from "./run-stardew-navigation-p4-runtime-probe.mjs";

const payload = {
  artifactKind: "stardew_navigation_p4_runtime_attestation",
  schemaVersion: 2,
  state: "world_map_completed",
  detail: {
    general: {
      gameAssemblyVersion: "1.6.15.24356",
      inputDigest: "ef2f63a15e9f528cfa70dcf8602013d241503d308b8702b846578fbf76e4876a",
      ordinaryCurrentWorld: {
        playerPresent: true,
        currentLocationPresent: true,
        currentLocationIsMineShaft: false,
        canMove: true,
        multiplayer: false,
        masterGame: true,
      },
      nativeApi: {
        mapRegionGetAreasInvocations: 1,
        mapAreaGetTooltipsInvocations: 1,
        mapAreaGetWorldPositionsInvocations: 1,
        mapRegionLocationNameInvocations: 1,
        tokenParserInvocations: 1,
      },
      mineIdentity: true,
      mineWorldMapNameMatchesCanonical: true,
      mountainWorldMapBinding: true,
      mineWorldMapTooltipBinding: true,
      aggregates: { minesTooltipAreaCount: 1 },
      progressiveObservation: {
        sourceCorrelation: { targetAssemblyInputDigestMatchesP4A: true, sourceBinding: "p4a_target_digest_bound" },
        pageSize: 8,
        root: {
          nativeRegionCount: 2,
          pageCount: 1,
          pagesVisited: 1,
          sameGenerationReplay: "stable",
          traversalDigestSha256: "d".repeat(64),
          replayTraversalDigestSha256: "d".repeat(64),
        },
        areas: {
          configuredCount: 17,
          includedCount: 16,
          conditionExcludedCount: 1,
          emptyNodeCount: 0,
          pagesVisited: 3,
        },
        tooltips: {
          configuredInIncludedAreaCount: 56,
          visibleCount: 42,
          conditionExcludedCount: 14,
          knownVisibleCount: 42,
          unknownPresentationObservedCount: 0,
          emptyNodeCount: 0,
          pagesVisited: 6,
        },
        positions: {
          configuredInIncludedAreaCount: 67,
          visibleCount: 67,
          conditionExcludedCount: 0,
          sourceCorrelatedUniqueLeafCandidateCount: 57,
          unresolvedLeafCount: 4,
          nonUniqueLeafCount: 6,
          presentationOnlyLeafCount: 0,
          emptyNodeCount: 0,
          pagesVisited: 9,
        },
        pagination: { state: "exercised", boundedTraversalReplay: "stable" },
      },
      localeEvaluation: {
        currentLanguage: "en",
        mineDisplayTokenSha256: "b".repeat(64),
        mineDisplayTextSha256: "c".repeat(64),
        currentLocaleTokenParser: "resolved_redacted",
        fallbackLocale: "not_attempted_global_locale_immutable",
        visibleTooltipCount: 42,
        hiddenOrUnknownTooltipCount: 14,
        unknownTooltipPresentation: "unknown_or_condition_excluded_present",
      },
    },
  },
  mutationCount: 0,
  bridgeUsed: false,
  productionRefIssued: false,
  rawLabelsEmitted: false,
};
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
async function fixture(root) {
  const f = join(root, "fixture"),
    save = join(f, "GameBuddyFixtureTest_123");
  await mkdir(save, { recursive: true });
  await writeFile(join(save, "GameBuddyFixtureTest_123"), "safe");
  await writeFile(join(save, "SaveGameInfo"), "info");
  await writeFile(
    join(f, "fixture-manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      fixtureKind: "stardew_navigation_p4_ordinary_native_save",
      saveDirectoryName: "GameBuddyFixtureTest_123",
      files: [
        { path: "GameBuddyFixtureTest_123/GameBuddyFixtureTest_123", sha256: sha256("safe") },
        { path: "GameBuddyFixtureTest_123/SaveGameInfo", sha256: sha256("info") },
      ],
    }),
  );
  return f;
}
async function builds(root) {
  const game = join(root, "game"),
    probe = join(root, "probe"),
    loader = join(root, "loader");
  await Promise.all([mkdir(game), mkdir(probe), mkdir(loader)]);
  await writeFile(
    join(probe, "manifest.json"),
    JSON.stringify({ UniqueID: "zhexulong.GameBuddy.NavigationRuntimeProbe" }),
  );
  await writeFile(join(probe, "StardewNavigationRuntimeProbe.dll"), "probe");
  await writeFile(
    join(loader, "manifest.json"),
    JSON.stringify({ UniqueID: "zhexulong.GameBuddy.NavigationP4Loader" }),
  );
  await writeFile(join(loader, "StardewNavigationP4Loader.dll"), "loader");
  return { game, probe, loader };
}
const environment = (build, fixtureRoot, root) => ({
  APPDATA: join(root, "AppData"),
  GAMEBUDDY_STARDEW_GAME_PATH: build.game,
  GAMEBUDDY_NAVIGATION_P4_PROBE_BUILD_PATH: build.probe,
  GAMEBUDDY_NAVIGATION_P4_LOADER_BUILD_PATH: build.loader,
  GAMEBUDDY_NAVIGATION_P4_FIXTURE_ROOT: fixtureRoot,
  GAMEBUDDY_NAVIGATION_P4_SAVE_ROOT: join(root, "AppData", "StardewValley", "Saves"),
});
async function writeTerminal(args) {
  const profile = args[args.indexOf("-ModsPath") + 1],
    arm = JSON.parse(await readFile(join(profile, "GameBuddy.NavigationRuntimeProbe", "arm.json")));
  const key = process.env.GAMEBUDDY_NAVIGATION_P4_TRANSACTION_KEY;
  if (!key) throw new Error("test_transaction_key_missing");
  const integrityMac = createHmac("sha256", key)
    .update(`result|${arm.nonce}|${arm.transactionPath}|${arm.resultPath}|${JSON.stringify(payload)}`)
    .digest("hex");
  await writeFile(arm.resultPath, JSON.stringify({ nonce: arm.nonce, attestation: payload, integrityMac }));
}

test("environment, profile, fixture ownership, and launch identity reject invalid inputs", async () => {
  assert.throws(
    () =>
      validateProbeRunEnvironment({
        GAMEBUDDY_STARDEW_GAME_PATH: "E:/game",
        GAMEBUDDY_NAVIGATION_P4_PROBE_BUILD_PATH: "E:/probe",
        GAMEBUDDY_NAVIGATION_P4_FIXTURE_ROOT: "E:/fixture",
        GAMEBUDDY_NAVIGATION_P4_SAVE_ROOT: "E:/Saves",
      }),
    /loader_build_missing/,
  );
  assert.throws(
    () => assertExactSmapiLaunch("E:/other.exe", ["--mods-path", "E:/mods"], "E:/game", "E:/mods"),
    /identity/,
  );
  assert.doesNotThrow(() =>
    assertExactSmapiLaunch(
      "E:/game/StardewModdingAPI.exe",
      ["--mods-path", "E:/GameBuddy Probe/mod profile"],
      "E:/game",
      "E:/GameBuddy Probe/mod profile",
    ),
  );
  assert.throws(
    () =>
      verifyLaunchedProcess(
        {
          imagePath: "E:/game/StardewModdingAPI.exe",
          commandLine: ["--mods-path", "E:/GameBuddy Probe/mod profile", "--smapi-extra"],
        },
        "E:/game",
        "E:/GameBuddy Probe/mod profile",
      ),
    /identity/,
  );
  assert.throws(
    () => assertProbeOnlyProfile(["GameBuddy.NavigationP4Loader", "GameBuddy.NavigationRuntimeProbe", "GameBuddy"]),
    /not_exact/,
  );
  assert.throws(() => assertExactModDirectory(["manifest.json", "GameBuddy.dll"], ["manifest.json"]), /not_exact/);
  const root = await mkdtemp(join(tmpdir(), "p4-owned-"));
  await mkdir(join(root, "bad"));
  await assert.rejects(readFixtureManifest(root), /manifest/);
  await rm(root, { recursive: true, force: true });
});

test("transaction authenticates one terminal and cleans up its two-mod isolated profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "p4-test-")),
    build = await builds(root),
    owned = await fixture(root);
  let launched = 0;
  const result = await runNavigationP4RuntimeProbe({
    env: environment(build, owned, root),
    tempRoot: root,
    deadlineMs: 10_000,
    listProcesses: async () => [],
    launch: async (_script, args, launchEnv) => {
      launched++;
      const prior = process.env.GAMEBUDDY_NAVIGATION_P4_TRANSACTION_KEY;
      process.env.GAMEBUDDY_NAVIGATION_P4_TRANSACTION_KEY = launchEnv.GAMEBUDDY_NAVIGATION_P4_TRANSACTION_KEY;
      const profile = args[args.indexOf("-ModsPath") + 1];
      assert.deepEqual((await readdir(profile)).sort(), [
        "GameBuddy.NavigationP4Loader",
        "GameBuddy.NavigationRuntimeProbe",
      ]);
      const loaderInput = JSON.parse(
        await readFile(join(profile, "GameBuddy.NavigationP4Loader", "fixture-load.json"), "utf8"),
      );
      assert.equal(loaderInput.observedSaveSlot, "GameBuddyFixtureTest_123");
      assert.equal(Number.isSafeInteger(loaderInput.deadlineUnixMs), true);
      await writeTerminal(args);
      if (prior === undefined) delete process.env.GAMEBUDDY_NAVIGATION_P4_TRANSACTION_KEY;
      else process.env.GAMEBUDDY_NAVIGATION_P4_TRANSACTION_KEY = prior;
    },
  });
  assert.equal(launched, 1);
  assert.equal(result.validation.valid, true);
  await assert.rejects(
    readFile(join(root, "AppData", "StardewValley", "Saves", "GameBuddyFixtureTest_123", "SaveGameInfo")),
    /ENOENT/,
  );
  assert.deepEqual((await readdir(root)).sort(), ["AppData", "fixture", "game", "loader", "probe"]);
  await rm(root, { recursive: true, force: true });
});

test("source integrity failure still removes the nested transaction", async () => {
  const root = await mkdtemp(join(tmpdir(), "p4-cleanup-")),
    build = await builds(root),
    owned = await fixture(root);
  await assert.rejects(
    runNavigationP4RuntimeProbe({
      env: environment(build, owned, root),
      tempRoot: root,
      deadlineMs: 10_000,
      listProcesses: async () => [],
      launch: async (_script, args, launchEnv) => {
        const prior = process.env.GAMEBUDDY_NAVIGATION_P4_TRANSACTION_KEY;
        process.env.GAMEBUDDY_NAVIGATION_P4_TRANSACTION_KEY = launchEnv.GAMEBUDDY_NAVIGATION_P4_TRANSACTION_KEY;
        await writeTerminal(args);
        if (prior === undefined) delete process.env.GAMEBUDDY_NAVIGATION_P4_TRANSACTION_KEY;
        else process.env.GAMEBUDDY_NAVIGATION_P4_TRANSACTION_KEY = prior;
        await writeFile(join(owned, "GameBuddyFixtureTest_123", "GameBuddyFixtureTest_123"), "mutated");
      },
    }),
    /hash_mismatch/,
  );
  assert.deepEqual((await readdir(root)).sort(), ["AppData", "fixture", "game", "loader", "probe"]);
  await rm(root, { recursive: true, force: true });
});

test("reports terminal and fixture-integrity failures together after transaction cleanup", async () => {
  const root = await mkdtemp(join(tmpdir(), "p4-primary-")),
    build = await builds(root),
    owned = await fixture(root);
  let error;
  try {
    await runNavigationP4RuntimeProbe({
      env: environment(build, owned, root),
      tempRoot: root,
      deadlineMs: 10_000,
      listProcesses: async () => [],
      launch: async () => {
        await writeFile(join(owned, "GameBuddyFixtureTest_123", "GameBuddyFixtureTest_123"), "mutated");
        throw new Error("launcher_failed");
      },
    });
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof AggregateError);
  assert.match(error.message, /launcher_failed/);
  assert.match(error.message, /hash_mismatch/);
  assert.deepEqual((await readdir(root)).sort(), ["AppData", "fixture", "game", "loader", "probe"]);
  await rm(root, { recursive: true, force: true });
});
