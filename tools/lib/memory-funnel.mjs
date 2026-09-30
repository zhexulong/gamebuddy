/**
 * The four-stage memory funnel (design §10.3):
 *
 *   L1 write      did the fact reach durable storage?
 *   L2 assembly   was it rendered into the context the model actually got?
 *   L3 decay      is it still there after a fold / restart?
 *   L4 expression did the model act on it?
 *
 * This module is a pure attributor: it consumes already-observed facts and
 * reports, per stage, whether that stage was observed, passed, or broke. It never
 * reads a product, never opens a socket, and never guesses a stage from a later
 * one.
 *
 * Three rules from the design are enforced structurally rather than documented:
 *
 * 1. Stages report INDEPENDENTLY. There is no aggregate score, no weights, and no
 *    headline number - `summarizeMemoryFunnel` returns a per-stage row set and
 *    findings, never a single verdict (design §8 anti-target).
 * 2. An unobserved upstream stage YIELDS `observability_gap`, never a downstream
 *    failure. If we did not see the write land, we cannot call the recall a miss.
 * 3. Every stage's evidence is a product-owned fact the caller passes in. A stage
 *    is only `passed`/`broken` when its own evidence is present.
 *
 * Component names mirror `tools/lib/system-findings.mjs` so a memory finding and a
 * Game finding can travel through the same comparison tooling.
 */

/** The stages, in funnel order. Order matters: upstream gates downstream. */
export const MEMORY_FUNNEL_STAGES = Object.freeze(["L1_write", "L2_assembly", "L3_decay", "L4_expression"]);

const STAGE_LABELS = Object.freeze({
  L1_write: "persistence",
  L2_assembly: "context_materialization",
  L3_decay: "consolidation",
  L4_expression: "presentation_admission",
});

/**
 * A stage outcome when we were not given the evidence that stage needs.
 *
 * This is deliberately NOT a failure. The audit design's whole premise (§2 seed
 * readiness, §3.3 evidence classes) is that an unobserved fact must be reported
 * as a gap so a missing producer can never masquerade as a product defect.
 */
function gap(stage, reason) {
  return Object.freeze({
    stage,
    component: STAGE_LABELS[stage],
    status: "observability_gap",
    reason,
  });
}

function stage(stageId, status, detail) {
  return Object.freeze({
    stage: stageId,
    component: STAGE_LABELS[stageId],
    status,
    ...(detail === undefined ? {} : { detail }),
  });
}

/**
 * L1: did the explicit write become durable?
 *
 * Evidence is the harness-observed `memory.mutated`/`memory.conflict` pair for the
 * seed window. `memory.mutated` currently has NO producer (design §10.2), so a
 * caller that never saw one must report a gap - this function does that by only
 * marking the stage when the mutation fact itself is present.
 */
function stageWrite({ mutationObserved, conflictObserved, seedRequired }) {
  if (seedRequired !== true) return undefined;
  if (conflictObserved === true) return stage("L1_write", "broken", "memory.conflict during the seed window");
  if (mutationObserved !== true) return gap("L1_write", "memory_mutation_unobserved");
  return stage("L1_write", "passed", "memory.mutated observed in the seed window");
}

/**
 * L2: was the fact rendered into what the model received?
 *
 * Evidence is Magic Context's own persisted `ModuleMeta.rendered_memory_ids` - the
 * list of ids that survived the budget trim and were written into m[0]. The caller
 * passes in whether the seeded id appears in it. We never infer this from "the
 * write succeeded, so it must be in the prompt".
 */
function stageAssembly({ renderedMemoryIdsObserved, seedIdRendered }) {
  // L2 is the delivery step every distance must obtain to attribute its own
  // result; without the rendered manifest the probe cannot say whether the fact
  // ever reached the model.
  if (renderedMemoryIdsObserved !== true) return gap("L2_assembly", "rendered_memory_ids_unobserved");
  if (seedIdRendered === true) return stage("L2_assembly", "passed", "seed id present in the rendered m[0] manifest");
  return stage("L2_assembly", "broken", "seed id absent from the rendered m[0] manifest after budget trim");
}

/**
 * L3: did it survive a fold or a restart?
 *
 * Evidence is the fold marker's own revision binding plus a re-read of the L2 fact
 * after the fold.
 *
 * `not_applicable` vs `observability_gap` matters here and is easy to conflate: a
 * turn-distance probe never crosses a fold, so L3 was not exercised at all
 * (`not_applicable`). A fold-distance probe *should* have produced a marker, so a
 * missing one is a genuine gap. Reporting the first as a gap would claim we tried
 * to observe a fold we never asked for.
 */
function stageDecay({ distance, foldObserved, postFoldAssembly }) {
  if (distance !== "fold" && distance !== "session") return undefined;
  if (foldObserved !== true) return gap("L3_decay", "fold_not_observed");
  if (postFoldAssembly === undefined) return gap("L3_decay", "post_fold_assembly_unobserved");
  if (postFoldAssembly === "present") return stage("L3_decay", "passed", "seed id still rendered after the fold");
  return stage("L3_decay", "broken", "seed id dropped across the fold");
}

/**
 * L4: did the reply show the fact was used?
 *
 * Evidence is the probe turn's own committed reply scored by the frozen keyword
 * rule. `verdict` is the probe event plus its `reason`; the two halves of
 * `distractor.confused` are NOT equivalent (design §3.2): `needle_only` means the
 * fact was recalled, `recall_failed` means it was not.
 */
function stageExpression({ probeEvent, probeReason }) {
  if (typeof probeEvent !== "string" || probeEvent.length === 0)
    return gap("L4_expression", "probe_verdict_unobserved");
  if (probeEvent === "needle.hit" || probeEvent === "supersede.pass")
    return stage("L4_expression", "passed", probeEvent);
  if (probeEvent === "needle.miss" || probeEvent === "supersede.fail")
    return stage("L4_expression", "broken", probeEvent);
  if (probeEvent === "distractor.confused") {
    // The cause decides: recalling the needle while a forbidden word co-occurred
    // is recall; failing to recall is the memory failure.
    if (probeReason === "needle_only") return stage("L4_expression", "passed", "distractor.confused/needle_only");
    if (probeReason === "recall_failed") return stage("L4_expression", "broken", "distractor.confused/recall_failed");
    return gap("L4_expression", "distractor_cause_unobserved");
  }
  return gap("L4_expression", `probe_verdict_${probeEvent}`);
}

/**
 * Attribute one memory observation to the funnel.
 *
 * Returns the four stage rows (in order, `undefined` for a stage the observation
 * did not reach) plus the findings implied by the stages that DID break. The
 * funnel stops attributing at the first broken stage: a stage downstream of a
 * break is `not_reached`, because claiming it passed or failed would attribute a
 * product defect to a layer the run never exercised.
 */
export function attributeMemoryFunnel(observation = {}) {
  const rows = [
    stageWrite(observation),
    stageAssembly(observation),
    stageDecay(observation),
    stageExpression(observation),
  ];

  const firstBroken = rows.findIndex((row) => row?.status === "broken");
  const resolved = rows.map((row, index) => {
    if (row === undefined) return undefined;
    if (firstBroken === -1 || index <= firstBroken) return row;
    return Object.freeze({
      stage: row.stage,
      component: row.component,
      status: "not_reached",
      reason: `upstream_${rows[firstBroken].stage}_broken`,
    });
  });

  const findings = [];
  for (const row of resolved) {
    if (row === undefined || row.status !== "broken") continue;
    findings.push(
      Object.freeze({
        id: `memory_funnel_${row.stage.toLowerCase()}`,
        component: row.component,
        count: 1,
        detail: `${row.stage} broke: ${row.detail ?? row.reason}`,
        recommendation: RECOMMENDATIONS[row.stage],
      }),
    );
  }

  return Object.freeze({
    stages: Object.freeze(resolved.filter((row) => row !== undefined)),
    findings: Object.freeze(findings),
  });
}

/**
 * One recommendation per stage - the concrete system change each break points at.
 * Kept here so a finding never arrives without an actionable next step (the same
 * discipline as the Game-side `system-findings.mjs`).
 */
const RECOMMENDATIONS = Object.freeze({
  L1_write: "persistence layer: check the CAS/transaction outcome on the write path before blaming recall",
  L2_assembly: "context materialization: the fact was stored but did not survive rendering - inspect the token budget and visibility predicate",
  L3_decay: "consolidation: the fact survived until a fold/restart and then did not - inspect the fold compression and whether this fact class needs a permanent exemption",
  L4_expression: "presentation admission: the fact was in the context but did not reach the reply - inspect the system prompt's attention and the model settings",
});

/**
 * Roll several funnel observations into per-stage counts.
 *
 * Still no aggregate: the return value is a per-stage tally plus the union of
 * findings, so a report can print each layer's own number.
 */
export function summarizeMemoryFunnel(observations = []) {
  const counts = {};
  for (const stageId of MEMORY_FUNNEL_STAGES) counts[stageId] = { passed: 0, broken: 0, observability_gap: 0, not_reached: 0 };
  const findings = [];
  for (const observation of observations) {
    const attributed = attributeMemoryFunnel(observation);
    for (const row of attributed.stages) {
      const bucket = counts[row.stage];
      if (bucket === undefined) continue;
      bucket[row.status] = (bucket[row.status] ?? 0) + 1;
    }
    findings.push(...attributed.findings);
  }
  return Object.freeze({ counts: Object.freeze(counts), findings: Object.freeze(findings) });
}
