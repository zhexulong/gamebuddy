/*
 * The world a run starts in - and the one it must leave alone.
 *
 * What these assertions protect: `frontend--r25` could not measure a launch at all because every run had
 * been entering the same world, and each run permanently binds one more Cabin in it; by the eighth run the
 * farm had no free cabin pad and the panel answered 409 `stardew_player_host_cabin_missing` for sixty reads.
 * The fixture's answer is that a run creates its own world - which means moving exactly the saves that carry
 * the world name the PRODUCT asked for, and never touching a save of another name (the other lanes'
 * `GameBuddyFixture_*` worlds and the player's own farms carry other names).
 *
 * red-proof: inject  `prepareOwnWorld` moving every save folder it finds instead of only the requested farm
 *                   name: `✖ the run's own world is moved into the run root and every other world stays where
 *                   it is` fails on the player's own world, exit 1 (measured 2026-11-21).
 * red-proof: inject  returning `{ kind: "moved" }` when no staged request exists: `✖ a run that cannot name
 *                   its world refuses instead of entering whatever is there` fails, exit 1.
 * red-proof: inject  the `already_owned` marker read removed: `✖ the second driver in a run moves nothing
 *                   twice` moves the world a sibling lane wrote after this run claimed its own, exit 1.
 *
 * NOT RED-PROOFED, said plainly: `fixture_world_still_visible` (a save the delete could not remove and that
 * the game's own list can therefore still enter) has no reproducible trigger on this machine - `rmSync`
 * clears the read-only attribute, and an open handle is opened with share-delete - so its trigger is named in
 * `fixture-world.cjs` rather than pinned here.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// The kit is CommonJS beside the drivers it shares; `require` from an ESM test file is how every
// `capture/*.test.mjs` beside it reaches its subject when the subject is a `.cjs` module.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { describeOwnWorld, prepareOwnWorld } = require("./fixture-world.cjs");

/** The save info shape the game writes beside a save: only the one field this helper reads is populated. */
function saveInfo(farmName) {
  return `<?xml version="1.0" encoding="utf-8"?>\n<Farmer>\n  <farmName>${farmName}</farmName>\n  <name>GameBuddy</name>\n</Farmer>\n`;
}

/** One save folder as the game leaves it: a directory the project id names and a `SaveGameInfo` inside. */
function writeSave(savesRoot, slot, { farmName = null } = {}) {
  const directory = join(savesRoot, slot);
  mkdirSync(directory, { recursive: true });
  if (farmName !== null) writeFileSync(join(directory, "SaveGameInfo"), saveInfo(farmName), "utf8");
  writeFileSync(join(directory, slot), "<SaveGame />", "utf8");
  return directory;
}

/** The Player Host profile the composer stages, carrying the world name the product asked the Mod for. */
function writeStagedRequest(runRoot, { farmName = "GameBuddy Farm", enabled = true } = {}) {
  const declaredDataRoot = join(runRoot, "GameBuddy", "data");
  const mods = join(declaredDataRoot, "stardew-private-bootstrap", "bootstrap-1", "player-host", "Mods", "GameBuddy");
  mkdirSync(mods, { recursive: true });
  writeFileSync(
    join(mods, "config.json"),
    JSON.stringify({
      WorldCreation: { Enable: enabled, FarmName: farmName, PlayerName: "GameBuddy", CreateOnce: true },
    }),
    "utf8",
  );
  return declaredDataRoot;
}

/** A machine: an APPDATA holding the game's save folder, and a run root that keeps what it moves. */
function machine() {
  const root = mkdtempSync(join(tmpdir(), "fixture-world-"));
  const appData = join(root, "appdata");
  const savesRoot = join(appData, "StardewValley", "Saves");
  mkdirSync(savesRoot, { recursive: true });
  return {
    root,
    appData,
    savesRoot,
    runRoot: join(root, "run"),
    declaredDataRoot: join(root, "run", "GameBuddy", "data"),
  };
}

function prepare(world, options = {}) {
  process.env.APPDATA = world.appData;
  try {
    return prepareOwnWorld({ declaredDataRoot: world.declaredDataRoot, runRoot: world.runRoot, ...options });
  } finally {
    process.env.APPDATA = HOST_APPDATA;
  }
}

const HOST_APPDATA = process.env.APPDATA;

test("the run's own world is moved into the run root and every other world stays where it is", () => {
  const world = machine();
  world.declaredDataRoot = writeStagedRequest(world.runRoot);
  const ours = writeSave(world.savesRoot, "GameBuddyFarm_451234657", { farmName: "GameBuddy Farm" });
  // The player's own world and another lane's fixture world carry other names, and a run that moved them
  // would be destroying something it does not own on every launch.
  const player = writeSave(world.savesRoot, "MyFarm_1234", { farmName: "My Farm" });
  const otherLane = writeSave(world.savesRoot, "GameBuddyFixtureStable_451844580", {
    farmName: "GameBuddyFixtureStable",
  });

  const reading = prepare(world);

  assert.equal(reading.kind, "moved");
  assert.equal(reading.farmName, "GameBuddy Farm");
  assert.deepEqual(
    reading.moved.map((entry) => entry.slot),
    ["GameBuddyFarm_451234657"],
  );
  assert.equal(existsSync(ours), false, "a moved world must not stay visible to the game's own save list");
  assert.equal(existsSync(player), true, "the player's own world must stay where the game put it");
  assert.equal(existsSync(otherLane), true, "another lane's fixture world must stay where the game put it");
  assert.equal(
    readFileSync(join(world.runRoot, "fixture-worlds", "GameBuddyFarm_451234657", "SaveGameInfo"), "utf8").includes(
      "GameBuddy Farm",
    ),
    true,
  );
  // The population travels with the reading: "moved 1" says nothing without the number of folders examined.
  assert.equal(reading.examined, 3);
  assert.deepEqual(reading.kept.map((entry) => entry.slot).sort(), ["GameBuddyFixtureStable_451844580", "MyFarm_1234"]);
  assert.deepEqual(reading.remaining, []);
});

test("a run that cannot name its world refuses instead of entering whatever is there", () => {
  const world = machine();
  const ours = writeSave(world.savesRoot, "GameBuddyFarm_451234657", { farmName: "GameBuddy Farm" });

  const reading = prepare(world);

  assert.equal(reading.kind, "refused");
  assert.equal(reading.reason, "no_staged_world_request");
  assert.equal(existsSync(ours), true, "a refusal moves nothing");
  assert.match(describeOwnWorld(reading), /examined 1 save folder/u);
});

test("a world request the product disabled is not a world this run creates", () => {
  const world = machine();
  world.declaredDataRoot = writeStagedRequest(world.runRoot, { enabled: false });
  writeSave(world.savesRoot, "GameBuddyFarm_451234657", { farmName: "GameBuddy Farm" });

  const reading = prepare(world);

  assert.equal(reading.kind, "refused");
  assert.equal(reading.reason, "no_staged_world_request");
});

test("the second driver in a run moves nothing twice", () => {
  const world = machine();
  world.declaredDataRoot = writeStagedRequest(world.runRoot);
  writeSave(world.savesRoot, "GameBuddyFarm_451234657", { farmName: "GameBuddy Farm" });
  const first = prepare(world);
  assert.equal(first.kind, "moved");
  // A world that appears after the run claimed its own (a sibling lane's, say) is not this run's to move.
  const later = writeSave(world.savesRoot, "GameBuddyFarm_459999999", { farmName: "GameBuddy Farm" });

  const second = prepare(world);

  assert.equal(second.kind, "already_owned");
  assert.deepEqual(
    second.moved.map((entry) => entry.slot),
    ["GameBuddyFarm_451234657"],
  );
  assert.equal(existsSync(later), true);
});

test("a save whose identity cannot be read is left alone and reported", () => {
  const world = machine();
  world.declaredDataRoot = writeStagedRequest(world.runRoot);
  const unknown = writeSave(world.savesRoot, "GameBuddyFarm_451234657");

  const reading = prepare(world);

  assert.equal(reading.kind, "moved");
  assert.deepEqual(reading.moved, []);
  assert.deepEqual(reading.unreadable, [{ slot: "GameBuddyFarm_451234657", reason: "save_info_unreadable" }]);
  assert.equal(existsSync(unknown), true);
  assert.match(describeOwnWorld(reading), /nothing to move yet/u);
});

test("a save that cannot be copied is a refusal, and the save stays where it was", () => {
  const world = machine();
  world.declaredDataRoot = writeStagedRequest(world.runRoot);
  const ours = writeSave(world.savesRoot, "GameBuddyFarm_451234657", { farmName: "GameBuddy Farm" });
  // Make the copy impossible by pointing the run root at a path a file already occupies.
  mkdirSync(world.runRoot, { recursive: true });
  writeFileSync(join(world.runRoot, "fixture-worlds"), "not a directory", "utf8");

  const reading = prepare(world);

  assert.equal(reading.kind, "refused");
  assert.match(String(reading.reason), /^fixture_world_(copy_failed|marker_unwritable)/u);
  assert.equal(existsSync(ours), true, "nothing is deleted before the copy is verified");
});
