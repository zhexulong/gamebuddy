import assert from "node:assert/strict";
import test from "node:test";
import {
  CARRIED,
  CARRY_HOLD_BOUND_MS,
  CompanionEventPump,
  CONSUMED,
  FACT_PRODUCER,
  FACT_TURN_CONSEQUENCE,
  HELD,
  LOST,
  NOT_OWED,
  type PendingBatch,
  turnAccountLine,
  type WorldFact,
} from "./event-pump.js";
import { PRESENTATION_LEASE_KINDS } from "./presentation-lease.js";
import { PROGRAM_SETTLED_DIGEST_SEMANTIC_KIND } from "./program-settlement-digest.js";

/**
 * `a_carried_fact_has_a_consumer:<site>`.
 *
 * <p>
 * MEASURED 2026-11-18 (`round68`, seven minutes): `turns opened 8` and then **347 seconds of nothing** - `COMPANION_ACTIVITY
 * {state:"idle"}` and not another line - while the account said `not owed 2 {… no_surface_for: 2 {receipt:succeeded: 2}}`
 * and `carried 2`. Two settlements were judged unpresentable, handed a `CarryTicket`, and **nobody ever consumed them**:
 * a carry is a promise that a later batch will take the fact, and no later batch ever opened. That is
 * `fact_flushed_then_discarded` in a newer spelling - the fact is not in the prompt, not in the account as a loss, and not
 * anywhere a reader can find it.
 * </p>
 * <p>
 * THE PROPERTY IS A DISJUNCTION, AND BOTH ARMS ARE MEASURED: every fact the pump carries is (a) CONSUMED by a turn - the
 * ticket resolves to the batch and the fact is in it - or (b) LOST by name within `CARRY_HOLD_BOUND_MS`, counted under the
 * shape that could not present (`receipt:succeeded`). Nothing may sit in between, and the ledger has to close:
 * `carried === consumed + lost + held` for every reading, so a fact cannot leave the ledger by any third door.
 * </p>
 * <p>
 * WHAT IT IS NOT. It is not a licence to open a turn per settlement: `a_turn_is_opened_where_no_surface_can_present`
 * (`event-pump.turn-surface.test.ts`) refuses a turn whose batch carries no presentation source, and the loss arm here
 * asserts that NO batch was delivered - the fact is named lost rather than bought a prompt nobody can see. It is not a
 * licence to call everything lost either: the consumed arm fails if the pump reports a fact lost that a presentable fact
 * actually carried.
 * </p>
 * <p>
 * THE POPULATION IS THE PUMP'S OWN ANSWER. Every `decision` shape in `FACT_TURN_CONSEQUENCE` is driven through one flush,
 * and the ones the pump answers `not_owed` for ARE the facts it carries - so a shape added to the classification, or a lease
 * kind removed from `PRESENTATION_LEASE_KINDS`, changes the population without this file changing. It refuses to pass on an
 * empty population.
 * </p>
 */

type Sink = Readonly<{ deliver(batch: PendingBatch): Promise<void> }>;

function recorder(): Readonly<{ batches: PendingBatch[]; sink: Sink }> {
  const batches: PendingBatch[] = [];
  return {
    batches,
    sink: {
      async deliver(batch) {
        batches.push(batch);
      },
    },
  };
}

/**
 * A pump whose clock the case moves, so "how long has this been waiting" is a measurement and not a sleep.
 *
 * `now` is the pump's own clock port: the bound is a duration, so a test that could not move time could only prove it by
 * waiting `CARRY_HOLD_BOUND_MS` in real seconds, which is not a test anyone would keep.
 */
function clock(): Readonly<{ now: () => number; advance: (ms: number) => void }> {
  let at = 1_700_000_000_000;
  return {
    now: () => at,
    advance: (ms) => {
      at += ms;
    },
  };
}

/** A lease-kind world fact: the Mod's own HUD line, carrying the opaque identity the lease needs. */
function presentableFact(kind: string, sourceEventId = `fact_${kind}`): WorldFact {
  return {
    source: "stardew_mod",
    kind: "world_fact",
    eventId: `event_${kind}`,
    sourceEventId,
    correlationId: `fact_${kind}`,
    revision: 1,
    occurredAtMs: 5,
    semanticKind: kind,
    payload: { kind },
  };
}

/** A world fact the surface was never told about: `modal_presented` is on no lease list (`round66` published eight). */
function unpresentableWorldFact(): WorldFact {
  return presentableFact("modal_presented");
}

/** A node's terminal receipt, in the wire's own shape: `protocol/bridge-v1.schema.json#receipt` has no event identity. */
function terminalReceipt(state: string, suffix = ""): WorldFact {
  return {
    source: "stardew_mod",
    kind: "execution_receipt",
    eventId: `receipt_${state}${suffix}`,
    correlationId: `receipt_${state}${suffix}`,
    revision: 1,
    occurredAtMs: 5,
    executionId: `exec_${state}${suffix}`,
    requestId: `request_${state}${suffix}`,
    payload: {
      actionId: "harvest_crop",
      state,
      reasonCode: "crop_harvested",
      revision: 1,
      evidence: null,
      origin: { kind: "programme", programId: "plan_1", nodeId: "n001" },
    },
  };
}

function semanticEvent(kind: string): WorldFact {
  return {
    source: "stardew_mod",
    kind: "semantic_event",
    eventId: `semantic_${kind}`,
    correlationId: `semantic_${kind}`,
    revision: 1,
    occurredAtMs: 5,
    payload: { kind, revision: 1, reasonCode: "body_trace" },
  };
}

/** The settled-plan digest, in the one shape `settledProgramOutcome` reads: a total and the Mod's own node counts. */
function settlement(outcome: string): WorldFact {
  const won = outcome === "succeeded";
  return {
    source: "host_game_session",
    kind: "world_fact",
    eventId: "program_settled_plan_1",
    sourceEventId: "program_settled_plan_1",
    correlationId: "program_settled_plan_1",
    revision: 0,
    occurredAtMs: 5,
    semanticKind: PROGRAM_SETTLED_DIGEST_SEMANTIC_KIND,
    payload: {
      kind: PROGRAM_SETTLED_DIGEST_SEMANTIC_KIND,
      programId: "plan_1",
      settledAtMs: 4,
      total: 1,
      counts: won ? { succeeded: 1 } : { rejected: 1 },
      ok: won,
      reason: won ? null : "#0 harvest_crop:rejected",
      summary: won ? "1/1 完成" : "0/1 完成",
      nodes: [],
      omitted: 0,
    },
  };
}

function lifecycleFact(): WorldFact {
  return {
    source: "host_transport",
    kind: "lifecycle",
    eventId: "lifecycle_adapter_offline",
    correlationId: "lifecycle_adapter_offline",
    revision: 1,
    occurredAtMs: 5,
    payload: { kind: "disconnected" },
  };
}

/** One fact per shape the classification calls a `decision`, in the pump's own shape spelling (`factTurnShape`). */
function factOfShape(shape: string): WorldFact {
  if (shape.startsWith("receipt:")) return terminalReceipt(shape.slice("receipt:".length));
  if (shape.startsWith("semantic:")) return semanticEvent(shape.slice("semantic:".length));
  if (shape.startsWith("settled:")) return settlement(shape.slice("settled:".length));
  if (shape === "lifecycle") return lifecycleFact();
  return unpresentableWorldFact();
}

test("a_carried_fact_has_a_consumer: every carried fact is consumed by a turn, or named lost within the bound", async () => {
  const decisions = Object.entries(FACT_TURN_CONSEQUENCE)
    .filter(([, consequence]) => consequence === "decision")
    .map(([shape]) => shape);
  assert.ok(
    decisions.length > 0,
    "decision shapes examined 0: the classification declares nothing this gate could drive",
  );
  assert.ok(
    CARRY_HOLD_BOUND_MS > 0,
    "the bound must be a stated duration: a carry with no bound is the `carried 2` of `round68`, which nothing ever consumed",
  );

  const carried: string[] = [];
  const consumedCases: string[] = [];
  const lostCases: string[] = [];

  for (const shape of decisions) {
    // DIRECTION ONE: carried, then a presentable fact arrives. That fact is the consumer, and the ledger has to say so.
    const consumerClock = clock();
    const withConsumer = new CompanionEventPump(
      () => Object.freeze({ programmes: [], omittedProgrammes: 0 }),
      consumerClock.now,
    );
    const consumedTurns = recorder();
    withConsumer.enqueueFact(factOfShape(shape), FACT_PRODUCER.adapterIngress);
    const first = await withConsumer.flush(consumedTurns.sink);
    if (first.kind === "opened") {
      // A shape that opens its own turn is not carried at all: a wake or a lease kind. Its own gate covers it.
      assert.equal(consumedTurns.batches.length, 1, `${shape}: an opened turn must be a delivery`);
      continue;
    }
    assert.equal(
      first.kind,
      "not_owed",
      `${shape}: a fact either opens a turn or is answered not-owed (${first.kind})`,
    );
    assert.ok(first.kind === "not_owed");
    assert.equal(first.reason, NOT_OWED.noSurface, `${shape}: the pump carries it, and says why (${first.reason})`);
    carried.push(shape);

    // The ticket names it, and "carried" says somebody WILL consume it: that promise is the thing being measured.
    const before = withConsumer.turnAccount.carry;
    assert.equal(before.held, 1, `${shape}: a carried fact is held until a batch takes it`);
    assert.equal(before.lostTotal, 0, `${shape}: nothing has been lost while the consumer is still possible`);
    assert.equal(before.consumed, 0, `${shape}: and nothing has been consumed yet`);
    assert.equal(
      before.carried,
      before.consumed + before.lostTotal + before.held,
      `${shape}: the ledger must close - carried = consumed + lost + held`,
    );

    withConsumer.enqueueFact(presentableFact("time_milestone"), FACT_PRODUCER.adapterIngress);
    const opened = await withConsumer.flush(consumedTurns.sink);
    assert.equal(
      opened.kind,
      "opened",
      `${shape}: the next presentable fact opens the turn the carried fact waits for`,
    );
    assert.ok(opened.kind === "opened");
    assert.equal(
      withConsumer.carriedInto(first.carry),
      opened.batchId,
      `${shape}: the ticket resolves to the batch that consumed it`,
    );
    assert.ok(
      consumedTurns.batches.at(-1)!.facts.some((fact) => fact.eventId === factOfShape(shape).eventId),
      `${shape}: and the fact is IN that batch - consumption is proved by arrival, not by the counter`,
    );
    const afterConsume = withConsumer.turnAccount.carry;
    assert.equal(afterConsume.consumed, 1, `${shape}: the consumption is counted`);
    assert.equal(afterConsume.held, 0, `${shape}: and nothing is left waiting`);
    assert.equal(
      afterConsume.lostTotal,
      0,
      `${shape}: a fact that arrived was never lost - reporting it lost is the lie this arm refuses`,
    );
    assert.equal(
      afterConsume.carried,
      afterConsume.consumed + afterConsume.lostTotal + afterConsume.held,
      `${shape}: the ledger still closes`,
    );
    consumedCases.push(shape);

    // DIRECTION TWO: carried, and then NOTHING. This is `round68`: no presentable fact ever comes, so the promise expires
    // and the only honest answer is a loss with the shape's name on it.
    const silentClock = clock();
    const noConsumer = new CompanionEventPump(
      () => Object.freeze({ programmes: [], omittedProgrammes: 0 }),
      silentClock.now,
    );
    const silentTurns = recorder();
    noConsumer.enqueueFact(factOfShape(shape), FACT_PRODUCER.adapterIngress);
    const declined = await noConsumer.flush(silentTurns.sink);
    assert.equal(declined.kind, "not_owed", `${shape}: the first answer carries it (${declined.kind})`);

    // The boundary: one millisecond short of the bound the fact is still "somebody will consume it".
    silentClock.advance(CARRY_HOLD_BOUND_MS - 1);
    const held = noConsumer.turnAccount.carry;
    assert.equal(held.held, 1, `${shape}: inside the bound the fact is held, not lost`);
    assert.equal(held.lostTotal, 0, `${shape}: and no loss is reported before the bound has passed`);

    // At the bound it is lost, by name, and no turn was opened to keep it.
    silentClock.advance(1);
    const lost = noConsumer.turnAccount.carry;
    assert.equal(
      lost.held,
      0,
      `${shape}: past the bound nothing is still "waiting" - that is the 347 seconds of silence`,
    );
    assert.equal(lost.lostTotal, 1, `${shape}: the fact is LOST, which is the state that was missing`);
    assert.deepEqual(
      lost.lost,
      { [shape === "world_fact" ? "world_fact:modal_presented" : shape]: 1 },
      `${shape}: and the loss names the shape that could not present`,
    );
    assert.equal(lost.consumed, 0, `${shape}: it was never consumed`);
    assert.equal(
      lost.carried,
      lost.consumed + lost.lostTotal + lost.held,
      `${shape}: the ledger closes across the loss too - a fact cannot leave it by a third door`,
    );
    assert.equal(
      silentTurns.batches.length,
      0,
      `${shape}: the loss is NAMED, not bought - no turn is opened whose batch carries no presentation source`,
    );
    lostCases.push(shape);
  }

  const tally = `shapes examined ${String(decisions.length)} · carried ${String(carried.length)} · consumed ${String(consumedCases.length)} · lost ${String(lostCases.length)} · lease kinds ${String(PRESENTATION_LEASE_KINDS.length)}`;
  assert.ok(
    carried.length > 0,
    `${tally}: no fact was carried, so this gate tested a path no fact takes - a population of zero is not a pass`,
  );
  assert.ok(
    consumedCases.length > 0,
    `${tally}: no carried fact was ever consumed, so the consumed arm proves nothing`,
  );
  assert.ok(lostCases.length > 0, `${tally}: no carried fact ever expired, so the loss arm proves nothing`);
  console.log(
    `${CARRIED} ${String(carried.length)} · ${CONSUMED} ${String(consumedCases.length)} · ${LOST} ${String(lostCases.length)} · ${HELD} 0 · ${tally}`,
  );
});

/**
 * THE REPRODUCTION, in the run's own units: `round68`'s last two settlements, and then nothing for 347 seconds.
 *
 * <p>
 * Two terminal receipts is what the account named (`no_surface_for: 2 {receipt:succeeded: 2}`) and `carried 2` is what it
 * printed for them. The falsifier is the second half: after the settle, NO further fact arrives - so the read has to say
 * `lost 2 {receipt:succeeded: 2}` in the line a run's log carries, or the run goes quiet having said nothing about two
 * answers the model was never given. 347 s is the measured silence, not a shape of it: any duration past
 * `CARRY_HOLD_BOUND_MS` takes this path.
 * </p>
 */
test("a_carried_fact_has_a_consumer:round68 - two settlements with no lease, then 347 s of nothing, are named lost", async () => {
  const runClock = clock();
  const pump = new CompanionEventPump(() => Object.freeze({ programmes: [], omittedProgrammes: 0 }), runClock.now);
  const turns = recorder();

  pump.enqueueFact(terminalReceipt("succeeded", "_a"), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(terminalReceipt("succeeded", "_b"), FACT_PRODUCER.adapterIngress);
  const flushed = await pump.flush(turns.sink);
  assert.equal(flushed.kind, "not_owed", `two receipts with no surface owe no turn of their own (${flushed.kind})`);
  assert.ok(flushed.kind === "not_owed");
  assert.equal(flushed.reason, NOT_OWED.noSurface, "and the answer names the surface");
  assert.equal(turns.batches.length, 0, "no batch is composed for a call that owes no turn");

  const waiting = pump.turnAccount.carry;
  assert.equal(waiting.held, 2, "both are held: the promise is that the next turn carries them");
  assert.equal(waiting.lostTotal, 0, "and nothing is lost yet");
  console.log(
    `${CARRIED} ${String(waiting.carried)} · ${CONSUMED} ${String(waiting.consumed)} · ${LOST} ${String(waiting.lostTotal)} · ${HELD} ${String(waiting.held)} · at 0 s`,
  );

  // THE SILENCE. Nothing else arrives - no clock mark, no notice, no settlement - and the run's own report is the only
  // thing that asks the pump what happened.
  runClock.advance(347_000);
  const account = pump.turnAccount;
  const line = turnAccountLine(account);
  console.log(
    `${CARRIED} ${String(account.carry.carried)} · ${CONSUMED} ${String(account.carry.consumed)} · ${LOST} ${String(account.carry.lostTotal)} · ${HELD} ${String(account.carry.held)} · at 347 s`,
  );

  assert.equal(account.carry.held, 0, "nothing may still be described as waiting after 347 s: nobody is coming");
  assert.equal(account.carry.lostTotal, 2, "both settlements are losses, and the count is the whole point");
  assert.deepEqual(
    account.carry.lost,
    { "receipt:succeeded": 2 },
    "and the loss names the shape the surface refused, in the same vocabulary as `no_surface_for`",
  );
  assert.equal(
    account.carry.carried,
    account.carry.consumed + account.carry.lostTotal + account.carry.held,
    "the ledger closes: carried = consumed + lost + held",
  );
  assert.match(
    line,
    new RegExp(`${CARRIED} 2 · ${CONSUMED} 0 · ${LOST} 2 \\{receipt:succeeded: 2\\} · ${HELD} 0`, "u"),
    `the line a run's log carries must say it: ${line}`,
  );
  assert.equal(turns.batches.length, 0, "and not one turn was opened to carry a fact no surface could show");
});

/**
 * THE FALSIFIER, in the other direction: a pump that answered "lost" for everything would pass the reproduction and fail
 * here. A carried fact that a later presentable fact consumes must never be counted as a loss.
 */
test("a_carried_fact_has_a_consumer: the cheapest wrong answer - calling every carry lost - is refused", async () => {
  const runClock = clock();
  const pump = new CompanionEventPump(() => Object.freeze({ programmes: [], omittedProgrammes: 0 }), runClock.now);
  const turns = recorder();
  pump.enqueueFact(terminalReceipt("succeeded"), FACT_PRODUCER.adapterIngress);
  await pump.flush(turns.sink);

  // Slow, but inside the bound: the world speaks again and the fact rides that turn.
  runClock.advance(CARRY_HOLD_BOUND_MS - 1_000);
  pump.enqueueFact(presentableFact("native_notice"), FACT_PRODUCER.adapterIngress);
  const opened = await pump.flush(turns.sink);
  assert.equal(opened.kind, "opened", `a late but real consumer still opens the turn (${opened.kind})`);

  const account = pump.turnAccount;
  assert.equal(account.carry.consumed, 1, "the fact arrived, so it is consumed");
  assert.equal(account.carry.lostTotal, 0, "and a consumed fact is not a loss - this is the arm the cheat fails");
  assert.equal(account.carry.held, 0, "with nothing left waiting");
});

/**
 * THE OTHER BOUND: a window wide enough to evict a ticketed fact must count that as a loss too, or the ledger would have
 * a third door - the arithmetic that makes `carried 2` readable at all.
 */
test("a_carried_fact_has_a_consumer: a carried fact the window bound drops is a named loss, not a silent one", async () => {
  const pump = new CompanionEventPump(() => Object.freeze({ programmes: [], omittedProgrammes: 0 }), clock().now);
  const turns = recorder();
  pump.enqueueFact(terminalReceipt("succeeded"), FACT_PRODUCER.adapterIngress);
  await pump.flush(turns.sink);
  assert.equal(pump.turnAccount.carry.held, 1, "the receipt is carried");

  // A newer fact in the same slot: the same execution's next statement supersedes it, and the carry's promise goes with it.
  pump.enqueueFact(
    {
      ...terminalReceipt("failed"),
      correlationId: "receipt_succeeded",
      executionId: "exec_succeeded",
      eventId: "receipt_again",
    },
    FACT_PRODUCER.adapterIngress,
  );
  const account = pump.turnAccount.carry;
  assert.equal(
    account.carried,
    account.consumed + account.lostTotal + account.held,
    `the ledger closes when a window bound takes a fact: ${JSON.stringify(account)}`,
  );
});
