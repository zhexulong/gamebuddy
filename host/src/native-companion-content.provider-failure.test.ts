import assert from "node:assert/strict";
import test from "node:test";

import {
  attachNativeCompanionContent,
  CHAT_TRANSCRIPT_DELIVERY_UNIT,
  CHAT_TRANSCRIPT_SCAFFOLDING,
  CHAT_TRANSCRIPT_STAGE_DIRECTION,
  type NativeCompanionContentEvent,
} from "./native-companion-content.js";

/**
 * One provider rejection reaches the player as ONE bounded class.
 *
 * Pi settles every provider refusal on the assistant message's own
 * `errorMessage`, which `formatProviderError(normalizeProviderError(error))`
 * built as `"<status>: <body>"` (`pi-ai/dist/api/openai-completions.js:505`).
 * That string is arbitrary third-party bytes: a gateway may echo a key prefix, a
 * prompt-echoing proxy may quote the player, and a validation 400 may quote a
 * request field. It therefore never leaves the Host. The observer reads it and
 * publishes only the class below, which is what the surface can turn into a
 * sentence the player can act on.
 *
 * The two cases that must never collapse: a wrong key and a rate limit ask the
 * player for opposite actions (fix the credential versus wait), and both used to
 * arrive as the same `onRejected("error")`.
 *
 * Every sink argument is captured raw, so the leak assertion below reads the real
 * boundary rather than a summary of it. That also keeps this file honest about
 * the sink's arity: it observes what was actually passed, not what the caller
 * expected to be passed.
 */

type Listener = (event: NativeCompanionContentEvent) => void;

function fakeSession() {
  const listeners = new Set<Listener>();
  return Object.freeze({
    session: Object.freeze({
      subscribe(listener: Listener): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    }),
    emit(event: NativeCompanionContentEvent): void {
      for (const listener of [...listeners]) listener(event);
    },
  });
}

/** The exact shape Pi hands `message_end` for a failed turn: no text, one reason. */
function failedAssistant(errorMessage?: string) {
  return Object.freeze({
    role: "assistant" as const,
    content: Object.freeze([]),
    stopReason: "error",
    responseId: "response-1",
    ...(errorMessage === undefined ? {} : { errorMessage }),
  });
}

async function reject(errorMessage?: string): Promise<{
  /** Exactly the arguments `onRejected` was invoked with, in order. */
  readonly args: readonly unknown[];
}> {
  const fx = fakeSession();
  const args: unknown[] = [];
  const observer = attachNativeCompanionContent(
    fx.session,
    {
      onPreviewDelta: async () => undefined,
      onFinalText: async () => assert.fail("a failed turn has no final text"),
      // Captured as `[...args]` rather than by declared arity on purpose: the
      // point of this file is what the observer actually passes.
      onRejected: ((...received: unknown[]) => {
        args.push(...received);
      }) as never,
    },
    {
      stageDirection: CHAT_TRANSCRIPT_STAGE_DIRECTION,
      scaffolding: CHAT_TRANSCRIPT_SCAFFOLDING,
      deliveryUnit: CHAT_TRANSCRIPT_DELIVERY_UNIT,
    },
  );
  observer.open();
  fx.emit({ type: "message_start", message: failedAssistant() });
  fx.emit({ type: "message_end", message: failedAssistant(errorMessage) });
  await observer.close();
  return { args };
}

/** OpenAI's own 401 body, which quotes the credential it rejected. */
const WRONG_KEY =
  '401: {"error":{"message":"Incorrect API key provided: sk-proj-AbC***XyZ","type":"invalid_request_error"}}';
/** A rate limit body, which asks for the opposite action. */
const RATE_LIMIT = '429: {"error":{"message":"Rate limit reached for requests per min","type":"rate_limit_error"}}';

test("a 401 and a 429 reach the sink as different classes, not the same 'error'", async () => {
  const credential = await reject(WRONG_KEY);
  const limited = await reject(RATE_LIMIT);
  // The member stays the closed union's own `error`; the class rides beside it.
  assert.equal(credential.args[0], "error");
  assert.equal(limited.args[0], "error");
  assert.equal(credential.args[1], "credential_rejected");
  assert.equal(limited.args[1], "rate_limited");
  assert.notEqual(credential.args[1], limited.args[1]);
});

test("no provider byte crosses the boundary, in any position of what the sink was handed", async () => {
  for (const errorMessage of [WRONG_KEY, RATE_LIMIT]) {
    const { args } = await reject(errorMessage);
    const handed = JSON.stringify(args);
    // The two things those bodies carry that must never escape: the credential's own
    // prefix, and the provider's prose about it.
    assert.equal(handed.includes("sk-proj"), false, handed);
    assert.equal(handed.includes("Incorrect API key"), false, handed);
    assert.equal(handed.includes("Rate limit reached"), false, handed);
    assert.equal(handed.includes('error":{'), false, handed);
    // And the whole handover is exactly the two bounded members - nothing was
    // smuggled in as a third argument or a detail object.
    assert.equal(args.length, 2, handed);
  }
});

test("a refusal the provider never described hands over no class rather than a guessed one", async () => {
  const silent = await reject(undefined);
  assert.equal(silent.args[0], "error");
  assert.equal(silent.args[1], undefined);
});
