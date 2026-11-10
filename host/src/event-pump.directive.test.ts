/**
 * The batch carries the directive - the half of the fix that makes the day's note state instead of an utterance.
 *
 * Measured 2026-11-10 (`round44`): the note reached the model once as `player_texts[0]` and no later batch carried it, so
 * by 04:00:18 its own words had 0 carriers while 31 described the work it had superseded. The assertion below is
 * therefore not "a directive exists" but "EVERY batch's own text carries it", including the batches nothing else asks
 * for - and the second directive leaves the first id out of the block, so a plan stamped with it is visibly stale.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { CompanionEventPump, type WorldFact } from "./event-pump.js";
import { issueDirective, type GameDirective } from "./game-directive.js";

const DAY_SIX = Object.freeze({ year: 1, seasonIndex: 0, dayOfMonth: 6 });

function snapshotFact(revision: number, payload: Record<string, unknown>): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    kind: "snapshot",
    eventId: `snapshot_${String(revision)}`,
    correlationId: `snapshot_${String(revision)}`,
    revision,
    payload: Object.freeze({ revision, ...payload }),
  });
}

function worldFact(eventId: string, revision: number): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    kind: "world_fact",
    eventId,
    correlationId: eventId,
    revision,
    semanticKind: "day_started",
    payload: Object.freeze({ kind: "day_started" }),
  });
}

function directive(id: string, text: string, previous: GameDirective | null = null): GameDirective {
  return issueDirective({ directiveId: id, text, worldDay: DAY_SIX, supersedes: previous });
}

/** A sink that keeps every batch frame as it was delivered, parsed. */
function recordingSink() {
  const batches: { disposition: string; body: Record<string, unknown> }[] = [];
  return {
    batches,
    sink: {
      async deliver(text: string, disposition: string) {
        batches.push({ disposition, body: JSON.parse(text) as Record<string, unknown> });
      },
    },
  };
}

const directiveOf = (body: Record<string, unknown>) => body.directive as GameDirective | null;

test("every batch carries the current directive, in its own text", async () => {
  const pump = new CompanionEventPump();
  const { batches, sink } = recordingSink();
  pump.setDirective(directive("d_6_aaaa", "找片水，钓条鱼回来。"));
  pump.enqueueFact(worldFact("day_started_1", 1));
  await pump.flush(sink);

  assert.equal(batches.length, 1);
  const body = batches[0]!.body;
  const carried = directiveOf(body);
  // The assertion the red gate fires on, and it says what is missing: a batch with a current directive and no directive
  // in it is exactly `round44`'s defect.
  assert.equal(carried?.directiveId, "d_6_aaaa", "the batch carries no directive");
  assert.equal(carried?.text, "找片水，钓条鱼回来。");
  assert.equal(carried?.state, "current");
  assert.ok(
    batches[0]!.disposition === "follow_up",
    "a directive restates what the day is for; it does not preempt a running turn the way player input does",
  );
});

test("a second directive supersedes the first: only the new one is in the block", async () => {
  const pump = new CompanionEventPump();
  const { batches, sink } = recordingSink();
  const first = directive("d_6_aaaa", "找片水，钓条鱼回来。");
  pump.setDirective(first);
  pump.enqueueFact(worldFact("day_started_1", 1));
  await pump.flush(sink);
  pump.setDirective(directive("d_6_bbbb", "去镇上买种。", first));
  pump.enqueueFact(worldFact("day_started_2", 2));
  await pump.flush(sink);

  const second = batches[1]!.body;
  assert.equal(directiveOf(second)?.directiveId, "d_6_bbbb");
  assert.equal(directiveOf(second)?.supersedes, "d_6_aaaa");
  // The superseded record is held NOWHERE, so its words cannot reach the model again: the older id survives only as the
  // name of what was replaced, and the batch never describes both directives as standing at once.
  assert.equal(JSON.stringify(second).includes("找片水"), false);
  assert.equal(first.state, "current", "the record handed in is a value, not a slot the pump mutates");
});

test("a directive is restated into later batches, but only the FIRST of them is a turn it owes", async () => {
  const pump = new CompanionEventPump();
  const { batches, sink } = recordingSink();
  pump.setDirective(directive("d_6_aaaa", "钓鱼。"));
  // Nothing else is pending, and the arriving directive still owes a turn: that first batch is where the day is stated.
  assert.equal(pump.hasPendingDelivery, true);
  await pump.flush(sink);
  assert.equal(batches.length, 1);
  assert.equal(pump.hasPendingDelivery, false, "a restatement must not mint another turn");
  pump.enqueueFact(worldFact("day_started_1", 1));
  await pump.flush(sink);
  assert.equal(batches.length, 2);
  assert.equal(directiveOf(batches[1]!.body)?.directiveId, "d_6_aaaa", "still carried, though it owes no turn");
});

test("the world moving to another day expires the directive, and the batch says so", async () => {
  const pump = new CompanionEventPump();
  const { batches, sink } = recordingSink();
  pump.setDirective(directive("d_6_aaaa", "钓鱼。"));
  pump.enqueueFact(worldFact("day_started_1", 1));
  await pump.flush(sink);
  pump.enqueueFact(snapshotFact(2, { year: 1, seasonIndex: 0, dayOfMonth: 7 }));
  // A snapshot is held latest-only and owes no turn of its own, so the batch that answers the new day is the one the day
  // itself triggers - the same `day_started` fact a real night produces.
  pump.enqueueFact(worldFact("day_started_2", 2));
  await pump.flush(sink);

  // The snapshot's own calendar triple is the day boundary: the world's day, not a Host clock and not `TotalDays`.
  assert.equal(directiveOf(batches[1]!.body)?.state, "expired");
  assert.equal(pump.directive?.state, "expired");
});

test("a snapshot naming the same day leaves the directive current", async () => {
  const pump = new CompanionEventPump();
  const { batches, sink } = recordingSink();
  pump.setDirective(directive("d_6_aaaa", "钓鱼。"));
  pump.enqueueFact(snapshotFact(1, DAY_SIX));
  await pump.flush(sink);
  assert.equal(directiveOf(batches[0]!.body)?.state, "current");
});

test("presence counts DELIVERED TURNS and the ones that carried a directive", async () => {
  const pump = new CompanionEventPump();
  const { sink } = recordingSink();
  // One turn before any directive exists: the denominator has a member and the numerator does not.
  pump.enqueueFact(worldFact("day_started_1", 1));
  await pump.flush(sink);
  assert.deepEqual(pump.directiveDelivery, { turns: 1, withDirective: 0 });
  pump.setDirective(directive("d_6_aaaa", "钓鱼。"));
  await pump.flush(sink);
  assert.deepEqual(pump.directiveDelivery, { turns: 2, withDirective: 1 });
});

test("a steer into a running turn carries the directive too, and clear() forgets it", async () => {
  const pump = new CompanionEventPump();
  const { batches, sink } = recordingSink();
  pump.setDirective(directive("d_6_aaaa", "钓鱼。"));
  pump.enqueueFact(
    Object.freeze({
      source: "stardew_mod",
      kind: "world_fact" as const,
      eventId: "clock_1200",
      correlationId: "clock_1200",
      revision: 1,
      semanticKind: "time_milestone",
      payload: Object.freeze({ milestone: "1200" }),
    }),
  );
  assert.equal(await pump.steer(sink), true);
  assert.equal(directiveOf(batches[0]!.body)?.directiveId, "d_6_aaaa");

  pump.clear();
  assert.equal(pump.directive, null);
  assert.equal(pump.worldDay, null);
});
