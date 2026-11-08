import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  link,
  lstat,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { probeTestArtifactLockOwner } from "./test-artifact-lock.mjs";

const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultLockPath = resolve(hostRoot, ".test-artifact.lock");
const LOCK_VERSION = 1;
const OWNER_TOKEN_PATTERN = /^[0-9a-f]{32}$/u;

function failure(message, cause) {
  return new Error(message, cause === undefined ? undefined : { cause });
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
    throw failure("host_test_artifact_lock_malformed");
  }
  return Object.freeze({ ...value });
}

function parseLockBytes(bytes) {
  try {
    return assertRecord(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    if (error?.message === "host_test_artifact_lock_malformed") throw error;
    throw failure("host_test_artifact_lock_malformed", error);
  }
}

/**
 * The two conditions that make a lock safe to move aside, and the only two. `malformed` is a record this command cannot
 * read at all. `owner-absent` is a READABLE record whose owner the shared liveness probe has proven gone.
 *
 * A pid that does not exist is a fact the machine can check, so a lock naming one is repaired instead of refused: this
 * is how `unverified:win32` records - Windows carries no start identity - were stranded, with every build refusing
 * until an operator deleted the file by hand. The probe is `probeTestArtifactLockOwner` and not a second spelling of
 * it: it answers "dead" only for a missing pid (or, on Linux, a start time that proves reuse) and answers
 * "alive"/"unknown" for a live, inaccessible or unexplained one. Everything but "dead" still meets
 * `host_test_artifact_lock_valid`, because a live pid this command cannot tie to its record may be an owner mid-write.
 */
export const LOCK_REPAIR_REASONS = Object.freeze({
  malformed: "malformed",
  ownerAbsent: "owner-absent",
});

export async function classifyRepairableLock(bytes, { processProbe }) {
  let record;
  try {
    record = parseLockBytes(bytes);
  } catch (error) {
    if (error?.message === "host_test_artifact_lock_malformed") return { reason: LOCK_REPAIR_REASONS.malformed };
    throw error;
  }
  const ownerState = await processProbe(record);
  if (ownerState !== "dead") throw failure("host_test_artifact_lock_valid");
  return { reason: LOCK_REPAIR_REASONS.ownerAbsent, record, ownerState };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fileIdentity(stat) {
  return `${stat.dev}:${stat.ino}:${stat.mode}`;
}

function pathIsWithinHostRoot(path) {
  const resolved = resolve(path);
  const remainder = relative(hostRoot, resolved);
  return remainder !== "" && remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder);
}

async function assertSafeLockPath(lockPath, { lstatFile = lstat, realpathFile = realpath } = {}) {
  const absolutePath = resolve(lockPath);
  if (!pathIsWithinHostRoot(absolutePath)) {
    throw failure("host_test_artifact_lock_path_outside_host_root");
  }
  let parent;
  try {
    parent = await realpathFile(dirname(absolutePath));
  } catch (error) {
    if (error?.code === "ENOENT") throw failure("host_test_artifact_lock_not_found", error);
    throw error;
  }
  if (!pathIsWithinHostRoot(resolve(parent, "placeholder"))) {
    throw failure("host_test_artifact_lock_path_outside_host_root");
  }
  let entry;
  try {
    entry = await lstatFile(absolutePath);
  } catch (error) {
    if (error?.code === "ENOENT") throw failure("host_test_artifact_lock_not_found", error);
    throw error;
  }
  if (entry.isSymbolicLink()) throw failure("host_test_artifact_lock_symlink_rejected");
  if (!entry.isFile()) throw failure("host_test_artifact_lock_not_regular_file");
  return { absolutePath, parent, entry };
}

function serializeReport(payload) {
  const canonical = JSON.stringify(payload);
  return JSON.stringify({ ...payload, reportSha256: sha256(Buffer.from(canonical, "utf8")) }) + "\n";
}

async function writeReport(reportPath, payload, {
  openFile = open,
  linkFile = link,
  unlinkFile = unlink,
} = {}) {
  const reportText = serializeReport(payload);
  const temporaryPath = `${reportPath}.new-${randomUUID()}`;
  const handle = await openFile(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(reportText, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  // link() is deliberately used instead of rename(): a pre-existing report
  // can never be overwritten, even if an operator or another process races us.
  await linkFile(temporaryPath, reportPath);
  await unlinkFile(temporaryPath);
  return { reportText };
}

async function restoreIfAbsent(quarantinePath, lockPath, { linkFile = link, lstatFile = lstat } = {}) {
  try {
    await linkFile(quarantinePath, lockPath);
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    return false;
  }
  // Keep the quarantine hardlink. The repair command never deletes original
  // lock bytes, even when restoring them after a failed re-check.
  try {
    await lstatFile(lockPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Move one unownable test-artifact lock into a same-directory quarantine: either a malformed record, or a readable one
 * whose recorded owner pid no longer exists. This is intentionally separate from ordinary lock acquisition - which
 * reclaims a proven-dead owner itself - because a caller has to opt in at the CLI with --quarantine-malformed.
 */
export async function quarantineMalformedTestArtifactLock(lockPath = defaultLockPath, options = {}) {
  const {
    renameFile = rename,
    lstatFile = lstat,
    readFileBuffer = readFile,
    realpathFile = realpath,
    openFile = open,
    linkFile = link,
    unlinkFile = unlink,
    processProbe = probeTestArtifactLockOwner,
    now = () => new Date(),
  } = options;
  const { absolutePath, entry } = await assertSafeLockPath(lockPath, { lstatFile, realpathFile });
  const originalBytes = await readFileBuffer(absolutePath);
  const afterRead = await lstatFile(absolutePath);
  if (fileIdentity(entry) !== fileIdentity(afterRead) || !afterRead.isFile()) {
    throw failure("host_test_artifact_lock_repair_race");
  }
  // A lock is repaired for exactly two reasons, and neither of them is "the owner looks busy": a record that cannot be
  // read, and a record whose owner pid is proven gone. A live pid stays refused whatever its identity says.
  const verdict = await classifyRepairableLock(originalBytes, { processProbe });

  const quarantinePath = `${absolutePath}.${verdict.reason}-quarantine-${randomUUID()}`;
  const reportPath = `${quarantinePath}.recovery-report.json`;
  await renameFile(absolutePath, quarantinePath);

  let quarantinedBytes;
  let quarantineEntry;
  try {
    quarantineEntry = await lstatFile(quarantinePath);
    quarantinedBytes = await readFileBuffer(quarantinePath);
  } catch (error) {
    throw failure("host_test_artifact_lock_repair_recheck_failed", error);
  }
  const exactIdentity = fileIdentity(entry) === fileIdentity(quarantineEntry);
  const exactBytes = Buffer.compare(originalBytes, quarantinedBytes) === 0;
  if (!exactIdentity || !exactBytes) {
    // If a pre-rename race moved a replacement into quarantine, restore it
    // only when lockPath is absent. Never overwrite a replacement lock.
    await restoreIfAbsent(quarantinePath, absolutePath, { linkFile, lstatFile });
    throw failure("host_test_artifact_lock_repair_recheck_failed");
  }

  let replacement;
  try {
    const replacementEntry = await lstatFile(absolutePath);
    if (replacementEntry.isFile() && !replacementEntry.isSymbolicLink()) {
      const replacementBytes = await readFileBuffer(absolutePath);
      replacement = {
        identity: fileIdentity(replacementEntry),
        byteLength: replacementBytes.byteLength,
        sha256: sha256(replacementBytes),
      };
    } else {
      replacement = { rejected: true, reason: "not_regular_file" };
    }
  } catch (error) {
    if (error?.code !== "ENOENT") replacement = { rejected: true, reason: error.code ?? "read_failed" };
  }

  const relativePath = (value) => relative(hostRoot, value) || ".";
  const payload = {
    schemaVersion: 1,
    status: `quarantined-${verdict.reason}`,
    repairedAt: now().toISOString(),
    lockPath: relativePath(absolutePath),
    quarantinePath: relativePath(quarantinePath),
    reportPath: relativePath(reportPath),
    original: {
      identity: fileIdentity(entry),
      byteLength: originalBytes.byteLength,
      sha256: sha256(originalBytes),
      reason: verdict.reason,
      owner:
        verdict.record === undefined
          ? null
          : {
              pid: verdict.record.pid,
              processStartIdentity: verdict.record.processStartIdentity,
              pidState: verdict.ownerState,
            },
    },
    quarantine: {
      identity: fileIdentity(quarantineEntry),
      byteLength: quarantinedBytes.byteLength,
      sha256: sha256(quarantinedBytes),
      exactIdentity,
      exactBytes,
    },
    replacementAtLockPath: replacement ?? { absent: true },
    operatorNote: "Review the quarantined bytes before any separate manual recovery; no lock or quarantine file was deleted by this command.",
  };
  await writeReport(reportPath, payload, { openFile, linkFile, unlinkFile });
  return Object.freeze({ lockPath: absolutePath, quarantinePath, reportPath, report: payload });
}

function parseArguments(argv) {
  let quarantineMalformed = false;
  let lockPath = defaultLockPath;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--quarantine-malformed") {
      quarantineMalformed = true;
    } else if (argument === "--lock-path") {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw failure("host_test_artifact_lock_invalid_arguments");
      lockPath = resolve(hostRoot, value);
    } else if (argument === "--help" || argument === "-h") {
      return { help: true };
    } else {
      throw failure("host_test_artifact_lock_invalid_arguments");
    }
  }
  return { quarantineMalformed, lockPath };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  if (args.help) {
    console.log("Usage: node scripts/repair-test-artifact-lock.mjs --quarantine-malformed [--lock-path PATH]");
    console.log("  --quarantine-malformed  move aside a malformed record, or one whose recorded owner pid is gone");
    return 0;
  }
  if (!args.quarantineMalformed) throw failure("host_test_artifact_lock_repair_requires_flag");
  const result = await quarantineMalformedTestArtifactLock(args.lockPath);
  console.log(JSON.stringify({ status: result.report.status, quarantinePath: result.quarantinePath, reportPath: result.reportPath }));
  return 0;
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}` || process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  });
}

export { defaultLockPath, hostRoot, parseArguments, serializeReport };
