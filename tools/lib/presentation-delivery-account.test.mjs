import assert from "node:assert/strict";
import test from "node:test";
import {
  assessBundleDeliveryAccount,
  deliveryAccountClause,
  describeDeliveryAccount,
  EXECUTION_STALL_PREFIX,
  MAX_BUNDLE_STALL_FACTS,
  readStallWatch,
  readTurnDeliveryRecords,
  summarizeDeliveryAccount,
  TURN_DELIVERY_PREFIX,
} from "./presentation-delivery-account.mjs";

/** One `NATIVE_COMPANION_TURN_DELIVERY` line, in the shape `host/src/companion-loop.ts` prints. */
const line = (account) => `NATIVE_COMPANION_TURN_DELIVERY ${JSON.stringify(account)}`;

/** One `EXECUTION_STALL` line, in the shape `host/src/host-service.ts` prints. */
const stall = (payload) => `${EXECUTION_STALL_PREFIX}${JSON.stringify(payload)}`;

/** One stall fact as the Host publishes it, with the fields a bundle keeps and the ones it re-reads from the last. */
const stallFact = (overrides = {}) => ({
  atMs: 1_764_000_000_000,
  kind: "execution_stalled",
  executionId: "exec_navigate",
  actionId: "navigate_to_destination",
  elapsedMs: 120_000,
  lastFactKind: "execution_receipt:running",
  stallFactsSoFar: 1,
  owner: null,
  endsOwnershipWith: null,
  ownershipAbsentReason: "no_body_owning_transition_in_progress",
  watched: 1,
  evicted: 0,
  ...overrides,
});

test("the bundle carries the stall facts the Host published, bounded, with what it omitted stated as zero when nothing", () => {
  const text = [stall(stallFact()), stall(stallFact({ elapsedMs: 480_000, stallFactsSoFar: 2 }))].join("\n");
  const watched = readStallWatch(text);
  assert.equal(watched.facts.length, 2);
  assert.equal(watched.omitted, 0, "a healthy run states omitted 0 rather than leaving the field out");
  assert.equal(watched.watched, 1, "the pump's own reading, off the last fact");
  assert.equal(watched.evicted, 0);
  assert.equal(watched.notMeasured, null);
  assert.deepEqual(watched.facts[1], {
    atMs: 1_764_000_000_000,
    executionId: "exec_navigate",
    actionId: "navigate_to_destination",
    elapsedMs: 480_000,
    lastFactKind: "execution_receipt:running",
    stallFactsSoFar: 2,
    owner: null,
    endsOwnershipWith: null,
    ownershipAbsentReason: "no_body_owning_transition_in_progress",
    watched: 1,
    evicted: 0,
  });
});

test("a run with more stalls than the bundle keeps says how many it hid", () => {
  const lines = [];
  for (let index = 0; index < MAX_BUNDLE_STALL_FACTS + 3; index += 1)
    lines.push(stall(stallFact({ executionId: `exec_${index}`, stallFactsSoFar: 1 })));
  const watched = readStallWatch(lines.join("\n"));
  assert.equal(watched.facts.length, MAX_BUNDLE_STALL_FACTS);
  assert.equal(watched.omitted, 3);
  assert.equal(
    watched.facts[0].executionId,
    "exec_0",
    "in arrival order: the first stall is the one that explains the run",
  );
});

test("a run that published no stall fact says not_measured instead of reporting zero stuck bodies", () => {
  const silent = readStallWatch("NATIVE_COMPANION_TURN_DELIVERY {}\nCOMPANION_ACTIVITY {}\n");
  assert.deepEqual(silent.facts, []);
  assert.equal(silent.omitted, 0);
  assert.equal(silent.watched, null, "a zero here would be a claim that nothing was stuck");
  assert.equal(silent.evicted, null);
  assert.equal(silent.notMeasured, "host_published_no_stall_fact");

  const unreadable = readStallWatch("EXECUTION_STALL {not json\n");
  assert.equal(unreadable.notMeasured, "execution_stall_fact_unreadable");
  assert.equal(unreadable.unreadable, 1);
  assert.equal(unreadable.watched, null);
});

test("a run's pieces and its account are the same population, and the reaction sounds are named as such", () => {
  // The round41 shape, reduced: 46 text parts presented as 46 pieces, plus the one sound each of the thirteen turns
  // opened with. 59 pieces, 59 accounted, nothing unexplained - which is the answer the bundle could not give.
  const records = [
    { textParts: 4, presented: 4, suppressed: {}, pieces: { text: 4, ahead: 1 } },
    { textParts: 42, presented: 42, suppressed: {}, pieces: { text: 42, ahead: 12 } },
  ];
  const account = summarizeDeliveryAccount({ records, piecesProduced: 59 });
  assert.deepEqual(account.pieces, { produced: 59, accounted: 59, unaccounted: 0, text: 46, ahead: 13 });
  assert.deepEqual(account.parts, {
    produced: 46,
    presented: 46,
    suppressed: {},
    missing: 0,
    mismatchedTurns: 0,
  });
  assert.equal(account.blocked, null);
  assert.match(
    describeDeliveryAccount(account),
    /^pieces produced 59 · accounted 59 · unaccounted 0 · parts produced 46 · presented 46 · suppressed 0 · missing 0 · turns 2 · reconciled$/u,
  );
});

test("a piece the account never named blocks the run and says which two numbers disagree", () => {
  // A turn that presented pieces but printed no record - the exact reading round41 could not rule out.
  const records = [{ textParts: 2, presented: 2, suppressed: {}, pieces: { text: 2, ahead: 0 } }];
  const account = summarizeDeliveryAccount({ records, piecesProduced: 15 });
  assert.equal(account.pieces.unaccounted, 13);
  assert.equal(account.blocked, "delivery_account_unaccounted_pieces");
  assert.match(describeDeliveryAccount(account), /pieces produced 15 · accounted 2 · unaccounted 13/u);
  assert.deepEqual(deliveryAccountClause(account), {
    id: "delivery_account",
    passed: false,
    reasonCode: "delivery_account_unaccounted_pieces",
  });
  // An account that could not be read blocks by name instead of throwing inside the verdict or passing on nothing.
  assert.deepEqual(deliveryAccountClause(undefined), {
    id: "delivery_account",
    passed: false,
    reasonCode: "delivery_account_absent",
  });
});

test("parts that do not add up block the run and print the three populations and the leftover", () => {
  const records = [{ textParts: 3, presented: 1, suppressed: {}, pieces: { text: 1, ahead: 0 } }];
  const account = summarizeDeliveryAccount({ records, piecesProduced: 1 });
  assert.equal(account.parts.missing, 2, "two parts reached neither the player nor a named suppression");
  assert.equal(account.blocked, "delivery_account_parts_do_not_add_up");
  assert.deepEqual(deliveryAccountClause(account), {
    id: "delivery_account",
    passed: false,
    reasonCode: "delivery_account_parts_do_not_add_up",
  });
  assert.match(describeDeliveryAccount(account), /delivery_mismatch:produced=3;presented=1;suppressed=0;missing=2$/u);
});

test("two turns that err in opposite directions do not cancel: the run-level totals can agree while no turn does", () => {
  // The reading this gate exists for. Each turn's own numbers are a small lie (+2, -2); summed with signs they are zero,
  // so the old account reported `unaccounted 0` and passed a run in which two turns had lost text. The totals still
  // agree - 4 produced, 4 presented - which is why the per-turn identity is checked and not only the aggregate.
  const records = [
    { textParts: 3, presented: 1, suppressed: {}, pieces: { text: 1, ahead: 0 } },
    { textParts: 1, presented: 3, suppressed: {}, pieces: { text: 3, ahead: 0 } },
  ];
  const account = summarizeDeliveryAccount({ records, piecesProduced: 4 });
  assert.equal(
    account.parts.missing,
    0,
    "the aggregate identity does hold, which is exactly why it alone is not enough",
  );
  assert.equal(account.parts.mismatchedTurns, 2);
  assert.equal(account.blocked, "delivery_account_parts_do_not_add_up");
  const described = describeDeliveryAccount(account);
  assert.match(described, /turns mismatched 2/u);
  assert.match(described, /delivery_mismatch:produced=4;presented=4;suppressed=0;missing=0$/u);
  assert.deepEqual(deliveryAccountClause(account), {
    id: "delivery_account",
    passed: false,
    reasonCode: "delivery_account_parts_do_not_add_up",
  });
});

test("a run that presented nothing and printed nothing says so instead of agreeing with itself", () => {
  const account = summarizeDeliveryAccount({ records: [], piecesProduced: 0 });
  assert.equal(account.blocked, null, "nothing to deliver is not a broken account");
  assert.equal(account.nothingPresented, true);
  assert.match(describeDeliveryAccount(account), /nothing presented$/u);
});

test("pieces with no records at all are an absent account, never a pass", () => {
  const account = summarizeDeliveryAccount({ records: [], piecesProduced: 7 });
  assert.equal(account.blocked, "delivery_account_absent");
  assert.equal(account.pieces.unaccounted, 7);
});

test("an unreadable record is counted, because an account nobody could read did not agree", () => {
  const text = [
    line({ textParts: 1, presented: 1, suppressed: {}, pieces: { text: 1, ahead: 0 } }),
    `${TURN_DELIVERY_PREFIX}{not json`,
  ].join("\n");
  const read = readTurnDeliveryRecords(text);
  assert.equal(read.records.length, 1);
  assert.equal(read.unparsable, 1);
  assert.equal(summarizeDeliveryAccount({ ...read, piecesProduced: 1 }).blocked, "delivery_account_unreadable");
});

test("the written bundle is judged by the same invariant, and an old bundle blocks rather than passing", () => {
  const reconciled = summarizeDeliveryAccount({
    records: [{ textParts: 1, presented: 1, suppressed: {}, pieces: { text: 1, ahead: 1 } }],
    piecesProduced: 2,
  });
  assert.deepEqual(assessBundleDeliveryAccount({ presentation: { pieceCount: 2, deliveryAccount: reconciled } }), {
    ok: true,
    code: "delivery_account_reconciled",
    detail: describeDeliveryAccount(reconciled),
  });
  // A bundle written before the account existed cannot answer the question, so it does not answer "passed".
  assert.equal(assessBundleDeliveryAccount({ presentation: { pieceCount: 59 } }).code, "delivery_account_absent");
  assert.equal(assessBundleDeliveryAccount({}).code, "delivery_account_bundle_without_presentation");
  // A bundle whose own piece count disagrees with the account it carries is the drift this gate exists for.
  assert.equal(
    assessBundleDeliveryAccount({ presentation: { pieceCount: 60, deliveryAccount: reconciled } }).code,
    "delivery_account_pieces_produced_disagrees",
  );
  // And a hand-written account whose sum does not hold is refused even though its `blocked` is null.
  const brokenSum = { ...reconciled, blocked: null, pieces: { ...reconciled.pieces, accounted: 1 } };
  assert.equal(
    assessBundleDeliveryAccount({ presentation: { pieceCount: 2, deliveryAccount: brokenSum } }).code,
    "delivery_account_sum_does_not_hold",
  );
  // The same hand-written reading in the PARTS population: 1 produced, 1 presented, nothing withheld - yet the account
  // claims another part was shown. Before this check the comparison subtracted the account's own residual, so it could
  // not be false and this bundle passed.
  const brokenParts = {
    ...reconciled,
    blocked: null,
    parts: { ...reconciled.parts, presented: 2, missing: -1 },
  };
  const partsVerdict = assessBundleDeliveryAccount({ presentation: { pieceCount: 2, deliveryAccount: brokenParts } });
  assert.equal(partsVerdict.code, "delivery_account_parts_do_not_add_up");
  assert.match(partsVerdict.detail, /delivery_mismatch:produced=1;presented=2;suppressed=0;missing=-1$/u);
});
