/**
 * Every interactive control has an accessible name.
 *
 * An icon-only control reads as nothing: a screen reader announces "button", the
 * player has no way to tell the stop button from the disconnect button, and the
 * axe pass only notices if the element happens to be in the audited subtree. This
 * is the gate that would have caught the icon-only controls before review, so it
 * checks the *structure* of every control in the component tree - the tag, its
 * children, its attributes, and the `<label>` around it - and reports `file:line`.
 *
 * The rule, exactly: for every `<button>`, `<a href>`, `<input>` (except
 * `type="hidden"`), `<select>` and `<textarea>` in the component tree, at least one of
 *   - an `aria-label` or `aria-labelledby` attribute,
 *   - a name-bearing child: a text node or an expression container that is not
 *     inside an `aria-hidden="true"` subtree,
 *   - a wrapping `<label>` ancestor, or
 *   - an `id` matched by a literal `<label htmlFor="...">` in the same file
 * must hold.
 *
 * False positives, and how each is handled:
 *  - `aria-label={expression}` is accepted without evaluation: the gate cannot
 *    know what it resolves to, and rejecting dynamic names would flag correct code;
 *  - an `aria-hidden="true"` icon inside a button does not count as a name, which is
 *    the whole point (the lucide glyph beside a label is decoration, and it is
 *    already marked as such);
 *  - a `<label htmlFor={expression}>` cannot be matched to an `id`, so only the
 *    literal pairing is accepted and the dynamic form is reported as unnamed only
 *    when no other source exists - the same reading a browser would take;
 *  - `<a>` without `href` and the hidden input are not controls, so they are not
 *    inspected at all.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const DIALOGUE_WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(DIALOGUE_WEB, "src");

export function sourceFiles(directory = SRC) {
  const out = [];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
      continue;
    }
    if (name.endsWith(".tsx")) out.push(path);
  }
  return out;
}

export function at(node, sourceFile) {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${sourceFile.fileName.replace(/\\/gu, "/").split("/dialogue-web/").pop()}:${line + 1}`;
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

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

/**
 * The static text of an attribute, or `undefined` when it is absent/dynamic.
 * A template literal with no substitution counts as static; `{`id`}` is matched
 * against `` `id` `` by source text, which is how a mapped row names its field.
 */
function attributeValue(node, name) {
  const attributes = jsxAttributes(node);
  if (attributes === undefined) return undefined;
  for (const property of attributes.properties) {
    if (!ts.isJsxAttribute(property) || property.name.getText() !== name) continue;
    const initializer = property.initializer;
    if (initializer === undefined) return "";
    if (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer)) return initializer.text;
    return undefined; // a dynamic expression: present, but unevaluable
  }
  return undefined;
}

/** The attribute expression's own source text: how a template id and htmlFor pair up. */
function attributeSource(node, name) {
  const attributes = jsxAttributes(node);
  if (attributes === undefined) return null;
  for (const property of attributes.properties) {
    if (!ts.isJsxAttribute(property) || property.name.getText() !== name) continue;
    const initializer = property.initializer;
    if (initializer === undefined) return null;
    if (ts.isJsxExpression(initializer) && initializer.expression !== undefined)
      return initializer.expression.getText().replace(/\s+/gu, " ");
    return initializer.getText().replace(/\s+/gu, " ");
  }
  return null;
}

function hasAttribute(node, name) {
  const attributes = jsxAttributes(node);
  if (attributes === undefined) return false;
  return attributes.properties.some((property) => ts.isJsxAttribute(property) && property.name.getText() === name);
}

function intrinsicName(node) {
  const name = jsxTagName(node);
  return name !== null && ts.isIdentifier(name) ? name.text : null;
}

/** True for the elements a player can focus and operate. */
export function isInteractiveControl(node) {
  const tag = intrinsicName(node);
  if (tag === "button" || tag === "select" || tag === "textarea") return true;
  if (tag === "a") return hasAttribute(node, "href");
  if (tag === "input") return attributeValue(node, "type") !== "hidden";
  return false;
}

/** True for an element the author marked as decoration. */
function isAriaHidden(node) {
  return attributeValue(node, "aria-hidden") === "true";
}

/**
 * A name-bearing child: a JSX text node or an expression container, found by
 * walking **children only**. Attribute initialisers are also `JsxExpression`
 * nodes in this AST, and counting them would call `<button onClick={() => {}} />`
 * named - the icon-only button this gate exists for.
 */
function subtreeHasName(node) {
  if (!ts.isJsxElement(node)) return false;
  for (const child of node.children) {
    if (ts.isJsxText(child) && child.text.trim().length > 0) return true;
    if (ts.isJsxExpression(child) && child.expression !== undefined) return true;
    if (ts.isJsxElement(child) && !isAriaHidden(child) && subtreeHasName(child)) return true;
  }
  return false;
}

function insideLabel(node) {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isJsxElement(current) && intrinsicName(current) === "label") return true;
  }
  return false;
}

/** Every `<label htmlFor=...>` target in one source file, by source text. */
function labelledTargets(sourceFile) {
  const targets = new Set();
  walk(sourceFile, (node) => {
    if ((!ts.isJsxElement(node) && !ts.isJsxSelfClosingElement(node)) || intrinsicName(node) !== "label") return;
    const target = attributeSource(node, "htmlFor");
    if (target !== null && target.length > 0) targets.add(target);
  });
  return targets;
}

/** The name source of a control, or null when it has none. */
export function nameSourceOf(node, labelled) {
  if (hasAttribute(node, "aria-label") || hasAttribute(node, "aria-labelledby")) return "aria";
  if (subtreeHasName(node)) return "content";
  if (insideLabel(node)) return "wrapping label";
  const id = attributeSource(node, "id");
  if (id !== null && id.length > 0 && labelled.has(id)) return "htmlFor";
  // `title` is a real fallback in the accessible-name computation, so a control
  // that only has one is named - but it is the weakest source there is, so
  // `namedControls` reports those separately and a11y.5 bounds the set.
  if (hasAttribute(node, "title")) return "title";
  return null;
}

/** Every control in one source text: `{ line, tag, source }` for the unnamed ones. */
export function controlsIn(text, fileName) {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const labelled = labelledTargets(sourceFile);
  const found = [];
  walk(sourceFile, (node) => {
    if (!ts.isJsxElement(node) && !ts.isJsxSelfClosingElement(node)) return;
    if (!isInteractiveControl(node)) return;
    found.push({
      line: at(node, sourceFile),
      tag: intrinsicName(node) ?? "?",
      source: nameSourceOf(node, labelled),
      titleOnly: nameSourceOf(node, labelled) === "title",
    });
  });
  return found;
}

/** Every control in one source text that has no accessible name. */
export function unnamedControls(text, fileName) {
  return controlsIn(text, fileName)
    .filter((control) => control.source === null)
    .map((control) => ({ line: control.line, tag: control.tag }));
}

test("a11y.1: every interactive control has an accessible name", (t) => {
  const failures = [];
  const sources = new Map();
  const titleOnly = [];
  let controls = 0;
  let files = 0;
  for (const file of sourceFiles()) {
    files += 1;
    const text = readFileSync(file, "utf8");
    for (const control of controlsIn(text, file)) {
      controls += 1;
      if (control.source === null) {
        failures.push(`${control.line} <${control.tag}> has no accessible name`);
        continue;
      }
      sources.set(control.source, (sources.get(control.source) ?? 0) + 1);
      if (control.titleOnly) titleOnly.push(`${control.line} <${control.tag}>`);
    }
  }
  const breakdown = [...sources.entries()].map(([source, count]) => `${source}=${count}`).join(" ");
  t.diagnostic(
    `a11y.1: ${files} tsx file(s), ${controls} interactive control(s), named by { ${breakdown} }, ${failures.length} unnamed, ${titleOnly.length} named by title alone`,
  );
  assert.deepEqual(failures, [], "a control with no accessible name reads as nothing to a screen reader");
});

/**
 * The controls whose only accessible name is `title`. `title` is a real fallback
 * in the name computation, so these are named - but it is the weakest source (no
 * visible text, hidden from touch, inconsistently announced), so the set is
 * bounded here: a new title-only control has to be a decision rather than an
 * accident.
 */
const TITLE_ONLY_CONTROLS = ["src/components/management-surface-panels.tsx:304 <button>"];

test("a11y.5: the one title-only control is the chat row's rename button", (t) => {
  const found = [];
  for (const file of sourceFiles()) {
    const text = readFileSync(file, "utf8");
    for (const control of controlsIn(text, file))
      if (control.titleOnly) found.push(`${control.line} <${control.tag}>`);
  }
  t.diagnostic(`a11y.5: ${found.length} title-only control(s), ${TITLE_ONLY_CONTROLS.length} declared`);
  assert.deepEqual(found, TITLE_ONLY_CONTROLS, "a new title-only control needs a decision: give it visible text or an aria-label");
});

test("a11y.2: the tree really is being read, not vacuously passing", (t) => {
  const files = sourceFiles();
  assert.ok(files.length >= 15, `expected the component tree, found ${files.length} tsx file(s)`);
  let controls = 0;
  for (const file of files) {
    const sourceFile = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    walk(sourceFile, (node) => {
      if ((ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) && isInteractiveControl(node)) controls += 1;
    });
  }
  assert.ok(controls >= 40, `expected at least 40 controls in the tree, found ${controls}`);
  t.diagnostic(`a11y.2: ${files.length} tsx file(s), ${controls} interactive control(s) enumerated`);
});

test("a11y.3 (mutation): an icon-only button fails with file and line", (t) => {
  const unnamed = [
    "export const Probe = () => (",
    '  <button type="button" onClick={() => {}}>',
    '    <svg viewBox="0 0 1 1" />',
    "  </button>",
    ");",
  ].join("\n");
  assert.deepEqual(unnamedControls(unnamed, "src/components/Mutation.tsx"), [
    { line: "src/components/Mutation.tsx:2", tag: "button" },
  ]);
  t.diagnostic("a11y.3: icon-only button reported at src/components/Mutation.tsx:2");
});

test("a11y.4: every accepted name source is real code shape, not a loophole", (t) => {
  const accepted = [
    'const a = <button aria-label="Stop" />;',
    'const b = <button><Power size={16} aria-hidden="true" />{labels.stop}</button>;',
    'const c = <label htmlFor="field">Name</label>; const d = <input id="field" />;',
    'const e = <label>Name<input type="text" /></label>;',
    'const f = <a href="/x">Docs</a>;',
    'const g = <input type="hidden" name="csrf" />;',
  ].join("\n");
  assert.deepEqual(unnamedControls(accepted, "src/components/Accepted.tsx"), []);

  const rejected = [
    "const a = <button><Power size={16} aria-hidden=\"true\" /></button>;",
    'const b = <textarea className="form-textarea" />;',
    'const c = <a href="/x"><svg viewBox="0 0 1 1" aria-hidden="true" /></a>;',
  ].join("\n");
  assert.deepEqual(
    unnamedControls(rejected, "src/components/Rejected.tsx").map((finding) => finding.tag),
    ["button", "textarea", "a"],
  );
  t.diagnostic("a11y.4: six accepted shapes clean; three unnamed shapes reported");
});
