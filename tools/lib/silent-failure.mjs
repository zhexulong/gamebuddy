/**
 * Gate for the SILENT FAILURE defect class: a reporting function that returns
 * early, or swallows an error, without leaving anything observable behind, so a
 * later reader cannot tell "it never happened" from "it happened and failed".
 *
 * The confirmed instances this class produced (2026-11):
 *
 *   - `reportTavernNarrativeGateRuntime` returned early when
 *     `process.connected !== true` and swallowed its own throw in `catch {}`. The
 *     run then reported `no_pre_send_marker`, which reads as "the product never
 *     reached the provider" when the truth was "the marker was never sent".
 *   - a provider rejection collapsed three distinct causes into one
 *     `runtime_unavailable`.
 *   - a thread census folded `no_process` / `no_threads` / `probe_failed` into one
 *     `"unavailable"`.
 *
 * A regex for `catch {}` is not this gate: 234 empty catch clauses exist in this
 * tree and nearly all of them are cleanup with genuinely nothing to say. Two
 * conditions must both hold, and the first is what keeps the gate quiet:
 *
 *   1. the enclosing function is a REPORTING function - its name says it exists
 *      to produce a fact (`report`, `probe`, `observe`, `classify`, `inspect`,
 *      `measure`, `diagnose`, `survey`, `attest`, ...). A swallow in `cleanup`,
 *      `dispose` or `close` is not this class, because nothing was promised;
 *   2. the site leaves no mark: the `catch` body neither rethrows nor writes
 *      anywhere, or the `return` happens before the function has written
 *      anything at all.
 *
 * A guard on the caller's own argument is also not the class: `if (input.modelId
 * === undefined) return;` says "you gave me nothing to report", which is the
 * boundary contract and the caller already knows. A guard on module state, the
 * process, a socket, a clock or a spawned child is the class - the function had
 * something to say and said nothing.
 *
 * Everything this gate finds is either fixed at the source or listed in
 * `DECLARED` with why silence is the right answer there. Each entry carries the
 * `witness` text it waives and the number of sites (`sites`) it waives; the gate
 * fails when either no longer matches, so a declaration cannot widen into a rule
 * repeal and cannot outlive the code it was written for.
 *
 * What no declaration can prove is the absence of a report that SHOULD have been
 * written: a function that returns the wrong value for the right-looking reason
 * is invisible here, because nothing in the source says what the caller expected
 * to arrive. This gate catches the swallow and the early exit, not the lie.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** Hand-authored sources. Generated bundles, JSON data and the C# trees are out of scope. */
const SCAN_EXTENSIONS = Object.freeze([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);

/**
 * Vendored, generated or scratch trees that never own a product observation.
 * `dist*`, `.tmp*`, `.scoped*`, `.worktree*` and `_devdist*` are prefix-matched
 * because the tree accumulates them per experiment.
 */
const EXCLUDED_DIRECTORIES = new Set([
  ".agents",
  ".audit-runs",
  ".build-staging",
  ".claude",
  ".commit-snapshots",
  ".cortexkit",
  ".git",
  ".live-runs",
  ".pi",
  ".pi-subagent-sessions",
  ".pi-subagents",
  ".ruff_cache",
  "NuGet",
  "__pycache__",
  "artifacts",
  "bin",
  "build",
  "coverage",
  "design",
  "node_modules",
  "obj",
  "playwright-report",
  "ref",
  "scratch",
  "subagent-artifacts",
  "subagent-reports",
  "test-results",
  "third_party",
  "tmp",
  "vendor",
]);

const MAX_SCANNED_BYTES = 2 * 1024 * 1024;

/** The gate's own module spells the shapes on purpose; its test plants them on purpose. */
export const GATE_PATHS = Object.freeze(["tools/lib/silent-failure.mjs", "tools/lib/silent-failure.test.mjs"]);

/** A function whose name says it exists to produce a fact. */
const OBSERVING_NAME =
  /^(?:re|un)?(?:report|probe|census|observ|diagnos|classif|inspect|measure|survey|attest|advertis|announce|telemetr|flush|close|dispose|shutdown|teardown)/iu;

/** A call that leaves a mark a later reader can find. */
const OBSERVABLE_SINK =
  /process\s*\.\s*(?:send|stderr|stdout)\b|console\s*\.\s*\w+\s*\(|(?:logger|recorder|sink|report|diagnostics?|errors?)\s*\.\s*\w+\s*\(|\b(?:emit|record|publish)\s*\(|\.\s*(?:write|writeSync|end)\s*\(|(?:write|append)FileSync\s*\(|\breject\s*\(/u;

/** A statement that changes state even though it writes and throws nothing. */
const OBSERVABLE_EFFECT = /(?<![=!<>+\-*/%&|^])=(?!=)|\.\s*(?:set|push|add|delete|clear|append|splice)\s*\(/u;

/**
 * A call to a function whose name says it reports. `fail(...)`, a rethrow helper and
 * an injected `reject` callback all leave the failure observable somewhere; they
 * just spell the report one frame away from the catch that made the decision.
 */
const REPORTING_CALL =
  /(?<![.\w$])(?:fail|failProtocol|failure|reject|report|record|emit|publish|warn|log|abort|trace)\w*\s*\(/u;

/** A header line that opens a control block or a call rather than a function body. */
const NOT_A_FUNCTION_HEADER = /^(?:if|for|while|switch|catch|try|else|do|with|return|await|new)\b/u;

const KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "try",
  "else",
  "do",
  "with",
  "return",
  "await",
  "new",
  "typeof",
  "function",
  "void",
  "yield",
  "delete",
  "in",
  "of",
  "case",
]);

/** A `return` that hands back a value. */
const VALUED_RETURN = /(?<![.\w$])return\s+(?![;\s])/u;

const CATCH_CLAUSE = /catch\s*(?:\([^)]*\))?\s*\{/gu;
const RETURN_STATEMENT = /(?<![.\w$])return\b[^;{}]*;?/gu;

function toPosix(path) {
  return path.split(sep).join("/");
}

function isExcludedDirectory(name) {
  return (
    EXCLUDED_DIRECTORIES.has(name) ||
    name.startsWith("dist") ||
    name.startsWith(".tmp") ||
    name.startsWith(".scoped") ||
    name.startsWith(".worktree") ||
    name.startsWith("_devdist")
  );
}

function hasScannedExtension(name) {
  const dot = name.lastIndexOf(".");
  return dot > 0 && SCAN_EXTENSIONS.includes(name.slice(dot));
}

/** A committed test may assert that a failure stays silent; a fixture is a stand-in, not a reporter. */
export function isTestPath(path) {
  return (
    /\.test-support\.[a-z]+$/u.test(path) ||
    /\.test\.[a-z]+$/u.test(path) ||
    /\.spec\.[a-z]+$/u.test(path) ||
    /(?:^|\/)(?:tests?|test-support|test-fixtures|test_doubles|fixtures)\//u.test(path)
  );
}

/**
 * Replace comment and string contents with spaces, keeping every offset so a
 * match index still points at the same place in the original text. Without it a
 * `"catch {"` inside a doc comment reads as code.
 */
export function blank(text) {
  const out = text.split("");
  const size = text.length;
  const previousSignificant = (at) => {
    for (let cursor = at - 1; cursor >= 0; cursor -= 1) if (!/\s/u.test(text[cursor])) return text[cursor];
    return "^";
  };
  let index = 0;
  while (index < size) {
    const character = text[index];
    if (character === "/" && text[index + 1] === "/") {
      while (index < size && text[index] !== "\n") out[index++] = " ";
      continue;
    }
    if (character === "/" && text[index + 1] === "*") {
      out[index++] = " ";
      out[index++] = " ";
      while (index < size && !(text[index] === "*" && text[index + 1] === "/")) {
        if (text[index] !== "\n") out[index] = " ";
        index += 1;
      }
      if (index < size) {
        out[index++] = " ";
        out[index++] = " ";
      }
      continue;
    }
    if (character === "/" && /[(=,:;&|!?{}[\]+\-*%~^<>]/u.test(previousSignificant(index))) {
      out[index++] = " ";
      let inClass = false;
      while (index < size) {
        if (text[index] === "\\") {
          out[index] = " ";
          if (index + 1 < size) out[index + 1] = " ";
          index += 2;
          continue;
        }
        if (text[index] === "\n") break;
        if (text[index] === "[") inClass = true;
        else if (text[index] === "]") inClass = false;
        else if (text[index] === "/" && !inClass) {
          out[index++] = " ";
          break;
        }
        out[index] = " ";
        index += 1;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      out[index++] = " ";
      while (index < size) {
        if (text[index] === "\\") {
          out[index] = " ";
          if (index + 1 < size && text[index + 1] !== "\n") out[index + 1] = " ";
          index += 2;
          continue;
        }
        if (text[index] === character) {
          out[index++] = " ";
          break;
        }
        if (text[index] !== "\n") out[index] = " ";
        index += 1;
      }
      continue;
    }
    index += 1;
  }
  return out.join("");
}

/** Every `{...}` pair in a blanked text, plus an opening-brace to closing-brace lookup. */
export function braces(blanked) {
  const pairs = [];
  const stack = [];
  for (let index = 0; index < blanked.length; index += 1) {
    if (blanked[index] === "{") stack.push(index);
    else if (blanked[index] === "}") {
      const open = stack.pop();
      if (open !== undefined) pairs.push({ open, close: index });
    }
  }
  const byOpen = new Map(pairs.map((pair) => [pair.open, pair.close]));
  return { pairs, byOpen };
}

function skipSpaceBackwards(text, index) {
  let cursor = index;
  while (cursor >= 0 && /\s/u.test(text[cursor])) cursor -= 1;
  return cursor;
}

function identifierEnding(text, index) {
  let cursor = index;
  while (cursor >= 0 && /[\w$]/u.test(text[cursor])) cursor -= 1;
  return text.slice(cursor + 1, index + 1);
}

/** The `(` matching the `)` at `close`. */
function matchingOpenParen(text, close) {
  let depth = 0;
  for (let cursor = close; cursor >= 0; cursor -= 1) {
    if (text[cursor] === ")") depth += 1;
    else if (text[cursor] === "(") {
      depth -= 1;
      if (depth === 0) return cursor;
    }
  }
  return -1;
}

/**
 * The function whose body opens at `open`, read backwards over its own parameter
 * list so a destructured or defaulted parameter cannot be mistaken for the header.
 * Returns `{ name, header }` or `null` when the brace opens an anonymous block.
 */
export function functionAt(blanked, open) {
  let cursor = skipSpaceBackwards(blanked, open - 1);
  // Skip a TypeScript return type (`): Promise<T> {`).
  if (blanked[cursor] !== ")") {
    let back = cursor;
    while (back >= 0 && !/[);{}]/u.test(blanked[back])) back -= 1;
    if (back < 0 || blanked[back] !== ")") return null;
    cursor = back;
  }
  const openParen = matchingOpenParen(blanked, cursor);
  if (openParen < 0) return null;
  const closeParen = cursor;
  const beforeParen = skipSpaceBackwards(blanked, openParen - 1);
  const parameters = blanked.slice(openParen + 1, closeParen);

  const name = identifierEnding(blanked, beforeParen);
  if (name !== "") {
    const head = blanked.slice(Math.max(0, beforeParen - name.length - 12), beforeParen - name.length);
    if (/\bfunction\s*\*?\s*$/u.test(head) || /^[^\w$]*$/u.test(head) || /[.:]\s*$/u.test(head)) {
      return {
        name,
        header: blanked.slice(Math.max(0, blanked.lastIndexOf(";", beforeParen) + 1), closeParen + 1).trim(),
        parameters,
      };
    }
  }
  // An arrow function: `const name = (...) => {`.
  const arrow = skipSpaceBackwards(blanked, beforeParen);
  const arrowEnd = skipSpaceBackwards(blanked, arrow + 1);
  if (blanked[arrow] === "=" && blanked[arrowEnd] === ">") {
    const assignment = blanked.slice(Math.max(0, blanked.lastIndexOf(";", arrow) + 1), arrow);
    const declared = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?$/u.exec(assignment);
    if (declared !== null) return { name: declared[1], header: `${assignment.trim()} (...) =>`, parameters };
  }
  return null;
}

/** The nearest enclosing named function, skipping anonymous control blocks. */
export function enclosingFunction(blanked, pairs, index) {
  const candidates = pairs
    .filter((pair) => pair.open < index && index < pair.close)
    .sort((left, right) => right.open - left.open);
  for (const pair of candidates) {
    const head = functionAt(blanked, pair.open);
    if (
      head === null ||
      KEYWORDS.has(head.name) ||
      NOT_A_FUNCTION_HEADER.test(blanked.slice(pair.open - 12, pair.open))
    ) {
      if (head !== null && KEYWORDS.has(head.name)) continue;
      if (head === null) continue;
    }
    return { ...head, open: pair.open, close: pair.close };
  }
  return null;
}

/** The names a function takes, so a guard on them can be told from a guard on the world. */
export function parameterNames(parameters) {
  const names = new Set();
  for (const part of parameters.split(",")) {
    const match = /^\s*(?:\.\.\.)?\s*([A-Za-z_$][\w$]*)/u.exec(part);
    if (match !== null) names.add(match[1]);
  }
  return names;
}

function guardsOnlyParameters(condition, parameters) {
  const identifiers = [...condition.matchAll(/(?<![.\w$])[A-Za-z_$][\w$]*/gu)]
    .map((match) => match[0])
    .filter((identifier) => !/^(?:undefined|null|true|false|typeof|in|of)$/u.test(identifier));
  return identifiers.length === 0 || identifiers.every((identifier) => parameters.has(identifier));
}

/**
 * Functions in this file that only ever leave by throwing. A catch body calling
 * one of them rethrows too - the throw is just written one frame away, which is
 * how `fail("target_assembly_missing")` reports a missing assembly.
 */
function throwerNames(blanked, pairs) {
  const throwers = new Set();
  for (const pair of pairs) {
    const head = functionAt(blanked, pair.open);
    if (head === null) continue;
    const body = blanked.slice(pair.open + 1, pair.close);
    if (/\bthrow\b/u.test(body) && !OBSERVABLE_SINK.test(body) && !OBSERVABLE_EFFECT.test(body))
      throwers.add(head.name);
  }
  return throwers;
}

function lineAt(text, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) if (text[cursor] === "\n") line += 1;
  return line;
}

/** The exact source text of a site, so a declaration can quote it back. */
function sourceOf(text, start, end) {
  return text.slice(start, end).replace(/\s+/gu, " ").trim();
}

/**
 * Every silent site the two shapes produce, as
 * `{ kind, path, symbol, line, text }`. `kind` is `silent-catch` for a catch
 * clause that leaves no trace and `early-return` for a return before the
 * function has reported anything.
 */
export function findSilentFailures(repoRoot) {
  const findings = [];
  for (const file of listSourceFiles(repoRoot)) {
    const path = toPosix(relative(repoRoot, file));
    if (isTestPath(path) || GATE_PATHS.includes(path)) continue;
    const text = readFileSync(file, "utf8");
    const blanked = blank(text);
    const { pairs, byOpen } = braces(blanked);
    const throwers = throwerNames(blanked, pairs);
    const rethrow = throwers.size === 0 ? null : new RegExp(`(?<![.\\w$])(?:${[...throwers].join("|")})\\s*\\(`, "u");
    const spokens = new Map();
    const observerAt = (index) => {
      const fn = enclosingFunction(blanked, pairs, index);
      if (fn === null || !OBSERVING_NAME.test(fn.name)) return null;
      if (!spokens.has(fn.open)) spokens.set(fn.open, OBSERVABLE_SINK.test(blanked.slice(fn.open + 1, fn.close)));
      return { ...fn, speaks: spokens.get(fn.open) };
    };

    CATCH_CLAUSE.lastIndex = 0;
    for (let match = CATCH_CLAUSE.exec(blanked); match !== null; match = CATCH_CLAUSE.exec(blanked)) {
      const open = match.index + match[0].length - 1;
      const close = byOpen.get(open);
      if (close === undefined) continue;
      const body = blanked.slice(open + 1, close);
      if (/\bthrow\b/u.test(body)) continue;
      if (OBSERVABLE_SINK.test(body) || OBSERVABLE_EFFECT.test(body)) continue;
      if (REPORTING_CALL.test(body)) continue;
      if (rethrow !== null && rethrow.test(body)) continue;
      const fn = observerAt(match.index);
      if (fn === null) continue;
      findings.push({
        kind: "silent-catch",
        path,
        symbol: fn.name,
        line: lineAt(text, match.index),
        // An empty catch has no body text to quote, and a declaration needs a
        // witness that a later edit would break. The whole clause is that witness:
        // it changes the moment anyone writes a report inside it.
        text: sourceOf(text, open + 1, close) || sourceOf(text, match.index, close + 1),
      });
    }

    RETURN_STATEMENT.lastIndex = 0;
    for (let match = RETURN_STATEMENT.exec(blanked); match !== null; match = RETURN_STATEMENT.exec(blanked)) {
      const statement = match[0];
      if (!/^return(?:\s+(?:undefined|null))?\s*;$/u.test(statement.trim())) continue;
      const fn = observerAt(match.index);
      if (fn === null || !fn.speaks) continue;
      const enclosing = pairs
        .filter((pair) => pair.open < match.index && match.index < pair.close)
        .sort((left, right) => right.open - left.open);
      const block = enclosing[0];
      if (block === undefined) continue;
      const inner = block.open === fn.open;
      const scopeStart = block.open + 1;
      // A guard: `if (...) return;` or `if (...) { return; }`. A return that is not a
      // guard is a normal exit, and the function's own emissions are not this rule's
      // business.
      const condition = guardCondition(blanked, block.open) ?? inlineIfCondition(blanked, scopeStart, match.index);
      if (condition === null) continue;
      if (guardsOnlyParameters(condition, parameterNames(fn.parameters))) continue;
      if (OBSERVABLE_SINK.test(blanked.slice(scopeStart, match.index))) continue;
      if (!inner && OBSERVABLE_SINK.test(blanked.slice(fn.open + 1, match.index))) continue;
      findings.push({
        kind: "early-return",
        path,
        symbol: fn.name,
        line: lineAt(text, match.index),
        text: sourceOf(text, match.index, match.index + statement.length),
      });
    }
  }
  findings.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line);
  return findings;
}

/** The `if (...)` condition that owns the block opening at `open`, when it has one. */
function guardCondition(blanked, open) {
  return ifConditionEndingAt(blanked, skipSpaceBackwards(blanked, open - 1));
}

/** The `if (...)` condition immediately before a return, for the brace-less guard form. */
function inlineIfCondition(blanked, scopeStart, returnIndex) {
  return ifConditionEndingAt(blanked, skipSpaceBackwards(blanked, returnIndex - 1));
}

function ifConditionEndingAt(blanked, cursor) {
  if (blanked[cursor] !== ")") return null;
  const openParen = matchingOpenParen(blanked, cursor);
  if (openParen < 0) return null;
  const keyword = skipSpaceBackwards(blanked, openParen - 1);
  const word = identifierEnding(blanked, keyword);
  if (word !== "if") return null;
  return blanked.slice(openParen + 1, cursor);
}

function listSourceFiles(repoRoot) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (isExcludedDirectory(entry.name)) continue;
        walk(join(directory, entry.name));
        continue;
      }
      if (!(entry.isFile() && hasScannedExtension(entry.name))) continue;
      const path = join(directory, entry.name);
      if (statSync(path).size > MAX_SCANNED_BYTES) continue;
      files.push(path);
    }
  };
  walk(repoRoot);
  return files;
}

/**
 * Silences that are the correct answer where they are. Each entry names the site,
 * the reason nothing is missing there, the exact source text it waives
 * (`witness`), and how many sites in that function it waives (`sites`).
 */
export const DECLARED = Object.freeze([
  // The catch reports the failure in the shape of the answer: readable:false is a
  // distinct fact from gameExecutable:false, which is the whole point of the field.
  Object.freeze({
    kind: "silent-catch",
    path: "host/src/stardew-game-install/discovery.ts",
    symbol: "probeStardewGameRoot",
    reason: "reports readable:false, which callers read as 'could not look' rather than 'no game here'",
    witness: "return Object.freeze({ readable: false, gameExecutable: false, smapi: false });",
    sites: 1,
  }),
  // Killing a child we already decided to abandon is cleanup, not an observation.
  // If the kill fails the child is left running and the promise is rejected by the
  // surrounding close/error/timer path, which is where the failure is reported.
  Object.freeze({
    kind: "silent-catch",
    path: "host/scripts/windows-release-bootstrap-scratch.internal.mjs",
    symbol: "inspectChain",
    reason:
      "child.kill() is cleanup of an already-failed inspection; the timeout, error and close handlers all reject with unavailable()",
    witness: "try { child?.kill(); } catch {}",
    sites: 1,
  }),
  // The shape of the answer IS the observation: 'invalid' with the path is a
  // reported fact, and the caller refuses on it. Nothing is swallowed.
  Object.freeze({
    kind: "silent-catch",
    path: "tools/lib/stardew-fixture-profile.mjs",
    symbol: "inspectTransactionLock",
    reason: "the catch returns state:invalid with the lock path, which is what the caller refuses on",
    witness: 'return Object.freeze({ state: "invalid", path: lockDir });',
    sites: 1,
  }),
  Object.freeze({
    kind: "silent-catch",
    path: "tools/lib/stardew-fixture-profile.mjs",
    symbol: "inspectFixtureBackup",
    reason: "the catch returns state:invalid with a named reasonCode, entries and the backup path",
    witness: 'reasonCode: "fixture_backup_manifest_unreadable"',
    sites: 1,
  }),
  // Announcing fixture roots is a console convenience before a run; a write that
  // fails must not abort the run, and the run's own artifacts carry the real state.
  Object.freeze({
    kind: "early-return",
    path: "tools/lib/stardew-fixture-roots.mjs",
    symbol: "announceStardewFixtureRoots",
    reason: "console announcement only; the fixture run's artifacts are the authority, not this banner",
    witness: "return;",
    sites: 1,
  }),
  // A smoke helper that reads a snapshot opportunistically. 'null' is the answer it
  // documents, and the smoke's assertions are on the receipts, not on this read.
  Object.freeze({
    kind: "silent-catch",
    path: "tools/run-stardew-native-local-player-multi-day-smoke.mjs",
    symbol: "observeQuietly",
    reason: "documented as a quiet opportunistic read; the smoke asserts on receipts, which fail loudly",
    witness: "return client.state?.snapshot ?? null;",
    sites: 1,
  }),
  // Screenshot tooling probing whether a dev server is up. A false negative means it
  // tries to start one, which then fails with its own error.
  Object.freeze({
    kind: "silent-catch",
    path: "tools/shots/run.mjs",
    symbol: "probesUp",
    reason: "a false negative only causes a start attempt, whose failure is reported",
    witness: "return false;",
    sites: 1,
  }),
  // Closing a launch that was ALREADY rejected. The validation error is the fact worth keeping, and a
  // cleanup failure here would replace it with a less useful one; the caller already knows the launch was
  // refused. Two sites because revoke and close each get their own catch, deliberately: one failing must
  // not skip the other.
  Object.freeze({
    kind: "silent-catch",
    path: "host/src/continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.ts",
    symbol: "closeRejectedReceiptBackedLaunch",
    reason: "cleanup of an already-rejected launch; the validation failure being raised is the fact the caller needs",
    witness: "/* preserve validation failure */",
    sites: 2,
  }),
  // Idempotence, not a swallowed failure: closing something already closed is the requested outcome, so there
  // is nothing to report. Two sites, both the same idea - the store is already closed, and the connection was
  // never opened. Listed rather than exempted by pattern, because "already done" and "could not do it" look
  // identical in source and only a reader can tell them apart.
  Object.freeze({
    kind: "early-return",
    path: "host/src/tavern/chat-thread-store.ts",
    symbol: "closeConnection",
    reason: "idempotence: a second close, or a close with no connection, has nothing to do and nothing to report",
    witness: "if (closed) return;",
    sites: 2,
  }),
  // Same idempotence, different frame: this one announces once per sink.
  Object.freeze({
    kind: "early-return",
    path: "tools/lib/stardew-fixture-roots.mjs",
    symbol: "announceStardewFixtureRoots",
    reason: "announces once per sink; a repeated call has nothing new to say",
    witness: "if (announcedSinks.has(sink)) return;",
    sites: 1,
  }),
  // A socket close during teardown, where the socket was already dropped by the browser.
  Object.freeze({
    kind: "silent-catch",
    path: "tools/live-run/core/browser-evidence.mjs",
    symbol: "close",
    reason: "closing an already-closed socket; the capture's own failures are reported through its summary",
    witness: "/* already closed */",
    sites: 1,
  }),
  // Both capture closers report the failure INSIDE the frozen summary they return, which is the artifact.
  Object.freeze({
    kind: "silent-catch",
    path: "tools/live-run/game/run-stardew-native-local-agent-ab-live.mjs",
    symbol: "closeCapture",
    reason: "reports the failure in the returned capture summary (failures: summary.failures), not on a log line",
    witness: 'schema: "gamebuddy_live_run_capture/v1"',
    sites: 1,
  }),
  Object.freeze({
    kind: "silent-catch",
    path: "tools/live-run/memory/run-memory-live-loop.mjs",
    symbol: "closeIntoReport",
    reason: "reports the failure in the returned capture summary (failures: summary.failures), not on a log line",
    witness: 'schema: "gamebuddy_live_run_capture/v1"',
    sites: 1,
  }),
  // Teardown after a verdict has already been read. Replacing that verdict with a close error would hide the
  // result the run exists to produce; the pid is reported separately by the surviving-process path.
  Object.freeze({
    kind: "silent-catch",
    path: "tools/run-stardew-lifecycle-cold-session.mjs",
    symbol: "disposeSession",
    reason: "best-effort teardown after the verdict; a close error must not replace the verdict already read",
    witness: "// Teardown is best-effort: a failed close must not replace the verdict already read.",
    sites: 2,
  }),
]);

function declarationProblems(declared) {
  const problems = [];
  for (const entry of declared) {
    if (entry.kind !== "silent-catch" && entry.kind !== "early-return")
      problems.push({ code: "declaration_unkinded", path: entry.path, symbol: entry.symbol });
    if (typeof entry.reason !== "string" || entry.reason.trim() === "" || entry.reason.includes("\n"))
      problems.push({ code: "declaration_unreasoned", path: entry.path, symbol: entry.symbol });
    if (typeof entry.witness !== "string" || entry.witness.trim() === "")
      problems.push({ code: "declaration_unwitnessed", path: entry.path, symbol: entry.symbol });
    if (!Number.isInteger(entry.sites) || entry.sites < 1)
      problems.push({ code: "declaration_uncounted", path: entry.path, symbol: entry.symbol });
  }
  return problems;
}

/**
 * The verdict: every finding not matched by a declaration, plus every declaration
 * that no longer matches the code it waives.
 */
export function checkSilentFailures(repoRoot, declared = DECLARED) {
  const findings = findSilentFailures(repoRoot);
  const problems = declarationProblems(declared);
  const waived = new Set();
  for (const entry of declared) {
    let text;
    try {
      text = readFileSync(join(repoRoot, entry.path), "utf8");
    } catch {
      problems.push({ code: "declaration_stale_path", path: entry.path, symbol: entry.symbol });
      continue;
    }
    if (!text.replace(/\s+/gu, " ").includes(entry.witness)) {
      problems.push({ code: "declaration_stale_witness", path: entry.path, symbol: entry.symbol });
      continue;
    }
    const matching = findings.filter(
      (finding) => finding.path === entry.path && finding.symbol === entry.symbol && finding.kind === entry.kind,
    );
    if (matching.length !== entry.sites) {
      problems.push({
        code: "declaration_count_drift",
        path: entry.path,
        symbol: entry.symbol,
        detail: `declared ${entry.sites}, found ${matching.length}`,
      });
      continue;
    }
    for (const finding of matching) waived.add(finding);
  }
  const undeclared = findings.filter((finding) => !waived.has(finding));
  return { findings, undeclared, problems };
}

/** The one-line, greppable form the CLI prints and CI matches on. */
export function formatFinding(finding) {
  return `silent_failure:${finding.kind}:${finding.path}:${finding.line}:${finding.symbol}`;
}
