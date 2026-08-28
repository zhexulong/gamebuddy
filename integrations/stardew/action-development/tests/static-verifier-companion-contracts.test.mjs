import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  evaluateCompanionLiveEvidence,
  gateProductionCompanionLiveEvidence,
  parseCompanionLiveEvidenceArtifact,
  sealCompanionLiveEvidenceRecord,
} from "../static-verifier/remaining-leaves/companion-live-evidence.mjs";
import {
  blockedAdmissionRecord,
  parseProductionAdmissionInvocation,
  runProductionAdmissionPreflight,
} from "../static-verifier/remaining-leaves/companion-production-admission.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const identity = { topology: "native_ai_farmhand_multiplayer", manifestSha256: "a".repeat(64), runtimeInstanceSha256: "b".repeat(64) };
const event = (kind, source, values = {}) => ({ kind, sourceEventSha256: source, batchIdSha256: null, stopIdSha256: null, epoch: null, disposition: null, observationRevision: null, ...values });
function artifact(events) {
  let previousSha256 = "0".repeat(64);
  return `${events.map((value, sequence) => { const record = sealCompanionLiveEvidenceRecord({ schema: "gamebuddy-stardew-companion-live-evidence/v1", sequence, identity, event: value, previousSha256 }); previousSha256 = record.recordSha256; return JSON.stringify(record); }).join("\n")}\n`;
}

test("package-owned companion live evidence contract verifies lineage but never mints production authority", () => {
  const source = digest("source"), batch = digest("batch"), stop = digest("stop");
  const text = artifact([
    event("native_player_input_observed", source),
    event("pi_turn_accepted", source, { batchIdSha256: batch, disposition: "steer" }),
    event("pi_turn_settled", source, { batchIdSha256: batch, disposition: "steer" }),
    event("native_stop_all_observed", source, { stopIdSha256: stop }),
    event("stop_sealed", source, { stopIdSha256: stop, epoch: 2 }),
    event("stop_settled", source, { stopIdSha256: stop, epoch: 2 }),
    event("old_epoch_quiet", source, { stopIdSha256: stop, epoch: 2, observationRevision: 9 }),
    event("body_settled", source, { stopIdSha256: stop, epoch: 2, observationRevision: 9 }),
  ]);
  assert.equal(evaluateCompanionLiveEvidence(parseCompanionLiveEvidenceArtifact(text)).state, "ready");
  assert.deepEqual(gateProductionCompanionLiveEvidence({ artifactText: text }), { state: "blocked", reasonCodes: ["companion_live_receipt_evidence_unavailable"] });
  assert.throws(() => parseCompanionLiveEvidenceArtifact(text.replace('"sequence":1', '"sequence":7')), /live_evidence_(record_digest|append_chain)_invalid/);
});

test("package-owned companion production admission contract is fixed-profile, read-only, and fail-closed", async () => {
  const argv = ["--profile", "preview_run_a_v1", "--operator-config", "C:\\operator.json", "--runtime-root", "C:\\runtime", "--fixture-transaction-manifest", "C:\\fixture.json", "--output", "C:\\safe\\result.json", "--preflight-only"];
  const invocation = parseProductionAdmissionInvocation(argv, { platform: "win32" });
  assert.deepEqual(invocation.scenarioIds, ["SIM-01", "SIM-02"]);
  assert.throws(() => parseProductionAdmissionInvocation([...argv, "--model", "x"], { platform: "win32" }), /admission_cli_forbidden_override/);
  const record = await runProductionAdmissionPreflight(invocation, {
    read: async () => JSON.stringify({ schema: "gamebuddy-stardew-companion-fixture-transaction/v1", state: "owned", profile: "preview_run_a_v1", topology: "native_ai_farmhand_multiplayer" }),
    supervisorProbe: async () => ({ schema: "gamebuddy-stardew-companion-admission-probe/v1", state: "blocked", reasonCode: "companion_live_source_attestation_unavailable" }),
  });
  assert.deepEqual(record, blockedAdmissionRecord("preview_run_a_v1", "companion_live_source_attestation_unavailable"));
  assert.throws(() => blockedAdmissionRecord("preview_run_a_v1", "C:\\secret"), /admission_reason_code_invalid/);
});
