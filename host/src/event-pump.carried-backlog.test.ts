import assert from "node:assert/strict";
import test from "node:test";
import {
  BACKLOG_BOUND,
  CARRIED_BACKLOG_BOUND_MS,
  CARRIED_BACKLOG_SEMANTIC_KIND,
  CARRY_HOLD_BOUND_MS,
  CARRIED,
  CompanionEventPump,
  CONSUMED,
  describeWorldChange,
  FACT_PRODUCER,
  FACT_TURN_CONSEQUENCE,
  factShapeName,
  factWindow,
  HELD,
  LOST,
  BACKLOG_TURNS_OPENED,
  NOT_OWED,
  OLDEST_HELD_MS,
  type PendingBatch,
  turnAccountLine,
  TURN_OPENING,
  type WorldFact,
} from "./event-pump.js";
import { PRESENTATION_LEASE_KINDS, presentationSourceOf } from "./presentation-lease.js";
import { PROGRAM_SETTLED_DIGEST_SEMANTIC_KIND } from "./program-settlement-digest.js";
import type { InFlightProgrammeReading } from "./program-status-wait.js";

/**
 * `a_held_fact_has_no_reader:<n>` - the bound that makes a carried fact a FACT ABOUT THE BACKLOG.
 *
 * <p>
 * MEASURED 2026-11-18 (`round72`, and `round69` before it): `carried 21 · consumed 16 · lost 0 · held 5`, and then **166
 * seconds idle** - one `idle` span, which is the run trace's own proof that no flush was attempted, because `HostService`
 * opens and closes that span around every `flushSoon`. The five were terminal receipts: `presentationSourceOf` answers
 * `undefined` for a receipt, so no turn ever opened for them, and nothing else happened to open one either. The carry bound
 * (added for `round68`) made that honest - they age out by name - and useless: the work they answered had already happened
 * and was thrown away, in a run that had just cut twenty weeds in one stretch.
 * </p>
 *
 * <p>
 * THE PROPERTY, and it is a DISJUNCTION with a stated bound: every fact this pump carries is (a) consumed by a turn, or
 * (b) named by the pump's own backlog fact within `CARRIED_BACKLOG_BOUND_MS` - or (c) lost by name at the carry bound.
 * `held H` inside the bound with `named 0` and no consumption is the state this gate fails on, and it fails by naming the
 * fact shape that is waiting.
 * </p>
 *
 * <p>
 * WHAT IT IS NOT. It is not "every settlement opens a turn": a settlement still opens NO turn of its own
 * (`event-pump.turn-surface.test.ts`), and the backlog is ONE utterance about N facts, not N. `round66`'s 60 bubbles in 120
 * turns and `round67`'s `adapter_ingress 33` are what a fact-per-event turn costs, and the falsifiers at the bottom of this
 * file are the three ways this could become that: naming a backlog with nothing held, naming one before the bound, and
 * naming one when the plan's own answer is already on its way.
 * </p>
 *
 * <p>
 * THE POPULATION IS DERIVED from `FACT_TURN_CONSEQUENCE`, so a decision shape added to the classification is driven here
 * without this file changing, and the ones that open their own turn are excluded by the pump's own answer rather than by a
 * list.
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

/** A pump whose clock the case moves, so "how long has this been waiting" is a measurement and not a sleep. */
function clock(): Readonly<{ now: () => number; advance: (ms: number) => void }> {
  let at = 1_700_000_000_000;
  return {
    now: () => at,
    advance: (ms) => {
      at += ms;
    },
  };
}

/** No plan: the journal says nothing is running, which is the state `round72` sat in when the backlog was all there was. */
const NO_PLAN: InFlightProgrammeReading = Object.freeze({ programmes: Object.freeze([]), omittedProgrammes: 0 });

/** A plan with nodes left: its settlement is presentable, so it is the turn the carried facts are waiting for. */
function runningPlan(remaining: number): InFlightProgrammeReading {
  return {
    programmes: [
      {
        programId: "plan_cut_weeds",
        total: 3,
        settled: 3 - remaining,
        remaining,
        readAgeMs: 400,
        nodes: [],
        omitted: 0,
        unsettledTiles: [],
      },
    ],
    omittedProgrammes: 0,
  };
}

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

/** The backlog fact a batch carries, if this turn is one the bound opened. */
function backlogOf(batch: PendingBatch | undefined): WorldFact | undefined {
  return batch?.facts.find((fact) => fact.semanticKind === CARRIED_BACKLOG_SEMANTIC_KIND);
}

test("a_held_fact_has_no_reader: every carried fact is read by the turn the bound opens, or named lost", async () => {
  const decisions = Object.entries(FACT_TURN_CONSEQUENCE)
    .filter(([, consequence]) => consequence === "decision")
    .map(([shape]) => shape);
  assert.ok(
    decisions.length > 0,
    "decision shapes examined 0: the classification declares nothing this gate could drive",
  );
  // THE ORDER OF THE TWO BOUNDS IS THE WHOLE DESIGN: the backlog has to name the wait while the facts can still be read,
  // and the carry bound is what ends the promise when even that did not work.
  assert.ok(
    CARRIED_BACKLOG_BOUND_MS < CARRY_HOLD_BOUND_MS,
    `the backlog bound (${String(CARRIED_BACKLOG_BOUND_MS)} ms) must be shorter than the carry bound ` +
      `(${String(CARRY_HOLD_BOUND_MS)} ms): a backlog that names the wait only after the promise has ended is a loss report`,
  );

  const held: string[] = [];
  const consumed: string[] = [];
  const named: string[] = [];
  const agedOut = 0;

  for (const shape of decisions) {
    const runClock = clock();
    const pump = new CompanionEventPump(() => NO_PLAN, runClock.now);
    const turns = recorder();
    pump.enqueueFact(factOfShape(shape), FACT_PRODUCER.adapterIngress);
    const first = await pump.flush(turns.sink);
    if (first.kind === "opened") {
      // A shape that opens its own turn is never carried, so the backlog never has to name it. Its own gate covers it.
      assert.equal(turns.batches.length, 1, `${shape}: an opened turn must be a delivery`);
      continue;
    }
    assert.equal(
      first.kind,
      "not_owed",
      `${shape}: a fact either opens a turn or is answered not-owed (${first.kind})`,
    );
    assert.equal(pump.turnAccount.carry.held, 1, `${shape}: the fact is held - this is the population`);
    held.push(shape);

    // INSIDE THE BOUND NOTHING IS BACKLOG_TURNS_OPENED: a fact that arrives while a turn is running is read by the next turn, and that
    // turn is the ordinary consumer this bound may not pre-empt.
    runClock.advance(CARRIED_BACKLOG_BOUND_MS - 1);
    const inside = pump.turnAccount.carry;
    assert.equal(inside.named, 0, `${shape}: no backlog fact before the bound has passed`);
    assert.equal(inside.held, 1, `${shape}: and the fact is still held, not lost`);
    assert.equal(inside.oldestHeldMs, CARRIED_BACKLOG_BOUND_MS - 1, `${shape}: the wait is the measurement`);

    // AT THE BOUND the pump opens the turn itself, and the fact is IN it - consumption proved by arrival, not by a counter.
    runClock.advance(1);
    const opened = await pump.flush(turns.sink);
    assert.equal(
      opened.kind,
      "opened",
      `${shape}: past the bound the pump must open the turn that reads it, or the fact ages out unread (${opened.kind})`,
    );
    assert.ok(opened.kind === "opened");
    const batch = turns.batches.at(-1);
    const backlog = backlogOf(batch);
    assert.notEqual(backlog, undefined, `${shape}: the turn is opened BY the backlog fact, so the batch carries it`);
    assert.equal(backlog?.payload.held, 1, `${shape}: and it names one fact, which is what is waiting`);
    assert.deepEqual(
      backlog?.payload.families,
      [factShapeName(factOfShape(shape))],
      `${shape}: and the family it names is the pump's own spelling of the shape that waited`,
    );
    assert.ok(
      batch?.facts.some((fact) => fact.eventId === factOfShape(shape).eventId),
      `${shape}: the fact itself rides that batch - the turn reads the outcome, not a summary of it`,
    );
    assert.ok(
      batch?.text.includes("1 份结果没读到"),
      `${shape}: and the model-facing line says what is waiting: ${batch?.text}`,
    );
    assert.equal(
      pump.turnAccount.openedByProducer[TURN_OPENING.due][FACT_PRODUCER.carriedBacklog],
      1,
      `${shape}: the account credits the pump's own entrance for the turn, so the bound is countable in every run`,
    );

    const after = pump.turnAccount.carry;
    assert.equal(after.held, 0, `${shape}: nothing is left waiting`);
    assert.equal(after.consumed, 1, `${shape}: the fact arrived`);
    assert.equal(after.named, 1, `${shape}: the backlog fact that named it is counted`);
    assert.equal(
      after.lostTotal,
      0,
      `${shape}: and a fact a backlog turn read is never a loss - this is the arm the cheat fails`,
    );
    assert.equal(
      after.carried,
      after.consumed + after.lostTotal + after.held,
      `${shape}: the ledger still closes - carried = consumed + lost + held`,
    );
    // EXACTLY ONE: a second flush has nothing to name and must not open a second turn for the same backlog.
    const again = await pump.flush(turns.sink);
    assert.equal(
      again.kind,
      "not_owed",
      `${shape}: the backlog is one utterance, not a standing invitation (${again.kind})`,
    );
    assert.equal(turns.batches.length, 1, `${shape}: and no second turn carries the same backlog`);
    consumed.push(shape);
    named.push(shape);
  }

  const tally =
    `shapes examined ${String(decisions.length)} · held ${String(held.length)} · consumed ${String(consumed.length)} · ` +
    `named ${String(named.length)} · aged-out ${String(agedOut)} · bound ${String(CARRIED_BACKLOG_BOUND_MS)} ms · ` +
    `lease kinds ${String(PRESENTATION_LEASE_KINDS.length)}`;
  assert.ok(held.length > 0, `${tally}: no shape was ever held, so this gate drove a path no fact takes`);
  assert.ok(named.length > 0, `${tally}: no held fact was ever named, so the bound proves nothing`);
  assert.equal(named.length, held.length, `${tally}: every held shape must be named by the bound`);
  // The full line a run's log carries, printed so the three readings are read together.
  const silentClock = clock();
  const silent = new CompanionEventPump(() => NO_PLAN, silentClock.now);
  const silentTurns = recorder();
  silent.enqueueFact(terminalReceipt("succeeded"), FACT_PRODUCER.adapterIngress);
  await silent.flush(silentTurns.sink);
  silentClock.advance(CARRIED_BACKLOG_BOUND_MS);
  await silent.flush(silentTurns.sink);
  const line = turnAccountLine(silent.turnAccount);
  assert.match(
    line,
    new RegExp(
      `${HELD} 0 · ${OLDEST_HELD_MS} 0 · ${BACKLOG_TURNS_OPENED} 1 · ${BACKLOG_BOUND} ${String(CARRIED_BACKLOG_BOUND_MS)}`,
      "u",
    ),
    `the account a run's log carries must state the bound it was measured against: ${line}`,
  );
  assert.match(line, new RegExp(`${CARRIED} 1 · ${CONSUMED} 1 · ${LOST} 0 · ${HELD} 0`, "u"), line);
  console.log(
    `${CARRIED} ${String(held.length)} · ${CONSUMED} ${String(named.length)} · ${BACKLOG_TURNS_OPENED} 1 · ${tally}`,
  );
});

/**
 * THE REPRODUCTION, in the run's own units: `round72`'s five held settlements, and then nothing.
 *
 * <p>
 * Five is what the account named (`held 5`) and 166 s is what the run spent idle. The falsifier half is the second flush:
 * after the backlog turn there is nothing waiting and nothing owed, so the run does not enter a loop - one utterance for
 * five facts, and then silence again.
 * </p>
 */
test("a_held_fact_has_no_reader:round72 - five settlements, 166 s, and one turn that reads them", async () => {
  const runClock = clock();
  const pump = new CompanionEventPump(() => NO_PLAN, runClock.now);
  const turns = recorder();
  for (let index = 0; index < 5; index += 1)
    pump.enqueueFact(
      terminalReceipt(index % 2 === 0 ? "succeeded" : "failed", `_${String(index)}`),
      FACT_PRODUCER.adapterIngress,
    );
  const first = await pump.flush(turns.sink);
  assert.equal(first.kind, "not_owed", `five receipts with no surface owe no turn of their own (${first.kind})`);
  assert.equal(pump.turnAccount.carry.held, 5, "all five are held: this is the round72 ledger");
  assert.equal(turns.batches.length, 0, "and no batch is composed for a call that owes no turn");

  // THE SILENCE, in the run's own duration. Nothing else arrives - no clock mark, no notice, no settlement.
  runClock.advance(166_000);
  const opened = await pump.flush(turns.sink);
  assert.equal(opened.kind, "opened", `the bound opens the turn nobody else was going to open (${opened.kind})`);
  const batch = turns.batches.at(-1);
  const backlog = backlogOf(batch);
  assert.equal(backlog?.payload.held, 5, "the turn says how many are waiting");
  assert.deepEqual(
    backlog?.payload.families,
    ["receipt:succeeded", "receipt:failed"],
    "and which families they are, oldest first",
  );
  assert.deepEqual(
    backlog?.payload.byFamily,
    { "receipt:succeeded": 3, "receipt:failed": 2 },
    "with the count each family owns, so the message and the ledger cannot disagree",
  );
  assert.ok(batch?.text.includes("有 5 份结果没读到"), `the model is told what the turn is for: ${batch?.text}`);
  const account = pump.turnAccount;
  assert.equal(account.carry.named, 1, "one backlog fact, not one per held fact");
  assert.equal(account.carry.held, 0, "and nothing is left described as waiting");
  assert.equal(account.carry.lostTotal, 0, "the facts were read, so none of them is a loss");
  assert.equal(turns.batches.length, 1, "166 s of silence costs one turn, not five");
});

/**
 * FALSIFIER ONE: nothing held for a long time is nothing to name.
 *
 * The cheapest wrong shape of this change - "after the bound, open a turn" without asking whether anything waits - would
 * make an idle companion talk to itself every 42 s. That is `round45`'s five narrated turns, at a schedule.
 */
test("a_held_fact_has_no_reader:nothing-held - an empty ledger never mints a backlog, however long it waits", async () => {
  const runClock = clock();
  const pump = new CompanionEventPump(() => NO_PLAN, runClock.now);
  const turns = recorder();
  runClock.advance(CARRIED_BACKLOG_BOUND_MS * 40);

  const flushed = await pump.flush(turns.sink);
  assert.equal(flushed.kind, "not_owed", `an empty pump owes no turn (${flushed.kind})`);
  assert.ok(flushed.kind === "not_owed");
  assert.equal(flushed.reason, NOT_OWED.nothingPending, "and the answer names the emptiness, not the surface");
  assert.equal(turns.batches.length, 0, "no turn is opened for a backlog that does not exist");
  const carry = pump.turnAccount.carry;
  assert.equal(carry.named, 0, "and the account says the bound never had to fire");
  assert.equal(pump.carriedBacklog.dueInMs, undefined, "the reading says the same thing: nothing will ever be due");
});

/**
 * FALSIFIER TWO: an ordinary turn inside the bound is the consumer, and the backlog is absorbed into it.
 *
 * This is the shape `round72`'s first sixteen consumptions had: a presentable fact arrives, opens the turn, and the held
 * facts ride it. One turn - not a backlog turn plus the world's turn.
 */
test("a_held_fact_has_no_reader:absorbed - a turn that opens for any other reason first carries the backlog", async () => {
  const runClock = clock();
  const pump = new CompanionEventPump(() => NO_PLAN, runClock.now);
  const turns = recorder();
  pump.enqueueFact(terminalReceipt("succeeded"), FACT_PRODUCER.adapterIngress);
  await pump.flush(turns.sink);
  assert.equal(pump.turnAccount.carry.held, 1, "the receipt is carried");

  runClock.advance(10_000);
  pump.enqueueFact(presentableFact("time_milestone"), FACT_PRODUCER.adapterIngress);
  const opened = await pump.flush(turns.sink);
  assert.equal(opened.kind, "opened", `the world's own presentable fact opens the turn (${opened.kind})`);
  assert.ok(opened.kind === "opened");
  assert.equal(opened.opener, TURN_OPENING.worldFact, "and the opener says the fact opened it, not the bound");
  const batch = turns.batches.at(-1);
  assert.equal(backlogOf(batch), undefined, "no backlog fact is minted: its facts were absorbed into this turn");
  assert.ok(
    batch?.facts.some((fact) => fact.kind === "execution_receipt"),
    "and the held fact travels in that batch, so nothing is lost by the absorption",
  );
  const carry = pump.turnAccount.carry;
  assert.equal(carry.held, 0, "nothing is left waiting after the turn");
  assert.equal(carry.consumed, 1, "the fact arrived");
  assert.equal(carry.named, 0, "the bound never had to name it");
  assert.equal(turns.batches.length, 1, "one turn - never a second");
  assert.equal(
    batch?.events.map((event) => presentationSourceOf(event)).find((id) => id !== undefined),
    "fact_time_milestone",
    "and that turn presents under the world's own identity, which is why it was the better turn to open",
  );
});

/**
 * FALSIFIER THREE: a plan whose nodes are still running is about to answer, so it is NOT a backlog.
 *
 * A backlog turn here would be the `plan_still_running` cost this pump exists to avoid (`follow_up` 9 -> 65), and it would
 * also be a lie: the settlement is presentable, one turn away, and it carries everything the backlog would have said.
 */
test("a_held_fact_has_no_reader:plan-running - the plan's own answer is the turn, not a backlog", async () => {
  const runClock = clock();
  const pump = new CompanionEventPump(() => runningPlan(2), runClock.now);
  const turns = recorder();
  pump.enqueueFact(terminalReceipt("succeeded"), FACT_PRODUCER.adapterIngress);
  await pump.flush(turns.sink);
  assert.equal(pump.turnAccount.carry.held, 1, "the receipt is held while the plan works");

  runClock.advance(CARRIED_BACKLOG_BOUND_MS);
  assert.equal(
    pump.carriedBacklog.dueInMs,
    undefined,
    "a plan with nodes left is not a backlog: the reading says nothing is owed to the silence",
  );
  const flushed = await pump.flush(turns.sink);
  assert.equal(flushed.kind, "not_owed", `the plan's answer is the turn (${flushed.kind})`);
  assert.equal(turns.batches.length, 0, "and no backlog turn was bought while the journal says work is left");
  assert.equal(pump.turnAccount.carry.named, 0, "the bound did not fire");
  assert.equal(pump.turnAccount.carry.held, 1, "the fact is still held for the settlement that is coming");
});

/**
 * `a_backlog_fact_claims_the_world_changed:<site>` - the backlog fact is not a world change, not a snapshot, and not filed
 * in `worldFacts`.
 *
 * <p>
 * WHY A GATE AND NOT A LINE OF PROSE. Three separate mechanisms read a fact as "the world moved", and all three are load
 * bearing: `snapshot` facts reset the stale-reading counter and re-arm its notice; `#worldFacts` is the window of things the
 * WORLD said (and the one window whose oldest entry is evicted when it fills); and `describeWorldChange` is what
 * `world_state_stale` counts as a contradiction of the reading. A backlog fact in any of those would make the Host's own
 * ledger look like the world speaking - it could re-arm a stale notice, or suppress one, with bookkeeping.
 * </p>
 *
 * <p>
 * THE POPULATION IS THE REAL FACT the pump mints, driven through the same bound the other cases use, and the three sites
 * are read from the product's own decisions: `kind`, `factWindow` (the filing `enqueueFact` uses) and `describeWorldChange`
 * (the world-change predicate). One mutation per site makes the gate red and names it, so a future author who files this
 * fact differently is told which of the three broke.
 * </p>
 */
function claimsOf(fact: WorldFact, readingLocation = "Farm"): readonly string[] {
  const sites: string[] = [];
  if (fact.kind === "snapshot") sites.push("a_backlog_fact_claims_the_world_changed:snapshot");
  if (factWindow(fact) === "world_facts") sites.push("a_backlog_fact_claims_the_world_changed:worldFacts");
  const change = describeWorldChange(fact, readingLocation);
  if (change !== undefined) sites.push(`a_backlog_fact_claims_the_world_changed:worldChange:${change}`);
  return Object.freeze(sites);
}

test("a_backlog_fact_claims_the_world_changed: the backlog is the Host's ledger, never the world moving", async () => {
  const runClock = clock();
  const pump = new CompanionEventPump(() => NO_PLAN, runClock.now);
  const turns = recorder();
  pump.enqueueFact(terminalReceipt("succeeded"), FACT_PRODUCER.adapterIngress);
  await pump.flush(turns.sink);
  runClock.advance(CARRIED_BACKLOG_BOUND_MS);
  await pump.flush(turns.sink);
  const fact = backlogOf(turns.batches.at(-1));
  assert.notEqual(fact, undefined, "the bound must have minted the fact this gate is about");
  const backlog = fact as WorldFact;

  assert.deepEqual(claimsOf(backlog), [], `the backlog fact claims the world changed: ${claimsOf(backlog).join(", ")}`);

  // THE THREE FALSIFIERS, one mutation each: a gate that cannot be made red on purpose is decoration.
  assert.deepEqual(
    claimsOf({ ...backlog, kind: "snapshot" }),
    ["a_backlog_fact_claims_the_world_changed:snapshot"],
    "filed as a reading, the fact would reset and re-arm the stale-reading measurement",
  );
  assert.deepEqual(
    claimsOf({ ...backlog, kind: "world_fact" }),
    ["a_backlog_fact_claims_the_world_changed:worldFacts"],
    "filed as a world fact, it would take a slot in the window of things the world said - and evict one",
  );
  assert.deepEqual(
    claimsOf({ ...backlog, payload: { ...backlog.payload, location: "Town" } }),
    ["a_backlog_fact_claims_the_world_changed:worldChange:location:Town"],
    "carrying a location, it would be counted as the world contradicting the reading it is delivered beside",
  );

  // AND THE SHAPE THE MODEL READS: the pump's own spelling of the fact's shape, which is what the account prints.
  assert.equal(
    factShapeName(backlog),
    `semantic:${CARRIED_BACKLOG_SEMANTIC_KIND}`,
    "the account names the backlog under the semantic kinds, in the same vocabulary as every other decision shape",
  );
});
