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
 * The rule is scoped to be precise rather than exhaustive. A comparison is
 * reported only when all three hold:
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
 * The gate reports the direct `<expr>.message <op> "<literal>"` form only; an
 * aliased `const message = error.message` comparison is not resolved.
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
const SUPER_LITERAL = /super\(\s*"([^"]+)"\s*\)/gu;
const BARE_ERROR = /new\s+Error\(\s*"([^"]+)"\s*\)/gu;
const CLASS_HEAD = /class\s+[A-Za-z_$][\w$]*\s+extends\s+([\w$.]+)/gu;
const ERROR_BASE = /(?:^|[.\w$])Error$/u;

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

/** Every `<expr>.message <op> "<literal>"` that classifies another module's typed failure by text. */
export function findViolations({ root = DEFAULT_SCOPE } = {}) {
  const { files, identityByLiteral, bareLiterals } = collectErrorIdentities(root);
  const findings = [];
  for (const file of files) {
    const rel = relative(root, file).split(sep).join("/");
    const lines = readFileSync(file, "utf8").split(/\r?\n/u);
    for (const [index, line] of lines.entries()) {
      MESSAGE_COMPARISON.lastIndex = 0;
      for (let match = MESSAGE_COMPARISON.exec(line); match !== null; match = MESSAGE_COMPARISON.exec(line)) {
        const literal = match[1];
        const definedIn = identityByLiteral.get(literal);
        if (definedIn === undefined) continue;
        if (bareLiterals.has(literal)) continue;
        if (definedIn.has(rel)) continue;
        findings.push({ file: rel, line: index + 1, literal, definedIn: [...definedIn].sort()[0] });
      }
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
  for (const finding of findings)
    process.stdout.write(
      `  ${finding.file}:${finding.line} compares error.message to "${finding.literal}", an error identity defined in ${finding.definedIn}\n`,
    );
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
