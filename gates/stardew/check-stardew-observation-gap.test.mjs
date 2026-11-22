import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPABILITY_CATALOG,
  DECOMPILED_ROOT,
  REQUIRED_INPUTS,
  chainSteps,
  missingInputs,
  runObservationGap,
} from "./check-stardew-observation-gap.mjs";

/**
 * Falsifiers for the arming of `--fail-on-ungranted`. The claim this file protects is narrow: the observation-gap
 * report is run with the flag that makes an unregistered gap exit 1, and a run that could not measure says so instead
 * of passing. Every case below is one way that claim could be false.
 *
 * The real tree is not measured here - that costs ~21 s and the ladder's L0b rung is where it runs. What is asserted
 * here is the wiring, which is the part that was missing: three grep hits for the flag, all inside the analyzer.
 *
 * red-proof: inject  with `--fail-on-ungranted` removed from the reconciliation step, this suite failed on
 *   "the chain arms --fail-on-ungranted on the reconciliation step, which is the whole point"
 * red-proof: with the failure excerpt cut back to the first 12 lines (the shape before 2026-11-08), this suite failed
 *   on "a failing cause names the findings that failed it" - the run printed "3 undeclared" and cut the two
 *   `mutation_not_observable` lines that were the verdict.
 */

const SUMMARY = [
  "observation gaps: 122 engine collections",
  "  A collections       20 read, 102 never read",
  "  green: every engine collection, tile channel, action target and handler mutation is published or recorded",
  "",
].join("\n");

const okRun = (args, { stdout = "", stderr = "" } = {}) => ({ status: 0, stdout, stderr });

test("the chain arms --fail-on-ungranted on the reconciliation step, which is the whole point", () => {
  const steps = chainSteps({ candidates: "C:/tmp/candidates.json", remaining: "C:/tmp/remaining.json" });
  assert.deepEqual(
    steps.map((step) => step.name),
    ["candidates", "remaining", "observation_gap"],
  );
  const last = steps.at(-1).args;
  assert.ok(last.includes("--fail-on-ungranted"), "the reconciliation step must pass the flag");
  assert.ok(last.includes("--remaining"), "the method-layer tiers only exist in the remaining report");
  assert.ok(last.includes(DECOMPILED_ROOT), "the decompiled tree is the source of every section");
  assert.ok(last.includes(CAPABILITY_CATALOG), "the catalog is a required input of the analyzer's CLI");
  assert.ok(steps[0].args.includes("--action-register"), "the candidates step needs the native seam register");
});

test("the three named inputs are the ones the skip message names", () => {
  assert.deepEqual(
    [...REQUIRED_INPUTS],
    [
      DECOMPILED_ROOT,
      "integrations/stardew/action-development/contracts/generated/native-multiplayer-sensitivity.v1.json",
      CAPABILITY_CATALOG,
    ],
  );
  assert.deepEqual(missingInputs({ exists: () => true }), []);
  assert.deepEqual(missingInputs({ exists: (path) => path === CAPABILITY_CATALOG }), [
    DECOMPILED_ROOT,
    REQUIRED_INPUTS[1],
  ]);
});

test("without the decompiled tree the gate SKIPS with a named reason and runs no step at all", () => {
  let ran = false;
  const result = runObservationGap({
    exists: () => false,
    run: () => {
      ran = true;
      return okRun([]);
    },
  });
  assert.equal(result.status, "skipped");
  assert.equal(ran, false, "an unmeasurable tree must not start a 16 s analysis");
  assert.ok(result.missing.includes(DECOMPILED_ROOT));
});

test("a failing step stops the chain, names the step, and leaves the cause in the gate's own words", () => {
  const removed = [];
  const result = runObservationGap({
    exists: () => true,
    makeTempDir: () => "C:/tmp/observation-gap",
    removeTempDir: (dir) => removed.push(dir),
    run: (args) =>
      args.some((arg) => arg.includes("stardew-remaining-actions-report.mjs"))
        ? { status: 1, stdout: "", stderr: "remaining_report_invalid:missing_tiers\n" }
        : okRun(args),
  });
  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, "remaining");
  assert.match(result.cause, /remaining_report_invalid:missing_tiers/u);
  assert.deepEqual(removed, ["C:/tmp/observation-gap"], "the temp directory is removed on the failing path too");
});

test("a chain that exits 0 without the analyzer's observation summary is a FAILURE, not a pass", () => {
  const result = runObservationGap({
    exists: () => true,
    makeTempDir: () => "C:/tmp/observation-gap",
    removeTempDir: () => {},
    run: (args) =>
      okRun(args, {
        stdout: args.some((arg) => arg.includes("stardew-action-inventory-reconciliation.mjs"))
          ? '{"state":"written"}\n'
          : "",
      }),
  });
  assert.equal(result.status, "failed");
  assert.equal(result.failedStep, "observation_gap");
  assert.match(result.cause, /without printing its observation summary/u);
});

test("a failing cause names the findings that failed it, even when they print after the section lines", () => {
  // The analyzer prints one line per section and then the findings that failed the run, so a head-only excerpt of a
  // failing run reported the section counts and cut the verdict - the reader got "3 undeclared" and no member.
  const stderr = [
    "observation gaps: 122 engine collections",
    ...Array.from({ length: 20 }, (_, index) => `  ${index} section   1 measured, 2 kept`),
    "  mutation_not_observable:collect_crab_pot_output:CurrentToolIndex: collect_crab_pot_output assigns `player.CurrentToolIndex`",
    "  mutation_not_observable:talk_to_npc:CurrentToolIndex: talk_to_npc assigns `Game1.player.CurrentToolIndex`",
    "  2 ungranted observation gap(s)",
    "",
  ].join("\n");
  const result = runObservationGap({
    exists: () => true,
    makeTempDir: () => "C:/tmp/observation-gap",
    removeTempDir: () => {},
    run: (args) =>
      args.some((arg) => arg.includes("stardew-action-inventory-reconciliation.mjs"))
        ? { status: 1, stdout: "", stderr }
        : okRun(args),
  });
  assert.equal(result.status, "failed");
  assert.match(result.cause, /observation gaps: 122 engine collections/u, "the head of the run is still shown");
  assert.match(result.cause, /mutation_not_observable:talk_to_npc:CurrentToolIndex/u, "the verdict names its members");
  assert.match(result.cause, /2 ungranted observation gap\(s\)/u);
  assert.match(result.cause, /line\(s\) omitted/u, "the elision is stated rather than silent");
});

test("a measured run carries the summary the analyzer printed, and every step's exit code", () => {
  const result = runObservationGap({
    exists: () => true,
    makeTempDir: () => "C:/tmp/observation-gap",
    removeTempDir: () => {},
    run: (args) =>
      okRun(args, {
        stderr: args.some((arg) => arg.includes("stardew-action-inventory-reconciliation.mjs")) ? SUMMARY : "",
      }),
  });
  assert.equal(result.status, "measured");
  assert.match(result.summary, /^observation gaps: 122 engine collections/mu);
  assert.deepEqual(
    result.steps.map((step) => [step.name, step.exitCode]),
    [
      ["candidates", 0],
      ["remaining", 0],
      ["observation_gap", 0],
    ],
  );
});

/**
 * Falsifiers for `check-stardew-instance-property-coverage.mjs`, which is the verdict at the level where the drops
 * happen. The claim it protects: a `published` verdict says a row CARRIES a property, and each of the three places that
 * claim can be false is red with the member named. Every case below is driven against the real
 * `protocol/bridge-v1.schema.json` and the real Mod sources - the wire and the builder are the authority, so a fixture
 * would only prove the fixture agrees with itself.
 *
 * red-proof: inject with `cropTargets.isRaised` published for `Crop.raisedSeeds` (the same-spelling coincidence the crop data
 *   carries), `verdict_field_without_witness` named it and pointed at `data?.IsRaised` - the expression the builder
 *   actually passes, which reads the crop DATA and not the instance flag.
 * red-proof: history before the record was resolved by its own field set, `chests.items` was
 *   `verdict_field_not_on_the_mod_record` against `BridgeChest`, `BridgeChestItem` and `BridgeChestsSummary`; the
 *   reading is the record whose fields ARE the wire's fields.
 */
import { readFileSync } from "node:fs";

import { publishedRowFields } from "../../integrations/stardew/action-development/src/analysis/stardew-action-inventory-reconciliation.mjs";
import {
  builderArguments,
  buildChecks,
  instanceCase,
  judgeAbsentVerdict,
  judgePublishedVerdict,
  judgeVerdicts,
  judgeWitness,
  modRecords,
  modSources,
  recordFor,
} from "./check-stardew-instance-property-coverage.mjs";

const schema = JSON.parse(readFileSync(new URL("../../protocol/bridge-v1.schema.json", import.meta.url), "utf8"));
const ROWS = publishedRowFields(schema);
const SOURCES = modSources();
const RECORDS = modRecords(SOURCES.filter((text) => /\brecord\s+Bridge[A-Z]/u.test(text)));

const published = (property, field, witness, entity) => ({
  property: { key: property, entity },
  entry: { verdict: "published", field, witness },
});

test("a published verdict that holds passes all three readers: the wire, the Mod record and the builder", () => {
  const findings = judgePublishedVerdict({
    ...published("Tree.hasMoss", "treeChopSourceTargets.moss", "tree.hasMoss.Value", "Tree"),
    rows: ROWS,
    records: RECORDS,
    declaredEntities: new Map([["Tree", ["treeChopSourceTargets"]]]),
    builders: SOURCES,
  });
  assert.deepEqual(findings, [], "the row declares moss, the record declares Moss and the builder passes tree.hasMoss");
  const record = recordFor(
    RECORDS,
    ROWS.get("treeChopSourceTargets").definition,
    ROWS.get("treeChopSourceTargets").fields,
  );
  assert.ok(
    [...new Set(builderArguments({ sources: SOURCES, record, field: "moss" }).map((found) => found.argument))].includes(
      "tree.hasMoss.Value",
    ),
    "the witness is the builder's own expression, read out of the Mod's source",
  );
});

test("a name coincidence is not a crossing: `cropTargets.isRaised` is filled from the crop DATA, not the instance flag", () => {
  const record = recordFor(RECORDS, ROWS.get("cropTargets").definition, ROWS.get("cropTargets").fields);
  const argumentsFound = builderArguments({ sources: SOURCES, record, field: "isRaised" });
  assert.ok(
    argumentsFound.some((found) => found.argument.includes("data?.IsRaised")),
    "the field is filled from the crop's Data entry",
  );
  const findings = judgeWitness({
    ...published("Crop.raisedSeeds", "cropTargets.isRaised", "crop.raisedSeeds.Value", "Crop"),
    name: "isRaised",
    record,
    builders: SOURCES,
  });
  assert.deepEqual(
    findings.map((finding) => finding.code),
    ["verdict_field_without_witness"],
    "and no construction passes the instance flag there, so the claim is red",
  );
  assert.match(findings[0].detail, /data\?\.IsRaised/u, "the failure shows what the builder does pass");
});

test("a published verdict naming a field the row does not carry is red, with the row's fields named", () => {
  const findings = judgePublishedVerdict({
    ...published("Bush.size", "bushTargets.size", "size", "Bush"),
    rows: ROWS,
    records: RECORDS,
    declaredEntities: new Map([["Bush", ["bushTargets"]]]),
    builders: SOURCES,
  });
  assert.deepEqual(
    findings.map((finding) => finding.code),
    ["verdict_field_not_on_the_wire"],
  );
  assert.match(findings[0].detail, /targetId, location, x, y/u, "the reader sees what the bush row actually carries");
});

test("a field on another entity's row is not this property's row", () => {
  const findings = judgePublishedVerdict({
    ...published("Tree.health", "weedTargets.health", "health", "Tree"),
    rows: ROWS,
    records: RECORDS,
    declaredEntities: new Map([["Tree", ["treeChopSourceTargets"]]]),
    builders: SOURCES,
  });
  assert.ok(
    findings.some((finding) => finding.code === "verdict_field_outside_entity_rows"),
    "weedTargets is a grass row, so a tree's health on it is red even though the field exists",
  );
});

test("an absence expires: a row that now carries the field, and a property the engine no longer declares", () => {
  const expired = judgeAbsentVerdict({
    property: { key: "Grass.grassType" },
    entry: { verdict: "deliberately_absent", reason: "r", expires: "row_field:grassTargets.grassType" },
    rows: ROWS,
  });
  assert.deepEqual(
    expired.map((finding) => finding.code),
    ["absent_entry_expired"],
    "grassTargets carries grassType, so the excuse is over",
  );
  const unexplained = judgeAbsentVerdict({
    property: { key: "Grass.grassSourceOffset" },
    entry: { verdict: "deliberately_absent", expires: "row_field:grassTargets.grassSourceOffset" },
    rows: ROWS,
  });
  assert.deepEqual(
    unexplained.map((finding) => finding.code),
    ["absent_entry_unexplained"],
  );
  const noExpiry = judgeAbsentVerdict({
    property: { key: "Grass.grassSourceOffset" },
    entry: { verdict: "deliberately_absent", reason: "r", expires: "someday" },
    rows: ROWS,
  });
  assert.deepEqual(
    noExpiry.map((finding) => finding.code),
    ["absent_entry_without_expiry"],
    "an expiry this gate does not evaluate is not an expiry",
  );
  const staleTable = judgeVerdicts({
    population: new Map(),
    table: {
      entities: [{ entity: "Grass", families: ["grassTargets"] }],
      verdicts: [{ property: "Grass.retired", verdict: "not_measured" }],
    },
    rows: ROWS,
    records: RECORDS,
    builders: SOURCES,
  });
  assert.deepEqual(
    staleTable.findings.map((finding) => finding.code),
    ["verdict_for_absent_property"],
    "a verdict for a property the engine stopped declaring expires too",
  );
});

test("not_measured is a finding that names an instance case, from run data or from the engine's closed values", () => {
  const property = {
    key: "Furniture.furniture_type",
    entity: "Furniture",
    declaringType: "Furniture",
    member: "furniture_type",
    declared: "NetInt",
    discriminator: [
      { label: "0", name: "chair" },
      { label: "15", name: "bed" },
    ],
  };
  const table = {
    entities: [{ entity: "Furniture", families: ["worldObjectTargets"] }],
    verdicts: [{ property: "Furniture.furniture_type", verdict: "not_measured" }],
  };
  const judged = judgeVerdicts({
    population: new Map([[property.key, property]]),
    table,
    rows: ROWS,
    records: RECORDS,
    builders: SOURCES,
    witnesses: {
      families: new Map([["Furniture", ["worldObjectTargets"]]]),
      tiles: new Map([["worldObjectTargets", { x: 6, y: 6 }]]),
    },
  });
  assert.deepEqual(
    judged.findings.map((finding) => finding.code),
    ["property_not_published"],
  );
  assert.equal(
    judged.findings[0].detail,
    "the Furniture at (6,6) has no row carrying furniture_type",
    "with run data the finding names the bed's tile, not a line number",
  );
  assert.equal(
    instanceCase(property),
    "a Furniture whose furniture_type is chair (Furniture.chair = 0)",
    "and without run data it names an instance the engine's own closed value set defines",
  );
});

test("an empty population is blocked rather than green", () => {
  const checks = buildChecks({
    properties: new Map(),
    typesExamined: 0,
    basesExamined: 0,
    undeclaredTypes: [],
    counts: { published: 0, deliberately_absent: 0, not_measured: 0 },
    findings: [],
  });
  assert.equal(checks[0].id, "population_derived");
  assert.equal(checks[0].status, "blocked", "zero properties is a measurement that did not happen");
});
