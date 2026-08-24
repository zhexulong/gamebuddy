import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ANCHOR_DEFS,
  extractSourceAnchors,
  MAP,
  mint,
  TARGET,
  validateDossier,
  validateMapProbe,
  verify,
} from "./stardew-portfolio-enter-mine-source-realization.mjs";

const gameLocation = `public virtual bool performAction(string[] action, Farmer who, Location tileLocation)
{
 if (who.IsLocalPlayer) { switch (action[0]) { case "Mine": { if (!ArgUtility.TryGetOptionalInt(action, 1, out var value3, out error, 1, "int mineLevel")) return false; playSound("stairsdown"); Game1.enterMine(value3); break; } } }
}`;
const game1 = `public static void enterMine(int whatLevel, int? forceLayout = null)
{ warpFarmer(MineShaft.GetLevelName(whatLevel, forceLayout), 6, 6, 2); }`;
const sources = () => ({
  "StardewValley/GameLocation.cs": Buffer.from(gameLocation),
  "StardewValley/Game1.cs": Buffer.from(game1),
});
const probe = () => ({
  state: "probed",
  gameAssemblyVersion: "1.6.15.24356",
  mapAsset: MAP.asset,
  mapFile: MAP.relativeFileName,
  mapXnbSha256: MAP.sha256,
  layerCount: 4,
  layerNames: ["Back", "Buildings", "Front", "Paths"],
  actionCount: 2,
  actions: [
    { layer: "Buildings", x: 23, y: 9, action: "Mine" },
    { layer: "Buildings", x: 67, y: 9, action: "Mine 77377" },
  ],
  note: "Locked exact-map Action producers only; Mine 77377 is reported for explicit exclusion, never as an enter_mine option.",
});
const boundary = () => ({
  actionInput:
    "Initial enter_mine is a typed, parameterless action. The Mod fixes its sole native level argument to 1; no caller, DSM, or request selects a floor or layout.",
  ordinaryProducer:
    "Maps/Mine Buildings Action Mine at (23,9) is recorded only as the ordinary player UI-ingress provenance for default floor 1; it is not an enter_mine admission, reachability, or position requirement.",
  excludedProducer:
    "Maps/Mine Buildings Action Mine 77377 at (67,9) is recorded as excluded player UI-ingress provenance, never an enter_mine option.",
  nativeChain:
    "Typed enter_mine → Game1.enterMine(1) → warpFarmer(MineShaft.GetLevelName(...), 6, 6, 2). Separately, ordinary player UI ingress is GameLocation.performAction Mine → ArgUtility.TryGetOptionalInt(action, 1, ..., 1) → Game1.enterMine(1).",
  excluded: [
    "UI/input",
    "raw coordinates",
    "caller-selected floor",
    "DSM-selected floor",
    "Mine 77377",
    "MineElevator",
    "ladder progression",
    "combat",
    "persistence",
    "publication",
    "live closure",
  ],
});
function dossier() {
  const anchors = extractSourceAnchors(sources());
  return {
    schemaVersion: 2,
    artifactKind: "portfolio_primitive_exact_target_source_map_realization",
    realizationId: "portfolio_enter_mine_source_realization_v2",
    actionId: "enter_mine",
    topology: "single_player_native_companion",
    target: TARGET,
    sourceManifest: { csharpFileCount: 2, canonicalSha256: "a".repeat(64) },
    mapRealization: {
      asset: MAP.asset,
      relativeFileName: MAP.relativeFileName,
      sha256: MAP.sha256,
      layer: "Buildings",
      ordinaryProducer: MAP.ordinary,
      excludedProducer: MAP.excluded,
      probeState: "probed",
    },
    anchors,
    semanticBoundary: boundary(),
    bdd: {
      scenario: "enter_mine enters the native default floor",
      given:
        "Required runtime Given: a fresh native observation proves the local player is in Mine exterior; no UI interaction pose or producer reachability is required.",
      when: "One typed parameterless enter_mine request fixes the native level argument to 1.",
      then: "The native seam enters floor 1.",
      verifier: "fresh native location/floor observation",
    },
    conclusion: {
      sourceMapStatus: "realized",
      projectionState: "eligible_for_connected_implementation_review",
      liveState: "not_performed",
      nonClaim:
        "This source+map realization does not claim Mine-exterior setup, authorization, connected implementation, publication, receipt evidence, persistence, or live closure.",
    },
  };
}
test("controlled probe schema accepts only ordinary Mine plus recorded excluded producer", () => {
  assert.equal(validateMapProbe(probe()), true);
  const extra = probe();
  extra.actions.push({ layer: "Buildings", x: 1, y: 1, action: "Mine 2" });
  extra.actionCount++;
  assert.throws(() => validateMapProbe(extra), /producer set drifted|bounds drifted/);
  const floor = probe();
  floor.actions[0].action = "Mine 2";
  assert.throws(() => validateMapProbe(floor), /producer set drifted/);
});
test("source anchors prove ordered default-floor native control flow", () => {
  assert.equal(extractSourceAnchors(sources()).length, ANCHOR_DEFS.length);
  const bad = sources();
  bad["StardewValley/GameLocation.cs"] = Buffer.from(gameLocation.replace("out error, 1", "out error, 2"));
  assert.throws(() => extractSourceAnchors(bad), /control flow drifted/);
});
test("source anchor rejects a decoy local-player guard that does not lexically contain Mine", () => {
  const decoy = `public virtual bool performAction(string[] action, Farmer who, Location tileLocation)
{
 if (who.IsLocalPlayer) { playSound("decoy"); }
 switch (action[0]) { case "Mine": { if (!ArgUtility.TryGetOptionalInt(action, 1, out var value3, out error, 1, "int mineLevel")) return false; playSound("stairsdown"); Game1.enterMine(value3); break; } }
}`;
  const bad = sources();
  bad["StardewValley/GameLocation.cs"] = Buffer.from(decoy);
  assert.throws(() => extractSourceAnchors(bad), /lexically contained/);
});
test("dossier rejects caller floor, producer-based admission, and map producer drift", () => {
  assert.equal(validateDossier(dossier()), true);
  const floor = dossier();
  floor.semanticBoundary.actionInput = "caller selects floor";
  assert.throws(() => validateDossier(floor), /semantic boundary drifted/);
  const producerAdmission = dossier();
  producerAdmission.semanticBoundary.ordinaryProducer = "requires producer reachability";
  assert.throws(() => validateDossier(producerAdmission), /semantic boundary drifted/);
  const reach = dossier();
  reach.mapRealization.ordinaryProducer = { ...MAP.ordinary, reachability: "adjacent" };
  assert.throws(() => validateDossier(reach), /map realization drifted/);
  const missing = dossier();
  missing.bdd.given = "map proves adjacent reachability";
  assert.throws(() => validateDossier(missing), /BDD boundary/);
});
test("real target mint and fresh verify are opt-in", { skip: !process.env.GAMEBUDDY_REAL_TARGET_TEST }, async () => {
  const gamePath = process.env.GAMEBUDDY_REAL_TARGET_PATH ?? "D:/Steam/steamapps/common/Stardew Valley";
  const root = await mkdtemp(path.join(os.tmpdir(), "gamebuddy-enter-mine-real-target-test-"));
  const dossierPath = path.join(root, "enter-mine.json");
  try {
    await mint({ gamePath, output: dossierPath });
    const verdict = await verify({ gamePath, dossierPath });
    assert.deepEqual(verdict, {
      actionId: "enter_mine",
      sourceMapStatus: "realized",
      verifiedAgainst: "fresh_locked_target_source_and_snapshot_map",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
