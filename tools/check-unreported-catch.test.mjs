import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { checkUnreportedCatches, DECLARED, formatFinding } from "./lib/unreported-catch.mjs";

// red-proof: inject  a handler whose catch only re-reads -> `unreported_catch:<path>:<line>:<symbol>`
// with `only calls rereadChat` beside it ("a catch that only re-reads is a finding" below); the
// same case plants the shape that shipped, `await rereadChat().catch(() => commit(...))`, and
// requires it to be reported too, because that report runs only when the re-read ALSO fails.
// red-proof: history  the revision before ffcbb876, where six message handlers and the Stop control
// ended in a re-read and nothing else -> the gate names all seven of them
// ("the pre-fix handlers are reported" below, reading the real commit's own file).

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots = [];

function makeRoot(files) {
  const root = mkdtempSync(join(tmpdir(), "unreported-catch-"));
  roots.push(root);
  for (const [relativePath, contents] of Object.entries(files)) {
    const full = join(root, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents, "utf8");
  }
  return root;
}

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A synthetic tree with no declarations of its own, so a test states exactly what it plants. */
function readPlant(source) {
  return checkUnreportedCatches({
    repoRoot: makeRoot({ "dialogue-web/src/handlers.tsx": source }),
    declared: [],
  });
}

test("a catch that only re-reads is a finding", () => {
  const readout = readPlant(
    [
      "async function rereadChat(): Promise<void> {}",
      "export async function handleRewind(): Promise<void> {",
      "  try {",
      "    await save();",
      "  } catch {",
      "    await rereadChat();",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  assert.equal(readout.unreported.length, 1);
  assert.equal(readout.unreported[0].does, "only calls rereadChat");
  assert.equal(formatFinding(readout.unreported[0]), "unreported_catch:dialogue-web/src/handlers.tsx:5:handleRewind");
});

test("a report that runs only when the re-read fails is still a finding", () => {
  const readout = readPlant(
    [
      "export async function handleDelete(): Promise<void> {",
      "  try {",
      "    await remove();",
      "  } catch (error) {",
      "    await reread().catch(() => {",
      "      commit(problemView(error));",
      "    });",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  assert.equal(readout.unreported.length, 1);
  assert.equal(readout.unreported[0].does, "only calls reread");
});

test("a catch that only logs is a finding", () => {
  const readout = readPlant(
    [
      "export function handleRegenerate(error: unknown): void {",
      "  try {",
      "    run();",
      "  } catch (error) {",
      "    console.error(error);",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  assert.equal(readout.unreported.length, 1);
  assert.equal(readout.unreported[0].does, "only calls console.error");
});

test("a catch that says nothing and one that answers undefined are findings", () => {
  const readout = readPlant(
    [
      "export function handleEdit(): void {",
      "  try {",
      "    run();",
      "  } catch {",
      "  }",
      "}",
      "export function handleSwipe(): undefined {",
      "  try {",
      "    run();",
      "  } catch {",
      "    return undefined;",
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  assert.deepEqual(
    readout.unreported.map((site) => `${site.symbol}:${site.does}`),
    ["handleEdit:does nothing", "handleSwipe:only returns undefined"],
  );
});

test("the four shapes that do report are not findings", () => {
  const readout = readPlant(
    [
      "export async function a(): Promise<void> {",
      "  try { run(); } catch (error) { throw error; }",
      "}",
      "export async function b(): Promise<void> {",
      "  try { run(); } catch (error) { setNotice(problem(error)); }",
      "}",
      "export async function c(): Promise<void> {",
      "  try { run(); } catch (error) { failure = problem(error); }",
      "}",
      "export async function d(): Promise<{ kind: string }> {",
      "  try { run(); } catch { return { kind: 'error' }; }",
      "}",
      "export function e(): boolean {",
      "  try { return run(); } catch { return false; }",
      "}",
      "",
    ].join("\n"),
  );
  assert.deepEqual(
    readout.unreported.map((site) => site.symbol),
    ["e"],
  );
});

test("a declaration whose witness is gone is a problem, not a pass", () => {
  const readout = checkUnreportedCatches({
    repoRoot: makeRoot({
      "dialogue-web/src/handlers.tsx": "export function a(): void {\n  try { run(); } catch { }\n}\n",
    }),
    declared: [
      { path: "dialogue-web/src/handlers.tsx", witness: "// a comment nobody wrote", reason: "planted", sites: 1 },
    ],
  });
  assert.deepEqual(
    readout.problems.map((problem) => problem.code),
    ["declaration_count_drift"],
  );
});

test("the pre-fix handlers are reported", () => {
  const path = "dialogue-web/src/components/ComposedReferenceGameApp.tsx";
  const shown = spawnSync("git", ["show", `ffcbb876^:${path}`], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(shown.status, 0, `git show ${path}: ${shown.stderr}`);
  const readout = checkUnreportedCatches({ repoRoot: makeRoot({ [path]: shown.stdout }), declared: [] });
  const silentReaders = readout.unreported
    .filter((site) => site.does === "only calls rereadChat")
    .map((site) => site.symbol)
    .sort();
  assert.deepEqual(silentReaders, [
    "handleDeleteConfirm",
    "handleEdit",
    "handleOpeningVariant",
    "handleRegenerate",
    "handleRewindConfirm",
    "handleStop",
    "handleSwipe",
  ]);
});

test("the real tree is green with its declarations", () => {
  const readout = checkUnreportedCatches({ repoRoot });
  assert.deepEqual(readout.unreported, []);
  assert.deepEqual(readout.problems, []);
  assert.ok(DECLARED.length > 0);
  assert.ok(readout.counts.sites > readout.counts.declared);
});
