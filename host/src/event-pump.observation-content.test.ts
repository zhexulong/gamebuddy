import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTO_OBSERVE_UNAVAILABLE,
  CompanionEventPump,
  type PendingBatch,
  TURN_OPENING,
  TURN_SUPPRESSION,
  type TurnDecision,
  turnAccountLine,
  type WorldFact,
  type WorldStateRefreshPort,
} from "./event-pump.js";

/**
 * WHAT THE SUPPRESSOR COMPARES, read off the real pump.
 *
 * <p>
 * `observation_restated` decides whether a flush that carries an observation is worth a turn, and until this unit it asked
 * its question of the snapshot's `revision`. That number is the Mod's action-echo counter: it moves inside action handlers
 * (`farmhandexecutioncontroller.cs:1779`, `:348`) and not when the world does - a time milestone is published as its own
 * fact carrying the UNCHANGED revision (`StardewSalientEventHooks.cs:196-207`). So the predicate was blind in both
 * directions, and both were measured (`round53`, `round46b`): a reading whose clock walked 06:10 -> 11:30, whose location
 * changed, whose stamina fell to 41 and whose weather turned to rain was suppressed as a re-statement because no action
 * had run, while a byte-identical payload carrying a bumped revision opened a turn to say what the previous turn had
 * already said - the exact defect the suppression list exists to close.
 * </p>
 *
 * <p>
 * The property this file asserts is a comparison of CONTENT: a flush opens a turn when the reading says something the one
 * she was shown did not, and stays shut when it does not, whatever the counter says. Each row is the same pump with one
 * field of the reading changed, and the expectation is in the test's name.
 * </p>
 */

/** The reading the Mod admitted: a free body in the farmhouse at 06:00 (the `round53` fixture, field for field). */
const READING = Object.freeze({
  revision: 352,
  location: "FarmHouse",
  tile: Object.freeze({ x: 9, y: 9 }),
  stamina: 270,
  health: 100,
  actionable: true,
  capabilities: Object.freeze([]),
  catalogRevision: 3,
  enabledActionIds: Object.freeze([]),
  presentationLocale: "zh-CN",
  exhausted: false,
  timeOfDay: 600,
  dayOfMonth: 6,
  seasonIndex: 0,
  year: 1,
  weather: "sunny",
  currentTool: "(T)Axe",
  currentToolSlot: 0,
  toolSlots: Object.freeze([]),
  inventoryItemFacts: Object.freeze([]),
  cropTargets: Object.freeze([]),
  harvestTargets: Object.freeze([]),
});

/** One `snapshot` fact: the payload plus the envelope the Mod wraps it in, whose `revision` is the action echo. */
function reading(revision: number, payload: Readonly<Record<string, unknown>>, tick: number): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    kind: "snapshot" as const,
    correlationId: `snapshot_${String(tick)}`,
    observedTick: tick,
    revision,
    occurredAtMs: 1_790_000_000_000 + tick,
    payload: Object.freeze({ ...payload, revision }) as never,
  });
}

const FIRST_INPUT = Object.freeze({
  source: "player_text",
  inputId: "player_input_content_first",
  text: "我到了。",
  locale: "zh-CN",
  timestampMs: 1_790_000_000_000,
});

const SECOND_INPUT = Object.freeze({
  source: "player_text",
  inputId: "player_input_content_second",
  text: "现在几点了？",
  locale: "zh-CN",
  timestampMs: 1_790_000_001_000,
});

const sink = (batches: PendingBatch[]) => ({
  async deliver(batch: PendingBatch): Promise<void> {
    batches.push(batch);
  },
});

/** `<world-state>`'s first line, split from the paragraph under it: the header is a claim ABOUT the paragraph. */
function worldStateBlock(text: string): Readonly<{ header: string; body: string }> {
  const matched = /<world-state>\n([\s\S]*?)\n<\/world-state>/u.exec(text);
  assert.ok(matched !== null, `the batch carried no <world-state> block, so there is nothing to read: ${text}`);
  const block = matched[1] ?? "";
  const [header, ...rest] = block.split("\n");
  assert.ok(header !== undefined, `the <world-state> block carries no first line: ${text}`);
  return Object.freeze({ header, body: rest.join("\n") });
}

/** The two markers `fact-brief.ts` prints, so a row's expectation can be stated as one of them. */
const FRESH = "刚刚更新";
const RESTATED = "本轮无新观察";

/**
 * The paragraph as a statement about the WORLD.
 *
 * `composeWorldState` prints the reading's AGE first (`（这是 N 轮之前看到的…）`, or the `world_state_stale:` code), and
 * that sentence is a claim about the reading rather than part of what the world says - it is the very thing the header
 * states in three words. Comparing it would make every block look different from the one before it, which would make the
 * header assertion pass on its own echo.
 */
function worldOnly(body: string): string {
  const [headline, ...rest] = body.split("\n");
  const parts = (headline ?? "").split("；");
  const first = parts[0] ?? "";
  const aged = /^（这是 \d+ 轮之前看到的/u.test(first) || first.startsWith("world_state_stale:");
  return [aged ? parts.slice(1).join("；") : parts.join("；"), ...rest].join("\n");
}

type Row = Readonly<{
  /** What the second flush - the one carrying the observation - decided. */
  decision: TurnDecision;
}>;

/**
 * The row fixture: one delivered turn, then the reading under test alone, then the person's own turn.
 *
 * <p>
 * The third flush is not decoration. A suppressed flush opens nothing, so the only way to see what the block WOULD have
 * said about that reading is the next turn that opens for another reason - which is exactly how `round53` printed
 * `11:30（上午）· 天气：雨天 · 位置: 镇上 · 体力: 41` under a header reading `本轮无新观察`. The header and the paragraph
 * are then compared against the paragraph she was last shown, so the assertion is about the two texts rather than about
 * a flag beside them.
 * </p>
 */
async function row(payload: Readonly<Record<string, unknown>>, revision: number, news: boolean): Promise<Row> {
  const pump = new CompanionEventPump();
  const batches: PendingBatch[] = [];

  pump.enqueueFact(reading(352, READING, 0));
  pump.enqueuePlayerInput(FIRST_INPUT);
  await pump.flush(sink(batches));

  pump.enqueueFact(reading(revision, payload, 1));
  await pump.flush(sink(batches));
  const decision = pump.turnAccount.lastDecision;
  assert.ok(decision !== undefined, "an examined flush always states its decision");

  pump.enqueuePlayerInput(SECOND_INPUT);
  await pump.flush(sink(batches));

  // THE HEADER MUST AGREE WITH THE PARAGRAPH BESIDE IT, on every batch she was handed: a block whose paragraph differs
  // from the one before it is news whatever the revision says, and a block whose paragraph is the one she already read is
  // a re-statement whatever the revision says. Neither direction is allowed to be a lie.
  const blocks = batches.map((batch) => worldStateBlock(batch.text));
  assert.equal(blocks.length >= 2, true, "the fixture delivered at least the reading under test and the person's turn");
  let differing = 0;
  for (let index = 1; index < blocks.length; index += 1) {
    const previous = blocks[index - 1];
    const current = blocks[index];
    assert.ok(previous !== undefined && current !== undefined);
    const changed = worldOnly(current.body) !== worldOnly(previous.body);
    if (changed) differing += 1;
    assert.equal(
      current.header.includes(RESTATED),
      !changed,
      changed
        ? `the block's own paragraph changed and its header still said ${RESTATED}: ${current.header} / ${current.body}`
        : `the block re-stated the paragraph she already read and its header claimed news: ${current.header}`,
    );
    assert.equal(
      current.header.includes(FRESH),
      changed,
      `the header states freshness in one of the two words: ${current.header}`,
    );
  }
  assert.equal(
    differing > 0,
    news,
    news
      ? "the fixture's changed field never reached a paragraph, so the header comparison would prove nothing"
      : "the fixture's reading reached a paragraph as news, so this row is not the re-statement it claims to be",
  );
  return Object.freeze({ decision });
}

test("content matrix: a clock that moved and nothing else OPENS a turn", async () => {
  // The measured suppression. `round53` read `06:10` at revision 5 and then `11:30` at revision 5, and the second one was
  // called a re-statement: 320 game minutes, five hours of villager schedules and shop hours, dropped because no action
  // had run. The revision is deliberately the SAME here, so nothing but the reading's own content can open the turn.
  const result = await row(Object.freeze({ ...READING, timeOfDay: 1130 }), 352, true);
  assert.deepEqual(result.decision, Object.freeze({ kind: "opened", index: 2, reason: TURN_OPENING.observation }));
});

test("content matrix: a location that changed OPENS a turn", async () => {
  const result = await row(Object.freeze({ ...READING, location: "Town" }), 352, true);
  assert.deepEqual(result.decision, Object.freeze({ kind: "opened", index: 2, reason: TURN_OPENING.observation }));
});

test("content matrix: a stamina that dropped OPENS a turn", async () => {
  const result = await row(Object.freeze({ ...READING, stamina: 41 }), 352, true);
  assert.deepEqual(result.decision, Object.freeze({ kind: "opened", index: 2, reason: TURN_OPENING.observation }));
});

test("content matrix: a weather that turned OPENS a turn", async () => {
  const result = await row(Object.freeze({ ...READING, weather: "rain" }), 352, true);
  assert.deepEqual(result.decision, Object.freeze({ kind: "opened", index: 2, reason: TURN_OPENING.observation }));
});

test("content matrix: an identical payload with a NEW revision is SUPPRESSED", async () => {
  // `round46b`'s shape, and the reason a revision cannot be the suppressor's authority: the Mod's counter moved (an action
  // ran) and the reading says exactly what she already read. Two consecutive turns with byte-identical content is the
  // defect this list exists to close, and the counter-based rule reopened it.
  const result = await row(Object.freeze({ ...READING }), 353, false);
  assert.deepEqual(
    result.decision,
    Object.freeze({ kind: "suppressed", reason: TURN_SUPPRESSION.observationRestated }),
  );
});

test("content matrix: an identical payload with an UNCHANGED revision is SUPPRESSED", async () => {
  const result = await row(Object.freeze({ ...READING }), 352, false);
  assert.deepEqual(
    result.decision,
    Object.freeze({ kind: "suppressed", reason: TURN_SUPPRESSION.observationRestated }),
  );
});

/**
 * A port that answers `observe` the way the integration does: by admitting a reading through the pump's own `enqueueFact`,
 * which is the route the answer really travels (`local-stardew-bridge.ts:1057`).
 */
function answeringPort(
  pump: CompanionEventPump,
  answer: () => WorldFact,
): { port: WorldStateRefreshPort; asked: number[] } {
  const asked: number[] = [];
  const port: WorldStateRefreshPort = Object.freeze({
    async observe(): Promise<unknown> {
      asked.push(asked.length + 1);
      pump.enqueueFact(answer());
      return Object.freeze({});
    },
    publish: (fact: WorldFact) => pump.enqueueFact(fact),
  });
  return { port, asked };
}

test("the suppressed flush ASKS the world first, and the answer is what opens the turn", async () => {
  // THE CLOSED LOOP this unit exists to break. A suppressed flush returned before the cure could be reached
  // (`event-pump.ts:1679-1682`), and the cure's own answer re-entered the same counter predicate, so no turn opened →
  // nothing acted → the revision never moved → nothing could ever open. Measured (`.tmp/audit/probe-refresh-loop.mjs`):
  // nine clock-only suppressions made ZERO probes.
  const pump = new CompanionEventPump();
  const batches: PendingBatch[] = [];
  const { port, asked } = answeringPort(pump, () => reading(352, { ...READING, timeOfDay: 1130 }, 1));
  pump.attachWorldStateRefresh(port);

  pump.enqueueFact(reading(352, READING, 0));
  pump.enqueuePlayerInput(FIRST_INPUT);
  await pump.flush(sink(batches));

  pump.enqueueFact(reading(352, READING, 2));
  await pump.flush(sink(batches));

  assert.deepEqual(asked, [1], "the flush that would have been suppressed asked the world once, before deciding");
  assert.deepEqual(
    pump.turnAccount.lastDecision,
    Object.freeze({ kind: "opened", index: 2, reason: TURN_OPENING.observation }),
    "and the reading the answer brought carries the SAME revision - which is why the turn could never open before",
  );
  const block = worldStateBlock(batches[1]?.text ?? "");
  assert.equal(block.header.includes(FRESH), true, `the turn states the answer it was composed from: ${block.header}`);
  assert.match(block.body, /11:30/u, "and the paragraph is the clock the world reported, not the one it was holding");
});

test("a world that answers with the reading it already gave is NOT a cure, and the budget stops the fourth ask", async () => {
  // The other half: an ask that returns the same reading changes nothing, so the flush stays suppressed - and the budget
  // is what keeps that from becoming a poll. The answer carries a BUMPED revision on every ask, so a budget re-armed by
  // the counter would ask forever while a budget re-armed by the reading spends three probes and says so.
  const pump = new CompanionEventPump();
  const batches: PendingBatch[] = [];
  let answer = 352;
  const { port, asked } = answeringPort(pump, () => reading((answer += 1), READING, answer));
  pump.attachWorldStateRefresh(port);

  pump.enqueueFact(reading(352, READING, 0));
  pump.enqueuePlayerInput(FIRST_INPUT);
  await pump.flush(sink(batches));

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    pump.enqueueFact(reading(400 + attempt, READING, 100 + attempt));
    await pump.flush(sink(batches));
    assert.deepEqual(
      pump.turnAccount.lastDecision,
      Object.freeze({ kind: "suppressed", reason: TURN_SUPPRESSION.observationRestated }),
      `attempt ${String(attempt)}: the reading she was shown is the reading this one states, so no turn is owed`,
    );
  }

  assert.equal(
    asked.length,
    3,
    `five suppressions of one reading asked ${String(asked.length)} times; the budget is three`,
  );
  const account = pump.turnAccount.autoObserve;
  assert.equal(account.refreshed, 3, "the served asks are the refreshes");
  assert.equal(
    account.unavailable[AUTO_OBSERVE_UNAVAILABLE.attemptsSpent],
    2,
    "and the flushes past the budget say so instead of asking again",
  );
  assert.match(turnAccountLine(pump.turnAccount), /refresh_attempts_spent: 2/u);
});

test("a REFUSED probe on the suppressed path is recorded, and its refusal reaches the model", async () => {
  // A probe the route would not serve must be as visible as the stale reading it could not replace, from the suppressed
  // path as much as from an opening one - otherwise "the bridge is down" and "the world did not move" are one silence.
  const pump = new CompanionEventPump();
  const batches: PendingBatch[] = [];
  const published: WorldFact[] = [];
  pump.attachWorldStateRefresh(
    Object.freeze({
      observe: () => Promise.reject(new Error("bridge_not_authenticated")),
      publish: (fact: WorldFact) => {
        published.push(fact);
        pump.enqueueFact(fact);
      },
    }),
  );

  pump.enqueueFact(reading(352, READING, 0));
  pump.enqueuePlayerInput(FIRST_INPUT);
  await pump.flush(sink(batches));

  pump.enqueueFact(reading(352, READING, 2));
  await pump.flush(sink(batches));
  assert.equal(pump.worldStateRefresh.probes, 1, "the suppressed flush asked, and the ask was refused");
  assert.equal(published.length, 1, "the refusal is published once for this reading");
  assert.equal(published[0]?.payload.code, "world_state_refresh_refused:bridge_not_authenticated");
  assert.equal(pump.turnAccount.autoObserve.unavailable[AUTO_OBSERVE_UNAVAILABLE.refused], 1);

  // The refusal is a Host-minted fact, so it opens the next turn and reaches the model in words - and that turn's flush
  // asks again, because the reading is still the one she was shown. The STATEMENT is published once; the ASKS are one per
  // examined flush, which is the accounting the account line prints.
  await pump.flush(sink(batches));
  assert.match(batches[1]?.text ?? "", /world_state_refresh_refused:bridge_not_authenticated/u);
  const account = pump.turnAccount.autoObserve;
  assert.equal(pump.worldStateRefresh.probes, 2, "the flush the refusal opened asked too, on the same reading");
  assert.equal(published.length, 1, "...and the reading's refusal was still said once");
  const declined = Object.values(account.unavailable).reduce((total, count) => total + count, 0);
  assert.equal(
    account.refreshed + declined,
    account.agedTurns,
    "every aged reading is settled or declined, never neither",
  );
  const line = turnAccountLine(pump.turnAccount);
  assert.match(line, /auto_observe_unavailable 2 \{no_bridge: 0, refresh_attempts_spent: 0, refresh_refused: 2\}/u);
});
