import assert from "node:assert/strict";
import test from "node:test";
import {
  createCompanionBootstrapEvidence,
  deliverCompanionBootstrapEvidence,
  parseCompanionBootstrapEvidence,
} from "./companion-bootstrap-evidence.js";

const challenge = "a".repeat(64);
test("bootstrap evidence is exact, redacted, and correlation-bound", () => {
  const evidence = createCompanionBootstrapEvidence({
    challengeSha256: challenge,
    launchBinding: "binding",
    runtimeInstanceId: "runtime",
  });
  assert.deepEqual(parseCompanionBootstrapEvidence(evidence), evidence);
  const serialized = JSON.stringify(evidence);
  assert.equal(serialized.includes(JSON.stringify("binding")), false);
  assert.equal(serialized.includes(JSON.stringify("runtime")), false);
});
test("bootstrap evidence delivery is acknowledged and bounded", async () => {
  const evidence = createCompanionBootstrapEvidence({
    challengeSha256: challenge,
    launchBinding: "binding",
    runtimeInstanceId: "runtime",
  });
  await deliverCompanionBootstrapEvidence(
    (_message, callback) => {
      queueMicrotask(() => callback(null));
      return true;
    },
    evidence,
    50,
  );
  await assert.rejects(
    deliverCompanionBootstrapEvidence(() => true, evidence, 10),
    /deterministic_bootstrap_evidence_delivery_timeout/,
  );
  await assert.rejects(
    deliverCompanionBootstrapEvidence(() => false, evidence, 50),
    /deterministic_bootstrap_evidence_ipc_unavailable/,
  );
});

test("bootstrap evidence rejects forged shapes, bad digests, and leaks", () => {
  const evidence = createCompanionBootstrapEvidence({
    challengeSha256: challenge,
    launchBinding: "binding",
    runtimeInstanceId: "runtime",
  });
  for (const value of [
    null,
    {},
    { ...evidence, rawRuntime: "runtime" },
    { ...evidence, challengeSha256: "wrong" },
    { ...evidence, controlReady: false },
  ])
    assert.throws(() => parseCompanionBootstrapEvidence(value), /invalid_companion_bootstrap_evidence/);
  assert.throws(
    () =>
      createCompanionBootstrapEvidence({
        challengeSha256: "x",
        launchBinding: "binding",
        runtimeInstanceId: "runtime",
      }),
    /invalid_companion_bootstrap_evidence_input/,
  );
});
