import { appendFile, copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

/**
 * Live-run capture: one local directory per run, holding everything the harness
 * can observe about that run.
 *
 * WHY this exists (2026-10 audit): the live runners only recorded *structural*
 * facts (hashes, ids, counts, receipts). A defect in the CONTENT of what the
 * model received — an empty default persona, an unrendered `{{char}}` macro —
 * was invisible to every gate and to every reviewer, because the artifact never
 * contained content. The evidence was already on disk in the run's runtime root
 * (`identity-profile.json`, `context.db`, session logs, run manifests); the
 * harness simply never collected it.
 *
 * The live-run loop is an external harness, NOT the Host product. The Host
 * boundary (architecture 1.1: Host must not write m[1], must not assemble
 * prompts, must not become a second authority) constrains the *product runtime*.
 * It does not license an observation tool to blindfold itself. This module
 * therefore collects what the harness can legitimately read, into a local
 * directory that is ignored by git and never shared.
 *
 * Two disciplines are enforced structurally:
 *
 * 1. NEVER throw. Capture is diagnostic: a failed copy must not fail a real
 *    live run. Every failure is recorded on `handle.failures` instead, so the
 *    runner can surface it in the run result — a silently-broken capture would
 *    recreate exactly the blind spot this module exists to remove.
 * 2. BOUNDED. Every copy is charged against a byte/file budget; a runaway
 *    runtime root cannot fill the disk. Truncation is recorded, never silent.
 */

export const LIVE_RUN_ROOT_ENV = "GAMEBUDDY_LIVE_RUN_ROOT";

/** Default root for local run directories: repo-local, git-ignored. */
export const DEFAULT_LIVE_RUN_ROOT = ".live-runs";

const DEFAULT_BUDGET = Object.freeze({ maxBytes: 256 * 1024 * 1024, maxFiles: 4000 });

/** Evidence files inside a continuity runtime root worth keeping for review. */
const RUNTIME_ROOT_EVIDENCE = [
  /^contexts\/[^/]+\/identity-profile\.json$/,
  /^contexts\/[^/]+\/worldbook\.json$/,
  /^contexts\/[^/]+\/data\/cortexkit\/magic-context\/context\.db(-wal|-shm)?$/,
  /^contexts\/[^/]+\/data\/cortexkit\/magic-context\/magic-context\.log$/,
  /^contexts\/[^/]+\/surface-sessions\/[^/]+\/companion-run-manifest\.json$/,
  /^contexts\/[^/]+\/surface-sessions\/[^/]+\/identity-profile-binding\.json$/,
  /^contexts\/[^/]+\/surface-sessions\/[^/]+\/sessions\/.+\.jsonl$/,
  /^contexts\/[^/]+\/\.cortexkit\/magic-context\.jsonc$/,
];

const NEVER_DESCEND = new Set(["node_modules", ".git", "dist", "dist-test"]);

function toPosix(value) {
  return value.split(sep).join("/");
}

/**
 * Where local run directories live. `GAMEBUDDY_LIVE_RUN_ROOT` overrides so a
 * caller can point at a scratch drive; otherwise `<repoRoot>/.live-runs`.
 */
export function resolveLiveRunRoot({ repoRoot, env = process.env } = {}) {
  const configured = env?.[LIVE_RUN_ROOT_ENV];
  if (typeof configured === "string" && configured.length > 0) return resolve(configured);
  if (typeof repoRoot !== "string" || repoRoot.length === 0) return resolve(DEFAULT_LIVE_RUN_ROOT);
  return join(resolve(repoRoot), DEFAULT_LIVE_RUN_ROOT);
}

function runDirectoryName(kind, label) {
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const suffix = typeof label === "string" && label.length > 0 ? `-${label.replace(/[^\w.-]+/gu, "_")}` : "";
  return `${stamp}${suffix}`;
}

/**
 * Open one run directory. Returns a handle whose every method is
 * failure-tolerant and budget-charged.
 */
export async function openLiveRunCapture({ kind, label, root, budget } = {}) {
  if (typeof kind !== "string" || kind.length === 0) throw new Error("capture_kind_required");
  const base = root ?? resolveLiveRunRoot({ repoRoot: process.cwd() });
  const limits = Object.freeze({ ...DEFAULT_BUDGET, ...(budget ?? {}) });
  const dir = join(base, kind, runDirectoryName(kind, label));

  const failures = [];
  const skipped = [];
  let bytesWritten = 0;
  let filesWritten = 0;

  const charge = (size) => {
    // Returns "ok" | "max_files" | "max_bytes"; the CALLER records the
    // specific skip reason so it can stay precise (audit MEDIUM-1: append and
    // record get their own reasons instead of a duplicated generic one).
    if (filesWritten + 1 > limits.maxFiles) return "max_files";
    if (bytesWritten + size > limits.maxBytes) return "max_bytes";
    bytesWritten += size;
    filesWritten += 1;
    return "ok";
  };

  let opened = true;
  try {
    await mkdir(dir, { recursive: true });
  } catch (error) {
    opened = false;
    failures.push({ op: "mkdir", path: dir, error: String(error?.message ?? error) });
  }

  /** JSON record (an observation, not a copy). Small and usually kept; still
   * charged so a runaway caller cannot exceed the budget through records. */
  async function record(name, value) {
    const path = join(dir, name);
    try {
      await mkdir(join(path, ".."), { recursive: true });
      const text = `${JSON.stringify(value, null, 2)}\n`;
      const size = Buffer.byteLength(text);
      const outcome = charge(size);
      if (outcome !== "ok") {
        skipped.push({ reason: "max_bytes_record", name });
        return undefined;
      }
      await writeFile(path, text, "utf8");
      return path;
    } catch (error) {
      // Roll back the charge on a failed write so filesWritten/bytesWritten stay
      // the honest counts of files actually on disk (audit NOTE-2).
      bytesWritten -= size;
      filesWritten -= 1;
      failures.push({ op: "record", path, error: String(error?.message ?? error) });
      return undefined;
    }
  }

  /** Append text (child stdout/stderr, harness narration). BUDGETED like every
   * other write (audit MEDIUM-1): the memory-loop stderr feed must not be able
   * to grow without bound behind the shared byte budget. */
  async function append(name, text) {
    if (typeof text !== "string" || text.length === 0) return;
    const path = join(dir, name);
    const size = Buffer.byteLength(text);
    const outcome = charge(size);
    if (outcome !== "ok") {
      skipped.push({ reason: "max_bytes_append", name });
      return;
    }
    try {
      await mkdir(join(path, ".."), { recursive: true });
      await appendFile(path, text, "utf8");
    } catch (error) {
      // Roll back the charge: an append that failed never hit disk.
      bytesWritten -= size;
      filesWritten -= 1;
      failures.push({ op: "append", path, error: String(error?.message ?? error) });
    }
  }

  /** Copy one file if it fits the budget; a missing file is a recorded miss.
   * A failed copy ROLLS BACK its charge so filesWritten/bytesWritten stay the
   * honest counts of what actually reached disk (audit NOTE-2). */
  async function copyFileInto(sourcePath, destRel, { required = false } = {}) {
    let size = 0;
    try {
      size = (await stat(sourcePath)).size;
    } catch (error) {
      if (required) failures.push({ op: "stat", path: sourcePath, error: String(error?.message ?? error) });
      return false;
    }
    const outcome = charge(size);
    if (outcome !== "ok") {
      skipped.push({ reason: outcome, size, ...(typeof destRel === "string" ? { path: destRel } : {}) });
      return false;
    }
    const dest = join(dir, destRel);
    try {
      await mkdir(join(dest, ".."), { recursive: true });
      await copyFile(sourcePath, dest);
      return true;
    } catch (error) {
      bytesWritten -= size;
      filesWritten -= 1;
      failures.push({ op: "copy", path: sourcePath, dest, error: String(error?.message ?? error) });
      return false;
    }
  }

  /**
   * Copy a tree, keeping only paths accepted by `include`. Symlinked or
   * unreadable entries are recorded and skipped, never fatal.
   */
  async function copyTree(sourceDir, { include, destPrefix = "" } = {}) {
    const accept = typeof include === "function" ? include : () => true;
    async function walk(current) {
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch (error) {
        failures.push({ op: "readdir", path: current, error: String(error?.message ?? error) });
        return;
      }
      for (const entry of entries) {
        if (NEVER_DESCEND.has(entry.name)) continue;
        const absolute = join(current, entry.name);
        const rel = toPosix(relative(sourceDir, absolute));
        if (entry.isDirectory()) {
          await walk(absolute);
          continue;
        }
        // Symlinks are recorded as skipped (audit NOTE-3) rather than silently
        // disappearing: a linked evidence file that capture refuses to follow is
        // an observable decision, not an invisible hole.
        if (!entry.isFile()) {
          if (entry.isSymbolicLink()) skipped.push({ reason: "symlink", path: rel });
          continue;
        }
        if (!accept(rel)) continue;
        await copyFileInto(absolute, destPrefix.length > 0 ? `${destPrefix}/${rel}` : rel);
      }
    }
    await walk(sourceDir);
  }

  /**
   * The preset every Game/Chat/Memory run should keep: the continuity runtime
   * root's own evidence (profile, world book, MC database + log, run manifest,
   * session logs). Reading these is what makes content defects visible.
   */
  async function captureRuntimeRoot(runtimeRoot, { destPrefix = "runtime-root" } = {}) {
    if (typeof runtimeRoot !== "string" || runtimeRoot.length === 0) {
      failures.push({ op: "capture_runtime_root", error: "runtime_root_required" });
      return;
    }
    await copyTree(runtimeRoot, {
      include: (rel) => RUNTIME_ROOT_EVIDENCE.some((pattern) => pattern.test(rel)),
      destPrefix,
    });
  }

  async function close() {
    if (!opened) return { dir, failures, skipped, bytesWritten, filesWritten };
    // The numbers INSIDE the summary describe everything captured BEFORE the
    // summary line; the returned totals include it. Recording the pre-summary
    // counts keeps the summary honest about what it is summarising.
    await record("capture-summary.json", {
      schema: "gamebuddy_live_run_capture/v1",
      kind,
      dir,
      bytesWritten,
      filesWritten,
      skipped,
      failures,
    });
    return { dir, failures, skipped, bytesWritten, filesWritten };
  }

  return Object.freeze({
    dir,
    record,
    append,
    copyFileInto,
    copyTree,
    captureRuntimeRoot,
    close,
    /** Live view: a runner may read this before close() for its result JSON. */
    get failures() {
      return [...failures];
    },
    get skipped() {
      return [...skipped];
    },
  });
}
