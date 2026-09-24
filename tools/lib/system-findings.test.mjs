import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeSystemFindings } from "./system-findings.mjs";

test("returns empty health for a clean run", () => {
  const result = summarizeSystemFindings(
    [
      { action: "till_soil", args: { x: 64, y: 18 }, state: "succeeded", reasonCode: "soil_tilled" },
      { action: "plant_seed", args: { x: 64, y: 18 }, state: "succeeded", reasonCode: "seed_planted" },
    ],
    [],
  );
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
  const result = summarizeSystemFindings(trace, []);
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
  const result = summarizeSystemFindings(trace, []);
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
  const result = summarizeSystemFindings(trace, []);
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
  const result = summarizeSystemFindings(trace, []);
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
  const result = summarizeSystemFindings(trace, []);
  const ids = result.findings.map((f) => f.id);
  assert.ok(ids.includes("blind_guess_enumeration"), `expected blind_guess_enumeration, got ${ids.join(",")}`);
  assert.ok(ids.includes("dominant_rejection"), `expected dominant_rejection, got ${ids.join(",")}`);
  assert.ok(ids.includes("high_rejection_rate"), `expected high_rejection_rate, got ${ids.join(",")}`);
  assert.equal(result.rejectedCount, 7);
  assert.equal(result.acceptedCount, 3);
  assert.equal(result.totalCount, 10);
});