import assert from "node:assert/strict";
import test from "node:test";
import {
  CompanionEventPump,
  FACT_PRODUCER,
  FACT_TURN_CONSEQUENCE,
  NOT_OWED,
  type PendingBatch,
  PUMP_MINTED_WAKE_KINDS,
  TURN_OPENING,
  type WorldFact,
} from "./event-pump.js";
import { PRESENTATION_LEASE_KINDS, presentationSourceOf } from "./presentation-lease.js";
import { PROGRAM_SETTLED_DIGEST_SEMANTIC_KIND } from "./program-settlement-digest.js";

/**
 * THE GATE: a turn opens only where the player's surface can show it, and every decision fact that cannot present is
 * CARRIED into the next turn that can.
 *
 * <p>
 * MEASURED 2026-11-17 (`round66`, final account): `turns opened 40 · bubbles delivered 30 · lost 12
 * {no_presentation_lease: 12}` for 17 world-changing actions, and every unadmitted turn's delivery record carried exactly
 * `["execution_receipt","snapshot"]` - a node's terminal receipt, with nothing in the window the surface was ever told
 * about. `lost 12` is twelve provider turns whose words nobody saw, paid for because the pump invited an answer it had no
 * surface to show.
 * </p>
 * <p>
 * THE PROPERTY HAS TWO DIRECTIONS, asserted together because either alone can be satisfied by moving the defect:
 * </p>
 * <ul>
 *   <li>OPENED ⇒ PRESENTABLE. Every batch this pump hands a sink carries a presentation source, so no turn exists whose
 *       answer the player cannot see.</li>
 *   <li>NOT OPENED ⇒ CARRIED. Every decision fact the surface refused is still owed to her: the call answers
 *       `not_owed {no_surface_for {shape: n}}`, the ticket names the fact, `carriedInto` resolves to the batch that consumed
 *       it, and the fact is IN that batch - so she reads the outcome at the next turn that can be shown. 事件守恒.</li>
 * </ul>
 * <p>
 * THE POPULATION IS DERIVED FROM THE CLASSIFICATION. `FACT_TURN_CONSEQUENCE` is built from `EXECUTION_STATES`, the held and
 * wake tables and `SETTLED_PROGRAM_OUTCOMES`, so a receipt state, a wake kind or a settlement outcome added to any of those
 * appears here without this file changing. Every shape it calls `decision` can open a turn, so every one is driven; the
 * failure names the member that drifted.
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

/**
 * A world fact the surface was never told about.
 *
 * `modal_presented` is not chosen for convenience: `round66` published eight of them and the lease white-list does not name
 * it, so it is the measured shape of "the world said something and the player's chat was not part of it".
 */
function unpresentableWorldFact(): WorldFact {
  return presentableFact("modal_presented");
}

/** A node's terminal receipt, in the wire's own shape: `protocol/bridge-v1.schema.json#receipt` has no event identity. */
function terminalReceipt(state: string): WorldFact {
  return {
    source: "stardew_mod",
    kind: "execution_receipt",
    eventId: `receipt_${state}`,
    correlationId: `receipt_${state}`,
    revision: 1,
    occurredAtMs: 5,
    executionId: `exec_${state}`,
    requestId: `request_${state}`,
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

/**
 * Every case this gate drives: one per `decision` shape, plus the PRESENTABLE end of the plain `world_fact` shape, plus every
 * declared Host/Mod wake.
 *
 * `world_fact` is one shape for every world fact that is not the settlement digest, so it covers both ends of the surface
 * question and a sample of one end would let the other pass by absence. The presentable end is derived from the lease list
 * itself. The wake half is `PUMP_MINTED_WAKE_KINDS` - the `due` opener - and it is in this population because it is the ONE
 * declared exception to "only where the surface can present", so a wake that stopped opening its turn has to fail here by
 * name rather than quietly join the carried bucket.
 */
function decisionCases(): readonly Readonly<{ label: string; fact: WorldFact; wake: boolean }>[] {
  const shapes = Object.entries(FACT_TURN_CONSEQUENCE)
    .filter(([, consequence]) => consequence === "decision")
    .map(([shape]) => shape);
  const cases: Readonly<{ label: string; fact: WorldFact; wake: boolean }>[] = shapes.map((shape) =>
    Object.freeze({ label: shape, fact: factOfShape(shape), wake: false }),
  );
  for (const kind of PRESENTATION_LEASE_KINDS)
    if (kind !== PROGRAM_SETTLED_DIGEST_SEMANTIC_KIND)
      cases.push(Object.freeze({ label: `world_fact:${kind}`, fact: presentableFact(kind), wake: false }));
  for (const kind of Object.keys(PUMP_MINTED_WAKE_KINDS))
    cases.push(Object.freeze({ label: `due:${kind}`, fact: presentableFact(kind), wake: true }));
  return Object.freeze(cases);
}

test("a_turn_is_opened_where_no_surface_can_present", async () => {
  const cases = decisionCases();
  assert.ok(cases.length > 0, "consequences examined 0: the classification declares no decision shape");
  assert.ok(
    PRESENTATION_LEASE_KINDS.length > 0,
    "consequences examined 0: the lease list is empty, so nothing can present and this gate agrees with itself",
  );

  const presentable: string[] = [];
  const carried: string[] = [];
  const wakes: string[] = [];
  const openedWithoutSurface: string[] = [];

  for (const { label, fact, wake } of cases) {
    const pump = new CompanionEventPump();
    const turns = recorder();
    pump.enqueueFact(fact, FACT_PRODUCER.adapterIngress);
    const flushed = await pump.flush(turns.sink);

    if (flushed.kind === "opened") {
      const batch = turns.batches[0];
      assert.notEqual(batch, undefined, `${label}: an opened turn must be a delivery`);
      if (wake) {
        // THE DECLARED EXCEPTION, ASSERTED. A wake is the turn that makes her look, so it must open - and the opener it is
        // counted under has to say so, or the exception would be invisible in the account.
        assert.equal(
          pump.turnAccount.byReason[TURN_OPENING.due],
          1,
          `${label}: a wake that opens must be counted as the \`due\` opener`,
        );
        wakes.push(label);
        continue;
      }
      const source = batch!.events.map((event) => presentationSourceOf(event)).find((id) => id !== undefined);
      if (source === undefined) openedWithoutSurface.push(label);
      else presentable.push(label);
      continue;
    }

    assert.equal(
      flushed.kind,
      "not_owed",
      `${label}: a fact either opens a turn or is answered not-owed (${flushed.kind})`,
    );
    assert.ok(flushed.kind === "not_owed");
    assert.equal(flushed.reason, NOT_OWED.noSurface, `${label}: the answer names the surface, not a re-statement`);
    assert.equal(turns.batches.length, 0, `${label}: no batch is composed for a call that owes no turn`);
    const account = pump.turnAccount;
    assert.equal(account.notOwed[NOT_OWED.noSurface], 1, `${label}: the refusal is counted once, under its own reason`);
    assert.deepEqual(
      account.noSurface,
      { [label === "world_fact" ? "world_fact:modal_presented" : label]: 1 },
      `${label}: and the braces name the SHAPE the surface refused`,
    );
    carried.push(label);

    // THE CARRY IS PROVED BY ARRIVAL, not by the ticket's existence: the next turn that CAN present consumes the exact fact,
    // exactly once, and the ticket resolves to that batch.
    const ticket = flushed.carry;
    assert.ok(ticket.facts.length > 0, `${label}: the answer must carry a ticket naming the fact it declined`);
    assert.equal(pump.carriedInto(ticket), undefined, `${label}: \`undefined\` is the state that says "not yet"`);
    pump.enqueueFact(presentableFact("time_milestone"), FACT_PRODUCER.adapterIngress);
    const opened = await pump.flush(turns.sink);
    assert.equal(
      opened.kind,
      "opened",
      `${label}: the next presentable fact must open the turn the carried fact waits for`,
    );
    const batch = turns.batches.at(-1)!;
    assert.equal(
      pump.carriedInto(ticket),
      batch.batchId,
      `${label}: the ticket resolves to the batch that consumed it`,
    );
    const declined = batch.facts.filter((entry) => entry.semanticKind !== "time_milestone");
    assert.equal(
      declined.length,
      1,
      `${label}: the declined fact travels exactly once, in the batch that could present it`,
    );
    assert.equal(pump.turnAccount.carry.pending, 0, `${label}: and nothing is left waiting`);
  }

  const tally = `consequences examined ${String(cases.length)} · presentable ${String(presentable.length)} · wake ${String(wakes.length)} · carried ${String(carried.length)} · opened-without-a-surface ${String(openedWithoutSurface.length)}`;
  assert.equal(
    wakes.length,
    Object.keys(PUMP_MINTED_WAKE_KINDS).length,
    `${tally}: a declared wake must open its turn - it is the look, not the line, and waiting for a surface is how a stall goes unanswered`,
  );
  assert.ok(presentable.length > 0, `${tally}: no shape could present, so the opened half of this gate proves nothing`);
  assert.ok(carried.length > 0, `${tally}: no shape was carried, so the carried half of this gate proves nothing`);
  assert.deepEqual(
    openedWithoutSurface,
    [],
    `${tally}: these decision shapes opened a turn whose batch carries no presentation source, so her answer to them can only be text nobody is shown`,
  );
});

test("a_carried_fact_is_consumed: the plan's settlement is the decision, and it carries the node terminal it answers", async () => {
  const pump = new CompanionEventPump();
  const turns = recorder();
  pump.enqueueFact(terminalReceipt("succeeded"), FACT_PRODUCER.adapterIngress);
  const first = await pump.flush(turns.sink);
  assert.equal(
    first.kind,
    "not_owed",
    `a terminal receipt cannot present, so it owes no turn of its own (${first.kind})`,
  );
  assert.ok(first.kind === "not_owed");
  assert.equal(first.reason, NOT_OWED.noSurface, "and the answer names the surface");
  assert.equal(turns.batches.length, 0, "no batch is composed for a call that owes no turn");
  assert.equal(pump.turnAccount.notOwed[NOT_OWED.noSurface], 1, "the refusal is counted");
  assert.deepEqual(
    pump.turnAccount.noSurface,
    { "receipt:succeeded": 1 },
    "and the account names the shape the surface refused - the reading a fix has to move",
  );

  // THE SETTLEMENT IS THE DECISION and it is presentable: the digest carries an opaque `sourceEventId` of its own
  // (`program_settled_<programId>`, `program-settlement-digest.ts`), which is what makes the one answer to a plan a turn
  // the player can see.
  pump.enqueueFact(settlement("refused"), FACT_PRODUCER.programSettlement);
  const second = await pump.flush(turns.sink);
  assert.equal(second.kind, "opened", `the settlement's answer must arrive (${second.kind})`);
  const batch = turns.batches[0]!;
  assert.equal(pump.carriedInto(first.carry), batch.batchId, "the node terminal arrives with the settlement's turn");
  assert.ok(
    batch.facts.some((fact) => fact.kind === "execution_receipt"),
    "and that turn CARRIES it, so nothing decided is dropped",
  );
  assert.equal(
    batch.events.map((event) => presentationSourceOf(event)).find((id) => id !== undefined),
    "program_settled_plan_1",
    "the settlement's turn presents under the digest's own identity, so the player sees her answer to the plan",
  );
  // ONCE. The windows were emptied by that batch, so the receipt cannot be delivered by a second turn.
  const third = await pump.flush(turns.sink);
  assert.equal(third.kind, "not_owed", `nothing is owed after the settlement's turn (${third.kind})`);
  assert.equal(turns.batches.length, 1, "and no second turn carries the same receipt");
});

/**
 * THE FALSIFIER: the pump and the loop read ONE predicate, so a lease kind whose identity is not opaque cannot sneak a turn
 * through, and the same kind with an opaque one still opens its turn as today.
 *
 * <p>
 * The injected violation this catches is the two-spellings defect: a pump that asked only `opensPresentationLease` would open
 * a turn for `{"kind":"time_milestone","sourceEventId":"day:1200"}` while `canonicalPresentationSource` refused it - a turn
 * whose words land nowhere, which is the exact `lost {no_presentation_lease}` count this unit removes.
 * </p>
 */
test("the_surface_predicate_is_one_reading: a lease kind without an opaque identity opens no turn", async () => {
  const malformed = new CompanionEventPump();
  const rejected = recorder();
  malformed.enqueueFact(presentableFact("time_milestone", "day:1200"), FACT_PRODUCER.adapterIngress);
  const notOwed = await malformed.flush(rejected.sink);
  assert.equal(
    notOwed.kind,
    "not_owed",
    "a lease kind the lineage would refuse (`:` is not in `[A-Za-z0-9_-]{1,128}`) must not open a turn either",
  );
  assert.deepEqual(rejected.batches, [], "no turn was opened for it");

  const wellFormed = new CompanionEventPump();
  const opened = recorder();
  wellFormed.enqueueFact(presentableFact("time_milestone"), FACT_PRODUCER.adapterIngress);
  const turned = await wellFormed.flush(opened.sink);
  assert.equal(turned.kind, "opened", `and the opaque spelling still opens its turn as today (${turned.kind})`);
  assert.equal(
    opened.batches[0]!.events.map((event) => presentationSourceOf(event)).find((id) => id !== undefined),
    "fact_time_milestone",
    "with the identity the surface presents under",
  );
});
