import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";

import { P1T_EXIT_MATRIX, validateP1tExitMatrix } from "./stardew-p1t-exit-matrix.mjs";

const requiredIds = [
  "coverage-policy-v1-default-deny-family",
  "coverage-experimental-opt-in-host-surface",
  "coverage-legacy-v0-allowlist-fail-closed",
  "coverage-hello-and-fresh-snapshot-same-enabled-set",
  "coverage-immutable-same-surface-generation-fence",
  "coverage-target-world-ready-snapshot-publication-identity",
  "coverage-withdrawal-generation-revision-boundary",
  "coverage-host-mod-write-asymmetry",
  "coverage-host-tool-per-published-entry-and-readiness",
  "coverage-advertised-validator-dispatcher-route",
  "coverage-descriptor-contract-bidirectional-consistency",
  "coverage-portfolio-ordinary-surface-isolation",
  "coverage-historical-second-source-drift",
  "exit-graph-edge-characterization",
  "exit-fault-injection-projection-drift",
  "exit-current-difference-expected-verdict",
  "exit-independent-reviewer-projection-boundary",
  "exit-no-definition-composition-or-legacy-projection-removal",
];

function changed(mutator) {
  const copy = structuredClone(P1T_EXIT_MATRIX);
  mutator(copy);
  return copy;
}

test("P1T exit matrix is a complete static non-authoritative aggregation", async () => {
  const result = await validateP1tExitMatrix();
  assert.equal(result.authority, "none");
  assert.equal(result.liveClosure, "none");
  assert.deepEqual(
    result.rows.map((entry) => entry.id),
    requiredIds,
  );
  assert.equal(result.rows.filter((entry) => entry.status === "characterized-bounded-evidence").length, 14);
  assert.equal(result.rows.filter((entry) => entry.status === "explicitly-unimplemented-lifecycle").length, 1);
  assert.equal(result.rows.filter((entry) => entry.status === "not-claimed").length, 3);
  assert.equal(
    result.rows.some((entry) =>
      /actionId|move_to_tile|stardew_/i.test(JSON.stringify({ id: entry.id, nonclaim: entry.nonclaim })),
    ),
    false,
  );
});

test("P1T exit matrix rejects removed rows, changed statuses, and lifecycle reclassification", async () => {
  await assert.rejects(validateP1tExitMatrix(changed((matrix) => matrix.rows.pop())), /row_count_invalid/);
  await assert.rejects(
    validateP1tExitMatrix(
      changed((matrix) => {
        matrix.rows[0].status = "not-claimed";
      }),
    ),
    /status_reclassified/,
  );
  await assert.rejects(
    validateP1tExitMatrix(
      changed((matrix) => {
        matrix.rows.find((entry) => entry.id === "coverage-withdrawal-generation-revision-boundary").status =
          "not-claimed";
      }),
    ),
    /withdrawal_reclassified/,
  );
  await assert.rejects(
    validateP1tExitMatrix(
      changed((matrix) => {
        matrix.rows.find((entry) => entry.id === "coverage-immutable-same-surface-generation-fence").nonclaim =
          "generation fence";
      }),
    ),
    /immutable_fence_invalid/,
  );
});

test("P1T exit matrix rejects substituted, reordered, and unavailable bound evidence", async () => {
  await assert.rejects(
    validateP1tExitMatrix(
      changed((matrix) => {
        matrix.rows[0].evidence = ["missing-evidence.test.mjs"];
      }),
    ),
    /evidence_binding_invalid/,
  );
  await assert.rejects(
    validateP1tExitMatrix(
      changed((matrix) => {
        matrix.rows[1].evidence.reverse();
      }),
    ),
    /evidence_binding_invalid/,
  );
  await assert.rejects(
    validateP1tExitMatrix(P1T_EXIT_MATRIX, {
      pathExists: async () => {
        throw new Error("unavailable");
      },
    }),
    /evidence_missing:integrations\/stardew\/tests/,
  );
  await assert.doesNotReject(access("tools/stardew-p1t-exit-matrix.mjs"));
});

test("P1T exit matrix rejects evidence whose registered marker is absent", async () => {
  await assert.rejects(
    validateP1tExitMatrix(P1T_EXIT_MATRIX, { readEvidence: async () => "marker absent" }),
    /evidence_marker_invalid:integrations\/stardew\/tests/,
  );
});

test("P1T exit matrix rejects claim language", async () => {
  await assert.rejects(
    validateP1tExitMatrix(
      changed((matrix) => {
        matrix.rows[0].nonclaim = "P1T passed with action live behavior";
      }),
    ),
    /forbidden_claim/,
  );
});
