/**
 * One declared icon family, and no emoji standing in for a structural control.
 *
 * An emoji in a control is a defect the review catches late: it renders in the
 * platform's own colour font, it is not part of `lucide-react`'s stroke set, it
 * changes shape per OS, it cannot take `currentColor`, and a screen reader reads
 * it aloud by an unrelated name ("wrench") instead of the action. The project's
 * rule is one declared icon family, so a glyph that is a *control* - a button, a
 * link, a disclosure summary, or anything carrying a `data-testid` (i.e. anything
 * a test or a player treats as structural) - may not be an emoji.
 *
 * The boundary is deliberate, and it is where the emoji is: inside a control or a
 * `data-testid` element is a finding; inside user-facing prose is not. A companion
 * who writes "🌻" in a message, a sample sentence in a fixture, a decorative emoji
 * in authored content - none of those are structural, and flagging them would make
 * the gate cry wolf.
 *
 * Both rules read JSX structure (the `data-testid` element is found as an element,
 * not as a substring) and report `file:line`.
 *
 * False positives, and how each is handled:
 *  - emoji detection uses Unicode's `Extended_Pictographic`, so typographic marks
 *    the product legitimately uses ("…", "—", "·", "✓", "→") are not emoji and are
 *    never findings - only actual pictographs are;
 *  - only JSX *children* are inspected, so an emoji inside a string literal that is
 *    passed as data (a message body, a fixture text) is out of scope;
 *  - `svg` elements are not emoji, so an inline icon is never a finding; the
 *    separate import check is what keeps the icon family single.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const DIALOGUE_WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(DIALOGUE_WEB, "src");

/** The one declared icon family. */
const ICON_FAMILY = "lucide-react";

/** A package that would introduce a second icon family. */
const FOREIGN_ICON_PACKAGES = /^(@?fortawesome\/|@?heroicons\/|@?iconify\/|react-icons|react-feather|feather-icons|material-icons)/u;

/** Unicode's own pictograph class: typographic marks are not here, emoji are. */
const EMOJI = /[\p{Extended_Pictographic}\u{20e3}]/u;

export function hasEmoji(value) {
  return EMOJI.test(value);
}

export function sourceFiles(directory = SRC) {
  const out = [];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
      continue;
    }
    if (name.endsWith(".tsx") || name.endsWith(".ts")) out.push(path);
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

function hasAttribute(node, name) {
  const attributes = jsxAttributes(node);
  if (attributes === undefined) return false;
  return attributes.properties.some((property) => ts.isJsxAttribute(property) && property.name.getText() === name);
}

function intrinsicName(node) {
  const name = jsxTagName(node);
  return name !== null && ts.isIdentifier(name) ? name.text : null;
}

/** A control, or anything a test or a player treats as structural. */
export function isStructural(node) {
  const tag = intrinsicName(node);
  if (tag === "button" || tag === "a" || tag === "summary") return true;
  return hasAttribute(node, "data-testid");
}

/** Every structural element's own text that contains an emoji. */
export function emojiInControls(text, fileName) {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = [];
  const visit = (node) => {
    if (ts.isJsxElement(node) && isStructural(node)) {
      for (const child of node.children) {
        if (ts.isJsxText(child) && hasEmoji(child.text))
          found.push({ line: at(node, sourceFile), kind: intrinsicName(node) ?? "component", value: child.text.trim() });
        if (ts.isJsxElement(child) && !ts.isJsxText(child))
          for (const nested of textIn(child)) {
            if (hasEmoji(nested.text))
              found.push({
                line: at(nested.node, sourceFile),
                kind: intrinsicName(child) ?? "component",
                value: nested.text.trim(),
              });
          }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

/** Text nodes inside a JSX element's own children, with their line. */
function textIn(element) {
  const out = [];
  const visit = (node) => {
    if (ts.isJsxText(node) && node.text.trim().length > 0) out.push({ node, text: node.text });
    for (const child of ts.isJsxElement(node) ? node.children : []) visit(child);
  };
  visit(element);
  return out;
}

/** Imports that would introduce a second icon family. */
export function foreignIconImports(text, fileName) {
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = [];
  walk(sourceFile, (node) => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return;
    const specifier = node.moduleSpecifier.text;
    if (FOREIGN_ICON_PACKAGES.test(specifier))
      found.push({ line: at(node, sourceFile), specifier });
  });
  return found;
}

test("icon.1: no emoji is a control", (t) => {
  const failures = [];
  let files = 0;
  let structural = 0;
  for (const file of sourceFiles()) {
    files += 1;
    const text = readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    walk(sourceFile, (node) => {
      if ((ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) && isStructural(node)) structural += 1;
    });
    for (const finding of emojiInControls(text, file))
      failures.push(`${finding.line} emoji in <${finding.kind}>: ${JSON.stringify(finding.value)}`);
  }
  t.diagnostic(`icon.1: ${files} file(s), ${structural} structural element(s), ${failures.length} emoji control(s)`);
  assert.deepEqual(failures, [], "an emoji is not part of the declared icon family and reads by the wrong name");
});

test("icon.2: every icon import is the declared family", (t) => {
  const failures = [];
  let files = 0;
  let imports = 0;
  for (const file of sourceFiles()) {
    files += 1;
    const text = readFileSync(file, "utf8");
    for (const finding of foreignIconImports(text, file))
      failures.push(`${finding.line} imports a second icon family: ${finding.specifier}`);
    imports += [...text.matchAll(new RegExp(`from "${ICON_FAMILY}"`, "gu"))].length;
  }
  t.diagnostic(`icon.2: ${files} file(s), ${imports} ${ICON_FAMILY} import(s), ${failures.length} foreign icon import(s)`);
  assert.deepEqual(failures, [], "one declared icon family: a second one means two visual languages");
});

test("icon.3 (mutation): an emoji inside a button and inside a data-testid element fail", (t) => {
  const mutated = [
    "export const Probe = () => (",
    '  <div>',
    '    <button type="button" aria-label="Wrench">🔧</button>',
    '    <span data-testid="status">✅ Ready</span>',
    "  </div>",
    ");",
  ].join("\n");
  assert.deepEqual(
    emojiInControls(mutated, "src/components/Mutation.tsx").map((finding) => [finding.line, finding.kind]),
    [
      ["src/components/Mutation.tsx:3", "button"],
      ["src/components/Mutation.tsx:4", "span"],
    ],
  );
  t.diagnostic("icon.3: emoji reported at :3 (button) and :4 (data-testid span)");
});

test("icon.4: emoji in prose, a fixture string and a typographic mark are not findings", (t) => {
  const clean = [
    "const sample = \"The farm 🌻 is lovely\";",
    "export const Render = () => (",
    '  <p data-testid="nothing">{sample} — wait… ✓</p>',
    ");",
  ].join("\n");
  assert.deepEqual(emojiInControls(clean, "src/components/Clean.tsx"), []);
  t.diagnostic("icon.4: prose emoji outside a control, an em dash, an ellipsis and a check mark are all clean");
});

test("icon.5: the tree really is being read, not vacuously passing", (t) => {
  const files = sourceFiles();
  assert.ok(files.length >= 20, `expected the component tree, found ${files.length}`);
  let structural = 0;
  for (const file of files) {
    const sourceFile = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    walk(sourceFile, (node) => {
      if ((ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) && isStructural(node)) structural += 1;
    });
  }
  assert.ok(structural >= 40, `expected at least 40 controls/testid elements, found ${structural}`);
  t.diagnostic(`icon.5: ${files.length} file(s), ${structural} structural element(s) enumerated`);
});
