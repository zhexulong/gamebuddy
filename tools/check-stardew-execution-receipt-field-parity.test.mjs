// Tests for the execution receipt field-parity gate.
//
// The four mutations required by the Task acceptance are executed against the real
// workspace sources (copied in memory and mutated), so a passing suite proves the
// checker is decisive rather than vacuous: deleting a receipt field from any single
// layer must be reported as a missing field on that exact layer.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  checkStardewExecutionReceiptFieldParity,
  extractCSharpRecordFields,
  extractMappingKeysAndReads,
  extractProjectionArgCount,
  extractSchemaReceipt,
  extractTsTypeProperties,
  extractValidateReceiptSets,
  findTsTypeBodyRange,
} from "./check-stardew-execution-receipt-field-parity.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceOf = (relativePath) => readFileSync(path.join(root, relativePath), "utf8");

const BRIDGE_MODELS_PATH = "integrations/stardew/src/Core/Models/BridgeProtocolModels.cs";
const BRIDGE_SESSION_PATH = "integrations/stardew/BridgeSession.cs";
const PROTOCOL_PATH = "host/src/protocol.ts";
const SCHEMA_PATH = "protocol/bridge-v1.schema.json";
const GAME_ADAPTER_PATH = "host/src/game-integration-adapter.ts";
const STARDEW_ADAPTER_PATH = "host/src/stardew-game-integration-adapter.ts";

const AUTHORITY_FIELDS = [
  "executionId",
  "requestId",
  "actionId",
  "state",
  "reasonCode",
  "revision",
  "evidence",
  "observation",
  "piggybackedScene",
  "nativeNotices",
];
const REQUIRED_FIELDS = ["executionId", "requestId", "actionId", "state", "reasonCode", "revision", "evidence"];
const OPTIONAL_FIELDS = ["observation", "piggybackedScene", "nativeNotices"];
const PROJECTION_FIELDS = ["requestId", "executionId", "actionId", "state", "reasonCode", "revision", "evidence", "nativeNotices"];

const sorted = (values) => [...values].sort();

test("parses the Mod authority record BridgeReceipt into its exact wire field set", () => {
  const authority = extractCSharpRecordFields(sourceOf(BRIDGE_MODELS_PATH), "BridgeReceipt");
  assert.deepEqual(authority.wire, AUTHORITY_FIELDS);
  assert.deepEqual(authority.required, REQUIRED_FIELDS);
  assert.deepEqual(sorted(authority.optional), sorted(OPTIONAL_FIELDS));
});

test("parses the Mod ledger record LocalExecutionReceipt into the same field set", () => {
  const ledger = extractCSharpRecordFields(sourceOf(BRIDGE_MODELS_PATH), "LocalExecutionReceipt");
  assert.deepEqual(sorted(ledger.wire), sorted(AUTHORITY_FIELDS));
});

test("counts every authority field passed by TryProjectReceipt to the wire constructor", () => {
  assert.equal(extractProjectionArgCount(sourceOf(BRIDGE_SESSION_PATH)), AUTHORITY_FIELDS.length);
});

test("parses the Host protocol ExecutionReceipt type with the authority's optional markers", () => {
  const type = extractTsTypeProperties(sourceOf(PROTOCOL_PATH), "ExecutionReceipt");
  assert.deepEqual(sorted(type.fields), sorted(AUTHORITY_FIELDS));
  assert.deepEqual(sorted(type.optional), sorted(OPTIONAL_FIELDS));
});

test("parses validateReceipt into an unconditional required base and conditional optional pushes", () => {
  const { base, pushes } = extractValidateReceiptSets(sourceOf(PROTOCOL_PATH));
  assert.deepEqual(sorted(base), sorted(REQUIRED_FIELDS));
  assert.deepEqual(sorted(pushes), sorted(OPTIONAL_FIELDS));
});

test("parses the wire schema receipt definition with matching properties and required list", () => {
  const schema = extractSchemaReceipt(sourceOf(SCHEMA_PATH));
  assert.deepEqual(sorted(schema.properties ?? []), sorted(AUTHORITY_FIELDS));
  assert.deepEqual(sorted(schema.required ?? []), sorted(REQUIRED_FIELDS));
});

test("parses the Host adapter receipt type and both mapping functions", () => {
  const adapterType = extractTsTypeProperties(sourceOf(GAME_ADAPTER_PATH), "IntegrationExecutionReceipt");
  assert.deepEqual(sorted(adapterType.fields), sorted(PROJECTION_FIELDS));
  assert.deepEqual(sorted(adapterType.optional), ["nativeNotices"]);

  const toIntegration = extractMappingKeysAndReads(sourceOf(STARDEW_ADAPTER_PATH), "toIntegrationReceipt", "receipt");
  assert.deepEqual(sorted(toIntegration.written), sorted(PROJECTION_FIELDS));
  for (const read of toIntegration.reads) assert.ok(AUTHORITY_FIELDS.includes(read), `unexpected read '${read}'`);

  const parseReceipt = extractMappingKeysAndReads(sourceOf(STARDEW_ADAPTER_PATH), "parseStardewReceipt", "value");
  assert.deepEqual(sorted(parseReceipt.written), sorted(PROJECTION_FIELDS));
  for (const read of parseReceipt.reads) assert.ok(AUTHORITY_FIELDS.includes(read), `unexpected read '${read}'`);
});

test("the current workspace sources satisfy the field-parity gate", () => {
  const report = checkStardewExecutionReceiptFieldParity();
  assert.deepEqual(report.violations, []);
  assert.equal(report.verdict, "passed");
  assert.deepEqual(report.authority.wireFields, AUTHORITY_FIELDS);
});

// ---------------------------------------------------------------------------
// Decisive mutation verification: each single-field deletion must be caught.
// ---------------------------------------------------------------------------

function expectBlockedWith(report, { layer, field, issue }) {
  assert.equal(report.verdict, "blocked", `expected blocked report, got: ${JSON.stringify(report.violations)}`);
  assert.ok(
    report.violations.some(
      (violation) => violation.layer === layer && violation.field === field && (issue === undefined || violation.issue === issue),
    ),
    `expected violation {layer: ${layer}, field: ${field}, issue: ${issue ?? "any"}} in ${JSON.stringify(report.violations)}`,
  );
}

function removeTypeProperty(source, typeName, propertyName) {
  const { start, end } = findTsTypeBodyRange(source, typeName);
  const body = source.slice(start, end);
  const pattern = new RegExp(`\\n[\\t ]*${propertyName}\\??[\\t ]*:[^;\\n]*;`, "u");
  const match = pattern.exec(body);
  assert.ok(match, `property '${propertyName}' not found in type '${typeName}'`);
  return source.slice(0, start + match.index) + source.slice(start + match.index + match[0].length);
}

test("mutation (a): deleting a field from the TS ExecutionReceipt type is caught", () => {
  const mutated = removeTypeProperty(sourceOf(PROTOCOL_PATH), "ExecutionReceipt", "revision");
  assert.notEqual(mutated, sourceOf(PROTOCOL_PATH));
  const report = checkStardewExecutionReceiptFieldParity({ overrides: { [PROTOCOL_PATH]: mutated } });
  expectBlockedWith(report, { layer: "protocol.ts/ExecutionReceipt", field: "revision", issue: "missing" });
});

test("mutation (b): deleting a field from validateReceipt allowedKeys is caught", () => {
  const original = sourceOf(PROTOCOL_PATH);
  const mutated = original.replace(
    '["executionId", "requestId", "actionId", "state", "reasonCode", "revision", "evidence"]',
    '["executionId", "requestId", "actionId", "state", "revision", "evidence"]',
  );
  assert.notEqual(mutated, original);
  const report = checkStardewExecutionReceiptFieldParity({ overrides: { [PROTOCOL_PATH]: mutated } });
  expectBlockedWith(report, { layer: "protocol.ts/validateReceipt", field: "reasonCode" });
});

test("mutation (c): deleting a field from the schema receipt properties is caught", () => {
  const schema = JSON.parse(sourceOf(SCHEMA_PATH));
  delete schema.$defs.receipt.properties.revision;
  const mutated = JSON.stringify(schema, null, 2);
  const report = checkStardewExecutionReceiptFieldParity({ overrides: { [SCHEMA_PATH]: mutated } });
  expectBlockedWith(report, { layer: "schema.json/$defs.receipt", field: "revision", issue: "missing" });
});

test("mutation (d): deleting a field from toIntegrationReceipt is caught", () => {
  const original = sourceOf(STARDEW_ADAPTER_PATH);
  const mutated = original.replace(/^[\t ]*revision: receipt\.revision,\r?\n/mu, "");
  assert.notEqual(mutated, original);
  const report = checkStardewExecutionReceiptFieldParity({ overrides: { [STARDEW_ADAPTER_PATH]: mutated } });
  expectBlockedWith(report, { layer: "stardew-game-integration-adapter.ts/toIntegrationReceipt", field: "revision", issue: "missing" });
});

test("mutation (e): deleting a field from parseStardewReceipt is caught", () => {
  const original = sourceOf(STARDEW_ADAPTER_PATH);
  const mutated = original.replace(/^[\t ]*reasonCode: value\.reasonCode,\r?\n/mu, "");
  assert.notEqual(mutated, original);
  const report = checkStardewExecutionReceiptFieldParity({ overrides: { [STARDEW_ADAPTER_PATH]: mutated } });
  expectBlockedWith(report, { layer: "stardew-game-integration-adapter.ts/parseStardewReceipt", field: "reasonCode", issue: "missing" });
});

test("mutation (f): an undocumented extra field in the schema properties is caught", () => {
  const schema = JSON.parse(sourceOf(SCHEMA_PATH));
  schema.$defs.receipt.properties.futureField = { type: "string" };
  const report = checkStardewExecutionReceiptFieldParity({ overrides: { [SCHEMA_PATH]: JSON.stringify(schema, null, 2) } });
  expectBlockedWith(report, { layer: "schema.json/$defs.receipt", field: "futureField", issue: "extra" });
});

test("mutation (g): dropping a field from the Mod ledger record is caught", () => {
  // The ledger record's members carry no JsonIgnore attribute (it is the Mod's
  // internal model, not the wire model), so the anchor must not require one: an
  // anchored regex would silently match the authority record's line instead and
  // mutate the very field set the ledger is compared against.
  const anchor = "    BridgeLocalObservation? Observation = null,\n";
  const mutated = sourceOf(BRIDGE_MODELS_PATH).replace(anchor, "");
  assert.notEqual(mutated, sourceOf(BRIDGE_MODELS_PATH));
  // Guard the anchor's target: the authority record must be untouched, otherwise
  // this case would be proving something about BridgeReceipt, not the ledger.
  assert.equal(
    extractCSharpRecordFields(mutated, "BridgeReceipt").wire.length,
    AUTHORITY_FIELDS.length,
    "the mutation must leave the authority record intact",
  );
  assert.equal(
    extractCSharpRecordFields(mutated, "LocalExecutionReceipt").wire.length,
    AUTHORITY_FIELDS.length - 1,
    "the mutation must actually remove one ledger field",
  );
  const report = checkStardewExecutionReceiptFieldParity({ overrides: { [BRIDGE_MODELS_PATH]: mutated } });
  expectBlockedWith(report, { layer: "BridgeProtocolModels.cs/LocalExecutionReceipt", field: "observation", issue: "missing" });
});

test("mutation (h): dropping a projection argument in TryProjectReceipt is caught", () => {
  const original = sourceOf(BRIDGE_SESSION_PATH);
  // Drop the piggybacked-scene and native-notice arguments: the wire constructor now
  // receives nine values for a ten-field model.
  const mutated = original.replace(/receipt\.PiggybackedScene,\r?\n[\t ]*receipt\.NativeNotices\);/u, "null);");
  assert.notEqual(mutated, original);
  const report = checkStardewExecutionReceiptFieldParity({ overrides: { [BRIDGE_SESSION_PATH]: mutated } });
  expectBlockedWith(report, { layer: "BridgeSession.cs/TryProjectReceipt", field: "<wire-constructor>", issue: "count" });
});
