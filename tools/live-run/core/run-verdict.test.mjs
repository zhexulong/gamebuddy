import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChatRunVerdict,
  buildMemoryRunVerdict,
  chatProbeVerdict,
  memoryStageVerdict,
  RUN_VERDICT_SCHEMA,
  rollupMappedVerdicts,
} from "./run-verdict.mjs";

/**
 * The three loops already agree about what the three outcomes mean; these tests hold that the
 * MAPPING preserves every distinction that matters and loses none of them, and that a run with no
 * evidence can never read as a pass.
 */

test("a Chat probe code maps onto the shared state and keeps its own name beside it", () => {
  const hit = chatProbeVerdict({ code: "needle.hit" });
  assert.equal(hit.state, "verified");
  assert.equal(hit.local, "needle.hit");

  const miss = chatProbeVerdict({ code: "needle.miss" });
  assert.equal(miss.state, "failed");
  assert.equal(miss.local, "needle.miss");

  // The gap is the outcome this whole vocabulary exists for: no evidence is not a pass.
  const gap = chatProbeVerdict({ code: "observability_gap", reason: "probe_turn_not_terminal" });
  assert.equal(gap.state, "unobserved");
  assert.equal(gap.reason, "probe_turn_not_terminal");

  // Supersession and isolation own their own codes; both directions map.
  assert.equal(chatProbeVerdict({ code: "supersede.pass" }).state, "verified");
  assert.equal(chatProbeVerdict({ code: "supersede.fail", reason: "old_retained" }).state, "failed");
  assert.equal(chatProbeVerdict({ code: "isolation.clean" }).state, "verified");
  assert.equal(chatProbeVerdict({ code: "isolation.breach" }).state, "failed");
  assert.equal(chatProbeVerdict({ code: "distractor.clean" }).state, "verified");
});

test("`distractor.confused` maps by its cause, because its two causes are different facts", () => {
  // The line `attributeMemoryFunnel` already draws: recalling the needle while a forbidden word
  // co-occurs is a correct reply that denies the distractor; failing to recall is the memory
  // failure. Flattening them would make the gate cry wolf on good replies.
  assert.equal(chatProbeVerdict({ code: "distractor.confused", reason: "needle_only" }).state, "verified");
  assert.equal(chatProbeVerdict({ code: "distractor.confused", reason: "recall_failed" }).state, "failed");
  // An unnamed cause is a gap, not a guess.
  const unknownCause = chatProbeVerdict({ code: "distractor.confused" });
  assert.equal(unknownCause.state, "unobserved");
  assert.equal(unknownCause.reason, "distractor_cause_unobserved");
});

test("an unmapped or missing code fails closed by name", () => {
  // A probe added tomorrow must not map to nothing quietly.
  const unknown = chatProbeVerdict({ code: "probe.invented.tomorrow" });
  assert.equal(unknown.state, "unobserved");
  assert.equal(unknown.reason, "unmapped_probe_code:probe.invented.tomorrow");
  assert.equal(unknown.local, "probe.invented.tomorrow");

  assert.equal(chatProbeVerdict({}).reason, "probe_code_missing");
  assert.equal(chatProbeVerdict(undefined).state, "unobserved");
});

test("a Memory funnel stage maps onto the same three states, and `not_reached` is a gap", () => {
  assert.equal(memoryStageVerdict({ stage: "L1_write", status: "passed" }).state, "verified");
  assert.equal(memoryStageVerdict({ stage: "L2_assembly", status: "broken" }).state, "failed");

  const gap = memoryStageVerdict({
    stage: "L2_assembly",
    status: "observability_gap",
    reason: "rendered_memory_ids_unobserved",
  });
  assert.equal(gap.state, "unobserved");
  assert.equal(gap.reason, "rendered_memory_ids_unobserved");
  assert.equal(gap.local, "observability_gap");

  // A stage downstream of a break was never exercised: it is not evidence of anything, and it keeps
  // its own name so a reader can see it was SKIPPED rather than looked at and missed.
  const skipped = memoryStageVerdict({
    stage: "L4_expression",
    status: "not_reached",
    reason: "upstream_L1_write_broken",
  });
  assert.equal(skipped.state, "unobserved");
  assert.equal(skipped.local, "not_reached");

  // An unknown status is a gap naming itself.
  const unknown = memoryStageVerdict({ stage: "L1_write", status: "invented" });
  assert.equal(unknown.state, "unobserved");
  assert.equal(unknown.reason, "unmapped_memory_stage_status:invented");
  assert.equal(memoryStageVerdict({}).reason, "memory_stage_status_missing");
});

test("a rollup of nothing is unobserved, never a vacuous pass", () => {
  // `rollupVerdicts([])` is all-verified by construction. That is exactly the "a gate with nothing
  // to check passes" shape this vocabulary exists to remove, so the empty case is answered here.
  const empty = rollupMappedVerdicts([]);
  assert.equal(empty.state, "unobserved");
  assert.equal(empty.reason, "no_evidence");
  assert.equal(rollupMappedVerdicts(undefined).state, "unobserved");

  // One failure outvotes passes, and one gap stops the rollup from reading as verified.
  assert.equal(rollupMappedVerdicts([{ state: "verified" }, { state: "failed" }]).state, "failed");
  assert.equal(
    rollupMappedVerdicts([{ state: "verified" }, { state: "unobserved", reason: "no_presentation_text" }]).state,
    "unobserved",
  );
  assert.equal(rollupMappedVerdicts([{ state: "verified" }, { state: "verified" }]).state, "verified");
});

test("a Chat run with no probe events is unobserved, and one failing probe is failed", () => {
  const noProbes = buildChatRunVerdict([]);
  assert.equal(noProbes.schema, RUN_VERDICT_SCHEMA);
  assert.equal(noProbes.state, "unobserved");
  assert.equal(noProbes.reason, "no_probe_evidence");
  assert.deepEqual(noProbes.checks, []);

  const events = [
    { kind: "lifecycle", code: "run.started" },
    { kind: "probe", code: "needle.hit", meta: { probeId: "probe_a" } },
    { kind: "probe", code: "needle.miss", meta: { probeId: "probe_b" } },
  ];
  const mixed = buildChatRunVerdict(events);
  assert.equal(mixed.state, "failed");
  // The lifecycle event is not a judgement and must not become a check.
  assert.deepEqual(
    mixed.checks.map((check) => `${check.id}:${check.local}:${check.state}`),
    ["probe_a:needle.hit:verified", "probe_b:needle.miss:failed"],
  );

  // A run whose only probe was an observation gap cannot read as verified.
  const gapOnly = buildChatRunVerdict([
    { kind: "probe", code: "observability_gap", meta: { probeId: "p", reason: "probe_turn_not_terminal" } },
  ]);
  assert.equal(gapOnly.state, "unobserved");
  assert.equal(gapOnly.reason, "probe_turn_not_terminal");
});

test("a Memory run rolls its stages up, and an absent funnel is unobserved", () => {
  assert.equal(buildMemoryRunVerdict([]).reason, "no_funnel_stage_evidence");

  const allPass = buildMemoryRunVerdict([
    { stage: "L1_write", status: "passed" },
    { stage: "L2_assembly", status: "passed" },
  ]);
  assert.equal(allPass.state, "verified");
  assert.deepEqual(
    allPass.checks.map((check) => `${check.id}:${check.state}`),
    ["L1_write:verified", "L2_assembly:verified"],
  );

  // The funnel's own seed-unproven shape: L1 broke, downstream skipped. The rollup must be `failed`
  // on L1's evidence, not `unobserved` because three stages were skipped.
  const seedBroken = buildMemoryRunVerdict([
    { stage: "L1_write", status: "observability_gap", reason: "seed_readback_unobserved" },
    { stage: "L2_assembly", status: "not_reached", reason: "upstream_L1_write_broken" },
  ]);
  assert.equal(seedBroken.state, "unobserved");
  assert.equal(seedBroken.reason, "seed_readback_unobserved");
  assert.equal(seedBroken.checks[1].local, "not_reached");
});

test("the mapping adds a shared field and does not replace the local vocabulary", () => {
  // The reason the local codes stay: `failed` alone cannot say which repair is needed. Three
  // failures with three different local names must stay three different findings.
  const failures = ["needle.miss", "supersede.fail", "isolation.breach"].map((code) => chatProbeVerdict({ code }));
  assert.equal(
    failures.every((verdict) => verdict.state === "failed"),
    true,
  );
  assert.deepEqual(
    failures.map((verdict) => verdict.local),
    ["needle.miss", "supersede.fail", "isolation.breach"],
  );
  // Same shared vocabulary as the Game loop reads, so a comparison tool has one field to read.
  assert.deepEqual(new Set(failures.map((verdict) => verdict.state)), new Set(["failed"]));
});
