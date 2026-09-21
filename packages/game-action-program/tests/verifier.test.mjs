import test from "node:test";
import assert from "node:assert/strict";
import { jsonDepth, PROGRAM_LIMITS } from "../src/model.mjs";
import { verifyActionProgram } from "../src/verifier.mjs";

const descriptors = { schema: "gamebuddy-action-descriptors/v1", catalogRevision: 1, actions: [
  { actionId: "navigate_to_destination", identityVersion: 1, lifecycle: "published", kind: "execution", argumentSchema: { destination: { type: "destination_selector" } }, outputFacts: { arrival: "destination_arrival" }, resourceTemplate: { claims: [{ key: "embodied_actor", value: "ScopePlayer" }] }, effect: "write", postcondition: { name: "arrived" } },
  { actionId: "inspect_arrival", identityVersion: 1, lifecycle: "published", kind: "read_only", argumentSchema: { arrival: { type: "destination_arrival" } }, outputFacts: {}, resourceTemplate: { claims: [] }, effect: "read", postcondition: { name: "observed" } },
] };
const policy = { enabledActionIds: ["navigate_to_destination", "inspect_arrival"] };
const valid = { schema: "gamebuddy-action-program/v1", programId: "route_1", nodes: [
  { nodeId: "navigate", actionId: "navigate_to_destination", args: { destination: { kind: "label", label: "Town" } }, bindings: [], guards: [] },
  { nodeId: "inspect", actionId: "inspect_arrival", args: {}, bindings: [{ arg: "arrival", from: "navigate", fact: "arrival" }], guards: [{ kind: "fact_present", nodeId: "navigate", fact: "arrival", operator: null, value: null }] },
], edges: [{ from: "navigate", to: "inspect" }] };
function codes(program, selectedPolicy = policy) { return verifyActionProgram({ program, descriptors, restrictivePolicy: selectedPolicy }).diagnostics.map(x => x.code); }
test("typed destination selector and arrival enforce exact shapes on the wire", () => {
  // label selector requires a bounded label; ref selector requires a dr1_ ref
  for (const destination of [
    { kind: "label" },
    { kind: "label", label: "" },
    { kind: "label", label: "Town", ref: null },
    { kind: "ref" },
    { kind: "ref", ref: "not-a-ref" },
    { kind: "bogus", label: "Town" },
  ]) {
    const report = verifyActionProgram({ program: { ...valid, nodes: [{ ...valid.nodes[0], args: { destination } }] }, descriptors, restrictivePolicy: policy });
    assert.equal(report.accepted, false);
    assert.ok(report.diagnostics.some((entry) => entry.code === "argument_type_mismatch"), JSON.stringify({ destination, diagnostics: report.diagnostics }));
  }
  // valid label selector still passes (the shared valid program covers this)
  assert.equal(verifyActionProgram({ program: valid, descriptors, restrictivePolicy: policy }).accepted, true);
});

test("accepts descriptor-driven navigation DAG without action-name special handling", () => assert.equal(verifyActionProgram({ program: valid, descriptors, restrictivePolicy: policy }).accepted, true));
test("rejects structural, bounds, action-identity, schema, typing, graph/dependency, resource, guard, raw-field, and policy violations", () => {
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

test("circular hostile programs return a rejected report without throwing or unbounded traversal", () => {
  const selfReferencing = { schema: "gamebuddy-action-program/v1", programId: "circular", nodes: [], edges: [], self: null };
  selfReferencing.self = selfReferencing;
  let report;
  assert.doesNotThrow(() => { report = verifyActionProgram({ program: selfReferencing, descriptors, restrictivePolicy: policy }); });
  assert.equal(report.accepted, false);
  assert.ok(report.diagnostics.some((entry) => entry.code === "invalid_program_shape"));

  const circularArgs = { destination: null };
  circularArgs.destination = circularArgs;
  const exactShape = { ...valid, nodes: [{ ...valid.nodes[0], args: circularArgs }] };
  assert.doesNotThrow(() => { report = verifyActionProgram({ program: exactShape, descriptors, restrictivePolicy: policy }); });
  assert.equal(report.accepted, false);
  assert.ok(report.diagnostics.some((entry) => entry.code === "invalid_program_encoding"));
});

test("enumerable nested getter failures return a rejected report without traversing or freezing input", () => {
  const destination = { kind: "label" };
  Object.defineProperty(destination, "hostile", { enumerable: true, get() { throw new Error("hostile getter"); } });
  const program = { ...valid, nodes: [{ ...valid.nodes[0], args: { destination } }] };
  let report;
  assert.doesNotThrow(() => { report = verifyActionProgram({ program, descriptors, restrictivePolicy: policy }); });
  assert.equal(report.accepted, false);
  assert.ok(report.diagnostics.some((entry) => entry.code === "invalid_program_encoding"));
  assert.equal(report.normalizedProgram, null);
  assert.equal(Object.isFrozen(program), false);
  assert.equal(Object.isFrozen(program.nodes[0].args), false);
  assert.equal(Object.isFrozen(destination), false);
});

test("BigInt and non-canonical values fail the encoding gate instead of passing the size gate", () => {
  const cases = [
    { ...valid, nodes: [{ ...valid.nodes[0], args: { destination: 3n } }] },
    { ...valid, nodes: [{ ...valid.nodes[0], args: { destination: { kind: "label", compute() {} } } }] },
    { ...valid, nodes: [{ ...valid.nodes[0], args: { destination: { kind: "label", missing: undefined } } }] },
  ];
  for (const program of cases) {
    let report;
    assert.doesNotThrow(() => { report = verifyActionProgram({ program, descriptors, restrictivePolicy: policy }); });
    assert.equal(report.accepted, false);
    assert.ok(report.diagnostics.some((entry) => entry.code === "invalid_program_encoding"), JSON.stringify(report.diagnostics));
    assert.ok(!report.diagnostics.some((entry) => entry.code === "program_too_large"));
  }
});

test("report maps descriptor projection catalogRevision to descriptorRevision without a compatibility alias", () => {
  const report = verifyActionProgram({ program: valid, descriptors, restrictivePolicy: policy });
  assert.equal(report.descriptorRevision, descriptors.catalogRevision);
  assert.ok(!("catalogRevision" in report));
  assert.deepEqual(Object.keys(report), ["accepted", "descriptorRevision", "normalizedProgram", "diagnostics", "runtimeRequirements"]);
  const rejected = verifyActionProgram({ program: { ...valid, extra: true }, descriptors: { ...descriptors, catalogRevision: 7 }, restrictivePolicy: policy });
  assert.equal(rejected.descriptorRevision, 7);
});

test("the report is deeply frozen and detached from the caller's program, descriptors, and policy", () => {
  const program = { ...valid, nodes: valid.nodes.map((node) => ({ ...node, args: { ...node.args }, bindings: [...node.bindings], guards: [...node.guards] })), edges: [...valid.edges] };
  const localDescriptors = { ...descriptors, actions: descriptors.actions.map((action) => ({ ...action, argumentSchema: Object.fromEntries(Object.entries(action.argumentSchema).map(([key, entry]) => [key, { ...entry }])), outputFacts: { ...action.outputFacts }, resourceTemplate: { claims: action.resourceTemplate.claims.map((claim) => ({ ...claim })) } })) };
  const localPolicy = { enabledActionIds: [...policy.enabledActionIds] };
  const report = verifyActionProgram({ program, descriptors: localDescriptors, restrictivePolicy: localPolicy });
  assert.equal(report.accepted, true);
  assert.ok(Object.isFrozen(report));
  assert.ok(Object.isFrozen(report.diagnostics));
  assert.ok(report.diagnostics.every((entry) => Object.isFrozen(entry)));
  assert.ok(Object.isFrozen(report.runtimeRequirements));
  assert.ok(report.runtimeRequirements.every((entry) => Object.isFrozen(entry)));
  assert.equal(Object.isFrozen(report.normalizedProgram), true);
  assert.equal(Object.isFrozen(report.normalizedProgram.nodes[0]), true);
  assert.equal(Object.isFrozen(report.normalizedProgram.nodes[0].args), true);
  assert.equal(Object.isFrozen(report.normalizedProgram.nodes[0].args.destination), true);
  assert.equal(Object.isFrozen(report.normalizedProgram.nodes[1].bindings[0]), true);
  program.nodes[0].nodeId = "mutated";
  program.nodes.push({ ...program.nodes[0] });
  localDescriptors.actions.length = 0;
  localDescriptors.catalogRevision = 99;
  localPolicy.enabledActionIds = [];
  assert.equal(report.normalizedProgram.nodes[0].nodeId, "navigate");
  assert.equal(report.normalizedProgram.nodes.length, 2);
  assert.equal(report.descriptorRevision, 1);
  const rejected = verifyActionProgram({ program: { ...valid, extra: true }, descriptors: localDescriptors, restrictivePolicy: localPolicy });
  assert.equal(rejected.normalizedProgram, null);
});

test("diagnostics truncation is bounded, deterministic, sorted, and deeply frozen", () => {
  const overflowing = {
    schema: "gamebuddy-action-program/v1",
    programId: "overflow",
    nodes: Array.from({ length: PROGRAM_LIMITS.maxNodes }, (_, index) => ({
      nodeId: `n_${index}`,
      actionId: "navigate_to_destination",
      args: { destination: { kind: "label" } },
      bindings: Array.from({ length: 20 }, () => ({})),
      guards: [],
    })),
    edges: [],
  };
  const report = verifyActionProgram({ program: overflowing, descriptors, restrictivePolicy: policy });
  assert.equal(report.diagnostics.length, PROGRAM_LIMITS.maxDiagnostics + 1);
  assert.equal(report.diagnostics.at(-1).code, "diagnostics_truncated");
  const kept = report.diagnostics.slice(0, PROGRAM_LIMITS.maxDiagnostics);
  assert.ok(kept.every((entry) => entry.code !== "diagnostics_truncated"));
  assert.deepEqual(kept, [...kept].sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code) || String(a.nodeId).localeCompare(String(b.nodeId))));
  assert.ok(kept.every((entry) => entry.message.length <= 256));
  assert.ok(Object.isFrozen(report.diagnostics));
  assert.ok(report.diagnostics.every((entry) => Object.isFrozen(entry)));
});


test("rejects sparse program.nodes at the canonical encoding boundary", () => {
  const sparseNodes = new Array(1);
  const report = verifyActionProgram({ program: { ...valid, nodes: sparseNodes }, descriptors, restrictivePolicy: policy });
  assert.equal(report.accepted, false);
  assert.ok(report.diagnostics.some((entry) => entry.code === "invalid_program_encoding"));
  assert.equal(report.normalizedProgram, null);
});

test("rejects sparse nested arrays without accepting a sparse normalized program", () => {
  const nested = new Array(1);
  const program = {
    ...valid,
    nodes: [{ ...valid.nodes[0], args: { destination: { kind: "label", nested } } }],
    edges: [],
  };
  const report = verifyActionProgram({ program, descriptors, restrictivePolicy: policy });
  assert.equal(report.accepted, false);
  assert.ok(report.diagnostics.some((entry) => entry.code === "invalid_program_encoding"));
  assert.equal(report.normalizedProgram, null);
});

test("rejects enumerable custom array properties before structuredClone", () => {
  const nodes = [...valid.nodes];
  nodes.unexpected = () => {};
  let report;
  assert.doesNotThrow(() => {
    report = verifyActionProgram({ program: { ...valid, nodes }, descriptors, restrictivePolicy: policy });
  });
  assert.equal(report.accepted, false);
  assert.ok(report.diagnostics.some((entry) => entry.code === "invalid_program_encoding"));
  assert.equal(report.normalizedProgram, null);
});

test("accepts dense JSON arrays through canonical round-trip validation", () => {
  const report = verifyActionProgram({ program: valid, descriptors, restrictivePolicy: policy });
  assert.equal(report.accepted, true);
  assert.deepEqual(report.normalizedProgram.nodes, valid.nodes);
  assert.deepEqual(report.normalizedProgram.edges, valid.edges);
});

test("malformed object nodeId is normalized to null without freezing or aliasing caller input", () => {
  const nodeId = { toString() { return "hostile"; } };
  const program = { ...valid, nodes: [{ ...valid.nodes[0], nodeId }] };
  const report = verifyActionProgram({ program, descriptors, restrictivePolicy: policy });
  assert.equal(report.accepted, false);
  assert.equal(report.normalizedProgram, null);
  assert.ok(report.diagnostics.some((diagnostic) => diagnostic.code === "invalid_node_id" && diagnostic.nodeId === null));
  assert.ok(report.diagnostics.every((diagnostic) => typeof diagnostic.nodeId === "string" || diagnostic.nodeId === null));
  assert.equal(Object.isFrozen(nodeId), false);
  assert.equal(report.diagnostics.some((diagnostic) => diagnostic.nodeId === nodeId), false);
  assert.ok(Object.isFrozen(report));
  assert.ok(Object.isFrozen(report.diagnostics));
  assert.ok(report.diagnostics.every((diagnostic) => Object.isFrozen(diagnostic)));
});


test("hostile descriptor claim accessors reject verification without throwing", () => {
  const claim = {};
  Object.defineProperties(claim, {
    key: { enumerable: true, get() { throw new Error("hostile claim key"); } },
    value: { enumerable: true, value: "ScopePlayer" },
  });
  const hostileDescriptors = {
    ...descriptors,
    actions: [{ ...descriptors.actions[0], resourceTemplate: { claims: [claim] } }, descriptors.actions[1]],
  };

  let report;
  assert.doesNotThrow(() => {
    report = verifyActionProgram({ program: valid, descriptors: hostileDescriptors, restrictivePolicy: policy });
  });
  assert.equal(report.accepted, false);
  assert.ok(report.diagnostics.some((entry) => entry.code === "invalid_descriptor_projection"));
  assert.equal(report.normalizedProgram, null);
  assert.equal(Object.isFrozen(claim), false);
});

test("rejected reports detach a primitive descriptor revision without invoking hostile catalogRevision accessors", () => {
  let reads = 0;
  const hostileDescriptors = {};
  Object.defineProperties(hostileDescriptors, {
    schema: { enumerable: true, value: "gamebuddy-action-descriptors/v1" },
    catalogRevision: { enumerable: true, get() { reads += 1; throw new Error("hostile catalog revision"); } },
    actions: { enumerable: true, value: [] },
  });
  const program = { ...valid, extra: true };

  let report;
  assert.doesNotThrow(() => {
    report = verifyActionProgram({ program, descriptors: hostileDescriptors, restrictivePolicy: policy });
  });
  assert.equal(report.accepted, false);
  assert.equal(report.descriptorRevision, null);
  assert.ok(!("catalogRevision" in report));
  assert.equal(reads, 0);
  assert.ok(Object.isFrozen(report));
  assert.ok(Object.isFrozen(report.diagnostics));
});


const guardDescriptors = { schema: "gamebuddy-action-descriptors/v1", catalogRevision: 11, actions: [
  { actionId: "produce_facts", identityVersion: 1, lifecycle: "published", kind: "read_only", argumentSchema: {}, outputFacts: { text: "string", count: "integer", enabled: "boolean", payload: "object" }, resourceTemplate: { claims: [] }, effect: "read", postcondition: { name: "facts_observed" } },
  { actionId: "consume_facts", identityVersion: 1, lifecycle: "published", kind: "read_only", argumentSchema: {}, outputFacts: {}, resourceTemplate: { claims: [] }, effect: "read", postcondition: { name: "facts_consumed" } },
  { actionId: "no_facts", identityVersion: 1, lifecycle: "published", kind: "read_only", argumentSchema: {}, outputFacts: {}, resourceTemplate: { claims: [] }, effect: "read", postcondition: { name: "completed" } },
  { actionId: "needs_target", identityVersion: 1, lifecycle: "published", kind: "read_only", argumentSchema: { target: { type: "object" } }, outputFacts: {}, resourceTemplate: { claims: [] }, effect: "read", postcondition: { name: "target_consumed" } },
] };
const guardPolicy = { enabledActionIds: guardDescriptors.actions.map(({ actionId }) => actionId) };
function guardProgram(guards = []) {
  return { schema: "gamebuddy-action-program/v1", programId: "guard_cases", nodes: [
    { nodeId: "producer", actionId: "produce_facts", args: {}, bindings: [], guards: [] },
    { nodeId: "consumer", actionId: "consume_facts", args: {}, bindings: [], guards },
  ], edges: [{ from: "producer", to: "consumer" }] };
}
function guardReport(guard) {
  return verifyActionProgram({ program: guardProgram([guard]), descriptors: guardDescriptors, restrictivePolicy: guardPolicy });
}
function assertInvalidGuard(guard, message = "Guard must reference a dominant declared fact or terminal node state.") {
  const report = guardReport(guard);
  assert.equal(report.accepted, false);
  assert.equal(report.normalizedProgram, null);
  assert.deepEqual(report.diagnostics.filter(({ code }) => code === "invalid_guard"), [{
    severity: "error",
    code: "invalid_guard",
    nodeId: "consumer",
    path: "/nodes/1/guards/0",
    message,
  }]);
  return report;
}
test("accepts each finite v1 guard form, including object presence and a no-fact producer terminal", () => {
  assert.equal(guardReport({ kind: "fact_present", nodeId: "producer", fact: "payload", operator: null, value: null }).accepted, true);
  assert.equal(guardReport({ kind: "fact_equals", nodeId: "producer", fact: "text", operator: null, value: "hello" }).accepted, true);
  assert.equal(guardReport({ kind: "node_succeeded", nodeId: "producer", fact: null, operator: null, value: null }).accepted, true);

  const noFactProgram = {
    schema: "gamebuddy-action-program/v1",
    programId: "no_fact_terminal",
    nodes: [
      { nodeId: "no_fact", actionId: "no_facts", args: {}, bindings: [], guards: [] },
      { nodeId: "after_no_fact", actionId: "consume_facts", args: {}, bindings: [], guards: [{ kind: "node_succeeded", nodeId: "no_fact", fact: null, operator: null, value: null }] },
    ],
    edges: [{ from: "no_fact", to: "after_no_fact" }],
  };
  assert.equal(verifyActionProgram({ program: noFactProgram, descriptors: guardDescriptors, restrictivePolicy: guardPolicy }).accepted, true);
});
test("accepts string, safe-integer, and boolean equality, including empty string, zero, and false", () => {
  for (const [fact, value] of [["text", ""], ["count", 0], ["enabled", false]]) {
    assert.equal(guardReport({ kind: "fact_equals", nodeId: "producer", fact, operator: null, value }).accepted, true, `${fact} equality should be accepted`);
  }
});
test("accepts descriptor-valid long string fact equality within global program bounds", () => {
  const value = "descriptor-owned-".repeat(300);
  const program = guardProgram([{ kind: "fact_equals", nodeId: "producer", fact: "text", operator: null, value }]);
  const encodedBytes = new TextEncoder().encode(JSON.stringify(program)).byteLength;
  const report = verifyActionProgram({ program, descriptors: guardDescriptors, restrictivePolicy: guardPolicy });
  assert.equal(value.length, 5100);
  assert.ok(encodedBytes < PROGRAM_LIMITS.maxUtf8Bytes);
  assert.ok(jsonDepth(program) <= PROGRAM_LIMITS.maxJsonDepth);
  assert.equal(report.accepted, true, JSON.stringify(report.diagnostics));
});
test("accepts guards against transitive ancestors and rejects missing argument bindings", () => {
  const program = {
    schema: "gamebuddy-action-program/v1",
    programId: "transitive_guard",
    nodes: [
      { nodeId: "producer", actionId: "produce_facts", args: {}, bindings: [], guards: [] },
      { nodeId: "middle", actionId: "consume_facts", args: {}, bindings: [], guards: [] },
      { nodeId: "consumer", actionId: "consume_facts", args: {}, bindings: [], guards: [{ kind: "fact_present", nodeId: "producer", fact: "payload", operator: null, value: null }, { kind: "node_succeeded", nodeId: "producer", fact: null, operator: null, value: null }] },
    ],
    edges: [{ from: "producer", to: "middle" }, { from: "middle", to: "consumer" }],
  };
  assert.equal(verifyActionProgram({ program, descriptors: guardDescriptors, restrictivePolicy: guardPolicy }).accepted, true);

  const missingBinding = {
    ...program,
    programId: "missing_binding",
    nodes: [{ ...program.nodes[0] }, { nodeId: "consumer", actionId: "needs_target", args: {}, bindings: [], guards: [] }],
    edges: [{ from: "producer", to: "consumer" }],
  };
  const report = verifyActionProgram({ program: missingBinding, descriptors: guardDescriptors, restrictivePolicy: guardPolicy });
  assert.equal(report.accepted, false);
  assert.ok(report.diagnostics.some(({ code, path }) => code === "argument_schema_mismatch" && path === "/nodes/1/args"));
  assert.equal(report.normalizedProgram, null);
});
test("rejects malformed guard combinations with stable invalid_guard path and node identity", () => {
  const malformed = [
    { kind: "fact_present", nodeId: "producer", fact: "text", operator: "equals", value: null },
    { kind: "fact_present", nodeId: "producer", fact: "text", operator: null, value: "" },
    { kind: "fact_equals", nodeId: "producer", fact: "text", operator: null, value: null },
    { kind: "fact_equals", nodeId: "producer", fact: "text", operator: "equals", value: "hello" },
    { kind: "node_succeeded", nodeId: "producer", fact: "text", operator: null, value: null },
    { kind: "node_succeeded", nodeId: "producer", fact: null, operator: "equals", value: null },
    { kind: "node_succeeded", nodeId: "producer", fact: null, operator: null, value: false },
  ];
  for (const guard of malformed) assertInvalidGuard(guard);
});
test("rejects guards with invalid, missing, or extra keys", () => {
  const shapeMessage = "Guard is not a finite v1 guard.";
  assertInvalidGuard({ kind: "fact_present", nodeId: "producer", fact: "text", operator: null }, shapeMessage);
  assertInvalidGuard({ kind: "fact_present", nodeId: "producer", fact: "text", operator: null, value: null, extra: true }, shapeMessage);
  assertInvalidGuard({ kind: "fact_present", nodeId: "producer", fact: "text", operator: null, value: null, extra: undefined }, shapeMessage);
});
test("rejects unknown, self, descendant, unrelated, non-declared, and inherited fact or node references", () => {
  assertInvalidGuard({ kind: "fact_present", nodeId: "missing", fact: "text", operator: null, value: null });
  assertInvalidGuard({ kind: "fact_present", nodeId: "consumer", fact: "text", operator: null, value: null });
  assertInvalidGuard({ kind: "fact_present", nodeId: "producer", fact: "missing_fact", operator: null, value: null });
  assertInvalidGuard({ kind: "fact_present", nodeId: "producer", fact: "toString", operator: null, value: null });
  assertInvalidGuard({ kind: "fact_present", nodeId: "producer", fact: "a", operator: null, value: null });
  assertInvalidGuard({ kind: "fact_present", nodeId: "a", fact: "text", operator: null, value: null }, "Guard is not a finite v1 guard.");

  const descendant = {
    schema: "gamebuddy-action-program/v1",
    programId: "descendant_guard",
    nodes: [
      { nodeId: "producer", actionId: "produce_facts", args: {}, bindings: [], guards: [] },
      { nodeId: "consumer", actionId: "consume_facts", args: {}, bindings: [], guards: [{ kind: "fact_present", nodeId: "descendant", fact: "text", operator: null, value: null }] },
      { nodeId: "descendant", actionId: "consume_facts", args: {}, bindings: [], guards: [] },
    ],
    edges: [{ from: "producer", to: "consumer" }, { from: "consumer", to: "descendant" }],
  };
  const descendantReport = verifyActionProgram({ program: descendant, descriptors: guardDescriptors, restrictivePolicy: guardPolicy });
  assert.equal(descendantReport.accepted, false);
  assert.ok(descendantReport.diagnostics.some(({ code, path, nodeId }) => code === "invalid_guard" && path === "/nodes/1/guards/0" && nodeId === "consumer"));

  const unrelated = {
    schema: "gamebuddy-action-program/v1",
    programId: "unrelated_guard",
    nodes: [
      { nodeId: "producer", actionId: "produce_facts", args: {}, bindings: [], guards: [] },
      { nodeId: "unrelated", actionId: "produce_facts", args: {}, bindings: [], guards: [] },
      { nodeId: "consumer", actionId: "consume_facts", args: {}, bindings: [], guards: [{ kind: "fact_present", nodeId: "unrelated", fact: "text", operator: null, value: null }] },
    ],
    edges: [{ from: "producer", to: "consumer" }],
  };
  const report = verifyActionProgram({ program: unrelated, descriptors: guardDescriptors, restrictivePolicy: guardPolicy });
  assert.equal(report.accepted, false);
  assert.ok(report.diagnostics.some(({ code, path, nodeId }) => code === "invalid_guard" && path === "/nodes/2/guards/0" && nodeId === "consumer"));

  const invalidNodeId = guardReport({ kind: "node_succeeded", nodeId: "not-a-node", fact: null, operator: null, value: null });
  assert.equal(invalidNodeId.diagnostics[0].code, "invalid_guard");
});
test("rejects object, array, null, and floating-point equality values", () => {
  for (const value of [{}, [], null, 1.5]) {
    assertInvalidGuard({ kind: "fact_equals", nodeId: "producer", fact: "text", operator: null, value });
  }
  assertInvalidGuard({ kind: "fact_equals", nodeId: "producer", fact: "payload", operator: null, value: {} });
  assertInvalidGuard({ kind: "fact_equals", nodeId: "producer", fact: "count", operator: null, value: 1.5 });
});
test("accepts empty, multi-sink, and no-guard DAGs without terminality rules", () => {
  const empty = { schema: "gamebuddy-action-program/v1", programId: "empty_guard_dag", nodes: [], edges: [] };
  assert.equal(verifyActionProgram({ program: empty, descriptors: guardDescriptors, restrictivePolicy: guardPolicy }).accepted, true);

  const multiSink = {
    schema: "gamebuddy-action-program/v1",
    programId: "multi_sink_guard_dag",
    nodes: [
      { nodeId: "root", actionId: "produce_facts", args: {}, bindings: [], guards: [] },
      { nodeId: "left", actionId: "consume_facts", args: {}, bindings: [], guards: [] },
      { nodeId: "right", actionId: "consume_facts", args: {}, bindings: [], guards: [] },
    ],
    edges: [{ from: "root", to: "left" }, { from: "root", to: "right" }],
  };
  assert.equal(verifyActionProgram({ program: multiSink, descriptors: guardDescriptors, restrictivePolicy: guardPolicy }).accepted, true);

  assert.equal(verifyActionProgram({ program: guardProgram(), descriptors: guardDescriptors, restrictivePolicy: guardPolicy }).accepted, true);
});
test("accepted and rejected reports expose only the frozen runtime requirements and no runtime authority claim", () => {
  const expected = ["fresh_mod_admission", "descriptor_derived_resources", "live_postcondition", "stop_epoch"];
  const accepted = verifyActionProgram({ program: guardProgram(), descriptors: guardDescriptors, restrictivePolicy: guardPolicy });
  const rejected = guardReport({ kind: "fact_equals", nodeId: "producer", fact: "text", operator: "equals", value: "hello" });
  for (const report of [accepted, rejected]) {
    assert.deepEqual(report.runtimeRequirements, expected);
    assert.ok(Object.isFrozen(report.runtimeRequirements));
    assert.ok(report.runtimeRequirements.every((requirement) => Object.isFrozen(requirement)));
    assert.deepEqual(Object.keys(report), ["accepted", "descriptorRevision", "normalizedProgram", "diagnostics", "runtimeRequirements"]);
    assert.equal(Object.hasOwn(report, "requestId"), false);
    assert.equal(Object.hasOwn(report, "executionId"), false);
    assert.equal(Object.hasOwn(report, "authority"), false);
  }
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.normalizedProgram, null);
});
