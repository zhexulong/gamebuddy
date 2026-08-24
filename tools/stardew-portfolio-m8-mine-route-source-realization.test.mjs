import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ANCHORS,
  deriveMapRealization,
  EXPECTED_MINE_ACTIONS,
  extractAnchors,
  mint,
  SNAPSHOT_INPUTS,
  TARGET,
  validateDossier,
  verify,
} from "./stardew-portfolio-m8-mine-route-source-realization.mjs";

const farmer = `protected virtual bool MovePositionImpl(
{
 Warp warp = Game1.currentLocation.isCollidingWithWarp(rectangle, this);
 warpFarmer(warp, direction);
}`;
const game1 = `public static void warpFarmer(LocationRequest locationRequest, int tileX, int tileY, int facingDirectionAfterWarp)
{ int warp_offset_x = nextFarmerWarpOffsetX; }`;
const location = `public virtual bool performAction(string[] action, Farmer who, Location tileLocation)
{ switch (action[0]) { case "Mine": return true; } }`;
const sources = () => ({
  "StardewValley/Farmer.cs": Buffer.from(farmer),
  "StardewValley/Game1.cs": Buffer.from(game1),
  "StardewValley/GameLocation.cs": Buffer.from(location),
});
const map = () => ({
  state: "probed",
  mapAsset: "Maps/Mine",
  mapFile: "Content/Maps/Mine.xnb",
  mapXnbSha256: "a8669be89fd338360bbe637df3c383f3dc5f0d50b1028ad7385aeb39f6e700ff",
  actions: [
    { layer: "Buildings", x: 23, y: 9, action: "Mine" },
    { layer: "Buildings", x: 67, y: 9, action: "Mine 77377" },
  ],
});
function dossier() {
  const mapRealization = deriveMapRealization(map());
  return {
    schemaVersion: 2,
    artifactKind: "portfolio_m8_route_source_map_realization",
    realizationId: "portfolio_m8_mine_route_source_realization_v2",
    actionId: "enter_mine",
    topology: "single_player_native_companion",
    target: TARGET,
    sourceManifest: { csharpFileCount: 3, canonicalSha256: "a".repeat(64) },
    mapRealization,
    anchors: extractAnchors(sources()),
    conclusion: {
      status: "blocked",
      blocker:
        "Exact route-map producer missing: locked target assets establish the ordinary Maps/Mine Action producer but do not provide the exterior warp-chain facts or a deterministic normal-player final approach-pose producer.",
      nonClaim:
        "No reachability, route composition, bridge capability, live execution, receipt, publication, or live closure is claimed.",
    },
  };
}
test("map probe consumes the complete sorted Mine producer set and rejects additions or parameter drift", () => {
  assert.deepEqual(map().actions, EXPECTED_MINE_ACTIONS);
  assert.deepEqual(deriveMapRealization(map()).ordinaryProducer, { layer: "Buildings", x: 23, y: 9, action: "Mine" });
  const drift = map();
  drift.actions[1].action = "Mine 77378";
  assert.throws(() => deriveMapRealization(drift), /Mine producer set drifted/);
  const extra = map();
  extra.actions.push({ layer: "Buildings", x: 1, y: 1, action: "Mine 42" });
  assert.throws(() => deriveMapRealization(extra), /Mine producer set drifted/);
  const unsorted = map();
  unsorted.actions.reverse();
  assert.throws(() => deriveMapRealization(unsorted), /Mine producer set drifted/);
});
test("probe pins every loader input including ContentHashes.json before and after content loading", async () => {
  const source = await readFile(
    new URL("./stardew-portfolio-m8-mine-route-content-probe/MineRouteContentProbe.cs", import.meta.url),
    "utf8",
  );
  const hashes = SNAPSHOT_INPUTS.find((input) => input.relativeFileName === "Content/ContentHashes.json");
  assert.ok(hashes);
  const declaration = `["Content/ContentHashes.json"] = "${hashes.sha256}"`;
  assert.ok(source.includes(declaration));
  assert.ok(!source.replace(declaration, "").includes("Content/ContentHashes.json"));
  assert.ok(!source.replace(hashes.sha256, "0".repeat(64)).includes(hashes.sha256));
  assert.match(
    source,
    /expectedSnapshotFiles\.Any\(entry => VerifiedChild\(root, entry\.Key, entry\.Value\) is null\)/,
  );
  assert.equal((source.match(/AssertSnapshot\(root, expectedSnapshotFiles, before\);/g) ?? []).length, 2);
  assert.match(source, /text\.StartsWith\("Mine ", StringComparison\.Ordinal\)/);
  assert.doesNotMatch(source, /Mine 77377/);
});
test("source anchors reject missing and duplicate anchor needles", () => {
  assert.equal(extractAnchors(sources()).length, ANCHORS.length);
  const missing = sources();
  missing["StardewValley/Farmer.cs"] = Buffer.from(farmer.replace("warpFarmer(warp, direction);", ""));
  assert.throws(() => extractAnchors(missing), /anchor drift/);
  const duplicate = sources();
  duplicate["StardewValley/GameLocation.cs"] = Buffer.from(
    location.replace('case "Mine":', 'case "Mine": case "Mine":'),
  );
  assert.throws(() => extractAnchors(duplicate), /anchor drift/);
});
test("dossier rejects a hardcoded candidate that mismatches map realization", () => {
  assert.equal(validateDossier(dossier()), true);
  const bad = dossier();
  bad.mapRealization.ordinaryProducer = { layer: "Buildings", x: 1, y: 1, action: "Mine 2" };
  assert.throws(() => validateDossier(bad), /Mine producer set drifted/);
});
test("dossier preserves exact blocked route-map and approach-pose conclusion", () => {
  assert.equal(validateDossier(dossier()), true);
  const overclaim = dossier();
  overclaim.conclusion.liveState = "closed";
  assert.throws(() => validateDossier(overclaim), /conclusion has unknown or missing fields/);
  const alteredNonClaim = dossier();
  alteredNonClaim.conclusion.nonClaim += " Live closure succeeded.";
  assert.throws(() => validateDossier(alteredNonClaim), /conclusion must retain exact blocked/);
  const mapOverclaim = dossier();
  mapOverclaim.mapRealization.liveState = "closed";
  assert.throws(() => validateDossier(mapOverclaim), /mapRealization has unknown or missing fields/);
});
test("real target mint then fresh verify is opt-in", { skip: !process.env.GAMEBUDDY_REAL_TARGET_TEST }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gamebuddy-m8-route-real-target-test-"));
  const dossierPath = path.join(root, "route.json");
  try {
    await mint({
      gamePath: process.env.GAMEBUDDY_REAL_TARGET_PATH ?? "D:/Steam/steamapps/common/Stardew Valley",
      output: dossierPath,
    });
    const result = await verify({
      gamePath: process.env.GAMEBUDDY_REAL_TARGET_PATH ?? "D:/Steam/steamapps/common/Stardew Valley",
      dossierPath,
    });
    assert.equal(result.status, "blocked");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
