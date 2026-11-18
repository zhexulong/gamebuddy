// red-proof: inject  the same extra BridgeReceipt field -> `AssertionError: the mutation must leave the
//   authority record intact` 11 !== 10 at tools/check-stardew-execution-receipt-field-parity.test.mjs:216,
//   with the ten-layer violation list as `actual`
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
  DOCUMENTED_EXTRAS,
  DOCUMENTED_EXTRA_REASONS,
  DOCUMENTED_LEDGER_OMISSIONS,
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
  "origin",
  "observation",
  "piggybackedScene",
  "nativeNotices",
];
const REQUIRED_FIELDS = [
  "executionId",
  "requestId",
  "actionId",
  "state",
  "reasonCode",
  "revision",
  "evidence",
  "origin",
];
const OPTIONAL_FIELDS = ["observation", "piggybackedScene", "nativeNotices"];
const PROJECTION_FIELDS = [
  "requestId",
  "executionId",
  "actionId",
  "state",
  "reasonCode",
  "revision",
  "evidence",
  "nativeNotices",
];

const sorted = (values) => [...values].sort();

test("parses the Mod authority record BridgeReceipt into its exact wire field set", () => {
  const authority = extractCSharpRecordFields(sourceOf(BRIDGE_MODELS_PATH), "BridgeReceipt");
  assert.deepEqual(authority.wire, AUTHORITY_FIELDS);
  assert.deepEqual(authority.required, REQUIRED_FIELDS);
  assert.deepEqual(sorted(authority.optional), sorted(OPTIONAL_FIELDS));
});

test("parses the Mod ledger record LocalExecutionReceipt into the authority's field set plus the declared extras", () => {
  // The ledger is the Mod's own model, not the wire model: it carries `hint` beside `reasonCode`
  // so `RouteReenteringBodyProgramExecutor` can copy the actionable direction into a
  // `BodyProgramTerminalResult`. That is a declared extra, not an authority field - the wire
  // `BridgeReceipt` deliberately does not carry it. So the assertion is "authority plus exactly the
  // declared extras", which still reddens when a member is added without a declaration.
  const ledger = extractCSharpRecordFields(sourceOf(BRIDGE_MODELS_PATH), "LocalExecutionReceipt");
  const declared = DOCUMENTED_EXTRAS["BridgeProtocolModels.cs/LocalExecutionReceipt"];
  assert.deepEqual(
    sorted(ledger.wire),
    sorted([
      ...AUTHORITY_FIELDS.filter((field) => !(field in DOCUMENTED_LEDGER_OMISSIONS)),
      ...declared,
    ]),
  );
});

test("counts every authority field passed by TryProjectReceipt to the wire constructor", () => {
  assert.equal(extractProjectionArgCount(sourceOf(BRIDGE_SESSION_PATH)), AUTHORITY_FIELDS.length);
});

test("parses the Host protocol ExecutionReceipt type with the authority's optional markers", () => {
  const type = extractTsTypeProperties(sourceOf(PROTOCOL_PATH), "ExecutionReceipt");
  assert.deepEqual(sorted(type.fields), sorted(AUTHORITY_FIELDS));
  // `origin` is required on the wire and optional in this type on purpose; the gate carries that difference as a
  // declared optionality exception rather than letting the two lists drift apart silently.
  assert.deepEqual(sorted(type.optional), sorted([...OPTIONAL_FIELDS, "origin"]));
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
  // THE THREE VIOLATIONS THIS TREE REALLY HAS, recorded rather than exempted: `origin` is on the wire authority and in
  // the Host's `ExecutionReceipt` type, and the Agent-facing projection never mentions it - so the field the event pump
  // reads for trace provenance is dropped at the adapter boundary. That is a product defect one layer below this gate's
  // own subject; it is recorded here so the day it is fixed this assertion reddens and the entry is removed.
  const knownOriginDrop = [
    "game-integration-adapter.ts/IntegrationExecutionReceipt:origin:missing",
    "stardew-game-integration-adapter.ts/parseStardewReceipt:origin:missing",
    "stardew-game-integration-adapter.ts/toIntegrationReceipt:origin:missing",
  ];
  assert.deepEqual(
    report.violations.map((violation) => `${violation.layer}:${violation.field}:${violation.issue}`).sort(),
    [...knownOriginDrop].sort(),
    "no violation other than the recorded `origin` drop may exist",
  );
  assert.deepEqual(report.authority.wireFields, AUTHORITY_FIELDS);
});

// ---------------------------------------------------------------------------
// Decisive mutation verification: each single-field deletion must be caught.
// ---------------------------------------------------------------------------

function expectBlockedWith(report, { layer, field, issue }) {
  assert.equal(report.verdict, "blocked", `expected blocked report, got: ${JSON.stringify(report.violations)}`);
  assert.ok(
    report.violations.some(
      (violation) =>
        violation.layer === layer && violation.field === field && (issue === undefined || violation.issue === issue),
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
    '["executionId", "requestId", "actionId", "state", "reasonCode", "revision", "evidence", "origin"]',
    '["executionId", "requestId", "actionId", "state", "revision", "evidence", "origin"]',
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
  expectBlockedWith(report, {
    layer: "stardew-game-integration-adapter.ts/toIntegrationReceipt",
    field: "revision",
    issue: "missing",
  });
});

test("mutation (e): deleting a field from parseStardewReceipt is caught", () => {
  const original = sourceOf(STARDEW_ADAPTER_PATH);
  const mutated = original.replace(/^[\t ]*reasonCode: value\.reasonCode,\r?\n/mu, "");
  assert.notEqual(mutated, original);
  const report = checkStardewExecutionReceiptFieldParity({ overrides: { [STARDEW_ADAPTER_PATH]: mutated } });
  expectBlockedWith(report, {
    layer: "stardew-game-integration-adapter.ts/parseStardewReceipt",
    field: "reasonCode",
    issue: "missing",
  });
});

test("mutation (f): an undocumented extra field in the schema properties is caught", () => {
  const schema = JSON.parse(sourceOf(SCHEMA_PATH));
  schema.$defs.receipt.properties.futureField = { type: "string" };
  const report = checkStardewExecutionReceiptFieldParity({
    overrides: { [SCHEMA_PATH]: JSON.stringify(schema, null, 2) },
  });
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
    extractCSharpRecordFields(sourceOf(BRIDGE_MODELS_PATH), "LocalExecutionReceipt").wire.length - 1,
    "the mutation must actually remove one ledger field",
  );
  const report = checkStardewExecutionReceiptFieldParity({ overrides: { [BRIDGE_MODELS_PATH]: mutated } });
  expectBlockedWith(report, {
    layer: "BridgeProtocolModels.cs/LocalExecutionReceipt",
    field: "observation",
    issue: "missing",
  });
});

test("mutation (h): dropping a projection argument in TryProjectReceipt is caught", () => {
  const original = sourceOf(BRIDGE_SESSION_PATH);
  // Drop the piggybacked-scene and native-notice arguments: the wire constructor now
  // receives nine values for a ten-field model.
  const mutated = original.replace(/receipt\.PiggybackedScene,\r?\n[\t ]*receipt\.NativeNotices\);/u, "null);");
  assert.notEqual(mutated, original);
  const report = checkStardewExecutionReceiptFieldParity({ overrides: { [BRIDGE_SESSION_PATH]: mutated } });
  expectBlockedWith(report, {
    layer: "BridgeSession.cs/TryProjectReceipt",
    field: "<wire-constructor>",
    issue: "count",
  });
});
// ---------------------------------------------------------------------------
// A receipt field the Mod WRITES is either exported or declared ignored by name.
// ---------------------------------------------------------------------------

const LEDGER_LAYER = "BridgeProtocolModels.cs/LocalExecutionReceipt";

function violationFor(report, { layer, field, issue }) {
  return report.violations.find(
    (violation) => violation.layer === layer && violation.field === field && violation.issue === issue,
  );
}

test("accounts every field the Mod writes into a receipt: written, exported, declared-ignored", () => {
  const report = checkStardewExecutionReceiptFieldParity();
  const { written, exported, declaredIgnored, unaccounted } = report.fields;

  assert.ok(written.length > 0, "a population of zero would let this accounting agree with itself");
  assert.deepEqual(unaccounted, [], "every written field reaches the wire or is declared ignored");
  assert.deepEqual(sorted(declaredIgnored), ["hint"], "the one field the wire deliberately does not carry");
  const wireFields = extractCSharpRecordFields(sourceOf(BRIDGE_MODELS_PATH), "BridgeReceipt").wire;
  assert.deepEqual(
    sorted(exported),
    sorted(wireFields.filter((field) => !(field in DOCUMENTED_LEDGER_OMISSIONS))),
    "the exported half is the wire authority minus the fields the ledger is declared not to write",
  );
  assert.equal(
    exported.length + declaredIgnored.length,
    written.length,
    `written ${written.length} must equal exported ${exported.length} plus declared-ignored ${declaredIgnored.length}`,
  );
});

test("mutation (i): a receipt field the Mod writes and nothing exports is named, with the counts", () => {
  const original = sourceOf(BRIDGE_MODELS_PATH);
  // Anchor on the ledger's own last member so the wire authority is untouched: this case must be about a producer field
  // no reader names, not about the authority gaining a member every layer would then be expected to carry.
  const mutated = original.replace(
    /(\r?\n)(\s+string\? Hint = null)(\r?\n\);)/u,
    `$1$2,$1    string? RedProofProbe = null$3`,
  );
  assert.notEqual(mutated, original, "the mutation must add a member to the ledger record");
  assert.equal(
    extractCSharpRecordFields(mutated, "BridgeReceipt").wire.length,
    AUTHORITY_FIELDS.length,
    "the mutation must leave the wire authority intact",
  );

  const report = checkStardewExecutionReceiptFieldParity({ overrides: { [BRIDGE_MODELS_PATH]: mutated } });
  const violation = violationFor(report, {
    layer: LEDGER_LAYER,
    field: "redProofProbe",
    issue: "produced_and_never_read",
  });
  assert.ok(violation, `expected the new field to be named, got ${JSON.stringify(report.violations)}`);
  assert.match(
    violation.detail,
    /fields written 12 · exported 10 · declared-ignored 1/u,
    "the failure prints the counts, so the reader sees the gap and not only the name",
  );
  assert.deepEqual(report.fields.unaccounted, ["redProofProbe"]);
});

test("mutation (j): deleting the declaration names the field instead of passing it", () => {
  const extras = { ...DOCUMENTED_EXTRAS, [LEDGER_LAYER]: [] };
  const report = checkStardewExecutionReceiptFieldParity({ extras });
  assert.ok(
    violationFor(report, { layer: LEDGER_LAYER, field: "hint", issue: "produced_and_never_read" }),
    `an undeclared 'hint' must be reported, got ${JSON.stringify(report.violations)}`,
  );
  assert.deepEqual(report.fields.declaredIgnored, []);
});

test("mutation (k): a declaration with no reason is refused", () => {
  const report = checkStardewExecutionReceiptFieldParity({ extraReasons: {} });
  assert.ok(
    violationFor(report, { layer: LEDGER_LAYER, field: "hint", issue: "declared_without_a_reason" }),
    "an exemption must say why it exists",
  );
});

test("mutation (l): an exemption that exempts nothing expires", () => {
  const extras = { ...DOCUMENTED_EXTRAS, [LEDGER_LAYER]: [...DOCUMENTED_EXTRAS[LEDGER_LAYER], "ghost"] };
  const report = checkStardewExecutionReceiptFieldParity({ extras });
  assert.ok(
    violationFor(report, { layer: LEDGER_LAYER, field: "ghost", issue: "stale_exemption" }),
    "a declared-ignored name no receipt field carries must be removed, not silently tolerated",
  );
});

test("the declaration's reason names the reader by symbol, not by line number", () => {
  const reason = DOCUMENTED_EXTRA_REASONS[`${LEDGER_LAYER}/hint`];
  assert.equal(typeof reason, "string");
  // A line number survives neither a refactor nor a merge; the reason this exemption carried before cited
  // `farmhandexecutioncontroller.cs:5145` (a line that does not exist) and `RouteReenteringBodyProgramExecutor.cs:348`
  // (a line that is an argument list), so nothing in it could be checked by its reader.
  assert.doesNotMatch(reason, /\.cs:\d+/u, "a reason may not cite a source line");
  for (const symbol of [
    "RouteReenteringBodyProgramExecutor.SettleWithoutProof",
    "OpenBodyProgramJournalAuthority.TryComplete",
    "BridgeSession.NodeStatus",
    "BridgeBodyProgramNodeStatus.Hint",
  ]) {
    assert.ok(reason.includes(symbol), `the reason must name the reader '${symbol}'`);
  }
});
