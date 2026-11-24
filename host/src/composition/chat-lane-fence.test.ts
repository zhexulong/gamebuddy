import assert from "node:assert/strict";
import test from "node:test";
import { ChatLaneDrainTimeoutError, createChatLaneFence } from "./chat-lane-fence.js";

function deferred(): Readonly<{ promise: Promise<void>; settle: () => void }> {
  let settle!: () => void;
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return Object.freeze({ promise, settle });
}

test("close runs the lane's services after the last admitted use, never beside it", async () => {
  const events: string[] = [];
  const fence = createChatLaneFence(async () => {
    events.push("close");
  });
  const read = deferred();

  const use = fence.use("state.read", async () => {
    events.push("read:start");
    await read.promise;
    events.push("read:end");
    return "state";
  });
  const close = fence.close();
  events.push("close:requested");

  // Nothing about the close happened while the read was inside the lane.
  assert.deepEqual(events, ["read:start", "close:requested"]);
  read.settle();
  assert.equal(await use, "state");
  await close;
  assert.deepEqual(events, ["read:start", "close:requested", "read:end", "close"]);
});

test("a sealed lane admits nothing and close waits for every use, not the first", async () => {
  let closed = 0;
  const fence = createChatLaneFence(async () => {
    closed += 1;
  });
  const first = deferred();
  const second = deferred();
  const firstUse = fence.use("memory.read", async () => await first.promise);
  const secondUse = fence.use("draft.read", async () => await second.promise);

  const close = fence.close();
  await assert.rejects(
    fence.use("chat.submit", async () => "never"),
    /chat_lane_closed/u,
  );
  first.settle();
  await firstUse;
  assert.equal(closed, 0, "the second use is still inside the lane");
  second.settle();
  await secondUse;
  await close;
  assert.equal(closed, 1);
});

test("a lane that does not drain is named with every use still inside it and is left open", async () => {
  let closed = 0;
  const fence = createChatLaneFence(
    async () => {
      closed += 1;
    },
    { drainTimeoutMs: 5 },
  );
  const stuck = deferred();
  const use = fence.use("management.managementService.listChats", async () => await stuck.promise);

  await assert.rejects(fence.close(), (error: unknown) => {
    assert.ok(error instanceof ChatLaneDrainTimeoutError);
    assert.equal(error.code, "chat_lane_drain_timeout");
    assert.deepEqual(error.inFlight, ["management.managementService.listChats"]);
    assert.match(error.message, /chat_lane_drain_timeout:1_in_flight_after_5ms/u);
    return true;
  });
  assert.equal(closed, 0, "a lane that did not drain was not closed");

  // The services are still open, so the next attempt waits again instead of reporting a close it never did.
  stuck.settle();
  await use;
  await fence.close();
  assert.equal(closed, 1);
});

test("close is one close however many callers ask, and a failing use still releases its count", async () => {
  let closed = 0;
  const fence = createChatLaneFence(async () => {
    closed += 1;
  });
  const failing = fence.use("chat.rewind", async () => {
    await Promise.resolve();
    throw new Error("rewind_unavailable");
  });
  await assert.rejects(failing, /rewind_unavailable/u);

  await Promise.all([fence.close(), fence.close()]);
  assert.equal(closed, 1);
});
