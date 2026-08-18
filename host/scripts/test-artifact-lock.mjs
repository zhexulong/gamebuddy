import { lstat, mkdir, open, readFile, rename, unlink, link } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultLockPath = resolve(hostRoot, ".test-artifact.lock");
const LOCK_VERSION = 1;
const OWNER_TOKEN_PATTERN = /^[0-9a-f]{32}$/u;

function lockInUse(cause) {
  return new Error("host_test_artifact_already_in_use", { cause });
}

function lockMalformed(cause) {
  return new Error("host_test_artifact_lock_malformed", { cause });
}

function lockOwnershipLost() {
  return new Error("host_test_artifact_lock_ownership_lost");
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === 5 && keys.join(",") === "createdAtMs,ownerToken,pid,processStartIdentity,version";
}

function assertRecord(value) {
  if (!isRecord(value) || value.version !== LOCK_VERSION ||
      !Number.isSafeInteger(value.pid) || value.pid <= 0 ||
      typeof value.processStartIdentity !== "string" || value.processStartIdentity.length === 0 || value.processStartIdentity.length > 512 ||
      !OWNER_TOKEN_PATTERN.test(value.ownerToken) ||
      !Number.isSafeInteger(value.createdAtMs) || value.createdAtMs <= 0) {
    throw lockMalformed();
  }
  return Object.freeze({ ...value });
}

function serializeRecord(record) {
  return JSON.stringify({
    version: record.version,
    pid: record.pid,
    processStartIdentity: record.processStartIdentity,
    ownerToken: record.ownerToken,
    createdAtMs: record.createdAtMs,
  }) + "\n";
}

function sameRecord(left, right) {
  return serializeRecord(left) === serializeRecord(right);
}

/** Read and strictly validate the lock's immutable owner record. */
export async function readTestArtifactLock(lockPath = defaultLockPath) {
  let text;
  try {
    text = await readFile(lockPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return assertRecord(JSON.parse(text));
  } catch (error) {
    if (error?.message === "host_test_artifact_lock_malformed") throw error;
    throw lockMalformed(error);
  }
}

async function linuxProcessStartIdentity(pid) {
  if (process.platform !== "linux") return undefined;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const closingParen = stat.lastIndexOf(")");
    if (closingParen < 0) return undefined;
    const fields = stat.slice(closingParen + 1).trim().split(/\s+/u);
    // The starttime field is field 22; fields after the comm field start at 3.
    const startTime = fields[19];
    if (!/^\d+$/u.test(startTime ?? "")) return undefined;
    let bootId;
    try { bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(); } catch { return undefined; }
    if (!/^[0-9a-f-]{16,64}$/iu.test(bootId)) return undefined;
    return `linux:${bootId}:${startTime}`;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ESRCH" || error?.code === "EACCES") return undefined;
    return undefined;
  }
}

async function currentProcessStartIdentity() {
  return await linuxProcessStartIdentity(process.pid) ?? `unverified:${process.platform}`;
}

/**
 * Conservative process liveness check. "unknown" is deliberately not
 * reclaimable. On Linux, a changed /proc start time proves PID reuse rather
 * than treating a reused PID as the old owner. Other platforms use kill(0):
 * an inaccessible or otherwise uncertain process is considered live/unknown.
 */
export async function probeTestArtifactLockOwner(record) {
  let signal;
  try {
    process.kill(record.pid, 0);
    signal = "alive";
  } catch (error) {
    if (error?.code === "ESRCH") return "dead";
    if (error?.code === "EPERM" || error?.code === "EACCES") return "alive";
    return "unknown";
  }
  const currentIdentity = await linuxProcessStartIdentity(record.pid);
  if (currentIdentity !== undefined && currentIdentity !== record.processStartIdentity) return "dead";
  return signal;
}

async function restoreQuarantine(quarantinePath, lockPath, { linkFile = link } = {}) {
  try {
    // link() is no-replace on the supported filesystems. rename() here would
    // overwrite a newly acquired live lock during an ownership race.
    await linkFile(quarantinePath, lockPath);
    await unlink(quarantinePath);
  } catch (error) {
    // EEXIST means a replacement owner is already safely at lockPath. Any
    // other failure leaves the quarantine in place rather than deleting it.
    if (error?.code !== "EEXIST") return false;
  }
  return true;
}

/**
 * Remove a lock only after atomically moving it to a private quarantine and
 * re-checking both its exact owner record and owner liveness. This makes path
 * replacement unable to turn cleanup into deletion of another owner's lock.
 */
export async function cleanupTestArtifactLock(lockPath, expectedRecord, { renameFile = rename, linkFile = link, unlinkFile = unlink, processProbe = probeTestArtifactLockOwner, allowCurrentOwner = false } = {}) {
  const quarantinePath = `${lockPath}.reclaim-${randomUUID()}`;
  try {
    await renameFile(lockPath, quarantinePath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }

  let quarantined;
  try {
    quarantined = await readTestArtifactLock(quarantinePath);
  } catch {
    await restoreQuarantine(quarantinePath, lockPath, { linkFile });
    throw lockOwnershipLost();
  }
  const ownerState = quarantined === undefined || !sameRecord(quarantined, expectedRecord)
    ? "changed"
    : await processProbe(quarantined);
  const isCurrentOwner = allowCurrentOwner && quarantined !== undefined && sameRecord(quarantined, expectedRecord) && quarantined.pid === process.pid && quarantined.processStartIdentity === await currentProcessStartIdentity();
  if (!isCurrentOwner && ownerState !== "dead" && (ownerState !== "changed" || !sameRecord(quarantined, expectedRecord))) {
    await restoreQuarantine(quarantinePath, lockPath, { linkFile });
    throw lockOwnershipLost();
  }
  if (!isCurrentOwner && ownerState !== "dead") {
    await restoreQuarantine(quarantinePath, lockPath, { linkFile });
    throw lockOwnershipLost();
  }
  await unlinkFile(quarantinePath);
  return true;
}

async function reclaimDeadLock(lockPath, record, processProbe) {
  const state = await processProbe(record);
  if (state !== "dead") return false;
  return await cleanupTestArtifactLock(lockPath, record, { processProbe });
}

/**
 * If a platform reports a successful hard-link publication but the published
 * bytes cannot be validated, move only the current published entry to a
 * private quarantine and re-check its inode before deleting it. The move is
 * the no-replace boundary: a contender's replacement is restored, never
 * unlinked through a stale pathname.
 */
async function removePublishedCandidate(temporaryPath, lockPath, {
  renameFile = rename,
  linkFile = link,
  unlinkFile = unlink,
} = {}) {
  let temporaryStat;
  let lockStat;
  try {
    [temporaryStat, lockStat] = await Promise.all([lstat(temporaryPath), lstat(lockPath)]);
    if (temporaryStat.dev !== lockStat.dev || temporaryStat.ino !== lockStat.ino) return false;
  } catch {
    return false;
  }
  const quarantinePath = `${lockPath}.publish-reclaim-${randomUUID()}`;
  try {
    await renameFile(lockPath, quarantinePath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    return false;
  }
  try {
    const [temporaryStat, quarantineStat] = await Promise.all([lstat(temporaryPath), lstat(quarantinePath)]);
    if (temporaryStat.dev !== quarantineStat.dev || temporaryStat.ino !== quarantineStat.ino) {
      await restoreQuarantine(quarantinePath, lockPath, { linkFile });
      return false;
    }
    await unlinkFile(quarantinePath);
    return true;
  } catch {
    await restoreQuarantine(quarantinePath, lockPath, { linkFile });
    return false;
  }
}

/** Exclusively own dist-test for an entire supported package-script operation. */
export async function withTestArtifactLock(run, {
  lockPath = defaultLockPath,
  processProbe = probeTestArtifactLockOwner,
  linkFile = link,
  unlinkFile = unlink,
  renameFile = rename,
} = {}) {
  let handle;
  let record;
  try {
    for (;;) {
      const candidate = Object.freeze({
        version: LOCK_VERSION,
        pid: process.pid,
        processStartIdentity: await currentProcessStartIdentity(),
        ownerToken: randomUUID().replaceAll("-", ""),
        createdAtMs: Date.now(),
      });
      const temporaryPath = `${lockPath}.new-${randomUUID()}`;
      try {
        await mkdir(dirname(lockPath), { recursive: true });
        const temporaryHandle = await open(temporaryPath, "wx", 0o600);
        try {
          await temporaryHandle.writeFile(serializeRecord(candidate), "utf8");
          await temporaryHandle.sync();
        } finally {
          await temporaryHandle.close();
        }
        // The complete, fsynced record is published with no-replace link
        // semantics. Do not expose lockPath while the record is being written.
        await linkFile(temporaryPath, lockPath);
        let publishedRecord;
        try {
          publishedRecord = await readTestArtifactLock(lockPath);
        } catch (error) {
          // A successful link must expose the exact complete record. If a
          // Windows/filesystem race nevertheless exposes malformed bytes,
          // remove only our hardlink inode; a replacement remains untouched.
          await removePublishedCandidate(temporaryPath, lockPath, { renameFile, linkFile, unlinkFile });
          throw error;
        }
        if (publishedRecord === undefined || !sameRecord(publishedRecord, candidate)) {
          await removePublishedCandidate(temporaryPath, lockPath, { renameFile, linkFile, unlinkFile });
          throw lockOwnershipLost();
        }
        // Cleanup is not part of publication. A transient failure to unlink
        // the private hardlink must not turn an already validated lock into a
        // second acquisition attempt.
        await unlinkFile(temporaryPath).catch(() => undefined);
        record = candidate;
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") {
          // The private hardlink is never the published lock. It is safe to
          // remove it after every non-contention failure.
          await unlinkFile(temporaryPath).catch(() => undefined);
          throw error;
        }
        // Windows can report a raced link publication as EEXIST after the
        // destination entry has become visible. If it is our exact inode,
        // quarantine it before interpreting EEXIST as a contender lock.
        const publishedAfterError = await removePublishedCandidate(temporaryPath, lockPath, { renameFile, linkFile, unlinkFile });
        await unlinkFile(temporaryPath).catch(() => undefined);
        if (publishedAfterError) continue;
        let existing;
        try {
          existing = await readTestArtifactLock(lockPath);
          if (existing === undefined) continue;
          const reclaimed = await reclaimDeadLock(lockPath, existing, processProbe);
          if (reclaimed) continue;
        } catch (probeError) {
          throw lockInUse(probeError);
        }
        throw lockInUse();
      }
    }
    return await run();
  } finally {
    if (handle !== undefined) {
      await handle.close();
      handle = undefined;
    }
    if (record !== undefined) {
      await cleanupTestArtifactLock(lockPath, record, { processProbe, allowCurrentOwner: true });
    }
  }
}

export { LOCK_VERSION, serializeRecord };
