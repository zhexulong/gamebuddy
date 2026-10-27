import assert from "node:assert/strict";
import test from "node:test";
import { CompanionEventPump, MAX_BATCH_BYTES } from "./event-pump.js";

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
 * The invariant: one delivery carries at most MAX_BATCH_BYTES characters, and whatever does not fit is
 * delivered LATER rather than dropped.
 */
test("a batch is bounded by bytes, and the overflow is delivered in a later batch", async () => {
  const pump = new CompanionEventPump();
  const delivered: string[] = [];
  const sink = {
    async deliver(text: string): Promise<void> {
      delivered.push(text);
    },
  };

  // 300 receipts of ~900 bytes is ~270k of payload: well inside the 512-entry window, well over any
  // sane byte bound. This fails on SIZE, not on the count limit that already existed.
  const padding = "x".repeat(900);
  for (let index = 0; index < 300; index += 1) {
    pump.enqueueFact({
      source: "stardew_mod",
      kind: "execution_receipt",
      correlationId: `receipt_${String(index)}`,
      revision: index,
      payload: { detail: padding, index },
    });
  }

  await pump.flush(sink);

  assert.equal(delivered.length, 1, "one flush delivers one batch");
  const first = delivered[0] ?? "";
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
  for (const text of delivered) {
    const batch = JSON.parse(text) as { worldFacts: Array<{ correlationId: string }> };
    for (const fact of batch.worldFacts) seen.add(fact.correlationId);
  }
  assert.equal(seen.size, 300, "every enqueued fact must be delivered exactly once");
});

test("a batch of ordinary size is not split", async () => {
  const pump = new CompanionEventPump();
  const delivered: string[] = [];
  const sink = {
    async deliver(text: string): Promise<void> {
      delivered.push(text);
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
  const delivered: string[] = [];
  const sink = {
    async deliver(text: string): Promise<void> {
      delivered.push(text);
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

  const first = JSON.parse(delivered[0] ?? "{}") as { worldFacts: Array<{ kind: string }> };
  assert.ok(
    first.worldFacts.some((fact) => fact.kind === "snapshot"),
    "the snapshot belongs to the batch it was captured for",
  );
});
