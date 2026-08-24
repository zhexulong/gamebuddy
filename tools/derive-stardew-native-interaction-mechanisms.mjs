import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { enumerateNativeInteractionMechanisms } from "./lib/stardew-native-interaction-mechanisms.mjs";

const ASSEMBLY_NAME = "Stardew Valley.dll";
const EXPECTED_VERSION = "1.6.15.24356";
const EXPECTED_SHA256 = "7f1e5b8e58d2758b78570ba771bbeb03d33522f62188bf6c32edf0cf626deaee";
const OPTIONS = ["--disable-updatecheck", "-p", "--nested-directories"];
const execFileAsync = promisify(execFile);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}
function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!option.startsWith("--")) fail("invalid_argument", `Unexpected argument ${option}.`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) fail("invalid_argument", `Missing value for ${option}.`);
    result[option.slice(2)] = value;
  }
  if (!result["game-path"] || !result.out)
    fail("arguments_required", "Usage: --game-path <installed-game-path> --out <report-path>");
  return result;
}
async function files(root, current = root, output = []) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const candidate = path.join(current, entry.name);
    if (entry.isDirectory()) await files(root, candidate, output);
    else if (entry.isFile() && entry.name.endsWith(".cs")) output.push(candidate);
  }
  return output;
}
async function checkTarget(gamePath) {
  const assemblyPath = path.join(gamePath, ASSEMBLY_NAME);
  let assembly;
  try {
    assembly = await stat(assemblyPath);
  } catch {
    fail("target_assembly_missing", `Missing ${ASSEMBLY_NAME}.`);
  }
  const actualHash = sha256(await readFile(assemblyPath));
  if (actualHash !== EXPECTED_SHA256)
    fail("target_assembly_hash_mismatch", "Exact target hash does not match.", { actualHash });
  const version = (
    await execFileAsync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "$p=$env:GAMEBUDDY_INSPECT_ASSEMBLY;(Get-Item -LiteralPath $p).VersionInfo.FileVersion",
      ],
      { encoding: "utf8", env: { ...process.env, GAMEBUDDY_INSPECT_ASSEMBLY: assemblyPath } },
    )
  ).stdout.trim();
  if (version !== EXPECTED_VERSION)
    fail("target_assembly_version_mismatch", "Exact target file version does not match.", { version });
  const contentHashesPath = path.join(gamePath, "Content", "ContentHashes.json");
  let contentHashes;
  try {
    contentHashes = JSON.parse(await readFile(contentHashesPath, "utf8"));
  } catch {
    fail("content_manifest_missing", "Could not read exact target Content/ContentHashes.json.");
  }
  return {
    assemblyPath,
    target: { relativePath: ASSEMBLY_NAME, fileVersion: version, lengthBytes: assembly.size, sha256: actualHash },
    contentHashes,
    contentHashesSha256: sha256(await readFile(contentHashesPath)),
  };
}
async function decompile(assemblyPath) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gamebuddy-stardew-mechanisms-"));
  const tool = process.env.ILSPYCMD_PATH || "ilspycmd";
  try {
    const version = (await execFileAsync(tool, ["--version"], { encoding: "utf8" })).stdout.trim().split(/\r?\n/)[0];
    if (version !== "ilspycmd: 9.1.0.7988")
      fail("decompiler_version_mismatch", "Locked ilspycmd version required.", { version });
    await execFileAsync(tool, [...OPTIONS, "-o", root, assemblyPath], { encoding: "utf8", maxBuffer: 256 * 1024 });
    return {
      root,
      tool: "ilspycmd",
      toolVersion: version,
      configurationDigest: sha256(JSON.stringify({ tool: "ilspycmd", options: OPTIONS, target: ASSEMBLY_NAME })),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    if (error.code?.startsWith("decompiler_")) throw error;
    fail("assembly_decompilation_failed", "Could not decompile exact target.", { cause: error.message });
  }
}
async function records(root) {
  const rows = [];
  const sourceFiles = [];
  const manifest = [];
  for (const filePath of (await files(root)).sort()) {
    const relativePath = path.relative(root, filePath).replaceAll(path.sep, "/");
    const text = await readFile(filePath, "utf8");
    const sourceSha256 = sha256(text);
    rows.push({ relativePath, text });
    sourceFiles.push({ relativePath, sha256: sourceSha256, byteLength: Buffer.byteLength(text, "utf8") });
    manifest.push(`${relativePath}\t${sourceSha256}`);
  }
  return { rows, sourceFiles, sourceFileCount: rows.length, sourceManifestSha256: sha256(`${manifest.join("\n")}\n`) };
}
function contentManifest(contentHashes) {
  if (!contentHashes || typeof contentHashes !== "object" || Array.isArray(contentHashes))
    fail("content_manifest_invalid", "ContentHashes.json must be an object.");
  const entries = Object.entries(contentHashes)
    .map(([relativePath, contentHash]) => ({ relativePath: relativePath.replaceAll("\\", "/"), contentHash }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const seen = new Set();
  for (const entry of entries) {
    if (
      !entry.relativePath ||
      entry.relativePath.startsWith("/") ||
      entry.relativePath.split("/").some((part) => !part || part === "." || part === "..") ||
      seen.has(entry.relativePath.toLowerCase()) ||
      typeof entry.contentHash !== "string" ||
      !entry.contentHash
    )
      fail("content_manifest_invalid", "ContentHashes.json has an unsafe, duplicate, or malformed logical path.", {
        entry,
      });
    seen.add(entry.relativePath.toLowerCase());
  }
  return {
    entries,
    contentManifestSha256: sha256(
      `${entries.map((entry) => `${entry.relativePath}\t${entry.contentHash}`).join("\n")}\n`,
    ),
  };
}
async function atomicWrite(filePath, report) {
  const output = path.resolve(filePath);
  const temporary = `${output}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`);
  await rename(temporary, output);
}
async function main() {
  const args = parseArgs(process.argv.slice(2).filter((argument) => argument !== "--"));
  const target = await checkTarget(path.resolve(args["game-path"]));
  const decompilation = await decompile(target.assemblyPath);
  try {
    const source = await records(decompilation.root);
    const enumeration = await enumerateNativeInteractionMechanisms(source.rows);
    const content = contentManifest(target.contentHashes);
    const report = {
      schemaVersion: 1,
      artifactKind: "native_interaction_mechanism_enumeration",
      target: target.target,
      decompilation: {
        tool: decompilation.tool,
        toolVersion: decompilation.toolVersion,
        configurationDigest: decompilation.configurationDigest,
      },
      source: {
        sourceFileCount: source.sourceFileCount,
        sourceManifestSha256: source.sourceManifestSha256,
        files: source.sourceFiles,
      },
      content: {
        contentHashesSha256: target.contentHashesSha256,
        contentManifestSha256: content.contentManifestSha256,
        pathCount: content.entries.length,
        paths: content.entries,
        expansionState: "not_interpreted_by_stage_1",
      },
      enumeration,
    };
    await atomicWrite(args.out, report);
  } finally {
    await rm(decompilation.root, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(`${error.code ?? "native_interaction_mechanism_enumeration_failed"}: ${error.message}`);
  process.exitCode = 1;
});
