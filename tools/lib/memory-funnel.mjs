/**
 * Parse Magic Context's rendered-memory marker lines into the id set it assembled.
 *
 * Kept here (not in the runner) because the parse IS the L2 evidence boundary: the
 * encoding details below are what decide whether L2 is observed or a gap, so they
 * belong in the module that owns the funnel rules and can be tested without a live
 * run. The marker line is `[probe:m0_memory_ids] <revision> <ids|"-">`.
 *
 * Returns `undefined` when NO marker was present. That distinction is load-bearing:
 * an absent marker means the vendor never reported (a producer gap), while an
 * emitted `-` means it reported an EMPTY rendered set. Collapsing the two would let
 * "we have no idea" masquerade as "the fact was not rendered".
 */
export function renderedMemoryIdsFromMarkers(markers) {
  const ids = new Set();
  let observed = false;
  for (const line of markers) {
    // Exactly three whitespace-separated tokens; anything else is not our marker and
    // must not be read as one (a partially-written line stays a gap, not an empty set).
    const match = /^\S+\s+(\S+)\s+(\S+)$/u.exec(String(line).trim());
    if (match === null) continue;
    observed = true;
    if (match[2] === "-") continue;
    for (const part of match[2].split(",")) {
      const value = Number(part);
      if (Number.isSafeInteger(value) && value >= 0) ids.add(value);
    }
  }
  return observed ? ids : undefined;
}

/**
 * Parse Magic Context's chapter-rollup marker lines into the rendered chapter
 * summary. Same Class B contract as the memory-ids marker (v1 chapter rollup,
 * vendor probe-materialization-marker.ts): the line is
 * `[probe:m0_chapters] <revision> <count> <sha256|\"-\">`.
 *
 * Returns `undefined` when NO marker was present (producer gap) — never a
 * fabricated `{count: 0}`; a real zero-count marker (`-` digest) is the
 * vendor's own report that no chapters rendered this pass, which is different
 * from us not having looked.
 */
export function renderedChaptersFromMarkers(markers) {
  let observed = false;
  let count = null;
  let digest = undefined;
  for (const line of markers) {
    const match = /^\S+\s+(\S+)\s+(\S+)\s+(\S+)$/u.exec(String(line).trim());
    if (match === null) continue;
    observed = true;
    count = Number(match[2]);
    if (match[3] !== "-") digest = match[3];
  }
  if (!observed) return undefined;
  return Object.freeze({
    observed: true,
    count: Number.isSafeInteger(count) && count >= 0 ? count : null,
    ...(digest === undefined ? {} : { digest }),
  });
}

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
 *    failure. If we did not see the write land or the fact rendered, we cannot call
 *    the recall a miss. This holds asymmetrically:
 *      - a downstream PASS always stands (a reply that contains the fact is positive
 *        evidence the fact reached the model, gaps upstream notwithstanding);
 *      - a downstream FAIL is only attributable when every upstream stage was
 *        observed AND passed. Otherwise it is reported as a gap whose reason names
 *        the unobserved upstream stage, because "the model ignored it" and "it never
 *        arrived" are not distinguishable from here.
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
 * Evidence is the management route's own durable readback: `mutate()` ends with
 * `projectRows(await readRows())`, so the response to `PUT /api/tavern/v1/memory`
 * IS a re-read of the vendor store, not a bare acknowledgement (design 10.4, which
 * corrected an earlier assumption that a new `memory.mutated` producer was needed).
 * The caller passes in what that readback showed.
 *
 * `seedRequired !== true` means this run injected no explicit seed, so L1 was not
 * exercised and the stage is omitted rather than reported as a gap.
 */
function stageWrite({ seedRequired, seedPresentInReadback, conflictObserved }) {
  if (seedRequired !== true) return undefined;
  if (conflictObserved === true) return stage("L1_write", "broken", "memory.conflict during the seed window");
  if (seedPresentInReadback !== true) return gap("L1_write", "seed_readback_unobserved");
  return stage("L1_write", "passed", "seed present in the management durable readback");
}

/**
 * L2: was the fact rendered into what the model received?
 *
 * Evidence is Magic Context's own rendered-memory marker: the list of ids that
 * survived the budget trim and were written into m[0]. The caller passes in whether
 * the seeded id appears in it. We never infer this from "the write succeeded, so it
 * must be in the prompt".
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

  // Rule 2, applied asymmetrically. A downstream PASS stands on its own: a reply
  // that contains the fact is positive evidence it reached the model, regardless of
  // a gap upstream. A downstream FAIL does not: if any upstream stage was never
  // observed, "the model ignored it" and "it never arrived" are indistinguishable
  // from here, so the break is reported as a gap naming the unobserved stage rather
  // than attributed to a component that may be innocent.
  const firstGap = rows.findIndex((row) => row?.status === "observability_gap");
  const firstBroken = rows.findIndex((row) => row?.status === "broken");
  const unattributable = firstGap !== -1 && (firstBroken === -1 || firstGap < firstBroken);

  const resolved = rows.map((row, index) => {
    if (row === undefined) return undefined;
    if (unattributable && row.status === "broken" && index > firstGap) {
      return gap(row.stage, `${rows[firstGap].stage}_unobserved`);
    }
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
