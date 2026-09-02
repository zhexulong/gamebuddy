import assert from "node:assert/strict";
import test from "node:test";
import {
  GAME_PROGRAM_FACT_CUSTOM_TYPE,
  createGameProgramFactIngress,
  type GameProgramFactIngressState,
} from "./game-program-fact-ingress.internal.js";

function record(cursor: number, factClass: "progress" | "terminal" | "resource_released" | "recovery_required", nodeId = "node"): Readonly<Record<string, unknown>> {
  return {
    type: GAME_PROGRAM_FACT_CUSTOM_TYPE,
    cursor,
    programId: "program",
    nodeId,
    nodeAttempt: 1,
    factClass,
    fact: { state: factClass, cursor },
  };
}

function memoryStore(initial?: GameProgramFactIngressState) {
  let state = initial;
  return {
    async load() { return state; },
    async save(next: GameProgramFactIngressState) { state = next; },
    get state() { return state; },
  };
}

test("game program fact ingress validates strict addressed v1 records and suppresses duplicates", async () => {
  const store = memoryStore();
  const ingress = createGameProgramFactIngress(store);
  await assert.rejects(ingress.ingest({ ...record(1, "terminal"), extra: true }), /invalid_game_program_fact/);
  assert.equal(await ingress.ingest(record(1, "terminal")), "accepted");
  assert.equal(await ingress.ingest(record(1, "terminal")), "duplicate");
  assert.deepEqual((await ingress.snapshot()).pending.map((fact) => fact.cursor), [1]);
});

test("game program fact ingress coalesces only exact-lineage progress and preserves non-droppable facts", async () => {
  const store = memoryStore();
  const ingress = createGameProgramFactIngress(store);
  assert.equal(await ingress.ingest(record(1, "progress")), "accepted");
  assert.equal(await ingress.ingest(record(2, "progress")), "coalesced");
  await ingress.ingest(record(3, "terminal"));
  await ingress.ingest(record(4, "resource_released"));
  await ingress.ingest(record(5, "recovery_required"));
  await ingress.ingest(record(6, "progress", "other_node"));
  const facts = (await ingress.snapshot()).pending;
  assert.deepEqual(facts.map((fact) => [fact.cursor, fact.factClass, fact.nodeId]), [
    [2, "progress", "node"],
    [3, "terminal", "node"],
    [4, "resource_released", "node"],
    [5, "recovery_required", "node"],
    [6, "progress", "other_node"],
  ]);
});

test("game program fact ingress coalescing reinserts progress by cursor without reordering terminal delivery", async () => {
  const ingress = createGameProgramFactIngress(memoryStore());
  await ingress.ingest(record(1, "progress"));
  await ingress.ingest(record(2, "terminal"));
  assert.equal(await ingress.ingest(record(3, "progress")), "coalesced");

  const delivered: number[] = [];
  while (await ingress.deliverOne(async (message) => { delivered.push(message.details.cursor); })) {
    // Deliver the complete durable queue.
  }
  assert.deepEqual(delivered, [2, 3]);
});

test("game program fact ingress accepts cursor zero with an undelivered sentinel", async () => {
  const ingress = createGameProgramFactIngress(memoryStore());
  assert.equal(await ingress.ingest(record(0, "terminal")), "accepted");
  assert.deepEqual(await ingress.snapshot(), { deliveredCursor: -1, pending: [
    { ...record(0, "terminal"), fact: { state: "terminal", cursor: 0 } },
  ] });
  assert.equal(await ingress.deliverOne(async () => undefined), true);
  assert.deepEqual(await ingress.snapshot(), { deliveredCursor: 0, pending: [] });
});

test("game program fact ingress advances its durable cursor only after Pi durable custom-message delivery", async () => {
  const store = memoryStore();
  const ingress = createGameProgramFactIngress(store);
  await ingress.ingest(record(1, "terminal"));
  await assert.rejects(ingress.deliverOne(async () => { throw new Error("pi_persistence_failed"); }), /pi_persistence_failed/);
  assert.equal((await ingress.snapshot()).deliveredCursor, -1);
  const delivered: string[] = [];
  assert.equal(await ingress.deliverOne(async (message) => { delivered.push(message.content); }), true);
  assert.equal(await ingress.deliverOne(async () => undefined), false);
  assert.deepEqual(JSON.parse(delivered[0] ?? "{}"), record(1, "terminal"));
  assert.deepEqual(await ingress.snapshot(), { deliveredCursor: 1, pending: [] });
});

test("game program fact ingress rejects malformed state and non-JSON fact values without coercion", async () => {
  const malformedStates: GameProgramFactIngressState[] = [
    { deliveredCursor: 0, pending: [record(0, "terminal") as never] },
    { deliveredCursor: -1, pending: [record(2, "terminal") as never, record(1, "terminal") as never] },
    Object.assign(Object.create(null), { deliveredCursor: -1, pending: [] }),
    Object.create({ deliveredCursor: -1, pending: [] }),
    Object.defineProperties({}, {
      deliveredCursor: { enumerable: true, get: () => -1 },
      pending: { enumerable: true, value: [] },
    }),
  ];
  for (const state of malformedStates) {
    await assert.rejects(createGameProgramFactIngress(memoryStore(state)).snapshot(), /invalid_game_program_fact_ingress_state/);
  }

  const ingress = createGameProgramFactIngress(memoryStore());
  for (const fact of [
    { value: undefined }, { value: Number.NaN }, { value: Infinity }, { value: () => undefined },
    { value: new Date() }, { value: Object.create(null) }, { value: [undefined] },
  ]) {
    await assert.rejects(ingress.ingest({ ...record(1, "terminal"), fact }), /invalid_game_program_fact/);
  }
});

test("game program fact ingress rejects sparse persisted pending arrays", async () => {
  const pending = new Array(1) as GameProgramFactIngressState["pending"];
  await assert.rejects(
    createGameProgramFactIngress(memoryStore({ deliveredCursor: -1, pending })).snapshot(),
    /invalid_game_program_fact_ingress_state/,
  );
});

test("game program fact ingress refuses non-droppable facts when its bounded queue is full", async () => {
  const ingress = createGameProgramFactIngress(memoryStore());
  for (let cursor = 0; cursor < 128; cursor += 1) await ingress.ingest(record(cursor, "terminal", `node-${cursor}`));
  await assert.rejects(ingress.ingest(record(128, "resource_released")), /game_program_fact_non_droppable_overflow/);
  assert.equal((await ingress.snapshot()).pending.length, 128);
});

test("game program fact ingress is explicitly at-least-once when consumer success precedes queue-save failure", async () => {
  let state: GameProgramFactIngressState | undefined;
  let failNextSave = false;
  const store = {
    async load() { return state; },
    async save(next: GameProgramFactIngressState) {
      if (failNextSave) {
        failNextSave = false;
        throw new Error("queue_save_failed");
      }
      state = next;
    },
  };
  const first = createGameProgramFactIngress(store);
  await first.ingest(record(0, "terminal"));
  failNextSave = true;
  const firstDeliveries: number[] = [];
  await assert.rejects(first.deliverOne(async (message) => { firstDeliveries.push(message.details.cursor); }), /queue_save_failed/);
  assert.deepEqual(firstDeliveries, [0]);

  const restarted = createGameProgramFactIngress(store);
  const restartedDeliveries: number[] = [];
  assert.equal(await restarted.deliverOne(async (message) => { restartedDeliveries.push(message.details.cursor); }), true);
  assert.deepEqual(restartedDeliveries, [0]);
  assert.deepEqual(await restarted.snapshot(), { deliveredCursor: 0, pending: [] });
});

test("game program fact ingress restart resumes pending facts without fabricating historical tool results", async () => {
  const store = memoryStore();
  const first = createGameProgramFactIngress(store);
  await first.ingest(record(1, "terminal"));
  const restarted = createGameProgramFactIngress(store);
  const customTypes: string[] = [];
  await restarted.deliverOne(async (message) => { customTypes.push(message.customType); });
  assert.deepEqual(customTypes, [GAME_PROGRAM_FACT_CUSTOM_TYPE]);
  assert.deepEqual(await restarted.snapshot(), { deliveredCursor: 1, pending: [] });
});
