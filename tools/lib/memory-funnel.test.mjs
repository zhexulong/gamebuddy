import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  MEMORY_FUNNEL_STAGES,
  attributeMemoryFunnel,
  summarizeMemoryFunnel,
} from "./memory-funnel.mjs";

const statusOf = (attributed, stageId) => attributed.stages.find((row) => row.stage === stageId)?.status;

test("the funnel reports four stages in order, with no aggregate score", () => {
  const attributed = attributeMemoryFunnel({
    distance: "fold",
    seedRequired: true,
    seedPresentInReadback: true,
    renderedMemoryIdsObserved: true,
    seedIdRendered: true,
    foldObserved: true,
    postFoldAssembly: "present",
    probeEvent: "needle.hit",
  });
  assert.deepEqual(
    attributed.stages.map((row) => row.stage),
    [...MEMORY_FUNNEL_STAGES],
  );
  // Design 8 anti-target: no headline number, no weights, no single verdict.
  const serialized = JSON.stringify(attributed);
  for (const forbidden of ["score", "weight", "total", "grade", "rating"]) {
    assert.equal(serialized.includes(forbidden), false, `aggregate key leaked: ${forbidden}`);
  }
});

test("an unobserved upstream stage yields a gap and never a downstream failure", () => {
  // L1 was never observed (the seed's durability was not confirmed). The recall must
  // NOT be reported as a memory failure just because the needle came back empty.
  const attributed = attributeMemoryFunnel({
    seedRequired: true,
    seedPresentInReadback: false,
    probeEvent: "needle.miss",
  });
  assert.equal(statusOf(attributed, "L1_write"), "observability_gap");
  assert.equal(statusOf(attributed, "L2_assembly"), "observability_gap");
  // The miss is NOT attributed to presentation admission: the fact may never have
  // been stored, so blaming the model would be unfounded.
  assert.equal(statusOf(attributed, "L4_expression"), "observability_gap");
  assert.equal(attributed.findings.length, 0);
});

test("a downstream failure is NOT attributed while an upstream stage is unobserved", () => {
  // Found by the first real memory-loop run: L1 passed and the chat reply missed the
  // fact, but L2 was never observed. Reporting L4 "broken" with a
  // presentation-admission recommendation would blame the model for a fact that may
  // never have reached it - exactly the mis-attribution the funnel exists to stop.
  const attributed = attributeMemoryFunnel({
    distance: "turn",
    seedRequired: true,
    seedPresentInReadback: true,
    probeEvent: "needle.miss",
  });
  assert.equal(statusOf(attributed, "L1_write"), "passed");
  assert.equal(statusOf(attributed, "L2_assembly"), "observability_gap");
  assert.equal(statusOf(attributed, "L4_expression"), "observability_gap");
  assert.equal(attributed.stages.find((row) => row.stage === "L4_expression").reason, "L2_assembly_unobserved");
  assert.equal(attributed.findings.length, 0);
});

test("the same failure IS attributed once every upstream stage is observed and passed", () => {
  // The converse, so the rule above cannot silently swallow real defects: with L1
  // and L2 both observed and green, the miss is genuinely the model's.
  const attributed = attributeMemoryFunnel({
    distance: "turn",
    seedRequired: true,
    seedPresentInReadback: true,
    renderedMemoryIdsObserved: true,
    seedIdRendered: true,
    probeEvent: "needle.miss",
  });
  assert.equal(statusOf(attributed, "L4_expression"), "broken");
  assert.equal(attributed.findings.length, 1);
  assert.equal(attributed.findings[0].component, "presentation_admission");
});

test("a downstream PASS still stands even with an upstream gap", () => {
  // The rule is asymmetric on purpose: a reply containing the fact is positive
  // evidence it reached the model, so it must not be downgraded by a missing producer.
  const attributed = attributeMemoryFunnel({
    distance: "turn",
    seedRequired: true,
    seedPresentInReadback: false,
    probeEvent: "needle.hit",
  });
  assert.equal(statusOf(attributed, "L1_write"), "observability_gap");
  assert.equal(statusOf(attributed, "L4_expression"), "passed");
});

test("a broken stage makes every downstream stage not_reached rather than wrong", () => {
  // The write landed and the fact was rendered, but the fold dropped it. L4 must
  // not be scored: the run never legitimately exercised expression.
  const attributed = attributeMemoryFunnel({
    distance: "fold",
    seedRequired: true,
    seedPresentInReadback: true,
    renderedMemoryIdsObserved: true,
    seedIdRendered: true,
    foldObserved: true,
    postFoldAssembly: "absent",
    probeEvent: "needle.hit",
  });
  assert.equal(statusOf(attributed, "L3_decay"), "broken");
  assert.equal(statusOf(attributed, "L4_expression"), "not_reached");
  assert.equal(attributed.stages.find((row) => row.stage === "L4_expression").reason, "upstream_L3_decay_broken");
  assert.deepEqual(
    attributed.findings.map((finding) => finding.component),
    ["consolidation"],
  );
});

test("a write that did not survive budget trimming is attributed to assembly, not to recall", () => {
  const attributed = attributeMemoryFunnel({
    seedRequired: true,
    seedPresentInReadback: true,
    renderedMemoryIdsObserved: true,
    seedIdRendered: false,
    probeEvent: "needle.miss",
  });
  assert.equal(statusOf(attributed, "L1_write"), "passed");
  assert.equal(statusOf(attributed, "L2_assembly"), "broken");
  assert.equal(statusOf(attributed, "L4_expression"), "not_reached");
  const finding = attributed.findings[0];
  assert.equal(finding.component, "context_materialization");
  assert.match(finding.recommendation, /token budget|visibility/);
});

test("the two causes of distractor.confused are NOT equivalent at L4", () => {
  // Upstream observed green, so a recall failure is genuinely attributable to L4
  // and the cause discriminates: `needle_only` means the fact WAS recalled.
  const upstreamGreen = { seedRequired: true, seedPresentInReadback: true, renderedMemoryIdsObserved: true, seedIdRendered: true };
  const recalled = attributeMemoryFunnel({ ...upstreamGreen, probeEvent: "distractor.confused", probeReason: "needle_only" });
  const failed = attributeMemoryFunnel({ ...upstreamGreen, probeEvent: "distractor.confused", probeReason: "recall_failed" });
  assert.equal(statusOf(recalled, "L4_expression"), "passed");
  assert.equal(statusOf(failed, "L4_expression"), "broken");
  // Without the cause we must not guess either way.
  const unknown = attributeMemoryFunnel({ ...upstreamGreen, probeEvent: "distractor.confused" });
  assert.equal(statusOf(unknown, "L4_expression"), "observability_gap");
  assert.equal(unknown.findings.length, 0);
});

test("a conflict during the seed window is attributed to persistence", () => {
  const attributed = attributeMemoryFunnel({
    seedRequired: true,
    seedPresentInReadback: false,
    conflictObserved: true,
    probeEvent: "needle.miss",
  });
  assert.equal(statusOf(attributed, "L1_write"), "broken");
  assert.equal(attributed.findings[0].component, "persistence");
});

test("a turn-distance probe does not report a gap for a fold it never crossed", () => {
  // L3 is the fold-layer check. A pure turn-distance retention probe never asks for
  // a fold, so L3 was not exercised - reporting a gap would claim we tried to
  // observe a fold that the probe never requested.
  const attributed = attributeMemoryFunnel({
    distance: "turn",
    seedRequired: true,
    seedPresentInReadback: true,
    renderedMemoryIdsObserved: true,
    seedIdRendered: true,
    probeEvent: "needle.hit",
  });
  assert.equal(attributed.stages.some((row) => row.stage === "L3_decay"), false);
  assert.equal(statusOf(attributed, "L4_expression"), "passed");
  assert.equal(attributed.findings.length, 0);
});

test("a fold-distance probe that never saw a marker does report a gap", () => {
  // The converse of the test above: at fold distance the marker IS required, so its
  // absence is a real gap rather than "not applicable".
  const attributed = attributeMemoryFunnel({ distance: "fold", seedRequired: true, seedPresentInReadback: true });
  assert.equal(statusOf(attributed, "L3_decay"), "observability_gap");
  assert.equal(attributed.stages.find((row) => row.stage === "L3_decay").reason, "fold_not_observed");
});

test("summarize counts per stage independently and carries no overall verdict", () => {
  const summary = summarizeMemoryFunnel([
    { seedRequired: true, seedPresentInReadback: true, renderedMemoryIdsObserved: true, seedIdRendered: false },
    { seedRequired: true, seedPresentInReadback: true, renderedMemoryIdsObserved: true, seedIdRendered: true },
    { seedRequired: true, seedPresentInReadback: false },
  ]);
  assert.deepEqual(Object.keys(summary.counts), [...MEMORY_FUNNEL_STAGES]);
  assert.equal(summary.counts.L1_write.passed, 2);
  assert.equal(summary.counts.L1_write.observability_gap, 1);
  assert.equal(summary.counts.L2_assembly.broken, 1);
  assert.equal(summary.counts.L2_assembly.passed, 1);
  // The summary is a per-stage tally: no key may claim to be the run's own result.
  const serialized = JSON.stringify(summary);
  for (const forbidden of ["score", "weight", "total", "verdict", "overall", "grade", "rating"]) {
    assert.equal(serialized.includes(`"${forbidden}`), false, `aggregate key leaked: ${forbidden}`);
  }
});

test("every broken stage ships an actionable recommendation", () => {
  for (const observation of [
    { seedRequired: true, conflictObserved: true },
    { seedRequired: true, seedPresentInReadback: true, renderedMemoryIdsObserved: true, seedIdRendered: false },
    { distance: "fold", seedRequired: true, seedPresentInReadback: true, renderedMemoryIdsObserved: true, seedIdRendered: true, foldObserved: true, postFoldAssembly: "absent" },
    { seedRequired: true, seedPresentInReadback: true, renderedMemoryIdsObserved: true, seedIdRendered: true, probeEvent: "needle.miss" },
  ]) {
    const attributed = attributeMemoryFunnel(observation);
    assert.equal(attributed.findings.length, 1);
    assert.equal(typeof attributed.findings[0].recommendation, "string");
    assert.ok(attributed.findings[0].recommendation.length > 0);
  }
});

test("the real run-07 trace attributes honestly: upstream gaps, L4 passed, no findings", async () => {
  // This is the funnel applied to a REAL trace, not a synthetic one. It is the
  // regression that keeps the gap discipline honest: the run had NO memory events,
  // so L1/L2 must report gaps rather than failures, and the one stage we could
  // genuinely score (L4, where reason=needle_only means recall) must pass.
  const trace = JSON.parse(
    await readFile(new URL("../fixtures/chat-run-audit/real-live-runs/run-07-probe-cause.json", import.meta.url), "utf8"),
  );
  const probe = trace.events.find((event) => event.kind === "probe");
  assert.equal(probe.code, "distractor.confused");
  assert.equal(probe.meta.reason, "needle_only");
  assert.equal(trace.events.filter((event) => event.kind === "memory").length, 0);

  const attributed = attributeMemoryFunnel({
    distance: probe.meta.distance ?? "turn",
    seedRequired: true,
    probeEvent: probe.code,
    probeReason: probe.meta.reason,
  });
  assert.equal(statusOf(attributed, "L1_write"), "observability_gap");
  assert.equal(statusOf(attributed, "L2_assembly"), "observability_gap");
  assert.equal(statusOf(attributed, "L4_expression"), "passed");
  // Nothing broke, so the run reports no defect - only the missing producers.
  assert.equal(attributed.findings.length, 0);
});
