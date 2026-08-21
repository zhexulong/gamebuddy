#!/usr/bin/env node
import { execFile } from "node:child_process";
/**
 * Produce a redacted, source-first semantic-kernel prototype from the exact
 * pinned Stardew installation. This is an audit artifact only: it never starts
 * the game, loads a save, creates actions, or changes game/mod state.
 */
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { deriveSoilTileSemanticKernels } from "./lib/stardew-source-semantic-kernel.mjs";

const execFileAsync = promisify(execFile);
const EXPECTED_FILE_VERSION = "1.6.15.24356";
const REQUIRED_SOURCES = Object.freeze([
  "StardewValley/Game1.cs",
  "StardewValley/Tools/Hoe.cs",
  "StardewValley/Tools/WateringCan.cs",
  "StardewValley/TerrainFeatures/HoeDirt.cs",
  "StardewValley/Object.cs",
  "StardewValley/Utility.cs",
  "StardewValley/Crop.cs",
]);

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  hash.update(await readFile(filePath));
  return hash.digest("hex");
}

async function inspectAssembly(assemblyPath) {
  try {
    await stat(assemblyPath);
  } catch {
    fail("target_assembly_missing", "The supplied directory does not contain Stardew Valley.dll.");
  }
  const result = await execFileAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      "$p = $env:GAMEBUDDY_INSPECT_ASSEMBLY; (Get-Item -LiteralPath $p).VersionInfo.FileVersion",
    ],
    { encoding: "utf8", env: { ...process.env, GAMEBUDDY_INSPECT_ASSEMBLY: assemblyPath } },
  );
  const fileVersion = (result.stdout || "").trim();
  if (fileVersion !== EXPECTED_FILE_VERSION)
    fail("target_installation_mismatch", `Expected ${EXPECTED_FILE_VERSION}; got ${fileVersion || "unknown"}.`);
  return Object.freeze({ relativePath: "Stardew Valley.dll", fileVersion, sha256: await sha256(assemblyPath) });
}

async function main() {
  const gamePath = argument("--game-path") || process.env.GAMEBUDDY_STARDEW_GAME_PATH;
  const outputPath = argument("--out");
  if (!gamePath || process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stderr.write(
      "Usage: node tools/derive-stardew-soil-kernel.mjs --game-path <absolute-path> [--out <file>]\n",
    );
    return gamePath ? 0 : 2;
  }
  const root = path.resolve(gamePath);
  const assemblyPath = path.join(root, "Stardew Valley.dll");
  const assembly = await inspectAssembly(assemblyPath);
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "gamebuddy-stardew-soil-kernel-"));
  try {
    const ilspyPath = process.env.ILSPYCMD_PATH || "ilspycmd";
    const options = ["--disable-updatecheck", "-p", "--nested-directories"];
    const version = await execFileAsync(ilspyPath, ["--version"], { encoding: "utf8" });
    await execFileAsync(ilspyPath, [...options, "-o", outputRoot, assemblyPath], {
      encoding: "utf8",
      maxBuffer: 256 * 1024,
    });
    const sources = Object.fromEntries(
      await Promise.all(
        REQUIRED_SOURCES.map(async (sourceFile) => [
          sourceFile,
          await readFile(path.join(outputRoot, sourceFile), "utf8"),
        ]),
      ),
    );
    const kernel = deriveSoilTileSemanticKernels(sources);
    const report = Object.freeze({
      ...kernel,
      target: Object.freeze({ game: "Stardew Valley", version: "1.6.15", build: 24356, assembly }),
      decompilation: Object.freeze({
        tool: "ilspycmd",
        toolVersion: (version.stdout || "").trim().split(/\r?\n/)[0] || "unknown",
        configurationDigest: createHash("sha256")
          .update(JSON.stringify({ tool: "ilspycmd", options }))
          .digest("hex"),
      }),
    });
    const text = `${JSON.stringify(report, null, 2)}\n`;
    if (outputPath) await writeFile(path.resolve(outputPath), text, "utf8");
    else process.stdout.write(text);
    return 0;
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`${error.code || "stardew_soil_kernel_derivation_failed"}: ${error.message}\n`);
  process.exitCode = 1;
}
