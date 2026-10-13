/**
 * A gate must assert the rule it checks, not where the code sits today.
 *
 * Three gates failed in one day for the same reason: each pinned an absolute line
 * number in a real source file (`management-surface-panels.tsx:304`,
 * `i18n.ts:444`) and went red the moment an unrelated edit shifted the file down,
 * even though the invariant each named still held. The failure was noise, and the
 * tempting repair - bump the number - guarantees the next edit re-breaks it.
 *
 * This gate fails when a gate source *itself* contains a hardcoded position in a
 * file that exists on disk: a `path:line` string literal such as
 * `"src/i18n.ts:444"` or `"src/components/x.tsx:304 <button>"`. The precise signal
 * is a path that resolves to a real file, so a *synthetic* probe name
 * (`src/components/Mutation.tsx:2`, a source that exists only inside the test) is
 * not a finding: its line is intrinsic to the test's own text and can never drift.
 * A route assembled at runtime - `` `${file}:${line}` `` - is a template
 * expression, not a string literal, so it is never reported either.
 *
 * Scope, deliberately: the rule matches the observable shape (`path:N`) rather
 * than "a number near a path". The broader heuristic the defect suggests
 * (`/\b\d{3,}\s*(===|!==|,|\))/`) cannot be made trustworthy - counts, thresholds
 * and ratios are legitimate numeric assertions, and a rule that cries wolf is
 * deleted. `path:N` is exact: it names a file that exists and a position inside
 * it, which is exactly the class and nothing else.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIALOGUE_WEB = join(HERE, "..");
const REPO = join(DIALOGUE_WEB, "..");

/** A `path:line` reference inside a string literal: `src/i18n.ts:444`. */
const PINNED_LOCATION = /([\w][\w./@-]*\.(?:ts|tsx|mjs|js|css|html)):(\d+)\b/gu;

/** Every static gate suite in this directory. */
export function gateSources(directory = HERE) {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".test.mjs"))
    .sort()
    .map((name) => join(directory, name));
}

/** True when `path` names a file that really exists, from this package or the repo root. */
function resolves(path) {
  return [join(DIALOGUE_WEB, path), join(REPO, path)].some((candidate) => existsSync(resolve(candidate)));
}

/** Every hardcoded location in the `path:line` string literals of one gate source. */
export function pinnedLocations(text, fileName) {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found = [];
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      for (const match of node.text.matchAll(PINNED_LOCATION)) {
        if (!resolves(match[1])) continue;
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        const source = fileName.replace(/\\/gu, "/").split("/").pop();
        found.push({ at: `${source}:${line + 1}`, path: match[1], line: Number(match[2]) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

test("gate-pinning.1: a gate locates its finding at runtime, never by a line number", (t) => {
  const failures = [];
  let sources = 0;
  for (const file of gateSources()) {
    sources += 1;
    for (const pinned of pinnedLocations(readFileSync(file, "utf8"), file))
      failures.push(
        `${pinned.at}: ${pinned.path}:${pinned.line} is an absolute position; assert the rule and derive the route at runtime`,
      );
  }
  t.diagnostic(`gate-pinning.1: ${sources} gate source(s) scanned, ${failures.length} hardcoded location(s)`);
  assert.deepEqual(failures, [], "a gate must assert the rule it checks, not where the code sits today");
});

test("gate-pinning.2 (mutation): a real-file pin is reported; a bare path and a synthetic probe are not", (t) => {
  const realPath = ["src", "i18n.ts"].join("/");
  const pinned = `assert.equal(entry.line, "${realPath}:7");`;
  assert.deepEqual(
    pinnedLocations(pinned, "probe.test.mjs").map((entry) => `${entry.path}:${entry.line}`),
    [`${realPath}:7`],
  );
  const mention = `assert.ok(existsSync("${realPath}"));`;
  assert.deepEqual(pinnedLocations(mention, "probe.test.mjs"), []);
  const synthetic = 'assert.equal(control.line, "src/components/Mutation.tsx:2");';
  assert.deepEqual(pinnedLocations(synthetic, "probe.test.mjs"), []);
  t.diagnostic("gate-pinning.2: a `path:line` literal is reported; a bare path and a synthetic probe are not");
});
