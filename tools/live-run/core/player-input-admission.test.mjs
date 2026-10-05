import assert from "node:assert/strict";
import { test } from "node:test";

import { submitPlayerPrompt } from "./player-input-admission.mjs";

/** Deterministic clock so the wait/attempt accounting is exact. */
function fakeClock() {
  let ms = 0;
  return {
    now: () => ms,
    sleep: async (duration) => {
      ms += duration;
    },
    advance: (duration) => {
      ms += duration;
    },
  };
}

test("an accepted prompt submits exactly once and reports the wait", async () => {
  const clock = fakeClock();
  const calls = [];
  const result = await submitPlayerPrompt({
    accept: async (text, locale) => {
      calls.push({ text, locale });
      clock.advance(120);
      return { accepted: true };
    },
    text: "harvest the strawberries",
    locale: "zh-CN",
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.deepEqual(result, { accepted: true, attempts: 1, waitedMs: 120, refusals: [] });
  assert.deepEqual(calls, [{ text: "harvest the strawberries", locale: "zh-CN" }]);
});

test("a revoked admission is retried until the Host accepts", async () => {
  const clock = fakeClock();
  let attempt = 0;
  const result = await submitPlayerPrompt({
    accept: async () => {
      attempt += 1;
      return attempt < 3 ? { accepted: false, reasonCode: "player_input_integration_unavailable" } : { accepted: true };
    },
    text: "hello",
    locale: "en-US",
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(result.accepted, true);
  assert.equal(result.attempts, 3);
  assert.deepEqual(result.refusals, [
    "player_input_integration_unavailable",
    "player_input_integration_unavailable",
  ]);
  // Two refusals each waited one poll interval.
  assert.equal(result.waitedMs, 1000);
});

test("a prompt refused for the whole window is reported as refused, never as a quiet success", async () => {
  const clock = fakeClock();
  const result = await submitPlayerPrompt({
    accept: async () => ({ accepted: false, reasonCode: "player_input_session_closed" }),
    text: "hello",
    locale: "en-US",
    timeoutMs: 1500,
    pollMs: 500,
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(result.accepted, false);
  assert.equal(result.lastRefusal, "player_input_session_closed");
  assert.equal(result.waitedMs, 1500);
  // 0ms + 3 waits of 500ms: the loop stops at the deadline instead of spinning.
  assert.equal(result.attempts, 4);
});

test("a void return is accepted, so legacy targets keep working", async () => {
  const clock = fakeClock();
  const result = await submitPlayerPrompt({
    accept: async () => undefined,
    text: "hello",
    locale: "en-US",
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.equal(result.accepted, true);
  assert.equal(result.attempts, 1);
});

test("a thrown delivery failure propagates instead of being retried as a refusal", async () => {
  const clock = fakeClock();
  let attempts = 0;
  await assert.rejects(
    () =>
      submitPlayerPrompt({
        accept: async () => {
          attempts += 1;
          throw new Error("provider_unavailable");
        },
        text: "hello",
        locale: "en-US",
        now: clock.now,
        sleep: clock.sleep,
      }),
    /provider_unavailable/,
  );
  // Exactly one attempt: re-sending an admitted-but-undelivered message is not
  // this helper's call to make.
  assert.equal(attempts, 1);
});

test("missing arguments fail closed rather than submitting nothing", async () => {
  await assert.rejects(() => submitPlayerPrompt({ text: "hello" }), /player_input_accept_required/);
  await assert.rejects(() => submitPlayerPrompt({ accept: async () => undefined, text: "   " }), /player_input_text_required/);
});

test("an unknown refusal shape without a reason code is still a refusal", async () => {
  const clock = fakeClock();
  const result = await submitPlayerPrompt({
    accept: async () => ({ accepted: false }),
    text: "hello",
    locale: "en-US",
    timeoutMs: 500,
    pollMs: 500,
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.equal(result.accepted, false);
  assert.equal(result.lastRefusal, "player_input_refused");
});
