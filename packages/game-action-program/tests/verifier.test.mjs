import test from "node:test";
import assert from "node:assert/strict";
import { verifyActionProgram } from "../src/verifier.mjs";

const descriptors = { schema: "gamebuddy-action-descriptors/v1", catalogRevision: 1, actions: [
  { actionId: "navigate_to_destination", identityVersion: 1, lifecycle: "published", kind: "execution", argumentSchema: { destination: { type: "object" } }, outputFacts: { arrival: "object" }, resourceTemplate: { claims: [{ key: "embodied_actor", value: "ScopePlayer" }] }, effect: "write", postcondition: { name: "arrived" } },
  { actionId: "inspect_arrival", identityVersion: 1, lifecycle: "published", kind: "read_only", argumentSchema: { arrival: { type: "object" } }, outputFacts: {}, resourceTemplate: { claims: [] }, effect: "read", postcondition: { name: "observed" } },
] };
const policy = { enabledActionIds: ["navigate_to_destination", "inspect_arrival"] };
const valid = { schema: "gamebuddy-action-program/v1", programId: "route_1", nodes: [
  { nodeId: "navigate", actionId: "navigate_to_destination", args: { destination: { kind: "label" } }, bindings: [], guards: [] },
  { nodeId: "inspect", actionId: "inspect_arrival", args: {}, bindings: [{ arg: "arrival", from: "navigate", fact: "arrival" }], guards: [{ kind: "fact_present", nodeId: "navigate", fact: "arrival", operator: null, value: null }] },
], edges: [{ from: "navigate", to: "inspect" }] };
function codes(program, selectedPolicy = policy) { return verifyActionProgram({ program, descriptors, restrictivePolicy: selectedPolicy }).diagnostics.map(x => x.code); }
test("accepts descriptor-driven navigation DAG without action-name special handling", () => assert.equal(verifyActionProgram({ program: valid, descriptors, restrictivePolicy: policy }).accepted, true));
test("rejects exact shape, bounds, unknown action, schema, cycle, dominance, type, resource, guard, terminality, raw fields, and policy", () => {
  assert.ok(codes({ ...valid, extra: true }).includes("invalid_program_shape"));
  assert.ok(codes({ ...valid, nodes: Array.from({ length: 17 }, () => valid.nodes[0]) }).includes("invalid_node_bounds"));
  assert.ok(codes({ ...valid, nodes: [{ ...valid.nodes[0], actionId: "unknown" }] }).includes("unknown_action"));
  assert.ok(codes({ ...valid, schema: "bad" }).includes("invalid_program_schema"));
  assert.ok(codes({ ...valid, edges: [{ from: "navigate", to: "inspect" }, { from: "inspect", to: "navigate" }] }).includes("cycle_detected"));
  assert.ok(codes({ ...valid, edges: [] }).includes("binding_dependency_not_dominant"));
  assert.ok(codes({ ...valid, nodes: [valid.nodes[0], { ...valid.nodes[1], bindings: [{ arg: "arrival", from: "navigate", fact: "arrival_typo" }] }] }).includes("binding_type_mismatch"));
  assert.ok(codes({ ...valid, nodes: [valid.nodes[0], { ...valid.nodes[0], nodeId: "parallel" }], edges: [] }).includes("resource_conflict_requires_dependency"));
  assert.ok(codes({ ...valid, nodes: [{ ...valid.nodes[0], guards: [{ kind: "script", nodeId: "navigate", fact: null, operator: null, value: null }] }] }).includes("invalid_guard"));
  assert.ok(codes({ ...valid, nodes: [{ ...valid.nodes[0], args: {} }] }).includes("argument_schema_mismatch"));
  assert.ok(codes({ ...valid, resources: [] }).includes("forbidden_raw_resource_field"));
  assert.ok(codes(valid, { enabledActionIds: [] }).includes("action_restricted_by_policy"));
});
test("diagnostics have stable order and bounded shape", () => { const report = verifyActionProgram({ program: { schema: "bad", programId: 1, nodes: [], edges: [], resources: [] }, descriptors, restrictivePolicy: policy }); assert.deepEqual(report.diagnostics, [...report.diagnostics].sort((a,b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code) || String(a.nodeId).localeCompare(String(b.nodeId)))); });

test("rejects malformed nested descriptor artifacts before empty, node, and resource-conflict paths", () => {
  const malformed = [
    { argumentSchema: { destination: { type: "invalid" } } },
    { argumentSchema: { destination: { type: "object", extra: true } } },
    { outputFacts: { arrival: "invalid" } },
    { resourceTemplate: { claims: "embodied_actor" } },
    { resourceTemplate: { claims: [{ key: "x".repeat(129), value: "ScopePlayer" }] } },
    { resourceTemplate: { claims: Array.from({ length: 17 }, (_, index) => ({ key: `key_${index}`, value: "ScopePlayer" })) } },
    { resourceTemplate: { claims: [{ key: "embodied_actor", value: "unmapped" }] } },
    { resourceTemplate: { claims: [{ key: "embodied_actor", value: "ScopePlayer" }, { key: "embodied_actor", value: "ScopePlayer" }] } },
    { lifecycle: "withdrawn" },
    { effect: "mutate" },
    { postcondition: { name: "" } },
    { postcondition: { name: 1 } },
  ];
  const empty = { schema: "gamebuddy-action-program/v1", programId: "empty", nodes: [], edges: [] };
  const parallel = { ...valid, nodes: [valid.nodes[0], { ...valid.nodes[0], nodeId: "parallel" }], edges: [] };
  for (const change of malformed) {
    const invalidDescriptors = { ...descriptors, actions: [{ ...descriptors.actions[0], ...change }, descriptors.actions[1]] };
    for (const program of [empty, { ...valid, nodes: [valid.nodes[0]], edges: [] }, parallel]) {
      let report;
      assert.doesNotThrow(() => { report = verifyActionProgram({ program, descriptors: invalidDescriptors, restrictivePolicy: policy }); });
      assert.equal(report.accepted, false);
      assert.ok(report.diagnostics.some((diagnostic) => diagnostic.code === "invalid_descriptor_projection"));
    }
  }
});

test("rejects malformed node fields without throwing", () => {
  const malformed = [
    { ...valid.nodes[0], args: null },
    { ...valid.nodes[0], args: [] },
    { ...valid.nodes[0], bindings: null },
    { ...valid.nodes[0], bindings: {} },
    { ...valid.nodes[0], guards: null },
    { ...valid.nodes[0], guards: {} },
  ];
  for (const node of malformed) {
    assert.doesNotThrow(() => verifyActionProgram({ program: { ...valid, nodes: [node] }, descriptors, restrictivePolicy: policy }));
  }
  assert.ok(codes({ ...valid, nodes: [{ ...valid.nodes[0], args: null }] }).includes("invalid_argument_shape"));
  assert.ok(codes({ ...valid, nodes: [{ ...valid.nodes[0], bindings: null }] }).includes("invalid_binding_bounds"));
  assert.ok(codes({ ...valid, nodes: [{ ...valid.nodes[0], guards: null }] }).includes("invalid_guard_bounds"));
});

test("rejects guards whose producer action is unknown without throwing", () => {
  const program = {
    ...valid,
    nodes: [
      { ...valid.nodes[0], nodeId: "unknown_producer", actionId: "unknown" },
      { ...valid.nodes[1], guards: [{ kind: "fact_present", nodeId: "unknown_producer", fact: "arrival", operator: null, value: null }] },
    ],
    edges: [{ from: "unknown_producer", to: "inspect" }],
  };
  assert.doesNotThrow(() => verifyActionProgram({ program, descriptors, restrictivePolicy: policy }));
  assert.ok(codes(program).includes("invalid_guard"));
});
