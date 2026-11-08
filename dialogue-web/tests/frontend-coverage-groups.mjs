/**
 * What kind of source file this is, and therefore which coverage group it belongs to.
 *
 * The reason this is derived from the file's own syntax tree rather than from a
 * list of names: the groups exist because a percentage over all of `src` answers a
 * question nobody asked. `management-pipeline-api.ts` (4.3 k lines of protocol
 * types and validators) and `i18n.ts` (1.9 k lines of string tables) would
 * dominate any total, and a high number over either says "the module was imported",
 * not "the player can read the screen". A file list would go stale the first time
 * somebody added a module; the four rules below are properties of the code, so a
 * new mirror or a new panel joins its group without anyone editing this file.
 *
 * The rules, in order (first match wins):
 *
 *   wire      - exports at least one function that narrows an `unknown` value into
 *               a declared shape (the `is`/`assert`/`parse`/`read`/`validate`
 *               naming recipe), and renders nothing. This is the shape of a
 *               mirror: its statements decide whether an external document matches
 *               a contract, so its coverage measures protocol knowledge.
 *   catalogue - renders nothing and its body is dominated by string-literal
 *               property assignments. A string table's coverage means the
 *               catalogue was walked, not that anything was shown.
 *   rendered  - contains JSX. A statement here is something the player can be
 *               looking at, which is where a lost draft or a zero-forward-path
 *               defect lives.
 *   state     - everything else: routing, session state, domain transforms and the
 *               hooks that bind them. No JSX, but it is code a surface executes.
 */
import { readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import ts from "typescript";

/** The four groups, in the order the rules are tried. */
export const GROUP_ORDER = Object.freeze(["wire", "catalogue", "rendered", "state"]);

/**
 * A colocated unit test (a `*.test.ts` beside the source it exercises, under `src/`).
 *
 * It is not code the browser can load: no journey can ever reach it, so counting it would
 * make the product's coverage a function of how many unit tests somebody wrote - and it
 * would punish exactly the change that raises confidence. It is excluded from the
 * denominator and counted in the report (`excluded=N test file(s)`), never dropped silently.
 */
const UNIT_TEST_FILE = /\.test\.tsx?$/u;

const NARROWING_NAME = /^(?:is|assert|parse|read|validate)[A-Z]/u;

/** One exported function that checks an `unknown` payload and returns a declared shape. */
function narrowsUnknown(node) {
  if (!ts.isFunctionDeclaration(node) || node.name === undefined) return false;
  const exported = node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
  if (!exported || !NARROWING_NAME.test(node.name.text)) return false;
  return node.parameters.some((parameter) => parameter.type?.kind === ts.SyntaxKind.UnknownKeyword);
}

/** The structural facts a group can be decided from, for one parsed source file. */
export function shapeOf(file) {
  const source = readFileSync(file, "utf8");
  const kind = extname(file) === ".tsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const shape = { lines: source.split("\n").length, jsx: 0, narrows: 0, stringEntries: 0 };
  const visit = (node) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) shape.jsx += 1;
    else if (narrowsUnknown(node)) shape.narrows += 1;
    else if (ts.isPropertyAssignment(node) && ts.isStringLiteralLike(node.initializer)) shape.stringEntries += 1;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return shape;
}

/** Which group one file belongs to, by the rules in this file's header. */
export function groupOf(shape) {
  if (shape.jsx === 0 && shape.narrows > 0) return "wire";
  if (shape.jsx === 0 && shape.stringEntries > 0 && shape.stringEntries >= shape.lines / 5) return "catalogue";
  if (shape.jsx > 0) return "rendered";
  return "state";
}

/**
 * Every module of the frontend, and every unit test that sits beside one.
 *
 * One walk answers both: `modules` are the product files the coverage denominator is
 * built from, `excluded` are the colocated unit tests it leaves out. Returned together
 * so the report prints the exclusion from the same scan that made it.
 */
export function sourcePopulation(srcDirectory) {
  const modules = [];
  const excluded = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (extname(path) === ".ts" || extname(path) === ".tsx") {
        const module = relative(srcDirectory, path).split(sep).join("/");
        (UNIT_TEST_FILE.test(entry.name) ? excluded : modules).push(module);
      }
    }
  };
  walk(srcDirectory);
  return { modules: modules.sort(), excluded: excluded.sort() };
}

/** The group of every product module under `src`, keyed by its `src`-relative path. */
export function classify(srcDirectory, modules = sourcePopulation(srcDirectory).modules) {
  const groups = new Map();
  for (const module of modules) {
    groups.set(module, groupOf(shapeOf(join(srcDirectory, module))));
  }
  return groups;
}
