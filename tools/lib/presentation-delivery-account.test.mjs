import assert from "node:assert/strict";
import test from "node:test";
import {
  assessBundleDeliveryAccount,
  deliveryAccountClause,
  describeDeliveryAccount,
  describeSpeechFrequency,
  EXECUTION_STALL_PREFIX,
  MAX_BUNDLE_STALL_FACTS,
  readStallWatch,
  readTurnDeliveryRecords,
  readWorldStateStaleFacts,
  summarizeDeliveryAccount,
  summarizeSpeechFrequency,
  TURN_DELIVERY_PREFIX,
  WORLD_STATE_STALE_PREFIX,
} from "./presentation-delivery-account.mjs";

/** One `WORLD_STATE_STALE` line, in the shape `host/src/host-service.ts` prints. */
const stale = (payload) => `${WORLD_STATE_STALE_PREFIX}${JSON.stringify(payload)}`;

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

test("the bundle carries the stale-world facts the Host published, or names why it carries none", () => {
  const text = [
    stale({
      atMs: 1_790_000_000_000,
      code: "world_state_stale:5;352;61000",
      turns: 5,
      revision: 352,
      ageMs: 61_000,
      staleFactsSoFar: 1,
    }),
    stale({
      atMs: 1_790_000_600_000,
      code: "world_state_stale:20;352;540000",
      turns: 20,
      revision: 352,
      ageMs: 540_000,
      staleFactsSoFar: 2,
    }),
  ].join("\n");
  const read = readWorldStateStaleFacts(text);
  assert.equal(read.facts.length, 2);
  assert.equal(read.omitted, 0);
  assert.equal(read.notMeasured, null);
  assert.equal(read.facts[1].turns, 20);
  assert.equal(read.facts[1].revision, 352);

  const silent = readWorldStateStaleFacts(stall(stallFact()));
  assert.deepEqual(silent.facts, [], "a run that never re-read its world published nothing here");
  assert.equal(silent.notMeasured, "host_published_no_world_state_stale_fact");
  const unreadable = readWorldStateStaleFacts("WORLD_STATE_STALE {not json\n");
  assert.equal(unreadable.notMeasured, "world_state_stale_fact_unreadable");
  assert.equal(unreadable.unreadable, 1);
});

test("a run's committed bubbles and its account are the same population, one per turn", () => {
  // The per-turn record in the shape `companion-loop.ts` now prints: two turns that rolled four messages into two
  // bubbles. The population the runner counts (`presentation.pieceCount`) and the population the Host names have to be
  // the same number, and when they are not the account blocks instead of leaving the difference to a reader.
  const records = [
    {
      textParts: 3,
      presented: 3,
      suppressed: {},
      bubbles: 1,
      messages: { count: 2, ids: ["msg_a1", "msg_a2"] },
      bubble: { chars: 74, truncatedChars: 0, sentencesDropped: 0 },
    },
    {
      textParts: 43,
      presented: 43,
      suppressed: {},
      bubbles: 1,
      messages: { count: 2, ids: ["msg_b1", "msg_b2"] },
      bubble: { chars: 80, truncatedChars: 22, sentencesDropped: 2 },
    },
  ];
  const account = summarizeDeliveryAccount({ records, bubblesProduced: 2 });
  assert.deepEqual(account.bubbles, {
    produced: 2,
    accounted: 2,
    unaccounted: 0,
    turns: 2,
    perTurnMax: 1,
    overOne: [],
    truncatedTurns: 1,
    truncatedChars: 22,
  });
  assert.deepEqual(account.rollUp, { messages: 4, bubbles: 2 });
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
    /^bubbles produced 2 · accounted 2 · unaccounted 0 · parts produced 46 · presented 46 · suppressed 0 · missing 0 · turns examined 2 · bubbles 2 · per-turn max 1 · messages rolled up: 4 into 2 · bubbles truncated 1 \(chars 22\) · reconciled · bubbles 0 · nothing was delivered/u,
  );
});

test("a turn that presents two bubbles blocks the run by name and says which turn and which messages", () => {
  // THE CADENCE GATE. The population is every prompt turn's delivery record, never a count of assistant messages:
  // MEASURED 2026-11-11 (round46b, 15 minutes): 27 prompt turns produced 55 assistant messages and 49 bubbles, because
  // each message was presented as a reply of its own. A run in that shape must not be able to call itself reconciled.
  const records = [
    { textParts: 1, presented: 1, suppressed: {}, bubbles: 1, messages: { count: 1, ids: ["msg_one"] } },
    {
      textParts: 2,
      presented: 2,
      suppressed: {},
      bubbles: 2,
      messages: { count: 2, ids: ["msg_two_a", "msg_two_b"] },
    },
    { textParts: 1, presented: 1, suppressed: {}, bubbles: 1, messages: { count: 1, ids: ["msg_three"] } },
  ];
  const account = summarizeDeliveryAccount({ records, bubblesProduced: 4 });
  assert.equal(account.bubbles.perTurnMax, 2);
  assert.deepEqual(account.bubbles.overOne, [{ turn: 2, bubbles: 2, messageIds: ["msg_two_a", "msg_two_b"] }]);
  assert.equal(account.blocked, "bubble_per_turn_over_one");
  const described = describeDeliveryAccount(account);
  assert.match(described, /bubble_per_turn_over_one:turn#2:2:msg_two_a,msg_two_b/u);
  assert.match(described, /per-turn max 2 · messages rolled up: 4 into 4/u);
  assert.deepEqual(deliveryAccountClause(account), {
    id: "delivery_account",
    passed: false,
    reasonCode: "bubble_per_turn_over_one",
  });
});

test("a bubble the account never named blocks the run and says which two numbers disagree", () => {
  // A turn that presented a bubble but printed no record - the exact reading round41 could not rule out.
  const records = [{ textParts: 2, presented: 2, suppressed: {}, bubbles: 1, messages: { count: 1, ids: ["msg_a"] } }];
  const account = summarizeDeliveryAccount({ records, bubblesProduced: 15 });
  assert.equal(account.bubbles.unaccounted, 14);
  assert.equal(account.blocked, "delivery_account_unaccounted_pieces");
  assert.match(describeDeliveryAccount(account), /bubbles produced 15 · accounted 1 · unaccounted 14/u);
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
  const records = [{ textParts: 3, presented: 1, suppressed: {}, bubbles: 1, messages: { count: 1, ids: ["msg_a"] } }];
  const account = summarizeDeliveryAccount({ records, bubblesProduced: 1 });
  assert.equal(account.parts.missing, 2, "two parts reached neither the player nor a named suppression");
  assert.equal(account.blocked, "delivery_account_parts_do_not_add_up");
  assert.deepEqual(deliveryAccountClause(account), {
    id: "delivery_account",
    passed: false,
    reasonCode: "delivery_account_parts_do_not_add_up",
  });
  assert.match(
    describeDeliveryAccount(account),
    /delivery_mismatch:produced=3;presented=1;suppressed=0;missing=2 · bubbles 0 · nothing was delivered/u,
  );
});

test("two turns that err in opposite directions do not cancel: the run-level totals can agree while no turn does", () => {
  // The reading this gate exists for. Each turn's own numbers are a small lie (+2, -2); summed with signs they are zero,
  // so the old account reported `unaccounted 0` and passed a run in which two turns had lost text. The totals still
  // agree - 4 produced, 4 presented - which is why the per-turn identity is checked and not only the aggregate.
  const records = [
    { textParts: 3, presented: 1, suppressed: {}, bubbles: 1, messages: { count: 1, ids: ["msg_a"] } },
    { textParts: 1, presented: 3, suppressed: {}, bubbles: 1, messages: { count: 1, ids: ["msg_b"] } },
  ];
  const account = summarizeDeliveryAccount({ records, bubblesProduced: 2 });
  assert.equal(
    account.parts.missing,
    0,
    "the aggregate identity does hold, which is exactly why it alone is not enough",
  );
  assert.equal(account.parts.mismatchedTurns, 2);
  assert.equal(account.blocked, "delivery_account_parts_do_not_add_up");
  const described = describeDeliveryAccount(account);
  assert.match(described, /turns mismatched 2/u);
  assert.match(
    described,
    /delivery_mismatch:produced=4;presented=4;suppressed=0;missing=0 · bubbles 0 · nothing was delivered/u,
  );
  assert.deepEqual(deliveryAccountClause(account), {
    id: "delivery_account",
    passed: false,
    reasonCode: "delivery_account_parts_do_not_add_up",
  });
});

test("a run that presented nothing and printed nothing says so instead of agreeing with itself", () => {
  const account = summarizeDeliveryAccount({ records: [], bubblesProduced: 0 });
  assert.equal(account.blocked, null, "nothing to deliver is not a broken account");
  assert.equal(account.nothingPresented, true);
  assert.match(describeDeliveryAccount(account), /nothing presented · bubbles 0 · nothing was delivered/u);
});

test("bubbles with no records at all are an absent account, never a pass", () => {
  const account = summarizeDeliveryAccount({ records: [], bubblesProduced: 7 });
  assert.equal(account.blocked, "delivery_account_absent");
  assert.equal(account.bubbles.unaccounted, 7);
});

test("an unreadable record is counted, because an account nobody could read did not agree", () => {
  const text = [
    line({ textParts: 1, presented: 1, suppressed: {}, bubbles: 1, messages: { count: 1, ids: ["msg_a"] } }),
    `${TURN_DELIVERY_PREFIX}{not json`,
  ].join("\n");
  const read = readTurnDeliveryRecords(text);
  assert.equal(read.records.length, 1);
  assert.equal(read.unparsable, 1);
  assert.equal(summarizeDeliveryAccount({ ...read, bubblesProduced: 1 }).blocked, "delivery_account_unreadable");
});

test("the written bundle is judged by the same invariant, and an old bundle blocks rather than passing", () => {
  const reconciled = summarizeDeliveryAccount({
    records: [{ textParts: 1, presented: 1, suppressed: {}, bubbles: 1, messages: { count: 1, ids: ["msg_a"] } }],
    bubblesProduced: 1,
  });
  assert.deepEqual(assessBundleDeliveryAccount({ presentation: { pieceCount: 1, deliveryAccount: reconciled } }), {
    ok: true,
    code: "delivery_account_reconciled",
    detail: describeDeliveryAccount(reconciled),
  });
  // A bundle written before the account existed cannot answer the question, so it does not answer "passed".
  assert.equal(assessBundleDeliveryAccount({ presentation: { pieceCount: 59 } }).code, "delivery_account_absent");
  assert.equal(assessBundleDeliveryAccount({}).code, "delivery_account_bundle_without_presentation");
  // A bundle whose account predates the bubble unit cannot answer the cadence question either.
  const oldShape = { ...reconciled, bubbles: undefined, pieces: { produced: 1, accounted: 1, unaccounted: 0 } };
  assert.equal(
    assessBundleDeliveryAccount({ presentation: { pieceCount: 1, deliveryAccount: oldShape } }).code,
    "delivery_account_bubbles_absent",
  );
  // A bundle whose own count disagrees with the account it carries is the drift this gate exists for.
  assert.equal(
    assessBundleDeliveryAccount({ presentation: { pieceCount: 2, deliveryAccount: reconciled } }).code,
    "delivery_account_pieces_produced_disagrees",
  );
  // And a hand-written account whose sum does not hold is refused even though its `blocked` is null.
  const brokenSum = { ...reconciled, blocked: null, bubbles: { ...reconciled.bubbles, accounted: 0 } };
  assert.equal(
    assessBundleDeliveryAccount({ presentation: { pieceCount: 1, deliveryAccount: brokenSum } }).code,
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
  const partsVerdict = assessBundleDeliveryAccount({ presentation: { pieceCount: 1, deliveryAccount: brokenParts } });
  assert.equal(partsVerdict.code, "delivery_account_parts_do_not_add_up");
  assert.match(partsVerdict.detail, /delivery_mismatch:produced=1;presented=2;suppressed=0;missing=-1$/u);
});

/**
 * `round73`'s own delivered bubbles, verbatim from its `result.json`, with the moments the port committed them at.
 *
 * The seven are the run this reading was written for: the audit counted them by hand off `run-progress.jsonl` and got
 * seven bubbles in 252 s, one every 36 s, with a 7-second gap between the third and the fourth. Nothing in the artifact
 * said any of it, which is why the numbers live here as the red case rather than in a sentence.
 */
const ROUND73_PIECES = [
  { index: 0, atMs: 1794984854863, text: "醒了就起，趁日头还软。门口那三棵花椰菜该掰了，我出门了。" },
  { index: 1, atMs: 1794984901571, text: "嗯。 行，镇上你去忙，家里这摊我收拾。" },
  { index: 2, atMs: 1794984918904, text: "还剩一棵花椰菜卡在那块地上，我绕到它边上再掰。" },
  { index: 3, atMs: 1794984926037, text: "掰下来了。这边草和石头我接着往西捋。" },
  { index: 4, atMs: 1794984998509, text: "西头这片的草有点密，我顺着往西捋。" },
  { index: 5, atMs: 1794985036604, text: "西头这一圈总算能看出地皮了，地上落的东西我也顺手揣进兜里。" },
  { index: 6, atMs: 1794985051954, text: "树桩一个个挖掉，地上散的木头也捡了。" },
];
const ROUND73_WINDOW = { startedAtMs: 1794984809363, endedAtMs: 1794985062407 };

test("the run reports how often she spoke from its own pieces, not from a count taken by hand", () => {
  // RED ON REAL HISTORY: this is round73's own bundle, and before this reading the run published `pieceCount 7` and an
  // account of `bubbles accounted 7` - both true, neither able to answer "how often did she talk", so the audit answered
  // it by counting a progress log by hand.
  const speech = summarizeDeliveryAccount({
    records: ROUND73_PIECES.map(() => ({ textParts: 1, presented: 1, suppressed: {}, bubbles: 1 })),
    bubblesProduced: ROUND73_PIECES.length,
    pieces: ROUND73_PIECES,
    window: ROUND73_WINDOW,
  }).speech;
  assert.equal(speech.bubbles, ROUND73_PIECES.length, "the population is every delivered bubble");
  assert.equal(speech.spanMs, ROUND73_WINDOW.endedAtMs - ROUND73_WINDOW.startedAtMs);
  // The properties, not today's numbers: the rate is the span divided by the bubbles, and the shortest gap is the
  // smallest adjacent difference - recomputed here from the same inputs by a different route.
  assert.equal(speech.oneEveryMs, Math.round(speech.spanMs / ROUND73_PIECES.length));
  const gaps = ROUND73_PIECES.slice(1).map((piece, index) => piece.atMs - ROUND73_PIECES[index].atMs);
  assert.equal(speech.shortestGapMs, Math.min(...gaps));
  assert.equal(
    gaps[speech.shortestGap.fromIndex],
    speech.shortestGapMs,
    "the gap is named by the two pieces it sits between, so a reader can open them",
  );
  assert.equal(speech.shortestGap.toIndex, speech.shortestGap.fromIndex + 1);
  assert.equal(speech.notMeasured, null);
  // The sentence the run prints for itself, in the two numbers a frequency claim needs.
  assert.match(
    describeSpeechFrequency(speech),
    /^bubbles 7 over 253 s = one every 36\.1 s · shortest gap 7\.1 s · turns 7$/u,
  );
});

test("a run that delivered nothing reports zero bubbles and the reason, never nothing at all", () => {
  const silent = summarizeDeliveryAccount({ records: [], bubblesProduced: 0, pieces: [], window: ROUND73_WINDOW });
  assert.equal(silent.speech.bubbles, 0);
  assert.equal(silent.speech.notMeasured, "run_presented_no_bubble");
  assert.equal(silent.speech.oneEveryMs, null, "a rate with no numerator is not a rate");
  assert.equal(silent.speech.shortestGapMs, null);
  assert.match(describeSpeechFrequency(silent.speech), /^bubbles 0 · nothing was delivered/u);
});

test("the three zeroes are told apart: no bubble, no window, and one bubble that cannot make a gap", () => {
  const oneBubble = summarizeDeliveryAccount({
    records: [],
    bubblesProduced: 1,
    pieces: [{ index: 0, atMs: 1794984854863 }],
    window: ROUND73_WINDOW,
  }).speech;
  assert.equal(oneBubble.notMeasured, "fewer_than_two_bubbles_on_the_run_clock");
  assert.equal(
    oneBubble.oneEveryMs,
    ROUND73_WINDOW.endedAtMs - ROUND73_WINDOW.startedAtMs,
    "one bubble over the span is still a rate",
  );
  assert.equal(oneBubble.shortestGapMs, null);
  const noWindow = summarizeDeliveryAccount({
    records: [],
    bubblesProduced: 2,
    pieces: ROUND73_PIECES.slice(0, 2),
  }).speech;
  assert.equal(noWindow.notMeasured, "run_window_not_recorded");
  assert.equal(noWindow.oneEveryMs, null);
  assert.equal(
    noWindow.shortestGapMs,
    ROUND73_PIECES[1].atMs - ROUND73_PIECES[0].atMs,
    "the gap needs no window: it is between two pieces that carry moments",
  );
  // A bundle that predates the absolute clock carries `elapsedMs` against a turn start, so it has no gap this can
  // measure - and says so rather than reporting the one it can place as if it were the only one.
  const unplaced = summarizeDeliveryAccount({
    records: [],
    bubblesProduced: 3,
    pieces: [
      { index: 0, elapsedMs: 1_000 },
      { index: 1, elapsedMs: 2_000 },
      { index: 2, atMs: 3_000 },
    ],
    window: ROUND73_WINDOW,
  }).speech;
  assert.equal(unplaced.placedBubbles, 1);
  assert.equal(unplaced.bubbles, 3, "every delivered bubble is counted, placed or not");
  assert.equal(unplaced.shortestGapMs, null);
  assert.equal(unplaced.notMeasured, "fewer_than_two_bubbles_on_the_run_clock");
});

test("an even cadence reads as an even cadence: seven bubbles seven seconds apart are a 7-second shortest gap", () => {
  // THE FALSIFIER the frequency reading needs. If the shortest gap could not come out at a value other than round73's,
  // the reading would be decoration: this input makes it 7 s by construction, and the rate 7 s too.
  const metronome = Array.from({ length: 7 }, (_, index) => ({ index, atMs: index * 7_000 }));
  const speech = summarizeDeliveryAccount({
    records: [],
    bubblesProduced: metronome.length,
    pieces: metronome,
    window: { startedAtMs: 0, endedAtMs: 49_000 },
  }).speech;
  assert.equal(speech.shortestGapMs, 7_000);
  assert.equal(speech.oneEveryMs, 7_000);
  assert.match(describeSpeechFrequency(speech), /bubbles 7 over 49 s = one every 7 s · shortest gap 7 s · turns 0/u);
  // And the reading is not a constant in the other direction either: double the spacing and both numbers move.
  const spaced = summarizeDeliveryAccount({
    records: [],
    bubblesProduced: metronome.length,
    pieces: metronome.map((piece) => ({ ...piece, atMs: piece.atMs * 2 })),
    window: { startedAtMs: 0, endedAtMs: 98_000 },
  }).speech;
  assert.equal(spaced.shortestGapMs, 14_000);
  assert.equal(spaced.oneEveryMs, 14_000);
});
