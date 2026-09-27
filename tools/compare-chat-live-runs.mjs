/**
 * Compare two Chat live-run audit traces (`chat_run_audit/v1`) and report what
 * changed in the Chat system's health signal between them.
 *
 * Usage:
 *   node tools/compare-chat-live-runs.mjs <baseline.json> <after.json>
 *
 * Exit code 0 = no regressions; 1 = a regression was found; 2 = usage or
 * validation error. An invalid input is never partially compared.
 *
 * Why this exists: one live run is a health report, not a pass/blocked verdict.
 * Reading it tells you what happened; only comparing two tells you whether a
 * system change actually helped. This is the Chat counterpart of
 * tools/compare-live-run-findings.mjs and shares its judgements:
 *   - counters that name waste (resyncs, /state reads, conflicts, invalid frames,
 *     reload mismatches, provider errors, presentation rejections) must go DOWN;
 *   - counters that name delivered value (committed presentations, settled
 *     provider turns, settled reloads, completed turns) must go UP;
 *   - audit findings are graded by appearance: a finding present where it was
 *     absent is always a regression, its disappearance is an improvement;
 *   - opaque values (per-turn terminal state, provider observability) only change;
 *   - measured durations are reported and never ranked, because a slower run is
 *     provider and machine noise rather than by itself a system regression.
 *
 * `chat_run_audit/v1` freezes only the event stream, so the audit findings that
 * name a Chat defect are derived here from that stream. Only findings whose
 * condition the design states exactly are derived (`design/tasks/active/
 * chat-run-audit-and-release-verdict.md` §4). The waste-envelope thresholds
 * (micro-stepping, idle-stall) belong to the audit kernel, so this tool reports
 * the threshold-free signal instead: per-turn /state reads and SSE frame counts,
 * the longest SSE frame gap, and the per-turn durations.
 */
import { existsSync, readFileSync } from "node:fs";
import { CHAT_RUN_AUDIT_CODES_BY_KIND, CHAT_RUN_AUDIT_META_KEYS, CHAT_RUN_AUDIT_PROBE_DIMENSIONS, CHAT_RUN_AUDIT_PROBE_DISTANCES } from "./lib/chat-run-audit.mjs";

const USAGE = "usage: node tools/compare-chat-live-runs.mjs <baseline.json> <after.json>";
const TRACE_SCHEMA = "chat_run_audit/v1";
const COMPARISON_SCHEMA = "chat_live_run_comparison/v1";

class InvalidTraceError extends Error {}

/** @returns {never} */
function fail(reason) {
  throw new InvalidTraceError(reason);
}

function vocabulary(kind, direction, integrity = false) {
  return Object.freeze({ kind, direction, integrity });
}

/**
 * Graded direction + integrity class per frozen §3.1 row, keyed by the
 * `kind.code` label. The label set is checked against the kernel's exported
 * vocabulary below, so this table can add grading but can never silently drift
 * from the frozen codes (a missing or extra row fails at load).
 */
const EVENT_GRADING = Object.freeze({
  "lifecycle.run.started": vocabulary("lifecycle", "neutral"),
  "lifecycle.run.finished": vocabulary("lifecycle", "neutral"),
  "lifecycle.turn.submitted": vocabulary("lifecycle", "neutral"),
  "lifecycle.turn.terminal": vocabulary("lifecycle", "neutral"),
  "http.state.read": vocabulary("http", "down"),
  "http.state.conflict": vocabulary("http", "down", true),
  "sse.frame.received": vocabulary("sse", "neutral"),
  "sse.frame.invalid": vocabulary("sse", "down", true),
  "sse.stream.resync": vocabulary("sse", "down"),
  "provider.request.sent": vocabulary("provider", "neutral"),
  "provider.settled": vocabulary("provider", "up"),
  "provider.error": vocabulary("provider", "down"),
  // A run without provider boundary evidence is an observation limit, not a
  // defect (design §3.2 rule 4): it stays visible and never fails the comparison.
  "provider.observability_gap": vocabulary("provider", "neutral"),
  "provider.boundary_unsettled": vocabulary("provider", "down", true),
  "presentation.admitted": vocabulary("presentation", "neutral"),
  "presentation.committed": vocabulary("presentation", "up"),
  "presentation.rejected": vocabulary("presentation", "down"),
  "presentation.observability_gap": vocabulary("presentation", "neutral"),
  "memory.read": vocabulary("memory", "neutral"),
  "memory.mutated": vocabulary("memory", "neutral"),
  "memory.conflict": vocabulary("memory", "down"),
  "recovery.reload.started": vocabulary("recovery", "neutral"),
  "recovery.reload.settled": vocabulary("recovery", "up"),
  "recovery.reload.mismatch": vocabulary("recovery", "down", true),
  // Probe results (probe design §6.1). More hits / clean distractors / passed
  // supersedes / clean isolation are the system doing better; misses, confused
  // distractors and failed supersedes are measurements of the wrong behaviour;
  // an observation gap mirrors provider.observability_gap and stays neutral. A
  // breach is the single fail-closed probe outcome and is graded like
  // recovery.reload.mismatch: its appearance is an integrity regression.
  "probe.needle.hit": vocabulary("probe", "up"),
  "probe.needle.miss": vocabulary("probe", "down"),
  "probe.distractor.clean": vocabulary("probe", "up"),
  "probe.distractor.confused": vocabulary("probe", "down"),
  "probe.supersede.pass": vocabulary("probe", "up"),
  "probe.supersede.fail": vocabulary("probe", "down"),
  "probe.isolation.clean": vocabulary("probe", "up"),
  "probe.isolation.breach": vocabulary("probe", "down", true),
  "probe.observability_gap": vocabulary("probe", "neutral"),
});

/**
 * The `kind.code` label of an event. §3.1 spells a wire code as `<kind>.<code>`,
 * and the trace stores `kind` and `code` as separate fields.
 */
function eventLabel(event) {
  return `${event.kind}.${event.code}`;
}

/**
 * Fail at load when this table and the kernel's frozen vocabulary disagree, so
 * the two consumers of one contract cannot drift apart again.
 */
const FROZEN_LABELS = Object.freeze(
  Object.entries(CHAT_RUN_AUDIT_CODES_BY_KIND).flatMap(([kind, codes]) => codes.map((code) => `${kind}.${code}`)),
);
for (const label of FROZEN_LABELS) {
  if (!Object.hasOwn(EVENT_GRADING, label)) fail(`grading table is missing frozen label ${label}`);
}
for (const label of Object.keys(EVENT_GRADING)) {
  if (!FROZEN_LABELS.includes(label)) fail(`grading table has a label that is not frozen: ${label}`);
}

/** The only meta keys the frozen schema allows. Derived from the kernel export
 * exactly like the code vocabulary above, so there is one authority: a new or
 * renamed meta key cannot appear in the kernel and be silently rejected here
 * (which would make compare exit 2 on every real trace). */
const META_KEYS = new Set(CHAT_RUN_AUDIT_META_KEYS);
const EVENT_FIELDS = new Set(["at", "kind", "actor", "code", "meta"]);
const ACTORS = new Set(["harness", "host", "provider", "player"]);
const CODE_PATTERN = /^[a-z0-9_.:-]{1,160}$/;
const MAX_META_KEYS = 8;
const MAX_META_TEXT = 160;
const PROBE_KIND = "probe";
const PROBE_ISOLATION_BREACH = "probe.isolation.breach";
const PROBE_ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Per-row obligations of a `probe` event, mirroring the audit kernel. Every
 * probe result is bound to the fixture manifest it measured (opaque `probeId` +
 * `manifestDigest`); a breach additionally has to name its distance and declare
 * `dimension=isolation`. A trace that violates any of these is rejected here
 * rather than compared, so two runs can never be diffed on unbound evidence.
 */
function probeObligationError(label, meta) {
  if (!label.startsWith(`${PROBE_KIND}.`)) return null;
  if (typeof meta.probeId !== "string" || !PROBE_ID.test(meta.probeId)) {
    return `${label} must carry meta.probeId as an opaque bounded token`;
  }
  if (typeof meta.manifestDigest !== "string" || !SHA256.test(meta.manifestDigest)) {
    return `${label} must carry meta.manifestDigest as a lowercase sha256 hex digest`;
  }
  if (meta.distance !== undefined && !CHAT_RUN_AUDIT_PROBE_DISTANCES.includes(meta.distance)) {
    return `${label} meta.distance ${JSON.stringify(meta.distance)} is not one of ${CHAT_RUN_AUDIT_PROBE_DISTANCES.join(", ")}`;
  }
  if (meta.dimension !== undefined && !CHAT_RUN_AUDIT_PROBE_DIMENSIONS.includes(meta.dimension)) {
    return `${label} meta.dimension ${JSON.stringify(meta.dimension)} is not one of ${CHAT_RUN_AUDIT_PROBE_DIMENSIONS.join(", ")}`;
  }
  if (label === PROBE_ISOLATION_BREACH) {
    if (!CHAT_RUN_AUDIT_PROBE_DISTANCES.includes(meta.distance)) return `${label} must carry meta.distance`;
    if (meta.dimension !== "isolation") return `${label} must carry meta.dimension=isolation`;
  }
  return null;
}

/**
 * Derived Chat audit findings. Every one of these is an integrity finding: its
 * appearance is always a regression, whatever the count.
 */
const FINDINGS = Object.freeze({
  hollow_success:
    "a turn reported terminal completed with no presentation.committed in that turn — success claimed without durable visible output",
  terminal_failed_without_problem_code:
    "a turn reported terminal failed with no provider.error carrying a problemCode — the failure cannot be attributed",
  terminal_cancelled_without_readback:
    "a turn reported terminal cancelled with no /state read afterwards — the cancel was never confirmed against durable state",
  provider_boundary_unsettled:
    "provider.request.sent was observed for a turn that never reached any terminal state — the provider boundary did not settle",
});

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoTimestamp(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function validateEvent(event, index, previousAt) {
  if (!isPlainObject(event)) fail(`events[${index}] is not an object`);
  for (const field of Object.keys(event)) {
    if (!EVENT_FIELDS.has(field)) fail(`events[${index}] has unknown field ${JSON.stringify(field)}`);
  }
  if (typeof event.at !== "number" || !Number.isFinite(event.at) || event.at < 0) {
    fail(`events[${index}].at must be a finite number >= 0`);
  }
  if (event.at < previousAt) {
    fail(`events[${index}].at ${event.at} precedes events[${index - 1}].at ${previousAt}`);
  }
  if (typeof event.code !== "string" || !CODE_PATTERN.test(event.code)) {
    fail(`events[${index}].code is not a bounded lowercase reason code`);
  }
  if (typeof event.kind !== "string") {
    fail(`events[${index}].kind must be a string`);
  }
  // `kind` and `code` are separate fields on the wire; the frozen vocabulary is
  // keyed by their `<kind>.<code>` composition. Deriving the key this way means
  // a bare-code lookup can never silently accept a code from another kind.
  const entry = EVENT_GRADING[eventLabel(event)];
  if (!entry) {
    fail(`events[${index}] ${JSON.stringify(eventLabel(event))} is not in the frozen ${TRACE_SCHEMA} vocabulary`);
  }
  if (typeof event.actor !== "string" || !ACTORS.has(event.actor)) {
    fail(`events[${index}].actor ${JSON.stringify(event.actor)} is not an allowed actor`);
  }
  if (eventLabel(event).startsWith(`${PROBE_KIND}.`)) {
    const obligation = probeObligationError(eventLabel(event), event.meta ?? {});
    if (obligation !== null) fail(`events[${index}] ${obligation}`);
  }
  if (event.meta === undefined) return;
  if (!isPlainObject(event.meta)) fail(`events[${index}].meta must be an object`);
  const keys = Object.keys(event.meta);
  if (keys.length > MAX_META_KEYS) {
    fail(`events[${index}].meta has ${keys.length} keys, at most ${MAX_META_KEYS} are allowed`);
  }
  for (const key of keys) {
    if (!META_KEYS.has(key)) fail(`events[${index}].meta.${key} is not an allowed meta key`);
    const value = event.meta[key];
    const scalar = typeof value === "string" || typeof value === "number" || typeof value === "boolean";
    if (!scalar) fail(`events[${index}].meta.${key} must be a scalar`);
    if (typeof value === "string" && value.length > MAX_META_TEXT) {
      fail(`events[${index}].meta.${key} exceeds ${MAX_META_TEXT} characters`);
    }
  }
}

function validateTrace(trace) {
  if (!isPlainObject(trace)) fail("top level is not a JSON object");
  if (trace.schema !== TRACE_SCHEMA) {
    fail(`schema is ${JSON.stringify(trace.schema)}, expected ${JSON.stringify(TRACE_SCHEMA)}`);
  }
  for (const key of ["runId", "startedAt", "completedAt"]) {
    if (typeof trace[key] !== "string" || trace[key].length === 0) fail(`${key} must be a non-empty string`);
  }
  if (!isIsoTimestamp(trace.startedAt)) fail("startedAt is not an ISO 8601 timestamp");
  if (!isIsoTimestamp(trace.completedAt)) fail("completedAt is not an ISO 8601 timestamp");
  if (trace.surface !== "chat-only") {
    fail(`surface is ${JSON.stringify(trace.surface)}, expected "chat-only"`);
  }
  if (typeof trace.originMs !== "number" || !Number.isFinite(trace.originMs) || trace.originMs < 0) {
    fail("originMs must be a finite number >= 0");
  }
  const artifact = trace.artifact;
  if (
    !isPlainObject(artifact) ||
    typeof artifact.generation !== "string" ||
    artifact.generation.length === 0 ||
    typeof artifact.inventoryDigest !== "string" ||
    artifact.inventoryDigest.length === 0
  ) {
    fail("artifact must carry a non-empty generation and inventoryDigest");
  }
  const provider = trace.provider;
  if (!isPlainObject(provider) || typeof provider.embedded !== "boolean" || typeof provider.observed !== "boolean") {
    fail("provider must carry boolean embedded and observed");
  }
  if (!Array.isArray(trace.events)) fail("events must be an array");

  let previousAt = -1;
  for (let index = 0; index < trace.events.length; index += 1) {
    const event = trace.events[index];
    validateEvent(event, index, previousAt);
    previousAt = event.at;
  }
  return trace;
}

function loadTrace(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new InvalidTraceError(`${path}: cannot read (${error.message})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new InvalidTraceError(`${path}: is not valid JSON (${error.message})`);
  }
  try {
    validateTrace(parsed);
  } catch (error) {
    throw new InvalidTraceError(`${path}: ${error.message}`);
  }
  return { path, trace: parsed };
}

function countByLabel(trace) {
  const counts = Object.create(null);
  for (const event of trace.events) {
    const label = eventLabel(event);
    counts[label] = (counts[label] ?? 0) + 1;
  }
  return counts;
}

/**
 * Group the event stream into turns. A turn opens at `lifecycle.turn.submitted`
 * and closes just before the next one, so the final turn extends to the end of
 * the trace and a late commit still belongs to its turn.
 */
function analyzeTurns(trace) {
  const events = trace.events;
  const starts = [];
  for (let index = 0; index < events.length; index += 1) {
    if (eventLabel(events[index]) === "lifecycle.turn.submitted") starts.push(index);
  }
  return starts.map((start, turnIndex) => {
    const end = turnIndex + 1 < starts.length ? starts[turnIndex + 1] - 1 : events.length - 1;
    return measureTurn(events, start, end);
  });
}

/** The first index in `[start, end]` whose event has `label`, or -1. */
function firstIndexOfLabel(events, start, end, label) {
  for (let index = start; index <= end; index += 1) {
    if (eventLabel(events[index]) === label) return index;
  }
  return -1;
}

function measureTurn(events, start, end) {
  const terminalIndex = firstIndexOfLabel(events, start, end, "lifecycle.turn.terminal");
  const providerSentIndex = firstIndexOfLabel(events, start, end, "provider.request.sent");
  const providerSettledIndex = firstIndexOfLabel(events, start, end, "provider.settled");
  const firstFrameIndex = firstIndexOfLabel(events, start, end, "sse.frame.received");
  let commitCount = 0;
  let problemCode = null;
  let stateReadAfterTerminal = false;
  const frameTimes = [];
  for (let index = start; index <= end; index += 1) {
    const event = events[index];
    const label = eventLabel(event);
    if (label === "presentation.committed") commitCount += 1;
    if (label === "sse.frame.received") frameTimes.push(event.at);
    // A failed turn's attributable cause is projected on the durable terminal
    // itself (`meta.problemCode`); `provider.error` is emitted only for the
    // runtime-unavailable subset. Reading only `provider.error` would report a
    // perfectly attributable failure as unattributable.
    if (label === "lifecycle.turn.terminal" && typeof event.meta?.problemCode === "string") {
      problemCode = event.meta.problemCode;
    }
    if (label === "provider.error" && typeof event.meta?.problemCode === "string") {
      problemCode = event.meta.problemCode;
    }
    if (label === "http.state.read" && terminalIndex >= 0 && index > terminalIndex) {
      stateReadAfterTerminal = true;
    }
  }

  const submittedAt = events[start].at;
  let maxFrameGapMs = null;
  for (let index = 1; index < frameTimes.length; index += 1) {
    const gap = frameTimes[index] - frameTimes[index - 1];
    if (maxFrameGapMs === null || gap > maxFrameGapMs) maxFrameGapMs = gap;
  }
  const terminal = terminalIndex >= 0 ? events[terminalIndex] : null;
  return {
    hasTerminal: terminalIndex >= 0,
    terminalState: terminal ? (terminal.meta?.state ?? null) : null,
    commitCount,
    providerSent: providerSentIndex >= 0,
    problemCode,
    stateReadAfterTerminal,
    wallTimeMs: terminal ? terminal.at - submittedAt : null,
    firstFrameLatencyMs: firstFrameIndex >= 0 ? events[firstFrameIndex].at - submittedAt : null,
    maxFrameGapMs,
    providerSettlementLatencyMs:
      providerSentIndex >= 0 && providerSettledIndex > providerSentIndex
        ? events[providerSettledIndex].at - events[providerSentIndex].at
        : null,
  };
}

function deriveFindings(turns) {
  const counts = Object.fromEntries(Object.keys(FINDINGS).map((id) => [id, 0]));
  for (const turn of turns) {
    if (turn.terminalState === "completed" && turn.commitCount === 0) counts.hollow_success += 1;
    if (turn.terminalState === "failed" && turn.problemCode === null) {
      counts.terminal_failed_without_problem_code += 1;
    }
    // Only a /state read inside this turn's own collection window, after its
    // terminal, proves the cancel was confirmed against durable state; a later
    // turn's polls are that turn's evidence, not this one's.
    if (turn.terminalState === "cancelled" && !turn.stateReadAfterTerminal) {
      counts.terminal_cancelled_without_readback += 1;
    }
    if (!turn.hasTerminal && turn.providerSent) counts.provider_boundary_unsettled += 1;
  }
  return counts;
}

function gradeDirection(direction, before, after) {
  if (direction !== "down" && direction !== "up") return "neutral";
  if (direction === "down") return after < before ? "improvement" : "regression";
  return after > before ? "improvement" : "regression";
}

const rows = [];

function addComparison({ kind, name, before, after, expectedDirection, detail }) {
  if (before === after) return;
  rows.push({
    kind,
    name,
    before,
    after,
    expectedDirection,
    verdict: gradeDirection(expectedDirection, before, after),
    detail,
  });
}

function addStage(name, before, after, verdict, detail) {
  if (before === after) return;
  rows.push({ kind: "stage", name, before, after, verdict, detail });
}

/**
 * Durations are measured facts, not correctness signals: reported, never ranked.
 * They are compared only where both traces carry the measurement, so a missing
 * duration never masquerades as a change in system health.
 */
function addDuration(name, before, after, detail) {
  if (before === null || after === null || before === after) return;
  rows.push({
    kind: "duration",
    name,
    before,
    after,
    verdict: "neutral",
    detail: `${detail}; reported, not ranked — a slower run is not by itself a system regression`,
  });
}

function gradeTerminalState(before, after) {
  if (before === "completed" && after !== "completed") return "regression";
  if (after === "completed" && before !== "completed") return "improvement";
  return "neutral";
}

function compareTraces(baseline, after) {
  const baselineEvents = baseline.trace.events;
  const afterEvents = after.trace.events;
  const baselineCounts = countByLabel(baseline.trace);
  const afterCounts = countByLabel(after.trace);
  const countOf = (counts, label) => counts[label] ?? 0;
  const baselineTurns = analyzeTurns(baseline.trace);
  const afterTurns = analyzeTurns(after.trace);
  const baselineFindings = deriveFindings(baselineTurns);
  const afterFindings = deriveFindings(afterTurns);

  addComparison({
    kind: "counter",
    name: "totalEventCount",
    before: baselineEvents.length,
    after: afterEvents.length,
    expectedDirection: "neutral",
    detail: "events recorded in the trace",
  });
  addComparison({
    kind: "counter",
    name: "turnCount",
    before: baselineTurns.length,
    after: afterTurns.length,
    expectedDirection: "neutral",
    detail: "turns the harness submitted; a different turn count moves every volume counter below",
  });
  addComparison({
    kind: "counter",
    name: "completedTurnCount",
    before: baselineTurns.filter((turn) => turn.terminalState === "completed").length,
    after: afterTurns.filter((turn) => turn.terminalState === "completed").length,
    expectedDirection: "up",
    detail: "turns that reached the durable terminal state completed",
  });
  addComparison({
    kind: "counter",
    name: "failedTurnCount",
    before: baselineTurns.filter((turn) => turn.terminalState === "failed").length,
    after: afterTurns.filter((turn) => turn.terminalState === "failed").length,
    expectedDirection: "down",
    detail: "turns that ended in a durable failure",
  });
  addComparison({
    kind: "counter",
    name: "cancelledTurnCount",
    before: baselineTurns.filter((turn) => turn.terminalState === "cancelled").length,
    after: afterTurns.filter((turn) => turn.terminalState === "cancelled").length,
    expectedDirection: "neutral",
    detail:
      "cancellations are a product action, not a failure; only a cancel with no durable read-back is an integrity finding",
  });
  addComparison({
    kind: "counter",
    name: "presentationCommitCount",
    before: countOf(baselineCounts, "presentation.committed"),
    after: countOf(afterCounts, "presentation.committed"),
    expectedDirection: "up",
    detail: "durable committed companion messages; more visible output is better",
  });
  addComparison({
    kind: "counter",
    name: "resyncCount",
    before: countOf(baselineCounts, "sse.stream.resync"),
    after: countOf(afterCounts, "sse.stream.resync"),
    expectedDirection: "down",
    detail: "stream resynchronizations the client had to request",
  });
  addComparison({
    kind: "counter",
    name: "stateReadCount",
    before: countOf(baselineCounts, "http.state.read"),
    after: countOf(afterCounts, "http.state.read"),
    expectedDirection: "down",
    detail: "/state reads, including polling",
  });

  const labels = [...new Set([...Object.keys(baselineCounts), ...Object.keys(afterCounts)])].sort();
  for (const label of labels) {
    const entry = EVENT_GRADING[label];
    addComparison({
      kind: "counter",
      name: `event.${label}`,
      before: countOf(baselineCounts, label),
      after: countOf(afterCounts, label),
      expectedDirection: entry.direction,
      detail: entry.integrity
        ? `${label} frequency; an integrity code must not appear in a healthy run`
        : `${label} frequency`,
    });
  }

  // Probe results per distance (probe design §6.1): the same probe code measured
  // at `turn`, `fold` and `session` distance answers different questions, so each
  // distance gets its own row — a fold-distance regression must not be able to
  // hide behind a turn-distance improvement in one aggregate count.
  const probeCountsByDistance = (trace) => {
    const counts = Object.create(null);
    for (const event of trace.events) {
      const label = eventLabel(event);
      // `label.startsWith("probe.")` already implies the probe kind. Keying on
      // the label rather than on `event.kind` is deliberate: Item 3 showed how a
      // kind-vs-code disagreement can make a row invisible, and validation now
      // enforces the pairing, so the label is the safe key.
      if (!label.startsWith(`${PROBE_KIND}.`)) continue;
      const distance = typeof event.meta?.distance === "string" ? event.meta.distance : "unspecified";
      const name = `${label}.distance.${distance}`;
      counts[name] = (counts[name] ?? 0) + 1;
    }
    return counts;
  };
  const baselineProbeCounts = probeCountsByDistance(baseline.trace);
  const afterProbeCounts = probeCountsByDistance(after.trace);
  const probeRowNames = [...new Set([...Object.keys(baselineProbeCounts), ...Object.keys(afterProbeCounts)])].sort();
  for (const name of probeRowNames) {
    const label = name.slice(0, name.indexOf(".distance."));
    const entry = EVENT_GRADING[label];
    addComparison({
      kind: "probe",
      name,
      before: countOf(baselineProbeCounts, name),
      after: countOf(afterProbeCounts, name),
      expectedDirection: entry.direction,
      detail: entry.integrity
        ? `${label} at one probe distance; an integrity code must not appear in a healthy run`
        : `${label} at one probe distance`,
    });
  }

  for (const id of Object.keys(FINDINGS)) {
    addComparison({
      kind: "finding",
      name: id,
      before: baselineFindings[id],
      after: afterFindings[id],
      expectedDirection: "down",
      detail: FINDINGS[id],
    });
  }

  const sharedTurns = Math.min(baselineTurns.length, afterTurns.length);
  for (let index = 0; index < sharedTurns; index += 1) {
    const before = baselineTurns[index];
    const afterTurn = afterTurns[index];
    addStage(
      `turn[${index}].terminalState`,
      before.terminalState,
      afterTurn.terminalState,
      gradeTerminalState(before.terminalState, afterTurn.terminalState),
      "terminal state the harness read from /state for this turn",
    );
    addDuration(`turn[${index}].wallTimeMs`, before.wallTimeMs, afterTurn.wallTimeMs, "submission to terminal");
    addDuration(
      `turn[${index}].firstFrameLatencyMs`,
      before.firstFrameLatencyMs,
      afterTurn.firstFrameLatencyMs,
      "submission to the first valid SSE frame",
    );
    addDuration(
      `turn[${index}].maxFrameGapMs`,
      before.maxFrameGapMs,
      afterTurn.maxFrameGapMs,
      "longest silence between SSE frames in the turn, the idle-stall signal free of any threshold",
    );
    addDuration(
      `turn[${index}].providerSettlementLatencyMs`,
      before.providerSettlementLatencyMs,
      afterTurn.providerSettlementLatencyMs,
      "provider pre-send marker to the durable terminal",
    );
  }

  const finishedEvents = (trace) => trace.events.filter((event) => eventLabel(event) === "lifecycle.run.finished");
  const baselineFinished = finishedEvents(baseline.trace);
  const afterFinished = finishedEvents(after.trace);
  addStage(
    "lifecycle.run.finished",
    baselineFinished.length > 0,
    afterFinished.length > 0,
    afterFinished.length > 0 ? "improvement" : "regression",
    "the harness recorded the end of collection; a trace without it is missing evidence",
  );
  addStage(
    "provider.observability",
    baselineFinished.at(-1)?.meta?.providerObservability ?? null,
    afterFinished.at(-1)?.meta?.providerObservability ?? null,
    "neutral",
    "the observer self-report; a change here is a change of observation capability, not of system health (design §3.2 rule 5)",
  );

  const regressions = rows.filter((row) => row.verdict === "regression");
  const improvements = rows.filter((row) => row.verdict === "improvement");
  return {
    schema: COMPARISON_SCHEMA,
    baseline: baseline.path,
    after: after.path,
    summary: {
      improvements: improvements.length,
      regressions: regressions.length,
      neutral: rows.length - improvements.length - regressions.length,
    },
    rows,
  };
}

function show(value) {
  return typeof value === "number" ? String(value) : JSON.stringify(value);
}

function printHumanSummary(comparison) {
  const lines = [`${COMPARISON_SCHEMA} — ${comparison.rows.length} changed row(s)`];
  lines.push(`  baseline: ${comparison.baseline}`);
  lines.push(`  after:    ${comparison.after}`);
  lines.push(
    `  improvements: ${comparison.summary.improvements}, regressions: ${comparison.summary.regressions}, neutral: ${comparison.summary.neutral}`,
  );
  for (const verdict of ["regression", "improvement", "neutral"]) {
    for (const row of comparison.rows.filter((entry) => entry.verdict === verdict)) {
      lines.push(`  [${verdict}] ${row.name}: ${show(row.before)} -> ${show(row.after)} (${row.detail})`);
    }
  }
  if (comparison.rows.length === 0) lines.push("  no differences");
  console.error(lines.join("\n"));
}

function main(argv) {
  if (argv.length !== 2) {
    console.error(USAGE);
    return 2;
  }
  const [baselinePath, afterPath] = argv;
  for (const path of argv) {
    if (!existsSync(path)) {
      console.error(`${USAGE}\nmissing input file: ${path}`);
      return 2;
    }
  }

  let baseline;
  let after;
  try {
    baseline = loadTrace(baselinePath);
    after = loadTrace(afterPath);
  } catch (error) {
    if (error instanceof InvalidTraceError) {
      console.error(`invalid ${TRACE_SCHEMA} trace: ${error.message}`);
      return 2;
    }
    throw error;
  }

  // `provider.embedded` is a property of the harness, not of system health. Two
  // runs that disagree on it measure different systems, so comparing them could
  // only produce a confident, meaningless verdict.
  if (baseline.trace.provider.embedded !== after.trace.provider.embedded) {
    console.error(
      `traces are not comparable: provider.embedded is ${baseline.trace.provider.embedded} in ${baselinePath} and ${after.trace.provider.embedded} in ${afterPath}`,
    );
    return 2;
  }
  // Probe results are only comparable against the SAME probe material (probe
  // design §6.3): a run measured against a different manifest answers a
  // different question, so comparing its counts would be a confident, wrong
  // verdict. A run with no probe event is comparable with anything.
  const probeDigests = (trace) =>
    [
      ...new Set(
        trace.events
          .filter((event) => eventLabel(event).startsWith(`${PROBE_KIND}.`))
          .map((event) => event.meta?.manifestDigest)
          .filter((value) => typeof value === "string"),
      ),
    ].sort();
  const baselineDigests = probeDigests(baseline.trace);
  const afterDigests = probeDigests(after.trace);
  if (baselineDigests.length > 0 && afterDigests.length > 0 && baselineDigests.join(",") !== afterDigests.join(",")) {
    console.error(
      `traces are not comparable: probe manifestDigest is ${baselineDigests.join(", ")} in ${baselinePath} and ${afterDigests.join(", ")} in ${afterPath} — probe results are only comparable against the same probe material`,
    );
    return 2;
  }

  const comparison = compareTraces(baseline, after);
  console.log(JSON.stringify(comparison, null, 2));
  printHumanSummary(comparison);

  if (comparison.summary.regressions > 0) {
    console.error(
      `REGRESSION: ${comparison.summary.regressions} chat signal(s) got worse: ${comparison.rows
        .filter((row) => row.verdict === "regression")
        .map((row) => row.name)
        .join(", ")}`,
    );
    return 1;
  }
  return 0;
}

process.exitCode = main(process.argv.slice(2));
