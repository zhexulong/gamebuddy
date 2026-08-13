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
 * Move one malformed test-artifact lock into a same-directory quarantine.
 * This is intentionally separate from ordinary lock acquisition: callers must
 * opt into the operator repair with --quarantine-malformed at the CLI.
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
    now = () => new Date(),
  } = options;
  const { absolutePath, entry } = await assertSafeLockPath(lockPath, { lstatFile, realpathFile });
  const originalBytes = await readFileBuffer(absolutePath);
  const afterRead = await lstatFile(absolutePath);
  if (fileIdentity(entry) !== fileIdentity(afterRead) || !afterRead.isFile()) {
    throw failure("host_test_artifact_lock_repair_race");
  }
  // A valid owner record is never eligible for this command, regardless of
  // process liveness. Ordinary acquisition remains the only reclaim path.
  let malformed = false;
  try {
    parseLockBytes(originalBytes);
  } catch (error) {
    if (error?.message === "host_test_artifact_lock_malformed") malformed = true;
    else throw error;
  }
  if (!malformed) throw failure("host_test_artifact_lock_valid");

  const quarantinePath = `${absolutePath}.malformed-quarantine-${randomUUID()}`;
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
    status: "quarantined-malformed",
    repairedAt: now().toISOString(),
    lockPath: relativePath(absolutePath),
    quarantinePath: relativePath(quarantinePath),
    reportPath: relativePath(reportPath),
    original: {
      identity: fileIdentity(entry),
      byteLength: originalBytes.byteLength,
      sha256: sha256(originalBytes),
      malformed: true,
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
    return 0;
  }
  if (!args.quarantineMalformed) throw failure("host_test_artifact_lock_repair_requires_flag");
  const result = await quarantineMalformedTestArtifactLock(args.lockPath);
  console.log(JSON.stringify({ quarantinePath: result.quarantinePath, reportPath: result.reportPath }));
  return 0;
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}` || process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  });
}

export { defaultLockPath, hostRoot, parseArguments, serializeReport };
