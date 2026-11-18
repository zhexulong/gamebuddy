import assert from "node:assert/strict";
import test from "node:test";

import { CompanionLoop } from "./companion-loop.js";
import {
  BACKLOG_TURNS_OPENED,
  CARRIED_BACKLOG_BOUND_MS,
  type CompanionEventPump,
  FACT_PRODUCER,
  HELD,
  turnAccountLine,
} from "./event-pump.js";
import { CompanionHostService } from "./host-service.js";

/**
 * `a_held_fact_has_no_reader:host` - the DRIVER, and the two ways a driver goes wrong.
 *
 * <p>
 * THE RUN THAT MADE IT NECESSARY. `round72` (2026-11-18, and `round69` before it): `carried 21 · consumed 16 · lost 0 ·
 * held 5` and then **166 seconds** with a single `idle` span - which is this layer's own proof that no `flushSoon` ran,
 * because `#beginIdle`/`#endIdle` bracket every call to it. The pump's bound
 * (`CARRIED_BACKLOG_BOUND_MS`) says when a wait becomes news about the backlog; a turn is created by `flush`, and `flush`
 * is the Host's to call. So the driver is here and the fact is in the pump, and these cases are the seam between them.
 * </p>
 *
 * <p>
 * WHY IT IS NOT INSIDE THE PUMP. A pump-owned timer would call `flush` with a sink it had stored from an earlier turn -
 * behind `#flushScheduled`, the delivery guard, the provider-wait trace and the presentation lease - and a second delivery
 * is the one outcome this whole path exists to prevent. The falsifier for that is the second case below: a turn still in
 * flight when the bound passes must produce NO second turn.
 * </p>
 *
 * <p>
 * THE TIMER IS MOCKED RATHER THAN WAITED OUT. `CARRIED_BACKLOG_BOUND_MS` is one measured turn (42.3 s); a test that proved
 * the timer by sleeping it would be a test nobody keeps. `node:test`'s timer mock moves both the clock the pump reads and the
 * timeout the Host armed, so what is measured here is the product's own arithmetic - `dueInMs` - and not a number this file
 * chose.
 * </p>
 */

const BASE_MS = 1_700_000_000_000;

/** Enough microtask turns for one `flushSoon` (which awaits a promise and then a delivery) to finish. */
async function settle(): Promise<void> {
  for (let index = 0; index < 16; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
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
 * A Pi session that answers with one spoken line, and whose NEXT answer waits for the test to release it.
 *
 * The hold is what the second case needs: a turn in flight is the state in which a timer must not buy another one.
 */
function scriptedSession() {
  const listeners = new Set<(event: unknown) => void>();
  const prompts: string[] = [];
  let held: Promise<void> | undefined;
  let release: (() => void) | undefined;
  const emit = (event: unknown): void => {
    for (const listener of [...listeners]) listener(event);
  };
  const answer = (batch: string): void => {
    emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: batch }] } });
    emit({
      type: "message_start",
      message: { role: "assistant", content: [], provider: "cpa-oai" },
    });
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "记下了。" }],
        stopReason: "stop",
      },
    });
    emit({ type: "agent_settled", aborted: false });
  };
  return {
    prompts,
    /** Make the next answer hang until `unhold()`, which is one turn in flight. */
    holdNext() {
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    unhold() {
      release?.();
      release = undefined;
      held = undefined;
    },
    session: {
      subscribe(listener: (event: unknown) => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      async sendUserMessage(batch: string) {
        prompts.push(batch);
        if (held !== undefined) await held;
        answer(batch);
      },
      async abort() {},
      clearQueue() {},
      async waitForIdle() {},
    },
  };
}

/** A node's terminal receipt: it owes her the news and can never present, so it is exactly what gets carried. */
function terminalReceipt(index: number) {
  return {
    source: "stardew_mod",
    kind: "execution_receipt" as const,
    eventId: `receipt_succeeded_${String(index)}`,
    correlationId: `receipt_succeeded_${String(index)}`,
    revision: 1,
    occurredAtMs: BASE_MS,
    executionId: `exec_${String(index)}`,
    requestId: `request_${String(index)}`,
    payload: {
      actionId: "harvest_crop",
      state: "succeeded",
      reasonCode: "crop_harvested",
      revision: 1,
      evidence: null,
      origin: { kind: "programme", programId: "plan_1", nodeId: "n001" },
    },
  };
}

/** The Mod's own clock mark: presentable, so it opens a turn the surface can show. */
function milestone(index: number) {
  return {
    source: "stardew_mod",
    kind: "world_fact" as const,
    eventId: `time_milestone_${String(index)}`,
    sourceEventId: `time_milestone_${String(index)}`,
    correlationId: `time_milestone_${String(index)}`,
    revision: 400 + index,
    occurredAtMs: BASE_MS,
    semanticKind: "time_milestone",
    payload: { kind: "time_milestone", milestone: "1200" },
  };
}

function host() {
  const adapter = eventHarness();
  const scripted = scriptedSession();
  const loop = new CompanionLoop(scripted.session as never);
  const service = new CompanionHostService(loop, adapter.events as never);
  return { adapter, scripted, loop, service };
}

test("a_held_fact_has_no_reader:host - the bound opens the turn a silent run owes, and prints that it did", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: BASE_MS });
  const { adapter, scripted, loop, service } = host();

  adapter.emit(terminalReceipt(1));
  await settle();
  assert.deepEqual(scripted.prompts, [], "a terminal receipt owes no turn of its own: this is round72's held fact");
  const waiting = loop.pump.turnAccount.carry;
  assert.equal(waiting.held, 1, "the pump is carrying it");
  assert.equal(
    loop.pump.carriedBacklog.dueInMs,
    CARRIED_BACKLOG_BOUND_MS,
    "and the reading the Host arms from is the product's own bound, measured from the first time it was waiting",
  );

  // THE SILENCE, in the unit the bound is written in. Nothing else arrives - no clock mark, no notice, no settlement.
  t.mock.timers.tick(CARRIED_BACKLOG_BOUND_MS);
  await settle();

  assert.equal(scripted.prompts.length, 1, `the timer must open exactly one turn (${String(scripted.prompts.length)})`);
  assert.match(
    scripted.prompts[0] ?? "",
    /有 1 份结果没读到/u,
    `and that turn must say what it is for: ${scripted.prompts[0] ?? ""}`,
  );
  const carry = loop.pump.turnAccount.carry;
  assert.equal(carry.named, 1, "one backlog fact, not one per held fact");
  assert.equal(carry.held, 0, "and nothing is left waiting after it");
  assert.match(
    turnAccountLine(loop.pump.turnAccount),
    new RegExp(`${BACKLOG_TURNS_OPENED} 1`, "u"),
    "the account a run's log carries must say the bound opened a turn, so a 166-second silence cannot be invisible again",
  );
  assert.equal(loop.pump.carriedBacklog.dueInMs, undefined, "and after it there is nothing left to be due");
  service.close();
});

/**
 * THE FALSIFIER THAT PROVES WHERE THE DRIVER LIVES: a turn already in flight is not a second turn.
 *
 * <p>
 * The timer is armed while the Host is idle with held facts; then a presentable fact opens a turn the test holds open. If
 * the driver were a pump-owned timer calling `flush` with a stored sink, this is the case where it would deliver a second
 * batch behind `#flushScheduled`. Asserted both ways: one prompt, one delivered batch, and no backlog fact.
 * </p>
 */
test("a_held_fact_has_no_reader:host - a turn in flight when the bound passes is not a second turn", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: BASE_MS });
  const { adapter, scripted, loop, service } = host();

  adapter.emit(terminalReceipt(1));
  await settle();
  assert.equal(loop.pump.carriedBacklog.dueInMs, CARRIED_BACKLOG_BOUND_MS, "the timer is armed for the held fact");

  // A presentable fact arrives first: the world's own turn, which the test then holds open.
  scripted.holdNext();
  adapter.emit(milestone(2));
  await settle();
  assert.equal(scripted.prompts.length, 1, "the presentable fact opened the turn, and it absorbed the held fact");

  // The bound passes while that turn is still running. Twice, so a timer that re-armed on its own tick would show itself.
  t.mock.timers.tick(CARRIED_BACKLOG_BOUND_MS);
  await settle();
  t.mock.timers.tick(CARRIED_BACKLOG_BOUND_MS);
  await settle();

  assert.equal(scripted.prompts.length, 1, "a turn in flight is not interrupted by a second one");
  assert.equal(
    loop.pump.turnAccount.carry.held,
    0,
    `the held fact was consumed by that turn, not left waiting (${turnAccountLine(loop.pump.turnAccount)})`,
  );
  assert.equal(
    loop.pump.turnAccount.carry.named,
    0,
    "and no backlog fact was minted: the account cannot claim the bound fired when no turn starts",
  );
  scripted.unhold();
  await settle();
  service.close();
});

/**
 * THE OTHER FALSIFIER: an empty ledger never arms the timer.
 *
 * <p>
 * The cheapest wrong shape - "arm a timer when nothing is owed" without asking whether anything waits - would make an idle
 * companion speak every 42 s. That is `round45`'s five narrated turns, at a schedule. It is asserted here at the Host's own
 * seam, because this is the layer that owns the timer.
 * </p>
 */
test("a_held_fact_has_no_reader:host - nothing held, nothing armed, however long the silence lasts", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: BASE_MS });
  const { adapter, scripted, loop, service } = host();

  // A reading and nothing else: a reading is standing state, so it opens no turn and ticketed no fact - the ledger is
  // empty, which is the state this case is about.
  adapter.emit({
    source: "stardew_mod",
    kind: "snapshot" as const,
    eventId: "snapshot_1",
    correlationId: "snapshot_1",
    revision: 1,
    occurredAtMs: BASE_MS,
    payload: { revision: 1, location: "Farm", timeOfDay: 600 },
  });
  await settle();
  assert.equal(loop.pump.carriedBacklog.dueInMs, undefined, "the pump says nothing will ever be due");

  t.mock.timers.tick(CARRIED_BACKLOG_BOUND_MS * 10);
  await settle();

  assert.equal(
    scripted.prompts.length,
    0,
    `an empty ledger must not speak (${String(scripted.prompts.length)} prompt(s))`,
  );
  assert.equal(loop.pump.turnAccount.carry.named, 0, "and the account says the bound never fired");
  service.close();
});

/**
 * The reading itself, printed once, so a reader of this file's output sees the same numbers the gates assert.
 */
test("a_held_fact_has_no_reader:host - the account prints the bound it was measured against", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: BASE_MS });
  const { adapter, loop, service } = host();
  adapter.emit(terminalReceipt(1));
  await settle();
  t.mock.timers.tick(CARRIED_BACKLOG_BOUND_MS);
  await settle();
  const account = loop.pump.turnAccount;
  console.log(`${HELD} ${String(account.carry.held)} · ${BACKLOG_TURNS_OPENED} ${String(account.carry.named)}`);
  assert.equal(account.carry.named, 1);
  service.close();
});

/** The pump's own producer for the backlog: named here so the accounting test above cannot credit the wrong entrance. */
test("a_held_fact_has_no_reader:host - the turn credits the pump's own entrance", () => {
  assert.equal(FACT_PRODUCER.carriedBacklog, "carried_backlog");
});
