/**
 * Chat run audit kernel.
 *
 * Turns one Chat live-run trace (`chat_run_audit/v1`) into a system health
 * report: integrity verdict, waste envelope, smell attribution and the
 * `auditing-runs` Phase 7 synthesis report. The schema and the code vocabulary
 * are frozen by design/tasks/active/chat-run-audit-and-release-verdict.md §3 and
 * §3.1 — this module consumes them and never invents a kind or a code.
 *
 * The trace is content-free by construction: no prompt, M0/M1 text, message
 * body, credential, provider payload or SQLite content is expressible. Every
 * check below therefore asks "which system layer misbehaved", never "what did
 * the model say".
 *
 * There is no score here and none should be added: findings are facts to read
 * and act on. To judge whether a Chat change helped, compare two runs
 * (Task 3, tools/compare-chat-live-runs.mjs).
 *
 * Deliberate boundaries (validated against the frozen contract, not extended):
 * - `actor` is validated against the schema's closed set but not against the
 *   per-code actor column of §3.1: the column describes the intended emitter,
 *   not a wire invariant, and enforcing it would block a trace for a naming
 *   disagreement rather than a defect.
 * - kind/code pairing IS enforced (see `validateEvent`): §3.1 binds each code to
 *   its owning kind, and the integrity gate depends on that binding, so a
 *   mis-kinded `isolation.breach` must not be able to present itself as a
 *   harmless lifecycle row. Codes may repeat across kinds (`observability_gap`),
 *   but each kind accepts only its own set and each per-code obligation is keyed
 *   on the kind-qualified label.
 * - Prefer `eventLabel(event)` (the kind-qualified `<kind>.<code>` label) for any
 *   new analysis: a bare `code` lookup cannot tell `provider.observability_gap`
 *   from `probe.observability_gap`.
 * - there is no `context_materialization` component: the frozen vocabulary has
 *   no context-materialization event, so attributing a finding there would be
 *   speculation rather than attribution.
 *
 * Probe results (the `probe` kind of the owner-approved §3.1 extension) are
 * measurements against one `chat_memory_probe_manifest/v1` sidecar, which the
 * trace references only by `manifestDigest`; the trace never carries needle,
 * keyword, prompt or reply text. Exactly one of the nine probe codes fails
 * closed (`isolation.breach`, a cross-partition correctness failure); every
 * other outcome is reported through the summary and the run comparison, never
 * through the exit code.
 */
import { randomUUID } from "node:crypto";
export const CHAT_RUN_AUDIT_SCHEMA = "chat_run_audit/v1";
export const CHAT_RUN_AUDIT_REPORT_SCHEMA = "chat_run_audit_report/v1";

/** §3.1 frozen vocabulary. Exported so the live-run harness emits exactly these. */
export const CHAT_RUN_AUDIT_KINDS = Object.freeze([
  "lifecycle",
  "http",
  "sse",
  "provider",
  "presentation",
  "memory",
  "recovery",
  "probe",
]);

export const CHAT_RUN_AUDIT_ACTORS = Object.freeze(["harness", "host", "provider", "player"]);

export const CHAT_RUN_AUDIT_CODES_BY_KIND = Object.freeze({
  lifecycle: Object.freeze(["run.started", "run.finished", "turn.submitted", "turn.terminal"]),
  http: Object.freeze(["state.read", "state.conflict"]),
  sse: Object.freeze(["frame.received", "frame.invalid", "stream.resync"]),
  provider: Object.freeze(["request.sent", "settled", "error", "observability_gap", "boundary_unsettled"]),
  presentation: Object.freeze(["admitted", "committed", "rejected", "observability_gap"]),
  memory: Object.freeze(["read", "mutated", "conflict"]),
  recovery: Object.freeze(["reload.started", "reload.settled", "reload.mismatch"]),
  // Memory-probe results (owner-approved 2026-09 as proposal 1 of the probe
  // design). Only `isolation.breach` is an integrity code: a leak across a
  // continuity/surface boundary is a correctness failure, while a miss, a
  // confused distractor, a failed supersede and an observation gap are
  // measurements that must stay out of the exit code.
  probe: Object.freeze([
    "needle.hit",
    "needle.miss",
    "distractor.clean",
    "distractor.confused",
    "supersede.pass",
    "supersede.fail",
    "isolation.clean",
    "isolation.breach",
    "observability_gap",
  ]),
});

/**
 * §3.1 meta allow-list. `providerObservability` is part of it because §3.2 rule 5
 * requires `run.finished` to carry the observer's own limitation.
 */
export const CHAT_RUN_AUDIT_META_KEYS = Object.freeze([
  "state",
  "reason",
  "problemCode",
  "disposition",
  "status",
  "count",
  "cursor",
  "generation",
  "providerObservability",
  // The probe keys (owner-approved 2026-09 as proposal 2). `probeId` names the
  // opaque probe the result belongs to, `manifestDigest` pins the fixture
  // sidecar that holds the probe material, and `distance` / `dimension` place
  // the result in the probe design's distance x dimension grid. All four carry
  // bounded opaque values only: no needle, keyword or reply text is
  // expressible here by construction.
  "probeId",
  "distance",
  "dimension",
  "manifestDigest",
]);

/**
 * Thresholds. They only rank severity and name a measured quantity; a defect
 * that is observed at all is always reported (§3 discipline: a threshold must
 * never hide a signal).
 */

/** A turn running for longer than this with no SSE frame is an idle stall. */
export const IDLE_STALL_THRESHOLD_MS = 30_000;

/**
 * `/state` reads per turn. The frozen turn projection has 7 states and the
 * harness is expected to stream transitions; 12 reads leaves room for the
 * submit read, per-transition reads and a reload read, so anything above it is
 * polling instead of consuming the stream.
 */
export const MAX_STATE_READS_PER_TURN = 12;

/** "Repeated" Memory CAS conflicts. */
export const MEMORY_CONFLICT_STORM_MIN = 3;

/** Repeated `/state` conflicts carrying no new information. */
export const FEEDBACK_STARVATION_MIN_CONFLICTS = 3;

/** Conflict-shaped events inside an open turn before it counts as contention. */
export const SETTLEMENT_CONTENTION_MIN_CONFLICTS = 2;

/** Closed component set. Every finding is attributed to exactly one of these. */
export const FINDING_COMPONENTS = Object.freeze([
  "presentation_admission",
  "provider_boundary",
  "persistence_recovery",
  "cancellation",
  "memory_isolation",
  "observability_gap",
]);

const KNOWN_CODES = new Set(Object.values(CHAT_RUN_AUDIT_CODES_BY_KIND).flat());
const META_KEY_SET = new Set(CHAT_RUN_AUDIT_META_KEYS);

const CODE_PATTERN = /^[a-z0-9_.:-]{1,160}$/;
const OPAQUE_MAX_LENGTH = 160;
/** An opaque identifier with no whitespace: a `probeId` names a probe, never contents. */
const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_.:-]{1,160}$/;
const MAX_META_KEYS = 8;
const MAX_META_VALUE_LENGTH = 160;
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SURFACE_CHAT_ONLY = "chat-only";
const TERMINAL_STATES = Object.freeze(["completed", "cancelled", "failed"]);
const PROVIDER_OBSERVABILITY_VALUES = Object.freeze(["observed", "unobserved"]);
/** `probe.distance` domain (probe design §5.2): the memory distance a probe measures. */
export const CHAT_RUN_AUDIT_PROBE_DISTANCES = Object.freeze(["turn", "fold", "session"]);

/** `probe.dimension` domain (probe design §5.2): the judgement dimension. */
export const CHAT_RUN_AUDIT_PROBE_DIMENSIONS = Object.freeze([
  "retention",
  "discrimination",
  "supersession",
  "isolation",
]);
const PROBE_KIND = "probe";
const PROBE_ISOLATION_BREACH_CODE = "isolation.breach";
const PROBE_BREACH_DIMENSION = "isolation";
const ALLOWED_RUN_FIELDS = new Set([
  "schema",
  "runId",
  "startedAt",
  "completedAt",
  "surface",
  "artifact",
  "provider",
  "originMs",
  "events",
]);
const ALLOWED_EVENT_FIELDS = new Set(["at", "kind", "actor", "code", "meta"]);
const ALLOWED_ARTIFACT_FIELDS = new Set(["generation", "inventoryDigest"]);
const ALLOWED_PROVIDER_FIELDS = new Set(["embedded", "observed"]);

/** States that only exist because a cancellation was driven into the turn. */
const CANCELLING_STATES = Object.freeze(["stopping", "cancelling"]);

/**
 * `turn_busy`-shaped problem codes (host/src/tavern/browser-contract/index.ts
 * ProblemCode). A conflict that names one of these means a mutation raced an
 * un-settled transition.
 */
const CONTENTION_PROBLEM_CODES = Object.freeze([
  "turn_busy",
  "selection_busy",
  "idempotency_in_progress",
  "idempotency_conflict",
  "draft_conflict",
  "selection_conflict",
  "state_reconciliation_required",
]);

/**
 * Codes that signal friction. The histogram of these is the `reasons` map a
 * run-vs-run comparison diffs; a clean run yields `{}`. Keys are the
 * `kind.code` pair of the frozen table (a display composition of the two frozen
 * fields, not a new code): §3.1 code strings are unique, so each label names
 * exactly one row.
 *
 * Probe outcomes are deliberately absent: they are measurements against a
 * manifest (reported through `summary.probe` and the run comparison), not
 * friction in this run's own machinery. The one probe code that is not a
 * measurement joins `INTEGRITY_FINDING_IDS` instead.
 */
const FRICTION_CODES = Object.freeze([
  "http.state.conflict",
  "sse.frame.invalid",
  "sse.stream.resync",
  "provider.error",
  "provider.observability_gap",
  "presentation.rejected",
  "memory.conflict",
  "recovery.reload.mismatch",
]);

/** The `kind.code` label of an event, matching the §3.1 table rows. */
function eventLabel(event) {
  return `${event.kind}.${event.code}`;
}

/**
 * Integrity-class findings: correctness failures that set the CLI exit code.
 * §3.2 rule 4 is the line: `provider.observability_gap` is a stated limitation of
 * the observer, not a defect, so it is reported and never fails the run. A turn
 * that sent a request and never reached any terminal is the opposite case — the
 * run did not finish — and therefore is an integrity failure.
 */
const INTEGRITY_FINDING_IDS = Object.freeze([
  "hollow_success",
  "hollow_failure",
  "unobserved_cancellation",
  "recovery_mismatch",
  "provider_boundary_unsettled",
  "invalid_stream_frame",
  "state_conflict",
  // The only fail-closed probe outcome (probe design §4.3 / §7: isolation is
  // the one dimension where a breach is a correctness failure, not a rate).
  "isolation_breach",
  // Run-level evidence integrity: a trace that describes a run which never
  // actually collected anything must never read as a clean audit. These are the
  // consumer-side half of the producer's `run.finished.meta.status` contract.
  "run_boundary_failed",
  "run_without_turns",
]);

const SEVERITY_RANK = Object.freeze({ high: 0, medium: 1 });

// ============================================================================
// Validation
// ============================================================================

function isScalar(value) {
  return value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number";
}

function pushError(errors, path, reason, detail) {
  errors.push({ path, reason, detail });
}

/**
 * Fail-closed validation of a `chat_run_audit/v1` trace.
 *
 * Any over-limit value, unknown field or content-looking value is an error; the
 * caller must not drop the line and continue. Returns every offense found, each
 * naming the exact field, so a blocked run is diagnosable without guesswork.
 *
 * @param {unknown} value
 * @returns {Readonly<{valid: boolean, errors: Readonly<{path: string, reason: string, detail: string}[]>}>}
 */
/** Reject any field the frozen run shape does not declare. */
function validateRunFields(value, errors) {
  for (const key of Object.keys(value)) {
    if (!ALLOWED_RUN_FIELDS.has(key)) {
      pushError(errors, key, "unknown_field", "not part of the frozen chat_run_audit/v1 shape");
    }
  }
}

/** Validate the identity fields: schema, runId, timestamps, surface, originMs. */
function validateRunIdentity(value, errors) {
  if (value.schema !== CHAT_RUN_AUDIT_SCHEMA) {
    pushError(
      errors,
      "schema",
      "schema_id_invalid",
      `expected ${CHAT_RUN_AUDIT_SCHEMA}, got ${JSON.stringify(value.schema)}`,
    );
  }
  if (
    typeof value.runId !== "string" ||
    value.runId.length === 0 ||
    value.runId.length > OPAQUE_MAX_LENGTH ||
    /\s/.test(value.runId)
  ) {
    pushError(errors, "runId", "run_id_invalid", "runId must be an opaque 1..160 character token without whitespace");
  }
  for (const field of ["startedAt", "completedAt"]) {
    const timestamp = value[field];
    if (timestamp === undefined) continue;
    if (typeof timestamp !== "string" || !ISO_UTC_PATTERN.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) {
      pushError(
        errors,
        field,
        "timestamp_invalid",
        "expected an ISO-8601 UTC timestamp such as 2026-01-01T00:00:00.000Z",
      );
    }
  }
  if (value.surface !== undefined && value.surface !== SURFACE_CHAT_ONLY) {
    pushError(
      errors,
      "surface",
      "surface_invalid",
      `expected ${SURFACE_CHAT_ONLY}, got ${JSON.stringify(value.surface)}`,
    );
  }
  if (!Number.isSafeInteger(value.originMs) || value.originMs < 0) {
    pushError(errors, "originMs", "origin_ms_invalid", "originMs must be a non-negative integer");
  }
}

/**
 * Validate the `artifact` block. §3 declares both `generation` and
 * `inventoryDigest`, and the producer refuses to write a trace at all without
 * the immutable artifact identity. A partial artifact is therefore a schema
 * violation, not a tolerated variation: accepting one would let a trace carry a
 * generation with no integrity binding.
 */
function validateRunArtifact(value, errors) {
  const artifact = value.artifact;
  if (artifact === undefined) {
    pushError(errors, "artifact", "artifact_missing", "expected an object with generation and inventoryDigest");
    return;
  }
  if (artifact === null || typeof artifact !== "object" || Array.isArray(artifact)) {
    pushError(errors, "artifact", "artifact_invalid", "expected an object with generation and inventoryDigest");
    return;
  }
  for (const key of Object.keys(artifact)) {
    if (!ALLOWED_ARTIFACT_FIELDS.has(key))
      pushError(errors, `artifact.${key}`, "unknown_field", "not part of artifact");
  }
  if (typeof artifact.generation !== "string" || artifact.generation.length === 0 || artifact.generation.length > OPAQUE_MAX_LENGTH) {
    pushError(
      errors,
      "artifact.generation",
      "artifact_invalid",
      "generation must be a non-empty opaque string of at most 160 characters",
    );
  }
  if (typeof artifact.inventoryDigest !== "string" || !SHA256_PATTERN.test(artifact.inventoryDigest)) {
    pushError(
      errors,
      "artifact.inventoryDigest",
      "artifact_invalid",
      "inventoryDigest must be a lowercase sha256 hex digest",
    );
  }
}

/** Validate the optional `provider` block. */
function validateRunProvider(value, errors) {
  const provider = value.provider;
  if (provider === undefined) return;
  if (provider === null || typeof provider !== "object" || Array.isArray(provider)) {
    pushError(errors, "provider", "provider_invalid", "expected an object with embedded and observed booleans");
    return;
  }
  for (const key of Object.keys(provider)) {
    if (!ALLOWED_PROVIDER_FIELDS.has(key))
      pushError(errors, `provider.${key}`, "unknown_field", "not part of provider");
  }
  for (const field of ["embedded", "observed"]) {
    if (provider[field] !== undefined && typeof provider[field] !== "boolean") {
      pushError(errors, `provider.${field}`, "provider_invalid", `${field} must be a boolean`);
    }
  }
}

/**
 * Validate one event's `meta`: the frozen key allow-list, at most 8 keys, scalar
 * values of at most 160 characters and no line breaks. A bounded scalar must
 * never be able to carry content across the boundary.
 */
function validateEventMeta(meta, path, errors) {
  if (meta === undefined) return;
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
    pushError(errors, path, "meta_invalid", "meta must be an object of scalars");
    return;
  }
  const keys = Object.keys(meta);
  if (keys.length > MAX_META_KEYS) {
    pushError(errors, path, "meta_too_many_keys", `${keys.length} keys exceeds the bound of ${MAX_META_KEYS}`);
  }
  for (const key of keys) {
    if (!META_KEY_SET.has(key)) {
      pushError(errors, `${path}.${key}`, "meta_key_disallowed", "key is not in the frozen meta allow-list");
      continue;
    }
    const raw = meta[key];
    if (!isScalar(raw) || (typeof raw === "number" && !Number.isFinite(raw))) {
      pushError(
        errors,
        `${path}.${key}`,
        "meta_value_invalid",
        `meta values must be scalars, got ${Array.isArray(raw) ? "array" : typeof raw}`,
      );
      continue;
    }
    const text = String(raw);
    if (text.length > MAX_META_VALUE_LENGTH) {
      pushError(
        errors,
        `${path}.${key}`,
        "meta_value_too_long",
        `${text.length} characters exceeds the bound of ${MAX_META_VALUE_LENGTH}`,
      );
    }
    if (/[\r\n]/.test(text)) {
      pushError(
        errors,
        `${path}.${key}`,
        "meta_value_multiline",
        "a bounded metadata scalar must not carry line breaks",
      );
    }
  }
}

/** Validate one event against §3 and the §3.1 vocabulary. */
function validateEvent(event, index, errors) {
  const path = `events[${index}]`;
  if (event === null || typeof event !== "object" || Array.isArray(event)) {
    pushError(
      errors,
      path,
      "event_not_object",
      `expected an object, got ${Array.isArray(event) ? "array" : typeof event}`,
    );
    return;
  }
  for (const key of Object.keys(event)) {
    if (!ALLOWED_EVENT_FIELDS.has(key)) pushError(errors, `${path}.${key}`, "unknown_field", "not part of an event");
  }
  if (!Number.isSafeInteger(event.at) || event.at < 0) {
    pushError(errors, `${path}.at`, "at_invalid", "at must be a non-negative integer millisecond offset from originMs");
  }
  if (typeof event.kind !== "string" || !CHAT_RUN_AUDIT_KINDS.includes(event.kind)) {
    pushError(errors, `${path}.kind`, "kind_unknown", `expected one of ${CHAT_RUN_AUDIT_KINDS.join(", ")}`);
  }
  if (typeof event.actor !== "string" || !CHAT_RUN_AUDIT_ACTORS.includes(event.actor)) {
    pushError(errors, `${path}.actor`, "actor_invalid", `expected one of ${CHAT_RUN_AUDIT_ACTORS.join(", ")}`);
  }
  if (typeof event.code !== "string" || !CODE_PATTERN.test(event.code)) {
    pushError(errors, `${path}.code`, "code_format_invalid", "code must match ^[a-z0-9_.:-]{1,160}$");
  } else if (!KNOWN_CODES.has(event.code)) {
    pushError(errors, `${path}.code`, "code_unknown", `${event.code} is not in the frozen vocabulary of §3.1`);
  } else if (typeof event.kind === "string" && CHAT_RUN_AUDIT_KINDS.includes(event.kind)
    && !CHAT_RUN_AUDIT_CODES_BY_KIND[event.kind].includes(event.code)) {
    // kind/code pairing IS enforced. §3.1 binds each code to the kind that owns
    // it, and the integrity gate now depends on that binding: a bare `code`
    // lookup let a `kind:"lifecycle", code:"isolation.breach"` event validate
    // and pass integrity while the harness and compare both rejected it, so the
    // one fail-closed signal could be bypassed by mis-kinding it. Codes may
    // still repeat across kinds (observability_gap), but each kind accepts only
    // its own set.
    pushError(
      errors,
      `${path}.code`,
      "code_kind_mismatch",
      `${event.code} is not a ${event.kind} code in the frozen vocabulary of §3.1`,
    );
  }
  validateEventMeta(event.meta, `${path}.meta`, errors);

  // Per-code obligations the frozen table states as part of the row contract.
  // They are keyed on the kind-qualified label so a mis-kinded event cannot
  // borrow another kind's obligation.
  if (event.kind === "lifecycle" && event.code === "turn.terminal") {
    const state = event.meta?.state;
    if (typeof state !== "string" || !TERMINAL_STATES.includes(state)) {
      pushError(
        errors,
        `${path}.meta.state`,
        "turn_terminal_state_invalid",
        `turn.terminal must carry meta.state of ${TERMINAL_STATES.join(", ")}`,
      );
    }
  }
  if (event.kind === "lifecycle" && event.code === "run.finished" && !PROVIDER_OBSERVABILITY_VALUES.includes(event.meta?.providerObservability)) {
    pushError(
      errors,
      `${path}.meta.providerObservability`,
      "provider_observability_missing",
      "§3.2 rule 5: run.finished must report providerObservability as observed or unobserved",
    );
  }
  if (event.kind === PROBE_KIND) validateProbeEvent(event, path, errors);
}

/**
 * Per-row obligations for the `probe` kind (probe design §5.2).
 *
 * Every probe event is bound to the fixture manifest it measured by an opaque
 * `probeId` plus the sidecar's `manifestDigest`, so a result can never be read
 * without the material it came from and a digest mismatch is a schema failure
 * rather than a silently incomparable row (probe design §6.1). An
 * `isolation.breach` additionally has to say what distance it was measured at
 * and that the dimension is `isolation`, exactly as `turn.terminal` has to
 * carry `meta.state`.
 */
function validateProbeEvent(event, path, errors) {
  if (typeof event.meta?.probeId !== "string" || !OPAQUE_TOKEN_PATTERN.test(event.meta.probeId)) {
    pushError(
      errors,
      `${path}.meta.probeId`,
      "probe_id_missing",
      "a probe event must carry meta.probeId as an opaque bounded token",
    );
  }
  const digest = event.meta?.manifestDigest;
  if (typeof digest !== "string" || !SHA256_PATTERN.test(digest)) {
    pushError(
      errors,
      `${path}.meta.manifestDigest`,
      "probe_manifest_digest_invalid",
      "a probe event must carry meta.manifestDigest as a lowercase sha256 hex digest of the probe manifest",
    );
  }
  if (event.meta?.distance !== undefined && !CHAT_RUN_AUDIT_PROBE_DISTANCES.includes(event.meta.distance)) {
    pushError(
      errors,
      `${path}.meta.distance`,
      "probe_distance_invalid",
      `meta.distance must be one of ${CHAT_RUN_AUDIT_PROBE_DISTANCES.join(", ")}`,
    );
  }
  if (event.meta?.dimension !== undefined && !CHAT_RUN_AUDIT_PROBE_DIMENSIONS.includes(event.meta.dimension)) {
    pushError(
      errors,
      `${path}.meta.dimension`,
      "probe_dimension_invalid",
      `meta.dimension must be one of ${CHAT_RUN_AUDIT_PROBE_DIMENSIONS.join(", ")}`,
    );
  }
  if (event.code !== PROBE_ISOLATION_BREACH_CODE) return;
  if (!CHAT_RUN_AUDIT_PROBE_DISTANCES.includes(event.meta?.distance)) {
    pushError(
      errors,
      `${path}.meta.distance`,
      "probe_breach_distance_missing",
      `${PROBE_ISOLATION_BREACH_CODE} must carry meta.distance to place the breach on a distance`,
    );
  }
  if (event.meta?.dimension !== PROBE_BREACH_DIMENSION) {
    pushError(
      errors,
      `${path}.meta.dimension`,
      "probe_breach_dimension_invalid",
      `${PROBE_ISOLATION_BREACH_CODE} must carry meta.dimension=isolation`,
    );
  }
}

/**
 * Fail-closed validation of the event list: shape, monotonic `at`, vocabulary
 * and the run-level obligations (`run.finished` must exist and self-report).
 */
function validateEvents(events, errors) {
  if (!Array.isArray(events)) {
    pushError(errors, "events", "events_not_array", "expected an array of events");
    return;
  }
  if (events.length === 0) {
    // Auditing discipline Phase 1: empty data must fail immediately, never read
    // as a clean run.
    pushError(errors, "events", "events_empty", "a trace with no events carries no auditable fact");
  }
  let previousAt = null;
  let sawRunFinished = false;
  let sawRunStarted = false;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    validateEvent(event, index, errors);
    if (event !== null && typeof event === "object" && !Array.isArray(event)) {
      if (Number.isSafeInteger(event.at) && event.at >= 0) {
        if (previousAt !== null && event.at < previousAt) {
          pushError(
            errors,
            `events[${index}].at`,
            "at_not_monotonic",
            `at ${event.at} is below the previous event at ${previousAt}`,
          );
        }
        previousAt = event.at;
      }
      if (event.code === "run.finished") sawRunFinished = true;
      if (event.code === "run.started") sawRunStarted = true;
    }
  }
  if (events.length > 0 && !sawRunFinished) {
    pushError(errors, "events", "run_finished_missing", "the trace has no lifecycle.run.finished event");
  }
  // A trace whose run never started does not describe a run. Accepting it would
  // let "the harness never got past bootstrap" audit as a clean, passed run,
  // which is the exact false-clean this kernel exists to prevent.
  if (events.length > 0 && !sawRunStarted) {
    pushError(
      errors,
      "events",
      "run_started_missing",
      "the trace has no lifecycle.run.started event, so it describes no run",
    );
  }
}

/**
 * @param {unknown} value
 * @returns {Readonly<{valid: boolean, errors: Readonly<{path: string, reason: string, detail: string}[]>}>}
 */
export function validateChatRunAudit(value) {
  const errors = [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    pushError(
      errors,
      "$",
      "audit_not_object",
      `expected an object, got ${Array.isArray(value) ? "array" : typeof value}`,
    );
    return Object.freeze({ valid: false, errors: Object.freeze(errors) });
  }
  validateRunFields(value, errors);
  validateRunIdentity(value, errors);
  validateRunArtifact(value, errors);
  validateRunProvider(value, errors);
  validateEvents(value.events, errors);
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

// ============================================================================
// Summary
// ============================================================================

function metaOf(event) {
  const meta = event?.meta;
  return meta !== null && typeof meta === "object" && !Array.isArray(meta) ? meta : {};
}

/**
 * Slice the event stream into turn windows.
 *
 * The frozen meta allow-list has no turn identifier, so a turn is positional: it
 * opens at `lifecycle.turn.submitted` and closes at the first
 * `lifecycle.turn.terminal` after it. Events after a close (a confirming
 * `/state` read, run-level recovery) belong to the run, not to the next turn,
 * so a turn is only ever opened by an explicit submission.
 */
function createTurnWindow(index, submittedAtMs) {
  return {
    index,
    submittedAtMs,
    windowEndMs: submittedAtMs,
    terminalAtMs: null,
    terminalState: null,
    lastState: null,
    cancellingStates: [],
    problemCodes: [],
    admitted: 0,
    committed: 0,
    rejected: 0,
    frames: 0,
    frameTimes: [],
    stateReads: 0,
    stateConflicts: 0,
    contentionCodes: [],
    resyncs: 0,
    resyncReasons: [],
    memoryConflicts: 0,
    providerRequested: false,
    providerSettled: false,
    providerErrored: false,
    cancelRequested: false,
    closed: false,
  };
}

/**
 * What each in-turn event contributes to its turn window. Codes absent from the
 * table still update `lastState`/`problemCodes` but add no counter, which is the
 * case for lifecycle events other than the terminal.
 */
const TURN_EVENT_FOLDERS = Object.freeze({
  "frame.received": (turn, event) => {
    turn.frames += 1;
    turn.frameTimes.push(event.at);
  },
  "state.read": (turn) => {
    turn.stateReads += 1;
  },
  "state.conflict": (turn, _event, meta) => {
    turn.stateConflicts += 1;
    turn.contentionCodes.push(meta.reason ?? meta.problemCode);
  },
  "stream.resync": (turn, _event, meta) => {
    turn.resyncs += 1;
    turn.resyncReasons.push(meta.reason ?? "unspecified");
  },
  "request.sent": (turn) => {
    turn.providerRequested = true;
  },
  settled: (turn) => {
    turn.providerSettled = true;
  },
  error: (turn) => {
    turn.providerErrored = true;
  },
  admitted: (turn) => {
    turn.admitted += 1;
  },
  committed: (turn) => {
    turn.committed += 1;
  },
  rejected: (turn) => {
    turn.rejected += 1;
  },
  conflict: (turn) => {
    turn.memoryConflicts += 1;
  },
});

/**
 * Facts the producer derives from the same authoritative `/state` read that
 * produced `turn.terminal`, emitted immediately afterwards. They describe the
 * turn that just closed, so they are folded into it rather than dropped.
 * Bare codes: §3.1 spells a wire code as `<kind>.<code>` and this set matches
 * the `code` field alone.
 */
const POST_TERMINAL_TURN_CODES = new Set([
  "settled",
  "error",
  "committed",
  "admitted",
  "rejected",
  "observability_gap",
]);

function foldEventIntoWindow(turn, event, meta) {
  turn.windowEndMs = event.at;
  if (event.code === "turn.terminal") {
    // The terminal event's own state is the durable outcome, not an observed
    // in-flight state; folding it into `lastState` would make the last state
    // before a cancellation read as the terminal it became. Its problemCode is
    // still part of the turn's evidence and must not be dropped.
    if (typeof meta.problemCode === "string") turn.problemCodes.push(meta.problemCode);
    turn.terminalAtMs = event.at;
    turn.terminalState = typeof meta.state === "string" ? meta.state : null;
    turn.closed = true;
    return;
  }
  if (typeof meta.state === "string") turn.lastState = meta.state;
  if (CANCELLING_STATES.includes(meta.state)) {
    turn.cancelRequested = true;
    if (!turn.cancellingStates.includes(meta.state)) turn.cancellingStates.push(meta.state);
  }
  if (typeof meta.problemCode === "string") turn.problemCodes.push(meta.problemCode);
  TURN_EVENT_FOLDERS[event.code]?.(turn, event, meta);
}

function buildTurnWindows(events) {
  const windows = [];
  let current = null;
  for (const event of events) {
    if (event.code === "turn.submitted") {
      if (current !== null) windows.push(current);
      current = createTurnWindow(windows.length + 1, event.at);
      continue;
    }
    if (current === null) continue;
    // A turn closes at its durable terminal, but the producer derives the
    // provider and presentation facts from that SAME authoritative `/state`
    // read and emits them immediately after `turn.terminal` so a reader can
    // attribute them positionally. Those trailing facts belong to the turn
    // that just closed: dropping them would report `hollow_success` on every
    // clean run. Only the derived post-terminal facts are folded; a later
    // out-of-band observed event still needs its own turn window.
    if (current.closed && !POST_TERMINAL_TURN_CODES.has(event.code)) continue;
    foldEventIntoWindow(current, event, metaOf(event));
  }
  if (current !== null) windows.push(current);
  for (const window of windows) {
    const end = window.terminalAtMs ?? window.windowEndMs;
    window.endMs = end;
    window.durationMs = end - window.submittedAtMs;
    window.maxFrameGapMs = maxFrameGap(window.submittedAtMs, end, window.frameTimes);
  }
  return windows;
}

/**
 * Longest span inside [startMs, endMs] with no SSE frame. A turn that received
 * no frame at all has one gap spanning the whole window.
 */
function maxFrameGap(startMs, endMs, frameTimes) {
  let previous = startMs;
  let max = 0;
  for (const at of frameTimes) {
    if (at > previous) max = Math.max(max, at - previous);
    previous = Math.max(previous, at);
  }
  return Math.max(max, endMs - previous);
}

function countBy(events, selector) {
  const counts = {};
  for (const event of events) {
    const key = selector(event);
    if (key === null || key === undefined) continue;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function countCode(events, code, kind = undefined) {
  return events.filter((event) => event.code === code && (kind === undefined || event.kind === kind)).length;
}

function countProbeCode(events, code) {
  return countCode(events, code, PROBE_KIND);
}

/**
 * Counts of `probe` events per key, restricted to a closed domain and emitted in
 * the domain's own order so a report reads the same way every run.
 */
function countProbeByDomain(probeEvents, domain, selector) {
  const counts = {};
  for (const name of domain) {
    const count = probeEvents.filter((event) => selector(metaOf(event)) === name).length;
    if (count > 0) counts[name] = count;
  }
  return counts;
}

/**
 * Probe results for one run. Nothing here is a score: the design forbids a
 * synthesized memory number (probe design §6.2), so each frozen `probe` code is
 * reported as its own count plus the manifest digests and the distance /
 * dimension grouping the caller needs to read a rate per probe.
 */
function buildProbeSummary(events) {
  const probeEvents = events.filter((event) => event.kind === PROBE_KIND);
  const digests = probeEvents
    .map((event) => metaOf(event).manifestDigest)
    .filter((value) => typeof value === "string");
  return {
    total: probeEvents.length,
    manifestDigests: Object.freeze([...new Set(digests)].sort()),
    codeCounts: Object.freeze(countBy(probeEvents, (event) => event.code)),
    countsByDistance: Object.freeze(
      countProbeByDomain(probeEvents, CHAT_RUN_AUDIT_PROBE_DISTANCES, (meta) => meta.distance),
    ),
    countsByDimension: Object.freeze(
      countProbeByDomain(probeEvents, CHAT_RUN_AUDIT_PROBE_DIMENSIONS, (meta) => meta.dimension),
    ),
    needleHits: countProbeCode(events, "needle.hit"),
    needleMisses: countProbeCode(events, "needle.miss"),
    distractorClean: countProbeCode(events, "distractor.clean"),
    distractorConfused: countProbeCode(events, "distractor.confused"),
    supersedePass: countProbeCode(events, "supersede.pass"),
    supersedeFail: countProbeCode(events, "supersede.fail"),
    isolationClean: countProbeCode(events, "isolation.clean"),
    isolationBreach: countProbeCode(events, "isolation.breach"),
    observabilityGap: countProbeCode(events, "observability_gap"),
  };
}

/**
 * Bounded structured summary of one audit: counts, turn windows, terminal state
 * and the provider/presentation/cancellation/recovery facts a report shows.
 * Content-free by construction — every field is a count, a state name or a
 * bounded identifier from the trace.
 *
 * @param {any} audit a value that passed validateChatRunAudit
 */
export function summarizeChatRunAudit(audit) {
  const events = Array.isArray(audit?.events) ? audit.events : [];
  const turns = buildTurnWindows(events);
  const runFinished = [...events].reverse().find((event) => event.code === "run.finished");
  const providerObservability = runFinished?.meta?.providerObservability ?? "unobserved";
  const terminalStates = turns.map((turn) => turn.terminalState).filter((state) => state !== null);
  const firstAt = events.length > 0 ? events[0].at : null;
  const lastAt = events.length > 0 ? events[events.length - 1].at : null;

  return Object.freeze({
    schema: audit?.schema ?? CHAT_RUN_AUDIT_SCHEMA,
    runId: audit?.runId ?? null,
    surface: audit?.surface ?? null,
    originMs: typeof audit?.originMs === "number" ? audit.originMs : null,
    startedAt: audit?.startedAt ?? null,
    completedAt: audit?.completedAt ?? null,
    totalEvents: events.length,
    firstEventAtMs: firstAt,
    lastEventAtMs: lastAt,
    observedSpanMs: firstAt === null || lastAt === null ? 0 : lastAt - firstAt,
    countsByKind: countBy(events, (event) => event.kind),
    countsByCode: countBy(events, (event) => event.code),
    turnCount: turns.length,
    turns: Object.freeze(turns.map((turn) => Object.freeze(turn))),
    terminalState: terminalStates.length > 0 ? terminalStates[terminalStates.length - 1] : null,
    terminalObservedTurns: terminalStates.length,
    provider: Object.freeze({
      embedded: audit?.provider?.embedded ?? null,
      declared: audit?.provider?.observed ?? null,
      observability: providerObservability,
      requestSent: countCode(events, "request.sent"),
      settled: countCode(events, "settled"),
      errored: countCode(events, "error"),
      observabilityGap: countCode(events, "observability_gap", "provider"),
    }),
    presentation: Object.freeze({
      admitted: countCode(events, "admitted"),
      committed: countCode(events, "committed"),
      rejected: countCode(events, "rejected"),
      committedTurns: turns.filter((turn) => turn.committed > 0).length,
    }),
    cancellation: Object.freeze({
      requestedTurns: turns.filter((turn) => turn.cancelRequested).length,
      durableCancelledTurns: turns.filter((turn) => turn.terminalState === "cancelled").length,
      reloadSettledCancelled: events.filter(
        (event) => event.code === "reload.settled" && metaOf(event).state === "cancelled",
      ).length,
    }),
    recovery: Object.freeze({
      reloadStarted: countCode(events, "reload.started"),
      reloadSettled: countCode(events, "reload.settled"),
      reloadMismatch: countCode(events, "reload.mismatch"),
    }),
    memory: Object.freeze({
      read: countCode(events, "read"),
      mutated: countCode(events, "mutated"),
      conflict: countCode(events, "conflict"),
    }),
    probe: Object.freeze(buildProbeSummary(events)),
  });
}

// ============================================================================
// Analysis
// ============================================================================

function formatTurnIndexes(turns, limit = 6) {
  const indexes = turns.map((turn) => turn.index);
  const shown = indexes.slice(0, limit);
  return indexes.length > limit ? `${shown.join(", ")} (+${indexes.length - limit} more)` : shown.join(", ");
}

function finding(id, component, severity, count, fields) {
  if (!FINDING_COMPONENTS.includes(component)) {
    throw new Error(`chat_run_audit_finding_component_unknown:${id}:${component}`);
  }
  return Object.freeze({ id, component, severity, count, ...fields });
}

function sortFindings(findings) {
  return [...findings].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    return bySeverity !== 0 ? bySeverity : b.count - a.count;
  });
}

/**
 * Shared state every detector reads: the trace, its turn windows and the
 * run-level facts a detector may need without recomputing them.
 */
function createAnalysisContext(audit) {
  const events = Array.isArray(audit?.events) ? audit.events : [];
  const summary = summarizeChatRunAudit(audit);
  return { events, summary, turns: summary.turns };
}

/** A turn claims `completed` while nothing was durably presented. */
function detectHollowSuccess(context) {
  const turns = context.turns.filter((turn) => turn.terminalState === "completed" && turn.committed === 0);
  if (turns.length === 0) return null;
  return finding("hollow_success", "presentation_admission", "high", turns.length, {
    detail: `${turns.length} turn(s) reached terminal \`completed\` with zero presentation.committed events (turn ${formatTurnIndexes(turns)}) — the run claims success while presenting nothing`,
    mechanism:
      "a durable terminal `completed` was minted without a durable presentation commit: success flowed from the provider-settlement path instead of the presentation path",
    recommendation:
      "audit the runtime-owned presentation admission/commit seam before the terminal projection: a completed turn must own a committed companion message",
    seam: "host/src/tavern/chat-pipeline-service.ts (presentation admission -> durable commit) + host/src/tavern/reference-pipeline-state.ts:projectTurn",
    blindSpot:
      "admission and commit are unit-tested in isolation; no test asserts the join `terminal completed => committed >= 1` over a real trace",
    gate: "deterministic gate: refuse to project terminal `completed` unless that turn's durable presentation commit exists; assert committed >= 1 per completed turn in the audit",
    metricTarget: `completed-without-commit turns: baseline ${turns.length} -> 0`,
    turnIndexes: turns.map((turn) => turn.index),
  });
}

/**
 * A turn reached terminal `failed` with no problemCode recoverable from its own
 * window, so its cause is unactionable downstream. The check is per turn, not
 * per run: in a multi-turn run an unrelated turn's problemCode must never
 * excuse a hollow failure, which is exactly the false-clean this must prevent.
 */
function detectHollowFailure(context) {
  const turns = context.turns.filter((turn) => turn.terminalState === "failed" && turn.problemCodes.length === 0);
  if (turns.length === 0) return null;
  return finding("hollow_failure", "persistence_recovery", "high", turns.length, {
    detail: `${turns.length} turn(s) reached terminal \`failed\` (turn ${formatTurnIndexes(turns)}) with no problemCode recoverable from that turn`,
    mechanism:
      "the durable terminal classification published `failed` without the reason code that explains it, so the failure is unactionable downstream",
    recommendation:
      "audit the terminal classification projection that emits problemCode for a durable `failed` classification (reference-pipeline-state.ts:projectTurn)",
    seam: "host/src/tavern/reference-pipeline-state.ts:projectTurn",
    blindSpot:
      "tests assert the failed state and the problemCode prop separately; none asserts that a failed terminal always carries a recoverable cause",
    gate: "causal failure envelope: a durable `failed` terminal must serialize its problemCode; the audit fails closed on failed-without-cause",
    metricTarget: `failed turns without a recoverable problemCode: baseline ${turns.length} -> 0`,
    turnIndexes: turns.map((turn) => turn.index),
  });
}

/** A cancel was driven into a turn but no durable `cancelled` was read back. */
function detectUnobservedCancellation(context) {
  const cancelling = context.turns.filter((turn) => turn.cancelRequested);
  if (cancelling.length === 0) return null;
  const durableCancelled =
    context.turns.some((turn) => turn.terminalState === "cancelled") ||
    context.summary.cancellation.reloadSettledCancelled > 0;
  if (durableCancelled) return null;
  const unresolved = cancelling.filter((turn) => turn.terminalState !== "cancelled");
  const cancelledStates = [...new Set(cancelling.flatMap((turn) => turn.cancellingStates))];
  const lastStates = [...new Set(cancelling.map((turn) => turn.lastState))].filter(Boolean);
  return finding("unobserved_cancellation", "cancellation", "high", unresolved.length, {
    detail: `${cancelling.length} turn(s) observed a cancellation state (${cancelledStates.join(", ")}) and no durable \`cancelled\` terminal was read back (turn ${formatTurnIndexes(resolveIndexes(unresolved, cancelling))}; last observed state ${lastStates.join(", ")})`,
    mechanism:
      "the cancel request was accepted at the boundary but the turn never reached, or never published, a durable cancelled terminal — the player cannot distinguish stopped from still-running",
    recommendation:
      "audit the Stop/cancel lifecycle seam through its one mounted authority: cancel must settle the turn to a durable terminal observable from /state",
    seam: "host/src/tavern/chat-thread-store.ts (cancel authority) + host/src/tavern/chat-pipeline-service.ts",
    blindSpot:
      "cancel tests assert the store transition in isolation; none asserts that a cancel observed at the boundary is followed by a durable cancelled read-back in the same run",
    gate: "deterministic gate: a cancellation observation must be followed by a durable cancelled terminal (or a reload read-back of one) within the same run, otherwise the audit fails closed",
    metricTarget: `cancel-requested turns without a durable cancelled read-back: baseline ${unresolved.length} -> 0`,
    turnIndexes: cancelling.map((turn) => turn.index),
  });
}

/** A turn ran past the stall threshold with no SSE frame at all. */
function detectIdleStall(context) {
  const turns = context.turns.filter((turn) => turn.maxFrameGapMs > IDLE_STALL_THRESHOLD_MS);
  if (turns.length === 0) return null;
  const measuredMs = Math.max(...turns.map((turn) => turn.maxFrameGapMs));
  return finding("idle_stall", "observability_gap", "medium", turns.length, {
    detail: `${turns.length} turn(s) ran longer than ${IDLE_STALL_THRESHOLD_MS} ms without a single sse.frame.received event (turn ${formatTurnIndexes(turns)}); longest frame-free span ${measuredMs} ms`,
    measuredMs,
    thresholdMs: IDLE_STALL_THRESHOLD_MS,
    mechanism:
      "nothing was published to the event stream while the turn was active: the gap is either a real stall in the turn pipeline or a missing publish of progress the turn did make",
    recommendation:
      "audit the turn's SSE publish path and the pre-provider context-materialization phase to separate missing frames from a real stall; the frozen trace cannot distinguish them",
    seam: "host/src/tavern/chat-event-stream.ts:publish + the context-materialization phase before a provider request",
    blindSpot:
      "stream tests drive frames that are already published, so a phase that publishes nothing is invisible to them",
    gate: "publish a monotonic progress frame (or an explicit phase marker) per turn phase; the audit fails closed on a frame-free span above the threshold",
    metricTarget: `longest frame-free span per turn: baseline ${measuredMs} ms -> <= ${IDLE_STALL_THRESHOLD_MS} ms`,
    turnIndexes: turns.map((turn) => turn.index),
  });
}

/** Turn transitions are discovered by polling instead of consumed from the stream. */
function detectMicroStepping(context) {
  const turns = context.turns.filter((turn) => turn.stateReads > MAX_STATE_READS_PER_TURN);
  if (turns.length === 0) return null;
  const maxStateReads = Math.max(...turns.map((turn) => turn.stateReads));
  return finding("micro_stepping", "observability_gap", "medium", turns.length, {
    detail: `${turns.length} turn(s) exceeded the ${MAX_STATE_READS_PER_TURN} /state reads per turn bound (turn ${formatTurnIndexes(turns)}); worst turn made ${maxStateReads} reads`,
    bound: MAX_STATE_READS_PER_TURN,
    maxStateReads,
    mechanism:
      "turn transitions are being discovered by polling instead of consumed from the event stream, so every poll is a serialized roundtrip the stream already had the facts for",
    recommendation:
      "audit the live-run harness /state polling loop against its SSE consumption: an excess read means the stream is not carrying the transition",
    seam: "tools/run-chat-live-audit.mjs (harness polling loop) + host/src/tavern/chat-event-stream.ts",
    blindSpot:
      "the stream is tested with subscribers that always receive events, so a polling fallback in the harness is never measured",
    gate: "hard bound of one /state read per observed transition plus the terminal read; the audit reports any turn above the bound with its count",
    metricTarget: `/state reads on the worst turn: baseline ${maxStateReads} -> <= ${MAX_STATE_READS_PER_TURN}`,
    turnIndexes: turns.map((turn) => turn.index),
  });
}

/** The client had to resynchronize its event stream. */
function detectStreamGapChurn(context) {
  const reasons = context.events
    .filter((event) => event.code === "stream.resync")
    .map((event) => metaOf(event).reason ?? "unspecified");
  if (reasons.length === 0) return null;
  const distinct = [...new Set(reasons)];
  return finding("stream_gap_churn", "observability_gap", reasons.length >= 3 ? "high" : "medium", reasons.length, {
    detail: `the client was told to resynchronize ${reasons.length}x (reasons: ${distinct.join(", ")}) — events were lost or the stream epoch changed under the reader`,
    sampleReasons: distinct,
    mechanism:
      "the event stream could not serve the requested cursor: a gap in the retained window, an epoch change or an ambiguous cursor forced a full re-read",
    recommendation:
      "audit the stream subscription/cursor seam (chat-event-stream.ts:subscribe) and the retention window against the reader's reconnect pattern",
    seam: "host/src/tavern/chat-event-stream.ts:subscribe",
    blindSpot:
      "stream tests subscribe before publishing, so a resync caused by a slow or reconnecting reader never occurs",
    gate: "deterministic gate: a subscription must either resume from a retained cursor or report the gap once; assert stream.resync count per run instead of tolerating churn",
    metricTarget: `stream.resync events per run: baseline ${reasons.length} -> 0`,
  });
}

/**
 * A malformed SSE frame was observed. §3.1 classifies `sse.frame.invalid` as an
 * integrity code: the stream is the only live channel carrying turn state, so a
 * frame the reader could not parse means state delivery was demonstrably broken
 * — not merely friction. Reporting it anywhere below the exit code would let a
 * corrupt stream read as a clean run.
 */
function detectInvalidStreamFrame(context) {
  const events = context.events.filter((event) => event.code === "frame.invalid");
  if (events.length === 0) return null;
  const reasons = [...new Set(events.map((event) => metaOf(event).reason ?? "unspecified"))];
  return finding("invalid_stream_frame", "observability_gap", "high", events.length, {
    detail: `${events.length} sse.frame.invalid event(s) (reasons: ${reasons.join(", ")}) — the event stream delivered frames the reader could not parse`,
    mechanism:
      "the SSE frame the server wrote and the frame the reader expected disagreed, so at least one state transition was not delivered as state",
    recommendation:
      "audit the SSE frame writer and the reader's strict parser together; a frame the reader rejects must never be written",
    seam: "host/src/tavern/chat-event-stream.ts (frame write) + dialogue-web/src/reference-pipeline-session.ts (frame parse)",
    blindSpot:
      "stream tests write and parse through the same helper, so a writer/reader schema disagreement cannot occur in-test",
    gate: "deterministic gate: every written frame must satisfy the reader's strict schema; assert zero parse rejections per run rather than tolerating and skipping",
    metricTarget: `sse.frame.invalid events per run: baseline ${events.length} -> 0`,
    sampleReasons: reasons,
  });
}

/**
 * An authenticated `/state` read failed. §3.1 classifies `http.state.conflict` as
 * an integrity code because `/state` is the recovery authority: if a read can
 * fail, the reader cannot re-establish authoritative truth, and any later
 * "recovery" would be a guess.
 */
function detectStateConflict(context) {
  const events = context.events.filter((event) => event.code === "state.conflict");
  if (events.length === 0) return null;
  const statuses = [...new Set(events.map((event) => metaOf(event).status ?? "unspecified"))];
  return finding("state_conflict", "persistence_recovery", "high", events.length, {
    detail: `${events.length} http.state.conflict event(s) (statuses: ${statuses.join(", ")}) — the authoritative snapshot could not be read`,
    mechanism:
      "the /state recovery authority refused or failed a read, so the reader had no authoritative truth to reconcile against",
    recommendation:
      "audit the /state handler and the reconciliation/storage path it depends on; a failed snapshot read must be a distinct, recoverable outcome rather than a silent gap",
    seam: "host/src/tavern/reference-pipeline-state.ts:read",
    blindSpot:
      "/state tests seed a healthy store, so a failing reconciliation or storage read is never surfaced through the route",
    gate: "deterministic gate: /state must either return the durable snapshot or a typed problem the reader can act on; assert the read outcome per turn instead of ignoring failed reads",
    metricTarget: `http.state.conflict events per run: baseline ${events.length} -> 0`,
    sampleStatuses: statuses,
  });
}

/** A reload read back a terminal that contradicts the durable one. */
function detectRecoveryMismatch(context) {
  const count = countCode(context.events, "reload.mismatch");
  if (count === 0) return null;
  return finding("recovery_mismatch", "persistence_recovery", "high", count, {
    detail: `${count} recovery.reload.mismatch event(s): the terminal state read back after reload disagreed with the previously durable terminal`,
    mechanism:
      "the durable turn terminal and the /state projection disagreed across a reload, so one of them is not derived from the durable authority",
    recommendation:
      "audit /state projection against the durable turn ledger across a reload (reference-pipeline-state.ts:read vs chat-thread-store.ts)",
    seam: "host/src/tavern/reference-pipeline-state.ts:read + host/src/tavern/chat-thread-store.ts (turn ledger)",
    blindSpot:
      "reload tests assert the projection of a fresh process; no test compares it with the terminal the previous read already observed",
    gate: "deterministic gate: after reload, /state must equal the durable terminal or the run fails closed; assert equality, never a best-effort merge",
    metricTarget: `recovery mismatches per run: baseline ${count} -> 0`,
  });
}

/** Repeated Memory CAS conflicts. */
function detectMemoryConflictStorm(context) {
  const count = countCode(context.events, "conflict");
  if (count < MEMORY_CONFLICT_STORM_MIN) return null;
  return finding("memory_conflict_storm", "memory_isolation", count >= 5 ? "high" : "medium", count, {
    detail: `memory.conflict fired ${count}x (>= ${MEMORY_CONFLICT_STORM_MIN}) — Memory CAS writes kept losing to a competing revision`,
    mechanism:
      "the Memory mutation path retried against an un-settled or concurrently advanced revision instead of serializing on a monotonic state token",
    recommendation:
      "audit the Memory projection-resolution + vendor state-token CAS seam so a mutation resolves the current revision once and commits or reports conflict once",
    seam: "host/src/tavern/memory-management.ts (projection resolve -> vendor CAS)",
    blindSpot: "Memory tests are single-writer, so a real concurrent revision race is never exercised",
    gate: "deterministic gate: resolve the current projection revision once and commit against that exact token; report conflict once with the violated constraint instead of retrying blind",
    metricTarget: `memory.conflict events per run: baseline ${count} -> <= 1`,
  });
}

/**
 * A provider request was observed and the turn never reached any terminal.
 * §3.2 rule 3: both conditions are required, so a stream-only turn without
 * provider evidence is never reported here.
 */
function detectProviderBoundaryUnsettled(context) {
  const turns = context.turns.filter((turn) => turn.providerRequested && turn.terminalAtMs === null);
  if (turns.length === 0) return null;
  return finding("provider_boundary_unsettled", "provider_boundary", "high", turns.length, {
    detail: `${turns.length} turn(s) observed provider.request.sent and never reached any terminal state (turn ${formatTurnIndexes(turns)}) — the provider round trip never settled`,
    mechanism:
      "the provider request was serialized and the attempt then never settled into a durable terminal, so no layer owns the outcome",
    recommendation:
      "audit the provider invocation settlement path and its deadline/cancellation handling: every sent request must reach a durable terminal",
    seam: "host/src/tavern/provider-invocation.ts (provider round trip -> durable terminal)",
    blindSpot:
      "provider tests resolve the attempt explicitly; none asserts the trace-level invariant `request.sent => terminal eventually observed`",
    gate: "deterministic gate: a sent provider request must settle into a durable terminal within the attempt deadline; the audit reports any sent-but-unsettled attempt",
    metricTarget: `sent-but-unsettled turns: baseline ${turns.length} -> 0`,
    turnIndexes: turns.map((turn) => turn.index),
  });
}

/** Repeated opaque /state failure with no new information between attempts. */
function detectFeedbackStarvation(context) {
  const conflicts = context.events.filter((event) => event.code === "state.conflict");
  if (conflicts.length < FEEDBACK_STARVATION_MIN_CONFLICTS) return null;
  const reasons = [...new Set(conflicts.map((event) => metaOf(event).reason ?? "unspecified"))];
  if (reasons.length > 1) return null;
  return finding("feedback_starvation", "observability_gap", "medium", conflicts.length, {
    detail: `${conflicts.length} /state requests failed with the same reason (${reasons.join(", ")}) — the caller retried against an opaque failure with no informational gradient`,
    sampleReasons: reasons,
    mechanism:
      "the conflict response withheld causal state facts (violated constraint, current revision/state), so each retry was information-free",
    recommendation:
      "audit the /state problem envelope so a conflict carries a machine-readable problemCode plus the current state instead of a bare status",
    seam: "host/src/tavern/browser-contract/index.ts (problem envelope) + host/src/tavern/reference-pipeline-state.ts",
    blindSpot:
      "route tests assert the status code and code string; none asserts that a repeated conflict carries new state facts",
    gate: "causal failure envelope: every non-2xx /state must serialize problemCode and the current projection revision; the audit counts repeated source-identical conflicts",
    metricTarget: `/state conflicts per run: baseline ${conflicts.length} -> <= 1`,
  });
}

/** Conflicts landed during a routine transition while a turn was open. */
function detectSettlementContention(context) {
  const memoryConflictsInTurn = context.turns.reduce((total, turn) => total + turn.memoryConflicts, 0);
  const busyConflictsInTurn = context.turns.reduce(
    (total, turn) => total + turn.contentionCodes.filter((code) => CONTENTION_PROBLEM_CODES.includes(code)).length,
    0,
  );
  const count = memoryConflictsInTurn + busyConflictsInTurn;
  if (memoryConflictsInTurn < SETTLEMENT_CONTENTION_MIN_CONFLICTS && busyConflictsInTurn < 1) return null;
  return finding("settlement_contention", "persistence_recovery", "medium", count, {
    detail: `${count} conflict event(s) landed while a turn was open (memory CAS ${memoryConflictsInTurn}, busy/conflict problem codes ${busyConflictsInTurn}) — a mutation raced an un-settled transition`,
    mechanism:
      "execution attempted a mutation before the prior turn transition settled, so the mutator had to retry or report conflict on a routine transition",
    recommendation:
      "audit the turn-settlement boundary so a mutation is admitted only against a settled transition (monotonic revision/state gate), not on a timer",
    seam: "host/src/tavern/chat-thread-store.ts (turn settlement) + host/src/tavern/chat-pipeline-service.ts",
    blindSpot: "tests drive one operation at a time, so a mutation issued during a transition is never exercised",
    gate: "deterministic gate: admit mutations only against a settled, monotonic transition; the audit reports conflicts that landed inside an open turn",
    metricTarget: `conflicts inside an open turn: baseline ${count} -> 0`,
  });
}

/**
 * The producer reported that the run never reached a collected state (its
 * boundary failed before or during collection). The trace exists only so the
 * failure is legible; it describes no successful run. Without this consumer the
 * honest `run.finished.meta.status="boundary_failed"` field would be written and
 * never read, so a harness that never reached a provider turn would audit as
 * `passed` with exit code 0.
 */
function detectRunBoundaryFailed(context) {
  const finished = [...context.events].reverse().find((event) => event.code === "run.finished");
  const status = metaOf(finished ?? {}).status;
  if (status === undefined || status === "collected") return null;
  const reason = metaOf(finished ?? {}).reason ?? "unspecified";
  return finding("run_boundary_failed", "observability_gap", "high", 1, {
    detail: `the run never collected: run.finished reported status \`${status}\` (reason ${reason}) — the trace records a harness boundary failure, not an observed run`,
    mechanism:
      "the harness could not reach the point where it observes a real turn (bootstrap, artifact resolution or stream setup failed), so no product behaviour was exercised at all",
    recommendation:
      "fix the harness boundary that failed (the reason names it) and re-run; do not read this trace as evidence about the Chat pipeline",
    seam: "tools/run-chat-live-audit.mjs:main (boundary collection) + tools/desktop-composition-launch.mjs (launch seam)",
    blindSpot:
      "the producer wrote an honest status field and no consumer read it, so an unstarted run and a clean run were indistinguishable to the audit",
    gate: "deterministic gate: run.finished.meta.status must be `collected` for a trace to be auditable; any other value is an integrity failure",
    metricTarget: "boundary-failed traces read as passed: baseline 1 -> 0",
  });
}

/**
 * The trace carries no turn at all. A run that observed no turn cannot support
 * any claim about turn behaviour, and every turn-level detector is vacuously
 * silent on it — which is precisely why it must be reported rather than passing
 * as "no findings".
 */
function detectRunWithoutTurns(context) {
  if (context.turns.length > 0) return null;
  return finding("run_without_turns", "observability_gap", "high", 1, {
    detail:
      "the trace contains no turn window, so no turn-level evidence exists and every turn detector was vacuously silent",
    mechanism:
      "a run with no submitted turn exercised no Chat turn behaviour; silence from the turn detectors is absence of evidence, not evidence of health",
    recommendation:
      "require at least one submitted turn in an auditable run and treat a turn-less trace as incomplete evidence",
    seam: "tools/run-chat-live-audit.mjs (turn drive sequence)",
    blindSpot:
      "detectors report findings, so a trace with nothing to examine produces an empty finding list that reads identical to a clean run",
    gate: "deterministic gate: an auditable trace must contain at least one lifecycle.turn.submitted; the audit fails closed otherwise",
    metricTarget: "audited traces with zero turns: baseline 1 -> 0",
  });
}

/**
 * A memory probe recorded an isolation breach. This is the one probe outcome
 * that fails closed (probe design §4.3, §7): retention, discrimination and
 * supersession are measured rates, but a cross-continuity/cross-surface leak is
 * a correctness failure and is treated exactly like `recovery.reload.mismatch`.
 *
 * Only the orchestrator that holds both sides of the evidence may emit this
 * code (probe design §4.1); the kernel does not re-derive the verdict, it only
 * refuses to let a published breach audit as a clean run.
 */
function detectIsolationBreach(context) {
  const events = context.events.filter((event) => event.kind === PROBE_KIND && event.code === "isolation.breach");
  if (events.length === 0) return null;
  const probeIds = [...new Set(events.map((event) => metaOf(event).probeId ?? "unspecified"))];
  const distances = [...new Set(events.map((event) => metaOf(event).distance ?? "unspecified"))];
  return finding("isolation_breach", "memory_isolation", "high", events.length, {
    detail: `${events.length} probe.isolation.breach event(s) (probes: ${probeIds.join(", ")}; distances: ${distances.join(", ")}) — a probed fact from one partition was observable in another that does not share it`,
    sampleProbeIds: probeIds,
    sampleDistances: distances,
    mechanism:
      "a memory read crossed a continuity or surface boundary the manifest declares as non-shared, so a companion surfaced a fact its own partition never held",
    recommendation:
      "audit the memory partition/scope key resolved at read time against the manifest's declared sharing, before treating the probe family as healthy",
    seam:
      "host/src/tavern/memory-management/memory-management.ts (partition-scoped read/projection) + the probe manifest sidecar the harness measured against",
    blindSpot:
      "memory tests seed a single continuity, so a read that resolves the wrong partition key cannot occur in-test",
    gate: "deterministic gate: a probe fact declared non-shared must never be retrievable from the foreign partition; the audit fails closed on isolation.breach",
    metricTarget: `probe.isolation.breach events per run: baseline ${events.length} -> 0`,
  });
}

/** Every Chat-side detector, in report order. A detector returns null when silent. */
const DETECTORS = Object.freeze([
  detectRunBoundaryFailed,
  detectRunWithoutTurns,
  detectHollowSuccess,
  detectHollowFailure,
  detectUnobservedCancellation,
  detectIdleStall,
  detectMicroStepping,
  detectStreamGapChurn,
  detectRecoveryMismatch,
  detectInvalidStreamFrame,
  detectStateConflict,
  detectMemoryConflictStorm,
  detectProviderBoundaryUnsettled,
  detectFeedbackStarvation,
  detectSettlementContention,
  detectIsolationBreach,
]);

function buildIntegrity(summary, findings) {
  const failures = findings.filter((entry) => INTEGRITY_FINDING_IDS.includes(entry.id));
  return {
    passed: failures.length === 0,
    failures: failures.map((entry) => ({
      id: entry.id,
      component: entry.component,
      severity: entry.severity,
      count: entry.count,
      detail: entry.detail,
    })),
    providerObservability: summary.provider.observability,
    terminalObserved: summary.terminalState !== null,
  };
}

function buildWasteEnvelope(context) {
  const { events, summary, turns } = context;
  return {
    totalEvents: summary.totalEvents,
    observedSpanMs: summary.observedSpanMs,
    turnCount: summary.turnCount,
    stateReads: countCode(events, "state.read"),
    maxStateReadsPerTurn: turns.reduce((max, turn) => Math.max(max, turn.stateReads), 0),
    stateReadsBoundPerTurn: MAX_STATE_READS_PER_TURN,
    sseFrames: countCode(events, "frame.received"),
    maxFrameGapMs: turns.reduce((max, turn) => Math.max(max, turn.maxFrameGapMs), 0),
    idleStallThresholdMs: IDLE_STALL_THRESHOLD_MS,
    streamResyncs: countCode(events, "stream.resync"),
    stateConflicts: countCode(events, "state.conflict"),
    memoryConflicts: countCode(events, "conflict"),
    presentationAdmitted: countCode(events, "admitted"),
    presentationCommitted: countCode(events, "committed"),
    presentationRejected: countCode(events, "rejected"),
    providerRequestsSent: summary.provider.requestSent,
    providerSettled: summary.provider.settled,
    providerErrored: summary.provider.errored,
    providerObservabilityGap: summary.provider.observabilityGap,
    reloads: summary.recovery.reloadStarted,
    reloadMismatches: summary.recovery.reloadMismatch,
    probeEvents: summary.probe.total,
    probeIsolationBreaches: summary.probe.isolationBreach,
  };
}

/**
 * Run every Chat-side detector over one audit and return system findings, the
 * friction histogram, the integrity verdict and the waste envelope.
 *
 * Precondition: validateChatRunAudit(audit).valid. An invalid trace must be
 * blocked by the caller, never analysed.
 *
 * @param {any} audit
 * @returns {{findings: readonly any[], reasons: Record<string, number>, integrity: any, waste: any}}
 */
export function analyzeChatRunAudit(audit) {
  const context = createAnalysisContext(audit);
  const findings = DETECTORS.map((detector) => detector(context)).filter((entry) => entry !== null);
  const reasons = countBy(
    context.events.filter((event) => FRICTION_CODES.includes(eventLabel(event))),
    eventLabel,
  );
  return {
    findings: Object.freeze(sortFindings(findings)),
    reasons: Object.freeze(reasons),
    integrity: Object.freeze(buildIntegrity(context.summary, findings)),
    waste: Object.freeze(buildWasteEnvelope(context)),
  };
}

function resolveIndexes(primary, fallback) {
  return primary.length > 0 ? primary : fallback;
}

// ============================================================================
// Report (auditing-runs Phase 7 synthesis)
// ============================================================================

function formatMs(value) {
  return `${value} ms`;
}

/**
 * Probe results as one bounded line. Rates are per dimension and per distance,
 * and no combined memory score is produced (probe design §6.2). A run with no
 * probe events says so rather than reporting zeroes that would read as a
 * measured result of nothing.
 */
function formatProbeLine(probe) {
  if (probe.total === 0) return "no probe event in this run (no memory-probe manifest was driven)";
  const distances = Object.entries(probe.countsByDistance).map(([name, count]) => `${name}=${count}`);
  return [
    `${probe.total} event(s) against manifest ${probe.manifestDigests.join(", ") || "<none>"}`,
    `retention hit/miss ${probe.needleHits}/${probe.needleMisses}`,
    `distractor clean/confused ${probe.distractorClean}/${probe.distractorConfused}`,
    `supersede pass/fail ${probe.supersedePass}/${probe.supersedeFail}`,
    `isolation clean/breach ${probe.isolationClean}/${probe.isolationBreach}`,
    `observability gaps ${probe.observabilityGap}`,
    distances.length > 0 ? `distances ${distances.join(", ")}` : null,
  ]
    .filter((part) => part !== null)
    .join("; ");
}

/**
 * The Memory evidence line.
 *
 * A bare `0 read(s), 0 mutation(s), 0 CAS conflict(s)` reads as three measured
 * zeros, but the schema has no `memory.observability_gap` row, so an absent
 * Memory projection is NOT distinguishable from an idle one. Say that plainly
 * instead of letting the zeros imply the Memory path was exercised and found
 * quiet.
 */
function formatMemoryEvidenceLine(memory, conflicts) {
  const counts = `${memory.read} read(s), ${memory.mutated} mutation(s), ${conflicts} CAS conflict(s)`;
  if (memory.read > 0 || memory.mutated > 0 || conflicts > 0) return counts;
  return `${counts} — no Memory evidence in this trace; the frozen vocabulary has no \`memory.observability_gap\` row, so an unavailable projection is not distinguishable from an idle one (a Memory claim must not rest on this run)`;
}

/**
 * Build the bounded JSON report for one audit.
 *
 * @param {{audit: any, artifact?: string|null}} input
 */
export function buildChatRunAuditReport({ audit, artifact = null } = {}) {
  const summary = summarizeChatRunAudit(audit);
  const analysis = analyzeChatRunAudit(audit);
  const anomaly =
    analysis.findings.length > 0 ? analysis.findings[0].detail : "no integrity failure and no smell detected";
  return {
    schema: CHAT_RUN_AUDIT_REPORT_SCHEMA,
    reportId: randomUUID(),
    auditSchema: summary.schema,
    runId: summary.runId,
    artifact: {
      label: artifact,
      generation: audit?.artifact?.generation ?? null,
      inventoryDigest: audit?.artifact?.inventoryDigest ?? null,
    },
    surface: summary.surface,
    startedAt: summary.startedAt,
    completedAt: summary.completedAt,
    originMs: summary.originMs,
    topology: { kind: "single_run", turns: summary.turnCount },
    verdict: analysis.integrity.passed ? "passed" : "integrity_failed",
    observedAnomaly: anomaly,
    summary,
    waste: analysis.waste,
    integrity: analysis.integrity,
    reasons: analysis.reasons,
    findings: analysis.findings,
  };
}

/** Render the report in the `auditing-runs` Phase 7 synthesis format. */
export function formatChatRunAuditReportText(report) {
  const lines = [];
  const summary = report.summary;
  lines.push("## Execution Audit Summary");
  lines.push(`- **Artifact**: ${report.artifact?.label ?? "<inline audit>"} (runId ${report.runId ?? "<none>"})`);
  lines.push(
    `- **Topology**: Single Run — ${summary.turnCount} turn(s), surface ${summary.surface ?? "<unset>"}, observed span ${formatMs(summary.observedSpanMs)}`,
  );
  lines.push(
    `- **Primary Metrics**: events=${summary.totalEvents}, sse frames=${report.waste.sseFrames}, /state reads=${report.waste.stateReads} (max ${report.waste.maxStateReadsPerTurn}/turn, bound ${report.waste.stateReadsBoundPerTurn}), provider requests=${report.waste.providerRequestsSent} (settled ${report.waste.providerSettled}, errored ${report.waste.providerErrored}), presentation commits=${report.waste.presentationCommitted}, terminal state=${summary.terminalState ?? "none observed"}, provider observability=${report.integrity.providerObservability}`,
  );
  lines.push(`- **Observed Anomaly**: ${report.observedAnomaly}`);
  lines.push("");
  lines.push("## Resource & Waste Profile");
  lines.push(
    `- /state polling: ${report.waste.stateReads} read(s), worst turn ${report.waste.maxStateReadsPerTurn} (bound ${report.waste.stateReadsBoundPerTurn}); ${report.waste.stateConflicts} conflict(s)`,
  );
  lines.push(
    `- Event stream: ${report.waste.sseFrames} frame(s), ${report.waste.streamResyncs} forced resynchronization(s)`,
  );
  lines.push(
    `- Idle: longest frame-free span ${formatMs(report.waste.maxFrameGapMs)} (stall threshold ${formatMs(report.waste.idleStallThresholdMs)})`,
  );
  lines.push(
    `- Memory: ${formatMemoryEvidenceLine(summary.memory, report.waste.memoryConflicts)}`,
  );
  lines.push(
    `- Recovery: ${report.waste.reloads} reload(s), ${report.waste.reloadMismatches} mismatch(es) against the durable terminal`,
  );
  lines.push(`- Memory probe: ${formatProbeLine(report.summary.probe)}`);
  lines.push("");
  lines.push("## Integrity & Boundary Assessment");
  lines.push(`- Verdict: ${report.verdict === "passed" ? "passed (no integrity failure)" : "INTEGRITY FAILED"}`);
  if (report.integrity.failures.length === 0) {
    lines.push("- Hollow Success / Failure: no turn claimed a terminal its evidence contradicts");
    lines.push("- Cancellation: no unobserved cancellation in this run");
  } else {
    for (const failure of report.integrity.failures) {
      lines.push(`- ${failure.id} [${failure.component}, ${failure.severity}] x${failure.count}: ${failure.detail}`);
    }
  }
  lines.push(
    `- Provider boundary: observability=${report.integrity.providerObservability} (request.sent=${report.waste.providerRequestsSent}, settled=${report.waste.providerSettled}, error=${report.waste.providerErrored}, observability_gap=${report.waste.providerObservabilityGap}) — unobserved provider state is reported as a limitation, never as a failure`,
  );
  lines.push(
    `- Containment: the audit consumed a content-free trace (counts, states and opaque identifiers only); no prompt, message body or credential is expressible in this schema, so containment is asserted by construction rather than by inspection`,
  );
  lines.push("");
  lines.push("## Runtime Smells & Mechanism Analysis");
  if (report.findings.length === 0) {
    lines.push("- none: every detector stayed silent on this trace");
  } else {
    for (const entry of report.findings) {
      lines.push(
        `- **${entry.id}** (${entry.component}, ${entry.severity}, x${entry.count}): ${entry.detail} -> ${entry.mechanism}`,
      );
    }
  }
  lines.push("");
  lines.push("## Seam Attribution & Deterministic Gates");
  if (report.findings.length === 0) {
    lines.push("- no finding: nothing to attribute; keep this run as the baseline for run-vs-run comparison");
  } else {
    lines.push(
      "| Seam (File & Symbol) | Mechanism Flaw | Test Blind Spot | Prescribed Fix & Gate | Metric Target (Baseline -> Target) |",
    );
    lines.push("| :--- | :--- | :--- | :--- | :--- |");
    for (const entry of report.findings) {
      lines.push(
        `| \`${entry.seam}\` | ${entry.mechanism} | ${entry.blindSpot} | ${entry.gate} | ${entry.metricTarget} |`,
      );
    }
  }
  return lines.join("\n");
}
