import assert from "node:assert/strict";
import test from "node:test";
import {
  CompanionEventPump,
  FACT_PRODUCER,
  HELD_RECEIPT_PROGRESS_STATES,
  NOT_OWED,
  type PendingBatch,
  type WorldFact,
} from "./event-pump.js";
import { programSettledDigest } from "./program-settlement-digest.js";
import type { PlanAnswerNode } from "./program-status-wait.js";
import { MAX_BODY_PROGRAM_NODES } from "./protocol.js";

/**
 * `a_batch_of_nodes_is_not_a_batch_of_turns:<nodes>` - what a plan costs in turns, held against how many nodes it has.
 *
 * <p>
 * MEASURED 2026-11-18 (the built pump, real facts, one flush per case), and it is the reading that retired a planned
 * change instead of shipping one. The change was "a node's terminal receipt must stop opening a turn of its own" on the
 * stated ground that 60 nodes could open up to 60 turns, which would make a batch WORSE than one tile per turn:
 * </p>
 * <ul>
 *   <li>60 node receipts, one flush ⇒ <b>0 turns</b>, answered `not_owed {no_surface_for {receipt:succeeded: 60}}`</li>
 *   <li>60 node receipts, one flush per receipt ⇒ <b>0 turns</b>, 60 × `no_surface_for`</li>
 *   <li>60 node receipts + the programme's settlement ⇒ <b>1 turn</b>, and that batch's text states the nodes</li>
 *   <li>60 node receipts + a presentable milestone ⇒ <b>1 turn</b>, and that batch's text states the nodes</li>
 * </ul>
 * <p>
 * WHY IT IS ALREADY ZERO: `#opensTurn` is `#owesTurn && !restatement && (isDueFact || #canPresent)`, and
 * `presentationSourceOf` answers `undefined` for every `execution_receipt` - `protocol/bridge-v1.schema.json#receipt`
 * carries no event identity to present under (`presentation-lease.ts`). A terminal receipt therefore OWES a turn (it is
 * news, and `takeBatch` states it in the batch's model-facing text) and OPENS none.
 * </p>
 * <p>
 * THE TWO QUESTIONS MUST NOT BE COLLAPSED, and that is what makes this a gate rather than a note. Filing a terminal
 * receipt as `progress` would make `#owesTurn` false, and the model-facing text is `promptFacts`, filtered on
 * `#owesTurn` - so the node's outcome would leave the prompt entirely. The same filter composes a STEER's text, so a
 * `rejected` receipt would steer a batch that states nothing. That direction was measured too: 17 of 151 `event-pump*`
 * assertions go red under it, every one of them a "carried, not dropped" property.
 * </p>
 * <p>
 * THE WAKE AFTER A PLAN IS ONE HOP. A settlement is presentable (`program_settled` is on the lease list), so it opens
 * its own turn in the flush that carries it and the node receipts travel in that batch - "the last node stopped" to
 * "she knows" is the settle hop, not a turn per node. A terminal receipt belonging to NO programme has no settlement to
 * wake her; it waits for the next presentable fact, whose population is `PRESENTATION_LEASE_KINDS` (the Mod's five
 * clock marks a day, `ISalientEventFilter.AllowedMilestones`: 600, 1200, 1800, 2200, 2400, plus the day boundary, her
 * arrival, a native notice and any player word). The pump imposes NO bound on the TURN (60 node receipts with nothing
 * presentable open no turn, by measurement); the WAIT for one is bounded separately (`CARRY_HOLD_BOUND_MS`), and past it
 * the receipts are counted as `lost` instead of still described as `held`.
 * </p>
 * <p>
 * THE POPULATION IS THE PLAN'S OWN BOUND, not a count written here: the smallest plan, the 60-node plan the `for` loop
 * compiles, and `MAX_BODY_PROGRAM_NODES`. The property is that the cost is INDEPENDENT of the population - adding a node
 * buys no turn - so the failure names the node count whose cost grew rather than a constant a future edit could move.
 * </p>
 */

/** The plan sizes examined: the wire's own bound, the 60-node plan this was measured on, and the smallest plan. */
const PLAN_SIZES: readonly number[] = Object.freeze([1, 60, MAX_BODY_PROGRAM_NODES]);

/** One node of the programme finishing: its own execution, bound to the programme by the Mod's own journal. */
function nodeReceipt(state: string, index: number): WorldFact {
  return {
    source: "stardew_mod",
    kind: "execution_receipt",
    correlationId: `exec_water_${String(index)}`,
    executionId: `exec_water_${String(index)}`,
    requestId: `request_water_${String(index)}`,
    revision: index,
    payload: {
      actionId: "water_crop",
      state,
      reasonCode: `reason_${state}`,
      revision: index,
      evidence: { detail: `tile=${String(index)}` },
      origin: { kind: "programme", programId: "plan_water_row", nodeId: `n${String(index)}` },
    },
  };
}

/** One node row of the Mod's journal, as the settlement read sees it. */
type JournalRow = Readonly<{ nodeId: string; state: string }>;

function planNode(nodeId: string): PlanAnswerNode {
  return {
    nodeId,
    actionId: "water_crop",
    arguments: { x: { type: "integer", canonicalValue: "60" }, y: { type: "integer", canonicalValue: "10" } },
  };
}

/** The settlement, built by the PRODUCER: what the pump classifies is what `programSettledDigest` actually mints. */
function settledFact(nodes: number): WorldFact {
  const rows: JournalRow[] = Array.from({ length: nodes }, (_, index) => ({
    nodeId: `n${String(index)}`,
    state: "succeeded",
  }));
  const fact = programSettledDigest({
    programId: "plan_water_row",
    settledAtMs: 4_242,
    compiled: rows.map((row) => planNode(row.nodeId)),
    status: {
      code: "found",
      snapshot: {
        programId: "plan_water_row",
        state: "succeeded",
        catalogRevision: 3,
        stopEpoch: 0,
        eventHighWater: 90,
        nodes: rows,
      },
    },
    nowMs: 9,
  });
  assert.ok(fact !== undefined, `the producer must state a settled plan of ${String(nodes)} nodes`);
  return fact;
}

/** The Mod's own HUD line: presentable (`time_milestone` is on the lease list) and carrying an opaque identity. */
function milestoneFact(): WorldFact {
  return {
    source: "stardew_mod",
    kind: "world_fact",
    eventId: "time_milestone_600",
    sourceEventId: "time_milestone_600",
    correlationId: "time_milestone_600",
    revision: 1,
    occurredAtMs: 600,
    semanticKind: "time_milestone",
    payload: { milestone: 600 },
  };
}

function recorder(): { batches: PendingBatch[]; sink: { deliver(batch: PendingBatch): Promise<void> } } {
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

test("a_batch_of_nodes_is_not_a_batch_of_turns: the cost is the settlement, never the nodes", async () => {
  const readings: { nodes: number; turnsWithoutSettlement: number; turnsWithSettlement: number }[] = [];

  for (const nodes of PLAN_SIZES) {
    const turns = recorder();
    const pump = new CompanionEventPump();

    for (let index = 0; index < nodes; index += 1)
      pump.enqueueFact(nodeReceipt("succeeded", index), FACT_PRODUCER.adapterIngress);
    const alone = await pump.flush(turns.sink);
    const turnsWithoutSettlement = pump.turnAccount.opened;
    const pendingAfterReceipts = pump.pendingCount;
    const notOwedAfterReceipts = pump.turnAccount.notOwed[NOT_OWED.noSurface];

    pump.enqueueFact(settledFact(nodes), FACT_PRODUCER.programSettlement);
    await pump.flush(turns.sink);
    const turnsWithSettlement = pump.turnAccount.opened;

    assert.equal(
      alone.kind,
      "not_owed",
      `a plan's ${String(nodes)} finished nodes cannot present, so none of them opens a turn`,
    );
    assert.equal(
      turnsWithoutSettlement,
      0,
      `${String(nodes)} finished nodes opened ${String(turnsWithoutSettlement)} turns: a receipt carries no event ` +
        "identity on the wire, so no turn it opens can be shown to the player",
    );
    assert.equal(
      notOwedAfterReceipts,
      1,
      "and the flush is still counted, as the surface's refusal - not as progress, which would claim she was told",
    );
    assert.equal(pendingAfterReceipts, nodes, `all ${String(nodes)} receipts are waiting, none dropped`);
    assert.equal(
      turnsWithSettlement,
      1,
      `the plan's answer is ONE turn for ${String(nodes)} nodes, got ${String(turnsWithSettlement)}: a settlement is ` +
        "one call and one answer, and a plan that cost a turn per node would be worse than acting one tile at a time",
    );
    assert.equal(turns.batches.length, 1, `and exactly one batch was delivered for ${String(nodes)} nodes`);
    readings.push({ nodes, turnsWithoutSettlement, turnsWithSettlement });
  }

  const costs = new Set(readings.map((reading) => reading.turnsWithSettlement));
  assert.equal(
    costs.size,
    1,
    `the cost must not grow with the population, and it does: ${readings
      .map((reading) => `${String(reading.nodes)}→${String(reading.turnsWithSettlement)}`)
      .join(" ")}`,
  );
  console.log(
    `a_batch_of_nodes_is_not_a_batch_of_turns: nodes examined ${String(readings.length)} · ` +
      `receipts ${String(readings.reduce((total, reading) => total + reading.nodes, 0))} · ` +
      `turns-without-settlement ${String(readings.reduce((total, reading) => total + reading.turnsWithoutSettlement, 0))} · ` +
      `turns-with-settlement ${String(readings.reduce((total, reading) => total + reading.turnsWithSettlement, 0))} · ` +
      `sizes ${readings.map((reading) => String(reading.nodes)).join(", ")}`,
  );
});

test("a_stated_outcome_is_not_a_woken_turn: a terminal receipt is CARRIED and STATED, standing state is neither", async () => {
  // THE FALSIFIER PAIR. The same batch shape is driven twice, once with a terminal receipt and once with an in-flight
  // one, and the two answers must differ. If a terminal state is filed as `progress`, the first half goes red by name
  // (`promptFacts` filters on `#owesTurn`); if an in-flight state starts being stated, the second half does.
  const stated: string[] = [];
  for (const state of ["succeeded", "rejected", "accepted", "running", "meaningful_progress"]) {
    const pump = new CompanionEventPump();
    const turns = recorder();
    pump.enqueueFact(nodeReceipt(state, 0), FACT_PRODUCER.adapterIngress);
    const refused = await pump.flush(turns.sink);
    assert.equal(refused.kind, "not_owed", `a ${state} receipt cannot present, so it opens no turn of its own`);
    const ticket = refused.kind === "not_owed" ? refused.carry : undefined;
    assert.ok(ticket !== undefined, `the refusal carries the ticket that proves where the fact went (${state})`);
    assert.equal(ticket.facts.length, 1, `and the ticket names it (${state})`);

    pump.enqueueFact(milestoneFact(), FACT_PRODUCER.adapterIngress);
    await pump.flush(turns.sink);
    assert.equal(pump.turnAccount.opened, 1, `the milestone opens the one turn (${state})`);
    assert.equal(
      pump.carriedInto(ticket),
      turns.batches[0]!.batchId,
      `and the ticket resolves to the batch that carried it (${state})`,
    );
    if (turns.batches[0]!.text.includes("water_crop")) stated.push(state);
  }

  // THE BEHAVIOUR FIRST, because that is the half that matters, and the declaration below only names the mechanism.
  assert.deepEqual(
    stated.sort(),
    ["rejected", "succeeded"],
    "a terminal receipt OWES a turn and the batch states it: it is the only fact that says the node ran. If this list " +
      "loses `succeeded` or `rejected`, a classification change has made an outcome she was told into one she was not",
  );
  // The negative half is the three states above that are NOT in this list: `HELD_RECEIPT_PROGRESS_STATES` is where a
  // state is filed as standing state, so the three are also asserted to be exactly the ones held today.
  assert.deepEqual(
    Object.keys(HELD_RECEIPT_PROGRESS_STATES).sort(),
    ["accepted", "meaningful_progress", "running"],
    "only the in-flight states are held as progress; a terminal state filed here is the change this gate exists for",
  );
});
