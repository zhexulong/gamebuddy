import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, rename, rmdir } from "node:fs/promises";
import path from "node:path";

function fail(code, cause) {
  throw new Error(`atomic_directory_${code}`, cause ? { cause } : undefined);
}

function samePath(left, right) {
  return process.platform === "win32"
    ? path.normalize(left).toLowerCase() === path.normalize(right).toLowerCase()
    : path.normalize(left) === path.normalize(right);
}

async function assertCanonicalDirectory(candidate, code) {
  const absolute = path.resolve(candidate);
  let current = path.parse(absolute).root;
  try {
    for (const segment of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      const details = await lstat(current);
      if (!details.isDirectory() || details.isSymbolicLink()) fail(code);
    }
    if (!samePath(await realpath(absolute), absolute)) fail(code);
    return absolute;
  } catch (error) {
    if (error?.message?.startsWith("atomic_directory_")) throw error;
    fail(code, error);
  }
}

async function ensureCanonicalParent(parent) {
  const missing = [];
  let current = path.resolve(parent);
  while (true) {
    try {
      await assertCanonicalDirectory(current, "parent_invalid");
      break;
    } catch (error) {
      if (error?.cause?.code !== "ENOENT") throw error;
      missing.push(current);
      const next = path.dirname(current);
      if (next === current) fail("parent_invalid", error);
      current = next;
    }
  }
  for (const candidate of missing.reverse()) {
    try { await mkdir(candidate, { mode: 0o700 }); }
    catch (error) { if (error?.code !== "EEXIST") throw error; }
    await assertCanonicalDirectory(candidate, "parent_invalid");
  }
  return await assertCanonicalDirectory(parent, "parent_invalid");
}

async function assertAbsent(candidate, code) {
  try { await lstat(candidate); fail(code); }
  catch (error) {
    if (error?.message === `atomic_directory_${code}`) throw error;
    if (error?.code !== "ENOENT") throw error;
  }
}

const records = new WeakMap();
function recordOf(transaction) {
  const record = records.get(transaction);
  if (!record) fail("transaction_invalid");
  if (record.phase !== "prepared") fail("transaction_consumed");
  return record;
}

export async function prepareAtomicDirectory(finalPath) {
  if (typeof finalPath !== "string" || finalPath.length === 0 || !path.isAbsolute(finalPath) || finalPath.includes("\0")) fail("invalid_input");
  const output = path.resolve(finalPath);
  const parent = await ensureCanonicalParent(path.dirname(output));
  await assertAbsent(output, "output_exists");
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const stagingPath = path.join(parent, `.${path.basename(output)}.staging-${process.pid}-${randomUUID()}`);
    try { await mkdir(stagingPath, { mode: 0o700 }); }
    catch (error) { if (error?.code === "EEXIST") continue; throw error; }
    await assertCanonicalDirectory(stagingPath, "staging_invalid");
    const transaction = Object.freeze({ finalPath: output, stagingPath });
    records.set(transaction, { phase: "prepared", parent, finalPath: output, stagingPath });
    return transaction;
  }
  fail("staging_unavailable");
}

export async function commitAtomicDirectory(transaction) {
  const record = recordOf(transaction);
  await assertCanonicalDirectory(record.parent, "parent_invalid");
  await assertCanonicalDirectory(record.stagingPath, "staging_invalid");
  await assertAbsent(record.finalPath, "output_exists");
  try { await rename(record.stagingPath, record.finalPath); }
  catch (error) {
    if (["EEXIST", "ENOTEMPTY", "EPERM"].includes(error?.code)) fail("output_exists", error);
    throw error;
  }
  await assertCanonicalDirectory(record.finalPath, "final_invalid");
  record.phase = "committed";
}

export async function cleanupAtomicDirectory(transaction) {
  const record = recordOf(transaction);
  await assertCanonicalDirectory(record.parent, "parent_invalid");
  await assertCanonicalDirectory(record.stagingPath, "staging_invalid");
  try { await rmdir(record.stagingPath); }
  catch (error) { fail(error?.code === "ENOTEMPTY" ? "staging_not_empty" : "cleanup_uncertain", error); }
  record.phase = "cleaned";
}
