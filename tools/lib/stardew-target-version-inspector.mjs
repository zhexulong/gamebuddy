#!/usr/bin/env node
/**
 * Reads the target Stardew/SMAPI file versions from one real game installation.
 *
 * Read-only: it never writes to the game root and never accepts a caller-supplied
 * version. Each file is observed twice and both observations must agree, so a
 * file replaced mid-read cannot be reported as a stable version fact.
 */
import { execFile } from "node:child_process";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GAME_ASSEMBLY = "Stardew Valley.dll";
const SMAPI_ASSEMBLY = "StardewModdingAPI.dll";

function fail(reason) {
  throw new Error(`stardew_target_version_inspection_${reason}`);
}

async function observeRealDirectory(candidate) {
  if (typeof candidate !== "string" || !isAbsolute(candidate)) fail("invalid_game_path");
  const info = await lstat(candidate).catch(() => null);
  if (!info || info.isSymbolicLink() || !info.isDirectory()) fail("invalid_game_path");
  const canonical = await realpath(candidate).catch(() => null);
  if (!canonical || resolve(canonical) !== resolve(candidate)) fail("invalid_game_path");
  return canonical;
}

function fileIdentity(info) {
  return { dev: info.dev, ino: info.ino, size: info.size, mtimeNs: info.mtimeNs };
}
function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs;
}

async function observeFileVersion(gamePath, fileName) {
  const filePath = join(gamePath, fileName);
  const before = await lstat(filePath).catch(() => null);
  if (!before || before.isSymbolicLink() || !before.isFile()) fail(`${fileName}_invalid`);
  const canonical = await realpath(filePath).catch(() => null);
  if (!canonical || resolve(canonical) !== resolve(filePath)) fail(`${fileName}_invalid`);
  const identity = fileIdentity(before);
  let handle;
  try {
    handle = await open(filePath, "r");
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(identity, fileIdentity(opened))) fail(`${fileName}_changed_during_read`);
    const version = await readWindowsFileVersion(filePath);
    const after = await handle.stat();
    const finalPath = await lstat(filePath);
    if (!sameIdentity(identity, fileIdentity(after)) || !sameIdentity(identity, fileIdentity(finalPath)))
      fail(`${fileName}_changed_during_read`);
    return version;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readWindowsFileVersion(filePath) {
  if (process.platform !== "win32") fail("read_unavailable");
  let stdout;
  try {
    const result = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-Command", "$p=$env:GAMEBUDDY_INSPECT_FILE; (Get-Item -LiteralPath $p).VersionInfo.FileVersion"],
      { encoding: "utf8", env: { ...process.env, GAMEBUDDY_INSPECT_FILE: filePath } },
    );
    stdout = result.stdout.trim();
  } catch {
    fail("read_unavailable");
  }
  if (!stdout) fail("read_unavailable");
  return stdout;
}

// SMAPI publishes a four-part file version ("4.5.2.0"); the action target profile
// carries the product version ("4.5.2"), so compare on the first three parts.
function normalizeSmapiVersion(value) {
  if (typeof value !== "string" || value.length === 0) fail("smapi_version_unavailable");
  return /^([0-9]+\.[0-9]+\.[0-9]+)/.exec(value)?.[1] ?? value;
}

export async function inspectTargetInstallation(gamePath) {
  const root = await observeRealDirectory(gamePath);
  const observe = async () =>
    Object.freeze({
      gameVersion: await observeFileVersion(root, GAME_ASSEMBLY),
      smapiVersion: normalizeSmapiVersion(await observeFileVersion(root, SMAPI_ASSEMBLY)),
    });
  const first = await observe();
  const second = await observe();
  if (first.gameVersion !== second.gameVersion || first.smapiVersion !== second.smapiVersion)
    fail("target_changed_during_inspection");
  return first;
}
