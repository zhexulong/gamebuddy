import assert from "node:assert/strict";
import test from "node:test";
import { createCompanionInterruption } from "./companion-interruption.js";
import {
  CompanionEventPump,
  EXECUTION_STALL_BOUND_MS,
  EXECUTION_STALL_REARM_MULTIPLE,
  type WorldFact,
} from "./event-pump.js";
import { CompanionHostService } from "./host-service.js";

/**
 * A stall must wake someone, and this is the layer that owns waking.
 *
 * Measured 2026-11-08 (`round43`): the Mod owned an execution, then published nothing for more than 180 s while the
 * receipt still said `running`; her session's last record was 3+ minutes old, no new observation ever came, `stop_action`
 * was dispatched zero times, and no turn was created. Every other turn start in `HostService` needs a fact to ARRIVE, and
 * the whole shape of a stall is that none does - so the pump measures the silence (`stallWatch`) and this layer's one
 * timer decides that the silence is now a turn.
 *
 * The loop below is a double, but the PUMP is real: the question here is whether a Host with no incoming facts ever
 * starts a turn, and the model-facing content of that turn is the fact the pump actually minted.
 */

function receipt(state: string, executionId: string, extra: Readonly<Record<string, unknown>> = {}): WorldFact {
  return {
    source: "stardew_mod",
    kind: "execution_receipt",
    eventId: `${executionId}_${state}`,
    sourceEventId: `${executionId}_${state}`,
    correlationId: executionId,
    executionId,
    revision: 1,
    occurredAtMs: Date.now(),
    payload: { state, executionId, actionId: "sleep", ...extra },
  };
}

function stallHarness() {
  const pump = new CompanionEventPump();
  const prompts: string[] = [];
  let factListener: ((fact: WorldFact) => void) | undefined;
  const loop = {
    pump,
    async flush() {
      return await pump.flush({
        async deliver(text) {
          prompts.push(text);
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

test("a silent execution wakes a turn at the bound, and the turn carries the stall fact", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const harness = stallHarness();
  harness.emit(receipt("running", "exec_sleep"));
  await drain();
  assert.equal(
    harness.prompts.length,
    0,
    "a `running` receipt is progress and starts no turn, which is exactly why its silence had no voice",
  );

  // ZERO facts arrive for the rest of the bound.
  t.mock.timers.tick(EXECUTION_STALL_BOUND_MS - 1);
  await drain();
  assert.equal(harness.prompts.length, 0, "silence below the bound is an ordinary gap between observations");

  t.mock.timers.tick(1);
  await drain();
  assert.equal(harness.prompts.length, 1, "the bound is where the silence becomes a turn");
  const prompt = harness.prompts[0] ?? "";
  assert.match(prompt, /execution_stalled/u, "the turn is triggered by, and carries, the stall fact");
  assert.match(prompt, /exec_sleep/u, "and it names which execution is stuck");
  harness.service.close();
});

test("an execution that settles normally never produces a stall turn", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const harness = stallHarness();
  harness.emit(receipt("running", "exec_sleep"));
  await drain();
  t.mock.timers.tick(60_000);
  harness.emit(receipt("succeeded", "exec_sleep"));
  await drain();
  assert.equal(harness.prompts.length, 1, "the terminal receipt is the only turn this execution needs");

  t.mock.timers.tick(EXECUTION_STALL_BOUND_MS * 10);
  await drain();
  assert.equal(harness.prompts.length, 1, "a settled execution leaves no timer behind to fire at");
  harness.service.close();
});

test("ten minutes of one stalled execution is two stall turns, not seven", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const harness = stallHarness();
  harness.emit(receipt("running", "exec_sleep"));
  await drain();

  t.mock.timers.tick(EXECUTION_STALL_BOUND_MS);
  await drain();
  t.mock.timers.tick(EXECUTION_STALL_BOUND_MS * (EXECUTION_STALL_REARM_MULTIPLE - 1));
  await drain();
  t.mock.timers.tick(EXECUTION_STALL_BOUND_MS);
  await drain();

  const stallTurns = harness.prompts.filter((prompt) => prompt.includes("execution_stalled"));
  assert.equal(
    stallTurns.length,
    2,
    "the re-arm multiple bounds a long stall to a handful of turns, not one per bound",
  );
  harness.service.close();
});

test("with nothing in flight no timer is armed at all", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const harness = stallHarness();
  harness.emit({
    source: "stardew_mod",
    kind: "snapshot",
    eventId: "snapshot_1",
    correlationId: "snapshot_1",
    revision: 1,
    payload: { location: "Farm" },
  });
  await drain();

  t.mock.timers.tick(EXECUTION_STALL_BOUND_MS * 10);
  await drain();
  assert.equal(harness.prompts.length, 0, "a snapshot is state, not a turn - and there is nothing to be stalled");
  harness.service.close();
});
