/**
 * A field that renders its own refusal must point at it.
 *
 * Memory's authoring forms report a refusal the way a player can read it: a `<p class="error-banner"
 * role="status">` directly under the field whose words the Host refused. That is the right sentence
 * in the right place and it says nothing at all to a screen reader - the field's description is
 * empty and `aria-invalid` is missing, so a player using one is told neither that the field failed
 * nor why. This gate is the class, not the three instances: it derives every form control and every
 * error message from the component tree and requires the association wherever the tree already
 * places a message beside exactly one field.
 *
 * The rule, exactly. A **form control** is a literal `<input>` that is not `hidden` or `file`, a
 * `<textarea>`, or a `<select>` (the hidden file input behind the card-import trigger is not a field
 * the player types into). An **error message** is a JSX element whose class names contain
 * `error-banner`, or that carries a `data-*refusal` attribute. A message is **field-scoped** when the
 * block that renders it - its own immediate JSX parent - holds exactly one form control and no other
 * error message in its subtree. For each field-scoped message:
 *   - the message carries an `id`;
 *   - the one control in that block carries `aria-invalid` and `aria-describedby`;
 *   - the control's `aria-describedby` resolves to that message's `id`: either the same literal
 *     (`aria-describedby="memory-create-refusal"` / `id="memory-create-refusal"`), or both ends read
 *     the same `fieldError(...)` binding (`aria-describedby={x.describedBy}` / `id={x.id}`), which is
 *     the module that produces the pair in one place.
 *
 * What is deliberately NOT reported, and why:
 *   - a message in a block with no form control (a read that did not answer, a backup that failed) is
 *     about the region, and there is no field to point at it;
 *   - a message in a block with several controls (a form whose save was refused) belongs to the form,
 *     and binding it to one of them would announce a subject the sentence never claimed;
 *   - a block holding more than one message is a region report as well: one field has one refusal.
 *     `CharactersPanel`'s roster block is exactly this shape - the activation notice and the create
 *     notice share the block that renders the create field - so the block is reported as a region and
 *     the two notices are left where they are rather than being tied to a field they are not about.
 *
 * The pair is verified from the real producer, not from a second hand-written copy: `fieldError` is
 * imported and called, so dropping `aria-invalid` from the module fails here as well as in the
 * browser (see `form-error-association.spec.ts` for the mounted half).
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { fieldError } from "../src/components/field-error.ts";

const DIALOGUE_WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(DIALOGUE_WEB, "src");

/** Every component source in the tree, derived from the directory rather than listed by hand. */
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

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

const isElement = (node) => ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node);

function jsxAttributes(node) {
  if (ts.isJsxElement(node)) return node.openingElement.attributes;
  if (ts.isJsxSelfClosingElement(node)) return node.attributes;
  return undefined;
}

function tagName(node) {
  const tag = ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName;
  return ts.isIdentifier(tag) ? tag.text : tag.getText();
}

/** An attribute's own source text: a literal's text, or the expression as written. */
export function attributeSource(node, name) {
  const attributes = jsxAttributes(node);
  if (attributes === undefined) return null;
  for (const property of attributes.properties) {
    if (!ts.isJsxAttribute(property) || property.name.getText() !== name) continue;
    const initializer = property.initializer;
    if (initializer === undefined) return "";
    if (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer))
      return JSON.stringify(initializer.text);
    if (ts.isJsxExpression(initializer) && initializer.expression !== undefined)
      return initializer.expression.getText().replace(/\s+/gu, " ");
    return initializer.getText();
  }
  return null;
}

function hasAttribute(node, name) {
  const attributes = jsxAttributes(node);
  if (attributes === undefined) return false;
  return attributes.properties.some((property) => ts.isJsxAttribute(property) && property.name.getText() === name);
}

/** True for the elements a player types into. */
export function isFormControl(node) {
  const tag = tagName(node);
  if (tag === "textarea" || tag === "select") return true;
  if (tag !== "input") return false;
  const type = attributeSource(node, "type");
  return type !== JSON.stringify("hidden") && type !== JSON.stringify("file");
}

/** True for an element that reports a failure the player is meant to read. */
export function isErrorMessage(node) {
  const className = attributeSource(node, "className") ?? "";
  if (/error-banner/u.test(className)) return true;
  const attributes = jsxAttributes(node);
  if (attributes === undefined) return false;
  return attributes.properties.some(
    (property) => ts.isJsxAttribute(property) && /refusal$/u.test(property.name.getText()),
  );
}

function subtree(node, predicate) {
  const found = [];
  const visit = (current) => {
    if (current !== node && isElement(current) && predicate(current)) found.push(current);
    ts.forEachChild(current, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

function blockOf(node) {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isJsxElement(current) || ts.isJsxFragment(current)) return current;
  }
  return null;
}

/** The names bound to `fieldError(...)` in one source file. */
function fieldErrorBindings(sourceFile) {
  const names = new Set();
  walk(sourceFile, (node) => {
    if (!ts.isVariableDeclaration(node) || node.initializer === undefined) return;
    if (!ts.isCallExpression(node.initializer)) return;
    if (node.initializer.expression.getText() !== "fieldError") return;
    if (ts.isIdentifier(node.name)) names.add(node.name.text);
  });
  return names;
}

/** The binding a `x.describedBy` / `x.id` expression reads, or null for anything else. */
function bindingOf(source, suffix) {
  if (source === null || !source.endsWith(`.${suffix}`)) return null;
  return source.slice(0, -(suffix.length + 1));
}

/**
 * Every control, message and association finding in one source text.
 * Exported so the mutation tests below drive the same reading as the tree.
 */
export function associationsIn(text, fileName) {
  const sourceFile = ts.createSourceFile(fileName.replace(/\\/gu, "/"), text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const at = (node) => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return `${sourceFile.fileName.replace(/\\/gu, "/").split("/dialogue-web/").pop()}:${line + 1}`;
  };
  const bindings = fieldErrorBindings(sourceFile);
  const controls = [];
  const messages = [];
  walk(sourceFile, (node) => {
    if (!isElement(node)) return;
    if (isFormControl(node)) controls.push({ at: at(node), tag: tagName(node), node });
    if (isErrorMessage(node)) messages.push({ at: at(node), tag: tagName(node), node });
  });

  const fieldScoped = [];
  for (const message of messages) {
    const block = blockOf(message.node);
    if (block === null) continue;
    const fields = subtree(block, isFormControl);
    const others = subtree(block, isErrorMessage).filter((other) => other !== message.node);
    if (fields.length !== 1 || others.length !== 0) continue;
    fieldScoped.push({
      message,
      field: { at: at(fields[0]), tag: tagName(fields[0]), node: fields[0] },
    });
  }

  const findings = [];
  for (const { message, field } of fieldScoped) {
    const id = attributeSource(message.node, "id");
    const describedBy = attributeSource(field.node, "aria-describedby");
    const problem = (reason) => findings.push({ at: field.at, tag: field.tag, message: message.at, reason });

    if (id === null) {
      problem("the message carries no id, so nothing can point at it");
      continue;
    }
    if (!hasAttribute(field.node, "aria-invalid")) problem("the field does not carry aria-invalid");
    if (describedBy === null) {
      problem("the field does not carry aria-describedby");
      continue;
    }
    if (describedBy === id) continue;
    const describedBinding = bindingOf(describedBy, "describedBy");
    const idBinding = bindingOf(id, "id");
    if (describedBinding !== null && describedBinding === idBinding && bindings.has(describedBinding)) continue;
    problem(`aria-describedby=${describedBy} does not resolve to the message id ${id}`);
  }

  return {
    controls: controls.map((control) => ({ at: control.at, tag: control.tag })),
    messages: messages.map((message) => ({ at: message.at, tag: message.tag, id: attributeSource(message.node, "id") })),
    fieldScoped: fieldScoped.length,
    findings,
  };
}

/** Every unwired field-scoped message in the component tree. */
export function unwiredAssociations(files = sourceFiles()) {
  const findings = [];
  let controls = 0;
  let messages = 0;
  let fieldScoped = 0;
  for (const file of files) {
    const read = associationsIn(readFileSync(file, "utf8"), file);
    controls += read.controls.length;
    messages += read.messages.length;
    fieldScoped += read.fieldScoped;
    findings.push(...read.findings);
  }
  return { findings, controls, messages, fieldScoped, files: files.length };
}

test("a11y-error.1: a field that renders its own refusal points at it", (t) => {
  const read = unwiredAssociations();
  t.diagnostic(
    `a11y-error.1: ${read.files} tsx file(s), ${read.controls} form control(s), ${read.messages} error message(s), ${read.fieldScoped} field-scoped, ${read.findings.length} unwired`,
  );
  assert.deepEqual(
    read.findings.map((finding) => `${finding.at} <${finding.tag}>: ${finding.reason} (message at ${finding.message})`),
    [],
    "a field whose own refusal is on screen must carry aria-invalid and point aria-describedby at it",
  );
});

test("a11y-error.2: the tree really is read, and the field-scoped population is not empty", (t) => {
  const read = unwiredAssociations();
  assert.ok(read.files >= 15, `expected the component tree, found ${read.files} tsx file(s)`);
  assert.ok(read.controls >= 40, `expected at least 40 form controls, found ${read.controls}`);
  assert.ok(read.messages >= 10, `expected the error messages the panels render, found ${read.messages}`);
  // One field plus one message in one block is the shape Memory's authoring forms use. If it ever
  // reads zero, this gate has stopped watching anything and must not pass: an empty population
  // agrees with itself.
  assert.ok(
    read.fieldScoped >= 3,
    `expected at least 3 field-scoped refusals (Memory's create, chapter and row editors), found ${read.fieldScoped}`,
  );
  t.diagnostic(`a11y-error.2: ${read.controls} control(s) and ${read.fieldScoped} field-scoped message(s) enumerated`);
});

test("a11y-error.3 (mutation): an unwired field beside its refusal is reported with file, line and field", (t) => {
  const source = [
    "export const Probe = () => (",
    '  <div className="composer-actions">',
    '    <textarea className="form-textarea" aria-label="Content" />',
    '    <p role="status" className="error-banner" data-probe-refusal>',
    "      refused",
    "    </p>",
    "  </div>",
    ");",
  ].join("\n");
  const read = associationsIn(source, "src/components/Mutation.tsx");
  assert.equal(read.fieldScoped, 1);
  assert.deepEqual(
    read.findings.map((finding) => `${finding.at} <${finding.tag}>: ${finding.reason}`),
    [
      "src/components/Mutation.tsx:3 <textarea>: the message carries no id, so nothing can point at it",
    ],
  );
  t.diagnostic("a11y-error.3: the field beside an unassociated refusal is reported at its own line");
});

test("a11y-error.4 (mutation): the wired shape passes, and each half of it is what makes it pass", (t) => {
  const wired = (extra) =>
    [
      "export const Probe = () => {",
      '  const refusalError = fieldError(message, "probe-refusal");',
      '  return <div className="composer-actions">',
      `    <textarea aria-invalid={refusalError.invalid} aria-describedby={refusalError.describedBy} ${extra} />`,
      '    <p role="status" className="error-banner" id={refusalError.id} data-probe-refusal>',
      "      refused",
      "    </p>",
      "  </div>;",
      "};",
    ].join("\n");

  assert.deepEqual(associationsIn(wired(""), "src/components/Wired.tsx").findings, []);

  const withoutInvalid = wired("").replace(" aria-invalid={refusalError.invalid}", "");
  assert.deepEqual(
    associationsIn(withoutInvalid, "src/components/Wired.tsx").findings.map((finding) => finding.reason),
    ["the field does not carry aria-invalid"],
  );

  // A second binding is not a match: the pointer and the target must read the SAME association.
  const crossed = wired("").replace("aria-describedby={refusalError.describedBy}", "aria-describedby={other.describedBy}");
  assert.deepEqual(
    associationsIn(crossed, "src/components/Wired.tsx").findings.map((finding) => finding.reason),
    ["aria-describedby=other.describedBy does not resolve to the message id refusalError.id"],
  );

  const literal = [
    "export const Probe = () => (",
    '  <div className="composer-actions">',
    '    <textarea aria-invalid="true" aria-describedby="probe-refusal" />',
    '    <p role="status" className="error-banner" id="probe-refusal">',
    "      refused",
    "    </p>",
    "  </div>",
    ");",
  ].join("\n");
  assert.deepEqual(associationsIn(literal, "src/components/Wired.tsx").findings, []);
  t.diagnostic("a11y-error.4: the wired, the literal, the missing-aria-invalid and the crossed-binding shapes read as intended");
});

test("a11y-error.5 (mutation): a region message is not reported — several fields or several messages", (t) => {
  const twoFields = [
    "export const Probe = () => (",
    "  <section>",
    '    <input aria-label="Name" />',
    '    <textarea aria-label="Description" />',
    '    <p role="status" className="error-banner">',
    "      the save was refused",
    "    </p>",
    "  </section>",
    ");",
  ].join("\n");
  assert.deepEqual(associationsIn(twoFields, "src/components/Region.tsx").findings, []);
  assert.equal(associationsIn(twoFields, "src/components/Region.tsx").fieldScoped, 0);

  const twoMessages = [
    "export const Probe = () => (",
    "  <section>",
    '    <input aria-label="Name" />',
    '    <p role="status" className="error-banner">',
    "      the activation was refused",
    "    </p>",
    '    <p role="status" className="error-banner">',
    "      the create was refused",
    "    </p>",
    "  </section>",
    ");",
  ].join("\n");
  assert.equal(associationsIn(twoMessages, "src/components/Region.tsx").fieldScoped, 0);
  t.diagnostic("a11y-error.5: a form-level notice and a two-message block stay region reports");
});

test("a11y-error.6: the association the gate reads is the one the module produces", (t) => {
  const failing = fieldError("the Host refused this", "probe-refusal");
  assert.deepEqual(failing, { invalid: "true", describedBy: "probe-refusal", id: "probe-refusal" });
  const clean = fieldError(null, "probe-refusal");
  assert.equal(clean.invalid, undefined, "a field with no refusal on screen must not read as invalid");
  assert.equal(clean.describedBy, undefined, "…and must not point at a message that is not rendered");
  t.diagnostic("a11y-error.6: fieldError yields both attributes for a refusal and neither for a clean field");
});
