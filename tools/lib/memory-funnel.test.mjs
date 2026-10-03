import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  MEMORY_FUNNEL_STAGES,
  attributeMemoryFunnel,
  foldCommittedRenderedIdsFromMarkers,
  m0DigestsFromMarkers,
  renderedMemoryIdsFromMarkers,
  renderedChaptersFromMarkers,
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
  // The write landed and the fact was rendered, but the REAL fold commit dropped
  // it. L4 must not be scored: the run never legitimately exercised expression.
  const attributed = attributeMemoryFunnel({
    distance: "fold",
    seedRequired: true,
    seedPresentInReadback: true,
    renderedMemoryIdsObserved: true,
    seedIdRendered: true,
    realFold: {
      revision: "rev_1",
      postFoldRenderedIds: new Set([1, 3]),
      seedId: 2,
    },
    probeEvent: "needle.hit",
  });
  assert.equal(statusOf(attributed, "L3_decay"), "broken");
  assert.equal(attributed.stages.find((row) => row.stage === "L3_decay").detail, "seed id dropped by the fold commit");
  assert.equal(statusOf(attributed, "L4_expression"), "not_reached");
  assert.equal(attributed.stages.find((row) => row.stage === "L4_expression").reason, "upstream_L3_decay_broken");
  assert.deepEqual(
    attributed.findings.map((finding) => finding.component),
    ["consolidation"],
  );
});

test("a REAL fold that retains the seed passes L3 with the fold-commit revision evidence", () => {
  const attributed = attributeMemoryFunnel({
    distance: "fold",
    seedRequired: true,
    seedPresentInReadback: true,
    renderedMemoryIdsObserved: true,
    seedIdRendered: true,
    realFold: {
      revision: "rev_fold",
      postFoldRenderedIds: new Set([2, 7]),
      seedId: 2,
    },
    probeEvent: "needle.hit",
  });
  assert.equal(statusOf(attributed, "L3_decay"), "passed");
  assert.equal(attributed.stages.find((row) => row.stage === "L3_decay").detail, "seed id retained in the fold-commit revision rendered set");
  assert.equal(statusOf(attributed, "L4_expression"), "passed");
});

test("a fold-distance probe whose fold-commit marker lacks a rendered set is a gap, not a pass or break", () => {
  const attributed = attributeMemoryFunnel({
    distance: "fold",
    seedRequired: true,
    seedPresentInReadback: true,
    realFold: { revision: "rev_fold", postFoldRenderedIds: undefined, seedId: 2 },
  });
  assert.equal(statusOf(attributed, "L3_decay"), "observability_gap");
  assert.equal(attributed.stages.find((row) => row.stage === "L3_decay").reason, "fold_post_render_unobserved");
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

test("parses fold-commit markers bound to the same materialization revision", () => {
  // A pass WITHOUT a fold: only memory-ids markers, no fold-commit line.
  assert.equal(
    foldCommittedRenderedIdsFromMarkers([
      "[probe:m0_memory_ids] rev_1 1,2",
      "[probe:m0_chapters] rev_1 0 -",
    ]),
    undefined,
  );
  // A real fold pass: the fold-commit marker and the post-fold ids share rev_fold.
  const folded = foldCommittedRenderedIdsFromMarkers([
    "[probe:m0_memory_ids] rev_1 1,2",
    "[probe:fold_committed] rev_fold",
    "[probe:m0_memory_ids] rev_fold 2,3,4",
    "[probe:m0_chapters] rev_fold 1 abc",
  ]);
  assert.deepEqual(folded, { revision: "rev_fold", postFoldRenderedIds: new Set([2, 3, 4]) });
  // The LATEST fold wins when a session folded twice: its post-fold set describes
  // the current baseline.
  const doubleFold = foldCommittedRenderedIdsFromMarkers([
    "[probe:fold_committed] rev_a",
    "[probe:m0_memory_ids] rev_a 1",
    "[probe:fold_committed] rev_b",
    "[probe:m0_memory_ids] rev_b 2,3",
  ]);
  assert.deepEqual(doubleFold, { revision: "rev_b", postFoldRenderedIds: new Set([2, 3]) });
  // A fold-commit marker whose revision has NO memory-ids line is a gap: the
  // pass folded but we cannot see what it rendered.
  const noRender = foldCommittedRenderedIdsFromMarkers(["[probe:fold_committed] rev_x"]);
  assert.deepEqual(noRender, { revision: "rev_x", postFoldRenderedIds: undefined });
  // An empty rendered set at the fold revision is observed (the fold COMMIT saw
  // nothing) - different from the absent marker above, which stays a gap.
  const emptyFold = foldCommittedRenderedIdsFromMarkers([
    "[probe:fold_committed] rev_z",
    "[probe:m0_memory_ids] rev_z -",
  ]);
  assert.deepEqual(emptyFold, { revision: "rev_z", postFoldRenderedIds: new Set() });
});

test("non-marker 3-token lines never set rendered-memory observed (audit NOTE anchor)", () => {
  // A "refreshed 7 memories"-style line must NOT flip the rendered set from
  // "we never saw a marker" (undefined) to "we saw an empty set" (a set).
  assert.equal(
    renderedMemoryIdsFromMarkers(["[buddy] refreshed 7 memories", "[buddy] other junk here"]),
    undefined,
  );
  assert.equal(renderedChaptersFromMarkers(["some line with 3 tokens here", "another 1 2 3"]), undefined);
  // A trailing comma in the id list is not an id 0 (Number("")===0 would parse
  // "1,2," as {1,2,0} on a non-anchored regex; the anchored one drops it).
  assert.deepEqual(renderedMemoryIdsFromMarkers(["[probe:m0_memory_ids] rev_1 1,2,"]), new Set([1, 2]));
});

test("L3 reports its evidence class: restart_substitute for session, fold_commit for real folds", () => {
  const sessionPass = attributeMemoryFunnel({
    distance: "session",
    seedRequired: true,
    seedPresentInReadback: true,
    renderedMemoryIdsObserved: true,
    seedIdRendered: true,
    foldObserved: true,
    postFoldAssembly: "present",
  });
  const l3 = sessionPass.stages.find((row) => row.stage === "L3_decay");
  assert.equal(l3.status, "passed");
  assert.equal(l3.l3Evidence, "restart_substitute");
  assert.equal(l3.detail, "seed id still rendered after the restart");

  const foldGap = attributeMemoryFunnel({ distance: "fold", seedRequired: true, seedPresentInReadback: true });
  assert.equal(foldGap.stages.find((row) => row.stage === "L3_decay").l3Evidence, "fold_commit");

  const foldPass = attributeMemoryFunnel({
    distance: "fold",
    seedRequired: true,
    seedPresentInReadback: true,
    renderedMemoryIdsObserved: true,
    seedIdRendered: true,
    realFold: { revision: "rev_fold", postFoldRenderedIds: new Set([2]), seedId: 2 },
  });
  assert.equal(foldPass.stages.find((row) => row.stage === "L3_decay").l3Evidence, "fold_commit");
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
    { distance: "fold", seedRequired: true, seedPresentInReadback: true, renderedMemoryIdsObserved: true, seedIdRendered: true, realFold: { revision: "rev_fold", postFoldRenderedIds: new Set([1]), seedId: 2 } },
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

test("renderedMemoryIdsFromMarkers distinguishes an absent marker from an empty render", () => {
  // An absent marker is a PRODUCER gap - the vendor never told us anything. An
  // emitted `-` is a real observation that m[0] carried no memories. Collapsing
  // these two would report "we do not know" as "the fact was not rendered", which
  // is exactly the mis-attribution the funnel exists to prevent.
  assert.equal(renderedMemoryIdsFromMarkers([]), undefined);
  assert.notEqual(renderedMemoryIdsFromMarkers([renderedMemoryMarker("rev_1", "-")]), undefined);
  assert.equal(renderedMemoryIdsFromMarkers([renderedMemoryMarker("rev_1", "-")]).size, 0);
});

test("renderedMemoryIdsFromMarkers reads the id list and ignores non-marker lines", () => {
  const single = renderedMemoryIdsFromMarkers(["refreshed 7 memories", renderedMemoryMarker("rev_9", "3,1,2")]);
  assert.deepEqual([...single].sort((left, right) => left - right), [1, 2, 3]);
  // Two emissions in one run union into the observed set rather than overwriting:
  // a pass may render more than once (fold + soft refresh).
  const union = renderedMemoryIdsFromMarkers([renderedMemoryMarker("rev_a", "1,2"), renderedMemoryMarker("rev_b", "2,3")]);
  assert.deepEqual([...union].sort((left, right) => left - right), [1, 2, 3]);
  // A malformed tail is skipped, not parsed as an id: "-" stays empty and junk is dropped.
  const junk = renderedMemoryIdsFromMarkers([renderedMemoryMarker("rev_c", "1,-,abc,2")]);
  assert.deepEqual([...junk].sort((left, right) => left - right), [1, 2]);
});

test("renderedChaptersFromMarkers distinguishes absent from zero and reads count+digest", () => {
  // Absent marker = producer gap; a real `-` digest = vendor says zero chapters.
  assert.equal(renderedChaptersFromMarkers([]), undefined);
  const zero = renderedChaptersFromMarkers([`[probe:m0_chapters] rev_1 0 -`]);
  assert.equal(zero.observed, true);
  assert.equal(zero.count, 0);
  assert.equal(zero.digest, undefined);
  const digest = "a".repeat(64);
  const two = renderedChaptersFromMarkers([`[probe:m0_chapters] rev_2 2 ${digest}`]);
  assert.equal(two.observed, true);
  assert.equal(two.count, 2);
  assert.equal(two.digest, digest);
});

test("renderedChaptersFromMarkers ignores non-marker lines and junk tails", () => {
  const single = renderedChaptersFromMarkers(["refreshed 7 memories", `[probe:m0_chapters] rev_9 1 ${`b`.repeat(64)}`]);
  assert.equal(single.count, 1);
  // A malformed count is reported as null, not fabricated.
  const junk = renderedChaptersFromMarkers([`[probe:m0_chapters] rev_c junk debug`]);
  assert.equal(junk.observed, true);
  assert.equal(junk.count, null);
});

test("a marker-observed render feeds L2 instead of leaving it a gap", () => {
  // The whole point of the L2 producer: with the marker present, the funnel can
  // finally attribute the assembly step rather than reporting a gap.
  const present = attributeMemoryFunnel({
    distance: "turn",
    seedRequired: true,
    seedPresentInReadback: true,
    renderedMemoryIdsObserved: true,
    seedIdRendered: true,
    probeEvent: "needle.hit",
  });
  assert.equal(statusOf(present, "L2_assembly"), "passed");
  assert.equal(present.stages.find((row) => row.stage === "L4_expression").status, "passed");

  // ...and when the id is genuinely missing from a render we DID observe, that is a
  // real L2 break, attributable all the way down.
  const absent = attributeMemoryFunnel({
    distance: "turn",
    seedRequired: true,
    seedPresentInReadback: true,
    renderedMemoryIdsObserved: true,
    seedIdRendered: false,
    probeEvent: "needle.miss",
  });
  assert.equal(statusOf(absent, "L2_assembly"), "broken");
  // A broken upstream stage leaves L4 `not_reached`, not a gap: we KNOW the fact
  // never got in, so the reply says nothing about expression. (The gap rule is for
  // stages we could not observe at all.)
  assert.equal(statusOf(absent, "L4_expression"), "not_reached");
});

function renderedMemoryMarker(revision, ids) {
  return `[probe:m0_memory_ids] ${revision} ${ids}`;
}
test("m0DigestsFromMarkers distinguishes an absent digest marker from a stable render", () => {
  assert.equal(m0DigestsFromMarkers([]), undefined);
  assert.equal(m0DigestsFromMarkers(["refreshed 7 memories", "another 1 2 3"]), undefined);
  // Same revision, same digest across passes -> stable (the prefix-cache contract).
  const stable = m0DigestsFromMarkers([
    "[probe:m0_digest] aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa rev_1",
    "[probe:m0_digest] aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa rev_1",
  ]);
  assert.equal(stable.observed, true);
  assert.equal(stable.passes.length, 2);
  assert.equal(stable.revisionCount, 1);
  assert.equal(stable.stable, true);
});

test("m0DigestsFromMarkers flags a same-revision digest change as unstable and allows a fold revision change", () => {
  const digestA = "a".repeat(64);
  const digestB = "b".repeat(64);
  const unstable = m0DigestsFromMarkers([
    `[probe:m0_digest] ${digestA} rev_1`,
    `[probe:m0_digest] ${digestB} rev_1`,
  ]);
  assert.equal(unstable.stable, false);
  // A legitimate fold advances the revision; each revision is internally stable.
  const folded = m0DigestsFromMarkers([
    `[probe:m0_digest] ${digestA} rev_1`,
    `[probe:m0_digest] ${digestA} rev_1`,
    `[probe:m0_digest] ${digestB} rev_2`,
    `[probe:m0_digest] ${digestB} rev_2`,
  ]);
  assert.equal(folded.revisionCount, 2);
  assert.equal(folded.stable, true);
});

test("m0DigestsFromMarkers ignores malformed digest lines (junk tails, wrong length)", () => {
  assert.equal(
    m0DigestsFromMarkers(["[probe:m0_digest] short-not-a-hash rev_1"]),
    undefined,
  );
  assert.equal(
    m0DigestsFromMarkers(["[probe:m0_digest] zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz rev_1"]),
    undefined,
  );
});