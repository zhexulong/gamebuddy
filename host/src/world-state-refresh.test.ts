/**
 * GATE `stale_world_state_produces_no_refresh`, and the bound that keeps its repair from becoming a spin.
 *
 * <p>
 * MEASURED 2026-11-10 (`round45`): the world reading froze at `revision 352` for the last 50 turns of the run while the
 * clock walked through two `02:00` pass-outs and two day starts, and the companion dispatched nothing for 601 s. The
 * pump already said so - `world_state_stale:50;352;…` reached the model - and nothing acted on it: the only producers of
 * `observe_request` in the product are the model's own `stardew_observe` tool and the execute path's `stale_snapshot`
 * re-take, so being told the picture was old WAS the entire repair. In a narration loop, being told is exactly what she
 * does not act on.
 * </p>
 *
 * <p>
 * The population is the frozen window's own facts, replayed in the order the bundle recorded them; the property is that
 * each stale fact is followed by a request for a fresh observation or by a named refusal, never by silence. The red
 * reading is kept beside it as a fixture, because it is what every composition shipped: a pump with no port attached
 * answers the same window with no request at all.
 * </p>
 */

import assert from "node:assert/strict";
import test from "node:test";

import { CompanionLoop } from "./companion-loop.js";
import {
  FACT_PRODUCER,
  AUTO_OBSERVE_REARM,
  AUTO_OBSERVE_REARM_REASONS,
  type AutoObserveRearmReason,
  AUTO_OBSERVE_UNAVAILABLE,
  CompanionEventPump,
  type PendingBatch,
  WORLD_STATE_REFRESH_ATTEMPTS,
  WORLD_STATE_REFRESH_REFUSED_SEMANTIC_KIND,
  type WorldFact,
  type WorldStateRefreshPort,
  turnAccountLine,
} from "./event-pump.js";
import { WORLD_STATE_STALE_TURNS } from "./fact-brief.js";
import { CompanionHostService } from "./host-service.js";
import type { Snapshot } from "./protocol.js";

/** The world as the Mod admitted it at `revision 352`, which is the reading the frozen window re-stated 50 times. */
const STUCK_READING = {
  revision: 352,
  location: "FarmHouse",
  tile: { x: 9, y: 9 },
  stamina: 270,
  health: 100,
  actionable: true,
  capabilities: [],
  catalogRevision: 3,
  enabledActionIds: [],
  presentationLocale: "zh-CN",
  exhausted: false,
  timeOfDay: 600,
  dayOfMonth: 6,
  seasonIndex: 0,
  year: 1,
  weather: "sunny",
  currentTool: "(T)Axe",
  currentToolSlot: 0,
  toolSlots: [],
  inventoryItemFacts: [],
  cropTargets: [],
  harvestTargets: [],
} as unknown as Snapshot;

function snapshotFact(revision: number, reading: Snapshot = STUCK_READING): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    kind: "snapshot" as const,
    eventId: `snapshot_${String(revision)}`,
    correlationId: `observe_${String(revision)}`,
    revision,
    payload: reading as never,
  });
}

function worldFact(semanticKind: string, gameTime: string, index: number): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    kind: "world_fact" as const,
    eventId: `${semanticKind}_${String(index)}`,
    correlationId: `${semanticKind}_${String(index)}`,
    revision: 400,
    observedTick: index,
    gameTime,
    semanticKind,
    payload: Object.freeze({ kind: semanticKind, revision: 400 }) as Readonly<Record<string, unknown>>,
  });
}

/**
 * A fact the world really published that says nothing about where the world IS: a modal opening.
 *
 * The population the refresh budget must NOT re-arm on, and the reason it is a real kind rather than an invented one: the
 * clock, the day, a pass-out and a warp are `DAY_BOUNDARY_SEMANTIC_KINDS` or `snapshot_changed` and are the world MOVING,
 * while `route_progress`, `body_idle` and `execution_started` open no turn at all (`HELD_SEMANTIC_PROGRESS_KINDS`).
 */
function silentFact(index: number): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    kind: "semantic_event" as const,
    eventId: `modal_presented_${String(index)}`,
    correlationId: `modal_presented_${String(index)}`,
    revision: 400,
    observedTick: index,
    payload: Object.freeze({ kind: "modal_presented", index }),
  });
}

/**
 * The facts the Mod published after the reading froze (22:26:19 - 22:55:40 in the bundle): the clock walking 12:00 ->
 * 18:00 -> 22:00 -> 24:00 -> 26:00, a pass-out, a new day, and then the same again.
 */
const FROZEN_WINDOW: readonly WorldFact[] = Object.freeze([
  worldFact("time_milestone", "1200", 2),
  worldFact("time_milestone", "1800", 3),
  worldFact("time_milestone", "2200", 4),
  worldFact("time_milestone", "2400", 5),
  worldFact("night_ended_pass_out", "2600", 6),
  worldFact("day_started", "0600", 7),
  worldFact("time_milestone", "1200", 8),
  worldFact("night_ended_pass_out", "2600", 9),
  worldFact("day_started", "0600", 10),
]);

/** One delivered turn, admitted in the order the Host admits it: the fact, then whatever the pump minted for it. */
async function deliverTurn(pump: CompanionEventPump, fact: WorldFact): Promise<PendingBatch | undefined> {
  const batches: PendingBatch[] = [];
  pump.enqueueFact(fact, FACT_PRODUCER.worldStateRefreshRefused);
  const stale = pump.takeWorldStateStaleFact();
  if (stale !== undefined) pump.enqueueFact(stale, FACT_PRODUCER.worldStateRefreshRefused);
  await pump.flush({
    async deliver(batch) {
      batches.push(batch);
    },
  });
  return batches.at(0);
}

function staleFactsOf(batch: PendingBatch | undefined): readonly WorldFact[] {
  return (batch?.facts ?? []).filter((fact) => fact.semanticKind === "world_state_stale");
}

/**
 * One turn the world did NOT speak in: a person's word, and nothing else.
 *
 * This is the purest population for "a flush happened and the world did not move" - a `time_milestone` fact would say the
 * clock advanced, which is the OTHER re-arm signal and a different question (`AUTO_OBSERVE_REARM`).
 */
async function silentTurn(pump: CompanionEventPump, index: number): Promise<PendingBatch | undefined> {
  pump.enqueuePlayerInput({
    source: "player_text",
    inputId: `player_input_${String(index)}`,
    text: "嗯。",
    locale: "zh-CN",
    timestampMs: 1_790_000_000_000 + index,
  });
  const batches: PendingBatch[] = [];
  await pump.flush({
    async deliver(batch) {
      batches.push(batch);
    },
  });
  return batches.at(0);
}

/** The refusal is published from a promise continuation, so it lands after the turn that produced it. */
const drained = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Replay the frozen window, returning every stale fact it published and what each of them asked for. */
async function replayFrozenWindow(pump: CompanionEventPump): Promise<readonly WorldFact[]> {
  const stale: WorldFact[] = [];
  await deliverTurn(pump, snapshotFact(352));
  for (const fact of FROZEN_WINDOW) {
    for (const one of staleFactsOf(await deliverTurn(pump, fact))) stale.push(one);
  }
  await drained();
  return stale;
}

test("stale_world_state_produces_no_refresh: every aged turn is answered by a request, and a served request replaces the notice", async () => {
  // THE RED READING, kept as the fixture. A pump nobody wired is what every composition shipped at HEAD: the frozen
  // window would produce stale facts and answer them with no request at all - the 601 s of silence, reproduced from the
  // bundle's own facts rather than described. What is asserted now is the arithmetic the account prints: every turn
  // composed from an aged reading is one of "the world was asked" or "it could not be asked, for this reason".
  const unattached = new CompanionEventPump();
  const unattachedStale = await replayFrozenWindow(unattached);
  assert.ok(unattachedStale.length > 0, "the window must produce stale facts, or this gate has nothing to read");
  assert.equal(
    unattached.worldStateRefresh.attached,
    false,
    "a pump nobody wired cannot refresh, and that condition must be readable rather than silent",
  );
  assert.equal(unattached.worldStateRefresh.probes, 0, "the defect this gate names: stale, and nothing asks");
  assert.ok(unattached.turnAccount.autoObserve.agedTurns > 0, "the window ages readings, or there is nothing to cure");
  assert.equal(
    unattached.turnAccount.autoObserve.unavailable[AUTO_OBSERVE_UNAVAILABLE.noBridge],
    unattached.turnAccount.autoObserve.agedTurns,
    "and every one of those aged turns says WHY nobody asked, instead of leaving it to be inferred from a silence",
  );

  // THE PROPERTY: an aged reading is answered by a request for a fresh observation, and a request that is SERVED replaces
  // the reading - so the turn carries the answer instead of a notice telling her to go and fetch it herself. The counts
  // come from the account, so the arithmetic is the pump's own statement rather than a second tally here.
  const pump = new CompanionEventPump();
  const asked: string[] = [];
  let revision = 352;
  pump.attachWorldStateRefresh(
    Object.freeze({
      async observe(): Promise<unknown> {
        asked.push(`observe_${String(asked.length + 1)}`);
        // The answer arrives the way the integration's does: an ordinary snapshot fact admitted by the pump - and it is a
        // LATER WORLD, not the same one under a new counter, so the clock follows the revision.
        revision += 1;
        pump.enqueueFact(
          snapshotFact(revision, { ...STUCK_READING, revision, timeOfDay: 600 + revision } as Snapshot),
          FACT_PRODUCER.worldStateRefreshRefused,
        );
        return Object.freeze({ revision });
      },
      publish: () => undefined,
    }),
  );
  const stale = await replayFrozenWindow(pump);
  assert.equal(pump.worldStateRefresh.attached, true);
  const staleAccount = pump.turnAccount.autoObserve;
  assert.ok(staleAccount.agedTurns > 0, "the window reaches at least one aged turn, or this gate has nothing to read");
  assert.equal(
    asked.length,
    pump.worldStateRefresh.probes,
    `each of the ${String(pump.worldStateRefresh.probes)} requests the pump counts must be one call (measured ${String(asked.length)})`,
  );
  assert.equal(
    staleAccount.refreshed,
    staleAccount.agedTurns,
    `every aged turn was answered by the world: ${String(staleAccount.refreshed)} of ${String(staleAccount.agedTurns)}`,
  );
  assert.deepEqual(stale, [], "so not one turn was handed a notice about a reading that had already been replaced");
});

test("refresh_loop_without_progress: a frozen reading is asked about at most WORLD_STATE_REFRESH_ATTEMPTS times", async () => {
  // Fifty turns of one revision against a bridge that refuses every one of them: the world never moves, so the request
  // count is the only thing that can run away. The re-arm keys are the REVISION and the WORLD's own statement that it
  // moved - and this fixture makes neither - so the count is bounded by the constant however long the freeze lasts.
  const pump = new CompanionEventPump();
  const refusals: WorldFact[] = [];
  pump.attachWorldStateRefresh(
    Object.freeze({
      async observe(): Promise<unknown> {
        throw new Error("bridge_not_authenticated");
      },
      publish: (fact: WorldFact) => {
        refusals.push(fact);
      },
    }),
  );
  await deliverTurn(pump, snapshotFact(352));
  for (let turn = 1; turn <= 50; turn += 1) await deliverTurn(pump, silentFact(turn));
  await drained();

  assert.equal(
    pump.worldStateRefresh.probes,
    WORLD_STATE_REFRESH_ATTEMPTS,
    `fifty turns of one frozen revision asked ${String(pump.worldStateRefresh.probes)} times; the bound is ` +
      `${String(WORLD_STATE_REFRESH_ATTEMPTS)} per crossed revision`,
  );
  assert.equal(
    pump.turnAccount.autoObserve.rearmed[AUTO_OBSERVE_REARM.worldMoved],
    0,
    "and nothing earned a new budget: a flush is not a world statement, however many of them there are",
  );
  assert.equal(
    refusals.length,
    1,
    "a refusal is said once per crossing: three copies of one condition would be three turns spent re-reading it",
  );
  const refused = refusals[0];
  assert.ok(refused !== undefined);
  assert.equal(refused.semanticKind, WORLD_STATE_REFRESH_REFUSED_SEMANTIC_KIND);
  assert.equal(refused.revision, 352, "the refusal names the reading it could not replace");
  assert.equal(
    refused.payload.code,
    "world_state_refresh_refused:bridge_not_authenticated",
    "the reason is the route's own words, not a Host paraphrase of them",
  );
  assert.equal(pump.worldStateRefresh.refusals, 1);
});

test("round61: a clock that advances while the snapshot stays frozen earns the fourth ask, not `refresh_attempts_spent`", async () => {
  // THE SHAPE `round61` SAT IN. `GAME_CLOCK_STALLED` reported `sinceLastSnapshotMs 630353` while `GAME_CLOCK_READ` walked
  // the clock to day 6 every 30 s - the bridge answered and the world moved - and the pump had spent its three asks, so
  // `auto_observe_unavailable:refresh_attempts_spent` was the only thing it could say for ten and a half minutes and 13
  // turns closed as `world_stale`.
  //
  // The defect was not the bound: it was that the bound's re-arm key (the reading's own CONTENT) can only be produced by
  // the ask the bound gates. A frozen snapshot is therefore a budget that can never come back. What the pump already
  // holds is the second signal - the Mod's own clock statement while the snapshot stays frozen - and that is what this
  // asks it to honour.
  const pump = new CompanionEventPump();
  const asked: number[] = [];
  pump.attachWorldStateRefresh(
    Object.freeze({
      // The bridge ANSWERS, every time, and the answer is still the reading it was asked about: this is the frozen
      // snapshot channel, not a dead bridge, which is what makes the silence a publish problem rather than a pipe problem.
      async observe(): Promise<unknown> {
        asked.push(asked.length + 1);
        return Object.freeze({});
      },
      publish: () => undefined,
    }),
  );
  await deliverTurn(pump, snapshotFact(352));
  for (let turn = 1; turn <= WORLD_STATE_REFRESH_ATTEMPTS + 2; turn += 1) await silentTurn(pump, turn);
  assert.equal(
    asked.length,
    WORLD_STATE_REFRESH_ATTEMPTS,
    `the bound must still hold in a world that says nothing: ${String(asked.length)} ask(s)`,
  );

  // The clock advances while the snapshot does not. The reading cannot have been replaced by this - the bridge answered
  // and published the same picture - so the fourth ask is a new question, not the same one asked twice.
  await deliverTurn(pump, worldFact("time_milestone", "2210", 900));
  assert.equal(
    asked.length,
    WORLD_STATE_REFRESH_ATTEMPTS + 1,
    "a world that says it moved while the reading is frozen must be asked again: the budget cannot need the ask it gates",
  );
  const account = pump.turnAccount.autoObserve;
  assert.equal(
    account.refreshed,
    asked.length,
    `every ask the pump made was answered by the bridge: ${String(account.refreshed)} of ${String(asked.length)}`,
  );
  assert.equal(
    account.refreshed + account.unavailable[AUTO_OBSERVE_UNAVAILABLE.attemptsSpent],
    account.agedTurns,
    "and the aged turns partition into answered asks + the one decline the budget earned before the world spoke",
  );
  assert.equal(
    account.rearmed[AUTO_OBSERVE_REARM.worldMoved],
    1,
    "and the account says WHICH signal earned the extra budget: the world moved, not the reading",
  );
  assert.equal(
    account.rearmed[AUTO_OBSERVE_REARM.readingMoved],
    0,
    "the reading never moved, so the budget was not earned back by the ask being answered",
  );
  const line = turnAccountLine(pump.turnAccount);
  assert.match(line, /refresh_rearmed 1 \{reading_moved: 0, world_moved: 1\}/u, `the line names the signal: ${line}`);
  console.log(`round61 reading: ${String(asked.length)} asks · ${line}`);
});

test("a snapshot frozen AND a clock frozen still declines, with the reason: nothing moved, so nothing new is asked", async () => {
  // THE INVERSE, and the half that keeps the bound a bound. With no signal at all the answer must stay
  // `refresh_attempts_spent` - fifty flushes of a world that says nothing are one question, and asking it fifty times is
  // the probe cadence the docblock refuses.
  const pump = new CompanionEventPump();
  const asked: number[] = [];
  pump.attachWorldStateRefresh(
    Object.freeze({
      async observe(): Promise<unknown> {
        asked.push(asked.length + 1);
        return Object.freeze({});
      },
      publish: () => undefined,
    }),
  );
  await deliverTurn(pump, snapshotFact(352));
  for (let turn = 1; turn <= 50; turn += 1) await silentTurn(pump, turn);
  assert.equal(
    asked.length,
    WORLD_STATE_REFRESH_ATTEMPTS,
    `fifty flushes of one frozen reading asked ${String(asked.length)} times; the bound is per world statement`,
  );
  const account = pump.turnAccount.autoObserve;
  assert.ok(
    account.unavailable[AUTO_OBSERVE_UNAVAILABLE.attemptsSpent] > 0,
    "and every aged turn past the bound says so, rather than leaving the silence to be inferred",
  );
  const line = turnAccountLine(pump.turnAccount);
  assert.match(line, /refresh_attempts_spent: [1-9]/u, `the decline is printed with its reason: ${line}`);
  console.log(`frozen reading and frozen clock: ${String(asked.length)} asks · ${line}`);
});

/**
 * The ingress-only drive for each re-arm key this pump declares: what produces that key when the ask it bounds never
 * succeeds.
 *
 * Keyed by `AUTO_OBSERVE_REARM_REASONS` rather than by a list here, so a third key added to the pump appears in the gate's
 * population without anyone remembering this file - and then fails by name, because no drive is declared for it.
 */
const REARM_DRIVES: Readonly<Partial<Record<AutoObserveRearmReason, (pump: CompanionEventPump) => Promise<void>>>> =
  Object.freeze({
    [AUTO_OBSERVE_REARM.readingMoved]: async (pump) => {
      // A reading the integration published on ITS OWN schedule - the model's `stardew_observe`, or the Mod's own
      // publish - arrives through the pump's ingress like any other fact. Two turns: one to deliver it (a reading alone is
      // standing state and opens nothing), one to be aged on it.
      await deliverTurn(pump, snapshotFact(400, { ...STUCK_READING, revision: 400, timeOfDay: 700 } as Snapshot));
      await silentTurn(pump, 900);
      await silentTurn(pump, 901);
    },
    [AUTO_OBSERVE_REARM.worldMoved]: async (pump) => {
      // The world's own clock statement, in a world where the snapshot channel publishes nothing.
      await deliverTurn(pump, worldFact("time_milestone", "1240", 900));
    },
  });

/**
 * GATE `bound_rearms_only_on_what_it_unlocks:<key>` - the defect class `round61` is a member of.
 *
 * A bound whose re-arm key can only be produced by the operation that bound gates is a bound that spends itself once and
 * never comes back: the reset condition is the success of what it is bounding. `round61` is exactly that shape - the
 * refresh budget was re-armed by the reading's own content, a frozen snapshot channel never published different content,
 * and the pump was deaf for ten and a half minutes while the clock advanced and the bridge answered.
 *
 * <p>
 * THE POPULATION IS THE PUMP'S OWN DECLARATION (`AUTO_OBSERVE_REARM_REASONS`), and the property is asked of the BOUND, not
 * of a key: every key it declares must be producible through the pump's ingress with the gated ask NEVER succeeding. A key
 * that needs the ask to have worked - the deleted shape, and the reason this file's own old assertion had to be
 * re-derived - fails here by name. Zero population is refused rather than passed, because a gate whose set of keys is
 * empty agrees with itself.
 * </p>
 */
test("bound_rearms_only_on_what_it_unlocks: every declared re-arm key is producible without the ask it gates", async () => {
  const reasons = AUTO_OBSERVE_REARM_REASONS;
  assert.ok(
    reasons.length > 0,
    "bound_rearms_only_on_what_it_unlocks: the pump declares no re-arm key, so this gate examined nothing rather than passing",
  );
  console.log(
    `bound_rearms_only_on_what_it_unlocks: examined ${String(reasons.length)} re-arm key(s) {${reasons.join(", ")}}`,
  );
  for (const reason of reasons) {
    const drive = REARM_DRIVES[reason];
    assert.ok(
      drive !== undefined,
      `bound_rearms_only_on_what_it_unlocks:${reason} - the pump declares this re-arm key and this gate has no ingress-only ` +
        "drive that produces it, so 'can this budget come back without the gated ask?' is unknown rather than true",
    );
    const pump = new CompanionEventPump();
    const asked: number[] = [];
    pump.attachWorldStateRefresh(
      Object.freeze({
        // THE GATED OPERATION NEVER SUCCEEDS: the bridge is asked, answers, and publishes no reading at all.
        async observe(): Promise<unknown> {
          asked.push(asked.length + 1);
          return Object.freeze({});
        },
        publish: () => undefined,
      }),
    );
    await deliverTurn(pump, snapshotFact(352));
    for (let turn = 1; turn <= WORLD_STATE_REFRESH_ATTEMPTS + 2; turn += 1) await silentTurn(pump, turn);
    assert.equal(
      asked.length,
      WORLD_STATE_REFRESH_ATTEMPTS,
      `bound_rearms_only_on_what_it_unlocks:${reason} - the precondition: with no key present the budget is spent and stays ` +
        `spent (${String(asked.length)} ask(s))`,
    );
    await drive(pump);
    assert.equal(
      asked.length,
      WORLD_STATE_REFRESH_ATTEMPTS + 1,
      `bound_rearms_only_on_what_it_unlocks:${reason} - a spent budget must come back when this key is present and the ` +
        `gated ask has never succeeded: ${String(asked.length)} ask(s)`,
    );
    const rearmed = pump.turnAccount.autoObserve.rearmed;
    assert.equal(
      rearmed[reason],
      1,
      `bound_rearms_only_on_what_it_unlocks:${reason} - and the account must name this key, not merely count the ask`,
    );
    for (const other of reasons) {
      if (other === reason) continue;
      assert.equal(
        rearmed[other],
        0,
        `bound_rearms_only_on_what_it_unlocks:${reason} - this drive must produce only that key; \`${String(other)}\` ` +
          "was counted too, so the two readings of one recovery are not telling them apart",
      );
    }
  }
});

test("a reading that actually moves re-arms the refresh, so one transient refusal cannot silence the run", async () => {
  // The bound stops a spin; it must not spend a run's only chance on a bridge that hiccuped. The budget is per REVISION, so
  // the next reading - a revision that actually moved - asks again from a full budget, and is refused once (the statement
  // is per reading; the requests are per aged turn).
  const pump = new CompanionEventPump();
  let refuse = true;
  let probes = 0;
  pump.attachWorldStateRefresh(
    Object.freeze({
      async observe(): Promise<unknown> {
        probes += 1;
        if (refuse) throw new Error("bridge_not_authenticated");
        return Object.freeze({});
      },
      publish: () => undefined,
    }),
  );
  await deliverTurn(pump, snapshotFact(352));
  for (let turn = 1; turn <= WORLD_STATE_STALE_TURNS + 1; turn += 1) await deliverTurn(pump, silentFact(turn));
  assert.equal(
    probes,
    WORLD_STATE_REFRESH_ATTEMPTS,
    "the aged turns of the first reading spend its budget, and no more",
  );
  assert.equal(pump.worldStateRefresh.refusals, 1, "and the refusal is said once for that reading");

  refuse = false;
  // The world is observed again at a new reading: that is the answer the probe was after, and the episode it belonged to
  // is over - so the next reading gets its own budget rather than inheriting a spent one. The reading moves its CLOCK,
  // because that is what makes it a new reading: the revision alone is the Mod's action echo (`readingContentIdentity`).
  await deliverTurn(pump, snapshotFact(400, { ...STUCK_READING, revision: 400, timeOfDay: 640 } as Snapshot));
  for (let turn = 1; turn <= WORLD_STATE_STALE_TURNS + 1; turn += 1) await deliverTurn(pump, silentFact(100 + turn));
  assert.equal(
    probes,
    2 * WORLD_STATE_REFRESH_ATTEMPTS,
    "a new crossed reading is a new question, asked from a full budget of its own",
  );
  assert.equal(
    pump.worldStateRefresh.refusals,
    1,
    "the refusal is the one reading that was refused; a second one could not be asked about again is not a second one stated",
  );
  assert.equal(
    pump.turnAccount.autoObserve.refreshed,
    WORLD_STATE_REFRESH_ATTEMPTS,
    "and the reading that MOVED was answered every time it was asked about: one transient refusal did not silence the run",
  );
  assert.equal(
    pump.turnAccount.autoObserve.rearmed[AUTO_OBSERVE_REARM.readingMoved],
    1,
    "and that budget was earned back by the READING moving, which is the other signal the account names",
  );
});

test("a port is attached once per pump: a second attach is a wiring bug, not a policy", () => {
  const pump = new CompanionEventPump();
  const port: WorldStateRefreshPort = Object.freeze({
    observe: () => Promise.resolve(Object.freeze({})),
    publish: () => undefined,
  });
  pump.attachWorldStateRefresh(port);
  assert.throws(() => pump.attachWorldStateRefresh(port), /world_state_refresh_already_attached/u);
  assert.equal(pump.worldStateRefresh.attached, true);
});

const ASSISTANT_START = Object.freeze({ role: "assistant" as const, content: Object.freeze([]), provider: "cpa-oai" });
const textEnd = Object.freeze({
  role: "assistant" as const,
  content: Object.freeze([{ type: "text", text: "看着呢。" }]),
  stopReason: "stop",
});

/** A Pi session that answers every prompt with one spoken line, so a delivered batch settles as a real turn. */
function spokenSession() {
  const listeners = new Set<(event: unknown) => void>();
  const prompts: string[] = [];
  const emit = (event: unknown): void => {
    for (const listener of [...listeners]) listener(event);
  };
  return {
    prompts,
    session: {
      subscribe(listener: (event: unknown) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async sendUserMessage(batch: string) {
        prompts.push(batch);
        emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: batch }] } });
        emit({ type: "message_start", message: ASSISTANT_START });
        emit({ type: "message_end", message: textEnd });
        emit({ type: "agent_settled", aborted: false });
      },
      async abort() {},
      clearQueue() {},
      async waitForIdle() {},
    },
  };
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
        return () => undefined;
      },
    },
    emit(fact: WorldFact) {
      factListener?.(fact);
    },
  };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 25));

test("a refused refresh reaches a turn on the Host's own Host-minted-fact route", async () => {
  // The wiring the composition installs, driven through the PRODUCTION Host: `publish` is `acceptHostMintedFact` and
  // nothing else, so a refusal cannot become a second way to start a turn - and it does reach the model, with the
  // route's own reason, which is the difference between waiting out a dead bridge and reporting it.
  const adapter = eventHarness();
  const scripted = spokenSession();
  const loop = new CompanionLoop(scripted.session as never);
  const host = new CompanionHostService(loop, adapter.events as never);
  try {
    loop.pump.attachWorldStateRefresh(
      Object.freeze({
        observe: () => Promise.reject(new Error("bridge_not_authenticated")),
        publish: (fact: WorldFact) => host.acceptHostMintedFact(fact, FACT_PRODUCER.worldStateRefreshRefused),
      }),
    );
    adapter.emit(snapshotFact(352));
    // Turns the world did NOT move in: the reading is a turn old when the first fact after it arrives (the snapshot rides
    // that batch), so the budget is spent on the turn after `WORLD_STATE_STALE_TURNS` and nothing earns it back.
    for (let turn = 1; turn <= WORLD_STATE_STALE_TURNS + 2; turn += 1) {
      adapter.emit(silentFact(turn));
      await settle();
    }
    // ONE clock mark, and it arrives AFTER the budget is spent: that is what makes the stale notice due
    // (`#worldStateStaleDue`) and what earns the one ask past the budget (`AUTO_OBSERVE_REARM.worldMoved`).
    const worldStatements = 1;
    adapter.emit(worldFact("time_milestone", "1200", 0));
    await settle();
    const said = scripted.prompts.join("\n---\n");
    assert.match(
      said,
      /世界观察刷新被拒绝：world_state_refresh_refused:bridge_not_authenticated/u,
      "the model must be handed the refusal in words, or a dead bridge reads as a world that did not move",
    );
    assert.match(said, /world_state_stale:/u, "and the stale reading itself is still stated exactly as it was");
    assert.equal(
      loop.pump.worldStateRefresh.probes,
      WORLD_STATE_REFRESH_ATTEMPTS + worldStatements,
      "one aged reading: its budget, plus the one ask the world's own statement of movement earns past it",
    );
  } finally {
    host.close();
  }
});

test("the composition that installs the port is named, and what this file did not exercise is said", () => {
  // The port is attached by `createHostGameRuntimeMaterializer` where it composes the loop and the Host. Exercising THAT
  // needs a materialized Stardew session - a named-pipe bridge with a real `hello_ack` attestation, a durable runtime
  // root and a mounted Pi session - whose fixture already lives in `local-stardew-bridge-attestation.test.ts`. A second
  // copy of it here would be a second spelling of one setup, so the missing reading is named rather than faked, and the
  // judgement is left where the evidence is.
  console.log(
    "not_measured: production attach not exercised, needs one materialized Stardew session " +
      "(attested named-pipe bridge + durable runtime root) to read the attached port back off the composed Host",
  );
  const pump = new CompanionEventPump();
  assert.equal(
    pump.worldStateRefresh.attached,
    false,
    "a bare pump is unattached by construction, which is why the composition has to install one",
  );
});
