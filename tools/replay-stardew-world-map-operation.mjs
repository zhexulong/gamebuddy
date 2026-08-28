import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  newEnvelope,
  validateBridgeMessage,
} from "../host/dist-test/protocol.js";
import { parseStrictBridgeJson } from "../host/dist-test/strict-bridge-json.js";

const scope = {
  integrationId: "stardew",
  saveId: "save_01",
  worldId: "world_01",
  playerId: "player_01",
  companionId: "companion_01",
};
const now = Date.now();
const nodeRef = `nr1_${"A".repeat(22)}`;
const cursor = `wc1_${"B".repeat(22)}`;
const ref = `dr1_${"C".repeat(22)}`;

function frame(type, payload, correlationId = `corr_${randomUUID().replaceAll("-", "")}`) {
  return newEnvelope(type, scope, payload, correlationId, now);
}

const validRequest = frame("navigation_read_request", {
  operation: "inspect_world_map",
  args: { nodeRef },
});
const validResult = frame("navigation_read_result", {
  status: "succeeded",
  reason: "world_map_observed",
  entries: [{ label: "Mines", nodeRef, destination: { kind: "ref", ref } }],
  nextCursor: cursor,
}, validRequest.correlationId);

for (const value of [validRequest, validResult]) {
  const parsed = parseStrictBridgeJson(JSON.stringify(value));
  assert.equal(validateBridgeMessage(parsed, scope, now), null);
}
assert.equal("executionId" in validResult.payload, false);
assert.equal("evidence" in validResult.payload, false);
assert.equal("receipt" in validResult.payload, false);

for (const payload of [
  { operation: "inspect_world_map", args: { nodeRef, cursor } },
  { operation: "inspect_world_map", args: { pageSize: 20 } },
  { operation: "find_destination", args: { query: "" } },
  { operation: "find_destination", args: { query: "mine", nodeRef } },
]) {
  assert.equal(
    validateBridgeMessage(frame("navigation_read_request", payload), scope, now),
    "invalid_navigation_read_request",
  );
}
for (const payload of [
  { status: "succeeded", reason: "world_map_observed", entries: [{ label: "Mines", nodeRef: `dr1_${"A".repeat(22)}` }] },
  { status: "succeeded", reason: "world_map_observed", entries: [], receipt: {} },
]) {
  assert.equal(
    validateBridgeMessage(frame("navigation_read_result", payload), scope, now),
    "invalid_navigation_read_result",
  );
}

console.log(JSON.stringify({ state: "world_map_replay_completed", validation: { valid: true, mutationCount: 0, executionReceiptCount: 0 } }));
