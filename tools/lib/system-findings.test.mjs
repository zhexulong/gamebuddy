import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeSystemFindings } from "./system-findings.mjs";

test("returns empty health for a clean run", () => {
  const result = summarizeSystemFindings([
      { action: "till_soil", args: { x: 64, y: 18 }, state: "succeeded", reasonCode: "soil_tilled" },
      { action: "plant_seed", args: { x: 64, y: 18 }, state: "succeeded", reasonCode: "seed_planted" },
    ]);
  assert.equal(result.findings.length, 0);
  assert.equal(result.rejectedCount, 0);
  assert.equal(result.acceptedCount, 2);
});

test("flags blind-guess enumeration (same action, many different args, one reason)", () => {
  const trace = [
    { action: "till_soil", args: { x: 64, y: 14 }, state: "rejected", reasonCode: "soil_not_diggable" },
    { action: "till_soil", args: { x: 65, y: 14 }, state: "rejected", reasonCode: "soil_not_diggable" },
    { action: "till_soil", args: { x: 63, y: 15 }, state: "rejected", reasonCode: "soil_not_diggable" },
    { action: "move_to_tile", args: { x: 8, y: 11 }, state: "rejected", reasonCode: "no_native_path" },
  ];
  const result = summarizeSystemFindings(trace);
  const blind = result.findings.find((f) => f.id === "blind_guess_enumeration");
  assert.ok(blind, "blind-guess finding should exist");
  assert.equal(blind.action, "till_soil");
  assert.equal(blind.component, "observation");
  assert.equal(blind.count, 3);
});

test("flags identical retries of the same rejected request", () => {
  const trace = [
    { action: "move_to_tile", args: { x: 3, y: 12 }, state: "rejected", reasonCode: "no_native_path" },
    { action: "move_to_tile", args: { x: 3, y: 12 }, state: "rejected", reasonCode: "no_native_path" },
    { action: "move_to_tile", args: { x: 3, y: 12 }, state: "rejected", reasonCode: "no_native_path" },
  ];
  const result = summarizeSystemFindings(trace);
  const retry = result.findings.find((f) => f.id === "identical_retry");
  assert.ok(retry);
  assert.equal(retry.count, 3);
  assert.equal(retry.component, "orchestration");
});

test("flags a dominant rejection reason with component attribution", () => {
  const trace = [
    { action: "till_soil", args: { x: 1, y: 1 }, state: "rejected", reasonCode: "soil_not_diggable" },
    { action: "till_soil", args: { x: 2, y: 1 }, state: "rejected", reasonCode: "soil_not_diggable" },
    { action: "till_soil", args: { x: 3, y: 1 }, state: "rejected", reasonCode: "soil_not_diggable" },
    { action: "water_crop", args: { x: 4, y: 1 }, state: "rejected", reasonCode: "body_owned" },
  ];
  const result = summarizeSystemFindings(trace);
  const dominant = result.findings.find((f) => f.id === "dominant_rejection");
  assert.ok(dominant);
  assert.equal(dominant.component, "observation"); // soil_not_diggable -> observation
});

test("flags a high overall rejection rate", () => {
  const trace = [
    { action: "a", state: "rejected", reasonCode: "x" },
    { action: "b", state: "rejected", reasonCode: "y" },
    { action: "c", state: "rejected", reasonCode: "z" },
    { action: "d", state: "accepted", reasonCode: "accepted" },
  ];
  const result = summarizeSystemFindings(trace);
  assert.ok(result.findings.some((f) => f.id === "high_rejection_rate"));
});

test("reproduces the real 8/15 rejection live finding shape", () => {
  // From the ladder-3 live run before the discovery-radius fix.
  const trace = [
    { action: "move_to_tile", args: { x: 8, y: 10 }, state: "accepted", reasonCode: "accepted" },
    { action: "move_to_tile", args: { x: 4, y: 12 }, state: "rejected", reasonCode: "no_native_path" },
    { action: "move_to_tile", args: { x: 6, y: 11 }, state: "rejected", reasonCode: "no_native_path" },
    { action: "move_to_tile", args: { x: 8, y: 11 }, state: "rejected", reasonCode: "no_native_path" },
    { action: "till_soil", args: { x: 64, y: 14 }, state: "rejected", reasonCode: "soil_not_diggable" },
    { action: "till_soil", args: { x: 65, y: 14 }, state: "rejected", reasonCode: "soil_not_diggable" },
    { action: "till_soil", args: { x: 63, y: 15 }, state: "rejected", reasonCode: "soil_not_diggable" },
    { action: "till_soil", args: { x: 62, y: 15 }, state: "rejected", reasonCode: "soil_not_diggable" },
    { action: "move_to_tile", args: { x: 64, y: 16 }, state: "accepted", reasonCode: "accepted" },
    { action: "till_soil", args: { x: 64, y: 18 }, state: "succeeded", reasonCode: "soil_tilled" },
  ];
  const result = summarizeSystemFindings(trace);
  const ids = result.findings.map((f) => f.id);
  assert.ok(ids.includes("blind_guess_enumeration"), `expected blind_guess_enumeration, got ${ids.join(",")}`);
  assert.ok(ids.includes("dominant_rejection"), `expected dominant_rejection, got ${ids.join(",")}`);
  assert.ok(ids.includes("high_rejection_rate"), `expected high_rejection_rate, got ${ids.join(",")}`);
  assert.equal(result.rejectedCount, 7);
  assert.equal(result.acceptedCount, 3);
  assert.equal(result.totalCount, 10);
});
test("namespaced replay rejections are attributed, not left unclassified", () => {
  // The live run that motivated this module reported zero rejections because a
  // thrown rejection never reached the trace; with the trace fixed, a compound
  // code like the replay rejection must still land on a component. Matching only
  // the whole string would silently fall through to `unclassified`.
  const result = summarizeSystemFindings([
      { action: "move_to_tile", args: { x: 3, y: 12 }, state: "rejected", reasonCode: "stale_snapshot" },
      {
        action: "move_to_tile",
        args: { x: 3, y: 12 },
        state: "rejected",
        reasonCode: "execution_receipt_replay_rejected:non_monotonic_revision",
      },
    ]);
  assert.equal(result.rejectedCount, 2);
  const components = result.findings.map((finding) => finding.component);
  assert.ok(components.includes("delivery"), `expected a delivery finding, got ${JSON.stringify(result.findings)}`);
  assert.ok(!components.includes("unclassified"), `nothing should be unclassified: ${JSON.stringify(result.findings)}`);
});

test("never reports a clean run while actions were rejected", () => {
  // The verify live run reported findings: [] while a third of its actions were
  // rejected (no_native_path x2, warp_out_of_range, target_out_of_range). All
  // four mapped to the same component and none reached the counting thresholds,
  // so the run's own health report said "no problems" about a run with four
  // real rejections. A rejection must always surface at least once.
  const result = summarizeSystemFindings([
      { action: "move_to_tile", args: { x: 3, y: 12 }, state: "rejected", reasonCode: "no_native_path" },
      { action: "move_to_tile", args: { x: 3, y: 11 }, state: "rejected", reasonCode: "no_native_path" },
      { action: "travel", args: { x: 3, y: 12 }, state: "rejected", reasonCode: "warp_out_of_range" },
      { action: "harvest_crop", args: { x: 64, y: 18 }, state: "rejected", reasonCode: "target_out_of_range" },
      { action: "move_to_tile", args: { x: 64, y: 15 }, state: "succeeded", reasonCode: "target_reached" },
      { action: "travel", args: { x: 80, y: 17 }, state: "succeeded", reasonCode: "travel_completed" },
      { action: "harvest_crop", args: { x: 64, y: 18 }, state: "succeeded", reasonCode: "crop_harvested" },
    ]);
  assert.equal(result.rejectedCount, 4);
  assert.ok(result.findings.length > 0, "a run with rejections must never report no findings");
  const summary = result.findings.find((finding) => finding.id === "rejection_observed");
  assert.ok(summary, `expected a rejection summary, got ${JSON.stringify(result.findings)}`);
  assert.equal(summary.count, 4);
  assert.notEqual(summary.component, "unclassified");
  assert.deepEqual(summary.sampleCodes.sort(), ["no_native_path", "target_out_of_range", "warp_out_of_range"]);
});

test("a genuinely clean run still reports nothing", () => {
  const result = summarizeSystemFindings([
      { action: "move_to_tile", args: { x: 1, y: 1 }, state: "succeeded", reasonCode: "target_reached" },
      { action: "harvest_crop", args: { x: 2, y: 2 }, state: "succeeded", reasonCode: "crop_harvested" },
    ]);
  assert.deepEqual(result.findings, []);
  assert.equal(result.rejectedCount, 0);
});


test("a refusal is attributed by its own evidence, not by its reason code alone", () => {
  // Measured live, then corrected: this refusal named a budget
  // (`route_exists=true; component_tiles=2404; probe_says_reachable=true; path_search=native_budget_exhausted`),
  // and the measurement showed the limit was irrelevant — null at 10000, 40000 and 400000 — because the
  // destination's CARDINAL approaches were both blocked while the native planner expands cardinally only. So
  // the honest label is `no_cardinal_route`, the refusal is the world's geometry, and the audit belongs on
  // `native_state`.
  const planner = summarizeSystemFindings([
    {
      action: "move_to_tile",
      args: { x: 4, y: 8 },
      state: "rejected",
      reasonCode: "no_native_path",
      evidence: "from=3,9;to=4,8;target_standable=false;route_exists_cardinal=false;path_search=no_cardinal_route;budget=40000",
    },
    { action: "move_to_tile", args: { x: 5, y: 9 }, state: "rejected", reasonCode: "no_native_path", evidence: "route_exists_cardinal=false" },
    { action: "move_to_tile", args: { x: 6, y: 9 }, state: "rejected", reasonCode: "no_native_path", evidence: "route_exists_cardinal=false" },
  ]);
  assert.equal(planner.findings.find((finding) => finding.id === "dominant_rejection").component, "native_state");

  // The other half of the same split: the planner returned null while its OWN cardinal component contains the
  // target. That is not the world's geometry, it is a derivation worth reviewing.
  const contradictory = summarizeSystemFindings([
    {
      action: "move_to_tile",
      args: { x: 4, y: 8 },
      state: "rejected",
      reasonCode: "no_native_path",
      evidence: "route_exists_cardinal=true;path_search=planner_null_with_cardinal_route;budget=40000",
    },
    { action: "move_to_tile", args: { x: 5, y: 9 }, state: "rejected", reasonCode: "no_native_path", evidence: "route_exists_cardinal=true" },
    { action: "move_to_tile", args: { x: 6, y: 9 }, state: "rejected", reasonCode: "no_native_path", evidence: "route_exists_cardinal=true" },
  ]);
  assert.equal(contradictory.findings.find((finding) => finding.id === "dominant_rejection").component, "observation");

  // Without that evidence the same code keeps its table attribution: the rule is evidence-driven, not a
  // blanket re-attribution of the code.
  const bare = summarizeSystemFindings([
    { action: "move_to_tile", args: { x: 4, y: 8 }, state: "rejected", reasonCode: "no_native_path" },
    { action: "move_to_tile", args: { x: 5, y: 9 }, state: "rejected", reasonCode: "no_native_path" },
    { action: "move_to_tile", args: { x: 6, y: 9 }, state: "rejected", reasonCode: "no_native_path" },
  ]);
  assert.equal(bare.findings.find((finding) => finding.id === "dominant_rejection").component, "observation");
});

test("an admitted action whose executions fail is reported even though no dispatch was refused", () => {
  // Three harvest executions ended in `target_out_of_reach` after being ACCEPTED, so a refusal-only reading saw
  // one unrelated finding. The per-execution outcomes now reach the summary.
  const result = summarizeSystemFindings(
    [{ action: "harvest_crop", args: { x: 5, y: 7 }, state: "accepted", reasonCode: "accepted" }],
    { harvest_crop: { failedTerminalReasonCodes: { target_out_of_reach: 3 } } },
  );
  const finding = result.findings.find((entry) => entry.id === "accepted_then_failed");
  assert.ok(finding, "the retry-into-failure loop must be reported");
  assert.equal(finding.action, "harvest_crop");
  assert.equal(finding.count, 3);
  assert.equal(finding.severity, "high");
  assert.deepEqual(finding.sampleCodes, ["target_out_of_reach"]);
  // A run whose executions all reached their terminal reports nothing new.
  const clean = summarizeSystemFindings(
    [{ action: "harvest_crop", args: { x: 5, y: 7 }, state: "succeeded", reasonCode: "crop_harvested" }],
    { harvest_crop: { failedTerminalReasonCodes: {} } },
  );
  assert.equal(clean.findings.length, 0);
});
