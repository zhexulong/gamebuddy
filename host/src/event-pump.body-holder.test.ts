import assert from "node:assert/strict";
import test from "node:test";

import {
  BODY_HOLDS,
  type BodyHoldSource,
  CLOSED_WITH_NOTHING_WAIT_FOR,
  CompanionEventPump,
  FACT_PRODUCER,
  HOST_MINTED_FACT_SOURCE,
  type PendingBatch,
  TURN_PRODUCTION,
  TURN_WITHOUT_ACTION_REASON,
  type WorldFact,
} from "./event-pump.js";
import { formatBodyState } from "./game-world-vocabulary.js";

/**
 * `a_held_body_is_named_by_the_fact_that_holds_it:<source>` - the holder half of `a_held_body`.
 *
 * <p>
 * MEASURED 2026-11-21 (`round94`, one 535 s gap between two programmes): the idle line could say the body was not free
 * and nothing else, because the pump answered "held" as one boolean. A body held by a warp the game is running, by a
 * mounted menu, and by a cutscene that absorbs the actor are three different waits with three different next steps - wait
 * for the owner's own receipt, answer or dismiss the modal, wait for the performance to end - so a reading that cannot
 * tell them apart is a reading a caller cannot act on.
 * </p>
 *
 * <p>
 * THE GATE IS THE POPULATION. `BODY_HOLDS` is the closed list of the facts that can answer, and every member is driven
 * here BY NAME: a source added to the pump without a fact shape that produces it fails this file instead of quietly
 * printing `held` for a condition nobody can name. The other direction is asserted too - a free body, a walk the Mod owns
 * (`transient` with `actionable: true`) and a session that has never read the world all say `undefined`, because "the body
 * is held" is not a default.
 * </p>
 */

const NOW_MS = Date.UTC(2026, 10, 21, 9, 5, 0);

/** One reading of the world, in the wire's own snapshot shape. */
function readingAt(observedTick: number, payload: Readonly<Record<string, unknown>>): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    kind: "snapshot",
    correlationId: `snapshot_${String(observedTick)}`,
    observedTick,
    revision: 14 + observedTick,
    occurredAtMs: NOW_MS + observedTick,
    payload: Object.freeze({ location: "Farm", ...payload }),
  });
}

/** The settled-plan digest: presentable on its own, so a turn can open without a reading first. */
function settlementFact(eventId: string, occurredAtMs: number): WorldFact {
  return Object.freeze({
    source: HOST_MINTED_FACT_SOURCE,
    kind: "world_fact",
    eventId,
    sourceEventId: eventId,
    correlationId: eventId,
    revision: 0,
    occurredAtMs,
    semanticKind: "program_settled",
    payload: Object.freeze({
      kind: "program_settled",
      programId: eventId,
      settledAtMs: occurredAtMs - 1,
      total: 1,
      counts: Object.freeze({ succeeded: 1 }),
      ok: true,
      reason: null,
      summary: "1/1 完成",
      nodes: Object.freeze([]),
      omitted: 0,
    }),
  });
}

/** The Mod's own clock mark: presentable, so a turn can be opened on it. */
function milestoneFact(index: number, occurredAtMs: number): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    kind: "world_fact",
    eventId: `time_milestone_${String(index)}`,
    sourceEventId: `time_milestone_${String(index)}`,
    correlationId: `time_milestone_${String(index)}`,
    revision: 1,
    occurredAtMs,
    semanticKind: "time_milestone",
    payload: Object.freeze({ milestone: index }),
  });
}

/**
 * The Mod's `body_owned_by_*` refusal: the receipt that starts the pump's own transition hold.
 *
 * The owner it names travels in the evidence detail (`farmhandexecutioncontroller.cs`), which the release path reads;
 * nothing here needs the release, only the hold's own name.
 */
function refusal(code: string): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    kind: "execution_receipt",
    eventId: `refusal_${code}`,
    correlationId: "exec_refused",
    executionId: "exec_refused",
    revision: 1,
    payload: Object.freeze({
      state: "rejected",
      executionId: "exec_refused",
      requestId: "request_refused",
      actionId: "pickup_item",
      reasonCode: code,
      evidence: "owner_action=warp_owner;",
    }),
  });
}

/** A sink that says the turn it was handed ended on speech and nothing else - the loop publishes exactly this. */
function speakingSink(pump: CompanionEventPump): { deliver(batch: PendingBatch): Promise<"completed"> } {
  return {
    async deliver() {
      pump.turnProduction = TURN_PRODUCTION.spoke;
      return "completed" as const;
    },
  };
}

/** A pump holding exactly the facts it is given, in order, with an injected clock. */
function pumpHolding(facts: readonly WorldFact[]): CompanionEventPump {
  const pump = new CompanionEventPump(undefined, () => NOW_MS);
  for (const fact of facts) pump.enqueueFact(fact, FACT_PRODUCER.adapterIngress);
  return pump;
}

/** One fact shape per `BodyHoldSource`, with the holder it must name. */
const HELD: readonly Readonly<{ source: BodyHoldSource; holder: string | undefined; facts: readonly WorldFact[] }>[] = [
  {
    // The pump's own guard answers first: the Mod said the body belongs to a transition it is running.
    source: "world_transition",
    holder: "body_owned_by_navigation",
    facts: [readingAt(0, { actionable: true }), refusal("body_owned_by_navigation")],
  },
  {
    // The Mod's own word for what holds the actor, with the detail it published for it.
    source: "disposition",
    holder: "modal/DialogueBox",
    facts: [readingAt(0, { actionable: false, actorDispositionKind: "modal", actorDispositionDetail: "DialogueBox" })],
  },
  {
    // A performance absorbs the actor: `event` is the wire's kind for a cutscene, and it is held even when the engine
    // would admit a command (a mounted minigame reports `actionable: true`).
    source: "disposition",
    holder: "event",
    facts: [readingAt(0, { actionable: true, actorDispositionKind: "event" })],
  },
  {
    // Not actionable, and the snapshot named nobody: the absence IS the reading, and inventing a holder for it would be a
    // guess about a world that did not say.
    source: "unnamed_engine_gate",
    holder: undefined,
    facts: [readingAt(0, { actionable: false })],
  },
];

/** The shapes that are NOT a hold, each for a reason the pump can state. */
const FREE: readonly Readonly<{ name: string; facts: readonly WorldFact[] }>[] = [
  { name: "a free body", facts: [readingAt(0, { actionable: true })] },
  { name: "the wire's idle disposition", facts: [readingAt(0, { actionable: true, actorDispositionKind: "idle" })] },
  {
    // A walk the Mod owns: `transient` is a hold a command can take over, which is why it reads as actionable and is not
    // a body anything has to wait for. Reading it as held would stop the idle read (`a_held_body`) over a moving body.
    name: "a transient the engine would let a command take over",
    facts: [readingAt(0, { actionable: true, actorDispositionKind: "transient" })],
  },
  { name: "a session that has never read the world", facts: [] },
];

/**
 * `a_held_body_is_named_by_the_fact_that_holds_it: every source is reachable` - THE GATE.
 *
 * Prints the population it examined, so "no unnamed holder" cannot be a file that read nothing.
 */
test("a_held_body_is_named_by_the_fact_that_holds_it: every source the pump can answer is produced by a fact", () => {
  const named = new Map<BodyHoldSource, number>();
  for (const held of HELD) {
    const pump = pumpHolding(held.facts);
    assert.deepEqual(
      { ...pump.bodyHeldBy },
      { source: held.source, holder: held.holder },
      `${held.source} must be named by the facts it is read from (${held.facts.map((fact) => fact.eventId ?? fact.correlationId).join(", ")})`,
    );
    assert.equal(pump.bodyHeldByEngine, true, `${held.source}: and the one-bit reading agrees that the body is held`);
    named.set(held.source, (named.get(held.source) ?? 0) + 1);
  }

  assert.deepEqual(
    [...BODY_HOLDS].sort(),
    [...named.keys()].sort(),
    `the pump can answer ${BODY_HOLDS.join(", ")}, and a source no fact shape produces is a name for a condition ` +
      `nothing proves is reachable (produced: ${[...named.keys()].join(", ")})`,
  );
  for (const free of FREE) {
    const pump = pumpHolding(free.facts);
    assert.equal(
      pump.bodyHeldBy,
      undefined,
      `${free.name}: the body is not held, and "held" is not the default the reading falls back to`,
    );
    assert.equal(pump.bodyHeldByEngine, false, `${free.name}: the one-bit reading says free, not held`);
  }
  console.log(
    `a_held_body_is_named_by_the_fact_that_holds_it: sources ${String(BODY_HOLDS.length)} · named ` +
      `{${HELD.map((held) => `${held.source}:${held.holder ?? "<unnamed>"}`).join(", ")}} · free ${String(FREE.length)}`,
  );
});

/**
 * `a_held_body_is_named_by_the_fact_that_holds_it: the holder is the Mod's own word` - cross-checked against the line
 * the model is already handed.
 *
 * <p>
 * ONE HOLDER, TWO SURFACES. Her per-turn body line is rendered by `formatBodyState` from the same two snapshot fields, so
 * the artifact's `heldBy` and the prompt's `持有:` must be the same token: two spellings of one holder would let the run
 * report a body held by one thing while the model was told another.
 * </p>
 */
test("a_held_body_is_named_by_the_fact_that_holds_it: the holder is the word her own body line prints", () => {
  const held = { actionable: false, actorDispositionKind: "modal", actorDispositionDetail: "DialogueBox" };
  const holder = pumpHolding([readingAt(0, held)]).bodyHeldBy?.holder;
  assert.ok(holder !== undefined && holder.length > 0, "a disposition with a detail names the holder");
  const line = formatBodyState(held, true);
  assert.ok(
    line.includes(holder),
    `the run's \`heldBy\` and the prompt's body line name one holder: \`${holder}\` is not in \`${line}\``,
  );
  assert.ok(line.includes("持有"), `and the line says it is a hold: ${line}`);
});

/**
 * `a_held_body_is_named_by_the_fact_that_holds_it: the wait names the holder` - the half `a_free_body` could not say.
 *
 * <p>
 * The wait belongs to the turn that closed, so its holder is taken AT THE SETTLEMENT: a hold that ended between that turn
 * and a reader's question is not that turn's answer, and recomputing it would describe a different turn than `turn` names.
 * The population is `TURN_WITHOUT_ACTION_REASONS`, so a condition added there is driven here by name.
 * </p>
 */
test("a_held_body_is_named_by_the_fact_that_holds_it: the wait names the holder the turn measured", async () => {
  const pump = new CompanionEventPump(undefined, () => NOW_MS);
  const sink = speakingSink(pump);

  // TURN ONE: a reading arrives WITH the settlement, so the pump holds a picture it has shown her.
  pump.enqueueFact(readingAt(0, { actionable: true }), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(settlementFact("program_settled_plan_holder_1", NOW_MS), FACT_PRODUCER.adapterIngress);
  await pump.flush(sink);
  assert.equal(pump.closedWithNothing.heldBy, undefined, "a turn that did nothing about the body names no holder");

  // TURN TWO: the engine mounts a menu, a clock mark opens the turn, and the turn can do nothing but speak.
  pump.enqueueFact(
    readingAt(1, { actionable: false, actorDispositionKind: "modal", actorDispositionDetail: "DialogueBox" }),
    FACT_PRODUCER.adapterIngress,
  );
  pump.enqueueFact(milestoneFact(600, NOW_MS + 60_000), FACT_PRODUCER.adapterIngress);
  await pump.flush(sink);

  assert.equal(
    pump.closedWithNothing.shape?.split(":").at(-1),
    TURN_WITHOUT_ACTION_REASON.bodyHeld,
    "the turn must have measured the body, or the holder below is about a different condition",
  );
  assert.equal(
    pump.closedWithNothing.waitingFor,
    CLOSED_WITH_NOTHING_WAIT_FOR.freeBody,
    "the wait is the body",
  );
  assert.deepEqual(
    pump.closedWithNothing.heldBy,
    { source: "disposition", holder: "modal/DialogueBox" },
    "and it says WHICH holder, so the reader knows whether to answer a modal or wait out a cutscene",
  );

  // THE HOLD ENDS, AND THE WAIT DOES NOT MOVE WITH IT: a body that is free now says nothing about who held the turn.
  pump.enqueueFact(readingAt(2, { actionable: true }), FACT_PRODUCER.adapterIngress);
  assert.equal(pump.bodyHeldBy, undefined, "the body is free again");
  assert.deepEqual(
    pump.closedWithNothing.heldBy,
    { source: "disposition", holder: "modal/DialogueBox" },
    "and the wait still describes the turn it belongs to, not the reading that arrived after it",
  );
});

/**
 * `a_held_body_is_named_by_the_fact_that_holds_it: every other wait names no holder`
 *
 * <p>
 * The field is not a second, always-on reading: for the four other conditions a turn can close with, and for a turn that
 * acted, the holder is `undefined`. A pump that carried the body's name beside a reading's wait would answer the wrong
 * question with the right word - the defect `nothing_owed` was.
 * </p>
 */
test("a_held_body_is_named_by_the_fact_that_holds_it: only the body's wait carries a holder", async () => {
  const pump = new CompanionEventPump(undefined, () => NOW_MS);
  const sink = speakingSink(pump);

  // A BODY THAT IS HELD THROUGHOUT: if the holder field were computed rather than captured per wait, every one of the
  // turns below would carry it, whatever condition it measured.
  pump.enqueueFact(
    readingAt(0, { actionable: false, actorDispositionKind: "modal" }),
    FACT_PRODUCER.adapterIngress,
  );
  // Turn one closes `no_reading`-free: the reading came WITH the turn, so the condition is the body.
  pump.enqueueFact(milestoneFact(700, NOW_MS + 10_000), FACT_PRODUCER.adapterIngress);
  await pump.flush(sink);
  assert.equal(pump.closedWithNothing.heldBy?.holder, "modal", "the body's own turn names the modal holding it");

  // A person speaks over a reading she has already been shown: `world_stale`, not the body.
  pump.enqueueFact(milestoneFact(701, NOW_MS + 20_000), FACT_PRODUCER.adapterIngress);
  await pump.flush(sink);
  assert.equal(
    pump.closedWithNothing.waitingFor,
    CLOSED_WITH_NOTHING_WAIT_FOR.freshReading,
    "a turn handed a reading it did not bring waits for a reading",
  );
  assert.equal(
    pump.closedWithNothing.heldBy,
    undefined,
    `and names no holder, even while the body is held (${CLOSED_WITH_NOTHING_WAIT_FOR.freshReading})`,
  );
  assert.notEqual(pump.bodyHeldBy, undefined, "the pump still reads the body as held: the field above is the turn's");
});
