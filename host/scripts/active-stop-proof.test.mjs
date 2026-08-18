import assert from "node:assert/strict";
import test from "node:test";

import { createActiveStopProofVerifier } from "./active-stop-proof.mjs";

const binding = "b".repeat(64);
const runtime = "r".repeat(64);
const batch = "a".repeat(64);
const stop = "s".repeat(64);
const source = "e".repeat(64);

function evidence(kind, overrides = {}) {
  return {
    schema: "gamebuddy-production-live-source-attestation/v1",
    protocolVersion: 1,
    evidenceClass: "production_live_source_attestation",
    launchBindingSha256: binding,
    runtimeInstanceSha256: runtime,
    kind,
    sourceEventSha256: source,
    batchIdSha256: null,
    stopIdSha256: null,
    epoch: null,
    disposition: null,
    observationRevision: null,
    ...overrides,
  };
}

function acceptFullProof(verifier, batchId = batch, stopId = stop) {
  assert.equal(verifier.accept(evidence("pi_turn_accepted", { batchIdSha256: batchId, disposition: "steer" })), true);
  assert.equal(verifier.accept(evidence("native_stop_all_observed", { stopIdSha256: stopId })), true);
  assert.equal(verifier.accept(evidence("stop_sealed", { batchIdSha256: batchId, stopIdSha256: stopId, epoch: 3 })), true);
  assert.equal(verifier.accept(evidence("stop_settled", { batchIdSha256: batchId, stopIdSha256: stopId, epoch: 3 })), true);
  assert.equal(verifier.accept(evidence("old_epoch_quiet", { batchIdSha256: batchId, stopIdSha256: stopId, epoch: 3, observationRevision: 9 })), true);
  assert.equal(verifier.accept(evidence("body_settled", { batchIdSha256: batchId, stopIdSha256: stopId, epoch: 3, observationRevision: 9 })), true);
}

test("active stop proof accepts one complete same-batch terminal sequence", () => {
  const verifier = createActiveStopProofVerifier(binding);
  acceptFullProof(verifier);
  assert.equal(verifier.result(), true);
});

test("active stop proof rejects a stop after the Pi batch settled", () => {
  const verifier = createActiveStopProofVerifier(binding);
  assert.equal(verifier.accept(evidence("pi_turn_accepted", { batchIdSha256: batch, disposition: "steer" })), true);
  assert.equal(verifier.accept(evidence("pi_turn_settled", { batchIdSha256: batch, disposition: "steer" })), true);
  assert.equal(verifier.accept(evidence("native_stop_all_observed", { stopIdSha256: stop })), true);
  assert.equal(verifier.accept(evidence("stop_sealed", { batchIdSha256: batch, stopIdSha256: stop, epoch: 3 })), false);
  assert.equal(verifier.result(), false);
});

test("active stop proof rejects a cross-batch Pi settlement", () => {
  const verifier = createActiveStopProofVerifier(binding);
  assert.equal(verifier.accept(evidence("pi_turn_accepted", { batchIdSha256: batch, disposition: "steer" })), true);
  assert.equal(verifier.accept(evidence("pi_turn_settled", { batchIdSha256: "c".repeat(64), disposition: "steer" })), false);
  assert.equal(verifier.result(), false);
});

test("active stop proof rejects null and cross-batch seals", () => {
  const empty = createActiveStopProofVerifier(binding);
  assert.equal(empty.accept(evidence("pi_turn_accepted", { batchIdSha256: batch, disposition: "steer" })), true);
  assert.equal(empty.accept(evidence("native_stop_all_observed", { stopIdSha256: stop })), true);
  assert.equal(empty.accept(evidence("stop_sealed", { batchIdSha256: null, stopIdSha256: stop, epoch: 3 })), false);

  const crossBatch = createActiveStopProofVerifier(binding);
  acceptFullProof(crossBatch, batch, stop);
  assert.equal(crossBatch.result(), true);
});

test("active stop proof fails closed on uncertain, mismatched, and duplicate terminal evidence", () => {
  const uncertain = createActiveStopProofVerifier(binding);
  assert.equal(uncertain.accept(evidence("pi_turn_accepted", { batchIdSha256: batch, disposition: "steer" })), true);
  assert.equal(uncertain.accept(evidence("stop_uncertain", { batchIdSha256: batch, stopIdSha256: stop, epoch: 3 })), false);
  assert.equal(uncertain.result(), false);

  const mismatch = createActiveStopProofVerifier(binding);
  assert.equal(mismatch.accept(evidence("pi_turn_accepted", { batchIdSha256: batch, disposition: "steer" })), true);
  assert.equal(mismatch.accept(evidence("native_stop_all_observed", { stopIdSha256: stop })), true);
  assert.equal(mismatch.accept(evidence("stop_sealed", { batchIdSha256: "c".repeat(64), stopIdSha256: stop, epoch: 3 })), false);
  assert.equal(mismatch.result(), false);

  const duplicate = createActiveStopProofVerifier(binding);
  acceptFullProof(duplicate);
  assert.equal(duplicate.accept(evidence("body_settled", { batchIdSha256: batch, stopIdSha256: stop, epoch: 3, observationRevision: 9 })), false);
  assert.equal(duplicate.result(), false);
});
