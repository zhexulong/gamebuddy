import assert from "node:assert/strict";
import test from "node:test";

import { CompanionLoop } from "./companion-loop.js";
import {
  CLOSED_WITH_NOTHING_WAIT_FOR,
  CLOSED_WITH_NOTHING_WAIT_FORS,
  type ClosedWithNothingWaitFor,
  type CompanionEventPump,
  FACT_PRODUCER,
  HOST_MINTED_FACT_SOURCE,
  NOT_OWED_REASONS,
  type PendingBatch,
  type TurnAccount,
  TURN_PRODUCTION,
  TURN_WITHOUT_ACTION_REASON,
  type TurnWithoutActionReason,
  type WorldFact,
} from "./event-pump.js";
import { CompanionHostService } from "./host-service.js";
import type { RunTrace, RunTraceAttributes, RunTraceSpan, RunTraceSpanHandle } from "./run-trace.js";
import { RUN_WAIT_NAMES } from "./run-trace-budget.js";

/**
 * `a_named_wait_is_what_the_idle_arm_reads:<kind>` - THE GATE, over the two halves of one mechanism.
 *
 * <p>
 * MEASURED 2026-11-20 (`round84`, 34 minutes, `.live-runs/game-ladder/2026-11-20T13-52-51-386Z-multiday_routine`). Two
 * shapes in one run:
 * </p>
 *
 * <p>
 * ONE: `70f83b4f` taught the pump to say what a turn that closed with nothing waits for, and when to be asked again -
 * `a_fresh_reading 0 · a_free_body 0 · the_world_s_next_fact 42.3 s` - deliberately as a READING, because reading it opens
 * no turn. Nothing acted on it. The run's own account then counted FIVE of those turns woken by the game's clock,
 * `424f2a21` after **203.8 s**, and the Host's whole reading of the interval was `wait.idle (reason: "nothing_owed")`:
 * **741.9 s** of a sentence nobody read. This file is the reader.
 * </p>
 *
 * <p>
 * TWO: the same run's cutscene (day 4, 12:20: eleven `modal_presented (DialogueBox, isQuestion:false,
 * blocksTimePass:true)` facts between `13:57:58` and `13:59:33`) woke her once per box, every turn spoke, and the run
 * counted `lost 21 {no_presentation_lease: 21}` of 91 messages while every prompt said `持有: event · 可由指令接管: 否 ·
 * 下一步: 下一回合`. `event-pump.world-locked-wake.test.ts` owns that rule; this file owns the JOIN - a cutscene that
 * leaves a named wait behind must wake her exactly once, when the performance ends.
 * </p>
 *
 * <p>
 * THE LINE THE GATE PRINTS: `kinds K · armed A · idled-instead I · woken-while-locked L`.
 * </p>
 *
 * <ul>
 *   <li>`I > 0` fails, naming the kind: a wait the arm idled through is a sentence nobody acts on, which is the same shape
 *       as a gate nobody calls.</li>
 *   <li>`L > 0` fails, naming the turn: a wake with neither speech nor action available - a turn opened for a world that
 *       was performing and could not show her.</li>
 *   <li>`armed` is the arm's OWN record (`CompanionHostService.namedWaitLook`), not a re-derivation: `0` means it flushed,
 *       a positive number means it armed one look at the wait's own moment, and it is keyed on the delivered turn, so a
 *       `0` that stays `0` after its look cannot become a flush per look.</li>
 * </ul>
 */

const BASE_MS = 1_700_000_000_000;

/** Enough microtask turns for one `flushSoon` (a promise, a delivery, and its own finally) to finish. */
async function settle(): Promise<void> {
  for (let index = 0; index < 32; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

function eventHarness() {
  let factListener: ((fact: Parameters<CompanionEventPump["enqueueFact"]>[0]) => void) | undefined;
  return {
    events: {
      onFact(next: (fact: never) => void) {
        factListener = next as unknown as (fact: Parameters<CompanionEventPump["enqueueFact"]>[0]) => void;
        return () => {
          factListener = undefined;
        };
      },
      onLifecycle() {
        return () => undefined;
      },
    },
    emit(fact: Parameters<CompanionEventPump["enqueueFact"]>[0]) {
      factListener?.(fact);
    },
  };
}

/**
 * A Pi session that answers with one spoken line and no tool.
 *
 * That is exactly `TURN_PRODUCTION.spoke`, the only production the pump counts a turn that closed with nothing in - so every
 * empty turn below is one the product would count, not a fixture's idea of a quiet turn.
 */
function scriptedSession() {
  const listeners = new Set<(event: unknown) => void>();
  const prompts: string[] = [];
  const emit = (event: unknown): void => {
    for (const listener of [...listeners]) listener(event);
  };
  const answer = (batch: string): void => {
    emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: batch }] } });
    emit({ type: "message_start", message: { role: "assistant", content: [], provider: "cpa-oai" } });
    emit({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "记下了。" }], stopReason: "stop" },
    });
    emit({ type: "agent_settled", aborted: false });
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
        answer(batch);
      },
      async abort() {},
      clearQueue() {},
      async waitForIdle() {},
    },
  };
}

/** One span the run exported: the idle line's own arguments, read here instead of from a bundle. */
type RecordedSpan = Readonly<{ name: string; attributes: RunTraceAttributes }>;

function recordingTrace() {
  const opened: RecordedSpan[] = [];
  const handle = (): RunTraceSpanHandle => Object.freeze({ spanId: `span_${String(opened.length)}`, end() {} });
  const trace: RunTrace = {
    traceId: "trace_named_wait",
    begin(name, attributes) {
      opened.push(Object.freeze({ name, attributes: Object.freeze({ ...(attributes ?? {}) }) }));
      return handle();
    },
    span<T>(name: string, attributes: RunTraceAttributes, body: (span: RunTraceSpanHandle) => T): T {
      opened.push(Object.freeze({ name, attributes: Object.freeze({ ...attributes }) }));
      return body(handle());
    },
    spans(): readonly RunTraceSpan[] {
      return [];
    },
    dropped(): number {
      return 0;
    },
  };
  return { opened, trace };
}

function host() {
  const adapter = eventHarness();
  const scripted = scriptedSession();
  const loop = new CompanionLoop(scripted.session as never);
  const recorded = recordingTrace();
  const service = new CompanionHostService(
    loop,
    adapter.events as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    recorded.trace,
  );
  return { adapter, scripted, loop, service, spans: recorded.opened };
}

const BODY_FREE = Object.freeze({ location: "Farm", gameTime: "0740", actionable: true });
const READING_MOVED = Object.freeze({ ...BODY_FREE, gameTime: "0820" });

function readingAt(revision: number, observedTick: number, payload: Readonly<Record<string, unknown>>): WorldFact {
  return {
    source: "stardew_mod",
    kind: "snapshot",
    correlationId: `snapshot_${String(observedTick)}`,
    observedTick,
    revision,
    occurredAtMs: BASE_MS + observedTick,
    payload,
  };
}

/** The settled-plan digest: presentable on its own, so it can open a turn without a reading first. */
function settledDigest(eventId: string, occurredAtMs: number): WorldFact {
  return {
    source: HOST_MINTED_FACT_SOURCE,
    kind: "world_fact",
    eventId,
    sourceEventId: eventId,
    correlationId: eventId,
    revision: 0,
    occurredAtMs,
    semanticKind: "program_settled",
    payload: {
      kind: "program_settled",
      programId: eventId,
      settledAtMs: occurredAtMs - 1,
      total: 1,
      counts: { succeeded: 1 },
      ok: true,
      reason: null,
      summary: "1/1 完成",
      nodes: [],
      omitted: 0,
    },
  };
}

/** The Mod's own clock mark: presentable, and the fact that ends a silent wait in the run's own history. */
function milestone(index: number, occurredAtMs: number): WorldFact {
  return {
    source: "stardew_mod",
    kind: "world_fact",
    eventId: `time_milestone_${String(index)}`,
    sourceEventId: `time_milestone_${String(index)}`,
    correlationId: `time_milestone_${String(index)}`,
    revision: 1,
    occurredAtMs,
    semanticKind: "time_milestone",
    payload: { milestone: index },
  };
}

/** A sink that reports what the loop reports for a text-only turn: speech, and no work. */
function speakingSink(pump: CompanionEventPump): { deliver(batch: PendingBatch): Promise<"completed"> } {
  return {
    async deliver() {
      pump.turnProduction = TURN_PRODUCTION.spoke;
      return "completed" as const;
    },
  };
}

/**
 * Deliver one turn that closes with `reason`, straight through the pump.
 *
 * <p>
 * WHICH CONDITION A TURN MEASURES IS THE PUMP'S QUESTION, and `event-pump.turn-wait-named.test.ts` owns it case by case;
 * what this file owns is what the HOST does with the wait the pump then names. Driving the pump directly is what measures
 * both halves on the same wait instead of on a rewritten copy of it.
 * </p>
 */
async function seedEmptyTurn(pump: CompanionEventPump, reason: TurnWithoutActionReason): Promise<void> {
  const sink = speakingSink(pump);
  const digest = (name: string): WorldFact => settledDigest(`program_settled_${name}`, BASE_MS);
  if (reason !== TURN_WITHOUT_ACTION_REASON.noReading) {
    pump.enqueueFact(readingAt(14, 0, BODY_FREE), FACT_PRODUCER.adapterIngress);
    pump.enqueueFact(digest("plan_named_wait_reading"), FACT_PRODUCER.adapterIngress);
    await pump.flush(sink);
  }
  switch (reason) {
    case TURN_WITHOUT_ACTION_REASON.noReading:
      pump.enqueueFact(digest("plan_named_wait_no_reading"), FACT_PRODUCER.adapterIngress);
      await pump.flush(sink);
      break;
    case TURN_WITHOUT_ACTION_REASON.bodyHeld:
      pump.enqueueFact(
        readingAt(15, 1, { ...BODY_FREE, actionable: false, actorDispositionKind: "modal" }),
        FACT_PRODUCER.adapterIngress,
      );
      pump.enqueueFact(milestone(610, BASE_MS + 61_000), FACT_PRODUCER.adapterIngress);
      await pump.flush(sink);
      break;
    case TURN_WITHOUT_ACTION_REASON.worldStale:
      pump.enqueueFact(milestone(600, BASE_MS + 60_000), FACT_PRODUCER.adapterIngress);
      await pump.flush(sink);
      break;
    case TURN_WITHOUT_ACTION_REASON.worldMovedSinceReading:
      pump.enqueueFact(readingAt(15, 1, READING_MOVED), FACT_PRODUCER.adapterIngress);
      pump.enqueueFact(milestone(620, BASE_MS + 62_000), FACT_PRODUCER.adapterIngress);
      await pump.flush(sink);
      break;
    case TURN_WITHOUT_ACTION_REASON.nothingPending:
      pump.enqueueFact(readingAt(15, 1, READING_MOVED), FACT_PRODUCER.adapterIngress);
      pump.enqueueFact(digest("plan_named_wait_nothing_pending"), FACT_PRODUCER.adapterIngress);
      await pump.flush(sink);
      break;
  }
  const shape = pump.closedWithNothing.shape ?? "";
  assert.equal(
    shape.slice(shape.indexOf(":") + 1),
    reason,
    "the pump must have just delivered a turn closing this way",
  );
}

/** One reason per named wait: the condition that measures it (`closedWithNothingWaitFor`, read from the pump itself). */
const REASON_OF_WAIT: Readonly<Record<ClosedWithNothingWaitFor, TurnWithoutActionReason>> = Object.freeze({
  [CLOSED_WITH_NOTHING_WAIT_FOR.freshReading]: TURN_WITHOUT_ACTION_REASON.worldStale,
  [CLOSED_WITH_NOTHING_WAIT_FOR.freeBody]: TURN_WITHOUT_ACTION_REASON.bodyHeld,
  [CLOSED_WITH_NOTHING_WAIT_FOR.nextWorldFact]: TURN_WITHOUT_ACTION_REASON.nothingPending,
});

/** A reading that owes no turn: standing state, so the Host's flush reaches its idle decision and nothing else. */
const IDLE_READING = readingAt(16, 2, { ...BODY_FREE, gameTime: "0745" });

/** The reading the Mod publishes while a performance owns the actor: `eventUp`, and no command can be admitted. */
const PERFORMING_READING = readingAt(20, 10, {
  location: "Town",
  gameTime: "1220",
  actionable: false,
  actorDispositionKind: "event",
  actorDispositionDetail: null,
});

function notOwedTotal(account: TurnAccount): number {
  return NOT_OWED_REASONS.reduce((total, reason) => total + account.notOwed[reason], 0);
}

/** The idle spans the run exported, with the wait each one named. */
function idleLines(spans: readonly RecordedSpan[]): readonly RunTraceAttributes[] {
  return spans.filter((span) => span.name === RUN_WAIT_NAMES.idle).map((span) => span.attributes);
}

/** One box of the cutscene, in the shape the run published eleven of. */
function cutsceneBox(index: number): WorldFact {
  return {
    source: "stardew_mod",
    kind: "world_fact",
    eventId: `modal_shown_${String(index)}`,
    sourceEventId: `modal_shown_${String(index)}`,
    correlationId: `modal_shown_${String(index)}`,
    revision: 20,
    occurredAtMs: BASE_MS + 10,
    semanticKind: "modal_presented",
    payload: {
      kind: "modal_presented",
      modalType: "DialogueBox",
      isQuestion: false,
      responseKeys: [],
      blocksTimePass: true,
      text: "这里曾经是这个镇子的骄傲。",
      textFrom: "modal",
    },
  };
}

test("a_named_wait_is_what_the_idle_arm_reads: every named wait is read, and a performing world wakes nobody", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: BASE_MS });
  const kinds = CLOSED_WITH_NOTHING_WAIT_FORS;
  assert.equal(kinds.length, 3, "the population is the pump's own closed list of named waits");

  const armed: ClosedWithNothingWaitFor[] = [];
  const idledInstead: ClosedWithNothingWaitFor[] = [];
  const namedInTheIdleLine: ClosedWithNothingWaitFor[] = [];
  const unmapped: ClosedWithNothingWaitFor[] = [];

  for (const waitingFor of kinds) {
    const { adapter, loop, service, spans } = host();
    const reason: TurnWithoutActionReason | undefined = (
      REASON_OF_WAIT as Readonly<Record<string, TurnWithoutActionReason | undefined>>
    )[waitingFor];
    if (reason === undefined) {
      unmapped.push(waitingFor);
      service.close();
      continue;
    }
    await seedEmptyTurn(loop.pump, reason);
    const wait = loop.pump.closedWithNothing;
    assert.equal(wait.waitingFor, waitingFor, `\`${reason}\` must name \`${waitingFor}\``);
    assert.equal(wait.turn, loop.pump.turnAccount.opened, "the wait belongs to the turn that just settled");

    // THE HOST REACHES ITS OWN IDLE DECISION: one fact that owes no turn, and the arm reads the wait the turn left.
    const before = notOwedTotal(loop.pump.turnAccount);
    adapter.emit(IDLE_READING);
    await settle();

    // ARMED IS THE ACT, NOT THE RECORD. The arm's own record says what it read; what the gate counts is whether the pump was
    // asked because of it - at once for a `0`, and at the moment the wait named for anything above zero.
    const asked = notOwedTotal(loop.pump.turnAccount) - before;
    const look = service.namedWaitLook;
    let acted = false;
    if (wait.lookAgainInMs === 0) {
      acted = asked >= 2;
      // A `0` THAT STAYS `0` IS NOT A SPIN: nothing else asks until another turn is delivered.
      const afterLook = notOwedTotal(loop.pump.turnAccount);
      await settle();
      assert.equal(
        notOwedTotal(loop.pump.turnAccount),
        afterLook,
        `\`${waitingFor}\`: the look is once per wait, so a \`0\` cannot become a flush per look`,
      );
    } else {
      const lookAgainInMs = wait.lookAgainInMs;
      assert.equal(
        asked,
        1,
        `\`${waitingFor}\`: only the reading itself may ask before the moment (asked ${String(asked)}×)`,
      );
      if (lookAgainInMs !== undefined && lookAgainInMs > 0) {
        t.mock.timers.tick(lookAgainInMs);
        await settle();
        const askedAtTheMoment = notOwedTotal(loop.pump.turnAccount);
        acted = askedAtTheMoment - before === 2;
        await settle();
        assert.equal(
          notOwedTotal(loop.pump.turnAccount),
          askedAtTheMoment,
          `\`${waitingFor}\`: and it does not re-arm for the same wait`,
        );
      }
    }
    if (acted) armed.push(waitingFor);
    else idledInstead.push(waitingFor);
    if (look !== undefined && look.turn === wait.turn)
      assert.equal(
        look.lookAgainInMs,
        wait.lookAgainInMs,
        `\`${waitingFor}\`: the arm must read the pump's own moment, not a second copy of it`,
      );

    if (idleLines(spans).some((line) => line.waitingFor === waitingFor)) namedInTheIdleLine.push(waitingFor);
    service.close();
  }

  // ── THE OTHER HALF: A WORLD THAT IS PERFORMING WAKES NOBODY, AND THEN EXACTLY ONCE ──────────────────────────────────
  const cutscene = host();
  const beforeCutscene = cutscene.scripted.prompts.length;
  cutscene.adapter.emit(PERFORMING_READING);
  await settle();
  for (const index of [1, 2, 3]) {
    cutscene.adapter.emit(cutsceneBox(index));
    await settle();
  }
  const during = cutscene.scripted.prompts.slice(beforeCutscene);

  const beforeLift = cutscene.scripted.prompts.length;
  cutscene.adapter.emit(readingAt(21, 11, { ...BODY_FREE, location: "Town", gameTime: "1230" }));
  await settle();
  const lift = cutscene.scripted.prompts.slice(beforeLift);

  const line =
    `kinds ${String(kinds.length)} · armed ${String(armed.length)} · idled-instead ${String(idledInstead.length)} · ` +
    `woken-while-locked ${String(during.length)}`;

  console.log(
    `${line} · named-in-the-idle-line ${String(namedInTheIdleLine.length)} · ` +
      `wakes-when-the-lock-lifts ${String(lift.length)}`,
  );

  assert.deepEqual(unmapped, [], `${line}: every named wait must be a condition a turn can measure`);
  assert.deepEqual(idledInstead, [], `${line}: these waits were named and nobody acted on them`);
  assert.equal(armed.length, kinds.length, `${line}: the arm reads every named wait`);
  assert.deepEqual(
    namedInTheIdleLine,
    [...kinds],
    `${line}: every wait must also be NAMED in the idle line, or a 42 s silence is still an empty span`,
  );
  assert.deepEqual(during, [], `${line}: a world that is performing woke her, with ${during.join(" / ")}`);
  assert.equal(
    lift.length,
    1,
    `${line}: the performance ended, and the boxes must ride exactly one turn (${lift.length})`,
  );
  assert.ok(
    (lift[0] ?? "").includes("这里曾经是这个镇子的骄傲。"),
    "and that one turn states what the boxes said, so the wake is the news and not a narrating timer",
  );
  assert.equal(
    cutscene.loop.pump.turnAccount.carry.held,
    0,
    "the boxes were consumed by it rather than left waiting for a turn that already happened",
  );
  cutscene.service.close();
});
