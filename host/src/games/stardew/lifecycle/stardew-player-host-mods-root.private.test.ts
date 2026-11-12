import assert from "node:assert/strict";
import { lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  admitGameRootForTesting,
  admissionChainFor,
  createHarness,
  createRoot,
  createStageBPackage,
  ownerTestView,
  stageCStageB,
  stageCStaging,
} from "./stardew-private-bootstrap-composer.test-fixtures.js";
import { launchStagedPlayerHostForTesting } from "./stardew-private-bootstrap-composer.test-support.js";

/**
 * The Player Host's SMAPI profile root is what `--mods-path` points at, so it is
 * the WHOLE set of Mods the game loads: SMAPI ignores the game folder's own
 * `Mods` the moment it is handed this path. A profile root that carries only the
 * staged GameBuddy Mod therefore starts the player's world with none of the
 * player's own Mods - content patches, UI mods, anything their save depends on -
 * while every launch fact still reads healthy.
 */
async function stagePlayerHostWithGameMods(
  populateGameMods: (gameMods: string) => Promise<void> = async (gameMods) => {
    await mkdir(join(gameMods, "ContentPatcher"), { recursive: true });
    await writeFile(join(gameMods, "ContentPatcher", "manifest.json"), '{"Name":"ContentPatcher"}', "utf8");
  },
): Promise<
  Readonly<{
    gameMods: string;
    profileMods: string;
    launch: () => Promise<Awaited<ReturnType<typeof launchStagedPlayerHostForTesting>>>;
    playerHostSpawnCalls: readonly Readonly<{ args: readonly string[] }>[];
  }>
> {
  const gameRoot = await createRoot("gamebuddy-mods-root-game-");
  const gameMods = join(gameRoot, "Mods");
  await mkdir(gameRoot, { recursive: true });
  await populateGameMods(gameMods);

  const harness = createHarness({ staging: stageCStaging(await createStageBPackage()) });
  const owner = await stageCStageB(harness, await createRoot());
  const transactionDirectory = ownerTestView(owner).transactionDirectory;
  const installation = await admitGameRootForTesting(gameRoot, [
    admissionChainFor(gameRoot),
    admissionChainFor(gameRoot),
    admissionChainFor(gameRoot),
  ]);
  return Object.freeze({
    gameMods,
    profileMods: join(transactionDirectory, "player-host", "Mods"),
    launch: () => launchStagedPlayerHostForTesting(owner, installation),
    playerHostSpawnCalls: harness.playerHostSpawnCalls,
  });
}

test("the launched Player Host's mods root carries the player's own Mods beside the staged Mod", async () => {
  const fixture = await stagePlayerHostWithGameMods();
  assert.deepEqual((await readdir(fixture.profileMods)).sort(), ["GameBuddy"]);

  const result = await fixture.launch();

  // The isolation ruling is unchanged: one root, handed over as `--mods-path`.
  const spawned = fixture.playerHostSpawnCalls[0];
  assert.deepEqual(spawned?.args, ["--mods-path", fixture.profileMods]);
  assert.deepEqual((await readdir(fixture.gameMods)).sort(), ["ContentPatcher"]);
  assert.deepEqual((await readdir(fixture.profileMods)).sort(), ["ContentPatcher", "GameBuddy"]);
  // Carried, not duplicated: the entry is a link into the player's own Mods.
  assert.equal((await lstat(join(fixture.profileMods, "ContentPatcher"))).isSymbolicLink(), true);
  assert.deepEqual(result.modsRoot, { kind: "carried", entries: ["ContentPatcher"], linkRefusals: [] });
});

test("a profile root that carries no player Mod is a named launch fact, not a silent launch", async () => {
  const fixture = await stagePlayerHostWithGameMods(async (gameMods) => {
    await mkdir(gameMods, { recursive: true });
  });

  const result = await fixture.launch();

  assert.deepEqual(result.modsRoot, { kind: "empty", reason: "player_mods_root_holds_only_staged_mod" });
  assert.deepEqual((await readdir(fixture.profileMods)).sort(), ["GameBuddy"]);
});

test("a game folder with no Mods yet is the named absent state, never a refusal", async () => {
  const fixture = await stagePlayerHostWithGameMods(async () => undefined);

  const result = await fixture.launch();

  assert.deepEqual(result.modsRoot, { kind: "empty", reason: "player_mods_root_absent" });
});

test("a launch whose profile root lost the staged Mod refuses instead of starting a Mod-less game", async () => {
  const fixture = await stagePlayerHostWithGameMods();
  await rm(join(fixture.profileMods, "GameBuddy"), { recursive: true });

  await assert.rejects(fixture.launch(), /stardew_player_host_mods_root_staged_mod_missing/);
  assert.deepEqual(fixture.playerHostSpawnCalls, []);
});

test("a player Mod that cannot be linked and cannot be copied names its own failure", async () => {
  const fixture = await stagePlayerHostWithGameMods(async (gameMods) => {
    await mkdir(gameMods, { recursive: true });
    await writeFile(join(gameMods, "LooseMod.dll"), "player-bytes", "utf8");
  });
  // The destination is taken by an entry this attempt did not write, so neither
  // the link nor the copy fallback can land.
  await writeFile(join(fixture.profileMods, "LooseMod.dll"), "occupied", "utf8");

  await assert.rejects(fixture.launch(), /mods_root_copy_failed:LooseMod\.dll/);
  assert.deepEqual(fixture.playerHostSpawnCalls, []);
});
