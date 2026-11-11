import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { auditConductClasses, CONDUCT_OWNERS, CONDUCT_SOURCE } from "./check-game-surface-conduct-classes.mjs";

// red-proof: inject  restoring the deleted "Speak before you act" rule to the floor's list AND classifying it FORM ->
//            `floor_governs_form:speak_before_acting:host/src/game-surface-prompt-floor.ts`
//            (see "a form rule put back in the floor is named" below).
//
// Also injected, each seen red once (this file): a rule appended with no class, a Stardew rule removed from the floor
// while its class stays behind, a class outside the three kinds, a class with no reason, a composed name no module
// declares, a renamed declaration (blocked, exit 2 - never green), and a list whose elements are no longer one string
// literal per line (blocked, because a reader that mis-parsed the floor and passed would be worse than no gate).
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

const RULES_CLOSE = '].join("\\n");';
const FLOOR_TABLE_CLOSE = "\n]);";
const REMOVED_RULE =
  '"Speak before you act: when responding to your partner or deciding to take an action, always deliver a spoken ' +
  "remark to your partner first in the same reply before calling any action or planning tool. Never run tools in total " +
  "silence when your partner has spoken to you or when beginning a stretch of work. Never claim work is already " +
  'finished before the tool has run; speak your immediate intent or acknowledgment, then invoke the tool.",';
const FORM_ENTRY =
  '{\n    id: "speak_before_acting",\n    class: "FORM",\n    reason: "a spoken remark before every tool call decides the turn\'s shape for the card.",\n  },';

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

/** The floor with one element appended to the composed list, and nothing added to either table. */
const withFloorElement = (source, element) => source.replace(RULES_CLOSE, `  ${element}\n${RULES_CLOSE}`);

/** The floor with one brace-delimited entry appended to its own class table. */
const withFloorClass = (source, entry) => source.replace(FLOOR_TABLE_CLOSE, `  ${entry}${FLOOR_TABLE_CLOSE}`);

test("every composed rule carries a class from its owner, and none of them governs form", () => {
  const reading = auditConductClasses({ root: REPOSITORY_ROOT });
  assert.deepEqual(codes(reading), [], "the tree's own conduct is fully classified");
  assert.ok(reading.examined >= 15, `examined ${String(reading.examined)} rules, too few to be the floor's own list`);
  assert.equal(
    reading.classes.FLOOR + reading.classes.CHANNEL + reading.classes.FORM,
    reading.examined,
    "each rule is exactly one class, so the four numbers describe one population",
  );
  assert.equal(reading.classes.FORM, 0, "a form rule in the floor is the defect this gate exists for");
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

test("a form rule put back in the floor is named with the module that carries it", async () => {
  const floor = withFloorClass(withFloorElement(REAL_FLOOR, REMOVED_RULE), FORM_ENTRY);
  const reading = await withFixtureRoot({ floor }, (root) => auditConductClasses({ root }));
  assert.deepEqual(
    codes(reading),
    [`floor_governs_form:speak_before_acting:${FLOOR_MODULE}`],
    "exactly the rule that governs form, named by its id and the module holding it",
  );
  assert.equal(reading.status, "failed");
  assert.match(reading.violations[0].detail, /the card owns that: delete the rule rather than classifying it/u);
});

test("a rule added without a class is named by its position in the floor and its first words", async () => {
  const reading = await withFixtureRoot({ floor: withFloorElement(REAL_FLOOR, REMOVED_RULE) }, (root) =>
    auditConductClasses({ root }),
  );
  assert.deepEqual(
    codes(reading),
    ["conduct_rule_without_a_class:19:Speak before you act: when"],
    "the floor grew a rule and its module's table did not, so the gate says which position and which words",
  );
});

test("a Stardew rule taken out of the floor leaves its class behind, and that is stale rather than harmless", async () => {
  // The anchor is the composed element AND the line that follows it: the name also appears once in this module's import
  // list, and a fixture that removed that occurrence instead would be testing the import sorter.
  const floor = REAL_FLOOR.replace(
    '  CONTENT_IDS_IN_WORDS,\n  "When something blocks you',
    '  "When something blocks you',
  );
  assert.notEqual(floor, REAL_FLOOR, "the fixture must really drop the element, or it proves nothing");
  const reading = await withFixtureRoot({ floor }, (root) => auditConductClasses({ root }));
  assert.deepEqual(codes(reading), ["stale_conduct_class:content_ids_in_words"]);
  assert.match(reading.violations[0].detail, /removing a rule must remove its class entry/u);
});

test("a name the floor composes but no module declares is unowned, not silently skipped", async () => {
  const reading = await withFixtureRoot({ floor: withFloorElement(REAL_FLOOR, "GHOST_RULE,") }, (root) =>
    auditConductClasses({ root }),
  );
  assert.deepEqual(codes(reading), ["conduct_rule_unowned:19:GHOST_RULE"]);
});

test("a class outside the three kinds is a finding, not a fourth kind", async () => {
  // `class: "FLOOR"` alone also matches the table's own TypeScript type, so the anchor carries an entry's own reason.
  const floor = REAL_FLOOR.replace(
    'class: "FLOOR",\n    reason: "the person before the work',
    'class: "STYLE",\n    reason: "the person before the work',
  );
  assert.notEqual(floor, REAL_FLOOR, "the fixture must really change an entry's class");
  const reading = await withFixtureRoot({ floor }, (root) => auditConductClasses({ root }));
  assert.deepEqual(codes(reading), ["conduct_class_unknown:partner_words_first"]);
  assert.match(reading.violations[0].detail, /is not one of FLOOR \/ CHANNEL \/ FORM/u);
});

test("a class with no reason is a label nobody argued for", async () => {
  const floor = REAL_FLOOR.replace(/reason: "the person before the work[^"]*",/u, 'reason: "",');
  const reading = await withFixtureRoot({ floor }, (root) => auditConductClasses({ root }));
  assert.deepEqual(codes(reading), ["conduct_class_without_reason:partner_words_first"]);
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

test("a list no longer written one rule per line is blocked, not silently mis-read", async () => {
  // The reader's premise is the file's own doc (one element per line). A rule split across two lines is a shape this
  // gate cannot read, and reporting a shorter population would hide whatever the floor now contains.
  const floor = REAL_FLOOR.replace(
    "  'Speak to your partner, not about yourself,",
    "  'Speak to your partner,\n  not about yourself,",
  );
  assert.notEqual(floor, REAL_FLOOR, "the fixture must really split a rule across two lines");
  const reading = await withFixtureRoot({ floor }, (root) => auditConductClasses({ root }));
  assert.equal(reading.status, "blocked");
  assert.match(reading.unreadable.join("\n"), /is neither a string literal nor a rule name/u);
});
