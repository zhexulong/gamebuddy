/**
 * The assertion-hook gate, proven red on every rule it states and blocked on an empty directory.
 *
 * WHY. The gate exists because a hook is loaded by the LIVE engine after the world has already been mutated, so a
 * hook that imports, awaits, takes two parameters or returns something other than a list is a silent failure at the
 * worst possible moment. Each falsifier below writes a hook that breaks exactly one rule into a directory of its
 * own, runs the gate over it and requires the finding BY NAME - a gate that only ever reads the real directory
 * cannot be shown to have teeth, because the real directory is sound by construction today.
 *
 * The empty-directory case is the other half: `0 findings` over `0 hooks` is a reading that agrees with itself.
 *
 * red-proof: inject  the import rule removed from `inspectHook` -> "a hook that imports is a finding" fails, naming
 *            the file it looked at with no finding (tools/check-assertion-hooks.test.mjs).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertAssertionHooks, checkAssertionHooks } from "./check-assertion-hooks.mjs";

const roots = [];
function hookDirectory(files) {
  const directory = mkdtempSync(join(tmpdir(), "assertion-hooks-"));
  roots.push(directory);
  for (const [name, source] of Object.entries(files)) writeFileSync(join(directory, name), source, "utf8");
  return directory;
}
test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const SOUND = `export const asserts = ["worldAfter.itemTargets"];
export function hook({ before, after, evidence }) {
  return before === undefined || after === undefined || evidence === undefined
    ? ["worldAfter.itemTargets: the engine passed no world"]
    : [];
}
`;

/** The labels one gate run produced, and the reading it produced them from. */
async function labelsOf(files) {
  const reading = await checkAssertionHooks({ directory: hookDirectory(files) });
  return { reading, labels: reading.labels };
}

function assertOnly(labels, expected) {
  assert.deepEqual(
    labels.filter((label) => label.startsWith(`${expected.name}:`)),
    [expected.label],
    `expected exactly ${expected.label}, got ${labels.length === 0 ? "nothing" : labels.join(" , ")}`,
  );
}

test("the committed directory's hooks are sound, and the reading names its population", async () => {
  const reading = await checkAssertionHooks();
  assert.ok(reading.examined > 0, "examined 0 hooks: a directory that read nothing is not a directory that passed");
  assert.deepEqual(reading.labels, [], `the committed hooks broke a rule: ${reading.labels.join(" , ")}`);
  assertAssertionHooks(reading);
  console.log(
    `hooks examined ${reading.examined} · test files ${reading.testFiles.length} · findings ${reading.findings.length}`,
  );
});

test("a sound hook in a directory of its own is green, so the gate is not red on everything", async () => {
  const { reading, labels } = await labelsOf({ "probe.mjs": SOUND });
  assert.equal(reading.examined, 1);
  assert.deepEqual(labels, []);
  assertAssertionHooks(reading);
});

test("a hook that imports is a finding naming the specifier", async () => {
  const { labels } = await labelsOf({ "imports.mjs": `import { existsSync } from "node:fs";\n${SOUND}` });
  assertOnly(labels, { name: "assertion_hook_imports", label: "assertion_hook_imports:imports.mjs:node:fs" });
});

test("a dynamic import is a finding too: the hook would resolve a module inside the live run", async () => {
  const { labels } = await labelsOf({ "dynamic.mjs": `const probe = await import("node:url");\n${SOUND}` });
  assert.deepEqual(labels, ["assertion_hook_imports:dynamic.mjs:import()", "assertion_hook_is_async:dynamic.mjs"]);
});

test("an async hook is a finding, and so is one that awaits without saying so", async () => {
  const { labels } = await labelsOf({
    "async.mjs": `export const asserts = ["worldAfter.itemTargets"];
export async function hook({ before }) {
  return [];
}
`,
  });
  assertOnly(labels, { name: "assertion_hook_is_async", label: "assertion_hook_is_async:async.mjs" });
});

test("a hook taking two parameters, or none, is a finding with the count", async () => {
  const { labels } = await labelsOf({
    "two.mjs": `export const asserts = ["worldAfter.itemTargets"];
export function hook(before, after) {
  return [];
}
`,
    "none.mjs": `export const asserts = ["worldAfter.itemTargets"];
export function hook() {
  return [];
}
`,
  });
  assert.deepEqual(labels, ["assertion_hook_parameters:none.mjs:0", "assertion_hook_parameters:two.mjs:2"]);
});

test("a hook that answers something other than a list reports nothing, so it is a finding", async () => {
  const { labels } = await labelsOf({
    "object.mjs": `export const asserts = ["worldAfter.itemTargets"];
export function hook({ before }) {
  return { ok: true };
}
`,
  });
  assertOnly(labels, { name: "assertion_hook_returns", label: "assertion_hook_returns:object.mjs" });
});

test("a hook that throws on a world it cannot know is a finding, not a crash in the gate", async () => {
  const { labels } = await labelsOf({
    "throws.mjs": `export const asserts = ["worldAfter.itemTargets"];
export function hook({ before }) {
  return before.fishPondTargets.map((row) => row.targetId);
}
`,
  });
  assertOnly(labels, { name: "assertion_hook_throws", label: "assertion_hook_throws:throws.mjs" });
});

test("a second exported function is a finding: the engine calls the one", async () => {
  const { labels } = await labelsOf({
    "two-functions.mjs": `${SOUND}export function helper({ before }) {
  return [];
}
`,
  });
  assertOnly(labels, { name: "assertion_hook_functions", label: "assertion_hook_functions:two-functions.mjs:2" });
});

test("a hook with no declared clause is a finding: coverage could not count what it answers", async () => {
  const { labels } = await labelsOf({
    "no-asserts.mjs": `export function hook({ before }) {
  return [];
}
`,
  });
  assertOnly(labels, { name: "assertion_hook_asserts", label: "assertion_hook_asserts:no-asserts.mjs" });
});

test("a hook whose own falsifier suite sits beside it is not measured as a hook", async () => {
  const { reading, labels } = await labelsOf({
    "probe.mjs": SOUND,
    "probe.test.mjs": `import test from "node:test";\nimport { hook } from "../../tools/probe.mjs";\ntest("x", () => hook({}));\n`,
  });
  assert.deepEqual(labels, [], "a test file imports node:test by its nature, and is not a hook");
  assert.equal(reading.examined, 1, "the population is the hooks, and the test file is counted separately");
  assert.deepEqual([...reading.testFiles], ["probe.test.mjs"]);
});

test("a directory with no hook in it is blocked with its reason, never green", async () => {
  const reading = await checkAssertionHooks({ directory: hookDirectory({ "only.test.mjs": SOUND }) });
  assert.equal(reading.examined, 0);
  assert.deepEqual(reading.labels, []);
  assert.throws(() => assertAssertionHooks(reading), /assertion_hooks_examined_nothing/u);
});

test("the guard is red on a finding, so a green reading is the only one it accepts", () => {
  const reading = Object.freeze({
    directory: "probe",
    examined: 1,
    files: Object.freeze(["probe.mjs"]),
    testFiles: Object.freeze([]),
    findings: Object.freeze([
      { name: "assertion_hook_is_async", file: "probe.mjs", label: "assertion_hook_is_async:probe.mjs", why: "probe" },
    ]),
    labels: Object.freeze(["assertion_hook_is_async:probe.mjs"]),
  });
  assert.throws(() => assertAssertionHooks(reading), /assertion_hook_findings:assertion_hook_is_async:probe\.mjs/u);
});
