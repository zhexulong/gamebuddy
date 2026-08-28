import { randomUUID } from "node:crypto";
import { link, lstat, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_RESULT_BYTES = 64 * 1024;
const state = new WeakMap();

function fail(code) {
  throw new Error(`game_action_private_result_${code}`);
}

async function trustedRoot(root) {
  if (typeof root !== "string" || root.length === 0) fail("invalid_root");
  const resolved = path.resolve(root);
  const stat = await lstat(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail("root_untrusted");
  return realpath(resolved);
}

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function trustedRegularFile(root, file) {
  if (!contained(root, file)) fail("path_escape");
  const stat = await lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile()) fail("result_untrusted");
}

/**
 * Reserves one absolute, initially absent result path inside a newly-created private directory.
 * The caller passes only `resultFile` to a child. This module never parses the child payload.
 */
export async function beginPrivateResultFile({ root = os.tmpdir() } = {}) {
  const canonicalRoot = await trustedRoot(root);
  const directory = await mkdtemp(path.join(canonicalRoot, "game-action-result-"));
  const resultFile = path.join(directory, "scenario-result.json");
  const claim = Object.freeze({ directory, resultFile });
  state.set(claim, "open");
  return claim;
}

/**
 * Writes bounded UTF-8 result text by exclusive sibling temporary file then one atomic link publish.
 * Child scenario code may use this protocol but retains ownership of the result schema.
 */
export async function writePrivateResultFile(resultFile, text) {
  if (typeof resultFile !== "string" || !path.isAbsolute(resultFile) || typeof text !== "string") fail("invalid_write_input");
  const directory = path.dirname(resultFile);
  const root = await trustedRoot(directory);
  const target = path.resolve(resultFile);
  if (!contained(root, target) || path.dirname(target) !== root) fail("path_escape");
  if (Buffer.byteLength(text, "utf8") === 0 || Buffer.byteLength(text, "utf8") > MAX_RESULT_BYTES) fail("invalid_size");
  try { await lstat(target); fail("destination_exists"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const temporary = path.join(root, `.${path.basename(target)}.${randomUUID()}.tmp`);
  let temporaryOwned = false;
  try {
    await writeFile(temporary, text, { encoding: "utf8", flag: "wx" });
    temporaryOwned = true;
    try { await link(temporary, target); } catch (error) {
      if (error?.code === "EEXIST") fail("destination_exists");
      throw error;
    }
    await rm(temporary);
    temporaryOwned = false;
  } catch (error) {
    if (temporaryOwned) await rm(temporary, { force: true });
    throw error;
  }
}

/** Reads the one result file exactly once as bounded UTF-8 text; schema validation remains game-owned. */
export async function readPrivateResultFile(claim) {
  if (!claim || state.get(claim) !== "open") fail("invalid_or_consumed_claim");
  state.set(claim, "reading");
  try {
    const root = await trustedRoot(claim.directory);
    const file = path.resolve(claim.resultFile);
    await trustedRegularFile(root, file);
    const handle = await open(file, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_RESULT_BYTES) fail("invalid_size");
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (bytesRead === 0) fail("result_changed");
        offset += bytesRead;
      }
      let text;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { fail("invalid_utf8"); }
      state.set(claim, "consumed");
      return text;
    } finally {
      await handle.close();
    }
  } catch (error) {
    state.set(claim, "failed");
    throw error;
  }
}

/** Removes the private directory; it is safe to call once after any terminal outcome. */
export async function cleanupPrivateResultFile(claim) {
  if (!claim || !state.has(claim)) fail("invalid_claim");
  if (state.get(claim) === "cleaned") fail("already_cleaned");
  state.set(claim, "cleaning");
  try {
    const parent = path.dirname(claim.directory);
    const canonicalParent = await trustedRoot(parent);
    const directory = path.resolve(claim.directory);
    if (!contained(canonicalParent, directory)) fail("path_escape");
    const stat = await lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("root_untrusted");
    await rm(directory, { recursive: true, force: false });
    state.set(claim, "cleaned");
  } catch (error) {
    state.set(claim, "failed");
    throw error;
  }
}

export { MAX_RESULT_BYTES };
