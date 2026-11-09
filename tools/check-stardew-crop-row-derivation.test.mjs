// Tests for the crop-row derivation gate.
//
// The mutations run against the REAL sources, copied in memory and edited, so a passing suite proves the checker is
// decisive: the field this change exists for, removed from the row, must be named as the finding.
//
// red-proof: inject  one shared field removed in memory (`bool? IsRaised` deleted from the row) -> the real checker's
//   `not_reachable:isRaised` and three `wire_extra:isRaised`, verdict `blocked`, asserted by "one shared field
//   removed" below (tools/check-stardew-crop-row-derivation.test.mjs)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkStardewCropRowDerivation,
  extractProtocolRowFields,
  extractWorkerCropRowFields,
  REACHABILITY_EXEMPTIONS,
} from "./check-stardew-crop-row-derivation.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceOf = (relativePath) => readFileSync(path.join(root, relativePath), "utf8");

const BRIDGE_MODELS_PATH = "integrations/stardew/src/Core/Models/BridgeProtocolModels.cs";
const CONTENT_DATA_PATH = "integrations/stardew/ContentDataQuery.cs";
const EXECUTION_CONTROLLER_PATH = "integrations/stardew/farmhandexecutioncontroller.cs";
const PROTOCOL_PATH = "host/src/protocol.ts";
const VALIDATOR_PATH = "host/src/protocol-target-facts.ts";
const DEPLOYED_VALIDATOR_PATH = "host/dist-test/protocol-target-facts.js";
const SCHEMA_PATH = "protocol/bridge-v1.schema.json";

/** The tree as it is, with one source replaced by an in-memory edit. */
const withEdit = (relativePath, edit) => ({ [relativePath]: edit(sourceOf(relativePath)) });

const codes = (report) => report.findings.map((finding) => `${finding.code}:${finding.member}`);

test("the two populations are read from source, and every worker field is reachable or reasoned", () => {
  const report = checkStardewCropRowDerivation();
  assert.equal(report.verdict, "passed", JSON.stringify(report.findings));
  assert.deepEqual(report.examined, {
    workerFields: 13,
    snapshotFields: 15,
    shared: 5,
    exempted: 8,
  });
  assert.deepEqual(report.workerFields.length, 13);
  assert.ok(report.snapshotFields.includes("tileBlockedNow"));
});

test("one shared field removed from the row is named, not averaged away", () => {
  const report = checkStardewCropRowDerivation({
    overrides: withEdit(BRIDGE_MODELS_PATH, (source) => source.replace(/[^\n]*bool\? IsRaised,\n/u, "")),
  });
  assert.equal(report.verdict, "blocked");
  assert.ok(
    codes(report).includes("not_reachable:isRaised"),
    `the finding must name the field: ${codes(report).join(", ")}`,
  );
  // And the three Host copies of the same contract notice it from the other side, each by its own name: the Mod stopped
  // publishing a field they still name.
  assert.ok(codes(report).includes("wire_extra:isRaised"));
});

test("a Host layer naming a field the Mod does not publish is red in the other direction", () => {
  const report = checkStardewCropRowDerivation({
    overrides: withEdit(VALIDATOR_PATH, (source) =>
      source.replace('      "tileBlockedNow",\n', '      "tileBlockedNow",\n      "isPaddyCrop",\n'),
    ),
  });
  assert.equal(report.verdict, "blocked");
  assert.ok(codes(report).includes("wire_extra:isPaddyCrop"));
});

test("a schema that forgot a published field is red", () => {
  const schema = JSON.parse(sourceOf(SCHEMA_PATH));
  delete schema.$defs.cropTarget.properties.fullyGrown;
  const report = checkStardewCropRowDerivation({
    overrides: withEdit(SCHEMA_PATH, () => JSON.stringify(schema, null, 2)),
  });
  assert.equal(report.verdict, "blocked");
  assert.ok(codes(report).includes("wire_missing:fullyGrown"));
});

test("a map-only passability answer is named, because it cannot report a trellis", () => {
  const report = checkStardewCropRowDerivation({
    overrides: withEdit(EXECUTION_CONTROLLER_PATH, (source) =>
      source.replace(
        /private static bool IsTileBlockedForFarmer\([\s\S]*?skipCollisionEffects: true\);/u,
        "private static bool IsTileBlockedForFarmer(StardewValley.GameLocation location, Farmer player, int x, int y) =>\n        !location.isTilePassable(new Vector2(x, y));",
      ),
    ),
  });
  assert.equal(report.verdict, "blocked");
  assert.ok(
    codes(report).includes("passability_map_only:tileBlockedNow"),
    `the finding must name the field: ${codes(report).join(", ")}`,
  );
});

test("an exemption for a field the row now publishes is red, so the table cannot rot", () => {
  const report = checkStardewCropRowDerivation({
    exemptions: { ...REACHABILITY_EXEMPTIONS, isRaised: { kind: "lookup_only", reason: "x".repeat(60) } },
  });
  assert.equal(report.verdict, "blocked");
  assert.ok(codes(report).includes("exemption_stale:isRaised"));
});

test("a worker population of zero is blocked, never green", () => {
  const report = checkStardewCropRowDerivation({
    overrides: withEdit(CONTENT_DATA_PATH, (source) =>
      source.replace(
        /BridgeDataQueryRow CropRow\(string id, CropData data\) =>[\s\S]*?\)\);/u,
        "BridgeDataQueryRow CropRow(string id, CropData data) => new(id, Fields());",
      ),
    ),
  });
  assert.equal(report.verdict, "blocked");
  assert.ok(codes(report).includes("worker_population_empty:<CropRow>"));
});

test("the Host row type is read as keys, not as comment prose", () => {
  const fields = extractProtocolRowFields(sourceOf(PROTOCOL_PATH));
  assert.deepEqual([...fields].sort(), [
    "cropFactsUnknown",
    "cropId",
    "daysToHarvest",
    "displayName",
    "fullyGrown",
    "harvestMethod",
    "harvestable",
    "isRaised",
    "regrowDays",
    "seasons",
    "targetId",
    "tileBlockedNow",
    "watered",
    "x",
    "y",
  ]);
});

test("the worker row is read from the pair list the projection really writes", () => {
  const fields = extractWorkerCropRowFields(sourceOf(CONTENT_DATA_PATH));
  assert.ok(fields.includes("isRaised"));
  assert.ok(fields.includes("daysToHarvest"));
  assert.ok(!fields.includes("displayName"), "a field the engine row does not project must not appear");
});

test("a stale DEPLOYED validator is a finding, because that is the copy a live run loads", () => {
  // Measured 2026-11-09: this gate was green reading `host/src`, the deployed `dist-test` was eight minutes older, and
  // the next run died at 58s with `invalid_snapshot:cropTargets`. A source-only parity check answers a question nobody
  // runs, so the deployed build is now part of the population.
  const source = sourceOf(VALIDATOR_PATH);
  const stale = source.replace(/\n\s*"isRaised",/u, "\n");
  assert.notEqual(stale, source, "the fixture must actually remove a key, or this test proves nothing");
  const result = checkStardewCropRowDerivation({
    overrides: { [DEPLOYED_VALIDATOR_PATH]: stale },
  });
  assert.ok(
    result.findings.some((finding) => finding.code === "deployed_host_stale" && finding.member === "isRaised"),
    `expected a deployed_host_stale finding for isRaised; got ${JSON.stringify(result.findings)}`,
  );
});

test("an unreadable deployed build is named, not silently skipped", () => {
  const result = checkStardewCropRowDerivation({
    overrides: { [DEPLOYED_VALIDATOR_PATH]: "export function isCropTargetFact() {}" },
  });
  assert.ok(
    result.findings.some(
      (finding) => finding.code === "deployed_host_stale" || finding.code === "deployed_host_absent",
    ),
    `an empty deployed validator must be named, not passed; got ${JSON.stringify(result.findings)}`,
  );
});

test("a nullable crop key without WhenWritingNull is the defect that closed a bridge", () => {
  // Measured 2026-11-09: `int? DaysToHarvest` with no omission attribute sent `"daysToHarvest": null`, the Host read a
  // null as the wrong type, and the whole snapshot was refused 162s into the run. Key-name parity cannot see this,
  // which is why the rule is asserted on the declaration itself.
  const source = sourceOf(BRIDGE_MODELS_PATH);
  const mutated = source.replace(
    /\[property: JsonIgnore\(Condition = JsonIgnoreCondition\.WhenWritingNull\)\] bool\? IsRaised,/u,
    "bool? IsRaised,",
  );
  assert.notEqual(mutated, source, "the fixture must actually strip the attribute, or this proves nothing");
  const result = checkStardewCropRowDerivation({ overrides: { [BRIDGE_MODELS_PATH]: mutated } });
  assert.ok(
    result.findings.some(
      (finding) =>
        finding.code === "nullable_wire_key_without_omission" && finding.member === "BridgeCropTarget.IsRaised",
    ),
    `expected the stripped attribute to be named; got ${JSON.stringify(result.findings.map((f) => f.code))}`,
  );
});
