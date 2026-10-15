/**
 * Focus visibility is never removed without a replacement that is a ring.
 *
 * `outline: none` is the one declaration that can silently delete keyboard
 * accessibility: the control keeps working, the mouse user sees nothing wrong, and
 * a keyboard user loses every trace of where they are. The stylesheet's own intent
 * is explicit - "Focus is never colour-only: the plan's gold ring, on every
 * control" (the `:focus-visible` rule in `theme.interactions`) - so this gate
 * refuses an `outline: none` unless a focus rule for that same control puts a *ring*
 * back: a non-`none` `outline`, or a non-`none` `box-shadow`. A border or
 * background colour change is a visible change, but it is exactly the colour-only
 * signal the stylesheet forbids, so it is not accepted as a replacement.
 *
 * The replacement may sit on the control (`:focus`, `:focus-visible`) or on a
 * container that holds it (`:focus-within`): the composer's textarea removes its
 * own outline because the container draws the ring. That parent case is *verified*
 * rather than allowlisted - the gate reads the JSX and requires an element carrying
 * the container's class to actually contain an element carrying the control's
 * class, so a `:focus-within` rule for some unrelated panel cannot excuse it.
 *
 * The one finding below is a real inconsistency reported to the owner rather than
 * fixed here (`dialogue-web/src/style.css` is another lane's file): the advanced Pi
 * JSON editor is the only control missing from the stylesheet's own list of
 * ring-restoring focus rules, so its focus signal is a border colour only. The gate
 * asserts it still reproduces, so the entry cannot outlive its fix.
 *
 * False positives, and how each is handled:
 *  - the ring may be declared anywhere in a focus rule, in any layer: the check is
 *    whether a ring exists for that control, not which layer wrote it;
 *  - a class-name match is exact against any class in the site's selector, so
 *    `.form-input` is compensated by a `.form-input:focus` rule and not by a
 *    lookalike `.surface-header h2:focus-visible`;
 *  - the parent (`:focus-within`) form is verified against the JSX rather than
 *    inferred from the class names, which is what keeps the rule deterministic.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const DIALOGUE_WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(DIALOGUE_WEB, "src");
const STYLESHEET = join(SRC, "style.css");

/**
 * Real findings this lane cannot fix (style.css belongs to another lane).
 * `{ selector, declarations, reason }`: the declarations the finding is made of,
 * so the gate follows the rule by its content rather than by its position in the
 * stylesheet - an unrelated CSS edit shifts line numbers, never declarations.
 * The gate fails if one stops reproducing.
 */
const REPORTED_FOCUS_SITES = [
  {
    selector: ".surface-advanced-editor",
    declarations: [["outline", "none"]],
    reason:
      "the advanced Pi JSON editor removes its outline and its only focus rule sets border-color, so keyboard focus reads as a 1px colour change; it is also the one control missing from the stylesheet's unified ring list (`.form-input:focus, .form-textarea:focus, .form-select:focus, ...` + `box-shadow`)",
  },
];

/** Comments blanked so a `;` or `{}` inside them cannot confuse the reader. */
function blankComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//gu, (match) => " ".repeat(match.length));
}

export function declarationsOf(body) {
  const out = [];
  for (const part of body.split(";")) {
    const trimmed = part.trim();
    if (trimmed.length === 0 || trimmed.includes("{")) continue;
    const separator = trimmed.indexOf(":");
    if (separator <= 0) continue;
    out.push([trimmed.slice(0, separator).trim(), trimmed.slice(separator + 1).trim().replace(/\s+/gu, " ")]);
  }
  return out;
}

/** Every ruleset in the stylesheet: `{ selector, declarations, body, line }`. */
export function rules(css) {
  const text = blankComments(css);
  const out = [];
  const stack = [];
  let preludeStart = 0;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === "{") {
      const prelude = text.slice(preludeStart, index).trim().replace(/\s+/gu, " ");
      stack.push({ prelude, start: index, at: prelude.startsWith("@") });
      preludeStart = index + 1;
      continue;
    }
    if (character === "}" || character === ";") {
      if (character === "}") {
        const entry = stack.pop();
        if (entry !== undefined && !entry.at && !stack.some((outer) => outer.at && /^@keyframes/u.test(outer.prelude))) {
          const body = text.slice(entry.start + 1, index);
          out.push({
            selector: entry.prelude,
            declarations: declarationsOf(body),
            body,
            line: css.slice(0, entry.start).split("\n").length,
          });
        }
      }
      preludeStart = index + 1;
    }
  }
  return out;
}

/** The line of a declaration inside a rule body, counted from the rule's own line. */
function declarationLine(rule, index) {
  return rule.line + rule.body.slice(0, index).split("\n").length - 1;
}

export function classNames(selector) {
  return new Set(selector.match(/\.[A-Za-z_-][\w-]*/gu) ?? []);
}

function keyedClass(selector) {
  return [...classNames(selector)].pop() ?? null;
}

function isFocusRule(selector) {
  return /:focus(-visible|-within)?\b/u.test(selector);
}

/** A ring: an outline or box-shadow that is actually drawn. */
function hasRing(declarations) {
  for (const [property, value] of declarations) {
    if (property === "outline" && !/^(none|0)\b/u.test(value) && !/^\s*0\s*(solid)?\s*$/u.test(value)) return true;
    if (property === "box-shadow" && !/^none\b/u.test(value) && value.trim().length > 0) return true;
  }
  return false;
}

/** Every `outline: none|0` site: `{ selector, line, classes, declarations }`, at the declaration. */
export function outlineSites(css) {
  const found = [];
  for (const rule of rules(css)) {
    for (const match of rule.body.matchAll(/outline\s*:\s*(none|0)\b/gu)) {
      found.push({
        selector: rule.selector,
        line: declarationLine(rule, match.index),
        classes: classNames(rule.selector),
        declarations: rule.declarations,
      });
    }
  }
  return found;
}

/** The focus rules that draw a ring, with the classes they name. */
export function ringRules(css) {
  return rules(css)
    .filter((rule) => isFocusRule(rule.selector) && hasRing(rule.declarations))
    .map((rule) => ({ selector: rule.selector, classes: classNames(rule.selector), line: rule.line }));
}

/** A container class holding an element with a given class, read from the JSX. */
export function containerOf(target, container, files) {
  for (const file of files) {
    const sourceFile = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const classNameOf = (node) => {
      const attributes = ts.isJsxElement(node) ? node.openingElement.attributes : node.attributes;
      for (const property of attributes.properties) {
        if (!ts.isJsxAttribute(property) || property.name.getText() !== "className") continue;
        const initializer = property.initializer;
        if (initializer !== undefined && ts.isStringLiteral(initializer)) return initializer.text;
      }
      return null;
    };
    let found = false;
    const visit = (node, insideContainer) => {
      if (ts.isJsxElement(node)) {
        const names = classNameOf(node);
        const here = insideContainer || (names !== null && names.split(/\s+/u).includes(container));
        if (insideContainer && names !== null && names.split(/\s+/u).includes(target)) found = true;
        for (const child of node.children) visit(child, here);
      } else if (ts.isJsxSelfClosingElement(node)) {
        const names = classNameOf(node);
        if (insideContainer && names !== null && names.split(/\s+/u).includes(target)) found = true;
      } else {
        ts.forEachChild(node, (child) => visit(child, insideContainer));
      }
    };
    visit(sourceFile, false);
    if (found) return file;
  }
  return null;
}

export function tsxFiles(directory = SRC) {
  const out = [];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) {
      out.push(...tsxFiles(path));
      continue;
    }
    if (name.endsWith(".tsx")) out.push(path);
  }
  return out;
}

/** Every `outline: none` site with no ring-restoring focus rule. */
export function unringedOutlineSites(css, files = tsxFiles()) {
  const rings = ringRules(css);
  const failures = [];
  for (const site of outlineSites(css)) {
    const direct = rings.some((rule) => {
      if (rule.selector.includes(":focus-within")) return false;
      for (const name of rule.classes) if (site.classes.has(name)) return true;
      return false;
    });
    if (direct) continue;
    const viaWithIn = rings.filter((rule) => rule.selector.includes(":focus-within"));
    const keyed = keyedClass(site.selector);
    const verified = viaWithIn.some((rule) => {
      if (keyed === null) return false;
      return [...rule.classes].some((container) => {
        const bare = container.slice(1);
        return containerOf(keyed.slice(1), bare, files) !== null;
      });
    });
    if (verified) continue;
    failures.push({ line: site.line, selector: site.selector, classes: [...site.classes], declarations: site.declarations });
  }
  return failures;
}

test("focus.1: every outline:none is replaced by a ring on focus", (t) => {
  const css = readFileSync(STYLESHEET, "utf8");
  const failures = [];
  for (const failure of unringedOutlineSites(css)) {
    if (REPORTED_FOCUS_SITES.some((entry) => entry.selector === failure.selector)) continue;
    failures.push(`src/style.css:${failure.line} ${failure.selector} removes the outline with no focus ring`);
  }
  const reported = unringedOutlineSites(css).filter((failure) =>
    REPORTED_FOCUS_SITES.some((entry) => entry.selector === failure.selector),
  ).length;
  t.diagnostic(
    `focus.1: ${outlineSites(css).length} outline:none site(s), ${ringRules(css).length} ring rule(s), ${reported} reported finding(s), ${failures.length} unreported`,
  );
  assert.deepEqual(failures, [], "a control whose outline is removed must draw a ring when it is focused");
});

test("focus.2: every reported finding still reproduces, and still declares what it names", (t) => {
  const css = readFileSync(STYLESHEET, "utf8");
  const found = unringedOutlineSites(css);
  for (const entry of REPORTED_FOCUS_SITES) {
    const match = found.find((failure) => failure.selector === entry.selector);
    assert.ok(match !== undefined, `${entry.selector} now draws a focus ring; remove the reported entry`);
    for (const [property, value] of entry.declarations) {
      assert.ok(
        match.declarations.some(([name, declared]) => name === property && declared === value),
        `${entry.selector} no longer declares \`${property}: ${value}\`; the finding changed and the reported entry must follow it`,
      );
    }
  }
  t.diagnostic(`focus.2: ${REPORTED_FOCUS_SITES.length} reported finding(s) still reproduce, by declaration`);
});

test("focus.3: the stylesheet's own baseline ring is present", (t) => {
  const css = readFileSync(STYLESHEET, "utf8");
  const baseline = ringRules(css).filter((rule) => rule.selector.includes(":focus-visible") && rule.classes.size === 0);
  assert.ok(baseline.length >= 1, "the unlayered :focus-visible ring must exist as the baseline");
  t.diagnostic(`focus.3: ${baseline.length} class-less :focus-visible ring rule(s): ${baseline.map((rule) => rule.selector).join(", ")}`);
});

test("focus.4: the composer's parent ring is verified against the JSX, not assumed", (t) => {
  const files = tsxFiles();
  assert.ok(
    containerOf("composer-textarea", "composer-container", files) !== null,
    "the composer container must really hold the textarea for its :focus-within ring to excuse the outline:none",
  );
  assert.equal(
    containerOf("surface-advanced-editor", "composer-container", files),
    null,
    "an unrelated container must not excuse a control it does not hold",
  );
  t.diagnostic("focus.4: composer-container holds composer-textarea in the JSX; an unrelated container does not");
});

test("focus.5 (mutation): outline:none alone, and with only a colour change, both fail", (t) => {
  const bare = ".gate-probe-input {\n  outline: none;\n}\n";
  assert.deepEqual(unringedOutlineSites(bare, []), [
    { line: 2, selector: ".gate-probe-input", classes: [".gate-probe-input"], declarations: [["outline", "none"]] },
  ]);

  const colourOnly = [
    ".gate-probe-input {",
    "  outline: none;",
    "}",
    "",
    ".gate-probe-input:focus {",
    "  border-color: var(--focus-ring);",
    "}",
    "",
  ].join("\n");
  assert.deepEqual(
    unringedOutlineSites(colourOnly, []).map((failure) => failure.selector),
    [".gate-probe-input"],
    "a border colour is not a ring",
  );

  const ringed = [
    ".gate-probe-input {",
    "  outline: none;",
    "}",
    "",
    ".gate-probe-input:focus {",
    "  box-shadow: 0 0 0 1px var(--focus-ring);",
    "}",
    "",
  ].join("\n");
  assert.deepEqual(unringedOutlineSites(ringed, []), []);
  t.diagnostic("focus.5: bare and colour-only sites reported; a box-shadow ring is accepted");
});
