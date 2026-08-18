import assert from "node:assert/strict";
import test from "node:test";

import { createHash } from "node:crypto";
import { superviseFarmhandSessionPhaseB, superviseNativeChatLiveEvidence, superviseStardewCompanionAdmissionProbe } from "./supervise-stardew-companion-live-session.mjs";
import { sealCompanionLiveEvidenceRecord } from "../../tools/lib/stardew-companion-live-evidence.mjs";

const secretValues = ["secret-pipe", "super-secret-token", "runtime-secret"];

function assertRedacted(value) {
  const serialized = JSON.stringify(value);
  for (const secret of secretValues) assert.equal(serialized.includes(secret), false);
}

test("Phase A stays input-free, fail-closed, and redacted", async () => {
  assert.equal(superviseStardewCompanionAdmissionProbe.length, 0);
  const result = await superviseStardewCompanionAdmissionProbe();
  assert.deepEqual(result, {
    schema: "gamebuddy-stardew-companion-admission-probe/v1",
    state: "blocked",
    reasonCode: "companion_live_source_attestation_unavailable",
  });
  assertRedacted(result);
  await assert.rejects(
    () => superviseStardewCompanionAdmissionProbe({ pipeName: "secret-pipe" }),
    /admission_supervisor_override_forbidden/,
  );
});

test("native chat production gate rejects even complete hand-authored append-only evidence", async () => {
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const identity = { topology: "native_ai_farmhand_multiplayer", manifestSha256: "a".repeat(64), runtimeInstanceSha256: "b".repeat(64) };
  let previousSha256 = "0".repeat(64);
  const source = hash("source"), stop = hash("stop"), batch = hash("batch");
  const events = [
    { kind: "native_player_input_observed", sourceEventSha256: source, batchIdSha256: null, stopIdSha256: null, epoch: null, disposition: null, observationRevision: null },
    { kind: "pi_turn_accepted", sourceEventSha256: source, batchIdSha256: batch, stopIdSha256: null, epoch: null, disposition: "steer", observationRevision: null },
    { kind: "pi_turn_settled", sourceEventSha256: source, batchIdSha256: batch, stopIdSha256: null, epoch: null, disposition: "steer", observationRevision: null },
    { kind: "native_stop_all_observed", sourceEventSha256: source, batchIdSha256: null, stopIdSha256: stop, epoch: null, disposition: null, observationRevision: null },
    { kind: "stop_sealed", sourceEventSha256: source, batchIdSha256: null, stopIdSha256: stop, epoch: 1, disposition: null, observationRevision: null },
    { kind: "stop_settled", sourceEventSha256: source, batchIdSha256: null, stopIdSha256: stop, epoch: 1, disposition: null, observationRevision: null },
    { kind: "old_epoch_quiet", sourceEventSha256: source, batchIdSha256: null, stopIdSha256: stop, epoch: 1, disposition: null, observationRevision: 1 },
    { kind: "body_settled", sourceEventSha256: source, batchIdSha256: null, stopIdSha256: stop, epoch: 1, disposition: null, observationRevision: 1 },
  ];
  const artifactText = events.map((event, sequence) => { const record = sealCompanionLiveEvidenceRecord({ schema: "gamebuddy-stardew-companion-live-evidence/v1", sequence, identity, event, previousSha256 }); previousSha256 = record.recordSha256; return JSON.stringify(record); }).join("\n");
  assert.deepEqual(await superviseNativeChatLiveEvidence({ productionArtifactReady: true, runbookPreflightReady: true, artifactText }), {
    schema: "gamebuddy-stardew-companion-phase-b-supervision/v1",
    phase: "B",
    state: "blocked",
    reasonCodes: ["companion_live_receipt_evidence_unavailable"],
  });
  assert.deepEqual((await superviseNativeChatLiveEvidence({ productionArtifactReady: false, runbookPreflightReady: true, artifactText })).reasonCodes, ["companion_live_receipt_evidence_unavailable"]);
});

test("Phase B stays input-free, fail-closed, and redacted", async () => {
  assert.equal(superviseFarmhandSessionPhaseB.length, 0);
  const result = await superviseFarmhandSessionPhaseB();
  assert.deepEqual(result, {
    schema: "gamebuddy-stardew-companion-phase-b-supervision/v1",
    phase: "B",
    state: "blocked",
    reasonCode: "phase_b_production_launcher_unavailable",
  });
  assertRedacted(result);
});
