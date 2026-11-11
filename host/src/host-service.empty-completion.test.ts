import assert from "node:assert/strict";
import test from "node:test";

import { CompanionLoop } from "./companion-loop.js";
import type { WorldFact } from "./event-pump.js";
import { CompanionHostService } from "./host-service.js";

/**
 * A provider that answers with NOTHING must not end the loop in silence.
 *
 * MEASURED 2026-11-07: a live Game run's own session record ended with
 *
 *   {"type":"message","message":{"role":"assistant","content":[],"usage":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"totalTokens":0}}}
 *   {"type":"context_edit","targetId":"f48af6ae","replacement":null}
 *
 * and then made no further record for 148 minutes while the game process stayed alive and the bridge stayed connected.
 * The turn had settled, so the loop reported `completed`, the Host reset the counter that decides whether another turn
 * is owed (only a turn that produced no work advances it), the pump had nothing pending, and nothing named the stall or
 * ended it. An assistant turn that carries neither text nor a tool call is not a turn: it is a provider that answered
 * with nothing, and the run must treat it as one.
 *
 * The other half is the one that must NOT change: a reply that has text and no tool call is a normal ending (the
 * companion said something and stopped), and a provider refusal keeps flowing through its own rate-limit path.
 */

type Answer = "empty" | "text" | "tool" | "tool_call" | "error";

const ASSISTANT_START = Object.freeze({ role: "assistant" as const, content: Object.freeze([]), provider: "cpa-oai" });

/** The exact assistant record the incident left behind: no text, no tool call, usage all zeros. */
const emptyEnd = Object.freeze({
  role: "assistant" as const,
  content: Object.freeze([]),
  provider: "cpa-oai",
  usage: Object.freeze({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }),
});

const textEnd = Object.freeze({
  role: "assistant" as const,
  content: Object.freeze([{ type: "text", text: "我在呢。" }]),
  stopReason: "stop",
});

/** The streaming lane Pi uses for a text message, so a presenter installed on the loop receives the answer. */
const partial = (text: string) => ({ role: "assistant" as const, content: [{ type: "text", text }] });

const toolEnd = Object.freeze({
  role: "assistant" as const,
  content: Object.freeze([{ type: "toolCall", id: "call_1", name: "stardew_observe", arguments: {} }]),
  stopReason: "toolUse",
});

const failureEnd = Object.freeze({
  role: "assistant" as const,
  content: Object.freeze([]),
  stopReason: "error",
  errorMessage: "429: rate limit reached",
});

/**
 * A Pi session that answers each prompt from a script, in Pi's own event vocabulary.
 *
 * The answers repeat the last member once the script runs out, so one `["empty"]` script is a provider that never
 * produces a turn and `["empty", "text"]` is one that answers nothing once and then answers properly.
 */
function scriptedSession(answers: readonly Answer[]) {
  const listeners = new Set<(event: unknown) => void>();
  const prompts: string[] = [];
  const emit = (event: unknown): void => {
    for (const listener of [...listeners]) listener(event);
  };
  return {
    prompts,
    session: {
      subscribe(listener: (event: unknown) => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      async sendUserMessage(batch: string) {
        prompts.push(batch);
        const answer = answers[Math.min(prompts.length - 1, answers.length - 1)] ?? "empty";
        emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: batch }] } });
        emit({ type: "message_start", message: ASSISTANT_START });
        if (answer === "tool") {
          // The one event that means "this turn acted": it is what `turnProduction` reads.
          emit({ type: "tool_execution_start", toolCallId: "call_1", toolName: "stardew_observe" });
          emit({ type: "message_end", message: toolEnd });
        } else if (answer === "tool_call") {
          // A tool call the runtime never executed (refused, or the turn ended before it ran). The message still asked
          // for something, so it is not a message that carried nothing.
          emit({ type: "message_end", message: toolEnd });
        } else if (answer === "text") {
          emit({
            type: "message_update",
            message: partial(""),
            assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: partial("") },
          });
          emit({
            type: "message_update",
            message: partial("我在呢。"),
            assistantMessageEvent: {
              type: "text_delta",
              contentIndex: 0,
              delta: "我在呢。",
              partial: partial("我在呢。"),
            },
          });
          emit({ type: "message_end", message: textEnd });
        } else if (answer === "error") {
          emit({ type: "message_end", message: failureEnd });
        } else {
          emit({ type: "message_end", message: emptyEnd });
        }
        emit({ type: "agent_settled", aborted: false });
      },
      async abort() {},
      clearQueue() {},
      async waitForIdle() {},
    },
  };
}

function eventHarness() {
  let factListener: ((fact: WorldFact) => void) | undefined;
  return {
    events: {
      onFact(next: (fact: WorldFact) => void) {
        factListener = next;
        return () => {
          factListener = undefined;
        };
      },
      onLifecycle() {
        return () => undefined;
      },
    },
    emit(fact: WorldFact) {
      factListener?.(fact);
    },
  };
}

const snapshot = (revision: number): WorldFact => ({
  source: "arcade_adapter",
  kind: "snapshot",
  eventId: `snapshot_${revision}`,
  occurredAtMs: Date.now(),
  correlationId: `snapshot_${revision}`,
  revision,
  payload: { revision },
});

function harness(answers: readonly Answer[]) {
  const adapter = eventHarness();
  const scripted = scriptedSession(answers);
  const loop = new CompanionLoop(scripted.session as never);
  const service = new CompanionHostService(loop, adapter.events as never);
  const input = (sourceEventId: string) =>
    service.acceptPlayerInput({ sourceEventId, text: "去农场看看。", locale: "zh-CN" });
  return { adapter, scripted, loop, service, input };
}

test("a provider that answers nothing is asked again, and the empty completion is counted", async () => {
  const { scripted, service, input } = harness(["empty", "text"]);

  const disposition = await input("source_empty_retry");

  assert.equal(
    scripted.prompts.length,
    2,
    "the empty answer is a turn that did not happen, so the prompt is owed again",
  );
  assert.equal(
    scripted.prompts[1],
    scripted.prompts[0],
    "the retry re-sends the SAME prompt: a fresh batch would answer different facts than the one that failed",
  );
  assert.deepEqual(disposition, { accepted: true, turnOutcome: "completed" });
  assert.equal(service.providerEmptyCompletions, 1, "the empty answer is counted even though the retry answered");
  assert.equal(service.runTermination, undefined);

  service.close();
});

test("three empty completions end the run with a named terminal code", async () => {
  const { adapter, scripted, loop, service } = harness(["empty"]);

  await assert.rejects(
    service.acceptPlayerInput({ sourceEventId: "source_empty_terminal", text: "去农场看看。", locale: "zh-CN" }),
    /provider_empty_completion/,
  );

  assert.equal(scripted.prompts.length, 3, "three attempts: the first answer plus two bounded retries");
  assert.deepEqual(service.runTermination, { code: "provider_empty_completion", emptyCompletions: 3 });
  assert.equal(service.providerEmptyCompletions, 3);
  // The run is over, but nothing was thrown away: the world, the bridge and the prompt's own fact stay where they are.
  assert.ok(loop.pump.pendingCount > 0, "the unanswered prompt stays in the pump rather than being dropped");

  assert.deepEqual(
    await service.acceptPlayerInput({ sourceEventId: "source_after", text: "还在吗？", locale: "zh-CN" }),
    {
      accepted: false,
      reasonCode: "player_input_run_terminated",
    },
  );

  adapter.emit(snapshot(9));
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  assert.equal(scripted.prompts.length, 3, "a later fact cannot wake a run that has named its own ending");

  service.close();
});

test("a reply with text and no tool call is a normal ending, and a turn that acted is not empty", async () => {
  const spoken = harness(["text"]);
  assert.deepEqual(await spoken.input("source_spoken"), { accepted: true, turnOutcome: "completed" });
  assert.equal(spoken.scripted.prompts.length, 1, "the companion said something and stopped");
  assert.equal(spoken.service.providerEmptyCompletions, 0);
  assert.equal(spoken.service.runTermination, undefined);
  spoken.service.close();

  const acted = harness(["tool"]);
  assert.deepEqual(await acted.input("source_acted"), { accepted: true, turnOutcome: "completed" });
  assert.equal(acted.scripted.prompts.length, 1, "a tool call is a turn even when the message carries no text");
  assert.equal(acted.service.providerEmptyCompletions, 0);
  assert.equal(acted.service.runTermination, undefined);
  acted.service.close();

  const asked = harness(["tool_call"]);
  assert.deepEqual(await asked.input("source_asked"), { accepted: true, turnOutcome: "completed" });
  assert.equal(asked.scripted.prompts.length, 1, "the message's own tool call is the fact, executed or not");
  assert.equal(asked.service.providerEmptyCompletions, 0);
  assert.equal(asked.service.runTermination, undefined);
  asked.service.close();
});

test("the same empty answer is caught with the Game presenter installed, which is where the run that stalled was", async () => {
  const adapter = eventHarness();
  const scripted = scriptedSession(["empty", "text"]);
  const loop = new CompanionLoop(scripted.session as never);
  const presented: string[] = [];
  loop.attachTurnObserver({ beginPlayerBatch() {}, endBatch() {} });
  loop.attachNativeGameContentPresenter(async (content) => {
    presented.push(content.text);
  });
  const service = new CompanionHostService(loop, adapter.events as never);

  assert.deepEqual(
    await service.acceptPlayerInput({ sourceEventId: "source_presented", text: "去农场看看。", locale: "zh-CN" }),
    {
      accepted: true,
      turnOutcome: "completed",
    },
  );

  // The native-content observer publishes NOTHING for this message (no text, no rejection, no final piece), so the
  // loop cannot learn the ending from it - which is why the rule reads Pi's raw stream instead.
  assert.equal(
    scripted.prompts.length,
    2,
    "the empty answer is re-asked on the surface that produced the 148-minute stall",
  );
  assert.equal(service.providerEmptyCompletions, 1);
  // The surface may lead with the turn's own reaction sound (`GAME_DELIVERY_PACING`); what must still land is the answer.
  assert.equal(presented.at(-1), "我在呢。", "and the answer that did arrive is presented exactly as before");

  service.close();
});

test("a provider refusal is not an empty completion and keeps its own path", async () => {
  const { scripted, service, input } = harness(["error"]);

  await input("source_provider_error");

  assert.equal(scripted.prompts.length, 1, "pi already retried the refusal; this layer must not retry it again");
  assert.equal(service.providerEmptyCompletions, 0, "a refusal that says why is not a provider that said nothing");
  assert.equal(service.runTermination, undefined);

  service.close();
});
