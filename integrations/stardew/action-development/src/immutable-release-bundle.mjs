import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rmdir } from "node:fs/promises";
import path from "node:path";

const BUNDLE_FILES = Object.freeze([
  "GameBuddy.Stardew.dll",
  "GameBuddy.Stardew.Core.dll",
  "manifest.json",
  "GameBuddy.Stardew.deps.json",
]);
const BUNDLE_FILE_SET = new Set(BUNDLE_FILES);
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const bindings = new WeakSet();

function fail(code, cause) {
  throw new Error(`stardew_immutable_release_bundle_${code}`, cause ? { cause } : undefined);
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function overlaps(left, right) {
  const leftRoot = path.parse(left).root;
  const rightRoot = path.parse(right).root;
  const sameRoot = process.platform === "win32"
    ? leftRoot.toLowerCase() === rightRoot.toLowerCase()
    : leftRoot === rightRoot;
  if (!sameRoot) return false;
  const relative = path.relative(left, right);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function trustedDirectory(candidate, code = "untrusted_directory") {
  const absolute = path.resolve(candidate);
  let current = path.parse(absolute).root;
  try {
    for (const segment of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      const details = await lstat(current);
      if (details.isSymbolicLink()) fail(code);
    }
    const details = await lstat(absolute);
    if (!details.isDirectory() || details.isSymbolicLink() || await realpath(absolute) !== absolute) fail(code);
    return Object.freeze({ absolute, details });
  } catch (error) {
    if (error?.message?.startsWith("stardew_immutable_release_bundle_")) throw error;
    fail(code, error);
  }
}

async function exactEntries(directory, code) {
  let entries;
  try { entries = await readdir(directory); } catch (error) { fail(code, error); }
  if (entries.length !== BUNDLE_FILES.length || entries.some((entry) => !BUNDLE_FILE_SET.has(entry))) fail(code);
}

async function openTrustedSource(directory, directoryDetails, name) {
  const candidate = path.join(directory, name);
  let before;
  let handle;
  try {
    const currentDirectory = await lstat(directory);
    if (!sameFile(currentDirectory, directoryDetails) || !currentDirectory.isDirectory() || currentDirectory.isSymbolicLink()) fail("source_drift");
    before = await lstat(candidate);
    if (!before.isFile() || before.isSymbolicLink()) fail("source_untrusted");
    handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFile(before, opened)) fail("source_drift");
    return { candidate, handle, opened };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error?.message?.startsWith("stardew_immutable_release_bundle_")) throw error;
    fail("source_untrusted", error);
  }
}

async function copyPinnedFile(source, destination, hash, name) {
  let output;
  try {
    output = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    let total = 0;
    hash.update(Buffer.from(name, "utf8"));
    hash.update(Buffer.from([0]));
    while (true) {
      const { bytesRead } = await source.handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      let written = 0;
      while (written < bytesRead) written += (await output.write(chunk, written, bytesRead - written, position + written)).bytesWritten;
      position += bytesRead;
      total += bytesRead;
    }
    await output.sync();
    if (total === 0) fail("source_empty");
    const afterHandle = await source.handle.stat();
    const afterPath = await lstat(source.candidate);
    if (!sameFile(source.opened, afterHandle) || !sameFile(source.opened, afterPath)
      || source.opened.size !== afterHandle.size || source.opened.mtimeMs !== afterHandle.mtimeMs
      || source.opened.ctimeMs !== afterHandle.ctimeMs) fail("source_drift");
  } catch (error) {
    if (error?.message?.startsWith("stardew_immutable_release_bundle_")) throw error;
    fail("copy_uncertain", error);
  } finally {
    await output?.close().catch(() => {});
    await source.handle.close().catch(() => {});
  }
}

async function digestTrustedBundle(directory, directoryDetails, code) {
  await exactEntries(directory, code);
  const hash = createHash("sha256");
  let manifest;
  for (const name of BUNDLE_FILES) {
    const source = await openTrustedSource(directory, directoryDetails, name);
    try {
      const bytes = await source.handle.readFile();
      if (bytes.length === 0) fail(code);
      hash.update(Buffer.from(name, "utf8"));
      hash.update(Buffer.from([0]));
      hash.update(bytes);
      if (name === "manifest.json") {
        try { manifest = JSON.parse(bytes.toString("utf8")); }
        catch (error) { fail(code, error); }
      }
      const afterHandle = await source.handle.stat();
      const afterPath = await lstat(source.candidate);
      if (!sameFile(source.opened, afterHandle) || !sameFile(source.opened, afterPath)
        || source.opened.size !== afterHandle.size || source.opened.mtimeNs !== afterHandle.mtimeNs
        || source.opened.ctimeNs !== afterHandle.ctimeNs) fail(code);
    } finally { await source.handle.close().catch(() => {}); }
  }
  return Object.freeze({ digest: hash.digest("hex"), manifest });
}

async function inspectReleaseSource({ releaseDir, modsPath, expectedAdapterVersion }) {
  const source = await trustedDirectory(releaseDir, "source_untrusted");
  const mods = await trustedDirectory(modsPath, "mods_path_untrusted");
  const target = path.join(mods.absolute, "GameBuddy");
  if (overlaps(source.absolute, target) || overlaps(target, source.absolute)) fail("path_overlap");
  const inspected = await digestTrustedBundle(source.absolute, source.details, "source_untrusted");
  const manifest = inspected.manifest;
  if (manifest?.Name !== "GameBuddy" || manifest?.UniqueID !== "zhexulong.GameBuddy"
    || manifest?.EntryDll !== "GameBuddy.Stardew.dll" || typeof manifest?.Version !== "string"
    || expectedAdapterVersion !== undefined && manifest.Version !== expectedAdapterVersion) fail("manifest_identity_mismatch");
  return Object.freeze({ source, mods, target, digest: inspected.digest, adapterVersion: manifest.Version, files: BUNDLE_FILES.length });
}

export async function inspectExactReleaseBundle({ releaseDir, modsPath, expectedAdapterVersion } = {}) {
  if (![releaseDir, modsPath].every((value) => typeof value === "string" && path.isAbsolute(value) && !value.includes("\0"))) fail("invalid_input");
  const inspected = await inspectReleaseSource({ releaseDir, modsPath, expectedAdapterVersion });
  return Object.freeze({ algorithm: "sha256", digest: inspected.digest, adapterVersion: inspected.adapterVersion, files: inspected.files });
}

async function strictCleanup(directory, directoryDetails) {
  const current = await lstat(directory).catch((error) => fail("cleanup_uncertain", error));
  if (!sameFile(current, directoryDetails) || !current.isDirectory() || current.isSymbolicLink()) fail("cleanup_uncertain");
  let entries;
  try { entries = await readdir(directory); } catch (error) { fail("cleanup_uncertain", error); }
  if (entries.some((entry) => !BUNDLE_FILE_SET.has(entry))) fail("cleanup_uncertain");
  for (const name of entries) {
    const candidate = path.join(directory, name);
    const details = await lstat(candidate).catch((error) => fail("cleanup_uncertain", error));
    if (!details.isFile() || details.isSymbolicLink()) fail("cleanup_uncertain");
  }
  for (const name of entries) {
    try { await import("node:fs/promises").then(({ unlink }) => unlink(path.join(directory, name))); }
    catch (error) { fail("cleanup_uncertain", error); }
  }
  try { await rmdir(directory); } catch (error) { fail("cleanup_uncertain", error); }
}

function validateOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) fail("invalid_input");
  const { releaseDir, modsPath, runRoot, runIdentity, expectedDigest } = options;
  if (![releaseDir, modsPath, runRoot].every((value) => typeof value === "string" && path.isAbsolute(value) && !value.includes("\0"))) fail("invalid_input");
  if (typeof runIdentity !== "string" || !IDENTITY_PATTERN.test(runIdentity) || !DIGEST_PATTERN.test(expectedDigest ?? "")) fail("invalid_input");
  return { releaseDir, modsPath, runRoot, runIdentity, expectedDigest };
}

export async function createImmutableReleaseBundleBinding(options) {
  const input = validateOptions(options);
  const release = await inspectReleaseSource({ releaseDir: input.releaseDir, modsPath: input.modsPath });
  const { source, mods, target } = release;
  const root = await trustedDirectory(input.runRoot, "run_root_untrusted");
  if (overlaps(root.absolute, source.absolute) || overlaps(source.absolute, root.absolute)
    || overlaps(root.absolute, target) || overlaps(target, root.absolute)) fail("path_overlap");
  if (release.digest !== input.expectedDigest) fail("digest_mismatch");

  const stagingDirectory = path.join(root.absolute, `.gamebuddy-release-${input.runIdentity}`);
  const currentRoot = await lstat(root.absolute).catch((error) => fail("run_root_ownership_lost", error));
  if (!sameFile(currentRoot, root.details)) fail("run_root_ownership_lost");
  try { await mkdir(stagingDirectory, { mode: 0o700 }); }
  catch (error) { fail(error?.code === "EEXIST" ? "staging_owned" : "staging_create_failed", error); }
  const staging = await trustedDirectory(stagingDirectory, "staging_ownership_lost");
  const rootAfterCreate = await lstat(root.absolute).catch((error) => fail("run_root_ownership_lost", error));
  if (!sameFile(rootAfterCreate, root.details)) fail("run_root_ownership_lost");

  try {
    const hash = createHash("sha256");
    for (const name of BUNDLE_FILES) {
      const sourceFile = await openTrustedSource(source.absolute, source.details, name);
      await copyPinnedFile(sourceFile, path.join(staging.absolute, name), hash, name);
    }
    await exactEntries(source.absolute, "source_drift");
    const copiedDigest = hash.digest("hex");
    if (copiedDigest !== input.expectedDigest) fail("source_drift");
    if ((await digestTrustedBundle(source.absolute, source.details, "source_drift")).digest !== input.expectedDigest) fail("source_drift");
    if ((await digestTrustedBundle(staging.absolute, staging.details, "staged_tamper")).digest !== input.expectedDigest) fail("staged_tamper");
  } catch (error) {
    try { await strictCleanup(staging.absolute, staging.details); } catch (cleanupError) { fail("cleanup_uncertain", new AggregateError([error, cleanupError])); }
    throw error;
  }

  let lifecycleAttempted = false;
  let restored = false;
  let closed = false;
  const assertActive = () => {
    if (!bindings.has(binding)) fail("invalid_binding");
    if (closed) fail("closed");
  };
  const assertStaged = async () => {
    const current = await lstat(staging.absolute).catch((error) => fail("staged_tamper", error));
    if (!sameFile(current, staging.details) || (await digestTrustedBundle(staging.absolute, staging.details, "staged_tamper")).digest !== input.expectedDigest) fail("staged_tamper");
  };
  const binding = Object.freeze({
    inspect() {
      assertActive();
      return Object.freeze({ version: 1, releaseDir: staging.absolute, digest: input.expectedDigest, lifecycleAttempted, restored, closed });
    },
    async runLifecycle(run, options = {}) {
      assertActive();
      if (lifecycleAttempted || typeof run !== "function") fail("lifecycle_replay");
      lifecycleAttempted = true;
      await assertStaged();
      const outcome = await run({ ...options, releaseDir: staging.absolute });
      if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)
        || Object.keys(outcome).length !== 2
        || !Object.hasOwn(outcome, "operationResult")
        || !Object.hasOwn(outcome, "cleanupResult")
        || !outcome.cleanupResult
        || outcome.cleanupResult.schema !== "gamebuddy-stardew-lifecycle-cleanup-result/v1"
        || outcome.cleanupResult.completed !== true
        || Object.keys(outcome.cleanupResult).length !== 2) fail("lifecycle_incomplete");
      await assertStaged();
      restored = true;
      return outcome.operationResult;
    },
    async close() {
      assertActive();
      if (!restored) fail("close_before_restore");
      await strictCleanup(staging.absolute, staging.details);
      closed = true;
    },
  });
  bindings.add(binding);
  return binding;
}

export const IMMUTABLE_RELEASE_BUNDLE_FILES = BUNDLE_FILES;
