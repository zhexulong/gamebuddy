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

test("event stream delivers live publications and removes listeners on close", () => {
  const stream = createChatEventStream();
  const received: number[] = [];
  const connection = stream.listen(
    { epoch: stream.epoch, after: 0, generation: 1 },
    (event) => received.push(event.sequence),
  );
  assert.equal(connection.result.kind, "replay");
  assert.deepEqual(connection.result.events, []);
  stream.publish(event());
  stream.publish({ ...event(), payload: { revision: 2, present: false } });
  assert.deepEqual(received, [1, 2]);
  connection.close();
  connection.close();
  stream.publish({ ...event(), payload: { revision: 3, present: true } });
  assert.deepEqual(received, [1, 2]);
});

test("event stream never binds a listener for a resync subscription", () => {
  const stream = createChatEventStream();
  let received = 0;
  const connection = stream.listen(
    { epoch: stream.epoch, after: 1, generation: 1 },
    () => {
      received += 1;
    },
  );
  assert.equal(connection.result.kind, "resync");
  assert.equal(connection.result.reason, "ambiguous_cursor");
  connection.close();
  connection.close();
  stream.publish(event());
  assert.equal(received, 0);
});

test("event stream rejects inputs that would override the stream-owned epoch, sequence, or apiVersion", () => {
  const stream = createChatEventStream();
  const base = { eventType: "draft.changed" as const, selectionGeneration: 1, payload: { revision: 1, present: true } };
  for (const forged of [
    { ...base, epoch: "A".repeat(43) },
    { ...base, sequence: 999 },
    { ...base, apiVersion: 1 },
  ]) {
    assert.throws(
      () => stream.publish(forged as unknown as Parameters<typeof stream.publish>[0]),
      /chat_event_stream_event_invalid/,
    );
  }
  assert.deepEqual(stream.decodeCursor(stream.cursor), {
    epoch: stream.epoch,
    sequence: 0,
  });
  const first = stream.publish(event());
  assert.equal(first.epoch, stream.epoch);
  assert.equal(first.sequence, 1);
});

test("event stream publishes an epoch-owned restart resync marker that advances the cursor", () => {
  const stream = createChatEventStream();
  const marker = stream.resync("restart", 3);
  assert.equal(marker.apiVersion, 1);
  assert.equal(marker.epoch, stream.epoch);
  assert.equal(marker.sequence, 1);
  assert.equal(marker.eventType, "stream.resync_required");
  assert.equal(marker.selectionGeneration, 3);
  assert.deepEqual(marker.payload, { reason: "restart" });
  assert.deepEqual(stream.decodeCursor(stream.cursor), {
    epoch: stream.epoch,
    sequence: 1,
  });
  for (const invalidGeneration of [0, 1.5, "2"]) {
    assert.throws(
      () => stream.resync("restart", invalidGeneration as unknown as number),
      /chat_event_stream_generation_invalid/,
    );
  }
  const next = stream.publish(event());
  assert.equal(next.epoch, stream.epoch);
  assert.equal(next.sequence, 2);
});

test("event stream delivers live publications to two concurrent readers and closing one leaves the other bound", () => {
  const stream = createChatEventStream();
  const left: number[] = [];
  const right: number[] = [];
  const first = stream.listen(
    { epoch: stream.epoch, after: 0, generation: 1 },
    (publication) => left.push(publication.sequence),
  );
  const second = stream.listen(
    { epoch: stream.epoch, after: 0, generation: 1 },
    (publication) => right.push(publication.sequence),
  );
  assert.equal(first.result.kind, "replay");
  assert.equal(second.result.kind, "replay");
  stream.publish(event());
  stream.publish({ ...event(), payload: { revision: 2, present: false } });
  assert.deepEqual(left, [1, 2]);
  assert.deepEqual(right, [1, 2]);
  first.close();
  stream.publish({ ...event(), payload: { revision: 3, present: true } });
  assert.deepEqual(left, [1, 2]);
  assert.deepEqual(right, [1, 2, 3]);
  second.close();
  stream.publish({ ...event(), payload: { revision: 4, present: false } });
  assert.deepEqual(right, [1, 2, 3]);
});
