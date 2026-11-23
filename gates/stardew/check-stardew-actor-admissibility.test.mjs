import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { dispositionMint, mintedKinds, namedFindings, publishFindings, transientFactory } from "../../tools/lib/stardew-disposition-mint.mjs";

/**
 * THE READER'S OWN PROOF, because two files re-read the same mint and a disagreement between them is silent.
 *
 * The first test is the tree's reading: the contract's fifteen rows resolve to real mints and the census says which
 * producer carries each. The rest are violations injected into the contract and into `WorldModel`'s own text, so a
 * mint form, a kind, a word or a branch that moves fails loudly and by name instead of quietly re-pointing a row.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORLD_MODEL = "integrations/stardew/WorldModel.cs";
const CONTRACT = "integrations/stardew/action-development/contracts/actor-admissibility/actor-admissibility.v1.json";

const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");
const worldModel = read(WORLD_MODEL);
const contract = () => JSON.parse(read(CONTRACT));

/** The contract with one fact row mutated, so a single claim can be made wrong at a time. */
function contractWith(fact, mutate) {
  const document = contract();
  mutate(document.facts.find((entry) => entry.fact === fact));
  return document;
}

const findings = (facts, source = worldModel) =>
  publishFindings({ where: WORLD_MODEL, worldModel: source, facts });

/**
 * The fact each finding names. The falsifiers below expect the row they made wrong BACK BY NAME: `rows.length === 1`
 * passes and says nothing about WHICH row came back, so a reader that reported another fact would still read one.
 */
const factsNamed = (rows) => rows.map((row) => row.split(":")[0]);

/** The one fact each falsifier below makes wrong, spelled once so the mutation and the expectation cannot disagree. */
const FREEZE_PAUSED = "FreezePaused";

test("the_two_mint_forms_resolve_to_their_own_producer", () => {
  // A classifier shaped like the Mod's: one factory over ActorTransientKind, one spelling of each word.
  const source = [
    "internal static class WorldModel",
    "{",
    "    private static ActorDisposition Transient(ActorTransientKind kind) =>",
    "        new(ActorDispositionKind.Transient, null, false, KindForWire(kind));",
    "",
    "    internal static string KindForWire(ActorTransientKind kind) => kind switch",
    "    {",
    '        ActorTransientKind.Warping => "warping",',
    "    };",
    "}",
  ].join("\n");
  const factory = transientFactory(source);
  assert.equal(factory.name, "Transient", "the factory is found by its own declaration, not by a name in a table");
  assert.equal(factory.kind, "Transient", "and the kind it mints is read out of its body");
  const inline = "return new ActorDisposition(ActorDispositionKind.Event, null, false, null);";
  const { end, ...inlineMint } = dispositionMint(inline, 0, factory);
  assert.deepEqual(
    inlineMint,
    { producer: "Classify", kind: "Event", transientKind: null, unwordedMember: null },
    "an inline mint states its own kind and carries no transient word",
  );
  assert.equal(inline[end], ")", "and the walk resumes at its closing bracket");
  const viaFactory = dispositionMint("return Transient(ActorTransientKind.Warping);", 0, factory);
  assert.deepEqual(
    { ...viaFactory, end: undefined },
    { producer: "Transient", kind: "Transient", transientKind: "warping", unwordedMember: null, end: undefined },
    "a factory mint takes its kind from the factory and its word from KindForWire",
  );
  assert.equal(
    dispositionMint("return FreezeDisposition();", 0, factory),
    null,
    "a third form is not silently accepted - the row that cites it is refused instead",
  );
});

test("the_shipped_contract_agrees_with_the_classifier_and_the_census_names_each_producer", () => {
  const { rows, census } = findings(contract().facts);
  console.log(`FACT-2 ${census}`);
  assert.deepEqual(rows, [], "every row cites a line that mints the disposition the row claims");
  assert.equal(
    census,
    "Classify 8 · Transient 7",
    "eight branches mint inline and the seven transient facts mint through the factory - the split FACT-3 rests on",
  );
});

test("falsifier: a row citing a line that mints nothing is refused, and the line it read is quoted", () => {
  const settleArm =
    worldModel.split("\n").findIndex((line) => line.trim() === "ActorTransientKind.FreezePause => FreezePauseSettleWindowMs,") +
    1;
  const { rows } = findings(contractWith(FREEZE_PAUSED, (row) => (row.classifyAt.line = settleArm)).facts);
  console.log(rows.join("\n"));
  assert.deepEqual(factsNamed(rows), [FREEZE_PAUSED], "one wrong citation is one finding, named by the row it refutes");
  assert.match(rows[0], /^FreezePaused: classifyAt integrations\/stardew\/WorldModel\.cs:\d+ mints no disposition/u);
  assert.match(rows[0], /ActorTransientKind\.FreezePause => FreezePauseSettleWindowMs,/u, "the line it read is quoted");
  assert.match(rows[0], /return new ActorDisposition\(\.\.\.\)/u, "and the forms it looked for are named");
});

test("falsifier: a row claiming a kind the mint does not carry is named with both", () => {
  const { rows } = findings(contractWith(FREEZE_PAUSED, (row) => (row.publishes.kind = "Event")).facts);
  assert.deepEqual(factsNamed(rows), [FREEZE_PAUSED]);
  assert.match(rows[0], /^FreezePaused: Transient mints Transient at .*WorldModel\.cs:\d+, the contract says Event/u);
});

test("falsifier: a row whose transient word is not the one KindForWire spells is named with both", () => {
  const { rows } = findings(contractWith(FREEZE_PAUSED, (row) => (row.publishes.transientKind = "eating")).facts);
  assert.deepEqual(factsNamed(rows), [FREEZE_PAUSED]);
  assert.match(rows[0], /^FreezePaused: .*WorldModel\.cs:\d+ publishes freezePause, the contract says eating/u);
});

test("falsifier: a factory naming a member KindForWire has no word for fails by that member's name", () => {
  // The arm is BLANKED rather than deleted: a deletion would shift every later line and every row would fail for the
  // shift instead of the missing word, which is a different finding.
  const arm = '        ActorTransientKind.Eating => "eating",\n';
  const source = worldModel.replace(arm, `${" ".repeat(arm.length - 1)}\n`);
  assert.notEqual(source, worldModel, "the arm was there to remove");
  const { rows } = findings(contract().facts, source);
  console.log(rows.join("\n"));
  assert.ok(
    rows.some((row) => /^Eating: .*WorldModel\.cs:\d+ names ActorTransientKind\.Eating, which KindForWire has no word for/u.test(row)),
    "the member with no word is named rather than dropped",
  );
});

test("falsifier: a branch that mints through a producer this reader does not know is refused by name", () => {
  const source = worldModel.replace(
    "return Transient(ActorTransientKind.FreezePause);",
    "return FreezeDisposition();",
  );
  assert.notEqual(source, worldModel, "the branch was there to replace");
  const { rows } = findings(contract().facts, source);
  console.log(rows.join("\n"));
  assert.deepEqual(factsNamed(rows), [FREEZE_PAUSED]);
  assert.match(rows[0], /^FreezePaused: classifyAt .*WorldModel\.cs:\d+ mints no disposition - it reads "return FreezeDisposition\(\);"/u);
});

test("FACT-3's population: every kind the classifier mints is one a row publishes, and Transient is one of them", () => {
  const kinds = mintedKinds(worldModel);
  console.log(`minted kinds ${kinds.join(" · ")}`);
  assert.deepEqual([...kinds].sort(), ["Event", "Modal", "PassOut", "Transient"]);
  assert.deepEqual(
    namedFindings({ kinds, facts: contract().facts, holdReasons: contract().holdReasons }),
    [],
    "the shipped contract names every kind the classifier mints",
  );
});

test("falsifier: an Idle row carrying a hold code is refused, because a body nobody holds has no hold", () => {
  const document = contract();
  document.holdReasons.find((entry) => entry.kind === "Idle").reasonCode = "player_busy_probe";
  const rows = namedFindings({
    kinds: mintedKinds(worldModel),
    facts: document.facts,
    holdReasons: document.holdReasons,
  });
  console.log(rows.join("\n"));
  assert.deepEqual(rows, ["Idle carries player_busy_probe; a body that is not held must not carry a hold code"]);
});

test("falsifier: a kind the classifier mints that no row publishes is named, and its hold with it", () => {
  const document = contract();
  const facts = document.facts.filter((fact) => fact.publishes.kind !== "Transient");
  const holdReasons = document.holdReasons.map((entry) =>
    entry.kind === "Transient" ? { ...entry, publishedBy: [] } : entry,
  );
  const rows = namedFindings({ kinds: mintedKinds(worldModel), facts, holdReasons });
  console.log(rows.join("\n"));
  assert.deepEqual(rows, [
    "Transient is returned by Classify and published by no fact",
    "Transient is published by no fact, so nothing can name it",
  ]);
});

// red-proof: inject  a row moved onto the `SettleWindowMs` arm -> `FreezePaused: classifyAt ...:N mints no disposition
//   - it reads "ActorTransientKind.FreezePause => FreezePauseSettleWindowMs,", not \`return new ActorDisposition(...)\``;
//   a row claiming `Event` for a `Transient` branch -> `FreezePaused: Transient mints Transient at ...:N, the contract
//   says Event`; a row claiming the word `eating` for the freeze branch -> `...:N publishes freezePause, the contract
//   says eating`; `KindForWire`'s `ActorTransientKind.Eating` arm deleted -> `Eating: ...:N names
//   ActorTransientKind.Eating, which KindForWire has no word for`; a branch minting through `FreezeDisposition()` ->
//   `FreezePaused: classifyAt ...:N mints no disposition - it reads "return FreezeDisposition();"`; the `Idle` row given
//   a code the Mod never mints (`player_busy_probe`) -> `Idle carries player_busy_probe; a body that is not held must
//   not carry a hold code`; every `Transient` row removed -> `Transient is returned by Classify and published by no
//   fact` beside `Transient is published by no fact, so nothing can name it`
//   (gates/stardew/check-stardew-actor-admissibility.test.mjs)
