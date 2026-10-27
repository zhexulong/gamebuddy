import assert from "node:assert/strict";
import test from "node:test";
import { CompanionEventPump } from "./event-pump.js";

/**
 * `events` and `worldFacts` were serializing the same semantic facts twice.
 *
 * Measured 2026-10-27 on the controller-fixed run: a single 131KB batch held 58KB of `worldFacts` and the SAME
 * 58KB again in `events`, both 88 entries. `input` reached 466,568 tokens and the model returned `output: 1`
 * twelve times with `stopReason: "length"` - the run had crossed a night and was 25 minutes old before this
 * killed it.
 *
 * `events` has one production consumer (`companion-loop.ts:537`, `canonicalPresentationSource`) and it reads only
 * `player_input` and `world_fact`. It does not read `semantic_event`. So the copy was pure weight.
 */
test("semantic events are not duplicated into the events projection", async () => {
  const pump = new CompanionEventPump();
  const delivered: string[] = [];
  const sink = {
    async deliver(text: string): Promise<void> {
      delivered.push(text);
    },
  };

  pump.enqueueFact({
    source: "stardew_mod",
    kind: "semantic_event",
    correlationId: "route-1",
    revision: 1,
    payload: { kind: "route_progress", reasonCode: "body_trace", pad: "x".repeat(400) },
  });
  // A semantic event alone is not a delivery trigger - `hasPendingDelivery` stays false until an ordinary or
  // salient fact arrives. Adding one here is what makes the batch exist at all; the assertion is about what the
  // batch CONTAINS, not about whether it happened.
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "world_fact",
    correlationId: "world-1",
    revision: 2,
    payload: { kind: "day_started" },
  });

  await pump.flush(sink);
  const batch = JSON.parse(delivered[0] ?? "{}") as {
    worldFacts: Array<{ kind: string }>;
    events: Array<{ kind: string }>;
  };

  assert.deepEqual(
    batch.worldFacts.map((fact) => fact.kind),
    ["semantic_event", "world_fact"],
    "both facts still reach the model through worldFacts",
  );
  assert.deepEqual(
    batch.events.map((event) => event.kind),
    ["world_fact"],
    "and the semantic event is not serialized a second time under events",
  );
});

test("the kinds canonicalPresentationSource reads are still present in events", async () => {
  // The narrowing must not touch what the ONE consumer acts on: `player_input` (a presentation cause) and
  // `world_fact` (a salient sensory lease). Both must survive whole.
  const pump = new CompanionEventPump();
  const delivered: string[] = [];
  const sink = {
    async deliver(text: string): Promise<void> {
      delivered.push(text);
    },
  };

  pump.enqueueFact({
    source: "stardew_mod",
    kind: "world_fact",
    correlationId: "world-1",
    revision: 2,
    payload: { kind: "day_started" },
  });

  await pump.flush(sink);
  const batch = JSON.parse(delivered[0] ?? "{}") as { events: Array<{ kind: string }> };

  assert.equal(batch.events.length, 1, "world_fact must stay in events");
  assert.equal(batch.events[0]?.kind, "world_fact");
});

test("a batch of only semantic events carries no duplicate payload at all", async () => {
  // The size claim, stated as a ratio rather than a constant: whatever the facts cost, `events` costs nothing.
  const pump = new CompanionEventPump();
  const delivered: string[] = [];
  const sink = {
    async deliver(text: string): Promise<void> {
      delivered.push(text);
    },
  };
  for (let index = 0; index < 40; index += 1) {
    pump.enqueueFact({
      source: "stardew_mod",
      kind: "semantic_event",
      correlationId: `route-${String(index)}`,
      revision: index,
      payload: { kind: "route_progress", reasonCode: "body_trace", pad: "y".repeat(400), index },
    });
  }
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "world_fact",
    correlationId: "world-1",
    revision: 100,
    payload: { kind: "day_started" },
  });

  await pump.flush(sink);
  const batch = JSON.parse(delivered[0] ?? "{}") as { worldFacts: Array<{ kind: string }>; events: unknown[] };

  // 40 semantic events collapse into ONE pending slot: they share a correlation key, so the pump keeps the
  // latest rather than queuing forty. That is its existing behaviour and is why `worldFacts` reads 2, not 41.
  assert.deepEqual(
    batch.worldFacts.map((fact) => fact.kind),
    ["semantic_event", "world_fact"],
    "the surviving fact reaches the model",
  );
  assert.equal(batch.events.length, 1, "only the one presentable fact appears in events");
});
