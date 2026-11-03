import assert from "node:assert/strict";
import test from "node:test";

import {
  createLiveSourceAttester,
  LIVE_SOURCE_ATTESTATION_SCHEMA,
  parseLiveSourceAttestation,
} from "./companion-live-source-attestation.js";

const binding = "a".repeat(64);

test("live source attester is inert until the current-user control runtime activates it", () => {
  const messages: Array<Readonly<{ schema: string; evidence: unknown }>> = [];
  const attester = createLiveSourceAttester({
    launchBindingSha256: binding,
    send: (message) => {
      messages.push(message);
      return true;
    },
  });
  attester.piTurnSettled({ batchId: "batch_01", sourceEventId: "source_01", disposition: "steer" });
  assert.equal(messages.length, 0);
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
  const envelope = messages[0];
  assert.equal(envelope?.schema, LIVE_SOURCE_ATTESTATION_SCHEMA);
  const evidence = parseLiveSourceAttestation(envelope?.evidence);
  assert.equal(evidence.kind, "pi_turn_accepted");
  assert.equal(evidence.batchIdSha256 === null, false);
  assert.equal(evidence.stopIdSha256, null);
  const observation = parseLiveSourceAttestation(messages[3]?.evidence);
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
  const first = valid[0];
  assert.ok(first !== undefined, "the valid corpus must carry a first envelope");
  const boxed = Object.assign(Object.create(null), first);
  for (const invalid of [
    { schema: LIVE_SOURCE_ATTESTATION_SCHEMA, text: "secret" },
    { ...first, unexpected: null },
    Object.fromEntries(Object.entries(first).filter(([key]) => key !== "epoch")),
    { ...first, launchBindingSha256: new String(sha("a")) },
    { ...first, runtimeInstanceSha256: { toString: () => sha("b") } },
    { ...first, sourceEventSha256: { valueOf: () => sha("c") } },
    { ...first, kind: new String("native_player_input_observed") },
    { ...first, observationRevision: 0 },
    { ...valid[2], disposition: null },
    { ...valid[5], observationRevision: 0 },
    boxed,
  ])
    assert.throws(() => parseLiveSourceAttestation(invalid), /invalid_live_source_attestation/);
});
