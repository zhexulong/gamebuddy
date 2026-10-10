#!/usr/bin/env node
// Independent judge for ONE ladder-6 run: did the Agent actually close the WIA interrupt loop itself?
//
// The ladder-6 main gate is a broad capability audit (some movement, a summary, session completed). It can pass
// a run that was interrupted but never recovered, which is exactly the vacuity this lane is allergic to. This
// checker re-judges the SAME run from the actual receipts: interrupt -> dismiss -> resume, in that order, all in
// the fact stream, from a snapshot that genuinely carries the breakpoint.
//
// It judges what happened, never what the prompt wanted; a run that never hit the modal is UNOBSERVED, which is
// not a pass and must not be reported as one.
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const EXPECTED_FIXTURE = "native_wia_modal_dismiss_chain_v1";

export function judgeWiaLoop(result, { fixtureScenario = EXPECTED_FIXTURE } = {}) {
  const trace = Array.isArray(result?.actionTrace) ? result.actionTrace : [];
  if (result?.configuredFixtureScenario !== fixtureScenario) {
    return {
      state: "blocked",
      reason: `fixture_scenario_mismatch:expected=${fixtureScenario};actual=${String(result?.configuredFixtureScenario)}`,
      interrupted: false,
      dismissed: false,
      resumed: false,
    };
  }

  const interrupted = trace.some(
    (step) => step?.receipt?.state === "invalidated" && step?.receipt?.reasonCode === "modal_interrupted",
  );
  const dismissed = trace.some((step) => step?.receipt?.reasonCode === "modal_dismissed");
  const resumed = trace.some(
    (step) => step?.action === "move_to_tile" && step?.receipt?.reasonCode === "target_reached",
  );

  // The order claim: the dismiss must come AFTER the interrupt. A receipt list that contains both in the wrong
  // order is a different defect, not a pass.
  const interruptIndex = trace.findIndex(
    (step) => step?.receipt?.state === "invalidated" && step?.receipt?.reasonCode === "modal_interrupted",
  );
  const dismissIndex = trace.findIndex((step) => step?.receipt?.reasonCode === "modal_dismissed");
  const ordered = interruptIndex >= 0 && dismissIndex >= 0 && dismissIndex > interruptIndex;

  if (!interrupted) {
    return { state: "unobserved", reason: "no_interruption_observed", interrupted: false, dismissed, resumed, ordered: false };
  }
  if (!dismissed || !resumed || !ordered) {
    return {
      state: "blocked",
      reason: `incomplete_chain:${interrupted ? "interrupted" : ""}${dismissed ? "+dismissed" : ""}${resumed ? "+resumed" : ""}${ordered ? "" : "+wrong_order"}`,
      interrupted,
      dismissed,
      resumed,
      ordered,
    };
  }
  return { state: "passed", reason: "wia_agent_loop_closed", interrupted, dismissed, resumed, ordered };
}

if (import.meta.main) {
  const resultPath = process.argv[2];
  if (!resultPath) throw new Error("usage: node check-stardew-wia-agent-loop.mjs <ladder6-result.json>");
  const result = JSON.parse(readFileSync(path.resolve(resultPath), "utf8"));
  const verdict = judgeWiaLoop(result);
  console.log(JSON.stringify(verdict, null, 2));
  if (verdict.state !== "passed") process.exitCode = 2;
}