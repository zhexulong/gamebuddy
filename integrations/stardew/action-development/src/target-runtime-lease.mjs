import { lstat, mkdir, readdir, realpath, rmdir } from "node:fs/promises";
import path from "node:path";

const LOCK_NAME = ".gamebuddy-target-runtime-lease-v1";
const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const leases = new WeakSet();

function fail(code) {
  throw new Error(`stardew_target_runtime_lease_${code}`);
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function stat(candidate, code) {
  try { return await lstat(candidate); } catch { fail(code); }
}

async function assertTrustedDirectory(candidate) {
  const absolute = path.resolve(candidate);
  const parsed = path.parse(absolute);
  const relative = absolute.slice(parsed.root.length);
  let current = parsed.root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const details = await stat(current, "untrusted_path");
    if (details.isSymbolicLink()) fail("untrusted_path");
  }
  const details = await stat(absolute, "untrusted_path");
  if (!details.isDirectory() || details.isSymbolicLink()) fail("untrusted_path");
  let physical;
  try { physical = await realpath(absolute); } catch { fail("untrusted_path"); }
  if (path.relative(absolute, physical) !== "" || path.relative(physical, absolute) !== "") fail("untrusted_path");
  return { absolute, details };
}

function validateInput(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) fail("invalid_input");
  const { root, identity } = options;
  if (typeof root !== "string" || root.length === 0 || root.includes("\0")) fail("invalid_input");
  if (typeof identity !== "string" || !IDENTITY_PATTERN.test(identity)) fail("invalid_identity");
  return { root, identity };
}

export async function acquireTargetRuntimeLease(options) {
  const { root, identity } = validateInput(options);
  const trustedRoot = await assertTrustedDirectory(root);
  const lockPath = path.join(trustedRoot.absolute, LOCK_NAME);

  try {
    await mkdir(lockPath);
  } catch (error) {
    if (error?.code === "EEXIST") fail("owned");
    fail("acquisition_failed");
  }

  let lockDetails;
  try {
    const currentRoot = await stat(trustedRoot.absolute, "ownership_lost");
    lockDetails = await stat(lockPath, "ownership_lost");
    if (!sameFile(currentRoot, trustedRoot.details) || !lockDetails.isDirectory() || lockDetails.isSymbolicLink()) {
      fail("ownership_lost");
    }
  } catch (error) {
    // Ownership is no longer provable, so even cleanup must fail closed.
    throw error;
  }

  let released = false;
  const lease = Object.freeze({
    inspect() {
      if (!leases.has(lease)) fail("invalid_owner");
      return Object.freeze({ version: 1, identity, released });
    },
    async release() {
      if (!leases.has(lease)) fail("invalid_owner");
      if (released) fail("released");

      const currentRoot = await stat(trustedRoot.absolute, "ownership_lost");
      const currentLock = await stat(lockPath, "ownership_lost");
      if (
        !sameFile(currentRoot, trustedRoot.details)
        || !sameFile(currentLock, lockDetails)
        || !currentLock.isDirectory()
        || currentLock.isSymbolicLink()
      ) fail("ownership_lost");

      let entries;
      try { entries = await readdir(lockPath); } catch { fail("ownership_lost"); }
      if (entries.length !== 0) fail("ownership_lost");
      try { await rmdir(lockPath); } catch { fail("ownership_lost"); }
      released = true;
    },
  });
  leases.add(lease);
  return lease;
}
