import assert from "node:assert/strict";
import test from "node:test";

import { createHostShutdownLifecycle, createVoicePollingSupervisor, type VoicePollingPort } from "./voice-polling.js";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("voice polling records deterministic success state", async () => {
  let now = 100;
  let polls = 0;
  const port: VoicePollingPort = { pollEvents: async () => void polls++ };
  const supervisor = createVoicePollingSupervisor(port, {
    now: () => now,
    setInterval: () => ({}) as ReturnType<typeof setInterval>,
    clearInterval: () => undefined,
  });

  supervisor.start();
  await supervisor.pollNow();
  now = 125;
  await supervisor.pollNow();

  assert.equal(polls, 2);
  assert.deepEqual(supervisor.state, {
    status: "running",
    pollCount: 2,
    successCount: 2,
    failureCount: 0,
    lastSuccessAtMs: 125,
    lastError: null,
  });
  await supervisor.close();
});

test("first terminal polling failure stops future polls without reconnect or cursor reset", async () => {
  let polls = 0;
  let scheduled: (() => void) | undefined;
  let cleared = 0;
  const port: VoicePollingPort = {
    pollEvents: async () => {
      polls += 1;
      throw new Error("voice_event_cursor_expired");
    },
  };
  const supervisor = createVoicePollingSupervisor(port, {
    now: () => 200,
    setInterval: (callback) => {
      scheduled = callback;
      return {} as ReturnType<typeof setInterval>;
    },
    clearInterval: () => {
      cleared += 1;
    },
  });

  supervisor.start();
  scheduled!();
  await supervisor.pollNow();
  scheduled!();
  await supervisor.pollNow();

  assert.equal(polls, 1);
  assert.equal(cleared, 1);
  assert.deepEqual(supervisor.state.lastError, {
    code: "voice_event_cursor_expired",
    timestampMs: 200,
    count: 1,
  });
  assert.equal(supervisor.state.status, "stopped");
  await supervisor.close();
});

test("unknown failures are reduced to the allowlisted redacted code", async () => {
  const secret = "token=secret socket=/private transcript=不要保留";
  const supervisor = createVoicePollingSupervisor(
    {
      pollEvents: async () => {
        throw new Error(secret);
      },
    },
    {
      now: () => 300,
      setInterval: () => ({}) as ReturnType<typeof setInterval>,
      clearInterval: () => undefined,
    },
  );

  supervisor.start();
  await supervisor.pollNow();
  const serialized = JSON.stringify(supervisor.state);
  assert.deepEqual(supervisor.state.lastError, { code: "voice_poll_failed", timestampMs: 300, count: 1 });
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("token"), false);
  assert.equal(serialized.includes("socket"), false);
  assert.equal(serialized.includes("transcript"), false);
  await supervisor.close();
});

test("shutdown lifecycle drains polling and detaches voice before return, exactly once", async () => {
  const poll = deferred<void>();
  const order: string[] = [];
  const supervisor = createVoicePollingSupervisor(
    {
      pollEvents: () => {
        order.push("poll");
        return poll.promise;
      },
    },
    {
      setInterval: () => ({}) as ReturnType<typeof setInterval>,
      clearInterval: () => undefined,
    },
  );
  supervisor.start();
  const polling = supervisor.pollNow();
  const shutdown = createHostShutdownLifecycle({
    stopPolling: async () => {
      order.push("stop-polling");
      await supervisor.close();
      order.push("polling-stopped");
    },
    detachVoice: () => {
      order.push("detach-voice");
    },
    closeVoice: () => {
      order.push("close-voice");
    },
    closeConnected: () => {
      order.push("close-connected");
    },
  });

  const preparing = shutdown.prepareForReturn();
  await Promise.resolve();
  assert.deepEqual(order, ["poll", "stop-polling"]);
  poll.resolve();
  await polling;
  await preparing;
  assert.deepEqual(order, ["poll", "stop-polling", "polling-stopped", "detach-voice"]);

  const cleanup1 = shutdown.cleanup();
  const cleanup2 = shutdown.cleanup();
  assert.equal(cleanup1, cleanup2);
  await cleanup1;
  assert.deepEqual(order, [
    "poll",
    "stop-polling",
    "polling-stopped",
    "detach-voice",
    "close-voice",
    "close-connected",
  ]);
  await shutdown.prepareForReturn();
  assert.deepEqual(order, [
    "poll",
    "stop-polling",
    "polling-stopped",
    "detach-voice",
    "close-voice",
    "close-connected",
  ]);
});

test("shutdown lifecycle records cleanup failures while attempting later resources", async () => {
  const first = new Error("stop failed");
  const second = new Error("detach failed");
  const order: string[] = [];
  const shutdown = createHostShutdownLifecycle({
    stopPolling: () => {
      order.push("stop-polling");
      throw first;
    },
    detachVoice: () => {
      order.push("detach-voice");
      throw second;
    },
    closeVoice: () => {
      order.push("close-voice");
    },
    closeConnected: () => {
      order.push("close-connected");
    },
  });

  assert.deepEqual(await shutdown.prepareForReturn(), [first, second]);
  assert.deepEqual(await shutdown.cleanup(), []);
  assert.deepEqual(order, ["stop-polling", "detach-voice", "close-voice", "close-connected"]);
});

test("polling is non-overlapping and close is idempotent", async () => {
  const first = deferred<void>();
  let calls = 0;
  let timerCallback: (() => void) | undefined;
  let clearCalls = 0;
  const supervisor = createVoicePollingSupervisor(
    {
      pollEvents: () => {
        calls += 1;
        return first.promise;
      },
    },
    {
      setInterval: (callback) => {
        timerCallback = callback;
        return {} as ReturnType<typeof setInterval>;
      },
      clearInterval: () => {
        clearCalls += 1;
      },
    },
  );

  supervisor.start();
  timerCallback!();
  timerCallback!();
  await Promise.resolve();
  const close1 = supervisor.close();
  const close2 = supervisor.close();
  assert.equal(close1, close2);
  assert.equal(calls, 1);
  assert.equal(clearCalls, 1);
  first.resolve();
  await close1;
  assert.equal(supervisor.state.status, "closed");
});

test("transient network failures retry with exponential backoff and recover on success", async () => {
  let scheduledDelay = 0;
  let scheduledCallback: (() => void) | undefined;
  let pollAttempts = 0;
  let shouldFail = true;

  const port: VoicePollingPort = {
    pollEvents: async () => {
      pollAttempts += 1;
      if (shouldFail) {
        throw new Error("voice_gateway_disconnected");
      }
    },
  };

  const supervisor = createVoicePollingSupervisor(port, {
    intervalMs: 200,
    minBackoffMs: 1000,
    maxBackoffMs: 10000,
    now: () => 500,
    setInterval: (callback, delay) => {
      scheduledCallback = callback;
      scheduledDelay = delay;
      return {} as ReturnType<typeof setInterval>;
    },
    clearInterval: () => undefined,
  });

  supervisor.start();
  assert.equal(scheduledDelay, 200);

  // First poll fails: transient network error
  await supervisor.pollNow();
  assert.equal(pollAttempts, 1);
  assert.equal(supervisor.state.status, "running"); // still running, not terminally stopped
  assert.equal(supervisor.state.failureCount, 1);
  assert.equal(supervisor.state.lastError?.code, "voice_gateway_disconnected");
  assert.equal(scheduledDelay, 1000); // backed off to minBackoffMs

  // Second poll fails: further backoff
  await supervisor.pollNow();
  assert.equal(pollAttempts, 2);
  assert.equal(supervisor.state.failureCount, 2);
  assert.equal(scheduledDelay, 1000); // 200 * 2^1 = 400 < minBackoff 1000 -> 1000

  // Recovery: network returns
  shouldFail = false;
  await supervisor.pollNow();
  assert.equal(pollAttempts, 3);
  assert.equal(supervisor.state.successCount, 1);
  assert.equal(scheduledDelay, 200); // resumed normal interval!

  await supervisor.close();
});
