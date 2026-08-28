import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";

function fail(errorPrefix, code) {
  throw new Error(`${errorPrefix}_${code}`);
}

function isMissing(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

async function readLstat(candidate, errorPrefix) {
  try {
    return await lstat(candidate);
  } catch (error) {
    fail(errorPrefix, isMissing(error) ? "unreadable" : "unreadable");
  }
}

function rejectLinkOrReparse(details, errorPrefix) {
  if (details.isSymbolicLink()) fail(errorPrefix, "path_link_or_reparse");
}

function assertContained(root, candidate, errorPrefix) {
  const relative = path.relative(root, candidate);
  if (
    relative.length === 0
    || path.isAbsolute(relative)
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
  ) {
    fail(errorPrefix, "path_outside_package");
  }
}

function assertPhysicalPathMatchesLexicalPath(physicalRoot, physicalCandidate, segments, errorPrefix) {
  const expected = path.resolve(physicalRoot, ...segments);
  const candidateToExpected = path.relative(expected, physicalCandidate);
  const expectedToCandidate = path.relative(physicalCandidate, expected);
  if (candidateToExpected !== "" || expectedToCandidate !== "") fail(errorPrefix, "path_link_or_reparse");
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function validateRelativePath(relativePath, errorPrefix) {
  if (
    typeof relativePath !== "string"
    || relativePath.length === 0
    || relativePath.includes("\0")
    || relativePath.includes("\\")
    || path.posix.isAbsolute(relativePath)
    || /^[A-Za-z]:/.test(relativePath)
    || path.posix.normalize(relativePath) !== relativePath
  ) {
    fail(errorPrefix, "invalid_package_relative_path");
  }

  const segments = relativePath.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    fail(errorPrefix, "invalid_package_relative_path");
  }
  return segments;
}

function validateReaderInput({ packageDirectory, relativePath, maxBytes, errorPrefix }) {
  if (
    typeof errorPrefix !== "string"
    || errorPrefix.length === 0
    || typeof packageDirectory !== "string"
    || packageDirectory.length === 0
    || packageDirectory.includes("\0")
  ) {
    throw new Error("stardew_action_package_reader_invalid_input");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) fail(errorPrefix, "invalid_bounds");
  return {
    root: path.resolve(packageDirectory),
    segments: validateRelativePath(relativePath, errorPrefix),
  };
}

async function checkedRealpath(candidate, errorPrefix) {
  try {
    return await realpath(candidate);
  } catch {
    fail(errorPrefix, "unreadable");
  }
}

async function readBoundedBytes(candidate, expected, maxBytes, errorPrefix) {
  let handle;
  try {
    handle = await open(candidate, "r");
  } catch {
    fail(errorPrefix, "unreadable");
  }

  try {
    let opened;
    try {
      opened = await handle.stat();
    } catch {
      fail(errorPrefix, "unreadable");
    }
    if (!opened.isFile()) fail(errorPrefix, "not_regular_file");
    if (!sameIdentity(expected, opened)) fail(errorPrefix, "path_changed");
    if (!Number.isSafeInteger(opened.size) || opened.size < 0) fail(errorPrefix, "bounds");
    if (opened.size > maxBytes) fail(errorPrefix, "bounds");

    let bytes;
    try {
      // The size check is deliberately before allocation. A later short read or
      // identity change fails closed rather than expanding the buffer.
      bytes = Buffer.alloc(opened.size);
    } catch {
      fail(errorPrefix, "unreadable");
    }

    let offset = 0;
    while (offset < bytes.length) {
      let result;
      try {
        result = await handle.read(bytes, offset, bytes.length - offset, offset);
      } catch {
        fail(errorPrefix, "unreadable");
      }
      if (
        !result
        || !Number.isSafeInteger(result.bytesRead)
        || result.bytesRead <= 0
        || result.bytesRead > bytes.length - offset
      ) {
        fail(errorPrefix, "path_changed");
      }
      offset += result.bytesRead;
    }

    let settled;
    try {
      settled = await handle.stat();
    } catch {
      fail(errorPrefix, "unreadable");
    }
    if (
      !settled.isFile()
      || !sameIdentity(opened, settled)
      || settled.size !== opened.size
    ) {
      fail(errorPrefix, "path_changed");
    }
    return bytes;
  } finally {
    try {
      await handle.close();
    } catch {
      fail(errorPrefix, "unreadable");
    }
  }
}

/**
 * Read one fixed package-relative regular file without following a linked path.
 * Every package-relative component is lstat'ed before the leaf is opened, and
 * both lexical and physical containment are required before bounded decoding.
 */
export async function readFixedPackageUtf8File(options) {
  const { root, segments } = validateReaderInput(options);
  const { maxBytes, errorPrefix } = options;

  const rootDetails = await readLstat(root, errorPrefix);
  rejectLinkOrReparse(rootDetails, errorPrefix);
  if (!rootDetails.isDirectory()) fail(errorPrefix, "package_root_not_directory");

  const physicalRoot = await checkedRealpath(root, errorPrefix);
  const confirmedRoot = await readLstat(root, errorPrefix);
  rejectLinkOrReparse(confirmedRoot, errorPrefix);
  if (!confirmedRoot.isDirectory()) fail(errorPrefix, "package_root_not_directory");
  if (!sameIdentity(rootDetails, confirmedRoot)) fail(errorPrefix, "path_changed");

  let candidate = root;
  let leafDetails;
  for (let index = 0; index < segments.length; index += 1) {
    candidate = path.join(candidate, segments[index]);
    const details = await readLstat(candidate, errorPrefix);
    rejectLinkOrReparse(details, errorPrefix);
    if (index < segments.length - 1) {
      if (!details.isDirectory()) fail(errorPrefix, "path_parent_not_directory");
    } else {
      if (!details.isFile()) fail(errorPrefix, "not_regular_file");
      leafDetails = details;
    }
  }

  const physicalCandidate = await checkedRealpath(candidate, errorPrefix);
  assertContained(physicalRoot, physicalCandidate, errorPrefix);
  assertPhysicalPathMatchesLexicalPath(physicalRoot, physicalCandidate, segments, errorPrefix);
  const bytes = await readBoundedBytes(candidate, leafDetails, maxBytes, errorPrefix);

  const settledLeaf = await readLstat(candidate, errorPrefix);
  rejectLinkOrReparse(settledLeaf, errorPrefix);
  if (!settledLeaf.isFile() || !sameIdentity(leafDetails, settledLeaf)) fail(errorPrefix, "path_changed");
  const settledPhysicalCandidate = await checkedRealpath(candidate, errorPrefix);
  assertContained(physicalRoot, settledPhysicalCandidate, errorPrefix);
  assertPhysicalPathMatchesLexicalPath(physicalRoot, settledPhysicalCandidate, segments, errorPrefix);

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail(errorPrefix, "invalid_utf8");
  }
}
