#!/usr/bin/env node
/**
 * Tests for the failure-reason-code gate (`check-failure-reason-codes.mjs`).
 *
 * The gate exists to catch one bug class: an exception's own text published in a `reasonCode`, which breaks every
 * consumer that switches on the code and leaves an artifact that names no site. This file proves, for each evidence
 * class:
 *
 *   1. the REAL pre-fix shapes are detected, quoted from the commit that shipped them (`String(error?.message ?? error)`
 *      inside a `reasonCode` template, and a caught value handed to a code helper) - not invented for the fixture;
 *   2. the finding comes from the RULE, not from the fixture: the identical source with a literal code is clean, so the
 *      difference is what the gate reacts to;
 *   3. the sanctioned shapes hold: a literal, a code a record carries, and a classified record's own `reasonCode`;
 *   4. an assignment (`x.reasonCode = ...`) is the same defect and is reported;
 *   5. a file that does not parse fails closed instead of passing as clean;
 *   6. the CLI reports, names the file, exits 1 on a finding and 0 on a clean tree - driven through the real entry
 *      point, so the gate is proven as a gate and not only as a function.
 *
 * red-proof: history  the pre-fix tree, quoted from the commit that shipped it - `String(error?.message ?? error)`
 *   inside a `reasonCode` template and a caught value handed to a code helper - is what this suite failed on
 *   before the gate learned to name the site.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { auditSource, REASON_CODE_RULES } from "./check-failure-reason-codes.mjs";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const CHECKER = path.join(HERE, "check-failure-reason-codes.mjs");

const ERROR_TEXT = "error_text_as_reason_code";
const UNPARSED = "source_unparsed";

async function findingsOf(source) {
  const result = await auditSource(source, "fixture.mjs");
  return result.findings;
}

async function runScanner(argumentsList) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CHECKER, ...argumentsList], {
      encoding: "utf8",
      cwd: REPO_ROOT,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

async function withFixtureTree(files, run) {
  const root = await mkdtemp(path.join(tmpdir(), "gb-reason-code-gate-"));
  try {
    for (const [name, contents] of Object.entries(files)) await writeFile(path.join(root, name), contents, "utf8");
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// --- 1. the real pre-fix shapes are detected -----------------------------------------

// Quoted from `tools/live-run/game/run-stardew-native-local-agent-ab-live.mjs` at 230775c7 (the tree that produced
// `2026-11-05T11-37-35-764Z-multiday_routine`): the harness put a thrown error's message straight into a night-cause
// code, so `menu_not_dismissed:useTool:path is not defined` was a "code" nobody had ever declared.
const PRE_FIX_MENU_DISMISS = `async function dismiss(menuType) {
  try {
    return await dispatch(menuType);
  } catch (error) {
    return Object.freeze({ receipt: null, reasonCode: \`menu_not_dismissed:\${menuType}:\${String(error?.message ?? error).slice(0, 160)}\` });
  }
}
`;

// The Chat audit's shape at the same commit: the caught value passed to a helper whose whole job was to launder it into
// a code. The message survived only because it happened to contain no spaces.
const PRE_FIX_SAFE_CODE = `function blocked(error) {
  return JSON.stringify({ schema: "outcome", state: "blocked", reasonCode: safeReasonCode(error) });
}
`;

test("the pre-fix harness template is reported, naming the line that shipped it", async () => {
  const findings = await findingsOf(PRE_FIX_MENU_DISMISS);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, ERROR_TEXT);
  assert.equal(findings[0].fileName, "fixture.mjs");
  assert.equal(findings[0].line, 5, "the finding points at the reasonCode expression, not at the file");
  assert.match(findings[0].message, /menu_not_dismissed/u);
});

test("the caught value handed to a code helper is reported, because the helper reads the error", async () => {
  const findings = await findingsOf(PRE_FIX_SAFE_CODE);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, ERROR_TEXT);
  assert.match(findings[0].message, /safeReasonCode\(error\)/u);
});

// --- 2. the finding is the RULE's, not the fixture's --------------------------------

test("the identical shape with a literal code is clean, so the gate reacts to the carrier and not the context", async () => {
  const findings = await findingsOf(
    PRE_FIX_MENU_DISMISS.replace("${String(error?.message ?? error).slice(0, 160)}", "dispatch_threw"),
  );
  assert.deepEqual(findings, []);
});

// --- 3. the sanctioned shapes hold ------------------------------------------------

test("literals, codes a record carries, and a classified record's own code are all accepted", async () => {
  const source = `function publish(record, thrown) {
  const settled = 1;
  return {
    a: { reasonCode: "seed_planted" },
    b: { reasonCode: null },
    c: { reasonCode: record.reasonCode },
    d: { reasonCode: thrown.reasonCode },
    e: { reasonCode: settled > 0 ? "level_up_resolved" : "level_up_not_resolved" },
    f: { reasonCode: \`menu_not_dismissed:\${record.menuType}:dispatch_threw\` },
  };
}
`;
  assert.deepEqual(await findingsOf(source), []);
});

// --- 4. an assignment is the same defect ------------------------------------------

test("a reasonCode assigned after construction is read, not skipped", async () => {
  const findings = await findingsOf(`function stamp(outcome, error) {\n  outcome.reasonCode = error.message;\n}\n`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, ERROR_TEXT);
  assert.equal(findings[0].line, 2);
});

// --- 5. an unreadable file fails closed --------------------------------------------

test("a file that does not parse is a finding, never a clean file", async () => {
  const findings = await findingsOf("function broken( {\n  reasonCode: 'x',\n");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, UNPARSED);
});

test("the rule vocabulary is the gate's, so a caller can ask for what it reports", () => {
  assert.deepEqual([...REASON_CODE_RULES], [ERROR_TEXT, UNPARSED]);
});

// --- 6. the exit code is the verdict ---------------------------------------------

test("the CLI names the file and exits 1, and exits 0 on the same tree once the carrier is gone", async () => {
  await withFixtureTree({ "runner.mjs": PRE_FIX_MENU_DISMISS }, async (root) => {
    const dirty = await runScanner([root]);
    assert.equal(dirty.code, 1);
    assert.match(dirty.stdout, /runner\.mjs:5:\d+\s+error_text_as_reason_code/u);
    assert.match(dirty.stdout, /1 findings/u);

    await writeFile(
      path.join(root, "runner.mjs"),
      PRE_FIX_MENU_DISMISS.replace("${String(error?.message ?? error).slice(0, 160)}", "dispatch_threw"),
      "utf8",
    );
    const clean = await runScanner([root]);
    assert.equal(clean.code, 0, clean.stdout + clean.stderr);
    assert.match(clean.stdout, /1 reasonCode sites, 0 findings/u);
  });
});

test("the repository's own live-run tree is clean, and the scan actually read its sites", async () => {
  const result = await runScanner(["--json"]);
  assert.equal(result.code, 0, result.stdout);
  const report = JSON.parse(result.stdout);
  assert.ok(report.filesScanned > 50, `expected the live-run tree, read ${report.filesScanned} files`);
  assert.ok(report.reasonCodeSites > 100, `expected the tree's reason codes to be read, saw ${report.reasonCodeSites}`);
  assert.deepEqual(report.findings, []);
});
