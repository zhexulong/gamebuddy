/**
 * Form and control hygiene for the component directory.
 *
 * "Raw/unstyled control" keeps recurring because nothing in the test suite ever
 * looks at what the JSX actually renders: a bare `<details>` is the browser's
 * black triangle, a bare `<ul>` is the default bullet indent, and a file input
 * with no styled wrapper is the browser's grey "Choose file" button. This gate
 * reads the component source as structure (the TypeScript compiler's TSX parser,
 * not a regex that a comment can defeat) and fails on the four shapes that
 * produced those defects, so the next occurrence is caught before review.
 *
 * Every failure names the file and the 1-based line, so the message is a route.
 * Every test also prints what it checked and found clean (`t.diagnostic`), so a
 * passing run is evidence rather than silence.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const DIALOGUE_WEB = join(HERE, "..");
const COMPONENTS = join(DIALOGUE_WEB, "src", "components");
const STYLESHEET = join(DIALOGUE_WEB, "src", "style.css");
const I18N = join(DIALOGUE_WEB, "src", "i18n.ts");

/** Component sources are the top-level `*.tsx` files the brief names. */
function componentFiles() {
  return readdirSync(COMPONENTS)
    .filter((name) => name.endsWith(".tsx"))
    .sort()
    .map((name) => join(COMPONENTS, name));
}

function parse(file) {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/** The JSX tag name of an element or self-closing element, or null. */
function jsxTagName(node) {
  if (ts.isJsxElement(node)) return node.openingElement.tagName;
  if (ts.isJsxSelfClosingElement(node)) return node.tagName;
  return null;
}

function jsxAttributes(node) {
  if (ts.isJsxElement(node)) return node.openingElement.attributes;
  if (ts.isJsxSelfClosingElement(node)) return node.attributes;
  return undefined;
}

/** True when `node` is the intrinsic element `tag` (e.g. `<p>`). */
function isElement(node, tag) {
  const name = jsxTagName(node);
  return name !== null && ts.isIdentifier(name) && name.text === tag;
}

/** Every JSX element/self-closing element in the subtree, including `node`. */
function jsxElements(node) {
  const found = [];
  walk(node, (child) => {
    if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) found.push(child);
  });
  return found;
}

function stringLiteralValue(initializer) {
  if (initializer === undefined) return null;
  if (ts.isStringLiteral(initializer)) return initializer.text;
  if (ts.isJsxExpression(initializer) && initializer.expression !== undefined) {
    if (ts.isStringLiteral(initializer.expression)) return initializer.expression.text;
    if (ts.isNoSubstitutionTemplateLiteral(initializer.expression)) return initializer.expression.text;
  }
  return null;
}

/** Static attribute values as text; a dynamic expression reads as null. */
function attributes(node) {
  const out = new Map();
  const attrs = jsxAttributes(node);
  if (attrs === undefined) return out;
  for (const property of attrs.properties) {
    if (!ts.isJsxAttribute(property)) continue;
    out.set(property.name.getText(), stringLiteralValue(property.initializer));
  }
  return out;
}

function classNameOf(node) {
  const attrs = attributes(node);
  return attrs.get("className") ?? attrs.get("class") ?? null;
}

/** `file:line` for the first token of a node, relative to dialogue-web. */
function at(node, sourceFile) {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const file = sourceFile.fileName.replace(/\\/gu, "/").split("/dialogue-web/").pop();
  return `${file}:${line + 1}`;
}

/** The class names style.css actually writes a rule for. */
function styledClassNames() {
  const css = readFileSync(STYLESHEET, "utf8").replace(/\/\*[\s\S]*?\*\//gu, "");
  const names = new Set();
  for (const match of css.matchAll(/\.(-?[A-Za-z_][A-Za-z0-9_-]*)/gu)) names.add(match[1]);
  return names;
}

function lucideComponentNames(sourceFile) {
  const names = new Set();
  walk(sourceFile, (node) => {
    if (!ts.isImportDeclaration(node)) return;
    if (!ts.isStringLiteral(node.moduleSpecifier) || node.moduleSpecifier.text !== "lucide-react") return;
    const bindings = node.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) return;
    for (const element of bindings.elements) names.add(element.name.text);
  });
  return names;
}

/** A `<summary>` carries an explicit icon when it renders an imported lucide
 *  component or an inline `<svg>` - never the browser's own triangle. */
function summaryHasIcon(summary, lucideNames) {
  return jsxElements(summary).some((element) => {
    const name = jsxTagName(element);
    if (name === null) return false;
    if (ts.isIdentifier(name)) return name.text === "svg" || lucideNames.has(name.text);
    return false;
  });
}

/** A paragraph the browser styles: no class, so the UA default applies. */
function bareParagraph(child) {
  return (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) && isElement(child, "p") && classNameOf(child) === null;
}

/** Containers whose stacked bare paragraphs read like a stdout dump. */
function isStatusOrCardContainer(node) {
  const attrs = attributes(node);
  const role = attrs.get("role");
  if (role === "status" || role === "alert") return true;
  const className = classNameOf(node);
  if (className === null) return false;
  return className
    .split(/\s+/u)
    .some((token) => ["banner", "card", "status", "notice", "placeholder"].some((marker) => token.includes(marker)));
}

/** Does the subtree contain a `.map(...)` call (i.e. dynamic entries)? */
function hasMapCall(node) {
  let found = false;
  walk(node, (child) => {
    if (found) return;
    if (
      ts.isCallExpression(child) &&
      ts.isPropertyAccessExpression(child.expression) &&
      child.expression.name.text === "map"
    )
      found = true;
  });
  return found;
}

function labelKeyIsOpeningChat(node) {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "labels" &&
    node.name.text === "openingChat"
  );
}

test("gate 1.1: a file input is never the browser's raw choose-file control", (t) => {
  const styled = styledClassNames();
  const failures = [];
  let fileInputs = 0;
  const files = componentFiles();
  for (const file of files) {
    const sourceFile = parse(file);
    walk(sourceFile, (node) => {
      if ((!ts.isJsxElement(node) && !ts.isJsxSelfClosingElement(node)) || !isElement(node, "input")) return;
      if (attributes(node).get("type") !== "file") return;
      fileInputs += 1;
      const className = classNameOf(node);
      const first = className === null ? null : className.split(/\s+/u)[0];
      if (className === null || first === null || !styled.has(first))
        failures.push(`${at(node, sourceFile)} raw <input type="file"> (className=${JSON.stringify(className)})`);
    });
  }
  t.diagnostic(`gate 1.1: ${files.length} files, ${fileInputs} file input(s), ${failures.length} violation(s)`);
  assert.deepEqual(failures, [], "a file input must be styled (or sit in a styled wrapper), never raw");
});

test("gate 1.2: a <details> is classed and its <summary> carries an explicit icon", (t) => {
  const failures = [];
  let details = 0;
  let summaries = 0;
  const files = componentFiles();
  for (const file of files) {
    const sourceFile = parse(file);
    const lucide = lucideComponentNames(sourceFile);
    walk(sourceFile, (node) => {
      if (!ts.isJsxElement(node) || !isElement(node, "details")) return;
      details += 1;
      const className = classNameOf(node);
      if (className === null || className.trim() === "")
        failures.push(`${at(node, sourceFile)} bare <details> with no styling class`);
      for (const element of jsxElements(node)) {
        if (!isElement(element, "summary")) continue;
        summaries += 1;
        if (!summaryHasIcon(element, lucide))
          failures.push(`${at(element, sourceFile)} <summary> without an explicit icon`);
      }
    });
  }
  t.diagnostic(`gate 1.2: ${files.length} files, ${details} <details>, ${summaries} <summary>, ${failures.length} violation(s)`);
  assert.deepEqual(failures, [], "a <details> must be styled and its <summary> must render an icon");
});

test("gate 1.3: no status/card container stacks three or more bare <p>", (t) => {
  const failures = [];
  let containers = 0;
  const files = componentFiles();
  for (const file of files) {
    const sourceFile = parse(file);
    walk(sourceFile, (node) => {
      if (!ts.isJsxElement(node) || !isStatusOrCardContainer(node)) return;
      containers += 1;
      let run = 0;
      for (const child of node.children) {
        if (ts.isJsxText(child)) continue; // whitespace between elements
        if (bareParagraph(child)) {
          run += 1;
          if (run === 3) failures.push(`${at(child, sourceFile)} third consecutive bare <p> in a status/card container`);
        } else {
          run = 0;
        }
      }
    });
  }
  t.diagnostic(`gate 1.3: ${files.length} files, ${containers} status/card container(s), ${failures.length} violation(s)`);
  assert.deepEqual(failures, [], "three stacked bare <p> read as a console dump; use a dl/dt/dd, chips or a card");
});

test("gate 1.4: a list carrying dynamic entries is never the raw bullet list", (t) => {
  const failures = [];
  let dynamicLists = 0;
  const files = componentFiles();
  for (const file of files) {
    const sourceFile = parse(file);
    walk(sourceFile, (node) => {
      if (!ts.isJsxElement(node)) return;
      const name = jsxTagName(node);
      if (name === null || !ts.isIdentifier(name) || (name.text !== "ul" && name.text !== "ol")) return;
      if (!hasMapCall(node)) return;
      dynamicLists += 1;
      const attrs = attributes(node);
      const hasClass = classNameOf(node) !== null;
      const hasHook = [...attrs.keys()].some((key) => key.startsWith("data-"));
      if (!hasClass && !hasHook)
        failures.push(`${at(node, sourceFile)} bare <${name.text}> with .map() entries`);
    });
  }
  t.diagnostic(`gate 1.4: ${files.length} files, ${dynamicLists} dynamic list(s), ${failures.length} violation(s)`);
  assert.deepEqual(failures, [], "a dynamic list must carry a styling class or a data hook");
});

test("gate 1.5: a panel's loading text is not another panel's copy", (t) => {
  // The three panel loading states reused `openingChat` ("Opening chat…"), which
  // is the chat surface's own copy. The honest generic loading string is the
  // `loading` key; assert both that the reuse is gone and that the generic key
  // is genuinely a different string in both catalogs.
  const sourceFile = parse(join(COMPONENTS, "management-panels.tsx"));
  const failures = [];
  walk(sourceFile, (node) => {
    if (labelKeyIsOpeningChat(node)) failures.push(`${at(node, sourceFile)} labels.openingChat reused outside the chat surface`);
  });
  assert.deepEqual(failures, []);

  const i18n = readFileSync(I18N, "utf8");
  const valueOf = (key) => {
    const match = new RegExp(`${key}:\\s*"([^"]*)"`, "gu");
    return [...i18n.matchAll(match)].map((entry) => entry[1]);
  };
  const opening = valueOf("openingChat");
  const loading = valueOf("loading");
  assert.equal(opening.length, 2, "openingChat must exist in both catalogs");
  assert.equal(loading.length, 2, "loading must exist in both catalogs");
  assert.notDeepEqual(loading, opening, "the generic loading string must not be the chat-opening string");
  t.diagnostic(`gate 1.5: management-panels.tsx, ${failures.length} openingChat reuse(s); loading=${JSON.stringify(loading)} vs openingChat=${JSON.stringify(opening)}`);
});
