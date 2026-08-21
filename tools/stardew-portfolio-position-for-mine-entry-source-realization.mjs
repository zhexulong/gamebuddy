#!/usr/bin/env node
import { spawn } from "node:child_process";
/** Exact-target, tools-only realization evidence for position_for_mine_entry. */
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  disposeTargetAssembly,
  targetAssembly,
  verifySnapshot,
} from "./stardew-portfolio-m8-elevator-source-realization.mjs";

const ACTION = "position_for_mine_entry",
  TOPOLOGY = "single_player_native_companion";
const TARGET = Object.freeze({
  relativeFileName: "Stardew Valley.dll",
  fileVersion: "1.6.15.24356",
  productVersion: "1.6.15.24356",
  length: 6268416,
  sha256: "7f1e5b8e58d2758b78570ba771bbeb03d33522f62188bf6c32edf0cf626deaee",
});
const MAP = Object.freeze({
  asset: "Maps/Mine",
  relativeFileName: "Content/Maps/Mine.xnb",
  sha256: "a8669be89fd338360bbe637df3c383f3dc5f0d50b1028ad7385aeb39f6e700ff",
  actionLayer: "Buildings",
});
const SNAPSHOT_ASSETS = Object.freeze([
  Object.freeze({
    relativeFileName: "Content/ContentHashes.json",
    sha256: "8143aa3110810e0039282ab8e9989417092388edb84c8c3b6c0b6f23840a4349",
  }),
  Object.freeze({ relativeFileName: MAP.relativeFileName, sha256: MAP.sha256 }),
]);
const SNAPSHOT_BOUNDARY = "private_temp_acl_current_user_and_SYSTEM_no_reparse_readonly_files";
const TOOL = Object.freeze({
  version: "ilspycmd: 9.1.0.7988",
  sha256: "5da34ef8b7a3d7e2057d27a0a84ec8e1ccdddb35d6d519058fce1e2f374c4c7f",
  installRelativePath: ".dotnet/tools/ilspycmd.exe",
  payloadRelativePath: ".dotnet/tools/.store/ilspycmd/9.1.0.7988/ilspycmd/9.1.0.7988/tools/net8.0/any",
  payloadFileCount: 59,
  payloadCanonicalSha256: "4bfe5d499f00ffe9373d400ab68a069b8fed079a96ae3aaa7804423f0eba80ea",
});
const ANCHOR_DEFS = Object.freeze([
  {
    anchorId: "action_button_check_action",
    relativePath: "StardewValley/Game1.cs",
    declaration: "public static bool tryToCheckAt(Vector2 grabTile, Farmer who)",
    needle: "currentLocation.checkAction",
    semanticRole: "action_button_passes_grab_tile_to_check_action",
  },
  {
    anchorId: "grab_tile_facing",
    relativePath: "StardewValley/Character.cs",
    declaration: "public Vector2 GetGrabTile()",
    needle: "FacingDirection switch",
    semanticRole: "grab_tile_is_derived_from_facing",
  },
  {
    anchorId: "check_action_dispatch",
    relativePath: "StardewValley/GameLocation.cs",
    declaration: "public virtual bool checkAction",
    needle: "performAction",
    semanticRole: "check_action_dispatches_tile_action",
  },
  {
    anchorId: "mine_dispatch_default",
    relativePath: "StardewValley/GameLocation.cs",
    declaration: "public virtual bool performAction(string[] action, Farmer who, Location tileLocation)",
    needle: 'case "Mine":',
    semanticRole: "mine_grammar_dispatches_default_floor",
  },
  {
    anchorId: "enter_mine_warp",
    relativePath: "StardewValley/Game1.cs",
    declaration: "public static void enterMine(int whatLevel, int? forceLayout = null)",
    needle: "warpFarmer(MineShaft.GetLevelName(whatLevel, forceLayout), 6, 6, 2);",
    semanticRole: "mine_entry_native_warp",
  },
  {
    anchorId: "pathfind_final_facing",
    relativePath: "StardewValley/Pathfinding/PathFindController.cs",
    declaration:
      "public PathFindController(Character c, GameLocation location, Point endPoint, int finalFacingDirection)",
    needle: "this(c, location, isAtEndPoint, finalFacingDirection",
    semanticRole: "pathfind_accepts_final_facing",
  },
  {
    anchorId: "pathfind_terminal_release",
    relativePath: "StardewValley/Pathfinding/PathFindController.cs",
    declaration: "protected virtual void moveCharacter(GameTime time)",
    needle: "character.controller = null",
    semanticRole: "pathfind_terminal_controller_release",
  },
  {
    anchorId: "pathfind_collision",
    relativePath: "StardewValley/Pathfinding/PathFindController.cs",
    declaration:
      "public static Stack<Point> findPath(Point startPoint, Point endPoint, isAtEnd endPointFunction, GameLocation location, Character character, int limit)",
    needle: "location.isCollidingPosition",
    semanticRole: "pathfind_consults_collision",
  },
]);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
          .join(",")}}`
      : JSON.stringify(value);
const manifestHash = (files) => sha256(`${files.map((f) => `${f.relativePath}\t${f.sha256}`).join("\n")}\n`);
const ordinal = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const FRAMEWORK_FALLBACK_NAMES = new Set(
  `Microsoft.Win32.Primitives System System.Buffers System.Collections System.Collections.Concurrent System.Collections.NonGeneric System.Collections.Specialized System.ComponentModel System.ComponentModel.TypeConverter System.Console System.Core System.Diagnostics.Process System.Diagnostics.StackTrace System.IO.FileSystem System.Linq System.Linq.Expressions System.Memory System.Net.NameResolution System.Net.NetworkInformation System.Net.Primitives System.Net.Requests System.Net.Sockets System.Net.WebHeaderCollection System.Numerics System.ObjectModel System.Reflection.Emit System.Reflection.Emit.ILGeneration System.Reflection.Emit.Lightweight System.Reflection.Primitives System.Runtime System.Runtime.InteropServices System.Runtime.InteropServices.RuntimeInformation System.Runtime.Serialization.Primitives System.Security.Cryptography.Algorithms System.Security.Cryptography.Csp System.Security.Cryptography.Primitives System.Text.Encoding.Extensions System.Text.RegularExpressions System.Threading System.Threading.Thread System.Xml.ReaderWriter System.Xml.XmlSerializer mscorlib netstandard`.split(
    " ",
  ),
);
function fail(message) {
  throw Object.assign(new Error(message), { code: "position_for_mine_entry_realization_invalid" });
}
function exact(value, fields, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    canonical(Object.keys(value).sort()) !== canonical([...fields].sort())
  )
    fail(`${label} has unknown or missing fields`);
}
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, ...options });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => (stderr += b));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} failed (${code}): ${stderr.trim()}`)),
    );
  });
}
function inside(root, candidate) {
  const rel = path.relative(root, candidate);
  return !!rel && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
async function noReparse(candidate) {
  for (let current = path.resolve(candidate); ; current = path.dirname(current)) {
    const item = await lstat(current).catch(() => fail(`path missing: ${current}`));
    if (item.isSymbolicLink()) fail(`path reparse: ${current}`);
    if (path.dirname(current) === current) return;
  }
}
async function identity(file, expectedHash) {
  await noReparse(file);
  const entry = await lstat(file);
  if (!entry.isFile() || entry.isSymbolicLink()) fail(`regular file required: ${file}`);
  const bytes = await readFile(file),
    digest = sha256(bytes);
  if (expectedHash && digest !== expectedHash) fail(`hash drift: ${path.basename(file)}`);
  return { dev: entry.dev, ino: entry.ino, size: entry.size, realpath: await realpath(file), sha256: digest };
}
async function verifyIdentity(file, expected) {
  if (canonical(await identity(file, expected.sha256)) !== canonical(expected))
    fail(`identity drift: ${path.basename(file)}`);
}
async function secureDirectory(prefix) {
  const root = await mkdtemp(path.join(process.env.TEMP || os.tmpdir(), prefix));
  try {
    await noReparse(root);
    await run("icacls.exe", [
      root,
      "/inheritance:r",
      "/grant:r",
      `${process.env.USERNAME}:(OI)(CI)F`,
      "/grant:r",
      "SYSTEM:(OI)(CI)F",
    ]);
    return root;
  } catch (e) {
    await rm(root, { recursive: true, force: true });
    throw e;
  }
}
function bodyEnd(source, brace) {
  let depth = 0,
    state = "code";
  for (let i = brace; i < source.length; i++) {
    const c = source[i],
      n = source[i + 1];
    if (state === "line") {
      if (c === "\n") state = "code";
      continue;
    }
    if (state === "block") {
      if (c === "*" && n === "/") {
        state = "code";
        i++;
      }
      continue;
    }
    if (state === "string" || state === "char") {
      if (c === "\\") i++;
      else if ((state === "string" && c === '"') || (state === "char" && c === "'")) state = "code";
      continue;
    }
    if (c === "/" && n === "/") {
      state = "line";
      i++;
    } else if (c === "/" && n === "*") {
      state = "block";
      i++;
    } else if (c === '"') state = "string";
    else if (c === "'") state = "char";
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  fail("unterminated declaration");
}
function methodSlice(bytes, declaration) {
  const source = bytes.toString("utf8"),
    found = [];
  for (let at = source.indexOf(declaration); at >= 0; at = source.indexOf(declaration, at + declaration.length))
    found.push(at);
  if (found.length !== 1) fail(`declaration missing or non-unique: ${declaration}`);
  const start = found[0],
    brace = source.indexOf("{", start);
  if (brace < 0) fail("declaration body missing");
  const end = bodyEnd(source, brace);
  return { source, start, end, slice: Buffer.from(source.slice(start, end)) };
}
function once(text, needle, message) {
  if (text.split(needle).length - 1 !== 1) fail(message);
}
export function extractSourceAnchors(sourceFiles) {
  const anchors = ANCHOR_DEFS.map((expected) => {
    const bytes = sourceFiles[expected.relativePath];
    if (!Buffer.isBuffer(bytes)) fail(`source missing: ${expected.relativePath}`);
    const { source, start, end, slice } = methodSlice(bytes, expected.declaration),
      text = slice.toString("utf8");
    once(text, expected.needle, `anchor missing or duplicate: ${expected.anchorId}`);
    if (expected.anchorId === "mine_dispatch_default") {
      for (const part of ['case "Mine":', "TryGetOptionalInt(action, 1", "out error, 1", "Game1.enterMine(value3)"])
        if (!text.includes(part)) fail("Mine grammar/default dispatch drifted");
    }
    return {
      ...expected,
      startByte: Buffer.byteLength(source.slice(0, start)),
      endByte: Buffer.byteLength(source.slice(0, end)),
      fileSha256: sha256(bytes),
      sliceSha256: sha256(slice),
    };
  });
  const game = methodSlice(
      sourceFiles["StardewValley/Game1.cs"],
      "public static bool tryToCheckAt(Vector2 grabTile, Farmer who)",
    ).slice.toString("utf8"),
    check = methodSlice(sourceFiles["StardewValley/GameLocation.cs"], "public virtual bool checkAction").slice.toString(
      "utf8",
    ),
    perform = methodSlice(
      sourceFiles["StardewValley/GameLocation.cs"],
      "public virtual bool performAction(string[] action, Farmer who, Location tileLocation)",
    ).slice.toString("utf8");
  const local = game.indexOf("who.IsLocalPlayer"),
    handoff = game.indexOf("checkAction(grabTile, who)");
  if (local < 0 || handoff < 0 || local > handoff)
    fail("tryToCheckAt does not locally gate and hand off exact grabTile/who");
  if (!/performAction\s*\(\s*action\s*,\s*who\s*,\s*tileLocation\s*\)/.test(check))
    fail("checkAction does not hand off action/who/tileLocation in order");
  const mine = perform.indexOf('case "Mine":');
  if (mine < 0 || perform.indexOf("Game1.enterMine", mine) < mine)
    fail("Mine case is not lexically contained in performAction dispatch");
  return anchors;
}
function parseMineGrammar(action) {
  const match = typeof action === "string" && /^Mine(?: ([1-9][0-9]*))?$/.exec(action);
  return match
    ? {
        form: match[1] ? "explicit_floor" : "default_floor",
        floor: match[1] ? Number(match[1]) : 1,
        defaulted: !match[1],
      }
    : null;
}
function actionOrder(a, b) {
  return a.layer.localeCompare(b.layer) || a.x - b.x || a.y - b.y || a.action.localeCompare(b.action);
}
function actionExact(a) {
  exact(a, ["layer", "x", "y", "action"], "map action");
  if (typeof a.layer !== "string" || !Number.isInteger(a.x) || !Number.isInteger(a.y) || typeof a.action !== "string")
    fail("map action invalid");
}
export function deriveMapRealization(probe) {
  exact(
    probe,
    [
      "state",
      "gameAssemblyVersion",
      "mapAsset",
      "mapFile",
      "mapXnbSha256",
      "layerCount",
      "layerNames",
      "actionCount",
      "actions",
      "note",
      "loaderProvenance",
    ],
    "map probe",
  );
  if (
    probe.state !== "probed" ||
    probe.mapAsset !== MAP.asset ||
    probe.mapFile !== MAP.relativeFileName ||
    probe.mapXnbSha256 !== MAP.sha256 ||
    !Array.isArray(probe.actions) ||
    probe.actionCount !== probe.actions.length ||
    !probe.loaderProvenance
  )
    fail("map probe identity drift");
  loaderProvenanceCheck(probe.loaderProvenance);
  probe.actions.forEach(actionExact);
  const producers = probe.actions.filter((a) => a.layer === MAP.actionLayer && parseMineGrammar(a.action));
  if (
    !producers.length ||
    canonical(producers) !== canonical([...producers].sort(actionOrder)) ||
    new Set(producers.map(canonical)).size !== producers.length
  )
    fail("Mine producer set incomplete, unsorted, or duplicate");
  const parsedForms = producers.map((a) => ({ ...a, ...parseMineGrammar(a.action) })),
    ordinary = parsedForms.filter((a) => a.form === "default_floor");
  if (ordinary.length !== 1) fail("ordinary default producer is not unique");
  const selected = ordinary[0],
    candidateTiles = [
      { x: selected.x - 1, y: selected.y },
      { x: selected.x, y: selected.y - 1 },
      { x: selected.x, y: selected.y + 1 },
      { x: selected.x + 1, y: selected.y },
    ].sort((a, b) => a.x - b.x || a.y - b.y);
  return {
    asset: probe.mapAsset,
    relativeFileName: probe.mapFile,
    sha256: probe.mapXnbSha256,
    layer: MAP.actionLayer,
    producers,
    parsedForms,
    ordinaryProducer: selected,
    excludedSpecialProducers: parsedForms.filter((a) => a.form !== "default_floor"),
    candidateTiles,
  };
}
export function validateMapProbe(probe) {
  deriveMapRealization(probe);
  return true;
}
function expectedBoundary() {
  return {
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
  };
}
function identityExact(item) {
  exact(item, ["name", "version", "culture", "publicKeyToken"], "assembly identity");
  if (
    typeof item.name !== "string" ||
    !item.name ||
    typeof item.version !== "string" ||
    !item.version ||
    typeof item.culture !== "string" ||
    typeof item.publicKeyToken !== "string"
  )
    fail("assembly identity invalid");
}
function loaderProvenanceCheck(value) {
  exact(
    value,
    [
      "privateSnapshotBoundary",
      "declaredSnapshotClosure",
      "allowedFrameworkFallbackIdentities",
      "actualResolvedLoadSet",
    ],
    "loader provenance",
  );
  if (
    value.privateSnapshotBoundary !== SNAPSHOT_BOUNDARY ||
    !Array.isArray(value.declaredSnapshotClosure) ||
    !value.declaredSnapshotClosure.length ||
    !Array.isArray(value.allowedFrameworkFallbackIdentities) ||
    !Array.isArray(value.actualResolvedLoadSet)
  )
    fail("loader provenance invalid");
  targetClosureCheck(value.declaredSnapshotClosure);
  for (const list of [value.allowedFrameworkFallbackIdentities, value.actualResolvedLoadSet])
    if (
      canonical(list) !== canonical([...list].sort((a, b) => ordinal(canonical(a), canonical(b)))) ||
      new Set(list.map(canonical)).size !== list.length
    )
      fail("loader provenance unordered");
  value.allowedFrameworkFallbackIdentities.forEach((identity) => {
    identityExact(identity);
    if (!FRAMEWORK_FALLBACK_NAMES.has(identity.name)) fail("unexpected framework fallback");
  });
  value.actualResolvedLoadSet.forEach((item) => {
    exact(item, ["identity", "source"], "resolved load");
    identityExact(item.identity);
    if (item.source !== "snapshot" && item.source !== "framework_default") fail("resolved load source invalid");
    if (
      item.source === "snapshot" &&
      !value.declaredSnapshotClosure.some((x) => canonical(x.identity) === canonical(item.identity))
    )
      fail("undeclared snapshot resolution");
    if (
      item.source === "framework_default" &&
      !value.allowedFrameworkFallbackIdentities.some((x) => canonical(x) === canonical(item.identity))
    )
      fail("unexpected framework fallback");
  });
  requiredResolvedLoads(value);
}
function closureCheck(items) {
  if (
    canonical(items) !==
      canonical(
        [...items].sort((a, b) =>
          a.relativeFileName < b.relativeFileName ? -1 : a.relativeFileName > b.relativeFileName ? 1 : 0,
        ),
      ) ||
    new Set(items.map((a) => a.relativeFileName)).size !== items.length
  )
    fail("loader closure invalid");
  items.forEach(closureExact);
}
function closureExact(item) {
  exact(item, ["relativeFileName", "sha256", "identity"], "loader closure item");
  identityExact(item.identity);
  if (!/^[a-f0-9]{64}$/.test(item.sha256)) fail("loader closure hash invalid");
}
function targetClosureCheck(items) {
  closureCheck(items);
  const target = items.filter((item) => item.relativeFileName === TARGET.relativeFileName);
  if (target.length !== 1 || target[0].sha256 !== TARGET.sha256)
    fail("discovery closure must contain exactly one locked Stardew Valley.dll");
}
function requiredResolvedLoads(value) {
  const required = ["MonoGame.Framework.dll", "Stardew Valley.dll", "xTile.dll"];
  const resolved = value.actualResolvedLoadSet.filter((item) => item.source === "snapshot");
  for (const relativeFileName of required) {
    const member = value.declaredSnapshotClosure.find((item) => item.relativeFileName === relativeFileName);
    if (!member || !resolved.some((item) => canonical(item.identity) === canonical(member.identity)))
      fail(`required snapshot resolution missing: ${relativeFileName}`);
  }
  if (new Set(resolved.map((item) => canonical(item.identity))).size !== resolved.length)
    fail("duplicate snapshot resolution");
}
export function buildProvenanceDigest(value) {
  const { provenanceSha256, ...unsigned } = value;
  return sha256(canonical(unsigned));
}
function buildProvenanceCheck(value) {
  exact(
    value,
    [
      "privateBuildBoundary",
      "buildInputManifest",
      "sdkVersion",
      "sdkInfoSha256",
      "restoreCommand",
      "buildCommand",
      "artifactOutput",
      "artifactSha256",
      "provenanceSha256",
    ],
    "build provenance",
  );
  const expectedInputs = [
    "NuGet.Config",
    "PositionForMineEntryContentProbe.cs",
    "PositionForMineEntryContentProbe.csproj",
    "global.json",
  ];
  if (
    value.privateBuildBoundary !== "private_temp_copied_project_no_repo_parent_discovery_no_external_package_sources" ||
    !Array.isArray(value.buildInputManifest) ||
    value.buildInputManifest.length !== expectedInputs.length ||
    canonical(value.buildInputManifest.map((x) => x?.relativePath)) !== canonical(expectedInputs) ||
    !value.buildInputManifest.every(
      (x) =>
        x &&
        typeof x === "object" &&
        canonical(Object.keys(x).sort()) === canonical(["relativePath", "sha256"]) &&
        typeof x.relativePath === "string" &&
        /^[a-f0-9]{64}$/.test(x.sha256),
    ) ||
    !/^\d+\.\d+\.\d+$/.test(value.sdkVersion) ||
    !/^[a-f0-9]{64}$/.test(value.sdkInfoSha256) ||
    value.restoreCommand !== "dotnet restore PositionForMineEntryContentProbe.csproj --configfile NuGet.Config" ||
    value.buildCommand !==
      "dotnet build PositionForMineEntryContentProbe.csproj --no-restore --nologo --output output" ||
    value.artifactOutput !== "output/PositionForMineEntryContentProbe.dll" ||
    !/^[a-f0-9]{64}$/.test(value.artifactSha256) ||
    !/^[a-f0-9]{64}$/.test(value.provenanceSha256) ||
    value.provenanceSha256 !== buildProvenanceDigest(value)
  )
    fail("build provenance invalid");
}
export function validateDossier(d) {
  exact(
    d,
    [
      "schemaVersion",
      "artifactKind",
      "realizationId",
      "actionId",
      "topology",
      "target",
      "decompilerProvenance",
      "loaderProvenance",
      "buildProvenance",
      "sourceManifest",
      "mapRealization",
      "anchors",
      "semanticBoundary",
      "bdd",
      "conclusion",
    ],
    "dossier",
  );
  if (
    d.schemaVersion !== 4 ||
    d.artifactKind !== "portfolio_primitive_exact_target_source_map_realization" ||
    d.realizationId !== "portfolio_position_for_mine_entry_source_realization_v2" ||
    d.actionId !== ACTION ||
    d.topology !== TOPOLOGY ||
    canonical(d.target) !== canonical(TARGET)
  )
    fail("dossier identity drift");
  exact(
    d.decompilerProvenance,
    ["version", "sha256", "payloadFileCount", "payloadCanonicalSha256"],
    "decompiler provenance",
  );
  if (
    canonical(d.decompilerProvenance) !==
    canonical({
      version: TOOL.version,
      sha256: TOOL.sha256,
      payloadFileCount: TOOL.payloadFileCount,
      payloadCanonicalSha256: TOOL.payloadCanonicalSha256,
    })
  )
    fail("decompiler provenance drift");
  loaderProvenanceCheck(d.loaderProvenance);
  buildProvenanceCheck(d.buildProvenance);
  exact(d.sourceManifest, ["csharpFileCount", "canonicalSha256"], "source manifest");
  if (
    !Number.isInteger(d.sourceManifest.csharpFileCount) ||
    d.sourceManifest.csharpFileCount < 1 ||
    !/^[a-f0-9]{64}$/.test(d.sourceManifest.canonicalSha256)
  )
    fail("source manifest invalid");
  exact(
    d.mapRealization,
    [
      "asset",
      "relativeFileName",
      "sha256",
      "layer",
      "producers",
      "parsedForms",
      "ordinaryProducer",
      "excludedSpecialProducers",
      "candidateTiles",
      "probeState",
    ],
    "map realization",
  );
  const r = d.mapRealization,
    reconstructed = deriveMapRealization({
      state: "probed",
      gameAssemblyVersion: "",
      mapAsset: r.asset,
      mapFile: r.relativeFileName,
      mapXnbSha256: r.sha256,
      layerCount: 0,
      layerNames: [],
      actionCount: r.producers?.length,
      actions: r.producers,
      note: "",
      loaderProvenance: d.loaderProvenance,
    });
  if (
    r.probeState !== "probed" ||
    canonical(r.producers) !== canonical(reconstructed.producers) ||
    canonical(r.parsedForms) !== canonical(reconstructed.parsedForms) ||
    canonical(r.ordinaryProducer) !== canonical(reconstructed.ordinaryProducer) ||
    canonical(r.excludedSpecialProducers) !== canonical(reconstructed.excludedSpecialProducers) ||
    canonical(r.candidateTiles) !== canonical(reconstructed.candidateTiles)
  )
    fail("map realization drift");
  if (
    !Array.isArray(d.anchors) ||
    d.anchors.length !== ANCHOR_DEFS.length ||
    new Set(d.anchors.map((a) => a.anchorId)).size !== ANCHOR_DEFS.length
  )
    fail("anchors invalid");
  for (const a of d.anchors) {
    const e = ANCHOR_DEFS.find((x) => x.anchorId === a.anchorId);
    if (!e) fail("unknown anchor");
    exact(a, [...Object.keys(e), "startByte", "endByte", "fileSha256", "sliceSha256"], "anchor");
    if (
      canonical(Object.fromEntries(Object.keys(e).map((k) => [k, a[k]]))) !== canonical(e) ||
      !Number.isInteger(a.startByte) ||
      !Number.isInteger(a.endByte) ||
      a.endByte <= a.startByte ||
      !/^[a-f0-9]{64}$/.test(a.fileSha256) ||
      !/^[a-f0-9]{64}$/.test(a.sliceSha256)
    )
      fail("anchor drift");
  }
  exact(d.semanticBoundary, Object.keys(expectedBoundary()), "semantic boundary");
  if (canonical(d.semanticBoundary) !== canonical(expectedBoundary())) fail("semantic boundary drift");
  exact(d.bdd, ["scenario", "given", "when", "then", "verifier"], "bdd");
  if (
    d.bdd.scenario !== "position_for_mine_entry approaches the unique ordinary Mine producer" ||
    !d.bdd.given.includes("runtime Given") ||
    !d.bdd.when.includes("derives a cardinal-adjacent") ||
    !d.bdd.then.includes("GetGrabTile") ||
    !d.bdd.verifier.includes("fresh native")
  )
    fail("BDD overclaim");
  exact(d.conclusion, ["sourceMapStatus", "projectionState", "liveState", "nonClaim"], "conclusion");
  if (
    d.conclusion.sourceMapStatus !== "realized" ||
    d.conclusion.projectionState !== "blocked_pending_dynamic_path_facing_collision_proof" ||
    d.conclusion.liveState !== "not_performed" ||
    d.conclusion.nonClaim !==
      "This dossier does not claim candidate passability, collision safety, final-facing safety, reachability, controller success, receipt evidence, implementation, publication, or live closure."
  )
    fail("conclusion overclaim");
  return true;
}
async function payloadState(root) {
  await noReparse(root);
  const visit = async (rel = "") => {
    const entries = await readdir(path.join(root, rel), { withFileTypes: true }).catch(() =>
      fail("locked decompiler payload missing"),
    );
    return (
      await Promise.all(
        entries.map(async (e) => {
          const next = rel ? `${rel}/${e.name}` : e.name;
          if (e.isSymbolicLink()) fail("locked decompiler payload reparse");
          return e.isDirectory() ? visit(next) : e.isFile() ? [next] : fail("locked decompiler payload invalid");
        }),
      )
    ).flat();
  };
  const files = (await visit()).sort();
  return {
    fileCount: files.length,
    canonicalSha256: manifestHash(
      await Promise.all(
        files.map(async (relativePath) => ({
          relativePath,
          sha256: sha256(await readFile(path.join(root, relativePath))),
        })),
      ),
    ),
  };
}
async function lockedTool() {
  const home = os.homedir(),
    toolPath = path.join(home, ...TOOL.installRelativePath.split("/")),
    payloadRoot = path.join(home, ...TOOL.payloadRelativePath.split("/")),
    toolIdentity = await identity(toolPath, TOOL.sha256),
    payload = await payloadState(payloadRoot);
  if (payload.fileCount !== TOOL.payloadFileCount || payload.canonicalSha256 !== TOOL.payloadCanonicalSha256)
    fail("locked decompiler payload drift");
  const { stdout } = await run(toolPath, ["--version"]);
  if (stdout.split(/\r?\n/)[0].trim() !== TOOL.version) fail("locked decompiler version drift");
  return { toolPath, toolIdentity, payloadRoot };
}
async function verifyTool(tool) {
  await verifyIdentity(tool.toolPath, tool.toolIdentity);
  const payload = await payloadState(tool.payloadRoot);
  if (payload.fileCount !== TOOL.payloadFileCount || payload.canonicalSha256 !== TOOL.payloadCanonicalSha256)
    fail("locked decompiler payload drift");
}
async function sourceTree(root, rel = "") {
  const out = [];
  for (const e of await readdir(path.join(root, rel), { withFileTypes: true })) {
    const next = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) fail("decompiler output reparse");
    if (e.isDirectory()) out.push(...(await sourceTree(root, next)));
    else if (e.isFile() && next.endsWith(".cs")) out.push([next, await readFile(path.join(root, next))]);
  }
  return out;
}
async function freshSource(gamePath) {
  const target = await targetAssembly(gamePath),
    output = await secureDirectory("gamebuddy-position-source-");
  try {
    await verifySnapshot(target);
    const tool = await lockedTool();
    await verifyTool(tool);
    await verifySnapshot(target);
    await run(tool.toolPath, ["--disable-updatecheck", "-p", "--nested-directories", "-o", output, target.path]);
    await verifyTool(tool);
    await verifySnapshot(target);
    const files = Object.fromEntries(await sourceTree(output));
    if (!Object.keys(files).length) fail("empty decompile");
    return {
      files,
      tool,
      cleanup: async () => {
        await rm(output, { recursive: true, force: true });
        await disposeTargetAssembly(target);
      },
    };
  } catch (e) {
    await rm(output, { recursive: true, force: true });
    await disposeTargetAssembly(target);
    throw e;
  }
}
async function snapshotGameInputs(gamePath, closure) {
  const gameRoot = path.resolve(gamePath),
    root = await secureDirectory("gamebuddy-position-probe-");
  try {
    await noReparse(gameRoot);
    targetClosureCheck(closure);
    const inputs = [...closure, ...SNAPSHOT_ASSETS],
      files = [];
    for (const input of inputs) {
      const source = path.resolve(gameRoot, input.relativeFileName);
      if (!inside(gameRoot, source)) fail("snapshot escaped root");
      const before = await identity(source, input.sha256),
        bytes = await readFile(source);
      await verifyIdentity(source, before);
      const dest = path.join(root, input.relativeFileName);
      await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
      await noReparse(path.dirname(dest));
      await writeFile(dest, bytes, { flag: "wx", mode: 0o444 });
      await chmod(dest, 0o444);
      files.push({ relativeFileName: input.relativeFileName, identity: await identity(dest, input.sha256) });
    }
    return { root, files, cleanup: () => rm(root, { recursive: true, force: true }) };
  } catch (e) {
    await rm(root, { recursive: true, force: true });
    throw e;
  }
}
async function verifyGameSnapshot(s) {
  await noReparse(s.root);
  for (const f of s.files) await verifyIdentity(path.join(s.root, f.relativeFileName), f.identity);
}
function removeDisplayNames(value) {
  if (Array.isArray(value)) return value.map(removeDisplayNames);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "displayName")
        .map(([key, item]) => [key, removeDisplayNames(item)]),
    );
  return value;
}
async function freshProbe(gamePath) {
  const directory = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "stardew-portfolio-position-for-mine-entry-content-probe",
    ),
    buildRoot = await secureDirectory("gamebuddy-position-build-");
  let snapshot;
  try {
    const projectRoot = path.join(buildRoot, "probe"),
      output = path.join(projectRoot, "output");
    await mkdir(projectRoot, { recursive: true, mode: 0o700 });
    for (const name of ["PositionForMineEntryContentProbe.cs", "PositionForMineEntryContentProbe.csproj"])
      await copyFile(path.join(directory, name), path.join(projectRoot, name), fsConstants.COPYFILE_EXCL);
    const sdkVersion = (await run("dotnet", ["--version"])).stdout.trim(),
      sdkInfo = (await run("dotnet", ["--info"])).stdout;
    if (!/^\d+\.\d+\.\d+$/.test(sdkVersion)) fail("dotnet sdk identity invalid");
    await writeFile(
      path.join(projectRoot, "global.json"),
      JSON.stringify({ sdk: { version: sdkVersion, rollForward: "disable" } }),
      { flag: "wx", mode: 0o444 },
    );
    await writeFile(
      path.join(projectRoot, "NuGet.Config"),
      "<configuration><packageSources><clear /></packageSources></configuration>",
      { flag: "wx", mode: 0o444 },
    );
    const inputs = [];
    for (const relativePath of [
      "PositionForMineEntryContentProbe.cs",
      "PositionForMineEntryContentProbe.csproj",
      "global.json",
      "NuGet.Config",
    ]) {
      const item = await identity(path.join(projectRoot, relativePath));
      inputs.push({ relativePath, sha256: item.sha256, identity: item });
    }
    await run("dotnet", ["restore", "PositionForMineEntryContentProbe.csproj", "--configfile", "NuGet.Config"], {
      cwd: projectRoot,
    });
    for (const item of inputs) await verifyIdentity(path.join(projectRoot, item.relativePath), item.identity);
    await run(
      "dotnet",
      ["build", "PositionForMineEntryContentProbe.csproj", "--no-restore", "--nologo", "--output", "output"],
      { cwd: projectRoot },
    );
    for (const item of inputs) await verifyIdentity(path.join(projectRoot, item.relativePath), item.identity);
    const artifact = path.join(output, "PositionForMineEntryContentProbe.dll"),
      artifactIdentity = await identity(artifact);
    const discovery = removeDisplayNames(
      JSON.parse((await run("dotnet", [artifact, "--discover", path.resolve(gamePath)])).stdout),
    );
    targetClosureCheck(discovery.declaredSnapshotClosure);
    snapshot = await snapshotGameInputs(gamePath, discovery.declaredSnapshotClosure);
    await verifyGameSnapshot(snapshot);
    const manifest = {
      privateSnapshotBoundary: SNAPSHOT_BOUNDARY,
      declaredSnapshotClosure: discovery.declaredSnapshotClosure,
      allowedFrameworkFallbackIdentities: discovery.allowedFrameworkFallbackIdentities,
    };
    await writeFile(path.join(snapshot.root, "probe-loader-manifest.json"), JSON.stringify(manifest), {
      flag: "wx",
      mode: 0o444,
    });
    const { stdout } = await run("dotnet", [artifact, snapshot.root]);
    await verifyIdentity(artifact, artifactIdentity);
    await verifyGameSnapshot(snapshot);
    const buildProvenance = {
      privateBuildBoundary: "private_temp_copied_project_no_repo_parent_discovery_no_external_package_sources",
      buildInputManifest: inputs.map(({ relativePath, sha256 }) => ({ relativePath, sha256 })),
      sdkVersion,
      sdkInfoSha256: sha256(sdkInfo),
      restoreCommand: "dotnet restore PositionForMineEntryContentProbe.csproj --configfile NuGet.Config",
      buildCommand: "dotnet build PositionForMineEntryContentProbe.csproj --no-restore --nologo --output output",
      artifactOutput: "output/PositionForMineEntryContentProbe.dll",
      artifactSha256: artifactIdentity.sha256,
    };
    return {
      probe: removeDisplayNames(JSON.parse(stdout)),
      buildProvenance: { ...buildProvenance, provenanceSha256: buildProvenanceDigest(buildProvenance) },
    };
  } finally {
    await snapshot?.cleanup();
    await rm(buildRoot, { recursive: true, force: true });
  }
}
async function realization(gamePath) {
  const source = await freshSource(gamePath);
  try {
    const files = Object.entries(source.files)
        .map(([relativePath, bytes]) => ({ relativePath, sha256: sha256(bytes) }))
        .sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
      probeRun = await freshProbe(gamePath);
    return {
      files,
      anchors: extractSourceAnchors(source.files),
      probe: probeRun.probe,
      buildProvenance: probeRun.buildProvenance,
      tool: source.tool,
    };
  } finally {
    await source.cleanup();
  }
}
function dossierFrom(o) {
  const map = deriveMapRealization(o.probe);
  return {
    schemaVersion: 4,
    artifactKind: "portfolio_primitive_exact_target_source_map_realization",
    realizationId: "portfolio_position_for_mine_entry_source_realization_v2",
    actionId: ACTION,
    topology: TOPOLOGY,
    target: TARGET,
    decompilerProvenance: {
      version: TOOL.version,
      sha256: TOOL.sha256,
      payloadFileCount: TOOL.payloadFileCount,
      payloadCanonicalSha256: TOOL.payloadCanonicalSha256,
    },
    loaderProvenance: o.probe.loaderProvenance,
    buildProvenance: o.buildProvenance,
    sourceManifest: { csharpFileCount: o.files.length, canonicalSha256: manifestHash(o.files) },
    mapRealization: { ...map, probeState: "probed" },
    anchors: o.anchors,
    semanticBoundary: expectedBoundary(),
    bdd: {
      scenario: "position_for_mine_entry approaches the unique ordinary Mine producer",
      given:
        "Required runtime Given: a fresh native observation proves the local player can reach the opaque ordinary Mine producer; source/map realization makes no reachability claim.",
      when: "One typed position_for_mine_entry request derives a cardinal-adjacent opaque approach tile and assigns native PathFindController with fixed facing.",
      then: "Only fresh runtime evidence may establish GetGrabTile equal to the ordinary producer and a terminal receipt.",
      verifier:
        "The connected runner correlates receipt and fresh native observation; this dossier does not replace runtime proof.",
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
export async function mint({ gamePath, output }) {
  if (!gamePath || !output) fail("usage: --game-path <path> --output <json>");
  const d = dossierFrom(await realization(gamePath));
  validateDossier(d);
  await writeFile(path.resolve(output), `${JSON.stringify(d, null, 2)}\n`);
  return d;
}
export async function verify({ gamePath, dossierPath }) {
  const d = JSON.parse(await readFile(path.resolve(dossierPath), "utf8"));
  validateDossier(d);
  const o = await realization(gamePath),
    fresh = dossierFrom(o);
  if (
    canonical(d.sourceManifest) !== canonical(fresh.sourceManifest) ||
    canonical(d.anchors) !== canonical(fresh.anchors) ||
    canonical(d.mapRealization) !== canonical(fresh.mapRealization) ||
    canonical(d.loaderProvenance) !== canonical(fresh.loaderProvenance) ||
    canonical(d.buildProvenance) !== canonical(fresh.buildProvenance)
  )
    fail("fresh source, map, or loader realization drifted");
  return {
    actionId: ACTION,
    sourceMapStatus: "realized",
    verifiedAgainst: "fresh_locked_target_source_snapshot_map_and_loader_closure",
  };
}
export { MAP, TARGET, ANCHOR_DEFS };
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  try {
    const a = process.argv.slice(2),
      get = (k) => a[a.indexOf(k) + 1],
      r =
        a.includes("--output") && !a.includes("--dossier")
          ? await mint({ gamePath: get("--game-path"), output: get("--output") })
          : a.includes("--dossier") && !a.includes("--output")
            ? await verify({ gamePath: get("--game-path"), dossierPath: get("--dossier") })
            : fail("usage: choose --output or --dossier");
    console.log(JSON.stringify(r, null, 2));
  } catch (e) {
    console.error(`stardew-portfolio-position-for-mine-entry-source-realization: ${e.message}`);
    process.exitCode = 1;
  }
