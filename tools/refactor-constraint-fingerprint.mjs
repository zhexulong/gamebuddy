/**
 * Constraint-fingerprint extractor for one host test file.
 *
 * Produces a deterministic JSON fingerprint of the test file's CONSTRAINT
 * SURFACE so a refactor can be verified not to lose/weaken any constraint:
 *  - per-test name + assertion-kind counts + error-code regexes + root prefixes
 *  - file aggregates: total tests, assert kinds, distinct root prefixes,
 *    distinct error codes, top-level helper definitions
 *
 * The tool excludes top-level helper bodies from per-test assertion counts
 * (helpers interleaved between tests must not pollute either neighbor block),
 * and excludes helper DEFINITION lines themselves from the createRoot-prefix
 * scan (a `function createRoot(` line is not a call site).
 *
 * Usage: node tools/refactor-constraint-fingerprint.mjs <test-file> [--out <json>]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const [testFile] = process.argv.slice(2);
const outArg = process.argv.indexOf("--out");
const outFile = outArg >= 0 ? process.argv[outArg + 1] : undefined;

if (!testFile || !existsSync(testFile)) {
  console.error("usage: node tools/refactor-constraint-fingerprint.mjs <test-file> [--out <json>]");
  process.exit(2);
}

const source = readFileSync(testFile, "utf8").replace(/\r\n/g, "\n");
const lines = source.split("\n");

// ── top-level helper definitions (file-local functions/consts) ────────────
// A helper starts at a function/const declaration at brace depth 0 and ends
// when its braces return to depth 0. Record name + [startLine, endLine] (1-based, inclusive).
const topLevelHelpers = [];
{
  let braceDepth = 0;
  let parenDepth = 0;
  let inHelper = false;
  let current = null;
  const helperDefRe = /^(?:export )?(?:async )?function\s+([A-Za-z0-9_]+)\s*\(|^const\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?[({]/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inHelper) {
      const m = line.match(helperDefRe);
      if (m && braceDepth === 0 && parenDepth === 0) {
        inHelper = true;
        current = { name: m[1] ?? m[2], startLine: i + 1, kind: m[1] ? "function" : "const" };
      }
    }
    if (inHelper) {
      for (const ch of line) {
        if (ch === "{") braceDepth++;
        else if (ch === "}") braceDepth--;
        else if (ch === "(") parenDepth++;
        else if (ch === ")") parenDepth--;
      }
      // helper ends when both brace and paren depth return to 0
      if (braceDepth <= 0 && parenDepth <= 0) {
        inHelper = false;
        braceDepth = 0;
        parenDepth = 0;
        current.endLine = i + 1;
        topLevelHelpers.push(current);
        current = null;
      }
    }
  }
}

// 0-based inclusive/exclusive helper line ranges for fast membership tests.
const helperRanges = topLevelHelpers.map((h) => ({ start: h.startLine - 1, end: h.endLine })); // [start, end) 0-based
const inAnyHelper = (lineIdx) => helperRanges.some((r) => lineIdx >= r.start && lineIdx < r.end);

// ── split into test blocks ────────────────────────────────────────────────
const testStartRe = /^\s*test\(/;
const blockStarts = [];
for (let i = 0; i < lines.length; i++) if (testStartRe.test(lines[i])) blockStarts.push(i);
blockStarts.push(lines.length);

const tests = [];
for (let b = 0; b < blockStarts.length - 1; b++) {
  const start = blockStarts[b];
  const end = blockStarts[b + 1];
  const blockLines = lines.slice(start, end);
  const block = blockLines.join("\n");
  const nameMatch = block.match(/^\s*test\(\s*([`"'])((\\.|(?!\1).)*)\1/s);
  const testName = nameMatch ? nameMatch[2].replace(/\\([`"'])|\$\{/g, "$1") : `(unnamed@${start + 1})`;

  const asserts = {};
  const errorCodes = new Set();
  const helperCalls = {};
  let rootPrefix = null;
  const helpers = [
    "createHarness", "createRoot", "reserveFresh", "mintPair", "mintOwnedTriple",
    "ownerPath", "withPathLock", "bindWindowsStaleLockReclaimer",
    "launchStagedPlayerHostForTesting", "createOwnerTransitions",
    "assertAttemptFixtureUnchanged",
  ];

  for (let li = 0; li < blockLines.length; li++) {
    const absoluteLine = start + li;
    // skip helper bodies that sit between tests (they belong to no test block)
    if (inAnyHelper(absoluteLine)) continue;
    const line = blockLines[li];
    let m = line.match(/assert\.([a-zA-Z]+)\(/);
    if (m) asserts[m[1]] = (asserts[m[1]] ?? 0) + 1;

    if (/(?:assert\.(?:rejects|throws|match|doesNotMatch)|assert\.match)\(/.test(line)) {
      const re = line.match(/\/[^/\n]+\/[a-z]*/g);
      if (re) for (const r of re) errorCodes.add(r);
    }

    for (const h of helpers) {
      const count = (line.match(new RegExp(`\\b${h}\\(`, "g")) ?? []).length;
      if (count > 0) helperCalls[h] = (helperCalls[h] ?? 0) + count;
    }

    const rootMatch = line.match(/\bcreateRoot\(\s*(`[^`]*`|"[^"]*"|'[^']*'|\$\{[^}]*\}|[^,)]*)/);
    if (rootMatch && rootPrefix === null) rootPrefix = rootMatch[1].trim() || "(no-arg default)";
  }

  tests.push({
    testName,
    asserts: Object.keys(asserts).length ? asserts : undefined,
    errorCodes: errorCodes.size ? [...errorCodes].sort() : undefined,
    rootPrefix: rootPrefix ?? null,
    helperCalls: Object.keys(helperCalls).length ? helperCalls : undefined,
  });
}

// ── file-level distinct createRoot first-arg variants ────────────────────
// Capture from the WHOLE file (including top-level helpers) but skip helper
// DEFINITION lines themselves (they are not call sites).
const fileRootPrefixes = new Set();
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (/^(?:export )?(?:async )?function\s+createRoot\s*\(|^const\s+createRoot\s*=/.test(line)) continue;
  const rootMatch = line.match(/\bcreateRoot\(\s*(`[^`]*`|"[^"]*"|'[^']*'|\$\{[^}]*\}|[^,)]*)/);
  if (rootMatch) fileRootPrefixes.add(rootMatch[1].trim() || "(no-arg default)");
}

const aggregate = {
  totalTests: tests.length,
  assertKinds: (() => { const a = {}; for (const t of tests) for (const [k, v] of Object.entries(t.asserts ?? {})) a[k] = (a[k] ?? 0) + v; return a; })(),
  rootPrefixes: [...new Set(tests.map((t) => t.rootPrefix).filter((p) => p !== null))].sort(),
  fileRootPrefixes: [...fileRootPrefixes].sort(),
  errorCodes: [...new Set(tests.flatMap((t) => t.errorCodes ?? []))].sort(),
  topLevelHelpers: topLevelHelpers.map((h) => `${h.name}@${h.startLine}-${h.endLine}`),
  file: testFile,
  lineCount: lines.length,
};

const fingerprint = { tests, aggregate };
const json = JSON.stringify(fingerprint, null, 1);
if (outFile) writeFileSync(outFile, json);
process.stdout.write(json);