import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FINAL_STATUSES = new Set(["complete", "incomplete"]);
const VERDICTS = new Set(["passed", "blocked", "failed", "uncertain"]);
const MAX_METADATA_BYTES = 32 * 1024;
const MANIFEST_KEYS = new Set(["schema", "identity", "status", "verdict", "metadata"]);
const runState = new WeakMap();

function fail(code) { throw new Error(`game_action_evidence_${code}`); }
function assertId(value, field) { if (typeof value !== "string" || !ID_PATTERN.test(value)) fail(`invalid_${field}`); }
function assertObject(value, code) { if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code); }
function assertRoot(root) { if (typeof root !== "string" || root.length === 0) fail("invalid_root"); return path.resolve(root); }
function validateIdentity(identity) {
  assertObject(identity, "invalid_identity");
  if (Object.keys(identity).length !== 3 || !["gameId", "actionId", "runId"].every((key) => Object.hasOwn(identity, key))) fail("invalid_identity");
  assertId(identity.gameId, "game_id"); assertId(identity.actionId, "action_id"); assertId(identity.runId, "run_id");
  return Object.freeze({ gameId: identity.gameId, actionId: identity.actionId, runId: identity.runId });
}
function runDirectory(root, identity) { return path.join(root, identity.gameId, identity.actionId, identity.runId); }
function stagingDirectory(root, identity) { return `${runDirectory(root, identity)}.staging`; }
function identityEquals(left, right) { return left.gameId === right.gameId && left.actionId === right.actionId && left.runId === right.runId; }

async function trustedRoot(root) {
  const resolved = assertRoot(root);
  const stat = await lstat(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail("path_symlink");
  return realpath(resolved);
}

async function assertTrustedPath(root, target, { createParents = false } = {}) {
  const canonicalRoot = await realpath(assertRoot(root));
  const relative = path.relative(canonicalRoot, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) fail("path_escape");
  const parts = relative.split(path.sep);
  const end = createParents ? parts.length - 1 : parts.length;
  let current = canonicalRoot;
  for (let i = 0; i < end; i++) {
    current = path.join(current, parts[i]);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) fail("path_symlink");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      if (!createParents) fail("bundle_unreadable");
      await mkdir(current);
    }
  }
  return canonicalRoot;
}

function validateManifest(manifest, expectedIdentity) {
  assertObject(manifest, "bundle_invalid");
  if (Object.keys(manifest).some((key) => !MANIFEST_KEYS.has(key)) || Object.keys(manifest).length !== MANIFEST_KEYS.size) fail("bundle_invalid");
  if (manifest.schema !== "gamebuddy-action-evidence/v1") fail("bundle_invalid");
  const identity = validateIdentity(manifest.identity);
  if (expectedIdentity && !identityEquals(identity, expectedIdentity)) fail("identity_mismatch");
  if (!FINAL_STATUSES.has(manifest.status) || !VERDICTS.has(manifest.verdict)) fail("bundle_invalid");
  if (manifest.status !== "complete" && manifest.verdict === "passed") fail("bundle_invalid");
  assertObject(manifest.metadata, "bundle_invalid");
  return Object.freeze({ schema: manifest.schema, identity, status: manifest.status, verdict: manifest.verdict, metadata: manifest.metadata });
}

function prepareManifest(manifest, expectedIdentity) {
  let text;
  try { text = JSON.stringify(manifest); } catch { fail("bundle_invalid"); }
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_METADATA_BYTES) fail("bundle_invalid");
  let parsed;
  try { parsed = JSON.parse(text); } catch { fail("bundle_invalid"); }
  return { manifest: validateManifest(parsed, expectedIdentity), text };
}

async function assertTrustedDirectory(directory) {
  const stat = await lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) fail("path_symlink");
}

async function readTrustedFile(file) {
  const stat = await lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile()) fail("path_symlink");
  return readFile(file, "utf8");
}

export async function beginEvidenceRun({ root, identity }) {
  const canonicalRoot = await trustedRoot(root);
  const canonicalIdentity = validateIdentity(identity);
  const finalDirectory = runDirectory(canonicalRoot, canonicalIdentity);
  const staging = stagingDirectory(canonicalRoot, canonicalIdentity);
  await assertTrustedPath(canonicalRoot, finalDirectory, { createParents: true });
  for (const candidate of [finalDirectory, staging]) {
    try { await lstat(candidate); fail(candidate === finalDirectory ? "final_destination_exists" : "staging_exists"); }
    catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
  await mkdir(staging);
  const run = Object.freeze({ root: canonicalRoot, identity: canonicalIdentity, staging, finalDirectory });
  runState.set(run, "open");
  return run;
}

export async function finalizeEvidenceRun(run, { status, verdict, metadata = {} }) {
  assertObject(run, "invalid_run");
  if (!runState.has(run)) fail("invalid_run");
  if (runState.get(run) !== "open") fail("already_finalized");
  const prepared = prepareManifest({ schema: "gamebuddy-action-evidence/v1", identity: run.identity, status, verdict, metadata }, run.identity);
  runState.set(run, "finalizing");
  try {
    await assertTrustedPath(run.root, path.dirname(run.finalDirectory));
    await assertTrustedDirectory(run.staging);
    await writeFile(path.join(run.staging, "bundle.json"), prepared.text, { encoding: "utf8", flag: "wx" });
    await rename(run.staging, run.finalDirectory);
    runState.set(run, "finalized");
    return Object.freeze({ ...prepared.manifest, directory: run.finalDirectory });
  } catch (error) {
    runState.set(run, "failed");
    await rm(run.staging, { recursive: true, force: true });
    throw error;
  }
}

export async function finalizeIncompleteEvidenceRun(run, { verdict = "uncertain", metadata = {} } = {}) {
  if (verdict === "passed") fail("incomplete_cannot_pass");
  return finalizeEvidenceRun(run, { status: "incomplete", verdict, metadata });
}

export async function readPassedEvidence({ root, identity }) {
  const canonicalRoot = await trustedRoot(root);
  const canonicalIdentity = validateIdentity(identity);
  const directory = runDirectory(canonicalRoot, canonicalIdentity);
  await assertTrustedPath(canonicalRoot, directory);
  let parsed;
  try { parsed = JSON.parse(await readTrustedFile(path.join(directory, "bundle.json"))); } catch (error) {
    if (String(error?.message).includes("path_symlink")) throw error;
    fail("bundle_unreadable");
  }
  const { manifest } = prepareManifest(parsed, canonicalIdentity);
  if (manifest.status !== "complete" || manifest.verdict !== "passed") fail("bundle_not_passing");
  return manifest;
}
