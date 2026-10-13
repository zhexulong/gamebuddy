import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { diagnosticPrints, inspect, isProductionSource, ratchet } from "./check-host-diagnostic-output.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOST_SOURCE = join(REPOSITORY_ROOT, "host", "src");
const GATE = join(REPOSITORY_ROOT, "tools", "check-host-diagnostic-output.mjs");

/**
 * Writes a whole source tree under a throwaway root, so every check below exercises the gate's own
 * rule rather than a hand-written expectation about a real module.
 */
function withFixtureRoot(build) {
  const root = mkdtempSync(join(tmpdir(), "gb-diagnostic-output-"));
  try {
    for (const [relativePath, contents] of Object.entries(build())) {
      const path = join(root, relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    }
    return inspect({ root, uncommitted: new Set() });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("flags the marker the shipping incident used", () => {
  const { violations } = withFixtureRoot(() => ({
    "a.ts": 'export function go(): void {\n  process.stderr.write("[DEBUG-chat-live-p4c] admission_ok\\n");\n}\n',
  }));
  assert.equal(violations.length, 1);
  assert.equal(violations[0].file, "a.ts");
  assert.equal(violations[0].line, 2);
  assert.equal(violations[0].form, "debug_marker");
});

test("flags a marker on a multi-line call whose literal starts on the next line", () => {
  const { violations } = withFixtureRoot(() => ({
    "a.ts": 'export function go(): void {\n  process.stderr.write(\n    `[DEBUG-x] stage=${stage}\\n`,\n  );\n}\n',
  }));
  assert.equal(violations.length, 1);
  assert.equal(violations[0].line, 2);
});

test("flags the DEBUG, XDEBUG, TRACE and DBG markers, and not other words", () => {
  const { violations } = withFixtureRoot(() => ({
    "a.ts":
      'export const a = (): void => console.log("[DEBUG-x] a");\n' +
      'export const b = (): void => console.log(`[XDEBUG] b`);\n' +
      'export const c = (): void => console.log("[trace] c");\n' +
      'export const d = (): void => console.log("[dbg] d");\n' +
      'export const e = (): void => console.log("[verbose] output disabled");\n',
  }));
  assert.deepEqual(
    violations.map((violation) => violation.line),
    [1, 2, 3, 4],
  );
});

test("does not flag console.debug itself, only a message that declares itself debug output", () => {
  const { violations } = withFixtureRoot(() => ({
    "a.ts": 'export const m = (stage: string): void => console.debug(`GameBuddy native chat ingress stage=${stage}`);\n',
  }));
  assert.deepEqual(violations, []);
});

test("does not flag the bounded operational record shape the product keeps", () => {
  const { violations } = withFixtureRoot(() => ({
    "a.ts":
      'export const read = (error: unknown): void => {\n  process.stderr.write(`[memory] read failed: ${boundedReason(error)}\\n`);\n};\n',
  }));
  assert.deepEqual(violations, []);
});

test("counts a text-first print call and ignores one whose first argument is not text", () => {
  const { counts } = withFixtureRoot(() => ({
    "a.ts":
      'export const write = (bytes: Uint8Array): void => {\n  process.stdout.write(bytes);\n};\n' +
      'export const log = (): void => console.log("a bounded record");\n',
  }));
  assert.deepEqual(counts, { "a.ts": 1 });
});

test("a commented-out call is still a site, and a commented-out marker is still reported", () => {
  const { counts, violations } = withFixtureRoot(() => ({
    "a.ts": '// process.stderr.write("[DEBUG-nope] x");\nexport const ok = 1;\n',
  }));
  assert.deepEqual(counts, { "a.ts": 1 });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].line, 1);
});

test("test, fixture and fixture-worker sources are out of scope", () => {
  const { violations, counts } = withFixtureRoot(() => ({
    "tavern/a.test.ts": 'test("x", () => process.stderr.write("[DEBUG-test] x\\n"));\n',
    "tavern/a.test-support.ts": 'export const x = (): void => console.log("[DEBUG-support] x");\n',
    "tavern/a.test-fixtures.ts": 'export const x = (): void => console.log("[DEBUG-fixtures] x");\n',
    "composition/drain-fixture-worker.ts": 'console.log("[DEBUG-worker] x");\n',
    "test-fixtures/worker.ts": 'process.stderr.write("[DEBUG-fixture] x\\n");\n',
  }));
  assert.deepEqual(violations, []);
  assert.deepEqual(counts, {});
});

test("production-source filter mirrors the host production tsconfig", () => {
  assert.equal(isProductionSource("tavern/chat-thread-store.ts"), true);
  assert.equal(isProductionSource("runtime-core.internal.ts"), true);
  assert.equal(isProductionSource("tavern/chat-thread-store.test.ts"), false);
  assert.equal(isProductionSource("tavern/loose.test-support.ts"), false);
  assert.equal(isProductionSource("tavern/loose.test-fixtures.ts"), false);
  assert.equal(isProductionSource("composition/drain-fixture-worker.ts"), false);
  assert.equal(isProductionSource("test-fixtures/worker.ts"), false);
  assert.equal(isProductionSource("tavern/types.d.ts"), false);
});

test("a new debug site is exactly what the marker arm reports", () => {
  const sites = diagnosticPrints("a.ts", 'process.stderr.write("[DEBUG-live-run] x\\n");\n');
  assert.equal(sites.length, 1);
  assert.equal(sites[0].literal, "[DEBUG-live-run] x\\n");
});

test("the ratchet reports growth past the recorded count and nothing else", () => {
  const baseline = { counts: { "a.ts": 1, "b.ts": 2 } };
  assert.deepEqual(ratchet({ baseline, counts: { "a.ts": 1, "b.ts": 2 } }), []);
  assert.deepEqual(ratchet({ baseline, counts: { "a.ts": 2, "b.ts": 2 } }), ["a.ts"]);
  assert.deepEqual(ratchet({ baseline, counts: { "a.ts": 0 } }), [], );
  assert.deepEqual(ratchet({ baseline, counts: { "a.ts": 1, "b.ts": 2, "new.ts": 1 } }), ["new.ts"]);
});

test("uncommitted files are skipped by both arms", () => {
  const root = mkdtempSync(join(tmpdir(), "gb-diagnostic-dirty-"));
  try {
    writeFileSync(join(root, "dirty.ts"), 'process.stderr.write("[DEBUG-in-flight] x\\n");\n');
    writeFileSync(join(root, "landed.ts"), 'process.stderr.write("[DEBUG-shipped] x\\n");\n');
    const { violations, counts } = inspect({ root, uncommitted: new Set(["dirty.ts"]) });
    assert.deepEqual(
      violations.map((violation) => violation.file),
      ["landed.ts"],
    );
    assert.deepEqual(counts, { "landed.ts": 1 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Runs the gate CLI over a throwaway scope with a baseline written beside it. */
function runGate(build, { baseline = { counts: {} } } = {}) {
  const root = mkdtempSync(join(tmpdir(), "gb-diagnostic-cli-"));
  try {
    for (const [relativePath, contents] of Object.entries(build())) {
      const path = join(root, "src", relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    }
    const baselinePath = join(root, "baseline.json");
    writeFileSync(baselinePath, JSON.stringify({ note: "planted", revision: "planted", total: 0, ...baseline }));
    const result = spawnSync(process.execPath, [GATE, join(root, "src"), "--baseline", baselinePath, "--include-dirty"], {
      encoding: "utf8",
      windowsHide: true,
    });
    return { status: result.status, stdout: result.stdout };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the CLI reports a planted debug marker and exits non-zero", () => {
  const { status, stdout } = runGate(() => ({
    "a.ts": 'export function go(): void {\n  process.stderr.write("[DEBUG-gate-plant] here\\n");\n}\n',
  }));
  assert.equal(status, 1);
  assert.match(stdout, /host_diagnostic_output_failed markers=1/u);
  assert.match(stdout, /a\.ts:2 prints "\[DEBUG-gate-plant\] here\\n"/u);
});

test("the CLI reports a planted print site the baseline does not record and exits non-zero", () => {
  const { status, stdout } = runGate(() => ({ "b.ts": 'console.log("a new narration");\n' }));
  assert.equal(status, 1);
  assert.match(stdout, /b\.ts: 0 -> 1 diagnostic print site\(s\)/u);
});

test("the CLI passes a planted tree that stays within its baseline", () => {
  const { status, stdout } = runGate(() => ({ "b.ts": 'process.stderr.write("[memory] read failed: bounded\\n");\n' }), {
    baseline: { counts: { "b.ts": 1 } },
  });
  assert.equal(status, 0);
  assert.match(stdout, /host_diagnostic_output_ok sites=1 files=1/u);
});

test("the repository's production host sources carry no debug marker", () => {
  const { violations } = inspect({ root: HOST_SOURCE, uncommitted: new Set() });
  assert.deepEqual(violations, []);
});
