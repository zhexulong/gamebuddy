#!/usr/bin/env node
/**
 * Chat live audit run harness (design/tasks/active/chat-run-audit-and-release-verdict.md Task 2).
 *
 * It drives the Desktop composition bootstrap itself against a fresh
 * gate-owned root, talks to the composed chat-only surface over its
 * authenticated Reference Chat HTTP API, submits real turns, stops one through
 * the authenticated cancel route, reloads the client surface from the
 * authenticated durable `/state`, and writes a `chat_run_audit/v1` trace.
 *
 * The trace is the product: it carries only sanitized metadata, bounded codes
 * and aggregate counts. It never carries prompt text, M0/M1 text, message
 * bodies, credentials, raw provider payloads, Pi JSONL, or SQLite content, and
 * the harness validates its own output against the frozen schema before it
 * writes anything.
 *
 * Evidence classes are frozen and must not be mixed (task doc §3.3):
 *
 * - Class A (authoritative product facts): authenticated `/state`, HTTP
 *   responses, the SSE stream, child IPC. Turn submit/terminal state, state
 *   reads, SSE frames and resync, provider pre-send, `presentation.committed`,
 *   `memory.*`, `recovery.reload.*`.
 * - Class B (diagnostic markers only): fixed production stderr markers
 *   (`[DEBUG-chat-live-p4c] ...`). These cover `presentation.admitted` /
 *   `presentation.rejected` only.
 *
 * Therefore `presentation.committed` is derived exclusively from the
 * authoritative `/state` transcript projection, and the stderr marker
 * `commit_done` is deliberately never mapped to it: a Class B marker must never
 * assert an authoritative presentation fact. A missing Class B marker produces
 * `presentation.observability_gap` and is never a failure.
 *
 * Provider facts are equally constrained. `provider.request.sent` is the only
 * pre-send evidence and comes from the one-shot child IPC marker
 * (`gamebuddy-tavern-narrative-gate-marker/v1`); `provider.settled` /
 * `provider.error` are derived from the durable terminal state and never assert
 * a provider-internal result. The marker binding is one-shot per Pi session, so
 * a turn after the first has no pre-send evidence of its own; the harness
 * reports that run-level observability honestly through
 * `run.finished`'s `meta.providerObservability` instead of guessing.
 */
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { launchDesktopCompositionGateChild } from "./desktop-composition-launch.mjs";

const HOST_ROOT = resolve(fileURLToPath(new URL("../host/", import.meta.url)));
const AUDIT_SCHEMA = "chat_run_audit/v1";
const HARNESS_OUTCOME_SCHEMA = "chat_run_audit/harness-outcome/v1";
const AUDIT_SURFACE = "chat-only";
const START_TIMEOUT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 12_000;
const TURN_TIMEOUT_MS = 180_000;
const POST_SUBMIT_STATE_POLLS = 6;
const POST_SUBMIT_STATE_POLL_MS = 400;
const CANCEL_ARM_POLLS = 40;
const CANCEL_ARM_POLL_MS = 250;
const STOP_TIMEOUT_MS = 5_000;
const MARKER_DRAIN_MS = 50;
/** Fixed non-content submit text; it never enters the trace. */
const SUBMIT_PROMPT_TEXT = "Please respond naturally.";

const TERMINAL_TURN_STATES = Object.freeze(new Set(["completed", "cancelled", "failed"]));

/**
 * Frozen audit vocabulary (task doc §3.1). Keyed by `<kind>.<code>`; the actor
 * is the frozen producer of the fact, and the pair may not be extended here.
 *
 * This table is a second copy of the kernel's `CHAT_RUN_AUDIT_CODES_BY_KIND`, so
 * the two are pinned equal in both directions by the producer/consumer parity
 * test (`tools/run-chat-live-audit.test.mjs`). The load-time drift check inside
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
export const AUDIT_KINDS = Object.freeze(["lifecycle", "sse", "http", "provider", "presentation", "memory", "recovery", "probe"]);
const AUDIT_EVENT_KEYS = Object.freeze(["at", "kind", "actor", "code", "meta"]);
const AUDIT_CATEGORY_KEYS = Object.freeze(["schema", "runId", "startedAt", "completedAt", "surface", "artifact", "provider", "originMs", "events"]);
const AUDIT_ARTIFACT_KEYS = Object.freeze(["generation", "inventoryDigest"]);
const AUDIT_PROVIDER_KEYS = Object.freeze(["embedded", "observed"]);
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
  "probeId",
  "distance",
  "dimension",
  "manifestDigest",
]);
const CODE_PATTERN = /^[a-z0-9_.:-]{1,160}$/;
const OPAQUE_RUN_ID = /^[A-Za-z0-9_-]{1,128}$/;
const GENERATION = /^[a-z0-9-]{1,160}$/i;
const OPERATION_HANDLE = /^[A-Za-z0-9_-]{1,160}$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const PI_SESSION_ID = /^[A-Za-z0-9_-]{1,256}$/;
const STARTUP_STDERR_CODE = /^[a-z][a-z0-9_.:-]{2,159}$/i;
const STARTUP_STDERR_REASON_PREFIX = "dialogue_start_stderr:";
/** Terminal states a `turn.terminal` may carry; mirrors the audit kernel. */
const AUDIT_TERMINAL_STATES = Object.freeze(["completed", "cancelled", "failed"]);
/** Observer self-report values a `run.finished` may carry; mirrors the kernel. */
const AUDIT_PROVIDER_OBSERVABILITY = Object.freeze(["observed", "unobserved"]);
/** `probe.distance` domain; mirrors the audit kernel. */
export const AUDIT_PROBE_DISTANCES = Object.freeze(["turn", "fold", "session"]);

/** `probe.dimension` domain; mirrors the audit kernel. */
export const AUDIT_PROBE_DIMENSIONS = Object.freeze(["retention", "discrimination", "supersession", "isolation"]);
const PROBE_KIND = "probe";
const PROBE_ISOLATION_BREACH_CODE = "isolation.breach";
const PROBE_BREACH_DIMENSION = "isolation";
/** An opaque probe identifier: bounded, no whitespace, never contents. */
const PROBE_ID = /^[A-Za-z0-9_.:-]{1,160}$/;

/**
 * Content guard for the persisted trace. It targets the exact leak classes the
 * frozen interface forbids (prompt material, message bodies, credentials, raw
 * provider payloads) rather than incidental system words, so a truthful
 * diagnostic code can still be reported without the guard rejecting it.
 */
const CONTENT_GUARD =
  /(?:private prompt|prompt text|player prefers|private dialogue|raw provider|authorization|bearer\s|api[_-]?key|set-cookie|statetoken|sk-[A-Za-z0-9_-]{16,})/i;

const AUDIT_IDENTITY = Object.freeze({
  playerId: "chat_audit_player",
  companionId: "chat_audit_companion",
  continuityId: "chat_audit_continuity",
});

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const names = Object.keys(value);
  return names.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

export function parseArguments(argv) {
  if (argv.length === 0) return Object.freeze({ reportPath: undefined });
  if ((argv.length !== 2 && argv.length !== 4) || argv[0] !== "--report")
    throw new Error("usage: node tools/run-chat-live-audit.mjs [--report <path>] [--probe-manifest <path>]");
  if (argv[1].length === 0 || (argv.length === 4 && (argv[2] !== "--probe-manifest" || argv[3].length === 0)))
    throw new Error("usage: node tools/run-chat-live-audit.mjs [--report <path>] [--probe-manifest <path>]");
  return argv.length === 2
    ? Object.freeze({ reportPath: resolve(argv[1]) })
    : Object.freeze({ reportPath: resolve(argv[1]), probeManifestPath: resolve(argv[3]) });
}

export async function prepareReportTarget(path) {
  if (path === undefined) return undefined;
  if (!isAbsolute(path) || relative(path, dirname(path)) === "") throw new Error("invalid_report_path");
  try {
    await lstat(path);
    throw new Error("report_target_already_exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const parent = dirname(path);
  let canonicalParent;
  try {
    canonicalParent = await realpath(parent);
  } catch {
    throw new Error("report_parent_missing_or_unresolvable");
  }
  const state = await lstat(canonicalParent);
  if (!state.isDirectory() || state.isSymbolicLink()) throw new Error("report_parent_not_real_directory");
  return join(canonicalParent, basename(path));
}

function safeReasonCode(error) {
  const value = error instanceof Error ? error.message : String(error);
  return /^[a-z0-9_:.-]{1,160}$/i.test(value) ? value : "chat_audit_runner_internal_error";
}

const PROBE_MANIFEST_SCHEMA = "chat_memory_probe_manifest/v1";
const PROBE_DISTANCES = Object.freeze(new Set(["turn", "fold", "session"]));
const PROBE_DIMENSIONS = Object.freeze(new Set(["retention", "discrimination", "supersession", "isolation"]));
const PROBE_STEP_KIND = Object.freeze(new Set(["seed", "filler", "probe"]));
const PROBE_ROLE = /^(companion|player)$/;

/**
 * Load and validate a probe manifest (fixture sidecar, never a product trace).
 * The schema is the proposal from the long-horizon-memory-probe design
 * (bounded, fixture-owned): an opaque manifest id + digest, a single continuity
 * topology, and a list of probe scenarios. Nothing here is allowed to reach a
 * trace except through the frozen `probe` vocabulary (probeId + manifestDigest).
 */
function validateProbeStepShape(step) {
  const kind = step?.kind;
  if (!PROBE_STEP_KIND.has(kind)) return "probe_step_kind_invalid";
  if (kind !== "probe" && kind !== "seed" && (typeof step.role !== "string" || !PROBE_ROLE.test(step.role))) return "probe_step_role_invalid";
  if (typeof step.text !== "string" || step.text.length === 0) return "probe_step_text_invalid";
  if (kind === "probe") {
    if (!Array.isArray(step.requiredKeywords) || step.requiredKeywords.some((keyword) => typeof keyword !== "string")) return "probe_step_keywords_invalid";
    if (step.forbiddenKeywords !== undefined && (!Array.isArray(step.forbiddenKeywords) || step.forbiddenKeywords.some((keyword) => typeof keyword !== "string"))) return "probe_step_keywords_invalid";
  }
  if (kind === "seed" && (typeof step.persistVia !== "string" || !["memory_route", "conversation"].includes(step.persistVia))) return "probe_step_persistvia_invalid";
  return undefined;
}

function validateProbeShape(probe, index) {
  if (probe === null || typeof probe !== "object" || Array.isArray(probe)) throw new Error(`probe_manifest_probe_invalid:${index}`);
  const probeKeys = new Set(["probeId", "distance", "dimension", "seedClass", "steps"]);
  for (const key of Object.keys(probe)) if (!probeKeys.has(key)) throw new Error(`probe_manifest_probe_field_unknown:${index}:${key}`);
  if (typeof probe.probeId !== "string" || !PROBE_ID.test(probe.probeId)) throw new Error(`probe_manifest_probe_id_invalid:${index}`);
  if (!PROBE_DISTANCES.has(probe.distance)) throw new Error(`probe_manifest_probe_distance_invalid:${index}:${probe.distance}`);
  if (!PROBE_DIMENSIONS.has(probe.dimension)) throw new Error(`probe_manifest_probe_dimension_invalid:${index}:${probe.dimension}`);
  if (probe.seedClass !== "explicit" && probe.seedClass !== "conversational") throw new Error(`probe_manifest_probe_seedclass_invalid:${index}:${probe.seedClass}`);
  if (!Array.isArray(probe.steps) || probe.steps.length === 0) throw new Error(`probe_manifest_probe_steps_missing:${index}`);
  const steps = probe.steps.map((step, stepIndex) => {
    const issue = validateProbeStepShape(step);
    if (issue !== undefined) throw new Error(`probe_manifest_${issue}:${index}:${stepIndex}`);
    return Object.freeze({ ...step });
  });
  return Object.freeze({ ...probe, steps });
}

export function loadProbeManifest(text) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw new Error("probe_manifest_invalid_json");
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("probe_manifest_invalid");
  const allowedKeys = new Set(["schema", "manifestId", "manifestDigest", "continuityTopology", "probes"]);
  for (const key of Object.keys(manifest)) if (!allowedKeys.has(key)) throw new Error(`probe_manifest_unknown_field:${key}`);
  if (manifest.schema !== PROBE_MANIFEST_SCHEMA) throw new Error(`probe_manifest_schema_mismatch:${manifest.schema}`);
  if (typeof manifest.manifestId !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(manifest.manifestId)) throw new Error("probe_manifest_id_invalid");
  if (typeof manifest.manifestDigest !== "string" || !SHA256_HEX.test(manifest.manifestDigest)) throw new Error("probe_manifest_digest_invalid");
  if (manifest.continuityTopology !== "single" && manifest.continuityTopology !== "dual") throw new Error("probe_manifest_topology_invalid");
  if (!Array.isArray(manifest.probes) || manifest.probes.length === 0) throw new Error("probe_manifest_probes_missing");
  const probes = manifest.probes.map((probe, index) => validateProbeShape(probe, index));
  const digest = sha256(JSON.stringify(Object.freeze({ schema: PROBE_MANIFEST_SCHEMA, manifestId: manifest.manifestId, continuityTopology: manifest.continuityTopology, probes })));
  if (digest !== manifest.manifestDigest) throw new Error("probe_manifest_digest_mismatch");
  return Object.freeze({ schema: PROBE_MANIFEST_SCHEMA, manifestId: manifest.manifestId, manifestDigest: manifest.manifestDigest, continuityTopology: manifest.continuityTopology, probes });
}

function boundedReason(value, fallback) {
  return typeof value === "string" && CODE_PATTERN.test(value) ? value : fallback;
}

/**
 * Keyword evidence for one probe turn comes only from the authenticated durable
 * transcript (Class A, same source as `presentation.committed`). The reply text
 * is matched here and NEVER reaches a trace; only the probe's opaque id + the
 * manifest digest do. `requiredKeywords` follow the design threshold: >=0.5 of
 * them by substring (after normalize), and any `forbiddenKeywords` hit fails.
 */
export function evaluateProbeReply({ transcriptText, step }) {
  if (typeof transcriptText !== "string" || transcriptText.length === 0)
    return Object.freeze({ hit: false, forbiddenCount: 0, reason: "no_presentation_text" });
  const required = Array.isArray(step.requiredKeywords) ? step.requiredKeywords : [];
  const forbidden = Array.isArray(step.forbiddenKeywords) ? step.forbiddenKeywords : [];
  if (required.length === 0) return Object.freeze({ hit: false, forbiddenCount: 0, reason: "no_required_keywords" });
  const normalized = normalizeKeywordText(transcriptText);
  const hitCount = required.filter((kw) => normalized.includes(normalizeKeywordText(kw))).length;
  const forbiddenCount = forbidden.filter((kw) => normalized.includes(normalizeKeywordText(kw))).length;
  const threshold = step.minHitRate !== undefined && Number.isFinite(step.minHitRate) ? Math.min(1, Math.max(0, step.minHitRate)) : 0.5;
  return Object.freeze({ hit: hitCount >= Math.ceil(required.length * threshold), forbiddenCount });
}

/**
 * The probe "was there a durable reply for THIS turn" gate (audit design §3.3).
 *
 * A keyword verdict may only be scored against the DURABLE committed-companion
 * delta of the current turn. The Class B stderr marker only reports that the
 * admission boundary was crossed — it can be `rejected`, and it is not the
 * durable fact — so a turn whose presentation never committed (or was rejected)
 * must be an observability gap, never a scored match against older transcript
 * text.
 */
export function probeTurnCommittedGate(outcome) {
  if (outcome === undefined || outcome.terminal !== true)
    return Object.freeze({ ok: false, reason: "probe_turn_not_terminal" });
  if (!(outcome.committedCompanionDelta > 0))
    return Object.freeze({ ok: false, reason: "probe_turn_no_committed_presentation" });
  return Object.freeze({ ok: true });
}

/**
 * The probe turn's verdict, given its gate decision and (only when the gate
 * passed) the keyword matches.
 *
 * This is the routing seam, not just the predicate: a failed gate SHORT-CIRCUITS
 * to `observability_gap` and the keyword matches are never even consulted, so a
 * turn whose presentation was rejected or never committed can never be scored —
 * not against this turn, and not against older transcript text. Tested directly
 * so that reordering this decision (scoring first, gating later) fails.
 */
export function probeVerdict({ gate, keywords }) {
  if (!gate.ok) return Object.freeze({ event: "observability_gap", reason: gate.reason });
  if (keywords === undefined) return Object.freeze({ event: "observability_gap", reason: "probe_keywords_missing" });
  if (keywords.hit && keywords.forbiddenCount === 0) return Object.freeze({ event: "needle.hit" });
  if (!keywords.hit && keywords.forbiddenCount === 0) return Object.freeze({ event: "needle.miss" });
  return Object.freeze({ event: "distractor.confused" });
}

/** Substring keyword normalization mirroring the conversational quality gate. */
function normalizeKeywordText(value) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Deployment manifest for one audit run. The schema is the frozen Host
 * deployment identity (`host/src/deployment-manifest.ts`, schemaVersion 2).
 */
export function createAuditDeploymentManifest(runtimeRoot, principal, bootstrapOperationId) {
  return Object.freeze({
    schemaVersion: 2,
    topology: "independent_chat_and_game_surfaces",
    runtimeRoot,
    principal: Object.freeze({ ...principal }),
    bootstrapOperationId,
    authorityGeneration: 1,
  });
}

/**
 * Per-row obligations for the `probe` kind. Mirrors the audit kernel's
 * `validateProbeEvent` exactly (same obligations, same order): every probe event
 * carries the opaque `probeId` and the `manifestDigest` of the sidecar that
 * holds the probe material, and `isolation.breach` additionally carries the
 * distance and `dimension=isolation`. Returns a reason code or undefined.
 */
function probeEventReason(meta) {
  if (!isPlainObject(meta)) return "event_probe_metadata_missing";
  if (typeof meta.probeId !== "string" || !PROBE_ID.test(meta.probeId)) return "event_probe_id_invalid";
  if (typeof meta.manifestDigest !== "string" || !SHA256_HEX.test(meta.manifestDigest))
    return "event_probe_manifest_digest_invalid";
  if (meta.distance !== undefined && !AUDIT_PROBE_DISTANCES.includes(meta.distance)) return "event_probe_distance_invalid";
  if (meta.dimension !== undefined && !AUDIT_PROBE_DIMENSIONS.includes(meta.dimension)) return "event_probe_dimension_invalid";
  return undefined;
}

/**
 * The extra obligations `isolation.breach` carries beyond every probe event.
 * Split out because the missing-meta branch must reach them too.
 */
function probeBreachReason(event, meta) {
  if (event.code !== PROBE_ISOLATION_BREACH_CODE || event.kind !== PROBE_KIND) return undefined;
  if (!isPlainObject(meta) || !AUDIT_PROBE_DISTANCES.includes(meta.distance))
    return "event_probe_breach_distance_missing";
  if (meta.dimension !== PROBE_BREACH_DIMENSION) return "event_probe_breach_dimension_invalid";
  return undefined;
}

export function validateAuditEvent(event) {
  if (!isPlainObject(event)) return Object.freeze({ ok: false, reasonCode: "event_not_object" });
  if (!Object.keys(event).every((key) => AUDIT_EVENT_KEYS.includes(key)))
    return Object.freeze({ ok: false, reasonCode: "event_unknown_field" });
  if (!Number.isSafeInteger(event.at) || event.at < 0)
    return Object.freeze({ ok: false, reasonCode: "event_at_invalid" });
  if (!AUDIT_KINDS.includes(event.kind)) return Object.freeze({ ok: false, reasonCode: "event_kind_unknown" });
  if (typeof event.code !== "string" || !CODE_PATTERN.test(event.code))
    return Object.freeze({ ok: false, reasonCode: "event_code_charset_invalid" });
  const actor = AUDIT_VOCABULARY[`${event.kind}.${event.code}`];
  if (actor === undefined) return Object.freeze({ ok: false, reasonCode: "event_code_unknown" });
  if (actor !== event.actor) return Object.freeze({ ok: false, reasonCode: "event_actor_mismatch" });
  if (event.meta === undefined) {
    // Per-code obligations still apply with no meta at all: `turn.terminal`,
    // `run.finished` and every `probe` event require one.
    if (event.code === "turn.terminal") return Object.freeze({ ok: false, reasonCode: "event_turn_terminal_state_missing" });
    if (event.code === "run.finished")
      return Object.freeze({ ok: false, reasonCode: "event_provider_observability_missing" });
    if (event.kind === PROBE_KIND) return Object.freeze({ ok: false, reasonCode: "event_probe_metadata_missing" });
    return Object.freeze({ ok: true, reasonCode: undefined });
  }
  if (!isPlainObject(event.meta)) return Object.freeze({ ok: false, reasonCode: "event_meta_not_object" });
  const metaKeys = Object.keys(event.meta);
  if (metaKeys.length > 8) return Object.freeze({ ok: false, reasonCode: "event_meta_too_many_keys" });
  for (const key of metaKeys) {
    if (!AUDIT_META_KEYS.includes(key)) return Object.freeze({ ok: false, reasonCode: "event_meta_key_unknown" });
    const value = event.meta[key];
    const valid =
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value)) ||
      (typeof value === "string" && value.length <= 160 && !/[\u0000-\u001f\u007f]/.test(value));
    if (!valid) return Object.freeze({ ok: false, reasonCode: "event_meta_value_invalid" });
  }
  // Per-code obligations the frozen table states as part of the row contract.
  // These MUST stay in step with the audit kernel's own obligations
  // (`tools/lib/chat-run-audit.mjs`): a trace this validator accepts but the
  // kernel rejects would be written to disk and then analysed as nothing.
  if (event.code === "turn.terminal" && !AUDIT_TERMINAL_STATES.includes(event.meta.state))
    return Object.freeze({ ok: false, reasonCode: "event_turn_terminal_state_invalid" });
  if (event.code === "run.finished" && !AUDIT_PROVIDER_OBSERVABILITY.includes(event.meta.providerObservability))
    return Object.freeze({ ok: false, reasonCode: "event_provider_observability_missing" });
  if (event.kind === PROBE_KIND) {
    const probeReason = probeEventReason(event.meta);
    if (probeReason !== undefined) return Object.freeze({ ok: false, reasonCode: probeReason });
  }
  const breachReason = probeBreachReason(event, event.meta);
  if (breachReason !== undefined) return Object.freeze({ ok: false, reasonCode: breachReason });
  return Object.freeze({ ok: true, reasonCode: undefined });
}

/**
 * The single fail-closed gate over the harness's own output. Any unknown field,
 * unknown code, actor mismatch, out-of-range value, non-monotonic `at`, or
 * content-bearing line is rejected; nothing is silently dropped and collection
 * never continues past an invalid emit.
 */
export function validateAuditTrace(trace) {
  if (!hasExactKeys(trace, AUDIT_CATEGORY_KEYS)) return Object.freeze({ ok: false, reasonCode: "trace_category_invalid" });
  if (trace.schema !== AUDIT_SCHEMA) return Object.freeze({ ok: false, reasonCode: "trace_schema_invalid" });
  if (typeof trace.runId !== "string" || !OPAQUE_RUN_ID.test(trace.runId))
    return Object.freeze({ ok: false, reasonCode: "trace_run_id_invalid" });
  const startedAtMs = typeof trace.startedAt === "string" ? Date.parse(trace.startedAt) : Number.NaN;
  const completedAtMs = typeof trace.completedAt === "string" ? Date.parse(trace.completedAt) : Number.NaN;
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(completedAtMs))
    return Object.freeze({ ok: false, reasonCode: "trace_timestamp_invalid" });
  if (completedAtMs < startedAtMs) return Object.freeze({ ok: false, reasonCode: "trace_timestamp_order_invalid" });
  if (trace.surface !== AUDIT_SURFACE) return Object.freeze({ ok: false, reasonCode: "trace_surface_invalid" });
  if (!hasExactKeys(trace.artifact, AUDIT_ARTIFACT_KEYS)) return Object.freeze({ ok: false, reasonCode: "trace_artifact_invalid" });
  if (typeof trace.artifact.generation !== "string" || !GENERATION.test(trace.artifact.generation))
    return Object.freeze({ ok: false, reasonCode: "trace_artifact_invalid" });
  if (typeof trace.artifact.inventoryDigest !== "string" || !SHA256_HEX.test(trace.artifact.inventoryDigest))
    return Object.freeze({ ok: false, reasonCode: "trace_artifact_invalid" });
  if (!hasExactKeys(trace.provider, AUDIT_PROVIDER_KEYS)) return Object.freeze({ ok: false, reasonCode: "trace_provider_invalid" });
  if (trace.provider.embedded !== true || typeof trace.provider.observed !== "boolean")
    return Object.freeze({ ok: false, reasonCode: "trace_provider_invalid" });
  if (trace.originMs !== 0) return Object.freeze({ ok: false, reasonCode: "trace_origin_invalid" });
  if (!Array.isArray(trace.events) || trace.events.length === 0)
    return Object.freeze({ ok: false, reasonCode: "trace_events_invalid" });
  let previousAt = 0;
  let finished = 0;
  let started = 0;
  let providerObservability;
  for (const event of trace.events) {
    const validation = validateAuditEvent(event);
    if (!validation.ok) return Object.freeze({ ok: false, reasonCode: validation.reasonCode });
    if (event.at < previousAt) return Object.freeze({ ok: false, reasonCode: "trace_at_not_monotonic" });
    previousAt = event.at;
    if (event.kind === "lifecycle" && event.code === "run.started") started += 1;
    if (event.kind === "lifecycle" && event.code === "run.finished") {
      finished += 1;
      const value = event.meta?.providerObservability;
      if (value !== "observed" && value !== "unobserved")
        return Object.freeze({ ok: false, reasonCode: "trace_provider_observability_missing" });
      providerObservability = value;
    }
  }
  if (finished !== 1) return Object.freeze({ ok: false, reasonCode: "trace_run_finished_invalid" });
  // Mirrors the audit kernel: a trace whose run never started describes no run.
  if (started === 0) return Object.freeze({ ok: false, reasonCode: "trace_run_started_missing" });
  if (providerObservability !== (trace.provider.observed ? "observed" : "unobserved"))
    return Object.freeze({ ok: false, reasonCode: "trace_provider_observability_inconsistent" });
  return Object.freeze({ ok: true, reasonCode: undefined });
}

export function contentFree(serialized) {
  return !CONTENT_GUARD.test(serialized);
}

/**
 * Validates, then writes the trace create-only. A trace that fails validation
 * or trips the content guard is never written.
 */
export async function writeAuditTrace(path, trace) {
  const validation = validateAuditTrace(trace);
  if (!validation.ok) throw new Error(`audit_trace_invalid:${validation.reasonCode}`);
  const serialized = `${JSON.stringify(trace, null, 2)}\n`;
  if (!contentFree(serialized)) throw new Error("audit_trace_content_guard_rejected");
  if (path === undefined) return serialized;
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(serialized, "utf8");
  } finally {
    await handle.close();
  }
  return serialized;
}

export function buildAuditTrace({ runId, startedAt, completedAt, artifact, providerObserved, events }) {
  return Object.freeze({
    schema: AUDIT_SCHEMA,
    runId,
    startedAt,
    completedAt,
    surface: AUDIT_SURFACE,
    artifact: Object.freeze({ generation: artifact.generation, inventoryDigest: artifact.inventoryDigest }),
    provider: Object.freeze({ embedded: true, observed: providerObserved === true }),
    originMs: 0,
    events: Object.freeze([...events]),
  });
}

/**
 * Monotonic emitter. `at` is a millisecond offset from the run origin, clamped
 * to never move backwards, and every event is validated as it is recorded so a
 * malformed emit fails closed at the source instead of producing a trace that
 * later has to be discarded.
 */
export function createAuditRecorder({ startedAtMs, now = Date.now }) {
  if (!Number.isSafeInteger(startedAtMs)) throw new Error("audit_recorder_origin_invalid");
  const events = [];
  let cursor = 0;
  return Object.freeze({
    record(kind, actor, code, meta) {
      const elapsed = Math.floor(now() - startedAtMs);
      const at = elapsed > cursor ? elapsed : cursor;
      cursor = at;
      const event = meta === undefined ? { at, kind, actor, code } : { at, kind, actor, code, meta: Object.freeze({ ...meta }) };
      const validation = validateAuditEvent(event);
      if (!validation.ok) throw new Error(`audit_event_emitted_invalid:${validation.reasonCode}`);
      events.push(Object.freeze(event));
      return event;
    },
    events() {
      return Object.freeze([...events]);
    },
  });
}

export function parseSseFrame(frame) {
  const lines = frame.split("\n");
  let cursor;
  let eventType;
  let data;
  for (const line of lines) {
    if (line.length === 0) continue;
    if (line.startsWith("id: ")) cursor = line.slice(4);
    else if (line.startsWith("event: ")) eventType = line.slice(7);
    else if (line.startsWith("data: ")) data = data === undefined ? line.slice(6) : `${data}\n${line.slice(6)}`;
    else return Object.freeze({ ok: false, reason: "malformed_line" });
  }
  if (eventType === undefined || data === undefined) return Object.freeze({ ok: false, reason: "incomplete_frame" });
  let payload;
  try {
    payload = JSON.parse(data);
  } catch {
    return Object.freeze({ ok: false, reason: "invalid_json" });
  }
  if (!isPlainObject(payload)) return Object.freeze({ ok: false, reason: "invalid_payload" });
  if (payload.eventType !== eventType) return Object.freeze({ ok: false, reason: "event_type_mismatch" });
  return Object.freeze({ ok: true, cursor, eventType, payload });
}

export function classifyStartupStderr(stderr) {
  if (typeof stderr !== "string" || stderr.length === 0) return undefined;
  for (const line of stderr.split(/\r?\n/).map((value) => value.trim())) {
    if (line.length === 0) continue;
    const code = line.replace(/^Error:\s*/i, "");
    if (!STARTUP_STDERR_CODE.test(code)) continue;
    const reason = `${STARTUP_STDERR_REASON_PREFIX}${code.toLowerCase()}`;
    if (CODE_PATTERN.test(reason)) return reason;
  }
  return undefined;
}

export function classifyStartupFailure(error, stderr) {
  const reason = safeReasonCode(error);
  if (!reason.startsWith("dialogue_exited_before_ready:") && reason !== "dialogue_start_timeout") return reason;
  return classifyStartupStderr(stderr) ?? reason;
}

/**
 * Class A child IPC: the pre-send marker proves only that Pi serialized a
 * request immediately before the provider call. It is scoped to the exact
 * session identity reported by the separate runtime frame.
 */
export function evaluateProviderRuntimeMarker(value) {
  if (value?.schema !== "gamebuddy-tavern-narrative-gate-runtime/v1" || typeof value.piSessionId !== "string" || !PI_SESSION_ID.test(value.piSessionId))
    return Object.freeze({ observed: false, reasonCode: "provider_runtime_session_unavailable" });
  return Object.freeze({ observed: true, piSessionId: value.piSessionId });
}

export function evaluateProviderPreSendMarker(value, expectedDigest, expectedSessionId) {
  if (value === undefined) return Object.freeze({ observed: false, reasonCode: "provider_marker_unavailable" });
  if (
    value?.schema !== "gamebuddy-tavern-narrative-gate-marker/v1" ||
    typeof value.sessionId !== "string" ||
    typeof value.nonceSha256 !== "string" ||
    !PI_SESSION_ID.test(value.sessionId) ||
    !SHA256_HEX.test(value.nonceSha256)
  )
    return Object.freeze({ observed: false, reasonCode: "provider_marker_schema_invalid" });
  if (value.sessionId !== expectedSessionId || value.nonceSha256 !== expectedDigest)
    return Object.freeze({ observed: false, reasonCode: "provider_marker_digest_mismatch" });
  return Object.freeze({ observed: true, preSendSerialized: true });
}

/**
 * Class B diagnostic markers. Only admission and rejection are expressible; the
 * `commit_done` marker is intentionally absent because the authoritative
 * presentation fact may only come from `/state`.
 */
const PRESENTATION_MARKER = /\[DEBUG-chat-live-p4c\] (admission_ok|commit_rejected|commit_error|native_rejected_[a-z_]+)/g;

/**
 * Class B probe materialization markers emitted by Magic Context on vendor
 * stderr after a durable fold COMMIT (D-1 approved: vendor stderr). They are
 * consumed internally by the probe driver for P-fold positioning and m[0]
 * bit-stability; they NEVER become frozen audit event codes.
 *   `[probe:m0_digest] <sha256-of-persisted-m0-bytes>`
 *   `[probe:fold_committed] <opaque-materialization-revision>`
 */
// The value alternative is ordered: a `rev_`-prefixed revision can never be a
// 64-char lowercase hex digest (the `r` is not a hex digit), so a bound value is
// unambiguous and there is no backtracking ambiguity between the two kinds. The
// digest marker carries its materialization revision as a third token because
// §5.4's bit-stability check is "same revision, same digest" — without the pair a
// legitimate re-render is indistinguishable from drift.
const PROBE_MATERIALIZATION_MARKER =
  /\[probe:(m0_digest|fold_committed)\] (rev_[A-Za-z0-9_-]{1,120}|[a-f0-9]{64})(?: (rev_[A-Za-z0-9_-]{1,120}))?/g;

export function classifyProbeMaterializationMarkers(stderr) {
  if (typeof stderr !== "string" || stderr.length === 0) return Object.freeze([]);
  const markers = [];
  for (const match of stderr.matchAll(PROBE_MATERIALIZATION_MARKER)) {
    const kind = match[1];
    const value = match[2];
    if (kind === "fold_committed") {
      markers.push(Object.freeze({ code: "fold_committed", revision: value }));
      continue;
    }
    // A digest without its revision cannot be compared, so a digest marker that
    // is missing the paired token is not evidence and is not reported as one.
    const revision = match[3];
    if (revision === undefined) continue;
    markers.push(Object.freeze({ code: "m0_digest", digest: value, revision }));
  }
  return Object.freeze(markers);
}

export function classifyPresentationMarkers(stderr) {
  if (typeof stderr !== "string" || stderr.length === 0) return Object.freeze([]);
  const markers = [];
  for (const match of stderr.matchAll(PRESENTATION_MARKER)) {
    const token = match[1];
    markers.push(
      token === "admission_ok"
        ? Object.freeze({ code: "admitted", status: "admission_ok" })
        : Object.freeze({ code: "rejected", reason: token.slice(0, 160) }),
    );
  }
  return Object.freeze(markers);
}

/**
 * Durable projection of one authenticated `/state` read. `chat.turn` is the
 * current turn ledger projection and `chat.transcript` is the durable
 * append-only transcript, which is the only authority for a committed
 * companion presentation.
 */
export function projectStateSnapshot(snapshot) {
  if (!isPlainObject(snapshot) || !isPlainObject(snapshot.chat)) return undefined;
  if (!Number.isSafeInteger(snapshot.selection?.generation)) return undefined;
  const turn = snapshot.chat.turn ?? null;
  const transcript = Array.isArray(snapshot.chat.transcript) ? snapshot.chat.transcript : [];
  const committedCompanion = transcript.filter((message) => message?.role === "companion");
  // Probe keyword matching sees ONLY the last committed companion message: that
  // is the probe turn's reply. Taking the last text-BEARING message instead would
  // fall back to an earlier turn when the newest message has no text, and joining
  // the whole transcript would let any earlier turn satisfy the match — either way
  // a `distractor.confused` would be a statement about the conversation rather
  // than about the probe turn.
  const lastCompanion = committedCompanion.at(-1);
  const committedCompanionText = typeof lastCompanion?.text === "string" ? lastCompanion.text : "";
  return Object.freeze({
    selectionGeneration: snapshot.selection.generation,
    draftRevision: Number.isSafeInteger(snapshot.chat.draft?.revision) ? snapshot.chat.draft.revision : undefined,
    turnHandle: typeof turn?.handle === "string" ? turn.handle : undefined,
    turnState: typeof turn?.state === "string" ? turn.state : undefined,
    problemCode: typeof turn?.problemCode === "string" ? boundedReason(turn.problemCode, undefined) : undefined,
    canCancel: turn?.canCancel === true,
    transcriptLength: transcript.length,
    committedCompanionMessages: committedCompanion.length,
    memoryReadAvailable: snapshot.memory?.readAvailable === true,
    // Probe keyword matching uses the durable committed companion TEXT (never a
    // trace field). It is present only when there is text to match, so the
    // projection shape remains unchanged for the common (probe-less) path.
    ...(committedCompanionText.length === 0 ? {} : { committedCompanionText }),
  });
}

/**
 * Reload comparison against the previously observed durable terminal state. The
 * transcript is append-only, so a shrinking transcript or a lost committed
 * companion message is a durable-continuity mismatch, never a rendering detail.
 */
export function compareReloadSnapshot(previous, reloaded) {
  if (previous.turnHandle !== reloaded.turnHandle) return Object.freeze({ consistent: false, reason: "turn_handle_changed" });
  if (previous.turnState !== reloaded.turnState) return Object.freeze({ consistent: false, reason: "turn_state_changed" });
  if (previous.transcriptLength > reloaded.transcriptLength) return Object.freeze({ consistent: false, reason: "transcript_truncated" });
  if (previous.committedCompanionMessages > reloaded.committedCompanionMessages)
    return Object.freeze({ consistent: false, reason: "committed_presentation_lost" });
  if (previous.selectionGeneration !== reloaded.selectionGeneration)
    return Object.freeze({ consistent: false, reason: "selection_generation_changed" });
  return Object.freeze({ consistent: true, reason: undefined });
}

function deadlineFetch(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

async function bootstrap(origin, token) {
  const response = await deadlineFetch(`${origin}/api/tavern/v1/bootstrap`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ apiVersion: 1, bootstrapToken: token }),
  });
  const body = await response.json().catch(() => undefined);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!response.ok || typeof cookie !== "string" || typeof body?.csrfToken !== "string")
    throw new Error(`bootstrap_failed:${response.status}`);
  return Object.freeze({ cookie, csrf: body.csrfToken });
}

async function readStateSnapshot({ origin, client, recorder }) {
  let response;
  try {
    response = await deadlineFetch(`${origin}/api/tavern/v1/state`, { headers: { Cookie: client.cookie, Origin: origin } });
  } catch {
    return Object.freeze({ ok: false, reasonCode: "state_unreachable" });
  }
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    recorder.record("http", "harness", "state.conflict", { status: response.status });
    return Object.freeze({ ok: false, reasonCode: `state_conflict:${response.status}` });
  }
  recorder.record("http", "harness", "state.read");
  const projection = projectStateSnapshot(body);
  if (projection === undefined) {
    recorder.record("http", "harness", "state.conflict", { status: response.status, reason: "state_snapshot_unusable" });
    return Object.freeze({ ok: false, reasonCode: "state_snapshot_unusable" });
  }
  return Object.freeze({ ok: true, projection });
}

async function submitTurn({ origin, client, projection, recorder, message = SUBMIT_PROMPT_TEXT }) {
  const response = await deadlineFetch(`${origin}/api/tavern/v1/messages`, {
    method: "POST",
    headers: {
      Origin: origin,
      Cookie: client.cookie,
      "X-CSRF-Token": client.csrf,
      "Idempotency-Key": randomBytes(16).toString("base64url"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      apiVersion: 1,
      selectionGeneration: projection.selectionGeneration,
      text: message,
      locale: "en",
      ...(projection.draftRevision === undefined ? {} : { expectedDraftRevision: projection.draftRevision }),
    }),
  });
  if (response.status !== 202) throw new Error(`message_failed:${response.status}`);
  const body = await response.json().catch(() => undefined);
  const disposition = body?.disposition === "accepted" || body?.disposition === "duplicate" ? body.disposition : undefined;
  recorder.record("lifecycle", "harness", "turn.submitted", disposition === undefined ? undefined : { disposition });
  return Object.freeze({ disposition });
}

/**
 * The authenticated cancel route. It returns the durable race winner, so a fast
 * completion is reported as `completion_won` / `already_terminal` rather than as
 * a fabricated cancellation.
 *
 * This never emits `turn.terminal` itself. The 200 response can legitimately
 * carry a NON-terminal `turn.state` (the route projects `running` when the turn
 * advanced past the cancellable phase), and §3.1 requires `turn.terminal` to
 * carry one of the three durable terminal states. Synthesising `stopping` here
 * would both invent a state the reference projection never produces and assert a
 * terminal the harness did not observe; the `/state` read-back in `awaitTerminal`
 * is the only authority for that fact.
 */
async function cancelTurn({ origin, client, projection, turnHandle }) {
  if (typeof turnHandle !== "string" || !OPERATION_HANDLE.test(turnHandle))
    return Object.freeze({ ok: false, reasonCode: "cancel_turn_handle_invalid" });
  const response = await deadlineFetch(`${origin}/api/tavern/v1/turns/${encodeURIComponent(turnHandle)}/cancel`, {
    method: "POST",
    headers: { Origin: origin, Cookie: client.cookie, "X-CSRF-Token": client.csrf, "Content-Type": "application/json" },
    body: JSON.stringify({ apiVersion: 1, selectionGeneration: projection.selectionGeneration }),
  });
  if (!response.ok) return Object.freeze({ ok: false, reasonCode: `cancel_failed:${response.status}` });
  const body = await response.json().catch(() => undefined);
  const disposition =
    body?.disposition === "cancelled" || body?.disposition === "completion_won" || body?.disposition === "already_terminal"
      ? body.disposition
      : undefined;
  const state = typeof body?.turn?.state === "string" ? body.turn.state : undefined;
  // Nothing is recorded here. This route's 200 can carry a non-terminal
  // `turn.state`, and `turn.terminal` must carry one of the three durable
  // terminal states, so asserting a terminal from this response would fabricate
  // one. The observed disposition is attached to the real terminal by
  // `awaitTerminal` once `/state` has been read back.
  return Object.freeze({ ok: true, disposition, state });
}

/**
 * One SSE observation connection per turn. A missing stream is a harness
 * boundary degradation, not a fabricated observation: the durable `/state`
 * read-back stays authoritative either way.
 *
 * `cursor` is the last event id this reader actually received on this run's
 * earlier connections. The host serves a bounded replay window and treats a
 * request for a sequence it can no longer replay as `resync("gap")`, so a reader
 * that reconnects without its cursor from `sequence: 0` forces a gap as soon as
 * the window rolls — a gap the reader itself created, which then looked like a
 * host stream defect in the audit. The cursor is therefore carried forward.
 */
async function openEventStream({ origin, client, recorder, cursor = undefined }) {
  const controller = new AbortController();
  const connectDeadline = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const query = cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`;
  let response;
  try {
    response = await fetch(`${origin}/api/tavern/v1/events?apiVersion=1${query}`, {
      headers: { Cookie: client.cookie, Origin: origin },
      signal: controller.signal,
    });
  } catch {
    clearTimeout(connectDeadline);
    return Object.freeze({ ok: false, reasonCode: "events_unreachable" });
  }
  clearTimeout(connectDeadline);
  if (!response.ok || response.body === null) {
    controller.abort();
    return Object.freeze({ ok: false, reasonCode: `events_failed:${response.status}` });
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let latestCursor = cursor;
  let settleTerminal;
  const terminal = new Promise((resolveTerminal) => {
    settleTerminal = resolveTerminal;
  });
  const pump = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let separator;
        while ((separator = buffer.indexOf("\n\n")) >= 0) {
          const raw = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          if (raw.trim().length === 0) continue;
          const frame = parseSseFrame(raw);
          if (!frame.ok) {
            recorder.record("sse", "harness", "frame.invalid", { reason: frame.reason });
            continue;
          }
          recorder.record("sse", "host", "frame.received");
          // The id carried on the frame is the reader's resume point; without
          // recording it the next connection would start from zero again.
          if (typeof frame.cursor === "string" && frame.cursor.length > 0) latestCursor = frame.cursor;
          if (frame.eventType === "stream.resync_required") {
            recorder.record("sse", "host", "stream.resync", { reason: boundedReason(frame.payload.payload?.reason, "unknown") });
            // The host closes a resync response, so the observable truth for this
            // turn comes from the durable `/state` read-back. Resolving the
            // terminal wait here is what keeps an observer-side stream close from
            // being reported as a 180 s product idle stall.
            settleTerminal("resync");
            continue;
          }
          if (frame.eventType === "turn.state_changed") {
            const state = frame.payload.payload?.state;
            if (TERMINAL_TURN_STATES.has(state)) settleTerminal(state);
          }
        }
      }
    } catch {
      // A closed or aborted stream is normal; `/state` remains the authority.
    }
  })();
  return Object.freeze({
    ok: true,
    /** Last event id seen on this connection: the next connection resumes here. */
    cursor: () => latestCursor,
    waitForTerminal: (timeoutMs) =>
      Promise.race([terminal, delay(timeoutMs).then(() => "timeout")]),
    async close() {
      controller.abort();
      await reader.cancel().catch(() => undefined);
      await pump.catch(() => undefined);
    },
  });
}

/**
 * Waits for the turn's terminal state and reconciles it through the
 * authenticated durable `/state` projection: an SSE terminal signal alone is
 * never promoted to a durable terminal fact.
 *
 * `projectionBefore` is the pre-submit snapshot used ONLY as the
 * committed-message baseline. It is deliberately not a candidate terminal: the
 * current turn projection at that moment is whatever the PREVIOUS turn settled
 * to, so starting from it would report the previous turn's terminal as this
 * turn's. A terminal is asserted only from a successful read taken after this
 * turn's submission, and only when that read is confirmed to describe a
 * different turn than the pre-submit snapshot.
 */
async function awaitTerminal({ origin, client, recorder, stream, projectionBefore, cancel }) {
  if (stream !== undefined) await stream.waitForTerminal(TURN_TIMEOUT_MS);
  let projection;
  for (let attempt = 0; attempt < POST_SUBMIT_STATE_POLLS; attempt += 1) {
    const read = await readStateSnapshot({ origin, client, recorder });
    if (read.ok) {
      projection = read.projection;
      if (TERMINAL_TURN_STATES.has(projection.turnState)) break;
    }
    if (attempt + 1 < POST_SUBMIT_STATE_POLLS) await delay(POST_SUBMIT_STATE_POLL_MS);
  }
  // No successful post-submit read at all: nothing authoritative was observed, so
  // no terminal can be claimed. The caller counts this turn as unsettled.
  if (projection === undefined) return Object.freeze({ terminal: false, projection: undefined });
  if (!TERMINAL_TURN_STATES.has(projection.turnState)) {
    // A non-terminal read for THIS turn is also not a terminal. Do not fall back
    // to any earlier snapshot.
    return Object.freeze({ terminal: false, projection });
  }
  // Turn-identity guard: when both the pre-submit and post-submit projections
  // carry an opaque turn handle, a terminal claim for this turn requires them to
  // differ (this turn's handle is new) or the snapshot to be positively this
  // turn's. A matching handle means we are looking at the previous turn's
  // settled projection, which must never be attributed here.
  if (
    typeof projection.turnHandle === "string" &&
    typeof projectionBefore?.turnHandle === "string" &&
    projection.turnHandle === projectionBefore.turnHandle
  ) {
    return Object.freeze({ terminal: false, projection, reasonCode: "terminal_turn_identity_stale" });
  }
  recorder.record("lifecycle", "harness", "turn.terminal", {
    state: projection.turnState,
    ...(cancel === undefined || cancel.disposition === undefined ? {} : { disposition: cancel.disposition }),
    ...(projection.problemCode === undefined ? {} : { problemCode: projection.problemCode }),
  });
  // Derived facts come from the same authoritative read; emitting them after
  // this turn's `turn.terminal` event lets a reader attribute them positionally.
  if (projection.turnState === "completed") recorder.record("provider", "host", "settled", { state: "completed" });
  else if (projection.turnState === "failed" && projection.problemCode === "runtime_unavailable")
    recorder.record("provider", "host", "error", { problemCode: "runtime_unavailable" });
  if (projection.committedCompanionMessages > projectionBefore.committedCompanionMessages)
    recorder.record("presentation", "host", "committed", {
      count: projection.committedCompanionMessages - projectionBefore.committedCompanionMessages,
    });
  // The durable committed-presentation delta is returned so a caller that needs
  // "was there a durable reply for THIS turn" can use the transcript authority
  // instead of the Class B stderr marker count. A marker only reports that the
  // admission boundary was crossed; it can be `rejected`, and it is not the
  // durable fact.
  return Object.freeze({
    terminal: true,
    projection,
    committedCompanionDelta:
      projection.committedCompanionMessages - (projectionBefore?.committedCompanionMessages ?? 0),
  });
}

function emitNewPresentationMarkers({ stderr, recorder, seen }) {
  const markers = classifyPresentationMarkers(stderr);
  for (let index = seen.count; index < markers.length; index += 1) {
    const marker = markers[index];
    if (marker.code === "admitted") recorder.record("presentation", "harness", "admitted", { status: marker.status });
    else recorder.record("presentation", "harness", "rejected", { reason: marker.reason });
  }
  seen.count = markers.length;
  return markers.length > 0;
}

async function collectRun({ root, recorder, nonceSha256, environment, attachChild, probeManifest }) {
  const artifact = await productionArtifactIdentity();
  environment.artifact = artifact;
  const configPath = join(root, "chat-audit.json");
  await writeFile(
    configPath,
    JSON.stringify(
      createAuditDeploymentManifest(
        root,
        AUDIT_IDENTITY,
        `chat_audit_bootstrap_${randomBytes(12).toString("hex")}`,
      ),
    ),
    "utf8",
  );
  // The launcher spawns the child internally, so both the stderr evidence and
  // the child handle are taken through its own explicit `spawnImpl` seam. That
  // keeps the real bundled runtime and the one formal entry: this only observes
  // the child and owns its teardown, so a launch that dies before ready still
  // yields the child's bounded startup diagnostic and its process is stopped.
  let stderr = "";
  const launch = await launchDesktopCompositionGateChild({
    outputRoot: join(HOST_ROOT, "dist"),
    root,
    surface: AUDIT_SURFACE,
    nonceSha256,
    manifestPath: configPath,
    readyTimeoutMs: START_TIMEOUT_MS,
    spawnImpl: (command, args, options) => {
      const spawned = spawn(command, args, options);
      attachChild(spawned);
      spawned.stderr.setEncoding("utf8");
      spawned.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      return spawned;
    },
  }).catch((error) => {
    // The child is stopped by the caller's teardown even when the launcher
    // rejects before returning its handle; only the bounded startup diagnostic
    // is classified here.
    environment.boundaryReason ??= classifyStartupFailure(error, stderr);
    throw error;
  });
  attachChild(launch.child, launch);

  // Provider evidence: the runtime frame supplies the exact Pi session identity,
  // the pre-send marker supplies the one provider-boundary fact. Both are
  // Class A child IPC and both must be present and cross-consistent.
  let runtimeSessionId;
  let pendingPreSend;
  let preSendSettled = false;
  // Which turn was active when the provider boundary was actually crossed. The
  // pre-send marker fires once per Pi session, so §3.2 rule 3's conjunction
  // (this turn saw `request.sent` AND never terminalised) can only be asserted
  // for that one turn.
  let providerMarkerTurn;
  let activeTurnIndex = 0;
  const flushPreSend = () => {
    if (preSendSettled || pendingPreSend === undefined || runtimeSessionId === undefined) return;
    preSendSettled = true;
    const evaluation = evaluateProviderPreSendMarker(pendingPreSend, nonceSha256, runtimeSessionId);
    pendingPreSend = undefined;
    if (!evaluation.observed) {
      environment.boundaryReason ??= evaluation.reasonCode;
      return;
    }
    environment.providerObservability = "observed";
    providerMarkerTurn = activeTurnIndex;
    recorder.record("provider", "host", "request.sent");
  };
  launch.onMessage((value) => {
    if (value?.schema === "gamebuddy-tavern-narrative-gate-runtime/v1") {
      const evaluation = evaluateProviderRuntimeMarker(value);
      if (evaluation.observed) {
        runtimeSessionId = evaluation.piSessionId;
        flushPreSend();
      }
      return;
    }
    if (value?.schema === "gamebuddy-tavern-narrative-gate-marker/v1" && !preSendSettled && pendingPreSend === undefined) {
      pendingPreSend = value;
      flushPreSend();
    }
  });

  let ready;
  try {
    ready = await launch.waitForReady();
  } catch (error) {
    throw new Error(classifyStartupFailure(error, stderr));
  }
  const url = new URL(ready);
  const origin = `${url.protocol}//${url.host}`;
  const bootstrapToken = new URLSearchParams(url.hash.slice(1)).get("boot");
  if (bootstrapToken === null) throw new Error("bootstrap_token_missing");
  const client = await bootstrap(origin, bootstrapToken);
  environment.started = true;
  recorder.record("lifecycle", "harness", "run.started", { status: "ready" });

  const seenPresentation = { count: 0 };
  environment.presentationMarkers = 0;
  // Magic Context's Class B fold/digest observations (D-1 approved: vendor
  // stderr). These are the ONLY producer of the fold distance's positioning
  // fact, so §3.3's rule is enforced here: a `fold` probe enters only after the
  // marker says the baseline actually folded; otherwise the probe is not scored
  // and reports `fold_not_observed` instead of guessing that the memory folded.
  const seenProbe = { foldCount: 0, digest: null, revision: null };
  const noteProbeMarkers = () => {
    for (const marker of classifyProbeMaterializationMarkers(stderr)) {
      if (marker.code === "fold_committed") seenProbe.foldCount += 1;
      // Last observation wins: the digest is compared against its own revision,
      // so the newest pair is the current baseline.
      else {
        seenProbe.digest = marker.digest;
        seenProbe.revision = marker.revision;
      }
    }
    environment.foldMarkers = seenProbe.foldCount;
  };
  let memoryReadEmitted = false;
  const noteMemoryProjection = (projection) => {
    if (memoryReadEmitted || !projection.memoryReadAvailable) return;
    memoryReadEmitted = true;
    recorder.record("memory", "host", "memory.read", { status: "available" });
  };
  const notePresentation = () => {
    emitNewPresentationMarkers({ stderr, recorder, seen: seenPresentation });
    environment.presentationMarkers = seenPresentation.count;
  };

  // Probe driving (independent opt-in mode; default behaviour unchanged). Each
  // probe scenario is a bounded, fixture-owned turn script: a probe turn that
  // must carry a committed presentation to count, with seed/filler turns that
  // only advance the conversation. Every emitted probe event must carry the
  // opaque probeId + manifestDigest (probeEventReason), and the keyword text
  // never enters a trace.
  const emitProbe = (probe, event, reason) => {
    // `reason` is a scalar (or undefined); the frozen meta allow-list has no
    // nested-object value, and `recorder.record` rejects any non-scalar meta.
    if (reason !== undefined && (typeof reason !== "string" || reason.length === 0))
      throw new Error("probe_event_reason_invalid");
    const meta = {
      probeId: probe.probeId,
      manifestDigest: probeManifest.manifestDigest,
      ...(probe.distance === undefined ? {} : { distance: probe.distance }),
      ...(probe.dimension === undefined ? {} : { dimension: probe.dimension }),
      ...(reason === undefined ? {} : { reason }),
    };
    recorder.record("probe", "harness", event, meta);
  };
  // Read the committed companion reply for the current turn from the durable
  // transcript. The transcript is append-only, so filtering by the companion
  // role and taking the LAST committed companion message is this turn's reply;
  // the text is used for keyword matching only and never recorded.
  const readCompanionKeywordMatches = async (step) => {
    const snapshot = await readStateSnapshot({ origin, client, recorder });
    if (!snapshot.ok || typeof snapshot.projection?.committedCompanionText !== "string") {
      return Object.freeze({ hit: false, forbiddenCount: 0 });
    }
    const companionText = snapshot.projection.committedCompanionText;
    return companionText.length === 0
      ? Object.freeze({ hit: false, forbiddenCount: 0 })
      : evaluateProbeReply({ transcriptText: companionText, step });
  };

  let unsettled = 0;
  let unsettledTurnIndexes = [];
  let durableTerminal;
  const runTurn = async ({ cancel, message = SUBMIT_PROMPT_TEXT }) => {
    activeTurnIndex += 1;
    const turnIndex = activeTurnIndex;
    const opened = await readStateSnapshot({ origin, client, recorder });
    if (!opened.ok) throw new Error(opened.reasonCode);
    noteMemoryProjection(opened.projection);
    const streamResult = await openEventStream({ origin, client, recorder, cursor: environment.streamCursor });
    if (!streamResult.ok) environment.boundaryReason ??= streamResult.reasonCode;
    const stream = streamResult.ok ? streamResult : undefined;
    try {
      await submitTurn({ origin, client, projection: opened.projection, recorder, message });
      let cancelResult;
      if (cancel) {
        let armed;
        for (let attempt = 0; attempt < CANCEL_ARM_POLLS; attempt += 1) {
          const poll = await readStateSnapshot({ origin, client, recorder });
          if (!poll.ok) break;
          if (TERMINAL_TURN_STATES.has(poll.projection.turnState)) break;
          if (poll.projection.canCancel) {
            armed = poll.projection;
            break;
          }
          await delay(CANCEL_ARM_POLL_MS);
        }
        if (armed === undefined) environment.collectionReason ??= "cancel_window_missed";
        else {
          cancelResult = await cancelTurn({ origin, client, projection: opened.projection, turnHandle: armed.turnHandle });
          if (!cancelResult.ok) {
            environment.boundaryReason ??= cancelResult.reasonCode;
            cancelResult = undefined;
          }
        }
      }
      const outcome = await awaitTerminal({
        origin,
        client,
        recorder,
        stream,
        projectionBefore: opened.projection,
        cancel: cancelResult,
      });
      if (!outcome.terminal) {
        unsettled += 1;
        unsettledTurnIndexes.push(turnIndex);
        return undefined;
      }
      durableTerminal = outcome.projection;
      // Return the full outcome (with `.terminal` and `.projection`) rather than
      // just the projection: a caller that asks "did this turn reach a durable
      // terminal AND what does the durable state look like" must see both. The
      // probe scenario checks `outcome.terminal`, and the reload comparison uses
      // `durableTerminal` captured above.
      return outcome;
    } finally {
      // Carry this connection's last event id forward so the next turn's
      // observation resumes instead of asking the host to replay from zero.
      if (stream?.cursor !== undefined && stream.cursor() !== undefined) environment.streamCursor = stream.cursor();
      await stream?.close();
      // The provider marker and the stderr markers are published at the provider
      // and presentation boundaries, so both are drained before the turn's
      // evidence is closed out.
      await delay(MARKER_DRAIN_MS);
      flushPreSend();
      notePresentation();
      noteProbeMarkers();
    }
  };

  const runProbeScenario = async ({ probe }) => {
    // Scenario steps run against the real pipeline and are bounded by the
    // turn timeout; without a progress mark a long scenario looks hung. Steps
    // are named by the manifest, never by content, and never enter a trace.
    for (let stepIndex = 0; stepIndex < probe.steps.length; stepIndex += 1) {
      const step = probe.steps[stepIndex];
      // Progress mark: one line per step so a long scenario is observable
      // instead of looking hung. The step kind is public; the step text is not.
      console.error(
        `[chat-live-audit] probe ${probe.probeId} step ${stepIndex + 1}/${probe.steps.length} (${step.kind})`,
      );
      if (step.kind === "probe") {
        // §3.3: a fold-distance probe is only scored once production itself has
        // folded the baseline. Otherwise the question is asked before the memory
        // folded, and a truthful "I don't know" would be recorded as a retention
        // miss — a fabricated regression. No marker is a gap, never a failure.
        if (probe.distance === "fold") {
          await delay(MARKER_DRAIN_MS);
          noteProbeMarkers();
          if (seenProbe.foldCount === 0) {
            emitProbe(probe, "observability_gap", "fold_not_observed");
            continue;
          }
        }
        const outcome = await runTurn({ message: step.text });
        const probeGate = probeTurnCommittedGate(outcome);
        // A failed gate must short-circuit BEFORE any keyword read, so a turn
        // with no durable commit is never scored against older text.
        const keywords = probeGate.ok ? await readCompanionKeywordMatches(step) : undefined;
        const verdict = probeVerdict({ gate: probeGate, keywords });
        emitProbe(probe, verdict.event, verdict.reason);
        continue;
      }
      // seed/filler: advance the conversation only.
      await runTurn({ message: step.text });
    }
    return undefined;
  };
  if (probeManifest !== undefined && probeManifest.probes.length > 0) {
    for (let index = 0; index < probeManifest.probes.length; index += 1) {
      await runProbeScenario({ probe: probeManifest.probes[index] });
    }
  } else {
    // Default (no manifest): the existing fixed two-turn sweep.
    await runTurn({ cancel: false });
    await runTurn({ cancel: true });
  }

  // Reload/recovery: the client surface drops its live stream and re-derives
  // everything from the authenticated durable `/state`, then compares that
  // read-back with the terminal state it already observed.
  recorder.record("recovery", "harness", "reload.started", { status: "surface_reloaded" });
  if (durableTerminal === undefined) environment.collectionReason ??= "no_durable_terminal_state";
  else {
    const reloaded = await readStateSnapshot({ origin, client, recorder });
    if (!reloaded.ok) environment.boundaryReason ??= reloaded.reasonCode;
    else {
      const comparison = compareReloadSnapshot(durableTerminal, reloaded.projection);
      if (comparison.consistent)
        recorder.record("recovery", "harness", "reload.settled", {
          status: "consistent",
          generation: reloaded.projection.selectionGeneration,
        });
      else recorder.record("recovery", "harness", "reload.mismatch", { reason: comparison.reason });
    }
  }

  // Observation-gap reporting: a missing marker is announced, never silently
  // read as cleanliness, and never treated as a failure.
  await delay(MARKER_DRAIN_MS);
  flushPreSend();
  notePresentation();
  if (unsettled > 0) {
    environment.collectionReason ??= "turn_never_terminal";
    environment.unsettledTurns = unsettled;
    // Only an unsettled turn that actually crossed the provider boundary can
    // satisfy §3.2 rule 3; record the conjunction per turn rather than letting
    // `finishRun` assert it from run-level facts.
    environment.unsettledProviderTurns =
      providerMarkerTurn === undefined || !unsettledTurnIndexes.includes(providerMarkerTurn) ? 0 : 1;
  }
}

function finishRun({ recorder, environment }) {
  // The run's own observability limits are reported explicitly so a missing
  // marker reads as a gap instead of as cleanliness. A gap is informational: it
  // is neither an integrity failure nor evidence about the provider.
  if (environment.providerObservability !== "observed")
    recorder.record("provider", "harness", "observability_gap", { status: "unobserved", reason: "no_pre_send_marker" });
  if (environment.presentationMarkers === 0)
    recorder.record("presentation", "harness", "observability_gap", { status: "unobserved", reason: "no_presentation_marker" });
  if (environment.unsettledProviderTurns > 0 && environment.providerObservability === "observed")
    // §3.2 rule 3 requires the conjunction to hold for THE TURN: it observed
    // `provider.request.sent` and never reached a terminal. The pre-send marker
    // fires once per Pi session, so the harness records which turn was active
    // when it fired; asserting this from run-level facts alone would claim a
    // per-turn integrity fact that turn has no evidence for.
    recorder.record("provider", "harness", "boundary_unsettled", {
      reason: "turn_never_terminal",
      count: environment.unsettledProviderTurns,
    });
  const boundaryFailed = environment.boundaryReason !== undefined;
  const reason = environment.boundaryReason ?? environment.collectionReason;
  recorder.record("lifecycle", "harness", "run.finished", {
    status: boundaryFailed ? "boundary_failed" : "collected",
    providerObservability: environment.providerObservability,
    ...(reason === undefined ? {} : { reason }),
  });
}

async function productionArtifactIdentity() {
  try {
    const pointer = JSON.parse(await readFile(join(HOST_ROOT, "dist", "current.json"), "utf8"));
    if (typeof pointer.generation !== "string" || !GENERATION.test(pointer.generation)) throw new Error("invalid");
    if (typeof pointer.inventoryDigest !== "string" || !SHA256_HEX.test(pointer.inventoryDigest)) throw new Error("invalid");
    return Object.freeze({ generation: pointer.generation, inventoryDigest: pointer.inventoryDigest });
  } catch {
    throw new Error("production_artifact_identity_unavailable");
  }
}

async function stop(child) {
  if (child === undefined || child.exitCode !== null) return "not_running";
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolveStop) => child.once("exit", () => resolveStop(true))),
    new Promise((resolveStop) => setTimeout(() => resolveStop(false), STOP_TIMEOUT_MS)),
  ]);
  if (exited) return "terminated";
  child.kill("SIGKILL");
  await Promise.race([
    new Promise((resolveStop) => child.once("exit", () => resolveStop(undefined))),
    new Promise((resolveStop) => setTimeout(resolveStop, 1_000)),
  ]);
  return "killed_after_stop_timeout";
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseArguments(argv);
  const reportTarget = await prepareReportTarget(parsed.reportPath);
  // Probe manifests are fixture-owned sidecars; loading one here keeps the
  // mechanism independent of the default two-turn sweep (whose shape stays
  // unchanged). A manifest that cannot be read or validated exits blocked, not
  // silently downgrading to the default sweep.
  let probeManifest;
  if (parsed.probeManifestPath !== undefined) {
    try {
      probeManifest = loadProbeManifest(await readFile(parsed.probeManifestPath, "utf8"));
    } catch (error) {
      console.error(JSON.stringify({ schema: HARNESS_OUTCOME_SCHEMA, state: "blocked", reasonCode: safeReasonCode(error) }));
      return 2;
    }
  }
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-chat-live-audit-"));
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  const runId = randomBytes(12).toString("hex");
  const recorder = createAuditRecorder({ startedAtMs });
  const environment = {
    artifact: undefined,
    boundaryReason: undefined,
    collectionReason: undefined,
    providerObservability: "unobserved",
    presentationMarkers: 0,
    // Last SSE event id observed on any connection, carried across turns so a
    // reconnect resumes the bounded replay window instead of forcing a gap.
    streamCursor: undefined,
    unsettledTurns: 0,
    unsettledProviderTurns: 0,
    started: false,
  };
  // `launchDesktopCompositionGateChild` builds its ready waiter before it can
  // fail, so a launch that dies before returning leaves that waiter's rejection
  // with no caller left to observe it. Node reports an unobserved rejection as a
  // fatal error and terminates the process before the harness could write a
  // truthful blocked trace, so a collector is installed for the whole process
  // lifetime. It never replaces the real reason: a run that started reports what
  // it observed, and this only supplies a boundary reason for a run that could
  // not start at all.
  process.on("unhandledRejection", (reason) => {
    environment.boundaryReason ??= safeReasonCode(reason);
  });
  let child;
  let launch;
  const attachChild = (spawned, handle) => {
    child = spawned;
    if (handle !== undefined) launch = handle;
  };
  try {
    await collectRun({
      root,
      recorder,
      nonceSha256: sha256(randomBytes(18).toString("hex")),
      environment,
      attachChild,
      probeManifest,
    });
  } catch (error) {
    environment.boundaryReason ??= safeReasonCode(error);
  } finally {
    await stop(child).catch(() => undefined);
    launch?.dispose();
  }

  try {
    if (environment.artifact === undefined) {
      // Without the immutable artifact identity no schema-valid trace is
      // expressible, so the harness refuses to write one.
      console.log(
        JSON.stringify(
          Object.freeze({
            schema: HARNESS_OUTCOME_SCHEMA,
            state: "blocked",
            runId,
            startedAt,
            reasonCode: environment.boundaryReason ?? "chat_audit_harness_blocked",
          }),
        ),
      );
      return 2;
    }
    // A trace is evidence about a run that actually collected something. If the
    // child never reached ready+bootstrap, no turn was ever observed and the
    // trace would describe nothing — yet every turn detector is vacuously silent
    // on it, so it would audit as a clean, passed run. Refuse to write it and
    // report the boundary failure instead.
    if (environment.started !== true) {
      console.log(
        JSON.stringify(
          Object.freeze({
            schema: HARNESS_OUTCOME_SCHEMA,
            state: "blocked",
            runId,
            startedAt,
            reasonCode: environment.boundaryReason ?? "chat_audit_harness_never_started",
          }),
        ),
      );
      return 2;
    }
    finishRun({ recorder, environment });
    const trace = buildAuditTrace({
      runId,
      startedAt,
      completedAt: new Date().toISOString(),
      artifact: environment.artifact,
      providerObserved: environment.providerObservability === "observed",
      events: recorder.events(),
    });
    const serialized = await writeAuditTrace(reportTarget, trace);
    if (reportTarget === undefined) console.log(serialized.trimEnd());
    else console.log(JSON.stringify(trace));
    return 0;
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => undefined);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(JSON.stringify({ schema: HARNESS_OUTCOME_SCHEMA, state: "blocked", reasonCode: safeReasonCode(error) }));
      process.exitCode = 2;
    });
}
