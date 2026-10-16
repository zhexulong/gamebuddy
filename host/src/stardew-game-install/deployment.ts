import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import { resolve, sep, win32 } from "node:path";

import {
  readPublishedStardewModPackageContract,
  verifyPublishedStardewModPackage,
} from "../stardew-mod-package-contract.js";
import { readStrictJsonFile } from "../strict-json-reader.js";
import { createPublishedWindowsReparseInspector } from "../windows-reparse-inspector/index.js";
import { probeStardewGameRoot } from "./discovery.js";

const STARDEW_MODS_DIRECTORY = "Mods";
const STARDEW_COMPANION_MOD_DIRECTORY = "GameBuddy";

const MOD_MANIFEST_FILE = "manifest.json";
const MOD_MANIFEST_MAX_BYTES = 64 * 1024;
const SAFE_PACKAGE_ENTRY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const DRIVE_ROOT = /^[A-Za-z]:\\$/;

/**
 * The verified Mod package the Host publishes into a generation.
 *
 * `digests` is the shipped bytes' sha256 per entry, computed from the package this
 * process read. It is what makes a re-launch compare content rather than presence:
 * an installed `Mods/GameBuddy` that carries the same version but not the same bytes
 * is not the shipped Mod.
 */
export type StardewCompanionModPackage = Readonly<{
  root: string;
  entries: readonly string[];
  digests: Readonly<Record<string, string>>;
  uniqueId: string;
  version: string;
}>;

export type StardewCompanionModTargetState =
  | Readonly<{ kind: "absent" }>
  | Readonly<{ kind: "installed"; uniqueId: string; version: string; contentMatches: boolean }>
  | Readonly<{ kind: "unreadable" }>;

export type StardewCompanionModDeploymentDecision =
  | Readonly<{ kind: "install" }>
  | Readonly<{ kind: "current" }>
  | Readonly<{ kind: "update" }>
  | Readonly<{ kind: "replace_requires_consent"; installedVersion: string }>
  | Readonly<{ kind: "foreign_mod_present"; uniqueId: string }>
  | Readonly<{ kind: "target_unreadable" }>;

export type StardewCompanionModDeploymentFailure =
  | "game_installation_not_found"
  | "smapi_not_installed"
  | "mods_directory_missing"
  | "mods_directory_not_writable"
  | "existing_mod_version_requires_consent"
  | "foreign_mod_present"
  | "installed_mod_manifest_unreadable"
  | "mod_package_invalid"
  | "mod_deployment_incomplete";

export type StardewCompanionModDeploymentResult =
  | Readonly<{ kind: "installed"; version: string }>
  | Readonly<{ kind: "current"; version: string }>
  /**
   * The installed directory was rewritten from the package. `installedVersion` is
   * the version found there: it equals `version` when the same version was repaired
   * from different bytes, and differs when an installed version was replaced.
   */
  | Readonly<{ kind: "updated"; installedVersion: string; version: string }>
  | Readonly<{ kind: "failed"; failure: StardewCompanionModDeploymentFailure }>;

export type StardewCompanionModDeploymentInput = Readonly<{
  installRoot: string;
  package: StardewCompanionModPackage;
  /** Explicit consent to replace an installed version this launcher did not publish in this generation. */
  allowReplaceDifferentVersion?: boolean;
}>;

/**
 * The first-install versus update rule, stated once. Identity and version are read
 * from the installed manifest, and "already correct" additionally requires the
 * installed entry bytes to be the shipped bytes:
 *
 *   absent                                      -> `install`
 *   our UniqueID, same version, same bytes      -> `current` (nothing is written)
 *   our UniqueID, same version, other bytes     -> `update`
 *   our UniqueID, different version             -> `replace_requires_consent`
 *   a different UniqueID                        -> `foreign_mod_present`
 *   present but not readable as our manifest    -> `target_unreadable`
 *
 * A version this launcher did not publish is never overwritten without the
 * caller's explicit consent, and another author's Mod directory is never
 * touched at all. Version equality alone is deliberately not `current`: a
 * directory that reads as our version but does not carry our bytes is a Mod the
 * game would load instead of the shipped one, so it is rewritten.
 */
export function decideStardewCompanionModDeployment(
  target: StardewCompanionModTargetState,
  mod: Readonly<{ uniqueId: string; version: string }>,
): StardewCompanionModDeploymentDecision {
  if (target.kind === "absent") return Object.freeze({ kind: "install" as const });
  if (target.kind === "unreadable") return Object.freeze({ kind: "target_unreadable" as const });
  if (target.uniqueId !== mod.uniqueId)
    return Object.freeze({ kind: "foreign_mod_present" as const, uniqueId: target.uniqueId });
  if (target.version !== mod.version)
    return Object.freeze({ kind: "replace_requires_consent" as const, installedVersion: target.version });
  return target.contentMatches
    ? Object.freeze({ kind: "current" as const })
    : Object.freeze({ kind: "update" as const });
}

function failed(failure: StardewCompanionModDeploymentFailure): StardewCompanionModDeploymentResult {
  return Object.freeze({ kind: "failed" as const, failure });
}

function isNodeErrorWithCode(error: unknown, codes: readonly string[]): boolean {
  return error instanceof Error && "code" in error && typeof error.code === "string" && codes.includes(error.code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Accepts exactly the canonical drive-rooted directory form the installation admission already requires. */
export function isCanonicalWindowsDirectory(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 32 * 1024 ||
    value.includes("/") ||
    !/^[A-Za-z]:\\/.test(value)
  )
    return false;
  if (DRIVE_ROOT.test(value)) return true;
  const components = value.slice(3).split("\\");
  if (components.length === 0 || components.length > 511) return false;
  return components.every(
    (component) =>
      component.length > 0 &&
      component !== "." &&
      component !== ".." &&
      !/[\\/:*?<>"|\u0000-\u001f]/.test(component) &&
      !component.endsWith(".") &&
      !component.endsWith(" "),
  );
}

function isValidPackage(value: unknown): value is StardewCompanionModPackage {
  if (!isRecord(value)) return false;
  const digests = value.digests;
  if (
    typeof value.root !== "string" ||
    value.root.length === 0 ||
    typeof value.uniqueId !== "string" ||
    value.uniqueId.length === 0 ||
    typeof value.version !== "string" ||
    value.version.length === 0 ||
    !Array.isArray(value.entries) ||
    value.entries.length === 0 ||
    !value.entries.every((entry) => typeof entry === "string" && SAFE_PACKAGE_ENTRY.test(entry)) ||
    !isRecord(digests)
  )
    return false;
  // Every entry carries the shipped bytes' digest and nothing else does, so a
  // package can never be compared against less content than it installs.
  const entries = value.entries as readonly string[];
  return (
    Object.keys(digests).length === entries.length &&
    entries.every((entry) => typeof digests[entry] === "string" && SHA256.test(digests[entry]))
  );
}

/** The installed Mod's own identity, or undefined when it is not readable as our manifest. */
async function readInstalledIdentity(
  modDirectory: string,
): Promise<Readonly<{ uniqueId: string; version: string }> | undefined> {
  try {
    const value = await readStrictJsonFile(win32.join(modDirectory, MOD_MANIFEST_FILE), MOD_MANIFEST_MAX_BYTES);
    if (!isRecord(value)) return undefined;
    const uniqueId = value.UniqueID;
    const version = value.Version;
    if (typeof uniqueId !== "string" || uniqueId.length === 0 || typeof version !== "string" || version.length === 0)
      return undefined;
    return Object.freeze({ uniqueId, version });
  } catch {
    return undefined;
  }
}

/** True only when every package entry is present as a regular file with the shipped bytes. */
async function installedContentMatches(modDirectory: string, mod: StardewCompanionModPackage): Promise<boolean> {
  for (const entry of mod.entries) {
    const expected = mod.digests[entry];
    if (expected === undefined) return false;
    try {
      const path = win32.join(modDirectory, entry);
      const state = await lstat(path);
      if (!state.isFile() || state.isSymbolicLink()) return false;
      if (createHash("sha256").update(await readFile(path)).digest("hex") !== expected) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function readTargetState(
  modDirectory: string,
  mod: StardewCompanionModPackage,
): Promise<StardewCompanionModTargetState> {
  try {
    const state = await lstat(modDirectory);
    if (!state.isDirectory() || state.isSymbolicLink()) return Object.freeze({ kind: "unreadable" as const });
  } catch (error) {
    if (isNodeErrorWithCode(error, ["ENOENT"])) return Object.freeze({ kind: "absent" as const });
    return Object.freeze({ kind: "unreadable" as const });
  }
  const identity = await readInstalledIdentity(modDirectory);
  if (identity === undefined) return Object.freeze({ kind: "unreadable" as const });
  return Object.freeze({
    kind: "installed" as const,
    uniqueId: identity.uniqueId,
    version: identity.version,
    contentMatches: await installedContentMatches(modDirectory, mod),
  });
}

function writeFailureFor(error: unknown): StardewCompanionModDeploymentFailure {
  if (isNodeErrorWithCode(error, ["EACCES", "EPERM", "EROFS", "EBUSY"])) return "mods_directory_not_writable";
  if (isNodeErrorWithCode(error, ["ENOENT", "ENOTDIR"])) return "mods_directory_missing";
  return "mod_deployment_incomplete";
}

/** Writes the package in place; returns a named failure, or undefined when every entry landed. */
async function writeModPackage(
  mod: StardewCompanionModPackage,
  modDirectory: string,
): Promise<StardewCompanionModDeploymentFailure | undefined> {
  try {
    await mkdir(modDirectory, { recursive: true });
  } catch (error) {
    return writeFailureFor(error);
  }
  for (const entry of mod.entries) {
    const temporary = win32.join(modDirectory, `${entry}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await copyFile(win32.join(mod.root, entry), temporary);
      await rename(temporary, win32.join(modDirectory, entry));
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      return writeFailureFor(error);
    }
  }
  return undefined;
}

/**
 * Copies every package entry into the game's own `Mods/GameBuddy` directory.
 *
 * An installed directory that already carries this exact version and these exact
 * bytes is reported as `current` and nothing is written at all.
 *
 * Copy, not link: a Windows symlink or junction needs Developer Mode or
 * elevation and is not guaranteed on a player machine, so a link that cannot be
 * created would leave the game without its Mod. Each file is written through an
 * exclusively-created sibling temporary and renamed over its target, and
 * `manifest.json` is the last entry of the published contract, so a first
 * install interrupted before the manifest is not a loadable Mod directory and is
 * removed. A consented replacement of a different version is the caller's
 * explicit choice; a failed replacement leaves each file complete rather than
 * half-written.
 */
export async function deployStardewCompanionMod(
  input: StardewCompanionModDeploymentInput,
): Promise<StardewCompanionModDeploymentResult> {
  const mod = input.package as unknown;
  if (!isValidPackage(mod)) return failed("mod_package_invalid");
  const { installRoot } = input;
  if (!isCanonicalWindowsDirectory(installRoot)) return failed("game_installation_not_found");

  const probe = await probeStardewGameRoot(installRoot);
  if (!probe.gameExecutable) return failed("game_installation_not_found");
  if (!probe.smapi) return failed("smapi_not_installed");

  const modsDirectory = win32.join(installRoot, STARDEW_MODS_DIRECTORY);
  try {
    const state = await lstat(modsDirectory);
    if (!state.isDirectory() || state.isSymbolicLink()) return failed("mods_directory_missing");
  } catch {
    return failed("mods_directory_missing");
  }

  const modDirectory = win32.join(modsDirectory, STARDEW_COMPANION_MOD_DIRECTORY);
  const target = await readTargetState(modDirectory, mod);
  const decision = decideStardewCompanionModDeployment(target, mod);
  // Nothing is written for an installed directory that already carries this exact
  // version and these exact bytes: a launch must not touch a Mod the game may have
  // loaded, and a locked file would otherwise turn a correct installation into a
  // named failure every start.
  if (decision.kind === "current") return Object.freeze({ kind: "current" as const, version: mod.version });
  if (decision.kind === "foreign_mod_present") return failed("foreign_mod_present");
  if (decision.kind === "target_unreadable") return failed("installed_mod_manifest_unreadable");
  if (decision.kind === "replace_requires_consent" && input.allowReplaceDifferentVersion !== true) {
    return failed("existing_mod_version_requires_consent");
  }

  const createdModDirectory = decision.kind === "install";
  const writeFailure = await writeModPackage(mod, modDirectory);
  if (writeFailure !== undefined) {
    // A first install owns the directory it just created, so a failed one is
    // removed whole; an update of an existing directory is left as complete,
    // individually-written files for the next attempt.
    if (createdModDirectory) await rm(modDirectory, { recursive: true, force: true }).catch(() => undefined);
    return failed(writeFailure);
  }
  if (!(await installedContentMatches(modDirectory, mod))) return failed("mod_deployment_incomplete");

  if (decision.kind === "install") return Object.freeze({ kind: "installed" as const, version: mod.version });
  return Object.freeze({
    kind: "updated" as const,
    // A same-version repair rewrote the version that was already installed.
    installedVersion: decision.kind === "update" ? mod.version : decision.installedVersion,
    version: mod.version,
  });
}

/**
 * Reads the verified Mod package from an immutable published generation. The
 * package root, entries, identity and per-entry digests all come from the published
 * contract, the package verifier and the package's own bytes; no caller supplies a
 * path or a descriptor.
 */
export async function readStardewCompanionModPackage(artifactRoot: string): Promise<StardewCompanionModPackage> {
  const inspector = await createPublishedWindowsReparseInspector(artifactRoot);
  const contract = await readPublishedStardewModPackageContract(artifactRoot);
  await verifyPublishedStardewModPackage(artifactRoot, contract, inspector);
  const uniqueId = contract.manifestIdentity.UniqueID;
  const version = contract.manifestIdentity.Version;
  if (typeof uniqueId !== "string" || uniqueId.length === 0 || typeof version !== "string" || version.length === 0) {
    throw new Error("stardew_companion_mod_package_manifest_identity_missing");
  }
  const root = resolve(artifactRoot, contract.descriptor.destination.replaceAll("/", sep));
  const entries = Object.freeze([...contract.entries]);
  const digests: Record<string, string> = {};
  for (const entry of entries) {
    digests[entry] = createHash("sha256").update(await readFile(resolve(root, entry))).digest("hex");
  }
  return Object.freeze({
    root,
    entries,
    digests: Object.freeze(digests),
    uniqueId,
    version,
  });
}
