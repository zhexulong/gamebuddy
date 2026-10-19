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
 * The subject is the CONTROLS, derived from the JSX rather than hand-listed: the
 * elements a browser makes focusable and a player operates (button, input other
 * than a hidden one, select, textarea, summary, a[href], and anything carrying a
 * `tabIndex` that is not `-1`). WCAG 2.4.11 is about those components. A heading
 * with `tabindex="-1"` is a programme-focus target the player cannot press: the
 * owner's ruling is that it wears no ring (a ring on something unpressable reads
 * as an unclicked button, `conversation-rendering-defects.spec.ts` defect 3), so
 * an `outline: none` on it is outside this gate - reported in the diagnostic with
 * its selector, so a scoped-out site is visible rather than silent.
 *
 * The one finding this gate carried (`REPORTED_FOCUS_SITES`) was the advanced Pi
 * JSON editor, which the owner reported and another lane then fixed: it now joins
 * the stylesheet's unified focus list and draws the same `--focus-ring`
 * border/box-shadow pair every other field draws. The list is kept, empty, so the
 * next site that loses its ring is reported as itself and not silently identical
 * to a site that has since been fixed.
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
 * The gate fails if one stops reproducing, so an entry cannot outlive its fix.
 *
 * Empty: the advanced Pi JSON editor was the one entry, and it now draws the
 * shared `--focus-ring` pair, so it stopped being a finding. The mechanism stays
 * for the next one.
 */
const REPORTED_FOCUS_SITES = [];

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

/** Every `outline: none` site with no ring-restoring focus rule, among the CONTROLS. */
export function unringedOutlineSites(css, files = tsxFiles(), sites = undefined) {
  const rings = ringRules(css);
  const failures = [];
  for (const site of sites ?? interactiveOutlineSites(css, files).interactive) {
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

/**
 * The elements a browser makes focusable, and so the components WCAG 2.4.11 asks
 * about. `h2` with `tabindex="-1"` is deliberately not one of them: the shell
 * focuses it, the player cannot press it.
 */
const INTERACTIVE_TAGS = new Set(["button", "input", "select", "textarea", "summary", "a"]);

/** True when one JSX element is a control a player can operate. */
function isInteractiveElement(tag, attributes) {
  const name = tag.toLowerCase();
  const tabIndex = attributes.get("tabIndex");
  if (!INTERACTIVE_TAGS.has(name)) return tabIndex !== undefined && tabIndex !== "-1";
  if (name === "a") return attributes.get("href") !== undefined;
  if (name === "input") return attributes.get("type") !== "hidden";
  return true;
}

/**
 * The gate's subject, derived from the JSX: the tags the shell renders as controls,
 * and every class it puts on one. A `className` that is not a plain string literal
 * (a computed list) contributes nothing rather than a guessed name.
 */
export function interactiveSubject(files = tsxFiles()) {
  const classes = new Set();
  const tags = new Set();
  const visit = (node) => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      const tag = opening.tagName.getText();
      const attributes = new Map();
      for (const property of opening.attributes.properties) {
        if (!ts.isJsxAttribute(property)) continue;
        const initializer = property.initializer;
        if (initializer === undefined) {
          attributes.set(property.name.getText(), "");
          continue;
        }
        if (ts.isStringLiteral(initializer)) {
          attributes.set(property.name.getText(), initializer.text);
          continue;
        }
        if (ts.isJsxExpression(initializer)) {
          attributes.set(property.name.getText(), initializer.expression?.getText() ?? "");
        }
      }
      if (isInteractiveElement(tag, attributes)) {
        tags.add(tag.toLowerCase());
        const className = attributes.get("className");
        if (typeof className === "string") {
          for (const name of className.split(/\s+/u)) if (name.length > 0) classes.add(name);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const file of files) {
    visit(
      ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX),
    );
  }
  return { classes, tags };
}

/** True when a stylesheet selector addresses one of those controls. */
export function isInteractiveSelector(selector, subject) {
  const text = selector.toLowerCase();
  if (/(^|[\s>+~,(])(button|input|select|textarea|summary)(?![-\w])/u.test(text)) return true;
  if (/(^|[\s>+~,(])a(?![-\w])[^\s{,]*(?:\[href\])/u.test(text)) return true;
  for (const name of classNames(selector)) if (subject.classes.has(name.slice(1))) return true;
  return false;
}

/**
 * Every `outline: none` site, split into the controls the gate is about and the
 * sites that are out of its subject (a heading the shell focuses, for instance).
 */
export function interactiveOutlineSites(css, files = tsxFiles()) {
  const subject = interactiveSubject(files);
  const all = outlineSites(css);
  return {
    subject,
    interactive: all.filter((site) => isInteractiveSelector(site.selector, subject)),
    scopedOut: all.filter((site) => !isInteractiveSelector(site.selector, subject)),
  };
}

test("focus.1: every outline:none on a CONTROL is replaced by a ring on focus", (t) => {
  const css = readFileSync(STYLESHEET, "utf8");
  const { interactive, scopedOut } = interactiveOutlineSites(css);
  const failures = [];
  for (const failure of unringedOutlineSites(css, undefined, interactive)) {
    if (REPORTED_FOCUS_SITES.some((entry) => entry.selector === failure.selector)) continue;
    failures.push(`src/style.css:${failure.line} ${failure.selector} removes the outline with no focus ring`);
  }
  const reported = unringedOutlineSites(css, undefined, interactive).filter((failure) =>
    REPORTED_FOCUS_SITES.some((entry) => entry.selector === failure.selector),
  ).length;
  t.diagnostic(
    `focus.1: ${outlineSites(css).length} outline:none site(s), ${interactive.length} on controls, ` +
      `${scopedOut.length} outside the subject (${scopedOut.map((site) => site.selector).join(", ") || "none"}), ` +
      `${ringRules(css).length} ring rule(s), ${reported} reported finding(s), ${failures.length} unreported`,
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

test("focus.5 (mutation): a control with no ring fails, and a programme-focus target is out of scope", (t) => {
  const bare = "button.gate-probe-button {\n  outline: none;\n}\n";
  assert.deepEqual(unringedOutlineSites(bare, []).map((failure) => failure.selector), ["button.gate-probe-button"]);

  const colourOnly = [
    "button.gate-probe-button {",
    "  outline: none;",
    "}",
    "",
    "button.gate-probe-button:focus {",
    "  border-color: var(--focus-ring);",
    "}",
    "",
  ].join("\n");
  assert.deepEqual(
    unringedOutlineSites(colourOnly, []).map((failure) => failure.selector),
    ["button.gate-probe-button"],
    "a border colour is not a ring",
  );

  const ringed = [
    "button.gate-probe-button {",
    "  outline: none;",
    "}",
    "",
    "button.gate-probe-button:focus {",
    "  box-shadow: 0 0 0 1px var(--focus-ring);",
    "}",
    "",
  ].join("\n");
  assert.deepEqual(unringedOutlineSites(ringed, []), []);

  // The narrowing: the same removal on a heading the shell focuses for its own
  // reading context is not this gate's subject, and is reported as scoped out.
  const heading = "h2.gate-probe-heading {\n  outline: none;\n}\n";
  assert.deepEqual(unringedOutlineSites(heading, []), []);
  assert.deepEqual(
    interactiveOutlineSites(heading, []).scopedOut.map((site) => site.selector),
    ["h2.gate-probe-heading"],
    "a scoped-out site is reported, not silently dropped",
  );
  t.diagnostic("focus.5: bare and colour-only controls reported; a box-shadow ring accepted; a heading scoped out");
});

/**
 * The narrowing must not be able to swallow a real finding. The subject set is
 * derived from the JSX, so this pins the derivation itself: every class the
 * stylesheet removes an outline for really is a control in the JSX, and the
 * heading (a programme-focus target) really is not.
 */
test("focus.6: the subject set is derived from the JSX, and the heading is outside it", (t) => {
  const css = readFileSync(STYLESHEET, "utf8");
  const { subject, interactive, scopedOut } = interactiveOutlineSites(css);
  for (const name of ["composer-textarea", "form-input", "form-textarea", "form-select", "surface-advanced-editor"]) {
    assert.ok(
      subject.classes.has(name),
      `the JSX renders .${name} on a control, so the derived subject set must carry it`,
    );
  }
  for (const site of interactive) {
    assert.ok(
      /(^|[\s>+~,(])(button|input|select|textarea|summary)(?![-\w])/u.test(site.selector.toLowerCase()) ||
        [...site.classes].some((name) => subject.classes.has(name.slice(1))),
      `${site.selector} is a finding, so it must be a control (by element or by a class the JSX puts on one)`,
    );
  }
  const heading = scopedOut.filter((site) => site.selector.includes(".surface-header h2"));
  assert.equal(heading.length, 1, "the heading's outline:none is the one site this gate scopes out of its subject");
  assert.ok(!subject.classes.has("surface-header"), "the surface header is not a control");
  t.diagnostic(
    `focus.6: ${subject.tags.size} control tag(s), ${subject.classes.size} control class(es); ` +
      `${interactive.length} site(s) on controls, ${scopedOut.length} scoped out`,
  );
});
