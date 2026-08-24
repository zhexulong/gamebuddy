#!/usr/bin/env node
import { spawn } from "node:child_process";
/** Locked-target source/map realization dossier for the initial Mine entry only. */
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  disposeTargetAssembly,
  targetAssembly,
  verifySnapshot,
} from "./stardew-portfolio-m8-elevator-source-realization.mjs";

const ACTION = "enter_mine",
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
  ordinary: Object.freeze({ x: 23, y: 9, action: "Mine", boundFloor: 1, defaulted: true }),
  excluded: Object.freeze({ x: 67, y: 9, action: "Mine 77377", boundFloor: 77377, defaulted: false }),
});
const SNAPSHOT_INPUTS = Object.freeze([
  TARGET,
  Object.freeze({
    relativeFileName: "xTile.dll",
    sha256: "a7c0a758ac446bb4f7715651478e3097b7b3bb6fbd4daca52bfa8e80ee1e7df1",
  }),
  Object.freeze({
    relativeFileName: "StardewValley.GameData.dll",
    sha256: "9c03497c2d2ac24c94e2f25b3c2fc39ecde1bc97341e514c5f9fdcc1e759cb81",
  }),
  Object.freeze({
    relativeFileName: "MonoGame.Framework.dll",
    sha256: "92e5423a5d002b399de4369e483577007274c5634745f5414fd508981b7494de",
  }),
  Object.freeze({ relativeFileName: "System.Configuration.dll" }),
  Object.freeze({
    relativeFileName: "Content/ContentHashes.json",
    sha256: "8143aa3110810e0039282ab8e9989417092388edb84c8c3b6c0b6f23840a4349",
  }),
  Object.freeze({ relativeFileName: MAP.relativeFileName, sha256: MAP.sha256 }),
]);
const OPTIONS = Object.freeze(["--disable-updatecheck", "-p", "--nested-directories"]);
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
    anchorId: "game_location_mine_dispatch",
    relativePath: "StardewValley/GameLocation.cs",
    declaration: "public virtual bool performAction(string[] action, Farmer who, Location tileLocation)",
    needle: 'case "Mine":',
    semanticRole: "Mine_dispatch_optional_floor_default_and_native_commit",
  },
  {
    anchorId: "game1_enter_mine_boundary",
    relativePath: "StardewValley/Game1.cs",
    declaration: "public static void enterMine(int whatLevel, int? forceLayout = null)",
    needle: "warpFarmer(MineShaft.GetLevelName(whatLevel, forceLayout), 6, 6, 2);",
    semanticRole: "native_mine_warp_boundary",
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
function fail(message) {
  throw Object.assign(new Error(message), { code: "enter_mine_realization_invalid" });
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
  const relative = path.relative(root, candidate);
  return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function assertNoReparseAncestors(candidate) {
  for (let current = path.resolve(candidate); ; current = path.dirname(current)) {
    const entry = await lstat(current).catch(() => fail(`path missing: ${current}`));
    if (entry.isSymbolicLink()) fail(`path reparse: ${current}`);
    const parent = path.dirname(current);
    if (parent === current) return;
  }
}
async function secureDirectory(prefix) {
  const root = await mkdtemp(path.join(process.env.TEMP || os.tmpdir(), prefix));
  try {
    await assertNoReparseAncestors(root);
    await run("icacls.exe", [
      root,
      "/inheritance:r",
      "/grant:r",
      `${process.env.USERNAME}:(OI)(CI)F`,
      "/grant:r",
      "SYSTEM:(OI)(CI)F",
    ]);
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
async function fileIdentity(file, expectedHash) {
  await assertNoReparseAncestors(file);
  const entry = await lstat(file);
  if (!entry.isFile() || entry.isSymbolicLink()) fail(`regular file required: ${file}`);
  const bytes = await readFile(file);
  const digest = sha256(bytes);
  if (expectedHash && digest !== expectedHash) fail(`hash drift: ${path.basename(file)}`);
  return { dev: entry.dev, ino: entry.ino, size: entry.size, realpath: await realpath(file), sha256: digest };
}
async function verifyIdentity(file, identity) {
  if (canonical(await fileIdentity(file, identity.sha256)) !== canonical(identity))
    fail(`identity drift: ${path.basename(file)}`);
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
  for (let i = source.indexOf(declaration); i >= 0; i = source.indexOf(declaration, i + declaration.length))
    found.push(i);
  if (found.length !== 1) fail(`declaration missing or non-unique: ${declaration}`);
  const start = found[0],
    brace = source.indexOf("{", start);
  if (brace < 0) fail("declaration has no body");
  const end = bodyEnd(source, brace);
  return { source, start, end, slice: Buffer.from(source.slice(start, end)) };
}
function onceAndOrdered(text, parts, message) {
  const positions = parts.map((part) => {
    const first = text.indexOf(part);
    if (first < 0 || text.indexOf(part, first + part.length) >= 0) fail(message);
    return first;
  });
  if (positions.some((p, i) => i && p <= positions[i - 1])) fail(message);
}
function matchingParen(source, open) {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")" && --depth === 0) return i;
  }
  fail("unterminated if condition");
}
function mineIsLexicallyLocal(text, mine) {
  let found = false;
  for (let at = text.indexOf("if", 0); at >= 0 && at < mine; at = text.indexOf("if", at + 2)) {
    if (!/\bif\b/.test(text.slice(at, at + 2))) continue;
    const open = text.indexOf("(", at + 2);
    if (open < 0 || open > mine) continue;
    const close = matchingParen(text, open);
    if (text.slice(open + 1, close).replace(/\s+/g, "") !== "who.IsLocalPlayer") continue;
    const brace = text.indexOf("{", close + 1);
    if (brace < 0 || brace > mine) continue;
    if (mine > brace && mine < bodyEnd(text, brace)) found = true;
  }
  return found;
}
export function extractSourceAnchors(sourceFiles) {
  return ANCHOR_DEFS.map((expected) => {
    const bytes = sourceFiles[expected.relativePath];
    if (!Buffer.isBuffer(bytes)) fail(`source missing: ${expected.relativePath}`);
    const { source, start, end, slice } = methodSlice(bytes, expected.declaration),
      text = slice.toString("utf8");
    if (expected.anchorId === "game_location_mine_dispatch") {
      const mine = text.indexOf('case "Mine":');
      if (mine < 0 || text.indexOf('case "Mine":', mine + 1) >= 0 || !mineIsLexicallyLocal(text, mine))
        fail("Mine must be lexically contained by if (who.IsLocalPlayer)");
      const branch = text.slice(mine);
      onceAndOrdered(
        branch,
        [
          'case "Mine":',
          "TryGetOptionalInt(action, 1",
          "out error, 1",
          'playSound("stairsdown");',
          "Game1.enterMine(value3)",
        ],
        "Mine default-floor control flow drifted",
      );
    } else if (
      (text.match(/warpFarmer\(MineShaft\.GetLevelName\(whatLevel, forceLayout\), 6, 6, 2\);/g) || []).length !== 1
    )
      fail("enterMine warp control flow drifted");
    return {
      ...expected,
      startByte: Buffer.byteLength(source.slice(0, start)),
      endByte: Buffer.byteLength(source.slice(0, end)),
      fileSha256: sha256(bytes),
      sliceSha256: sha256(slice),
    };
  });
}
export function validateMapProbe(probe) {
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
    ],
    "map probe",
  );
  if (
    probe.state !== "probed" ||
    probe.mapAsset !== MAP.asset ||
    probe.mapFile !== MAP.relativeFileName ||
    probe.mapXnbSha256 !== MAP.sha256 ||
    probe.layerNames?.join("\n") !== "Back\nBuildings\nFront\nPaths" ||
    !Array.isArray(probe.actions) ||
    probe.actionCount !== probe.actions.length ||
    probe.actionCount !== 2
  )
    fail("map probe identity or bounds drifted");
  const ordinary = probe.actions.filter(
    (a) => canonical(a) === canonical({ layer: MAP.actionLayer, x: 23, y: 9, action: "Mine" }),
  );
  const excluded = probe.actions.filter(
    (a) => canonical(a) === canonical({ layer: MAP.actionLayer, x: 67, y: 9, action: "Mine 77377" }),
  );
  if (ordinary.length !== 1 || excluded.length !== 1) fail("Mine producer set drifted");
  return true;
}
function expectedBoundary() {
  return {
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
  };
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
    d.schemaVersion !== 2 ||
    d.artifactKind !== "portfolio_primitive_exact_target_source_map_realization" ||
    d.realizationId !== "portfolio_enter_mine_source_realization_v2" ||
    d.actionId !== ACTION ||
    d.topology !== TOPOLOGY ||
    canonical(d.target) !== canonical(TARGET)
  )
    fail("dossier identity or target drifted");
  exact(d.sourceManifest, ["csharpFileCount", "canonicalSha256"], "sourceManifest");
  if (
    !Number.isInteger(d.sourceManifest.csharpFileCount) ||
    d.sourceManifest.csharpFileCount < 1 ||
    !/^[a-f0-9]{64}$/.test(d.sourceManifest.canonicalSha256)
  )
    fail("source manifest invalid");
  exact(
    d.mapRealization,
    ["asset", "relativeFileName", "sha256", "layer", "ordinaryProducer", "excludedProducer", "probeState"],
    "mapRealization",
  );
  if (
    d.mapRealization.asset !== MAP.asset ||
    d.mapRealization.relativeFileName !== MAP.relativeFileName ||
    d.mapRealization.sha256 !== MAP.sha256 ||
    d.mapRealization.layer !== MAP.actionLayer ||
    canonical(d.mapRealization.ordinaryProducer) !== canonical(MAP.ordinary) ||
    canonical(d.mapRealization.excludedProducer) !== canonical(MAP.excluded) ||
    d.mapRealization.probeState !== "probed"
  )
    fail("map realization drifted");
  if (
    !Array.isArray(d.anchors) ||
    d.anchors.length !== ANCHOR_DEFS.length ||
    d.anchors.some(
      (a) =>
        !ANCHOR_DEFS.some(
          (e) =>
            canonical(a) ===
            canonical({
              ...e,
              startByte: a.startByte,
              endByte: a.endByte,
              fileSha256: a.fileSha256,
              sliceSha256: a.sliceSha256,
            }),
        ),
    )
  )
    fail("source anchors invalid");
  exact(d.semanticBoundary, Object.keys(expectedBoundary()), "semanticBoundary");
  if (canonical(d.semanticBoundary) !== canonical(expectedBoundary())) fail("semantic boundary drifted");
  exact(d.bdd, ["scenario", "given", "when", "then", "verifier"], "bdd");
  if (
    d.bdd.scenario !== "enter_mine enters the native default floor" ||
    d.bdd.given !==
      "Required runtime Given: a fresh native observation proves the local player is in Mine exterior; no UI interaction pose or producer reachability is required." ||
    d.bdd.when !== "One typed parameterless enter_mine request fixes the native level argument to 1." ||
    !d.bdd.then.includes("floor 1") ||
    !d.bdd.verifier.includes("fresh native location/floor observation")
  )
    fail("BDD boundary is incomplete");
  exact(d.conclusion, ["sourceMapStatus", "projectionState", "liveState", "nonClaim"], "conclusion");
  if (
    d.conclusion.sourceMapStatus !== "realized" ||
    d.conclusion.projectionState !== "eligible_for_connected_implementation_review" ||
    d.conclusion.liveState !== "not_performed" ||
    !d.conclusion.nonClaim.includes("does not claim")
  )
    fail("conclusion overclaims");
  return true;
}
async function payloadState(root) {
  await assertNoReparseAncestors(root);
  const visit = async (prefix = "") => {
    const entries = await readdir(path.join(root, prefix), { withFileTypes: true }).catch(() =>
      fail("locked decompiler payload missing"),
    );
    const nested = await Promise.all(
      entries.map(async (entry) => {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) fail("locked decompiler payload reparse");
        if (entry.isDirectory()) return visit(rel);
        return entry.isFile() ? [rel] : fail("locked decompiler payload invalid");
      }),
    );
    return nested.flat();
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
    payloadRoot = path.join(home, ...TOOL.payloadRelativePath.split("/"));
  await assertNoReparseAncestors(home);
  await assertNoReparseAncestors(toolPath);
  const toolIdentity = await fileIdentity(toolPath, TOOL.sha256);
  const payload = await payloadState(payloadRoot);
  if (payload.fileCount !== TOOL.payloadFileCount || payload.canonicalSha256 !== TOOL.payloadCanonicalSha256)
    fail("locked decompiler payload drift");
  const { stdout } = await run(toolPath, ["--version"]);
  if (stdout.split(/\r?\n/)[0].trim() !== TOOL.version) fail("locked decompiler version drift");
  return { toolPath, toolIdentity, payloadRoot };
}
async function verifyLockedTool(tool) {
  await verifyIdentity(tool.toolPath, tool.toolIdentity);
  const payload = await payloadState(tool.payloadRoot);
  if (payload.fileCount !== TOOL.payloadFileCount || payload.canonicalSha256 !== TOOL.payloadCanonicalSha256)
    fail("locked decompiler payload drift");
}
async function sourceTree(root, prefix = "") {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) fail(`decompiler output reparse: ${rel}`);
    if (entry.isDirectory()) result.push(...(await sourceTree(root, rel)));
    else if (entry.isFile() && rel.endsWith(".cs")) result.push([rel, await readFile(path.join(root, rel))]);
  }
  return result;
}
async function freshSource(gamePath) {
  const target = await targetAssembly(gamePath),
    output = await secureDirectory("gamebuddy-enter-mine-source-");
  try {
    await verifySnapshot(target);
    const tool = await lockedTool();
    await verifyLockedTool(tool);
    await verifySnapshot(target);
    await run(tool.toolPath, [...OPTIONS, "-o", output, target.path]);
    await verifyLockedTool(tool);
    await verifySnapshot(target);
    const pairs = await sourceTree(output);
    if (!pairs.length) fail("fresh decompile empty");
    return {
      files: Object.fromEntries(pairs),
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
async function snapshotGameInputs(gamePath) {
  const gameRoot = path.resolve(gamePath);
  await assertNoReparseAncestors(gameRoot);
  const root = await secureDirectory("gamebuddy-enter-mine-probe-snapshot-");
  try {
    const entries = await readdir(gameRoot, { withFileTypes: true });
    const dependencies = entries
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink() && entry.name.endsWith(".dll"))
      .map((entry) => Object.freeze({ relativeFileName: entry.name }));
    const inputs = [
      ...SNAPSHOT_INPUTS,
      ...dependencies.filter(
        (candidate) => !SNAPSHOT_INPUTS.some((input) => input.relativeFileName === candidate.relativeFileName),
      ),
    ];
    const files = [];
    for (const input of inputs) {
      const source = path.resolve(gameRoot, input.relativeFileName);
      if (!inside(gameRoot, source)) fail("snapshot input path escaped game root");
      const before = await fileIdentity(source, input.sha256),
        bytes = await readFile(source);
      await verifyIdentity(source, before);
      const destination = path.join(root, input.relativeFileName);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await assertNoReparseAncestors(path.dirname(destination));
      await writeFile(destination, bytes, { flag: "wx", mode: 0o444 });
      await chmod(destination, 0o444);
      files.push({ relativeFileName: input.relativeFileName, identity: await fileIdentity(destination, input.sha256) });
    }
    return { root, files, cleanup: async () => rm(root, { recursive: true, force: true }) };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
async function verifyGameSnapshot(snapshot) {
  await assertNoReparseAncestors(snapshot.root);
  for (const file of snapshot.files)
    await verifyIdentity(path.join(snapshot.root, file.relativeFileName), file.identity);
}
async function freshProbe(gamePath) {
  const probeDirectory = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "stardew-portfolio-enter-mine-content-probe",
    ),
    project = path.join(probeDirectory, "EnterMineContentProbe.csproj"),
    source = path.join(probeDirectory, "EnterMineContentProbe.cs");
  const buildRoot = await secureDirectory("gamebuddy-enter-mine-probe-build-"),
    snapshot = await snapshotGameInputs(gamePath);
  try {
    const inputs = [await fileIdentity(project), await fileIdentity(source)];
    const output = path.join(buildRoot, "output");
    await run("dotnet", ["build", project, "--nologo", "--output", output]);
    for (const input of inputs) await verifyIdentity(input.realpath, input);
    const artifact = path.join(output, "EnterMineContentProbe.dll"),
      artifactIdentity = await fileIdentity(artifact);
    await verifyGameSnapshot(snapshot);
    const { stdout } = await run("dotnet", [artifact, snapshot.root]);
    await verifyIdentity(artifact, artifactIdentity);
    await verifyGameSnapshot(snapshot);
    const probe = JSON.parse(stdout);
    validateMapProbe(probe);
    return probe;
  } finally {
    await snapshot.cleanup();
    await rm(buildRoot, { recursive: true, force: true });
  }
}
async function realization(gamePath) {
  const source = await freshSource(gamePath);
  try {
    const manifest = Object.entries(source.files)
      .map(([relativePath, bytes]) => ({ relativePath, sha256: sha256(bytes) }))
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return { files: manifest, anchors: extractSourceAnchors(source.files), probe: await freshProbe(gamePath) };
  } finally {
    await source.cleanup();
  }
}
function dossierFrom(observed) {
  return {
    schemaVersion: 2,
    artifactKind: "portfolio_primitive_exact_target_source_map_realization",
    realizationId: "portfolio_enter_mine_source_realization_v2",
    actionId: ACTION,
    topology: TOPOLOGY,
    target: TARGET,
    sourceManifest: { csharpFileCount: observed.files.length, canonicalSha256: manifestHash(observed.files) },
    mapRealization: {
      asset: MAP.asset,
      relativeFileName: MAP.relativeFileName,
      sha256: MAP.sha256,
      layer: MAP.actionLayer,
      ordinaryProducer: MAP.ordinary,
      excludedProducer: MAP.excluded,
      probeState: "probed",
    },
    anchors: observed.anchors,
    semanticBoundary: expectedBoundary(),
    bdd: {
      scenario: "enter_mine enters the native default floor",
      given:
        "Required runtime Given: a fresh native observation proves the local player is in Mine exterior; no UI interaction pose or producer reachability is required.",
      when: "One typed parameterless enter_mine request fixes the native level argument to 1.",
      then: "The native seam enters floor 1 and yields a terminal receipt plus fresh floor/location observation.",
      verifier:
        "The connected runner correlates the receipt and fresh native location/floor observation; this realization neither supplies nor replaces Mine-exterior, authorization, or receipt evidence.",
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
export async function mint({ gamePath, output }) {
  if (!gamePath || !output) fail("usage: --game-path <path> --output <json>");
  const dossier = dossierFrom(await realization(gamePath));
  validateDossier(dossier);
  await writeFile(path.resolve(output), `${JSON.stringify(dossier, null, 2)}\n`);
  return dossier;
}
export async function verify({ gamePath, dossierPath }) {
  const dossier = JSON.parse(await readFile(path.resolve(dossierPath), "utf8"));
  validateDossier(dossier);
  const observed = await realization(gamePath);
  if (
    dossier.sourceManifest.csharpFileCount !== observed.files.length ||
    dossier.sourceManifest.canonicalSha256 !== manifestHash(observed.files)
  )
    fail("fresh exact source manifest drifted");
  if (canonical(dossier.anchors) !== canonical(observed.anchors)) fail("fresh exact source anchors drifted");
  validateMapProbe(observed.probe);
  return {
    actionId: ACTION,
    sourceMapStatus: "realized",
    verifiedAgainst: "fresh_locked_target_source_and_snapshot_map",
  };
}
export { MAP, TARGET, ANCHOR_DEFS };
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  try {
    const a = process.argv.slice(2),
      get = (key) => a[a.indexOf(key) + 1];
    const result =
      a.includes("--output") && !a.includes("--dossier")
        ? await mint({ gamePath: get("--game-path"), output: get("--output") })
        : a.includes("--dossier") && !a.includes("--output")
          ? await verify({ gamePath: get("--game-path"), dossierPath: get("--dossier") })
          : fail("usage: choose --output or --dossier");
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`stardew-portfolio-enter-mine-source-realization: ${error.message}`);
    process.exitCode = 1;
  }
