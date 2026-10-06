#!/usr/bin/env node
/**
 * Tests for the scope-reference gate (`check-scope-references.mjs` +
 * `lib/scope-reference-audit.mjs`).
 *
 * The gate exists to catch one bug class: a name used outside the scope that declares
 * it, so the reference throws inside a failure/result path and the run produces no
 * artifact. This file proves, for each evidence class:
 *
 *   1. the three real `tools/live-run/` shapes are DETECTED (catch-references-try,
 *      sibling-function buffer, read-before-declaration);
 *   2. each finding comes from the RULE, not from the fixture — disabling that one
 *      rule on the identical source removes the finding (the mutation proof);
 *   3. the documented false-positive boundary HOLDS (host globals shadowed elsewhere,
 *      hoisted `var`, a closure defined before a later `const`, import aliases);
 *   4. a file that does not parse fails closed instead of producing scope findings;
 *   5. the CLI reports and exits non-zero, and the report is deterministic.
 *
 * Tests 1/2 are the honest pair: a finding that survives "detection disabled" is not
 * evidence of detection, and a fixture that produces no finding when the rule is on
 * would fail here rather than pass silently.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { analyzeSource, HOST_GLOBALS, PARSE_ERROR_RULE, SCOPE_REFERENCE_RULES } from "./lib/scope-reference-audit.mjs";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const CHECKER = path.join(HERE, "check-scope-references.mjs");

const OUT_OF_SCOPE = "out_of_scope_reference";
const READ_BEFORE_DECLARATION = "read_before_declaration";

async function analyze(source, options = {}) {
  const result = await analyzeSource(source, { fileName: "fixture.mjs", ...options });
  return result.findings;
}

async function runChecker(argumentsList) {
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

function summaryOf(findings) {
  return findings.map((finding) => ({ rule: finding.rule, name: finding.name, line: finding.line }));
}

// --- 1. the real bug shapes are detected -------------------------------------------

// Instance 1: the catch block reads a binding declared inside its `try`. Both blocks
// are separate scopes, so `size` is gone by the time the catch runs — and the catch
// only runs on failure, which is why the run produced no artifact at all.
const CATCH_REFERENCES_TRY = `function run() {
  try {
    const size = 1;
    write(size);
  } catch (error) {
    rollback(size);
  }
}
`;

// Instance 3: a buffer declared inside one function is pushed to from a module-level
// function. The sibling function is not enclosed by the buffer's scope.
const SIBLING_FUNCTION_BUFFER = `function collect(run) {
  const buffer = [];
  buffer.push(run);
  return buffer;
}
async function awaitTerminal(entry) {
  buffer.push(entry);
}
`;

test("a catch block reading a try-scoped binding is reported", async () => {
  const findings = await analyze(CATCH_REFERENCES_TRY);
  assert.deepEqual(summaryOf(findings), [{ rule: OUT_OF_SCOPE, name: "size", line: 6 }]);
  assert.match(findings[0].message, /run\(\)/);
});

test("a function reaching into a sibling function's local is reported", async () => {
  const findings = await analyze(SIBLING_FUNCTION_BUFFER);
  assert.deepEqual(summaryOf(findings), [{ rule: OUT_OF_SCOPE, name: "buffer", line: 7 }]);
  assert.match(findings[0].message, /awaitTerminal\(\)/);
});

test("the same binding used from the function that declares it is not reported", async () => {
  const findings = await analyze(`function collect(run) {
  const buffer = [];
  buffer.push(run);
  return buffer;
}
`);
  assert.deepEqual(findings, []);
});

// Instance 2: a top-level `const` reads a binding declared further down the same block.
const READ_BEFORE_DECLARATION_SOURCE = `function verdict() {
  const label = spoken ? "spoken" : "silent";
  const spoken = readSession();
  return label;
}
`;

test("a read before a later lexical declaration in the same scope is reported", async () => {
  const findings = await analyze(READ_BEFORE_DECLARATION_SOURCE);
  assert.deepEqual(summaryOf(findings), [{ rule: READ_BEFORE_DECLARATION, name: "spoken", line: 2 }]);
  assert.match(findings[0].message, /temporal dead zone/);
});

test("an ordinary declaration-then-use pair is not reported", async () => {
  const findings = await analyze(`function verdict() {
  const spoken = readSession();
  return spoken ? "spoken" : "silent";
}
`);
  assert.deepEqual(findings, []);
});

test("a finally-scoped binding used after the try statement is reported", async () => {
  // The failure-path shape that a live probe in `tools/` still carries.
  const findings = await analyze(`async function probe(input) {
  let primaryError = null;
  try {
    await measure(input);
  } catch (error) {
    primaryError = error;
  } finally {
    const logTail = await readLogTail(input);
    drain(logTail);
  }
  if (primaryError !== null) throw new Error(\`failed\${logTail}\`);
}
`);
  assert.deepEqual(summaryOf(findings), [{ rule: OUT_OF_SCOPE, name: "logTail", line: 11 }]);
});

// --- 2. the RULE produces the finding, not the fixture ------------------------------

test("disabling out_of_scope_reference removes exactly that finding", async () => {
  const enabled = await analyze(CATCH_REFERENCES_TRY);
  assert.equal(enabled.length, 1, "precondition: the fixture is detected with the rule on");
  const disabled = await analyze(CATCH_REFERENCES_TRY, {
    rules: SCOPE_REFERENCE_RULES.filter((rule) => rule !== OUT_OF_SCOPE),
  });
  assert.deepEqual(disabled, [], "with the rule disabled the identical source must be clean");
});

test("disabling read_before_declaration removes exactly that finding", async () => {
  const enabled = await analyze(READ_BEFORE_DECLARATION_SOURCE);
  assert.equal(enabled.length, 1, "precondition: the fixture is detected with the rule on");
  const disabled = await analyze(READ_BEFORE_DECLARATION_SOURCE, {
    rules: SCOPE_REFERENCE_RULES.filter((rule) => rule !== READ_BEFORE_DECLARATION),
  });
  assert.deepEqual(disabled, [], "with the rule disabled the identical source must be clean");
});

test("a broken declaration order is invisible to the out_of_scope rule alone", async () => {
  // Inverse control: the two rules are independent, so neither one alone explains
  // both findings. If a change made one rule swallow the other, this fails.
  const findings = await analyze(READ_BEFORE_DECLARATION_SOURCE, { rules: [OUT_OF_SCOPE] });
  assert.deepEqual(findings, []);
});

// --- 3. the documented false-positive boundary --------------------------------------

test("a host global shadowed elsewhere in the file is not reported", async () => {
  // `function f(process, ...)` binds `process` locally, so every ordinary `process.env`
  // in the same file would otherwise look like a cross-scope leak.
  const findings = await analyze(`export function verifyLaunchedProcess(process, gamePath) {
  return process.imagePath === gamePath;
}
export function readEnvironment() {
  return process.env.GAMEBUDDY_STARDEW_GAME_PATH;
}
`);
  assert.deepEqual(findings, []);
  assert.ok(HOST_GLOBALS.has("process"), "process must stay on the host-global list");
});

test("a name the file never declares is never reported", async () => {
  const findings = await analyze(`export function read() {
  return notDeclaredAnywhereInThisFile.value;
}
`);
  assert.deepEqual(findings, []);
});

test("a var hoisted out of a nested block resolves at the function scope", async () => {
  const findings = await analyze(`export function pick(flag) {
  if (flag) {
    var resolved = compute();
  }
  return resolved;
}
`);
  assert.deepEqual(findings, []);
});

test("a closure defined before a later module-level const is not a temporal dead zone", async () => {
  const findings = await analyze(`export function later() {
  return PINNED;
}
export const PINNED = 42;
`);
  assert.deepEqual(findings, []);
});

test("an import alias plus a local of the imported name is not reported", async () => {
  // The alias is the local binding; the foreign name is not a reference of this module.
  const findings = await analyze(`import { execFile as execFileCallback } from "node:child_process";
const execFile = promisify(execFileCallback);
export { execFile, execFileCallback };
`);
  assert.deepEqual(findings, []);
});

test("a re-export names neither a binding nor a reference of this module", async () => {
  const findings = await analyze(`export { alpha as beta } from "./mod.mjs";
`);
  assert.deepEqual(findings, []);
});

test("for-of loop heads, destructuring, and class members resolve normally", async () => {
  const findings = await analyze(`export class Ledger {
  #rows = new Map();
  record({ key, value = 0 } = {}, ...rest) {
    for (const entry of rest) this.#rows.set(key, entry + value);
    return [...this.#rows];
  }
}
`);
  assert.deepEqual(findings, []);
});

test("a recursive named function expression resolves to its own name", async () => {
  const findings = await analyze(`export const walk = function step(node) {
  return node.next === null ? node : step(node.next);
};
`);
  assert.deepEqual(findings, []);
});

// --- 4. parse failures fail closed ---------------------------------------------------

test("a file that does not parse reports parse_error and no scope findings", async () => {
  // Structural breakage (here an unclosed declaration plus the shadowed catch-run
  // bug from above) must fail closed: reporting scope findings from a recovered
  // parse tree would be reporting on text the parser did not understand.
  const findings = await analyze(`const broken = ;
function run() {
  try {
    const size = 1;
  } catch {
    rollback(size);
  }
}
`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, PARSE_ERROR_RULE);
  assert.equal(findings[0].name, null);
});

test("parse_error cannot be disabled by the scope rule list", async () => {
  const findings = await analyze("const broken = ;\n", { rules: [] });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].rule, PARSE_ERROR_RULE);
});

test("the grammar is a superset, so parse_error is not a node --check replacement", async () => {
  // tree-sitter accepts a top-level `return` that V8 rejects as an early error, so
  // a file whose only defect is that shape reports nothing here. `node --check`
  // owns early-error coverage; this gate owns scope resolution.
  assert.deepEqual(await analyze("return 1;\n"), []);
});

// --- 5. the CLI ----------------------------------------------------------------------

test("the CLI reports a finding and exits non-zero", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gamebuddy-scope-ref-"));
  try {
    await writeFile(path.join(directory, "broken.mjs"), CATCH_REFERENCES_TRY, "utf8");
    const result = await runChecker([directory]);
    assert.equal(result.code, 1, `expected a failing gate; stderr: ${result.stderr}`);
    assert.match(result.stdout, /broken\.mjs:6:\d+\s+out_of_scope_reference/u);
    assert.match(result.stdout, /scope-reference gate: 1 files scanned, 1 findings/u);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("the CLI exits zero when the only rule that would fire is disabled", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gamebuddy-scope-ref-"));
  try {
    await writeFile(path.join(directory, "broken.mjs"), CATCH_REFERENCES_TRY, "utf8");
    const result = await runChecker([directory, "--rules", READ_BEFORE_DECLARATION]);
    assert.equal(result.code, 0, `expected a passing gate; stdout: ${result.stdout}`);
    assert.match(result.stdout, /0 findings/u);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("the CLI --json report is structured, repo-relative, and deterministic", async () => {
  const first = await runChecker(["tools/live-run", "--json"]);
  const second = await runChecker(["tools/live-run", "--json"]);
  assert.equal(first.code, second.code, "the same tree must produce the same exit code");
  assert.equal(first.stdout, second.stdout, "the report must be byte-identical across runs");
  const report = JSON.parse(first.stdout);
  assert.ok(report.filesScanned >= 10, `expected the live-run tree to be scanned; got ${report.filesScanned}`);
  for (const finding of report.findings) {
    assert.ok(!path.isAbsolute(finding.fileName), `finding paths stay repo-relative: ${finding.fileName}`);
    assert.ok(SCOPE_REFERENCE_RULES.includes(finding.rule) || finding.rule === PARSE_ERROR_RULE);
    assert.ok(Number.isInteger(finding.line) && finding.line >= 1);
    assert.ok(typeof finding.message === "string" && finding.message.length > 0);
  }
  assert.deepEqual(Object.keys(report.counts), [PARSE_ERROR_RULE, ...SCOPE_REFERENCE_RULES]);
});

test("the CLI rejects an unknown extension instead of silently skipping files", async () => {
  const result = await runChecker(["tools/live-run", "--ext", ".coffee"]);
  assert.equal(result.code, 1);
  assert.match(`${result.stdout}${result.stderr}`, /no grammar for extension/u);
});
