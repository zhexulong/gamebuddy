/**
 * The failure dump must be able to assemble a run whose module evaluation died, and it assembles that result out of
 * module-scope bindings. A binding declared *after* the first `process.once(...)` hook is therefore a trap: the hook
 * fires while evaluation is still above that declaration, and the read throws
 * `Cannot access '<name>' before initialization` — which REPLACES the run's real failure with `assembly failed` and
 * leaves no artifact at all.
 *
 * Two measurements, the same defect twice:
 *   2026-11-13 `head-ladder`: the module died at the stale-lock pair check; the dump reached `sampleProgramOutcomes`,
 *   read `programSubmissions` (declared ~2 500 lines below the throw) and published nothing.
 *   The next iteration: `programSubmissions` alone was hoisted and the dump stopped at the NEXT member
 *   (`bodyProgramJournal`). A TDZ is discovered one throw at a time; the population is every binding the dump path
 *   reads, which is why this gate enumerates instead of chasing.
 *
 * So this gate reads the runner's source and asserts the property, not a list of names:
 *
 *   every `const`/`let`/`class` binding reachable from the dump path is declared BEFORE the first hook line.
 *
 * The population is derived: module-scope declarations come from the source itself, and the dump path is the
 * transitive closure of the calls from the hook entries. It is printed on every run (`analysed …`) so a narrowing walk
 * is visible rather than silent, and the failure names the binding, its line, and which dump function reads it.
 *
 * Parser-free on purpose: `tools/` has no parser dependency of its own, and this check must not add one.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), "run-stardew-native-local-agent-ab-live.mjs");
/** The functions the hooks call, and the assembly they reach. Renaming one of these must fail this gate, not skip it. */
const DUMP_ROOTS = Object.freeze([
  "exitAfterDump",
  "writeKilledDump",
  "writeFailureDump",
  "writeRunDump",
  "failureDumpEvidence",
  "buildRunResult",
]);
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;

/** Blank out comments, strings, templates and regex literals, keeping every newline so line numbers still line up. */
export function stripLiterals(text) {
  const out = text.split("");
  let state = "code";
  let quote = "";
  let previousSignificant = "";
  let index = 0;
  const blank = (at) => {
    if (text[at] !== "\n") out[at] = " ";
  };
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    if (state === "code") {
      if (char === "/" && next === "/") {
        state = "line";
        blank(index);
        blank(index + 1);
        index += 2;
        continue;
      }
      if (char === "/" && next === "*") {
        state = "block";
        blank(index);
        blank(index + 1);
        index += 2;
        continue;
      }
      if (char === '"' || char === "'" || char === "`") {
        state = "string";
        quote = char;
        blank(index);
        index += 1;
        continue;
      }
      // A `/` after an operator or an opener begins a regex; after a value it is a division.
      if (char === "/" && /[=(,:;[!&|?{}+\-*%~^<>]|^$/.test(previousSignificant)) {
        state = "regex";
        blank(index);
        index += 1;
        continue;
      }
      if (!/\s/.test(char)) previousSignificant = char;
      index += 1;
      continue;
    }
    if (state === "line") {
      if (char === "\n") state = "code";
      else blank(index);
      index += 1;
      continue;
    }
    if (state === "block") {
      if (char === "*" && next === "/") {
        state = "code";
        blank(index);
        blank(index + 1);
        index += 2;
        continue;
      }
      blank(index);
      index += 1;
      continue;
    }
    if (state === "string") {
      if (char === "\\") {
        blank(index);
        blank(index + 1);
        index += 2;
        continue;
      }
      if (char === quote) {
        state = "code";
        blank(index);
        previousSignificant = quote;
        index += 1;
        continue;
      }
      blank(index);
      index += 1;
      continue;
    }
    // regex
    if (char === "\\") {
      blank(index);
      blank(index + 1);
      index += 2;
      continue;
    }
    if (char === "/") {
      state = "code";
      blank(index);
      previousSignificant = "/";
      index += 1;
      continue;
    }
    blank(index);
    index += 1;
  }
  return out.join("");
}

/** The `{` that opens the body of the top-level construct starting at `startLine` (params may contain braces). */
function bodyStart(lines, startLine) {
  let parenDepth = 0;
  for (let line = startLine; line < lines.length; line += 1) {
    for (let column = 0; column < lines[line].length; column += 1) {
      const char = lines[line][column];
      if (char === "(") {
        parenDepth += 1;
        continue;
      }
      if (char === ")") {
        parenDepth -= 1;
        continue;
      }
      if (parenDepth > 0) continue;
      if (char === "{") return { line, column };
    }
  }
  return { line: startLine, column: 0 };
}

/** The last line of the construct: the brace that closes its body. */
function bodyEnd(lines, startLine) {
  const start = bodyStart(lines, startLine);
  let depth = 0;
  let opened = false;
  for (let line = start.line; line < lines.length; line += 1) {
    for (let column = line === start.line ? start.column : 0; column < lines[line].length; column += 1) {
      const char = lines[line][column];
      if (char === "{") {
        depth += 1;
        opened = true;
      } else if (char === "}") {
        depth -= 1;
        if (opened && depth === 0) return line;
      }
    }
  }
  return lines.length - 1;
}

/**
 * The whole reading: module declarations, top-level functions, the first hook line, and the transitive closure of the
 * dump path with the edges that reached each binding.
 */
export function analyse(source) {
  const lines = stripLiterals(source).split("\n");
  const declarations = new Map();
  const functions = new Map();
  for (let line = 0; line < lines.length; line += 1) {
    const match = /^(?:async\s+)?(const|let|var|class|function)\s+([A-Za-z_$][\w$]*)/.exec(lines[line]);
    if (match === null) continue;
    const [, kind, name] = match;
    declarations.set(name, { kind, line: line + 1 });
    if (kind === "function" || (kind === "const" && /=\s*(async\s*)?(\(|function)/.test(lines[line]))) {
      functions.set(name, line);
    }
  }
  const hookLine = lines.findIndex((line) => /^process\.once\(|^installLiveRunInterrupt\(/.test(line)) + 1;

  const identifiersIn = (startLine, endLine) => {
    const names = new Set();
    const locals = new Set();
    for (let line = startLine; line <= endLine; line += 1) {
      const text = lines[line];
      for (const token of text.matchAll(IDENTIFIER)) {
        if (text.slice(0, token.index).trimEnd().endsWith(".")) continue;
        names.add(token[0]);
      }
      for (const match of text.matchAll(/(?:^|[\s({,;])(?:const|let|var|class|function)\s+([A-Za-z_$][\w$]*)/g)) {
        locals.add(match[1]);
      }
      for (const match of text.matchAll(/(?:async\s+)?function\s*[A-Za-z_$\w]*\s*\(([^)]*)\)/g)) {
        for (const token of match[1].matchAll(IDENTIFIER)) locals.add(token[0]);
      }
      for (const match of text.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
        for (const token of match[1].matchAll(IDENTIFIER)) locals.add(token[0]);
      }
    }
    return { names, locals };
  };

  const walked = new Set();
  const reached = new Map();
  const queue = [...DUMP_ROOTS];
  const missing = DUMP_ROOTS.filter((name) => !functions.has(name));
  while (queue.length > 0) {
    const name = queue.shift();
    if (walked.has(name)) continue;
    walked.add(name);
    const start = functions.get(name);
    if (start === undefined) continue;
    const end = bodyEnd(lines, start);
    const { names, locals } = identifiersIn(start, end);
    for (const token of names) {
      if (locals.has(token) || token === name) continue;
      const declared = declarations.has(token) || functions.has(token);
      if (!declared) continue;
      if (!reached.has(token)) reached.set(token, new Set());
      reached.get(token).add(`${name}:${start + 1}`);
      if (functions.has(token) && !walked.has(token)) queue.push(token);
    }
  }

  const late = [...reached.entries()]
    .filter(([token]) => {
      const declaration = declarations.get(token);
      if (declaration === undefined) return false;
      // Function declarations are hoisted and `var` is defined (as undefined) from the start: neither can be a TDZ.
      if (declaration.kind === "function" || declaration.kind === "var") return false;
      return declaration.line > hookLine;
    })
    .map(([token, via]) => ({ name: token, ...declarations.get(token), via: [...via].sort() }))
    .sort((left, right) => left.line - right.line);

  return { hookLine, declarations, walked, reached, late, missing };
}

test("the failure dump reads no binding declared after the hooks that can call it", (t) => {
  const analysis = analyse(readFileSync(RUNNER, "utf8"));
  t.diagnostic(
    `hook line ${analysis.hookLine}; walked ${analysis.walked.size} functions from ${DUMP_ROOTS.join(", ")}; ` +
      `reached ${analysis.reached.size} module bindings (${analysis.declarations.size} declared in the file)`,
  );
  assert.deepEqual(analysis.missing, [], "every dump entry point must still exist as a top-level function");
  assert.ok(analysis.hookLine > 0, "the file must install the dump hook, or this gate cannot read its own boundary");
  // A walk that read nothing would agree with itself. These are the shapes the walk must prove it saw.
  assert.ok(
    analysis.walked.has("buildRunResult") && analysis.walked.has("writeFailureDump"),
    "the walk must reach the dump's assembly functions",
  );
  assert.ok(
    analysis.reached.size >= 20,
    `the walk reached only ${analysis.reached.size} bindings - it has stopped seeing the dump's population`,
  );
  assert.deepEqual(
    analysis.late.map((entry) => `${entry.name} (${entry.kind}, line ${entry.line}, read by ${entry.via.join(", ")})`),
    [],
    "a module binding the failure dump reads is declared after the first dump hook, so the dump throws " +
      "`Cannot access '...' before initialization` for a run that dies above it and publishes no artifact",
  );
});
