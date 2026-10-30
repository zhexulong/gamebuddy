import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import { win32 } from "node:path";

import { probeStardewGameRoot } from "./discovery.js";
import type { SmapiPayload } from "./smapi-payload.js";

const GAME_DEPENDENCIES_FILE = "Stardew Valley.deps.json";
const LOADER_DEPENDENCIES_FILE = "StardewModdingAPI.deps.json";
const MOD_LOADER_FILE = "StardewModdingAPI.exe";
const DRIVE_ROOT = /^[A-Za-z]:\\$/;

/**
 * The named refusals a one-click mod-loader install can produce.
 *
 * `game_installation_not_found` is a folder holding no Stardew Valley executable, so there
 * is nothing to add a mod loader to. `installation_conflict` is a path the payload would
 * have to overwrite that is not the payload's own bytes and is not the player's to keep: an
 * install that mixed two mod loaders would run neither, so it refuses the whole write
 * rather than half of it. `game_dependencies_missing` is a game folder carrying no
 * `Stardew Valley.deps.json`, which SMAPI's own install instructions derive its runtime
 * dependencies from. `mods_directory_not_writable` is the platform refusing a write
 * (permissions, a read-only volume, a locked file) and `deployment_incomplete` is anything
 * else that stopped the payload from landing in full.
 */
type SmapiDeploymentFailure =
  | "game_installation_not_found"
  | "installation_conflict"
  | "game_dependencies_missing"
  | "mods_directory_not_writable"
  | "deployment_incomplete";

export type SmapiDeploymentResult =
  | Readonly<{ kind: "installed"; version: string }>
  /**
   * A mod loader is already present. Nothing is written - not even a repair - because the
   * loader in the player's game folder is the one their game will run and a running game
   * holds it open. `version` is the payload this launcher ships, not a claim about the
   * installed loader's own version.
   */
  | Readonly<{ kind: "current"; version: string }>
  | Readonly<{ kind: "failed"; failure: SmapiDeploymentFailure }>;

export type SmapiDeploymentInput = Readonly<{ installRoot: string; payload: SmapiPayload }>;

function failed(failure: SmapiDeploymentFailure): SmapiDeploymentResult {
  return Object.freeze({ kind: "failed" as const, failure });
}

/** Accepts exactly the canonical drive-rooted directory form the installation admission requires. */
function isCanonicalWindowsDirectory(value: unknown): value is string {
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

function isNodeErrorWithCode(error: unknown, codes: readonly string[]): boolean {
  return error instanceof Error && "code" in error && typeof error.code === "string" && codes.includes(error.code);
}

async function lstatOrUndefined(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch {
    return undefined;
  }
}

function writeFailureFor(error: unknown): SmapiDeploymentFailure {
  if (isNodeErrorWithCode(error, ["EACCES", "EPERM", "EROFS", "EBUSY"])) return "mods_directory_not_writable";
  return "deployment_incomplete";
}

/**
 * Installs the shipped mod loader into the player's own game folder.
 *
 * Every target is inspected before anything is written, so one conflicting file refuses
 * the whole install instead of leaving two mod loaders interleaved in one folder. A file the
 * payload marks player-owned (`smapi-internal/config.json`) is written only when absent, so
 * a one-click install never resets a configuration the player already tuned.
 *
 * SMAPI's own installation instructions derive the loader's runtime dependencies from the
 * game folder's `Stardew Valley.deps.json`; that file is copied to
 * `StardewModdingAPI.deps.json` as part of the install, because a loader without it cannot
 * start.
 */
export async function deploySmapiPayload(input: SmapiDeploymentInput): Promise<SmapiDeploymentResult> {
  const { installRoot, payload } = input;
  if (!isCanonicalWindowsDirectory(installRoot)) return failed("game_installation_not_found");

  const probe = await probeStardewGameRoot(installRoot);
  if (!probe.gameExecutable) return failed("game_installation_not_found");
  if (probe.smapi) return Object.freeze({ kind: "current" as const, version: payload.version });

  const dependencies = await lstatOrUndefined(win32.join(installRoot, GAME_DEPENDENCIES_FILE));
  if (dependencies === undefined || !dependencies.isFile()) return failed("game_dependencies_missing");

  const playerOwned = new Set(payload.playerOwnedFiles);
  const writes: Array<Readonly<{ path: string; source: string }>> = [];
  for (const file of payload.files) {
    const path = win32.join(installRoot, ...file.path.split("/"));
    const source = win32.join(payload.root, ...file.path.split("/"));
    const existing = await lstatOrUndefined(path);
    if (existing === undefined) {
      writes.push(Object.freeze({ path, source }));
      continue;
    }
    if (!existing.isFile() || existing.isSymbolicLink()) return failed("installation_conflict");
    if (playerOwned.has(file.path)) continue;
    if (existing.size !== file.size) return failed("installation_conflict");
    if (
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex") !== file.sha256
    )
      return failed("installation_conflict");
  }

  const created: string[] = [];
  try {
    for (const write of writes) {
      await mkdir(win32.dirname(write.path), { recursive: true });
      const temporary = `${write.path}.${process.pid}.tmp`;
      await copyFile(write.source, temporary);
      await rename(temporary, write.path);
      created.push(write.path);
    }
    const loaderDependencies = win32.join(installRoot, LOADER_DEPENDENCIES_FILE);
    if ((await lstatOrUndefined(loaderDependencies)) === undefined) {
      await copyFile(win32.join(installRoot, GAME_DEPENDENCIES_FILE), loaderDependencies);
      created.push(loaderDependencies);
    }
  } catch (error) {
    // A first install that did not land in full is removed rather than left as a folder the
    // loader can never start from. Paths that already existed were not written by this
    // attempt and are not this attempt's to delete.
    for (const path of created) await rm(path, { force: true }).catch(() => undefined);
    return failed(writeFailureFor(error));
  }

  const installed = await lstatOrUndefined(win32.join(installRoot, MOD_LOADER_FILE));
  if (installed === undefined || !installed.isFile()) return failed("deployment_incomplete");
  return Object.freeze({ kind: "installed" as const, version: payload.version });
}
