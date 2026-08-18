import assert from "node:assert/strict";
import test from "node:test";
import { createChatEventStream } from "./chat-event-stream.js";

const event = (selectionGeneration = 1) => ({
  eventType: "draft.changed" as const,
  selectionGeneration,
  payload: { revision: 1, present: true },
});

test("event stream assigns an opaque epoch and monotonic replay cursor", () => {
  const stream = createChatEventStream(4);
  const first = stream.publish(event());
  const second = stream.publish({ ...event(), payload: { revision: 2, present: false } });
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.equal(first.epoch, stream.epoch);
  assert.deepEqual(stream.decodeCursor(stream.encodeCursor({ epoch: stream.epoch, sequence: 2 })), {
    epoch: stream.epoch,
    sequence: 2,
  });
  assert.deepEqual(stream.subscribe({ epoch: stream.epoch, after: 0, generation: 1 }).events, [first, second]);
});

test("event stream rejects invalid and future cursors with resync reasons", () => {
  const stream = createChatEventStream();
  stream.publish(event());
  assert.equal(stream.decodeCursor("not-a-cursor"), null);
  assert.equal(stream.subscribe({ epoch: "A".repeat(43), after: 0, generation: 1 }).reason, "epoch_changed");
  assert.equal(stream.subscribe({ epoch: stream.epoch, after: 2, generation: 1 }).reason, "ambiguous_cursor");
  assert.equal(stream.subscribe({ epoch: stream.epoch, after: 0, generation: 2 }).reason, "epoch_changed");
});

test("event stream returns resync after a bounded replay gap", () => {
  const stream = createChatEventStream(2);
  stream.publish(event());
  stream.publish({ ...event(), payload: { revision: 2, present: true } });
  stream.publish({ ...event(), payload: { revision: 3, present: false } });
  const result = stream.subscribe({ epoch: stream.epoch, after: 0, generation: 1 });
  assert.deepEqual(result, { kind: "resync", events: [], reason: "gap" });
});

test("event stream drops events from a foreign selection generation", () => {
  const stream = createChatEventStream();
  stream.publish(event(1));
  stream.publish(event(2));
  const result = stream.subscribe({ epoch: stream.epoch, after: 0, generation: 1 });
  assert.equal(result.kind, "resync");
  assert.equal(result.reason, "epoch_changed");
});
