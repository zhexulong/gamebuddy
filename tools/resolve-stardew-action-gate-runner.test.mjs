import assert from "node:assert/strict";
import test from "node:test";
import { resolveStardewActionGateRunner } from "./resolve-stardew-action-gate-runner.mjs";
import { STARDEW_PUBLISHED_ACTION_GATES } from "./stardew-action-gate-descriptors.mjs";

test("fixture launcher resolver returns the canonical descriptor runner for every published action", () => {
  for (const gate of STARDEW_PUBLISHED_ACTION_GATES)
    assert.equal(resolveStardewActionGateRunner(gate.actionId), gate.runner);
});

test("fixture launcher resolver fails closed for malformed and unknown action identities", () => {
  assert.throws(() => resolveStardewActionGateRunner("move_to_tile "), /invalid_stardew_action_id/);
  assert.throws(() => resolveStardewActionGateRunner("not_a_published_action"), /unknown_stardew_action_id/);
});
