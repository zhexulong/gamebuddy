import assert from "node:assert/strict";
import test from "node:test";
import { CompanionEventPump, type WorldFact } from "./event-pump.js";

/**
 * A held PROGRESS fact that has not changed says nothing the model does not already have.
 *
 * Measured 2026-10-27 on a twelve-minute Game session: `input` reached 114,569 tokens against a 131,072
 * window and the model answered `stopReason: "length"` twice. The batch composition, by semantic kind, was
 * `route_progress` 859, `execution_settled_succeeded` 219, `body_idle` 211, `execution_started` 184. The
 * three PROGRESS kinds are already held latest-only in this pump, but "held" only means one slot per
 * identity - the surviving fact was re-delivered into every batch, so the same tile and the same idle body
 * were stated hundreds of times.
 *
 * The rule these tests pin: a held progress fact reaches the model once, and again only when its content
 * changes. `tick` and `revision` are counters that advance on every observation of the SAME state, so they
 * are not content; the tile, the location, the kind and the execution are.
 */

/** The three semantic kinds the pump treats as progress (`isProgressSemanticEvent`). */
const PROGRESS_KINDS = ["execution_started", "route_progress", "body_idle"];

interface DeliveredBatch {
  readonly text: string;
  readonly worldFacts: ReadonlyArray<Readonly<{ kind: string; payload: Readonly<Record<string, unknown>> }>>;
}

/** One re-observation of a state that has not changed: same tile, same body, new counters. */
function routeProgress(executionId: string, tile: { x: number; y: number }, tick: number): WorldFact {
  return {
    source: "stardew_mod",
    kind: "semantic_event",
    eventId: `trace_${executionId}_${String(tick)}`,
    correlationId: `transport_${String(tick)}`,
    executionId,
    revision: tick,
    payload: {
      kind: "route_progress",
      revision: tick,
      reasonCode: "body_trace",
      activeExecution: { executionId, phase: "approach", cancelSafe: true },
      bodyTrace: { category: "route_progress", executionId, requestId: "request_1", tick, location: "Farm", tile },
    },
  };
}

function executionStarted(executionId: string, tick: number): WorldFact {
  return {
    source: "stardew_mod",
    kind: "semantic_event",
    eventId: `started_${executionId}`,
    correlationId: `started_transport_${String(tick)}`,
    executionId,
    revision: tick,
    payload: {
      kind: "execution_started",
      revision: tick,
      reasonCode: "body_trace",
      activeExecution: { executionId, phase: "approach", cancelSafe: true },
      bodyTrace: { category: "execution_started", executionId, requestId: "request_1", tick, location: "Farm" },
    },
  };
}

function bodyIdle(tick: number): WorldFact {
  return {
    source: "stardew_mod",
    kind: "semantic_event",
    eventId: `idle_${String(tick)}`,
    correlationId: `idle_transport_${String(tick)}`,
    revision: tick,
    payload: {
      kind: "body_idle",
      revision: tick,
      reasonCode: "body_trace",
      activeExecution: null,
      bodyTrace: { category: "body_idle", executionId: "exec_one", requestId: "request_1", tick, location: "Farm" },
    },
  };
}

/** The delivery trigger: an ordinary world fact, the kind that is not held and must always arrive. */
function ordinaryTick(index: number): WorldFact {
  return {
    source: "stardew_mod",
    kind: "world_fact",
    eventId: `time_milestone_${String(index)}`,
    correlationId: `time_milestone_${String(index)}`,
    revision: index,
    observedTick: index,
    semanticKind: "time_milestone",
    payload: { kind: "time_milestone", text: `第 ${String(index)} 次时间里程碑` },
  };
}

function progressFactsOf(
  batch: DeliveredBatch,
): ReadonlyArray<Readonly<{ payload: Readonly<Record<string, unknown>> }>> {
  return batch.worldFacts.filter(
    (fact) => fact.kind === "semantic_event" && PROGRESS_KINDS.includes(String(fact.payload.kind)),
  );
}

async function collect(pump: CompanionEventPump): Promise<DeliveredBatch[]> {
  const batches: DeliveredBatch[] = [];
  await pump.flush({
    async deliver(text) {
      const parsed = JSON.parse(text) as Omit<DeliveredBatch, "text">;
      batches.push({ text, worldFacts: parsed.worldFacts });
    },
  });
  return batches;
}

test("an unchanged held progress fact is delivered once, not in every later batch", async () => {
  const pump = new CompanionEventPump();
  const delivered: DeliveredBatch[] = [];
  const TILE = { x: 64, y: 15 };

  for (let batch = 0; batch < 40; batch++) {
    // The SAME state, re-observed forty times: the tile never moves, the body never leaves, and every
    // fresh observation carries its own tick and revision because the Mod mints them per publish.
    pump.enqueueFact(executionStarted("exec_one", batch));
    pump.enqueueFact(routeProgress("exec_one", TILE, batch));
    pump.enqueueFact(bodyIdle(batch));
    pump.enqueueFact(ordinaryTick(batch));
    delivered.push(...(await collect(pump)));
  }

  assert.equal(delivered.length, 40, "every batch was delivered: the ordinary fact is a real trigger each time");
  const carriers = delivered.map((batch) => progressFactsOf(batch).length);
  assert.deepEqual(
    carriers,
    [2, ...Array<number>(39).fill(0)],
    `only the first batch may carry the unchanged progress facts, got ${JSON.stringify(carriers)}. TWO is the design: executionStarted and routeProgress both name exec_one, so they occupy ONE slot - the newest observation of that execution supersedes the earlier one, while bodyIdle has no execution and keeps its own. A body walking one path is one fact about where it is, not three.`,
  );
  // The ordinary fact is never suppressed: it is not progress, so nothing here may touch it.
  assert.equal(
    delivered.every((batch) => batch.worldFacts.length > 0),
    true,
  );
});

test("a held progress fact whose state changes is delivered again, and then held again", async () => {
  const pump = new CompanionEventPump();
  const delivered: DeliveredBatch[] = [];

  pump.enqueueFact(routeProgress("exec_one", { x: 64, y: 15 }, 0));
  pump.enqueueFact(ordinaryTick(0));
  delivered.push(...(await collect(pump)));

  // Nothing changed: same tile, new counters.
  pump.enqueueFact(routeProgress("exec_one", { x: 64, y: 15 }, 1));
  pump.enqueueFact(ordinaryTick(1));
  delivered.push(...(await collect(pump)));

  // The actor stepped onto a new tile. That IS new information.
  pump.enqueueFact(routeProgress("exec_one", { x: 65, y: 15 }, 2));
  pump.enqueueFact(ordinaryTick(2));
  delivered.push(...(await collect(pump)));

  // Same new tile again: held again.
  pump.enqueueFact(routeProgress("exec_one", { x: 65, y: 15 }, 3));
  pump.enqueueFact(ordinaryTick(3));
  delivered.push(...(await collect(pump)));

  assert.deepEqual(
    delivered.map((batch) => progressFactsOf(batch).length),
    [1, 0, 1, 0],
  );
  const moved = progressFactsOf(delivered[2]!)[0]?.payload as { bodyTrace?: { tile?: { x: number } } };
  assert.equal(moved.bodyTrace?.tile?.x, 65, "the delivered fact is the CHANGED one, not the earlier tile");
});

test("a nonterminal progress receipt is held until its state changes", async () => {
  const pump = new CompanionEventPump();
  const delivered: DeliveredBatch[] = [];
  const receipt = (state: string, tick: number): WorldFact => ({
    source: "stardew_mod",
    kind: "execution_receipt",
    correlationId: "exec_one",
    executionId: "exec_one",
    requestId: "request_1",
    revision: tick,
    payload: { state, reasonCode: "running", revision: tick, executionId: "exec_one" },
  });

  for (let tick = 0; tick < 3; tick++) {
    pump.enqueueFact(receipt("running", tick));
    pump.enqueueFact(ordinaryTick(tick));
    delivered.push(...(await collect(pump)));
  }

  // The receipt advanced to a new state: that is a change, so it is delivered.
  pump.enqueueFact(receipt("meaningful_progress", 3));
  pump.enqueueFact(ordinaryTick(3));
  delivered.push(...(await collect(pump)));

  assert.deepEqual(
    delivered.map((batch) => batch.worldFacts.filter((fact) => fact.kind === "execution_receipt").length),
    [1, 0, 0, 1],
  );
});

test("the snapshot keeps riding every batch: only PROGRESS facts are held once", async () => {
  // The narrowest possible control. `snapshot` is held in the pump too (latest-only), and it is the world
  // the rest of the batch describes - a batch that carried facts but no snapshot would describe a state
  // the model cannot see. Only progress is deduplicated.
  const pump = new CompanionEventPump();
  const delivered: DeliveredBatch[] = [];
  for (let index = 0; index < 3; index++) {
    pump.enqueueFact({
      source: "stardew_mod",
      kind: "snapshot",
      correlationId: "snapshot",
      revision: index + 1,
      payload: { location: "Farm", revision: index + 1 },
    });
    pump.enqueueFact(ordinaryTick(index));
    delivered.push(...(await collect(pump)));
  }
  assert.deepEqual(
    delivered.map((batch) => batch.worldFacts.filter((fact) => fact.kind === "snapshot").length),
    [1, 1, 1],
  );
});

test("clear forgets what was delivered, so a new session's first observation speaks again", async () => {
  const pump = new CompanionEventPump();
  pump.enqueueFact(routeProgress("exec_one", { x: 64, y: 15 }, 0));
  pump.enqueueFact(ordinaryTick(0));
  const first = await collect(pump);
  assert.equal(progressFactsOf(first[0]!).length, 1);

  pump.clear();

  pump.enqueueFact(routeProgress("exec_one", { x: 64, y: 15 }, 1));
  pump.enqueueFact(ordinaryTick(1));
  const second = await collect(pump);
  assert.equal(
    progressFactsOf(second[0]!).length,
    1,
    "a cleared pump has delivered nothing; the same state must reach the new session",
  );
});
