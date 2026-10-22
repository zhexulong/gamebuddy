/**
 * Host action admission: one node admission challenge decided and granted.
 *
 * This is the decision every game action pays before it can touch the game: `HostNodeAdmissionService`
 * re-reads the durable record for the exact (program, node, attempt, admission attempt) tuple,
 * checks the deadline, runs the Host's fresh-policy validator, mints the grant, and records it.
 * A live run pays it once per action, so it is on the cost path of every turn.
 *
 * The journal is the module's own in-memory writer (the seam its constructor exposes for tests),
 * because the durable append this decision triggers is the `journal.write` case's subject: with a
 * file handle here, this number would be a second, noisier copy of that one. What is left is the
 * admission decision itself, measured at the protocol's own size floor and ceiling - 1 bound
 * argument and no claims, against 32 bound arguments of 512 bytes and 16 claims, which is the
 * largest challenge `validateBodyNodeAdmissionChallenge` accepts.
 */
import test from "node:test";

import { loadHostModule, measure, report } from "./harness.mjs";

const CASE = "admission.action";

const { HostNodeAdmissionService } = await loadHostModule("action-execution-coordinator.internal.js");
const { StardewLogicalActionRecoveryJournal } = await loadHostModule("stardew-logical-action-recovery-journal.js");

/** The protocol's ceilings: 32 bound arguments, 16 derived claims, 512 bytes per string value. */
const SIZES = Object.freeze([
  Object.freeze({ size: "small", boundArgs: 1, claims: 0, valueBytes: 1 }),
  Object.freeze({ size: "large", boundArgs: 32, claims: 16, valueBytes: 512 }),
]);

const MAX_OPS = 4000;

function boundArgsFor({ boundArgs, valueBytes }) {
  const value = "x".repeat(valueBytes);
  const args = {};
  for (let index = 1; index <= boundArgs; index += 1) args[`arg_${index}`] = { type: "string", canonicalValue: value };
  return args;
}

function claimsFor({ claims }) {
  const derived = {};
  for (let index = 1; index <= claims; index += 1) derived[`claim_${index}`] = `resource_${index}`;
  return derived;
}

function challengeFor(index, size) {
  return {
    programId: "program-1",
    nodeId: "node-1",
    // The tuple (program, node, nodeAttempt, admissionAttempt) is what makes one record unique.
    nodeAttempt: index,
    admissionAttempt: 1,
    stopEpoch: 0,
    catalogRevision: 3,
    policyIdentity: { value: "policy-value-1", capabilityRevision: 1 },
    actionId: "move_to_tile",
    canonicalBoundArgs: boundArgsFor(size),
    derivedResourceClaims: claimsFor(size),
    deadlineMs: Date.now() + 60_000,
  };
}

for (const size of SIZES) {
  test(`${CASE} ${size.size}`, async () => {
    const journal = new StardewLogicalActionRecoveryJournal({ write: (record) => record });
    const service = new HostNodeAdmissionService(journal, () => ({
      result: "granted",
      attachmentGeneration: "attachment-generation-1",
      policyRevision: "policy-revision-1",
    }));
    let next = 1;
    const result = await measure({
      id: CASE,
      size: size.size,
      maxOps: MAX_OPS,
      run: async () => {
        const admitted = await service.admit(challengeFor(next++, size));
        if (admitted.result !== "granted") throw new Error(`perf_case_admission_refused:${admitted.result}`);
      },
    });
    report({
      ...result,
      detail: { boundArgs: size.boundArgs, claims: size.claims, boundValueBytes: size.valueBytes },
    });
  });
}
