/**
 * The frozen `chat_run_audit/v1` contract: the schema names, the vocabulary every event is keyed by, the key sets a
 * trace is validated against, the code patterns they are matched with, the fixed identity an audit runs as, and the
 * probe vocabulary a memory-probe manifest speaks.
 *
 * Split out of `run-chat-live-audit.mjs`: the harness drives a run, this file is what a trace may SAY. A reader
 * asking "is this finding allowed to exist" reads here, not in the runner.
 */
export const AUDIT_SCHEMA = "chat_run_audit/v1";
export const HARNESS_OUTCOME_SCHEMA = "chat_run_audit/harness-outcome/v1";
export const AUDIT_SURFACE = "chat-only";

/**
 * Frozen audit vocabulary (task doc §3.1). Keyed by `<kind>.<code>`; the actor
 * is the frozen producer of the fact, and the pair may not be extended here.
 *
 * This table is a second copy of the kernel's `CHAT_RUN_AUDIT_CODES_BY_KIND`, so
 * the two are pinned equal in both directions by the producer/consumer parity
 * test (`tools/live-run/chat/run-chat-live-audit.test.mjs`). The load-time drift check inside
 * `tools/compare-chat-live-runs.mjs` only covers kernel<->compare, so without
 * that test a change to either table alone would go unnoticed.
 */
export const AUDIT_VOCABULARY = Object.freeze({
  "lifecycle.run.started": "harness",
  "lifecycle.run.finished": "harness",
  "lifecycle.turn.submitted": "harness",
  "lifecycle.turn.terminal": "harness",
  "http.state.read": "harness",
  "http.state.conflict": "harness",
  "sse.frame.received": "host",
  "sse.frame.invalid": "harness",
  "sse.stream.resync": "host",
  "provider.request.sent": "host",
  "provider.settled": "host",
  "provider.error": "host",
  "provider.observability_gap": "harness",
  "provider.boundary_unsettled": "harness",
  "presentation.admitted": "harness",
  "presentation.piece": "host",
  "presentation.committed": "host",
  "presentation.rejected": "harness",
  "presentation.observability_gap": "harness",
  "memory.read": "host",
  "memory.mutated": "host",
  "memory.conflict": "host",
  "recovery.reload.started": "harness",
  "recovery.reload.settled": "harness",
  "recovery.reload.mismatch": "harness",
  // Probe results are emitted by the orchestrator that holds the probe evidence,
  // never by the run's own harness; the harness accepts them so a produced trace
  // validates, and validates their per-code obligations below.
  "probe.needle.hit": "harness",
  "probe.needle.miss": "harness",
  "probe.distractor.clean": "harness",
  "probe.distractor.confused": "harness",
  "probe.supersede.pass": "harness",
  "probe.supersede.fail": "harness",
  "probe.isolation.clean": "harness",
  "probe.isolation.breach": "harness",
  "probe.observability_gap": "harness",
});
export const AUDIT_KINDS = Object.freeze([
  "lifecycle",
  "sse",
  "http",
  "provider",
  "presentation",
  "memory",
  "recovery",
  "probe",
]);
export const AUDIT_EVENT_KEYS = Object.freeze(["at", "kind", "actor", "code", "meta"]);
export const AUDIT_CATEGORY_KEYS = Object.freeze([
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
export const AUDIT_ARTIFACT_KEYS = Object.freeze(["generation", "inventoryDigest"]);
export const AUDIT_PROVIDER_KEYS = Object.freeze(["embedded", "observed"]);
/** The only `meta` keys the frozen interface permits. */
export const AUDIT_META_KEYS = Object.freeze([
  "state",
  "reason",
  "problemCode",
  "disposition",
  "status",
  "count",
  "cursor",
  "generation",
  "providerObservability",
  "gateMarker",
  "firstResponseMs",
  "probeId",
  "distance",
  "dimension",
  "manifestDigest",
]);
export const CODE_PATTERN = /^[a-z0-9_.:-]{1,160}$/;
export const OPAQUE_RUN_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const GENERATION = /^[a-z0-9-]{1,160}$/i;
export const OPERATION_HANDLE = /^[A-Za-z0-9_-]{1,160}$/;
export const SHA256_HEX = /^[a-f0-9]{64}$/;
export const PI_SESSION_ID = /^[A-Za-z0-9_-]{1,256}$/;
export const STARTUP_STDERR_CODE = /^[a-z][a-z0-9_.:-]{2,159}$/i;
export const STARTUP_STDERR_REASON_PREFIX = "dialogue_start_stderr:";
/** Terminal states a `turn.terminal` may carry; mirrors the audit kernel. */
export const AUDIT_TERMINAL_STATES = Object.freeze(["completed", "cancelled", "failed"]);
/** Observer self-report values a `run.finished` may carry; mirrors the kernel. */
export const AUDIT_PROVIDER_OBSERVABILITY = Object.freeze(["observed", "unobserved"]);
/** `probe.distance` domain; mirrors the audit kernel. */
export const AUDIT_PROBE_DISTANCES = Object.freeze(["turn", "fold", "session"]);

/** `probe.dimension` domain; mirrors the audit kernel. */
export const AUDIT_PROBE_DIMENSIONS = Object.freeze(["retention", "discrimination", "supersession", "isolation"]);
export const PROBE_KIND = "probe";
export const PROBE_ISOLATION_BREACH_CODE = "isolation.breach";
export const PROBE_BREACH_DIMENSION = "isolation";
/** An opaque probe identifier: bounded, no whitespace, never contents. */
export const PROBE_ID = /^[A-Za-z0-9_.:-]{1,160}$/;

/**
 * Content guard for the persisted trace. It targets the exact leak classes the
 * frozen interface forbids (prompt material, message bodies, credentials, raw
 * provider payloads) rather than incidental system words, so a truthful
 * diagnostic code can still be reported without the guard rejecting it.
 */
export const CONTENT_GUARD =
  /(?:private prompt|prompt text|player prefers|private dialogue|raw provider|authorization|bearer\s|api[_-]?key|set-cookie|statetoken|sk-[A-Za-z0-9_-]{16,})/i;

export const AUDIT_IDENTITY = Object.freeze({
  playerId: "chat_audit_player",
  companionId: "chat_audit_companion",
  continuityId: "chat_audit_continuity",
});
