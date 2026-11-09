import assert from "node:assert/strict";
import test from "node:test";
import {
  assessBundleDeliveryAccount,
  deliveryAccountClause,
  describeDeliveryAccount,
  readTurnDeliveryRecords,
  summarizeDeliveryAccount,
  TURN_DELIVERY_PREFIX,
} from "./presentation-delivery-account.mjs";

/** One `NATIVE_COMPANION_TURN_DELIVERY` line, in the shape `host/src/companion-loop.ts` prints. */
const line = (account) => `NATIVE_COMPANION_TURN_DELIVERY ${JSON.stringify(account)}`;

test("a run's pieces and its account are the same population, and the reaction sounds are named as such", () => {
  // The round41 shape, reduced: 46 text parts presented as 46 pieces, plus the one sound each of the thirteen turns
  // opened with. 59 pieces, 59 accounted, nothing unexplained - which is the answer the bundle could not give.
  const records = [
    { textParts: 4, presented: 4, suppressed: {}, unaccounted: 0, pieces: { text: 4, ahead: 1 } },
    { textParts: 42, presented: 42, suppressed: {}, unaccounted: 0, pieces: { text: 42, ahead: 12 } },
  ];
  const account = summarizeDeliveryAccount({ records, piecesProduced: 59 });
  assert.deepEqual(account.pieces, { produced: 59, accounted: 59, unaccounted: 0, text: 46, ahead: 13 });
  assert.deepEqual(account.parts, { produced: 46, presented: 46, suppressed: {}, unaccounted: 0 });
  assert.equal(account.blocked, null);
  assert.match(
    describeDeliveryAccount(account),
    /^pieces produced 59 · accounted 59 · unaccounted 0 · parts produced 46 · presented 46 · unaccounted 0 · turns 2 · reconciled$/u,
  );
});

test("a piece the account never named blocks the run and says which two numbers disagree", () => {
  // A turn that presented pieces but printed no record - the exact reading round41 could not rule out.
  const records = [{ textParts: 2, presented: 2, suppressed: {}, unaccounted: 0, pieces: { text: 2, ahead: 0 } }];
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

test("a part no layer named is its own block, in the parts population", () => {
  const records = [{ textParts: 3, presented: 1, suppressed: {}, unaccounted: 2, pieces: { text: 1, ahead: 0 } }];
  const account = summarizeDeliveryAccount({ records, piecesProduced: 1 });
  assert.equal(account.parts.unaccounted, 2, "two parts reached neither the player nor a named suppression");
  assert.equal(account.blocked, "delivery_account_unaccounted_parts");
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
    line({ textParts: 1, presented: 1, suppressed: {}, unaccounted: 0, pieces: { text: 1, ahead: 0 } }),
    `${TURN_DELIVERY_PREFIX}{not json`,
  ].join("\n");
  const read = readTurnDeliveryRecords(text);
  assert.equal(read.records.length, 1);
  assert.equal(read.unparsable, 1);
  assert.equal(summarizeDeliveryAccount({ ...read, piecesProduced: 1 }).blocked, "delivery_account_unreadable");
});

test("the written bundle is judged by the same invariant, and an old bundle blocks rather than passing", () => {
  const reconciled = summarizeDeliveryAccount({
    records: [{ textParts: 1, presented: 1, suppressed: {}, unaccounted: 0, pieces: { text: 1, ahead: 1 } }],
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
});
