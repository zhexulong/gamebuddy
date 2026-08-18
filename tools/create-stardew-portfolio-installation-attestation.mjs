#!/usr/bin/env node
/**
 * Produces the P0b installation attestation from one observation of the real
 * target installation, approved Portfolio Mod bundle, and Host artifact.
 *
 * This command is deliberately not a bootstrapper: it never writes to the
 * game/profile/save roots and it never accepts caller-supplied hashes or
 * versions. The destination is a create-only atomic publication.
 */
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, open, readFile, realpath, link, unlink } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  PORTFOLIO_INSTALLATION_ATTESTATION_SCHEMA_VERSION,
  PORTFOLIO_TARGET_GAME_SHA256,
  PORTFOLIO_TARGET_SMAPI_VERSION,
  PORTFOLIO_TARGET_VERSION,
  validatePortfolioInstallationAttestation,
} from "./lib/stardew-portfolio-p0b.mjs";
import { PORTFOLIO_TOPOLOGY, inspectPortfolioModBundle } from "./lib/stardew-portfolio-profile.mjs";

const execFileAsync = promisify(execFile);
const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const GAME_FILES = Object.freeze([
  ["Stardew Valley.dll", "game"],
  ["StardewModdingAPI.dll", "smapi"],
  ["StardewModdingAPI.exe", "smapiExe"],
]);
const MOD_FILES = Object.freeze([
  ["GameBuddy.Stardew.dll", "dllSha256"],
  ["manifest.json", "manifestSha256"],
  ["GameBuddy.Stardew.deps.json", "depsSha256"],
]);

/** Parse the intentionally small CLI surface. All paths are checked again by
 * the producer; parsing does not turn a relative path into an accepted root. */
export function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined || value.startsWith("--") || values.has(flag))
      throw new Error(
        "usage: --game-path <path> --profile-root <path> --host-artifact <path> --host-build-id <id> --out <path>",
      );
    values.set(flag.slice(2), value);
    index += 1;
  }
  const result = Object.freeze({
    gamePath: values.get("game-path"),
    profileRoot: values.get("profile-root"),
    hostArtifactPath: values.get("host-artifact"),
    hostBuildId: values.get("host-build-id"),
    outputPath: values.get("out") ?? values.get("output"),
  });
  if (Object.values(result).some((value) => value === undefined))
    throw new Error(
      "usage: --game-path <path> --profile-root <path> --host-artifact <path> --host-build-id <id> --out <path>",
    );
  return result;
}

/**
 * Observe and publish one attestation. `readVersion` is an internal test seam;
 * the CLI always uses the target OS file-version metadata reader.
 */
export async function createPortfolioInstallationAttestation(options) {
  const context = validateOptions(options);
  const readVersion = options.readVersion ?? readWindowsFileVersion;
  await assertRealDirectory(context.gamePath, "portfolio_game_root_invalid");
  await assertRealDirectory(context.profileRoot, "portfolio_profile_root_invalid");
  await assertRealDirectory(dirname(context.hostArtifactPath), "portfolio_host_artifact_parent_invalid");
  const target = await observeTarget(context.gamePath, readVersion);
  const mod = await observeMod(context.profileRoot);
  const host = await observeHost(context.hostArtifactPath, context.hostBuildId);

  // A second observation is required before publication. It catches a file
  // being replaced while the three independently-owned roots are read and
  // ensures the bytes in the attestation are facts observed twice.
  const targetAgain = await observeTarget(context.gamePath, readVersion);
  const modAgain = await observeMod(context.profileRoot);
  const hostAgain = await observeHost(context.hostArtifactPath, context.hostBuildId);
  assertSameObservation(target, targetAgain, "portfolio_target_changed_during_attestation");
  assertSameObservation(mod, modAgain, "portfolio_mod_changed_during_attestation");
  assertSameObservation(host, hostAgain, "portfolio_host_changed_during_attestation");

  const attestation = Object.freeze({
    schemaVersion: PORTFOLIO_INSTALLATION_ATTESTATION_SCHEMA_VERSION,
    artifactKind: "portfolio_installation_attestation",
    topology: PORTFOLIO_TOPOLOGY,
    target: {
      gameVersion: target.game.fileVersion,
      gameSha256: target.game.sha256,
      smapiVersion: target.smapi.fileVersion,
      smapiSha256: target.smapi.sha256,
      smapiExeVersion: target.smapiExe.fileVersion,
      smapiExeSha256: target.smapiExe.sha256,
    },
    mod: {
      version: mod.version,
      dllSha256: mod.files.dllSha256,
      manifestSha256: mod.files.manifestSha256,
      depsSha256: mod.files.depsSha256,
    },
    host: { sha256: host.sha256, buildId: context.hostBuildId },
  });
  const schema = validatePortfolioInstallationAttestation(attestation, { modDllSha256: mod.files.dllSha256 });
  if (!schema.valid) throw codedError("portfolio_installation_attestation_validation_failed", schema.errors.join(","));

  const publishedPath = await publishCreateOnlyJson(context.outputPath, attestation);
  // Reparse the exact bytes that won the create-only publication. This is a
  // separate validator boundary, not trust in the object held in memory.
  const reparsed = JSON.parse(await readFile(publishedPath, "utf8"));
  const reparsedSchema = validatePortfolioInstallationAttestation(reparsed, {
    modDllSha256: mod.files.dllSha256,
  });
  if (!reparsedSchema.valid)
    throw codedError("portfolio_installation_attestation_reparse_invalid", reparsedSchema.errors.join(","));
  return Object.freeze({ state: "written", artifactKind: attestation.artifactKind, outputPath: publishedPath });
}

export async function observeTarget(gamePath, readVersion) {
  const observed = {};
  for (const [fileName, key] of GAME_FILES) {
    const file = await observeRegularFile(join(gamePath, fileName), `portfolio_target_file_invalid:${fileName}`);
    observed[key] = Object.freeze({
      sha256: file.sha256,
      fileVersion:
        fileName === "Stardew Valley.dll"
          ? await readVersion(file.path, fileName)
          : normalizeSmapiVersion(await readVersion(file.path, fileName)),
    });
  }
  if (observed.game.sha256 !== PORTFOLIO_TARGET_GAME_SHA256) throw new Error("portfolio_target_game_hash_mismatch");
  if (observed.game.fileVersion !== PORTFOLIO_TARGET_VERSION) throw new Error("portfolio_target_game_version_mismatch");
  if (observed.smapi.fileVersion !== PORTFOLIO_TARGET_SMAPI_VERSION)
    throw new Error("portfolio_target_smapi_version_mismatch");
  if (observed.smapiExe.fileVersion !== PORTFOLIO_TARGET_SMAPI_VERSION)
    throw new Error("portfolio_target_smapi_exe_version_mismatch");
  return Object.freeze(observed);
}

export async function observeMod(profileRoot) {
  const bundle = await inspectPortfolioModBundle(profileRoot);
  if (bundle.state !== "single_bundle" || typeof bundle.directory !== "string")
    throw new Error(bundle.reasons?.[0] ?? "portfolio_mod_bundle_unavailable");
  const directory = bundle.directory;
  await assertRealDirectory(directory, "portfolio_mod_bundle_directory_invalid");
  const files = {};
  let manifestBytes;
  for (const [fileName, key] of MOD_FILES) {
    const file = await observeRegularFile(join(directory, fileName), `portfolio_mod_file_invalid:${fileName}`);
    files[key] = file.sha256;
    if (fileName === "manifest.json") manifestBytes = file.bytes;
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    throw new Error("portfolio_mod_manifest_invalid_json");
  }
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    manifest.UniqueID !== "zhexulong.GameBuddy" ||
    manifest.EntryDll !== "GameBuddy.Stardew.dll" ||
    typeof manifest.Version !== "string" ||
    manifest.Version.length === 0
  )
    throw new Error("portfolio_mod_manifest_identity_invalid");
  return Object.freeze({ version: manifest.Version, files: Object.freeze(files) });
}

async function observeHost(path, buildId) {
  if (!IDENTIFIER.test(buildId ?? "")) throw new Error("portfolio_host_build_id_invalid");
  const file = await observeRegularFile(path, "portfolio_host_artifact_invalid");
  return Object.freeze({ sha256: file.sha256 });
}

async function observeRegularFile(path, reason) {
  if (!isAbsolute(path)) throw new Error(`${reason}:not_absolute`);
  const before = await lstat(path).catch(() => null);
  if (!before || before.isSymbolicLink() || !before.isFile() || !(await isRealPath(path))) throw new Error(reason);
  const identity = fileIdentity(before);
  let handle;
  try {
    handle = await open(path, "r");
    const opened = await handle.stat();
    if (!opened.isFile() || opened.isSymbolicLink() || !sameFileIdentity(identity, fileIdentity(opened)))
      throw new Error(reason);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    const finalPath = await lstat(path);
    if (
      !sameFileIdentity(identity, fileIdentity(after)) ||
      !sameFileIdentity(identity, fileIdentity(finalPath)) ||
      finalPath.isSymbolicLink() ||
      !(await isRealPath(path))
    )
      throw new Error(`${reason}:changed_during_read`);
    return Object.freeze({ path, bytes, sha256: createHash("sha256").update(bytes).digest("hex") });
  } catch (error) {
    if (error?.message === reason || error?.message?.startsWith(`${reason}:`)) throw error;
    throw new Error(reason);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function assertRealDirectory(path, reason) {
  const info = await lstat(path).catch(() => null);
  if (!info || info.isSymbolicLink() || !info.isDirectory()) throw new Error(reason);
  const canonical = await realpath(path).catch(() => null);
  if (!canonical || resolve(canonical) !== resolve(path)) throw new Error(reason);
  return canonical;
}
function fileIdentity(info) {
  return { dev: info.dev, ino: info.ino, size: info.size, mtimeNs: info.mtimeNs };
}
function sameFileIdentity(first, second) {
  return (
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.size === second.size &&
    first.mtimeNs === second.mtimeNs
  );
}
async function isRealPath(filePath) {
  const canonical = await realpath(filePath).catch(() => null);
  return canonical !== null && resolve(canonical) === resolve(filePath);
}

export async function publishCreateOnlyJson(outputPath, value) {
  if (!isAbsolute(outputPath)) throw new Error("portfolio_attestation_output_not_absolute");
  const parent = dirname(outputPath);
  const canonicalParent = await assertRealDirectory(parent, "portfolio_attestation_output_parent_invalid");
  const canonicalOutputPath = join(canonicalParent, basename(outputPath));
  const existing = await lstat(canonicalOutputPath).catch(() => null);
  if (existing) throw new Error("portfolio_attestation_output_exists");
  const temporary = join(canonicalParent, `.${basename(outputPath)}.tmp-${process.pid}-${randomUUID()}`);
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  let temporaryCreated = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    temporaryCreated = true;
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    // link(2) is atomic and cannot replace a concurrently-created destination;
    // unlike rename, it preserves the no-overwrite evidence boundary.
    await link(temporary, canonicalOutputPath);
    await unlink(temporary);
    temporaryCreated = false;
    return canonicalOutputPath;
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("portfolio_attestation_output_exists");
    throw error;
  } finally {
    if (temporaryCreated) await unlink(temporary).catch(() => {});
  }
}

function validateOptions(options = {}) {
  for (const key of ["gamePath", "profileRoot", "hostArtifactPath", "outputPath"]) {
    if (typeof options[key] !== "string" || !isAbsolute(options[key])) throw new Error(`portfolio_${key}_not_absolute`);
  }
  if (!IDENTIFIER.test(options.hostBuildId ?? "")) throw new Error("portfolio_host_build_id_invalid");
  return Object.freeze({ ...options });
}

function assertSameObservation(first, second, reason) {
  if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error(reason);
}
function normalizeSmapiVersion(value) {
  if (typeof value !== "string" || value.length === 0) throw new Error("portfolio_target_file_version_unavailable");
  const smapi = /^([0-9]+\.[0-9]+\.[0-9]+)/.exec(value);
  return smapi?.[1] ?? value;
}
async function readWindowsFileVersion(filePath) {
  if (process.platform !== "win32") throw new Error("portfolio_target_file_version_unavailable");
  try {
    const result = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-Command", "$p=$env:GAMEBUDDY_INSPECT_FILE; (Get-Item -LiteralPath $p).VersionInfo.FileVersion"],
      { encoding: "utf8", env: { ...process.env, GAMEBUDDY_INSPECT_FILE: filePath } },
    );
    const value = result.stdout.trim();
    if (!value) throw new Error("missing");
    return value;
  } catch {
    throw new Error("portfolio_target_file_version_unavailable");
  }
}
function codedError(code, detail) {
  const error = new Error(`${code}:${detail}`);
  error.code = code;
  return error;
}

async function main(argv = process.argv.slice(2)) {
  try {
    const args = parseArguments(argv);
    const result = await createPortfolioInstallationAttestation(args);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.code ?? error?.message ?? "portfolio_installation_attestation_failed"}\n`);
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
