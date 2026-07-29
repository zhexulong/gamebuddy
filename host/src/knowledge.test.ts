import assert from "node:assert/strict";
import test from "node:test";
import { decideCapability, formatExecutionForPlayer, type KnowledgeBundle } from "./knowledge.js";

const snapshot = { revision: 4, location: "Farm", tile: { x: 1, y: 2 }, stamina: 100, health: 100, actionable: true, capabilities: ["move_to_tile"], activeExecution: null } as const;
const bundle: KnowledgeBundle = { bundleVersion: 1, integrationId: "stardew", gameVersion: "1.6.15", rules: [{ id: "move-v1", integrationId: "stardew", gameVersion: "1.6.15", capability: "move_to_tile", text: "Movement needs a fresh actionable snapshot." }] };

test("knowledge remains versioned advice and cannot override live capability facts", () => {
  assert.equal(decideCapability(bundle, snapshot, "move_to_tile", "1.6.15").kind, "supported");
  assert.deepEqual(decideCapability(bundle, snapshot, "move_to_tile", "different").reasonCode, "knowledge_bundle_not_applicable");
  assert.deepEqual(decideCapability(bundle, { ...snapshot, capabilities: [] }, "move_to_tile", "1.6.15").reasonCode, "capability_not_declared");
});

test("execution presentation never calls acceptance or unsupported success a completion", () => {
  assert.match(formatExecutionForPlayer({ executionId: "execution_01", requestId: "request_01", state: "accepted", reasonCode: "accepted", revision: 1, evidence: null }), /尚未完成/);
  assert.match(formatExecutionForPlayer({ executionId: "execution_01", requestId: "request_01", state: "succeeded", reasonCode: "postcondition", revision: 2, evidence: { detail: "target" } }), /已完成/);
  assert.match(formatExecutionForPlayer({ executionId: "execution_01", requestId: "request_01", state: "succeeded", reasonCode: "missing_evidence", revision: 2, evidence: null }), /尚未证实/);
});
