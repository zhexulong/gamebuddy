import assert from "node:assert/strict";
import test from "node:test";
import {
  CompanionEventPump,
  FACT_PRODUCER,
  HOST_MINTED_FACT_SOURCE,
  NARRATION_WITHOUT_WORK_SEMANTIC_KIND,
  NOT_OWED,
  type PendingBatch,
  TURN_OPENING,
  TURN_OPENINGS,
  type TurnOpening,
  WAKE_RULE,
  WAKE_RULES,
  type WakeRule,
  type WorldFact,
} from "./event-pump.js";
import type { InFlightProgramme, InFlightProgrammeReading } from "./program-status-wait.js";

/**
 * `a_wake_rule_that_cannot_open_a_turn:<rule>` - every wake rule has a bell, and the one that did not is the reason.
 *
 * <p>
 * THE DEFECT THIS EXISTS FOR, measured on a whole run rather than argued: `round84` (2026-11-20, 34 minutes) printed
 * `turns opened 82 {player_input 7, world_fact 74 {adapter_ingress 26, companion_arrival 1, program_settlement 47}}`, and
 * the low-water rule the pump had carried since `8e8e625f` - "wake her when her plan is down to its last two nodes" - opened
 * **none** of them. It could not: `#opensTurn` asks the SURFACE question first (`#canPresent`), a node's `execution_receipt`
 * carries no presentation lease, and `watchProgramSettlement` synthesizes `program_settled` only once every node is terminal.
 * The rule was a filter on a fact that is never offered to it, and the round that tuned its unit measured a rule that never
 * ran.
 * </p>
 * <p>
 * SO THE TEST IS ABOUT REACHABILITY, NOT ABOUT THE THRESHOLD. `WAKE_RULES` is the pump's own declaration of the wakes it
 * has, and this file must supply a carrier fact and the opener it must produce FOR EVERY MEMBER - typed as a
 * `Record<WakeRule, …>`, so a wake rule added to the pump does not compile until its bell is named. Each carrier is then
 * driven through a real pump twice: once with nothing in flight, where it must open a turn, and once behind a plan that is
 * still working, where it must still reach the decision - by opening, or by being refused for the PLAN and not for a surface
 * or a progress reason, which is the difference between "it waited" and "it never arrived".
 * </p>
 * <p>
 * AND THE FALSIFIER IS THE REAL HISTORY: the fact kind the retired rule needed - a node's receipt, arriving while her plan
 * still had nodes - is driven here too, and it is answered `progress`/`no_surface_for` with no turn at all. That is the
 * assertion the 34-minute run would have made in a millisecond.
 * </p>
 */

/** A plan with nodes left: the journal's own reading while a programme is in flight. */
const RUNNING: InFlightProgrammeReading = Object.freeze({
  programmes: Object.freeze([
    {
      programId: "plan_wake_reachability",
      total: 3,
      settled: 0,
      remaining: 3,
      readAgeMs: 400,
      nodes: [],
      omitted: 0,
      unsettledTiles: [],
    } satisfies InFlightProgramme,
  ]),
  omittedProgrammes: 0,
});

const ANSWERED: InFlightProgrammeReading = Object.freeze({ programmes: Object.freeze([]), omittedProgrammes: 0 });

/** A clock mark: presentable (`time_milestone` is on the lease list), so it is a fact that can open a turn. */
function milestoneFact(): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    kind: "world_fact" as const,
    eventId: "time_milestone_600",
    sourceEventId: "time_milestone_600",
    correlationId: "time_milestone_600",
    revision: 600,
    occurredAtMs: 600,
    semanticKind: "time_milestone",
    payload: { milestone: 600 } as never,
  });
}

/** A Host-minted wake (`PUMP_MINTED_WAKE_KINDS`): the look itself is the product, so it never waits for a fact. */
function dueWakeFact(): WorldFact {
  return Object.freeze({
    source: HOST_MINTED_FACT_SOURCE,
    kind: "world_fact" as const,
    eventId: "narration_without_work_3",
    sourceEventId: "narration_without_work_3",
    correlationId: "narration_without_work_3",
    revision: 3,
    occurredAtMs: 3,
    semanticKind: NARRATION_WITHOUT_WORK_SEMANTIC_KIND,
    payload: { kind: NARRATION_WITHOUT_WORK_SEMANTIC_KIND, turns: 3 } as never,
  });
}

/** The world saying it will not move until it is answered: unpresentable, and it opens a turn all the same. */
function heldWorldFact(): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    kind: "world_fact" as const,
    eventId: "modal_presented_1",
    sourceEventId: "modal_presented_1",
    correlationId: "modal_presented_1",
    revision: 9,
    occurredAtMs: 9,
    semanticKind: "modal_presented",
    payload: { isQuestion: true, blocksTimePass: true, responseKeys: ["Yes", "No"] } as never,
  });
}

/** A node's receipt, in whatever state the case needs: the fact kind the retired low-water rule needed, and it cannot present. */
function nodeReceiptFact(state: string): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    kind: "execution_receipt" as const,
    correlationId: `exec_${state}`,
    executionId: `exec_${state}`,
    requestId: `request_${state}`,
    revision: 1,
    payload: {
      actionId: "harvest_crop",
      state,
      reasonCode: `reason_${state}`,
      revision: 1,
      origin: { kind: "programme", programId: "plan_wake_reachability", nodeId: "n002" },
    } as never,
  });
}

/**
 * One wake rule's bell: the fact that carries it, the opener it must produce, and whether the refusal behind a running plan
 * may hold it.
 */
type Bell = Readonly<{
  fact: WorldFact;
  /** The opener the carrier must produce when nothing is in flight. */
  opener: TurnOpening;
  /**
   * What a running plan does to it: `holds` - refused, and the refusal must name the PLAN; `opens` - the rule does not wait.
   */
  behindAPlan: "holds" | "opens";
}>;

/**
 * THE BELL OF EVERY WAKE RULE, typed over the pump's own declaration.
 *
 * A rule added to `WAKE_RULES` without an entry here is a compile error, which is the whole mechanism: the author of the
 * next wake rule has to name the fact kind that carries it, and this file then proves the pump opens a turn for it.
 */
const BELLS: Readonly<Record<WakeRule, Bell>> = Object.freeze({
  [WAKE_RULE.presentableNews]: Object.freeze({
    fact: milestoneFact(),
    opener: TURN_OPENING.worldFact,
    behindAPlan: "holds",
  }),
  [WAKE_RULE.dueWake]: Object.freeze({
    fact: dueWakeFact(),
    opener: TURN_OPENING.due,
    behindAPlan: "opens",
  }),
  [WAKE_RULE.heldWorld]: Object.freeze({
    fact: heldWorldFact(),
    opener: TURN_OPENING.worldFact,
    behindAPlan: "opens",
  }),
});

type Delivery = Readonly<{ batches: PendingBatch[]; sink: { deliver(batch: PendingBatch): Promise<void> } }>;

function recorder(): Delivery {
  const batches: PendingBatch[] = [];
  return { batches, sink: { async deliver(batch) { batches.push(batch); } } };
}

/** One fact driven through a real pump, on a journal the case states. */
async function drive(
  reading: InFlightProgrammeReading,
  fact: WorldFact,
): Promise<Readonly<{ opened: number; outcome: string; reason: string | undefined; delivered: number }>> {
  const pump = new CompanionEventPump(() => reading);
  const turns = recorder();
  pump.enqueueFact(fact, FACT_PRODUCER.adapterIngress);
  const outcome = await pump.flush(turns.sink);
  return {
    opened: pump.turnAccount.opened,
    outcome: outcome.kind,
    reason: outcome.kind === "not_owed" ? outcome.reason : undefined,
    delivered: turns.batches.length,
  };
}

/**
 * The gate. `rules R · opened O · held H`, and a rule whose bell opens nothing fails naming itself.
 */
test("a_wake_rule_that_cannot_open_a_turn: every declared wake rule is carried by a fact that opens one", async () => {
  assert.ok(WAKE_RULES.length > 0, "an empty population agrees with itself: the pump declared no wake rules");
  const offenders: string[] = [];
  let opened = 0;
  let held = 0;
  for (const rule of WAKE_RULES) {
    const bell = BELLS[rule];
    // DIRECTION ONE: the bell really opens a turn, so the rule is reachable by a fact at all.
    const idle = await drive(ANSWERED, bell.fact);
    if (idle.opened !== 1 || idle.outcome !== "opened") {
      offenders.push(`${rule}: its carrier opens ${String(idle.opened)} turns with nothing in flight (${idle.outcome})`);
      continue;
    }
    opened += 1;
    // DIRECTION TWO: behind a plan that is still working, the same fact must still REACH the decision - opening, or being
    // refused for the plan. A fact that cannot present would be refused for the surface instead, which is the 34-minute
    // defect: the rule never sees it.
    const behind = await drive(RUNNING, bell.fact);
    if (bell.behindAPlan === "opens") {
      if (behind.opened !== 1)
        offenders.push(`${rule}: a running plan held it, but this wake does not wait (${behind.outcome})`);
    } else if (behind.reason !== NOT_OWED.planStillRunning) {
      offenders.push(
        `${rule}: a running plan must refuse it BY NAME (${String(behind.reason)}), not by a reason that fired first`,
      );
    } else {
      held += 1;
    }
  }
  assert.deepEqual(offenders, [], `a wake rule no fact can carry: ${offenders.join("; ")}`);
  assert.equal(opened, WAKE_RULES.length, "every declared rule's carrier opened a turn with nothing in flight");
  assert.equal(
    held,
    WAKE_RULES.filter((rule) => BELLS[rule].behindAPlan === "holds").length,
    "and every rule that waits behind a plan was refused BY THE PLAN, which is what proving it reached the decision means",
  );
  console.log(
    `a_wake_rule_that_cannot_open_a_turn: rules ${String(WAKE_RULES.length)} · opened ${String(opened)} · held ` +
      `${String(held)} · rules ${WAKE_RULES.join(", ")}`,
  );
});

/**
 * The falsifier, on the run's own facts: the bell the retired low-water rule needed does not ring.
 *
 * <p>
 * "Wake her when her plan is down to its last nodes" has to be carried by something that says the plan moved - a node's
 * receipt, or the settlement. Driven through the pump, a node receipt arriving while a plan has THREE nodes left is answered
 * `progress` (it is a step of a programme she dispatched) with no turn, and the settlement only arrives once every node is
 * terminal, which is the moment the tail the rule was about is gone. So the rule could not have fired in `round84`, and
 * neither could any tuning of it: the count it compared was never on the wire.
 * </p>
 */
test("a_wake_rule_that_cannot_open_a_turn: the retired rule's bell is a node receipt, and it never rings", async () => {
  // BOTH STATES A NODE CAN BE IN, because the retirement is about both: a step still running is `progress` (standing state
  // inside work she dispatched) and a terminal one is `no_surface_for` (no presentation lease). Neither ever asks the plan.
  const running = await drive(RUNNING, nodeReceiptFact("running"));
  const terminal = await drive(RUNNING, nodeReceiptFact("succeeded"));
  for (const [state, receipt] of [
    ["running", running],
    ["succeeded", terminal],
  ] as const) {
    assert.equal(receipt.opened, 0, `a node receipt (${state}) buys no turn while her plan still has nodes`);
    assert.equal(receipt.delivered, 0, `and no batch was composed for it (${state})`);
    assert.notEqual(
      receipt.reason,
      NOT_OWED.planStillRunning,
      `it does not reach the plan rule (${state}): the fact is answered before the plan is ever asked about`,
    );
  }
  assert.equal(running.reason, NOT_OWED.progress, "a step still running is standing state inside work already answered");
  assert.equal(terminal.reason, NOT_OWED.noSurface, "and a finished one cannot present, so no turn can carry its words");
  console.log(
    `a_wake_rule_that_cannot_open_a_turn: retired rule's carriers opened 0 · running → ${String(running.reason)} · ` +
      `succeeded → ${String(terminal.reason)} · the tail the rule compared is not on the wire`,
  );
});

/** And the population of openers is still the pump's closed list: a wake rule added without an opener here is caught. */
test("a_wake_rule_that_cannot_open_a_turn: the bells name openers from the pump's closed list", () => {
  const openers = new Set(WAKE_RULES.map((rule) => BELLS[rule].opener));
  for (const opener of openers)
    assert.ok(
      TURN_OPENINGS.includes(opener),
      `a bell names the opener \`${opener}\`, which is not a member of TURN_OPENINGS: ${TURN_OPENINGS.join(", ")}`,
    );
  assert.ok(openers.size > 1, "three rules behind one opener would be one rule with three names");
});
