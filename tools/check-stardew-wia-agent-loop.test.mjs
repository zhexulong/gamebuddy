import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { judgeWiaLoop } from "./check-stardew-wia-agent-loop.mjs";

/** A synthetic ladder-6 result with every fact the runner would record. */
const OK_RESULT = {
  ladder: "6",
  state: "passed",
  configuredFixtureScenario: "native_wia_modal_dismiss_chain_v1",
  actionTrace: [
    { action: "move_to_tile", receipt: { reasonCode: "accepted", state: "accepted" } },
    { action: "move_to_tile", receipt: { reasonCode: "modal_interrupted", state: "invalidated", evidence: { detail: "interrupted_by=DialogueBox;target_tile=35,35" } } },
    { action: "dismiss_modal", receipt: { reasonCode: "modal_dismissed", state: "succeeded" } },
    { action: "move_to_tile", receipt: { reasonCode: "target_reached", state: "succeeded" } },
  ],
  factLog: [],
  presentedSummary: "I walked, got interrupted by a dialogue, closed it, and finished walking.",
};

test("a run with the full interrupt -> dismiss -> resume chain judges passed", () => {
  const verdict = judgeWiaLoop(OK_RESULT, { fixtureScenario: "native_wia_modal_dismiss_chain_v1" });
  assert.equal(verdict.state, "passed");
  assert.equal(verdict.interrupted, true);
  assert.equal(verdict.dismissed, true);
  assert.equal(verdict.resumed, true);
});

test("a run that never hit the modal is UNOBSERVED, never passed", () => {
  const never = {
    ...OK_RESULT,
    actionTrace: [
      { action: "move_to_tile", receipt: { reasonCode: "target_reached", state: "succeeded" } },
      { action: "inspect_self", receipt: { reasonCode: "observation_complete", state: "succeeded" } },
    ],
  };
  const verdict = judgeWiaLoop(never, { fixtureScenario: "native_wia_modal_dismiss_chain_v1" });
  assert.equal(verdict.state, "unobserved");
});

test("a run interrupted but never dismissed is blocked", () => {
  const noDismiss = {
    ...OK_RESULT,
    actionTrace: [
      { action: "move_to_tile", receipt: { reasonCode: "modal_interrupted", state: "invalidated" } },
      { action: "move_to_tile", receipt: { reasonCode: "target_reached", state: "succeeded" } },
    ],
  };
  // A later move while the modal is up is itself refused; the chain is not complete.
  const verdict = judgeWiaLoop(noDismiss, { fixtureScenario: "native_wia_modal_dismiss_chain_v1" });
  assert.equal(verdict.state, "blocked");
  assert.equal(verdict.dismissed, false);
});

test("a run whose fixture was not the WIA one is blocked, not judged", () => {
  const wrongWorld = { ...OK_RESULT, configuredFixtureScenario: "native_till_soil_v1", actionTrace: [] };
  const verdict = judgeWiaLoop(wrongWorld, { fixtureScenario: "native_wia_modal_dismiss_chain_v1" });
  assert.equal(verdict.state, "blocked");
  assert.match(verdict.reason, /fixture_scenario_mismatch/);
});

test("a run marked passed by the harness still gets judged independently by the receipts", () => {
  // The harness's ladder-6 pass is only a coarse capability audit; this checker re-judges from the actual
  // receipts, so a harness `passed` that lacks the resume is not accepted here.
  const noResume = { ...OK_RESULT, actionTrace: OK_RESULT.actionTrace.slice(0, 3) };
  const verdict = judgeWiaLoop(noResume, { fixtureScenario: "native_wia_modal_dismiss_chain_v1" });
  assert.equal(verdict.resumed, false);
  assert.equal(verdict.state, "blocked");
});