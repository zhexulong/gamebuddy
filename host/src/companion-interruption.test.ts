import assert from "node:assert/strict";
import test from "node:test";
import {
  createCompanionInterruption,
  type InterruptionSnapshot,
} from "./companion-interruption.js";

test("captures immutable open admission and advances epochs monotonically", () => {
  const interruption = createCompanionInterruption();
  const initial = interruption.capture();
  assert.deepEqual(initial, { epoch: 0, open: true });
  assert.equal(Object.isFrozen(initial), true);
  assert.equal(interruption.isCurrent(initial), true);

  const stopped = interruption.stop("stop-1", "event-1", "player_stop");
  assert.deepEqual(stopped, {
    accepted: true,
    stopId: "stop-1",
    sourceEventId: "event-1",
    reasonCode: "player_stop",
    previousEpoch: 0,
    epoch: 1,
  });
  assert.equal(Object.isFrozen(stopped), true);
  assert.equal(interruption.isCurrent(initial), false);
  assert.deepEqual(interruption.capture(), { epoch: 1, open: false });

  const reopened = interruption.open();
  assert.deepEqual(reopened, { epoch: 1, open: true });
  assert.equal(interruption.isCurrent(reopened), true);
  interruption.close("teardown");
  assert.deepEqual(interruption.capture(), { epoch: 2, open: false });
  assert.equal(interruption.isCurrent(reopened), false);
});

test("rejects stale, forged, closed, and replayed admissions fail closed", () => {
  const interruption = createCompanionInterruption();
  const old = interruption.capture();
  interruption.stop("stop-1", "event-1", "player_stop");
  const closed = interruption.capture();

  assert.equal(interruption.isCurrent(old), false);
  assert.equal(interruption.isCurrent(closed), false);
  assert.equal(interruption.isCurrent({ epoch: 1, open: true }), false);
  assert.equal(interruption.isCurrent({ epoch: 0, open: true }), false);
  assert.throws(() => interruption.assertCurrent(old), /stale_interruption_admission/);
  assert.throws(() => interruption.assertCurrent(closed), /stale_interruption_admission/);
  assert.throws(
    () => interruption.assertCurrent({ epoch: 1, open: true } as InterruptionSnapshot),
    /stale_interruption_admission/,
  );

  const current = interruption.open();
  interruption.assertCurrent(current);
  interruption.close("second_stop");
  assert.throws(() => interruption.assertCurrent(current), /stale_interruption_admission/);
});

test("deduplicates stop IDs without changing the epoch or reopening admission", () => {
  const interruption = createCompanionInterruption();
  const first = interruption.stop("repeat", "event-1", "player_stop");
  const duplicate = interruption.stop("repeat", "event-2", "different_reason");

  assert.deepEqual(duplicate, { ...first, accepted: false });
  assert.equal(Object.isFrozen(duplicate), true);
  assert.deepEqual(interruption.capture(), { epoch: 1, open: false });
});

test("does not refresh duplicate STOP IDs in the bounded LRU dedupe cache", () => {
  const interruption = createCompanionInterruption({ maxRememberedStops: 2 });
  interruption.stop("a", "event-a", "stop");
  interruption.stop("b", "event-b", "stop");
  assert.equal(interruption.stop("a", "ignored", "ignored").accepted, false);
  interruption.stop("c", "event-c", "stop");

  // The duplicate did not move a to the LRU tail, so c evicted a, not b.
  assert.equal(interruption.stop("b", "ignored", "ignored").accepted, false);
  const reaccepted = interruption.stop("a", "event-a2", "stop");
  assert.equal(reaccepted.accepted, true);
  assert.equal(reaccepted.previousEpoch, 3);
  assert.equal(reaccepted.epoch, 4);
});

test("stop synchronously closes old admission before returning any work descriptor", () => {
  const interruption = createCompanionInterruption();
  const before = interruption.capture();
  let observedCurrent = true;
  const result = interruption.stop("stop-1", "event-1", "player_stop");
  observedCurrent = interruption.isCurrent(before);

  assert.equal(observedCurrent, false);
  assert.equal(interruption.capture().open, false);
  assert.equal(typeof (result as { then?: unknown }).then, "undefined");
  assert.equal(typeof (interruption.stop("stop-2", "event-2", "player_stop") as { then?: unknown }).then, "undefined");
});

test("rejects invalid options and stop fields without changing admission", () => {
  assert.throws(
    () => createCompanionInterruption({ maxRememberedStops: 0 }),
    /invalid_interruption_dedupe_bound/,
  );
  assert.throws(
    () => createCompanionInterruption({ maxRememberedStops: 1.5 }),
    /invalid_interruption_dedupe_bound/,
  );

  const interruption = createCompanionInterruption();
  const initial = interruption.capture();
  for (const [stopId, sourceEventId, reason] of [
    ["", "event", "reason"],
    ["stop", "", "reason"],
    ["stop", "event", ""],
    ["stop\0", "event", "reason"],
  ]) {
    assert.throws(() => interruption.stop(stopId, sourceEventId, reason), /invalid_interruption_/);
    assert.deepEqual(interruption.capture(), initial);
  }

  for (const invalidIdentifier of ["bad id", "bad\tidentifier", "bad\u0001identifier", "停止", "a".repeat(129)]) {
    for (const [stopId, sourceEventId, reason] of [
      [invalidIdentifier, "event", "reason"],
      ["stop", invalidIdentifier, "reason"],
      ["stop", "event", invalidIdentifier],
    ]) {
      assert.throws(() => interruption.stop(stopId, sourceEventId, reason), /invalid_interruption_/);
      assert.deepEqual(interruption.capture(), initial);
    }
  }
  assert.throws(() => interruption.close(""), /invalid_interruption_reason_code/);
  assert.deepEqual(interruption.capture(), initial);
  interruption.close("valid");
  assert.deepEqual(interruption.open(), { epoch: 1, open: true });
  assert.throws(() => interruption.open(), /interruption_admission_already_open/);
});
