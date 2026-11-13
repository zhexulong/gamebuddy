#!/usr/bin/env node
/**
 * The gate for "a test froze a count the product owns" - as a POPULATION question.
 *
 * WHY (four instances in one night, 2026-11-05; provenance for the primitive in tools/lib/member-diff.mjs)
 *
 *   `expected 28 to equal 15`  a test froze "15 registered seams that all nine predicates reject" and the
 *                              authority held 28; the failure quoted two numbers and no member.
 *   `13 -> 15`                 a frozen key table grew by two keys.
 *   `66 of 68`                 a legal growth became 67 of 69.
 *   `advance_day -> sleep`     a rename left the assertion pointing at the old name.
 *
 * The class is one shape: an assertion whose expected side is a NUMBER LITERAL of a `.length`. The number
 * goes stale the moment the authority behind it grows or renames, and the diff it produces - "Expected
 * 15, got 13" - names neither the members that arrived nor the one that left. So the literal is banned
 * outright; the assertion has to compare the population itself:
 *
 *   assert.deepEqual(new Set(actual), new Set(AUTHORITY))    // the assertion
 *   describeMemberDiff("registered seams", actual, AUTHORITY)  // its message, naming the drift
 *
 * Two derived sides are fine: `assert.equal(snapshot.seams.length, AUTHORITY.length)` names an authority
 * on both sides, so it cannot go stale on its own - it reports the drift instead of freezing it.
 *
 * WHAT IS READ, and why syntax rather than a grep: this file's own fixtures spell the defect inside
 * string and template literals, and a comment in tools/lib/harness-conformance.mjs could spell it too. A
 * line scanner cannot tell those from code and would have to carry an exception, so the reading is the
 * syntax tree (tools/lib/javascript-ast.mjs): comments and strings are never descended into, and the line
 * number is the node's own.
 *
 * Usage:
 *   node tools/check-derived-population.mjs             # the gate; exit 1 on a violation or empty population
 *   node tools/check-derived-population.mjs --json      # the reading, machine-readable
 *   node tools/check-derived-population.mjs --root <dir>  # the gate's own fixture
 *
 * WHY IT IS NOT SCHEDULED, measured 2026-11-13: `examined 980, violations 1222, unread 0`. The class is ONE shape and
 * the literal's value is what splits it:
 *
 *   645 `=== 1`   291 `=== 0`   137 `=== 2`   61 `=== 3-4`   36 `=== 5-9`   51 `=== 10+`   1 non-numeric
 *   by root: host 641 · tools 488 · integrations 49 · dialogue-web 44
 *
 * 1073 of the 1222 (88%) are a literal 0, 1 or 2, and a boundary about a scenario the test itself builds is not the
 * defect this file was written for: `list.length === 0` after a removal, `=== 1` for the one reply that came back, or
 * `=== 2` for a pair are assertions whose authority is the fixture declared three lines above them. This file reads
 * syntax, so it cannot tell that fixture from a product-owned population - which is why the count is 1222 and not the
 * handful that will actually drift.
 *
 * The 148 in the 3-and-up band are where the defect lives, and inside `tools/` there are 62 of them in 40 files. The
 * ones inspected split the same way: most are fixture counts too (`page.asked === 5`, `merged.rows === 4`, a capture
 * fixture's 11082 bytes, `published.turns === 46`), and the genuine freezes have no derived side in the file that
 * holds them - `tools/check-refusal-informativeness.test.mjs`'s `actions.length === 95` and its 70 target-bound
 * actions are the published surface's size, and `tools/check-stardew-tool-family-stamina-evidence.test.mjs`'s
 * `Object.keys(STARDEW_TOOL_FAMILY).length === 12` is that table's size; clearing either means deriving the member set
 * (from the generator of `action-surface.v1.json`, and from the Mod's `DoFunction`-driving handlers), which is a gate to
 * write rather than an assertion to edit. Replacing them with a hand-written list of the expected members would be the
 * same defect with more text in it.
 *
 * So the gate stays OFF, and the reason is this reading rather than a promise: it becomes schedulable when the 3-and-up
 * band reaches zero, or when the file learns the discrimination it is missing - a count whose authority is declared in
 * the same file it is asserted in, or whose receiver is a literal the test built, is not a frozen population. Until one
 * of those is true, switching it on would red the tree for 1222 assertions and teach its readers to ignore it.
 *
 * red-proof: inject  `assert.equal(list.length, 15)` in a test file ->
 *            `literal_population_assertion:<file>:<line>:15 - use list.length or assert.deepEqual(...)`, green
 *            for `assert.equal(list.length, AUTHORITY.length)` (tools/check-derived-population.test.mjs)
 *
 * Also injected, each seen red once (tools/check-derived-population.test.mjs): the same literal on the left
 * of the assertion, a bare `list.length === 15`, two derived sides reported as a literal, every file in a
 * directory treated as a test, an unsorted member diff, an empty population treated as a pass, and a
 * raw-text sweep in place of the syntax tree - which names the defect inside a comment and a string.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseJavaScript } from "./lib/javascript-ast.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The directories whose tests can freeze a population, and the suffix that makes a file one of them.
 * `under` narrows a directory whose tests live in a `tests/` segment (`integrations/<integration>/tests`).
 */
export const POPULATION_SCOPE = Object.freeze([
  { directory: "host/src", suffix: ".test.ts" },
  { directory: "dialogue-web/tests", suffix: ".ts" },
  { directory: "tools", suffix: ".test.mjs" },
  { directory: "integrations", suffix: ".mjs", under: "tests" },
]);

/** The assertion helpers that compare a value with an expectation. */
const ASSERTING_METHODS = new Set(["equal", "strictEqual"]);

/** The operators that compare directly, without a helper. */
const COMPARING_OPERATORS = new Set(["===", "=="]);

/** Node types whose text is data, not code: descending into them is how a gate starts reading prose. */
const OPAQUE = new Set(["comment", "string", "template_string", "regex"]);

/** Whether a file under `scope.directory` is one of that scope's tests: its suffix, and its `under` segment. */
function isPopulationFile(relativePath, scope) {
  if (!relativePath.endsWith(scope.suffix)) return false;
  if (scope.under === undefined) return true;
  return relativePath.split("/").slice(0, -1).includes(scope.under);
}

/** Every file in the scope, sorted so the reading is the same on every run. */
export function populationFiles({ root = REPOSITORY_ROOT, scope = POPULATION_SCOPE } = {}) {
  const found = new Set();
  for (const candidate of scope) {
    const walk = (directory, relativePath) => {
      let entries;
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const path = `${directory}/${entry.name}`;
        const relative = `${relativePath}/${entry.name}`;
        if (entry.isDirectory()) {
          // A checked-out revision, a capture root or an installed dependency is not this tree's tests.
          if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
          walk(path, relative);
        } else if (isPopulationFile(relative, candidate)) {
          found.add(path);
        }
      }
    };
    walk(`${root}/${candidate.directory}`, candidate.directory);
  }
  return [...found].sort();
}

/** A `x.length` access, whose expected side must never be a literal. */
function lengthOf(node) {
  if (node?.type !== "member_expression") return null;
  const property = node.childForFieldName("property");
  if (property?.type !== "property_identifier" || property.text !== "length") return null;
  const object = node.childForFieldName("object");
  return { node, authority: object === null ? node.text.slice(0, -".length".length) : object.text };
}

function isLiteralCount(node) {
  return node?.type === "number" && /^\d[\d_]*$/u.test(node.text);
}

function isAssertObject(node) {
  if (node === null) return false;
  if (node.type === "identifier") return node.text === "assert";
  if (node.type === "member_expression") return node.childForFieldName("property")?.text === "assert";
  return false;
}

function operatorOf(node) {
  return node.children
    .filter((child) => !child.isNamed)
    .map((child) => child.text)
    .join("");
}

/**
 * One comparison whose expected side is a literal: `side` is the `.length` access and `literal` the number it
 * is compared with, in either order. Two `.length` sides are an authority comparison and say nothing here.
 */
function literalComparison([left, right], operator) {
  for (const [side, other] of [
    [lengthOf(left), right],
    [lengthOf(right), left],
  ]) {
    if (side === null || !isLiteralCount(other)) continue;
    return { ...side, literal: other.text, operator };
  }
  return null;
}

/** The literal comparison a node makes, if it is one: an assertion call, or a bare `===`/`==`. */
function comparisonIn(node) {
  if (node.type === "call_expression") {
    const callee = node.childForFieldName("function");
    if (callee?.type !== "member_expression") return null;
    const method = callee.childForFieldName("property")?.text;
    if (!ASSERTING_METHODS.has(method)) return null;
    if (!isAssertObject(callee.childForFieldName("object"))) return null;
    return literalComparison(node.childForFieldName("arguments")?.namedChildren ?? [], method);
  }
  if (node.type !== "binary_expression") return null;
  const operator = operatorOf(node);
  if (!COMPARING_OPERATORS.has(operator)) return null;
  return literalComparison([node.childForFieldName("left"), node.childForFieldName("right")], operator);
}

/** Every literal comparison in a file, in source order. */
function literalComparisons(tree) {
  const found = [];
  const visit = (node) => {
    if (OPAQUE.has(node.type)) return;
    const comparison = comparisonIn(node);
    if (comparison !== null) found.push(comparison);
    for (const child of node.namedChildren) visit(child);
  };
  visit(tree.rootNode);
  return found;
}

const messageOf = ({ file, line, literal, authority }) =>
  `literal_population_assertion:${file}:${line}:${literal} — use ${authority}.length or ` +
  `assert.deepEqual(new Set(actual), new Set(AUTHORITY))`;

const hintOf = ({ authority }) =>
  `name the drift instead of counting it: describeMemberDiff("${authority}", actual, AUTHORITY) reads ` +
  `"+ newly added: [...]" and "- missing: [...]" (tools/lib/member-diff.mjs)`;

/**
 * The whole reading: every test file in the scope, parsed, and every comparison between a `.length` and a
 * number literal in it. `examined` is the population, so a reading that measured nothing is visible as
 * `examined 0` rather than as a clean run; `unparsed` is a file the grammar could not read, which is not
 * the same as a file with no finding and is reported as `unread` on every run.
 */
export async function auditDerivedPopulation({ root = REPOSITORY_ROOT, scope = POPULATION_SCOPE } = {}) {
  const files = populationFiles({ root, scope });
  const violations = [];
  const unparsed = [];
  for (const path of files) {
    const file = path.slice(root.length + 1);
    const source = readFileSync(path, "utf8");
    let tree;
    try {
      tree = await parseJavaScript(source, path);
    } catch (error) {
      unparsed.push(`${file}: ${error.message}`);
      continue;
    }
    if (tree.rootNode.hasError) {
      unparsed.push(`${file}: the grammar left an ERROR node, so its comparisons were not all read`);
      continue;
    }
    for (const found of literalComparisons(tree)) {
      const entry = {
        file,
        line: found.node.startPosition.row + 1,
        literal: found.literal,
        authority: found.authority,
        operator: found.operator,
      };
      violations.push({
        code: "literal_population_assertion",
        ...entry,
        message: messageOf(entry),
        hint: hintOf(entry),
      });
    }
  }
  violations.sort(byFileThenLine);
  return { examined: files.length, violations, unparsed };
}

/** Source order: the file, then the line, so two runs over one tree print the same list. */
function byFileThenLine(left, right) {
  if (left.file !== right.file) return left.file < right.file ? -1 : 1;
  return left.line - right.line;
}

/** Per-file counts, which is how a debt of this size is handed to the lanes that own the files. */
export function byFile(violations) {
  const counts = new Map();
  for (const violation of violations) counts.set(violation.file, (counts.get(violation.file) ?? 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1));
}

/** The verdict: a reading that examined nothing cannot pass, whatever it found. */
function statusOf({ examined, violations }) {
  if (examined === 0) return "blocked";
  if (violations.length > 0) return "failed";
  return "passed";
}

function main(argv) {
  const rootIndex = argv.indexOf("--root");
  const root =
    rootIndex >= 0 && typeof argv[rootIndex + 1] === "string" ? resolve(argv[rootIndex + 1]) : REPOSITORY_ROOT;
  const json = argv.includes("--json");
  auditDerivedPopulation({ root })
    .then(({ examined, violations, unparsed }) => {
      const status = statusOf({ examined, violations });
      const reading = { gate: "derived-population", examined, violations, unparsed, status };
      if (json) process.stdout.write(`${JSON.stringify(reading)}\n`);
      else {
        process.stdout.write(
          `derived_population examined ${examined} violations ${violations.length} unread ${unparsed.length} ` +
            `status ${status}\n`,
        );
        for (const [file, count] of byFile(violations)) process.stdout.write(`  ${file}: ${count}\n`);
        process.stdout.write(`${JSON.stringify(reading)}\n`);
      }
      for (const violation of violations) {
        process.stderr.write(`${violation.message}\n  ${violation.hint}\n`);
      }
      for (const line of unparsed) process.stderr.write(`derived_population_unparsed: ${line}\n`);
      if (examined === 0) {
        process.stderr.write(
          "derived_population: no test file was examined, so nothing can be judged; a green run reads examined>=1\n",
        );
      }
      process.exitCode = status === "passed" ? 0 : 1;
    })
    .catch((error) => {
      process.stderr.write(`derived_population: ${error.stack ?? error.message}\n`);
      process.exitCode = 1;
    });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2));
