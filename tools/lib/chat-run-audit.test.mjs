import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CHAT_RUN_AUDIT_CODES_BY_KIND,
  CHAT_RUN_AUDIT_KINDS,
  CHAT_RUN_AUDIT_META_KEYS,
  CHAT_RUN_AUDIT_SCHEMA,
  FINDING_COMPONENTS,
  IDLE_STALL_THRESHOLD_MS,
  MAX_STATE_READS_PER_TURN,
  analyzeChatRunAudit,
  buildChatRunAuditReport,
  formatChatRunAuditReportText,
  summarizeChatRunAudit,
  validateChatRunAudit,
} from "./chat-run-audit.mjs";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "chat-run-audit");

/** @param {string} name */
async function fixture(name) {
  return JSON.parse(await readFile(join(FIXTURE_DIR, name), "utf8"));
}

/** @param {string} name */
function fixturePath(name) {
  return join(FIXTURE_DIR, name);
}

/** A minimal valid trace that individual tests perturb. */
function baseAudit(overrides = {}) {
  return {
    schema: CHAT_RUN_AUDIT_SCHEMA,
    runId: "run-test-0001",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
    surface: "chat-only",
    artifact: { generation: "gen-test-0001", inventoryDigest: "a".repeat(64) },
    originMs: 0,
    events: [
      { at: 0, kind: "lifecycle", actor: "harness", code: "run.started" },
      { at: 10, kind: "lifecycle", actor: "harness", code: "turn.submitted" },
      { at: 20, kind: "http", actor: "harness", code: "state.read", meta: { state: "running" } },
      { at: 30, kind: "provider", actor: "host", code: "request.sent" },
      { at: 40, kind: "sse", actor: "host", code: "frame.received" },
      { at: 50, kind: "presentation", actor: "host", code: "committed" },
      { at: 60, kind: "lifecycle", actor: "harness", code: "turn.terminal", meta: { state: "completed" } },
      {
        at: 70,
        kind: "lifecycle",
        actor: "harness",
        code: "run.finished",
        meta: { providerObservability: "observed" },
      },
    ],
    ...overrides,
  };
}

/** @param {any} audit */
function reasonsFor(audit) {
  return validateChatRunAudit(audit).errors.map((error) => error.reason);
}

// ============================================================================
// Validation
// ============================================================================

test("validateChatRunAudit accepts the clean and detector fixtures", async () => {
  for (const name of [
    "clean-success.json",
    "idle-stall.json",
    "cancelled-clean.json",
    "probe-isolation-breach.json",
    "probe-reported-only.json",
  ]) {
    const result = validateChatRunAudit(await fixture(name));
    assert.equal(result.valid, true, `${name}: ${JSON.stringify(result.errors)}`);
    assert.deepEqual(result.errors, []);
  }
});

// ============================================================================
// Probe vocabulary obligations
// ============================================================================

test("a probe event must bind to its manifest, and only a breach must place itself", () => {
  const bound = { probeId: "p-turn-01", manifestDigest: "a".repeat(64) };
  const withProbe = (code, meta) => {
    const audit = baseAudit();
    audit.events.splice(4, 0, { at: 35, kind: "probe", actor: "harness", code, ...(meta === undefined ? {} : { meta }) });
    return audit;
  };
  // Non-breach outcomes only have to name their probe and manifest.
  assert.equal(validateChatRunAudit(withProbe("needle.hit", bound)).valid, true);
  assert.equal(validateChatRunAudit(withProbe("needle.miss", { ...bound, distance: "turn" })).valid, true);
  // A probe event with no meta at all cannot carry either binding.
  assert.ok(reasonsFor(withProbe("needle.hit", undefined)).includes("probe_id_missing"));
  assert.ok(
    reasonsFor(withProbe("needle.hit", { probeId: "p-turn-01" })).includes("probe_manifest_digest_invalid"),
  );
  assert.ok(
    reasonsFor(withProbe("needle.hit", { manifestDigest: "a".repeat(64) })).includes("probe_id_missing"),
  );
  // The two enumerable domains are closed.
  assert.ok(reasonsFor(withProbe("needle.hit", { ...bound, distance: "week" })).includes("probe_distance_invalid"));
  assert.ok(
    reasonsFor(withProbe("needle.hit", { ...bound, dimension: "naturalness" })).includes("probe_dimension_invalid"),
  );
  // `isolation.breach` additionally requires distance + dimension=isolation.
  assert.ok(reasonsFor(withProbe("isolation.breach", bound)).includes("probe_breach_distance_missing"));
  assert.ok(
    reasonsFor(withProbe("isolation.breach", { ...bound, distance: "fold" })).includes(
      "probe_breach_dimension_invalid",
    ),
  );
  assert.equal(
    validateChatRunAudit(withProbe("isolation.breach", { ...bound, distance: "fold", dimension: "isolation" }))
      .valid,
    true,
  );
});

test("a kind/code mismatch is rejected, so a mis-kinded breach cannot bypass integrity", () => {
  const audit = baseAudit();
  audit.events.splice(4, 0, {
    at: 35,
    kind: "probe",
    actor: "harness",
    code: "isolation.breach",
    meta: { probeId: "p-iso-01", manifestDigest: "a".repeat(64), distance: "session", dimension: "isolation" },
  });
  assert.equal(validateChatRunAudit(audit).valid, true, JSON.stringify(validateChatRunAudit(audit).errors));

  // The breach is the only probe code that fails closed, and the detector keys on
  // `kind === "probe"`. If kind/code pairing were not enforced, re-kinding the
  // same code would validate as a harmless lifecycle row, the detector would not
  // fire, and the audit would exit 0 — a silent bypass of the one fail-closed
  // signal. The mismatch must therefore be a schema failure, not a lookup miss.
  for (const kind of ["lifecycle", "http", "sse", "provider", "presentation", "memory", "recovery"]) {
    const misKinded = baseAudit();
    misKinded.events.splice(4, 0, {
      at: 35,
      kind,
      actor: "harness",
      code: "isolation.breach",
      meta: { probeId: "p-iso-01", manifestDigest: "a".repeat(64), distance: "session", dimension: "isolation" },
    });
    const result = validateChatRunAudit(misKinded);
    assert.equal(result.valid, false, `kind=${kind} must not be able to carry isolation.breach`);
    assert.ok(
      result.errors.some((error) => error.reason === "code_kind_mismatch"),
      `kind=${kind}: ${JSON.stringify(result.errors)}`,
    );
    // Validation is the gate the audit CLI applies before any analysis, so the
    // mis-kinded row is rejected as malformed (exit 2) and the detector is never
    // reached. What matters is that no consumer can read it as a clean run.
    assert.notEqual(result.valid, true);
  }

  // A code shared across kinds stays legal in each of its own kinds.
  for (const kind of ["provider", "presentation", "probe"]) {
    const shared = baseAudit();
    shared.events.splice(4, 0, { at: 35, kind, actor: "harness", code: "observability_gap", ...(kind === "probe" ? { meta: { probeId: "p-01", manifestDigest: "a".repeat(64) } } : {}) });
    assert.equal(validateChatRunAudit(shared).valid, true, `${kind}.observability_gap must stay valid`);
  }
});

test("the probe meta keys are the only new keys, and a ninth key still fails closed", () => {
  const audit = baseAudit();
  audit.events.splice(4, 0, {
    at: 35,
    kind: "probe",
    actor: "harness",
    code: "needle.hit",
    meta: { probeId: "p-turn-01", manifestDigest: "a".repeat(64), distance: "turn", dimension: "retention" },
  });
  assert.equal(validateChatRunAudit(audit).valid, true, JSON.stringify(validateChatRunAudit(audit).errors));
  // A trace may not smuggle probe material: `needle`, `requiredKeywords` and
  // friends are not meta keys and are therefore not expressible.
  for (const key of ["needle", "requiredKeywords", "forbiddenKeywords", "probePrompt", "reply"]) {
    const leaky = baseAudit();
    leaky.events.splice(4, 0, {
      at: 35,
      kind: "probe",
      actor: "harness",
      code: "needle.hit",
      meta: { probeId: "p-turn-01", manifestDigest: "a".repeat(64), [key]: "text" },
    });
    const errors = validateChatRunAudit(leaky).errors;
    assert.ok(
      errors.some((error) => error.reason === "meta_key_disallowed" && error.path === `events[4].meta.${key}`),
      `${key} must be refused: ${JSON.stringify(errors)}`,
    );
  }
});

test("summarizeChatRunAudit reports each probe outcome as its own count, with no combined score", async () => {
  const summary = summarizeChatRunAudit(await fixture("probe-reported-only.json"));
  assert.equal(summary.probe.total, 5);
  assert.equal(summary.probe.needleMisses, 1);
  assert.equal(summary.probe.distractorConfused, 1);
  assert.equal(summary.probe.supersedeFail, 1);
  assert.equal(summary.probe.isolationClean, 1);
  assert.equal(summary.probe.observabilityGap, 1);
  assert.equal(summary.probe.needleHits, 0);
  assert.equal(summary.probe.isolationBreach, 0);
  // Three probe events share the distance `turn`, one `session`, one `fold`.
  assert.deepEqual(summary.probe.countsByDistance, { turn: 3, session: 1, fold: 1 });
  assert.deepEqual(summary.probe.countsByDimension, {
    retention: 2,
    discrimination: 1,
    supersession: 1,
    isolation: 1,
  });
  assert.deepEqual(summary.probe.manifestDigests, ["3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b"]);
  // No synthesized memory score exists in the summary at all.
  assert.equal(Object.hasOwn(summary.probe, "score"), false);
  assert.equal(Object.hasOwn(summary.probe, "rate"), false);
});

test("validateChatRunAudit rejects a non-object and an array", () => {
  assert.deepEqual(reasonsFor(null), ["audit_not_object"]);
  assert.deepEqual(reasonsFor([]), ["audit_not_object"]);
  assert.deepEqual(reasonsFor("trace"), ["audit_not_object"]);
});

test("validateChatRunAudit rejects a bad schema id with the observed value in the detail", () => {
  const result = validateChatRunAudit(baseAudit({ schema: "chat_run_audit/v2" }));
  assert.equal(result.valid, false);
  const error = result.errors.find((entry) => entry.reason === "schema_id_invalid");
  assert.ok(error);
  assert.equal(error.path, "schema");
  assert.match(error.detail, /chat_run_audit\/v2/);
});

test("validateChatRunAudit rejects bad runIds", () => {
  for (const runId of [undefined, "", "has space", "x".repeat(161), 42]) {
    const errors = validateChatRunAudit(baseAudit({ runId })).errors;
    assert.ok(
      errors.some((error) => error.reason === "run_id_invalid"),
      `runId ${JSON.stringify(runId)} should be rejected: ${JSON.stringify(errors)}`,
    );
  }
});

test("validateChatRunAudit rejects a bad timestamp, surface, originMs, artifact and provider", () => {
  assert.ok(reasonsFor(baseAudit({ startedAt: "2026-01-01 00:00:00" })).includes("timestamp_invalid"));
  assert.ok(reasonsFor(baseAudit({ surface: "chat+game" })).includes("surface_invalid"));
  assert.ok(reasonsFor(baseAudit({ originMs: -1 })).includes("origin_ms_invalid"));
  assert.ok(reasonsFor(baseAudit({ originMs: 1.5 })).includes("origin_ms_invalid"));
  assert.ok(reasonsFor(baseAudit({ artifact: "gen" })).includes("artifact_invalid"));
  assert.ok(reasonsFor(baseAudit({ artifact: { inventoryDigest: "not-a-digest" } })).includes("artifact_invalid"));
  assert.ok(reasonsFor(baseAudit({ provider: { embedded: "yes" } })).includes("provider_invalid"));
  assert.ok(reasonsFor(baseAudit({ provider: { vendor: "x" } })).includes("unknown_field"));
});

test("validateChatRunAudit rejects unknown top-level, artifact, provider and event fields", () => {
  assert.deepEqual(reasonsFor(baseAudit({ transcript: "leaked" })), ["unknown_field"]);
  const event = baseAudit();
  event.events.push({ at: 80, kind: "sse", actor: "host", code: "frame.received", text: "message body" });
  const errors = validateChatRunAudit(event).errors;
  assert.ok(errors.some((error) => error.path === "events[8].text" && error.reason === "unknown_field"));
});

test("validateChatRunAudit rejects non-monotonic `at` and names both values", () => {
  const audit = baseAudit();
  audit.events[3] = { at: 5, kind: "provider", actor: "host", code: "request.sent" };
  const result = validateChatRunAudit(audit);
  const error = result.errors.find((entry) => entry.reason === "at_not_monotonic");
  assert.ok(error);
  assert.equal(error.path, "events[3].at");
  assert.match(error.detail, /5 is below the previous event at 20/);
});

test("validateChatRunAudit rejects a non-integer `at`", () => {
  const audit = baseAudit();
  audit.events[1] = { at: 1.5, kind: "lifecycle", actor: "harness", code: "turn.submitted" };
  assert.ok(reasonsFor(audit).includes("at_invalid"));
});

test("validateChatRunAudit rejects a disallowed meta key", () => {
  const audit = baseAudit();
  audit.events[2] = { at: 20, kind: "http", actor: "harness", code: "state.read", meta: { text: "prompt leak" } };
  const errors = validateChatRunAudit(audit).errors;
  assert.ok(errors.some((error) => error.reason === "meta_key_disallowed" && error.path === "events[2].meta.text"));
});

test("validateChatRunAudit accepts exactly the frozen meta keys", () => {
  const audit = baseAudit();
  audit.events[2] = {
    at: 20,
    kind: "http",
    actor: "harness",
    code: "state.read",
    meta: {
      state: "running",
      reason: "r",
      problemCode: "p",
      disposition: "d",
      status: "s",
      count: 1,
      cursor: "c",
      generation: 2,
    },
  };
  assert.equal(validateChatRunAudit(audit).valid, true, JSON.stringify(validateChatRunAudit(audit).errors));
  assert.equal(CHAT_RUN_AUDIT_META_KEYS.length, 13);
  assert.ok(CHAT_RUN_AUDIT_META_KEYS.includes("providerObservability"));
  for (const key of ["probeId", "distance", "dimension", "manifestDigest"]) {
    assert.ok(CHAT_RUN_AUDIT_META_KEYS.includes(key), `${key} must be in the frozen allow-list`);
  }
});

test("validateChatRunAudit rejects more than 8 meta keys", () => {
  // A probe event carries 4 of its own keys, so the 8-key bound still leaves room
  // for the probe result's whole context; a ninth key fails closed regardless.
  const audit = baseAudit();
  audit.events[2] = {
    at: 20,
    kind: "http",
    actor: "harness",
    code: "state.read",
    meta: {
      state: "running",
      reason: "r",
      problemCode: "p",
      disposition: "d",
      status: "s",
      count: 1,
      cursor: "c",
      generation: 2,
      providerObservability: "observed",
    },
  };
  const errors = validateChatRunAudit(audit).errors;
  assert.ok(
    errors.some((error) => error.reason === "meta_too_many_keys" && error.detail === "9 keys exceeds the bound of 8"),
  );
});

test("validateChatRunAudit rejects an over-long and a multiline meta value", () => {
  const long = baseAudit();
  long.events[2] = { at: 20, kind: "http", actor: "harness", code: "state.read", meta: { reason: "x".repeat(161) } };
  assert.ok(reasonsFor(long).includes("meta_value_too_long"));

  const multiline = baseAudit();
  multiline.events[2] = { at: 20, kind: "http", actor: "harness", code: "state.read", meta: { reason: "a\nb" } };
  assert.ok(reasonsFor(multiline).includes("meta_value_multiline"));
});

test("validateChatRunAudit rejects a non-scalar meta value", () => {
  const audit = baseAudit();
  audit.events[2] = {
    at: 20,
    kind: "http",
    actor: "harness",
    code: "state.read",
    meta: { state: "running", payload: { body: "content" } },
  };
  const errors = validateChatRunAudit(audit).errors;
  assert.ok(errors.some((error) => error.reason === "meta_key_disallowed"));
  const shaped = baseAudit();
  shaped.events[2] = { at: 20, kind: "http", actor: "harness", code: "state.read", meta: { state: ["running"] } };
  assert.ok(reasonsFor(shaped).includes("meta_value_invalid"));
  const nested = baseAudit();
  nested.events[2] = { at: 20, kind: "http", actor: "harness", code: "state.read", meta: { count: Number.NaN } };
  assert.ok(reasonsFor(nested).includes("meta_value_invalid"));
});

test("validateChatRunAudit rejects a bad code format and reports the pattern reason", () => {
  const audit = baseAudit();
  audit.events[2] = { at: 20, kind: "http", actor: "harness", code: "Bad Code!" };
  const errors = validateChatRunAudit(audit).errors;
  const error = errors.find((entry) => entry.reason === "code_format_invalid");
  assert.ok(error);
  assert.equal(error.detail, "code must match ^[a-z0-9_.:-]{1,160}$");

  const longCode = baseAudit();
  longCode.events[2] = { at: 20, kind: "http", actor: "harness", code: "a".repeat(161) };
  assert.ok(reasonsFor(longCode).includes("code_format_invalid"));
});

test("validateChatRunAudit rejects an unknown code and an unknown kind", () => {
  const unknownCode = baseAudit();
  unknownCode.events[2] = { at: 20, kind: "http", actor: "harness", code: "state.polled" };
  const codeErrors = validateChatRunAudit(unknownCode).errors;
  assert.ok(codeErrors.some((error) => error.reason === "code_unknown" && /state\.polled/.test(error.detail)));

  const unknownKind = baseAudit();
  unknownKind.events[2] = { at: 20, kind: "telemetry", actor: "harness", code: "state.read" };
  const kindErrors = validateChatRunAudit(unknownKind).errors;
  assert.ok(kindErrors.some((error) => error.reason === "kind_unknown" && /lifecycle, http, sse/.test(error.detail)));
});

test("validateChatRunAudit rejects an unknown actor", () => {
  assert.ok(
    reasonsFor(baseAudit({ events: [{ at: 0, kind: "lifecycle", actor: "robot", code: "run.started" }] })).includes(
      "actor_invalid",
    ),
  );
});

test("validateChatRunAudit requires turn.terminal to name a terminal state", () => {
  const missing = baseAudit();
  missing.events[6] = { at: 60, kind: "lifecycle", actor: "harness", code: "turn.terminal" };
  assert.ok(reasonsFor(missing).includes("turn_terminal_state_invalid"));

  const nonTerminal = baseAudit();
  nonTerminal.events[6] = {
    at: 60,
    kind: "lifecycle",
    actor: "harness",
    code: "turn.terminal",
    meta: { state: "running" },
  };
  assert.ok(reasonsFor(nonTerminal).includes("turn_terminal_state_invalid"));
});

test("validateChatRunAudit requires run.finished to self-report providerObservability", () => {
  const audit = baseAudit();
  audit.events[7] = { at: 70, kind: "lifecycle", actor: "harness", code: "run.finished" };
  const error = validateChatRunAudit(audit).errors.find((entry) => entry.reason === "provider_observability_missing");
  assert.ok(error);
  assert.equal(error.path, "events[7].meta.providerObservability");
});

test("validateChatRunAudit fails closed when the trace has no events or no run.finished", () => {
  assert.ok(reasonsFor(baseAudit({ events: [] })).includes("events_empty"));
  assert.ok(reasonsFor(baseAudit({ events: "not an array" })).includes("events_not_array"));
  const audit = baseAudit();
  audit.events = audit.events.slice(0, 7);
  assert.ok(reasonsFor(audit).includes("run_finished_missing"));
});

test("validateChatRunAudit reports every offense of the malformed fixture, never a generic failure", async () => {
  const result = validateChatRunAudit(await fixture("malformed.json"));
  assert.equal(result.valid, false);
  const reasons = new Set(result.errors.map((error) => error.reason));
  for (const expected of [
    "unknown_field",
    "at_not_monotonic",
    "code_unknown",
    "kind_unknown",
    "meta_key_disallowed",
    "meta_too_many_keys",
    "meta_value_invalid",
    "run_finished_missing",
  ]) {
    assert.ok(reasons.has(expected), `expected ${expected} in ${[...reasons].join(", ")}`);
  }
});

// ============================================================================
// Summary
// ============================================================================

test("summarizeChatRunAudit counts by kind and code and reports the run facts", async () => {
  const summary = summarizeChatRunAudit(await fixture("clean-success.json"));
  assert.equal(summary.runId, "run-clean-0001");
  assert.equal(summary.turnCount, 2);
  assert.equal(summary.terminalState, "completed");
  assert.equal(summary.countsByCode["turn.submitted"], 2);
  assert.equal(summary.countsByCode["frame.received"], 5);
  assert.equal(summary.countsByKind.sse, 5);
  assert.equal(summary.provider.requestSent, 2);
  assert.equal(summary.provider.settled, 2);
  assert.equal(summary.provider.observability, "observed");
  assert.equal(summary.presentation.committed, 2);
  assert.equal(summary.presentation.committedTurns, 2);
  assert.equal(summary.cancellation.durableCancelledTurns, 0);
  assert.equal(summary.recovery.reloadStarted, 0);
  assert.equal(summary.totalEvents, 27);
  assert.equal(summary.lastEventAtMs, 230);
});

test("summarizeChatRunAudit is positional across turns and does not fold post-terminal events into the next turn", async () => {
  const summary = summarizeChatRunAudit(await fixture("clean-success.json"));
  assert.equal(summary.turns.length, 2);
  assert.equal(summary.turns[0].stateReads, 3);
  assert.equal(summary.turns[1].stateReads, 3);
  assert.equal(summary.turns[0].committed, 1);
  assert.equal(summary.turns[1].committed, 1);
});

test("summarizeChatRunAudit reports cancellation and recovery facts", async () => {
  const summary = summarizeChatRunAudit(await fixture("cancelled-clean.json"));
  assert.equal(summary.cancellation.requestedTurns, 1);
  assert.equal(summary.cancellation.durableCancelledTurns, 1);
  assert.equal(summary.cancellation.reloadSettledCancelled, 1);
  assert.equal(summary.recovery.reloadStarted, 1);
  assert.equal(summary.recovery.reloadSettled, 1);
  assert.equal(summary.recovery.reloadMismatch, 0);
  assert.equal(summary.terminalState, "cancelled");
});

// ============================================================================
// Detectors — clean fixture stays silent (no false positives)
// ============================================================================

test("analyzeChatRunAudit raises no finding and reports integrity passed on the clean fixture", async () => {
  const analysis = analyzeChatRunAudit(await fixture("clean-success.json"));
  assert.deepEqual(analysis.findings, []);
  assert.equal(analysis.integrity.passed, true);
  assert.deepEqual(analysis.integrity.failures, []);
  assert.deepEqual(analysis.reasons, {});
});

test("analyzeChatRunAudit stays silent on the cancelled-clean fixture", async () => {
  const analysis = analyzeChatRunAudit(await fixture("cancelled-clean.json"));
  assert.deepEqual(analysis.findings, []);
  assert.equal(analysis.integrity.passed, true);
});

test("analyzeChatRunAudit treats a provider observability gap as reported, not as a failure", async () => {
  const analysis = analyzeChatRunAudit(await fixture("provider-unobserved.json"));
  assert.equal(analysis.integrity.passed, true);
  assert.equal(analysis.integrity.providerObservability, "unobserved");
  assert.equal(analysis.waste.providerObservabilityGap, 1);
  assert.deepEqual(analysis.findings, []);
  assert.deepEqual(analysis.reasons, { "provider.observability_gap": 1 });
});

// ============================================================================
// Detectors — each fixture fires its own finding
// ============================================================================

/** @param {any} analysis @param {string} id */
function findingById(analysis, id) {
  return analysis.findings.find((entry) => entry.id === id);
}

test("flags hollow_success when a turn completes with no presentation commit", async () => {
  const analysis = analyzeChatRunAudit(await fixture("hollow-success.json"));
  const finding = findingById(analysis, "hollow_success");
  assert.ok(finding, JSON.stringify(analysis.findings));
  assert.equal(finding.component, "presentation_admission");
  assert.equal(finding.severity, "high");
  assert.equal(finding.count, 1);
  assert.deepEqual(finding.turnIndexes, [1]);
  assert.match(finding.detail, /terminal `completed` with zero presentation\.committed/);
  assert.match(finding.recommendation, /presentation/);
  assert.equal(analysis.integrity.passed, false);
  assert.deepEqual(
    analysis.integrity.failures.map((entry) => entry.id),
    ["hollow_success"],
  );
});

test("flags hollow_failure when a failed terminal carries no recoverable problemCode", async () => {
  const analysis = analyzeChatRunAudit(await fixture("hollow-failure.json"));
  const finding = findingById(analysis, "hollow_failure");
  assert.ok(finding, JSON.stringify(analysis.findings));
  assert.equal(finding.component, "persistence_recovery");
  assert.equal(finding.count, 1);
  assert.equal(analysis.integrity.passed, false);
});

test("a durable failed terminal with provider.error is attributable and never reported hollow", async () => {
  // The owner ruling keeps the failed terminal out of the live lane (a live run
  // must not be made to fake a provider outage) and puts its judgement here, in
  // the deterministic fixture suite. This fixture is the attributed-failure
  // branch: a provider.error carrying the problemCode, plus a failed terminal.
  const analysis = analyzeChatRunAudit(await fixture("provider-error-attributable.json"));
  assert.equal(findingById(analysis, "hollow_failure"), undefined, JSON.stringify(analysis.findings));
  assert.equal(findingById(analysis, "hollow_success"), undefined);
  assert.equal(analysis.integrity.passed, true, JSON.stringify(analysis.findings));

  const summary = summarizeChatRunAudit(
    JSON.parse(await readFile(fixturePath("provider-error-attributable.json"), "utf8")),
  );
  assert.equal(summary.provider.requestSent, 1);
  assert.equal(summary.provider.errored, 1);
  assert.equal(summary.provider.settled, 0);
  assert.equal(summary.provider.observability, "observed");
});

test("a provider.error with no recoverable problemCode is a hollow failure", () => {
  // The negative half of the same branch: an error event is not itself the
  // attribution. If the terminal cannot recover a cause, the failure stays
  // unactionable and the audit must fail closed even though provider.error is
  // present in the turn.
  const audit = baseAudit();
  audit.events = [
    { at: 0, kind: "lifecycle", actor: "harness", code: "run.started" },
    { at: 10, kind: "lifecycle", actor: "harness", code: "turn.submitted" },
    { at: 20, kind: "provider", actor: "host", code: "request.sent" },
    { at: 30, kind: "provider", actor: "host", code: "error" },
    { at: 40, kind: "lifecycle", actor: "harness", code: "turn.terminal", meta: { state: "failed" } },
    { at: 50, kind: "lifecycle", actor: "harness", code: "run.finished", meta: { providerObservability: "observed" } },
  ];
  const analysis = analyzeChatRunAudit(audit);
  assert.ok(findingById(analysis, "hollow_failure"), JSON.stringify(analysis.findings));
  assert.equal(analysis.integrity.passed, false);
});

test("does not flag hollow_failure when the failure carries a problemCode", () => {
  const audit = baseAudit();
  audit.events[6] = {
    at: 60,
    kind: "lifecycle",
    actor: "harness",
    code: "turn.terminal",
    meta: { state: "failed", problemCode: "runtime_unavailable" },
  };
  const analysis = analyzeChatRunAudit(audit);
  assert.equal(findingById(analysis, "hollow_failure"), undefined);
  assert.equal(findingById(analysis, "hollow_success"), undefined);
  assert.equal(analysis.integrity.passed, true);
});

test("hollow_failure is per turn: another turn's problemCode does not excuse it", () => {
  // Turn 1 fails with a cause, turn 2 fails with none. A run-level "does any
  // event carry a problemCode?" check would call this clean.
  const audit = baseAudit();
  audit.events = [
    { at: 0, kind: "lifecycle", actor: "harness", code: "run.started" },
    { at: 10, kind: "lifecycle", actor: "harness", code: "turn.submitted" },
    { at: 20, kind: "provider", actor: "host", code: "error", meta: { problemCode: "runtime_unavailable" } },
    { at: 30, kind: "lifecycle", actor: "harness", code: "turn.terminal", meta: { state: "failed" } },
    { at: 40, kind: "lifecycle", actor: "harness", code: "turn.submitted" },
    { at: 50, kind: "lifecycle", actor: "harness", code: "turn.terminal", meta: { state: "failed" } },
    { at: 60, kind: "lifecycle", actor: "harness", code: "run.finished", meta: { providerObservability: "observed" } },
  ];
  const finding = findingById(analyzeChatRunAudit(audit), "hollow_failure");
  assert.ok(finding, "turn 2 had no cause and must be reported");
  assert.deepEqual(finding.turnIndexes, [2]);
  assert.equal(finding.count, 1);
});

test("flags unobserved_cancellation when a cancel is never read back as a durable terminal", async () => {
  const analysis = analyzeChatRunAudit(await fixture("unobserved-cancellation.json"));
  const finding = findingById(analysis, "unobserved_cancellation");
  assert.ok(finding, JSON.stringify(analysis.findings));
  assert.equal(finding.component, "cancellation");
  assert.equal(finding.count, 1);
  assert.match(finding.detail, /stopping/);
  assert.equal(analysis.integrity.passed, false);
});

test("flags idle_stall with the measured frame-free span", async () => {
  const analysis = analyzeChatRunAudit(await fixture("idle-stall.json"));
  const finding = findingById(analysis, "idle_stall");
  assert.ok(finding, JSON.stringify(analysis.findings));
  assert.equal(finding.component, "observability_gap");
  assert.equal(finding.measuredMs, 94950);
  assert.equal(finding.thresholdMs, IDLE_STALL_THRESHOLD_MS);
  assert.match(finding.detail, /94950 ms/);
  // An idle stall is waste, not an integrity failure: the run still completed.
  assert.equal(analysis.integrity.passed, true);
});

test("flags micro_stepping above the per-turn /state read bound", async () => {
  const analysis = analyzeChatRunAudit(await fixture("micro-stepping.json"));
  const finding = findingById(analysis, "micro_stepping");
  assert.ok(finding, JSON.stringify(analysis.findings));
  assert.equal(finding.component, "observability_gap");
  assert.equal(finding.bound, MAX_STATE_READS_PER_TURN);
  assert.equal(finding.maxStateReads, 20);
  assert.match(finding.detail, /exceeded the 12 \/state reads per turn bound/);
});

test("does not flag micro_stepping at exactly the bound", () => {
  const audit = baseAudit();
  const events = [audit.events[0], audit.events[1]];
  for (let index = 0; index < MAX_STATE_READS_PER_TURN; index += 1) {
    events.push({ at: 15 + index, kind: "http", actor: "harness", code: "state.read", meta: { state: "running" } });
  }
  events.push({ at: 40, kind: "provider", actor: "host", code: "request.sent" });
  events.push({ at: 45, kind: "sse", actor: "host", code: "frame.received" });
  events.push({ at: 50, kind: "presentation", actor: "host", code: "committed" });
  events.push({ at: 60, kind: "lifecycle", actor: "harness", code: "turn.terminal", meta: { state: "completed" } });
  events.push({
    at: 70,
    kind: "lifecycle",
    actor: "harness",
    code: "run.finished",
    meta: { providerObservability: "observed" },
  });
  audit.events = events;
  const analysis = analyzeChatRunAudit(audit);
  assert.equal(findingById(analysis, "micro_stepping"), undefined);
  assert.equal(analysis.waste.maxStateReadsPerTurn, MAX_STATE_READS_PER_TURN);
});

test("flags stream_gap_churn and counts the forced resynchronizations", async () => {
  const analysis = analyzeChatRunAudit(await fixture("stream-gap-churn.json"));
  const finding = findingById(analysis, "stream_gap_churn");
  assert.ok(finding, JSON.stringify(analysis.findings));
  assert.equal(finding.count, 3);
  assert.equal(finding.severity, "high");
  assert.deepEqual(finding.sampleReasons.sort(), ["epoch_changed", "gap"]);
  assert.equal(analysis.waste.streamResyncs, 3);
});

test("flags recovery_mismatch as an integrity failure", async () => {
  const analysis = analyzeChatRunAudit(await fixture("recovery-mismatch.json"));
  const finding = findingById(analysis, "recovery_mismatch");
  assert.ok(finding, JSON.stringify(analysis.findings));
  assert.equal(finding.component, "persistence_recovery");
  assert.equal(analysis.integrity.passed, false);
  assert.equal(analysis.waste.reloadMismatches, 1);
});

test("flags isolation_breach as the only fail-closed probe outcome", async () => {
  const analysis = analyzeChatRunAudit(await fixture("probe-isolation-breach.json"));
  const finding = findingById(analysis, "isolation_breach");
  assert.ok(finding, JSON.stringify(analysis.findings));
  assert.equal(finding.component, "memory_isolation");
  assert.equal(finding.severity, "high");
  assert.equal(finding.count, 1);
  assert.deepEqual(finding.sampleProbeIds, ["p-iso-a"]);
  assert.deepEqual(finding.sampleDistances, ["session"]);
  assert.equal(analysis.integrity.passed, false);
  assert.deepEqual(
    analysis.integrity.failures.map((entry) => entry.id),
    ["isolation_breach"],
  );
  assert.equal(analysis.waste.probeIsolationBreaches, 1);
});

test("a reported-only probe run is never an integrity failure", async () => {
  // needle.miss / distractor.confused / supersede.fail / isolation.clean /
  // probe.observability_gap are measurements (probe design §6.1): they must show
  // up in the summary and in the comparison, and must never move the exit code.
  const analysis = analyzeChatRunAudit(await fixture("probe-reported-only.json"));
  assert.deepEqual(analysis.findings, []);
  assert.equal(analysis.integrity.passed, true);
  assert.equal(analysis.waste.probeEvents, 5);
  assert.equal(analysis.waste.probeIsolationBreaches, 0);
  // They are not friction either: the friction histogram stays empty.
  assert.deepEqual(analysis.reasons, {});
});

test("the report shows probe results per dimension and distance with no combined score", async () => {
  const report = buildChatRunAuditReport({ audit: await fixture("probe-reported-only.json") });
  const text = formatChatRunAuditReportText(report);
  assert.match(text, /- Memory probe: 5 event\(s\) against manifest /);
  assert.match(text, /retention hit\/miss 0\/1/);
  assert.match(text, /distractor clean\/confused 0\/1/);
  assert.match(text, /supersede pass\/fail 0\/1/);
  assert.match(text, /isolation clean\/breach 1\/0/);
  assert.match(text, /observability gaps 1/);
  assert.match(text, /distances turn=3, fold=1, session=1/);
  assert.doesNotMatch(text, /memory score|naturalness score|weighted/i);

  const clean = formatChatRunAuditReportText(buildChatRunAuditReport({ audit: await fixture("clean-success.json") }));
  assert.match(clean, /- Memory probe: no probe event in this run/);
});

test("flags memory_conflict_storm on repeated Memory CAS conflicts", async () => {
  const analysis = analyzeChatRunAudit(await fixture("memory-conflict-storm.json"));
  const finding = findingById(analysis, "memory_conflict_storm");
  assert.ok(finding, JSON.stringify(analysis.findings));
  assert.equal(finding.component, "memory_isolation");
  assert.equal(finding.count, 5);
  // The same conflicts are also contention: a mutation raced an unsettled state.
  assert.ok(findingById(analysis, "settlement_contention"));
  assert.equal(analysis.integrity.passed, true);
});

test("stays silent on memory_conflict_storm below the repeat threshold", () => {
  const audit = baseAudit();
  audit.events.splice(2, 0, {
    at: 12,
    kind: "memory",
    actor: "host",
    code: "conflict",
    meta: { reason: "revision_advanced" },
  });
  const analysis = analyzeChatRunAudit(audit);
  assert.equal(findingById(analysis, "memory_conflict_storm"), undefined);
  assert.equal(findingById(analysis, "settlement_contention"), undefined);
});

test("flags provider_boundary_unsettled only when a sent request never reached a terminal", async () => {
  const analysis = analyzeChatRunAudit(await fixture("provider-boundary-unsettled.json"));
  const finding = findingById(analysis, "provider_boundary_unsettled");
  assert.ok(finding, JSON.stringify(analysis.findings));
  assert.equal(finding.component, "provider_boundary");
  assert.equal(analysis.integrity.passed, false);
});

test("does not flag provider_boundary_unsettled when no request was observed", () => {
  // §3.2 rule 3: both conditions are required. A stream-only turn with no
  // provider evidence must not be reported as an unsettled provider round trip.
  const audit = baseAudit();
  audit.events = [
    { at: 0, kind: "lifecycle", actor: "harness", code: "run.started" },
    { at: 10, kind: "lifecycle", actor: "harness", code: "turn.submitted" },
    { at: 20, kind: "http", actor: "harness", code: "state.read", meta: { state: "running" } },
    { at: 30, kind: "sse", actor: "host", code: "frame.received" },
    {
      at: 40,
      kind: "lifecycle",
      actor: "harness",
      code: "run.finished",
      meta: { providerObservability: "unobserved" },
    },
  ];
  const analysis = analyzeChatRunAudit(audit);
  assert.equal(findingById(analysis, "provider_boundary_unsettled"), undefined);
});

test("flags feedback_starvation on repeated opaque state conflicts", async () => {
  const analysis = analyzeChatRunAudit(await fixture("feedback-starvation.json"));
  const finding = findingById(analysis, "feedback_starvation");
  assert.ok(finding, JSON.stringify(analysis.findings));
  assert.equal(finding.count, 3);
  assert.deepEqual(finding.sampleReasons, ["stream_resync_required"]);
  assert.equal(analysis.reasons["http.state.conflict"], 3);
});

test("flags settlement_contention when a busy conflict lands inside an open turn", async () => {
  const analysis = analyzeChatRunAudit(await fixture("settlement-contention.json"));
  const finding = findingById(analysis, "settlement_contention");
  assert.ok(finding, JSON.stringify(analysis.findings));
  assert.equal(finding.component, "persistence_recovery");
  assert.equal(finding.count, 1);
});

test("every finding carries a bounded component and a recommendation naming a layer", async () => {
  const fixtures = await Promise.all(
    [
      "hollow-success.json",
      "hollow-failure.json",
      "idle-stall.json",
      "unobserved-cancellation.json",
      "micro-stepping.json",
      "stream-gap-churn.json",
      "recovery-mismatch.json",
      "memory-conflict-storm.json",
      "provider-boundary-unsettled.json",
      "feedback-starvation.json",
      "settlement-contention.json",
      "invalid-stream-frame.json",
      "probe-isolation-breach.json",
    ].map(fixture),
  );
  const seen = new Set();
  for (const audit of fixtures) {
    for (const finding of analyzeChatRunAudit(audit).findings) {
      seen.add(finding.id);
      assert.ok(FINDING_COMPONENTS.includes(finding.component), `${finding.id} component ${finding.component}`);
      assert.ok(["high", "medium"].includes(finding.severity), `${finding.id} severity`);
      assert.ok(Number.isInteger(finding.count) && finding.count > 0, `${finding.id} count`);
      assert.ok(
        typeof finding.recommendation === "string" && finding.recommendation.length > 0,
        `${finding.id} recommendation`,
      );
      assert.ok(typeof finding.seam === "string" && finding.seam.length > 0, `${finding.id} seam`);
      assert.ok(typeof finding.gate === "string" && finding.gate.length > 0, `${finding.id} gate`);
      assert.ok(
        typeof finding.metricTarget === "string" && /->/.test(finding.metricTarget),
        `${finding.id} metricTarget`,
      );
    }
  }
  for (const expected of [
    "hollow_success",
    "hollow_failure",
    "idle_stall",
    "unobserved_cancellation",
    "micro_stepping",
    "stream_gap_churn",
    "recovery_mismatch",
    "memory_conflict_storm",
    "provider_boundary_unsettled",
    "feedback_starvation",
    "settlement_contention",
    "invalid_stream_frame",
    "state_conflict",
    "isolation_breach",
  ]) {
    assert.ok(seen.has(expected), `${expected} never fired on any fixture`);
  }
  assert.equal(seen.size, 14, "no detector fired that has no fixture");
});

test("findings are sorted with high severity first", async () => {
  const analysis = analyzeChatRunAudit(await fixture("memory-conflict-storm.json"));
  const severities = analysis.findings.map((entry) => entry.severity);
  assert.equal(severities.indexOf("medium"), severities.length - 1);
  assert.ok(
    severities.slice(0, -1).every((entry) => entry === "high"),
    severities.join(","),
  );
});

// ============================================================================
// Report
// ============================================================================

test("buildChatRunAuditReport mirrors the auditing-runs Phase 7 sections", async () => {
  const report = buildChatRunAuditReport({
    audit: await fixture("hollow-success.json"),
    artifact: "hollow-success.json",
  });
  assert.equal(report.verdict, "integrity_failed");
  assert.equal(report.topology.kind, "single_run");
  assert.equal(report.artifact.label, "hollow-success.json");
  assert.equal(report.artifact.generation, "gen-hollow-success-0001");
  assert.ok(report.findings.length > 0);
  assert.ok(report.observedAnomaly.length > 0);
});

test("formatChatRunAuditReportText emits every Phase 7 section and the seam table", async () => {
  const report = buildChatRunAuditReport({
    audit: await fixture("hollow-success.json"),
    artifact: "hollow-success.json",
  });
  const text = formatChatRunAuditReportText(report);
  for (const heading of [
    "## Execution Audit Summary",
    "## Resource & Waste Profile",
    "## Integrity & Boundary Assessment",
    "## Runtime Smells & Mechanism Analysis",
    "## Seam Attribution & Deterministic Gates",
  ]) {
    assert.ok(text.includes(heading), `missing ${heading}`);
  }
  assert.match(text, /INTEGRITY FAILED/);
  assert.match(text, /\| `host\/src\/tavern\/chat-pipeline-service\.ts/);
  assert.match(text, /baseline 1 -> 0/);
});

test("formatChatRunAuditReportText renders a clean run without a seam table", async () => {
  const report = buildChatRunAuditReport({ audit: await fixture("clean-success.json") });
  const text = formatChatRunAuditReportText(report);
  assert.match(text, /passed \(no integrity failure\)/);
  assert.match(text, /- none: every detector stayed silent on this trace/);
  assert.ok(!text.includes("| :--- |"), "a clean run must not print an empty seam table");
});

// ============================================================================
// Vocabulary guard
// ============================================================================

test("the frozen vocabulary matches §3.1 exactly, with only the documented kind collision", () => {
  const all = Object.values(CHAT_RUN_AUDIT_CODES_BY_KIND).flat();
  for (const code of all) assert.match(code, /^[a-z0-9_.:-]{1,160}$/);
  assert.equal(all.length, 33);
  assert.deepEqual([...CHAT_RUN_AUDIT_KINDS], Object.keys(CHAT_RUN_AUDIT_CODES_BY_KIND));
  assert.equal(countCodeEntries(CHAT_RUN_AUDIT_CODES_BY_KIND, "probe"), 9);
  // §3.1 deliberately reuses the bare code `observability_gap` under `provider`,
  // `presentation` and `probe`: they are the same concept (a fact the observer
  // could not observe) applied to three evidence sources. Every consumer must
  // therefore match on `kind` as well as `code`; a bare-code filter would merge
  // them. This test pins that this is the ONLY collision.
  const colliding = new Set();
  const owner = new Map();
  for (const [kind, codes] of Object.entries(CHAT_RUN_AUDIT_CODES_BY_KIND))
    for (const code of codes) {
      if (owner.has(code)) colliding.add(code);
      else owner.set(code, kind);
    }
  assert.deepEqual([...colliding], ["observability_gap"]);
  assert.equal(new Set(all).size, all.length - 2, "only observability_gap is shared, by three kinds");
});

/** @param {typeof CHAT_RUN_AUDIT_CODES_BY_KIND} byKind @param {string} kind */
function countCodeEntries(byKind, kind) {
  return byKind[kind].length;
}
