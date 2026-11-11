import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Shared plumbing for the two dynamic data-shape stress suites.
 *
 * The suites drive the REAL product: the compiled Host from `host/dist-test`.
 * Nothing here is stubbed. Every helper either loads a product module, builds a
 * disposable identity root, or turns a thrown bounded error into a reported row.
 */

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const HOST_ROOT = join(REPOSITORY_ROOT, "host");
const TEST_OUTPUT_ROOT = join(HOST_ROOT, "dist-test");

/**
 * Loads one emitted Host module from the compiled test artifact. The suites
 * import only modules the Host build emits; a missing artifact is a build
 * problem, not a product finding, and fails loudly with the path.
 */
export async function loadHost(module) {
  if (typeof module !== "string" || !/^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.js$/.test(module))
    throw new Error(`stress_harness_invalid_module:${module}`);
  const modulePath = resolve(TEST_OUTPUT_ROOT, module);
  if (!existsSync(modulePath)) throw new Error(`stress_harness_module_absent:${modulePath}`);
  return await import(pathToFileURL(modulePath).href);
}

let hostBound = false;
/**
 * Binds the one Windows stale-lock reclaimer the product's `withPathLock`
 * requires. Without it every real artifact write refuses at release with
 * `windows_reclaimer_unavailable` - a harness setup fact, not a product defect,
 * so it is bound once before any store is touched.
 */
export async function bindHostRuntime() {
  if (hostBound) return;
  const { bindWindowsStaleLockReclaimer } = await loadHost("path-lock.js");
  const { createBuildWindowsStaleLockReclaimer } = await loadHost("windows-stale-lock-reclaimer/index.js");
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
  hostBound = true;
}

/** A disposable identity root beneath a canonical user-owned parent. */
export async function freshRoot(prefix) {
  const parent = process.platform === "win32" ? process.env.LOCALAPPDATA : tmpdir();
  if (typeof parent !== "string" || parent.length === 0) throw new Error("test_local_app_data_unavailable");
  return await mkdtemp(join(await realpath(parent), prefix));
}

/** Releases a root after its SQLite connections are closed; retries the Windows rename race. */
export async function releaseRoot(root, closers = []) {
  for (const close of closers) {
    try {
      close?.();
    } catch {
      // A store that never opened has nothing to release.
    }
  }
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
}

export function identity(playerId, companionId, continuityId) {
  return Object.freeze({ playerId, companionId, continuityId });
}

/**
 * The per-identity roots a suite needs. `runtimeCwd` is where the product puts
 * the companion's own `worldbook.json`; the suites write it there exactly as
 * provisioning does.
 */
export function runtimePaths(root, id) {
  return {
    root,
    runtimeCwd: root,
    agentDir: join(root, "agent"),
    sessionDir: join(root, "sessions"),
    identityProfilePath: join(root, "identity-profile.json"),
    identityProfileBindingPath: join(root, "identity-profile-binding.json"),
    runManifestPath: join(root, "run-manifest.json"),
  };
}

/**
 * Builds the real service graph for one identity: the artifact store, the
 * thread store, the library service and the import service. These are the exact
 * objects the Host wires; the suites call them from here.
 */
export async function openServices(root, id) {
  const [
    { TavernArtifactStore },
    { createChatThreadStore },
    { createTavernLibraryService },
    { StCardImportService },
    { resolveTavernPaths },
  ] = await Promise.all([
    loadHost("tavern/artifact-store.js"),
    loadHost("tavern/chat-thread-store.js"),
    loadHost("tavern/library-service.js"),
    loadHost("tavern/st-card-import-service.js"),
    loadHost("tavern/tavern-paths.js"),
  ]);
  const paths = resolveTavernPaths(runtimePaths(root, id), id);
  const artifacts = new TavernArtifactStore(root);
  const threads = createChatThreadStore(root, id.continuityId);
  const service = createTavernLibraryService(paths, artifacts, threads, {
    async readExact() {
      return { profileId: `profile-${id.companionId}`, revision: 1, canonicalHash: "a".repeat(64) };
    },
  });
  const importer = new StCardImportService(artifacts, paths);
  return {
    paths,
    artifacts,
    threads,
    service,
    importer,
    close: () => threads.close?.(),
    modules: { resolveTavernPaths },
  };
}

/** Writes the companion's own durable world book the way provisioning does. */
export async function writeCompanionWorldBook(runtimeCwd, book) {
  const { writeWorldBook, validateWorldBook } = await loadHost("worldbook.js");
  await mkdir(runtimeCwd, { recursive: true });
  const validated = validateWorldBook(book);
  await writeWorldBook(join(runtimeCwd, "worldbook.json"), validated);
  return validated;
}

/** Reads the companion's own durable world book back from disk. */
export async function readCompanionWorldBook(runtimeCwd) {
  const { readWorldBook } = await loadHost("worldbook.js");
  const path = join(runtimeCwd, "worldbook.json");
  if (!existsSync(path)) return null;
  return await readWorldBook(path);
}

/** Writes an identity profile the way both provisioning paths do. */
export async function writeProfile(profilePath, profile) {
  const { writeIdentityProfile } = await loadHost("identity-profile.js");
  await mkdir(dirname(profilePath), { recursive: true });
  await writeIdentityProfile(profilePath, profile, { containmentRoot: dirname(dirname(profilePath)) });
}

/** sha256 hex of a string, matching the product's own hash vocabulary. */
export function hash(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function utf8Bytes(value) {
  return Buffer.byteLength(value, "utf8");
}

/** The vendor Memory CRUD facade the Host's Memory management service wraps. */
export async function loadMemoryFacade() {
  const entry = join(HOST_ROOT, "node_modules", "@cortexkit", "pi-magic-context", "dist", "memory", "index.js");
  if (!existsSync(entry)) throw new Error("stress_harness_memory_facade_absent");
  const module = await import(pathToFileURL(entry).href);
  if (typeof module.createGameBuddyPlayerMemoryCrudFacade !== "function")
    throw new Error("stress_harness_memory_facade_invalid");
  return module.createGameBuddyPlayerMemoryCrudFacade;
}

/**
 * Expands the product's own macro subset with the exact replacement table the
 * Host uses, so the suites can assert on the rendered prompt without a second
 * macro implementation.
 */
export async function macroTableFor(char, locale = "zh-CN") {
  const { macroTable } = await loadHost("tavern/macro-engine.js");
  return macroTable({ char, locale });
}

export async function expandMacros(text, table) {
  const { renderMacros } = await loadHost("tavern/macro-engine.js");
  return renderMacros(text, table);
}

/** Every `{{...}}` occurrence in a string, with its key, in source order. */
const MACRO_PATTERN = /\{\{[^{}]*\}\}/gu;
export function findUnrenderedMacros(text) {
  if (typeof text !== "string") return [];
  return [...text.matchAll(MACRO_PATTERN)].map((match) => match[0]);
}

/**
 * Walks every string reachable from a JSON value, invoking `visit(path, text)`.
 * The path is a stable dotted/bracketed locator so a finding names the exact
 * field that broke rather than "the card".
 */
export function walkStrings(value, visit, path = "$") {
  if (typeof value === "string") {
    visit(path, value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkStrings(item, visit, `${path}[${index}]`));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) walkStrings(item, visit, `${path}.${key}`);
  }
}

/**
 * A structural deep compare of two JSON values.
 *
 * It reports path-qualified differences rather than a boolean: the card round
 * trip must prove `extensions.gamebuddy.stardew` is field-for-field identical,
 * and "present" would not catch a nested value washed away. Absent stays absent
 * (a missing key is a difference from `{}`), because a value the export invented
 * is a defect the same way a dropped one is.
 */
export function deepDiff(left, right, path = "$", out = []) {
  if (left === right) return out;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) {
      out.push({ path, left: shortSummary(left), right: shortSummary(right), kind: "type" });
      return out;
    }
    if (left.length !== right.length)
      out.push({ path, left: `len=${left.length}`, right: `len=${right.length}`, kind: "length" });
    const max = Math.max(left.length, right.length);
    for (let index = 0; index < max; index += 1)
      deepDiff(left[index] ?? undefined, right[index] ?? undefined, `${path}[${index}]`, out);
    return out;
  }
  if (left !== null && right !== null && typeof left === "object" && typeof right === "object") {
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of [...keys].sort()) {
      if (!(key in left)) {
        out.push({ path: `${path}.${key}`, left: undefined, right: shortSummary(right[key]), kind: "invented" });
        continue;
      }
      if (!(key in right)) {
        out.push({ path: `${path}.${key}`, left: shortSummary(left[key]), right: undefined, kind: "lost" });
        continue;
      }
      deepDiff(left[key], right[key], `${path}.${key}`, out);
    }
    return out;
  }
  out.push({ path, left: shortSummary(left), right: shortSummary(right), kind: "value" });
  return out;
}

function shortSummary(value) {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value.length > 80 ? `${value.slice(0, 40)}…(${value.length})` : value;
  try {
    const json = JSON.stringify(value);
    return json !== undefined && json.length > 80 ? `${json.slice(0, 60)}…` : json;
  } catch {
    return String(value);
  }
}

/**
 * One reported row. `status` is `pass` only when nothing was dropped, invented,
 * truncated or refused unexpectedly. `detail` carries the RAW bounded code /
 * status the product returned, never a friendly rewrite.
 */
export function row(spec) {
  return Object.freeze({
    case: spec.case,
    dimension: spec.dimension,
    created: spec.created ?? "",
    read: spec.read ?? "",
    turn: spec.turn ?? "",
    status: spec.status ?? "pass",
    flags: Object.freeze(spec.flags ?? []),
    detail: spec.detail ?? "",
  });
}

/** Runs one case, capturing any throw as the raw bounded code the product emitted. */
export async function runCase(meta, body) {
  const started = Date.now();
  try {
    const result = await body();
    return row({ ...meta, ...result, status: result.status ?? (result.flags?.length ? "fail" : "pass") });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return row({
      ...meta,
      status: "fail",
      turn: meta.turn ?? "",
      flags: ["threw"],
      detail: `raw=${message}`,
      elapsedMs: Date.now() - started,
    });
  }
}

/**
 * Renders a fixed-width table. Every case prints one row: what was created, what
 * the read returned, whether the turn ran, and what broke.
 */
export function printTable(rows, columns) {
  const header = columns.map((column) => column.label);
  const body = rows.map((item) => columns.map((column) => normalizeCell(column.value(item))));
  const widths = header.map((label, index) =>
    Math.max(label.length, ...body.map((cells) => (cells[index] ?? "").length), 0),
  );
  const line = (cells) => cells.map((cell, index) => cell.padEnd(widths[index])).join("  ");
  const output = [line(header), widths.map((width) => "-".repeat(width)).join("  "), ...body.map(line)];
  process.stdout.write(`${output.join("\n")}\n`);
}

function normalizeCell(value) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/\s+/gu, " ").slice(0, 120);
}

/** Tallies rows into a passed/failed summary and returns the process exit code. */
export function summarize(suite, rows) {
  const failed = rows.filter((item) => item.status === "fail");
  const skipped = rows.filter((item) => item.status === "skip");
  const passed = rows.filter((item) => item.status === "pass");
  process.stdout.write(
    `\n${suite}: ${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped (${rows.length} cases)\n`,
  );
  if (failed.length > 0) {
    process.stdout.write("Findings (ranked by first failure):\n");
    for (const item of failed) process.stdout.write(`  - [${item.dimension}] ${item.case}: ${item.detail}\n`);
  }
  return failed.length === 0 ? 0 : 1;
}
