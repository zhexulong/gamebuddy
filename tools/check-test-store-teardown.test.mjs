import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  HOST_SOURCE,
  deriveStoreOpeners,
  inspect,
  openingLines,
  ratchet,
} from "./check-test-store-teardown.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GATE = join(REPOSITORY_ROOT, "tools", "check-test-store-teardown.mjs");
const REAL_OPENERS = ["createChatThreadStore", "openProductionContinuityStore"];

function withFixtureTree(build, run) {
  const root = mkdtempSync(join(tmpdir(), "gb-store-teardown-"));
  try {
    for (const [relativePath, contents] of Object.entries(build())) {
      const path = join(root, relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    }
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Writes a whole source tree under a throwaway root, so each check exercises the gate's own rule. */
function withFixtureRoot(build) {
  return withFixtureTree(build, (root) => inspect({ root, uncommitted: new Set() }));
}

const STORE_MODULE =
  "export function createChatThreadStore(root: string): Store {\n" +
  '  const dbPath = join(root, "tavern.sqlite");\n' +
  "  const db = new DatabaseSync(dbPath);\n" +
  "  return { close: () => db.close() };\n" +
  "}\n";

test("the openers are derived from the production modules that open a file-backed database", () => {
  const { modules, names } = deriveStoreOpeners(HOST_SOURCE);
  assert.deepEqual([...names].sort(), REAL_OPENERS);
  assert.deepEqual(
    [...modules].map(([module, list]) => `${module}: ${list.join(",")}`).sort(),
    [
      "continuity-semantic-store/continuity-semantic-production-store.ts: openProductionContinuityStore",
      "tavern/chat-thread-store.ts: createChatThreadStore",
    ],
  );
});

test("a construction that is not in an exported declaration is not derived", () => {
  const { modules, names } = withFixtureTree(
    () => ({
      "private.ts":
        'function privateOpener(): void {\n  const db = new DatabaseSync(path);\n}\nexport function publicThing(): void {}\n',
    }),
    (root) => deriveStoreOpeners(root),
  );
  assert.deepEqual([...names], []);
  assert.deepEqual([...modules], []);
});

test("flags a test file that opens a store and never closes it", () => {
  const { openers, openings, closes } = withFixtureRoot(() => ({
    "a.ts": STORE_MODULE,
    "a.test.ts": 'test("x", () => {\n  const store = createChatThreadStore(root);\n  assert.equal(store.read(), 1);\n});\n',
  }));
  assert.deepEqual(openers, ["createChatThreadStore"]);
  assert.deepEqual(openings, { "a.test.ts": [2] });
  assert.deepEqual(closes, { "a.test.ts": 0 });
  assert.deepEqual(ratchet({ baseline: { openings: {} }, openings }), ["a.test.ts"]);
});

test("counts a test that opens the SQLite file itself, and ignores an in-memory handle", () => {
  const { openings } = withFixtureRoot(() => ({
    "a.ts": STORE_MODULE,
    "a.test.ts":
      'test("x", () => {\n  const file = new DatabaseSync(dbPath);\n  const scratch = new DatabaseSync(":memory:");\n  file.close();\n  scratch.close();\n});\n',
  }));
  assert.deepEqual(openings, { "a.test.ts": [2] });
});

test("does not count a construction whose throw is the assertion", () => {
  const { openings } = withFixtureRoot(() => ({
    "a.ts": STORE_MODULE,
    "a.test.ts":
      'test("x", () => {\n  assert.throws(() => createChatThreadStore(root), /unsupported_schema/);\n});\n',
  }));
  assert.deepEqual(openings, {});
});

test("counts a construction that is only near an assertion, not inside it", () => {
  const { openings } = withFixtureRoot(() => ({
    "a.ts": STORE_MODULE,
    "a.test.ts":
      'test("x", () => {\n  assert.throws(() => createChatThreadStore(root), /unsupported_schema/);\n  const store = createChatThreadStore(root);\n  assert.ok(store);\n});\n',
  }));
  assert.deepEqual(openings, { "a.test.ts": [3] });
});

test("counts one line once when a ternary holds two constructions", () => {
  const { openings } = withFixtureRoot(() => ({
    "a.ts": STORE_MODULE,
    "a.test.ts":
      'test("x", () => {\n  const store = now === undefined ? createChatThreadStore(a) : createChatThreadStore(b);\n  store.close();\n});\n',
  }));
  assert.deepEqual(openings, { "a.test.ts": [2] });
});

test("test support, fixtures and production files are out of scope", () => {
  const { openings } = withFixtureRoot(() => ({
    "a.ts": STORE_MODULE,
    "helper.test-support.ts": "export const open = (): Store => createChatThreadStore(root);\n",
    "a.test-fixtures.ts": "export const open = (): Store => createChatThreadStore(root);\n",
    "drain-fixture-worker.ts": "const store = createChatThreadStore(root);\n",
    "nested/a.test.ts": 'test("x", () => {\n  const store = createChatThreadStore(root);\n});\n',
  }));
  assert.deepEqual(openings, { "nested/a.test.ts": [2] });
});

test("the ratchet allows the recorded count, a reduction, and nothing above it", () => {
  const baseline = { openings: { "a.test.ts": 2 } };
  assert.deepEqual(ratchet({ baseline, openings: { "a.test.ts": [1, 2] } }), []);
  assert.deepEqual(ratchet({ baseline, openings: { "a.test.ts": [1] } }), []);
  assert.deepEqual(ratchet({ baseline, openings: { "a.test.ts": [1, 2, 3] } }), ["a.test.ts"]);
  assert.deepEqual(ratchet({ baseline, openings: { "new.test.ts": [1] } }), ["new.test.ts"]);
});

test("an uncommitted test file is skipped", () => {
  const root = mkdtempSync(join(tmpdir(), "gb-store-dirty-"));
  try {
    writeFileSync(join(root, "a.ts"), STORE_MODULE);
    writeFileSync(join(root, "a.test.ts"), 'test("x", () => {\n  createChatThreadStore(root);\n});\n');
    assert.deepEqual(inspect({ root, uncommitted: new Set(["a.test.ts"]) }).openings, {});
    assert.deepEqual(Object.keys(inspect({ root, uncommitted: new Set() }).openings), ["a.test.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("openingLines reads a file that only opens without closing", () => {
  assert.deepEqual(openingLines('const store = createChatThreadStore(root, key);\n', ["createChatThreadStore"]), [1]);
  assert.deepEqual(openingLines("const store = createChatThreadStore(root, key);\n", []), []);
});

/** Runs the gate CLI over a throwaway scope with a baseline written beside it. */
function runGate(build, { baseline, update = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "gb-store-cli-"));
  try {
    for (const [relativePath, contents] of Object.entries(build())) {
      const path = join(root, "src", relativePath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    }
    const baselinePath = join(root, "baseline.json");
    writeFileSync(baselinePath, JSON.stringify(baseline ?? { note: "planted", revision: "planted", files: 0, openings: {} }));
    const args = [GATE, join(root, "src"), "--baseline", baselinePath, "--include-dirty"];
    if (update) args.push("--update");
    const result = spawnSync(process.execPath, args, { encoding: "utf8", windowsHide: true });
    return { status: result.status, stdout: result.stdout };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the CLI reports a planted raw construction in a test file and exits non-zero", () => {
  const { status, stdout } = runGate(() => ({
    "a.ts": STORE_MODULE,
    "planted.test.ts": 'test("x", () => {\n  const store = createChatThreadStore(root);\n});\n',
  }));
  assert.equal(status, 1);
  assert.match(stdout, /test_store_teardown_openers=1 createChatThreadStore/u);
  assert.match(stdout, /planted\.test\.ts: 0 -> 1 store-opening line\(s\), at 2 \(0 close site\(s\) in the file\)/u);
});

test("the CLI passes the same tree once the opening is recorded", () => {
  const build = () => ({
    "a.ts": STORE_MODULE,
    "planted.test.ts": 'test("x", () => {\n  const store = createChatThreadStore(root);\n});\n',
  });
  assert.equal(runGate(build, { update: true }).status, 0);
  const { status, stdout } = runGate(build, { baseline: { openings: { "planted.test.ts": 1 } } });
  assert.equal(status, 0);
  assert.match(stdout, /test_store_teardown_ok files=1/u);
});

test("the CLI reports a second opening in a file that already has one", () => {
  const { status, stdout } = runGate(
    () => ({
      "a.ts": STORE_MODULE,
      "b.test.ts":
        'test("x", () => {\n  const first = createChatThreadStore(root);\n  const second = createChatThreadStore(root);\n  first.close();\n  second.close();\n});\n',
    }),
    { baseline: { openings: { "b.test.ts": 1 } } },
  );
  assert.equal(status, 1);
  assert.match(stdout, /b\.test\.ts: 1 -> 2 store-opening line\(s\), at 2,3 \(2 close site\(s\) in the file\)/u);
});

test("the CLI passes a file that stays at its recorded count", () => {
  const { status, stdout } = runGate(
    () => ({
      "a.ts": STORE_MODULE,
      "b.test.ts":
        'test("x", () => {\n  const store = now === undefined ? createChatThreadStore(a) : createChatThreadStore(b);\n  store.close();\n});\n',
    }),
    { baseline: { openings: { "b.test.ts": 1 } } },
  );
  assert.equal(status, 0);
  assert.match(stdout, /test_store_teardown_ok/u);
});
