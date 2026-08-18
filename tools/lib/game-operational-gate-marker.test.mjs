import assert from "node:assert/strict";
import test from "node:test";
import {
  GAME_OPERATIONAL_GATE_MARKER_SCHEMA,
  validateGameOperationalGateMarkerReport,
  verifyGameOperationalGateMarkerReport,
} from "./game-operational-gate-marker.mjs";

const nonce = "a".repeat(64);
const report = Object.freeze({
  schema: GAME_OPERATIONAL_GATE_MARKER_SCHEMA,
  sessionId: "pi_session_01",
  nonceSha256: nonce,
  surface: "game",
  m1MaxMemoryMutationId: 4,
  materializedCategoryCounts: Object.freeze({ SEMANTIC_MEMORY: 1, INTERACTION_EPISODE: 1 }),
});
const expected = Object.freeze({ sessionId: "pi_session_01", nonceSha256: nonce, surface: "game" });

test("Game Operational Gate marker accepts only its redacted aggregate schema", () => {
  assert.deepEqual(validateGameOperationalGateMarkerReport(report), {
    observed: true,
    sessionId: "pi_session_01",
    nonceSha256: nonce,
    surface: "game",
    m1MaxMemoryMutationId: 4,
    materializedCategoryCounts: { SEMANTIC_MEMORY: 1, INTERACTION_EPISODE: 1 },
  });
});

test("Game Operational Gate marker rejects content-bearing and unknown report fields", () => {
  for (const forbidden of [
    "content",
    "prompt",
    "provider",
    "providerRequest",
    "providerResponse",
    "path",
    "memoryId",
    "memoryIds",
    "unexpected",
  ]) {
    assert.deepEqual(validateGameOperationalGateMarkerReport({ ...report, [forbidden]: "forbidden" }), {
      observed: false,
      reasonCode: "marker_report_shape_invalid",
    });
  }
  assert.deepEqual(
    validateGameOperationalGateMarkerReport({ ...report, materializedCategoryCounts: { SEMANTIC_MEMORY: 1 } }),
    {
      observed: false,
      reasonCode: "marker_report_materialized_category_counts_invalid",
    },
  );
});

test("Game Operational Gate marker requires safe nonnegative watermark and exact category counts", () => {
  for (const candidate of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "4"]) {
    assert.equal(
      validateGameOperationalGateMarkerReport({ ...report, m1MaxMemoryMutationId: candidate }).reasonCode,
      "marker_report_m1_max_memory_mutation_id_invalid",
    );
  }
  for (const materializedCategoryCounts of [
    { SEMANTIC_MEMORY: 1, INTERACTION_EPISODE: 1, OTHER: 0 },
    { SEMANTIC_MEMORY: -1, INTERACTION_EPISODE: 1 },
    { SEMANTIC_MEMORY: 1, INTERACTION_EPISODE: 1.5 },
  ]) {
    assert.equal(
      validateGameOperationalGateMarkerReport({ ...report, materializedCategoryCounts }).reasonCode,
      "marker_report_materialized_category_counts_invalid",
    );
  }
});

test("Game Operational Gate marker binds nonce, session, and surface then consumes the report once", () => {
  const consumed = new Set();
  assert.deepEqual(verifyGameOperationalGateMarkerReport(report, expected, consumed), {
    observed: true,
    sessionId: "pi_session_01",
    nonceSha256: nonce,
    surface: "game",
    m1MaxMemoryMutationId: 4,
    materializedCategoryCounts: { SEMANTIC_MEMORY: 1, INTERACTION_EPISODE: 1 },
    oneShot: true,
  });
  assert.deepEqual(verifyGameOperationalGateMarkerReport(report, expected, consumed), {
    observed: false,
    reasonCode: "marker_report_replayed",
  });
  for (const expectation of [
    { ...expected, nonceSha256: "b".repeat(64) },
    { ...expected, sessionId: "other_session" },
    { ...expected, surface: "chat" },
  ]) {
    assert.deepEqual(verifyGameOperationalGateMarkerReport(report, expectation), {
      observed: false,
      reasonCode: "marker_binding_mismatch",
    });
  }
});
