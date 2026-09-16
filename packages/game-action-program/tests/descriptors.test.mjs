import test from "node:test";
import assert from "node:assert/strict";
import { descriptorMap, validateDescriptorProjection } from "../src/descriptors.mjs";
import { verifyActionProgram } from "../src/verifier.mjs";

test("empty descriptor projections validate and expose a frozen read-only empty map", () => {
  const projection = {
    schema: "gamebuddy-action-descriptors/v1",
    catalogRevision: 1,
    actions: [],
  };

  assert.equal(validateDescriptorProjection(projection), true);

  const map = descriptorMap(projection);
  assert.ok(map instanceof Map);
  assert.equal(map.size, 0);
  assert.deepEqual([...map], []);
  assert.ok(Object.isFrozen(map));
  assert.throws(() => map.set("move_to_tile", {}), {
    name: "TypeError",
    message: "descriptor_map_read_only",
  });
});

function validDescriptor(overrides = {}) {
  return {
    actionId: "move_to_tile",
    identityVersion: 1,
    lifecycle: "published",
    kind: "execution",
    argumentSchema: { destination: { type: "object" } },
    outputFacts: { arrival: "object" },
    resourceTemplate: { claims: [{ key: "embodied_actor", value: "ScopePlayer" }] },
    effect: "write",
    postcondition: { name: "arrived" },
    ...overrides,
  };
}

function validProjection(actionOverrides = {}) {
  return {
    schema: "gamebuddy-action-descriptors/v1",
    catalogRevision: 1,
    actions: [validDescriptor(actionOverrides)],
  };
}

function defineNonEnumerableDataProperty(object, key, value = object[key]) {
  Object.defineProperty(object, key, {
    configurable: true,
    enumerable: false,
    value,
    writable: true,
  });
  return object;
}

test("descriptor maps preserve read lookup semantics while blocking prototype mutator bypass", () => {
  const projection = validProjection();
  const map = descriptorMap(projection);

  assert.ok(map instanceof Map);
  assert.equal(map.size, 1);
  assert.equal(map.has("move_to_tile"), true);
  assert.equal(map.has("forged"), false);
  assert.deepEqual([...map.keys()], ["move_to_tile"]);
  assert.deepEqual([...map.entries()].map(([key]) => key), ["move_to_tile"]);
  assert.deepEqual([...map].map(([key]) => key), ["move_to_tile"]);
  assert.equal([...map.values()][0].postcondition.name, "arrived");
  assert.equal(map.get("move_to_tile").argumentSchema.destination.type, "object");
  assert.ok(Object.isFrozen(map.get("move_to_tile")));
  assert.equal(map.get("missing"), undefined);

  const visited = [];
  map.forEach((descriptor, actionId, owner) => visited.push([actionId, descriptor.postcondition.name, owner === map]));
  assert.deepEqual(visited, [["move_to_tile", "arrived", true]]);

  assert.throws(() => map.set("forged", {}), { name: "TypeError", message: "descriptor_map_read_only" });
  assert.throws(() => map.delete("move_to_tile"), { name: "TypeError", message: "descriptor_map_read_only" });
  assert.throws(() => map.clear(), { name: "TypeError", message: "descriptor_map_read_only" });
  assert.throws(() => Map.prototype.set.call(map, "forged", {}), { name: "TypeError" });
  assert.throws(() => Map.prototype.delete.call(map, "move_to_tile"), { name: "TypeError" });
  assert.throws(() => Map.prototype.clear.call(map), { name: "TypeError" });
  assert.equal(map.has("forged"), false);
  assert.equal(map.has("move_to_tile"), true);
  assert.equal(map.size, 1);
});

test("empty descriptor maps reject prototype mutator bypass without publishing forged actions", () => {
  const projection = {
    schema: "gamebuddy-action-descriptors/v1",
    catalogRevision: 1,
    actions: [],
  };
  const map = descriptorMap(projection);

  assert.throws(() => Map.prototype.set.call(map, "forged", {}), { name: "TypeError" });
  assert.equal(map.has("forged"), false);
  assert.equal(map.size, 0);
  assert.deepEqual([...map], []);
});

test("non-enumerable resource claim key and value fields fail closed before detached cloning", () => {
  for (const field of ["key", "value"]) {
    const claim = { key: "embodied_actor", value: "ScopePlayer" };
    defineNonEnumerableDataProperty(claim, field);
    const projection = validProjection({ resourceTemplate: { claims: [claim] } });

    assert.doesNotThrow(() => validateDescriptorProjection(projection));
    assert.equal(validateDescriptorProjection(projection), false);
    assert.doesNotThrow(() => descriptorMap(projection));
    assert.equal(descriptorMap(projection), null);
    assert.equal(Object.isFrozen(projection), false);
    assert.equal(Object.isFrozen(projection.actions[0]), false);
    assert.equal(Object.isFrozen(projection.actions[0].resourceTemplate), false);
    assert.equal(Object.isFrozen(claim), false);
    assert.equal(projection.actions[0].resourceTemplate.claims[0], claim);
  }
});

test("non-enumerable argumentSchema fields produce a rejected verifier report before descriptor cloning", () => {
  const descriptor = validDescriptor();
  const argumentSchema = descriptor.argumentSchema;
  defineNonEnumerableDataProperty(descriptor, "argumentSchema", argumentSchema);
  const projection = {
    schema: "gamebuddy-action-descriptors/v1",
    catalogRevision: 1,
    actions: [descriptor],
  };
  const program = {
    schema: "gamebuddy-action-program/v1",
    programId: "descriptor_rejection",
    nodes: [],
    edges: [],
  };

  let report;
  assert.doesNotThrow(() => {
    report = verifyActionProgram({
      program,
      descriptors: projection,
      restrictivePolicy: { enabledActionIds: [] },
    });
  });
  assert.equal(report.accepted, false);
  assert.ok(report.diagnostics.some((entry) => entry.code === "invalid_descriptor_projection"));
  assert.equal(report.normalizedProgram, null);
  assert.equal(validateDescriptorProjection(projection), false);
  assert.equal(descriptorMap(projection), null);
  assert.equal(Object.isFrozen(projection), false);
  assert.equal(Object.isFrozen(descriptor), false);
  assert.equal(Object.isFrozen(argumentSchema), false);
  assert.equal(Object.isFrozen(argumentSchema.destination), false);
});

test("hostile descriptor accessors fail closed without throwing, freezing, or aliasing caller data", () => {
  const throwingClaim = {};
  Object.defineProperties(throwingClaim, {
    key: { enumerable: true, get() { throw new Error("hostile claim key"); } },
    value: { enumerable: true, value: "ScopePlayer" },
  });
  const throwingArgumentEntry = {};
  Object.defineProperty(throwingArgumentEntry, "type", { enumerable: true, get() { throw new Error("hostile argument type"); } });
  const throwingFacts = {};
  Object.defineProperty(throwingFacts, "arrival", { enumerable: true, get() { throw new Error("hostile output fact"); } });
  const throwingPostcondition = {};
  Object.defineProperty(throwingPostcondition, "name", { enumerable: true, get() { throw new Error("hostile postcondition"); } });

  const projections = [
    validProjection({ resourceTemplate: { claims: [throwingClaim] } }),
    validProjection({ argumentSchema: { destination: throwingArgumentEntry } }),
    validProjection({ outputFacts: throwingFacts }),
    validProjection({ postcondition: throwingPostcondition }),
  ];

  for (const projection of projections) {
    assert.doesNotThrow(() => validateDescriptorProjection(projection));
    assert.equal(validateDescriptorProjection(projection), false);
    assert.doesNotThrow(() => descriptorMap(projection));
    assert.equal(descriptorMap(projection), null);
    assert.equal(Object.isFrozen(projection), false);
    assert.equal(Object.isFrozen(projection.actions), false);
    assert.equal(Object.isFrozen(projection.actions[0]), false);
  }
  assert.equal(Object.isFrozen(throwingClaim), false);
  assert.equal(Object.isFrozen(throwingArgumentEntry), false);
  assert.equal(Object.isFrozen(throwingFacts), false);
  assert.equal(Object.isFrozen(throwingPostcondition), false);
});
