/**
 * Reading a mounted journey as a document: the tests it declares, the assertions each one makes, and
 * the Host routes it replaces with a fixture.
 *
 * Three gates ask three questions of the same files - does a declared surface have a journey that
 * asserts on it (`tools/check-surface-journeys.mjs`), is a journey only asserting that a control
 * exists (`tools/check-assertion-substance.mjs`), and does a journey stub the thing its title claims
 * to test (`tools/check-stub-subject-collision.mjs`) - so the reading lives here once. A second
 * parser would be a second answer to "what does this spec assert", and the two would disagree the
 * first time either was edited.
 *
 * The parse is deliberately shallow: a test is its title plus the body between its braces, and an
 * assertion is the `expect(...)` call with the matcher chained to it, or a `node:assert` call. That is
 * enough to answer all three questions mechanically, and it does not need a TypeScript parse: a spec's
 * assertions are calls in its own text, and the gates judge those calls, not a type.
 *
 * BOTH SPELLINGS COUNT. A chain that breaks the line after `expect` (`await expect`, then `.poll(...)`,
 * then `.toBe(...)`) and a claim written in node's own idiom (`assert.deepEqual(violations, [])`) are
 * assertions exactly as a single-line matcher is, and reading only the single-line `expect` chain
 * graded one of the three styles - so a spec's whole claim could be invisible to the gates above it.
 * Nothing is loosened by counting them: the matcher a call names is still what decides its substance.
 *
 * UNTRACKED FILES ARE NOT PART OF THE COMMIT. A worktree where several lanes run holds specs
 * somebody is still writing; judging one would fail another lane's in-flight work, and letting one
 * witness a surface would make that surface look covered by a file that is not in the commit. Both
 * directions are the same rule, so it is applied once, here.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { cleanOutputLines } from "./subprocess-output.mjs";

const JOURNEY_DIRECTORY = "dialogue-web/tests";

const toPosix = (path) => path.split(sep).join("/");

/** Files git reports as untracked; a directory that is not a worktree reports none. */
export function untrackedFiles(root) {
  const result = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) return new Set();
  return new Set(cleanOutputLines(result.stdout).filter(Boolean).map(toPosix));
}

/** Every `.spec.ts` under `directory`, as repo-relative paths, sorted. */
function scanSpecs(directory, root, out = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) scanSpecs(path, root, out);
    else if (entry.name.endsWith(".spec.ts")) out.push(toPosix(relative(root, path)));
  }
  return out.sort();
}

/** The commit's journeys, each with its source. A tree with no spec directory yields an empty list. */
export function journeySpecs({ root, directory = JOURNEY_DIRECTORY }) {
  const absolute = join(root, directory);
  if (!existsSync(absolute)) return [];
  const untracked = untrackedFiles(root);
  return scanSpecs(absolute, root)
    .filter((file) => !untracked.has(file))
    .map((file) => ({ file, source: readFileSync(join(root, file), "utf8") }));
}

/** The title of a `test(...)` call, tolerating a title written across lines. `.describe` is a group. */
const TEST_CALL =
  /^[ \t]*test(?:\.(?:skip|only|fixme|fail|slow|concurrent))*\s*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/gmu;

/** A character after which a `/` opens a regex literal rather than dividing. */
const REGEX_PRECEDERS = new Set([
  "(",
  ",",
  "=",
  ":",
  "[",
  "!",
  "&",
  "|",
  "?",
  "{",
  ";",
  "+",
  "-",
  "*",
  "%",
  "<",
  ">",
  "~",
  "^",
]);

/** Index just past the regex literal and its flags at `index`, or null when that `/` divides. */
function regexEnd(source, index) {
  let previous = index - 1;
  while (previous >= 0 && /\s/u.test(source[previous])) previous -= 1;
  if (previous >= 0 && !REGEX_PRECEDERS.has(source[previous])) return null;
  let inClass = false;
  for (let cursor = index + 1; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (character === "\\") cursor += 1;
    else if (character === "\n") return null;
    else if (character === "[") inClass = true;
    else if (character === "]") inClass = false;
    else if (character === "/" && !inClass) {
      for (cursor += 1; cursor < source.length && /[a-z]/u.test(source[cursor]); cursor += 1);
      return cursor;
    }
  }
  return null;
}

/**
 * The region of the source a test's assertions live in: its own `test(` call up to the next one.
 *
 * The region is not the call's bracket span. Matching brackets through a spec means matching them
 * through regex literals (`value.match(/rgba?\(([^)]+)\)/u)` is unbalanced as text) and through
 * comments full of apostrophes, and every miss ends the span early - which reads as a test that
 * asserts nothing, the exact opposite of the truth. Splitting on the next `test(` has no such edge:
 * the population is the file's own declaration order.
 */
export function parseTests(source) {
  const starts = [...source.matchAll(TEST_CALL)].map((match) => ({
    title: match[2],
    index: match.index,
    line: source.slice(0, match.index).split("\n").length,
  }));
  return starts.map((entry, order) => ({
    title: entry.title,
    line: entry.line,
    body: source.slice(entry.index, starts[order + 1]?.index ?? source.length),
  }));
}

/**
 * Index just past the `)` matching the `(` at `open`.
 *
 * Comments, quoted text and regex literals are skipped rather than counted: an apostrophe in a comment
 * (`the strip's worst case`) or a regex like `/rgba?\(([^)]+)\)/u` is not balanced text, and counting
 * its parentheses walks the scan out of the call.
 */
function callEnd(source, open) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (character === "/" && source[index + 1] === "/") {
      const newline = source.indexOf("\n", index);
      if (newline === -1) return source.length;
      index = newline;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      const close = source.indexOf("*/", index + 2);
      if (close === -1) return source.length;
      index = close + 1;
      continue;
    }
    if (character === "/") {
      const skipped = regexEnd(source, index);
      if (skipped !== null) {
        index = skipped - 1;
        continue;
      }
    }
    if (character === '"' || character === "'" || character === "`") {
      for (index += 1; index < source.length; index += 1) {
        if (source[index] === "\\") index += 1;
        else if (source[index] === character) break;
      }
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return source.length;
}

/** `expect(` / `expect.soft(` / `expect.poll(`: the chain may break the line before its own call. */
const EXPECT = /\bexpect\s*(?:\.\s*\w+\s*)?\(/gu;
/** The matcher chained to a resolved `expect(...)`, allowing `.not`, `.resolves` and `.rejects`. */
const MATCHER = /^\s*(?:\.\s*(?:not|resolves|rejects)\s*)*\.\s*(to[A-Za-z]+)\s*\(/u;

/** No `node:assert` in this spec, so no call in its body is read as one. */
const NO_NODE_ASSERT = Object.freeze({ namespaces: [], methods: [] });

/**
 * The local names a spec binds `node:assert` to, so the calls it makes through them can be read.
 *
 * A spec that judges a value in node's idiom asserts as much as one that chains a matcher, and the
 * gates above were reading none of it. WHICH call is a node assertion comes from the file's own
 * import rather than from a list of method names, so the reading cannot drift from node: a namespace
 * (`import assert from "node:assert/strict"`, `import * as assert`) makes every `<name>.<method>(` an
 * assertion, and a destructured import makes that bare name one. A method node adds in a later release
 * is read without editing this file, and a spec's own helper named `match` is not read at all.
 */
const NODE_ASSERT_IMPORT = /^[ \t]*import\s+([^;]*?)\s*from\s*["']node:assert(?:\/strict)?["']/gmu;

export function nodeAssertBindings(source) {
  const namespaces = new Set();
  const methods = new Set();
  for (const match of source.matchAll(NODE_ASSERT_IMPORT)) {
    const clause = match[1].trim();
    const braces = clause.indexOf("{");
    const outside = (braces === -1 ? clause : clause.slice(0, braces)).replace(/,\s*$/u, "").trim();
    if (outside) namespaces.add(outside.replace(/^\*\s+as\s+/u, "").trim());
    if (braces === -1) continue;
    for (const part of clause.slice(braces + 1, clause.lastIndexOf("}")).split(",")) {
      const [imported, local] = part.split(/\s+as\s+/u).map((each) => each.trim());
      if (!imported) continue;
      if (imported === "strict") namespaces.add(local ?? imported);
      else methods.add(local ?? imported);
    }
  }
  return { namespaces: [...namespaces], methods: [...methods] };
}

/** Every `node:assert` call in a body: where it starts, the method it names, and its own `(`. */
function nodeAssertCalls(body, { namespaces, methods }) {
  const calls = [];
  for (const namespace of namespaces) {
    const pattern = new RegExp(`\\b${namespace}\\s*\\.\\s*(\\w+)\\s*\\(`, "gu");
    for (const match of body.matchAll(pattern))
      calls.push({ start: match.index, method: match[1], open: match.index + match[0].length - 1 });
  }
  for (const method of methods) {
    const pattern = new RegExp(`(^|[^.\\w$])${method}\\s*\\(`, "gu");
    for (const match of body.matchAll(pattern))
      calls.push({
        start: match.index + match[1].length,
        method,
        open: match.index + match[0].length - 1,
      });
  }
  return calls;
}

/**
 * Every assertion in a body: the matcher's name, whether it was negated, and the whole call's text.
 *
 * `text` runs from `expect` (or the assert call) to the end of the matcher's own call, because that is
 * the span that names the control, the text and the matcher together - the unit the three gates above
 * judge. A node assertion names its method where an `expect` chain names a matcher, so `deepEqual`
 * and `toEqual` are two spellings the classification above weighs by the same rule.
 */
export function assertionsOf(body, { nodeAssert = NO_NODE_ASSERT } = {}) {
  const assertions = [];
  for (const match of body.matchAll(EXPECT)) {
    const openParen = match.index + match[0].length - 1;
    const closeParen = callEnd(body, openParen);
    const chained = MATCHER.exec(body.slice(closeParen));
    if (chained === null) continue;
    const matcherOpen = closeParen + chained[0].length - 1;
    assertions.push({
      index: match.index,
      matcher: chained[1],
      negated: /\.\s*not\s*\./u.test(chained[0]),
      text: body.slice(match.index, callEnd(body, matcherOpen)),
    });
  }
  for (const call of nodeAssertCalls(body, nodeAssert))
    assertions.push({
      index: call.start,
      matcher: call.method,
      negated: call.method.startsWith("not"),
      text: body.slice(call.start, callEnd(body, call.open)),
    });
  return assertions
    .sort((left, right) => left.index - right.index)
    .map(({ index, matcher, negated, text }) => ({ matcher, negated, text }));
}
