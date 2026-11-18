import assert from "node:assert/strict";
import test from "node:test";

import { CompanionEventPump, FACT_PRODUCER, type WorldFact } from "./event-pump.js";
import { PROGRAM_SETTLEMENT_WATCH_INTERVAL_MS } from "./program-settlement-digest.js";
import {
  createProgramProgressObserver,
  IN_FLIGHT_READING_MAX_AGE_MS,
  MAX_IN_FLIGHT_NODE_ROWS,
  MAX_IN_FLIGHT_PROGRAMMES,
  readInFlightProgrammes,
} from "./program-status-wait.js";

/**
 * A programme's progress is not a block: the SETTLEMENT is the answer.
 *
 * <p>
 * MEASURED 2026-11-11 (`round46`), the two turns between a submission and its settlement: `07:25:53` she submits a
 * two-node plan, `07:26:04` she speaks over it, `07:26:17` she submits another, `07:26:26` she speaks again, and
 * `07:26:34` an observe finally shows her the world. The diagnosis then was that the batch had to carry what
 * `stardew_action_program_status` would answer - a row per unfinished node - so `<in-flight>` was added.
 * </p>
 * <p>
 * WHY IT IS GONE (`design/fact-authority.md` §1b, 2026-11-16). A row per node is her BODY moving, not news: the
 * programme's own settlement states what her call did, per node, with its bounded evidence (`<execution-result>`), and
 * telling her "dispatched is not done" on every turn is the narration the run paid for. Measured `round64`: 401 admitted
 * "facts" for 8 opened turns, 260 of them one tile of movement stated twice. What replaces the block is the settlement -
 * and the tests below are what is left of this file once the block is deleted: the ledger reading every status call
 * fills, which is now read by the tools rather than by the pump.
 * </p>
 */

/**
 * A journal snapshot in the shape `validateBodyProgramStatusResult` accepts.
 *
 * The nodes are the wire's own: `actionId` is REQUIRED on every row (`isBodyProgramNodeStatus`), so a fixture that left it
 * out would be a fixture the Mod cannot produce.
 */
function journalStatus(
  programId: string,
  state: string,
  nodes: readonly Readonly<{ nodeId: string; actionId: string; state: string }>[],
  stopEpoch = 0,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    code: "found",
    snapshot: Object.freeze({
      programId,
      state,
      catalogRevision: 3,
      stopEpoch,
      eventHighWater: 7,
      nodes: Object.freeze(
        nodes.map((node) =>
          Object.freeze({
            nodeId: node.nodeId,
            state: node.state,
            nodeAttempt: 0,
            admissionAttempt: 0,
            actionId: node.actionId,
          }),
        ),
      ),
    }),
  });
}

/** A player's word, which is the one opener here that is not a fact: it opens the turn this file reads. */
function playerInput(): Readonly<{
  source: "player_text";
  inputId: string;
  eventId: string;
  text: string;
  locale: string;
  timestampMs: number;
}> {
  return Object.freeze({
    source: "player_text" as const,
    inputId: "player_1",
    eventId: "player_source_1",
    text: "你在忙什么？",
    locale: "zh-CN",
    timestampMs: 1_000,
  });
}

/** A step of a programme she dispatched: the shape that used to be rendered as an `<in-flight>` row. */
function programmeStep(executionId: string, revision: number): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    kind: "execution_receipt" as const,
    correlationId: executionId,
    executionId,
    requestId: `request_${executionId}`,
    revision,
    payload: Object.freeze({
      actionId: "water_crop",
      state: "running",
      reasonCode: "node_started",
      revision,
      origin: Object.freeze({ kind: "programme" as const, programId: "plan_rows", nodeId: "n001" }),
    }),
  });
}

/**
 * A programme still running is not narrated into the turn that opens for another reason.
 *
 * <p>
 * THE REPLACEMENT FOR THE BLOCK. The turn a person's word opens carries the world she is standing in and nothing about
 * the nodes of a plan in flight: their outcome arrives as the settlement's own per-node rows, bounded by the digest. The
 * step is still in the batch's FRAME (`batch.facts`) - nothing is lost, it is simply not pushed into the text - so a
 * reader can still account for it and the model is not handed a progress line it did not ask for.
 * </p>
 */
test("a programme in flight is not narrated: the settlement is the answer", async () => {
  const pump = new CompanionEventPump();
  pump.enqueueFact(programmeStep("exec_water_1", 10), FACT_PRODUCER.adapterIngress);
  pump.enqueuePlayerInput(playerInput());
  let batch: Readonly<{ text: string; facts: readonly WorldFact[] }> | undefined;
  await pump.flush({
    async deliver(delivered) {
      batch = delivered;
    },
  });
  assert.ok(batch !== undefined, "the person's word opened the turn it was owed");
  assert.equal(
    batch.text.includes("<in-flight>"),
    false,
    `no in-flight block exists any more, so none may be printed: ${batch.text}`,
  );
  assert.equal(batch.text.includes("in_flight:"), false, `and no row-per-node line either: ${batch.text}`);
  assert.equal(
    batch.facts.filter((fact) => fact.kind === "execution_receipt").length,
    1,
    "the step is still in the batch's frame: it is not delivered to the model, but it is not lost either",
  );
});

test("in_flight_reading_is_the_journals_own_rows: what a status read answers is what the ledger holds", () => {
  const observer = createProgramProgressObserver();
  const payload = journalStatus("plan_rows", "active", [
    { nodeId: "n001", actionId: "water_crop", state: "running" },
    { nodeId: "n002", actionId: "water_crop", state: "pending" },
    { nodeId: "n003", actionId: "harvest_crop", state: "succeeded" },
  ]);
  observer.observe(payload, 0);
  // A second read 2 s later: only the running node moved on, and its own clock restarts at the transition.
  observer.observe(
    journalStatus("plan_rows", "active", [
      { nodeId: "n001", actionId: "water_crop", state: "succeeded" },
      { nodeId: "n002", actionId: "water_crop", state: "running" },
      { nodeId: "n003", actionId: "harvest_crop", state: "succeeded" },
    ]),
    2_000,
  );
  const reading = observer.inFlight(4_000);
  assert.equal(reading.programmes.length, 1, `one programme in flight, got ${String(reading.programmes.length)}`);
  const programme = reading.programmes[0]!;
  assert.equal(programme.programId, "plan_rows", "the journal's own id, not a Host label");
  assert.equal(programme.total, 3, "the journal's node count, not the rows the bound happened to show");
  assert.equal(programme.settled, 2);
  assert.equal(programme.remaining, 1, "`remaining` is the count of rows that have NOT happened");
  assert.deepEqual(
    programme.nodes.map((node) => [node.index, node.nodeId, node.actionId, node.state]),
    [
      [0, "n001", "water_crop", "succeeded"],
      [1, "n002", "water_crop", "running"],
      [2, "n003", "harvest_crop", "succeeded"],
    ],
    "index, id, action and state, in the journal's order and in the Mod's own tokens",
  );
  assert.deepEqual(
    programme.nodes.map((node) => node.observedInStateMs),
    [2_000, 2_000, 4_000],
    "each node's clock is the ledger's own: `n001` and `n002` moved 2 s ago, `n003` has been settled since the first read",
  );
  assert.equal(programme.readAgeMs, 2_000, "and the reading says how old the journal read it came from is");
});

test("in_flight_reading_ends_when_the_journal_does: settled, stale and unread plans are not in flight", () => {
  const observer = createProgramProgressObserver();
  observer.observe(
    journalStatus("plan_ends", "active", [
      { nodeId: "n001", actionId: "water_crop", state: "running" },
      { nodeId: "n002", actionId: "water_crop", state: "pending" },
    ]),
    0,
  );
  assert.equal(observer.inFlight(0).programmes.length, 1, "the plan is in flight while the journal says `active`");
  assert.equal(
    observer.inFlight(IN_FLIGHT_READING_MAX_AGE_MS).programmes.length,
    1,
    "a read AT the bound is still evidence: the bound is the first age that is not",
  );
  assert.equal(
    observer.inFlight(IN_FLIGHT_READING_MAX_AGE_MS + 1).programmes.length,
    0,
    "past the bound the ledger is not evidence a programme is running, and a status read that kept saying so would lie",
  );
  // The bound has to be far above the watch that fills it, or ordinary operation would read as silence.
  assert.ok(
    IN_FLIGHT_READING_MAX_AGE_MS > PROGRAM_SETTLEMENT_WATCH_INTERVAL_MS * 2,
    `the reading expires after ${String(IN_FLIGHT_READING_MAX_AGE_MS)} ms while the watch re-reads every ${String(PROGRAM_SETTLEMENT_WATCH_INTERVAL_MS)} ms`,
  );
  // And a plan the Mod's journal has stopped leaves nothing behind.
  observer.observe(
    journalStatus("plan_ends", "succeeded", [
      { nodeId: "n001", actionId: "water_crop", state: "succeeded" },
      { nodeId: "n002", actionId: "water_crop", state: "succeeded" },
    ]),
    1_000,
  );
  assert.equal(observer.inFlight(1_000).programmes.length, 0, "a settled programme keeps no clock and no rows");
});

test("in_flight_reading_is_bounded: a long plan and many plans are counted, not truncated in silence", () => {
  const observer = createProgramProgressObserver();
  const nodes = Array.from({ length: MAX_IN_FLIGHT_NODE_ROWS + 4 }, (_, index) => ({
    nodeId: `n${String(index + 1).padStart(3, "0")}`,
    actionId: "water_crop",
    state: "pending",
  }));
  observer.observe(journalStatus("plan_long", "active", nodes), 0);
  const long = observer.inFlight(1_000).programmes[0]!;
  assert.equal(long.nodes.length, MAX_IN_FLIGHT_NODE_ROWS, "the rows are bounded");
  assert.equal(long.omitted, 4, "and what the bound left out is COUNTED");
  assert.equal(long.total, nodes.length, "while `total` still covers every node the journal holds");

  for (let index = 0; index < MAX_IN_FLIGHT_PROGRAMMES + 1; index += 1)
    observer.observe(
      journalStatus(`plan_many_${String(index)}`, "active", [
        { nodeId: "n001", actionId: "water_crop", state: "pending" },
      ]),
      0,
    );
  const many = observer.inFlight(1_000);
  assert.equal(many.programmes.length, MAX_IN_FLIGHT_PROGRAMMES, "the programmes are bounded");
  assert.equal(many.omittedProgrammes, 2, "and the two the bound left out are named as a count");
});

test("in_flight_reading_is_readable_without_a_batch: the ledger is the tools' reader, not the pump's", () => {
  // The pump's in-flight port is gone with the block. What is left is the reader every status call fills, and it must
  // still answer: a tool that asks "is my plan done" reads THIS.
  const programId = "plan_production_reader";
  const status = createProgramProgressObserver();
  status.observe(
    journalStatus(programId, "active", [{ nodeId: "n001", actionId: "enter_exit", state: "host_admitted" }]),
    0,
  );
  const reading = status.inFlight(500);
  const mine = reading.programmes.find((programme) => programme.programId === programId);
  assert.notEqual(mine, undefined, `the reading does not hold ${programId}`);
  assert.equal(mine?.nodes[0]?.state, "host_admitted", "and it states the journal's own node state");
  // The module-level reader every status call fills is still callable and still shaped the same way.
  assert.equal(typeof readInFlightProgrammes, "function");
});
