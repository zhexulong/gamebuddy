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
const ref = `dr1_${"A".repeat(22)}`;

function frame(type, payload, correlationId = `corr_${randomUUID().replaceAll("-", "")}`) {
  return newEnvelope(type, scope, payload, correlationId, now);
}

const request = frame("navigation_read_request", {
  operation: "find_destination",
  args: { query: "mine" },
});
const resolved = frame("navigation_read_result", {
  status: "resolved",
  reason: "exact_current_locale",
  destination: { kind: "ref", ref },
}, request.correlationId);
const candidates = frame("navigation_read_result", {
  status: "candidates",
  reason: "fuzzy_match",
  candidates: [
    { label: "Mines", selector: { kind: "label", label: "Mines" } },
  ],
}, request.correlationId);

for (const value of [request, resolved, candidates]) {
  const parsed = parseStrictBridgeJson(JSON.stringify(value));
  assert.equal(validateBridgeMessage(parsed, scope, now), null);
}
for (const payload of [resolved.payload, candidates.payload]) {
  assert.equal("query" in payload, false);
  assert.equal("score" in payload, false);
  assert.equal("threshold" in payload, false);
  assert.equal("executionId" in payload, false);
  assert.equal("receipt" in payload, false);
  assert.equal("evidence" in payload, false);
}

for (const payload of [
  { operation: "find_destination", args: { query: "" } },
  { operation: "find_destination", args: { query: "mine", nodeRef: `nr1_${"A".repeat(22)}` } },
  { operation: "find_destination", args: { query: "mine", extra: true } },
]) {
  assert.equal(
    validateBridgeMessage(frame("navigation_read_request", payload), scope, now),
    "invalid_navigation_read_request",
  );
}
for (const payload of [
  { status: "resolved", reason: "exact_current_locale", destination: { kind: "label", label: "Mines" }, query: "mine" },
  { status: "candidates", reason: "fuzzy_match", candidates: [{ label: "Mines", score: 99, selector: { kind: "label", label: "Mines" } }] },
  { status: "candidates", reason: "fuzzy_match", candidates: [] },
]) {
  assert.equal(
    validateBridgeMessage(frame("navigation_read_result", payload), scope, now),
    "invalid_navigation_read_result",
  );
}

console.log(JSON.stringify({ state: "destination_search_replay_completed", validation: { valid: true, mutationCount: 0, executionReceiptCount: 0 } }));
