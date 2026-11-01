/**
 * One verdict vocabulary for the three live loops, mapped at their boundaries.
 *
 * `tools/live-run/core/evidence-verdict.mjs` names the three outcomes every loop already
 * distinguishes - `verified` / `failed` / `unobserved` - and makes "no evidence" unable to
 * double as a pass. The Game loop judges through it directly. The Chat and Memory loops each
 * arrived at the SAME three outcomes under their own spellings:
 *
 *   Chat    `probeVerdict` emits frozen probe codes (`needle.hit`, `supersede.fail`, ...) and
 *           `observability_gap` when the turn had nothing to score.
 *   Memory  `attributeMemoryFunnel` reports per-stage `passed` / `broken` /
 *           `observability_gap` / `not_reached`.
 *
 * This module is the JOIN, not a rewrite. Nothing here re-judges: each function takes the
 * outcome the owning loop already decided and renames it into the shared vocabulary, so a
 * comparison tool can read one field named `state` across all three.
 *
 * ## Why the local vocabulary stays
 *
 * The mapping is additive in both directions, and that is deliberate:
 *
 *  - the LOCAL code travels beside the shared state (`local`), because it is what makes a
 *    failure actionable. `failed` alone cannot distinguish "the needle was never recalled" from
 *    "the old fact survived a supersede" from "the isolation fence leaked" - and those are
 *    three different repairs.
 *  - `distractor.confused` needs its own `reason` to be mappable at all: `needle_only` means the
 *    fact WAS recalled while a forbidden word co-occurred, `recall_failed` means it was not.
 *    `attributeMemoryFunnel` already draws exactly that line (`stageExpression`), so this module
 *    follows it rather than inventing a second reading.
 *
 * Collapsing the codes into three states and discarding them would lose the reasons and keep
 * none of the distinctions; keeping only the codes would deny a comparison tool a common field.
 * Both, with the local code named, is the only version that loses neither.
 *
 * ## What is deliberately NOT mapped
 *
 * A run's LIFECYCLE status is not a verdict. The Chat harness closes `run.finished` with
 * `status: "collected"`, and `collected` means "the harness observed what it could" - not "the
 * evidence held". Mapping it to `verified` would re-create the exact defect `evidence-verdict.mjs`
 * was written for (a gate whose default on missing evidence is PASS), so `collected` stays a
 * lifecycle fact and the verdict is computed from the loop's own judgements alone.
 */

import { EVIDENCE_STATE, rollupVerdicts } from "./evidence-verdict.mjs";

/** One run's mapped verdict, published beside the loop's own artifacts. */
export const RUN_VERDICT_SCHEMA = "live_run_verdict/v1";

/**
 * Chat's frozen probe codes, as `probeVerdict` emits them (`chat/run-chat-live-audit.mjs`), mapped
 * onto the shared states.
 *
 * The table is keyed by the code the trace carries (the emitted event's `code`, not the
 * `probe.`-prefixed vocabulary key). A code that is absent here is `unobserved` with its own
 * name, so a probe added tomorrow fails closed by name instead of mapping to nothing quietly.
 */
const CHAT_PROBE_STATES = Object.freeze({
  "needle.hit": EVIDENCE_STATE.verified,
  "needle.miss": EVIDENCE_STATE.failed,
  "distractor.clean": EVIDENCE_STATE.verified,
  "supersede.pass": EVIDENCE_STATE.verified,
  "supersede.fail": EVIDENCE_STATE.failed,
  "isolation.clean": EVIDENCE_STATE.verified,
  "isolation.breach": EVIDENCE_STATE.failed,
  observability_gap: EVIDENCE_STATE.unobserved,
});

/**
 * The one code whose shared state depends on its own `reason`.
 *
 * `distractor.confused` is two different facts under one name, and `evidence-verdict.mjs`'s whole
 * premise is that they must not be flattened: a reply that recalls the needle while denying the
 * distractor is a correct reply, and calling it a failure would make the gate cry wolf. The
 * `needle_only` / `recall_failed` split is `attributeMemoryFunnel`'s own (`stageExpression`), so
 * the two loops agree by construction rather than by two tables that happen to match today.
 */
const DISTRACTOR_CAUSE_STATES = Object.freeze({
  needle_only: EVIDENCE_STATE.verified,
  recall_failed: EVIDENCE_STATE.failed,
});

/**
 * Memory's funnel statuses (`tools/lib/memory-funnel.mjs`), mapped onto the shared states.
 *
 * `not_reached` maps to `unobserved` rather than to a state of its own: the funnel stopped at an
 * earlier broken stage, so this stage was never exercised and there is no evidence for it. It
 * keeps its own name in `local`, so a reader still sees that it was SKIPPED after a break rather
 * than looked at and missed. `not_applicable` never reaches here - a stage the observation did not
 * reach is omitted from `stages` entirely, by the funnel's own design.
 */
const MEMORY_STAGE_STATES = Object.freeze({
  passed: EVIDENCE_STATE.verified,
  broken: EVIDENCE_STATE.failed,
  observability_gap: EVIDENCE_STATE.unobserved,
  not_reached: EVIDENCE_STATE.unobserved,
});

/**
 * One Chat probe code as a shared verdict.
 *
 * `code` is what the trace carries; `reason` is the probe's own bounded cause when it has one.
 * An unknown code, or a `distractor.confused` with no recognised cause, is `unobserved` naming
 * itself - never a silent pass.
 */
export function chatProbeVerdict({ code, reason } = {}) {
  if (typeof code !== "string" || code.length === 0)
    return Object.freeze({ state: EVIDENCE_STATE.unobserved, reason: "probe_code_missing", local: null });
  if (code === "distractor.confused") {
    const mapped = typeof reason === "string" ? DISTRACTOR_CAUSE_STATES[reason] : undefined;
    return mapped === undefined
      ? Object.freeze({ state: EVIDENCE_STATE.unobserved, reason: "distractor_cause_unobserved", local: code })
      : Object.freeze({ state: mapped, reason: reason, local: code });
  }
  const mapped = CHAT_PROBE_STATES[code];
  if (mapped === undefined)
    return Object.freeze({ state: EVIDENCE_STATE.unobserved, reason: `unmapped_probe_code:${code}`, local: code });
  return Object.freeze({
    state: mapped,
    reason: typeof reason === "string" && reason.length > 0 ? reason : null,
    local: code,
  });
}

/** One Memory funnel stage row as a shared verdict. */
export function memoryStageVerdict(row) {
  const stage = typeof row?.stage === "string" ? row.stage : null;
  const status = typeof row?.status === "string" ? row.status : undefined;
  const mapped = status === undefined ? undefined : MEMORY_STAGE_STATES[status];
  if (mapped === undefined) {
    return Object.freeze({
      state: EVIDENCE_STATE.unobserved,
      reason: status === undefined ? "memory_stage_status_missing" : `unmapped_memory_stage_status:${status}`,
      local: status ?? null,
      stage,
    });
  }
  return Object.freeze({
    state: mapped,
    reason: typeof row?.reason === "string" && row.reason.length > 0 ? row.reason : null,
    local: status,
    stage,
  });
}

/**
 * Roll several mapped verdicts into one, through the shared rollup.
 *
 * An EMPTY list is `unobserved`, not `verified`: `rollupVerdicts([])` is vacuously all-verified,
 * which is precisely the "a gate with nothing to check passes" shape this whole vocabulary
 * exists to remove. A run that measured no judgement therefore says `no_evidence` by name.
 */
export function rollupMappedVerdicts(verdicts, { reasons } = {}) {
  const list = Array.isArray(verdicts) ? verdicts : [];
  if (list.length === 0)
    return Object.freeze({
      state: EVIDENCE_STATE.unobserved,
      reason: typeof reasons?.empty === "string" && reasons.empty.length > 0 ? reasons.empty : "no_evidence",
    });
  const rolled = rollupVerdicts(list);
  return Object.freeze({ state: rolled.state, reason: rolled.reasons.find((reason) => reason !== null) ?? null });
}

/**
 * One Chat run's verdict, from the probe events its trace carries.
 *
 * A default run has no probe manifest and therefore no probe events at all; that is `unobserved`
 * with `no_probe_evidence`, which is the truthful statement - a run with no recall claim to make
 * has not verified one.
 */
export function buildChatRunVerdict(events) {
  const probeEvents = (Array.isArray(events) ? events : []).filter((event) => event?.kind === "probe");
  const checks = probeEvents.map((event) =>
    Object.freeze({
      id: typeof event.meta?.probeId === "string" ? event.meta.probeId : null,
      ...chatProbeVerdict({ code: event.code, reason: event.meta?.reason }),
    }),
  );
  const rolled = rollupMappedVerdicts(checks, { reasons: { empty: "no_probe_evidence" } });
  return Object.freeze({
    schema: RUN_VERDICT_SCHEMA,
    state: rolled.state,
    reason: rolled.reason,
    checks: Object.freeze(checks),
  });
}

/** One Memory run's verdict, from the funnel stages its report carries. */
export function buildMemoryRunVerdict(stages) {
  const rows = (Array.isArray(stages) ? stages : []).filter((row) => row !== undefined && row !== null);
  const checks = rows.map((row) => Object.freeze({ id: row.stage ?? null, ...memoryStageVerdict(row) }));
  const rolled = rollupMappedVerdicts(checks, { reasons: { empty: "no_funnel_stage_evidence" } });
  return Object.freeze({
    schema: RUN_VERDICT_SCHEMA,
    state: rolled.state,
    reason: rolled.reason,
    checks: Object.freeze(checks),
  });
}

/**
 * One line per run, in the vocabulary a comparison tool reads.
 *
 * The surface name travels in the line because the three loops measure three different questions: a reader
 * diffing two runs needs to know which loop produced `unobserved` before deciding whether that gap is a
 * regression.
 */
export function narrateRunVerdict(surface, verdict) {
  const reason = verdict.reason === null ? "" : ` reason=${verdict.reason}`;
  const checks =
    verdict.checks.length === 0
      ? ["  (no checks)"]
      : verdict.checks.map((check) => {
          const local = check.local === null ? "" : ` local=${check.local}`;
          return `  ${String(check.id)}: ${check.state}${local}${check.reason === null ? "" : ` (${check.reason})`}`;
        });
  return [`[${surface}-live] run verdict state=${verdict.state}${reason}`, ...checks].join("\n");
}
