import assert from "node:assert/strict";
import test from "node:test";
import { createGameEventStream } from "./game-event-stream.js";

const attachmentPatch = (generation: number) =>
  ({
    fact: "attachment" as const,
    game: {
      attachment: { status: "attached" as const, generation },
      connectionStatus: "connected_idle" as const,
      capabilitySummary: { status: "published" as const, count: 7 },
    },
  }) satisfies Parameters<ReturnType<typeof createGameEventStream>["publish"]>[0];

test("the game stream mints its own epoch, monotonic sequences and an opaque round-tripping cursor", () => {
  const stream = createGameEventStream();
  assert.match(stream.epoch, /^[A-Za-z0-9_-]{22,128}$/u);
  assert.deepEqual(stream.decodeCursor(stream.cursor), { epoch: stream.epoch, sequence: 0 });

  const first = stream.publish(attachmentPatch(2));
  const second = stream.publish(attachmentPatch(3));
  assert.equal(first.epoch, stream.epoch);
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.equal(first.eventType, "game.fact_changed");
  assert.deepEqual(stream.decodeCursor(stream.cursor), { epoch: stream.epoch, sequence: 2 });

  // Two streams are two epochs: a cursor from one is never a position in the other.
  assert.notEqual(createGameEventStream().epoch, stream.epoch);

  assert.equal(stream.decodeCursor(""), null);
  assert.equal(stream.decodeCursor("x".repeat(129)), null);
  assert.equal(stream.decodeCursor("not base64url json"), null);
  assert.equal(stream.decodeCursor(Buffer.from(JSON.stringify(["nope", 0])).toString("base64url")), null);
  assert.equal(stream.decodeCursor(Buffer.from(JSON.stringify([stream.epoch, -1])).toString("base64url")), null);
  assert.throws(() => stream.encodeCursor({ epoch: "nope", sequence: 0 }), /game_event_stream_cursor_invalid/);
});

test("the game stream replays only what the bounded window still holds, and calls anything else a gap", () => {
  const stream = createGameEventStream(2);
  assert.equal(stream.subscribe({ epoch: stream.epoch, after: 0 }).kind, "replay");

  for (const generation of [2, 3, 4]) stream.publish(attachmentPatch(generation));
  const replay = stream.subscribe({ epoch: stream.epoch, after: 1 });
  assert.equal(replay.kind, "replay");
  assert.deepEqual(
    replay.events.map((event) => event.sequence),
    [2, 3],
  );

  // Sequence 1 has left a two-frame window, so the interval cannot be reconstructed: the caller resyncs.
  const gapped = stream.subscribe({ epoch: stream.epoch, after: 0 });
  assert.equal(gapped.kind, "resync");
  assert.equal(gapped.reason, "gap");
  assert.deepEqual(gapped.events, []);
});

test("the game stream separates epoch_changed from ambiguous_cursor and never serves a cursor ahead of itself", () => {
  const stream = createGameEventStream();
  stream.publish(attachmentPatch(2));

  assert.equal((stream.subscribe({ epoch: "Z".repeat(43), after: 0 }) as { reason: string }).reason, "epoch_changed");
  assert.equal((stream.subscribe({ epoch: stream.epoch, after: 5 }) as { reason: string }).reason, "ambiguous_cursor");
  assert.equal(
    (stream.subscribe({ epoch: "not-an-epoch", after: 0 }) as { reason: string }).reason,
    "ambiguous_cursor",
  );
  assert.equal((stream.subscribe({ epoch: stream.epoch, after: -1 }) as { reason: string }).reason, "ambiguous_cursor");
  assert.equal((stream.subscribe(null as never) as { reason: string }).reason, "ambiguous_cursor");
});

test("the game stream delivers live frames to its listeners and stops when a listener closes", () => {
  const stream = createGameEventStream();
  const seen: number[] = [];
  const connection = stream.listen(
    { epoch: stream.epoch, after: stream.decodeCursor(stream.cursor)!.sequence },
    (event) => seen.push(event.sequence),
  );
  assert.equal(connection.result.kind, "replay");
  stream.publish(attachmentPatch(2));
  assert.deepEqual(seen, [1]);
  connection.close();
  stream.publish(attachmentPatch(3));
  assert.deepEqual(seen, [1]);

  // A subscription the stream refuses installs no listener at all: a resync is answered once, on the request.
  const refused = stream.listen({ epoch: "Z".repeat(43), after: 0 }, () => assert.fail("no frame may arrive"));
  assert.equal(refused.result.kind, "resync");
  stream.publish(attachmentPatch(4));
  refused.close();
});

test("a resync frame is a sequence the ring does not hold, so replay skips it and never rewinds a fact", () => {
  const stream = createGameEventStream();
  stream.publish(attachmentPatch(2));
  const resync = stream.resync("ambiguous_cursor");
  assert.equal(resync.eventType, "game.stream_resync_required");
  assert.deepEqual(resync.payload, { reason: "ambiguous_cursor" });
  assert.equal(resync.sequence, 2);
  stream.publish(attachmentPatch(3));

  // A cursor from before the resync still replays the facts it holds, in order: the resync carried no fact, so the
  // hole it leaves is a position, not a lost change. This is why a resync frame is answered on the connection that
  // asked for it and never stored.
  const replayed = stream.subscribe({ epoch: stream.epoch, after: 0 });
  assert.equal(replayed.kind, "replay");
  assert.deepEqual(
    replayed.events.map((event) => event.sequence),
    [1, 3],
  );
  // A cursor at the resync frame itself (the browser's own `lastEventId` after reading it) gets exactly what came
  // after it.
  const after = stream.subscribe({ epoch: stream.epoch, after: resync.sequence });
  assert.equal(after.kind, "replay");
  assert.deepEqual(
    after.events.map((event) => event.sequence),
    [3],
  );
});

test("the game stream refuses a frame that is not one of the facts that change without a player", () => {
  const stream = createGameEventStream();
  assert.throws(
    () => stream.publish({ fact: "actionAuthority", game: { actionAuthority: "active" } } as never),
    /game_event_stream_event_invalid/,
  );
  // A refused frame consumes no sequence: the next real one is first.
  assert.equal(stream.publish(attachmentPatch(2)).sequence, 1);
  assert.throws(() => createGameEventStream(0), /game_event_stream_window_invalid/);
  assert.throws(() => createGameEventStream(257), /game_event_stream_window_invalid/);
});
