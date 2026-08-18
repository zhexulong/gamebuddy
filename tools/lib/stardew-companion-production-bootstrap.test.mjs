import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  verifyDeterministicBootstrapComposition,
  blockedDeterministicBootstrapComposition,
} from "./stardew-companion-production-bootstrap.mjs";
const digest = (value) => createHash("sha256").update(value).digest("hex");
function valid() {
  const challengeSha256 = "a".repeat(64);
  const runtimeInstanceId = "runtime";
  const handoff = {
    schema: "gamebuddy-production-control-capability/v1",
    protocolVersion: 1,
    pipeName: "pipe",
    launchToken: "token",
    launchBinding: digest("binding"),
  };
  return {
    challengeSha256,
    handoffs: [handoff],
    evidence: {
      schema: "gamebuddy-companion-bootstrap-evidence/v1",
      evidenceClass: "deterministic_bootstrap_composition",
      challengeSha256,
      protocolVersion: 1,
      launchBindingSha256: handoff.launchBinding,
      runtimeInstanceSha256: digest(runtimeInstanceId),
      controlReady: true,
    },
    mutationCalls: 0,
  };
}
test("D0 verifier accepts only redacted unique deterministic composition", () =>
  assert.equal(verifyDeterministicBootstrapComposition(valid()), "deterministic_bootstrap_composition_passed"));
test("D0 verifier rejects duplicate, wrong correlation, leaks, mutation, and is never live", () => {
  for (const patch of [
    { handoffs: [] },
    { handoffs: [valid().handoffs[0], valid().handoffs[0]] },
    { mutationCalls: 1 },
    { evidence: { ...valid().evidence, challengeSha256: "b".repeat(64) } },
    { evidence: { ...valid().evidence, raw: "token" } },
  ])
    assert.equal(
      verifyDeterministicBootstrapComposition({ ...valid(), ...patch }),
      "deterministic_bootstrap_composition_failed",
    );
  assert.equal(blockedDeterministicBootstrapComposition(), "deterministic_bootstrap_composition_blocked");
});
