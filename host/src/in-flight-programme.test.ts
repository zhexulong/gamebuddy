import assert from "node:assert/strict";
import test from "node:test";

import { CompanionEventPump, FACT_PRODUCER, type WorldFact } from "./event-pump.js";
import { composeFactBrief, FACT_BRIEF_BLOCKS, NOTHING_IN_FLIGHT } from "./fact-brief.js";
import { PROGRAM_SETTLEMENT_WATCH_INTERVAL_MS } from "./program-settlement-digest.js";
import {
  createProgramProgressObserver,
  IN_FLIGHT_READING_MAX_AGE_MS,
  MAX_IN_FLIGHT_NODE_ROWS,
  MAX_IN_FLIGHT_PROGRAMMES,
  programmesNamed,
  programStatusProgress,
  readInFlightProgrammes,
  SETTLING_GRACE_MS,
} from "./program-status-wait.js";
import { BODY_PROGRAM_NODE_STATES, bodyProgramNodeStateVerdict } from "./protocol.js";

/**
 * "I don't know why, at the start she sent a lot of talk but did nothing."
 *
 * <p>
 * MEASURED 2026-11-11 (`round46`), from the run's own session - the two turns between a submission and its settlement:
 * </p>
 *
 * <pre>
 * 07:25:53  plan_work{builder.enter_exit({x:9,y:8})} -> {"accepted":true,"nodeCount":2,"settled":false,"remaining":2}
 * 07:26:04  she speaks: "*推开门，晨风凉凉地扑在脸上* 门前这片草和石头还横着呢…"   <- nothing has moved yet
 *           the batch she was handed: &lt;world-state&gt; 世界（revision 0，本轮无新观察）… 位置: 农舍；脚下: (9,9)
 * 07:26:17  plan_work{builder.enter_exit({x:3,y:12})} -> 2 nodes
 * 07:26:26  she speaks again: "*靴底踩着屋里的木地板往西挪*"                     <- still nothing moved
 * 07:26:34  observe -> 世界（revision 14）… 位置: 农场；脚下: (64, 15)
 * </pre>
 *
 * <p>
 * She did not idle. She was handed two speaking turns whose batch said nothing about the programme in flight, so
 * "dispatched" and "done" were the same sentence to her. The fix is not a scolding: the batch has to carry what
 * `stardew_action_program_status` would answer without being asked, and its own words have to draw the line that
 * `settled: false` draws in the tool result.
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

/** The world as round46's 07:26:04 batch stated it: the farmhouse, (9,9), on the day's first reading. */
function round46WorldFact(revision: number): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    kind: "snapshot" as const,
    eventId: `snapshot_${String(revision)}`,
    sourceEventId: `snapshot_${String(revision)}`,
    correlationId: `snapshot_${String(revision)}`,
    revision,
    occurredAtMs: 0,
    payload: Object.freeze({ revision, location: "FarmHouse", tile: Object.freeze({ x: 9, y: 9 }) }),
  });
}

/** One world fact that makes a turn deliverable without bringing an observation of its own. */
function milestone(index: number, occurredAtMs: number): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    kind: "world_fact" as const,
    eventId: `milestone_${String(index)}`,
    sourceEventId: `milestone_${String(index)}`,
    correlationId: `milestone_${String(index)}`,
    revision: 1,
    occurredAtMs,
    semanticKind: "time_milestone",
    payload: Object.freeze({ milestone: index }),
  });
}

/** The one batch a flush composes, as the model reads it. */
async function deliverText(pump: CompanionEventPump): Promise<string> {
  let text = "";
  await pump.flush({
    async deliver(batch) {
      text = batch.text;
    },
  });
  return text;
}

/** The programme rows an `<in-flight>` block printed, in order: `<index>/<total> <actionId> <state>`. */
function inFlightRows(text: string): string[] {
  const block = /<in-flight>\n([\s\S]*?)\n<\/in-flight>/u.exec(text)?.[1];
  if (block === undefined) return [];
  return [...block.matchAll(/^- (\d+\/\d+) (\S+) (\S+)（/gmu)].map(
    (match) => `${match[1] ?? ""} ${match[2] ?? ""} ${match[3] ?? ""}`,
  );
}

/** A pump whose in-flight reading comes from `observer`, so one test's programme cannot reach another's batch. */
function pumpReading(observer: ReturnType<typeof createProgramProgressObserver>, nowMs: number): CompanionEventPump {
  return new CompanionEventPump(() => observer.inFlight(nowMs));
}

test("in_flight_programme_absent_from_batch: round46's 07:26:04 batch says the programme is not settled", async () => {
  // The submission at 07:25:53 is a journal read this Host makes of every plan it submits and then watches
  // (`program-settlement-digest.ts#watchProgramSettlement`, once a second). The batch she spoke over was composed 11 s
  // later, and nothing had moved: no receipt existed to carry it. The programme's own state was the only truth
  // available, and the batch did not state it.
  const observer = createProgramProgressObserver();
  observer.observe(
    journalStatus("plan_46_enter_exit", "active", [
      { nodeId: "n001", actionId: "enter_exit", state: "pending" },
      { nodeId: "n002", actionId: "enter_exit", state: "pending" },
    ]),
    0,
  );
  const pump = pumpReading(observer, 11_000);

  // 07:25:53 - the world's first reading, delivered by the turn the submission came back on.
  pump.enqueueFact(round46WorldFact(0), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(milestone(599, 0), FACT_PRODUCER.adapterIngress);
  const first = await deliverText(pump);
  assert.match(first, /刚刚更新/u, `the first batch is the one that BRINGS the reading: ${first}`);
  // 07:26:04 - the turn she spoke over: no new observation at all, and a programme 11 s old.
  pump.enqueueFact(milestone(600, 11_000), FACT_PRODUCER.adapterIngress);
  const text = await deliverText(pump);

  assert.match(text, /本轮无新观察/u, `the world facts of this turn are round46's: ${text}`);
  assert.match(text, /<in-flight>\n/u, `the batch carries the programme in flight: ${text}`);
  assert.match(text, /in_flight:settled=0;total=2;remaining=2/u, "and the journal's own numbers for it");
  assert.match(text, /还没结算/u, "the block's own words say the programme has not settled");
  assert.match(text, /还没结算，就等于一步都还没做成/u, "and that none of it has happened yet");
  assert.deepEqual(
    inFlightRows(text),
    ["1/2 enter_exit pending", "2/2 enter_exit pending"],
    "one row per journal node",
  );
});

test("in_flight_programme_absent_from_batch: every node state the journal can report reaches the batch", async () => {
  // THE POPULATION IS THE WIRE'S OWN DECLARATION, not a list of the states someone remembered. A state whose verdict is
  // `moving` is one the plan has not finished with, so a batch composed while a node sits in it must say so.
  const moving = BODY_PROGRAM_NODE_STATES.filter((state) => bodyProgramNodeStateVerdict(state) === "moving");
  assert.ok(
    moving.length >= 4,
    `examined ${String(moving.length)} non-terminal states, which is too few to be the wire`,
  );
  process.stdout.write(`in_flight_programme_absent_from_batch examined ${moving.join(", ")}\n`);

  const failed: string[] = [];
  for (const state of moving) {
    const programId = `plan_state_${state}`;
    const observer = createProgramProgressObserver();
    observer.observe(
      journalStatus(programId, "active", [
        { nodeId: "n001", actionId: "water_crop", state },
        { nodeId: "n002", actionId: "harvest_crop", state: "pending" },
      ]),
      0,
    );
    const pump = pumpReading(observer, 3_000);
    pump.enqueueFact(round46WorldFact(0), FACT_PRODUCER.adapterIngress);
    pump.enqueueFact(milestone(1, 3_000), FACT_PRODUCER.adapterIngress);
    const text = await deliverText(pump);
    const rows = inFlightRows(text);
    if (!text.includes(`in_flight:settled=0;total=2;remaining=2`))
      failed.push(`${state}: no token for the journal's rows`);
    // The block's node count is the JOURNAL's: two rows, in the journal's order, with the Mod's own tokens.
    if (rows.length !== 2) failed.push(`${state}: ${String(rows.length)} rows for a 2-node programme`);
    if (rows[0] !== `1/2 water_crop ${state}`) failed.push(`${state}: first row was ${String(rows[0])}`);
    if (rows[1] !== "2/2 harvest_crop pending") failed.push(`${state}: second row was ${String(rows[1])}`);
  }
  assert.deepEqual(
    failed,
    [],
    `these states did not reach the batch as the journal describes them: ${failed.join("; ")}`,
  );
});

test("in_flight_block_when_nothing_is_running: no unsettled programme means no block at all", async () => {
  // An empty block reads as "a programme exists and has no nodes" - the opposite of what the batch knows. The population
  // here is the honest one: the journal says the programme it once watched has SETTLED, so the ledger drops it.
  const observer = createProgramProgressObserver();
  observer.observe(
    journalStatus("plan_46_settled_alone", "succeeded", [
      { nodeId: "n001", actionId: "enter_exit", state: "succeeded" },
      { nodeId: "n002", actionId: "enter_exit", state: "succeeded" },
    ]),
    0,
  );
  const pump = pumpReading(observer, 11_000);
  pump.enqueueFact(round46WorldFact(0), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(milestone(599, 0), FACT_PRODUCER.adapterIngress);
  await deliverText(pump);
  pump.enqueueFact(milestone(601, 11_000), FACT_PRODUCER.adapterIngress);
  const text = await deliverText(pump);

  assert.equal(text.includes("<in-flight>"), false, `no block, and not an empty one: ${text}`);
  assert.equal(text.includes("</in-flight>"), false, `no block, and not an empty one: ${text}`);
  // The block is absent from the batch's own markup, not merely empty inside it.
  const opened = [...text.matchAll(/<([a-z-]+)>/gu)].map((match) => match[1] ?? "");
  assert.deepEqual(
    opened,
    FACT_BRIEF_BLOCKS.filter((name) => name !== "in-flight" && name !== "execution-result"),
    `the batch carries the blocks it has content for, and no <in-flight> placeholder: ${text}`,
  );
});

test("in_flight_block_when_nothing_is_running: an empty reading is not an empty block", () => {
  // The composer, at the seam: `NOTHING_IN_FLIGHT` and an absent reading must both render nothing rather than a block
  // with no rows - which is the shape a naive `block("in-flight", lines.join("\n"))` produces from an empty list.
  assert.equal(
    composeFactBrief({ inputs: [], snapshot: undefined, events: [], locale: "zh-CN" }),
    composeFactBrief({ inputs: [], snapshot: undefined, events: [], inFlight: NOTHING_IN_FLIGHT, locale: "zh-CN" }),
    "an empty reading changes nothing about the text",
  );
  assert.equal(FACT_BRIEF_BLOCKS.includes("in-flight"), true, "and the block is a member of the closed set");
});

test("in_flight_reading_is_the_journals_own_rows: what the batch states is what the tool answers", () => {
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
    "past the bound the ledger is not evidence a programme is running, and a batch that kept saying so would lie",
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
  assert.equal(observer.inFlight(1_000).programmes.length, 0, "a settled programme keeps no clock and no block");
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

test("in_flight_reading_reads_the_production_ledger: the pump's default is the one every status read fills", () => {
  // Not a second reading: the id observed here is the one the module-level ledger holds, which is the ledger
  // `stardew_action_program_status` reports its clocks from. Whether OTHER programmes are in flight is another test's
  // business, so this asserts membership rather than a total.
  const programId = "plan_production_default";
  programStatusProgress.observe(
    journalStatus(programId, "active", [{ nodeId: "n001", actionId: "enter_exit", state: "host_admitted" }]),
    Date.now(),
  );
  const reading = readInFlightProgrammes();
  const mine = reading.programmes.find((programme) => programme.programId === programId);
  assert.notEqual(mine, undefined, `the default reading does not hold ${programId}`);
  assert.equal(mine?.nodes[0]?.state, "host_admitted", "and it states the journal's own node state");
});

test("steer_batch_carries_it_too: a steer joining a running turn states the programme in flight", async () => {
  // The second compose site: a steer is a batch the model reads while a turn is running, and a programme submitted in
  // that same turn is exactly what she would narrate over. It costs one line and nothing else is consumed.
  const observer = createProgramProgressObserver();
  observer.observe(
    journalStatus("plan_steer", "active", [{ nodeId: "n001", actionId: "enter_exit", state: "pending" }]),
    0,
  );
  const pump = pumpReading(observer, 5_000);
  pump.enqueueFact(milestone(700, 5_000), FACT_PRODUCER.adapterIngress);
  const texts: string[] = [];
  await pump.steer({
    async deliver(batch) {
      texts.push(batch.text);
    },
  });
  assert.equal(texts.length, 1, "the steer delivered one batch");
  assert.match(texts[0] ?? "", /in_flight:settled=0;total=1;remaining=1/u, "and it says what is outstanding");
});

// ---------------------------------------------------------------------------------------------------------------
// The lifetime: named, then clockless, then gone.
// ---------------------------------------------------------------------------------------------------------------

/**
 * A programme is not forgotten the instant its status turns terminal.
 *
 * <p>
 * MEASURED 2026-11-15 (`round62`): `program_settlement` suppressed 168 times as `progress`, and `adapter_ingress` still
 * opened 71 turns. The ledger deleted a programme at the same instant its status turned terminal, and the LAST node's
 * receipt - which arrives after that read and before the settlement that states it - then had no programme to belong to:
 * it fell through to `decision` and bought a turn for a step whose own settlement was already queued behind it.
 * </p>
 * <p>
 * The name cannot live forever: a later plan may reuse the id, and a stale anchor would report another plan's work as
 * this one's (the reason the delete existed at all). So the lifetime has exactly two exits, and both are held below.
 * </p>
 */
test("settling_lifetime: a stopped programme stays NAMED for its tail receipts, and is never reported in flight", () => {
  const observer = createProgramProgressObserver();
  observer.observe(
    journalStatus("plan_tail", "active", [
      { nodeId: "n001", actionId: "harvest_crop", state: "succeeded" },
      { nodeId: "n002", actionId: "harvest_crop", state: "running" },
    ]),
    0,
  );
  assert.equal(programmesNamed(observer.inFlight(0)), true, "while it runs it is named");

  // The read that sees the last node finish, 2 s later: the boundary the tail receipt arrives on.
  observer.observe(
    journalStatus("plan_tail", "succeeded", [
      { nodeId: "n001", actionId: "harvest_crop", state: "succeeded" },
      { nodeId: "n002", actionId: "harvest_crop", state: "succeeded" },
    ]),
    2_000,
  );
  const settled = observer.inFlight(2_000);
  assert.equal(
    settled.programmes.length,
    0,
    "it is not in flight: every node has settled, and a block saying otherwise lies",
  );
  assert.deepEqual(
    settled.settling.map((programme) => [programme.programId, programme.settledAgeMs]),
    [["plan_tail", 0]],
    "but its NAME is still there, aged from the read that saw it stop",
  );
  assert.equal(
    programmesNamed(settled),
    true,
    "which is what stops the tail receipt from being read as a lone outcome",
  );
});

test("settling_lifetime: the grace is the second exit, and it is read from one bound", () => {
  // Both ends of the same edge, in the style the reading bound is held in above: AT the grace the name is still there,
  // one millisecond past it the name is gone and a receipt is a lone outcome again.
  const observer = createProgramProgressObserver();
  observer.observe(
    journalStatus("plan_grace", "active", [{ nodeId: "n001", actionId: "water_crop", state: "running" }]),
    0,
  );
  observer.observe(
    journalStatus("plan_grace", "succeeded", [{ nodeId: "n001", actionId: "water_crop", state: "succeeded" }]),
    1_000,
  );
  assert.equal(
    observer.inFlight(1_000 + SETTLING_GRACE_MS).settling.length,
    1,
    "the last read inside the grace still names it",
  );
  assert.equal(
    observer.inFlight(1_000 + SETTLING_GRACE_MS + 1).settling.length,
    0,
    "past the grace the name is gone: a programme nothing is owed for must not keep answering for other receipts",
  );
});

test("settling_lifetime: a new plan taking the id ends the old name, and cannot inherit its clocks", () => {
  // THE FIRST EXIT, in its in-place form: `plan_273` stops and a later `plan_273` starts under the SAME key, so the name
  // is replaced rather than left behind - and the settled plan's frozen anchors must not come with it. (The cross-key form
  // of the same exit - a new STOP epoch - is the test below, and it is the one the eviction loop itself answers for.)
  const observer = createProgramProgressObserver();
  observer.observe(
    journalStatus("plan_reuse", "active", [{ nodeId: "n001", actionId: "till_soil", state: "running" }]),
    0,
  );
  observer.observe(
    journalStatus("plan_reuse", "succeeded", [{ nodeId: "n001", actionId: "till_soil", state: "succeeded" }]),
    4_000,
  );
  assert.equal(observer.inFlight(4_000).settling.length, 1, "the stopped plan is named while the id is free");

  const again = observer.observe(
    journalStatus("plan_reuse", "active", [{ nodeId: "n001", actionId: "till_soil", state: "running" }]),
    9_000,
  );
  const reading = observer.inFlight(9_000);
  assert.deepEqual(
    reading.settling.map((programme) => programme.programId),
    [],
    "the id is the live plan's now: the settling name it replaced is gone",
  );
  assert.deepEqual(
    reading.programmes.map((programme) => programme.programId),
    ["plan_reuse"],
    "and the live plan is in flight under that same id",
  );
  assert.equal(again?.current?.observedInStateMs, 0, "with its own clock, not the one the stopped plan left behind");
});

test("settling_lifetime: a STOP epoch is a new plan, so it ends the previous epoch's name too", () => {
  // The key is the id AND the stop epoch: a STOP cancels the nodes and the same ids are re-dispatched, so the settling
  // name of epoch 0 must not answer for epoch 1's steps. This is the exit the eviction loop exists for - the new plan's
  // key is different, so nothing overwrites the old entry.
  const observer = createProgramProgressObserver();
  observer.observe(
    journalStatus("plan_epoch", "active", [{ nodeId: "n001", actionId: "enter_exit", state: "running" }]),
    0,
  );
  observer.observe(
    journalStatus("plan_epoch", "cancelled", [{ nodeId: "n001", actionId: "enter_exit", state: "cancelled" }]),
    1_000,
  );
  assert.equal(
    observer.inFlight(1_000).settling.length,
    1,
    "the cancelled plan is named while nothing has replaced it",
  );
  observer.observe(
    journalStatus("plan_epoch", "active", [{ nodeId: "n001", actionId: "enter_exit", state: "pending" }], 1),
    3_000,
  );
  assert.deepEqual(
    observer.inFlight(3_000).settling.map((programme) => programme.programId),
    [],
    "the new epoch took the id: one id has one lifetime",
  );
});

test("settling_lifetime: a plan this ledger never saw active was never forgotten, so it starts no lifetime", () => {
  // The precision that keeps the name from being a blanket silence: the lifetime exists for a programme a PRIOR status
  // update removed. A first read that already shows the plan stopped removed nothing, and answering for it would suppress
  // the first `succeeded` receipt of a run.
  const observer = createProgramProgressObserver();
  observer.observe(
    journalStatus("plan_first_seen_stopped", "succeeded", [
      { nodeId: "n001", actionId: "harvest_crop", state: "succeeded" },
    ]),
    0,
  );
  const reading = observer.inFlight(0);
  assert.deepEqual(reading.programmes, [], "nothing is in flight");
  assert.deepEqual(reading.settling, [], "and nothing was forgotten here, so nothing is named");
  assert.equal(programmesNamed(reading), false);
});

test("settling_lifetime: the grace outlasts the watch that reports the stop and stays inside the reading bound", () => {
  // A named programme must outlive the tick that saw it stop - the tail receipt is already in flight at that moment - and
  // it must not outlive the bound that exists because a dead watch's last read is not evidence. Both ends are stated as
  // properties so neither number can drift into the other's territory.
  assert.ok(
    SETTLING_GRACE_MS > PROGRAM_SETTLEMENT_WATCH_INTERVAL_MS * 2,
    `the name expires after ${String(SETTLING_GRACE_MS)} ms while the watch re-reads every ${String(PROGRAM_SETTLEMENT_WATCH_INTERVAL_MS)} ms`,
  );
  assert.ok(
    SETTLING_GRACE_MS < IN_FLIGHT_READING_MAX_AGE_MS,
    `the name outlives the reading bound it belongs to: ${String(SETTLING_GRACE_MS)} ms against ${String(IN_FLIGHT_READING_MAX_AGE_MS)} ms`,
  );
});
