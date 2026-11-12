import assert from "node:assert/strict";
import { mkdir, readdir, writeFile } from "node:fs/promises";
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
async function stagePlayerHostWithGameMods(): Promise<
  Readonly<{
    gameMods: string;
    profileMods: string;
    launch: () => Promise<{ status: { kind: string } }>;
    playerHostSpawnCalls: readonly Readonly<{ args: readonly string[] }>[];
  }>
> {
  const gameRoot = await createRoot("gamebuddy-mods-root-game-");
  const gameMods = join(gameRoot, "Mods");
  await mkdir(join(gameMods, "ContentPatcher"), { recursive: true });
  await writeFile(join(gameMods, "ContentPatcher", "manifest.json"), '{"Name":"ContentPatcher"}', "utf8");

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

  await fixture.launch();

  // The isolation ruling is unchanged: one root, handed over as `--mods-path`.
  const spawned = fixture.playerHostSpawnCalls[0];
  assert.deepEqual(spawned?.args, ["--mods-path", fixture.profileMods]);
  assert.deepEqual((await readdir(fixture.gameMods)).sort(), ["ContentPatcher"]);
  assert.deepEqual((await readdir(fixture.profileMods)).sort(), ["ContentPatcher", "GameBuddy"]);
});

test("a profile root that carries no player Mod is a named launch fact, not a silent launch", async () => {
  const fixture = await stagePlayerHostWithGameMods();

  const result = await fixture.launch();

  const reported = (result as unknown as { modsRoot?: unknown }).modsRoot;
  assert.deepEqual(reported, { kind: "carried", entries: ["ContentPatcher"] });
});
