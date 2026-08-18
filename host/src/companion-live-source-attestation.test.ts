import assert from "node:assert/strict";
import test from "node:test";

import {
  createLiveSourceAttester,
  parseLiveSourceAttestation,
  LIVE_SOURCE_ATTESTATION_SCHEMA,
} from "./companion-live-source-attestation.js";

const binding = "a".repeat(64);

test("live source attester is inert until the current-user control runtime activates it", () => {
  const messages: unknown[] = [];
  const attester = createLiveSourceAttester({
    launchBindingSha256: binding,
    send: (message) => {
      messages.push(message);
      return true;
    },
  });
  attester.piTurnSettled({ batchId: "batch_01", sourceEventId: "source_01", disposition: "steer" });
  assert.deepEqual(messages, []);
  attester.activate("runtime_01");
  attester.piTurnAccepted({ batchId: "batch_01", sourceEventId: "source_01", disposition: "steer" });
  attester.piTurnSettled({ batchId: "batch_01", sourceEventId: "source_01", disposition: "steer" });
  attester.stopSealed({ stopId: "stop_01", sourceEventId: "source_01", batchId: "batch_01", epoch: 1 });
  attester.bodySettled({
    stopId: "stop_01",
    sourceEventId: "source_01",
    batchId: "batch_01",
    epoch: 1,
    observationRevision: 7,
  });
  assert.equal(messages.length, 4);
  const envelope = messages[0] as { schema: string; evidence: unknown };
  assert.equal(envelope.schema, LIVE_SOURCE_ATTESTATION_SCHEMA);
  const evidence = parseLiveSourceAttestation(envelope.evidence);
  assert.equal(evidence.kind, "pi_turn_accepted");
  assert.equal(evidence.batchIdSha256 === null, false);
  assert.equal(evidence.stopIdSha256, null);
  const observation = parseLiveSourceAttestation((messages[3] as { evidence: unknown }).evidence);
  assert.equal(observation.kind, "body_settled");
  assert.equal(observation.observationRevision, 7);
});

test("live source attester rejects an unavailable direct-parent delivery", () => {
  const attester = createLiveSourceAttester({ launchBindingSha256: binding, send: () => false });
  attester.activate("runtime_01");
  assert.throws(
    () => attester.stopSettled({ stopId: "stop_01", sourceEventId: "source_01", batchId: "batch_01", epoch: 1 }),
    /live_source_attestation_delivery_unavailable/,
  );
});

test("live source evidence parser accepts only the exact primitive wire corpus for every kind", () => {
  const sha = (character: string) => character.repeat(64);
  const base = {
    schema: LIVE_SOURCE_ATTESTATION_SCHEMA,
    protocolVersion: 1,
    evidenceClass: "production_live_source_attestation",
    launchBindingSha256: sha("a"),
    runtimeInstanceSha256: sha("b"),
    sourceEventSha256: sha("c"),
  };
  const valid = [
    {
      ...base,
      kind: "native_player_input_observed",
      batchIdSha256: null,
      stopIdSha256: null,
      epoch: null,
      disposition: null,
      observationRevision: null,
    },
    {
      ...base,
      kind: "native_stop_all_observed",
      batchIdSha256: null,
      stopIdSha256: sha("d"),
      epoch: null,
      disposition: null,
      observationRevision: null,
    },
    ...["pi_turn_accepted", "pi_turn_settled"].map((kind) => ({
      ...base,
      kind,
      batchIdSha256: sha("d"),
      stopIdSha256: null,
      epoch: null,
      disposition: "steer",
      observationRevision: null,
    })),
    ...["stop_sealed", "stop_settled", "stop_uncertain"].map((kind) => ({
      ...base,
      kind,
      batchIdSha256: sha("e"),
      stopIdSha256: sha("d"),
      epoch: 0,
      disposition: null,
      observationRevision: null,
    })),
    ...["old_epoch_quiet", "body_settled"].map((kind) => ({
      ...base,
      kind,
      batchIdSha256: sha("e"),
      stopIdSha256: sha("d"),
      epoch: 0,
      disposition: null,
      observationRevision: 0,
    })),
  ];
  for (const evidence of valid) assert.equal(parseLiveSourceAttestation(evidence).kind, evidence.kind);
  const boxed = Object.assign(Object.create(null), valid[0]);
  for (const invalid of [
    { schema: LIVE_SOURCE_ATTESTATION_SCHEMA, text: "secret" },
    { ...valid[0], unexpected: null },
    Object.fromEntries(Object.entries(valid[0]).filter(([key]) => key !== "epoch")),
    { ...valid[0], launchBindingSha256: new String(sha("a")) },
    { ...valid[0], runtimeInstanceSha256: { toString: () => sha("b") } },
    { ...valid[0], sourceEventSha256: { valueOf: () => sha("c") } },
    { ...valid[0], kind: new String("native_player_input_observed") },
    { ...valid[0], observationRevision: 0 },
    { ...valid[2], disposition: null },
    { ...valid[5], observationRevision: 0 },
    boxed,
  ])
    assert.throws(() => parseLiveSourceAttestation(invalid), /invalid_live_source_attestation/);
});
