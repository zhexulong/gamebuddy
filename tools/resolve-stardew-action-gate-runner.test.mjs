import assert from "node:assert/strict";
import test from "node:test";
import {
  GATE_EXEMPT_PUBLISHED_ACTIONS,
} from "./lib/stardew-published-action-registry.mjs";
import { resolveStardewActionGateRunner } from "./resolve-stardew-action-gate-runner.mjs";
import {
  STARDEW_EXPERIMENTAL_ACTION_RUNNERS,
  STARDEW_PUBLISHED_ACTION_GATES,
} from "./stardew-action-gate-descriptors.mjs";

test("fixture launcher resolver returns the canonical descriptor runner for every published action", () => {
  for (const gate of STARDEW_PUBLISHED_ACTION_GATES)
    assert.equal(resolveStardewActionGateRunner(gate.actionId), gate.runner);
});

test("fixture launcher resolver returns the experimental runner without widening the published set", () => {
  // Experimental actions must stay out of STARDEW_PUBLISHED_ACTION_GATES; the
  // separate map only lets the disposable native-local launcher reach their
  // own shared-harness runner.
  const publishedIds = new Set(STARDEW_PUBLISHED_ACTION_GATES.map((gate) => gate.actionId));
  for (const [actionId, runner] of Object.entries(STARDEW_EXPERIMENTAL_ACTION_RUNNERS)) {
    assert.equal(publishedIds.has(actionId), false, `${actionId} must not enter the published gate list`);
    assert.match(runner, /^run-stardew-native-local-player-[a-z0-9-]+\.mjs$/);
    assert.equal(resolveStardewActionGateRunner(actionId), runner);
  }
});

test("fixture launcher resolver returns the declared runner for gate-exempt published actions", () => {
  // The exemption is a carve-out of the gate list, not a hole in it: the
  // declared runner (navigation's own smoke runner) must resolve.
  for (const exemption of GATE_EXEMPT_PUBLISHED_ACTIONS) {
    assert.equal(resolveStardewActionGateRunner(exemption.actionId), exemption.runner);
    assert.match(exemption.runner, /^run-stardew-[a-z0-9-]+\.mjs$/);
  }
});

test("fixture launcher resolver fails closed for malformed and unknown action identities", () => {
  assert.throws(() => resolveStardewActionGateRunner("move_to_tile "), /invalid_stardew_action_id/);
  assert.throws(() => resolveStardewActionGateRunner("not_a_published_action"), /unknown_stardew_action_id/);
});
