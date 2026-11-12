/**
 * The trace itself: the deployment manifest one run declares, the recorder every event goes through, the validation
 * that decides an event may exist, the content guard, and the create-only writer.
 *
 * A trace that fails validation or trips the content guard is never written, which is why all three live in one file:
 * the recorder, the validator and the writer must agree on the same frozen contract
 * (`chat-audit-contract.mjs`).
 */
import { open } from "node:fs/promises";

import {
  AUDIT_ARTIFACT_KEYS,
  AUDIT_CATEGORY_KEYS,
  AUDIT_EVENT_KEYS,
  AUDIT_KINDS,
  AUDIT_META_KEYS,
  AUDIT_PROBE_DIMENSIONS,
  AUDIT_PROBE_DISTANCES,
  AUDIT_PROVIDER_KEYS,
  AUDIT_PROVIDER_OBSERVABILITY,
  AUDIT_SCHEMA,
  AUDIT_SURFACE,
  AUDIT_TERMINAL_STATES,
  AUDIT_VOCABULARY,
  CODE_PATTERN,
  CONTENT_GUARD,
  GENERATION,
  OPAQUE_RUN_ID,
  PROBE_BREACH_DIMENSION,
  PROBE_ID,
  PROBE_ISOLATION_BREACH_CODE,
  PROBE_KIND,
  SHA256_HEX,
} from "./chat-audit-contract.mjs";
import { hasExactKeys, isPlainObject } from "./chat-audit-values.mjs";
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
  if (meta.distance !== undefined && !AUDIT_PROBE_DISTANCES.includes(meta.distance))
    return "event_probe_distance_invalid";
  if (meta.dimension !== undefined && !AUDIT_PROBE_DIMENSIONS.includes(meta.dimension))
    return "event_probe_dimension_invalid";
  return undefined;
}

/**
 * The extra obligations `isolation.breach` carries beyond every probe event.
 * Split out because the missing-meta branch must reach them too.
 */
function probeBreachReason(event, meta) {
  if (event.code !== PROBE_ISOLATION_BREACH_CODE || event.kind !== PROBE_KIND) return undefined;
  if (!(isPlainObject(meta) && AUDIT_PROBE_DISTANCES.includes(meta.distance)))
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
    if (event.code === "turn.terminal")
      return Object.freeze({ ok: false, reasonCode: "event_turn_terminal_state_missing" });
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
  if (!hasExactKeys(trace, AUDIT_CATEGORY_KEYS))
    return Object.freeze({ ok: false, reasonCode: "trace_category_invalid" });
  if (trace.schema !== AUDIT_SCHEMA) return Object.freeze({ ok: false, reasonCode: "trace_schema_invalid" });
  if (typeof trace.runId !== "string" || !OPAQUE_RUN_ID.test(trace.runId))
    return Object.freeze({ ok: false, reasonCode: "trace_run_id_invalid" });
  const startedAtMs = typeof trace.startedAt === "string" ? Date.parse(trace.startedAt) : Number.NaN;
  const completedAtMs = typeof trace.completedAt === "string" ? Date.parse(trace.completedAt) : Number.NaN;
  if (!(Number.isFinite(startedAtMs) && Number.isFinite(completedAtMs)))
    return Object.freeze({ ok: false, reasonCode: "trace_timestamp_invalid" });
  if (completedAtMs < startedAtMs) return Object.freeze({ ok: false, reasonCode: "trace_timestamp_order_invalid" });
  if (trace.surface !== AUDIT_SURFACE) return Object.freeze({ ok: false, reasonCode: "trace_surface_invalid" });
  if (!hasExactKeys(trace.artifact, AUDIT_ARTIFACT_KEYS))
    return Object.freeze({ ok: false, reasonCode: "trace_artifact_invalid" });
  if (typeof trace.artifact.generation !== "string" || !GENERATION.test(trace.artifact.generation))
    return Object.freeze({ ok: false, reasonCode: "trace_artifact_invalid" });
  if (typeof trace.artifact.inventoryDigest !== "string" || !SHA256_HEX.test(trace.artifact.inventoryDigest))
    return Object.freeze({ ok: false, reasonCode: "trace_artifact_invalid" });
  if (!hasExactKeys(trace.provider, AUDIT_PROVIDER_KEYS))
    return Object.freeze({ ok: false, reasonCode: "trace_provider_invalid" });
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
      const event =
        meta === undefined ? { at, kind, actor, code } : { at, kind, actor, code, meta: Object.freeze({ ...meta }) };
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
