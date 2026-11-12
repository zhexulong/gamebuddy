import assert from "node:assert/strict";
import test from "node:test";

import type { HostNodeAdmissionResult } from "../action-execution-coordinator.internal.js";
import type { BodyNodeAdmissionChallenge, BodyNodeAdmissionGrant } from "../protocol.js";
import { createRunTrace, RUN_SPAN_NAMES } from "../run-trace.js";
import { createTracedBodyNodeAdmission } from "./continuity-semantic-game-runtime-materializer.js";

/**
 * The composition's body-node admission is the interval a cross-language gap lands in, so its span is the reading the
 * trace exists to carry: from the Mod's challenge reaching this Host to the result this Host sends back.
 */

function clockAt(startMs = 1_000): { readonly now: () => number; advance(ms: number): void } {
  let current = startMs;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

const challenge: BodyNodeAdmissionChallenge = Object.freeze({
  programId: "program_01",
  nodeId: "node_01",
  nodeAttempt: 1,
  admissionAttempt: 1,
  stopEpoch: 0,
  catalogRevision: 11,
  policyIdentity: Object.freeze({ value: "policy_01", capabilityRevision: 1 }),
  actionId: "water_crop",
  canonicalBoundArgs: Object.freeze({}),
  derivedResourceClaims: Object.freeze({ embodied_actor: "player_01" }),
  deadlineMs: 1_000 + 60_000,
});

const grant: BodyNodeAdmissionGrant = Object.freeze({
  ...challenge,
  grantId: "grant_01",
  attachmentGeneration: "generation_01",
  policyRevision: "revision_01",
  executionBinding: null,
});

test("one admission is measured from the challenge to the result, and says how it was decided", async () => {
  const clock = clockAt();
  const trace = createRunTrace("run_admission", { now: clock.now });
  const admitted = createTracedBodyNodeAdmission(trace, async () => {
    clock.advance(40);
    return Object.freeze({ result: "granted", grant }) as HostNodeAdmissionResult;
  });

  const result = await admitted(challenge);

  // The result the Mod receives is the same projection the untraced handler produced: the span is beside it, not in it.
  assert.deepEqual(result, { ...grant, result: "granted" });
  const spans = trace.spans();
  assert.equal(spans.length, 1);
  const [admission] = spans;
  assert.equal(admission!.name, RUN_SPAN_NAMES.admission);
  assert.equal(admission!.parentId, null);
  // The whole interval, on the run clock: the dissemination the Mod's own journal append does not cover.
  assert.equal(admission!.endMs! - admission!.startMs, 40);
  assert.equal(admission!.attributes.programId, "program_01");
  assert.equal(admission!.attributes.nodeId, "node_01");
  assert.equal(admission!.attributes.nodeAttempt, 1);
  assert.equal(admission!.attributes.admissionAttempt, 1);
  assert.equal(admission!.attributes.actionId, "water_crop");
  assert.equal(admission!.attributes.result, "granted");
});

test("a refused admission is a duration and a code, not a closed bridge", async () => {
  const trace = createRunTrace("run_admission_refused");
  const admitted = createTracedBodyNodeAdmission(trace, async () =>
    Object.freeze({ result: "rejected", code: "policy_denied" }),
  );

  assert.deepEqual(await admitted(challenge), { ...challenge, result: "rejected", code: "policy_denied" });
  const [admission] = trace.spans();
  assert.equal(admission!.name, RUN_SPAN_NAMES.admission);
  assert.equal(admission!.attributes.result, "rejected");
  assert.equal(admission!.attributes.code, "policy_denied");
  assert.ok(admission!.endMs !== null);
});

test("an admission that throws closes its span with the bounded cause and rethrows", async () => {
  const trace = createRunTrace("run_admission_failed");
  const admitted = createTracedBodyNodeAdmission(trace, async () => {
    throw new Error("node_admission_challenge_mismatch");
  });

  await assert.rejects(() => admitted(challenge), /node_admission_challenge_mismatch/u);
  const [admission] = trace.spans();
  assert.equal(admission!.attributes.failed, "node_admission_challenge_mismatch");
  assert.ok(admission!.endMs !== null);
});
