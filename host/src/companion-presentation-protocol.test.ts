import assert from "node:assert/strict";
import test from "node:test";

import { newEnvelope, validateBridgeMessage, type Scope } from "./protocol.js";

const scope: Scope = {
  integrationId: "stardew",
  saveId: "save_01",
  worldId: "world_01",
  playerId: "farmhand_01",
  companionId: "companion_01",
};

test("companion presentation protocol structurally rejects malformed text, locale, revision, and epoch", () => {
  const valid = newEnvelope("companion_presentation_request", scope, {
    expressionId: "expression_01",
    sourceEventId: "source_01",
    text: "你好。",
    locale: "zh-CN",
    expectedRevision: 4,
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
  for (const expectedRevision of ["4", null, 4.5, -1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(
      validateBridgeMessage({ ...valid, payload: { ...valid.payload, expectedRevision } }, scope),
      "invalid_companion_presentation_request",
    );
  }
  for (const presentationEpoch of ["0", null, 0.5, -1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(
      validateBridgeMessage({ ...valid, payload: { ...valid.payload, presentationEpoch } }, scope),
      "invalid_companion_presentation_request",
    );
  }
});
