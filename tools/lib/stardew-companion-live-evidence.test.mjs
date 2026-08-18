import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  evaluateCompanionLiveEvidence,
  gateProductionCompanionLiveEvidence,
  parseCompanionLiveEvidenceArtifact,
  sealCompanionLiveEvidenceRecord,
} from "./stardew-companion-live-evidence.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const identity = {
  topology: "native_ai_farmhand_multiplayer",
  manifestSha256: "a".repeat(64),
  runtimeInstanceSha256: "b".repeat(64),
};
function artifact(events) {
  let previousSha256 = "0".repeat(64);
  return (
    events
      .map((event, sequence) => {
        const record = sealCompanionLiveEvidenceRecord({
          schema: "gamebuddy-stardew-companion-live-evidence/v1",
          sequence,
          identity,
          event,
          previousSha256,
        });
        previousSha256 = record.recordSha256;
        return JSON.stringify(record);
      })
      .join("\n") + "\n"
  );
}
const event = (kind, source = hash("source"), values = {}) => ({
  kind,
  sourceEventSha256: source,
  batchIdSha256: null,
  stopIdSha256: null,
  epoch: null,
  disposition: null,
  observationRevision: null,
  ...values,
});
test("accepts redacted append-only native input and stop evidence only when required lineage settles", () => {
  const source = hash("source"),
    stop = hash("stop"),
    batch = hash("batch");
  const parsed = parseCompanionLiveEvidenceArtifact(
    artifact([
      event("native_player_input_observed", source),
      event("pi_turn_accepted", source, { batchIdSha256: batch, disposition: "steer" }),
      event("pi_turn_settled", source, { batchIdSha256: batch, disposition: "steer" }),
      event("native_stop_all_observed", source, { stopIdSha256: stop }),
      event("stop_sealed", source, { stopIdSha256: stop, epoch: 2 }),
      event("stop_settled", source, { stopIdSha256: stop, epoch: 2 }),
      event("old_epoch_quiet", source, { stopIdSha256: stop, epoch: 2, observationRevision: 9 }),
      event("body_settled", source, { stopIdSha256: stop, epoch: 2, observationRevision: 9 }),
    ]),
  );
  assert.deepEqual(evaluateCompanionLiveEvidence(parsed).reasonCodes, []);
});
test("rejects tampering and fails closed when a STOP has no authoritative body settled fact", () => {
  const source = hash("source"),
    stop = hash("stop");
  const text = artifact([
    event("native_stop_all_observed", source, { stopIdSha256: stop }),
    event("stop_sealed", source, { stopIdSha256: stop, epoch: 2 }),
    event("stop_settled", source, { stopIdSha256: stop, epoch: 2 }),
    event("old_epoch_quiet", source, { stopIdSha256: stop, epoch: 2, observationRevision: 9 }),
  ]);
  assert.deepEqual(evaluateCompanionLiveEvidence(parseCompanionLiveEvidenceArtifact(text)).reasonCodes, [
    "production_live_body_settle_evidence_unavailable",
    "native_player_input_scenario_missing",
  ]);
  assert.throws(
    () => parseCompanionLiveEvidenceArtifact(text.replace('"sequence":1', '"sequence":7')),
    /live_evidence_(record_digest|append_chain)_invalid/,
  );
});
test("production gate rejects even a complete hand-authored JSONL chain", () => {
  const source = hash("source"),
    stop = hash("stop"),
    batch = hash("batch");
  const completeHandAuthoredArtifact = artifact([
    event("native_player_input_observed", source),
    event("pi_turn_accepted", source, { batchIdSha256: batch, disposition: "steer" }),
    event("pi_turn_settled", source, { batchIdSha256: batch, disposition: "steer" }),
    event("native_stop_all_observed", source, { stopIdSha256: stop }),
    event("stop_sealed", source, { stopIdSha256: stop, epoch: 2 }),
    event("stop_settled", source, { stopIdSha256: stop, epoch: 2 }),
    event("old_epoch_quiet", source, { stopIdSha256: stop, epoch: 2, observationRevision: 9 }),
    event("body_settled", source, { stopIdSha256: stop, epoch: 2, observationRevision: 9 }),
  ]);
  assert.equal(
    evaluateCompanionLiveEvidence(parseCompanionLiveEvidenceArtifact(completeHandAuthoredArtifact)).state,
    "ready",
  );
  assert.deepEqual(
    gateProductionCompanionLiveEvidence({
      productionArtifactReady: true,
      runbookPreflightReady: true,
      artifactText: completeHandAuthoredArtifact,
    }),
    {
      state: "blocked",
      reasonCodes: ["companion_live_receipt_evidence_unavailable"],
    },
  );
});
