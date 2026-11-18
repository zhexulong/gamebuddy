/**
 * The falsifier suite for `tools/check-description-plan-vocabulary.mjs`.
 *
 * Every case is an INJECTION into a copy of the real source or the real wire schema, because the defect this gate exists
 * for is a sentence that was written and shipped: two descriptions taught `for_each`'s filter for months after the
 * compiler stopped accepting the form, and a text that is present in this tree cannot be made present twice by
 * describing it. The population cases inject a description the tree does not have, which is the claim that matters -
 * the set is the declaration's, so a tool nobody has written yet arrives examined.
 *
 * red-proof: inject  the `occupantKind` sentence as it shipped - "What stands on this tile in the words a `for_each`
 *   `where: [{ occupant: ... }]` filter and an action's `Clears` declaration use" - into
 *   `protocol/bridge-v1.schema.json` -> `descriptions examined 193 · refused vocabulary 27`, two findings at
 *   `#/$defs/tileAreaRow/properties/occupantKind/description`, naming `for_each` and `where`, failed, exit 1 - the reading
 *   that shipped is the reading that reds
 * red-proof: inject  the `stardew_observe` clause as it shipped - "the very words a for_each `where: [{ occupant: ... }]`
 *   filter takes" - into the tool's own description -> the same two words refused, and the member names the TOOL rather
 *   than the file, so a reader is sent to the text she reads
 * red-proof: inject  `for_each` alone into `planWorkDescription`'s body -> refused through the call that builds
 *   `stardew_plan_work`'s description, so the text a planning turn holds is inside the population even though it is not a
 *   literal at the `description:` key
 * red-proof: inject  `where: [{ occupant: 3 }]` with no form id beside it -> `where` alone is named: the vocabulary is a
 *   set of words, not a list of sentences somebody thought of
 * red-proof: inject  `It takes NO arguments: ...` into a description -> green, because `arguments:` in prose is not
 *   `` `arguments` `` in a call; the position rule is what keeps the gate from banning English
 * red-proof: inject  `FarmhandPlanFormCatalog`'s `ForEachActionId` removed -> `refused_vocabulary_empty:plan_form_id`,
 *   blocked: the words are gone and an empty vocabulary must not agree with every description
 * red-proof: inject  `for_each` added to `action-surface.v1.json` -> `refused_form_is_published:for_each`, blocked, and no
 *   per-description finding: the word is accepted now, so the sentences naming it are no longer this gate's subject
 * red-proof: inject  `"for_each"` into the compiler's `PLAN_FORM_ACTION_IDS` -> `form_declared_by_the_compiler:for_each`,
 *   blocked: a declared form must be taught, which is the other direction
 * red-proof: inject  `plan_script_uses_forbidden` renamed in the compiler -> `refusal_code_unanchored`, blocked, so the
 *   vocabulary is never judged against a refusal nothing produces
 * red-proof: inject  the observation tool's `name: "stardew_observe"` renamed -> `description_population_unanchored`,
 *   blocked, so the population cannot silently stop covering the sentence this gate was built for
 * red-proof: inject  the plan tool's `description: planWorkDescription(` pointed at an undeclared function ->
 *   `description_place_unreadable`, blocked, so a description this reading cannot reach is named instead of skipped
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkDescriptionPlanVocabulary,
  hostDescriptionPlaces,
  namesWord,
  refusedVocabulary,
  renderReport,
  RULES,
  wordPosition,
} from "./check-description-plan-vocabulary.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");

const COMPILER = "host/src/body-program-script.ts";
const PREFLIGHT = "host/src/body-program-preflight.ts";
const GAME_TOOLS = "host/src/game-tools.ts";
const MATERIALIZER =
  "host/src/continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.ts";
const SCHEMA = "protocol/bridge-v1.schema.json";
const ACTION_SURFACE = "integrations/stardew/action-development/contracts/generated/action-surface.v1.json";
const FORM_CATALOG = "integrations/stardew/src/Core/Policy/FarmhandPlanFormCatalog.cs";
const FORM_ARGUMENTS = "integrations/stardew/src/Core/Policy/FarmhandForEachArguments.cs";

/** The `occupantKind` sentence as it shipped, before the product deleted the form it taught. */
const SHIPPED_OCCUPANT_KIND =
  "What stands on this tile in the words a `for_each` `where: [{ occupant: ... }]` filter and an action's `Clears` " +
  "declaration use - `TileOccupancy.Of`, the same function the pass's own row reads: weed, stone, crop, grass, tree, " +
  "tree_stump, a resource clump's own name, object, terrain, or `none`.";

/** The `stardew_observe` clause as it shipped. */
const SHIPPED_OBSERVE_CLAUSE =
  "occupantKind (what stands there in the very words a for_each `where: [{ occupant: ... }]` filter takes, so a row can " +
  "be filtered with the same word a loop is written in)";

const check = (overrides = {}) => checkDescriptionPlanVocabulary({ overrides });

/** A finding's identity without the line, because an injection above it moves every line below. */
function sites(result) {
  return codes(result)
    .map((code) => code.replace(/(:\d+)(?=:)/u, ":<line>"))
    .sort();
}

const codes = (result) => result.findings.map((finding) => `${finding.code}:${finding.member}`);
const reportOf = (result) => JSON.parse(renderReport(result).lines.at(-1));

/** The wire schema with one member's description replaced, as a JSON text the gate reads instead of the file. */
function schemaWith(pointer, description) {
  const schema = JSON.parse(read(SCHEMA));
  const parts = pointer.replace(/^#?\//u, "").split("/");
  let node = schema;
  for (const part of parts) node = node[part];
  node.description = description;
  return JSON.stringify(schema);
}

test("the real tree: no description teaches a form or a vocabulary the compiler refuses", () => {
  const result = check();
  assert.deepEqual(codes(result), [], "no description names a refused word");
  assert.equal(result.status, "passed");
  assert.ok(result.examined.descriptions > 100, `the population is ${String(result.examined.descriptions)} descriptions`);
  assert.ok(
    result.examined.refusedVocabulary > 0,
    "the vocabulary is non-empty, so the pass is a reading rather than an empty set agreeing with itself",
  );
  assert.match(renderReport(result).lines[0], /^descriptions examined \d+ · refused vocabulary \d+$/u);
});

test("the population covers the two sentences this gate was built for", () => {
  const result = check();
  const host = hostDescriptionPlaces(
    ["host/src/game-tools.ts", "host/src/body-program-script.ts"].map((file) => [file, read(file)]),
  );
  assert.ok(
    host.places.some((place) => place.tool === "stardew_observe"),
    "the observation tool's description is a place, attributed to the tool rather than to a line",
  );
  const schema = check().examined.schemaDescriptions;
  assert.ok(schema > 30, `the wire schema contributed ${String(schema)} descriptions`);
  assert.ok(
    result.findings.every((finding) => !finding.code.includes("unanchored")),
    "both anchors resolved",
  );
});

test("the schema sentence that shipped is refused, by site and by word", () => {
  const result = check({ [SCHEMA]: schemaWith("/$defs/tileAreaRow/properties/occupantKind", SHIPPED_OCCUPANT_KIND) });
  assert.equal(result.status, "failed");
  assert.deepEqual(sites(result), [
    `a_description_teaches_a_form_the_compiler_does_not_accept:#/$defs/tileAreaRow/properties/occupantKind/description:for_each`,
    `a_description_teaches_a_form_the_compiler_does_not_accept:#/$defs/tileAreaRow/properties/occupantKind/description:where`,
  ].sort());
});

test("the observe clause that shipped is refused at the tool, not at the file", () => {
  const source = read(GAME_TOOLS);
  const needle = "occupantKind (what stands there";
  assert.notEqual(source.indexOf(needle), -1, "the observation tool no longer describes occupantKind in this shape");
  const injected = source.replace(
    /occupantKind \(what stands there[^)]*\)/u,
    `${SHIPPED_OBSERVE_CLAUSE}, so the word that names what removes a tile is the word the row carries)`,
  );
  const result = check({ [GAME_TOOLS]: injected });
  assert.deepEqual(sites(result), [
    "a_description_teaches_a_form_the_compiler_does_not_accept:host/src/game-tools.ts:<line>:for_each",
    "a_description_teaches_a_form_the_compiler_does_not_accept:host/src/game-tools.ts:<line>:where",
  ]);
  const detail = result.findings[0].detail;
  assert.match(detail, /`stardew_observe`'s description/u, "the finding names the text the model reads");
});

test("the planner's guidance is read through the call that builds it", () => {
  const source = read(COMPILER);
  const needle = "Stop when builder.isFull() is true";
  assert.notEqual(source.indexOf(needle), -1, "the planner's guidance no longer carries this sentence");
  const injected = source.replace(needle, "A batch is for_each({ source }) over a family. " + needle);
  const result = check({ [COMPILER]: injected });
  const members = sites(result).filter((code) => code.includes("for_each"));
  assert.deepEqual(members, [
    "a_description_teaches_a_form_the_compiler_does_not_accept:host/src/continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.ts:<line>:for_each",
  ]);
  assert.match(result.findings[0].detail, /`stardew_plan_work`'s description/u);
  // The word appears in a COMMENT above the guidance too, and a comment is not a description.
  assert.equal(
    check({ [COMPILER]: source.replace("The words `source`, `where`, `row`", "Nothing to see here:") }).findings.length,
    0,
    "a comment naming the removed words is not a description teaching them",
  );
});

test("a document key alone is refused with no form id beside it", () => {
  const source = read(GAME_TOOLS);
  const injected = source.replace(
    "A rectangle has a SIZE limit",
    "A condition looks like `where: [{ x: 3 }]`. A rectangle has a SIZE limit",
  );
  const result = check({ [GAME_TOOLS]: injected });
  assert.deepEqual(sites(result), [
    "a_description_teaches_a_form_the_compiler_does_not_accept:host/src/game-tools.ts:<line>:where",
  ]);
});

test("a word in prose is not a call: the position rule is what keeps English out", () => {
  const source = read(GAME_TOOLS);
  const prose = source.replace(
    "A rectangle has a SIZE limit",
    "It takes NO arguments: nothing to choose and nothing to name. A rectangle has a SIZE limit",
  );
  assert.deepEqual(codes(check({ [GAME_TOOLS]: prose })), [], "`arguments:` in prose is not `` `arguments` `` in a call");
  const call = source.replace(
    "A rectangle has a SIZE limit",
    "There is no `arguments` here. A rectangle has a SIZE limit",
  );
  assert.deepEqual(sites(check({ [GAME_TOOLS]: call })), [
    "a_description_teaches_a_form_the_compiler_does_not_accept:host/src/game-tools.ts:<line>:arguments",
  ]);
  assert.equal(wordPosition("for_each"), "anywhere", "a word no sentence spells is matched wherever it stands");
  assert.equal(wordPosition("where"), "code", "an ordinary word is matched only where the description marks it as code");
  assert.ok(namesWord("a `for_each` filter", { word: "for_each", source: "plan_form_id" }));
  assert.ok(namesWord("`source.family`", { word: "for_each", source: "plan_form_id" }) === false);
});

test("the vocabulary is derived from the refusals, and named with the code each produces", () => {
  const vocabulary = refusedVocabulary({
    compilerSource: read(COMPILER),
    preflightSource: read(PREFLIGHT),
    formCatalogSource: read(FORM_CATALOG),
    formArgumentsSource: read(FORM_ARGUMENTS),
    actionIds: new Set(
      JSON.parse(read(ACTION_SURFACE)).actions.map((action) => action.actionId),
    ),
  });
  const of = (word) => vocabulary.words.find((entry) => entry.word === word);
  assert.equal(of("for_each")?.code, "plan_script_unknown_action");
  assert.equal(of("where")?.code, "plan_form_not_declared");
  assert.equal(of("loop")?.code, "plan_form_not_declared");
  assert.equal(of("Math.random")?.code, "plan_script_uses_forbidden");
  assert.deepEqual(vocabulary.sources.declaredForms, [], "the compiler declares no plan form");
  assert.deepEqual(vocabulary.problems, []);
});

test("a form the Mod stops declaring leaves no vocabulary, and an empty vocabulary is blocked", () => {
  const result = check({
    [FORM_CATALOG]: read(FORM_CATALOG).replace('public const string ForEachActionId = "for_each";', ""),
  });
  assert.equal(result.status, "blocked");
  assert.ok(codes(result).includes("refused_vocabulary_empty:plan_form_id"), codes(result).join(" · "));
});

test("a form the action surface publishes is no longer refused, and the premise drift is named", () => {
  const surface = JSON.parse(read(ACTION_SURFACE));
  surface.actions.push({ ...surface.actions[0], actionId: "for_each" });
  const result = check({ [ACTION_SURFACE]: JSON.stringify(surface) });
  assert.equal(result.status, "blocked");
  assert.ok(codes(result).includes("refused_form_is_published:for_each"), codes(result).join(" · "));
  assert.deepEqual(result.refused, [], "and no description is accused of a word nothing refuses any more");
});

test("a form the compiler declares must be taught, not banned", () => {
  const result = check({
    [COMPILER]: read(COMPILER).replace(
      "export const PLAN_FORM_ACTION_IDS: readonly string[] = Object.freeze([]);",
      'export const PLAN_FORM_ACTION_IDS: readonly string[] = Object.freeze(["for_each"]);',
    ),
  });
  assert.equal(result.status, "blocked");
  assert.ok(codes(result).includes("form_declared_by_the_compiler:for_each"), codes(result).join(" · "));
});

test("a refusal code that moved is blocked, never judged against nothing", () => {
  const result = check({
    [COMPILER]: read(COMPILER).replaceAll("plan_script_uses_forbidden", "plan_script_forbidden_v2"),
  });
  assert.equal(result.status, "blocked");
  assert.ok(codes(result).includes("refusal_code_unanchored:plan_script_uses_forbidden"), codes(result).join(" · "));
});

test("the observation tool leaving the declaration unanchors the population", () => {
  const result = check({
    [GAME_TOOLS]: read(GAME_TOOLS).replace('name: "stardew_observe"', 'name: "stardew_observe_tiles"'),
  });
  assert.equal(result.status, "blocked");
  assert.ok(codes(result).includes("description_population_unanchored:stardew_observe"), codes(result).join(" · "));
});

test("a description built by a function this tree does not declare is named, not skipped", () => {
  const result = check({
    [MATERIALIZER]: read(MATERIALIZER).replace("description: planWorkDescription(", "description: planWorkText("),
  });
  assert.equal(result.status, "blocked");
  assert.ok(
    codes(result).some((code) => code.startsWith("description_place_unreadable:")),
    codes(result).join(" · "),
  );
});

test("the report enumerates every rule and carries the verdict the harness reads", () => {
  const report = reportOf(check());
  assert.equal(report.status, "passed");
  assert.deepEqual(
    report.checks.map((entry) => entry.id),
    RULES.map((rule) => rule.id),
    "a passing rule is enumerated beside a failing one, so the report is the gate's capability",
  );
  const failing = reportOf(check({ [SCHEMA]: schemaWith("/$defs/tileAreaRow/properties/occupantKind", SHIPPED_OCCUPANT_KIND) }));
  assert.equal(failing.status, "failed");
  assert.deepEqual(
    failing.checks.filter((entry) => entry.status !== "passed").map((entry) => entry.id),
    ["no_description_teaches_a_refused_form"],
  );
});
