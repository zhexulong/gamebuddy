import assert from "node:assert/strict";
import test from "node:test";
import { createCompanionInterruption } from "./companion-interruption.js";
import { CompanionEventPump, MOD_STALL_VERDICT_CODE, STARDEW_TICKS_PER_SECOND, type WorldFact } from "./event-pump.js";
import { CompanionHostService } from "./host-service.js";
import type { InFlightProgrammeReading } from "./program-status-wait.js";

/**
 * A stall must wake someone, and this is the layer that owns waking - WITHOUT owning a clock.
 *
 * <p>
 * MEASURED 2026-11-08 (`round43`): the Mod owned an execution and then published nothing for more than 180 s while the
 * receipt still said `running`, and no turn was created. The cure then was one timer measuring the silence - and that
 * timer is the defect this suite now pins the other side of: a wall-clock distance cannot tell "running", "waiting for the
 * engine", "stalled" and "gone" apart, and a run whose Mod had stopped emitting traces read as one long stall.
 * </p>
 * <p>
 * WHAT REPLACED IT: the body controller's own verdict (`stalled_waiting`, with `reason` and `stalled_ticks`), minted into a
 * decision fact the moment the receipt carrying it is admitted, and announced only while the programme's own journal still
 * shows its work in flight. The loop below is a double, but the PUMP is real: the question here is whether a Host with no
 * timer ever starts a turn for a stalled execution, and whether it stays silent for one that is merely slow.
 * </p>
 */

function receipt(state: string, executionId: string, extra: Readonly<Record<string, unknown>> = {}): WorldFact {
  return {
    source: "stardew_mod",
    kind: "execution_receipt",
    eventId: `${executionId}_${state}_${JSON.stringify(extra)}`,
    sourceEventId: `${executionId}_${state}`,
    correlationId: executionId,
    executionId,
    revision: 1,
    occurredAtMs: Date.now(),
    payload: { state, executionId, actionId: "sleep", ...extra },
  };
}

/** The body controller's verdict, as it is written on the wire (`StardewBodyController.cs:1174`). */
function verdict(executionId: string, ticks = 180): WorldFact {
  return {
    source: "stardew_mod",
    kind: "execution_receipt",
    eventId: `${executionId}_verdict_${String(ticks)}`,
    sourceEventId: `${executionId}_running`,
    correlationId: executionId,
    executionId,
    revision: 2,
    occurredAtMs: Date.now(),
    payload: {
      state: "running",
      executionId,
      actionId: "sleep",
      reasonCode: MOD_STALL_VERDICT_CODE,
      evidence: { detail: `reason=entity_block;tile=40,5;target=44,5;stalled_ticks=${String(ticks)};wait_ticks=60` },
    },
  };
}

/** One programme the journal still shows in flight. */
function livenessReading(inFlight: boolean): InFlightProgrammeReading {
  return Object.freeze({
    programmes: Object.freeze(
      inFlight
        ? [
            Object.freeze({
              programId: "plan_sleep",
              total: 1,
              settled: 0,
              remaining: 1,
              readAgeMs: 10,
              nodes: Object.freeze([
                Object.freeze({
                  index: 0,
                  nodeId: "n001",
                  actionId: "sleep",
                  state: "running",
                  observedInStateMs: 3_000,
                }),
              ]),
              omitted: 0,
            }),
          ]
        : [],
    ),
    omittedProgrammes: 0,
  });
}

function stallHarness({ inFlight = true }: { inFlight?: boolean } = {}) {
  const pump = new CompanionEventPump(() => livenessReading(inFlight));
  const prompts: string[] = [];
  let factListener: ((fact: WorldFact) => void) | undefined;
  const loop = {
    pump,
    async flush() {
      return await pump.flush({
        async deliver(batch) {
          prompts.push(batch.text);
        },
      });
    },
    async abortAndClear() {},
    async steer() {
      return false;
    },
    hasQueuedPlayerDelivery: false,
  };
  const service = new CompanionHostService(
    loop as never,
    {
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
    undefined,
    createCompanionInterruption(),
    async () => undefined,
    async () => undefined,
  );
  return {
    service,
    prompts,
    emit(fact: WorldFact) {
      factListener?.(fact);
    },
  };
}

/** Let the Host's microtask-coalesced flush run to completion; `setImmediate` is not one of the mocked APIs. */
async function drain(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

test("falsifier① a running execution that publishes nothing for ten minutes wakes no turn", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const harness = stallHarness();
  harness.emit(receipt("running", "exec_sleep"));
  await drain();
  assert.equal(harness.prompts.length, 0, "a `running` receipt is progress and starts no turn");

  // ZERO facts arrive for ten minutes. The programme's own state says the work is still running, and no authority says
  // otherwise - which is the whole difference from a clock: silence is not evidence of anything.
  for (let minute = 0; minute < 10; minute += 1) {
    t.mock.timers.tick(60_000);
    await drain();
  }
  assert.equal(
    harness.prompts.length,
    0,
    "ten minutes of a live programme produced no stall turn and no timer to fire",
  );
  harness.service.close();
});

test("falsifier② a stalled execution wakes exactly one turn, and the turn carries the verdict", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const harness = stallHarness();
  harness.emit(receipt("running", "exec_sleep"));
  await drain();
  assert.equal(
    harness.prompts.length,
    0,
    "a `running` receipt is progress and starts no turn, which is exactly why its silence had no voice",
  );

  harness.emit(verdict("exec_sleep", 180));
  await drain();
  assert.equal(harness.prompts.length, 1, "the Mod's verdict is the one thing that says the body is waiting");
  const prompt = harness.prompts[0] ?? "";
  assert.match(prompt, /sleep 卡住不动了/u, "the turn is triggered by, and carries, the stall fact");
  assert.match(prompt, /原因 entity_block/u, "and it names what the body is waiting for, in the Mod's own word");
  assert.match(
    prompt,
    new RegExp(`已等 ${String((180 * 1000) / STARDEW_TICKS_PER_SECOND / 1000)} 秒`, "u"),
    "and how long the Mod says it has waited",
  );

  // A second copy of the same verdict, and then a long silence: one verdict is one turn, and no clock follows it.
  harness.emit(verdict("exec_sleep", 180));
  await drain();
  t.mock.timers.tick(600_000);
  await drain();
  assert.equal(harness.prompts.length, 1, "the announcement is not re-armed by anything the Host measures itself");
  harness.service.close();
});

test("a verdict for work the journal no longer runs wakes no turn", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const harness = stallHarness({ inFlight: false });
  harness.emit(receipt("running", "exec_sleep"));
  harness.emit(verdict("exec_sleep"));
  await drain();
  assert.equal(
    harness.prompts.length,
    0,
    "the programme's own state says the work is over, so a verdict left behind it is not news the Host may announce",
  );
  harness.service.close();
});

test("a verdict that arrives after its execution settled wakes no turn", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  // The journal says no programme is running, so nothing can be waiting.
  const harness = stallHarness({ inFlight: false });
  harness.emit(receipt("running", "exec_sleep"));
  harness.emit(receipt("succeeded", "exec_sleep"));
  await drain();
  // A transport that replayed, or a verdict that overtook its own terminal.
  harness.emit(verdict("exec_sleep"));
  await drain();
  const stallTurns = harness.prompts.filter((prompt) => prompt.includes("卡住不动了"));
  assert.deepEqual(
    stallTurns,
    [],
    "the programme's own state says the work is over, so nothing is waiting for anything",
  );
  harness.service.close();
});
