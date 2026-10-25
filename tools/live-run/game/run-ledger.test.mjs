import assert from "node:assert/strict";
import test from "node:test";

import { createLedger, ledgerSpans, ledgerSummary, LEDGER_KINDS } from "./run-ledger.mjs";

/**
 * The ledger exists because a 614-second run could not be attributed: `actionCadence` reported all three phases as
 * zero, `acceptMs` was the whole accept path rather than the provider, and the presentation time had an incomplete
 * boundary. Any split from those numbers is an upper bound, which is another way of saying nobody could say.
 *
 * What these cases pin is the property that makes a split trustworthy: two boundaries on one clock are a duration,
 * an unfinished pair is an open wait (never a zero), and an unknown kind is refused rather than absorbed.
 */

function fixedClock() {
  let t = 0;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

test("two boundaries on one clock are a duration", () => {
  const clock = fixedClock();
  const ledger = createLedger({ now: clock.now });
  ledger.record("provider.request");
  clock.advance(2500);
  ledger.record("provider.first_token");

  const spans = ledgerSpans(ledger.entries(), "provider.request", "provider.first_token");
  assert.equal(spans.length, 1);
  assert.equal(spans[0].durationMs, 2500);
});

test("an unfinished pair is an open wait, not a zero", () => {
  // This is the shape a frozen or still-running turn leaves, and the one `actionCadence` could not express: it
  // reported 0 for a phase that had simply never closed.
  const clock = fixedClock();
  const ledger = createLedger({ now: clock.now });
  ledger.record("world.dispatch");
  clock.advance(40_000);

  const spans = ledgerSpans(ledger.entries(), "world.dispatch", "world.settled");
  assert.equal(spans.length, 1);
  assert.equal(spans[0].endMs, null);
  assert.equal(spans[0].durationMs, null);

  const summary = ledgerSummary(spans);
  assert.equal(summary.count, 0, "an open wait is not a measured duration");
  assert.equal(summary.open, 1, "but it is counted, so it cannot disappear");
  assert.equal(summary.medianMs, null);
});

test("an unknown kind is refused rather than stored", () => {
  const clock = fixedClock();
  const ledger = createLedger({ now: clock.now });
  assert.throws(() => ledger.record("thinking_about_it"), /ledger_unknown_kind/);
  assert.equal(ledger.entries().length, 0);
});

test("a ledger without a clock is refused, because two clocks is the defect being fixed", () => {
  assert.throws(() => createLedger({}), /ledger_needs_a_clock/);
  assert.throws(() => createLedger(undefined), /ledger_needs_a_clock/);
});

test("entries sharing a millisecond keep their arrival order", () => {
  // Ordering by time alone would drop one of two events in the same millisecond, which is exactly the race a
  // reader is looking for when a dispatch and its settle look simultaneous.
  const clock = fixedClock();
  const ledger = createLedger({ now: clock.now });
  ledger.record("tool.start", { tool: "a" });
  ledger.record("tool.start", { tool: "b" });
  ledger.record("tool.settled", { tool: "a" });

  const starts = ledger.entries().filter((e) => e.kind === "tool.start");
  assert.equal(starts.length, 2);
  assert.equal(starts[0].detail.tool, "a");
  assert.equal(starts[1].detail.tool, "b");
  assert.deepEqual(
    ledger.entries().map((e) => e.seq),
    [0, 1, 2],
  );
});

test("the summary reports median and max over closed spans only", () => {
  const clock = fixedClock();
  const ledger = createLedger({ now: clock.now });
  for (const ms of [100, 300, 200]) {
    ledger.record("provider.request");
    clock.advance(ms);
    ledger.record("provider.done");
  }
  ledger.record("provider.request"); // left open

  const summary = ledgerSummary(ledgerSpans(ledger.entries(), "provider.request", "provider.done"));
  assert.equal(summary.count, 3);
  assert.equal(summary.open, 1);
  assert.equal(summary.medianMs, 200);
  assert.equal(summary.maxMs, 300);
  assert.equal(summary.sumMs, 600);
});

test("a snapshot cannot be rewritten by later entries", () => {
  const clock = fixedClock();
  const ledger = createLedger({ now: clock.now });
  ledger.record("run.start");
  const taken = ledger.snapshot();
  clock.advance(10);
  ledger.record("run.end");

  assert.equal(taken.entries.length, 1, "the published snapshot is what was true when it was taken");
  assert.equal(ledger.snapshot().entries.length, 2);
});

test("every kind the product can record is declared", () => {
  // A closed set is the point: a new category has to be added here, where a reader can see it, instead of
  // appearing in one run's artifact and never again.
  assert.ok(LEDGER_KINDS.includes("provider.first_token"));
  assert.ok(LEDGER_KINDS.includes("world.settled"));
  assert.ok(LEDGER_KINDS.includes("present.visible"));
  assert.equal(new Set(LEDGER_KINDS).size, LEDGER_KINDS.length, "no duplicate kinds");
});
