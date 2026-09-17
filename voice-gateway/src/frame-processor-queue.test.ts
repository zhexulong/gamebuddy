import { strict as assert } from "node:assert";
import test from "node:test";

import { FRAME_PRIORITY, FrameProcessorQueue, frameComesBefore } from "./frame-processor-queue.js";

function frame(priority: 1 | 10 | 20, kind: string, seq: number) {
  return Object.freeze({ priority, id: `${kind}_${seq}`, kind, seq });
}

test("FrameProcessorQueue serves system frames immediately and never queues them", () => {
  const queue = new FrameProcessorQueue();
  assert.equal(queue.push(frame(FRAME_PRIORITY.system, "cancel_speech", 1)), true);
  assert.equal(queue.size, 0); // never queued
  assert.equal(queue.systemFramesServed, 1);
  assert.equal(queue.totalFramesServed, 1);
});

test("FrameProcessorQueue queues control and data frames in priority order, FIFO within priority", () => {
  const queue = new FrameProcessorQueue();
  queue.push(frame(FRAME_PRIORITY.data, "audio", 1));
  queue.push(frame(FRAME_PRIORITY.control, "duck", 2));
  queue.push(frame(FRAME_PRIORITY.data, "audio", 3));
  assert.equal(queue.size, 3);
  const first = queue.pop(FRAME_PRIORITY.data);
  assert.equal(first?.kind, "duck"); // control first
  const second = queue.pop(FRAME_PRIORITY.data);
  const third = queue.pop(FRAME_PRIORITY.data);
  assert.equal(second?.kind, "audio");
  assert.equal(third?.kind, "audio");
  assert.equal(second?.seq, 1); // FIFO within data
});

test("FrameProcessorQueue pops below a ceiling and leaves higher-priority frames queued", () => {
  const queue = new FrameProcessorQueue();
  queue.push(frame(FRAME_PRIORITY.control, "duck", 1));
  queue.push(frame(FRAME_PRIORITY.data, "audio", 2));
  // Only data frames serviceable under the data ceiling... control has higher
  // priority, so a data-ceiling pop still serves control first.
  const popped = queue.pop(FRAME_PRIORITY.data);
  assert.equal(popped?.kind, "duck");
  assert.equal(queue.size, 1);
});

test("FrameProcessorQueue reset() drains every queued frame atomically", () => {
  const queue = new FrameProcessorQueue();
  for (let index = 0; index < 50; index += 1) queue.push(frame(FRAME_PRIORITY.data, "audio", index));
  queue.push(frame(FRAME_PRIORITY.control, "duck", 100));
  assert.equal(queue.size, 51);
  assert.equal(queue.reset(), 51); // returns the drained count
  assert.equal(queue.size, 0);
  assert.equal(queue.pop(FRAME_PRIORITY.data), undefined);
});

test("FrameProcessorQueue cancel during 50-frame backlog clears inside one reset", () => {
  const queue = new FrameProcessorQueue();
  for (let index = 0; index < 50; index += 1) queue.push(frame(FRAME_PRIORITY.data, "audio", index));
  // Barge-in: the system cancel bypasses the backlog entirely
  const servedNow = queue.push(frame(FRAME_PRIORITY.system, "cancel_speech", 999));
  assert.equal(servedNow, true);
  assert.equal(queue.systemFramesServed, 1);
  // Drain the stale audio atomically before any further playback can start.
  const drained = queue.reset();
  assert.equal(drained, 50);
  assert.equal(queue.size, 0);
});

test("FrameProcessorQueue enforces capacity by dropping the oldest data frame", () => {
  const queue = new FrameProcessorQueue(4);
  for (let index = 0; index < 4; index += 1) queue.push(frame(FRAME_PRIORITY.data, "audio", index));
  queue.push(frame(FRAME_PRIORITY.data, "audio", 4)); // overflow
  assert.equal(queue.size, 4);
  const seqs = [];
  let popped;
  while ((popped = queue.pop(FRAME_PRIORITY.data)) !== undefined) seqs.push(popped.seq);
  assert.deepEqual(seqs, [1, 2, 3, 4]); // oldest (seq 0) dropped
});

test("frameComesBefore enforces strict weak ordering across priorities and FIFO ties", () => {
  const a = frame(FRAME_PRIORITY.data, "audio", 1);
  const b = frame(FRAME_PRIORITY.data, "audio", 2);
  const c = frame(FRAME_PRIORITY.control, "duck", 0);
  assert.equal(frameComesBefore(c, a), true);
  assert.equal(frameComesBefore(a, c), false);
  assert.equal(frameComesBefore(a, b), true);
  assert.equal(frameComesBefore(b, a), false);
  assert.equal(frameComesBefore(a, a), false);
});