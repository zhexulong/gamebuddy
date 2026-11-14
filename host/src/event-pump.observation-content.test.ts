import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTO_OBSERVE_ON_STALE,
  AUTO_OBSERVE_UNAVAILABLE,
  CompanionEventPump,
  type PendingBatch,
  turnAccountLine,
  TURN_OPENING,
  TURN_SUPPRESSION,
  type WorldFact,
  type WorldStateRefreshPort,
} from "./event-pump.js";

/**
 * THE READING IS STANDING STATE, NOT NEWS.
 *
 * <p>
 * ONE OBSERVATION, TWO PATHS, and they disagreed. The snapshot has always been the `<world-state>` block: `takeBatch`
 * renders the last reading into every delivery (`event-pump.ts#worldStateReading`), and `fact-brief.ts` refuses to print
 * the same payload a second time as news (`factLine`: "The snapshot is the state block, not news"). The OPENER, however,
 * asked a different question - does this reading's content differ from the one she was last shown - so a reading whose
 * clock had moved opened a turn to deliver a paragraph the next turn would have carried anyway.
 * </p>
 *
 * <p>
 * MEASURED 2026-11-15 (`round55`, `tools/_multiday_routine-round55-live-runner.log`): 120 turns opened, 115 of them
 * `observation`, and 86 of those closed `turn_closed_without_action {observation:nothing_pending}`. The run's own bridge
 * traffic says where they came from: of its 131 examined flushes, 90 carried no fact at all - no receipt, no semantic
 * event, no world fact, no lifecycle, no player word - only a snapshot. Every one of those 90 opened a turn, and 87 of
 * them ended with speech and no action. The other 41 windows carried a fact, and 28 of those turns acted.
 * </p>
 *
 * <p>
 * The shape is structural rather than accidental: a turn that runs a tool leaves the observations its tools produced in
 * the pump, `HostService` re-states the latest reading before the next flush, and the opener turned that leftover into a
 * new turn - about three per action turn, which is exactly the 90/29 the run shows. Nothing was decided in those turns
 * and nothing had to be: the work they described had already run.
 * </p>
 *
 * <p>
 * THE RULE THIS FILE PINS. Standing state owns "what the world is" and opens nothing; a turn opener owns "something needs
 * a decision now" - a person's words, an outcome, a due wake. So the reading is delivered by whatever turn comes next,
 * with the header that says whether that turn brought it, and a flush that holds only a reading is a suppressed flush
 * that names its reason. The round53 property is kept and re-asserted here in both directions: the block's header and
 * the paragraph beside it can never disagree, because `#readingIsNews` is still the one comparison behind both.
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

/** A fact the world really published: the clock reaching a milestone. It is news, so it opens the turn it needs. */
function milestoneFact(index: number, occurredAtMs: number): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    kind: "world_fact" as const,
    eventId: `time_milestone_${String(index)}`,
    correlationId: `time_milestone_${String(index)}`,
    revision: 1,
    observedTick: index,
    occurredAtMs,
    semanticKind: "time_milestone",
    payload: Object.freeze({ kind: "time_milestone", milestone: 1200 }),
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

/** The two markers `fact-brief.ts` prints, so an expectation can be stated as one of them. */
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

/**
 * The red case, in the run's own shape: one delivered turn, then the reading alone.
 *
 * `round55` opened 90 such turns and closed 87 of them with speech and nothing done, because the reading is re-stated by
 * the next turn whether or not this one exists. The flush is examined exactly once and says so by name.
 */
test("the reading alone opens no turn: round55's 90 snapshot-only flushes are standing state", async () => {
  const pump = new CompanionEventPump();
  const batches: PendingBatch[] = [];

  pump.enqueueFact(reading(352, READING, 0));
  pump.enqueuePlayerInput(FIRST_INPUT);
  await pump.flush(sink(batches));
  assert.equal(batches.length, 1, "the person spoke, so the first turn is owed whatever else is pending");

  // The turn that ran a tool leaves its own observations behind; `HostService.#restateWorldSnapshot` hands them back.
  pump.enqueueFact(reading(400, Object.freeze({ ...READING, timeOfDay: 700, stamina: 240 }), 1));
  await pump.flush(sink(batches));

  assert.equal(
    batches.length,
    1,
    "a reading is standing state: the next turn states it whether or not a turn is opened for it, so this flush owes " +
      "no model round-trip",
  );
  assert.deepEqual(
    pump.turnAccount.lastDecision,
    Object.freeze({ kind: "suppressed", reason: TURN_SUPPRESSION.observationIsState }),
    "and the flush names what it was holding rather than claiming nothing arrived",
  );
  assert.equal(pump.turnAccount.opened, 1, "no turn was opened for it");
  assert.equal(
    pump.turnAccount.emptyTurns.total,
    0,
    "and no empty turn was counted: the shape this run spent 86 turns on cannot be reached",
  );
  assert.match(
    turnAccountLine(pump.turnAccount),
    /turns opened 1 \{player_input: 1, world_fact: 0, due: 0\}/u,
    "the account's opener population is the closed list, which no longer has a reading member",
  );
});

/**
 * THE FALSIFIER, and the forward path: the same reading beside a fact that needs a decision opens the turn - as
 * `world_fact`, because the reading is what rides along, not what asked.
 *
 * Before this unit the identical fixture answered `observation`: the snapshot was checked first, so a turn owed by a
 * clock milestone, a receipt or a refusal was filed under the reading it carried.
 */
test("a fact beside the reading opens the turn, and the reading rides along as state", async () => {
  const pump = new CompanionEventPump();
  const batches: PendingBatch[] = [];

  pump.enqueueFact(reading(352, READING, 0));
  pump.enqueuePlayerInput(FIRST_INPUT);
  await pump.flush(sink(batches));

  pump.enqueueFact(reading(400, Object.freeze({ ...READING, timeOfDay: 1130, stamina: 240 }), 1));
  pump.enqueueFact(milestoneFact(1200, 1_790_000_002_000));
  await pump.flush(sink(batches));

  assert.equal(batches.length, 2, "the milestone is news, so it opens the turn it needs");
  assert.deepEqual(
    pump.turnAccount.lastDecision,
    Object.freeze({ kind: "opened", index: 2, reason: TURN_OPENING.worldFact }),
    "and the opener names the fact, not the reading it carries",
  );
  const block = worldStateBlock(batches[1]?.text ?? "");
  assert.equal(
    block.header.includes(FRESH),
    true,
    `the turn states the reading it was composed from, so nothing she would have seen is lost: ${block.header}`,
  );
  assert.match(block.body, /11:30/u, "and the paragraph is the clock the world reported, not the one it was holding");
});

/**
 * The matrix, inverted: each row changes ONE field of the reading and opens no turn - and the next turn that opens for
 * another reason states the changed paragraph under `刚刚更新`.
 *
 * <p>
 * This keeps the property `round53` was about (a block whose paragraph changed cannot say `本轮无新观察`) while removing
 * the premise the old matrix asserted (that the change was worth a turn). Each row is the same pump with one field moved,
 * so a rule that let any of them open a turn again fails here by name.
 * </p>
 */
async function row(payload: Readonly<Record<string, unknown>>, revision: number): Promise<void> {
  const pump = new CompanionEventPump();
  const batches: PendingBatch[] = [];

  pump.enqueueFact(reading(352, READING, 0));
  pump.enqueuePlayerInput(FIRST_INPUT);
  await pump.flush(sink(batches));

  pump.enqueueFact(reading(revision, payload, 1));
  await pump.flush(sink(batches));
  assert.deepEqual(
    pump.turnAccount.lastDecision,
    Object.freeze({ kind: "suppressed", reason: TURN_SUPPRESSION.observationIsState }),
    "the reading alone opens nothing, whatever field moved",
  );

  pump.enqueuePlayerInput(SECOND_INPUT);
  await pump.flush(sink(batches));

  // THE HEADER MUST AGREE WITH THE PARAGRAPH BESIDE IT, on every batch she was handed: a block whose paragraph differs
  // from the one before it is news whatever the revision says, and a block whose paragraph is the one she already read is
  // a re-statement whatever the revision says. Neither direction is allowed to be a lie.
  const before = worldStateBlock(batches[0]?.text ?? "");
  const after = worldStateBlock(batches[1]?.text ?? "");
  const changed = worldOnly(after.body) !== worldOnly(before.body);
  assert.equal(changed, true, `the row's field never reached a paragraph, so nothing is being proven: ${after.body}`);
  assert.equal(after.header.includes(FRESH), true, `the block states the reading it brought: ${after.header}`);
  assert.equal(after.header.includes(RESTATED), false, `and does not also deny it: ${after.header}`);
}

test("content matrix: a clock that moved, a location that changed, stamina, weather and a held body open no turn", async () => {
  await row(Object.freeze({ ...READING, timeOfDay: 1130 }), 352);
  await row(Object.freeze({ ...READING, location: "Town" }), 353);
  await row(Object.freeze({ ...READING, stamina: 41 }), 354);
  await row(Object.freeze({ ...READING, weather: "rain" }), 355);
  await row(Object.freeze({ ...READING, actionable: false, actorDispositionKind: "modal" }), 356);
});

test("content matrix: an identical payload with a new revision is still state, and opens nothing", async () => {
  const pump = new CompanionEventPump();
  const batches: PendingBatch[] = [];
  pump.enqueueFact(reading(352, READING, 0));
  pump.enqueuePlayerInput(FIRST_INPUT);
  await pump.flush(sink(batches));

  pump.enqueueFact(reading(353, READING, 1));
  await pump.flush(sink(batches));
  assert.equal(batches.length, 1);
  assert.deepEqual(
    pump.turnAccount.lastDecision,
    Object.freeze({ kind: "suppressed", reason: TURN_SUPPRESSION.observationIsState }),
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

/**
 * THE STALE PATH, BOTH DIRECTIONS - it is a refresh, not a turn.
 *
 * <p>
 * `auto_observe_on_stale 16 {ageTurns: 1}` was the one thing in `round55` that worked as designed, and this unit must not
 * buy its turns back by breaking it. So: a flush whose reading is one she has already been shown still ASKS the world
 * before it decides, and the answer is what the turn it opens is composed from - and the ask itself opens nothing. The
 * turn is owed by the person's words; the reading it carries is the answer.
 * </p>
 */
test("an aged reading still asks the world first, and the ask itself opens no turn", async () => {
  const pump = new CompanionEventPump();
  const batches: PendingBatch[] = [];
  // The answer must carry a revision NEWER than the reading the pump is holding: the Mod's own admission keeps the
  // greatest revision (`enqueueFact`), so an answer that arrived behind the held one would be dropped rather than
  // admitted, and the fixture would be measuring the admission rule instead of the cure.
  const { port, asked } = answeringPort(pump, () => reading(355, Object.freeze({ ...READING, timeOfDay: 640 }), 3));
  pump.attachWorldStateRefresh(port);

  pump.enqueueFact(reading(352, READING, 0));
  pump.enqueuePlayerInput(FIRST_INPUT);
  await pump.flush(sink(batches));
  assert.deepEqual(asked, [], "the turn brought its own reading, so there was nothing to cure");

  // A reading alone: suppressed, and the cure still runs - the world is asked about the aged reading without paying a turn.
  pump.enqueueFact(reading(354, READING, 2));
  await pump.flush(sink(batches));
  assert.deepEqual(
    pump.turnAccount.lastDecision,
    Object.freeze({ kind: "suppressed", reason: TURN_SUPPRESSION.observationIsState }),
    "the answer to the ask is a reading, so it opens no turn either",
  );
  assert.equal(asked.length, 1, "the flush asked the world about the reading it could not use");
  assert.equal(
    pump.turnAccount.autoObserve.refreshed,
    1,
    "and the answer is counted as a refresh, which costs one pipe round-trip and no model turn",
  );

  // The person speaks: the turn carries the reading the answer made current, and says so.
  pump.enqueuePlayerInput(SECOND_INPUT);
  await pump.flush(sink(batches));
  assert.equal(batches.length, 2, "the person's turn is the second turn, and the only other one");
  const block = worldStateBlock(batches[1]?.text ?? "");
  assert.equal(block.header.includes(FRESH), true, `the turn was composed from the freshest reading: ${block.header}`);
  assert.match(block.body, /06:40/u, "which is the clock the world reported");
  assert.match(
    turnAccountLine(pump.turnAccount),
    new RegExp(`${AUTO_OBSERVE_ON_STALE} 1`, "u"),
    "and the run's account still prints the refresh it made",
  );
});

test("a pump with no way to ask declines by name, and the turn it could not cure still opens", async () => {
  // THE OTHER DIRECTION: the cure is an improvement to a turn, never a gate on one. A pump nobody wired must compose the
  // aged reading exactly as before and say why it could not ask.
  const pump = new CompanionEventPump();
  const batches: PendingBatch[] = [];
  pump.enqueueFact(reading(352, READING, 0));
  pump.enqueuePlayerInput(FIRST_INPUT);
  await pump.flush(sink(batches));

  pump.enqueuePlayerInput(SECOND_INPUT);
  await pump.flush(sink(batches));
  assert.equal(batches.length, 2, "a person's turn is owed even when the world cannot be asked");
  assert.equal(pump.turnAccount.autoObserve.unavailable[AUTO_OBSERVE_UNAVAILABLE.noBridge], 1);
  assert.match(worldStateBlock(batches[1]?.text ?? "").header, new RegExp(RESTATED, "u"));
});

test("the flush that holds only a reading is counted against the reading, never as nothing pending", async () => {
  // A run's account has to tell "a reading arrived and needed no decision" from "nothing arrived at all", or the next
  // reader cannot see this rule working: `round55` printed `observation: 115` with no suppression at all.
  const pump = new CompanionEventPump();
  const batches: PendingBatch[] = [];
  await pump.flush(sink(batches));
  assert.deepEqual(
    pump.turnAccount.lastDecision,
    Object.freeze({ kind: "suppressed", reason: TURN_SUPPRESSION.nothingPending }),
    "an empty pump has nothing pending, and no reading to blame",
  );

  pump.enqueueFact(reading(352, READING, 0));
  await pump.flush(sink(batches));
  assert.deepEqual(
    pump.turnAccount.lastDecision,
    Object.freeze({ kind: "suppressed", reason: TURN_SUPPRESSION.observationIsState }),
    "a reading that arrived and decided nothing is its own named condition",
  );
  const line = turnAccountLine(pump.turnAccount);
  assert.match(line, /suppressed 2 \{observation_is_state: 1, world_fact_restated: 0, nothing_pending: 1\}/u, line);
});
