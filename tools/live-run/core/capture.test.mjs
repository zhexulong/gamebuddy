import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { DEFAULT_LIVE_RUN_ROOT, LIVE_RUN_ROOT_ENV, openLiveRunCapture, resolveLiveRunRoot } from "./capture.mjs";
import { writeLaunchReceipt } from "./run-closure.mjs";

/**
 * A run's start instant, as its launch receipt states it (`startedAtMs`). Written by the launcher that outlives the run,
 * and the one fact a session directory can be bound to.
 */
const RUN_STARTED_AT_MS = Date.parse("2026-11-21T17:47:00.000Z");

/** A session record of `bytes` bytes, named with the instant the runtime opened it (`<utc>_<sessionId>.jsonl`). */
async function sessionRecord(sessionDir, name, bytes) {
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(sessionDir, name), "x".repeat(bytes), "utf8");
  return join(sessionDir, name);
}

/**
 * The Host's own filename for what the environment provider RENDERED into each assembled request
 * (`ENVIRONMENT_FACTS_RECORD_FILENAME`, host/src/runtime-core.internal.ts). `round-verdict.mjs` reads rows 2
 * and 5 from it, so if the capture stops keeping it those two criteria go back to reading a session that by
 * construction never contained the block.
 */
const ENVIRONMENT_FACTS_RECORD = "environment-facts.jsonl";

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), "live-run-capture-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("resolveLiveRunRoot honours the env override and defaults to a repo-local root", async (t) => {
  const repoRoot = await scratch(t);
  assert.equal(resolveLiveRunRoot({ repoRoot, env: {} }), join(repoRoot, DEFAULT_LIVE_RUN_ROOT));
  const scratchRoot = join(repoRoot, "scratch-runs");
  assert.equal(resolveLiveRunRoot({ repoRoot, env: { [LIVE_RUN_ROOT_ENV]: scratchRoot } }), scratchRoot);
  // An empty override is not a root: fall back rather than writing to "".
  assert.equal(
    resolveLiveRunRoot({ repoRoot, env: { [LIVE_RUN_ROOT_ENV]: "" } }),
    join(repoRoot, DEFAULT_LIVE_RUN_ROOT),
  );
});

test("a run directory holds JSON records and a summary", async (t) => {
  const root = await scratch(t);
  const capture = await openLiveRunCapture({ kind: "game-ladder", label: "ladder-5", root });
  assert.ok(existsSync(capture.dir), "run dir created");
  assert.ok(capture.dir.startsWith(join(root, "game-ladder")), "kind namespaced under root");

  await capture.record("observation.json", { ladder: "5", rejectionCount: 8 });
  const written = JSON.parse(await readFile(join(capture.dir, "observation.json"), "utf8"));
  assert.deepEqual(written, { ladder: "5", rejectionCount: 8 });

  const summary = await capture.close();
  assert.deepEqual(summary.failures, []);
  assert.ok(existsSync(join(capture.dir, "capture-summary.json")));
  const recorded = JSON.parse(await readFile(join(capture.dir, "capture-summary.json"), "utf8"));
  assert.equal(recorded.schema, "gamebuddy_live_run_capture/v1");
  // No runtime root was captured, so which session this bundle holds is `not_attempted` - a third reading, not "none".
  assert.equal(recorded.session.state, "not_attempted");
  // The numbers INSIDE the summary describe everything captured before it (the
  // one observation); the returned totals include the summary file itself. Both
  // are reported so neither is ambiguous.
  assert.equal(recorded.filesWritten, 1);
  assert.equal(summary.filesWritten, 2);
});

test("append keeps harness narration and child output without throwing", async (t) => {
  const root = await scratch(t);
  const capture = await openLiveRunCapture({ kind: "chat-audit", root });
  await capture.append("child-stderr.log", "line one\n");
  await capture.append("child-stderr.log", "line two\n");
  const text = await readFile(join(capture.dir, "child-stderr.log"), "utf8");
  assert.equal(text, "line one\nline two\n");
  // Degenerate inputs are ignored, never fatal.
  await capture.append("child-stderr.log", "");
  await capture.append("child-stderr.log", undefined);
  await capture.close();
});

test("copyTree keeps only included paths and never descends into node_modules", async (t) => {
  const root = await scratch(t);
  const source = join(root, "runtime-root");
  const contextDir = join(source, "contexts", "abc");
  await mkdir(join(contextDir, "data", "cortexkit", "magic-context"), { recursive: true });
  await mkdir(join(contextDir, "node_modules", "junk"), { recursive: true });
  await writeFile(join(contextDir, "identity-profile.json"), '{"persona":{"core":"warm"}}', "utf8");
  await writeFile(join(contextDir, "data", "cortexkit", "magic-context", "context.db"), "SQLITE", "utf8");
  await writeFile(join(contextDir, "data", "cortexkit", "magic-context", "magic-context.log"), "log\n", "utf8");
  await writeFile(join(contextDir, "unrelated.txt"), "noise", "utf8");
  await writeFile(join(contextDir, "node_modules", "junk", "index.js"), "noise", "utf8");

  const capture = await openLiveRunCapture({ kind: "game-ladder", root });
  await capture.captureRuntimeRoot(source);
  await capture.close();

  assert.ok(existsSync(join(capture.dir, "runtime-root", "contexts", "abc", "identity-profile.json")));
  assert.ok(
    existsSync(
      join(capture.dir, "runtime-root", "contexts", "abc", "data", "cortexkit", "magic-context", "context.db"),
    ),
  );
  assert.ok(
    existsSync(
      join(capture.dir, "runtime-root", "contexts", "abc", "data", "cortexkit", "magic-context", "magic-context.log"),
    ),
  );
  assert.equal(existsSync(join(capture.dir, "runtime-root", "contexts", "abc", "unrelated.txt")), false);
  assert.equal(existsSync(join(capture.dir, "runtime-root", "contexts", "abc", "node_modules")), false);
});

test("the file budget truncates loudly instead of filling the disk", async (t) => {
  const root = await scratch(t);
  const source = join(root, "runtime-root");
  const contextDir = join(source, "contexts", "abc");
  await mkdir(join(contextDir, "surface-sessions", "s", "sessions"), { recursive: true });
  await writeFile(join(contextDir, "identity-profile.json"), "{}", "utf8");
  for (let i = 0; i < 5; i += 1) {
    await writeFile(join(contextDir, "surface-sessions", "s", "sessions", `s${i}.jsonl`), `{"i":${i}}`, "utf8");
  }

  const capture = await openLiveRunCapture({ kind: "game-ladder", root, budget: { maxFiles: 2 } });
  await capture.captureRuntimeRoot(source);
  const summary = await capture.close();
  assert.ok(summary.skipped.length > 0, "budget overflow recorded");
  // Copy-path skips carry their path; the close-time summary record may also be
  // skipped (budget exhausted) which is honest. Only the copy skips must be
  // max_files.
  const copySkips = summary.skipped.filter((entry) => entry.reason === "over_cap");
  assert.ok(copySkips.length > 0, "copy skips present");
  assert.ok(
    copySkips.every((entry) => typeof entry.path === "string" && typeof entry.bytes === "number"),
    "a skipped copy names its path and the bytes it refused, so the gap is countable",
  );
});

test("the rendered environment record travels with the run, beside the session it describes", async (t) => {
  const root = await scratch(t);
  const source = join(root, "runtime-root");
  const contextDir = join(source, "contexts", "abc");
  await mkdir(join(contextDir, "surface-sessions", "s", "sessions"), { recursive: true });
  // Both layouts the Host can write: with a surface session id (a Game activation) and without one.
  const line = `${JSON.stringify({ schema: "gamebuddy_environment_facts_render/v1", revision: 7, bytes: 3, text: "x" })}\n`;
  await writeFile(join(contextDir, "surface-sessions", "s", ENVIRONMENT_FACTS_RECORD), line, "utf8");
  await writeFile(join(contextDir, ENVIRONMENT_FACTS_RECORD), line, "utf8");

  const capture = await openLiveRunCapture({ kind: "game-ladder", root });
  await capture.captureRuntimeRoot(source);
  await capture.close();

  assert.equal(
    await readFile(
      join(capture.dir, "runtime-root", "contexts", "abc", "surface-sessions", "s", ENVIRONMENT_FACTS_RECORD),
      "utf8",
    ),
    line,
  );
  assert.equal(
    await readFile(join(capture.dir, "runtime-root", "contexts", "abc", ENVIRONMENT_FACTS_RECORD), "utf8"),
    line,
  );
});

test("a shared root's historical session does not take the bundle from this run's own record", async (t) => {
  // Measured 2026-11-21 (`round88`): the bundle copied 309 files / 266.8 MB out of a SHARED runtime root, hit the byte cap
  // before it reached this run's own 4 843 990-byte record, and `round-verdict` then read a leftover `13-38-33` session from
  // an earlier run - so every model-time and turn number in that verdict belonged to another run. The falsifier is that
  // same shape: two records, the historical one sorting FIRST in walk order, and a cap that fits only one. The run's own
  // record must be in the bundle, the one it skipped must be NAMED, and the summary must say which session it kept.
  const OWN_BYTES = 512 * 1024;
  const HISTORICAL_BYTES = 512 * 1024;
  const OWN_RECORD = "2026-11-21T17-48-50-387Z_01a1b2c3-0000-7000-8000-000000000001.jsonl";
  const HISTORICAL_RECORD = "2026-11-21T13-38-33-000Z_01a1b2c3-0000-7000-8000-000000000000.jsonl";
  const root = await scratch(t);
  const source = join(root, "runtime-root");
  const context = join(source, "contexts", "identity");
  const historical = await sessionRecord(
    join(context, "surface-sessions", "game-1795280000000", "sessions"),
    HISTORICAL_RECORD,
    HISTORICAL_BYTES,
  );
  const own = await sessionRecord(
    join(context, "surface-sessions", "game-1795283329340", "sessions"),
    OWN_RECORD,
    OWN_BYTES,
  );
  const rendered = join(context, "surface-sessions", "game-1795283329340", "environment-facts.jsonl");
  await writeFile(rendered, `${JSON.stringify({ revision: 1, text: "位置: x" })}\n`, "utf8");

  const runDir = join(root, "run");
  writeLaunchReceipt({ dir: runDir, kind: "game-ladder", startedAtMs: RUN_STARTED_AT_MS, pid: 4_242 });
  const capture = await openLiveRunCapture({
    kind: "game-ladder",
    dir: runDir,
    budget: { maxBytes: OWN_BYTES + 4_096 },
  });
  await capture.captureRuntimeRoot(source);
  const summary = await capture.close();

  const bundle = join(capture.dir, "runtime-root", "contexts", "identity", "surface-sessions");
  assert.ok(existsSync(join(bundle, "game-1795283329340", "sessions", OWN_RECORD)), "this run's own record is kept");
  assert.equal(
    existsSync(join(bundle, "game-1795280000000", "sessions", HISTORICAL_RECORD)),
    false,
    "the earlier run's record is not this bundle's",
  );
  // The rendered environment record travels with the same run, outside the cap for the same reason.
  assert.ok(existsSync(join(bundle, "game-1795283329340", "environment-facts.jsonl")));

  const recorded = JSON.parse(await readFile(join(capture.dir, "capture-summary.json"), "utf8"));
  assert.equal(recorded.session.state, "bound");
  assert.equal(recorded.session.directory, "runtime-root/contexts/identity/surface-sessions/game-1795283329340");
  assert.equal(recorded.session.startedAtMs, Date.parse("2026-11-21T17:48:50.387Z"));
  assert.equal(recorded.session.launchedAtMs, RUN_STARTED_AT_MS);
  assert.deepEqual(
    recorded.session.records,
    [
      {
        path: `runtime-root/contexts/identity/surface-sessions/game-1795283329340/sessions/${OWN_RECORD}`,
        bytes: OWN_BYTES,
      },
    ],
    "the summary names WHICH session it kept, with the bytes it took",
  );
  // The one it left behind is named too, with its own reason - so a reader can tell "the wrong session" from "no session".
  assert.deepEqual(recorded.skipped, [
    {
      path: `runtime-root/contexts/identity/surface-sessions/game-1795280000000/sessions/${HISTORICAL_RECORD}`,
      bytes: HISTORICAL_BYTES,
      reason: "not_this_run",
    },
  ]);
  assert.equal(summary.session.records.length, 1);
  assert.equal(existsSync(historical), true, "the source root is untouched");
  assert.equal(existsSync(own), true);
});

/**
 * The other half of the same falsifier: a run that opened no session of its own must publish `none`, never another run's
 * record and never silence. A reader has to be able to tell the two apart without opening a file.
 */
test("a run that opened no session of its own publishes none, and bundles no other run's", async (t) => {
  const root = await scratch(t);
  const source = join(root, "runtime-root");
  const historicalRecord = "2026-11-21T13-38-33-000Z_01a1b2c3-0000-7000-8000-000000000000.jsonl";
  await sessionRecord(
    join(source, "contexts", "identity", "surface-sessions", "game-1795280000000", "sessions"),
    historicalRecord,
    4_096,
  );
  const runDir = join(root, "run");
  writeLaunchReceipt({ dir: runDir, kind: "game-ladder", startedAtMs: RUN_STARTED_AT_MS, pid: 4_242 });
  const capture = await openLiveRunCapture({ kind: "game-ladder", dir: runDir });
  await capture.captureRuntimeRoot(source);
  await capture.close();

  const recorded = JSON.parse(await readFile(join(capture.dir, "capture-summary.json"), "utf8"));
  assert.equal(recorded.session.state, "none");
  assert.equal(recorded.session.reason, "no_session_record_at_or_after_the_run_start");
  assert.equal(recorded.session.directory, null);
  assert.deepEqual(recorded.session.records, []);
  assert.equal(
    recorded.skipped.filter((entry) => entry.reason === "not_this_run").length,
    1,
    "the record it refused is named, so `none` is a decision and not an empty directory",
  );
  const bundle = join(capture.dir, "runtime-root", "contexts", "identity", "surface-sessions");
  assert.equal(existsSync(join(bundle, "game-1795280000000", "sessions", historicalRecord)), false);
});

test("a run whose launch instant cannot be read keeps nothing out, and says the session is unbound", async (t) => {
  // The third reading: a receipt that states no start instant cannot bind a session at all. Refusing every record would
  // throw away evidence, and claiming one would be the round88 defect again - so the summary names the state and the
  // reason, and the records are copied like any other evidence.
  const root = await scratch(t);
  const source = join(root, "runtime-root");
  const record = "2026-11-21T17-48-50-387Z_01a1b2c3-0000-7000-8000-000000000001.jsonl";
  await sessionRecord(
    join(source, "contexts", "identity", "surface-sessions", "game-1795283329340", "sessions"),
    record,
    1_024,
  );
  const runDir = join(root, "run");
  await mkdir(runDir, { recursive: true });
  await writeFile(
    join(runDir, "launch.json"),
    `${JSON.stringify({ schema: "gamebuddy-live-run-launch/v1", kind: "game-ladder" })}\n`,
    "utf8",
  );
  const capture = await openLiveRunCapture({ kind: "game-ladder", dir: runDir });
  await capture.captureRuntimeRoot(source);
  await capture.close();

  const recorded = JSON.parse(await readFile(join(capture.dir, "capture-summary.json"), "utf8"));
  assert.equal(recorded.session.state, "unbound");
  assert.equal(recorded.session.reason, "no_launch_instant");
  assert.deepEqual(recorded.skipped, [], "an unbound run refuses no evidence on a guess");
  assert.ok(
    existsSync(
      join(
        capture.dir,
        "runtime-root",
        "contexts",
        "identity",
        "surface-sessions",
        "game-1795283329340",
        "sessions",
        record,
      ),
    ),
  );
});

test("the run's own record is kept even when it alone is over the byte cap", async (t) => {
  const root = await scratch(t);
  const source = join(root, "runtime-root");
  const context = join(source, "contexts", "identity");
  const record = "2026-11-21T17-48-50-387Z_01a1b2c3-0000-7000-8000-000000000001.jsonl";
  await sessionRecord(join(context, "surface-sessions", "game-1795283329340", "sessions"), record, 4_096);
  await writeFile(join(context, "identity-profile.json"), "y".repeat(4_096), "utf8");
  const runDir = join(root, "run");
  writeLaunchReceipt({ dir: runDir, kind: "game-ladder", startedAtMs: RUN_STARTED_AT_MS, pid: 4_242 });
  const capture = await openLiveRunCapture({ kind: "game-ladder", dir: runDir, budget: { maxBytes: 1_024 } });
  await capture.captureRuntimeRoot(source);
  const summary = await capture.close();

  assert.ok(
    existsSync(
      join(
        capture.dir,
        "runtime-root",
        "contexts",
        "identity",
        "surface-sessions",
        "game-1795283329340",
        "sessions",
        record,
      ),
    ),
    "a cap that can starve the subject of the report is not a cap",
  );
  assert.ok(
    summary.skipped.some(
      (entry) => entry.path === "runtime-root/contexts/identity/identity-profile.json" && entry.reason === "over_cap",
    ),
    "what remains is still capped, and the refusal is named",
  );
});

test("a missing source is recorded as a failure and never throws", async (t) => {
  const root = await scratch(t);
  const capture = await openLiveRunCapture({ kind: "memory-loop", root });
  await capture.captureRuntimeRoot(join(root, "does-not-exist"));
  const summary = await capture.close();
  assert.equal(summary.failures.length, 1);
  assert.equal(summary.failures[0].op, "readdir");
});

test("append and record are budgeted too (audit MEDIUM-1): runaway stderr cannot exceed the byte budget", async (t) => {
  const root = await scratch(t);
  const capture = await openLiveRunCapture({ kind: "memory-loop", root, budget: { maxBytes: 200 } });
  await capture.append("child-stderr.log", "a".repeat(150));
  await capture.append("child-stderr.log", "b".repeat(150));
  await capture.record("obs.json", { text: "c".repeat(150) });
  const summary = await capture.close();
  assert.ok(summary.skipped.length >= 2, "over-budget appends/records recorded as skipped");
  assert.ok(summary.skipped.every((entry) => entry.reason === "over_cap"));
  assert.deepEqual(
    summary.skipped.map((entry) => entry.path),
    ["child-stderr.log", "obs.json"],
    "each refused write names itself rather than a shared word for both",
  );
  // The file that fit is on disk; its content is preserved.
  const text = await readFile(join(capture.dir, "child-stderr.log"), "utf8");
  assert.equal(text.length, 150);
});

test("a failed copy rolls back its charge (audit NOTE-2)", async (t) => {
  const root = await scratch(t);
  const source = join(root, "source");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "evidence.db"), "x".repeat(64), "utf8");
  const capture = await openLiveRunCapture({ kind: "memory-loop", root, budget: { maxBytes: 1024, maxFiles: 1 } });
  // First copy succeeds (1 file).
  assert.equal(await capture.copyFileInto(join(source, "evidence.db"), "a.db"), true);
  // Blow the file budget: the SECOND copy is refused before writing.
  assert.equal(await capture.copyFileInto(join(source, "evidence.db"), "b.db"), false);
  const summary = await capture.close();
  assert.equal(summary.skipped[0].reason, "over_cap");
  assert.equal(existsSync(join(capture.dir, "b.db")), false);
});

test("symlinks are recorded as skipped, not silently dropped (audit NOTE-3)", async (t) => {
  const root = await scratch(t);
  const source = join(root, "runtime-root");
  await mkdir(source, { recursive: true });
  const target = join(source, "real-file.txt");
  await writeFile(target, "data", "utf8");
  try {
    await symlink(target, join(source, "linked-evidence.txt"));
  } catch {
    // Windows may need privileges for symlinks; skip the assertion then.
    t.skip("symlink creation not permitted in this environment");
    return;
  }
  const capture = await openLiveRunCapture({ kind: "game-ladder", root });
  await capture.captureRuntimeRoot(source);
  const summary = await capture.close();
  assert.ok(summary.skipped.some((entry) => entry.reason === "symlink"));
  assert.equal(existsSync(join(capture.dir, "runtime-root", "linked-evidence.txt")), false);
});

test("captureRuntimeRoot rejects an empty root explicitly", async (t) => {
  const root = await scratch(t);
  const capture = await openLiveRunCapture({ kind: "memory-loop", root });
  await capture.captureRuntimeRoot("");
  const summary = await capture.close();
  assert.equal(summary.failures[0].error, "runtime_root_required");
});

test("a run writes a launch receipt before it does any work, so a killed run leaves evidence", async () => {
  // Night audit (2026-10-17/18): 7 of 36 run directories were empty and 10 had no manifest, because every record
  // was written at CLOSE. A run killed before its interesting moment was therefore indistinguishable on disk from
  // one that never started. The receipt is written the moment the directory exists.
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-capture-launch-"));
  try {
    const capture = await openLiveRunCapture({ kind: "game-ladder", label: "receipt", root });
    const receipt = JSON.parse(await readFile(join(capture.dir, "launch.json"), "utf8"));
    assert.equal(receipt.schema, "gamebuddy-live-run-launch/v1");
    assert.equal(receipt.kind, "game-ladder");
    assert.equal(receipt.label, "receipt");
    assert.equal(typeof receipt.startedAtMs, "number");
    assert.equal(typeof receipt.pid, "number");
    // A process death after this point still leaves the directory non-empty.
    assert.ok(existsSync(join(capture.dir, "launch.json")));
  } finally {
    rm(root, { recursive: true, force: true });
  }
});
