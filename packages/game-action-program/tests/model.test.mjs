import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTION_PROGRAM_SCHEMA, ACTION_IDENTIFIER,
  PROGRAM_LIMITS, PROGRAM_KEYS, NODE_KEYS, GUARD_KEYS,
  isPlainDataObject, hasExactKeys, jsonDepth, canonicalStringify, utf8Bytes, deepFreeze,
} from "../src/model.mjs";

test("v1 protocol limits are frozen and match the ADR-006 contract", () => {
  assert.equal(ACTION_PROGRAM_SCHEMA, "gamebuddy-action-program/v1");
  assert.ok(Object.isFrozen(PROGRAM_LIMITS));
  assert.throws(() => { PROGRAM_LIMITS.maxNodes = 99; }, TypeError);
  assert.equal(PROGRAM_LIMITS.maxUtf8Bytes, 12_288);
  assert.equal(PROGRAM_LIMITS.maxNodes, 16);
  assert.equal(PROGRAM_LIMITS.maxEdges, 32);
  assert.equal(PROGRAM_LIMITS.maxGuardsPerNode, 4);
  assert.equal(PROGRAM_LIMITS.maxGuards, 32);
  assert.equal(PROGRAM_LIMITS.maxBindingsPerNode, 4);
  assert.equal(PROGRAM_LIMITS.maxBindings, 32);
  assert.equal(PROGRAM_LIMITS.maxDegree, 8);
  assert.equal(PROGRAM_LIMITS.maxJsonDepth, 16);
  assert.equal(PROGRAM_LIMITS.maxDiagnostics, 64);
  assert.equal(PROGRAM_LIMITS.maxActions, 128);
  assert.equal(PROGRAM_LIMITS.maxArgumentCount, 32);
  assert.equal(PROGRAM_LIMITS.maxFactCount, 32);
  assert.equal(PROGRAM_LIMITS.maxResourceClaims, 16);
  assert.equal(PROGRAM_LIMITS.maxStringLength, 128);
});

test("ACTION_IDENTIFIER is the single bounded identifier spelling", () => {
  assert.match("node_1", ACTION_IDENTIFIER);
  assert.match("a".repeat(128), ACTION_IDENTIFIER);
  assert.doesNotMatch("a", ACTION_IDENTIFIER);
  assert.doesNotMatch("1node", ACTION_IDENTIFIER);
  assert.doesNotMatch("node-1", ACTION_IDENTIFIER);
  assert.doesNotMatch("", ACTION_IDENTIFIER);
  assert.doesNotMatch("a".repeat(129), ACTION_IDENTIFIER);
});

test("hasExactKeys is strict and safe for hostile values", () => {
  assert.equal(hasExactKeys({ schema: 1, programId: 1, nodes: [], edges: [] }, PROGRAM_KEYS), true);
  assert.equal(hasExactKeys({ schema: 1, programId: 1, nodes: [] }, PROGRAM_KEYS), false);
  assert.equal(hasExactKeys({ schema: 1, programId: 1, nodes: [], edges: [], extra: 1 }, PROGRAM_KEYS), false);
  const withSymbol = { schema: 1, programId: 1, nodes: [], edges: [] };
  withSymbol[Symbol("extra")] = 1;
  assert.equal(hasExactKeys(withSymbol, PROGRAM_KEYS), false);
  const withHidden = { schema: 1, programId: 1, nodes: [], edges: [] };
  Object.defineProperty(withHidden, "hidden", { value: 1 });
  assert.equal(hasExactKeys(withHidden, PROGRAM_KEYS), false);
  const withBombGetter = { schema: 1, programId: 1, nodes: [], edges: [] };
  Object.defineProperty(withBombGetter, "boom", { enumerable: true, get() { throw new Error("key must not be read"); } });
  assert.equal(hasExactKeys(withBombGetter, PROGRAM_KEYS), false);
  assert.equal(hasExactKeys(JSON.parse('{"schema":"s","programId":"p","nodes":[],"edges":[],"__proto__":1}'), PROGRAM_KEYS), false);
  assert.equal(hasExactKeys(Object.create(null), PROGRAM_KEYS), false);
  assert.equal(hasExactKeys([], new Set()), false);
  assert.equal(hasExactKeys(null, PROGRAM_KEYS), false);
  assert.equal(hasExactKeys("text", PROGRAM_KEYS), false);
  assert.equal(hasExactKeys({ nodeId: "n1", actionId: "a1", args: {}, bindings: [], guards: [] }, NODE_KEYS), true);
  assert.equal(hasExactKeys({ kind: "fact_present", nodeId: "n1", fact: "f", operator: null, value: null }, GUARD_KEYS), true);
});

test("jsonDepth is bounded and reports over-limit depth without stack overflow", () => {
  assert.equal(jsonDepth({ a: { b: 1 } }), 3);
  assert.equal(jsonDepth({}), 1);
  assert.equal(jsonDepth(null), 1);
  assert.equal(jsonDepth("text"), 1);
  assert.equal(jsonDepth({ a: { b: {} } }, 2), 3);
  assert.equal(jsonDepth({ a: { b: 1 } }, 3), 3);
  const atLimit = {};
  let cursor = atLimit;
  for (let level = 1; level < PROGRAM_LIMITS.maxJsonDepth; level += 1) { cursor.child = {}; cursor = cursor.child; }
  assert.equal(jsonDepth(atLimit), PROGRAM_LIMITS.maxJsonDepth);
  const overLimit = {};
  cursor = overLimit;
  for (let level = 0; level <= PROGRAM_LIMITS.maxJsonDepth; level += 1) { cursor.child = {}; cursor = cursor.child; }
  assert.ok(jsonDepth(overLimit) > PROGRAM_LIMITS.maxJsonDepth);
  const circular = {};
  circular.self = circular;
  assert.doesNotThrow(() => assert.ok(jsonDepth(circular) > PROGRAM_LIMITS.maxJsonDepth));
  const circularArray = [];
  circularArray.push(circularArray);
  assert.doesNotThrow(() => assert.ok(jsonDepth(circularArray) > PROGRAM_LIMITS.maxJsonDepth));
  assert.doesNotThrow(() => assert.ok(jsonDepth(circular, NaN) > PROGRAM_LIMITS.maxJsonDepth));
  assert.doesNotThrow(() => assert.ok(jsonDepth(circular, Infinity) > PROGRAM_LIMITS.maxJsonDepth));
});

test("canonicalStringify and utf8Bytes fail closed without throwing", () => {
  const plain = { schema: ACTION_PROGRAM_SCHEMA, programId: "p1", nodes: [], edges: [] };
  assert.equal(canonicalStringify(plain), JSON.stringify(plain));
  assert.equal(utf8Bytes(plain), new TextEncoder().encode(canonicalStringify(plain)).byteLength);
  const circular = {};
  circular.self = circular;
  assert.doesNotThrow(() => assert.equal(canonicalStringify(circular), null));
  assert.doesNotThrow(() => assert.equal(utf8Bytes(circular), 0));
  assert.doesNotThrow(() => assert.equal(canonicalStringify(3n), null));
  assert.doesNotThrow(() => assert.equal(utf8Bytes(3n), 0));
  assert.doesNotThrow(() => assert.equal(canonicalStringify(undefined), null));
  assert.doesNotThrow(() => assert.equal(utf8Bytes(undefined), 0));
  const withBombGetter = { get value() { throw new Error("boom"); } };
  assert.doesNotThrow(() => assert.equal(canonicalStringify(withBombGetter), null));
  assert.doesNotThrow(() => assert.equal(utf8Bytes(withBombGetter), 0));
});

test("deepFreeze recursively freezes nested values without throwing or touching unrelated objects", () => {
  const frozen = deepFreeze({ a: { b: [1, { c: "x" }] }, d: "y" });
  assert.deepEqual(frozen, { a: { b: [1, { c: "x" }] }, d: "y" });
  assert.ok(Object.isFrozen(frozen));
  assert.ok(Object.isFrozen(frozen.a));
  assert.ok(Object.isFrozen(frozen.a.b));
  assert.ok(Object.isFrozen(frozen.a.b[1]));
  assert.equal(deepFreeze(null), null);
  assert.equal(deepFreeze("text"), "text");
  assert.equal(deepFreeze(42), 42);
  assert.equal(deepFreeze(undefined), undefined);
  assert.doesNotThrow(() => deepFreeze(3n));
  const unrelated = { untouched: true };
  deepFreeze({ other: 1 });
  assert.equal(Object.isFrozen(unrelated), false);
  const shared = { value: 1 };
  const withShared = deepFreeze({ first: shared, second: shared });
  assert.equal(withShared.first, withShared.second);
  assert.ok(Object.isFrozen(shared));
  const self = {};
  self.self = self;
  assert.doesNotThrow(() => deepFreeze(self));
  assert.ok(Object.isFrozen(self));
});

test("model helpers never throw on hostile plain-data inputs", () => {
  const hostile = [
    null, undefined, true, 42, "text", 3n, Symbol("s"), () => {},
    Object.create(null), [], [[]], { a: { b: [1, { c: 2 }] } },
  ];
  const deep = {};
  let cursor = deep;
  for (let level = 0; level < 64; level += 1) { cursor.next = {}; cursor = cursor.next; }
  hostile.push(deep);
  for (const input of hostile) {
    assert.doesNotThrow(() => isPlainDataObject(input));
    assert.doesNotThrow(() => hasExactKeys(input, PROGRAM_KEYS));
    assert.doesNotThrow(() => jsonDepth(input));
    assert.doesNotThrow(() => canonicalStringify(input));
    assert.doesNotThrow(() => utf8Bytes(input));
    assert.doesNotThrow(() => deepFreeze(input));
  }
  const ring = {};
  ring.next = ring;
  assert.doesNotThrow(() => isPlainDataObject(ring));
  assert.doesNotThrow(() => hasExactKeys(ring, PROGRAM_KEYS));
  assert.doesNotThrow(() => assert.ok(jsonDepth(ring) > PROGRAM_LIMITS.maxJsonDepth));
  assert.doesNotThrow(() => assert.equal(canonicalStringify(ring), null));
  assert.doesNotThrow(() => assert.equal(utf8Bytes(ring), 0));
  assert.doesNotThrow(() => deepFreeze(ring));
});

test("model limits are the verifier's gates end to end (producer → consumer → verifier)", async () => {
  const { verifyActionProgram } = await import("../src/verifier.mjs");
  const descriptors = { schema: "gamebuddy-action-descriptors/v1", catalogRevision: 1, actions: [] };
  const restrictivePolicy = { enabledActionIds: [] };
  const run = (program) => verifyActionProgram({ program, descriptors, restrictivePolicy });
  const padded = (padLength) => ({ schema: ACTION_PROGRAM_SCHEMA, programId: `x_${"a".repeat(padLength)}`, nodes: [], edges: [] });
  let padLength = 0;
  while (utf8Bytes(padded(padLength + 1)) <= PROGRAM_LIMITS.maxUtf8Bytes) padLength += 1;
  const atLimit = padded(padLength);
  const overLimit = padded(padLength + 1);
  assert.equal(utf8Bytes(atLimit), new TextEncoder().encode(canonicalStringify(atLimit)).byteLength);
  assert.equal(utf8Bytes(overLimit), utf8Bytes(atLimit) + 1);
  assert.ok(utf8Bytes(atLimit) <= PROGRAM_LIMITS.maxUtf8Bytes);
  assert.ok(utf8Bytes(overLimit) > PROGRAM_LIMITS.maxUtf8Bytes);
  assert.ok(!run(atLimit).diagnostics.some((entry) => entry.code === "program_too_large"));
  assert.ok(run(overLimit).diagnostics.some((entry) => entry.code === "program_too_large"));
  const validEmpty = { schema: ACTION_PROGRAM_SCHEMA, programId: "link_check", nodes: [], edges: [] };
  assert.equal(run(validEmpty).accepted, true);
});