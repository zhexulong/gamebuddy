import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, stat, lstat, writeFile, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseCSharpSyntaxStructure,
  assertCSharpSyntaxParseClean,
} from "./lib/stardew-csharp-syntax-structural-canary.mjs";

const EXPECTED_FILE_VERSION = "1.6.15.24356";
const EXPECTED_SHA256 = "7f1e5b8e58d2758b78570ba771bbeb03d33522f62188bf6c32edf0cf626deaee";
const ASSEMBLY_NAME = "Stardew Valley.dll";
const MANIFEST_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "stardew-csharp-syntax-structural-manifest.json",
);
const execFileAsync = promisify(execFile);

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function hashBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!option.startsWith("--")) fail("invalid_argument", `Unexpected argument ${option}.`);
    const key = option.slice(2);
    const value = argv[++index];
    if (!value || value.startsWith("--")) fail("invalid_argument", `Missing value for --${key}.`);
    options[key] = value;
  }
  if (!options["game-path"] || !options.out)
    fail("arguments_required", "Usage: --game-path <installed-game-path> --out <report-path>");
  return options;
}

async function sha256(filePath) {
  return hashBytes(await readFile(filePath));
}

function assertSafeRelativeCSharpPath(relativePath) {
  if (
    typeof relativePath !== "string" ||
    !relativePath.endsWith(".cs") ||
    relativePath.includes("\\") ||
    path.isAbsolute(relativePath) ||
    relativePath.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    fail("manifest_relative_path_invalid", "Manifest source path must be a normalized relative .cs path.", {
      relativePath,
    });
  }
}

async function readManifest() {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, "utf8"));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.entries) || manifest.entries.length === 0)
    fail("manifest_invalid", "Structural manifest has an unsupported schema or no entries.");
  const paths = manifest.entries.map((entry) => entry.relativePath);
  for (const entry of manifest.entries) {
    assertSafeRelativeCSharpPath(entry.relativePath);
    if (
      !Number.isInteger(entry.expectedByteLength) ||
      entry.expectedByteLength < 0 ||
      !/^[a-f0-9]{64}$/.test(entry.expectedSha256 ?? "")
    )
      fail("manifest_entry_invalid", "Structural manifest entry has invalid source attestation.", {
        relativePath: entry.relativePath,
      });
  }
  const sorted = [...paths].sort((left, right) => left.localeCompare(right));
  if (
    JSON.stringify(paths) !== JSON.stringify(sorted) ||
    new Set(paths.map((value) => value.toLowerCase())).size !== paths.length
  )
    fail(
      "manifest_entries_not_canonical",
      "Structural manifest entries must be sorted and unique under case-insensitive comparison.",
    );
  return Object.freeze({ manifest, manifestSha256: hashBytes(canonicalJson(manifest)) });
}

async function inspectAssembly(gamePath) {
  const assemblyPath = path.join(gamePath, ASSEMBLY_NAME);
  let assemblyStat;
  try {
    assemblyStat = await stat(assemblyPath);
  } catch {
    fail("target_assembly_missing", `Missing ${ASSEMBLY_NAME}.`);
  }
  const hash = await sha256(assemblyPath);
  if (hash !== EXPECTED_SHA256)
    fail(
      "target_assembly_hash_mismatch",
      "The supplied Stardew assembly does not match the exact locked target hash.",
      { expected: EXPECTED_SHA256, actual: hash },
    );
  const result = await execFileAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      "$p = $env:GAMEBUDDY_INSPECT_ASSEMBLY; (Get-Item -LiteralPath $p).VersionInfo.FileVersion",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, GAMEBUDDY_INSPECT_ASSEMBLY: assemblyPath },
    },
  );
  const fileVersion = (result.stdout || "").trim();
  if (fileVersion !== EXPECTED_FILE_VERSION)
    fail("target_assembly_version_mismatch", "The supplied Stardew assembly does not match the locked file version.", {
      expected: EXPECTED_FILE_VERSION,
      actual: fileVersion,
    });
  return Object.freeze({
    relativePath: ASSEMBLY_NAME,
    fileVersion,
    lengthBytes: assemblyStat.size,
    sha256: hash,
    assemblyPath,
  });
}

async function decompile(assemblyPath, expectedDecompiler) {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "gamebuddy-stardew-csharp-canary-"));
  const ilspyPath = process.env.ILSPYCMD_PATH || "ilspycmd";
  const options = ["--disable-updatecheck", "-p", "--nested-directories"];
  const configurationDigest = hashBytes(JSON.stringify({ tool: "ilspycmd", options, target: ASSEMBLY_NAME }));
  try {
    const version = await execFileAsync(ilspyPath, ["--version"], { encoding: "utf8" });
    const toolVersion = (version.stdout || "").trim().split(/\r?\n/)[0] || "unknown";
    if (
      toolVersion !== expectedDecompiler.toolVersion ||
      configurationDigest !== expectedDecompiler.configurationDigest
    ) {
      fail(
        "decompiler_attestation_mismatch",
        "The local decompiler/version/configuration does not match the structural manifest.",
        { expected: expectedDecompiler, actual: { toolVersion, configurationDigest } },
      );
    }
    await execFileAsync(ilspyPath, [...options, "-o", outputRoot, assemblyPath], {
      encoding: "utf8",
      maxBuffer: 256 * 1024,
    });
    return Object.freeze({ outputRoot, tool: "ilspycmd", toolVersion, options, configurationDigest });
  } catch (error) {
    await rm(outputRoot, { recursive: true, force: true });
    if (error.code?.startsWith("decompiler_")) throw error;
    fail("assembly_decompilation_failed", "Could not decompile the exact target assembly.", { cause: error.message });
  }
}

async function parseManifestFile(outputRoot, entry) {
  const sourcePath = path.resolve(outputRoot, entry.relativePath);
  const rootWithSeparator = `${path.resolve(outputRoot)}${path.sep}`;
  if (!sourcePath.startsWith(rootWithSeparator))
    fail("manifest_path_escape", "Manifest source path escapes the temporary decompilation root.", {
      relativePath: entry.relativePath,
    });
  let sourceStat;
  try {
    sourceStat = await lstat(sourcePath);
  } catch {
    fail("manifest_source_missing", "Decompiler did not emit a required structural-manifest file.", {
      relativePath: entry.relativePath,
    });
  }
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink())
    fail("manifest_source_not_regular_file", "Manifest source entry is not a regular non-symbolic file.", {
      relativePath: entry.relativePath,
    });
  const sourceBuffer = await readFile(sourcePath);
  if (sourceBuffer.length !== entry.expectedByteLength || hashBytes(sourceBuffer) !== entry.expectedSha256) {
    fail(
      "manifest_source_attestation_mismatch",
      "Decompiler output does not match the fixed structural-manifest source attestation.",
      {
        relativePath: entry.relativePath,
        expectedByteLength: entry.expectedByteLength,
        actualByteLength: sourceBuffer.length,
        expectedSha256: entry.expectedSha256,
        actualSha256: hashBytes(sourceBuffer),
      },
    );
  }
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(sourceBuffer);
  } catch {
    fail("manifest_source_invalid_utf8", "Manifest source file is not valid UTF-8.", {
      relativePath: entry.relativePath,
    });
  }
  const syntax = await parseCSharpSyntaxStructure({ source, relativePath: entry.relativePath });
  assertCSharpSyntaxParseClean(syntax);
  const matchingTopLevel = syntax.declarations.filter(
    (item) =>
      item.ownerDeclarationLocator === null &&
      item.declarationSyntaxKind === entry.expectedTopLevelDeclaration.declarationSyntaxKind &&
      item.identifierSyntax === entry.expectedTopLevelDeclaration.identifierSyntax,
  );
  if (matchingTopLevel.length !== 1)
    fail(
      "manifest_top_level_declaration_mismatch",
      "Expected exactly one top-level declaration from the structural manifest.",
      { relativePath: entry.relativePath, expected: entry.expectedTopLevelDeclaration, count: matchingTopLevel.length },
    );
  return Object.freeze(syntax);
}

async function writeAtomically(outputPath, content) {
  const resolved = path.resolve(outputPath);
  const temporary = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, resolved);
}

async function main() {
  const args = process.argv.slice(2).filter((argument) => argument !== "--");
  const { "game-path": gamePathArgument, out } = parseArgs(args);
  const { manifest, manifestSha256 } = await readManifest();
  const gamePath = path.resolve(gamePathArgument);
  const target = await inspectAssembly(gamePath);
  if (target.sha256 !== manifest.targetAssemblySha256)
    fail("manifest_target_mismatch", "Structural manifest is not for the supplied locked target assembly.");
  const decompilation = await decompile(target.assemblyPath, manifest.decompiler);
  try {
    const sourceFiles = [];
    for (const entry of manifest.entries) sourceFiles.push(await parseManifestFile(decompilation.outputRoot, entry));
    const [first] = sourceFiles;
    if (!sourceFiles.every((file) => canonicalJson(file.parser) === canonicalJson(first.parser)))
      fail("parser_provenance_inconsistent", "Parser provenance changed during sequential structural parsing.");
    const report = Object.freeze({
      schemaVersion: 2,
      artifactKind: "csharp_syntax_structural_manifest_canary",
      target: Object.freeze({
        relativePath: target.relativePath,
        fileVersion: target.fileVersion,
        lengthBytes: target.lengthBytes,
        sha256: target.sha256,
      }),
      decompilation: Object.freeze({
        tool: decompilation.tool,
        toolVersion: decompilation.toolVersion,
        options: decompilation.options,
        configurationDigest: decompilation.configurationDigest,
      }),
      parser: first.parser,
      sourceManifest: Object.freeze({
        schemaVersion: manifest.schemaVersion,
        manifestSha256,
        entryCount: manifest.entries.length,
        entries: manifest.entries,
      }),
      sourceFiles: sourceFiles.map(({ parser, ...file }) => Object.freeze(file)),
    });
    await writeAtomically(out, `${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await rm(decompilation.outputRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`${error.code ?? "stardew_csharp_syntax_canary_failed"}: ${error.message}`);
  process.exitCode = 1;
});
