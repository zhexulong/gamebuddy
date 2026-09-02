import { createHash } from "node:crypto";
import { mkdir, mkdtemp, lstat, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import yauzl from "yauzl";

const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_ENTRIES = 2_000;
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
import { createWindowsReleaseBootstrapScratch } from "./windows-release-bootstrap-scratch.internal.mjs";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const slash = (value) => value.replaceAll("\\", "/");
const inside = (root, path) => { const value = relative(root, path); return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value)); };
const protectedReleaseWorkflow = "GameBuddy Protected Windows Release";
const protectedReleaseEnvironment = "gamebuddy-production-release";
const protectedTagRef = /^refs\/tags\/v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const exactDescriptor = (value) => value !== null && typeof value === "object" && typeof value.sourceUrl === "string" && /^https:\/\/nodejs\.org\//.test(value.sourceUrl)
  && typeof value.archiveSha256 === "string" && /^[a-f0-9]{64}$/.test(value.archiveSha256)
  && typeof value.archiveRoot === "string" && /^[A-Za-z0-9._-]+$/.test(value.archiveRoot)
  && typeof value.nodeSha256 === "string" && /^[a-f0-9]{64}$/.test(value.nodeSha256);

function rejectName(name, root) {
  if (typeof name !== "string" || !name || name.includes("\0") || name.includes("\\") || name.startsWith("/") || name.startsWith("\\\\") || /^[A-Za-z]:/.test(name) || name.endsWith("/") || name.includes(":")) throw new Error("runtime_zip_entry_forbidden");
  const pieces = name.split("/");
  if (pieces.some((piece) => !piece || piece === "." || piece === ".." || /[. ]$/.test(piece) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(piece))) throw new Error("runtime_zip_entry_forbidden");
  if (pieces[0] !== root || pieces.length < 2) throw new Error("runtime_zip_root_invalid");
  return pieces.slice(1).join("/");
}
function isRegularEntry(entry) { const unixType = (entry.externalFileAttributes >>> 16) & 0o170000; const dosDirectory = (entry.externalFileAttributes & 0x10) !== 0; return !entry.encrypted && (entry.compressionMethod === 0 || entry.compressionMethod === 8) && !dosDirectory && (unixType === 0 || unixType === 0o100000); }
function openZip(bytes) { return new Promise((resolveOpen, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true, autoClose: false }, (error, zip) => error ? reject(error) : resolveOpen(zip))); }
async function preflight(zip, descriptor) {
  const entries = []; const seenRaw = new Set(); const seenFolded = new Set(); let total = 0;
  try { await new Promise((resolveEntries, reject) => { zip.on("error", reject); zip.on("entry", (entry) => { try { if (entries.length >= MAX_ENTRIES) throw new Error("runtime_zip_entry_count_limit"); if (!isRegularEntry(entry)) throw new Error("runtime_zip_entry_forbidden"); if (entry.uncompressedSize > MAX_ENTRY_BYTES) throw new Error("runtime_zip_entry_size_limit"); const path = rejectName(entry.fileName, descriptor.archiveRoot); const folded = path.toLocaleLowerCase("en-US"); if (seenRaw.has(path) || seenFolded.has(folded)) throw new Error("runtime_zip_duplicate_destination"); seenRaw.add(path); seenFolded.add(folded); total += entry.uncompressedSize; if (total > MAX_TOTAL_BYTES) throw new Error("runtime_zip_expanded_size_limit"); entries.push({ entry, path }); zip.readEntry(); } catch (error) { reject(error); } }); zip.on("end", resolveEntries); zip.readEntry(); }); } catch (error) { throw new Error(error?.message?.startsWith("runtime_zip_") ? error.message : "runtime_zip_entry_forbidden"); }
  if (!entries.some(({ path }) => path === "node.exe")) throw new Error("runtime_zip_node_missing"); return entries;
}
async function streamEntry(zip, entry) { return new Promise((resolveStream, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolveStream(stream))); }
async function closure(root, prefix = "") { const entries = []; for (const item of (await readdir(resolve(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) { const path = prefix ? `${prefix}/${item.name}` : item.name; const absolute = resolve(root, path); const state = await lstat(absolute); if (state.isSymbolicLink() || (!state.isDirectory() && !state.isFile())) throw new Error("runtime_extraction_nonregular_entry"); if (state.isDirectory()) entries.push(...await closure(root, path)); else entries.push({ sourcePath: slash(path), sha256: sha256(await readFile(absolute)) }); } return entries; }
async function extract(bytes, descriptor, acquisitionRoot) {
  let zip; try { zip = await openZip(bytes); } catch { throw new Error("runtime_zip_entry_forbidden"); }
  try { const entries = await preflight(zip, descriptor); const extractionRoot = resolve(acquisitionRoot, "extracted"); await mkdir(extractionRoot, { recursive: false }); for (const { entry, path } of entries) { const target = resolve(extractionRoot, descriptor.archiveRoot, path); if (!inside(extractionRoot, target)) throw new Error("runtime_zip_entry_forbidden"); await mkdir(resolve(target, ".."), { recursive: true }); const output = await open(target, "wx"); try { const input = await streamEntry(zip, entry); let bytesWritten = 0; for await (const chunk of input) { bytesWritten += chunk.length; if (bytesWritten > entry.uncompressedSize) throw new Error("runtime_zip_entry_size_mismatch"); await output.write(chunk); } if (bytesWritten !== entry.uncompressedSize) throw new Error("runtime_zip_entry_size_mismatch"); } finally { await output.close(); } } const root = resolve(extractionRoot, descriptor.archiveRoot); if (JSON.stringify((await readdir(extractionRoot)).sort()) !== JSON.stringify([descriptor.archiveRoot])) throw new Error("runtime_extraction_root_invalid"); const files = await closure(root); if (files.find((entry) => entry.sourcePath === "node.exe")?.sha256 !== descriptor.nodeSha256) throw new Error("runtime_node_digest_mismatch"); return { extractedRoot: extractionRoot, files }; } finally { zip.close(); }
}
/** The release lane is intentionally unavailable outside the protected workflow.
 * The marker is bounded by this module and is not a runtime URL, digest, or path.
 * GitHub environment protection and tag protection are repository-admin prerequisites. */
export function assertProtectedWindowsReleaseCiEnvironment({ env = process.env, platform = process.platform } = {}) {
  const releaseRef = env.GAMEBUDDY_RELEASE_REF ?? env.GITHUB_REF;
  if (platform !== "win32" || env.GITHUB_ACTIONS !== "true" || env.RUNNER_OS !== "Windows" || env.RUNNER_ARCH !== "X64"
    || !/^(?:[1-9]\d*)$/.test(env.GITHUB_RUN_ID ?? "") || !/^(?:[1-9]\d*)$/.test(env.GITHUB_RUN_ATTEMPT ?? "")
    || env.GITHUB_WORKFLOW !== protectedReleaseWorkflow || env.GAMEBUDDY_RELEASE_ENVIRONMENT !== protectedReleaseEnvironment
    || !["push", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME) || !protectedTagRef.test(releaseRef ?? ""))
    throw new Error("protected_windows_release_ci_required");
}

async function privateScratchRoot() {
  if (process.platform === "win32") {
    // Identity checks bound this admission and the immediately preceding cleanup
    // action only; they do not claim a permanent lock against later pathname races.
    const scratch = await createWindowsReleaseBootstrapScratch();
    return Object.freeze({ root: scratch.root, dispose: scratch.close });
  }
  const parent = resolve(tmpdir());
  const state = await lstat(parent);
  if (state.isSymbolicLink() || !state.isDirectory()) throw new Error("runtime_acquisition_scratch_parent_unsafe");
  const root = await mkdtemp(resolve(parent, "gamebuddy-node-release-"));
  const rootState = await lstat(root);
  if (rootState.isSymbolicLink() || !rootState.isDirectory()) {
    await rm(root, { recursive: true, force: true });
    throw new Error("runtime_acquisition_scratch_root_unsafe");
  }
  return Object.freeze({ root, dispose: async () => await rm(root, { recursive: true, force: true }) });
}
async function acquire({ descriptor, bytes, cleanup = rm, scratchRoot = privateScratchRoot }) {
  if (!exactDescriptor(descriptor) || !Buffer.isBuffer(bytes) || bytes.length > MAX_ARCHIVE_BYTES) throw new Error("invalid_pinned_runtime_acquisition");
  if (sha256(bytes) !== descriptor.archiveSha256) throw new Error("pinned_runtime_digest_mismatch");
  const scratch = await scratchRoot();
  if (scratch === null || typeof scratch !== "object" || typeof scratch.root !== "string" || typeof scratch.dispose !== "function") throw new Error("runtime_acquisition_scratch_root_unsafe");
  const acquisitionRoot = scratch.root; const state = { acquisitionRoot, cleanup, scratchDispose: scratch.dispose, disposed: false };
  // Disposal is one terminal attempt. A failed cleanup must reject the release,
  // not trigger a second mutation attempt through an outer finally block.
  state.dispose = async () => {
    if (state.disposed) return;
    state.disposed = true;
    try { await state.scratchDispose(); await state.cleanup(state.acquisitionRoot, { recursive: true, force: true }); }
    catch { throw new Error("runtime_acquisition_cleanup_failed"); }
  };
  try { await writeFile(resolve(acquisitionRoot, "archive.zip"), bytes, { flag: "wx" }); Object.assign(state, await extract(bytes, descriptor, acquisitionRoot), { descriptor: Object.freeze({ ...descriptor }) }); return state; } catch (error) { try { await state.dispose(); } catch { throw new Error("runtime_acquisition_cleanup_failed"); } throw error; }
}

async function downloadReleaseArchive(descriptor, fetchRelease) {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetchRelease(descriptor.sourceUrl, { redirect: "error", signal: controller.signal });
    const length = response?.headers?.get?.("content-length");
    if (response === null || typeof response !== "object" || !response.ok || response.redirected
      || typeof response.url !== "string" || new URL(response.url).origin !== "https://nodejs.org"
      || !response.body?.[Symbol.asyncIterator]) throw new Error("pinned_runtime_download_failed");
    if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > MAX_ARCHIVE_BYTES))
      throw new Error("pinned_runtime_download_failed");
    const chunks = []; let total = 0;
    for await (const chunk of response.body) {
      if (!(Buffer.isBuffer(chunk) || chunk instanceof Uint8Array)) throw new Error("pinned_runtime_download_failed");
      const value = Buffer.from(chunk);
      total += value.length;
      if (total > MAX_ARCHIVE_BYTES) {
        controller.abort();
        throw new Error("pinned_runtime_download_failed");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    if (error?.message === "pinned_runtime_download_failed") throw error;
    throw new Error("pinned_runtime_download_failed");
  } finally { clearTimeout(deadline); }
}
async function withAcquiredReleaseRuntime({ descriptor, bytes, cleanup = rm, scratchRoot = privateScratchRoot, afterAcquisition }, callback) {
  const state = await acquire({ descriptor, bytes, cleanup, scratchRoot });
  try {
    await afterAcquisition?.(Object.freeze({ extractedRoot: state.extractedRoot }));
    return await callback(state);
  } finally {
    // The fixed-runtime provider may already have disposed an unconsumed or
    // publisher-consumed state. `dispose()` is one terminal operation, so this
    // closes every acquired state without issuing a second cleanup mutation.
    await state.dispose();
  }
}

let fixedReleaseRuntime;
let fixedReleaseRuntimeConsumed = false;

// This is deliberately the only composition that installs release runtime
// state. The acquired object never crosses an exported parameter boundary.
async function composeFixedReleaseRuntimeBuild(state, build) {
  if (fixedReleaseRuntime !== undefined || typeof build !== "function") throw new Error("invalid_release_runtime_composition");
  fixedReleaseRuntime = state;
  fixedReleaseRuntimeConsumed = false;
  try { return await build(); }
  finally {
    const consumed = fixedReleaseRuntimeConsumed;
    fixedReleaseRuntime = undefined;
    fixedReleaseRuntimeConsumed = false;
    if (!consumed) await state.dispose();
  }
}

/** Internal no-input consumption point. It cannot be used to supply a runtime. */
export function takeComposedFixedReleaseRuntimeForPublisher() {
  if (fixedReleaseRuntime === undefined || fixedReleaseRuntimeConsumed)
    throw new Error("verified_bundled_runtime_input_required");
  fixedReleaseRuntimeConsumed = true;
  return fixedReleaseRuntime;
}

async function acquireReleaseRuntimePublisher({ descriptor, fetchRelease, afterAcquisition, scratchRoot = privateScratchRoot }, build) {
  if (typeof build !== "function" || typeof fetchRelease !== "function") throw new Error("invalid_release_runtime_composition");
  const bytes = await downloadReleaseArchive(descriptor, fetchRelease);
  const state = await acquire({ descriptor, bytes, scratchRoot });
  try {
    await afterAcquisition?.(Object.freeze({ extractedRoot: state.extractedRoot }));
    return await composeFixedReleaseRuntimeBuild(state, build);
  } finally {
    // `dispose()` is terminal and idempotent, so it closes an unconsumed state
    // without creating a second cleanup mutation after publisher consumption.
    await state.dispose();
  }
}

/** Fixed, no-argument production release lane. */
export async function publishFixedReleaseProductionArtifact() {
  assertProtectedWindowsReleaseCiEnvironment();
  const { readArtifactConfig } = await import("./production-artifact.mjs"); const { buildFixedReleaseProductionArtifact } = await import("./build-production-artifact.mjs"); const hostRoot = resolve(new URL("..", import.meta.url).pathname);
  const descriptor = (await readArtifactConfig(hostRoot)).bundledRuntime;
  return acquireReleaseRuntimePublisher({ descriptor, fetchRelease: fetch }, async () => buildFixedReleaseProductionArtifact());
}

export async function withSyntheticVerifiedReleaseBundledRuntimeForTest({ descriptor, zipBytes, cleanupForTest, scratchRootForTest, afterAcquisitionForTest }, callback) {
  if (typeof callback !== "function" || (scratchRootForTest !== undefined && typeof scratchRootForTest !== "function")
    || (afterAcquisitionForTest !== undefined && typeof afterAcquisitionForTest !== "function")) throw new Error("invalid_runtime_test_acquisition");
  const scratchRoot = scratchRootForTest ?? (async () => {
    const root = await mkdtemp(resolve(tmpdir(), "gamebuddy-node-release-test-"));
    return Object.freeze({ root, dispose: async () => {} });
  });
  return await withAcquiredReleaseRuntime({
    descriptor,
    bytes: zipBytes,
    cleanup: cleanupForTest ?? rm,
    scratchRoot,
    afterAcquisition: afterAcquisitionForTest,
  }, async (state) => await callback(Object.freeze({
    extractedRoot: state.extractedRoot,
    files: Object.freeze(state.files.map((entry) => Object.freeze({ ...entry }))),
    descriptor: state.descriptor,
  })));
}
