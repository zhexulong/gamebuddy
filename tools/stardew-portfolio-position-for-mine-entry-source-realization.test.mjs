import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ANCHOR_DEFS,
  buildProvenanceDigest,
  deriveMapRealization,
  extractSourceAnchors,
  MAP,
  mint,
  TARGET,
  validateDossier,
  verify,
} from "./stardew-portfolio-position-for-mine-entry-source-realization.mjs";

const closure = [
  {
    relativeFileName: "Content/ContentHashes.json",
    sha256: "a".repeat(64),
    identity: { name: "ContentHashes", version: "1.0.0.0", culture: "", publicKeyToken: "" },
  },
  {
    relativeFileName: "Content/Maps/Mine.xnb",
    sha256: MAP.sha256,
    identity: { name: "MineMap", version: "1.0.0.0", culture: "", publicKeyToken: "" },
  },
  {
    relativeFileName: "MonoGame.Framework.dll",
    sha256: "b".repeat(64),
    identity: { name: "MonoGame.Framework", version: "1.0.0.0", culture: "", publicKeyToken: "" },
  },
  {
    relativeFileName: "Stardew Valley.dll",
    sha256: TARGET.sha256,
    identity: { name: "StardewValley", version: "1.6.15.0", culture: "", publicKeyToken: "" },
  },
  {
    relativeFileName: "xTile.dll",
    sha256: "c".repeat(64),
    identity: { name: "xTile", version: "1.0.0.0", culture: "", publicKeyToken: "" },
  },
];
const provenance = {
  privateSnapshotBoundary: "private_temp_acl_current_user_and_SYSTEM_no_reparse_readonly_files",
  declaredSnapshotClosure: closure,
  allowedFrameworkFallbackIdentities: [],
  actualResolvedLoadSet: closure
    .map((x) => ({ identity: x.identity, source: "snapshot" }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
};
const probe = (actions) => ({
  state: "probed",
  gameAssemblyVersion: "1.6.15.24356",
  mapAsset: MAP.asset,
  mapFile: MAP.relativeFileName,
  mapXnbSha256: MAP.sha256,
  layerCount: 4,
  layerNames: ["Back", "Buildings", "Front", "Paths"],
  actionCount: actions.length,
  actions,
  note: "test",
  loaderProvenance: JSON.parse(JSON.stringify(provenance)),
});
const actions = [
  { layer: "Buildings", x: 23, y: 9, action: "Mine" },
  { layer: "Buildings", x: 67, y: 9, action: "Mine 77377" },
];
const decl = {
  "StardewValley/Game1.cs":
    "public static bool tryToCheckAt(Vector2 grabTile, Farmer who){ if (who.IsLocalPlayer) currentLocation.checkAction(grabTile, who); } public static void enterMine(int whatLevel, int? forceLayout = null){ warpFarmer(MineShaft.GetLevelName(whatLevel, forceLayout), 6, 6, 2); }",
  "StardewValley/Character.cs": "public Vector2 GetGrabTile(){ FacingDirection switch; }",
  "StardewValley/GameLocation.cs":
    'public virtual bool checkAction(){ performAction(action, who, tileLocation); } public virtual bool performAction(string[] action, Farmer who, Location tileLocation){ case "Mine": TryGetOptionalInt(action, 1, out error, 1); Game1.enterMine(value3); }',
  "StardewValley/Pathfinding/PathFindController.cs":
    "public PathFindController(Character c, GameLocation location, Point endPoint, int finalFacingDirection){ this(c, location, isAtEndPoint, finalFacingDirection); } protected virtual void moveCharacter(GameTime time){ character.controller = null; } public static Stack<Point> findPath(Point startPoint, Point endPoint, isAtEnd endPointFunction, GameLocation location, Character character, int limit){ location.isCollidingPosition; }",
};
const sources = () => Object.fromEntries(Object.entries(decl).map(([k, v]) => [k, Buffer.from(v)]));
function dossier() {
  const map = deriveMapRealization(probe(actions));
  const anchors = extractSourceAnchors(sources());
  const buildProvenance = {
    privateBuildBoundary: "private_temp_copied_project_no_repo_parent_discovery_no_external_package_sources",
    buildInputManifest: [
      "NuGet.Config",
      "PositionForMineEntryContentProbe.cs",
      "PositionForMineEntryContentProbe.csproj",
      "global.json",
    ].map((relativePath) => ({ relativePath, sha256: "e".repeat(64) })),
    sdkVersion: "8.0.100",
    sdkInfoSha256: "f".repeat(64),
    restoreCommand: "dotnet restore PositionForMineEntryContentProbe.csproj --configfile NuGet.Config",
    buildCommand: "dotnet build PositionForMineEntryContentProbe.csproj --no-restore --nologo --output output",
    artifactOutput: "output/PositionForMineEntryContentProbe.dll",
    artifactSha256: "0".repeat(64),
  };
  return {
    schemaVersion: 4,
    artifactKind: "portfolio_primitive_exact_target_source_map_realization",
    realizationId: "portfolio_position_for_mine_entry_source_realization_v2",
    actionId: "position_for_mine_entry",
    topology: "single_player_native_companion",
    target: TARGET,
    decompilerProvenance: {
      version: "ilspycmd: 9.1.0.7988",
      sha256: "5da34ef8b7a3d7e2057d27a0a84ec8e1ccdddb35d6d519058fce1e2f374c4c7f",
      payloadFileCount: 59,
      payloadCanonicalSha256: "4bfe5d499f00ffe9373d400ab68a069b8fed079a96ae3aaa7804423f0eba80ea",
    },
    loaderProvenance: JSON.parse(JSON.stringify(provenance)),
    buildProvenance: { ...buildProvenance, provenanceSha256: buildProvenanceDigest(buildProvenance) },
    sourceManifest: { csharpFileCount: 1, canonicalSha256: "d".repeat(64) },
    mapRealization: { ...map, probeState: "probed" },
    anchors,
    semanticBoundary: {
      candidateRule:
        "Derive all four sorted cardinal neighbors only from the unique parsed default-floor producer; caller publishes no coordinates, facing, location, or route.",
      actionInput:
        "Initial position_for_mine_entry consumes only the unique fresh opaque parsed default-floor Mine producer; no caller, DSM, or request selects coordinates, facing, location, route, or floor.",
      ordinaryProducer:
        "The unique Maps/Mine Buildings Action matching the source-resolved default Mine grammar is the sole in-scope producer; source/map realization does not claim reachability.",
      excludedProducer:
        "Every parsed explicit-floor Mine producer remains recorded evidence and excluded from position_for_mine_entry.",
      nativeChain:
        "GameLocation.checkAction → performAction Mine → ArgUtility.TryGetOptionalInt(action, 1, ..., 1) → Game1.enterMine(1) → warpFarmer(MineShaft.GetLevelName(...), 6, 6, 2)",
      excluded: [
        "UI/input",
        "raw coordinates",
        "caller-selected floor",
        "DSM-selected floor",
        "explicit-floor Mine producers",
        "MineElevator",
        "ladder progression",
        "combat",
        "persistence",
        "publication",
        "live closure",
      ],
    },
    bdd: {
      scenario: "position_for_mine_entry approaches the unique ordinary Mine producer",
      given: "runtime Given",
      when: "derives a cardinal-adjacent",
      then: "GetGrabTile",
      verifier: "fresh native",
    },
    conclusion: {
      sourceMapStatus: "realized",
      projectionState: "blocked_pending_dynamic_path_facing_collision_proof",
      liveState: "not_performed",
      nonClaim:
        "This dossier does not claim candidate passability, collision safety, final-facing safety, reachability, controller success, receipt evidence, implementation, publication, or live closure.",
    },
  };
}
test("discovers all exact grammar producers and selects default mechanically", () => {
  const r = deriveMapRealization(probe(actions));
  assert.equal(r.ordinaryProducer.x, 23);
  assert.deepEqual(r.candidateTiles, [
    { x: 22, y: 9 },
    { x: 23, y: 8 },
    { x: 23, y: 10 },
    { x: 24, y: 9 },
  ]);
  assert.equal(r.excludedSpecialProducers.length, 1);
});
test("grammar changes, non-Buildings, duplicates, and unknown nested fields fail closed", () => {
  assert.throws(() =>
    deriveMapRealization(
      probe([
        { layer: "Buildings", x: 23, y: 9, action: "Mine 0" },
        { layer: "Buildings", x: 67, y: 9, action: "Mine 77377" },
      ]),
    ),
  );
  assert.doesNotThrow(() => deriveMapRealization(probe([{ layer: "Back", x: 1, y: 1, action: "Mine" }, ...actions])));
  assert.throws(() => deriveMapRealization(probe([...actions, actions[1]])));
  const p = probe(actions.map((a) => ({ ...a })));
  p.actions[0].extra = true;
  assert.throws(() => deriveMapRealization(p));
});
test("anchors are declaration bounded, unique, and complete", () => {
  assert.equal(extractSourceAnchors(sources()).length, ANCHOR_DEFS.length);
  const x = sources();
  x["StardewValley/Game1.cs"] = Buffer.from(
    `${decl["StardewValley/Game1.cs"]} public static bool tryToCheckAt(Vector2 grabTile, Farmer who){}`,
  );
  assert.throws(() => extractSourceAnchors(x));
});
test("dossier rejects duplicate anchors, candidate tamper, target/load/build drift", () => {
  validateDossier(dossier());
  for (const mutate of [
    (d) => (d.anchors[1] = { ...d.anchors[0] }),
    (d) => (d.mapRealization.candidateTiles[0] = { x: 0, y: 0 }),
    (d) => (d.bdd.then = "claims safety"),
    (d) => (d.conclusion.nonClaim = "does not claim"),
    (d) => (d.loaderProvenance.declaredSnapshotClosure = []),
    (d) =>
      (d.loaderProvenance.declaredSnapshotClosure.find((x) => x.relativeFileName === "Stardew Valley.dll").sha256 =
        "1".repeat(64)),
    (d) =>
      (d.loaderProvenance.actualResolvedLoadSet = d.loaderProvenance.actualResolvedLoadSet.filter(
        (x) => x.identity.name !== "xTile",
      )),
    (d) => (d.buildProvenance.artifactSha256 = "1".repeat(64)),
    (d) =>
      d.loaderProvenance.actualResolvedLoadSet.push({
        identity: { name: "rogue", version: "1.0.0.0", culture: "", publicKeyToken: "" },
        source: "snapshot",
      }),
  ]) {
    const d = dossier();
    mutate(d);
    assert.throws(() => validateDossier(d));
  }
});
test("source semantics reject local-gate and ordered-handoff substitutions", () => {
  for (const mutate of [
    (x) =>
      (x["StardewValley/Game1.cs"] = Buffer.from(
        decl["StardewValley/Game1.cs"].replace("who.IsLocalPlayer", "other.IsLocalPlayer"),
      )),
    (x) =>
      (x["StardewValley/Game1.cs"] = Buffer.from(
        decl["StardewValley/Game1.cs"].replace("checkAction(grabTile, who)", "checkAction(otherTile, who)"),
      )),
    (x) =>
      (x["StardewValley/GameLocation.cs"] = Buffer.from(
        decl["StardewValley/GameLocation.cs"].replace(
          "performAction(action, who, tileLocation)",
          "performAction(action, other, tileLocation)",
        ),
      )),
    (x) =>
      (x["StardewValley/GameLocation.cs"] = Buffer.from(
        decl["StardewValley/GameLocation.cs"].replace('case "Mine":', 'case "Other":'),
      )),
  ]) {
    const x = sources();
    mutate(x);
    assert.throws(() => extractSourceAnchors(x));
  }
});
test("real target mint then fresh verify is opt-in", { skip: !process.env.GAMEBUDDY_REAL_TARGET_TEST }, async () => {
  const gamePath = process.env.GAMEBUDDY_REAL_TARGET_PATH ?? "D:/Steam/steamapps/common/Stardew Valley",
    root = await mkdtemp(path.join(os.tmpdir(), "gamebuddy-position-real-target-test-")),
    dossierPath = path.join(root, "position.json");
  try {
    await mint({ gamePath, output: dossierPath });
    assert.deepEqual(await verify({ gamePath, dossierPath }), {
      actionId: "position_for_mine_entry",
      sourceMapStatus: "realized",
      verifiedAgainst: "fresh_locked_target_source_snapshot_map_and_loader_closure",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
