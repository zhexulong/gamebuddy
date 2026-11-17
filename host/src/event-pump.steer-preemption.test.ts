import assert from "node:assert/strict";
import test from "node:test";
import { isTerminalExecutionState } from "./execution-correlation-ledger.js";
import {
  FACT_PRODUCER,
  MODEL_STOP_REASON_CODE,
  PREEMPTING_EXECUTION_STATES,
  CompanionEventPump,
  isPreemptingFact,
  type PendingBatch,
  type WorldFact,
} from "./event-pump.js";
import { BODY_PROGRAM_PROOF_NODE_STATES, EXECUTION_STATES } from "./protocol.js";

/** One execution receipt, in the shape the Mod's own journal publishes. */
function receipt(correlationId: string, payload: Readonly<Record<string, unknown>>): WorldFact {
  return {
    source: "stardew_mod",
    kind: "execution_receipt",
    eventId: correlationId,
    sourceEventId: correlationId,
    correlationId,
    revision: 1,
    observedTick: 1000,
    executionId: `exec_${correlationId}`,
    requestId: `req_${correlationId}`,
    payload,
  };
}

const oneSnapshot = (revision: number): WorldFact => ({
  source: "stardew_mod",
  kind: "snapshot",
  eventId: `snapshot_${String(revision)}`,
  correlationId: `snapshot_${String(revision)}`,
  revision,
  payload: { revision, location: "Farm", actionable: true },
});

/** The batch a steer hands over, or `undefined` when the pump had nothing steerable. */
async function steeredBatch(pump: CompanionEventPump): Promise<PendingBatch | undefined> {
  let batch: PendingBatch | undefined;
  const steered = await pump.steer({
    async deliver(delivered) {
      batch = delivered;
    },
  });
  return steered ? batch : undefined;
}

/** The first delivery a turn takes, with the sink held open so the turn stays in flight. */
function holdFirstTurn(pump: CompanionEventPump) {
  const seen: PendingBatch[] = [];
  let release: () => void = () => undefined;
  let started: () => void = () => undefined;
  const firstDelivery = new Promise<void>((resolve) => {
    started = resolve;
  });
  const turn = pump.flush({
    async deliver(batch) {
      seen.push(batch);
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  });
  return {
    seen,
    // A turn that never takes a batch would be a `flush` that owed none, and waiting on it forever would look exactly
    // like a slow suite. The bound is a hang detector, not a budget: it ends the wait, it never fails a real delivery.
    firstDelivery: Promise.race([
      firstDelivery,
      new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error("no turn took a batch: this flush owed none, so nothing is in flight to steer"));
        }, 1_000).unref();
      }),
    ]),
    release: async () => {
      release();
      await turn;
    },
  };
}

/** The receipt identities a batch carries, in delivery order: the snapshot rides in `facts` too and is not a receipt. */
const receiptIdentities = (batch: PendingBatch | undefined): readonly string[] =>
  (batch?.facts ?? []).filter((fact) => fact.kind === "execution_receipt").map((fact) => fact.correlationId);

/**
 * THE GATE.
 *
 * <p>
 * The population is `EXECUTION_STATES` - the protocol's own vocabulary, not a list written here - and the property is
 * per member: a state the ledger calls terminal and the Mod's `provesEffect` rule calls unproven is a STOPPED PLAN, and
 * a stopped plan must be steerable. Anything else is progress a turn may carry to its own end.
 * </p>
 * <p>
 * Each member is driven through THREE paths that can disagree: the classifier, the pump's getter and the batch `steer`
 * actually hands over. The defect this replaces was exactly a disagreement between them - the getter scanned a window
 * holding no receipts at all, so every receipt answered "not news" - so agreement is the assertion, not a formality.
 * </p>
 */
test("a_blocked_step_waits_for_a_turn: no stopped-plan state is left for the turn to finish", async () => {
  const provedEffect: ReadonlySet<string> = new Set<string>(BODY_PROGRAM_PROOF_NODE_STATES);
  const preemptingStates: string[] = [];
  const carriedStates: string[] = [];
  const failures: string[] = [];

  for (const state of EXECUTION_STATES) {
    const fact = receipt(`receipt_${state}`, { state });
    const pump = new CompanionEventPump();
    pump.enqueueFact(fact, FACT_PRODUCER.adapterIngress);

    const classifier = isPreemptingFact(fact);
    const getter = pump.hasPreemptingFact;
    const batch = await steeredBatch(pump);
    const steered = batch !== undefined && batch.facts.some((member) => member.correlationId === fact.correlationId);

    const stoppedPlan = isTerminalExecutionState(state) && !provedEffect.has(state);
    if (stoppedPlan) preemptingStates.push(state);
    else carriedStates.push(state);

    if (getter !== classifier)
      failures.push(
        `${state}: the pump's getter says ${String(getter)} while the classification says ${String(classifier)} - the ` +
          "getter is scanning a window this receipt does not live in",
      );
    if (steered !== classifier)
      failures.push(
        `${state}: a steer ${steered ? "did" : "did not"} carry it while the classification says ${String(classifier)}`,
      );
    if (stoppedPlan && !steered)
      failures.push(
        `${state}: stopped_plan carried into the turn - the body has stopped and the running turn will keep thinking ` +
          "about it until it ends. A stopped-plan state must steer or the ruling is wrong again",
      );
    if (!stoppedPlan && steered)
      failures.push(
        `${state}: the plan is still moving or proved its effect, and interrupting a running plan to say so ` +
          "trades a finished action for a half-finished thought",
      );
  }

  process.stderr.write(
    `a_blocked_step_waits_for_a_turn: states examined ${String(EXECUTION_STATES.length)} · ` +
      `preempting ${String(preemptingStates.length)} {${preemptingStates.join(", ")}} · ` +
      `carried ${String(carriedStates.length)} {${carriedStates.join(", ")}}\n`,
  );
  // A check whose population is empty agrees with itself.
  assert.ok(EXECUTION_STATES.length > 0, "the population came from the protocol's vocabulary and it was empty");
  assert.ok(
    preemptingStates.length > 0 && carriedStates.length > 0,
    `both classes must be populated or the classification collapsed: preempting ${preemptingStates.join(",")} · carried ${carriedStates.join(",")}`,
  );
  assert.deepEqual(
    failures,
    [],
    `every execution state is classified, and the classes are exercised for real:\n${failures.join("\n")}`,
  );
});

/**
 * The one state the state table cannot decide alone, decided from the payload rather than guessed.
 *
 * <p>
 * A cancel SHE asked for is already in her own tool result (`stardew_stop_action` returns the receipt), so steering it
 * would interrupt a running thought with something she herself said. A cancel the MOD performed is an obstruction she
 * has not been told about. The receipt's `reasonCode` is what says which, and these two assertions are the two arms.
 * </p>
 */
test("a cancel she asked for is not news; a cancel the Mod performed is", async () => {
  const herAsk = receipt("receipt_stop", { state: "cancelled", reasonCode: MODEL_STOP_REASON_CODE });
  const modVerdict = receipt("receipt_superseded", {
    state: "cancelled",
    reasonCode: "superseded_night_that_has_not_begun",
  });

  assert.equal(PREEMPTING_EXECUTION_STATES.cancelled, true, "the un-narrowed reading cannot lose an outcome");
  assert.equal(isPreemptingFact(herAsk), false, "`model_stop_requested` is her own ask, already in her tool result");
  assert.equal(isPreemptingFact(modVerdict), true, "a cancel the Mod performed is news she has not been told");

  const pump = new CompanionEventPump();
  pump.enqueueFact(herAsk, FACT_PRODUCER.adapterIngress);
  assert.equal(pump.hasPreemptingFact, false, "and the pump agrees: nothing to steer");
  assert.equal(
    await pump.steer({
      async deliver() {
        throw new Error("her own ask must not steer");
      },
    }),
    false,
  );

  pump.enqueueFact(modVerdict, FACT_PRODUCER.adapterIngress);
  const batch = await steeredBatch(pump);
  assert.deepEqual(
    receiptIdentities(batch),
    ["receipt_superseded"],
    "the Mod's verdict travels and her ask does not, in one batch",
  );
});

/**
 * FALSIFIER 1 — the direction the fix exists for, and the contract the steer batch must not break.
 *
 * <p>
 * A `rejected` node arrives while a turn is thinking. It must be handed over NOW, and the in-flight turn's own follow-up
 * must still find everything the steer had no business taking: the successful receipt, the player's words, and the
 * snapshot slot that decides whether the next turn says `刚刚更新`.
 * </p>
 */
test("a rejected node reaches the running turn, and the turn's own follow-up still has the rest", async () => {
  const pump = new CompanionEventPump();
  // A step that OWES a turn opens it; a `running` receipt is held progress and would open none (`HELD_RECEIPT_PROGRESS_STATES`).
  pump.enqueueFact(
    receipt("receipt_opener", { state: "succeeded", actionId: "water_crop" }),
    FACT_PRODUCER.adapterIngress,
  );

  const turn = holdFirstTurn(pump);
  await turn.firstDelivery;
  assert.equal(turn.seen.length, 1, "the turn is genuinely in flight");

  // Mid-turn: a step the Mod refused, a step that succeeded, the player's words, and a newer reading.
  pump.enqueueFact(
    receipt("receipt_refused", {
      state: "rejected",
      actionId: "navigate_to_destination",
      reasonCode: "destination_unreachable",
      evidence: { detail: "topology=unreachable" },
    }),
    FACT_PRODUCER.adapterIngress,
  );
  pump.enqueueFact(
    receipt("receipt_done", { state: "succeeded", actionId: "water_crop" }),
    FACT_PRODUCER.adapterIngress,
  );
  pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "input_1",
    text: "先把那块地浇了",
    locale: "zh-CN",
    timestampMs: 1,
  });
  pump.enqueueFact(oneSnapshot(2), FACT_PRODUCER.adapterIngress);

  assert.equal(pump.hasPreemptingFact, true, "the refused step is what a steer is for");
  const steer = await steeredBatch(pump);
  assert.deepEqual(
    receiptIdentities(steer),
    ["receipt_refused"],
    "the steer carries the obstruction and nothing else - not the success, not the reading",
  );
  assert.equal(steer?.disposition, "steer");
  // The obstruction must arrive as the Mod's own words, because the sink sends `batch.text` and discards `facts`.
  assert.match(steer?.text ?? "", /navigate_to_destination/u, "the action that stopped is named");
  assert.match(steer?.text ?? "", /destination_unreachable/u, "and the Mod's own reason for it");
  assert.match(steer?.text ?? "", /topology=unreachable/u, "and its evidence detail, verbatim");

  await turn.release();

  const followUp: PendingBatch[] = [];
  await pump.flush({
    async deliver(batch) {
      followUp.push(batch);
    },
  });
  assert.equal(followUp.length, 1, "the player's own words still open the turn they were owed");
  assert.deepEqual(
    receiptIdentities(followUp[0]),
    ["receipt_done"],
    "the successful receipt is the plan working: it is carried, not steered",
  );
  assert.deepEqual(
    followUp[0]?.inputs.map((input) => input.text),
    ["先把那块地浇了"],
    "and the steer never consumed the player's words",
  );
  assert.equal(
    followUp[0]?.broughtObservation,
    true,
    "and the snapshot slot is still the follow-up's: a steer states the world it joins, it does not take the reading",
  );
});

/**
 * FALSIFIER 2 — the regressed direction. A `succeeded` step is the plan WORKING; it is progress the settlement turn
 * carries, and a steer that interrupted a running plan to announce it would trade a finished action for a half-finished
 * thought. This is the half of the old ruling that was right, kept as its own assertion.
 */
test("a succeeded step never steers, whatever else is waiting", async () => {
  const pump = new CompanionEventPump();
  const succeeded = receipt("receipt_ok", { state: "succeeded", actionId: "water_crop" });
  pump.enqueueFact(succeeded, FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(oneSnapshot(3), FACT_PRODUCER.adapterIngress);
  pump.enqueuePlayerInput({ source: "player_text", inputId: "input_2", text: "好", locale: "zh-CN", timestampMs: 2 });

  assert.equal(pump.hasPreemptingFact, false, "progress is not news a running turn needs");
  assert.equal(isPreemptingFact(succeeded), false);
  assert.equal(
    await pump.steer({
      async deliver() {
        throw new Error("nothing here stops the plan");
      },
    }),
    false,
    "so a steer has nothing to carry",
  );

  const batches: PendingBatch[] = [];
  await pump.flush({
    async deliver(batch) {
      batches.push(batch);
    },
  });
  assert.deepEqual(
    receiptIdentities(batches[0]),
    ["receipt_ok"],
    "the receipt is still delivered - as the turn's own content, which is where progress belongs",
  );
});

/**
 * FALSIFIER 3 — a preempting fact must never become a way to OPEN a turn.
 *
 * <p>
 * `steer` is for a turn that is already thinking. With no turn running the receipt is ordinary pending work and the
 * ordinary flush delivers it, with the ordinary disposition - the call site's `#flushScheduled` guard is what keeps the
 * two apart, and this pins the pump's half of that contract.
 * </p>
 */
test("with no turn running a preempting fact is ordinary pending work, not a steer", async () => {
  const pump = new CompanionEventPump();
  pump.enqueueFact(
    receipt("receipt_failed", {
      state: "failed",
      actionId: "navigate_to_destination",
      reasonCode: "native_path_ended",
    }),
    FACT_PRODUCER.adapterIngress,
  );

  assert.equal(pump.hasPreemptingFact, true, "the pump knows it is there");
  assert.equal(pump.hasExpiringFact, false, "and it is not a milestone, so the two questions stay separate");

  const batches: PendingBatch[] = [];
  await pump.flush({
    async deliver(batch) {
      batches.push(batch);
    },
  });
  assert.equal(batches.length, 1, "the ordinary flush opened the turn the fact is owed");
  assert.equal(batches[0]?.disposition, "follow_up", "and it is that turn's content rather than a steer");
  assert.equal(
    await pump.steer({
      async deliver() {
        throw new Error("the window is empty");
      },
    }),
    false,
  );
});

/**
 * The population is the RECEIPT shape, not "any fact that mentions a state". A semantic event or a world fact carrying a
 * stopped-plan token says nothing about an execution the pump is holding, and steering on it would be a guess.
 */
test("only an execution receipt can preempt", async () => {
  const shapes: readonly WorldFact[] = [
    {
      source: "stardew_mod",
      kind: "semantic_event",
      correlationId: "event_1",
      revision: 1,
      payload: { kind: "execution_started", state: "rejected" },
    },
    {
      source: "stardew_mod",
      kind: "world_fact",
      correlationId: "fact_1",
      revision: 1,
      payload: { state: "failed" },
    },
    {
      source: "stardew_mod",
      kind: "lifecycle",
      correlationId: "lifecycle_1",
      revision: 1,
      payload: { state: "rejected" },
    },
  ];
  for (const fact of shapes) assert.equal(isPreemptingFact(fact), false, `${fact.kind} is not a receipt`);

  // And a receipt carrying a state the protocol does not declare is not a shape anything may read a classification from.
  const unknown = receipt("receipt_unknown", { state: "constructor" });
  assert.equal(isPreemptingFact(unknown), false, "a prototype key is not an execution state");
  const undeclared = receipt("receipt_undeclared", { state: "abandoned" });
  assert.equal(isPreemptingFact(undeclared), false, "an undeclared state opens a turn rather than being guessed at");
  assert.equal(
    Object.hasOwn(PREEMPTING_EXECUTION_STATES, "abandoned"),
    false,
    "the population is the protocol's own execution vocabulary, so `abandoned` is not classified here at all",
  );
});
