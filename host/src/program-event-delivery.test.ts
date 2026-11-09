import assert from "node:assert/strict";
import test from "node:test";
import { createProgramEventDeliveryLedger } from "./program-event-delivery.js";

/** One `program_status` answer, in the shape the port returns. */
function statusAnswer(programId: string, eventHighWater: number, state = "active") {
  return {
    code: "found",
    snapshot: {
      programId,
      state,
      catalogRevision: 1,
      stopEpoch: 0,
      eventHighWater,
      nodes: [],
    },
    programs: null,
    programCount: 1,
  };
}

test("a snapshot that keeps up with what was delivered carries no staleness", () => {
  const ledger = createProgramEventDeliveryLedger();
  ledger.observeEvents("plan_a", { highWater: 620 });
  assert.equal(ledger.delivered("plan_a"), 620, "an events page says how far the journal had advanced");
  assert.equal(ledger.observeStatus(statusAnswer("plan_a", 626)), null, "626 is newer than 620, so nothing is stale");
});

test("a snapshot below what the connection already delivered names both numbers", () => {
  // round41: `state: "active"`, `eventHighWater: 626` answered a program whose three nodes had already settled on
  // cursors 625/629/633 this Host held. Both numbers travel, because "stale" alone cannot be acted on.
  const ledger = createProgramEventDeliveryLedger();
  ledger.observeEvents("plan_739_frozen", { highWater: 633 });
  assert.deepEqual(ledger.observeStatus(statusAnswer("plan_739_frozen", 626)), {
    code: "stale_snapshot:eventHighWater=626;delivered=633",
    eventHighWater: 626,
    delivered: 633,
  });
});

test("a snapshot is compared with what came before it and never with itself", () => {
  const ledger = createProgramEventDeliveryLedger();
  assert.equal(ledger.observeStatus(statusAnswer("plan_b", 630)), null, "the first read has nothing to lag behind");
  assert.equal(
    ledger.observeStatus(statusAnswer("plan_b", 630)),
    null,
    "a repeated read at the same watermark is current, not stale",
  );
  assert.equal(ledger.observeStatus(statusAnswer("plan_b", 640)), null, "and a later read moves the watermark up");
  assert.equal(ledger.delivered("plan_b"), 640);
});

test("one program's watermark cannot make another program's snapshot stale", () => {
  const ledger = createProgramEventDeliveryLedger();
  ledger.observeEvents("plan_busy", { highWater: 900 });
  assert.equal(
    ledger.observeStatus(statusAnswer("plan_quiet", 12)),
    null,
    "a plan that has been waiting is not stale because another plan wrote to the journal",
  );
  assert.equal(ledger.delivered("plan_quiet"), 12);
  assert.equal(ledger.delivered("plan_busy"), 900);
});

test("an answer that names no plan is not a watermark", () => {
  const ledger = createProgramEventDeliveryLedger();
  assert.equal(ledger.observeStatus({ code: "not_found", snapshot: null, programs: null, programCount: 0 }), null);
  assert.equal(ledger.observeStatus({ code: "found", snapshot: null, programs: [], programCount: 3 }), null);
  assert.equal(ledger.delivered(""), null, "a program nobody has been delivered anything about has no watermark");
});
