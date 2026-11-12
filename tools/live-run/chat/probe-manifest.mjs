/**
 * The memory-probe manifest and the verdicts it produces: a fixture-sidecar list of seed/filler/probe steps, the
 * reply gate that decides whether a probe turn committed anything at all, and the dimension verdict on top of it.
 *
 * A probe manifest is never a product trace; nothing here reaches the trace except through the frozen `probe`
 * vocabulary (`probeId` + `manifestDigest`).
 */
import { CODE_PATTERN, PROBE_ID, SHA256_HEX } from "./chat-audit-contract.mjs";
import { sha256 } from "./chat-audit-values.mjs";

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
  if (kind !== "probe" && kind !== "seed" && (typeof step.role !== "string" || !PROBE_ROLE.test(step.role)))
    return "probe_step_role_invalid";
  if (typeof step.text !== "string" || step.text.length === 0) return "probe_step_text_invalid";
  if (kind === "probe") {
    if (!Array.isArray(step.requiredKeywords) || step.requiredKeywords.some((keyword) => typeof keyword !== "string"))
      return "probe_step_keywords_invalid";
    if (
      step.forbiddenKeywords !== undefined &&
      (!Array.isArray(step.forbiddenKeywords) || step.forbiddenKeywords.some((keyword) => typeof keyword !== "string"))
    )
      return "probe_step_keywords_invalid";
  }
  if (
    kind === "seed" &&
    (typeof step.persistVia !== "string" || !["memory_route", "conversation"].includes(step.persistVia))
  )
    return "probe_step_persistvia_invalid";
  return undefined;
}

function validateProbeShape(probe, index) {
  if (probe === null || typeof probe !== "object" || Array.isArray(probe))
    throw new Error(`probe_manifest_probe_invalid:${index}`);
  const probeKeys = new Set(["probeId", "distance", "dimension", "seedClass", "steps"]);
  for (const key of Object.keys(probe))
    if (!probeKeys.has(key)) throw new Error(`probe_manifest_probe_field_unknown:${index}:${key}`);
  if (typeof probe.probeId !== "string" || !PROBE_ID.test(probe.probeId))
    throw new Error(`probe_manifest_probe_id_invalid:${index}`);
  if (!PROBE_DISTANCES.has(probe.distance))
    throw new Error(`probe_manifest_probe_distance_invalid:${index}:${probe.distance}`);
  if (!PROBE_DIMENSIONS.has(probe.dimension))
    throw new Error(`probe_manifest_probe_dimension_invalid:${index}:${probe.dimension}`);
  if (probe.seedClass !== "explicit" && probe.seedClass !== "conversational")
    throw new Error(`probe_manifest_probe_seedclass_invalid:${index}:${probe.seedClass}`);
  if (!Array.isArray(probe.steps) || probe.steps.length === 0)
    throw new Error(`probe_manifest_probe_steps_missing:${index}`);
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
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest))
    throw new Error("probe_manifest_invalid");
  const allowedKeys = new Set(["schema", "manifestId", "manifestDigest", "continuityTopology", "probes"]);
  for (const key of Object.keys(manifest))
    if (!allowedKeys.has(key)) throw new Error(`probe_manifest_unknown_field:${key}`);
  if (manifest.schema !== PROBE_MANIFEST_SCHEMA) throw new Error(`probe_manifest_schema_mismatch:${manifest.schema}`);
  if (typeof manifest.manifestId !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(manifest.manifestId))
    throw new Error("probe_manifest_id_invalid");
  if (typeof manifest.manifestDigest !== "string" || !SHA256_HEX.test(manifest.manifestDigest))
    throw new Error("probe_manifest_digest_invalid");
  if (manifest.continuityTopology !== "single" && manifest.continuityTopology !== "dual")
    throw new Error("probe_manifest_topology_invalid");
  if (!Array.isArray(manifest.probes) || manifest.probes.length === 0) throw new Error("probe_manifest_probes_missing");
  const probes = manifest.probes.map((probe, index) => validateProbeShape(probe, index));
  const digest = sha256(
    JSON.stringify(
      Object.freeze({
        schema: PROBE_MANIFEST_SCHEMA,
        manifestId: manifest.manifestId,
        continuityTopology: manifest.continuityTopology,
        probes,
      }),
    ),
  );
  if (digest !== manifest.manifestDigest) throw new Error("probe_manifest_digest_mismatch");
  return Object.freeze({
    schema: PROBE_MANIFEST_SCHEMA,
    manifestId: manifest.manifestId,
    manifestDigest: manifest.manifestDigest,
    continuityTopology: manifest.continuityTopology,
    probes,
  });
}

export function boundedReason(value, fallback) {
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
  const threshold =
    step.minHitRate !== undefined && Number.isFinite(step.minHitRate) ? Math.min(1, Math.max(0, step.minHitRate)) : 0.5;
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
export function probeVerdict({ gate, keywords, dimension }) {
  if (!gate.ok) return Object.freeze({ event: "observability_gap", reason: gate.reason });
  if (keywords === undefined) return Object.freeze({ event: "observability_gap", reason: "probe_keywords_missing" });
  // The supersession dimension answers a different question from retention: not "is
  // the fact present" but "did the overwrite take effect in BOTH directions". It has
  // its own frozen codes and its own `reason` vocabulary (design 3.5,
  // `old_retained` / `new_missing`), and it was specified but never produced - the
  // codes sat in the frozen table while no branch emitted them.
  if (dimension === "supersession") {
    // The old fact surviving is the more specific failure: it means the supersede
    // chain did not take effect in the assembled prompt. A reply that names both (the
    // "you like parsnips and amethyst" fudge) therefore lands here rather than on
    // `new_missing`, which is what makes the both-answers case detectable at all.
    if (keywords.forbiddenCount > 0) return Object.freeze({ event: "supersede.fail", reason: "old_retained" });
    if (keywords.hit) return Object.freeze({ event: "supersede.pass" });
    return Object.freeze({ event: "supersede.fail", reason: "new_missing" });
  }
  if (keywords.hit && keywords.forbiddenCount === 0) return Object.freeze({ event: "needle.hit" });
  if (!keywords.hit && keywords.forbiddenCount === 0) return Object.freeze({ event: "needle.miss" });
  // `distractor.confused` has two distinct causes and they must stay
  // distinguishable in the report, because only one of them is a memory
  // failure: `needle_only` means the needle WAS recalled and a forbidden word
  // merely co-occurred (which a correct reply that denies the distractor also
  // does), while `recall_failed` means the needle was not recalled at all.
  // The code is unchanged and the frozen vocabulary is untouched; the cause
  // rides on the already-permitted scalar `reason` meta key.
  return Object.freeze({
    event: "distractor.confused",
    reason: keywords.hit ? "needle_only" : "recall_failed",
  });
}

/** Substring keyword normalization mirroring the conversational quality gate. */
function normalizeKeywordText(value) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * The boundary reason a CONVERSATION turn contributes, or `undefined` when it settled cleanly.
 *
 * A `failed` terminal is as much a product fact as an unsettled one, and it used to leave the run
 * reporting `collected` while one of its own turns had died — which is exactly the kind of silent
 * downgrade this harness is forbidden to make. The per-turn state itself is recorded in the trace
 * (`turn.terminal`, with its bounded `problemCode`); this decision only carries it into the run verdict.
 */
export function conversationTurnBoundaryReason(turn) {
  if (turn?.terminal !== true) return "conversation_turn_not_terminal";
  return turn.projection?.turnState === "failed" ? "conversation_turn_failed" : undefined;
}
