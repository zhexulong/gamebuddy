import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  auditConductClasses,
  COMPOSED_DECLARATION,
  conductRules,
  CONDUCT_OWNERS,
  CONDUCT_RULE_CODES,
  CONDUCT_SOURCE,
} from "./check-game-surface-conduct-classes.mjs";

// red-proof: inject  a second, hand-written class table beside the floor's entries with two rows whose classes are not
//            the ones their entries declare -> `conduct_class_restated:observed_only` and
//            `conduct_class_restated:one_utterance_per_reply`, each detail naming both classes; the rules themselves keep
//            the class their own entry gives them (see "a class restated in a table beside the rules is named with both
//            classes" below).
//
// Also injected, each seen red once (this file): the deleted "Speak before you act" rule restored as an entry and
// classified FORM (`floor_governs_form:speak_before_acting:host/src/game-surface-prompt-floor.ts`), a rule's text spelled
// into the composed list instead of a reference to its entry, a Stardew rule removed from the floor while its class stays
// behind, a class outside the three kinds, a class with no reason, a composed name no module declares, a renamed
// declaration (blocked, exit 2 - never green), and a list whose elements are no longer one per line (blocked, because a
// reader that mis-parsed the floor and passed would be worse than no gate).
//
// DERIVED, NOT PINNED, measured 2026-11-22. Nine cases here pinned an index, a count, or the sentence of the rule next
// door, all read off the 19-rule floor, and the floor then lost nine rules in two commits - seven in af080cb6
// (partner_words_first, company_not_step_reports, no_dispatcher_logging, tangible_specifics, refusal_in_person,
// decide_yourself, concrete_question_ok), two in 6cc7915c (LIVE_STATE_GROUNDING, HOUSE_HAS_NO_KITCHEN) - so the suite read
// 5 pass / 9 fail while the gate itself stayed green (`examined 10 · FLOOR 2 · CHANNEL 8 · FORM 0`). Every expectation a
// deletion can move is now read from the table the gate classifies: the population is the count the two tables declare,
// a rule's position is looked up by its id, the class counts come from the entries, and a fixture edits the list by the
// rule's own element instead of by a neighbour's prose - so the next rule that leaves moves the expectation with it.
//
// THE SHIFT THIS GATE COULD NOT SEE, measured 2026-11-15 on the previous shape: the rules were one array and their
// classes another, joined only by index. Swapping the markdown/delivery rule with the observation-honesty rule - two
// rules of different classes - kept `status: passed`, `examined 19`, FLOOR 10, CHANNEL 9 at exit 0, recording the
// observation contract as a delivery rule and the delivery rule as observation honesty. That swap is a test here now
// ("reordering the composed list moves the prompt, not a class"): the class follows its element because the element IS a
// reference to the entry that carries it.
//
// PROVENANCE - 2026-11-11, round46b, the run this gate exists for: the floor ordered "always deliver a spoken remark
// before calling any action or planning tool", the shipped card's own directive says 收放自如, and the run answered
// with 132 bubbles over 93 prompt turns - 90 of them standalone speech with no tool call in the same message.

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GATE = join(REPOSITORY_ROOT, "tools", "check-game-surface-conduct-classes.mjs");

const readReal = (module) => readFileSync(join(REPOSITORY_ROOT, ...module.split("/")), "utf8");
const FLOOR_MODULE = CONDUCT_SOURCE;
const STARDEW_MODULE = CONDUCT_OWNERS.find((owner) => owner.module !== CONDUCT_SOURCE)?.module;
const REAL_FLOOR = readReal(FLOOR_MODULE);
const REAL_STARDEW = readReal(STARDEW_MODULE);

/**
 * The tree's own reading, taken once, and the population the floor's two tables declare.
 *
 * Every expectation below that a rule's deletion can move is read from these instead of being pinned: a pinned index is
 * the position a list happened to have on the day it was written, and the floor lost nine rules after these pins were
 * (af080cb6, 6cc7915c), which left nine cases asserting numbers of a list that no longer existed.
 */
const REAL_READING = auditConductClasses({ root: REPOSITORY_ROOT });
const DECLARED = conductRules(
  new Map([
    [FLOOR_MODULE, REAL_FLOOR],
    [STARDEW_MODULE, REAL_STARDEW],
  ]),
).declared.size;
/** The position an element appended after the composed list's last rule lands at. */
const APPENDED_INDEX = String(REAL_READING.examined);

const RULES_OPEN = "const GAME_SURFACE_CONDUCT_RULES = {\n";
const RULES_CLOSE = '].join("\\n");';
const TABLE_PROJECTION =
  "}>[] = Object.entries(GAME_SURFACE_CONDUCT_RULES).map(([id, rule]) =>\n" +
  "  Object.freeze({ id, class: rule.class, reason: rule.reason, exit: rule.exit }),\n" +
  ");";
const REMOVED_RULE_TEXT =
  "Speak before you act: when responding to your partner or deciding to take an action, always deliver a spoken " +
  "remark to your partner first in the same reply before calling any action or planning tool. Never run tools in total " +
  "silence when your partner has spoken to you or when beginning a stretch of work. Never claim work is already " +
  "finished before the tool has run; speak your immediate intent or acknowledgment, then invoke the tool.";

/** A throwaway tree at the real relative paths, so the gate reads the product's own file names. */
async function withFixtureRoot({ floor = REAL_FLOOR, stardew = REAL_STARDEW }, run) {
  const root = mkdtempSync(join(tmpdir(), "conduct-classes-"));
  try {
    for (const [module, source] of [
      [FLOOR_MODULE, floor],
      [STARDEW_MODULE, stardew],
    ]) {
      const path = join(root, ...module.split("/"));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, source);
    }
    return await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const codes = (reading) => reading.violations.map((violation) => violation.code);

/** One entry of the classed declaration, rendered as the source would carry it. */
const entry = ({
  id,
  class: klass,
  reason,
  text,
  exit = "permanent: a fixture rule, and its exit is not what these cases measure.",
}) =>
  `  ${id}: {\n    class: "${klass}",\n    reason: ${JSON.stringify(reason)},\n    exit: ${JSON.stringify(exit)},\n    text: ${JSON.stringify(text)},\n  },`;

/** The floor with one entry appended to the classed declaration. */
const withEntry = (source, rendered) => source.replace(RULES_OPEN, `${RULES_OPEN}${rendered}\n`);

/** The floor with one element appended to the composed list. */
const withComposedElement = (source, element) => source.replace(RULES_CLOSE, `  ${element}\n${RULES_CLOSE}`);

/** The floor's class table written back as literals instead of projected from the entries. */
const withRestatedTable = (source, rows) =>
  source.replace(TABLE_PROJECTION, `}>[] = Object.freeze([\n${rows.join("\n")}\n]);`);

/** The composed list as the floor writes it: the lines before it, its own elements, and the lines that follow. */
function composedList(source) {
  const at = source.indexOf(COMPOSED_DECLARATION);
  assert.notEqual(at, -1, `the composed list is not declared as "${COMPOSED_DECLARATION}" any more`);
  const lines = source.slice(at).split("\n");
  const close = lines.findIndex((line) => line.trim().startsWith("]"));
  assert.notEqual(close, -1, 'the composed list is never closed by a line starting with "]"');
  return { before: source.slice(0, at), open: lines[0], elements: lines.slice(1, close), after: lines.slice(close) };
}

const rebuild = ({ before, open, elements, after }) => [before + open, ...elements, ...after].join("\n");

/**
 * The position, in the composed list, of the element that carries the rule with this id.
 *
 * The fixtures below edit the list by the rule's own element, never by the sentence of the rule beside it: a neighbour
 * is the anchor that rots. `refusal_in_person` and `partner_words_first` both left in af080cb6 and took three of this
 * file's anchors with them, so the fixture for a rule then reached nothing.
 */
function elementIndex(list, id) {
  const needles = [`GAME_SURFACE_CONDUCT_RULES.${id}.text,`, `${id.toUpperCase()},`];
  const index = list.elements.findIndex((line) => needles.includes(line.trim()));
  assert.notEqual(index, -1, `the composed list carries no element for ${id}: this fixture would prove nothing`);
  return index;
}

/** One classed entry with one field's string rewritten - the entry found by its id, never by a neighbour's prose. */
function withEntryField(source, id, field, value) {
  const at = source.indexOf(`  ${id}: {\n`);
  assert.notEqual(at, -1, `${id} is not an entry of GAME_SURFACE_CONDUCT_RULES: this fixture would prove nothing`);
  const end = source.indexOf("\n  },", at);
  assert.notEqual(end, -1, `the entry ${id} is not closed on a line of its own`);
  const match = new RegExp(`${field}:\\s*"(?:[^"\\\\]|\\\\.)*"`, "u").exec(source.slice(at, end));
  assert.notEqual(match, null, `the entry ${id} carries no ${field} string: ${source.slice(at, at + 80)}`);
  const start = at + match.index;
  const [before, after] = [source.slice(0, start), source.slice(start + match[0].length)];
  return `${before}${field}: ${JSON.stringify(value)}${after}`;
}

/** The braces of one rule's entry or table row, found by its id, as the slice a fixture may edit. */
function ruleBlock(source, id) {
  const starts = [`  ${id}: {\n`, `    id: "${id}",\n`];
  const start = starts.map((needle) => source.indexOf(needle)).find((index) => index !== -1);
  assert.notEqual(start, undefined, `${id} is not an entry of either table: this fixture would prove nothing`);
  const end = source.indexOf("\n  },", start);
  assert.notEqual(end, -1, `the entry ${id} is not closed on a line of its own`);
  return { start: source.lastIndexOf("{", start), end: end + 4 };
}

/** One rule's entry or table row with one field's string removed - the field found inside the rule's own braces. */
function withoutField(source, id, field) {
  const { start, end } = ruleBlock(source, id);
  const block = source.slice(start, end);
  const match = new RegExp(`\\n\\s*${field}:\\s*"(?:[^"\\\\]|\\\\.)*",`, "su").exec(block);
  assert.notEqual(match, null, `${id} carries no ${field} string: ${block.slice(0, 80)}`);
  return source.slice(0, start) + block.replace(match[0], "") + source.slice(end);
}

/** The first rule the floor module itself declares with this class, read from the tree's own table. */
function floorRuleOfClass(klass) {
  const rule = REAL_READING.rules.find((row) => row.module === FLOOR_MODULE && row.class === klass);
  assert.ok(rule, `the floor declares no ${klass} rule, so this case has nothing to break`);
  return rule;
}

/** Two composed rules that sit next to each other and are not of one class - the swap a positional table cannot survive. */
function differentClassNeighbours() {
  for (let index = 0; index + 1 < REAL_READING.rules.length; index += 1) {
    const [left, right] = [REAL_READING.rules[index], REAL_READING.rules[index + 1]];
    if (right.index === left.index + 1 && left.class !== right.class) return [left, right];
  }
  assert.fail("the floor composes no adjacent pair of different classes, so a swap could not move a class");
}

test("every composed rule carries a class from the entry it names, and none of them governs form", () => {
  const reading = auditConductClasses({ root: REPOSITORY_ROOT });
  assert.deepEqual(codes(reading), [], "the tree's own conduct is fully classified");
  // Re-derived from the tables (this read `examined >= 15` for the 19-rule floor): the composed list is exactly the
  // population the two tables declare, so a shorter reading is a truncated list and a longer one is an element no
  // table classifies.
  assert.equal(
    reading.examined,
    DECLARED,
    `the composed list carries ${String(reading.examined)} rules and the floor's tables declare ${String(DECLARED)}`,
  );
  assert.equal(
    reading.classes.FLOOR + reading.classes.CHANNEL + reading.classes.FORM,
    reading.examined,
    "each rule is exactly one class, so the four numbers describe one population",
  );
  assert.equal(reading.classes.FORM, 0, "a form rule in the floor is the defect this gate exists for");
  const ids = reading.rules.map((rule) => rule.id);
  assert.equal(new Set(ids).size, ids.length, "each rule is classed once, so no id describes two rules");
  // Both owners are exercised by the real tree: a module that contributed no rule would make its table untested here.
  for (const owner of CONDUCT_OWNERS) {
    const owned = reading.rules.filter((rule) => rule.module === owner.module).length;
    assert.ok(owned > 0, `${owner.module} contributes no rule to the floor, so its table classifies nothing`);
  }
  process.stdout.write(
    `conduct_classes examined ${String(reading.examined)} · FLOOR ${String(reading.classes.FLOOR)} · ` +
      `CHANNEL ${String(reading.classes.CHANNEL)} · FORM ${String(reading.classes.FORM)}\n`,
  );
});

test("a form rule restored to the floor is named with the module that carries it", async () => {
  const floor = withComposedElement(
    withEntry(
      REAL_FLOOR,
      entry({
        id: "speak_before_acting",
        class: "FORM",
        reason: "a spoken remark before every tool call.",
        text: REMOVED_RULE_TEXT,
      }),
    ),
    "GAME_SURFACE_CONDUCT_RULES.speak_before_acting.text,",
  );
  const reading = await withFixtureRoot({ floor }, (root) => auditConductClasses({ root }));
  assert.deepEqual(
    codes(reading),
    [`floor_governs_form:speak_before_acting:${FLOOR_MODULE}`],
    "exactly the rule that governs form, named by its id and the module holding it",
  );
  assert.equal(reading.status, "failed");
  assert.match(reading.violations[0].detail, /the card owns that: delete the rule rather than classifying it/u);
});

test("reordering the composed list moves the prompt, not a class", async () => {
  // The shift that was invisible: two composed rules of different classes swapped positions. The element is a reference
  // to its entry, so the class travels with it - the swap changes the reading order and nothing else.
  // The pair is read from the tables rather than pinned at 10 and 11, which was where these two rules sat in the
  // 19-rule list: the pair only has to be adjacent and of different classes for the swap to be able to move a class.
  const [left, right] = differentClassNeighbours();
  const list = composedList(REAL_FLOOR);
  const [leftAt, rightAt] = [elementIndex(list, left.id), elementIndex(list, right.id)];
  assert.equal(rightAt, leftAt + 1, `${left.id} and ${right.id} are no longer neighbours in the composed list`);
  const elements = [...list.elements];
  [elements[leftAt], elements[rightAt]] = [elements[rightAt], elements[leftAt]];
  const floor = rebuild({ ...list, elements });
  assert.notEqual(floor, REAL_FLOOR, "the fixture must really reorder the composed list");
  const reading = await withFixtureRoot({ floor }, (root) => auditConductClasses({ root }));
  assert.deepEqual(codes(reading), [], "a reordering is an order change: it cannot move a class off its rule");
  const at = (index) => reading.rules.find((rule) => rule.index === index);
  assert.deepEqual(
    [at(left.index), at(right.index)].map((rule) => [rule?.id, rule?.class]),
    [
      [right.id, right.class],
      [left.id, left.class],
    ],
    "each element still reads as the class its own entry declares, whatever position it sits at",
  );
});

test("a class restated in a table beside the rules is named with both classes", async () => {
  // The regression shape this unit removed: a second, hand-written class table. Its classes are not the entries' own,
  // and before the refactor that disagreement was a silent result of array position rather than a finding.
  const floor = withRestatedTable(REAL_FLOOR, [
    '  { id: "observed_only", class: "CHANNEL", reason: "the observation rule, moved." },',
    '  { id: "one_utterance_per_reply", class: "FLOOR", reason: "the delivery rule, moved." },',
  ]);
  assert.notEqual(floor, REAL_FLOOR, "the fixture must really write the table back as literals");
  const reading = await withFixtureRoot({ floor }, (root) => auditConductClasses({ root }));
  assert.deepEqual(codes(reading), [
    "conduct_class_restated:observed_only",
    "conduct_class_restated:one_utterance_per_reply",
  ]);
  assert.match(
    reading.violations[0].detail,
    /states the class "CHANNEL", and that rule's own entry declares "FLOOR"/u,
    "the finding names the class the table states and the one the rule's own entry declares",
  );
  assert.equal(
    reading.rules.find((rule) => rule.id === "observed_only")?.class,
    "FLOOR",
    "the rule is still read as its own entry classifies it: the table cannot move it",
  );
  // Re-derived from the entries (this read `CHANNEL === 9`, the 19-rule floor's count): the table below moves one FLOOR
  // rule into CHANNEL and one CHANNEL rule into FLOOR, so a table that won would leave both counts off by one.
  assert.equal(
    reading.classes.CHANNEL,
    REAL_READING.classes.CHANNEL,
    "the counts are the entries', not the restated table's",
  );
  assert.equal(reading.classes.FLOOR, REAL_READING.classes.FLOOR, "the restated table moves no rule out of FLOOR");
});

// The report is the half `tools/lib/harness-conformance.mjs` reads, so it is driven over the CLI rather than the library:
// a report and a finding that disagree is the shape this suite could not see before.
const cliReport = (root) => {
  const result = spawnSync(process.execPath, [GATE, "--root", root], { encoding: "utf8" });
  const lines = result.stdout.trim().split("\n");
  return {
    status: result.status,
    report: JSON.parse(lines[lines.length - 1]),
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

test("the default run names every rule it can go red on, one report entry per rule", () => {
  const { status, report } = cliReport(REPOSITORY_ROOT);
  assert.equal(status, 0, "the tree's own conduct is fully classified");
  assert.deepEqual(
    report.checks.map((check) => check.id),
    ["conduct_population", ...CONDUCT_RULE_CODES],
    "the report is the population plus one entry per falsifier, in the order the gate lists them",
  );
  assert.deepEqual(
    report.checks.map((check) => check.status),
    report.checks.map(() => "passed"),
    "the real tree passes every rule, so a red entry here would be a finding rather than a shape",
  );
  assert.equal(
    report.examined,
    auditConductClasses({ root: REPOSITORY_ROOT }).examined,
    "the report carries the same population the library reading does, so one number describes one list",
  );
});

test("a form rule in the floor turns that rule's report entry red, not only the exit code", async () => {
  const floor = withComposedElement(
    withEntry(
      REAL_FLOOR,
      entry({
        id: "speak_before_acting",
        class: "FORM",
        reason: "a spoken remark before every tool call.",
        text: REMOVED_RULE_TEXT,
      }),
    ),
    "GAME_SURFACE_CONDUCT_RULES.speak_before_acting.text,",
  );
  await withFixtureRoot({ floor }, (root) => {
    const { status, report, stderr } = cliReport(root);
    assert.equal(status, 1, `the CLI exits 1 on a form rule, printed: ${stderr}`);
    const form = report.checks.find((check) => check.id === "floor_governs_form");
    assert.equal(form?.status, "failed", "the rule's own entry is red, which is what the conformance suite reads");
    assert.match(form.detail, /^1 violation\(s\) of no rule in the floor governs the turn's form/u);
    assert.deepEqual(
      report.checks.filter((check) => check.status === "failed").map((check) => check.id),
      ["floor_governs_form"],
      "only the rule that fired is red, so the report names which rule a reader has to fix",
    );
    return null;
  });
});

test("a blocked reading reports every rule as blocked rather than as passed", async () => {
  const floor = REAL_FLOOR.replace(
    "const GAME_SURFACE_INTERACTION_CONDUCT = [",
    "const GAME_SURFACE_INTERACTION_CONDUCT_RENAMED = [",
  );
  await withFixtureRoot({ floor }, (root) => {
    const { status, report } = cliReport(root);
    assert.equal(status, 2, "a population this gate cannot see cannot pass");
    assert.equal(report.examined, 0);
    assert.deepEqual(
      report.checks.map((check) => check.status),
      report.checks.map(() => "blocked"),
      "nothing was judged, so no rule may claim to have passed over it",
    );
    return null;
  });
});

test("a rule's text spelled into the composed list is named by its position and its first words", async () => {
  const floor = withComposedElement(REAL_FLOOR, `"${REMOVED_RULE_TEXT}",`);
  const reading = await withFixtureRoot({ floor }, (root) => auditConductClasses({ root }));
  assert.deepEqual(
    codes(reading),
    [`conduct_rule_without_a_class:${APPENDED_INDEX}:Speak before you act: when`],
    "a rule written into the prompt has no entry for its class to live in, so the gate says which position and words",
  );
  assert.match(reading.violations[0].detail, /compose it as a reference to that entry/u);
});

test("a Stardew rule taken out of the floor leaves its class behind, and that is stale rather than harmless", async () => {
  // The element is located inside the composed list and removed there: the name also appears once in this module's import
  // list, and the anchor this case used to carry was the line of the rule that followed it (`refusal_in_person`, gone in
  // af080cb6), so the fixture stopped dropping the element at all.
  const removed = REAL_READING.rules.find((rule) => rule.module === STARDEW_MODULE);
  assert.ok(removed, `${STARDEW_MODULE} contributes no rule to the floor, so this case has nothing to remove`);
  const list = composedList(REAL_FLOOR);
  const at = elementIndex(list, removed.id);
  const floor = rebuild({ ...list, elements: list.elements.filter((_, index) => index !== at) });
  assert.notEqual(floor, REAL_FLOOR, "the fixture must really drop the element, or it proves nothing");
  const reading = await withFixtureRoot({ floor }, (root) => auditConductClasses({ root }));
  assert.deepEqual(codes(reading), [`stale_conduct_class:${removed.id}`]);
  assert.match(reading.violations[0].detail, /removing a rule must remove its class entry/u);
});

test("a name the floor composes but no module declares is unowned, not silently skipped", async () => {
  const reading = await withFixtureRoot({ floor: withComposedElement(REAL_FLOOR, "GHOST_RULE,") }, (root) =>
    auditConductClasses({ root }),
  );
  assert.deepEqual(codes(reading), [`conduct_rule_unowned:${APPENDED_INDEX}:GHOST_RULE`]);
});

test("a class outside the three kinds is a finding, not a fourth kind", async () => {
  // The entry is chosen from the reading and edited inside its own braces: the anchor this case used to carry was the
  // reason sentence of `partner_words_first`, and that rule left the floor in af080cb6.
  const target = floorRuleOfClass("FLOOR");
  const floor = withEntryField(REAL_FLOOR, target.id, "class", "STYLE");
  assert.notEqual(floor, REAL_FLOOR, "the fixture must really change an entry's class");
  const reading = await withFixtureRoot({ floor }, (root) => auditConductClasses({ root }));
  assert.deepEqual(codes(reading), [`conduct_class_unknown:${target.id}`]);
  assert.match(reading.violations[0].detail, /is not one of FLOOR \/ CHANNEL \/ FORM/u);
});

test("a class with no reason is a label nobody argued for", async () => {
  const target = floorRuleOfClass("FLOOR");
  const floor = withEntryField(REAL_FLOOR, target.id, "reason", "");
  assert.notEqual(floor, REAL_FLOOR, "the fixture must really blank an entry's reason");
  const reading = await withFixtureRoot({ floor }, (root) => auditConductClasses({ root }));
  assert.deepEqual(codes(reading), [`conduct_class_without_reason:${target.id}`]);
});

test("a rule that names no exit is named with the rule, and the census counts it as unowned", async () => {
  // The property this unit added: a floor rule is a debt with a named owner, so an entry without an exit is the finding -
  // the shape an entry with no exit has is a rule nobody has said when they will delete.
  const target = floorRuleOfClass("CHANNEL");
  const floor = withoutField(REAL_FLOOR, target.id, "exit");
  assert.notEqual(floor, REAL_FLOOR, "the fixture must really remove an entry's exit");
  const reading = await withFixtureRoot({ floor }, (root) => auditConductClasses({ root }));
  assert.deepEqual(codes(reading), [`floor_rule_has_no_exit:${target.id}`]);
  assert.equal(reading.unowned, 1, "the census counts the rule as unowned rather than dropping it");
  assert.equal(
    reading.exits.surface + reading.exits.authority + reading.exits.permanent,
    reading.examined - 1,
    "the rules that do name an exit are still counted, so the two halves describe one population",
  );
  assert.match(reading.violations[0].detail, /names no exit, so nothing says how the rule dies/u);
  await withFixtureRoot({ floor }, (root) => {
    const { status, report, stderr } = cliReport(root);
    assert.equal(status, 1, `a rule with no exit fails the gate, printed: ${stderr}`);
    const unexited = report.checks.find((check) => check.id === "floor_rule_has_no_exit");
    assert.equal(unexited?.status, "failed", "the rule's own report entry is red, which is what the suite reads");
    assert.match(unexited.detail, /^1 violation\(s\) of every rule names its exit/u);
    assert.equal(report.unowned, 1);
    return null;
  });
});

test("a Stardew row with no exit is named too: the table that owns the rule carries the debt", async () => {
  const removed = REAL_READING.rules.find((rule) => rule.module === STARDEW_MODULE);
  assert.ok(removed, `${STARDEW_MODULE} contributes no rule to the floor, so this case has nothing to edit`);
  const stardew = withoutField(REAL_STARDEW, removed.id, "exit");
  assert.notEqual(stardew, REAL_STARDEW, "the fixture must really remove an exit from a table row");
  const reading = await withFixtureRoot({ stardew }, (root) => auditConductClasses({ root }));
  assert.deepEqual(codes(reading), [`floor_rule_has_no_exit:${removed.id}`]);
});

test("an exit outside the three kinds is named with what the entry spelled", async () => {
  const target = floorRuleOfClass("FLOOR");
  const floor = withEntryField(REAL_FLOOR, target.id, "exit", "later: someone will delete this");
  assert.notEqual(floor, REAL_FLOOR, "the fixture must really change an entry's exit");
  const reading = await withFixtureRoot({ floor }, (root) => auditConductClasses({ root }));
  assert.deepEqual(codes(reading), [`floor_rule_has_no_exit:${target.id}`]);
  assert.match(
    reading.violations[0].detail,
    /names the exit kind "later", which is not one of surface \/ authority \/ permanent/u,
  );
});

test("an exit that names a kind and says nothing after it is a label, not an exit", async () => {
  const target = floorRuleOfClass("FLOOR");
  const floor = withEntryField(REAL_FLOOR, target.id, "exit", "permanent: ");
  const reading = await withFixtureRoot({ floor }, (root) => auditConductClasses({ root }));
  assert.deepEqual(codes(reading), [`floor_rule_has_no_exit:${target.id}`]);
  assert.match(reading.violations[0].detail, /an exit with no change, no owner and no reason is a label/u);
});

test("the census adds up over the real tree, and it is what the default run prints", () => {
  const { status, report, stdout } = cliReport(REPOSITORY_ROOT);
  assert.equal(status, 0, "the tree's own floor names an exit for every rule");
  assert.equal(report.unowned, 0);
  assert.equal(report.withAnExit, report.examined, "every rule that was read named an exit");
  assert.equal(
    report.surface + report.authority + report.permanent,
    report.withAnExit,
    "each exit is exactly one kind, so the four numbers describe one population",
  );
  assert.match(
    stdout,
    /with an exit \d+ · surface \d+ · authority \d+ · permanent \d+ · unowned \d+/u,
    "the census is printed, not only carried in the report",
  );
});

test("an unreadable conduct is blocked, and the CLI never calls it green", async () => {
  const floor = REAL_FLOOR.replace(
    "const GAME_SURFACE_INTERACTION_CONDUCT = [",
    "const GAME_SURFACE_INTERACTION_CONDUCT_RENAMED = [",
  );
  const reading = await withFixtureRoot({ floor }, (root) => auditConductClasses({ root }));
  assert.equal(reading.status, "blocked", "a population this gate cannot see cannot pass");
  assert.equal(reading.examined, 0);

  await withFixtureRoot({ floor }, (root) => {
    const result = spawnSync(process.execPath, [GATE, "--root", root], { encoding: "utf8" });
    assert.equal(result.status, 2, `the CLI exits 2 when blocked, printed: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /nothing was judged/u);
    return null;
  });
});

test("an empty floor is blocked and says to delete the module, not to pass on nobody", async () => {
  // The stated end state at zero rules. A gate that passed on an empty population would agree with itself, so the empty
  // floor is the one read that is never green: it BLOCKS and its message says what zero means for this module.
  const floor = rebuild({ ...composedList(REAL_FLOOR), elements: [] });
  assert.notEqual(floor, REAL_FLOOR, "the fixture must really empty the composed list");
  const reading = await withFixtureRoot({ floor }, (root) => auditConductClasses({ root }));
  assert.equal(reading.status, "blocked", "zero rules is blocked, never green");
  assert.equal(reading.examined, 0);
  assert.match(reading.unreadable.join("\n"), /declares no rule: the Game floor is empty/u);
  assert.match(reading.unreadable.join("\n"), /delete the floor and its tables/u);
  await withFixtureRoot({ floor }, (root) => {
    const { status, report } = cliReport(root);
    assert.equal(status, 2, "a blocked reading exits 2");
    assert.deepEqual(
      report.checks.map((check) => check.status),
      report.checks.map(() => "blocked"),
      "nothing was judged, so no rule may claim to have passed over it",
    );
    return null;
  });
});

test("a list no longer written one rule per line is blocked, not silently mis-read", async () => {
  // The reader's premise is the file's own doc (one element per line). An element split across two lines is a shape this
  // gate cannot read, and reporting a shorter population would hide whatever the floor now contains. The element is the
  // first reference in the list itself: this case used to name `partner_words_first`, which left in af080cb6.
  const element = composedList(REAL_FLOOR).elements.find((line) => line.trim().endsWith(".text,"));
  assert.ok(element !== undefined, "the composed list carries no rule reference to split across two lines");
  const floor = REAL_FLOOR.replace(element, element.replace(/\.text,$/u, "\n  .text,"));
  assert.notEqual(floor, REAL_FLOOR, "the fixture must really split an element across two lines");
  const reading = await withFixtureRoot({ floor }, (root) => auditConductClasses({ root }));
  assert.equal(reading.status, "blocked");
  assert.match(reading.unreadable.join("\n"), /does not end in a comma/u);
});
