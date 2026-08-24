import assert from "node:assert/strict";
import test from "node:test";
import { classifyStardewGateFailure } from "./lib/stardew-gate-failure-taxonomy.mjs";

test("fixture-native block is classified without replacing its native reason", () => {
  const value = classifyStardewGateFailure("fixture_preflight_blocked_fixture_native_ready_grab_crop_missing", {
    nativeReasonCode: "fixture_native_ready_grab_crop_missing",
  });
  assert.equal(value.category, "fixture_precondition");
  assert.equal(value.normalizedReasonCode, "fixture_native_precondition_missing");
  assert.equal(value.nativeReasonCode, "fixture_native_ready_grab_crop_missing");
});

test("readiness authentication failure is fail-fast diagnostic", () => {
  const value = classifyStardewGateFailure("fixture_readiness_authentication_failed");
  assert.equal(value.category, "fixture_readiness");
  assert.equal(value.normalizedReasonCode, "fixture_readiness_unavailable");
});

test("missing live target keeps action-specific reason and suggests fixture/discovery audit", () => {
  const value = classifyStardewGateFailure("no_live_food_target");
  assert.equal(value.category, "live_target");
  assert.equal(value.sourceReasonCode, "no_live_food_target");
});

test("bridge disconnect is not interpreted as action failure or success", () => {
  const value = classifyStardewGateFailure("bridge_disconnected", { nativeReasonCode: "accepted" });
  assert.equal(value.category, "bridge_transport");
  assert.equal(value.nativeReasonCode, "accepted");
});

test("stale revision diagnostic remains separate from native receipt reason", () => {
  const value = classifyStardewGateFailure("request_revision_stale", { nativeReasonCode: "stale_snapshot" });
  assert.equal(value.category, "target_staleness");
  assert.equal(value.nativeReasonCode, "stale_snapshot");
});

test("postcondition mismatch is classified", () => {
  const value = classifyStardewGateFailure("item_used_postcondition_mismatch", { nativeReasonCode: "item_used" });
  assert.equal(value.category, "postcondition");
  assert.equal(value.nativeReasonCode, "item_used");
});

test("unknown and unsafe diagnostic text fails closed to unclassified", () => {
  const value = classifyStardewGateFailure("error with spaces and detail=secret");
  assert.equal(value.category, "native_or_unknown");
  assert.equal(value.sourceReasonCode, "invalid_or_missing_reason_code");
  assert.equal(value.nativeReasonCode, null);
});
