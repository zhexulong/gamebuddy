import assert from "node:assert/strict";
import test from "node:test";

import { CompanionLoop } from "./companion-loop.js";
import * as pumpModule from "./event-pump.js";
import {
  CompanionEventPump,
  EXECUTION_STALL_BOUND_MS,
  HOST_MINTED_WAKE_KINDS,
  MEASURED_TURN_CADENCE_MS,
  NARRATION_WITHOUT_WORK_SEMANTIC_KIND,
  NARRATION_WITHOUT_WORK_TURNS,
  TURN_PRODUCTION,
  type CompanionTurnOutcome,
  type TurnProduction,
  type WorldFact,
} from "./event-pump.js";
import { CompanionHostService, HOST_WAKE_REASON, HOST_WAKE_REASONS } from "./host-service.js";

/**
 * "She spoke and did nothing" must be a fact the loop can wake her for.
 *
 * MEASURED 2026-11-10 (`round45`): after 22:28:02 she dispatched nothing for the rest of the run. The last five turns
 * were pure narration - 「斧头扛上肩，靴子一踏进湿草」「推开门，晨光一下打到脸上…外头的雾还没散」 - while her body stood
 * still and the engine passed her out twice at 02:00. The run's own account is 134 assistant messages, 97 prompt turns
 * and 60 `continuation` wakes: the loop kept asking and she kept narrating, and nothing in the loop said so.
 *
 * The counter that was meant to catch this (`HostService.#idleTurnsWithoutWork`) could not, and this file states what it
 * did instead of assuming: its one wake called `flush`, which returns `undefined` when nothing is pending - which is the
 * whole premise of the arm - so no turn was created and no fact was published. The replacement is the pump's own
 * measurement (`narrationWithoutWork`) and the Host's named decision (`wakeReason`).
 */

const ASSISTANT_START = Object.freeze({ role: "assistant" as const, content: Object.freeze([]), provider: "cpa-oai" });
const textEnd = Object.freeze({
  role: "assistant" as const,
  content: Object.freeze([{ type: "text", text: "斧头扛上肩，靴子一踏进湿草。" }]),
  stopReason: "stop",
});
const partial = (text: string) => ({ role: "assistant" as const, content: [{ type: "text", text }] });

/**
 * A Pi session that answers every prompt with a spoken line and no tool call, in Pi's own event vocabulary.
 *
 * This is round45's tail as a provider: the world says something, she narrates it, nothing moves. The answers do not run
 * out - the point is that she never stops narrating.
 */
function narratingSession() {
  const listeners = new Set<(event: unknown) => void>();
  const prompts: string[] = [];
  const emit = (event: unknown): void => {
    for (const listener of [...listeners]) listener(event);
  };
  return {
    prompts,
    session: {
      subscribe(listener: (event: unknown) => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      async sendUserMessage(batch: string) {
        prompts.push(batch);
        emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: batch }] } });
        emit({ type: "message_start", message: ASSISTANT_START });
        emit({
          type: "message_update",
          message: partial("斧头扛上肩，靴子一踏进湿草。"),
          assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: partial("") },
        });
        emit({ type: "message_end", message: textEnd });
        emit({ type: "agent_settled", aborted: false });
      },
      async abort() {},
      clearQueue() {},
      async waitForIdle() {},
    },
  };
}

function eventHarness() {
  let factListener: ((fact: WorldFact) => void) | undefined;
  return {
    events: {
      onFact(next: (fact: WorldFact) => void) {
        factListener = next;
        return () => {
          factListener = undefined;
        };
      },
      onLifecycle() {
        return () => undefined;
      },
    },
    emit(fact: WorldFact) {
      factListener?.(fact);
    },
  };
}

const snapshot = (revision: number): WorldFact => ({
  source: "arcade_adapter",
  kind: "snapshot",
  eventId: `snapshot_${revision}`,
  occurredAtMs: Date.now(),
  correlationId: `snapshot_${revision}`,
  revision,
  payload: { revision },
});

/** The world saying something: a clock milestone, which is both a delivery trigger and a world change. */
const milestone = (index: number): WorldFact => ({
  source: "arcade_adapter",
  kind: "world_fact",
  eventId: `time_milestone_${index}`,
  occurredAtMs: Date.now(),
  correlationId: `time_milestone_${index}`,
  revision: 400 + index,
  semanticKind: "time_milestone",
  payload: { kind: "time_milestone", milestone: "1200" },
});

function harness() {
  const adapter = eventHarness();
  const scripted = narratingSession();
  const loop = new CompanionLoop(scripted.session as never);
  const service = new CompanionHostService(loop, adapter.events as never);
  return { adapter, scripted, loop, service };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 25));

/**
 * One pump-level delivered turn: the loop's production report, then the caller's own text so `flush` has something to
 * deliver.
 *
 * PLAYER INPUT, because that is what these turns were: every one of round45's 97 prompt turns was opened by the harness
 * asking her to carry on, and `player_input` is the member of the closed list that says so. A FACT cannot stand in for it
 * any more - a fact repeated verbatim is not a reason to open a turn (`TURN_OPENING`) - and inventing a distinct fact per
 * turn would be measuring the fixture instead of the narration run.
 */
async function deliverTurn(pump: CompanionEventPump, production: TurnProduction, index: number): Promise<void> {
  pump.turnProduction = production;
  pump.enqueuePlayerInput({
    source: "player_text",
    inputId: `carry_on_${String(index)}`,
    text: "接着做。",
    locale: "zh-CN",
    timestampMs: Date.now(),
  });
  await pump.flush({ deliver: async (): Promise<CompanionTurnOutcome> => "completed" });
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* The gate: every fact the pump mints, and every reason the decider declares, reaches something.                     */
/* ---------------------------------------------------------------------------------------------------------------- */

/**
 * A GATE, not a test of today's two members.
 *
 * The defect it exists for is in this file's own subject: a mechanism was added, ran, and reached no decider, so a run
 * with forty narration turns produced no fact at all and no artifact could show it. A reason the decider declares and
 * nothing can produce is the same failure one layer up, so the population comes from the two declarations that own it -
 * the pump's exported `*_SEMANTIC_KIND` constants and `HOST_WAKE_REASONS` - and each is driven to a real answer here
 * rather than asserted in prose.
 */
test("narration_turns_reach_no_decider: every pump-minted kind and every declared wake reason is consumed", async () => {
  const minted = Object.entries(pumpModule)
    .filter(([name]) => name.endsWith("_SEMANTIC_KIND"))
    .map(([name, kind]) => [name, kind as string] as const);
  assert.ok(minted.length > 0, "the scan recognised no pump-minted kind, so this reading is blocked rather than green");

  const unclassified = minted.filter(([, kind]) => !(kind in HOST_MINTED_WAKE_KINDS));
  assert.deepEqual(
    unclassified.map(([name]) => name),
    [],
    `the pump mints these kinds and nothing says how a turn is created for them: ${unclassified
      .map(([, kind]) => kind)
      .join(", ")}. Add each to HOST_MINTED_WAKE_KINDS with the Host path that delivers it.`,
  );

  // Each declared reason, driven to an answer. The table is keyed by the enum, so a member added tomorrow fails here
  // until somebody makes it producible - which is the whole point of a population read from the authority.
  const produced = new Map<string, string>();

  const quiet = harness();
  assert.equal(quiet.service.wakeReason, undefined, "a session with nothing pending and nothing spoken owes no turn");
  quiet.service.close();

  const pending = harness();
  pending.loop.pump.enqueueFact(milestone(0));
  const pendingReason = pending.service.wakeReason;
  assert.equal(pendingReason, HOST_WAKE_REASON.pendingDelivery, "a held fact is the ordinary reason, unchanged");
  produced.set(pendingReason, "a fact the pump is holding has not reached a turn yet");
  pending.service.close();

  const narrating = harness();
  for (let index = 0; index < NARRATION_WITHOUT_WORK_TURNS; index += 1)
    await deliverTurn(narrating.loop.pump, TURN_PRODUCTION.spoke, index);
  const narrationReason = narrating.service.wakeReason;
  assert.equal(
    narrationReason,
    HOST_WAKE_REASON.narrationWithoutWork,
    "nothing pending, and the last turns only spoke",
  );
  produced.set(narrationReason, "the pump has nothing to deliver and the last turns only spoke");
  narrating.service.close();

  assert.deepEqual(
    [...produced.keys()].sort(),
    [...HOST_WAKE_REASONS].sort(),
    `wake_reason_never_reachable:${HOST_WAKE_REASONS.filter((reason) => !produced.has(reason)).join(",")} - a reason ` +
      "the decider declares and nothing can produce is a claim about a run nobody checked",
  );

  console.log(
    `narration_without_work: examined ${String(minted.length)} pump-minted kind(s) ` +
      `(${minted.map(([, kind]) => kind).join(", ")}), all classified in HOST_MINTED_WAKE_KINDS; ` +
      `examined ${String(HOST_WAKE_REASONS.length)} declared wake reason(s) ` +
      `(${HOST_WAKE_REASONS.join(", ")}), all produced: ${[...produced.entries()]
        .map(([reason, how]) => `${reason} <- ${how}`)
        .join("; ")}`,
  );
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* The red proof: round45's tail, replayed through the product Host.                                                  */
/* ---------------------------------------------------------------------------------------------------------------- */

test("idle_mechanism_is_dead_or_alive: five narration turns and no tool call produce a fact the model is handed", async () => {
  const { adapter, scripted, service } = harness();
  // The world exists first, so every later turn re-states a reading rather than composing an empty block.
  adapter.emit(snapshot(352));
  await settle();

  const before = scripted.prompts.length;
  for (let index = 0; index < 5; index += 1) {
    adapter.emit(milestone(index));
    await settle();
  }

  const narrationPrompts = scripted.prompts.filter((prompt) => prompt.includes(NARRATION_WITHOUT_WORK_SEMANTIC_KIND));
  assert.ok(
    narrationPrompts.length >= 1,
    `five narration turns, zero tool calls and nothing in flight produced no ${NARRATION_WITHOUT_WORK_SEMANTIC_KIND} ` +
      `fact in any of the ${String(scripted.prompts.length - before)} prompts this replay created. That is the round45 ` +
      "shape: the loop kept asking and she kept narrating, and nothing in the loop said so.",
  );
  // A named line inside `<world-facts>`, and the numbers the fact carries - not an imperative, and not a second block.
  assert.match(
    narrationPrompts[0]!,
    new RegExp(`<world-facts>[\\s\\S]*${NARRATION_WITHOUT_WORK_SEMANTIC_KIND}`, "u"),
    "the fact must be a `<world-facts>` line, which is the block every other Host-minted fact is printed in",
  );
  service.close();
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* The measurement.                                                                                                   */
/* ---------------------------------------------------------------------------------------------------------------- */

test("the bound is the first whole turn past the stall bound at the measured cadence", () => {
  assert.ok(
    NARRATION_WITHOUT_WORK_TURNS * MEASURED_TURN_CADENCE_MS >= EXECUTION_STALL_BOUND_MS,
    "the bound must not name a companion whose narration is still shorter than the silence this file calls a stall",
  );
  assert.ok(
    (NARRATION_WITHOUT_WORK_TURNS - 1) * MEASURED_TURN_CADENCE_MS < EXECUTION_STALL_BOUND_MS,
    "and it must be the FIRST such turn, or the bound is later than the measurement it claims to follow",
  );
});

test("a companion who speaks once and then works is never named", async () => {
  const pump = new CompanionEventPump();
  await deliverTurn(pump, TURN_PRODUCTION.spoke, 0);
  assert.equal(pump.narrationWithoutWork.turns, 1, "one spoken turn is the ordinary 'speak first, act second' shape");
  assert.equal(pump.narrationWithoutWork.due, false, "so it is not yet a fact");
  assert.equal(pump.takeNarrationWithoutWorkFact(), undefined);

  await deliverTurn(pump, TURN_PRODUCTION.worked, 1);
  assert.equal(pump.narrationWithoutWork.turns, 0, "a turn that produced work clears the run");
  assert.ok(pump.narrationWithoutWork.lastWorkTurnAgoMs >= 0);
});

test("a turn that carried no assistant text is not narration, and neither is a turn that died", async () => {
  const pump = new CompanionEventPump();
  await deliverTurn(pump, TURN_PRODUCTION.spoke, 0);
  await deliverTurn(pump, TURN_PRODUCTION.saidNothing, 1);
  assert.equal(pump.narrationWithoutWork.turns, 0, "a provider that answered with nothing is not her narrating");

  for (let index = 0; index < 3; index += 1) await deliverTurn(pump, TURN_PRODUCTION.spoke, 10 + index);
  assert.equal(pump.narrationWithoutWork.turns, 3);
  pump.turnProduction = TURN_PRODUCTION.spoke;
  pump.enqueueFact({
    source: "arcade_adapter",
    kind: "lifecycle",
    eventId: "lifecycle_aborted",
    occurredAtMs: Date.now(),
    correlationId: "lifecycle_aborted",
    revision: 99,
    payload: { state: "connected" },
  });
  await pump.flush({ deliver: async (): Promise<CompanionTurnOutcome> => "aborted" });
  assert.equal(pump.narrationWithoutWork.turns, 0, "an aborted turn is the player's or the provider's own decision");
});

test("the fact is bounded: forty narration turns are five facts, not forty", async () => {
  const pump = new CompanionEventPump();
  const published: number[] = [];
  for (let index = 0; index < 40; index += 1) {
    await deliverTurn(pump, TURN_PRODUCTION.spoke, index);
    const fact = pump.takeNarrationWithoutWorkFact();
    if (fact !== undefined) published.push(Number(fact.payload.turns));
  }
  assert.deepEqual(
    published,
    [3, 12, 21, 30, 39],
    "one fact per re-arm multiple of the bound - saying the same thing every turn would spend the run on one reading",
  );
});

test("the fact says what happened, in the one token a run reader already reads", async () => {
  const pump = new CompanionEventPump();
  for (let index = 0; index < 3; index += 1) await deliverTurn(pump, TURN_PRODUCTION.spoke, index);
  const fact = pump.takeNarrationWithoutWorkFact();
  assert.ok(fact !== undefined);
  assert.equal(fact.semanticKind, NARRATION_WITHOUT_WORK_SEMANTIC_KIND);
  assert.match(
    String(fact.payload.code),
    /^narration_without_work:3:\d+$/u,
    "narration_without_work:<consecutiveTurns>:<lastToolTurnAgoMs>, spelled once and printed verbatim",
  );
  assert.equal(fact.payload.turns, 3);
  assert.equal(fact.payload.narrationFactsSoFar, 1);
  assert.equal(pump.takeNarrationWithoutWorkFact(), undefined, "and taking it moves the next one out");
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* The ordering: a frozen world is not her fault.                                                                     */
/* ---------------------------------------------------------------------------------------------------------------- */

test("a frozen world outranks her silence, so the world's own fact is the one published", async () => {
  const pump = new CompanionEventPump();
  pump.enqueueFact(snapshot(352));
  // Six delivered turns: the first carries the snapshot, so the reading is five turns old - the stale bound.
  for (let index = 0; index < 6; index += 1) await deliverTurn(pump, TURN_PRODUCTION.spoke, index);
  // The world says it moved while her picture of it did not.
  pump.enqueueFact(milestone(0));

  assert.equal(pump.narrationWithoutWork.turns >= NARRATION_WITHOUT_WORK_TURNS, true, "the narration run is real");
  assert.equal(
    pump.narrationWithoutWork.due,
    false,
    "a stale reading outranks it: her picture has already been contradicted, so 'she chose to narrate' is not the " +
      "statement to make about that turn",
  );

  const stale = pump.takeWorldStateStaleFact();
  assert.ok(stale !== undefined, "the world's own fact is the one that is owed");
  assert.equal(stale.semanticKind, "world_state_stale");

  assert.equal(
    pump.narrationWithoutWork.due,
    true,
    "and once the world has said what it had to say, the ordering releases - the narration is then a fact about her",
  );
});
