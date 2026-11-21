import { appendFile, copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { RUN_LAUNCH_FILE, readRunLaunch, writeLaunchReceipt } from "./run-closure.mjs";

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
 * Three disciplines are enforced structurally:
 *
 * 1. NEVER throw. Capture is diagnostic: a failed copy must not fail a real
 *    live run. Every failure is recorded on `handle.failures` instead, so the
 *    runner can surface it in the run result — a silently-broken capture would
 *    recreate exactly the blind spot this module exists to remove.
 * 2. BOUNDED. Every copy is charged against a byte/file budget; a runaway
 *    runtime root cannot fill the disk. Truncation is recorded, never silent.
 * 3. RUN-SCOPED. The run's own artifacts — the surface-session directory it opened and the rendered
 *    environment record — are copied FIRST and are never refused; the budget applies only to what remains.
 *    A shared runtime root holds every earlier run's session directory (100+ of them on 2026-11-21), so a
 *    budget charged in walk order spent itself on other runs' logs and skipped the subject of the report:
 *    `round88`'s bundle kept a 13-38-33 session from an earlier run, and `round-verdict` then priced that
 *    run's turns as this one's. A cap that can starve the subject of the report is not a cap.
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
  // What the provider RENDERED into each assembled request (`createRenderedEnvironmentFactsProvider`,
  // `host/src/runtime-core.internal.ts`). `<runtime-environment>` exists only inside a request, so without
  // this file a run's artifact cannot answer a prompt-level question at all - measured on round18: `位置:`,
  // `脚下` and `待浇水` appeared zero times in the session. Both layouts are listed because a runtime may
  // mount with or without a surface session id, which decides the directory this record lives in.
  /^contexts\/[^/]+\/surface-sessions\/[^/]+\/environment-facts\.jsonl$/,
  /^contexts\/[^/]+\/environment-facts\.jsonl$/,
  /^contexts\/[^/]+\/surface-sessions\/[^/]+\/sessions\/.+\.jsonl$/,
  /^contexts\/[^/]+\/\.cortexkit\/magic-context\.jsonc$/,
];

const NEVER_DESCEND = new Set(["node_modules", ".git", "dist", "dist-test"]);

/** The product's directory for one surface session under a context (`resolveRuntimePaths`, `host/src/runtime-identity.ts`). */
const SURFACE_SESSIONS_DIR = "surface-sessions";

/**
 * The instant a session RECORD's own name states: `2026-11-21T17-48-50-387Z_<sessionId>.jsonl`.
 *
 * The runtime opens each Pi session under exactly that name, so it is the one timestamp a record carries in its
 * name - which is what lets a reader bind a record to the run that opened it, and it is why the newest or the largest
 * file under a shared root is not that binding.
 */
const SESSION_RECORD_STAMP = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/u;

function sessionRecordStartedAtMs(name) {
  const match = SESSION_RECORD_STAMP.exec(name);
  if (match === null) return null;
  const parsed = Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

function toPosix(value) {
  return value.split(sep).join("/");
}

/** Names of the entries in one directory, sorted, or none when it cannot be read (a missing root is not a failure). */
async function childNames(path, { files = false } = {}) {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => (files ? entry.isFile() : entry.isDirectory()))
    .map((entry) => entry.name)
    .sort();
}

async function sizeOfFile(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

/**
 * Every surface-session directory under a runtime root, with the evidence files and session records it holds.
 *
 * The walk is bounded to the layout the product writes (`contexts/<identity>/surface-sessions/<surfaceSessionId>/`,
 * records under `sessions/`), rather than a recursive sweep: the questions asked here are about WHICH session
 * directory a run opened, and an unbounded sweep of a shared root full of historical runs answers that question with
 * the newest file instead of with this run's.
 */
async function surveySurfaceSessions(runtimeRoot, include) {
  const directories = [];
  const environmentFacts = [];
  const contextsDir = join(runtimeRoot, "contexts");
  for (const context of await childNames(contextsDir)) {
    // The rendered environment record of a mount that carries no surface session id lives directly under the context
    // (`host/src/runtime-core.internal.ts`), one file per context: this run's, never a historical one.
    const renderedRel = `contexts/${context}/environment-facts.jsonl`;
    if (include(renderedRel) && (await sizeOfFile(join(runtimeRoot, renderedRel))) !== null) {
      environmentFacts.push(renderedRel);
    }
    for (const surface of await childNames(join(contextsDir, context, SURFACE_SESSIONS_DIR))) {
      const surfaceRel = `contexts/${context}/${SURFACE_SESSIONS_DIR}/${surface}`;
      const surfaceDir = join(runtimeRoot, surfaceRel);
      const files = [
        ...(await childNames(surfaceDir, { files: true })).map((name) => `${surfaceRel}/${name}`),
        ...(await childNames(join(surfaceDir, "sessions"), { files: true })).map(
          (name) => `${surfaceRel}/sessions/${name}`,
        ),
      ].filter(include);
      const records = [];
      for (const rel of files) {
        const atMs = sessionRecordStartedAtMs(rel.split("/").at(-1));
        if (atMs === null) continue;
        records.push(Object.freeze({ rel, atMs, bytes: await sizeOfFile(join(runtimeRoot, rel)) }));
      }
      directories.push(
        Object.freeze({
          rel: surfaceRel,
          files,
          records,
          openedAtMs: records.length === 0 ? null : Math.min(...records.map((record) => record.atMs)),
        }),
      );
    }
  }
  return { directories, environmentFacts };
}

/**
 * Which surface-session directory THIS run opened, and every session record the root holds besides it.
 *
 * The runtime names the directory `game-<Date.now()>` and the record inside it `<utc>_<sessionId>.jsonl`, and both are
 * created AFTER the run was armed - so this run's directory is the one whose FIRST record was opened at or after the
 * instant its launch receipt states, and the earliest such directory is the activation this launch wrote.
 *
 * MEASURED 2026-11-21 (`round88`): the bundle copied 309 files / 266.8 MB against a shared root, then hit the byte cap
 * before it reached this run's own 4 843 990-byte record, and `round-verdict` read a leftover `13-38-33` session from an
 * earlier run instead - so every model-time and turn number in that verdict belonged to another run. "Newest under the
 * root" is the same defect one step later (2026-10-22: two runs 38 minutes apart published one foreign record as each
 * run's own).
 *
 * A run whose launch instant cannot be read (`unbound`) is a THIRD reading, not `none`: nothing can be asked of it, and
 * the summary says which of the two stopped the reader.
 */
async function bindRunSession(runtimeRoot, { launchedAtMs = null, include } = {}) {
  if (!Number.isFinite(launchedAtMs)) {
    return Object.freeze({
      state: "unbound",
      reason: "no_launch_instant",
      launchedAtMs: null,
      directory: null,
      startedAtMs: null,
      environmentFacts: [],
      ownedFiles: [],
      records: [],
      foreignRecords: [],
    });
  }
  const survey = await surveySurfaceSessions(runtimeRoot, include);
  const candidates = survey.directories
    .filter((directory) => directory.openedAtMs !== null && directory.openedAtMs >= launchedAtMs)
    .sort((left, right) => left.openedAtMs - right.openedAtMs || left.rel.localeCompare(right.rel));
  const bound = candidates[0] ?? null;
  return Object.freeze({
    // `none` and `unbound` are different readings and neither is "here is your session": a run that opened no session
    // of its own has none, and a run whose launch instant cannot be read cannot be asked the question at all.
    state: bound === null ? "none" : "bound",
    reason: bound === null ? "no_session_record_at_or_after_the_run_start" : null,
    launchedAtMs,
    directory: bound === null ? null : bound.rel,
    startedAtMs: bound === null ? null : bound.openedAtMs,
    environmentFacts: survey.environmentFacts,
    ownedFiles: bound === null ? [] : bound.files,
    records: bound === null ? [] : bound.records,
    foreignRecords: survey.directories
      .filter((directory) => directory !== bound)
      .flatMap((directory) => directory.records),
  });
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

export function runDirectoryName(kind, label) {
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const suffix = typeof label === "string" && label.length > 0 ? `-${label.replace(/[^\w.-]+/gu, "_")}` : "";
  return `${stamp}${suffix}`;
}

/**
 * Open one run directory. Returns a handle whose every method is
 * failure-tolerant and budget-charged.
 */
export async function openLiveRunCapture({ kind, label, root, budget, dirName, dir: explicitDir } = {}) {
  if (typeof kind !== "string" || kind.length === 0) throw new Error("capture_kind_required");
  const base = root ?? resolveLiveRunRoot({ repoRoot: process.cwd() });
  const limits = Object.freeze({ ...DEFAULT_BUDGET, ...(budget ?? {}) });
  // `dirName` lets a surface whose runs are identified by their own opaque run id
  // address the run directory directly (`.live-runs/<run-id>/`), so one directory
  // can hold everything about that run: the trace, the content sidecar, the
  // browser shots and the captured runtime-root evidence. Without it the shared
  // `<kind>/<timestamp>-<label>` layout is used, unchanged.
  const dir =
    typeof explicitDir === "string" && explicitDir.length > 0
      ? // THE CALLER OWNS THE DIRECTORY. A run whose dir was allocated by the process that outlives it (the ladder
        // launcher, which writes the launch receipt and the closure record there) is addressed directly. The name is then
        // the launcher's fact and is not re-derived here.
        explicitDir
      : typeof dirName === "string" && dirName.length > 0
        ? join(base, dirName.replace(/[^\w.-]+/gu, "_"))
        : join(base, kind, runDirectoryName(kind, label));

  const failures = [];
  const skipped = [];
  let bytesWritten = 0;
  let filesWritten = 0;
  // What the run-scoped pass found out about this run's own session, named in the summary. `null` until a runtime root
  // is captured: a run that never captured one is `not_attempted`, which is a third reading and not "no session".
  let runSession = null;

  const charge = (size, { exempt = false } = {}) => {
    // Returns "ok" | "over_cap", and the CALLER records the path and size it refused, so a bundle that dropped evidence
    // names it (`skipped`). An `exempt` copy is the run's own artifact: it is charged, so the totals stay honest, and it
    // is never refused, because a cap that can starve the subject of the report is not a cap.
    if (!exempt) {
      if (filesWritten + 1 > limits.maxFiles) return "over_cap";
      if (bytesWritten + size > limits.maxBytes) return "over_cap";
    }
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

  // A LAUNCH RECEIPT, written the moment the run directory exists.
  //
  // Measured 2026-10-17/18 (night audit): 7 of 36 run directories were EMPTY and 10 had no `manifest.json`, because
  // every record was written at CLOSE - so a run killed before its interesting moment left no evidence that it had
  // ever been armed, and "the run failed" was indistinguishable on disk from "the run never started". The receipt
  // is deliberately tiny and outside the charge budget: its value is highest exactly when nothing else got written.
  // FIRST WRITER WINS. A receipt already in the directory was written by a process that outlives this one (the ladder
  // launcher, which allocates the run directory before it spawns anything and writes its own pid), and its closing record is
  // matched to that pid. Overwriting it with the child's pid would name a process that is dead by the time anybody asks how
  // the run ended - which is the one fact this file exists to carry. Surfaces with no launcher (Chat, the frontend
  // captures) find no receipt here and get one, exactly as before.
  if (opened) {
    try {
      // ONE SPELLING of the receipt (`run-closure.mjs`), and it writes only when the directory does not already carry one.
      writeLaunchReceipt({ dir, kind, label });
    } catch (error) {
      failures.push({ op: "write", path: join(dir, RUN_LAUNCH_FILE), error: String(error?.message ?? error) });
    }
  }

  /** JSON record (an observation, not a copy). Small and usually kept; still
   * charged so a runaway caller cannot exceed the budget through records.
   *
   * `exempt` is for the ONE record that must survive the budget it reports: the capture summary. For the same reason the
   * launch receipt sits outside it, the account of what was capped cannot be something the cap itself suppresses.
   */
  async function record(name, value, { exempt = false } = {}) {
    const path = join(dir, name);
    // What charge() actually took, so the catch can roll back exactly that much. Declared OUTSIDE the
    // try on purpose: a `let`/`const` inside a try is scoped to it and the catch below is a sibling
    // scope, so reading `size` there threw a ReferenceError — inside the one module whose first
    // discipline is "NEVER throw", meaning a failed record destroyed the evidence of its own failure.
    // Found by tools/check-scope-references.mjs; the same shape cost three real live runs their result
    // file. Rolling back only what was charged is also more honest than the previous unconditional
    // decrement, which would have subtracted a charge that never happened (e.g. an mkdir failure).
    let chargedBytes = 0;
    let chargedFiles = 0;
    try {
      await mkdir(join(path, ".."), { recursive: true });
      const text = `${JSON.stringify(value, null, 2)}\n`;
      const size = Buffer.byteLength(text);
      const outcome = charge(size, { exempt });
      if (outcome !== "ok") {
        skipped.push({ path: name, bytes: size, reason: outcome });
        return undefined;
      }
      chargedBytes = size;
      chargedFiles = 1;
      await writeFile(path, text, "utf8");
      return path;
    } catch (error) {
      // Roll back the charge on a failed write so filesWritten/bytesWritten stay
      // the honest counts of files actually on disk (audit NOTE-2).
      bytesWritten -= chargedBytes;
      filesWritten -= chargedFiles;
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
      skipped.push({ path: name, bytes: size, reason: outcome });
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
  async function copyFileInto(sourcePath, destRel, { required = false, exempt = false } = {}) {
    let size = 0;
    try {
      size = (await stat(sourcePath)).size;
    } catch (error) {
      if (required) failures.push({ op: "stat", path: sourcePath, error: String(error?.message ?? error) });
      return false;
    }
    const dest = join(dir, destRel);
    const outcome = charge(size, { exempt });
    if (outcome !== "ok") {
      skipped.push({ path: destRel, bytes: size, reason: outcome });
      return false;
    }
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
   *
   * `exclusion(rel)` names a path this bundle may not hold at all (another run's session record): its reason is recorded
   * with its size instead of the file being copied, so the reader sees what was left behind and why.
   */
  async function copyTree(sourceDir, { include, destPrefix = "", exempt = false, exclusion = null } = {}) {
    const accept = typeof include === "function" ? include : () => true;
    const destOf = (rel) => (destPrefix.length > 0 ? `${destPrefix}/${rel}` : rel);

    /** One entry: descend, record the decision to leave it, or copy it - never fatal, never silent. */
    async function copyEntry(current, entry) {
      if (NEVER_DESCEND.has(entry.name)) return;
      const absolute = join(current, entry.name);
      const rel = toPosix(relative(sourceDir, absolute));
      if (entry.isDirectory()) {
        await walk(absolute);
        return;
      }
      // Symlinks are recorded as skipped (audit NOTE-3) rather than silently
      // disappearing: a linked evidence file that capture refuses to follow is
      // an observable decision, not an invisible hole.
      if (!entry.isFile()) {
        if (entry.isSymbolicLink()) skipped.push({ path: rel, bytes: null, reason: "symlink" });
        return;
      }
      if (!accept(rel)) return;
      const destRel = destOf(rel);
      const excluded = typeof exclusion === "function" ? exclusion(rel) : null;
      if (excluded !== null) {
        skipped.push({ path: destRel, bytes: await sizeOfFile(absolute), reason: excluded });
        return;
      }
      await copyFileInto(absolute, destRel, { exempt });
    }

    async function walk(current) {
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch (error) {
        failures.push({ op: "readdir", path: current, error: String(error?.message ?? error) });
        return;
      }
      // In order, one at a time: the budget is spent in a defined order, so two captures of the same
      // root keep the same files instead of whichever finished its stat first.
      for (const entry of entries) await copyEntry(current, entry);
    }
    await walk(sourceDir);
  }

  /**
   * The preset every Game/Chat/Memory run should keep: the continuity runtime
   * root's own evidence (profile, world book, MC database + log, run manifest,
   * session logs). Reading these is what makes content defects visible.
   *
   * THE RUN'S OWN ARTIFACTS GO FIRST AND ARE NEVER REFUSED, and the budget applies only to what remains: the run's
   * surface-session directory (bound by the `startedAtMs` its launch receipt states) and the rendered environment
   * record are what every verdict is measured against, while the root's other session directories belong to earlier
   * runs and are named `not_this_run` instead of being copied. Both lists land in the summary, so a reader can tell
   * "the wrong session" from "no session" without opening a file. Measured 2026-11-21 (`round88`): walk order over a
   * shared root spent the whole budget on 309 files of other runs' logs and skipped this run's own 4.8 MB record.
   */
  async function captureRuntimeRoot(runtimeRoot, { destPrefix = "runtime-root" } = {}) {
    if (typeof runtimeRoot !== "string" || runtimeRoot.length === 0) {
      failures.push({ op: "capture_runtime_root", error: "runtime_root_required" });
      return;
    }
    const include = (rel) => RUNTIME_ROOT_EVIDENCE.some((pattern) => pattern.test(rel));
    // ONE SPELLING of the run's start: the receipt that armed this directory (written by the launcher that outlives the
    // run, or by `openLiveRunCapture` when no launcher exists) rather than a second instant derived here.
    const launchedAtMs = readRunLaunch({ dir })?.startedAtMs;
    const bound = await bindRunSession(runtimeRoot, { launchedAtMs, include });

    const kept = new Set();
    for (const rel of [...new Set([...bound.environmentFacts, ...bound.ownedFiles])]) {
      if (await copyFileInto(join(runtimeRoot, rel), `${destPrefix}/${rel}`, { exempt: true })) kept.add(rel);
    }
    runSession = Object.freeze({
      state: bound.state,
      reason: bound.reason,
      directory: bound.directory === null ? null : `${destPrefix}/${bound.directory}`,
      startedAtMs: bound.startedAtMs,
      launchedAtMs: bound.launchedAtMs,
      // WHICH SESSION THE BUNDLE KEPT, NAMED - only the records that actually reached disk.
      records: bound.records
        .filter((record) => kept.has(record.rel))
        .map((record) => Object.freeze({ path: `${destPrefix}/${record.rel}`, bytes: record.bytes })),
    });

    // What remains is charged against the budget, and another run's session record is not something this bundle may
    // spend that budget on: it is named `not_this_run`, so the choice is visible even though it is not paid.
    const foreign = new Set(bound.foreignRecords.map((record) => record.rel));
    await copyTree(runtimeRoot, {
      include: (rel) => include(rel) && !kept.has(rel),
      destPrefix,
      exclusion: (rel) => (foreign.has(rel) ? "not_this_run" : null),
    });
  }

  async function close() {
    const session = runSession ?? Object.freeze({ state: "not_attempted" });
    if (!opened) return { dir, failures, skipped, bytesWritten, filesWritten, session };
    // The numbers INSIDE the summary describe everything captured BEFORE the
    // summary line; the returned totals include it. Recording the pre-summary
    // counts keeps the summary honest about what it is summarising.
    await record(
      "capture-summary.json",
      {
        schema: "gamebuddy_live_run_capture/v1",
        kind,
        dir,
        bytesWritten,
        filesWritten,
        // WHICH SESSION THIS BUNDLE KEPT, named: `state` `bound` with its records, `none` when this run opened no session
        // it can prove, `unbound` when the run's start instant is unreadable, `not_attempted` when no root was captured.
        session,
        skipped,
        failures,
      },
      { exempt: true },
    );
    return { dir, failures, skipped, bytesWritten, filesWritten, session };
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
