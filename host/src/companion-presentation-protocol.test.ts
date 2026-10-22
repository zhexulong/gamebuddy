import assert from "node:assert/strict";
import test from "node:test";

import { newEnvelope, type Scope, validateBridgeMessage } from "./protocol.js";

const scope: Scope = {
  integrationId: "stardew",
  saveId: "save_01",
  worldId: "world_01",
  playerId: "farmhand_01",
  companionId: "companion_01",
};

test("companion presentation protocol structurally rejects malformed text, locale, epoch, and a revision claim", () => {
  const valid = newEnvelope("companion_presentation_request", scope, {
    expressionId: "expression_01",
    sourceEventId: "source_01",
    text: "你好。",
    locale: "zh-CN",
    presentationEpoch: 0,
  });
  assert.equal(validateBridgeMessage(valid, scope), null);
  assert.equal(
    validateBridgeMessage({ ...valid, payload: { ...valid.payload, text: " " } }, scope),
    "invalid_companion_presentation_request",
  );
  assert.equal(
    validateBridgeMessage({ ...valid, payload: { ...valid.payload, locale: "bad locale" } }, scope),
    "invalid_companion_presentation_request",
  );
  for (const presentationEpoch of ["0", null, 0.5, -1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(
      validateBridgeMessage({ ...valid, payload: { ...valid.payload, presentationEpoch } }, scope),
      "invalid_companion_presentation_request",
    );
  }
  // Presentation mutates no world state, so the request carries no world-revision claim: a sender
  // that reintroduces one is refused on the exact-key check rather than silently stale-revisioned.
  assert.equal(
    validateBridgeMessage({ ...valid, payload: { ...valid.payload, expectedRevision: 4 } }, scope),
    "invalid_companion_presentation_request",
  );
});
