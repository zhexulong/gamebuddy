import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  DEFAULT_LIVE_RUN_ROOT,
  LIVE_RUN_ROOT_ENV,
  openLiveRunCapture,
  resolveLiveRunRoot,
} from "./capture.mjs";

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), "live-run-capture-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("resolveLiveRunRoot honours the env override and defaults to a repo-local root", async (t) => {
  const repoRoot = await scratch(t);
  assert.equal(resolveLiveRunRoot({ repoRoot, env: {} }), join(repoRoot, DEFAULT_LIVE_RUN_ROOT));
  const scratchRoot = join(repoRoot, "scratch-runs");
  assert.equal(
    resolveLiveRunRoot({ repoRoot, env: { [LIVE_RUN_ROOT_ENV]: scratchRoot } }),
    scratchRoot,
  );
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
  assert.ok(existsSync(join(capture.dir, "runtime-root", "contexts", "abc", "data", "cortexkit", "magic-context", "context.db")));
  assert.ok(existsSync(join(capture.dir, "runtime-root", "contexts", "abc", "data", "cortexkit", "magic-context", "magic-context.log")));
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
  assert.equal(summary.skipped.every((entry) => entry.reason === "max_files"), true);
});

test("a missing source is recorded as a failure and never throws", async (t) => {
  const root = await scratch(t);
  const capture = await openLiveRunCapture({ kind: "memory-loop", root });
  await capture.captureRuntimeRoot(join(root, "does-not-exist"));
  const summary = await capture.close();
  assert.equal(summary.failures.length, 1);
  assert.equal(summary.failures[0].op, "readdir");
});

test("captureRuntimeRoot rejects an empty root explicitly", async (t) => {
  const root = await scratch(t);
  const capture = await openLiveRunCapture({ kind: "memory-loop", root });
  await capture.captureRuntimeRoot("");
  const summary = await capture.close();
  assert.equal(summary.failures[0].error, "runtime_root_required");
});
