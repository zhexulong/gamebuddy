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
 * Gate 1.1 asks for the *pair*, not for a class: a file input styled on its own
 * box - the shape the character surface shipped, a `<input type="file">` with
 * `className="form-input"` - still paints the platform's own "Choose file"
 * button and file name inside that box, white-on-dark in the middle of the
 * tavern surface. So the input must be taken out of the visual flow
 * (`clip-path: inset(50%)`, the recipe this sheet writes) and the file it picks
 * must be asked for by a themed `button`/`label` in the same file - a class that
 * merely *exists* is not a control.
 *
 * Every failure names the file and the 1-based line, so the message is a route.
 * Every test also prints what it checked and found clean (`t.diagnostic`), so a
 * passing run is evidence rather than silence.
 *
 * Two of the shapes now live in `tools/ast-grep/rules` and run as
 * `pnpm lint:ast-grep`, because they are pure structure and the maintained rule
 * engine expresses them in prose: `bare-details` (a `<details>` with no
 * `className`) and `bare-dynamic-list` (a `<ul>`/`<ol>` carrying `.map()`
 * entries with neither a class nor a `data-` hook). What is left here needs more
 * than structure - which class the stylesheet actually takes out of the visual
 * flow or paints a themed surface (gates 1.1, 1.6), which class markers mark a
 * status/card container (gate 1.3), which i18n key a panel is reusing (gate
 * 1.5), and whether a `<summary>`'s child is an imported lucide component (gate
 * 1.2) - and none of that is knowable from a pattern rule.
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

/** The raw `name={…}` attribute node, for the values a static string cannot read. */
function jsxAttribute(node, name) {
  const attrs = jsxAttributes(node);
  if (attrs === undefined) return undefined;
  for (const property of attrs.properties) {
    if (ts.isJsxAttribute(property) && property.name.getText() === name) return property;
  }
  return undefined;
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

function labelKeyIsOpeningChat(node) {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "labels" &&
    node.name.text === "openingChat"
  );
}

test("gate 1.1: a file input is visually hidden and driven by a themed control", (t) => {
  const byClass = classDeclarations();
  const hidden = visuallyHiddenClassNames();
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
      const tokens = className === null ? [] : className.split(/\s+/u).filter(Boolean);
      if (!tokens.some((token) => hidden.has(token))) {
        failures.push(
          `${at(node, sourceFile)} a visible native <input type="file"> (className=${JSON.stringify(className)}); ` +
            "hide it with the sheet's clip-path recipe and drive it from a themed control",
        );
        return;
      }
      // The control that asks for the file, wired to this input: a themed
      // button/label that clicks its ref or names its id.
      if (themedTriggerFor(sourceFile, byClass, node) === null)
        failures.push(
          `${at(node, sourceFile)} the hidden file input has no themed button/label wired to it ` +
            "(click the input's ref, or a label that names its id)",
        );
    });
  }
  t.diagnostic(
    `gate 1.1: ${files.length} files, ${fileInputs} file input(s), ${hidden.size} visually-hidden class(es), ${failures.length} violation(s)`,
  );
  assert.deepEqual(
    failures,
    [],
    "a file input must be hidden behind the product's own control, never the browser's visible choose-file widget",
  );
});

test("gate 1.2: a <details>'s <summary> carries an explicit icon", (t) => {
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
      for (const element of jsxElements(node)) {
        if (!isElement(element, "summary")) continue;
        summaries += 1;
        if (!summaryHasIcon(element, lucide))
          failures.push(`${at(element, sourceFile)} <summary> without an explicit icon`);
      }
    });
  }
  t.diagnostic(`gate 1.2: ${files.length} files, ${details} <details>, ${summaries} <summary>, ${failures.length} violation(s)`);
  assert.deepEqual(failures, [], "a <details>'s <summary> must render an explicit icon, not the browser's triangle");
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

/**
 * Declarations style.css writes, keyed by every class token that appears in a
 * selector. A class only has to be *somewhere* in a selector (including a
 * descendant or state selector) for its declarations to count.
 */
function classDeclarations() {
  const css = readFileSync(STYLESHEET, "utf8").replace(/\/\*[\s\S]*?\*\//gu, "");
  const byClass = new Map();
  const stack = [];
  let buffer = "";
  for (const character of css) {
    if (character === "{") {
      stack.push(buffer.trim());
      buffer = "";
    } else if (character === "}") {
      const selector = stack.pop() ?? "";
      // At-rule blocks (`@media …`) hold their own inner rules, which were
      // already recorded when their own closing brace was seen.
      if (!selector.startsWith("@")) {
        for (const token of selector.matchAll(/\.(-?[A-Za-z_][A-Za-z0-9_-]*)/gu)) {
          const declarations = byClass.get(token[1]) ?? [];
          declarations.push(buffer);
          byClass.set(token[1], declarations);
        }
      }
      buffer = "";
    } else {
      buffer += character;
    }
  }
  return byClass;
}

const BARE_BACKGROUND_VALUES = new Set([
  "transparent",
  "none",
  "inherit",
  "unset",
  "currentcolor",
  "initial",
  "revert",
]);

/** True when some declaration in the block paints a themed surface. */
function blockPaintsThemedSurface(block) {
  return block.split(";").some((declaration) => {
    const separator = declaration.indexOf(":");
    if (separator < 0) return false;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    if (property !== "background" && property !== "background-color") return false;
    const value = declaration
      .slice(separator + 1)
      .replace(/!important/giu, "")
      .trim()
      .toLowerCase();
    // A theme token, a deliberate see-through control, or a themed gradient.
    return value.includes("var(--") || BARE_BACKGROUND_VALUES.has(value);
  });
}

/**
 * The classes the sheet actually takes out of the visual flow: the controller's
 * `clip-path: inset(50%)` recipe. A class named "visually hidden" that the sheet
 * gives no rule is exactly the defect this gate must not accept, so the class
 * list is read from the declarations and never from the name.
 */
function visuallyHiddenClassNames() {
  const names = new Set();
  for (const [name, blocks] of classDeclarations())
    if (blocks.some((block) => /clip-path:\s*inset\(50%\)/iu.test(block))) names.add(name);
  return names;
}

/**
 * The control that asks for the file: a `button`/`label` whose own class
 * declares a themed surface (the `.small-button` vocabulary), wired to *this*
 * input - either by clicking the ref the input is bound to, or by naming the
 * input's own id. A `className` that merely exists is not a control, and an
 * unrelated themed button in the same file is not this input's trigger.
 */
function themedTriggerFor(sourceFile, byClass, input) {
  const idAttribute = jsxAttribute(input, "id");
  const idText = idAttribute === undefined ? null : idAttribute.getText(sourceFile);
  const refAttribute = jsxAttribute(input, "ref");
  const refName = refAttribute === undefined ? null : (/\{\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\}/u.exec(refAttribute.getText(sourceFile))?.[1] ?? null);
  let found = null;
  walk(sourceFile, (node) => {
    if (found !== null) return;
    if (!ts.isJsxElement(node) && !ts.isJsxSelfClosingElement(node)) return;
    const name = jsxTagName(node);
    if (name === null || !ts.isIdentifier(name) || (name.text !== "button" && name.text !== "label")) return;
    const className = classNameOf(node);
    if (className === null) return;
    const declared = className
      .split(/\s+/u)
      .filter(Boolean)
      .flatMap((token) => byClass.get(token) ?? []);
    if (!declared.some(blockPaintsThemedSurface)) return;
    const onClick = jsxAttribute(node, "onClick");
    const clicksTheInput =
      refName !== null && onClick !== undefined && onClick.getText(sourceFile).includes(`${refName}.current`);
    const htmlFor = jsxAttribute(node, "htmlFor");
    const namesTheInput = idText !== null && htmlFor !== undefined && htmlFor.getText(sourceFile) === idText;
    if (clicksTheInput || namesTheInput) found = node;
  });
  return found;
}

/** Controls the browser paints with its own surface when nothing styles them. */
const INTERACTIVE_CONTROL_TAGS = new Set(["button", "select", "textarea"]);
const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "submit",
  "reset",
  "checkbox",
  "radio",
  "range",
  "color",
  "file",
  "image",
  "date",
  "datetime-local",
  "month",
  "week",
  "time",
]);

function interactiveControlKind(node) {
  const name = jsxTagName(node);
  if (name === null || !ts.isIdentifier(name)) return null;
  if (INTERACTIVE_CONTROL_TAGS.has(name.text)) return `<${name.text}>`;
  if (name.text !== "input") return null;
  const type = attributes(node).get("type");
  if (type === undefined || !NON_TEXT_INPUT_TYPES.has(type)) return null;
  return `<input type="${type}">`;
}

test("gate 1.6: an interactive control paints a themed surface, never the browser default", (t) => {
  // The Chats row select control carried `chat-item-title chat-item-select`:
  // `chat-item-title` only sets type, `chat-item-select` had no rule at all, so
  // the browser painted its own near-white button face inside a dark card. A
  // class that merely EXISTS is not styling; the control's own classes must
  // declare a background that is a theme token or a deliberate transparent one.
  const byClass = classDeclarations();
  const hidden = visuallyHiddenClassNames();
  const failures = [];
  let controls = 0;
  let unjudged = 0;
  let unpainted = 0;
  const files = componentFiles();
  for (const file of files) {
    const sourceFile = parse(file);
    walk(sourceFile, (node) => {
      if (!ts.isJsxElement(node) && !ts.isJsxSelfClosingElement(node)) return;
      const kind = interactiveControlKind(node);
      if (kind === null) return;
      controls += 1;
      const own = classNameOf(node);
      const ownTokens = own === null ? [] : own.split(/\s+/u).filter(Boolean);
      if (ownTokens.some((token) => hidden.has(token))) {
        // Taken out of the visual flow: the browser paints nothing here, so
        // there is no default face to catch. The control the player sees is the
        // themed trigger gate 1.1 requires beside it.
        unpainted += 1;
        return;
      }
      if (classNameOf(node) === null && attributes(node).has("className")) {
        // A dynamic `className={…}` cannot be resolved statically. The runtime
        // assertion in `ui-hygiene-runtime.spec.ts` measures those controls'
        // computed background on the real mounted surfaces instead.
        unjudged += 1;
        return;
      }
      const className = classNameOf(node);
      const tokens = className === null ? [] : className.split(/\s+/u).filter(Boolean);
      const declared = tokens.flatMap((token) => byClass.get(token) ?? []);
      const unstyled = tokens.filter((token) => !byClass.has(token));
      if (!declared.some(blockPaintsThemedSurface)) {
        failures.push(
          `${at(node, sourceFile)} ${kind} painted by the browser default (className=${JSON.stringify(className)})` +
            (unstyled.length === 0 ? "" : `; no rule at all for: ${unstyled.join(", ")}`),
        );
      }
    });
  }
  t.diagnostic(
    `gate 1.6: ${files.length} files, ${controls} interactive control(s), ${unjudged} dynamic className(s) left to the runtime gate, ${unpainted} out of the visual flow, ${failures.length} violation(s)`,
  );
  assert.deepEqual(
    failures,
    [],
    "an interactive control must declare a theme-token or transparent background; the browser default reads as a foreign control",
  );
});
