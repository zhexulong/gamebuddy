#!/usr/bin/env node
import { spawn } from "node:child_process";
/** Locked-target source/map dossier for the blocked ordinary route to Mine. */
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
const MAP_INPUT = Object.freeze({
  relativeFileName: "Content/Maps/Mine.xnb",
  sha256: "a8669be89fd338360bbe637df3c383f3dc5f0d50b1028ad7385aeb39f6e700ff",
});
export const SNAPSHOT_INPUTS = Object.freeze([
  TARGET,
  MAP_INPUT,
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
  Object.freeze({
    relativeFileName: "Content/ContentHashes.json",
    sha256: "8143aa3110810e0039282ab8e9989417092388edb84c8c3b6c0b6f23840a4349",
  }),
]);
const EXPECTED_MINE_ACTIONS = Object.freeze([
  { layer: "Buildings", x: 23, y: 9, action: "Mine" },
  { layer: "Buildings", x: 67, y: 9, action: "Mine 77377" },
]);
const TOOL = Object.freeze({
  path: ".dotnet/tools/ilspycmd.exe",
  payload: ".dotnet/tools/.store/ilspycmd/9.1.0.7988/ilspycmd/9.1.0.7988/tools/net8.0/any",
  version: "ilspycmd: 9.1.0.7988",
  sha256: "5da34ef8b7a3d7e2057d27a0a84ec8e1ccdddb35d6d519058fce1e2f374c4c7f",
  fileCount: 59,
  payloadSha256: "4bfe5d499f00ffe9373d400ab68a069b8fed079a96ae3aaa7804423f0eba80ea",
});
const ANCHORS = Object.freeze([
  {
    anchorId: "normal_player_warp_collision",
    relativePath: "StardewValley/Farmer.cs",
    declaration: "protected virtual bool MovePositionImpl(",
    needle: "Warp warp =",
    semanticRole: "ordinary_movement_discovers_map_warp",
  },
  {
    anchorId: "normal_player_warp_dispatch",
    relativePath: "StardewValley/Farmer.cs",
    declaration: "protected virtual bool MovePositionImpl(",
    needle: "warpFarmer(warp, direction);",
    semanticRole: "movement_direction_is_native_warp_facing_input",
  },
  {
    anchorId: "warp_facing_boundary",
    relativePath: "StardewValley/Game1.cs",
    declaration:
      "public static void warpFarmer(LocationRequest locationRequest, int tileX, int tileY, int facingDirectionAfterWarp)",
    needle: "int warp_offset_x = nextFarmerWarpOffsetX;",
    semanticRole: "native_warp_accepts_facing_only_at_internal_boundary",
  },
  {
    anchorId: "mine_entry_producer",
    relativePath: "StardewValley/GameLocation.cs",
    declaration: "public virtual bool performAction(string[] action, Farmer who, Location tileLocation)",
    needle: 'case "Mine":',
    semanticRole: "ordinary_mine_action_producer",
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
  throw new Error(message);
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
async function noReparse(candidate) {
  for (let current = path.resolve(candidate); ; current = path.dirname(current)) {
    const entry = await lstat(current).catch(() => fail(`path missing: ${current}`));
    if (entry.isSymbolicLink()) fail(`path reparse: ${current}`);
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
async function verifyIdentity(file, before) {
  if (canonical(await identity(file, before.sha256)) !== canonical(before))
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
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
async function payloadState(root) {
  const visit = async (rel = "") => {
    const entries = await readdir(path.join(root, rel), { withFileTypes: true }).catch(() =>
      fail("locked decompiler payload missing"),
    );
    return (
      await Promise.all(
        entries.map(async (entry) => {
          const next = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.isSymbolicLink()) fail("locked decompiler payload reparse");
          return entry.isDirectory()
            ? visit(next)
            : entry.isFile()
              ? [next]
              : fail("locked decompiler payload invalid");
        }),
      )
    ).flat();
  };
  const files = (await visit()).sort();
  const manifest = await Promise.all(
    files.map(async (relativePath) => ({
      relativePath,
      sha256: sha256(await readFile(path.join(root, relativePath))),
    })),
  );
  return { fileCount: files.length, canonicalSha256: manifestHash(manifest) };
}
async function lockedTool() {
  const home = os.homedir(),
    toolPath = path.join(home, ...TOOL.path.split("/")),
    payloadRoot = path.join(home, ...TOOL.payload.split("/"));
  const tool = await identity(toolPath, TOOL.sha256);
  const payload = await payloadState(payloadRoot);
  if (payload.fileCount !== TOOL.fileCount || payload.canonicalSha256 !== TOOL.payloadSha256)
    fail("locked decompiler payload drift");
  const { stdout } = await run(toolPath, ["--version"]);
  if (stdout.split(/\r?\n/)[0].trim() !== TOOL.version) fail("locked decompiler version drift");
  return { toolPath, tool, payloadRoot };
}
async function verifyTool(tool) {
  await verifyIdentity(tool.toolPath, tool.tool);
  const payload = await payloadState(tool.payloadRoot);
  if (payload.fileCount !== TOOL.fileCount || payload.canonicalSha256 !== TOOL.payloadSha256)
    fail("locked decompiler payload drift");
}
function bodyEnd(s, b) {
  let d = 0,
    state = "code";
  for (let i = b; i < s.length; i++) {
    const c = s[i],
      n = s[i + 1];
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
    else if (c === "{") d++;
    else if (c === "}" && --d === 0) return i + 1;
  }
  fail("unterminated declaration");
}
function methodSlice(bytes, declaration) {
  const source = bytes.toString("utf8"),
    positions = [];
  for (let at = source.indexOf(declaration); at >= 0; at = source.indexOf(declaration, at + declaration.length))
    positions.push(at);
  if (positions.length !== 1) fail(`declaration missing/non-unique: ${declaration}`);
  const start = positions[0],
    brace = source.indexOf("{", start);
  if (brace < 0) fail("declaration body missing");
  return { source, start, end: bodyEnd(source, brace) };
}
export function extractAnchors(files) {
  return ANCHORS.map((anchor) => {
    const bytes = files[anchor.relativePath];
    if (!Buffer.isBuffer(bytes)) fail(`source missing: ${anchor.relativePath}`);
    const { source, start, end } = methodSlice(bytes, anchor.declaration),
      text = source.slice(start, end);
    if (
      !text.includes(anchor.needle) ||
      (anchor.anchorId !== "normal_player_warp_collision" && text.split(anchor.needle).length - 1 !== 1)
    )
      fail(`anchor drift: ${anchor.anchorId} (${text.split(anchor.needle).length - 1})`);
    return {
      ...anchor,
      startByte: Buffer.byteLength(source.slice(0, start)),
      endByte: Buffer.byteLength(source.slice(0, end)),
      fileSha256: sha256(bytes),
      sliceSha256: sha256(Buffer.from(text)),
    };
  });
}
async function sourceTree(root, rel = "") {
  const out = [];
  for (const entry of await readdir(path.join(root, rel), { withFileTypes: true })) {
    const next = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) fail("decompiler output reparse");
    if (entry.isDirectory()) out.push(...(await sourceTree(root, next)));
    else if (entry.isFile() && next.endsWith(".cs")) out.push([next, await readFile(path.join(root, next))]);
  }
  return out;
}
async function freshSource(gamePath) {
  const target = await targetAssembly(gamePath),
    output = await secureDirectory("gamebuddy-m8-route-source-");
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
      cleanup: async () => {
        let cleanupError;
        try {
          await rm(output, { recursive: true, force: true });
        } catch (error) {
          cleanupError = error;
        }
        try {
          await disposeTargetAssembly(target);
        } catch (error) {
          cleanupError ??= error;
        }
        if (cleanupError) throw cleanupError;
      },
    };
  } catch (error) {
    await rm(output, { recursive: true, force: true }).catch(() => {});
    await disposeTargetAssembly(target).catch(() => {});
    throw error;
  }
}
async function snapshotGameInputs(gamePath) {
  const gameRoot = path.resolve(gamePath),
    root = await secureDirectory("gamebuddy-m8-route-probe-");
  try {
    await noReparse(gameRoot);
    const files = [];
    for (const input of SNAPSHOT_INPUTS) {
      const source = path.resolve(gameRoot, input.relativeFileName);
      if (!inside(gameRoot, source)) fail("snapshot input path escaped game root");
      const before = await identity(source, input.sha256),
        bytes = await readFile(source);
      await verifyIdentity(source, before);
      const destination = path.join(root, input.relativeFileName);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await noReparse(path.dirname(destination));
      await writeFile(destination, bytes, { flag: "wx", mode: 0o444 });
      await chmod(destination, 0o444);
      files.push({ relativeFileName: input.relativeFileName, identity: await identity(destination, input.sha256) });
    }
    return { root, files, cleanup: () => rm(root, { recursive: true, force: true }) };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
async function verifyGameSnapshot(snapshot) {
  await noReparse(snapshot.root);
  for (const file of snapshot.files)
    await verifyIdentity(path.join(snapshot.root, file.relativeFileName), file.identity);
}
export function deriveMapRealization(probe) {
  exact(probe, ["state", "mapAsset", "mapFile", "mapXnbSha256", "actions"], "map probe");
  if (
    probe.state !== "probed" ||
    probe.mapAsset !== "Maps/Mine" ||
    probe.mapFile !== MAP_INPUT.relativeFileName ||
    probe.mapXnbSha256 !== MAP_INPUT.sha256 ||
    !Array.isArray(probe.actions)
  )
    fail("map probe identity drift");
  const sorted = [...probe.actions].sort(
    (left, right) =>
      left.layer.localeCompare(right.layer) ||
      left.x - right.x ||
      left.y - right.y ||
      left.action.localeCompare(right.action),
  );
  if (
    probe.actions.some(
      (action) =>
        !action ||
        typeof action !== "object" ||
        Array.isArray(action) ||
        canonical(action) !== canonical({ layer: action.layer, x: action.x, y: action.y, action: action.action }) ||
        action.layer !== "Buildings" ||
        !Number.isInteger(action.x) ||
        !Number.isInteger(action.y) ||
        typeof action.action !== "string" ||
        !(action.action === "Mine" || action.action.startsWith("Mine ")),
    ) ||
    canonical(probe.actions) !== canonical(sorted) ||
    canonical(probe.actions) !== canonical(EXPECTED_MINE_ACTIONS)
  )
    fail("Mine producer set drifted");
  return {
    asset: probe.mapAsset,
    relativeFileName: probe.mapFile,
    sha256: probe.mapXnbSha256,
    ordinaryProducer: probe.actions[0],
    excludedSpecialProducer: probe.actions[1],
  };
}
async function freshProbe(gamePath) {
  const directory = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "stardew-portfolio-m8-mine-route-content-probe",
    ),
    project = path.join(directory, "MineRouteContentProbe.csproj"),
    source = path.join(directory, "MineRouteContentProbe.cs"),
    buildRoot = await secureDirectory("gamebuddy-m8-route-probe-build-"),
    snapshot = await snapshotGameInputs(gamePath);
  try {
    const inputs = [await identity(project), await identity(source)],
      output = path.join(buildRoot, "output");
    await run("dotnet", ["build", project, "--nologo", "--output", output]);
    for (const input of inputs) await verifyIdentity(input.realpath, input);
    const artifact = path.join(output, "MineRouteContentProbe.dll"),
      artifactIdentity = await identity(artifact);
    await verifyGameSnapshot(snapshot);
    const { stdout } = await run("dotnet", [artifact, snapshot.root]);
    await verifyIdentity(artifact, artifactIdentity);
    await verifyGameSnapshot(snapshot);
    return deriveMapRealization(JSON.parse(stdout));
  } finally {
    await snapshot.cleanup().catch(() => {});
    await rm(buildRoot, { recursive: true, force: true }).catch(() => {});
  }
}
async function realization(gamePath) {
  const source = await freshSource(gamePath);
  try {
    const files = Object.entries(source.files)
      .map(([relativePath, bytes]) => ({ relativePath, sha256: sha256(bytes) }))
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return {
      sourceManifest: { csharpFileCount: files.length, canonicalSha256: manifestHash(files) },
      anchors: extractAnchors(source.files),
      mapRealization: await freshProbe(gamePath),
    };
  } finally {
    await source.cleanup().catch(() => {});
  }
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
      "conclusion",
    ],
    "dossier",
  );
  if (
    d.schemaVersion !== 2 ||
    d.artifactKind !== "portfolio_m8_route_source_map_realization" ||
    d.realizationId !== "portfolio_m8_mine_route_source_realization_v2" ||
    d.actionId !== ACTION ||
    d.topology !== TOPOLOGY ||
    canonical(d.target) !== canonical(TARGET)
  )
    fail("dossier identity drift");
  exact(d.sourceManifest, ["csharpFileCount", "canonicalSha256"], "sourceManifest");
  if (
    !Number.isInteger(d.sourceManifest.csharpFileCount) ||
    d.sourceManifest.csharpFileCount < 1 ||
    !/^[a-f0-9]{64}$/.test(d.sourceManifest.canonicalSha256)
  )
    fail("source manifest invalid");
  exact(
    d.mapRealization,
    ["asset", "relativeFileName", "sha256", "ordinaryProducer", "excludedSpecialProducer"],
    "mapRealization",
  );
  deriveMapRealization({
    state: "probed",
    mapAsset: d.mapRealization.asset,
    mapFile: d.mapRealization.relativeFileName,
    mapXnbSha256: d.mapRealization.sha256,
    actions: [d.mapRealization.ordinaryProducer, d.mapRealization.excludedSpecialProducer],
  });
  if (
    !Array.isArray(d.anchors) ||
    d.anchors.length !== ANCHORS.length ||
    canonical(d.anchors.map((a) => a.anchorId).sort()) !== canonical(ANCHORS.map((a) => a.anchorId).sort())
  )
    fail("source anchor drift");
  exact(d.conclusion, ["status", "blocker", "nonClaim"], "conclusion");
  if (
    d.conclusion.status !== "blocked" ||
    d.conclusion.blocker !==
      "Exact route-map producer missing: locked target assets establish the ordinary Maps/Mine Action producer but do not provide the exterior warp-chain facts or a deterministic normal-player final approach-pose producer." ||
    d.conclusion.nonClaim !==
      "No reachability, route composition, bridge capability, live execution, receipt, publication, or live closure is claimed."
  )
    fail("conclusion must retain exact blocked route-map/approach-pose boundary");
  return true;
}
function dossierFrom(observed) {
  return {
    schemaVersion: 2,
    artifactKind: "portfolio_m8_route_source_map_realization",
    realizationId: "portfolio_m8_mine_route_source_realization_v2",
    actionId: ACTION,
    topology: TOPOLOGY,
    target: TARGET,
    sourceManifest: observed.sourceManifest,
    mapRealization: observed.mapRealization,
    anchors: observed.anchors,
    conclusion: {
      status: "blocked",
      blocker:
        "Exact route-map producer missing: locked target assets establish the ordinary Maps/Mine Action producer but do not provide the exterior warp-chain facts or a deterministic normal-player final approach-pose producer.",
      nonClaim:
        "No reachability, route composition, bridge capability, live execution, receipt, publication, or live closure is claimed.",
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
    canonical(dossier.sourceManifest) !== canonical(observed.sourceManifest) ||
    canonical(dossier.anchors) !== canonical(observed.anchors)
  )
    fail("fresh exact-target source/decompiler drift");
  if (canonical(dossier.mapRealization) !== canonical(observed.mapRealization))
    fail("fresh exact-target map producer drift");
  return {
    status: "blocked",
    blocker: "exact route-map producer missing and deterministic normal-player approach pose producer missing",
    verifiedAgainst: "fresh_locked_target_source_and_snapshot_map",
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2),
    get = (key) => args[args.indexOf(key) + 1];
  try {
    const result = args.includes("--output")
      ? await mint({ gamePath: get("--game-path"), output: get("--output") })
      : await verify({ gamePath: get("--game-path"), dossierPath: get("--dossier") });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`stardew-portfolio-m8-mine-route-source-realization: ${error.message}`);
    process.exitCode = 1;
  }
}
export { TARGET, ANCHORS, EXPECTED_MINE_ACTIONS };
