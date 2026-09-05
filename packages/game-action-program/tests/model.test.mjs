import test from "node:test";
import assert from "node:assert/strict";
import { ACTION_PROGRAM_SCHEMA, PROGRAM_LIMITS, hasExactKeys, jsonDepth } from "../src/model.mjs";
test("v1 model exposes frozen protocol limits and exact-key helper", () => { assert.equal(ACTION_PROGRAM_SCHEMA, "gamebuddy-action-program/v1"); assert.equal(PROGRAM_LIMITS.maxNodes, 16); assert.equal(hasExactKeys({ schema: 1, programId: 1, nodes: [], edges: [] }, new Set(["schema", "programId", "nodes", "edges"])), true); assert.equal(jsonDepth({ a: { b: 1 } }), 3); });
