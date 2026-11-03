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

import { loadHostModule, measure, measureRatio, report, reportScaling, scalingRequested } from "./harness.mjs";

const CASE = "admission.action";

const { HostNodeAdmissionService } = await loadHostModule("action-execution-coordinator.internal.js");
const { StardewLogicalActionRecoveryJournal } = await loadHostModule("stardew-logical-action-recovery-journal.js");

/** The protocol's ceilings: 32 bound arguments, 16 derived claims, 512 bytes per string value. */
const SIZES = Object.freeze([
  Object.freeze({ size: "small", boundArgs: 1, claims: 0, valueBytes: 1 }),
  Object.freeze({ size: "large", boundArgs: 32, claims: 16, valueBytes: 512 }),
]);

/**
 * The pair the ratio is measured on, and why it does not end where the budget pair does.
 *
 * `small` and `large` differ on THREE fields at once (1 -> 32 bound arguments, 0 -> 16 claims, 1 -> 512
 * bytes per value), so a ratio between them is a measure of three changes rather than of one, and the
 * `small` end is a protocol floor with almost no work in it. The dominant axis among the three is the
 * bound-argument COUNT, measured one axis at a time through the real `admit` path (600 ops, 60 ms
 * windows, best of 3, 2026-11-03): (32, 16, 512) 89.59 µs/op, (16, 16, 512) 41.60, (32, 0, 512) 76.72,
 * (32, 16, 1) 74.59, (32, 16, 256) 77.12, (1, 0, 1) 8.34 - about 2.5 µs per bound argument, with the
 * claims map worth ~13 µs and the 512-byte values ~15 µs of a 90 µs op.
 *
 * There is no size above `large` to add: 32 arguments, 16 claims and 512-byte values are the protocol's
 * own ceilings, and the real validator says so - `validateBodyNodeAdmissionPayload` returns null at
 * (32, 16, 512) and `invalid_body_node_admission_challenge` at (33, 16, 512), (32, 17, 512),
 * (32, 16, 513) and (64, 16, 512). So `large` is the TOP of this pair and the doubling goes back down
 * one axis to 16 arguments, with the claims and the value bytes held at the ceiling. Both points are
 * challenges the product accepts, which is the only range whose shape matters.
 */
const SCALING = Object.freeze({
  axis: "boundArgs",
  from: Object.freeze({ size: "arg16", boundArgs: 16, claims: 16, valueBytes: 512 }),
  to: SIZES[1],
});

/**
 * What admission's cost may do with the bound arguments, and why.
 *
 * Each argument is validated, canonicalised and frozen on its way into the admission record, so the
 * per-op cost is expected to be linear in the count: 16 -> 32 arguments read 41.60 -> 89.59 µs/op,
 * ratio 2.15, in the axis measurement above. A quadratic pass over the arguments would read ~4.0
 * ((32/16)^2), and an admission that stopped walking them would read ~1.0 - the floor is 1.4 because
 * a linear path at these two sizes cannot come near it. The ceiling is 3.2, 1.5x the measured ratio:
 * this case's two points are both short (8-40 ms windows because the challenge memory is bounded), so
 * the band absorbs the ±15% a busy machine moves such a window by, while a quadratic still breaks it.
 */
const SCALING_BAND = Object.freeze({
  min: 1.4,
  max: 3.2,
  reason:
    "doubling the bound arguments measured 2.15 (validated, canonicalised and frozen per argument); " +
    "a quadratic walk of the arguments reads ~4.0, one that stopped walking them ~1.0",
});

const MAX_OPS = 4000;

/** The ratio case's op budget: both challenges are held in memory as admission records, so the
 * windows end by op count long before they end by the clock. */
const SCALING_MAX_OPS = 1000;

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
 * One challenge size's op, with the journal and the service it needs; both branches of this file build
 * their admission here, so the ratio and the budget reading are the same decision.
 */
function caseFor(size) {
  const journal = new StardewLogicalActionRecoveryJournal({ write: (record) => record });
  const service = new HostNodeAdmissionService(journal, () => ({
    result: "granted",
    attachmentGeneration: "attachment-generation-1",
    policyRevision: "policy-revision-1",
  }));
  const template = challengeTemplateFor(size);
  let next = 1;
  return {
    input: Object.freeze({ boundArgs: size.boundArgs, claims: size.claims, valueBytes: size.valueBytes }),
    run: async () => {
      // Only what must differ per op: `nodeAttempt` is the tuple (program, node, nodeAttempt,
      // admissionAttempt) that makes one record unique, and the deadline is kept fresh so a long
      // run cannot start measuring `deadline_expired` rejections. Both are numbers.
      const admitted = await service.admit({ ...template, nodeAttempt: next++, deadlineMs: Date.now() + 60_000 });
      if (admitted.result !== "granted") throw new Error(`perf_case_admission_refused:${admitted.result}`);
    },
  };
}

/**
 * One case's measurement. It runs at module scope, not inside the `test()` that reports it:
 * `node:test` instruments the async work a test body awaits, and `admit` awaits several promises per
 * op, so the same op read 21.11 µs/op inside a test body against 11.43 µs/op outside one, in one
 * process. A budget half of which is the framework cannot see a regression in the other half.
 */
async function measureCase(size) {
  return await measure({ id: CASE, size: size.size, maxOps: MAX_OPS, run: caseFor(size).run });
}

if (scalingRequested()) {
  const points = [SCALING.from, SCALING.to].map((size) => ({
    size: size.size,
    maxOps: SCALING_MAX_OPS,
    ...caseFor(size),
  }));
  const ratio = await measureRatio({ id: CASE, axis: SCALING.axis, points });
  test(`${CASE} scaling`, () => reportScaling(ratio, SCALING_BAND));
} else {
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
}
