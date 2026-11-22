// red-proof: history  the duplicate-key test as it shipped at 39588596 (`host/src/local-stardew-bridge.test.ts:864`)
//   replayed through `auditTestAwaitDeadlines` -> `await_without_deadline:...:864:disconnected` and status `failed`
//   (tools/check-test-await-deadlines.test.mjs)
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { auditTestAwaitDeadlines, statusOf } from "./check-test-await-deadlines.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GATE = join(REPOSITORY_ROOT, "tools", "check-test-await-deadlines.mjs");

/** One throwaway root holding the given test files, keyed by their path inside it. */
function rootWith(files) {
  const root = mkdtempSync(join(tmpdir(), "test-await-deadlines-"));
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents, "utf8");
  }
  return root;
}

/** The findings for one fixture, with the root removed again. */
function findingsFor(files) {
  const root = rootWith(files);
  try {
    return auditTestAwaitDeadlines({ root });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The gate CLI over a fixture root: what an operator sees, including the exit status. */
function runGate(root) {
  const result = spawnSync(process.execPath, [GATE, "--root", root, "--json"], { encoding: "utf8" });
  return { status: result.status, report: JSON.parse(String(result.stdout).trim()), stderr: String(result.stderr) };
}

/** A client whose listener the test awaits, written once so each case varies only in how it waits. */
const LISTENER_PROMISE = [
  "  const disconnected = new Promise<{ state: string }>((resolvePromise) =>",
  "    client.onConnectionFact(resolvePromise),",
  "  );",
];

/**
 * The defect itself: the promise a listener settles is awaited bare. This is the shape that cost 600 s of every host
 * suite run, and the finding has to name the member - the file, the await's line, and the expression - because
 * "1 await without a deadline" is a number a reader cannot act on.
 */
test("a listener await with no deadline is named with its file, its line and the promise it awaits", () => {
  const reading = findingsFor({
    "host/src/bare.test.ts": [
      "const connect = async () => undefined;",
      ...LISTENER_PROMISE,
      "await disconnected;",
    ].join("\n"),
  });
  assert.deepEqual(reading.findings, ["await_without_deadline:host/src/bare.test.ts:5:disconnected"]);
  assert.deepEqual(
    reading.awaits.map((entry) => entry.promiseSource),
    ["disconnected"],
    "one await, named by the expression it awaits",
  );
  assert.equal(reading.withDeadline, 0);
  assert.equal(statusOf(reading), "failed");
});

/** The sanctioned shape in this tree: the fact is raced against a timer that rejects when it never arrives. */
test("a listener await raced against a setTimeout deadline is not a finding", () => {
  const reading = findingsFor({
    "host/src/raced.test.ts": [
      ...LISTENER_PROMISE,
      "await Promise.race([",
      "  disconnected,",
      '  new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("fact_timeout")), 1_000)),',
      "]);",
    ].join("\n"),
  });
  assert.deepEqual(reading.findings, []);
  assert.equal(reading.withDeadline, 1);
  assert.equal(statusOf(reading), "passed");
});

/** A promise that sets its own timeout at construction already bounds itself: nothing to race. */
test("a new Promise that sets its own timeout while it waits is not a finding", () => {
  const reading = findingsFor({
    "host/src/construction.test.ts": [
      "const disconnected = new Promise<{ state: string }>((resolvePromise, _reject) => {",
      '  setTimeout(() => resolvePromise({ state: "timeout" }), 1_000);',
      "  client.onConnectionFact(resolvePromise);",
      "});",
      "await disconnected;",
    ].join("\n"),
  });
  assert.deepEqual(reading.findings, []);
  assert.equal(reading.withDeadline, 1);
});

/**
 * `timeout(5_000).then(() => { throw … })` is how this repository already races a child process's exit: the timer is
 * inside a local function, so a reader that only matches `setTimeout` in the race list would call it a hang.
 */
test("a local function that builds the timer is a deadline, followed through one hop", () => {
  const reading = findingsFor({
    "host/src/helper.test.ts": [
      "const timeout = (ms: number) => new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, ms));",
      ...LISTENER_PROMISE,
      "await Promise.race([",
      "  disconnected,",
      "  timeout(1_000).then(() => {",
      '    throw new Error("fact_timeout");',
      "  }),",
      "]);",
    ].join("\n"),
  });
  assert.deepEqual(reading.findings, []);
  assert.equal(reading.withDeadline, 1);
});

/** A file-local wrapper around the promise is a deadline when its own body races the promise against a timer. */
test("a local deadline wrapper around the promise is a deadline, and the promise inside it is still the population", () => {
  const reading = findingsFor({
    "host/src/wrapper.test.ts": [
      "function factWithinDeadline<T>(pending: Promise<T>, factName: string): Promise<T> {",
      "  return Promise.race([",
      "    pending,",
      "    new Promise<never>((_resolve, reject) => {",
      "      setTimeout(() => reject(new Error(`${factName}_timeout`)), 5_000).unref();",
      "    }),",
      "  ]);",
      "}",
      ...LISTENER_PROMISE,
      'await factWithinDeadline(disconnected, "connection_fact");',
    ].join("\n"),
  });
  assert.deepEqual(reading.findings, []);
  assert.equal(reading.withDeadline, 1);
});

/** `node:timers/promises` is a timer source too, and the file's own import is what says so. */
test("a timer imported from node:timers/promises bounds the race", () => {
  const reading = findingsFor({
    "host/src/imported.test.ts": [
      'import { setTimeout as delay } from "node:timers/promises";',
      ...LISTENER_PROMISE,
      "await Promise.race([",
      "  disconnected,",
      "  delay(1_000).then(() => {",
      '    throw new Error("fact_timeout");',
      "  }),",
      "]);",
    ].join("\n"),
  });
  assert.deepEqual(reading.findings, []);
  assert.equal(reading.withDeadline, 1);
});

/** A `Promise.race` that races two facts and no timer bounds nothing, so it is still a finding. */
test("a race between two listener promises and no timer is still a finding", () => {
  const reading = findingsFor({
    "host/src/two-facts.test.ts": [
      ...LISTENER_PROMISE,
      "const received = new Promise<{ fact: string }>((resolvePromise) =>",
      "  client.onFact(resolvePromise),",
      ");",
      "await Promise.race([disconnected, received]);",
    ].join("\n"),
  });
  assert.deepEqual(reading.findings, [
    "await_without_deadline:host/src/two-facts.test.ts:7:Promise.race([disconnected, received])",
  ]);
  assert.equal(reading.withDeadline, 0, "a race between two facts and no timer bounds neither of them");
});

/** Prose is not code: a docblock that spells the defect must not be read as one. */
test("a comment that spells the bare await is not the await, and an empty population blocks", () => {
  const reading = findingsFor({
    "host/src/comment.test.ts": [
      "/**",
      " * This used to hang: `assert.deepEqual(await disconnected, ...)` with no deadline.",
      " */",
      "test('x', async () => {",
      "  await new Promise<void>((resolveLocked) => setImmediate(resolveLocked));",
      "});",
    ].join("\n"),
  });
  assert.deepEqual(reading.findings, []);
  assert.deepEqual(reading.awaits, []);
  assert.equal(statusOf(reading), "blocked", "a scan of 436 files that finds no listener await has lost its reader");
});

/** The three answers the CLI can give, on fixture roots: passed, failed on a violation, blocked on nothing to measure. */
test("the CLI exits 0 for a clean tree, 1 naming the await, and 2 when it measured nothing", () => {
  const clean = rootWith({
    "host/src/raced.test.ts": [
      ...LISTENER_PROMISE,
      "await Promise.race([",
      "  disconnected,",
      '  new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("fact_timeout")), 1_000)),',
      "]);",
    ].join("\n"),
  });
  const dirty = rootWith({ "host/src/bare.test.ts": [...LISTENER_PROMISE, "await disconnected;"].join("\n") });
  const empty = mkdtempSync(join(tmpdir(), "test-await-deadlines-empty-"));
  try {
    assert.equal(runGate(clean).status, 0);
    const failed = runGate(dirty);
    assert.equal(failed.status, 1);
    assert.deepEqual(failed.report.findings, ["await_without_deadline:host/src/bare.test.ts:4:disconnected"]);
    const blocked = runGate(empty);
    assert.equal(blocked.status, 2);
    assert.equal(blocked.report.status, "blocked");
    assert.equal(blocked.report.examined, 0);
    assert.match(blocked.stderr, /no test file was read/u);
  } finally {
    for (const root of [clean, dirty, empty]) rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The real history this gate exists for: the duplicate-key test as it stood at 39588596, the commit whose message says
 * the frame "no longer [is] refused". Replayed rather than synthesised, so the case cannot drift into a fixture nobody
 * ever wrote; `t.skip` when this checkout cannot read the revision, because an unreadable pin is not a pass.
 */
test("the pre-fix duplicate-key test is red on the await that cost 600 s of every suite run", (t) => {
  let source;
  try {
    source = execFileSync("git", ["show", "39588596:host/src/local-stardew-bridge.test.ts"], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
    });
  } catch (error) {
    t.skip(`39588596 is not readable from this checkout: ${String(error?.message ?? error).split("\n")[0]}`);
    return;
  }
  const reading = findingsFor({ "host/src/local-stardew-bridge.test.ts": source });
  assert.ok(
    reading.findings.includes("await_without_deadline:host/src/local-stardew-bridge.test.ts:864:disconnected"),
    `the duplicate-key await is named by line: ${reading.findings.join(" · ")}`,
  );
  assert.deepEqual(reading.without, reading.awaits, "every listener await in that revision is unraced");
  assert.equal(statusOf(reading), "failed");
});
