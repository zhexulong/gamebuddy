import assert from "node:assert/strict";
import test from "node:test";
import { isTerminalExecutionState } from "./execution-correlation-ledger.js";
import {
  FACT_PRODUCER,
  MODEL_STOP_REASON_CODE,
  PREEMPTION,
  PREEMPTION_PREEMPTS,
  PREEMPTION_REASONS,
  CompanionEventPump,
  STOPPED_PLAN_EXECUTION_STATES,
  isStoppedPlanReceipt,
  preemptionOf,
  preemptionShapeOf,
  TURN_OPENING,
  type PendingBatch,
  type PreemptionReason,
  type WorldFact,
} from "./event-pump.js";
import type { InFlightProgramme, InFlightProgrammeReading } from "./program-status-wait.js";
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

/**
 * The Mod's own clock mark: the one opener here that is not a receipt.
 *
 * `time_milestone` is on `PRESENTATION_LEASE_KINDS` and carries an opaque `sourceEventId`, so `#opensTurn` accepts it
 * through `#canPresent`. An `execution_receipt` never can - the wire's `#receipt` carries no event identity to present
 * under - which is why a turn in these tests must not be opened with one (see falsifiers 1 and 3).
 */
const timeMilestone = (): WorldFact => ({
  source: "stardew_mod",
  kind: "world_fact",
  eventId: "time_milestone_600",
  sourceEventId: "time_milestone_600",
  correlationId: "time_milestone_600",
  revision: 1,
  observedTick: 1000,
  semanticKind: "time_milestone",
  payload: { milestone: 600 },
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
 * a stopped plan STATED BY NO PLAN (no provenance at all here) is news a running turn needs now. Anything else is
 * progress a turn may carry to its own end.
 * </p>
 * <p>
 * Each member is driven through THREE paths that can disagree: the classification, the pump's getter and the batch
 * `steer` actually hands over. The defect this replaces was exactly a disagreement between them - the getter scanned a
 * window holding no receipts at all, so every receipt answered "not news" - so agreement is the assertion, not a
 * formality.
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

    const reason = preemptionOf(fact, []);
    const classifier = PREEMPTION_PREEMPTS[reason];
    const getter = pump.hasPreemptingFact;
    const batch = await steeredBatch(pump);
    const steered = batch !== undefined && batch.facts.some((member) => member.correlationId === fact.correlationId);

    const stoppedPlan = isTerminalExecutionState(state) && !provedEffect.has(state);
    if (stoppedPlan) preemptingStates.push(state);
    else carriedStates.push(state);

    if (getter !== classifier)
      failures.push(
        `${state}: the pump's getter says ${String(getter)} while the classification says ${reason} ` +
          `(${String(classifier)}) - the getter is scanning a window this receipt does not live in`,
      );
    if (steered !== classifier)
      failures.push(
        `${state}: a steer ${steered ? "did" : "did not"} carry it while the classification says ${reason} ` +
          `(${String(classifier)})`,
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

  assert.equal(STOPPED_PLAN_EXECUTION_STATES.cancelled, true, "the un-narrowed reading cannot lose an outcome");
  assert.equal(
    isStoppedPlanReceipt(herAsk),
    false,
    "`model_stop_requested` is her own ask, already in her tool result",
  );
  assert.equal(isStoppedPlanReceipt(modVerdict), true, "a cancel the Mod performed is news she has not been told");

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
 * <p>
 * THE OPENER IS THE MOD'S CLOCK MARK, NOT A RECEIPT, and the earlier version of this test got that wrong. It opened the
 * turn with a `succeeded` node receipt on the reasoning "a step that OWES a turn opens it" - true when it was written,
 * false since `9be6af14`: `#opensTurn` is `#owesTurn && !restatement && (isDueFact || #canPresent)`, and
 * `presentationSourceOf` answers `undefined` for every `execution_receipt`. A receipt now OWES a turn and OPENS none, so
 * that opener started nothing and every assertion after it was unreachable. The subject here is the STEER, so the turn
 * is opened by a fact the pump's own `#opensTurn` accepts, and the receipt's two answers are asserted at the end: STATED
 * by the follow-up's text, and NOT the opener of it.
 * </p>
 */
test("a rejected node reaches the running turn, and the turn's own follow-up still has the rest", async () => {
  const pump = new CompanionEventPump();
  // A clock mark is presentable, so it opens a turn through `#canPresent`. A receipt could not: it has nothing to present.
  pump.enqueueFact(timeMilestone(), FACT_PRODUCER.adapterIngress);

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
  // THE TWO ANSWERS, IN THE ONE PLACE BOTH ARE VISIBLE. `#owesTurn` says the model is TOLD; `#opensTurn` says it is WOKEN.
  // This receipt does the first and not the second, and a change that collapses the two has to leave one of these red.
  assert.match(
    followUp[0]?.text ?? "",
    /water_crop 做成了/u,
    "the outcome is STATED: a receipt OWES a turn even though it can open none, and this is the fact that says the node ran",
  );
  assert.deepEqual(
    pump.turnAccount.lastDecision,
    { kind: "opened", index: 2, reason: TURN_OPENING.playerInput },
    "while the OPENER is the player's own word, not the receipt: `#owesTurn` and `#opensTurn` are two answers",
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
  assert.equal(isStoppedPlanReceipt(succeeded), false);
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
 * `steer` is for a turn that is already thinking. With no turn running the receipt is ordinary pending work, and the
 * call site's `#flushScheduled` guard is what keeps the two apart; this pins the pump's half of that contract.
 * </p>
 * <p>
 * WHAT CHANGED HERE, AND WHY IT IS THE SAME PROPERTY. The old assertion was `batches.length === 1`, reading "the ordinary
 * flush opened the turn the fact is owed" - which stopped being true at `9be6af14` for the reason falsifier 1 spells out:
 * `#opensTurn` requires a presentable surface and a receipt has none. The property was never "a batch exists"; it was
 * that a preempting fact is ORDINARY PENDING WORK when no turn is running, so that is what is asserted now - the flush
 * owes no turn, the fact stays in its window with a ticket, and the turn that CAN present states it. Pending work is a
 * delay, never a silence, and both halves are asserted.
 * </p>
 * <p>
 * AND THE PUMP CANNOT TELL THAT NO TURN IS RUNNING: `takeSteerableOnly` reads `#receipts` for `#steersNow` and
 * nothing else, and `steer` is documented as the branch the CALLER takes only while its `#flushScheduled` guard says a
 * turn is in flight. So `steer` hands the fact over whenever it is asked, which is asserted rather than implied - a pump
 * that guessed at turn liveness would be a second, worse copy of a guard the Host already owns.
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
  const outcome = await pump.flush({
    async deliver(batch) {
      batches.push(batch);
    },
  });
  assert.equal(
    outcome.kind,
    "not_owed",
    "no surface can show a receipt, so the ordinary flush invites no turn for it: it is pending work, not an opener",
  );
  assert.equal(batches.length, 0, "and nothing was delivered, so it did not become a turn of its own");
  assert.equal(pump.turnAccount.opened, 0, "which is the number a run's own account reads");
  assert.equal(pump.pendingCount, 1, "it is still in its window - not consumed, not steered, not dropped");
  const ticket = outcome.kind === "not_owed" ? outcome.carry : undefined;
  assert.ok(
    ticket !== undefined && ticket.facts.length === 1,
    "and ticketed, so 'it did not vanish' is a field, not a hope",
  );

  // PENDING WORK IS A DELAY, NOT A SILENCE: the next turn that CAN be shown states the obstruction.
  pump.enqueueFact(timeMilestone(), FACT_PRODUCER.adapterIngress);
  await pump.flush({
    async deliver(batch) {
      batches.push(batch);
    },
  });
  assert.equal(batches.length, 1, "the clock mark opens the turn the refusal rides");
  assert.match(batches[0]?.text ?? "", /navigate_to_destination/u, "and the obstruction is stated in it");
  assert.match(batches[0]?.text ?? "", /native_path_ended/u, "with the Mod's own reason for it");
  assert.equal(pump.carriedInto(ticket!), batches[0]?.batchId, "and the ticket resolves to that batch");

  // THE PUMP'S HALF OF THE `#flushScheduled` CONTRACT, asserted rather than assumed.
  pump.enqueueFact(
    receipt("receipt_again", { state: "failed", actionId: "water_crop", reasonCode: "tool_not_held" }),
    FACT_PRODUCER.adapterIngress,
  );
  let steered: PendingBatch | undefined;
  assert.equal(
    await pump.steer({
      async deliver(batch) {
        steered = batch;
      },
    }),
    true,
    "`steer` hands over anything preempting that is waiting: it does not know whether a turn is running, and that guard " +
      "is `HostService.#flushScheduled`'s, not this pump's",
  );
  assert.deepEqual(receiptIdentities(steered), ["receipt_again"], "and the steer carries that fact alone");
  assert.equal(pump.pendingCount, 0, "the steer consumed exactly it");
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
  for (const fact of shapes) assert.equal(isStoppedPlanReceipt(fact), false, `${fact.kind} is not a receipt`);

  // And a receipt carrying a state the protocol does not declare is not a shape anything may read a classification from.
  const unknown = receipt("receipt_unknown", { state: "constructor" });
  assert.equal(isStoppedPlanReceipt(unknown), false, "a prototype key is not an execution state");
  const undeclared = receipt("receipt_undeclared", { state: "abandoned" });
  assert.equal(
    isStoppedPlanReceipt(undeclared),
    false,
    "an undeclared state opens a turn rather than being guessed at",
  );
  assert.equal(
    Object.hasOwn(STOPPED_PLAN_EXECUTION_STATES, "abandoned"),
    false,
    "the population is the protocol's own execution vocabulary, so `abandoned` is not classified here at all",
  );
});
/**
 * A receipt of a BODY-PROGRAMME NODE: the Mod's journal says which plan and which node the execution answered.
 *
 * The provenance is what separates "a node of her plan lost" from "an execution of no plan lost", and it is stated by
 * the receipt itself (`protocol.ts#ExecutionOrigin`), never inferred from the pump's ledger.
 */
function programmeReceipt(
  correlationId: string,
  payload: Readonly<Record<string, unknown>>,
  node: Readonly<{ programId: string; nodeId: string }>,
): WorldFact {
  return receipt(correlationId, { ...payload, origin: { kind: "programme", ...node } });
}

/** The node states in which nothing has STARTED, so `settled` below counts the rest as still to come. */
const NOT_STARTED_NODE_STATES: ReadonlySet<string> = new Set(["pending", "awaiting_host_admission"]);

/** The journal's reading of the plans still in flight, in the shape `readInFlightProgrammes` answers with. */
function planReading(
  ...programmes: readonly Readonly<{
    programId: string;
    nodes: readonly Readonly<{ nodeId: string; actionId?: string; state: string }>[];
    omitted?: number;
  }>[]
): InFlightProgrammeReading {
  const built: InFlightProgramme[] = programmes.map((programme) => {
    const omitted = programme.omitted ?? 0;
    const total = programme.nodes.length + omitted;
    const settled = programme.nodes.filter((node) => !NOT_STARTED_NODE_STATES.has(node.state)).length;
    return Object.freeze({
      programId: programme.programId,
      total,
      settled,
      remaining: total - settled,
      readAgeMs: 0,
      nodes: Object.freeze(
        programme.nodes.map((node, index) => Object.freeze({ index, ...node, observedInStateMs: 0 })),
      ),
      omitted,
      // No tile in these fixtures: the steer cases are about which turn opens, and a queued tile only subtracts rows.
      unsettledTiles: Object.freeze([]),
    });
  });
  return Object.freeze({ programmes: Object.freeze(built), omittedProgrammes: 0 });
}

/** A pump whose journal reading is the one the case states. */
const pumpWith = (reading: InFlightProgrammeReading): CompanionEventPump => new CompanionEventPump(() => reading);

/**
 * A plan's own settlement, as the Host mints it (`program-settlement-digest.ts`).
 *
 * A presentable `world_fact`, which is why it is the turn a carried node row rides: the digest exists so the plan's rows
 * reach her as ONE answer instead of one interruption per row.
 */
function settlementFact(programId: string): WorldFact {
  return {
    source: "host_game_session",
    kind: "world_fact",
    eventId: `settled_${programId}`,
    sourceEventId: `settled_${programId}`,
    correlationId: `settled_${programId}`,
    revision: 1,
    semanticKind: "program_settled",
    payload: { programId, summary: "settled: 1 rejected" },
  };
}

/**
 * THE GATE: one shape, one steer, per turn.
 *
 * <p>
 * THE POPULATION IS THE CLASSIFICATION'S OWN TABLE, not a list written here: the case table below is keyed BY REASON and
 * asserted set-equal to `PREEMPTION_REASONS`, so a reason added to the declaration fails this test by name until someone
 * says what it does - and `PREEMPTION_PREEMPTS` decides whether each one must steer or must be carried.
 * </p>
 * <p>
 * THE PROPERTY is about what the SINK actually received, not about the predicate: two facts of one shape inside one turn
 * must reach the sink once. That is the whole unit - `round77` measured 24 refused `plant_seed` nodes of two shapes
 * turning into 24 preemptions, and each preemption is a turn she answered with a line.
 * </p>
 * <p>
 * `carried-by-structure C` IS PRINTED BESIDE THE PREEMPTIONS because that number IS the trade: it is how much was left in
 * the settlement instead of interrupting a thought. A gate that printed only `repeats 0` would be green on a pump that
 * preempted everything and a pump that preempted nothing.
 * </p>
 */
test("a_preemption_is_not_a_repeat: no shape steers one turn twice", async () => {
  const plan = "plan_gate_1";
  const other = "plan_gate_2";
  /** One case per reason: two facts of ONE shape, then one of a second shape so a class is never measured by one member. */
  const cases: Readonly<
    Record<string, () => Readonly<{ facts: readonly WorldFact[]; reading: InFlightProgrammeReading }>>
  > = {
    // The plan repeats the action: both facts are the same shape and the second must not steer.
    [PREEMPTION.structural]: () => ({
      facts: [
        programmeReceipt(
          "gate_structural_1",
          { state: "rejected", actionId: "plant_seed", reasonCode: "seed_stale" },
          {
            programId: plan,
            nodeId: "n01",
          },
        ),
        programmeReceipt(
          "gate_structural_2",
          { state: "rejected", actionId: "plant_seed", reasonCode: "seed_stale" },
          {
            programId: plan,
            nodeId: "n02",
          },
        ),
        programmeReceipt(
          "gate_structural_3",
          { state: "rejected", actionId: "plant_seed", reasonCode: "seed_gone" },
          {
            programId: plan,
            nodeId: "n03",
          },
        ),
      ],
      reading: planReading({
        programId: plan,
        nodes: [
          { nodeId: "n04", actionId: "plant_seed", state: "pending" },
          { nodeId: "n05", actionId: "plant_seed", state: "pending" },
        ],
      }),
    }),
    [PREEMPTION.uncertain]: () => ({
      facts: [
        receipt("gate_uncertain_1", { state: "uncertain", actionId: "break_rock", reasonCode: "result_unobserved" }),
        receipt("gate_uncertain_2", { state: "uncertain", actionId: "break_rock", reasonCode: "result_unobserved" }),
        receipt("gate_uncertain_3", { state: "uncertain", actionId: "break_rock", reasonCode: "journal_lost" }),
      ],
      reading: planReading(),
    }),
    [PREEMPTION.modStall]: () => ({
      facts: [
        receipt("gate_stall_1", { state: "failed", actionId: "move_to_tile", reasonCode: "stalled_waiting" }),
        receipt("gate_stall_2", { state: "failed", actionId: "move_to_tile", reasonCode: "stalled_waiting" }),
        receipt("gate_stall_3", { state: "failed", actionId: "till_soil", reasonCode: "stalled_waiting" }),
      ],
      reading: planReading(),
    }),
    // No plan owns these executions, so no settlement will state them: the turn is the only reader they will ever get.
    [PREEMPTION.lone]: () => ({
      facts: [
        receipt("gate_lone_1", { state: "rejected", actionId: "water_crop", reasonCode: "tool_not_held" }),
        receipt("gate_lone_2", { state: "rejected", actionId: "water_crop", reasonCode: "tool_not_held" }),
        receipt("gate_lone_3", { state: "rejected", actionId: "water_crop", reasonCode: "can_out_of_water" }),
      ],
      reading: planReading(),
    }),
    // THE COMPARISON HAS TO BE ABLE TO SAY NO, and this is the case that proves it: the plan's remaining work is a
    // DIFFERENT action, so nothing of the plan repeats this refusal and the settlement is where it belongs.
    [PREEMPTION.nodeLost]: () => ({
      facts: [
        programmeReceipt(
          "gate_lost_1",
          { state: "rejected", actionId: "plant_seed", reasonCode: "seed_stale" },
          {
            programId: other,
            nodeId: "n01",
          },
        ),
        programmeReceipt(
          "gate_lost_2",
          { state: "rejected", actionId: "plant_seed", reasonCode: "seed_stale" },
          {
            programId: other,
            nodeId: "n02",
          },
        ),
        programmeReceipt(
          "gate_lost_3",
          { state: "rejected", actionId: "plant_seed", reasonCode: "seed_gone" },
          {
            programId: other,
            nodeId: "n03",
          },
        ),
      ],
      reading: planReading({
        programId: other,
        nodes: [
          { nodeId: "n04", actionId: "move_to_tile", state: "pending" },
          { nodeId: "n05", actionId: "harvest_crop", state: "pending" },
          { nodeId: "n06", actionId: "move_to_tile", state: "awaiting_host_admission" },
        ],
      }),
    }),
    // The body is held by something the Mod has NOT called a stall: busy is not news.
    [PREEMPTION.bodyBusy]: () => ({
      facts: [
        receipt("gate_busy_1", { state: "rejected", actionId: "plant_seed", reasonCode: "body_owned_by_movement" }),
        receipt("gate_busy_2", { state: "rejected", actionId: "plant_seed", reasonCode: "body_owned_by_movement" }),
        receipt("gate_busy_3", { state: "rejected", actionId: "plant_seed", reasonCode: "body_owned_by_ride" }),
      ],
      reading: planReading(),
    }),
    [PREEMPTION.notAPreemption]: () => ({
      facts: [
        receipt("gate_progress_1", { state: "succeeded", actionId: "plant_seed", reasonCode: "seed_planted" }),
        receipt("gate_progress_2", { state: "running", actionId: "plant_seed", reasonCode: "in_progress" }),
      ],
      reading: planReading(),
    }),
  };

  const failures: string[] = [];
  assert.deepEqual(
    Object.keys(cases).sort(),
    [...PREEMPTION_REASONS].sort(),
    "the gate's cases are keyed by the classification's own reasons: a new answer above needs a case here, and a case " +
      "whose reason left the table is a case nobody can reach",
  );

  const preempted: string[] = [];
  const examined: PreemptionReason[] = [];
  for (const reason of PREEMPTION_REASONS) {
    const { facts, reading } = cases[reason]!();
    const pump = pumpWith(reading);
    for (const fact of facts) {
      // Every fact is classified through the real predicate, so the case's stated reason cannot drift from the answer.
      const classified = preemptionOf(fact, reading.programmes);
      examined.push(classified);
      if (classified !== reason)
        failures.push(
          `${preemptionShapeOf(fact)}: the case says ${reason} while the pump's predicate says ${classified}`,
        );
      pump.enqueueFact(fact, FACT_PRODUCER.adapterIngress);
    }
    const batch = await steeredBatch(pump);
    const steered = receiptIdentities(batch);
    const expected = facts.filter((fact) => PREEMPTION_PREEMPTS[preemptionOf(fact, reading.programmes)]);
    const shapes = steered.map((id) => {
      const fact = facts.find((candidate) => candidate.correlationId === id)!;
      return preemptionShapeOf(fact);
    });
    preempted.push(...shapes);
    // ONE per shape, and the FIRST of each: the repeat is suppressed, the second shape is not.
    const expectedShapes = [...new Set(expected.map(preemptionShapeOf))];
    if (shapes.length !== expectedShapes.length || new Set(shapes).size !== shapes.length)
      failures.push(
        `${reason}: the steer carried ${shapes.length} of the ${expected.length} ${reason} facts ` +
          `{${shapes.join(", ")}} - expected one per shape {${expectedShapes.join(", ")}}`,
      );
    // AND NOTHING IS LEFT FOR A SECOND STEER: a repeat that were still steerable would fire on the next arrival.
    if ((await steeredBatch(pump)) !== undefined)
      failures.push(
        `${reason}: a second steer carried the repeats of ${reason}, which this turn has already been told`,
      );
  }

  const distinct = [...new Set(preempted)];
  const repeats = preempted.length - distinct.length;
  const count = (reason: PreemptionReason): number => examined.filter((entry) => entry === reason).length;
  process.stderr.write(
    `a_preemption_is_not_a_repeat: preemptions examined ${String(examined.length)} · ` +
      `distinct shapes ${String(distinct.length)} · structural ${String(count(PREEMPTION.structural))} · ` +
      `uncertain ${String(count(PREEMPTION.uncertain))} · mod-stall ${String(count(PREEMPTION.modStall))} · ` +
      `lone ${String(count(PREEMPTION.lone))} · carried-by-structure ${String(count(PREEMPTION.nodeLost))} · ` +
      `repeats ${String(repeats)}\n`,
  );
  assert.ok(examined.length > 0, "the population was empty, so this gate examined nothing");
  assert.deepEqual(
    failures,
    [],
    `one shape steers a turn once, and each reason is exercised for real:\n${failures.join("\n")}`,
  );
  assert.deepEqual(
    repeats,
    0,
    `a shape steered twice in one turn: ${preempted.filter((shape, index) => preempted.indexOf(shape) !== index).join(", ")}`,
  );
});

/**
 * The half of the gate that keeps "structural" from being a word for "always": the comparison must be able to say NO.
 *
 * <p>
 * A refused `plant_seed` node of a plan whose remaining work is a walk and a harvest repeats nothing - the plan carries
 * on, its settlement states the row, and a steer would buy a turn whose only content is work she already submitted.
 * </p>
 */
test("a_failure_the_plan_does_not_repeat_is_carried, not steered", async () => {
  const plan = "plan_no_repeat";
  const reading = planReading({
    programId: plan,
    nodes: [
      { nodeId: "n02", actionId: "move_to_tile", state: "pending" },
      { nodeId: "n03", actionId: "harvest_crop", state: "pending" },
    ],
  });
  const refused = programmeReceipt(
    "no_repeat_1",
    { state: "rejected", actionId: "plant_seed", reasonCode: "seed_not_owned_in_slot" },
    { programId: plan, nodeId: "n01" },
  );
  assert.equal(
    preemptionOf(refused, reading.programmes),
    PREEMPTION.nodeLost,
    "nothing the plan still has to run carries this shape",
  );

  const pump = pumpWith(reading);
  pump.enqueueFact(refused, FACT_PRODUCER.adapterIngress);
  assert.equal(pump.hasPreemptingFact, false, "so there is nothing to steer");
  assert.equal(
    await pump.steer({
      async deliver() {
        throw new Error("the plan's own row belongs in its settlement");
      },
    }),
    false,
  );
  // NOTHING WAS LOST: the refusal is still pending work, and the turn its plan opens carries it.
  assert.equal(pump.pendingCount, 1, "carried, not dropped");
  pump.enqueueFact(settlementFact(plan), FACT_PRODUCER.programSettlement);
  const batches: PendingBatch[] = [];
  await pump.flush({
    async deliver(batch) {
      batches.push(batch);
    },
  });
  assert.deepEqual(
    receiptIdentities(batches[0]),
    ["no_repeat_1"],
    "the refusal rides the plan's own settlement turn instead of interrupting the running one",
  );
});

/**
 * NOVELTY IS PER TURN, and that is the other half of the rule: a shape is a repeat only of what THIS turn has been told.
 *
 * A ledger that outlived the turn would silence a plan that is still failing ten minutes later - the failure to avoid is
 * a pump that never speaks again, which is why the count is per turn rather than per session.
 */
test("the next turn hears the same shape again", async () => {
  const plan = "plan_next_turn";
  const reading = planReading({
    programId: plan,
    nodes: [{ nodeId: "n09", actionId: "plant_seed", state: "pending" }],
  });
  const pump = pumpWith(reading);
  const refusal = (id: string) =>
    programmeReceipt(
      id,
      { state: "rejected", actionId: "plant_seed", reasonCode: "seed_not_owned_in_slot" },
      { programId: plan, nodeId: "n01" },
    );

  pump.enqueueFact(refusal("turn_1_a"), FACT_PRODUCER.adapterIngress);
  assert.deepEqual(receiptIdentities(await steeredBatch(pump)), ["turn_1_a"], "the first turn hears it");
  pump.enqueueFact(refusal("turn_1_b"), FACT_PRODUCER.adapterIngress);
  assert.equal(await steeredBatch(pump), undefined, "and does not hear the same shape twice");

  // A delivery is the turn boundary: the pump hands one batch over and the next turn has been told nothing.
  pump.enqueueFact(settlementFact(plan), FACT_PRODUCER.programSettlement);
  await pump.flush({
    async deliver() {
      return "completed";
    },
  });
  pump.enqueueFact(refusal("turn_2_a"), FACT_PRODUCER.adapterIngress);
  assert.deepEqual(
    receiptIdentities(await steeredBatch(pump)),
    ["turn_2_a"],
    "the new turn has been told nothing, so the same shape is news to it",
  );
});

/**
 * ROUND77'S 34 `plant_seed` REFUSALS, REPLAYED THROUGH THE PUMP - the falsifier.
 *
 * <p>
 * THE RECORD (`.live-runs/game-ladder/2026-11-19T04-46-54-502Z-multiday_routine/timeline.jsonl` and the same run's
 * `result.json#programOutcomes`): 40 planned plantings, 24 of which arrived as `rejected` receipts - 22
 * `seed_not_owned_in_slot` and 2 `seed_target_unavailable` - in three plan bursts, and 10 more rows the plan settled
 * itself as `skipped_dependency`. Every one of the 24 was a `programme` node receipt, so today's predicate made 24
 * preemptions out of 2 shapes.
 * </p>
 * <p>
 * THE BEFORE IS COMPUTED WITH THE BASE CLASS, not remembered: `isStoppedPlanReceipt` is what the pump steered on before
 * this unit, so `before` is the number of facts that predicate accepts. The after is what the sink received.
 * </p>
 * <p>
 * THE TEN SKIPPED ROWS ARE IN THE REPLAY because they are what makes the count 34, and they are not receipts: they are
 * the plan's own settlement, which preempts nothing and is the reason the node rows do not need to.
 * </p>
 */
test("round77_replay: 34 planting refusals, one preemption per shape", async () => {
  const bursts = [
    { programId: "plan_435_84cb0492f0383b6a", reasonCode: "seed_not_owned_in_slot", nodes: 4 },
    { programId: "plan_435_84cb0492f0383b6a", reasonCode: "seed_target_unavailable", nodes: 2 },
    { programId: "plan_455_84cb0492f0383b6a", reasonCode: "seed_not_owned_in_slot", nodes: 6 },
    { programId: "plan_619_0337c1d1e0a556ef", reasonCode: "seed_not_owned_in_slot", nodes: 12 },
  ] as const;
  /** The record's skipped rows, one per node the refused producers took with them. */
  const skippedRows = 10;
  /** What each plan still had to run when its burst began: every planting of that plan, in journal order. */
  const plannedPerProgramme = new Map<string, number>();
  for (const burst of bursts)
    plannedPerProgramme.set(burst.programId, (plannedPerProgramme.get(burst.programId) ?? 0) + burst.nodes);

  const pending = new Map(plannedPerProgramme);
  const reader = (): InFlightProgrammeReading =>
    planReading(
      ...[...pending.entries()].map(([programId, left]) => ({
        programId,
        nodes: Array.from({ length: left }, (_, index) => ({
          nodeId: `${programId}_n${String(index)}`,
          actionId: "plant_seed",
          state: "pending",
        })),
      })),
    );
  const pump = new CompanionEventPump(reader);

  const baseClass: WorldFact[] = [];
  const steered: string[] = [];
  for (const burst of bursts) {
    for (let attempt = 0; attempt < burst.nodes; attempt += 1) {
      const fact = programmeReceipt(
        `round77_${burst.programId}_${burst.reasonCode}_${String(attempt)}`,
        { state: "rejected", actionId: "plant_seed", reasonCode: burst.reasonCode },
        { programId: burst.programId, nodeId: `${burst.programId}_n${String(attempt)}` },
      );
      baseClass.push(fact);
      pump.enqueueFact(fact, FACT_PRODUCER.adapterIngress);
      // The node that just answered is one the plan no longer has to run: the reading is taken after it settled.
      pending.set(burst.programId, (pending.get(burst.programId) ?? 0) - 1);
      const batch = await steeredBatch(pump);
      steered.push(...receiptIdentities(batch));
    }
  }
  // And the rows the plan itself settled, which is the other 10 of the 34.
  const settlement: WorldFact = {
    source: "host_game_session",
    kind: "world_fact",
    eventId: "round77_settlement",
    sourceEventId: "round77_settlement",
    correlationId: "round77_settlement",
    revision: 1,
    semanticKind: "program_settled",
    payload: {
      programId: "plan_619_0337c1d1e0a556ef",
      summary: `settled: succeeded 6, failed 24, skipped_dependency ${String(skippedRows)}`,
    },
  };
  pump.enqueueFact(settlement, FACT_PRODUCER.adapterIngress);

  const before = baseClass.filter(isStoppedPlanReceipt).length;
  const shapes = [...new Set(baseClass.map(preemptionShapeOf))];
  process.stderr.write(
    `round77_replay: refusals ${String(before + skippedRows)} {receipts ${String(before)} · skipped rows ` +
      `${String(skippedRows)}} · preemptions before ${String(before)} · after ${String(steered.length)} ` +
      `{${steered.join(", ")}} · shapes ${String(shapes.length)} {${shapes.join(", ")}}\n`,
  );

  assert.equal(
    before,
    bursts.reduce((total, burst) => total + burst.nodes, 0),
    "the replay carries the record's 24 rejected receipts",
  );
  assert.equal(baseClass.length + skippedRows, 34, "and with the plan's own skipped rows, the record's 34 refusals");
  assert.ok(before > 1, "the before has to be the defect for the after to mean anything");
  assert.deepEqual(
    [...new Set(steered.map((id) => preemptionShapeOf(baseClass.find((fact) => fact.correlationId === id)!)))].sort(),
    [...shapes].sort(),
    `every shape steered, and no receipt steered twice: ${String(steered.length)} preemptions for ${String(shapes.length)} shapes`,
  );
  assert.equal(
    steered.length,
    shapes.length,
    `one preemption per shape, not one per node: ${String(before)} -> ${String(steered.length)}`,
  );
  // THE CARRIED ONES ARE NOT LOST: the refusals nobody steered are the ones the settlement's turn states.
  assert.equal(
    isStoppedPlanReceipt(settlement),
    false,
    "the plan's own settlement is not a receipt, so it neither steers nor counts as one",
  );
});
