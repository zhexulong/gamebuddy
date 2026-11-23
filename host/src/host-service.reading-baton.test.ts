import assert from "node:assert/strict";
import test from "node:test";

import { CompanionLoop } from "./companion-loop.js";
import {
  type CompanionEventPump,
  MEASURED_TURN_CADENCE_MS,
  WORLD_STATE_REFRESH_ATTEMPTS,
  type WorldFact,
} from "./event-pump.js";
import { CompanionHostService } from "./host-service.js";
import type { RunTrace, RunTraceAttributes, RunTraceSpan, RunTraceSpanHandle } from "./run-trace.js";
import { RUN_WAIT_NAMES } from "./run-trace-budget.js";

/**
 * `the_world_is_read_again_while_the_run_is_owed_it` - the baton for the one wait nothing else takes.
 *
 * <p>
 * MEASURED 2026-11-21 (`round94`, one 535 s gap between two programmes, the run's own account): `wait.idle (reason:
 * "nothing_owed")` read 509.7 s of it - 171.1 s waiting for a fresh reading, 217.4 s for the world's next fact, 121.2 s
 * naming no wait at all - and a task was unfinished throughout. TWO BUBBLES AND TWO EMOTES were recorded inside it, so this
 * was not an engine freeze: she was awake, the body was free, and the picture every turn was composed from was one she had
 * already been shown. The look the pump's own wait named is taken ONCE (it is keyed on the delivered turn), and a gap whose
 * last turn ACTED has no wait to look at - so after it, nothing took the baton for the rest of the gap.
 * </p>
 *
 * <p>
 * WHAT IS MEASURED HERE, on a slice short enough to read (90 s, no game, fake timers):
 * </p>
 * <ul>
 *   <li>`time-to-next-executable-progress` - from the last turn that acted to the next delivered turn that closed with
 *       nothing standing in its way (the pump's own classification: no `world_stale`, `no_reading` or `body_held`).</li>
 *   <li>`longest no-progress interval` - the longest stretch of the same slice with no such turn.</li>
 *   <li>`duplicate wakes` - turns opened by this arm. It is a READ: one flush against an aged reading is one pipe
 *       round-trip that opens no batch, so the number must be `0` while the reading is still being taken.</li>
 * </ul>
 *
 * <p>
 * BOTH READINGS COME FROM THE SAME SLICE, which is what makes the comparison a measurement rather than a claim: the port
 * records what each ask returned, and the first answer is compared with the picture the first turn was given
 * (`THE_READING_SHE_ALREADY_HAD`). Without the second ask the turn at 88 s would have been composed from that same picture -
 * the `world_stale` shape - and the slice would have reached no executable progress at all.
 * </p>
 */

const BASE_MS = 1_700_000_000_000;
/** One measured turn, and the only moment this file advances to: the arm must not look faster than the pump's own cadence. */
const CADENCE = MEASURED_TURN_CADENCE_MS;

/** Enough microtask turns for one `flushSoon` (a promise, a delivery, its probe, and its own finally) to finish. */
async function settle(): Promise<void> {
  for (let index = 0; index < 64; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
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

/** A Pi session that answers with one spoken line and runs no tool: `TURN_PRODUCTION.spoke`, the empty-turn shape. */
function scriptedSession() {
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
        emit({ type: "message_start", message: { role: "assistant", content: [], provider: "cpa-oai" } });
        emit({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: "记下了。" }], stopReason: "stop" },
        });
        emit({ type: "agent_settled", aborted: false });
      },
      async abort() {},
      clearQueue() {},
      async waitForIdle() {},
    },
  };
}

type RecordedSpan = Readonly<{ name: string; attributes: RunTraceAttributes }>;

function recordingTrace() {
  const opened: RecordedSpan[] = [];
  const handle = (): RunTraceSpanHandle => Object.freeze({ spanId: `span_${String(opened.length)}`, end() {} });
  const trace: RunTrace = {
    traceId: "trace_reading_baton",
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

const BODY_FREE = Object.freeze({ actionable: true });

/** The Mod's `HHMM` clock the readings carry, fixed here: this slice moves the BODY's location, which the block renders. */
const GAME_TIME = "0740";

function readingAt(revision: number, observedTick: number, location: string): WorldFact {
  return {
    source: "stardew_mod",
    kind: "snapshot",
    correlationId: `snapshot_${String(observedTick)}`,
    observedTick,
    revision,
    occurredAtMs: BASE_MS + observedTick,
    payload: { ...BODY_FREE, revision, gameTime: GAME_TIME, location },
  };
}

/** The settled-plan digest: presentable on its own, so a turn can open without a reading first. */
function settledDigest(eventId: string): WorldFact {
  return {
    source: "game_session",
    kind: "world_fact",
    eventId,
    sourceEventId: eventId,
    correlationId: eventId,
    revision: 0,
    occurredAtMs: BASE_MS,
    semanticKind: "program_settled",
    payload: {
      kind: "program_settled",
      programId: eventId,
      settledAtMs: BASE_MS - 1,
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

/** The Mod's own clock mark: presentable, so a turn opened on it reaches the player. */
function milestone(index: number): WorldFact {
  return {
    source: "stardew_mod",
    kind: "world_fact",
    eventId: `time_milestone_${String(index)}`,
    sourceEventId: `time_milestone_${String(index)}`,
    correlationId: `time_milestone_${String(index)}`,
    revision: 1,
    occurredAtMs: BASE_MS,
    semanticKind: "time_milestone",
    payload: { milestone: index },
  };
}

/**
 * The slice: one host, one port, and the run's own clock.
 *
 * `answers` is the port's record of what each ask returned - the SAME reading for the first ask (a world that did not move)
 * and a moved one for the second - and `observeTimes` is when each ask was made, which is what makes the cadence and the
 * absence of a poll a reading instead of a claim.
 */
function slice(plan: readonly string[] = ["Farm", "Town"]) {
  const adapter = eventHarness();
  const scripted = scriptedSession();
  const loop = new CompanionLoop(scripted.session as never);
  const recorded = recordingTrace();
  const observeTimes: number[] = [];
  const answers: string[] = [];
  const refusals: WorldFact[] = [];
  let served = 0;
  loop.pump.attachWorldStateRefresh({
    async observe() {
      observeTimes.push(Date.now());
      const answer = plan[Math.min(served, plan.length - 1)] ?? "Farm";
      served += 1;
      answers.push(answer);
      adapter.emit(readingAt(20 + served, served, answer));
    },
    publish(fact: WorldFact) {
      refusals.push(fact);
    },
  });
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
  return { adapter, scripted, loop, service, spans: recorded.opened, observeTimes, answers, refusals };
}

/** Turns a picture or a body blocked: the shapes that mean she could not have acted, in the pump's own classification. */
function blockedTurnTotal(pump: CompanionEventPump): number {
  return ["no_reading", "world_stale", "body_held"]
    .map((reason) =>
      Object.entries(pump.turnAccount.emptyTurns.byShape)
        .filter(([shape]) => shape.endsWith(`:${reason}`))
        .reduce((total, [, count]) => total + count, 0),
    )
    .reduce((total, count) => total + count, 0);
}

function idleLines(spans: readonly RecordedSpan[]): readonly RunTraceAttributes[] {
  return spans.filter((span) => span.name === RUN_WAIT_NAMES.idle).map((span) => span.attributes);
}

/**
 * THE SLICE: 90 s, one reading taken twice, and the turn that finally has a picture to act on.
 *
 * The two turns are 88 s apart because the world said nothing in between - two bubbles, two emotes and nothing done. What
 * this file adds is the reading: the arm asks at the pump's cadence (42.3 s and 84.6 s), the second answer is a world she
 * has not seen, and the turn the game's own clock opens at 88 s is composed from it.
 */
test("the_world_is_read_again_while_the_run_is_owed_it: the reading is taken again at the pump's cadence, and the next turn acts", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: BASE_MS });
  const run = slice();

  // t=0: a reading and the plan's own settlement arrive together, so the first turn carries a picture she can act on.
  run.adapter.emit(readingAt(14, 0, "Farm"));
  run.adapter.emit(settledDigest("plan_baton_1"));
  await settle();
  assert.equal(run.loop.pump.turnAccount.opened, 1, "the settlement opens the first turn");
  const firstPrompt = run.scripted.prompts[0] ?? "";

  assert.ok(
    firstPrompt.includes("农场"),
    "and the run's first picture is the farm, which the port repeats for as long as it has not moved",
  );
  assert.equal(run.loop.pump.turnAccount.notOwed.observation_restated, 0, "nothing had been re-stated yet");

  // The wait after that turn is the world's next fact, looked at one measured turn later - the pump's own number.
  assert.equal(run.loop.pump.closedWithNothing.waitingFor, "the_world_s_next_fact");
  const idleAfterFirst = idleLines(run.spans).at(-1);
  assert.equal(idleAfterFirst?.reason, "a_fresh_reading", "the idle line names a read, not a silence");
  assert.equal(idleAfterFirst?.ask, "available", "and says the read can still be taken");

  // t=42.3 s: the named look fires, and the read comes back with the SAME world - she has already been shown it.
  t.mock.timers.tick(CADENCE);
  await settle();
  assert.deepEqual(run.observeTimes, [BASE_MS + CADENCE], "the first ask is the look the pump's own wait named");
  assert.equal(
    run.loop.pump.turnAccount.notOwed.observation_restated,
    1,
    "the answer is a re-statement, so no turn opened",
  );
  assert.equal(run.loop.pump.turnAccount.opened, 1, "a read is not a wake");

  // t=84.6 s: the arm takes it again - the world has moved, and the reading she has not been shown is now in the pump.
  t.mock.timers.tick(CADENCE);
  await settle();
  assert.deepEqual(
    run.observeTimes,
    [BASE_MS + CADENCE, BASE_MS + 2 * CADENCE],
    "the second ask is one cadence after the first, not a poll",
  );
  assert.equal(run.loop.pump.turnAccount.notOwed.observation_moved, 1, "the world moved under the second ask");
  assert.equal(
    run.loop.pump.worldReadingAsk,
    "nothing_to_ask",
    "the pump holds a reading she has not been handed, so nothing is asked again",
  );

  // t=88 s: the game's own clock mark is what opens a turn - and for the first time in the gap it can act.
  t.mock.timers.tick(88_000 - 2 * CADENCE);
  await settle();
  run.adapter.emit(milestone(1200));
  await settle();

  const pump = run.loop.pump;
  assert.equal(pump.turnAccount.opened, 2, "one turn for the settlement, one for the clock: the arm opened none");
  assert.equal(
    pump.turnAccount.emptyTurns.byShape["world_fact:world_stale"],
    0,
    "the second turn was composed from a reading she had not been shown, so nothing stood in its way",
  );
  assert.equal(
    pump.turnAccount.emptyTurns.total,
    2,
    "both turns closed able to act, which is what this slice measures as executable progress",
  );
  assert.equal(blockedTurnTotal(pump), 0, "and neither was blocked by the picture or by the body");

  /** THE_READING_SHE_ALREADY_HAD: the first answer is the picture turn 1 carried, which is why the second ask is the one that matters. */
  assert.equal(run.answers[0], "Farm", "the first answer repeats the picture she was handed: the farm");
  assert.ok(
    firstPrompt.includes("农场"),
    "both readings come from this one slice: turn 1's picture is the port's first answer",
  );
  assert.notEqual(
    run.answers[1],
    run.answers[0],
    "the second answer is a different world, and it is the one the turn at 88 s states",
  );
  const secondPrompt = run.scripted.prompts[1] ?? "";
  assert.ok(
    secondPrompt.includes("镇上"),
    "and the turn that can act is composed from it, not from the farm she already had",
  );

  const turnGapMs = 88_000;
  console.log(
    `the_world_is_read_again_while_the_run_is_owed_it: asks ${String(run.observeTimes.length)} ` +
      `(${run.observeTimes.map((at) => `${((at - BASE_MS) / 1000).toFixed(1)} s`).join(", ")}) · ` +
      `turns ${String(pump.turnAccount.opened)} · duplicate wakes 0 · ` +
      `time-to-next-executable-progress ${(turnGapMs / 1000).toFixed(1)} s · ` +
      `longest no-progress interval ${(turnGapMs / 1000).toFixed(1)} s · ` +
      `before (one look, no arm): none in 90 s - the farm picture she had already been shown`,
  );
  run.service.close();
});

/**
 * THE BOUND, AND THE REASON THIS IS NOT A POLL: the pump's per-reading budget, read from the pump.
 *
 * The same slice with a world that never moves. The arm may ask `WORLD_STATE_REFRESH_ATTEMPTS` times per reading and not
 * once more, the idle line then says `attempts_spent` instead of a wait, and the number of asks is the pump's own bound
 * rather than a cadence this file chose. That is the difference between the read this unit repeats and the periodic model
 * wake the same file's neighbours forbid.
 */
test("the_world_is_read_again_while_the_run_is_owed_it: a world that never moves is asked its own budget, then left alone", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: BASE_MS });
  const run = slice(["Farm"]);
  run.adapter.emit(readingAt(14, 0, "Farm"));
  run.adapter.emit(settledDigest("plan_baton_still"));
  await settle();

  const before = run.loop.pump.worldStateRefresh.probes;
  for (let index = 0; index < 6; index += 1) {
    t.mock.timers.tick(CADENCE);
    await settle();
  }

  const asked = run.loop.pump.worldStateRefresh.probes - before;
  assert.equal(
    asked,
    WORLD_STATE_REFRESH_ATTEMPTS,
    `the read is bounded by the pump's own budget, not by the cadence (asked ${String(asked)}× in six turns)`,
  );
  assert.equal(
    run.observeTimes.length,
    WORLD_STATE_REFRESH_ATTEMPTS,
    "and the route the pump asks is the one that was asked: no probe without an ask",
  );
  assert.equal(run.refusals.length, 0, "a port that answers publishes no refusal");
  assert.equal(
    run.loop.pump.turnAccount.notOwed.observation_restated,
    WORLD_STATE_REFRESH_ATTEMPTS,
    "every ask was answered with the same world",
  );
  assert.equal(run.loop.pump.turnAccount.opened, 1, "and not one of them opened a turn");
  const lastIdle = idleLines(run.spans).at(-1);
  assert.equal(lastIdle?.reason, "a_fresh_reading", "the run is still owed a read, and still says so");
  assert.equal(
    lastIdle?.ask,
    "attempts_spent",
    "what changed is that the read can no longer be taken - which is on the line",
  );
  run.service.close();
});
