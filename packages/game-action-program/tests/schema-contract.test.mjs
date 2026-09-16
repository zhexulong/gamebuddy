import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const schema = JSON.parse(readFileSync(new URL("../schemas/game-action-program.v1.schema.json", import.meta.url), "utf8"));
const defs = schema.$defs;
const guard = defs.guard;
const identifier = defs.identifier;
const scalarLiteral = defs.scalarLiteral;

function sortedKeys(value) {
  return Object.keys(value).sort();
}

function assertExactKeys(value, expected) {
  assert.deepEqual(sortedKeys(value), [...expected].sort());
}

function matchesIdentifier(value) {
  return typeof value === "string"
    && value.length >= identifier.minLength
    && value.length <= identifier.maxLength
    && new RegExp(identifier.pattern).test(value);
}

function matchesScalarLiteral(value) {
  return scalarLiteral.anyOf.some((branch) => {
    if (branch.type === "string") return typeof value === "string";
    if (branch.type === "integer") {
      return typeof value === "number"
        && Number.isInteger(value)
        && value >= branch.minimum
        && value <= branch.maximum;
    }
    return branch.type === "boolean" && typeof value === "boolean";
  });
}

function matchesBranchRule(value, rule) {
  if (Object.hasOwn(rule, "const")) return Object.is(value, rule.const);
  if (rule.$ref === "#/$defs/identifier") return matchesIdentifier(value);
  if (rule.$ref === "#/$defs/scalarLiteral") return matchesScalarLiteral(value);
  assert.fail(`unexpected guard branch rule: ${JSON.stringify(rule)}`);
}

/**
 * This is deliberately only a guard-shape probe, not a general JSON Schema
 * implementation. It executes the fixed discriminator metadata so these tests
 * do not claim full JSON Schema validation without an approved validator.
 */
function matchesGuardBranch(candidate) {
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return false;
  const allowedKeys = new Set(Object.keys(guard.properties));
  if (Object.keys(candidate).some((key) => !allowedKeys.has(key))) return false;

  const matchingBranches = guard.oneOf.filter((branch) => {
    if (!branch.required.every((key) => Object.hasOwn(candidate, key))) return false;
    return Object.entries(branch.properties).every(([key, rule]) => matchesBranchRule(candidate[key], rule));
  });
  return matchingBranches.length === 1;
}

test("schema identity and exact program/node contract shape are package-owned", () => {
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(schema.$id, "gamebuddy-action-program/v1");
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...schema.required].sort(), ["edges", "nodes", "programId", "schema"]);
  assertExactKeys(schema.properties, ["schema", "programId", "nodes", "edges"]);
  assert.equal(schema.properties.schema.const, "gamebuddy-action-program/v1");
  assert.equal(schema.properties.programId.$ref, "#/$defs/identifier");
  assert.equal(schema.properties.nodes.type, "array");
  assert.equal(schema.properties.nodes.maxItems, 16);
  assert.equal(schema.properties.nodes.items.$ref, "#/$defs/node");
  assert.equal(schema.properties.edges.type, "array");
  assert.equal(schema.properties.edges.maxItems, 32);
  assert.equal(schema.properties.edges.items.$ref, "#/$defs/edge");
  assert.equal(schema.properties.nodes.minItems, undefined);
  assert.equal(schema.properties.edges.minItems, undefined);

  assert.deepEqual(
    Object.keys(defs).sort(),
    ["argumentIdentifier", "binding", "edge", "guard", "identifier", "jsonArray", "jsonObject", "jsonValue", "node", "scalarLiteral"],
  );
  for (const name of ["node", "edge", "binding", "guard"]) {
    assert.equal(defs[name].type, "object");
    assert.equal(defs[name].additionalProperties, false);
  }

  assert.deepEqual([...defs.node.required].sort(), ["actionId", "args", "bindings", "guards", "nodeId"]);
  assertExactKeys(defs.node.properties, ["nodeId", "actionId", "args", "bindings", "guards"]);
  assert.equal(defs.node.properties.nodeId.$ref, "#/$defs/identifier");
  assert.equal(defs.node.properties.actionId.$ref, "#/$defs/identifier");
  assert.equal(defs.node.properties.args.$ref, "#/$defs/jsonObject");
  assert.equal(defs.node.properties.bindings.items.$ref, "#/$defs/binding");
  assert.equal(defs.node.properties.guards.items.$ref, "#/$defs/guard");

  assert.deepEqual([...defs.edge.required].sort(), ["from", "to"]);
  assertExactKeys(defs.edge.properties, ["from", "to"]);
  assert.equal(defs.edge.properties.from.$ref, "#/$defs/identifier");
  assert.equal(defs.edge.properties.to.$ref, "#/$defs/identifier");

  assert.deepEqual([...defs.binding.required].sort(), ["arg", "fact", "from"]);
  assertExactKeys(defs.binding.properties, ["arg", "from", "fact"]);
  assert.equal(defs.binding.properties.arg.$ref, "#/$defs/argumentIdentifier");
  assert.equal(defs.binding.properties.from.$ref, "#/$defs/identifier");
  assert.equal(defs.binding.properties.fact.$ref, "#/$defs/identifier");
});

test("relaxed nested values leave action-specific bounds to descriptor runtime checks", () => {
  assert.equal(Object.hasOwn(defs.jsonObject, "maxProperties"), false);
  assert.equal(Object.hasOwn(defs.jsonArray, "maxItems"), false);

  const jsonStringBranch = defs.jsonValue.anyOf.find((branch) => branch.type === "string");
  assert.ok(jsonStringBranch);
  assert.equal(Object.hasOwn(jsonStringBranch, "maxLength"), false);

  const scalarStringBranch = scalarLiteral.anyOf.find((branch) => branch.type === "string");
  assert.ok(scalarStringBranch);
  assert.equal(Object.hasOwn(scalarStringBranch, "maxLength"), false);
});

test("guard schema has exactly the approved finite discriminator branches", () => {
  assert.deepEqual([...guard.required].sort(), ["fact", "kind", "nodeId", "operator", "value"]);
  assertExactKeys(guard.properties, ["kind", "nodeId", "fact", "operator", "value"]);
  assert.deepEqual(guard.properties.kind.enum, ["fact_present", "fact_equals", "node_succeeded"]);
  assert.equal(guard.properties.nodeId.$ref, "#/$defs/identifier");
  assert.deepEqual(guard.properties.fact.type, ["string", "null"]);
  assert.equal(guard.properties.fact.pattern, defs.identifier.pattern);
  assert.equal(guard.properties.fact.minLength, defs.identifier.minLength);
  assert.equal(guard.properties.fact.maxLength, defs.identifier.maxLength);
  assert.deepEqual(guard.properties.operator, { const: null });
  assert.equal(guard.properties.value.$ref, "#/$defs/jsonValue");

  assert.equal(guard.oneOf.length, 3);
  assert.deepEqual(
    guard.oneOf.map((branch) => branch.properties.kind.const),
    ["fact_present", "fact_equals", "node_succeeded"],
  );
  for (const branch of guard.oneOf) {
    assert.deepEqual([...branch.required].sort(), ["fact", "kind", "nodeId", "operator", "value"]);
    assertExactKeys(branch.properties, ["kind", "nodeId", "fact", "operator", "value"]);
    assert.deepEqual(branch.properties.operator, { const: null });
  }

  const branches = Object.fromEntries(guard.oneOf.map((branch) => [branch.properties.kind.const, branch]));
  assert.equal(branches.fact_present.properties.fact.$ref, "#/$defs/identifier");
  assert.deepEqual(branches.fact_present.properties.value, { const: null });
  assert.equal(branches.fact_equals.properties.fact.$ref, "#/$defs/identifier");
  assert.deepEqual(branches.fact_equals.properties.value, { $ref: "#/$defs/scalarLiteral" });
  assert.deepEqual(branches.node_succeeded.properties.fact, { const: null });
  assert.deepEqual(branches.node_succeeded.properties.value, { const: null });

  assert.deepEqual(
    scalarLiteral.anyOf.map((branch) => branch.type),
    ["string", "integer", "boolean"],
  );
  const integerBranch = scalarLiteral.anyOf.find((branch) => branch.type === "integer");
  assert.equal(integerBranch.minimum, -Number.MAX_SAFE_INTEGER);
  assert.equal(integerBranch.maximum, Number.MAX_SAFE_INTEGER);
  assert.match(schema.$comment, /runtime-only checks/);
  assert.ok(schema["x-gamebuddy-runtimeChecks"].some((entry) => entry.includes("descriptor-declared output-fact membership/type")));
  assert.ok(schema["x-gamebuddy-runtimeChecks"].some((entry) => entry.includes("ancestor/dependency dominance")));
});

test("representative guard values match one discriminator branch without runtime claims", () => {
  const accepted = [
    { kind: "fact_present", nodeId: "producer", fact: "arrival", operator: null, value: null },
    { kind: "fact_equals", nodeId: "producer", fact: "state", operator: null, value: "ready" },
    { kind: "fact_equals", nodeId: "producer", fact: "count", operator: null, value: Number.MAX_SAFE_INTEGER },
    { kind: "fact_equals", nodeId: "producer", fact: "enabled", operator: null, value: false },
    { kind: "node_succeeded", nodeId: "producer", fact: null, operator: null, value: null },
    // Structural validity does not prove that a producer or fact exists at runtime.
    { kind: "fact_present", nodeId: "unknown_producer", fact: "unknown_fact", operator: null, value: null },
  ];
  for (const candidate of accepted) assert.equal(matchesGuardBranch(candidate), true, JSON.stringify(candidate));

  const rejected = [
    { kind: "unsupported", nodeId: "producer", fact: "arrival", operator: null, value: null },
    { kind: "fact_present", nodeId: "producer", fact: null, operator: null, value: null },
    { kind: "fact_present", nodeId: "producer", fact: "arrival", operator: null, value: true },
    { kind: "fact_equals", nodeId: "producer", fact: "state", operator: null, value: null },
    { kind: "fact_equals", nodeId: "producer", fact: "state", operator: "equals", value: "ready" },
    { kind: "fact_equals", nodeId: "producer", fact: "state", operator: null, value: 1.5 },
    { kind: "fact_equals", nodeId: "producer", fact: "state", operator: null, value: Number.MAX_SAFE_INTEGER + 1 },
    { kind: "fact_equals", nodeId: "producer", fact: "state", operator: null, value: {} },
    { kind: "node_succeeded", nodeId: "producer", fact: "status", operator: null, value: null },
    { kind: "node_succeeded", nodeId: "producer", fact: null, operator: null, value: false },
    { kind: "node_succeeded", nodeId: "producer", fact: null, operator: null, value: null, extra: true },
    { kind: "fact_present", nodeId: "producer", fact: "arrival", operator: null },
  ];
  for (const candidate of rejected) assert.equal(matchesGuardBranch(candidate), false, JSON.stringify(candidate));
});
