import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, readdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import {
  cleanupAtomicDirectory,
  commitAtomicDirectory,
  prepareAtomicDirectory,
} from "@gamebuddy/game-action-devkit";

export const RELEASE_BUNDLE_FILES = Object.freeze([
  "GameBuddy.Stardew.dll",
  "GameBuddy.Stardew.Core.dll",
  "Raffinert.FuzzySharp.dll",
  "manifest.json",
  "GameBuddy.Stardew.deps.json",
]);

function fail(code) {
  throw new Error(`stardew_release_bundle_publish_${code}`);
}
function sameFile(left, right) { return left.dev === right.dev && left.ino === right.ino; }
async function trustedDirectory(candidate) {
  const absolute = path.resolve(candidate);
  let current = path.parse(absolute).root;
  try {
    for (const segment of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      const state = await lstat(current);
      if (!state.isDirectory() || state.isSymbolicLink()) fail("untrusted_directory");
    }
    const state = await lstat(absolute);
    if (!state.isDirectory() || state.isSymbolicLink() || await realpath(absolute) !== absolute) fail("untrusted_directory");
    return { absolute, state };
  } catch (error) {
    if (error?.message?.startsWith("stardew_release_bundle_publish_")) throw error;
    fail("untrusted_directory");
  }
}
async function openSource(directory, directoryState, name) {
  const candidate = path.join(directory, name);
  let handle;
  try {
    const rootNow = await lstat(directory);
    if (!sameFile(rootNow, directoryState)) fail("source_drift");
    const before = await lstat(candidate);
    if (!before.isFile() || before.isSymbolicLink()) fail("source_untrusted");
    handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFile(before, opened)) fail("source_drift");
    return { candidate, handle, opened };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error?.message?.startsWith("stardew_release_bundle_publish_")) throw error;
    fail("source_untrusted");
  }
}
async function copyPinned(source, destination, hash, name) {
  let output;
  try {
    output = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    hash.update(Buffer.from(name, "utf8"));
    hash.update(Buffer.from([0]));
    while (true) {
      const { bytesRead } = await source.handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      let offset = 0;
      while (offset < bytesRead) offset += (await output.write(chunk, offset, bytesRead - offset, position + offset)).bytesWritten;
      position += bytesRead;
    }
    if (position === 0) fail("source_empty");
    await output.sync();
    const afterHandle = await source.handle.stat();
    const afterPath = await lstat(source.candidate);
    if (!sameFile(source.opened, afterHandle) || !sameFile(source.opened, afterPath)
      || source.opened.size !== afterHandle.size || source.opened.mtimeMs !== afterHandle.mtimeMs
      || source.opened.ctimeMs !== afterHandle.ctimeMs) fail("source_drift");
  } finally {
    await output?.close().catch(() => {});
    await source.handle.close().catch(() => {});
  }
}
async function digestPinnedDirectory(directory, directoryState, { exactEntries }) {
  if (exactEntries) {
    const entries = (await readdir(directory)).sort();
    const expected = [...RELEASE_BUNDLE_FILES].sort();
    if (entries.length !== expected.length || entries.some((entry, index) => entry !== expected[index])) {
      fail("staging_entries_invalid");
    }
  }
  const hash = createHash("sha256");
  for (const name of RELEASE_BUNDLE_FILES) {
    const source = await openSource(directory, directoryState, name);
    try {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let position = 0;
      hash.update(Buffer.from(name, "utf8"));
      hash.update(Buffer.from([0]));
      while (true) {
        const { bytesRead } = await source.handle.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
      if (position === 0) fail("source_empty");
      const afterHandle = await source.handle.stat();
      const afterPath = await lstat(source.candidate);
      const directoryNow = await lstat(directory);
      if (!sameFile(directoryState, directoryNow) || !sameFile(source.opened, afterHandle)
        || !sameFile(source.opened, afterPath) || source.opened.size !== afterHandle.size
        || source.opened.mtimeMs !== afterHandle.mtimeMs || source.opened.ctimeMs !== afterHandle.ctimeMs) {
        fail("source_drift");
      }
    } finally {
      await source.handle.close().catch(() => {});
    }
  }
  return hash.digest("hex");
}

async function cleanupKnown(transaction) {
  for (const name of RELEASE_BUNDLE_FILES) {
    try { await unlink(path.join(transaction.stagingPath, name)); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  await cleanupAtomicDirectory(transaction);
}

export async function publishEquipToolReleaseBundle({ sourceDir, destinationDir }) {
  if (![sourceDir, destinationDir].every((value) => typeof value === "string" && path.isAbsolute(value) && !value.includes("\0"))) fail("invalid_input");
  const source = await trustedDirectory(sourceDir);
  const transaction = await prepareAtomicDirectory(destinationDir);
  try {
    const hash = createHash("sha256");
    for (const name of RELEASE_BUNDLE_FILES) {
      const input = await openSource(source.absolute, source.state, name);
      await copyPinned(input, path.join(transaction.stagingPath, name), hash, name);
    }
    const manifest = JSON.parse(await readFile(path.join(transaction.stagingPath, "manifest.json"), "utf8"));
    if (manifest?.Name !== "GameBuddy" || manifest?.UniqueID !== "zhexulong.GameBuddy"
      || manifest?.EntryDll !== "GameBuddy.Stardew.dll" || typeof manifest?.Version !== "string") fail("manifest_identity_mismatch");
    const digest = hash.digest("hex");
    const sourceDigest = await digestPinnedDirectory(source.absolute, source.state, { exactEntries: false });
    const staging = await trustedDirectory(transaction.stagingPath);
    const stagedDigest = await digestPinnedDirectory(staging.absolute, staging.state, { exactEntries: true });
    if (sourceDigest !== digest || stagedDigest !== digest) fail("digest_mismatch");
    await commitAtomicDirectory(transaction);
    return Object.freeze({
      schema: "gamebuddy-stardew-release-bundle-publication/v1",
      status: "published",
      destinationDir: path.resolve(destinationDir),
      adapterVersion: manifest.Version,
      algorithm: "sha256",
      digest,
      files: RELEASE_BUNDLE_FILES.length,
    });
  } catch (error) {
    await cleanupKnown(transaction).catch(() => fail("cleanup_uncertain"));
    throw error;
  }
}
