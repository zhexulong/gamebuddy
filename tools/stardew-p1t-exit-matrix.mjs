import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const STATUS = Object.freeze({
  CHARACTERIZED: "characterized-bounded-evidence",
  UNIMPLEMENTED: "explicitly-unimplemented-lifecycle",
  NOT_CLAIMED: "not-claimed",
});
const REQUIRED_ROW_STATUSES = Object.freeze({
  "coverage-policy-v1-default-deny-family": STATUS.CHARACTERIZED,
  "coverage-experimental-opt-in-host-surface": STATUS.CHARACTERIZED,
  "coverage-legacy-v0-allowlist-fail-closed": STATUS.CHARACTERIZED,
  "coverage-hello-and-fresh-snapshot-same-enabled-set": STATUS.CHARACTERIZED,
  "coverage-immutable-same-surface-generation-fence": STATUS.CHARACTERIZED,
  "coverage-target-world-ready-snapshot-publication-identity": STATUS.NOT_CLAIMED,
  "coverage-withdrawal-generation-revision-boundary": STATUS.UNIMPLEMENTED,
  "coverage-host-mod-write-asymmetry": STATUS.CHARACTERIZED,
  "coverage-host-tool-per-published-entry-and-readiness": STATUS.CHARACTERIZED,
  "coverage-advertised-validator-dispatcher-route": STATUS.CHARACTERIZED,
  "coverage-descriptor-contract-bidirectional-consistency": STATUS.CHARACTERIZED,
  "coverage-portfolio-ordinary-surface-isolation": STATUS.CHARACTERIZED,
  "coverage-historical-second-source-drift": STATUS.CHARACTERIZED,
  "exit-graph-edge-characterization": STATUS.CHARACTERIZED,
  "exit-fault-injection-projection-drift": STATUS.CHARACTERIZED,
  "exit-current-difference-expected-verdict": STATUS.CHARACTERIZED,
  "exit-independent-reviewer-projection-boundary": STATUS.NOT_CLAIMED,
  "exit-no-definition-composition-or-legacy-projection-removal": STATUS.NOT_CLAIMED,
});
const EVIDENCE = Object.freeze({
  policy: "integrations/stardew/tests/FarmhandActionCapabilityProjectionTests.cs",
  projection: "tools/check-stardew-action-promotion.test.mjs",
  host: "host/src/farmhand-action-projection-characterization.test.ts",
  historical: "tools/stardew-p1t-historical-projection-characterization.test.mjs",
  plan: "design/38_STARDEW_ACTION_DEVELOPMENT_PLATFORM_IMPLEMENTATION_PLAN.md",
});
const EVIDENCE_MARKERS = Object.freeze({
  [EVIDENCE.policy]: "VersionOneDefaultAdvertisementContainsEveryStableAction",
  [EVIDENCE.projection]: "promotion checker accepts the checked projection",
  [EVIDENCE.host]: "every PUBLISHED_STARDEW_ACTION has exact live-capability",
  [EVIDENCE.historical]: "P1T pinned Git characterization records only historical membership facts",
  [EVIDENCE.plan]: "## P1T — Farmhand Action Truth/Projection Characterization",
});
const REQUIRED_ROW_EVIDENCE = Object.freeze({
  "coverage-policy-v1-default-deny-family": [EVIDENCE.policy],
  "coverage-experimental-opt-in-host-surface": [EVIDENCE.policy, EVIDENCE.host],
  "coverage-legacy-v0-allowlist-fail-closed": [EVIDENCE.policy],
  "coverage-hello-and-fresh-snapshot-same-enabled-set": [EVIDENCE.policy],
  "coverage-immutable-same-surface-generation-fence": [EVIDENCE.policy],
  "coverage-target-world-ready-snapshot-publication-identity": [EVIDENCE.plan],
  "coverage-withdrawal-generation-revision-boundary": [EVIDENCE.policy, EVIDENCE.plan],
  "coverage-host-mod-write-asymmetry": [EVIDENCE.projection, EVIDENCE.host],
  "coverage-host-tool-per-published-entry-and-readiness": [EVIDENCE.projection, EVIDENCE.host],
  "coverage-advertised-validator-dispatcher-route": [EVIDENCE.projection],
  "coverage-descriptor-contract-bidirectional-consistency": [EVIDENCE.projection],
  "coverage-portfolio-ordinary-surface-isolation": [EVIDENCE.policy, EVIDENCE.projection],
  "coverage-historical-second-source-drift": [EVIDENCE.historical],
  "exit-graph-edge-characterization": [EVIDENCE.policy, EVIDENCE.projection, EVIDENCE.host, EVIDENCE.historical],
  "exit-fault-injection-projection-drift": [EVIDENCE.projection],
  "exit-current-difference-expected-verdict": [EVIDENCE.historical, EVIDENCE.projection],
  "exit-independent-reviewer-projection-boundary": [EVIDENCE.plan],
  "exit-no-definition-composition-or-legacy-projection-removal": [EVIDENCE.plan],
});

function row(id, status, evidence, nonclaim) {
  return Object.freeze({ id, status, evidence: Object.freeze(evidence), nonclaim });
}

export const P1T_EXIT_MATRIX = Object.freeze({
  artifactKind: "stardew_p1t_exit_matrix/v1",
  authority: "none",
  liveClosure: "none",
  rows: Object.freeze([
    row("coverage-policy-v1-default-deny-family", STATUS.CHARACTERIZED, [EVIDENCE.policy], "Policy characterization only; it does not grant authority."),
    row("coverage-experimental-opt-in-host-surface", STATUS.CHARACTERIZED, [EVIDENCE.policy, EVIDENCE.host], "Projection characterization only; it does not grant authority."),
    row("coverage-legacy-v0-allowlist-fail-closed", STATUS.CHARACTERIZED, [EVIDENCE.policy], "Policy characterization only; it does not grant authority."),
    row("coverage-hello-and-fresh-snapshot-same-enabled-set", STATUS.CHARACTERIZED, [EVIDENCE.policy], "Offline same-surface characterization only; it does not establish target-world-ready identity."),
    row("coverage-immutable-same-surface-generation-fence", STATUS.CHARACTERIZED, [EVIDENCE.policy], "The immutable same-surface generation fence is offline and world-not-ready only; it neither characterizes target-world-ready identity nor surface replacement or revision-bound withdrawal."),
    row("coverage-target-world-ready-snapshot-publication-identity", STATUS.NOT_CLAIMED, [EVIDENCE.plan], "Target-world-ready publication identity is not claimed by this static matrix."),
    row("coverage-withdrawal-generation-revision-boundary", STATUS.UNIMPLEMENTED, [EVIDENCE.policy, EVIDENCE.plan], "Surface replacement and revision-bound withdrawal are explicitly unimplemented lifecycle behavior."),
    row("coverage-host-mod-write-asymmetry", STATUS.CHARACTERIZED, [EVIDENCE.projection, EVIDENCE.host], "Static and Host projection characterization only; it does not grant authority."),
    row("coverage-host-tool-per-published-entry-and-readiness", STATUS.CHARACTERIZED, [EVIDENCE.projection, EVIDENCE.host], "Host materialization characterization only; it does not grant authority."),
    row("coverage-advertised-validator-dispatcher-route", STATUS.CHARACTERIZED, [EVIDENCE.projection], "Structural route characterization only; it does not establish action-specific live behavior."),
    row("coverage-descriptor-contract-bidirectional-consistency", STATUS.CHARACTERIZED, [EVIDENCE.projection], "Descriptor characterization only; it does not grant authority or success."),
    row("coverage-portfolio-ordinary-surface-isolation", STATUS.CHARACTERIZED, [EVIDENCE.policy, EVIDENCE.projection], "Isolation characterization only; it does not grant authority."),
    row("coverage-historical-second-source-drift", STATUS.CHARACTERIZED, [EVIDENCE.historical], "Pinned historical characterization only; it does not grant authority."),
    row("exit-graph-edge-characterization", STATUS.CHARACTERIZED, [EVIDENCE.policy, EVIDENCE.projection, EVIDENCE.host, EVIDENCE.historical], "Bounded edge characterization only; it does not establish action-specific live behavior."),
    row("exit-fault-injection-projection-drift", STATUS.CHARACTERIZED, [EVIDENCE.projection], "Static fault-injection characterization only; it does not grant authority."),
    row("exit-current-difference-expected-verdict", STATUS.CHARACTERIZED, [EVIDENCE.historical, EVIDENCE.projection], "Expected-drift characterization only; it does not grant authority."),
    row("exit-independent-reviewer-projection-boundary", STATUS.NOT_CLAIMED, [EVIDENCE.plan], "No independent reviewer evidence or action-specific target-world result is recorded by this static matrix."),
    row("exit-no-definition-composition-or-legacy-projection-removal", STATUS.NOT_CLAIMED, [EVIDENCE.plan], "No composition or removal is claimed, and this matrix does not authorize P2."),
  ]),
});

export async function validateP1tExitMatrix(matrix = P1T_EXIT_MATRIX, { root = process.cwd(), pathExists = access, readEvidence = readFile } = {}) {
  if (!matrix || matrix.artifactKind !== "stardew_p1t_exit_matrix/v1" || matrix.authority !== "none" || matrix.liveClosure !== "none") {
    throw new Error("stardew_p1t_exit_matrix_metadata_invalid");
  }
  if (!Array.isArray(matrix.rows) || matrix.rows.length !== 18) throw new Error("stardew_p1t_exit_matrix_row_count_invalid");
  const ids = new Set();
  for (const entry of matrix.rows) {
    if (!entry || typeof entry.id !== "string" || ids.has(entry.id)) throw new Error("stardew_p1t_exit_matrix_row_id_invalid");
    ids.add(entry.id);
    if (!Object.values(STATUS).includes(entry.status)) throw new Error("stardew_p1t_exit_matrix_status_invalid");
    const expectedEvidence = REQUIRED_ROW_EVIDENCE[entry.id];
    if (!Array.isArray(entry.evidence) || !expectedEvidence || entry.evidence.length !== expectedEvidence.length || entry.evidence.some((item, index) => item !== expectedEvidence[index])) {
      throw new Error("stardew_p1t_exit_matrix_evidence_binding_invalid");
    }
    if (typeof entry.nonclaim !== "string" || entry.nonclaim.length === 0) throw new Error("stardew_p1t_exit_matrix_nonclaim_invalid");
    for (const evidence of entry.evidence) {
      try { await pathExists(resolve(root, evidence)); } catch { throw new Error(`stardew_p1t_exit_matrix_evidence_missing:${evidence}`); }
      try {
        const content = await readEvidence(resolve(root, evidence), "utf8");
        if (typeof content !== "string" || !content.includes(EVIDENCE_MARKERS[evidence])) throw new Error();
      } catch { throw new Error(`stardew_p1t_exit_matrix_evidence_marker_invalid:${evidence}`); }
    }
  }
  if (ids.size !== Object.keys(REQUIRED_ROW_STATUSES).length || [...ids].some((id) => !(id in REQUIRED_ROW_STATUSES))) {
    throw new Error("stardew_p1t_exit_matrix_required_row_missing");
  }
  const withdrawal = matrix.rows.find((entry) => entry.id === "coverage-withdrawal-generation-revision-boundary");
  if (withdrawal?.status !== STATUS.UNIMPLEMENTED) throw new Error("stardew_p1t_exit_matrix_withdrawal_reclassified");
  if (matrix.rows.some((entry) => entry.status !== REQUIRED_ROW_STATUSES[entry.id])) throw new Error("stardew_p1t_exit_matrix_status_reclassified");
  const immutable = matrix.rows.find((entry) => entry.id === "coverage-immutable-same-surface-generation-fence");
  if (immutable?.status !== STATUS.CHARACTERIZED || !immutable.nonclaim.includes("world-not-ready only")) throw new Error("stardew_p1t_exit_matrix_immutable_fence_invalid");
  const output = JSON.stringify(matrix);
  if (/P1T\s+passed|(?<!live)closure|action\s+live/i.test(output)) throw new Error("stardew_p1t_exit_matrix_forbidden_claim");
  return matrix;
}

if (import.meta.main) {
  try { console.log(JSON.stringify(await validateP1tExitMatrix())); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
