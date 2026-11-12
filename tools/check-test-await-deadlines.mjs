#!/usr/bin/env node
/**
 * The gate for "a test awaited a fact that can never arrive" - a promise a listener settles, awaited with no deadline.
 *
 * WHY (measured 2026-11-12): `host/src/local-stardew-bridge.test.ts` awaited `onConnectionFact` for a duplicate-key
 * frame. Commit 39588596 took the strict scanner off the receive path (it decoded every inbound frame's bytes twice,
 * 0.0283 ms against 0.0031 ms median on one frame), so the close that await was written for can no longer happen.
 * Alone, at ~0% CPU, that test ran until the suite's 600 s budget killed it - and every host suite run paid those ten
 * minutes while the other thirty tests in the file summed 391 ms. A hang reports nothing; this gate is what makes the
 * next one impossible to write quietly.
 *
 * THE POPULATION, derived by parsing and not by grep: every `await` in the tests under `host/src` (suffix `.test.ts`)
 * and under `host/scripts` (suffix `.test.mjs`) whose operand is a promise a listener registration settles - a call
 * whose callee is a property access named `on<Capital>` (`client.onConnectionFact`, `client.onFact`,
 * `emitter.onEvent`), reached directly, through the identifier a `new Promise(...)` was assigned to, or through a
 * `Promise.race` or a local helper wrapping one of those. Comments and strings are never descended into, so a docblock
 * naming the defect is not the defect. At the commit that added this gate the reading was `awaits examined 12 · with a
 * deadline 0 · without 12`, all twelve in one file; it is what the gate printed while it was red.
 *
 * THE PROPERTY: the awaited promise is raced against a bounded deadline - a `Promise.race` with an element that builds a
 * timer (`setTimeout`/`setInterval`/`setImmediate`, a name imported from `node:timers/promises`, or a local function
 * whose body calls one, which is how `timeout(5_000)` reads) or a call to a local helper that does - or the
 * `new Promise` executor sets its own timeout at construction. A member without it waits out the runner's budget on a
 * fact nobody is going to publish; the finding names the file, the line and the promise expression.
 *
 * WHAT IS OUTSIDE THIS POPULATION, counted rather than left unsaid (2026-11-12): `events.once(emitter, "event")` and
 * lowercase `emitter.on(...)` callbacks are the transport-level analogue of the same hang - 18 such awaits exist in
 * this tree and none carries a deadline - but they settle on objects the test itself owns (a child process, a local
 * HTTP response), which makes them a different lane's debt rather than this gate's false green.
 *
 * ZERO POPULATION BLOCKS. A scan that finds no listener await in 436 test files has lost its reader, not fixed the
 * class, and "awaits examined 0 · with a deadline 0 · without 0" is a sentence that agrees with itself.
 *
 * Usage:
 *   node tools/check-test-await-deadlines.mjs               # the gate; exit 0 passed, 1 failed, 2 blocked
 *   node tools/check-test-await-deadlines.mjs --json        # the reading, machine-readable
 *   node tools/check-test-await-deadlines.mjs --root <dir>  # the gate's own fixture
 *
 * red-proof: inject  reverting the duplicate-key test in `local-stardew-bridge.test.ts` to the bare
 *            `assert.deepEqual(await disconnected, ...)` -> `await_without_deadline:<file>:882:disconnected`, green
 *            again once the await goes through `factWithinDeadline` (tools/check-test-await-deadlines.test.mjs)
 */
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The two directories whose tests can await a listener, and the suffix that makes a file one of them.
 *
 * `host/src` holds the bridge, event-pump and launcher tests that register on a live client; `host/scripts` holds the
 * build and release tests that register on a child process's events.
 */
const TEST_AWAIT_SCOPES = Object.freeze([
  { directory: "host/src", suffix: ".test.ts" },
  { directory: "host/scripts", suffix: ".test.mjs" },
]);

/** A listener registration: a property access named `on<Capital>`. Bare `onX(…)` names a callback, not a registration. */
const LISTENER_PROPERTY = /^on[A-Z]/u;

/** The globals that build a timer, plus whatever a file imports from `node:timers/promises`. */
const TIMER_GLOBALS = new Set(["setTimeout", "setInterval", "setImmediate"]);

/** How many helper hops a reader follows before it stops attributing a timer to a name. */
const MAX_HELPER_DEPTH = 4;

/** What each verdict exits with: a violation is a failure, and a scan that measured nothing is neither. */
const EXIT_STATUS = Object.freeze({ passed: 0, failed: 1, blocked: 2 });

/** Past a parenthesised/cast/non-null wrapper, the expression that decides something. */
function unwrapExpression(node, typescript) {
  let current = node;
  while (
    typescript.isParenthesizedExpression(current) ||
    typescript.isAsExpression(current) ||
    typescript.isSatisfiesExpression(current) ||
    typescript.isNonNullExpression(current) ||
    typescript.isAwaitExpression(current)
  )
    current = current.expression;
  return current;
}

/** The name a call's callee answers to, and whether it was written as a property access. */
function calleeOf(callee, typescript) {
  if (callee === undefined) return null;
  if (typescript.isIdentifier(callee)) return { name: callee.text, property: false };
  if (typescript.isPropertyAccessExpression(callee)) return { name: callee.name.text, property: true };
  return null;
}

/** Whether any call inside `node` satisfies `predicate`, never descending into a comment or a string. */
function callsMatching(node, predicate, typescript) {
  let found = false;
  const visit = (child) => {
    if (found) return;
    if (typescript.isCallExpression(child) && predicate(child)) {
      found = true;
      return;
    }
    typescript.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

/**
 * Every test file in the population, as repo-relative paths sorted so two runs read the same tree the same way.
 *
 * `root` is the checkout being read; a missing directory is an empty list rather than an error, so a fixture with one
 * scope present still measures the files it has.
 */
function populationFiles({ root = REPOSITORY_ROOT, scopes = TEST_AWAIT_SCOPES } = {}) {
  const files = [];
  for (const scope of scopes) {
    const walk = (directory) => {
      let entries;
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile() && entry.name.endsWith(scope.suffix))
          files.push(path.slice(root.length + 1).replace(/\\/gu, "/"));
      }
    };
    walk(join(root, scope.directory));
  }
  return files.sort();
}

/**
 * The reader for one syntax tree: which awaited operands are listener promises, and which of those carry a deadline.
 *
 * Everything is resolved inside the file - the `new Promise` an identifier holds, the local function that builds a
 * timer, the names a file imported from `node:timers/promises` - so the reading follows the tree's own text instead of
 * a table of names this gate would have to keep current.
 */
function readerFor(ast, typescript) {
  const timerNames = new Set();
  const localBodies = new Map();
  const variables = new Map();

  const visitDeclarations = (node) => {
    if (typescript.isImportDeclaration(node) && node.moduleSpecifier.text === "node:timers/promises") {
      const bindings = node.importClause?.namedBindings;
      if (bindings !== undefined && typescript.isNamedImports(bindings))
        for (const element of bindings.elements) timerNames.add(element.name.text);
    }
    if (typescript.isFunctionDeclaration(node) && node.name !== undefined && node.body !== undefined)
      localBodies.set(node.name.text, node.body);
    if (
      typescript.isVariableDeclaration(node) &&
      typescript.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      variables.set(node.name.text, node.initializer);
      const initializer = unwrapExpression(node.initializer, typescript);
      if (typescript.isArrowFunction(initializer) || typescript.isFunctionExpression(initializer))
        localBodies.set(node.name.text, initializer.body);
    }
    typescript.forEachChild(node, visitDeclarations);
  };
  visitDeclarations(ast);

  const buildsTimer = (node, depth = 0) => {
    if (depth > MAX_HELPER_DEPTH || !typescript.isCallExpression(node)) return false;
    const callee = calleeOf(unwrapExpression(node.expression, typescript), typescript);
    if (callee === null || callee.property) return false;
    if (TIMER_GLOBALS.has(callee.name) || timerNames.has(callee.name)) return true;
    const body = localBodies.get(callee.name);
    return body !== undefined && callsMatching(body, (call) => buildsTimer(call, depth + 1), typescript);
  };

  const isListenerRegistration = (call) => {
    const callee = calleeOf(unwrapExpression(call.expression, typescript), typescript);
    return callee !== null && callee.property && LISTENER_PROPERTY.test(callee.name);
  };

  const isRace = (node) => {
    const callee = calleeOf(unwrapExpression(node.expression, typescript), typescript);
    return callee !== null && callee.property && callee.name === "race";
  };

  const isDeadlineHelper = (node) => {
    const callee = calleeOf(unwrapExpression(node.expression, typescript), typescript);
    if (callee === null) return false;
    const body = localBodies.get(callee.name);
    return body !== undefined && callsMatching(body, (call) => buildsTimer(call), typescript);
  };

  const isListenerPromise = (node, depth = 0) => {
    if (depth > MAX_HELPER_DEPTH) return false;
    const value = unwrapExpression(node, typescript);
    if (typescript.isIdentifier(value)) {
      const initializer = variables.get(value.text);
      return initializer !== undefined && isListenerPromise(initializer, depth + 1);
    }
    if (typescript.isNewExpression(value)) {
      return (value.arguments ?? []).some((argument) => callsMatching(argument, isListenerRegistration, typescript));
    }
    if (typescript.isCallExpression(value)) {
      if (isListenerRegistration(value)) return true;
      if (!(isRace(value) || isDeadlineHelper(value))) return false;
      return value.arguments.some((argument) =>
        typescript.isArrayLiteralExpression(unwrapExpression(argument, typescript))
          ? unwrapExpression(argument, typescript).elements.some((element) => isListenerPromise(element, depth + 1))
          : isListenerPromise(argument, depth + 1),
      );
    }
    return false;
  };

  const hasDeadline = (node, depth = 0) => {
    if (depth > MAX_HELPER_DEPTH) return false;
    const value = unwrapExpression(node, typescript);
    if (typescript.isIdentifier(value)) {
      const initializer = variables.get(value.text);
      return initializer !== undefined && hasDeadline(initializer, depth + 1);
    }
    if (typescript.isNewExpression(value)) return callsMatching(value, buildsTimer, typescript);
    if (typescript.isCallExpression(value)) {
      if (isDeadlineHelper(value)) return true;
      if (!isRace(value)) return false;
      return value.arguments.some((argument) => {
        const list = typescript.isArrayLiteralExpression(unwrapExpression(argument, typescript))
          ? unwrapExpression(argument, typescript).elements
          : [argument];
        return list.some((element) => callsMatching(element, (call) => buildsTimer(call), typescript));
      });
    }
    return false;
  };

  return { isListenerPromise, hasDeadline };
}

/** The whole reading: every listener await in the population, with whether it is raced against a deadline. */
export function auditTestAwaitDeadlines({ root = REPOSITORY_ROOT, scopes = TEST_AWAIT_SCOPES } = {}) {
  const typescript = createRequire(join(REPOSITORY_ROOT, "host", "package.json"))("typescript");
  const files = populationFiles({ root, scopes });
  const awaits = [];
  const unparsed = [];
  for (const file of files) {
    const source = readFileSync(join(root, file), "utf8");
    const ast = typescript.createSourceFile(
      file,
      source,
      typescript.ScriptTarget.Latest,
      true,
      file.endsWith(".ts") ? typescript.ScriptKind.TS : typescript.ScriptKind.JS,
    );
    if (ast.parseDiagnostics !== undefined && ast.parseDiagnostics.length > 0) {
      unparsed.push(`${file}: ${String(ast.parseDiagnostics[0].messageText)}`);
      continue;
    }
    const reader = readerFor(ast, typescript);
    const visit = (node) => {
      if (
        typescript.isAwaitExpression(node) &&
        node.expression !== undefined &&
        reader.isListenerPromise(node.expression)
      ) {
        const { line } = ast.getLineAndCharacterOfPosition(node.getStart(ast));
        awaits.push({
          file,
          line: line + 1,
          promiseSource: node.expression.getText(ast).replace(/\s+/gu, " ").trim().slice(0, 200),
          withDeadline: reader.hasDeadline(node.expression),
        });
      }
      typescript.forEachChild(node, visit);
    };
    visit(ast);
  }
  const without = awaits.filter((entry) => !entry.withDeadline);
  return {
    files: files.length,
    awaits,
    withDeadline: awaits.length - without.length,
    without,
    findings: without.map((entry) => `await_without_deadline:${entry.file}:${entry.line}:${entry.promiseSource}`),
    unparsed,
  };
}

/** The verdict: a scan that read no file, or found no listener await, measured nothing and cannot pass. */
export function statusOf({ files, awaits, unparsed }) {
  if (files === 0 || awaits.length === 0) return "blocked";
  if (unparsed.length > 0) return "failed";
  return awaits.some((entry) => !entry.withDeadline) ? "failed" : "passed";
}

function main(argv) {
  const rootIndex = argv.indexOf("--root");
  const root =
    rootIndex >= 0 && typeof argv[rootIndex + 1] === "string" ? resolve(argv[rootIndex + 1]) : REPOSITORY_ROOT;
  const json = argv.includes("--json");
  const reading = auditTestAwaitDeadlines({ root });
  const status = statusOf(reading);
  const checks = [
    {
      id: "test_files_examined",
      status: reading.files === 0 ? "blocked" : "passed",
      detail: `${reading.files} test file(s) under ${TEST_AWAIT_SCOPES.map((scope) => scope.directory).join(", ")}`,
    },
    {
      id: "listener_awaits_found",
      status: reading.awaits.length === 0 ? "blocked" : "passed",
      detail: `${reading.awaits.length} await(s) on a promise a listener settles`,
    },
    {
      id: "every_listener_await_has_a_deadline",
      status: reading.without.length === 0 ? "passed" : "failed",
      detail: `${reading.without.length} without a deadline`,
    },
    {
      id: "every_test_file_parsed",
      status: reading.unparsed.length === 0 ? "passed" : "failed",
      detail: `${reading.unparsed.length} unread file(s)`,
    },
  ];
  const report = {
    gate: "test-await-deadlines",
    status,
    examined: reading.awaits.length,
    files: reading.files,
    withDeadline: reading.withDeadline,
    without: reading.without.length,
    checks,
    findings: reading.findings,
    unparsed: reading.unparsed,
  };
  if (json) process.stdout.write(`${JSON.stringify(report)}\n`);
  else {
    process.stdout.write(
      `awaits examined ${report.examined} · with a deadline ${report.withDeadline} · without ${report.without}` +
        ` · files ${report.files}\n`,
    );
    for (const check of checks) process.stdout.write(`  ${check.id}: ${check.status} (${check.detail})\n`);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  }
  for (const finding of reading.findings) process.stderr.write(`${finding}\n`);
  for (const line of reading.unparsed) process.stderr.write(`test_file_unparsed: ${line}\n`);
  if (reading.files === 0)
    process.stderr.write(
      "test_await_deadlines: no test file was read, so nothing can be judged; a green run reads examined>=1\n",
    );
  else if (reading.awaits.length === 0)
    process.stderr.write(
      "test_await_deadlines: no listener await was found in the population, which is a scan that lost its reader, " +
        "not a class that went away\n",
    );
  process.exitCode = EXIT_STATUS[status];
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2));
