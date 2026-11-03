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
 *
 * The challenge is built once per case, outside the measured window: its 32 bound arguments and 16
 * claims are the same values on every op, so rebuilding them inside the window made this case read
 * V8's allocation and scavenge cost instead of `admit`'s - without changing what the case reads
 * (125.82 against 129.32 µs/op at the large size, and the spread did not move either).
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

function challengeTemplateFor(size) {
  return Object.freeze({
    programId: "program-1",
    nodeId: "node-1",
    admissionAttempt: 1,
    stopEpoch: 0,
    catalogRevision: 3,
    policyIdentity: { value: "policy-value-1", capabilityRevision: 1 },
    actionId: "move_to_tile",
    canonicalBoundArgs: boundArgsFor(size),
    derivedResourceClaims: claimsFor(size),
  });
}

/**
 * One case's measurement. It runs at module scope, not inside the `test()` that reports it:
 * `node:test` instruments the async work a test body awaits, and `admit` awaits several promises per
 * op, so the same op read 21.11 µs/op inside a test body against 11.43 µs/op outside one, in one
 * process. A budget half of which is the framework cannot see a regression in the other half.
 */
async function measureCase(size) {
  const journal = new StardewLogicalActionRecoveryJournal({ write: (record) => record });
  const service = new HostNodeAdmissionService(journal, () => ({
    result: "granted",
    attachmentGeneration: "attachment-generation-1",
    policyRevision: "policy-revision-1",
  }));
  const template = challengeTemplateFor(size);
  let next = 1;
  return await measure({
    id: CASE,
    size: size.size,
    maxOps: MAX_OPS,
    run: async () => {
      // Only what must differ per op: `nodeAttempt` is the tuple (program, node, nodeAttempt,
      // admissionAttempt) that makes one record unique, and the deadline is kept fresh so a long
      // run cannot start measuring `deadline_expired` rejections. Both are numbers.
      const admitted = await service.admit({ ...template, nodeAttempt: next++, deadlineMs: Date.now() + 60_000 });
      if (admitted.result !== "granted") throw new Error(`perf_case_admission_refused:${admitted.result}`);
    },
  });
}

const outcomes = new Map();
for (const size of SIZES) {
  try {
    outcomes.set(size.size, { measured: await measureCase(size) });
  } catch (error) {
    // The case that could not be measured fails its own test below, instead of taking the other
    // size's finished measurement down with the file's module load.
    outcomes.set(size.size, { error });
  }
}

for (const size of SIZES) {
  test(`${CASE} ${size.size}`, () => {
    const outcome = outcomes.get(size.size);
    if (outcome.error !== undefined) throw outcome.error;
    report({
      ...outcome.measured,
      detail: { boundArgs: size.boundArgs, claims: size.claims, boundValueBytes: size.valueBytes },
    });
  });
}
