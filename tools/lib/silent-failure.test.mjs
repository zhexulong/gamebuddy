import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { checkSilentFailures, findSilentFailures } from "./silent-failure.mjs";

/**
 * A gate earns its place by being able to go red. Every case below builds a tiny
 * tree, so the gate is exercised against code written for the case rather than
 * against the repository it happens to be sitting in.
 */

async function tree(files) {
  const root = await mkdtemp(join(tmpdir(), "silent-failure-"));
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, body, "utf8");
  }
  return root;
}

test("an empty catch with no declaration is a finding", async () => {
  const root = await tree({
    "src/a.ts": "export function reportLoad() {\n  try { return read(); } catch {}\n}\n",
  });
  try {
    const findings = findSilentFailures(root);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, "silent-catch");
    assert.equal(findings[0].symbol, "reportLoad");
    const verdict = checkSilentFailures(root, []);
    assert.equal(verdict.findings.length, 1, "undeclared silence must still be reported");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a declaration with a witness silences exactly the site it quotes", async () => {
  const source = "export function reportLoad() {\n  try { return read(); } catch {}\n}\n";
  const root = await tree({ "src/a.ts": source });
  try {
    const [finding] = findSilentFailures(root);
    const declared = [
      {
        kind: finding.kind,
        path: finding.path,
        symbol: finding.symbol,
        reason: "nothing to report here",
        witness: "catch {}",
        sites: 1,
      },
    ];
    const verdict = checkSilentFailures(root, declared);
    // `findings` is the inventory of silent sites; `undeclared` is the verdict.
    assert.equal(verdict.findings.length, 1, "the site is still in the inventory");
    assert.equal(verdict.problems.length, 0, `unexpected problem: ${JSON.stringify(verdict.problems[0])}`);
    assert.equal(verdict.undeclared?.length ?? 0, 0, "the declared site is waived");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a declaration whose witness no longer matches the code is stale, not silently applied", async () => {
  // This is the decoy that stops a declaration from widening: the reason still
  // reads plausibly, the path still exists, but the code it waived has changed.
  const root = await tree({
    "src/a.ts": "export function reportLoad() {\n  try { return read(); } catch { return null; }\n}\n",
  });
  try {
    const declared = [
      {
        kind: "silent-catch",
        path: "src/a.ts",
        symbol: "reportLoad",
        reason: "nothing to report here",
        witness: "catch {}",
        sites: 1,
      },
    ];
    const verdict = checkSilentFailures(root, declared);
    assert.ok(verdict.problems.length > 0, "a declaration that no longer matches must be reported");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a declaration with no reason or no witness is rejected outright", async () => {
  const root = await tree({ "src/a.ts": "export function probeThing() { try { g(); } catch {} }\n" });
  try {
    const verdict = checkSilentFailures(root, [
      { kind: "silent-catch", path: "src/a.ts", symbol: "probeThing", reason: "  ", witness: "x", sites: 1 },
      { kind: "silent-catch", path: "src/a.ts", symbol: "probeThing", reason: "ok", witness: "", sites: 1 },
      { kind: "silent-catch", path: "src/a.ts", symbol: "probeThing", reason: "ok", witness: "x", sites: 0 },
    ]);
    const codes = verdict.problems.map((p) => p.code);
    assert.ok(codes.includes("declaration_unreasoned"));
    assert.ok(codes.includes("declaration_unwitnessed"));
    assert.ok(codes.includes("declaration_uncounted"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an early return before the function reported anything is a finding of its own kind", async () => {
  const root = await tree({
    "src/b.ts":
      "const seen = new WeakSet();\nexport function announceRoot(roots, sink = process.stderr) {\n  if (seen.has(sink)) return;\n  seen.add(sink);\n  sink.write(`${roots}\n`);\n}\n",
  });
  try {
    const findings = findSilentFailures(root);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].kind, "early-return");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a catch that propagates is not a finding", async () => {
  const root = await tree({
    "src/c.ts": "export function probeThing() {\n  try { return g(); } catch (error) { throw error; }\n}\n",
  });
  try {
    assert.equal(findSilentFailures(root).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the gate does not scan its own machinery or test files", async () => {
  const root = await tree({
    "tools/lib/silent-failure.mjs": "export const X = 1; try { y(); } catch {}\n",
    "src/x.test.ts": "test('a', () => { try { g(); } catch {} });\n",
  });
  try {
    assert.equal(findSilentFailures(root).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
