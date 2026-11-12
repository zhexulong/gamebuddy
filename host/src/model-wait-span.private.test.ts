import assert from "node:assert/strict";
import test from "node:test";

import { RUN_WAIT_NAMES } from "./run-trace-budget.js";
import { createModelWaitTracker } from "./model-wait-span.js";

/**
 * `wait.model` is the time the agent spends deciding: from the moment the last tool result of a batch
 * settles to the moment the next assistant message begins.
 *
 * This exists because `actionCadence.thinkMs` measured "receipt to next dispatch" and called it thinking.
 * That number also contains the body being unavailable - a menu, a pass-out, a sleep lifecycle - so one
 * median over it described neither. The tracker below measures exactly one thing and refuses to guess the
 * rest: when it cannot tell where a wait started, it reports nothing rather than measuring from the wrong
 * moment.
 */

const assistantStart = (atMs: number) => ({ type: "message_start" as const, role: "assistant" as const, atMs });
const toolSettled = (atMs: number) => ({ type: "tool_result" as const, atMs });
const assistantEnd = (atMs: number) => ({ type: "message_end" as const, role: "assistant" as const, atMs });

test("a wait opens when the last tool result settles and closes at the next assistant message", () => {
  const tracker = createModelWaitTracker();

  tracker.observe(toolSettled(1_000));
  const span = tracker.observe(assistantStart(4_500));

  assert.notEqual(span, null);
  assert.equal(span!.name, RUN_WAIT_NAMES.model);
  assert.equal(span!.startMs, 1_000);
  assert.equal(span!.endMs, 4_500, "the wait is 3.5s, not 4.5s from the beginning of the run");
});

test("assistant-to-assistant is not a model wait", () => {
  // A turn that begins without any tool result in front of it is the player speaking, not the agent
  // deciding. Measuring it would fold the player's own latency into the model's.
  const tracker = createModelWaitTracker();
  tracker.observe(assistantStart(0));
  tracker.observe(assistantEnd(2_000));

  assert.equal(tracker.observe(assistantStart(9_000)), null);
});

test("only the LAST tool result counts, because the batch settles together", () => {
  const tracker = createModelWaitTracker();
  tracker.observe(toolSettled(1_000));
  tracker.observe(toolSettled(3_000));
  tracker.observe(toolSettled(5_000));

  const span = tracker.observe(assistantStart(8_000));
  assert.equal(span!.startMs, 5_000, "the wait begins when the batch finished, not when its first item did");
  assert.equal(span!.endMs, 8_000);
});

test("a wait already consumed does not open a second time for the same settle", () => {
  const tracker = createModelWaitTracker();
  tracker.observe(toolSettled(1_000));
  assert.notEqual(tracker.observe(assistantStart(4_000)), null);

  // The next assistant message must not re-use the old settle.
  assert.equal(tracker.observe(assistantStart(6_000)), null);
});

test("an open wait is visible while it is open, which is what a freeze looks like", () => {
  const tracker = createModelWaitTracker();
  tracker.observe(toolSettled(1_000));

  const open = tracker.openWait();
  assert.notEqual(open, null);
  assert.equal(open!.startMs, 1_000);
  assert.equal(open!.endMs, null, "a wait with no end yet is exactly the state a frozen run leaves behind");
});

test("nothing is reported before any tool result has settled", () => {
  const tracker = createModelWaitTracker();
  assert.equal(tracker.openWait(), null);
  assert.equal(tracker.observe(assistantStart(100)), null);
});
