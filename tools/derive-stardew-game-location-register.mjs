import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, rm, stat, writeFile, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildGameLocationInteractionRegister } from "./lib/stardew-game-location-register.mjs";

const ASSEMBLY = "Stardew Valley.dll";
const VERSION = "1.6.15.24356";
const SHA256 = "7f1e5b8e58d2758b78570ba771bbeb03d33522f62188bf6c32edf0cf626deaee";
const OPTIONS = ["--disable-updatecheck", "-p", "--nested-directories"];
const exec = promisify(execFile);
const digest = (value) => createHash("sha256").update(value).digest("hex");
function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}
function args(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) fail("invalid_argument", `Unexpected ${key}.`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) fail("invalid_argument", `Missing value for ${key}.`);
    out[key.slice(2)] = value;
  }
  if (!out["game-path"] || !out.out) fail("arguments_required", "Usage: --game-path <path> --out <path>");
  return out;
}
async function list(root, current = root, output = []) {
  for (const item of await readdir(current, { withFileTypes: true })) {
    const candidate = path.join(current, item.name);
    if (item.isDirectory()) await list(root, candidate, output);
    else if (item.isFile() && candidate.endsWith(".cs")) output.push(candidate);
  }
  return output;
}
async function target(gamePath) {
  const assemblyPath = path.join(gamePath, ASSEMBLY);
  let file;
  try {
    file = await stat(assemblyPath);
  } catch {
    fail("target_assembly_missing", `Missing ${ASSEMBLY}.`);
  }
  const actualHash = digest(await readFile(assemblyPath));
  if (actualHash !== SHA256) fail("target_assembly_hash_mismatch", "Locked assembly hash mismatch.", { actualHash });
  const actualVersion = (
    await exec(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "$p=$env:GAMEBUDDY_INSPECT_ASSEMBLY;(Get-Item -LiteralPath $p).VersionInfo.FileVersion",
      ],
      { encoding: "utf8", env: { ...process.env, GAMEBUDDY_INSPECT_ASSEMBLY: assemblyPath } },
    )
  ).stdout.trim();
  if (actualVersion !== VERSION)
    fail("target_assembly_version_mismatch", "Locked assembly version mismatch.", { actualVersion });
  return {
    assemblyPath,
    attestation: { relativePath: ASSEMBLY, fileVersion: actualVersion, lengthBytes: file.size, sha256: actualHash },
  };
}
async function snapshot(assemblyPath) {
  const root = await mkdtemp(path.join(os.tmpdir(), "gamebuddy-stardew-location-register-"));
  const tool = process.env.ILSPYCMD_PATH || "ilspycmd";
  try {
    const version = (await exec(tool, ["--version"], { encoding: "utf8" })).stdout.trim().split(/\r?\n/)[0];
    if (version !== "ilspycmd: 9.1.0.7988")
      fail("decompiler_version_mismatch", "Locked ilspycmd version required.", { version });
    await exec(tool, [...OPTIONS, "-o", root, assemblyPath], { encoding: "utf8", maxBuffer: 256 * 1024 });
    return {
      root,
      provenance: {
        tool: "ilspycmd",
        toolVersion: version,
        configurationDigest: digest(JSON.stringify({ tool: "ilspycmd", options: OPTIONS, target: ASSEMBLY })),
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    if (error.code?.startsWith("decompiler_")) throw error;
    fail("assembly_decompilation_failed", "Could not decompile exact target.", { cause: error.message });
  }
}
async function sources(root) {
  const rows = [];
  const manifest = [];
  for (const filePath of (await list(root)).sort()) {
    const relativePath = path.relative(root, filePath).replaceAll(path.sep, "/");
    if (relativePath !== "StardewValley/GameLocation.cs" && !relativePath.startsWith("StardewValley/Locations/"))
      continue;
    const text = await readFile(filePath, "utf8");
    rows.push({ relativePath, text });
    manifest.push(`${relativePath}\t${digest(text)}`);
  }
  return { rows, manifestSha256: digest(`${manifest.join("\n")}\n`) };
}
async function save(output, report) {
  const absolute = path.resolve(output);
  const temporary = `${absolute}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`);
  await rename(temporary, absolute);
}
async function main() {
  const input = args(process.argv.slice(2).filter((item) => item !== "--"));
  const checked = await target(path.resolve(input["game-path"]));
  const decompiled = await snapshot(checked.assemblyPath);
  try {
    const source = await sources(decompiled.root);
    const register = await buildGameLocationInteractionRegister(source.rows);
    await save(input.out, {
      schemaVersion: 1,
      target: checked.attestation,
      decompilation: decompiled.provenance,
      source: { selectedSourceFileCount: source.rows.length, selectedSourceManifestSha256: source.manifestSha256 },
      register,
    });
  } finally {
    await rm(decompiled.root, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(`${error.code ?? "game_location_register_failed"}: ${error.message}`);
  process.exitCode = 1;
});
