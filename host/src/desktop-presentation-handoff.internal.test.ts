import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";

import {
  composeDesktopPresentationHandoffFrame,
  createDesktopPresentationHandoffPublisher,
  desktopPresentationHandoffPipeName,
} from "./desktop-presentation-handoff.internal.js";

/**
 * Focused tests for the Desktop-owned presentation handoff channel.
 *
 * Failure caught by each: a token that reaches a channel it may not reach (stdout,
 * an argv, a file, a message), a frame shape the launcher would refuse, a second
 * frame on a one-shot channel, and a Handoff that turns a missing launcher into a
 * product failure.
 */
const bootstrapId = "0123456789abcdef".repeat(4);
const token = "fixture-bootstrap-token-0123456789";
const launchUrl = `http://127.0.0.1:41234/#profile=composed-reference-game&boot=${token}`;

async function listenOn(name: string): Promise<{
  readonly frames: readonly Buffer[];
  waitForFrames(count: number): Promise<void>;
  settle(): Promise<void>;
  close(): Promise<void>;
}> {
  const frames: Buffer[] = [];
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let received = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      const newline = received.indexOf(10);
      if (newline < 0) return;
      frames.push(received.subarray(0, newline + 1));
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(name, () => resolve());
  });
  return {
    frames,
    async waitForFrames(count) {
      for (let attempt = 0; attempt < 200 && frames.length < count; attempt += 1) {
        await new Promise((settle) => setTimeout(settle, 5));
      }
    },
    async settle() {
      await new Promise((settle) => setTimeout(settle, 50));
    },
    close: () =>
      new Promise<void>((settle) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => settle());
      }),
  };
}

test("the launcher-owned handoff pipe receives exactly one strict frame carrying the one-shot launch URL", async () => {
  const pipeName = desktopPresentationHandoffPipeName(bootstrapId);
  const listener = await listenOn(pipeName);
  try {
    createDesktopPresentationHandoffPublisher(bootstrapId)(launchUrl);
    await listener.waitForFrames(1);
    const frame = listener.frames[0]!;
    assert.equal(listener.frames.length, 1);
    assert.deepEqual(JSON.parse(frame.subarray(0, -1).toString("utf8")), {
      schema: "gamebuddy-desktop-presentation-handoff/v1",
      protocolVersion: 1,
      bootstrapId,
      launchUrl,
    });
    // Key order is the frame's shape here as on every other private wire.
    assert.deepEqual(
      Object.keys(JSON.parse(frame.subarray(0, -1).toString("utf8"))),
      ["schema", "protocolVersion", "bootstrapId", "launchUrl"],
    );
    assert.equal(frame[frame.length - 1], 10);
    assert.equal(frame.subarray(0, -1).includes(10), false);
    assert.equal(frame.includes(13), false);
    assert.deepEqual(frame, composeDesktopPresentationHandoffFrame(bootstrapId, launchUrl));
  } finally {
    await listener.close();
  }
});

test("a launch with no launcher reading the handoff pipe publishes nothing and never fails the composition", async () => {
  // No listener is created for this bootstrap id: the connect is refused
  // asynchronously, and the publisher's contract is that this cannot reach the
  // running composition as an uncaught error or a throw.
  assert.doesNotThrow(() => createDesktopPresentationHandoffPublisher("f".repeat(64))(launchUrl));
  await new Promise((settle) => setTimeout(settle, 100));
});

test("the handoff refuses every entry that is not the literal-loopback launch URL", async () => {
  for (const refused of [
    "http://example.com/#profile=composed-reference-game&boot=x",
    `https://127.0.0.1:41234/#boot=${token}`,
    `http://127.0.0.1/#boot=${token}`,
    `http://127.0.0.1:41234/#boot=${token}\n`,
    `http://127.0.0.1:41234\\#boot=${token}`,
    "",
  ]) {
    assert.equal(composeDesktopPresentationHandoffFrame(bootstrapId, refused), undefined, refused);
  }
  assert.equal(
    composeDesktopPresentationHandoffFrame("not-a-bootstrap-id", launchUrl),
    undefined,
  );
  assert.throws(
    () => desktopPresentationHandoffPipeName("not-a-bootstrap-id"),
    /desktop_presentation_handoff_bootstrap_invalid/,
  );
  // A refused entry is never published either: the listener sees no connection.
  const listener = await listenOn(desktopPresentationHandoffPipeName("a".repeat(64)));
  try {
    createDesktopPresentationHandoffPublisher("a".repeat(64))("http://example.com/#boot=x");
    await listener.settle();
    assert.equal(listener.frames.length, 0);
  } finally {
    await listener.close();
  }
});
