import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deriveArchitectureAccounting, sha256Text } from "./lib/stardew-native-architecture-accounting.mjs";

const ASSEMBLY_NAME = "Stardew Valley.dll";
const CONTENT_MANIFEST_PATH = "Content/ContentHashes.json";
const EXPECTED_VERSION = "1.6.15.24356";
const EXPECTED_ASSEMBLY_SHA256 = "7f1e5b8e58d2758b78570ba771bbeb03d33522f62188bf6c32edf0cf626deaee";
const EXPECTED_CONTENT_HASHES_SHA256 = "8143aa3110810e0039282ab8e9989417092388edb84c8c3b6c0b6f23840a4349";
const EXPECTED_ILSPYCMD_SHA256 = "5da34ef8b7a3d7e2057d27a0a84ec8e1ccdddb35d6d519058fce1e2f374c4c7f";
const EXPECTED_ILSPYCMD_NUPKG_SHA512 = "52af105a73cbca189fe10af74f36d4a709761879b02a96c9a084ba43bd70b45f1c4f22d9eb327864395042b947ccecc1bc9f0c45041bcef2732be78fb41ce481";
const EXPECTED_ILSPYCMD_VERSION = "ilspycmd: 9.1.0.7988";
const ILSPYCMD_PACKAGE_VERSION = "9.1.0.7988";
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_REPORT_ROOT = path.join(REPOSITORY_ROOT, ".worktree");
const DECOMPILE_OPTIONS = ["--disable-updatecheck", "-p", "--nested-directories"];
const execFileAsync = promisify(execFile);

const ROOT_REGISTER = Object.freeze([
  { id: "root:control-action", family: "player-control", sourcePath: "StardewValley/Game1.cs", anchor: "public static bool pressActionButton(" },
  { id: "root:control-tool", family: "player-control", sourcePath: "StardewValley/Game1.cs", anchor: "public static bool pressUseToolButton()" },
  { id: "root:menu-host", family: "menu-event-minigame", sourcePath: "StardewValley/Game1.cs", anchor: "public static void updateActiveMenu(GameTime gameTime)" },
  { id: "root:game-update", family: "game-update", sourcePath: "StardewValley/Game1.cs", anchor: "private void _update(GameTime gameTime)" },
  { id: "root:world-location", family: "world-location", sourcePath: "StardewValley/GameLocation.cs", anchor: "public virtual bool performAction(string fullActionString" },
  { id: "root:content-loader", family: "content-dispatch", sourcePath: "StardewValley/DataLoader.cs", anchor: "public static class DataLoader" },
  { id: "root:save", family: "save-load", sourcePath: "StardewValley/SaveGame.cs", anchor: "public static IEnumerator<int> Save()" },
  { id: "root:new-day", family: "day-progression", sourcePath: "StardewValley/Game1.cs", anchor: "public static void NewDay(float timeToPause)" },
  { id: "root:network", family: "network", sourcePath: "StardewValley/Multiplayer.cs", anchor: "Game1.client.receiveMessages();" },
]);

const BOUNDARY_REGISTER = Object.freeze([
  { id: "boundary:world-location-content-text", family: "content-boundary", sourcePath: "StardewValley/GameLocation.cs", anchor: "Game1.content.LoadString(" },
  { id: "boundary:world-location-event-host", family: "event-boundary", sourcePath: "StardewValley/GameLocation.cs", anchor: "public virtual void startEvent(Event evt)" },
  { id: "boundary:menu-host-current", family: "menu-boundary", sourcePath: "StardewValley/Game1.cs", anchor: "public static void updateActiveMenu(GameTime gameTime)" },
  { id: "boundary:save-iterator", family: "save-boundary", sourcePath: "StardewValley/SaveGame.cs", anchor: "public static IEnumerator<int> getSaveEnumerator()" },
  { id: "boundary:network-client", family: "network-boundary", sourcePath: "StardewValley/Multiplayer.cs", anchor: "Game1.client.receiveMessages();" },
  { id: "boundary:content-loader", family: "content-boundary", sourcePath: "StardewValley/DataLoader.cs", anchor: "public static class DataLoader" },
]);
const REQUIRED_ROOT_FAMILIES = Object.freeze(["player-control", "menu-event-minigame", "game-update", "world-location", "content-dispatch", "save-load", "day-progression", "network"]);

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function hash(algorithm, value) {
  return createHash(algorithm).update(value).digest("hex");
}

function sha256(value) {
  return hash("sha256", value);
}

function configurationDigest() {
  return sha256(JSON.stringify({
    tool: "ilspycmd",
    executableSha256: EXPECTED_ILSPYCMD_SHA256,
    options: DECOMPILE_OPTIONS,
    target: ASSEMBLY_NAME,
  }));
}

export function parseArgs(argv) {
  const result = {};
  const accepted = new Set(["game-path", "out"]);
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!option.startsWith("--")) fail("invalid_argument", `Unexpected argument ${option}.`);
    const name = option.slice(2);
    if (!accepted.has(name)) fail("invalid_argument", `Unknown option --${name}.`);
    if (Object.hasOwn(result, name)) fail("invalid_argument", `Repeated option --${name}.`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) fail("invalid_argument", `Missing value for ${option}.`);
    result[name] = value;
  }
  if (!result["game-path"] || !result.out) {
    fail("arguments_required", "Usage: --game-path <installed-game-path> --out <report-path>");
  }
  return Object.freeze(result);
}

function assertWindows() {
  if (process.platform !== "win32") {
    fail("unsupported_platform", "Native Stardew architecture accounting currently requires Windows.");
  }
}

function assertSafeRelativePath(relativePath, kind) {
  if (typeof relativePath !== "string" || !relativePath || relativePath.includes("\\") || relativePath.startsWith("/") || relativePath.split("/").some((part) => !part || part === "." || part === "..")) {
    fail("content_manifest_path_invalid", `Invalid ${kind} path.`, { relativePath });
  }
}

function resolveUnder(root, relativePath) {
  const resolved = path.resolve(root, ...relativePath.split("/"));
  const relative = path.relative(root, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail("snapshot_path_escape", "Snapshot path escaped its controlled root.", { relativePath });
  }
  return resolved;
}

async function hashFile(algorithm, filePath) {
  return hash(algorithm, await readFile(filePath));
}

async function readFileVersion(assemblyPath) {
  const versionResult = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-Command",
    "$p=$env:GAMEBUDDY_INSPECT_ASSEMBLY;(Get-Item -LiteralPath $p).VersionInfo.FileVersion",
  ], {
    encoding: "utf8",
    env: { ...process.env, GAMEBUDDY_INSPECT_ASSEMBLY: assemblyPath },
  });
  return versionResult.stdout.trim();
}

async function resolveDecompiler(snapshotRoot) {
  const executablePath = process.env.ILSPYCMD_PATH;
  if (!executablePath) {
    fail("decompiler_path_required", "Set ILSPYCMD_PATH to the absolute path of the locked ilspycmd.exe.");
  }
  if (!path.isAbsolute(executablePath)) {
    fail("decompiler_path_invalid", "ILSPYCMD_PATH must be an absolute executable path.", { executablePath });
  }
  const resolvedPath = path.resolve(executablePath);
  const expectedSuffix = path.join(".dotnet", "tools", "ilspycmd.exe").toLowerCase();
  if (!resolvedPath.toLowerCase().endsWith(expectedSuffix)) {
    fail("decompiler_path_untrusted", "ILSPYCMD_PATH must identify the locked per-user .NET tool shim.", { resolvedPath });
  }
  const packagePath = path.join(path.dirname(resolvedPath), ".store", "ilspycmd", ILSPYCMD_PACKAGE_VERSION, "ilspycmd", ILSPYCMD_PACKAGE_VERSION, `ilspycmd.${ILSPYCMD_PACKAGE_VERSION}.nupkg`);
  const [executableSha256, packageSha512] = await Promise.all([
    hashFile("sha256", resolvedPath),
    hashFile("sha512", packagePath),
  ]).catch(() => fail("decompiler_missing", "Locked ilspycmd executable or package is missing.", { resolvedPath, packagePath }));
  if (executableSha256 !== EXPECTED_ILSPYCMD_SHA256 || packageSha512 !== EXPECTED_ILSPYCMD_NUPKG_SHA512) {
    fail("decompiler_identity_mismatch", "Configured ilspycmd does not match the locked executable and package identity.", {
      expectedExecutableSha256: EXPECTED_ILSPYCMD_SHA256,
      actualExecutableSha256: executableSha256,
      expectedPackageSha512: EXPECTED_ILSPYCMD_NUPKG_SHA512,
      actualPackageSha512: packageSha512,
    });
  }
  const packageSnapshotRoot = path.join(snapshotRoot, ".store", "ilspycmd", ILSPYCMD_PACKAGE_VERSION, "ilspycmd", ILSPYCMD_PACKAGE_VERSION);
  await mkdir(path.dirname(packageSnapshotRoot), { recursive: true });
  const packageSnapshotPath = path.join(snapshotRoot, `ilspycmd.${ILSPYCMD_PACKAGE_VERSION}.nupkg`);
  await copyFile(packagePath, packageSnapshotPath);
  const snapshotPackageSha512 = await hashFile("sha512", packageSnapshotPath);
  if (snapshotPackageSha512 !== EXPECTED_ILSPYCMD_NUPKG_SHA512) {
    fail("decompiler_snapshot_hash_mismatch", "Could not create an identity-preserving ilspycmd package snapshot.", { expected: EXPECTED_ILSPYCMD_NUPKG_SHA512, actual: snapshotPackageSha512 });
  }
  try {
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Expand-Archive -LiteralPath $env:GAMEBUDDY_NUPKG -DestinationPath $env:GAMEBUDDY_PACKAGE_ROOT -Force",
    ], {
      encoding: "utf8",
      env: { ...process.env, GAMEBUDDY_NUPKG: packageSnapshotPath, GAMEBUDDY_PACKAGE_ROOT: packageSnapshotRoot },
    });
  } catch (error) {
    fail("decompiler_snapshot_extract_failed", "Could not extract the verified ilspycmd package snapshot.", { cause: error.message });
  }
  const snapshotPath = path.join(snapshotRoot, "ilspycmd.exe");
  await copyFile(resolvedPath, snapshotPath);
  const snapshotSha256 = await hashFile("sha256", snapshotPath);
  if (snapshotSha256 !== EXPECTED_ILSPYCMD_SHA256) {
    fail("decompiler_snapshot_hash_mismatch", "Could not create an identity-preserving ilspycmd snapshot.", { expected: EXPECTED_ILSPYCMD_SHA256, actual: snapshotSha256 });
  }
  const version = await execFileAsync(snapshotPath, ["--version"], { encoding: "utf8", env: { ...process.env, DOTNET_CLI_HOME: snapshotRoot } });
  const toolVersion = version.stdout.trim().split(/\r?\n/)[0];
  if (toolVersion !== EXPECTED_ILSPYCMD_VERSION) {
    fail("decompiler_version_mismatch", "The verified ilspycmd snapshot does not match the locked tool version.", { expected: EXPECTED_ILSPYCMD_VERSION, actual: toolVersion });
  }
  return Object.freeze({ snapshotPath, executableSha256: snapshotSha256, packageSha512: snapshotPackageSha512, toolVersion });
}

function parseContentHashes(manifestBytes) {
  const manifestSha256 = sha256(manifestBytes);
  if (manifestSha256 !== EXPECTED_CONTENT_HASHES_SHA256) {
    fail("content_manifest_hash_mismatch", "ContentHashes.json differs from the exact locked target.", { expected: EXPECTED_CONTENT_HASHES_SHA256, actual: manifestSha256 });
  }
  let contentHashes;
  try {
    contentHashes = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    fail("content_manifest_invalid", "ContentHashes.json is not valid JSON.");
  }
  if (!contentHashes || Array.isArray(contentHashes) || Object.getPrototypeOf(contentHashes) !== Object.prototype) {
    fail("content_manifest_invalid", "ContentHashes.json must be a plain path-to-MD5 object.");
  }
  const sourceEntries = Object.entries(contentHashes);
  if (sourceEntries.length === 0) fail("content_manifest_empty", "ContentHashes.json has no declared content inputs.");
  const seen = new Set();
  const entries = [];
  for (const [rawPath, expectedMd5] of sourceEntries) {
    const relativePath = rawPath.replaceAll("\\", "/");
    assertSafeRelativePath(relativePath, "content manifest");
    const key = relativePath.toLowerCase();
    if (seen.has(key)) fail("content_manifest_path_duplicate", "ContentHashes.json has case-colliding paths.", { relativePath });
    seen.add(key);
    if (typeof expectedMd5 !== "string" || !/^[a-fA-F0-9]{32}$/.test(expectedMd5)) {
      fail("content_manifest_entry_invalid", "ContentHashes.json contains a non-MD5 content hash.", { relativePath, expectedMd5 });
    }
    entries.push(Object.freeze({ relativePath, expectedMd5: expectedMd5.toLowerCase() }));
  }
  return Object.freeze({ entries: Object.freeze(entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath))), manifestSha256 });
}

async function copyVerifiedContentSnapshot(gamePath, snapshotRoot) {
  const originalManifestPath = resolveUnder(gamePath, CONTENT_MANIFEST_PATH);
  const snapshotManifestPath = resolveUnder(snapshotRoot, CONTENT_MANIFEST_PATH);
  await mkdir(path.dirname(snapshotManifestPath), { recursive: true });
  await copyFile(originalManifestPath, snapshotManifestPath);
  const manifest = parseContentHashes(await readFile(snapshotManifestPath));

  for (const entry of manifest.entries) {
    const sourcePath = resolveUnder(path.join(gamePath, "Content"), entry.relativePath);
    const destinationPath = resolveUnder(path.join(snapshotRoot, "Content"), entry.relativePath);
    try {
      await mkdir(path.dirname(destinationPath), { recursive: true });
      await copyFile(sourcePath, destinationPath);
    } catch {
      fail("content_snapshot_copy_failed", "Could not snapshot a declared target content input.", { relativePath: entry.relativePath });
    }
    const actualMd5 = await hashFile("md5", destinationPath);
    if (actualMd5 !== entry.expectedMd5) {
      fail("content_hash_mismatch", "A snapshotted target content input does not match ContentHashes.json.", { relativePath: entry.relativePath, expected: entry.expectedMd5, actual: actualMd5 });
    }
  }
  return Object.freeze({ manifestSha256: manifest.manifestSha256, paths: manifest.entries.map((entry) => entry.relativePath) });
}

async function snapshotTarget(gamePath, snapshotRoot) {
  const originalAssemblyPath = resolveUnder(gamePath, ASSEMBLY_NAME);
  const assemblyPath = resolveUnder(snapshotRoot, ASSEMBLY_NAME);
  try {
    await copyFile(originalAssemblyPath, assemblyPath);
  } catch {
    fail("target_assembly_missing", `Missing ${ASSEMBLY_NAME}.`);
  }
  const assemblySha256 = await hashFile("sha256", assemblyPath);
  if (assemblySha256 !== EXPECTED_ASSEMBLY_SHA256) {
    fail("target_assembly_hash_mismatch", "Supplied assembly differs from exact locked target.", { expected: EXPECTED_ASSEMBLY_SHA256, actual: assemblySha256 });
  }
  const fileVersion = await readFileVersion(assemblyPath);
  if (fileVersion !== EXPECTED_VERSION) {
    fail("target_assembly_version_mismatch", "Supplied assembly differs from the locked file version.", { expected: EXPECTED_VERSION, actual: fileVersion });
  }
  const assembly = await stat(assemblyPath);
  const content = await copyVerifiedContentSnapshot(gamePath, snapshotRoot);
  return Object.freeze({
    assemblyPath,
    target: Object.freeze({ relativePath: ASSEMBLY_NAME, fileVersion, lengthBytes: assembly.size, sha256: assemblySha256 }),
    content,
  });
}

async function decompile(decompiler, assemblyPath) {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "gamebuddy-stardew-architecture-decompile-"));
  try {
    await execFileAsync(decompiler.snapshotPath, [...DECOMPILE_OPTIONS, "-o", outputRoot, assemblyPath], { encoding: "utf8", maxBuffer: 256 * 1024, env: { ...process.env, DOTNET_CLI_HOME: path.dirname(decompiler.snapshotPath) } });
    return outputRoot;
  } catch (error) {
    await rm(outputRoot, { recursive: true, force: true });
    fail("assembly_decompilation_failed", "Could not produce the target source snapshot.", { cause: error.message });
  }
}

async function findFiles(root, current = root, output = []) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const candidate = path.join(current, entry.name);
    if (entry.isDirectory()) await findFiles(root, candidate, output);
    else if (entry.isFile() && entry.name.endsWith(".cs")) output.push(candidate);
  }
  return output;
}

async function sourceRecords(root) {
  const files = (await findFiles(root)).sort();
  const records = [];
  const manifestRows = [];
  for (const filePath of files) {
    const relativePath = path.relative(root, filePath).replaceAll(path.sep, "/");
    const text = await readFile(filePath, "utf8");
    records.push(Object.freeze({ relativePath, text }));
    manifestRows.push(`${relativePath}\t${sha256Text(text)}`);
  }
  return Object.freeze({
    records: Object.freeze(records),
    fileCount: records.length,
    manifestSha256: sha256(`${manifestRows.join("\n")}\n`),
  });
}

function contentManifestSha256(entries) {
  return sha256(`${entries.map((entry) => `${entry.relativePath}\t${entry.expectedMd5}`).join("\n")}\n`);
}

async function resolveLocalReportPath(outputPath) {
  if (!path.isAbsolute(outputPath) && outputPath.split(/[\\/]/).some((part) => part === "..")) {
    fail("output_path_invalid", "Report path may not traverse outside .worktree.", { outputPath });
  }
  await mkdir(LOCAL_REPORT_ROOT, { recursive: true });
  const reportRootRealPath = await realpath(LOCAL_REPORT_ROOT);
  const resolved = path.resolve(REPOSITORY_ROOT, outputPath);
  const relative = path.relative(reportRootRealPath, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail("output_path_outside_local_root", "Report output must be a file under the repository .worktree directory.", { outputPath });
  }
  const parent = path.dirname(resolved);
  await mkdir(parent, { recursive: true });
  const parentRealPath = await realpath(parent);
  const parentRelative = path.relative(reportRootRealPath, parentRealPath);
  if (parentRelative.startsWith("..") || path.isAbsolute(parentRelative)) {
    fail("output_path_outside_local_root", "Report parent escapes the repository .worktree directory.", { outputPath });
  }
  try {
    await lstat(resolved);
    fail("output_path_exists", "Report output must not overwrite an existing local artifact.", { outputPath });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return resolved;
}

async function atomicWrite(outputPath, report) {
  const resolved = await resolveLocalReportPath(outputPath);
  const temporary = path.join(path.dirname(resolved), `.${path.basename(resolved)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, resolved);
}

async function main(argv = process.argv.slice(2)) {
  assertWindows();
  const args = parseArgs(argv.filter((argument) => argument !== "--"));
  const snapshotRoot = await mkdtemp(path.join(os.tmpdir(), "gamebuddy-stardew-architecture-input-"));
  let decompilationRoot;
  try {
    const decompiler = await resolveDecompiler(snapshotRoot);
    const target = await snapshotTarget(path.resolve(args["game-path"]), snapshotRoot);
    decompilationRoot = await decompile(decompiler, target.assemblyPath);
    const sources = await sourceRecords(decompilationRoot);
    const accounting = deriveArchitectureAccounting({
      sourceRecords: sources.records,
      contentPaths: target.content.paths,
      rootRegister: ROOT_REGISTER,
      boundaryRegister: BOUNDARY_REGISTER,
      requiredRootFamilies: REQUIRED_ROOT_FAMILIES,
    });
    const report = Object.freeze({
      schemaVersion: 1,
      artifactKind: "native_action_architecture_accounting",
      target: target.target,
      decompilation: Object.freeze({
        tool: "ilspycmd",
        toolVersion: decompiler.toolVersion,
        executableSha256: decompiler.executableSha256,
        packageSha512: decompiler.packageSha512,
        options: DECOMPILE_OPTIONS,
        configurationDigest: configurationDigest(),
      }),
      inputUniverse: Object.freeze({
        sourceFileCount: sources.fileCount,
        sourceManifestSha256: sources.manifestSha256,
        contentPathCount: target.content.paths.length,
        contentHashesSha256: target.content.manifestSha256,
        contentManifestSha256: contentManifestSha256(parseContentHashes(await readFile(resolveUnder(snapshotRoot, CONTENT_MANIFEST_PATH))).entries),
      }),
      accounting,
      analysisBoundary: Object.freeze({
        sourceSemantics: "not_inferred",
        primitiveBasis: "not_inferred",
        playerActionSet: "not_inferred",
        gameBuddyProjection: "not_inferred",
        callResolution: "not_performed",
        liveBehaviorValidation: "not_performed",
      }),
    });
    await atomicWrite(args.out, report);
  } finally {
    if (decompilationRoot) await rm(decompilationRoot, { recursive: true, force: true });
    await rm(snapshotRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`${error.code ?? "native_action_architecture_map_failed"}: ${error.message}`);
    process.exitCode = 1;
  });
}
