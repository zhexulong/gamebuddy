import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { CompanionLoop } from "./companion-loop.js";
import type { WorldFact } from "./event-pump.js";
import { CompanionHostService } from "./host-service.js";
import { programStatusProgress } from "./program-status-wait.js";
import { createRunTrace, RUN_SPAN_NAMES } from "./run-trace.js";
import { RUN_BETWEEN_CALL_SPANS, RUN_WAIT_NAMES } from "./run-trace-budget.js";

/**
 * THE STEPS BETWEEN TWO MODEL CALLS, each with its own span.
 *
 * <p>
 * Round62's wall clock (2,065.6 s) was provider 1,708.1 s, environment 83.3 s, our code 4.6 s, and 269.6 s that nothing
 * attributed - while the longest single model round-trip was 21.5 s and the longest stretch with no observable event was
 * 175.6 s. The hole was not the calls; it was what happened between them. This file drives the seams that can be driven
 * here and gates the ones that are emitted inside a mount.
 * </p>
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST_SRC = join(HERE, "..", "..", "host", "src");

const tick = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

const fact = (kind: WorldFact["kind"], revision: number): WorldFact => ({
  source: "arcade_adapter",
  kind,
  eventId: `${kind}_${String(revision)}`,
  occurredAtMs: revision,
  correlationId: `${kind}_${String(revision)}`,
  revision,
  payload: { revision },
});

/** The `CompanionHostService` constructor, with the recorder last and everything before it a test double. */
function service(loop: unknown, events: unknown, trace: ReturnType<typeof createRunTrace>): CompanionHostService {
  return new CompanionHostService(
    loop as never,
    events as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    trace,
  );
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
    emit(next: WorldFact) {
      factListener?.(next);
    },
  };
}

/** The pump surface the Host service reads, with the stale-reading route scripted by the test. */
function serviceLoop(
  options: Readonly<{ staleFacts?: readonly WorldFact[]; pending?: boolean; failure?: string }> = {},
) {
  const staleFacts = [...(options.staleFacts ?? [])];
  return {
    pump: {
      hasPendingDelivery: options.pending === true,
      enqueueFact() {},
      enqueuePlayerInput() {},
      takeWorldStateStaleFact: () => staleFacts.shift(),
    },
    async flush() {
      // A provider refusal leaves the exact batch in the pump, which is the one state where "another turn is owed"
      // survives a flush. A pump double that never drains would instead re-enter the Host's own drain loop forever.
      if (options.failure !== undefined) throw new Error(options.failure);
    },
  };
}

test("a flush that leaves nothing owed opens ONE named idle wait, and the next flush closes it", async () => {
  const clock = { now: 0 };
  const trace = createRunTrace("run_idle", { now: () => clock.now });
  const harness = eventHarness();
  const serviceUnderTest = service(serviceLoop(), harness.events, trace);

  clock.now = 1_000;
  serviceUnderTest.acceptHostMintedFact(fact("world_fact", 1), "stall_watch");
  await tick();
  clock.now = 1_600;
  serviceUnderTest.acceptHostMintedFact(fact("world_fact", 2), "stall_watch");
  await tick();
  clock.now = 2_000;
  serviceUnderTest.close();

  const idle = trace.spans().filter((span) => span.name === RUN_WAIT_NAMES.idle);
  assert.equal(idle.length, 2, "one per silence, and the second flush ends the first");
  assert.deepEqual(
    idle.map((span) => [span.startMs, span.endMs]),
    [
      [1_000, 1_600],
      [1_600, 2_000],
    ],
    "each wait is measured up to the moment the next turn is owed, and close() ends the last one",
  );
  assert.equal(idle[0]!.attributes.reason, "nothing_owed");
});

test("a flush that still owes a turn does not open an idle wait", async () => {
  const clock = { now: 0 };
  const trace = createRunTrace("run_pending", { now: () => clock.now });
  const harness = eventHarness();
  const serviceUnderTest = service(
    serviceLoop({
      pending: true,
      failure:
        '429: {"type":"server_error","message":"Upstream request failed: [prefill_cap_refused] the cell is at capacity; retry shortly (after 30 s)"}',
    }),
    harness.events,
    trace,
  );

  clock.now = 500;
  serviceUnderTest.acceptHostMintedFact(fact("world_fact", 3), "stall_watch");
  await tick();
  clock.now = 900;
  serviceUnderTest.close();

  assert.deepEqual(
    trace.spans().filter((span) => span.name === RUN_WAIT_NAMES.idle),
    [],
    "pending work is not a silence: another turn is already owed",
  );
  assert.equal(
    serviceUnderTest.lastProviderFailure,
    "rate_limited",
    "the refusal is recorded by the class the Host names",
  );
});

test("a stale reading names the wait for a fresh snapshot, and the snapshot ends it", async () => {
  const clock = { now: 0 };
  const trace = createRunTrace("run_stale", { now: () => clock.now });
  const harness = eventHarness();
  const serviceUnderTest = service(serviceLoop({ staleFacts: [fact("world_fact", 7)] }), harness.events, trace);

  clock.now = 100;
  harness.emit(fact("snapshot", 10));
  await tick();
  clock.now = 900;
  harness.emit(fact("snapshot", 11));
  await tick();
  clock.now = 1_200;
  serviceUnderTest.close();

  const waits = trace.spans().filter((span) => span.name === RUN_WAIT_NAMES.snapshot);
  assert.equal(waits.length, 1, "the pump minted one stale fact, so there is one wait");
  assert.deepEqual([waits[0]!.startMs, waits[0]!.endMs], [100, 900]);
  assert.equal(waits[0]!.attributes.trigger, "world_state_stale");
});

test("a batch reaching Pi is a delivery span, and the turn's ending is a tail span", async () => {
  const clock = { now: 0 };
  const trace = createRunTrace("run_delivery", { now: () => clock.now });
  const listeners = new Set<(event: unknown) => void>();
  const emit = (event: unknown): void => {
    for (const listener of [...listeners]) listener(event);
  };
  const session = {
    async sendUserMessage(text: string) {
      // Pi consumed THIS batch, 500 ms after the Host handed it over.
      clock.now = 1_500;
      emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } });
      clock.now = 2_000;
      emit({
        type: "message_end",
        message: { id: "assistant_1", role: "assistant", content: [{ type: "text", text: "Hi." }] },
      });
      // The last words are out; the turn settles 600 ms later.
      clock.now = 2_600;
      emit({ type: "agent_settled" });
    },
    async abort() {},
    clearQueue() {},
    async waitForIdle() {},
    subscribe(next: (event: unknown) => void) {
      listeners.add(next);
      return () => {
        listeners.delete(next);
      };
    },
  };
  const loop = new CompanionLoop(session as never, undefined, undefined, undefined, undefined, undefined, trace);

  loop.pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "input_1",
    eventId: "input_1",
    text: "hello",
    locale: "en-US",
    timestampMs: 0,
  });
  clock.now = 1_000;
  await loop.flush();

  const spans = trace.spans();
  const delivery = spans.filter((span) => span.name === RUN_SPAN_NAMES.delivery);
  const tail = spans.filter((span) => span.name === RUN_SPAN_NAMES.turnTail);
  assert.equal(delivery.length, 1, "one batch is one delivery");
  assert.deepEqual([delivery[0]!.startMs, delivery[0]!.endMs], [1_000, 1_500], "handed over -> Pi consumed it");
  // A player input is delivered as a steer: the span must carry the kind of delivery it measured, not a blank.
  assert.equal(delivery[0]!.attributes.disposition, "steer");
  assert.equal(tail.length, 1, "one turn is one ending");
  assert.deepEqual([tail[0]!.startMs, tail[0]!.endMs], [2_000, 2_600], "last words -> Pi settled");
  assert.deepEqual(
    spans.filter((span) => span.endMs === null).map((span) => span.name),
    [],
    "a settled turn leaves no open span that would read like a frozen stage",
  );
});

/** Every non-test TypeScript source under `host/src`, as text. */
function sourceFiles(dir: string): readonly { path: string; text: string }[] {
  const files: { path: string; text: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "test-fixtures") continue;
      files.push(...sourceFiles(path));
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    if (/\.test(-support|-fixtures)?\.ts$/u.test(entry.name)) continue;
    // The two files that DECLARE the vocabulary are not emitters: what is asked for is a call site beside the step.
    if (entry.name === "run-trace.ts" || entry.name === "run-trace-budget.ts") continue;
    files.push({ path, text: readFileSync(path, "utf8") });
  }
  return files;
}

/** How a call site names one span: the declaration's own member expression, never a copied string. */
function referenceOf(name: string): string | undefined {
  for (const [key, value] of Object.entries(RUN_SPAN_NAMES)) if (value === name) return `RUN_SPAN_NAMES.${key}`;
  for (const [key, value] of Object.entries(RUN_WAIT_NAMES)) if (value === name) return `RUN_WAIT_NAMES.${key}`;
  return undefined;
}

/** Which of `names` no non-test source USES, by its declaration member. */
function namesWithNoEmitter(names: readonly string[], sources: readonly { text: string }[]): readonly string[] {
  return names.filter((name) => {
    const reference = referenceOf(name);
    if (reference === undefined) return true;
    return !sources.some((source) => source.text.includes(reference));
  });
}

test("every declared between-call span is emitted at a call site beside its step", () => {
  // POPULATION FROM THE DECLARATION: add a name to RUN_BETWEEN_CALL_SPANS and this fails until something references it
  // outside the taxonomy's own file. That is the gate the audit's finding C needed - `wait.model` was declared, tested,
  // and had no live caller at all.
  const sources = sourceFiles(HOST_SRC);
  assert.ok(sources.length > 100, `the scan must read the sources, and read ${String(sources.length)}`);
  assert.deepEqual(namesWithNoEmitter(RUN_BETWEEN_CALL_SPANS, sources), []);
});

test("the falsifier: a declared span nothing emits is reported by name", () => {
  // The guard above is only a guard if it can go red on the shape it exists to catch.
  const sources = sourceFiles(HOST_SRC);
  assert.deepEqual(namesWithNoEmitter([...RUN_BETWEEN_CALL_SPANS, "wait.invented"], sources), ["wait.invented"]);
});

/**
 * THE WIRED READING: the idle span asks the journal's ledger, and names the executor when her own plan has nodes left.
 *
 * <p>
 * The pure decision is gated in `program-status-wait.idle-reason.test.ts`; this is the one case that proves the span is
 * built from it rather than from a literal. It is the last case in this file because it fills the process-wide ledger
 * every earlier case here runs without, and a case that ran after it would be reading a state it did not create.
 * </p>
 */
test("the idle wait names her own executor when the journal still shows a node to run", async () => {
  const clock = { now: 0 };
  const trace = createRunTrace("run_body_idle", { now: () => clock.now });
  const harness = eventHarness();
  const serviceUnderTest = service(serviceLoop(), harness.events, trace);

  const now = Date.now();
  programStatusProgress.observe(
    {
      code: "found",
      snapshot: {
        programId: "plan_body_idle",
        state: "active",
        catalogRevision: 3,
        stopEpoch: 0,
        eventHighWater: 7,
        nodes: [
          { nodeId: "n001", state: "succeeded", nodeAttempt: 0, admissionAttempt: 0, actionId: "water_crop" },
          { nodeId: "n002", state: "running", nodeAttempt: 0, admissionAttempt: 0, actionId: "water_crop" },
        ],
      },
    },
    now,
  );

  clock.now = 1_000;
  serviceUnderTest.acceptHostMintedFact(fact("world_fact", 11), "stall_watch");
  await tick();
  clock.now = 1_400;
  serviceUnderTest.close();

  const idle = trace.spans().filter((span) => span.name === RUN_WAIT_NAMES.idle);
  assert.equal(idle.length, 1, "the flush owed no turn, so it opened one wait");
  assert.equal(
    idle[0]!.attributes.reason,
    "body_still_working",
    `the wait was ours, not the world's: ${JSON.stringify(idle[0]!.attributes)}`,
  );
  assert.equal(idle[0]!.attributes.remaining, 1, "and the run says how many nodes it was waiting on");
});
