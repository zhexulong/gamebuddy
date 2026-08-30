import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, rm, rmdir } from "node:fs/promises";
import path from "node:path";

const DEFAULT_ERROR_CODE = "atomic_directory";

function errorName(code, errorCode) {
  if (errorCode !== "ci_snapshot" && errorCode !== "ci_snapshot_output") return code;
  return {
    parent_invalid: "output_root_invalid",
    staging_invalid: errorCode === "ci_snapshot" ? "temporary_output_invalid" : "output_root_invalid",
    final_invalid: "output_root_invalid",
    staging_unavailable: "temporary_output_unavailable",
    output_exists: "output_exists",
  }[code] ?? code;
}

function fail(code, cause, errorCode = DEFAULT_ERROR_CODE) {
  throw new Error(`${errorCode}_${errorName(code, errorCode)}`, cause ? { cause } : undefined);
}

function samePath(left, right) {
  return process.platform === "win32"
    ? path.normalize(left).toLowerCase() === path.normalize(right).toLowerCase()
    : path.normalize(left) === path.normalize(right);
}

async function assertCanonicalDirectory(candidate, code, errorCode = DEFAULT_ERROR_CODE) {
  const absolute = path.resolve(candidate);
  let current = path.parse(absolute).root;
  try {
    for (const segment of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      const details = await lstat(current);
      if (!details.isDirectory() || details.isSymbolicLink()) fail(code, undefined, errorCode);
    }
    if (!samePath(await realpath(absolute), absolute)) fail(code, undefined, errorCode);
    return absolute;
  } catch (error) {
    if (error?.message?.startsWith(`${errorCode}_`)) throw error;
    fail(code, error, errorCode);
  }
}

async function ensureCanonicalParent(parent, errorCode) {
  const missing = [];
  let current = path.resolve(parent);
  while (true) {
    try {
      await assertCanonicalDirectory(current, "parent_invalid", errorCode);
      break;
    } catch (error) {
      if (error?.cause?.code !== "ENOENT") throw error;
      missing.push(current);
      const next = path.dirname(current);
      if (next === current) fail("parent_invalid", error, errorCode);
      current = next;
    }
  }
  for (const candidate of missing.reverse()) {
    try { await mkdir(candidate, { mode: 0o700 }); }
    catch (error) { if (error?.code !== "EEXIST") throw error; }
    await assertCanonicalDirectory(candidate, "parent_invalid", errorCode);
  }
  return await assertCanonicalDirectory(parent, "parent_invalid", errorCode);
}

async function assertAbsent(candidate, code, errorCode = DEFAULT_ERROR_CODE) {
  try { await lstat(candidate); fail(code, undefined, errorCode); }
  catch (error) {
    if (error?.message === `${errorCode}_${code}`) throw error;
    if (error?.code !== "ENOENT") throw error;
  }
}

const records = new WeakMap();
function recordOf(transaction) {
  const record = records.get(transaction);
  if (!record) fail("transaction_invalid");
  if (record.phase !== "prepared") fail("transaction_consumed", undefined, record.errorCode);
  return record;
}

export async function prepareAtomicDirectory(
  finalPath,
  { code: errorCode = DEFAULT_ERROR_CODE, create = true } = {},
) {
  if (
    typeof finalPath !== "string" ||
    finalPath.length === 0 ||
    !path.isAbsolute(finalPath) ||
    finalPath.includes("\0")
  )
    fail("invalid_input", undefined, errorCode);
  const output = path.resolve(finalPath);
  const parent = await ensureCanonicalParent(path.dirname(output), errorCode);
  await assertAbsent(output, "output_exists", errorCode);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const stagingPath = path.join(parent, `.${path.basename(output)}.staging-${process.pid}-${randomUUID()}`);
    try {
      if (create) {
        await mkdir(stagingPath, { mode: 0o700 });
        await assertCanonicalDirectory(stagingPath, "staging_invalid", errorCode);
      } else {
        await assertAbsent(stagingPath, "staging_invalid", errorCode);
      }
    } catch (error) {
      if (error?.code === "EEXIST") continue;
      throw error;
    }
    const transaction = Object.freeze({ finalPath: output, stagingPath });
    records.set(transaction, { phase: "prepared", errorCode, create, parent, finalPath: output, stagingPath });
    return transaction;
  }
  fail("staging_unavailable", undefined, errorCode);
}

export async function commitAtomicDirectory(transaction) {
  const record = recordOf(transaction);
  if (record.errorCode === "ci_snapshot" && process.platform !== "win32")
    fail("transactional_output_unsupported_platform", undefined, record.errorCode);
  await assertCanonicalDirectory(record.parent, "parent_invalid", record.errorCode);
  await assertCanonicalDirectory(record.stagingPath, "staging_invalid", record.errorCode);
  await assertAbsent(record.finalPath, "output_exists", record.errorCode);
  try { await rename(record.stagingPath, record.finalPath); }
  catch (error) {
    if (["EEXIST", "ENOTEMPTY", "EPERM"].includes(error?.code)) fail("output_exists", error, record.errorCode);
    throw error;
  }
  await assertCanonicalDirectory(record.finalPath, "final_invalid", record.errorCode);
  record.phase = "committed";
}

export async function cleanupAtomicDirectory(transaction, { recursive = false } = {}) {
  const record = recordOf(transaction);
  await assertCanonicalDirectory(record.parent, "parent_invalid", record.errorCode);
  try {
    await assertCanonicalDirectory(record.stagingPath, "staging_invalid", record.errorCode);
  } catch (error) {
    if (record.create || error?.cause?.code !== "ENOENT") throw error;
    record.phase = "cleaned";
    return;
  }
  try {
    if (recursive) await rm(record.stagingPath, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
    else await rmdir(record.stagingPath);
  } catch (error) {
    fail(error?.code === "ENOTEMPTY" ? "staging_not_empty" : "cleanup_uncertain", error, record.errorCode);
  }
  record.phase = "cleaned";
}
