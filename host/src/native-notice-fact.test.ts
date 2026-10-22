import assert from "node:assert/strict";
import test from "node:test";

import { CompanionLoop } from "./companion-loop.js";
import type { WorldFact } from "./event-pump.js";
import { CompanionHostService } from "./host-service.js";
import {
  MAX_REMEMBERED_NATIVE_NOTICES,
  NATIVE_NOTICE_SEMANTIC_KIND,
  NATIVE_NOTICE_SOURCE,
  NativeNoticeLedger,
} from "./native-notice-fact.js";

function reducedSession(sendUserMessage: (text: string) => Promise<void> | void) {
  return { sendUserMessage, async abort() {}, clearQueue() {}, async waitForIdle() {} };
}

function eventHarness() {
  let factListener: ((fact: WorldFact) => void) | undefined;
  return {
    events: {
      onFact(next: (fact: WorldFact) => void) {
        factListener = next;
        return () => {
          factListener = undefined;
        };
      },
      onLifecycle() {
        return () => {};
      },
    },
    emit(fact: WorldFact) {
      factListener?.(fact);
    },
  };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const snapshotFact = (revision: number, dayOfMonth: number): WorldFact => ({
  source: "stardew_mod",
  kind: "snapshot",
  eventId: `snapshot_${String(revision)}`,
  occurredAtMs: 1_000 + revision,
  correlationId: `snapshot_${String(revision)}`,
  revision,
  payload: {
    revision,
    presentationLocale: "en-US",
    timeOfDay: 2_400,
    dayOfMonth,
    seasonIndex: 0,
    year: 1,
    weather: "clear",
    location: "FarmHouse",
  },
});

/** A receipt as the Mod publishes it: `nativeNotices` is the raw HUD text seen in the action's window. */
const receiptFact = (
  executionId: string,
  state: string,
  nativeNotices: readonly string[] | undefined,
  inGameTime = "2400",
): WorldFact => ({
  source: "stardew_mod",
  kind: "execution_receipt",
  eventId: `receipt_${executionId}`,
  occurredAtMs: 2_000,
  correlationId: executionId,
  revision: 1,
  executionId,
  requestId: `request_${executionId}`,
  payload: {
    executionId,
    requestId: `request_${executionId}`,
    actionId: "move_to_tile",
    state,
    reasonCode: "native_path_ended",
    revision: 1,
    evidence: null,
    observation: {
      location: "Farm",
      tileX: 12,
      tileY: 9,
      facing: 2,
      inGameTime,
      playerNearby: true,
      revision: 1,
    },
    ...(nativeNotices === undefined ? {} : { nativeNotices }),
  },
});

const noticesIn = (batch: string): readonly Readonly<Record<string, unknown>>[] =>
  (JSON.parse(batch) as { worldFacts: readonly Readonly<Record<string, unknown>>[] }).worldFacts.filter(
    (fact) => fact.semanticKind === NATIVE_NOTICE_SEMANTIC_KIND,
  );

test("an idle companion learns the clock: a notice reaches the conversation once, as the game's words, with nothing in flight", async () => {
  const adapter = eventHarness();
  const delivered: string[] = [];
  const opened: string[] = [];
  const loop = new CompanionLoop(
    reducedSession((text) => {
      delivered.push(text);
    }) as never,
    {
      beginPlayerBatch(sourceEventId) {
        opened.push(sourceEventId);
      },
      endBatch() {},
    },
  );
  const service = new CompanionHostService(loop, adapter.events);
  try {
    // Between plans: no player input, no execution command outstanding. A HELD progress receipt cannot open a turn
    // by itself, so a notice riding one is exactly the case that used to be lost.
    assert.equal(loop.pump.hasPendingDelivery, false, "the companion is idle before the notice arrives");
    assert.equal(loop.pump.hasPendingPlayerInput, false);

    adapter.emit(receiptFact("exec_late_1", "running", ["It's getting late..."]));
    await settle();

    assert.equal(delivered.length, 1, "the notice alone wakes the companion exactly one turn");
    const batch = JSON.parse(delivered[0]!) as Readonly<Record<string, unknown>>;
    assert.equal(batch.kind, "gamebuddy_fact_batch");
    // Not shaped as the player speaking: the fact batch's player-input lane is empty, and the notice travels as a
    // world fact of its own rather than as a receipt field or a player message.
    assert.deepEqual(batch.playerInputs, [], "the notice is not player text");
    const notices = noticesIn(delivered[0]!);
    assert.equal(notices.length, 1, "the notice appears once, with its own identity");
    const notice = notices[0]!;
    const payload = notice.payload as Readonly<Record<string, unknown>>;
    assert.equal(payload.notice, "It's getting late...", "the game's own words are quoted verbatim");
    // No imperative: the notice reports the hour and names who showed it - it never tells her what to do.
    assert.equal(payload.text, "The game's own notice: It's getting late...");
    assert.doesNotMatch(String(payload.text), /\b(go|head in|should|must|need to|bed|sleep)\b/iu);
    // The whitelist is what lets her answer reach the chat: the notice opens its own presentation lease.
    assert.deepEqual(opened, [String(notice.sourceEventId)]);
    assert.match(opened[0]!, /^[A-Za-z0-9_-]{1,128}$/u);
  } finally {
    service.close();
  }
});

test("one delivery per identity: a repeated notice is not re-announced, and the next game day's same line is", async () => {
  const adapter = eventHarness();
  const delivered: string[] = [];
  const loop = new CompanionLoop(
    reducedSession((text) => {
      delivered.push(text);
    }) as never,
  );
  const service = new CompanionHostService(loop, adapter.events);
  try {
    // The world day is read from the Mod's snapshot; a snapshot is held state and never a turn of its own.
    adapter.emit(snapshotFact(1, 4));
    adapter.emit(receiptFact("exec_late_1", "running", ["It's getting late..."]));
    await settle();
    assert.equal(delivered.length, 1);

    // The engine leaves the line on screen for a few seconds, so every later action's window sees it again. The same
    // notice identity must not be delivered twice.
    adapter.emit(receiptFact("exec_late_2", "running", ["It's getting late..."]));
    adapter.emit(receiptFact("exec_late_3", "running", ["It's getting late...", "It's getting late..."]));
    await settle();
    assert.equal(delivered.length, 1, "the repeated notice produces no further turn");

    // Day five says the same line at the same hour. It is a new notice, not a repeat.
    adapter.emit(snapshotFact(2, 5));
    adapter.emit(receiptFact("exec_late_4", "running", ["It's getting late..."]));
    await settle();
    assert.equal(delivered.length, 2, "the next night's identical line is delivered again");
    assert.equal(noticesIn(delivered[1]!).length, 1);

    // A receipt that captured no notice adds nothing, which is the ordinary case for most actions.
    const before = delivered.length;
    adapter.emit(receiptFact("exec_quiet_1", "running", undefined));
    await settle();
    assert.equal(delivered.length, before, "a receipt without notices mints no notice fact");
  } finally {
    service.close();
  }
});

test("the remembered identities are bounded and the framing follows the world's own presentation locale", () => {
  const ledger = new NativeNoticeLedger();
  ledger.observeSnapshot({ revision: 1, presentationLocale: "zh-CN", dayOfMonth: 4, seasonIndex: 0, year: 1 });
  const [first] = ledger.admit({ executionId: "exec_zh", nativeNotices: ["已经很晚了……"] } as never, 1);
  assert.equal((first!.contextProjection as Record<string, unknown>).text, "游戏自己的提示：已经很晚了……");
  assert.equal(first!.source, NATIVE_NOTICE_SOURCE);

  const bounded = new NativeNoticeLedger();
  bounded.observeSnapshot({ revision: 1, presentationLocale: "en-US", dayOfMonth: 4, seasonIndex: 0, year: 1 });
  for (let index = 0; index <= MAX_REMEMBERED_NATIVE_NOTICES; index++) {
    assert.equal(
      bounded.admit(
        { executionId: `exec_${String(index)}`, nativeNotices: [`notice ${String(index)}`] } as never,
        index,
      ).length,
      1,
      "each distinct notice is its own identity",
    );
  }
  // The oldest identity was evicted, so the set can never grow with the session.
  assert.equal(bounded.admit({ executionId: "exec_again", nativeNotices: ["notice 0"] } as never, 0).length, 1);
  assert.equal(bounded.admit({ executionId: "exec_repeat", nativeNotices: ["notice 0"] } as never, 0).length, 0);
});
