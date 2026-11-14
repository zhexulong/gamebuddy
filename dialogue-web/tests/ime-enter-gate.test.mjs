/**
 * The Enter a player pressed to confirm a Chinese, Japanese or Korean candidate is not a command.
 *
 * The defect this exists for: a text field is submitted on Enter, and a character composer is
 * confirmed on the same key, so a message went out mid-composition. The measured shape of it is
 * worse than "somebody forgot a guard": a guard on `KeyboardEvent.isComposing` alone is right in
 * Chromium and Firefox and wrong in WebKit (bug 165004), which delivers the confirming keydown with
 * `isComposing` already false. Only `keyCode === 229` (`VK_PROCESSKEY`) still says the input method
 * handled the key on all three, which is why the guard is `isImeProcessingKey` from
 * `src/components/ime-composition.ts` and never a bare `isComposing` read.
 *
 * The population is the product's own source (`sourcePopulation`, the same scan the coverage
 * denominator comes from), and the two rules are the two ways the browser lets Enter become a
 * command:
 *
 *   1. an `onKeyDown`/`onKeyPress`/`onKeyUp` handler that branches on the `"Enter"` key must reach
 *      `isImeProcessingKey`, whether the branch is `===` or `!==`;
 *   2. a `<form>` submits implicitly on an Enter pressed in one of its fields, and the implicit
 *      submission is the browser's default action rather than a handler of ours - so the form must
 *      carry the keydown guard that removes it (`preventImeFormSubmit`).
 *
 * Every finding names the file, the line and which rule it broke, so the next reader has a route
 * rather than a count. The rule is proved on text of its own (`ime-enter-gate.mjs` mutation cases)
 * as well as on this tree, because a gate that only ever reads today's sources stops checking the
 * day the sources change shape.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { sourcePopulation } from "./frontend-coverage-groups.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src");

/** The attribute names React uses to hand a component a key it did not originate. */
const KEY_ATTRIBUTES = new Set(["onKeyDown", "onKeyPress", "onKeyUp"]);

/**
 * The guard module's two entry points: the predicate every Enter branch has to reach, and the
 * form-level keydown built from it. `ime-composition.test.ts` holds the second to the first, so
 * this gate never has to trust a name whose body it cannot see.
 */
const GUARD = "isImeProcessingKey";
const FORM_GUARD = "preventImeFormSubmit";

/** The tree position of an attributable finding, as a `file:line` route. */
function position(node, sourceFile) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/** True when any node under `root` satisfies `matches`. */
function contains(root, matches) {
  if (matches(root)) return true;
  let found = false;
  const visit = (node) => {
    if (found) return;
    if (matches(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(root, visit);
  return found;
}

/** A call to the shared guard: `isImeProcessingKey(...)`. */
function callsGuard(node) {
  return (
    ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === GUARD
  );
}

/** The `"Enter"` key itself, as the branch compares it. */
function namesEnter(node) {
  return ts.isStringLiteralLike(node) && node.text === "Enter";
}

/** Every inline handler in a file, keyed by the name a JSX attribute can refer to it by. */
function namedHandlers(sourceFile) {
  const byName = new Map();
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      byName.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return byName;
}

/** The handler an `onKeyDown={...}` attribute points at: written inline, or named in this file. */
function handlerBody(initializer, byName) {
  if (initializer === undefined || !ts.isJsxExpression(initializer)) return undefined;
  const expression = initializer.expression;
  if (expression === undefined) return undefined;
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return expression;
  if (ts.isIdentifier(expression)) return byName.get(expression.text);
  return undefined;
}

/** True when a JSX attribute's expression is the shared form guard itself. */
function isFormGuard(initializer) {
  return (
    initializer !== undefined &&
    ts.isJsxExpression(initializer) &&
    initializer.expression !== undefined &&
    ts.isIdentifier(initializer.expression) &&
    initializer.expression.text === FORM_GUARD
  );
}

/**
 * Every place the tree turns Enter into a command without asking the input method first.
 *
 * Exported so the mutation case below drives the same analysis the tree is measured with: a rule
 * tested against a second, hand-written copy of itself proves nothing about the copy in use.
 */
export function imeEnterFindings(text, fileName) {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const byName = namedHandlers(sourceFile);
  const findings = [];
  const visit = (node) => {
    if (ts.isJsxAttribute(node) && node.name.getText(sourceFile) !== undefined && node.initializer !== undefined) {
      const name = node.name.getText(sourceFile);
      if (KEY_ATTRIBUTES.has(name)) {
        const handler = handlerBody(node.initializer, byName);
        if (handler !== undefined && contains(handler, namesEnter) && !contains(handler, callsGuard)) {
          findings.push({
            at: position(node, sourceFile),
            rule: "enter-branch-without-guard",
            detail: `${name} branches on "Enter" and never reaches ${GUARD}`,
          });
        }
      }
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (node.tagName.getText(sourceFile) === "form") {
        const guardAttribute = node.attributes.properties.find(
          (property) => ts.isJsxAttribute(property) && property.name.getText(sourceFile) === "onKeyDown",
        );
        const guarded =
          guardAttribute !== undefined &&
          (isFormGuard(guardAttribute.initializer) ||
            (handlerBody(guardAttribute.initializer, byName) !== undefined &&
              contains(handlerBody(guardAttribute.initializer, byName), callsGuard)));
        if (!guarded) {
          findings.push({
            at: position(node, sourceFile),
            rule: "form-submits-on-the-ime-enter",
            detail: `a <form> submits implicitly on Enter; it carries no keydown that reaches ${GUARD} (${FORM_GUARD})`,
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

/** The two counts a passing run has to print: a rule over nothing agrees with itself. */
export function measured(text, fileName) {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
  const byName = namedHandlers(sourceFile);
  let enterBranches = 0;
  let forms = 0;
  const visit = (node) => {
    if (ts.isJsxAttribute(node) && node.initializer !== undefined && KEY_ATTRIBUTES.has(node.name.getText(sourceFile))) {
      const handler = handlerBody(node.initializer, byName);
      if (handler !== undefined && contains(handler, namesEnter)) enterBranches += 1;
    }
    if (
      (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
      node.tagName.getText(sourceFile) === "form"
    ) {
      forms += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { enterBranches, forms };
}

test("ime-enter.1: every Enter branch in the product asks the input method first", (t) => {
  const { modules } = sourcePopulation(SRC);
  assert.ok(modules.length > 0, "no product source found, so this gate would pass by measuring nothing");
  let enterBranches = 0;
  let forms = 0;
  const findings = [];
  for (const module of modules) {
    const text = readFileSync(join(SRC, module), "utf8");
    const counts = measured(text, module);
    enterBranches += counts.enterBranches;
    forms += counts.forms;
    for (const finding of imeEnterFindings(text, module)) {
      findings.push(`src/${module}:${finding.at} (${finding.rule}) - ${finding.detail}`);
    }
  }
  t.diagnostic(
    `ime-enter.1: ${modules.length} module(s), ${enterBranches} Enter-branch handler(s), ${forms} <form>(s), ` +
      `${findings.length} finding(s)`,
  );
  assert.ok(enterBranches > 0, "no Enter branch found; the rule would be green over an empty population");
  assert.ok(forms > 0, "no <form> found; the implicit-submission rule would be green over nothing");
  assert.deepEqual(findings, [], "an Enter that commits must be behind isImeProcessingKey");
});

test("ime-enter.2 (mutation): the rule names a handler that reads isComposing alone, and one that does not", () => {
  const unguarded = `
    const onKeyDown = (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      send();
    };
    export const C = () => <textarea onKeyDown={onKeyDown} />;
  `;
  const isComposingOnly = `
    const onKeyDown = (event) => {
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Enter") send();
    };
    export const C = () => <textarea onKeyDown={onKeyDown} />;
  `;
  const guarded = `
    import { isImeProcessingKey } from "./ime-composition";
    const onKeyDown = (event) => {
      if (isImeProcessingKey(event.nativeEvent)) return;
      if (event.key === "Enter") send();
    };
    export const C = () => <textarea onKeyDown={onKeyDown} />;
  `;
  const formWithoutGuard = `export const F = () => <form onSubmit={(e) => { e.preventDefault(); save(); }} />;`;
  const formWithGuard = `
    import { preventImeFormSubmit } from "./ime-composition";
    export const F = () => <form onKeyDown={preventImeFormSubmit} onSubmit={(e) => e.preventDefault()} />;
  `;

  assert.equal(imeEnterFindings(unguarded, "a.tsx").length, 1, "an unguarded Enter branch is the defect");
  assert.equal(
    imeEnterFindings(isComposingOnly, "b.tsx").length,
    1,
    "isComposing alone misses the WebKit ordering, so it is the same defect",
  );
  assert.deepEqual(imeEnterFindings(guarded, "c.tsx"), [], "the shared guard clears the branch");
  assert.equal(imeEnterFindings(formWithoutGuard, "d.tsx").length, 1, "an unguarded form submits on the IME's Enter");
  assert.deepEqual(imeEnterFindings(formWithGuard, "e.tsx"), [], "the form guard clears the implicit submission");
});
