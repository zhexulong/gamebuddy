#!/usr/bin/env node
/**
 * Gate for the "classify another module's failure by its message text" bug class.
 *
 * A typed error is an identity: the module that throws it can export it, and a
 * caller can ask `error instanceof ExactThreadNotFoundError`. Reaching across
 * that boundary by comparing `error.message` to the literal the class throws is
 * fragile - the literal is an implementation detail of the thrower, and any
 * reword silently re-routes the caller's control flow.
 *
 * Two shapes of that comparison are reported:
 *
 *   - direct:   `<expr>.message <op> "<literal>"`
 *   - one hop:  `const <name> = <expr>.message` (anywhere above) ...
 *               `<name> <op> "<literal>"`
 *
 * The one-hop shape is the one a request edge reaches for: the message is copied
 * into a local once and then compared many times. It is followed exactly one hop
 * and no further. The alias set is built per file in line order - a `const`
 * declaration whose initialiser reads a `.message` property registers the name,
 * and only comparisons after that line are reported. Reassignment, shadowing,
 * destructuring (`const { message } = error`), a `.message` read through a
 * helper, and any second hop are not followed. Each of those keeps the same
 * defect alive, so each is a stated limit of a one-hop rule rather than a claim
 * that the rest of the tree is clean.
 *
 * A comparison is reported only when all three hold, whichever shape it has:
 *
 *   1. the compared literal is the `super("<literal>")` message of a class that
 *      extends an `Error`-named base somewhere in the scanned tree - it really is
 *      an error identity, not an incidental string;
 *   2. that class is defined in a *different* file than the comparison - a module
 *      matching its own private message is not crossing a boundary;
 *   3. the literal is never constructed as a bare `new Error("<literal>")` in the
 *      scanned tree. A literal with both a typed and a bare producer cannot be
 *      classified by `instanceof` alone, so it is left to a deliberate decision
 *      rather than an automatic finding.
 *
 * Classes that take their message as a constructor argument (`super(code)`) are
 * out of scope: the literal never appears at the `super(...)` site to match on.
 *
 * Usage:
 *   node tools/check-error-identity-classification.mjs [scopeDir]
 *
 * Exit code is 1 when any finding is reported, 0 otherwise.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SCOPE = join(REPOSITORY_ROOT, "host", "src");

const MESSAGE_COMPARISON = /(?:\b[A-Za-z_$][\w$]*\??\.message)\s*(?:===|!==|==|!=)\s*"([^"]*)"/gu;
const LOCAL_COMPARISON = /(?<![.\w$])([A-Za-z_$][\w$]*)\s*(?:===|!==|==|!=)\s*"([^"]*)"/gu;
/** `const <name>[: type] = <anything>.message` - one hop, declaration order. */
const MESSAGE_ALIAS = /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=[^;\n]*\.message\b/gu;
const SUPER_LITERAL = /super\(\s*"([^"]+)"\s*\)/gu;
const BARE_ERROR = /new\s+Error\(\s*"([^"]+)"\s*\)/gu;
const CLASS_HEAD = /class\s+[A-Za-z_$][\w$]*\s+extends\s+([\w$.]+)/gu;
const ERROR_BASE = /(?:^|[.\w$])Error$/u;

/** Every non-overlapping match of a global regex on one line, from a fixed start. */
function matchesOn(line, pattern) {
  pattern.lastIndex = 0;
  return [...line.matchAll(pattern)];
}

/** True for a shipped `.ts` source; committed tests and fixtures are excluded. */
export function isProductionSource(relativePath) {
  const normalized = relativePath.split(sep).join("/");
  if (!normalized.endsWith(".ts") || normalized.endsWith(".d.ts")) return false;
  if (/\.test\.ts$/u.test(normalized)) return false;
  if (/\.test-support\.ts$/u.test(normalized)) return false;
  if (/(?:^|\/)test-support\//u.test(normalized)) return false;
  if (/(?:^|\/)test-fixtures\//u.test(normalized)) return false;
  return true;
}

function listProductionSources(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && isProductionSource(relative(root, full))) files.push(full);
    }
  };
  walk(root);
  files.sort();
  return files;
}

/**
 * Every error identity literal in the tree, with the file that defines it, plus
 * every literal a bare `new Error(...)` constructs.
 */
export function collectErrorIdentities(root) {
  const files = listProductionSources(root);
  const identityByLiteral = new Map();
  const bareLiterals = new Set();
  for (const file of files) {
    const rel = relative(root, file).split(sep).join("/");
    const lines = readFileSync(file, "utf8").split(/\r?\n/u);
    let classBase;
    for (const line of lines) {
      CLASS_HEAD.lastIndex = 0;
      for (let match = CLASS_HEAD.exec(line); match !== null; match = CLASS_HEAD.exec(line))
        classBase = match[1];
      SUPER_LITERAL.lastIndex = 0;
      for (let match = SUPER_LITERAL.exec(line); match !== null; match = SUPER_LITERAL.exec(line)) {
        if (classBase === undefined || !ERROR_BASE.test(classBase)) continue;
        const definedIn = identityByLiteral.get(match[1]) ?? new Set();
        definedIn.add(rel);
        identityByLiteral.set(match[1], definedIn);
      }
      BARE_ERROR.lastIndex = 0;
      for (let match = BARE_ERROR.exec(line); match !== null; match = BARE_ERROR.exec(line))
        bareLiterals.add(match[1]);
    }
  }
  return { files, identityByLiteral, bareLiterals };
}

/**
 * Every place that classifies another module's typed failure by text, in either
 * the direct or the one-hop form.
 */
export function findViolations({ root = DEFAULT_SCOPE } = {}) {
  const { files, identityByLiteral, bareLiterals } = collectErrorIdentities(root);
  const findings = [];
  for (const file of files) {
    const rel = relative(root, file).split(sep).join("/");
    const lines = readFileSync(file, "utf8").split(/\r?\n/u);
    const aliasedNames = new Set();
    for (const [index, line] of lines.entries()) {
      const record = (literal, form, local) => {
        const definedIn = identityByLiteral.get(literal);
        if (definedIn === undefined) return;
        if (bareLiterals.has(literal)) return;
        if (definedIn.has(rel)) return;
        findings.push({ file: rel, line: index + 1, literal, definedIn: [...definedIn].sort()[0], form, local });
      };
      for (const match of matchesOn(line, MESSAGE_COMPARISON)) record(match[1], "direct", undefined);
      for (const match of matchesOn(line, LOCAL_COMPARISON)) {
        if (!aliasedNames.has(match[1])) continue;
        record(match[2], "aliased-local", match[1]);
      }
      for (const match of matchesOn(line, MESSAGE_ALIAS)) aliasedNames.add(match[1]);
    }
  }
  return findings;
}

export function main(argv = process.argv.slice(2)) {
  const scope = resolve(argv.find((argument) => !argument.startsWith("--")) ?? DEFAULT_SCOPE);
  const scopeLabel = relative(REPOSITORY_ROOT, scope).split(sep).join("/") || ".";
  const findings = findViolations({ root: scope });
  if (findings.length === 0) {
    process.stdout.write(`error_identity_classification_ok scope=${scopeLabel}\n`);
    return 0;
  }
  process.stdout.write(`error_identity_classification_failed findings=${findings.length}\n`);
  for (const finding of findings) {
    const subject =
      finding.form === "aliased-local"
        ? `the local "${finding.local}", a copy of a .message`
        : "error.message";
    process.stdout.write(
      `  ${finding.file}:${finding.line} compares ${subject} to "${finding.literal}", an error identity defined in ${finding.definedIn}\n`,
    );
  }
  process.stdout.write("classify the typed error by identity instead of matching its message text\n");
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
