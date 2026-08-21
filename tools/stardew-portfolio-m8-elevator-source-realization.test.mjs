import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  extractAnchors,
  resolveLockedToolPath,
  validateDossier,
  verifySnapshot,
} from "./stardew-portfolio-m8-elevator-source-realization.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(",")}}`
      : JSON.stringify(value);
const authority = {
  relativePath: "fixtures/stardew/portfolio-m8-elevator-contract.example.json",
  canonicalSha256: "a".repeat(64),
};

function sources() {
  return {
    "StardewValley/Locations/MineShaft.cs": Buffer.from(
      `public override bool checkAction()\n{\n switch (tile) { case 112: if (mineLevel <= 120) { Game1.activeClickableMenu = new MineElevatorMenu(); } break; }\n}`,
    ),
    "StardewValley/Menus/MineElevatorMenu.cs": Buffer.from(
      `public MineElevatorMenu()\n{\n int num = Math.Min(MineShaft.lowestLevelReached, 120) / 5;\n for (int i = 1; i <= num; i++) { elevators.Add(new ClickableComponent(new Rectangle(), (i * 5).ToString())); }\n}\npublic override void receiveLeftClick(int x, int y, bool playSound = true)\n{\n foreach (ClickableComponent elevator in elevators) { if (elevator.containsPoint(x, y)) { if (Convert.ToInt32(elevator.name) == Game1.CurrentMineLevel) return; Game1.player.ridingMineElevator = true; Game1.enterMine(Convert.ToInt32(elevator.name)); Game1.exitActiveMenu(); } }\n}`,
    ),
    "StardewValley/Game1.cs": Buffer.from(
      `public static void enterMine(int whatLevel, int? forceLayout = null)\n{\n warpFarmer(MineShaft.GetLevelName(whatLevel, forceLayout), 6, 6, 2);\n}`,
    ),
  };
}
function dossier() {
  const source = sources();
  return {
    schemaVersion: 1,
    artifactKind: "portfolio_primitive_exact_target_source_realization",
    realizationId: "portfolio_m8_elevator_source_realization_v1",
    actionId: "select_mine_elevator_floor",
    topology: "single_player_native_companion",
    target: {
      relativeFileName: "Stardew Valley.dll",
      fileVersion: "1.6.15.24356",
      productVersion: "1.6.15.24356",
      length: 6268416,
      sha256: "7f1e5b8e58d2758b78570ba771bbeb03d33522f62188bf6c32edf0cf626deaee",
    },
    decompiler: {
      tool: "ilspycmd",
      version: "ilspycmd: 9.1.0.7988",
      toolInstallRelativePath: ".dotnet/tools/ilspycmd.exe",
      toolSha256: "5da34ef8b7a3d7e2057d27a0a84ec8e1ccdddb35d6d519058fce1e2f374c4c7f",
      payloadInstallRelativePath: ".dotnet/tools/.store/ilspycmd/9.1.0.7988/ilspycmd/9.1.0.7988/tools/net8.0/any",
      payloadFileCount: 59,
      payloadCanonicalSha256: "4bfe5d499f00ffe9373d400ab68a069b8fed079a96ae3aaa7804423f0eba80ea",
      options: ["--disable-updatecheck", "-p", "--nested-directories"],
      configurationDigest: sha256(
        canonical({
          tool: "ilspycmd",
          toolInstallRelativePath: ".dotnet/tools/ilspycmd.exe",
          toolSha256: "5da34ef8b7a3d7e2057d27a0a84ec8e1ccdddb35d6d519058fce1e2f374c4c7f",
          payloadInstallRelativePath: ".dotnet/tools/.store/ilspycmd/9.1.0.7988/ilspycmd/9.1.0.7988/tools/net8.0/any",
          payloadFileCount: 59,
          payloadCanonicalSha256: "4bfe5d499f00ffe9373d400ab68a069b8fed079a96ae3aaa7804423f0eba80ea",
          options: ["--disable-updatecheck", "-p", "--nested-directories"],
          targetRelativeFileName: "Stardew Valley.dll",
        }),
      ),
      extractedAtUtc: "2026-04-12T12:34:56.789Z",
    },
    sourceManifest: (() => {
      const files = Object.entries(source)
        .map(([relativePath, bytes]) => ({ relativePath, sha256: sha256(bytes) }))
        .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
      return {
        csharpFileCount: files.length,
        canonicalSha256: sha256(`${files.map((file) => `${file.relativePath}\t${file.sha256}`).join("\n")}\n`),
      };
    })(),
    primitiveContract: authority,
    provenanceBoundary: {
      snapshotThreatBoundary:
        "The input DLL is copied into a newly created Windows private temporary directory with inheritance removed and access restricted to the current user and SYSTEM; each snapshot root/file is rejected if it is a reparse point and its lstat identity, resolved path, size, and hash must match immediately before and after decompilation. This fails closed for observed drift, reparse substitution, and replacement by principals outside that private ACL. It does not claim resistance to malicious code already executing as this process/current user (which can alter ACLs or race a pathname open), kernel compromise, or a compromised .NET host.",
    },
    anchors: extractAnchors(source),
    semanticBoundary: {
      contextualEquivalence:
        "A fresh current MineShaft Buildings-layer elevator facility supports selecting one materialized checkpoint in 5..120 without UI ingress pose; the checkpoint must be a non-current multiple of five no greater than Math.Min(lowestLevelReached, 120), and this does not grant arbitrary enterMine authority.",
      guardCommitContinuation:
        "MineShaft checkAction case 112 and MineElevatorMenu are provenance for the ordinary UI ingress; the direct typed seam independently verifies facility presence and bounded unlocked checkpoint, sets ridingMineElevator, then enters the selected mine.",
      excluded: ["ladders", "combat", "route discovery", "new-depth progression", "persistence"],
    },
    conclusion: {
      primitiveSourceRealizationStatus: "realized",
      projectionState: "eligible_for_separate_projection_review",
      liveState: "not_performed",
      nonClaim:
        "This primitive source realization does not claim aggregate M8 route realization, publication, capability enablement, receipt evidence, liveness, or live closure.",
    },
  };
}

test("M8 primitive dossier accepts only a redacted complete-source manifest", () => {
  const value = dossier();
  assert.equal(validateDossier(value, authority), true);
  assert.deepEqual(Object.keys(value.sourceManifest).sort(), ["canonicalSha256", "csharpFileCount"]);
  const expanded = dossier();
  expanded.sourceManifest.files = [];
  assert.throws(() => validateDossier(expanded, authority), /unknown or missing fields/);
});

test("M8 primitive dossier rejects strict-shape, source-manifest, and claim drift", () => {
  const unknown = dossier();
  unknown.unapproved = true;
  assert.throws(() => validateDossier(unknown, authority), /unknown or missing fields/);
  const manifest = dossier();
  manifest.sourceManifest.csharpFileCount = 0;
  assert.throws(() => validateDossier(manifest, authority), /source manifest shape/);
  const closure = dossier();
  closure.decompiler.payloadCanonicalSha256 = "b".repeat(64);
  assert.throws(() => validateDossier(closure, authority), /decompiler tuple is invalid/);
  const provenance = dossier();
  provenance.provenanceBoundary.snapshotThreatBoundary = "overclaim";
  assert.throws(() => validateDossier(provenance, authority), /provenance boundary drifted/);
  const claim = dossier();
  claim.conclusion.liveState = "live_closed";
  assert.throws(() => validateDossier(claim, authority), /unauthorized claim/);
  const anchor = dossier();
  anchor.anchors[0].unexpected = true;
  assert.throws(() => validateDossier(anchor, authority), /unknown or missing fields/);
});

test("M8 fixed tool identity is derived from the installed home and never ILSPYCMD_PATH", () => {
  const previous = process.env.ILSPYCMD_PATH;
  process.env.ILSPYCMD_PATH = "definitely-not-ilspycmd";
  try {
    assert.equal(
      resolveLockedToolPath("C:/fixed-home"),
      "C:/fixed-home/.dotnet/tools/ilspycmd.exe".replaceAll("/", path.sep),
    );
  } finally {
    if (previous === undefined) delete process.env.ILSPYCMD_PATH;
    else process.env.ILSPYCMD_PATH = previous;
  }
});

test("M8 snapshot validation rejects identity replacement and reparse substitution", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "gamebuddy-m8-snapshot-test-"));
  const targetPath = path.join(root, "Stardew Valley.dll");
  await writeFile(targetPath, Buffer.alloc(6268416));
  const rootStat = await lstat(root),
    fileStat = await lstat(targetPath);
  const target = {
    path: targetPath,
    snapshotRoot: root,
    length: 6268416,
    sha256: "7f1e5b8e58d2758b78570ba771bbeb03d33522f62188bf6c32edf0cf626deaee",
    identity: {
      rootDev: rootStat.dev,
      rootIno: rootStat.ino,
      fileDev: fileStat.dev,
      fileIno: fileStat.ino,
      resolvedRoot: await import("node:fs/promises").then(({ realpath }) => realpath(root)),
      resolvedFile: await import("node:fs/promises").then(({ realpath }) => realpath(targetPath)),
    },
  };
  await rm(targetPath);
  await writeFile(targetPath, Buffer.alloc(6268416));
  await assert.rejects(() => verifySnapshot(target), /identity drifted/);
  try {
    await rm(targetPath);
    await symlink(process.execPath, targetPath);
    await assert.rejects(() => verifySnapshot(target), /reparse point/);
  } catch (error) {
    if (error?.code !== "EPERM") throw error;
    t.diagnostic(
      "Windows symlink creation is unavailable without Developer Mode/privilege; identity-replacement regression still ran.",
    );
  }
  await rm(root, { recursive: true, force: true });
});

test("M8 anchor extraction fails closed on source and semantic-anchor drift", () => {
  const presentation = sources();
  presentation["StardewValley/Locations/MineShaft.cs"] = Buffer.from(
    `public override bool checkAction() { case 112: Game1.activeClickableMenu = new MineElevatorMenu(); }`,
  );
  assert.throws(() => extractAnchors(presentation), /Presentation guard is incomplete/);
  const materialization = sources();
  materialization["StardewValley/Menus/MineElevatorMenu.cs"] = Buffer.from(
    materialization["StardewValley/Menus/MineElevatorMenu.cs"].toString().replace("elevators.Add", "ignored.Add"),
  );
  assert.throws(() => extractAnchors(materialization), /Finite checkpoint materialization is incomplete/);
  const selection = sources();
  selection["StardewValley/Menus/MineElevatorMenu.cs"] = Buffer.from(
    selection["StardewValley/Menus/MineElevatorMenu.cs"]
      .toString()
      .replace("ridingMineElevator = true", "ridingMineElevator = false"),
  );
  assert.throws(
    () => extractAnchors(selection),
    /Selection membership\/current-floor\/commit semantics are incomplete/,
  );
  const warp = sources();
  warp["StardewValley/Game1.cs"] = Buffer.from(
    `public static void enterMine(int whatLevel, int? forceLayout = null) { warpFarmer("Mine", 6, 6, 2); }`,
  );
  assert.throws(() => extractAnchors(warp), /missing or non-unique within declaration/);
});

test("M8 anchors reject duplicate declarations, duplicate in-declaration needles, and external decoys", () => {
  const duplicateDeclaration = sources();
  duplicateDeclaration["StardewValley/Game1.cs"] = Buffer.from(
    `${duplicateDeclaration["StardewValley/Game1.cs"]}\npublic static void enterMine(int whatLevel, int? forceLayout = null) { warpFarmer(MineShaft.GetLevelName(whatLevel, forceLayout), 6, 6, 2); }`,
  );
  assert.throws(() => extractAnchors(duplicateDeclaration), /declaration is missing or non-unique/);
  const duplicateNeedle = sources();
  duplicateNeedle["StardewValley/Game1.cs"] = Buffer.from(
    `public static void enterMine(int whatLevel, int? forceLayout = null) { warpFarmer(MineShaft.GetLevelName(whatLevel, forceLayout), 6, 6, 2); warpFarmer(MineShaft.GetLevelName(whatLevel, forceLayout), 6, 6, 2); }`,
  );
  assert.throws(() => extractAnchors(duplicateNeedle), /missing or non-unique within declaration/);
  const decoy = sources();
  decoy["StardewValley/Game1.cs"] = Buffer.from(
    `// warpFarmer(MineShaft.GetLevelName(whatLevel, forceLayout), 6, 6, 2);\n${decoy["StardewValley/Game1.cs"]}`,
  );
  assert.doesNotThrow(() => extractAnchors(decoy));
});
