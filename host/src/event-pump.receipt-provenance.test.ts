import assert from "node:assert/strict";
import test from "node:test";

import {
  CompanionEventPump,
  FACT_PRODUCER,
  FACT_TURN_CONSEQUENCE,
  factTurnConsequence,
  MAX_NAMED_UNATTRIBUTED_EXECUTIONS,
  type PendingBatch,
  TURN_OPENING,
  TURN_SUPPRESSION,
  turnAccountLine,
  type WorldFact,
} from "./event-pump.js";
import { createProgramProgressObserver } from "./program-status-wait.js";
import { EXECUTION_STATES, newEnvelope, type Scope, validateBridgeMessage } from "./protocol.js";

/**
 * `receipt_without_its_programme:<execution>:<kind>` - a receipt was filed by something other than the programme its
 * own execution belongs to.
 *
 * <p>
 * THE DEFECT THIS EXISTS FOR, measured three times in a row. `execution_receipt` carries an `executionId` and nothing
 * about the programme or node the execution belongs to (`protocol.ts`, `ExecutionReceipt`), so the Host has to guess what
 * a receipt IS. It guessed with "is anything named right now" (`event-pump.ts#programmeNamed`), and when that guess was
 * wrong the turn account said so and nothing else: `round57` `turns opened 66 {adapter_ingress: 57}`, `round59` `88
 * {adapter_ingress: 79}`, `round62` `82 {adapter_ingress: 82}` against 224 programme dispatches. Each fix moved the
 * guess; `SETTLING_GRACE_MS` (commit `14d8afbb`) made it a TEN-SECOND WINDOW and said so in its own comment - "inside it
 * a `succeeded` receipt is filed as a step even if its programme was not the one that stopped". Time standing in for
 * causality is the defect, not the fix.
 * </p>
 *
 * <p>
 * THE PROPERTY, AND WHY IT IS THIS ONE. The Mod's journal already knows which programme node every execution belongs to
 * (`integrations/stardew/src/Core/BodyPrograms/BodyProgramModels.cs#NodeExecutionBinding`), so the fact can SAY it. Once
 * it does, the pump's filing is a function of the fact alone: no ledger reading, no clock, no window. This gate drives
 * every receipt state over five ledger readings and two clocks and requires one answer - so a filing that moves with a
 * timer, or with which OTHER programme happens to be in flight, is red by name.
 * </p>
 *
 * <p>
 * THE POPULATION IS EVERY RECEIPT THE MOD EMITS, which is `EXECUTION_STATES` (the protocol's own list, and the list
 * `validateReceipt` refuses a state outside of) cross the provenance members the wire declares. It was wider until the
 * Mod stopped publishing a semantic restatement of a finished step (`IN_FLIGHT_SEMANTIC_PROGRESS_KINDS`, removed with
 * its emitters): a class nothing can emit is a gate agreeing with itself, and no `semantic:` shape a programme's step
 * could arrive as is classified any more - a kind the pump does not declare takes the `decision` default, so the loss of
 * that table can only cost a turn, never a fact.
 * </p>
 *
 * {@link receiptWithoutItsProgrammeGate} is a function of recorded readings rather than of the pump, so the falsifier can
 * hand it the reading the tree actually produced - the direction that matters, because a gate that can only be turned red
 * by breaking the code it just wrote proves nothing about the defect it was written for.
 */

/** How the Mod's journal says one execution is owned. The object the wire carries and the pump reads. */
export type WireOrigin = Readonly<{ kind: string; programId?: string; nodeId?: string }>;

/** The programme the execution under test belongs to. */
const PROGRAMME: WireOrigin = Object.freeze({ kind: "programme", programId: "plan_cauli", nodeId: "n002" });
/** A programme that is NOT the one the execution under test belongs to, for the "filed as somebody else's step" case. */
const OTHER_PROGRAMME = "plan_wood";
const STANDALONE: WireOrigin = Object.freeze({ kind: "standalone" });
const UNATTRIBUTED: WireOrigin = Object.freeze({ kind: "unattributed" });

/** The provenance members the wire declares, derived from them rather than listed at the drive. */
function provenancePopulation(): readonly WireOrigin[] {
  return [PROGRAMME, STANDALONE, UNATTRIBUTED];
}

function receiptFact(state: string, executionId: string, origin: WireOrigin | undefined): WorldFact {
  return {
    source: "stardew_mod",
    kind: "execution_receipt",
    correlationId: executionId,
    executionId,
    requestId: `request_${executionId}`,
    revision: 3,
    payload: {
      actionId: "harvest_crop",
      state,
      reasonCode: `reason_${state}`,
      revision: 3,
      ...(origin === undefined ? {} : { origin }),
    },
  };
}

/** One fact the gate files, and the shape the classification answers for it. */
type ReceiptCase = Readonly<{ shape: string; executionId: string; fact: WorldFact; origin: WireOrigin | undefined }>;

/**
 * Every receipt the Mod emits, cross every provenance it can carry.
 *
 * A fact with NO provenance at all is examined too: today the wire lets one through, and the pump then guesses. After the
 * change `validateReceipt` refuses it at the bridge, so this member asserts the protocol half of the same property.
 */
function receiptPopulation(): readonly ReceiptCase[] {
  const cases: ReceiptCase[] = [];
  for (const state of EXECUTION_STATES)
    for (const origin of [...provenancePopulation(), undefined])
      cases.push(
        Object.freeze({
          shape: `receipt:${state}`,
          executionId: `exec_${state}_${origin?.kind ?? "unstated"}`,
          fact: receiptFact(state, `exec_${state}_${origin?.kind ?? "unstated"}`, origin),
          origin,
        }),
      );
  return cases;
}

// ---------------------------------------------------------------------------------------------------------------
// The ledgers: what the pump could guess from, if it were still guessing.
// ---------------------------------------------------------------------------------------------------------------

const BASE_MS = 1_700_000_000_000;

/**
 * The Mod's own progress ledger, read at `nowMs`, after the journal reported what it reported.
 *
 * The REAL observer (`createProgramProgressObserver`), not a literal reading: the guess this gate is about reads the
 * ledger's lifetime, so a fixture that stated the reading itself could not have produced the defect.
 */
function ledgerReading(programme: string | null, settledAgoMs: number | null, nowMs: number) {
  const observer = createProgramProgressObserver();
  if (programme === null) return observer.inFlight(nowMs);
  const status = (state: string) => ({
    code: "found",
    snapshot: {
      programId: programme,
      state,
      catalogRevision: 3,
      stopEpoch: 0,
      eventHighWater: 90,
      nodes: [
        { nodeId: "n001", state: "succeeded", nodeAttempt: 1, admissionAttempt: 1, actionId: "harvest_crop" },
        {
          nodeId: "n002",
          state: state === "active" ? "running" : "succeeded",
          nodeAttempt: 1,
          admissionAttempt: 1,
          actionId: "harvest_crop",
        },
      ],
    },
  });
  observer.observe(status("active"), nowMs - 30_000);
  if (settledAgoMs !== null) observer.observe(status("succeeded"), nowMs - settledAgoMs);
  return observer.inFlight(nowMs);
}

/** The five readings one receipt is filed against. The pump's answer must not depend on which one it gets. */
const LEDGERS = Object.freeze({
  /** Nothing named: no programme was ever read. */
  nothing: (nowMs: number) => () => ledgerReading(null, null, nowMs),
  /** The programme the receipt belongs to is running. */
  itsProgrammeRunning: (nowMs: number) => () => ledgerReading(PROGRAMME.programId ?? "", null, nowMs),
  /** ANOTHER programme is the one in flight - the case the window's own comment names. */
  anotherProgrammeRunning: (nowMs: number) => () => ledgerReading(OTHER_PROGRAMME, null, nowMs),
  /** Its programme stopped a moment ago: the tail receipt of `round62`, inside any plausible window. */
  itsProgrammeJustStopped: (nowMs: number) => () => ledgerReading(PROGRAMME.programId ?? "", 2_000, nowMs),
  /** ...and long enough ago that a window would have closed. */
  itsProgrammeStoppedLongAgo: (nowMs: number) => () => ledgerReading(PROGRAMME.programId ?? "", 120_000, nowMs),
});

type LedgerName = keyof typeof LEDGERS;
const LEDGER_NAMES = Object.freeze(Object.keys(LEDGERS) as LedgerName[]);

/** What one drive of the pump did with one fact. */
type Filing = Readonly<{ opened: number; reason: string | undefined }>;

/** A ledger that has named nothing at all: the reading a session's first action arrives against. */
const NOTHING_NAMED = () => ledgerReading(null, null, BASE_MS);

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

async function filingOf(fact: WorldFact, ledger: () => ReturnType<typeof ledgerReading>): Promise<Filing> {
  const pump = new CompanionEventPump(ledger);
  pump.enqueueFact(fact, FACT_PRODUCER.adapterIngress);
  await pump.flush({
    async deliver() {
      return undefined;
    },
  });
  return Object.freeze({ opened: pump.turnAccount.opened, reason: pump.turnAccount.lastDecision?.reason });
}

/** One receipt, filed against every ledger, at two instants a window's width apart. */
type CaseReadings = Readonly<{
  shape: string;
  executionId: string;
  origin: WireOrigin | undefined;
  /** The pump's classification of the shape: the consequence the fact owes her when nothing else speaks. */
  consequence: string | undefined;
  filings: Readonly<Record<LedgerName, Filing>>;
}>;

async function readEveryCase(): Promise<readonly CaseReadings[]> {
  const readings: CaseReadings[] = [];
  for (const entry of receiptPopulation()) {
    const filings = {} as Record<LedgerName, Filing>;
    for (const ledger of LEDGER_NAMES) filings[ledger] = await filingOf(entry.fact, LEDGERS[ledger](BASE_MS));
    readings.push(
      Object.freeze({
        shape: entry.shape,
        executionId: entry.executionId,
        origin: entry.origin,
        consequence: FACT_TURN_CONSEQUENCE[entry.shape],
        filings: Object.freeze(filings),
      }),
    );
  }
  return readings;
}

// ---------------------------------------------------------------------------------------------------------------
// The verdict.
// ---------------------------------------------------------------------------------------------------------------

/**
 * What the origin says the filing must be, or `undefined` when the fact does not state a cause the wire can carry.
 *
 * Derived from the classification, so a state added to `EXECUTION_STATES` is judged by the same three lines rather than
 * by a fourth hand-written rule.
 */
function expectedFiling(reading: CaseReadings): Readonly<{ opened: number; reason: string }> | undefined {
  if (reading.consequence === "decision") return Object.freeze({ opened: 1, reason: TURN_OPENING.worldFact });
  if (reading.consequence === "progress") return Object.freeze({ opened: 0, reason: TURN_SUPPRESSION.progress });
  if (reading.consequence !== "in_flight_progress") return undefined;
  // The step's own provenance decides: a programme's step is progress whatever else is running, and a lone outcome is
  // news because nothing else will ever state it.
  if (reading.origin?.kind === "programme")
    return Object.freeze({ opened: 0, reason: TURN_SUPPRESSION.inFlightProgress });
  return Object.freeze({ opened: 1, reason: TURN_OPENING.worldFact });
}

export type ProvenanceGate = Readonly<{
  receiptsExamined: number;
  carryAProgramme: number;
  standalone: number;
  /** Receipts filed differently at the two instants: TIME standing in for causality. Must be 0. */
  filedByTime: number;
  /** Receipts filed differently depending on which programme was in flight. Must be 0. */
  filedByAnotherProgrammesFlight: number;
  violations: readonly string[];
  blocked: string | null;
}>;

/**
 * The verdict over the readings, with zero population BLOCKED rather than green.
 *
 * Four defects, four tokens, because they are fixed by different layers: a receipt whose own programme was not honoured
 * (`receipt_without_its_programme`), a lone outcome the change silenced (`standalone_outcome_swallowed`), a filing that
 * moved with the clock (`receipt_filed_by_time`), and one that moved with somebody else's flight
 * (`receipt_filed_as_another_programmes_step`).
 */
export function receiptWithoutItsProgrammeGate(readings: readonly CaseReadings[]): ProvenanceGate {
  if (readings.length === 0)
    return Object.freeze({
      receiptsExamined: 0,
      carryAProgramme: 0,
      standalone: 0,
      filedByTime: 0,
      filedByAnotherProgrammesFlight: 0,
      violations: Object.freeze([]),
      blocked: "zero_population:no_receipt_was_examined",
    });
  const violations: string[] = [];
  let carryAProgramme = 0;
  let standalone = 0;
  let filedByTime = 0;
  let filedByAnotherProgrammesFlight = 0;
  for (const reading of readings) {
    const expected = expectedFiling(reading);
    const shape = `${reading.executionId}:${reading.shape}`;
    if (reading.origin?.kind === "programme") carryAProgramme += 1;
    if (reading.origin?.kind === "standalone") standalone += 1;
    if (expected === undefined) {
      // A shape the classification does not state a consequence for is a defect of the table, not of this gate.
      violations.push(`unclassified_receipt_shape:${shape}`);
      continue;
    }
    for (const ledger of LEDGER_NAMES) {
      const filing = reading.filings[ledger];
      if (filing.opened !== expected.opened || filing.reason !== expected.reason)
        violations.push(
          `${RECEIPT_WITHOUT_ITS_PROGRAMME}:${shape}:${ledger}:${String(filing.opened)}:${String(filing.reason)}`,
        );
    }
    // The step's own provenance, in the two directions the window got wrong. A receipt whose execution belongs to a
    // programme must be filed as that programme's step even while ANOTHER programme is the one in flight, and a lone
    // outcome must still speak while a programme is in flight - silencing it hides the only fact that says it happened.
    const inFlightProgress = reading.consequence === "in_flight_progress";
    if (inFlightProgress && reading.origin?.kind !== "programme" && reading.filings.nothing.opened === 0)
      violations.push(`standalone_outcome_swallowed:${shape}:${String(reading.filings.nothing.reason)}`);
    // TIME: the same fact, the same ledger, one window apart.
    if (
      reading.filings.itsProgrammeJustStopped.opened !== reading.filings.itsProgrammeStoppedLongAgo.opened ||
      reading.filings.itsProgrammeJustStopped.reason !== reading.filings.itsProgrammeStoppedLongAgo.reason
    ) {
      filedByTime += 1;
      violations.push(
        `receipt_filed_by_time:${shape}:${String(reading.filings.itsProgrammeJustStopped.reason)}->${String(reading.filings.itsProgrammeStoppedLongAgo.reason)}`,
      );
    }
    // SOMEBODY ELSE'S FLIGHT: the same fact, and only the identity of what is in flight differs.
    if (
      reading.filings.nothing.opened !== reading.filings.anotherProgrammeRunning.opened ||
      reading.filings.nothing.reason !== reading.filings.anotherProgrammeRunning.reason
    ) {
      filedByAnotherProgrammesFlight += 1;
      violations.push(
        `receipt_filed_as_another_programmes_step:${shape}:${String(reading.filings.nothing.reason)}->${String(reading.filings.anotherProgrammeRunning.reason)}`,
      );
    }
  }
  return Object.freeze({
    receiptsExamined: readings.length,
    carryAProgramme,
    standalone,
    filedByTime,
    filedByAnotherProgrammesFlight,
    violations: Object.freeze(violations),
    blocked: null,
  });
}

const RECEIPT_WITHOUT_ITS_PROGRAMME = "receipt_without_its_programme";

// ---------------------------------------------------------------------------------------------------------------
// The protocol half: a receipt with no provenance never reaches the pump.
// ---------------------------------------------------------------------------------------------------------------

const scope: Scope = {
  integrationId: "stardew",
  saveId: "save_01",
  worldId: "world_01",
  playerId: "player_01",
  companionId: "companion_01",
};
const nowMs = BASE_MS;

function receiptEnvelope(payload: Readonly<Record<string, unknown>>): unknown {
  return newEnvelope("execution_receipt", scope, payload, "receipt_provenance_01", nowMs);
}

function baseReceiptPayload(): Record<string, unknown> {
  return {
    executionId: "execution_01",
    requestId: "request_01",
    actionId: "harvest_crop",
    state: "succeeded",
    reasonCode: "crop_harvested",
    revision: 5,
    evidence: { detail: "tile=60,10" },
  };
}

/**
 * `receipt_without_its_programme:<execution>:<kind>` over the WIRE: the bridge refuses a receipt that does not say whose
 * execution it is, so the pump is never handed one it would have to guess about.
 *
 * The population is every provenance the wire declares: each must round-trip, and the malformed shapes must be refused by
 * name. Today `validateReceipt` has no `origin` key at all, so a receipt arrives with nothing and the guess is the only
 * option left - which is the first assertion below, failing.
 */
test("receipt_without_its_programme: a receipt states its own programme, and the wire refuses one that does not", () => {
  // RED ON THE TREE BEFORE THIS CHANGE, and the first assertion is the one that was red: a receipt with NO provenance was
  // a well-formed receipt, so every Host decision about it was a guess. It is now refused at the bridge, which is what
  // makes `factExecutionOrigin` a reading rather than a nullable field somebody might resolve by time.
  assert.equal(
    validateBridgeMessage(receiptEnvelope(baseReceiptPayload()), scope, nowMs),
    "invalid_receipt",
    "a receipt that does not say whose execution it is must not cross the bridge at all",
  );
  assert.equal(
    validateBridgeMessage(
      receiptEnvelope({
        ...baseReceiptPayload(),
        origin: { kind: "programme", programId: "plan_cauli", nodeId: "n002" },
      }),
      scope,
      nowMs,
    ),
    null,
    "a receipt that names its programme node is a well-formed receipt",
  );
  assert.equal(
    validateBridgeMessage(receiptEnvelope({ ...baseReceiptPayload(), origin: { kind: "standalone" } }), scope, nowMs),
    null,
    "and so is one that says it has no programme: standalone is stated, not inferred from an absence",
  );
  assert.equal(
    validateBridgeMessage(receiptEnvelope({ ...baseReceiptPayload(), origin: { kind: "unattributed" } }), scope, nowMs),
    null,
    "nor is a journal that cannot answer a malformed frame: that defect is named, not rejected into silence",
  );
  // Malformed provenance is refused, one case per way a tagged union can be wrong.
  for (const [label, origin] of [
    ["programme_without_node", { kind: "programme", programId: "plan_cauli" }],
    ["programme_without_programme", { kind: "programme", nodeId: "n002" }],
    ["standalone_carrying_a_name", { kind: "standalone", programId: "plan_cauli", nodeId: "n002" }],
    ["unattributed_carrying_a_name", { kind: "unattributed", programId: "plan_cauli" }],
    ["unknown_kind", { kind: "programme_maybe" }],
    ["not_an_object", "standalone"],
  ] as const)
    assert.equal(
      validateBridgeMessage(receiptEnvelope({ ...baseReceiptPayload(), origin }), scope, nowMs),
      "invalid_receipt",
      `an origin that is ${label} must be refused by name, not resolved by the reader`,
    );
});

// ---------------------------------------------------------------------------------------------------------------
// The gate, and its two directions.
// ---------------------------------------------------------------------------------------------------------------

test("receipt_without_its_programme: no receipt is filed by the clock or by somebody else's flight", async () => {
  const gate = receiptWithoutItsProgrammeGate(await readEveryCase());

  assert.equal(gate.blocked, null, `the gate measured nothing: ${String(gate.blocked)}`);
  assert.ok(gate.receiptsExamined > 0, "zero population is blocked, never green");
  // Printed because "0 violations" over an unstated population agrees with itself, and because these four numbers are
  // the reading a run's log cannot give: how many receipts carry a cause at all.
  console.log(
    `receipt_without_its_programme: receipts examined ${String(gate.receiptsExamined)} · carry a programme ${String(gate.carryAProgramme)} · standalone ${String(gate.standalone)} · filed by time ${String(gate.filedByTime)} · filed by another programme's flight ${String(gate.filedByAnotherProgrammesFlight)}`,
  );
  assert.equal(gate.filedByTime, 0, "a receipt filed differently one window later is a receipt filed by time");
  assert.equal(
    gate.filedByAnotherProgrammesFlight,
    0,
    "a receipt filed differently because a different programme was in flight is a receipt filed by a guess",
  );
  assert.deepEqual(gate.violations, [], "every receipt is filed by its own execution's provenance and nothing else");
});

test("receipt_without_its_programme: the gate is red on the ordering the tree produced before the field existed", () => {
  // THE FALSIFIER, in the direction that matters: the readings the CURRENT tree produces. The same `succeeded` receipt,
  // the same execution, and the only difference between the two drives is how long ago the journal reported its
  // programme stopped - 2 s and 120 s. A window makes those two answers disagree, and that disagreement IS the defect.
  const recorded = receiptWithoutItsProgrammeGate([
    {
      shape: "receipt:succeeded",
      executionId: "exec_round62_tail",
      origin: PROGRAMME,
      consequence: FACT_TURN_CONSEQUENCE["receipt:succeeded"],
      filings: {
        nothing: { opened: 1, reason: TURN_OPENING.worldFact },
        itsProgrammeRunning: { opened: 0, reason: TURN_SUPPRESSION.inFlightProgress },
        anotherProgrammeRunning: { opened: 0, reason: TURN_SUPPRESSION.inFlightProgress },
        itsProgrammeJustStopped: { opened: 0, reason: TURN_SUPPRESSION.inFlightProgress },
        itsProgrammeStoppedLongAgo: { opened: 1, reason: TURN_OPENING.worldFact },
      },
    },
  ]);

  assert.equal(recorded.filedByTime, 1, "one receipt filed by the clock is one too many");
  assert.equal(
    recorded.filedByAnotherProgrammesFlight,
    1,
    "and one filed by another programme's flight is one too many",
  );
  assert.ok(
    recorded.violations.includes(
      `receipt_filed_by_time:exec_round62_tail:receipt:succeeded:${TURN_SUPPRESSION.inFlightProgress}->${TURN_OPENING.worldFact}`,
    ),
    `the violation must name the execution and the shape, got ${JSON.stringify(recorded.violations)}`,
  );
  assert.ok(
    recorded.violations.includes(
      `${RECEIPT_WITHOUT_ITS_PROGRAMME}:exec_round62_tail:receipt:succeeded:nothing:1:${TURN_OPENING.worldFact}`,
    ),
    "and it must name the drive it fired on, or the next reader is told 'expected true, got false'",
  );
});

test("receipt_without_its_programme: a lone outcome silenced while a programme runs is red too", () => {
  // The other direction, which "fewer turns" alone can never detect: an execution no programme owns is the only fact that
  // will ever say it happened, so it must open its turn whatever else is in flight.
  const swallowed = receiptWithoutItsProgrammeGate([
    {
      shape: "receipt:partially_succeeded",
      executionId: "exec_lone_action",
      origin: STANDALONE,
      consequence: FACT_TURN_CONSEQUENCE["receipt:partially_succeeded"],
      filings: {
        nothing: { opened: 0, reason: TURN_SUPPRESSION.inFlightProgress },
        itsProgrammeRunning: { opened: 0, reason: TURN_SUPPRESSION.inFlightProgress },
        anotherProgrammeRunning: { opened: 0, reason: TURN_SUPPRESSION.inFlightProgress },
        itsProgrammeJustStopped: { opened: 0, reason: TURN_SUPPRESSION.inFlightProgress },
        itsProgrammeStoppedLongAgo: { opened: 0, reason: TURN_SUPPRESSION.inFlightProgress },
      },
    },
  ]);
  assert.ok(
    swallowed.violations.includes(
      `standalone_outcome_swallowed:exec_lone_action:receipt:partially_succeeded:${TURN_SUPPRESSION.inFlightProgress}`,
    ),
    `a lone outcome that never spoke must be named, got ${JSON.stringify(swallowed.violations)}`,
  );
  assert.equal(swallowed.standalone, 1, "and the printed population must count the standalone receipt it examined");
});

test("receipt_without_its_programme: zero population is blocked, never green", () => {
  const empty = receiptWithoutItsProgrammeGate([]);
  assert.equal(empty.blocked, "zero_population:no_receipt_was_examined");
  assert.deepEqual(empty.violations, []);
  assert.equal(empty.receiptsExamined, 0);
  assert.equal(empty.filedByTime, 0);
});

/**
 * `unattributed_execution:<id>`: the Mod's journal could not say which programme owns an execution.
 *
 * <p>
 * THE RULE THIS PINS IS THE ONE THE WHOLE CHANGE RESTS ON: an unattributed execution is a NAMED DEFECT, not a null the
 * Host resolves for itself. It still owes its turn - the fact is a real outcome and erring toward a turn cannot lose one
 * - and the account says so, in the one line a run's log already carries.
 * </p>
 */
test("unattributed_execution: an execution the journal could not attribute is named, counted, and still owes its turn", async () => {
  const pump = new CompanionEventPump(NOTHING_NAMED);
  pump.enqueueFact(receiptFact("succeeded", "exec_unattributed", UNATTRIBUTED), FACT_PRODUCER.adapterIngress);
  const turns = recorder();
  await pump.flush(turns.sink);

  assert.equal(
    pump.turnAccount.opened,
    1,
    "an execution nobody can attribute is still an outcome she has not been told",
  );
  assert.equal(pump.turnAccount.executionProvenance.facts.unattributed, 1, "and the account counts the defect");
  assert.deepEqual(pump.turnAccount.executionProvenance.unattributedExecutions, ["exec_unattributed"], "and names it");
  assert.match(
    turnAccountLine(pump.turnAccount),
    /unattributed_execution 1 \{exec_unattributed\}/u,
    "the token reaches the line a reader greps, or the defect is invisible in every artifact the run produced",
  );
});

test("unattributed_execution: the named list is bounded and DRAINED, and the total still closes", async () => {
  // A stuck journal produces one unattributed execution per action, so a list that grew with the session would be a leak.
  // The bound must not lie about the total, which is why `omitted` is its own counter rather than a shorter list.
  const pump = new CompanionEventPump(NOTHING_NAMED);
  for (let index = 0; index < MAX_NAMED_UNATTRIBUTED_EXECUTIONS + 3; index += 1) {
    pump.enqueueFact(
      receiptFact("succeeded", `exec_unattributed_${String(index)}`, UNATTRIBUTED),
      FACT_PRODUCER.adapterIngress,
    );
    await pump.flush(recorder().sink);
  }
  const provenance = pump.turnAccount.executionProvenance;
  assert.equal(provenance.facts.unattributed, MAX_NAMED_UNATTRIBUTED_EXECUTIONS + 3, "every fact is counted");
  assert.equal(
    provenance.unattributedExecutions.length,
    MAX_NAMED_UNATTRIBUTED_EXECUTIONS,
    "and only the bound is named",
  );
  assert.equal(provenance.omittedUnattributed, 3, "the rest is counted, not dropped");
});

test("receipt_without_its_programme: a receipt that states NOTHING is filed as an outcome, and counted as unstated", async () => {
  // The shape the wire now refuses. A pump handed one anyway - an old adapter, a fixture, a frame that skipped validation
  // - must not read the absence as "a programme's step": that reading is exactly the guess this field replaced.
  const pump = new CompanionEventPump(NOTHING_NAMED);
  pump.enqueueFact(receiptFact("succeeded", "exec_unstated", undefined), FACT_PRODUCER.adapterIngress);
  await pump.flush(recorder().sink);

  assert.equal(
    pump.turnAccount.opened,
    1,
    "a receipt with no provenance owes a turn: erring toward a turn cannot lose an outcome",
  );
  assert.equal(
    pump.turnAccount.executionProvenance.facts.unstated,
    1,
    "and the absence is counted rather than assumed",
  );
  assert.equal(pump.turnAccount.executionProvenance.facts.programme, 0, "nothing was invented for it");
});

test("receipt_without_its_programme: the population is every receipt state the protocol declares, cross every provenance", () => {
  const population = receiptPopulation();
  assert.ok(population.length > 0, "an empty population proves nothing");
  assert.deepEqual(
    [...new Set(population.map((entry) => entry.shape))].filter((shape) => !shape.startsWith("receipt:")),
    [],
    "the population is RECEIPTS, and only receipts: the Mod publishes no other statement of a step since the body-trace cut, and a kind nothing can emit would be a gate agreeing with itself. A step stated a second way is judged by the same reading the moment it is classified (`FACT_TURN_CONSEQUENCE`), so widening this population means adding the shape here and the consequence there",
  );
  assert.deepEqual(
    EXECUTION_STATES.filter((state) => !population.some((entry) => entry.shape === `receipt:${state}`)),
    [],
    "every state the protocol declares for a receipt is examined, so one added later cannot go unfiled",
  );
  assert.deepEqual(
    population.filter((entry) => entry.origin === undefined).length > 0,
    true,
    "a receipt with no provenance is in the population: that is the frame the wire must refuse",
  );
  // The classification must have an answer for every shape examined: a shape it does not state is a defect of the table.
  assert.deepEqual(
    [...new Set(population.map((entry) => entry.shape))].filter((shape) => FACT_TURN_CONSEQUENCE[shape] === undefined),
    [],
    "and every examined shape is one the classification states a consequence for",
  );
  assert.equal(
    factTurnConsequence(population[0]!.fact) === "decision" || factTurnConsequence(population[0]!.fact) === "progress",
    true,
    "the drive files real facts through the real classifier, not payloads it wrote itself",
  );
});
