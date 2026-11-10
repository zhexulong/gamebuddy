import assert from "node:assert/strict";
import test from "node:test";
import {
  CompanionEventPump,
  FACT_BATCH_CHARS_PER_TOKEN_MIN,
  FACT_BATCH_SHARE_OF_CHUNK,
  MAX_BATCH_BYTES,
  MAX_PENDING_WORLD_FACTS,
  deriveMaxBatchBytes,
  type PendingBatch,
} from "./event-pump.js";

/**
 * A batch has to fit in a model's context, and nothing enforced that.
 *
 * Measured 2026-10-27 on a real multiday run: after twelve minutes of intensive farm work the pump
 * delivered one batch of 685 facts - 417 semantic events and 260 execution receipts - which serialized
 * to 1,037,822 characters. The model reported `input: 373915`, `output: 1`, `stopReason: "length"` and
 * then produced nothing for the rest of the run: the companion stood in the farmhouse with
 * `can_move=True; navigate=idle` while the loop kept re-sending a batch it could not fit.
 *
 * The per-kind windows (MAX_PENDING_RECEIPTS = 512, MAX_PENDING_SEMANTIC_EVENTS = 512) bound the COUNT.
 * They do not bound the SIZE: 685 facts of roughly 700 bytes each sits comfortably inside those windows
 * and is still a megabyte.
 *
 * The invariant: one delivery carries at most MAX_BATCH_BYTES characters of MODEL-FACING TEXT, and whatever
 * does not fit is delivered LATER rather than dropped. The lever below is prose that renders in full - a dialogue
 * line quotes the Mod's pages verbatim - because a receipt line, a target family or a `<world-facts>` row is already
 * bounded where the sentences are composed.
 */
test("a batch is bounded by bytes, and the overflow is delivered in a later batch", async () => {
  const pump = new CompanionEventPump();
  const delivered: PendingBatch[] = [];
  const sink = {
    async deliver(batch: PendingBatch): Promise<void> {
      delivered.push(batch);
    },
  };

  // 30 dialogues of ~1,340 rendered characters is far over any sane byte bound, and the `<world-facts>` line cap does
  // not save it: the composer names at most 24 rows, which is already ~32k. Inside the 30-entry world-fact window, so
  // this fails on SIZE, not on the count limit that already existed.
  const page = "今天天气不错，要不要一起去山里走走？".repeat(70);
  for (let index = 0; index < MAX_PENDING_WORLD_FACTS - 2; index += 1) {
    pump.enqueueFact({
      source: "stardew_mod",
      kind: "world_fact",
      eventId: `npc_dialogue_${String(index)}`,
      sourceEventId: `npc_dialogue_${String(index)}`,
      correlationId: `npc_dialogue_${String(index)}`,
      revision: index,
      observedTick: index,
      semanticKind: "npc_dialogue_presented",
      payload: { speaker: "Marnie", pages: [page], choices: [] },
    });
  }

  await pump.flush(sink);

  assert.equal(delivered.length, 1, "one flush delivers one batch");
  const first = delivered[0]?.text ?? "";
  assert.ok(
    first.length <= MAX_BATCH_BYTES,
    `the first batch is ${String(first.length)} characters, over the ${String(MAX_BATCH_BYTES)} bound`,
  );

  // The rest is still pending: nothing was dropped to make the first batch fit.
  assert.equal(pump.hasPendingDelivery, true, "overflow must remain queued");

  // Drain. Across the batches every fact arrives exactly once - a bound that lost facts would be worse
  // than the unbounded batch it replaced.
  let guard = 0;
  while (pump.hasPendingDelivery && guard < 100) {
    await pump.flush(sink);
    guard += 1;
  }
  assert.ok(guard < 100, "the pump drained within a bounded number of batches");

  const seen = new Set<string>();
  for (const batch of delivered) {
    for (const fact of batch.facts) if (fact.correlationId !== undefined) seen.add(fact.correlationId);
  }
  assert.equal(seen.size, MAX_PENDING_WORLD_FACTS - 2, "every enqueued fact must be delivered exactly once");
});

test("a batch of ordinary size is not split", async () => {
  const pump = new CompanionEventPump();
  const delivered: PendingBatch[] = [];
  const sink = {
    async deliver(batch: PendingBatch): Promise<void> {
      delivered.push(batch);
    },
  };
  for (let index = 0; index < 5; index += 1) {
    pump.enqueueFact({
      source: "stardew_mod",
      kind: "execution_receipt",
      correlationId: `small_${String(index)}`,
      revision: index,
      payload: { index },
    });
  }

  await pump.flush(sink);

  assert.equal(delivered.length, 1);
  assert.equal(pump.hasPendingDelivery, false, "a small batch leaves nothing behind");
});

test("the snapshot is never separated from the batch that triggers it", async () => {
  // A snapshot is the world the rest of the batch describes. Splitting it off would make the delivered
  // facts describe a state the model cannot see.
  const pump = new CompanionEventPump();
  const delivered: PendingBatch[] = [];
  const sink = {
    async deliver(batch: PendingBatch): Promise<void> {
      delivered.push(batch);
    },
  };
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "snapshot",
    correlationId: "snap",
    revision: 1,
    payload: { location: "Farm", pad: "y".repeat(200_000) },
  });
  for (let index = 0; index < 60; index += 1) {
    pump.enqueueFact({
      source: "stardew_mod",
      kind: "execution_receipt",
      correlationId: `after_${String(index)}`,
      revision: index + 2,
      payload: { detail: "z".repeat(900), index },
    });
  }

  await pump.flush(sink);

  const first = delivered[0]!;
  assert.ok(
    first.facts.some((fact) => fact.kind === "snapshot"),
    "the snapshot belongs to the batch it was captured for",
  );
});

/**
 * The bound is DERIVED from the consumer, not a token count that looked about right.
 *
 * Two values failed here in the same direction. 120,000 characters was half a fold at best. Then 60,000 was
 * chosen as "roughly 15k tokens", assuming ~4 characters per token - but real fact batches measure 2.47-2.76
 * chars/token, so 60,000 was 22,534 tokens against a 22,879-token chunk: 98-106% of a whole one. 22 uncleared
 * batches then held 434,021 tokens, 96% of all active message tokens, and the next burst filled a 200,000-token
 * window and answered stopReason: "length".
 *
 * These assertions are on the DERIVATION, so they stay true if the chunk or the ratio moves: what has to hold is
 * the relationship, not the literal.
 */
test("the batch bound is a fraction of the fold chunk it is derived from", () => {
  const share = MAX_BATCH_BYTES / FACT_BATCH_CHARS_PER_TOKEN_MIN;
  const chunk = share / FACT_BATCH_SHARE_OF_CHUNK;
  assert.ok(
    FACT_BATCH_SHARE_OF_CHUNK < 0.5,
    "the share must be under half a chunk: at half, one fold pass spends its whole budget on a single delivery " +
      "and the protected tail cannot shrink at all",
  );
  assert.equal(
    Math.floor(chunk * FACT_BATCH_SHARE_OF_CHUNK * FACT_BATCH_CHARS_PER_TOKEN_MIN),
    MAX_BATCH_BYTES,
    "MAX_BATCH_BYTES must be exactly what deriveMaxBatchBytes produces for the chunk it names",
  );
  assert.equal(
    deriveMaxBatchBytes(22_879),
    MAX_BATCH_BYTES,
    "and the exported fallback chunk is the one the constant was derived from",
  );
});

test("a doubles-sized chunk yields a doubles-sized bound, so the bound tracks its consumer", () => {
  // Within one character: the derivation floors, so an exact double can land one short.
  const doubled = deriveMaxBatchBytes(45_758);
  assert.ok(
    Math.abs(doubled - MAX_BATCH_BYTES * 2) <= 1,
    `doubling the chunk must double the bound (got ${String(doubled)} against ${String(MAX_BATCH_BYTES * 2)})`,
  );
  // A degenerate input falls back rather than producing zero, which would stall every delivery.
  assert.equal(deriveMaxBatchBytes(0), MAX_BATCH_BYTES);
  assert.equal(deriveMaxBatchBytes(Number.NaN), MAX_BATCH_BYTES);
});
