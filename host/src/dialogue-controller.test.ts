import assert from "node:assert/strict";
import test from "node:test";
import { DialogueController, validateDialogueInput } from "./dialogue-controller.js";

function fakeSession() {
  const prompts: Array<{ text: string; options: unknown }> = [];
  let aborted = 0;
  let cleared = 0;
  let release: (() => void) | undefined;
  let block = false;
  return {
    session: {
      get isIdle() { return !block; },
      async prompt(text: string, options: unknown) {
        prompts.push({ text, options });
        if (block) await new Promise<void>((resolvePromise) => { release = resolvePromise; });
      },
      async abort() { aborted++; block = false; release?.(); },
      clearQueue() { cleared++; return { steering: [], followUp: [] }; },
    },
    prompts,
    blockNext() { block = true; },
    get aborted() { return aborted; },
    get cleared() { return cleared; },
  };
}

test("DialogueController serializes canonical browser envelopes and deduplicates IDs", async () => {
  const fake = fakeSession();
  const controller = new DialogueController(fake.session, () => 42);
  assert.equal(await controller.submit({ clientMessageId: "input_01", text: "/should-not-be-a-command", locale: "zh-CN" }), "accepted");
  assert.equal(await controller.submit({ clientMessageId: "input_01", text: "duplicate", locale: "zh-CN" }), "duplicate");
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
  assert.equal(fake.prompts.length, 1);
  assert.deepEqual(JSON.parse(fake.prompts[0]!.text), { kind: "gamebuddy_dialogue_input_v1", clientMessageId: "input_01", text: "/should-not-be-a-command", locale: "zh-CN", receivedAtMs: 42 });
  assert.deepEqual(fake.prompts[0]!.options, { expandPromptTemplates: false, source: "rpc" });
});

test("DialogueController stop aborts the active dialogue turn and clears Pi queues", async () => {
  const fake = fakeSession(); fake.blockNext();
  const controller = new DialogueController(fake.session);
  await controller.submit({ clientMessageId: "input_01", text: "hello", locale: "en-US" });
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
  await controller.stop();
  assert.equal(fake.aborted, 1); assert.equal(fake.cleared, 1);
});

test("DialogueController fails a player turn when no explicit presentation was emitted", async () => {
  const events: string[] = [];
  const controller = new DialogueController({ async prompt() {}, async abort() {}, clearQueue() { return { steering: [], followUp: [] }; }, get isIdle() { return true; } }, Date.now, () => false);
  controller.subscribe((event) => events.push(JSON.stringify(event)));
  await controller.submit({ clientMessageId: "silent_01", text: "hello", locale: "en-US" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(events.map((event) => JSON.parse(event).type), ["turn_queued", "turn_started", "turn_failed"]);
});

test("DialogueController reports a failed turn without exposing provider detail", async () => {
  const events: string[] = [];
  const controller = new DialogueController({ async prompt() { throw new Error("provider secret"); }, async abort() {}, clearQueue() { return { steering: [], followUp: [] }; }, get isIdle() { return true; } });
  controller.subscribe((event) => events.push(JSON.stringify(event)));
  await controller.submit({ clientMessageId: "failed_01", text: "hello", locale: "en-US" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(events.map((event) => JSON.parse(event).type), ["turn_queued", "turn_started", "turn_failed"]);
  assert.doesNotMatch(events.join("\n"), /provider secret/);
});

test("DialogueController rejects browser control fields and UTF-8 byte overflow", () => {
  assert.throws(() => validateDialogueInput({ clientMessageId: "input", text: "hello", locale: "zh-CN", model: "wrong" }), /invalid_dialogue_input/);
  assert.throws(() => validateDialogueInput({ clientMessageId: "input", text: "你".repeat(1_334), locale: "zh-CN" }), /invalid_dialogue_input/);
});
