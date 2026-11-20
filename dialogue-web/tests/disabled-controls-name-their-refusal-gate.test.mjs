/**
 * A control that greys itself out says why, or it says nothing at all.
 *
 * WHY (measured 2026-11-20)
 *
 * The owner cleared the thinking-level field on Settings and watched the Save beside it go grey: no
 * sentence, no red edge, the keyboard where it was, and no request to the Host. The reason existed -
 * `modelProfilesLevelRequired`, "Enter a thinking level." - attached to the Host's `invalid_request`
 * answer on a path that form can never reach, because the press that would send it is the press that
 * is withdrawn.
 *
 * That was the ELEVENTH site of one shape. The previous ten were each cured by hand, one at a time,
 * and each cure added its own `*-names-the-field.spec.ts` - ten specs pinning ten sites, and nothing
 * watching the class, which is why the eleventh had to be found by the owner. This gate is the class:
 * its population is every `disabled={...}` in the component tree, derived by parsing the files rather
 * than listed here, so a control added tomorrow is judged the day it is written.
 *
 * THE RULE, exactly. A predicate may withhold a press for one reason without explaining itself: a
 * request is in flight (`IN_FLIGHT`, below, each word carrying the day it must be re-read). Anything
 * else - an empty field, an invalid number, a row that cannot be removed, a dial that is already in
 * the asked-for position - is a fact the player can do something about, and the control must then
 * carry the reason in one of the two ways this product already uses:
 *
 *   - the FIELD half: the control carries `aria-invalid` and `aria-describedby`, the pair
 *     `fieldError(...)` produces (`field-error.ts`), so the sentence rendered under the field is the
 *     field's own description - the shape Memory's authoring forms and the world book's forms use;
 *   - the NAME half: the control's accessible name (`aria-label`, `aria-labelledby` or `title`) is
 *     derived from the same fact the predicate reads, so the name changes when the reason does -
 *     the shape the message-variant arrows use (`swipeNextAtLast`: "Next variant (this is the last
 *     variant)"). Derived, not asserted by a string match: the name expression's own facts are
 *     resolved through the local bindings it reads, and at least one of them must be a fact the
 *     predicate reads too. A name that merely repeats the button's word ("Save") is not a reason.
 *
 * WHAT IS NOT THE POPULATION, and why:
 *   - `<option disabled>`: an option is a choice that is not offered, not a control whose press is
 *     withheld; both of the tree's members render the reason AS the option's own label;
 *   - a `disabled` attribute with no expression at all is reported rather than excused: it is a
 *     control no player can ever press, which is the defect in its purest form.
 *
 * THE OPEN LIST is the honest count of today's unfixed sites. Each entry names the file, the control
 * and the predicate as written, the reason it is still silent, and the day the declaration expires -
 * at which point this gate fails on that entry whether or not the site was fixed. An entry whose site
 * has been fixed fails too: an exemption that exempts nothing is a note that stopped being true.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const DIALOGUE_WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(DIALOGUE_WEB, "src");

/**
 * The words that mean "a request is running". A predicate built only from these withholds a press the
 * player could not have made anyway, and needs no sentence of its own.
 *
 * Each word carries the day it must be re-read: this list is hand-written, so it decays, and a decayed
 * entry is a control this gate silently stopped judging. `expires` is how that cannot happen quietly.
 */
export const IN_FLIGHT = Object.freeze({
  active: { expires: "2027-01-31", why: "a lifecycle step is running (GameStatePanel's own field name)" },
  busy: { expires: "2027-01-31", why: "this row is being written" },
  clearing: { expires: "2027-01-31", why: "a clear request is running (voiceClearing)" },
  creating: { expires: "2027-01-31", why: "a create request is running" },
  exporting: { expires: "2027-01-31", why: "an export request is running" },
  importing: { expires: "2027-01-31", why: "an import request is running" },
  pending: { expires: "2027-01-31", why: "the panel's own in-flight flag, the name every settings group uses" },
  saving: { expires: "2027-01-31", why: "a save request is running" },
});

/**
 * The sites that still withhold a press for a reason that is not a request in flight.
 *
 * Every entry is a work item, not a permission: the file and the predicate are matched against the
 * tree, so an entry that no longer matches a silent control fails this gate, and so does one whose
 * `expires` has passed.
 */
export const OPEN = Object.freeze([
  {
    file: "src/components/CharacterWorldBookPanel.tsx",
    predicate: "!canRemove",
    expires: "2027-01-31",
    why: "the last entry cannot be removed; nothing on screen says so (the row's own text would be the reason)",
  },
  {
    file: "src/components/CharactersPanel.tsx",
    predicate: "choosingHandle !== null",
    expires: "2027-01-31",
    why: "another row's opening picker is open, and the press names no reason",
  },
  {
    file: "src/components/CharactersPanel.tsx",
    predicate: "openingVariants.value.length <= 1",
    expires: "2027-01-31",
    why: "one opening left cannot be discarded; the name is a bare word",
  },
  {
    file: "src/components/CharactersPanel.tsx",
    predicate:
      "openingSaving || openingVariants.value.every((variant) => variant.text.trim().length === 0)",
    expires: "2027-01-31",
    why: "half in flight, half 'every opening is empty' - the second half says nothing",
  },
  {
    file: "src/components/CompanionExamplesSection.tsx",
    predicate: "rows.value.length <= 1",
    expires: "2027-01-31",
    why: "the last example cannot be discarded; the third copy of the same shape",
  },
  {
    file: "src/components/Composer.tsx",
    predicate: "value.trim().length === 0",
    expires: "2027-01-31",
    why: "an empty composer withholds 'keep this draft'; self-evident, and still unstated",
  },
  {
    file: "src/components/GameStatePanel.tsx",
    predicate: "lifecycle.activation.active || session.controls.installationRequired",
    expires: "2027-01-31",
    why: "half in flight, half 'install the game first' - the second half says nothing",
  },
  {
    file: "src/components/GameStatePanel.tsx",
    predicate: "session.stop.active || session.stop.blocked",
    expires: "2027-01-31",
    why: "'blocked' names another running operation, and no sentence says which",
  },
  {
    file: "src/components/GameStatePanel.tsx",
    predicate: "session.disconnect.active || session.disconnect.blocked",
    expires: "2027-01-31",
    why: "same shape as Stop beside it",
  },
  {
    file: "src/components/GameStatePanel.tsx",
    predicate: 'state.kind === "confirming"',
    expires: "2027-01-31",
    why: "the control is withheld while its own confirmation is open",
  },
  {
    file: "src/components/MessageBubble.tsx",
    predicate: "busy || !canSave",
    expires: "2027-01-31",
    why: "an empty editor withholds Save; the sentence beside it is about the tail, not the field",
  },
  {
    file: "src/components/StardewInstallationDiscovery.tsx",
    predicate: "scannerDisabled || !isConfirmableCandidate(status)",
    expires: "2027-01-31",
    why: "two composed flags whose names describe the control, not the reason",
  },
  {
    file: "src/components/StardewInstallationDiscovery.tsx",
    predicate: "pickerDisabled",
    expires: "2027-01-31",
    why: "a composed flag: the name restates the control",
  },
  {
    file: "src/components/StardewInstallationDiscovery.tsx",
    predicate: "scannerDisabled",
    expires: "2027-01-31",
    why: "a composed flag: the name restates the control",
  },
  {
    file: "src/components/StardewInstallationDiscovery.tsx",
    predicate: "cancelDisabled",
    expires: "2027-01-31",
    why: "a composed flag: the name restates the control",
  },
  {
    file: "src/components/SurfaceModelSettings.tsx",
    predicate: "unavailable || saving",
    expires: "2027-01-31",
    why: "half in flight, half 'this route is not served' - the second half says nothing",
  },
  {
    file: "src/components/management-panels.tsx",
    predicate: "connectionView.pending || selected === undefined",
    expires: "2027-01-31",
    why: "a provider not yet chosen withholds the press; the select shows an empty row, not a reason",
  },
  {
    file: "src/components/management-panels.tsx",
    predicate: 'pending || connection.readiness !== "ready" || connection.active',
    expires: "2027-01-31",
    why: "'readiness !== ready' withholds the press; `connectionActivateRequiresReady` exists but is not tied to it",
  },
  {
    file: "src/components/management-panels.tsx",
    predicate: 'voiceView.pending || voiceView.preference.consent === "accepted"',
    expires: "2027-01-31",
    why: "consent already accepted withholds the press and says nothing",
  },
  {
    file: "src/components/management-panels.tsx",
    predicate: 'voiceView.pending || voiceView.preference.consent === "revoked"',
    expires: "2027-01-31",
    why: "consent already revoked withholds the press and says nothing",
  },
  {
    file: "src/components/management-surface-panels.tsx",
    predicate: "selectAvailable === false",
    expires: "2027-01-31",
    why: "a select that is not available withholds the press and says nothing",
  },
  {
    file: "src/components/management-surface-panels.tsx",
    predicate: "view.pending || !parsed.ok",
    expires: "2027-01-31",
    why: "an out-of-range temperature withholds Save; the warning beside it is not the field's description",
  },
]);

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

const toPosix = (path) => path.split(sep).join("/");

/** The camelCase words of a name, so `voiceClearing` reads as `voice` + `clearing`. */
function wordsOf(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .split(/[^a-zA-Z0-9]+/u)
    .map((word) => word.toLowerCase())
    .filter(Boolean);
}

const NOT_A_FACT = new Set(["undefined", "true", "false", "null"]);

/**
 * The facts an expression reads: its own bare identifiers, and the property each access chain ends at.
 *
 * `lifecycle.setup.active` reads `active` - the middle of a chain is a container, not a fact, and
 * counting `setup` would let any object-shaped predicate look like it named a reason.
 */
function factsOf(node) {
  const facts = new Set();
  walk(node, (inner) => {
    if (ts.isPropertyAccessExpression(inner)) {
      // Only the end of a chain: an access that is itself the object of another access is a path.
      if (ts.isPropertyAccessExpression(inner.parent) && inner.parent.expression === inner) return;
      facts.add(inner.name.getText());
      return;
    }
    if (!ts.isIdentifier(inner)) return;
    if (NOT_A_FACT.has(inner.text)) return;
    // A name-side identifier is already counted by the access above; an object side is a container.
    if (ts.isPropertyAccessExpression(inner.parent)) return;
    facts.add(inner.text);
  });
  return facts;
}

function attributesOf(element) {
  return ts.isJsxElement(element) ? element.openingElement.attributes : element.attributes;
}

function tagOf(element) {
  return ts.isJsxElement(element) ? element.openingElement.tagName.getText() : element.tagName.getText();
}

/** The named attribute of an element, or null. */
function attributeOf(element, name) {
  for (const property of attributesOf(element).properties)
    if (ts.isJsxAttribute(property) && property.name.getText() === name) return property;
  return null;
}

/** An attribute's expression: what was written between the braces, or the literal itself. */
function expressionOf(attribute) {
  const initializer = attribute.initializer;
  if (initializer === undefined) return null;
  return ts.isJsxExpression(initializer) ? (initializer.expression ?? null) : initializer;
}

/**
 * Every control whose press may be withheld in one source text, and the finding for each one that
 * says nothing about why.
 *
 * Exported so the mutation tests below drive the same reading as the tree, rather than a second
 * hand-written copy of the rule.
 */
export function withheldPressesIn(text, fileName) {
  const sourceFile = ts.createSourceFile(
    toPosix(fileName),
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const at = (node) => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const local = new Map();
  walk(sourceFile, (node) => {
    if (!ts.isVariableDeclaration(node) || node.initializer === undefined) return;
    if (ts.isIdentifier(node.name)) local.set(node.name.text, node.initializer);
  });

  const findings = [];
  const examined = [];
  walk(sourceFile, (node) => {
    if (!ts.isJsxAttribute(node) || node.name.getText() !== "disabled") return;
    const element = node.parent.parent;
    if (tagOf(element) === "option") return;
    const predicate = expressionOf(node);
    const located = `${toPosix(fileName).split("/dialogue-web/").pop()}:${at(node)}`;
    if (predicate === null) {
      findings.push(`${located} <${tagOf(element)}>: disabled with no condition at all, so no press ever`);
      return;
    }
    const written = predicate.getText().replace(/\s+/gu, " ");
    const facts = factsOf(predicate);
    const inFlight = facts.size > 0 && [...facts].every((fact) => wordsOf(fact).some((word) => word in IN_FLIGHT));
    examined.push({ located, tag: tagOf(element), written, facts: [...facts].sort(), inFlight });
    if (inFlight) return;

    // The FIELD half: the pair `fieldError(...)` produces, on the control itself.
    if (attributeOf(element, "aria-invalid") !== null && attributeOf(element, "aria-describedby") !== null) return;

    // The NAME half: an accessible name derived from the same fact the predicate reads.
    const named = new Set();
    const seen = new Set();
    const queue = [];
    for (const name of ["aria-label", "aria-labelledby", "title"]) {
      const attribute = attributeOf(element, name);
      const expression = attribute === null ? null : expressionOf(attribute);
      if (expression !== null) queue.push(expression);
    }
    while (queue.length > 0) {
      const current = queue.pop();
      for (const fact of factsOf(current)) named.add(fact);
      walk(current, (inner) => {
        if (!ts.isIdentifier(inner) || !local.has(inner.text) || seen.has(inner.text)) return;
        seen.add(inner.text);
        queue.push(local.get(inner.text));
      });
    }
    const shared = [...facts].filter((fact) => named.has(fact));
    if (shared.length > 0) return;

    findings.push(
      `${located} <${tagOf(element)}> disabled={${written}}: withheld for ${[...facts].sort().join("+") || "no fact"}, ` +
        "which is not a request in flight, and neither half states the reason - the control carries no " +
        "field error (aria-invalid + aria-describedby) and its accessible name is not derived from that fact",
    );
  });
  return { examined, findings };
}

/** Every withheld press in the component tree, and the finding for each one that says nothing. */
export function silentControls(files = sourceFiles()) {
  const findings = [];
  const examined = [];
  for (const file of files) {
    const read = withheldPressesIn(readFileSync(file, "utf8"), file);
    examined.push(...read.examined);
    findings.push(...read.findings);
  }
  return { findings, examined, files: files.length };
}

/** The site key an OPEN entry is matched by: the file, the control's predicate as written. */
function siteKey(file, predicate) {
  return `${toPosix(file).split("/dialogue-web/").pop()}|${predicate}`;
}

function findingKey(finding) {
  const match = /^(.*?):\d+ <[^>]+> disabled=\{(.*?)\}: withheld for/u.exec(finding);
  return match === null ? finding : `${match[1]}|${match[2]}`;
}

test("silent-disable.1: a press withheld for a reason other than a request in flight states the reason", (t) => {
  const read = silentControls();
  const declared = new Set(OPEN.map((entry) => siteKey(entry.file, entry.predicate)));
  const undeclared = read.findings.filter((finding) => !declared.has(findingKey(finding)));
  const silentKeys = new Set(read.findings.map(findingKey));
  const stale = OPEN.filter((entry) => !silentKeys.has(siteKey(entry.file, entry.predicate))).map(
    (entry) => `stale_exemption: ${entry.file} disabled={${entry.predicate}} is not a silent control any more`,
  );
  t.diagnostic(
    `silent-disable.1: ${read.files} tsx file(s), ${read.examined.length} withheld press(es), ` +
      `${read.examined.filter((entry) => entry.inFlight).length} in flight only, ${read.findings.length} silent, ` +
      `${OPEN.length} declared`,
  );
  assert.deepEqual(
    [...undeclared, ...stale],
    [],
    "a control that withholds a press for something the player can fix must say what it is: give the field " +
      "the `fieldError` pair, or derive the control's accessible name from the fact the predicate reads - " +
      "and if it is left for now, declare it in OPEN with the day the declaration expires",
  );
});

test("silent-disable.2: the population is the tree, and it is not empty", (t) => {
  const read = silentControls();
  assert.ok(read.files >= 20, `expected the component tree, found ${read.files} tsx file(s)`);
  // Derived, not listed: if the parse stops finding braces, every count below drops to zero and this
  // gate would agree with itself. The numbers are floors measured on the tree it was written against.
  assert.ok(read.examined.length >= 90, `expected the tree's withheld presses, found ${read.examined.length}`);
  assert.ok(
    read.examined.filter((entry) => entry.inFlight).length >= 60,
    `expected the in-flight majority, found ${read.examined.filter((entry) => entry.inFlight).length} of ${read.examined.length}`,
  );
  t.diagnostic(
    `silent-disable.2: examined ${read.examined.length} withheld press(es) in ${read.files} file(s), reading ` +
      `${read.findings.length} silent`,
  );
});

test("silent-disable.3: every in-flight word and every exemption expires, and each is still doing work", (t) => {
  const today = new Date().toISOString().slice(0, 10);
  const read = silentControls();
  const failures = [];
  for (const [word, entry] of Object.entries(IN_FLIGHT)) {
    if (entry.expires < today) failures.push(`in_flight_word_expired: ${word} was last read on ${entry.expires}`);
    // A word nothing matches is a word that has stopped exempting anything, and the list is the only
    // place that would ever say so.
    const uses = read.examined.filter((control) =>
      control.facts.some((fact) => wordsOf(fact).includes(word)),
    ).length;
    if (uses === 0) failures.push(`in_flight_word_unused: no control's predicate reads "${word}"`);
    t.diagnostic(`silent-disable.3: ${word} (${entry.why}) - ${uses} withheld press(es)`);
  }
  for (const entry of OPEN) {
    if (entry.expires < today) failures.push(`exemption_expired: ${entry.file} disabled={${entry.predicate}} (${entry.expires})`);
    if (entry.why.trim() === "") failures.push(`exemption_unexplained: ${entry.file} disabled={${entry.predicate}}`);
  }
  const duplicates = OPEN.map((entry) => siteKey(entry.file, entry.predicate)).filter(
    (key, index, all) => all.indexOf(key) !== index,
  );
  for (const key of duplicates) failures.push(`exemption_declared_twice: ${key}`);
  t.diagnostic(`silent-disable.3: ${Object.keys(IN_FLIGHT).length} in-flight word(s), ${OPEN.length} exemption(s)`);
  assert.deepEqual(failures, [], "an exemption is a debt with a date on it");
});

test("silent-disable.4 (mutation): a withheld press with no reason is reported with file, predicate and the missing half", (t) => {
  const probe = [
    "export const Probe = ({ canSave }: { canSave: boolean }) => (",
    "  <form>",
    '    <input className="form-input" aria-label="Thinking level" />',
    '    <button type="submit" aria-label="Save" disabled={!canSave}>',
    "      Save",
    "    </button>",
    "  </form>",
    ");",
  ].join("\n");
  const read = withheldPressesIn(probe, "src/components/Mutation.tsx");
  assert.equal(read.examined.length, 1);
  assert.deepEqual(
    read.findings.map((finding) => finding.replace(/^.*?:(\d+) /u, "")),
    [
      "<button> disabled={!canSave}: withheld for canSave, which is not a request in flight, and neither half " +
        "states the reason - the control carries no field error (aria-invalid + aria-describedby) and its " +
        "accessible name is not derived from that fact",
    ],
  );
  assert.match(read.findings[0], /^src\/components\/Mutation\.tsx:4 /u, "the finding names the control's own line");
  t.diagnostic("silent-disable.4: the silent press is named by file, line and predicate, and the missing half is spelled out");
});

test("silent-disable.5 (mutation): each way of stating the reason passes, and half of it does not", (t) => {
  const source = (button) =>
    [
      "export const Probe = ({ canSave, busy }: { canSave: boolean; busy: boolean }) => (",
      "  <form>",
      '    <input className="form-input" aria-label="Thinking level" aria-invalid={error.invalid} aria-describedby={error.describedBy} />',
      '    <p role="status" className="error-banner" id={error.id}>',
      "      {problem}",
      "    </p>",
      `    ${button}`,
      "  </form>",
      ");",
    ].join("\n");

  // In flight: no reason owed.
  assert.deepEqual(withheldPressesIn(source("<button disabled={busy} />"), "src/P.tsx").findings, []);
  // The field half, on the control itself.
  assert.deepEqual(
    withheldPressesIn(source('<button disabled={!canSave} aria-invalid="true" aria-describedby="refusal" />'), "src/P.tsx")
      .findings,
    [],
  );
  // The name half: the name reads the same fact the predicate does, through a local binding.
  const named = [
    "export const Probe = ({ atEdge }: { atEdge: boolean }) => {",
    "  const name = atEdge ? 'Next variant (this is the last variant)' : 'Next variant';",
    "  return <button disabled={atEdge} aria-label={name} />;",
    "};",
  ].join("\n");
  assert.deepEqual(withheldPressesIn(named, "src/P.tsx").findings, []);
  // A name that is a bare word does not.
  const bareWord = [
    "export const Probe = ({ atEdge }: { atEdge: boolean }) => (",
    '  <button disabled={atEdge} aria-label="Next variant" />',
    ");",
  ].join("\n");
  assert.equal(withheldPressesIn(bareWord, "src/P.tsx").findings.length, 1);
  // And a name derived from a DIFFERENT fact is not a reason for this one.
  const otherFact = [
    "export const Probe = ({ atEdge, busy }: { atEdge: boolean; busy: boolean }) => {",
    "  const name = busy ? 'Saving' : 'Save';",
    "  return <button disabled={atEdge} aria-label={name} />;",
    "};",
  ].join("\n");
  assert.equal(withheldPressesIn(otherFact, "src/P.tsx").findings.length, 1);
  t.diagnostic("silent-disable.5: in-flight, field-error, derived-name pass; a bare word and a foreign fact do not");
});

test("silent-disable.6 (mutation): an option is a choice, not a control whose press is withheld", (t) => {
  const probe = [
    "export const Probe = () => (",
    '  <select aria-label="Provider">',
    '    <option value="" disabled>',
    "      Choose a provider",
    "    </option>",
    "  </select>",
    ");",
  ].join("\n");
  assert.deepEqual(withheldPressesIn(probe, "src/P.tsx").findings, []);
  // A `<button disabled>` with no condition at all is the defect in its purest form, and is reported.
  const literal = "export const Probe = () => <button disabled>Save</button>;";
  assert.deepEqual(withheldPressesIn(literal, "src/P.tsx").findings, [
    "src/P.tsx:1 <button>: disabled with no condition at all, so no press ever",
  ]);
  t.diagnostic("silent-disable.6: a disabled option is not the population; a disabled button with no condition is");
});
